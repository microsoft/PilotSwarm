/**
 * 0091: advisory review reports from the package-reviewer agent
 * (docs/proposals-impl/cron-tool.md, component 4). A report explains an exact
 * pending candidate against an exact baseline. It is never an approval:
 * nothing here changes review, activation, binding or admission state.
 */
export function packageReviewReportsMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
CREATE TABLE IF NOT EXISTS ${s}.agent_package_review_reports (
    report_id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    package_id          TEXT NOT NULL,
    version_id          TEXT NOT NULL REFERENCES ${s}.agent_package_versions(version_id) ON DELETE CASCADE,
    candidate_sha256    TEXT NOT NULL CHECK (candidate_sha256 ~ '^[a-f0-9]{64}$'),
    baseline_version_id TEXT,
    baseline_sha256     TEXT CHECK (baseline_sha256 IS NULL OR baseline_sha256 ~ '^[a-f0-9]{64}$'),
    session_id          TEXT,
    author_provider     TEXT NOT NULL,
    author_subject      TEXT NOT NULL,
    report              JSONB NOT NULL
        CHECK (jsonb_typeof(report) = 'object'
            AND NOT (report ?| ARRAY['verdict', 'decision', 'approved', 'approval', 'rejected'])
            AND octet_length(report::text) <= 262144),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK ((baseline_version_id IS NULL) = (baseline_sha256 IS NULL)),
    CHECK (baseline_version_id IS NULL OR baseline_version_id <> version_id)
);
CREATE INDEX IF NOT EXISTS agent_package_review_reports_candidate
    ON ${s}.agent_package_review_reports (version_id, candidate_sha256, created_at DESC);

-- Administrator only, for an exact candidate that is still pending with this
-- digest, against another exact version of the same package (or none).
CREATE OR REPLACE FUNCTION ${s}.cms_put_agent_package_review_report(
    p_package_id TEXT, p_version_id TEXT, p_sha256 TEXT,
    p_baseline_version_id TEXT, p_baseline_sha256 TEXT,
    p_session_id TEXT, p_report JSONB,
    p_provider TEXT, p_subject TEXT, p_is_admin BOOLEAN
) RETURNS BIGINT AS $$
DECLARE
    v_id BIGINT;
BEGIN
    IF p_is_admin IS NOT TRUE OR NULLIF(BTRIM(p_provider), '') IS NULL OR NULLIF(BTRIM(p_subject), '') IS NULL THEN
        RAISE EXCEPTION 'PACKAGE_REVIEW_REPORT_FORBIDDEN: authenticated administrator required';
    END IF;
    IF p_sha256 IS NULL OR p_sha256 !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION 'PACKAGE_REVIEW_REPORT_INVALID: exact candidate digest required';
    END IF;
    IF (p_baseline_version_id IS NULL) <> (p_baseline_sha256 IS NULL) THEN
        RAISE EXCEPTION 'PACKAGE_REVIEW_REPORT_INVALID: baseline version and digest go together';
    END IF;
    IF p_report IS NULL OR jsonb_typeof(p_report) <> 'object' THEN
        RAISE EXCEPTION 'PACKAGE_REVIEW_REPORT_INVALID: report must be an object';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM ${s}.agent_package_reviews r
        JOIN ${s}.agent_package_versions v ON v.version_id = r.version_id
        WHERE r.version_id = p_version_id AND r.package_id = p_package_id
          AND r.sha256 = p_sha256 AND v.sha256 = p_sha256 AND v.package_id = p_package_id
          AND r.decision = 'pending'
    ) THEN
        RAISE EXCEPTION 'PACKAGE_REVIEW_REPORT_CONFLICT: candidate is not pending with this exact digest';
    END IF;
    IF p_baseline_version_id IS NOT NULL AND (p_baseline_version_id = p_version_id OR NOT EXISTS (
        SELECT 1 FROM ${s}.agent_package_versions v
        WHERE v.version_id = p_baseline_version_id AND v.package_id = p_package_id AND v.sha256 = p_baseline_sha256
    )) THEN
        RAISE EXCEPTION 'PACKAGE_REVIEW_REPORT_CONFLICT: baseline is not another exact version of this package';
    END IF;
    INSERT INTO ${s}.agent_package_review_reports (
        package_id, version_id, candidate_sha256, baseline_version_id, baseline_sha256,
        session_id, author_provider, author_subject, report)
    VALUES (p_package_id, p_version_id, p_sha256, p_baseline_version_id, p_baseline_sha256,
        NULLIF(BTRIM(p_session_id), ''), p_provider, p_subject, p_report)
    RETURNING report_id INTO v_id;
    RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- Newest report for the exact candidate and baseline, and only while the
-- candidate is still pending with that digest. NULL otherwise.
CREATE OR REPLACE FUNCTION ${s}.cms_get_agent_package_review_report(
    p_package_id TEXT, p_version_id TEXT, p_sha256 TEXT,
    p_baseline_version_id TEXT, p_baseline_sha256 TEXT, p_is_admin BOOLEAN
) RETURNS JSONB AS $$
DECLARE
    v_report JSONB;
BEGIN
    IF p_is_admin IS NOT TRUE THEN
        RAISE EXCEPTION 'PACKAGE_REVIEW_REPORT_FORBIDDEN: authenticated administrator required';
    END IF;
    SELECT jsonb_build_object(
        'reportId', rr.report_id::TEXT,
        'packageId', rr.package_id,
        'versionId', rr.version_id,
        'sha256', rr.candidate_sha256,
        'baselineVersionId', rr.baseline_version_id,
        'baselineSha256', rr.baseline_sha256,
        'sessionId', rr.session_id,
        'authorProvider', rr.author_provider,
        'authorSubject', rr.author_subject,
        'createdAt', rr.created_at,
        'content', rr.report)
    INTO v_report
    FROM ${s}.agent_package_review_reports rr
    JOIN ${s}.agent_package_reviews r
      ON r.version_id = rr.version_id AND r.sha256 = rr.candidate_sha256 AND r.decision = 'pending'
    WHERE rr.package_id = p_package_id AND rr.version_id = p_version_id AND rr.candidate_sha256 = p_sha256
      AND rr.baseline_version_id IS NOT DISTINCT FROM p_baseline_version_id
      AND rr.baseline_sha256 IS NOT DISTINCT FROM p_baseline_sha256
    ORDER BY rr.created_at DESC, rr.report_id DESC
    LIMIT 1;
    RETURN v_report;
END;
$$ LANGUAGE plpgsql STABLE;
`;
}
