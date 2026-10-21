/**
 * 0090: per-user notifications for package review decisions and broken cron
 * prechecks (docs/proposals-impl/cron-tool.md, component 6). Informational
 * only: nothing here changes review, activation, binding or admission state.
 */
export function userNotificationsMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
CREATE TABLE IF NOT EXISTS ${s}.user_notifications (
    notification_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    recipient_provider TEXT NOT NULL,
    recipient_subject  TEXT NOT NULL,
    kind               TEXT NOT NULL
        CHECK (kind IN ('package_review', 'cron_precheck_broken', 'cron_precheck_recovered')),
    scope_key          TEXT,
    dedup_key          TEXT,
    payload            JSONB NOT NULL,
    occurrences        INTEGER NOT NULL DEFAULT 1,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    notified_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    read_at            TIMESTAMPTZ,
    resolved_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS user_notifications_open_dedup
    ON ${s}.user_notifications (recipient_provider, recipient_subject, dedup_key)
    WHERE dedup_key IS NOT NULL AND resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS user_notifications_recipient
    ON ${s}.user_notifications (recipient_provider, recipient_subject, notified_at DESC);
CREATE INDEX IF NOT EXISTS user_notifications_open_scope
    ON ${s}.user_notifications (scope_key) WHERE scope_key IS NOT NULL AND resolved_at IS NULL;

-- Broken precheck: one open row per recipient and (session, precheck, digest,
-- outcome). A repeat only counts and, after a day, re-notifies (unread again).
-- Recipients are the session owner and the package owner only; the package
-- owner's copy omits the session ID.
CREATE OR REPLACE FUNCTION ${s}.cms_notify_cron_precheck_broken(
    p_session_id TEXT, p_precheck TEXT, p_outcome TEXT,
    p_package_id TEXT, p_version_id TEXT, p_sha256 TEXT
) RETURNS INTEGER AS $$
DECLARE
    v_scope TEXT;
    v_key TEXT;
    v_base JSONB;
    v_count INTEGER := 0;
    v_rows INTEGER;
    r RECORD;
BEGIN
    IF NULLIF(BTRIM(p_session_id), '') IS NULL OR NULLIF(BTRIM(p_precheck), '') IS NULL THEN
        RAISE EXCEPTION 'USER_NOTIFICATION_INVALID: session and precheck required';
    END IF;
    IF p_outcome IS NULL OR p_outcome NOT IN ('error', 'timeout', 'invalid', 'unregistered') THEN
        RAISE EXCEPTION 'USER_NOTIFICATION_INVALID: % is not a broken precheck outcome', p_outcome;
    END IF;
    v_scope := 'cron_precheck:' || p_session_id;
    v_key := v_scope || ':' || p_precheck || ':' || COALESCE(p_sha256, 'worker') || ':' || p_outcome;
    v_base := jsonb_strip_nulls(jsonb_build_object(
        'precheck', p_precheck,
        'outcome', p_outcome,
        'summary', CASE p_outcome
            WHEN 'error' THEN 'The precheck threw or one of its MCP calls failed.'
            WHEN 'timeout' THEN 'The precheck did not answer within its timeout.'
            WHEN 'invalid' THEN 'The precheck returned an answer other than run or skip.'
            ELSE 'The precheck is not registered on the worker that ran the schedule.' END,
        'packageId', p_package_id,
        'packageName', (SELECT p.name FROM ${s}.agent_packages p WHERE p.package_id = p_package_id),
        'versionId', p_version_id,
        'semver', (SELECT v.semver FROM ${s}.agent_package_versions v
                   WHERE v.version_id = p_version_id AND v.package_id = p_package_id),
        'sha256', p_sha256));

    FOR r IN
        SELECT DISTINCT ON (provider, subject) provider, subject, with_session
        FROM (
            SELECT u.provider, u.subject, TRUE AS with_session
            FROM ${s}.session_owners so JOIN ${s}.users u ON u.user_id = so.user_id
            WHERE so.session_id = COALESCE(
                (SELECT so2.session_id FROM ${s}.session_owners so2 WHERE so2.session_id = p_session_id),
                ${s}.cms_resolve_root_session(p_session_id))
            UNION ALL
            SELECT p.owner_provider, p.owner_subject, FALSE
            FROM ${s}.agent_packages p
            WHERE p_package_id IS NOT NULL AND p.package_id = p_package_id
        ) recipients
        WHERE NULLIF(BTRIM(provider), '') IS NOT NULL AND NULLIF(BTRIM(subject), '') IS NOT NULL
        ORDER BY provider, subject, with_session DESC
    LOOP
        INSERT INTO ${s}.user_notifications AS n
            (recipient_provider, recipient_subject, kind, scope_key, dedup_key, payload)
        VALUES (r.provider, r.subject, 'cron_precheck_broken', v_scope, v_key,
            CASE WHEN r.with_session THEN v_base || jsonb_build_object('sessionId', p_session_id) ELSE v_base END)
        ON CONFLICT (recipient_provider, recipient_subject, dedup_key)
            WHERE dedup_key IS NOT NULL AND resolved_at IS NULL
        DO UPDATE SET
            occurrences = n.occurrences + 1,
            last_seen_at = now(),
            read_at = CASE WHEN n.notified_at <= now() - INTERVAL '1 day' THEN NULL ELSE n.read_at END,
            notified_at = CASE WHEN n.notified_at <= now() - INTERVAL '1 day' THEN now() ELSE n.notified_at END;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        v_count := v_count + v_rows;
    END LOOP;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- Recovery: close every open broken row for the session and send one notice
-- per closed row to the same recipient, carrying the same visible fields.
CREATE OR REPLACE FUNCTION ${s}.cms_resolve_cron_precheck_broken(p_session_id TEXT)
RETURNS INTEGER AS $$
DECLARE v_count INTEGER;
BEGIN
    WITH closed AS (
        UPDATE ${s}.user_notifications
        SET resolved_at = now()
        WHERE scope_key = 'cron_precheck:' || p_session_id
          AND kind = 'cron_precheck_broken' AND resolved_at IS NULL
        RETURNING recipient_provider, recipient_subject, scope_key, payload, occurrences, created_at
    ), notices AS (
        INSERT INTO ${s}.user_notifications
            (recipient_provider, recipient_subject, kind, scope_key, payload)
        SELECT recipient_provider, recipient_subject, 'cron_precheck_recovered', scope_key,
            (payload - 'outcome' - 'summary') || jsonb_build_object(
                'previousOutcome', payload->>'outcome',
                'brokenSince', created_at,
                'brokenOccurrences', occurrences)
        FROM closed
        RETURNING 1
    )
    SELECT count(*)::INTEGER INTO v_count FROM notices;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;

-- Review decisions notify the package owner and editors from the same
-- transaction as the audited decision. A notification failure never blocks
-- or rolls back the decision.
CREATE OR REPLACE FUNCTION ${s}.cms_package_review_notify()
RETURNS TRIGGER AS $$
DECLARE v_pkg ${s}.agent_packages; v_payload JSONB;
BEGIN
    IF NEW.after_decision NOT IN ('approved', 'rejected', 'revoked')
       OR NEW.after_decision = NEW.before_decision THEN
        RETURN NEW;
    END IF;
    BEGIN
        SELECT * INTO v_pkg FROM ${s}.agent_packages WHERE package_id = NEW.package_id;
        IF NOT FOUND THEN RETURN NEW; END IF;
        v_payload := jsonb_strip_nulls(jsonb_build_object(
            'packageId', NEW.package_id,
            'packageName', v_pkg.name,
            'versionId', NEW.version_id,
            'semver', (SELECT v.semver FROM ${s}.agent_package_versions v WHERE v.version_id = NEW.version_id),
            'sha256', NEW.sha256,
            'decision', NEW.after_decision,
            'previousDecision', NEW.before_decision,
            'reason', NEW.reason,
            'revision', NEW.revision));
        INSERT INTO ${s}.user_notifications (recipient_provider, recipient_subject, kind, payload)
        SELECT DISTINCT provider, subject, 'package_review', v_payload
        FROM (
            SELECT v_pkg.owner_provider AS provider, v_pkg.owner_subject AS subject
            UNION ALL
            SELECT u.provider, u.subject
            FROM ${s}.agent_package_editors e JOIN ${s}.users u ON u.user_id = e.user_id
            WHERE e.package_id = NEW.package_id
        ) recipients
        WHERE NULLIF(BTRIM(provider), '') IS NOT NULL AND NULLIF(BTRIM(subject), '') IS NOT NULL;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'package review notification skipped for %: %', NEW.version_id, SQLERRM;
    END;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS agent_package_review_notify ON ${s}.agent_package_review_audit;
CREATE TRIGGER agent_package_review_notify
AFTER INSERT ON ${s}.agent_package_review_audit
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_package_review_notify();

-- The caller's own notifications only. Review notices carry the live
-- "approved, not active" state so the reminder clears once activated.
CREATE OR REPLACE FUNCTION ${s}.cms_list_user_notifications(
    p_provider TEXT, p_subject TEXT, p_unread_only BOOLEAN, p_limit INTEGER
) RETURNS TABLE (
    notification_id BIGINT, kind TEXT, payload JSONB, occurrences INTEGER,
    created_at TIMESTAMPTZ, notified_at TIMESTAMPTZ, last_seen_at TIMESTAMPTZ,
    read_at TIMESTAMPTZ, resolved_at TIMESTAMPTZ
) AS $$
#variable_conflict use_column
BEGIN
    IF NULLIF(BTRIM(p_provider), '') IS NULL OR NULLIF(BTRIM(p_subject), '') IS NULL THEN
        RAISE EXCEPTION 'USER_NOTIFICATION_FORBIDDEN: authenticated principal required';
    END IF;
    RETURN QUERY
    SELECT n.notification_id, n.kind,
        CASE WHEN n.kind = 'package_review' AND n.payload->>'decision' = 'approved' THEN
            n.payload || jsonb_build_object('approvedNotActive',
                COALESCE(p.active_version_id IS DISTINCT FROM n.payload->>'versionId', TRUE))
        ELSE n.payload END,
        n.occurrences, n.created_at, n.notified_at, n.last_seen_at, n.read_at, n.resolved_at
    FROM ${s}.user_notifications n
    LEFT JOIN ${s}.agent_packages p
        ON n.kind = 'package_review' AND p.package_id = n.payload->>'packageId'
    WHERE n.recipient_provider = p_provider AND n.recipient_subject = p_subject
      AND (p_unread_only IS NOT TRUE OR n.read_at IS NULL)
    ORDER BY n.notified_at DESC, n.notification_id DESC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));
END;
$$ LANGUAGE plpgsql STABLE;

-- NULL ids marks all of the caller's unread notifications.
CREATE OR REPLACE FUNCTION ${s}.cms_mark_user_notifications_read(
    p_provider TEXT, p_subject TEXT, p_ids BIGINT[]
) RETURNS INTEGER AS $$
DECLARE v_count INTEGER;
BEGIN
    IF NULLIF(BTRIM(p_provider), '') IS NULL OR NULLIF(BTRIM(p_subject), '') IS NULL THEN
        RAISE EXCEPTION 'USER_NOTIFICATION_FORBIDDEN: authenticated principal required';
    END IF;
    UPDATE ${s}.user_notifications
    SET read_at = now()
    WHERE recipient_provider = p_provider AND recipient_subject = p_subject
      AND read_at IS NULL AND (p_ids IS NULL OR notification_id = ANY(p_ids));
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$ LANGUAGE plpgsql;
`;
}
