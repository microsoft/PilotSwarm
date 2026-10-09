/**
 * Atomic registered-workflow admission and request idempotency.
 *
 * Admission deliberately precedes session creation. A process that fails after
 * reserving an admission can retry the same request and repair the deterministic
 * session/orchestration start without creating another logical execution.
 */
export function workflowAdmissionsMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
CREATE TABLE IF NOT EXISTS ${s}.workflow_admissions (
    session_id          TEXT PRIMARY KEY,
    definition_id       TEXT NOT NULL REFERENCES ${s}.registered_workflow_definitions(definition_id),
    primary_key_json    JSONB,
    primary_key_sha256  TEXT,
    attempt             INTEGER NOT NULL CHECK (attempt > 0),
    inputs_json         JSONB NOT NULL,
    parent_session_id   TEXT,
    owner_provider      TEXT NOT NULL,
    owner_subject       TEXT NOT NULL,
    owner_email         TEXT,
    owner_display_name  TEXT,
    group_id            TEXT,
    visibility          TEXT CHECK (visibility IS NULL OR visibility IN ('private', 'shared_read', 'shared_write')),
    rerun_reason        TEXT,
    status              TEXT NOT NULL DEFAULT 'admitted' CHECK (status IN ('admitted', 'started')),
    orchestration_id    TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at          TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (primary_key_json IS NULL AND primary_key_sha256 IS NULL)
        OR (
            jsonb_typeof(primary_key_json) = 'array'
            AND primary_key_sha256 ~ '^[0-9a-f]{64}$'
        )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_${schema}_workflow_admission_logical_attempt
    ON ${s}.workflow_admissions(definition_id, primary_key_sha256, attempt)
    WHERE primary_key_sha256 IS NOT NULL;

CREATE TABLE IF NOT EXISTS ${s}.workflow_admission_requests (
    owner_provider      TEXT NOT NULL,
    owner_subject       TEXT NOT NULL,
    idempotency_key     TEXT NOT NULL,
    request_sha256      TEXT NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    session_id          TEXT NOT NULL REFERENCES ${s}.workflow_admissions(session_id) ON DELETE CASCADE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_provider, owner_subject, idempotency_key)
);

CREATE OR REPLACE FUNCTION ${s}.cms_admit_workflow(
    p_session_id          TEXT,
    p_definition_id       TEXT,
    p_inputs_json         JSONB,
    p_primary_key_json    JSONB,
    p_primary_key_sha256  TEXT,
    p_owner_provider      TEXT,
    p_owner_subject       TEXT,
    p_owner_email         TEXT,
    p_owner_display_name  TEXT,
    p_parent_session_id   TEXT,
    p_group_id            TEXT,
    p_visibility          TEXT,
    p_idempotency_key     TEXT,
    p_request_sha256      TEXT,
    p_force_rerun         BOOLEAN,
    p_rerun_reason        TEXT,
    p_is_admin            BOOLEAN
) RETURNS TABLE (
    session_id TEXT,
    definition_id TEXT,
    primary_key_json JSONB,
    primary_key_sha256 TEXT,
    attempt INTEGER,
    inputs_json JSONB,
    parent_session_id TEXT,
    owner_provider TEXT,
    owner_subject TEXT,
    owner_email TEXT,
    owner_display_name TEXT,
    group_id TEXT,
    visibility TEXT,
    rerun_reason TEXT,
    orchestration_id TEXT,
    created BOOLEAN,
    deduplicated BOOLEAN,
    needs_start BOOLEAN
) AS $$
DECLARE
    v_existing ${s}.workflow_admissions%ROWTYPE;
    v_request ${s}.workflow_admission_requests%ROWTYPE;
    v_attempt INTEGER := 1;
    v_reason TEXT := NULLIF(BTRIM(p_rerun_reason), '');
BEGIN
    IF COALESCE(BTRIM(p_session_id), '') = ''
        OR COALESCE(BTRIM(p_definition_id), '') = ''
        OR COALESCE(BTRIM(p_owner_provider), '') = ''
        OR COALESCE(BTRIM(p_owner_subject), '') = ''
        OR COALESCE(BTRIM(p_idempotency_key), '') = ''
        OR LENGTH(p_idempotency_key) > 200
        OR p_request_sha256 !~ '^[0-9a-f]{64}$'
        OR jsonb_typeof(p_inputs_json) IS DISTINCT FROM 'object'
    THEN
        RAISE EXCEPTION 'WORKFLOW_ADMISSION_INVALID: session, definition, owner, inputs, idempotency key, and request identity are required';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM ${s}.registered_workflow_definitions
         WHERE registered_workflow_definitions.definition_id = p_definition_id
    ) THEN
        RAISE EXCEPTION 'WORKFLOW_DEFINITION_NOT_FOUND: registered workflow definition is unavailable';
    END IF;
    IF p_visibility IS NOT NULL
        AND p_visibility NOT IN ('private', 'shared_read', 'shared_write')
    THEN
        RAISE EXCEPTION 'WORKFLOW_ADMISSION_INVALID: unsupported visibility';
    END IF;
    IF (
        p_primary_key_json IS NULL
        OR p_primary_key_sha256 IS NULL
    ) IS DISTINCT FROM (
        p_primary_key_json IS NULL
        AND p_primary_key_sha256 IS NULL
    ) OR (
        p_primary_key_json IS NOT NULL
        AND (
            jsonb_typeof(p_primary_key_json) IS DISTINCT FROM 'array'
            OR p_primary_key_sha256 !~ '^[0-9a-f]{64}$'
        )
    ) THEN
        RAISE EXCEPTION 'WORKFLOW_PRIMARY_KEY_INVALID: primary-key value and identity must be supplied together';
    END IF;
    IF COALESCE(p_force_rerun, FALSE) AND v_reason IS NULL THEN
        RAISE EXCEPTION 'WORKFLOW_RERUN_REASON_REQUIRED: forced reruns require a reason';
    END IF;

    PERFORM pg_advisory_xact_lock(
        hashtextextended(p_owner_provider || E'\\n' || p_owner_subject || E'\\n' || p_idempotency_key, 0)
    );
    SELECT req.* INTO v_request
      FROM ${s}.workflow_admission_requests req
     WHERE req.owner_provider = p_owner_provider
       AND req.owner_subject = p_owner_subject
       AND req.idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF v_request.request_sha256 IS DISTINCT FROM p_request_sha256 THEN
            RAISE EXCEPTION 'WORKFLOW_IDEMPOTENCY_CONFLICT: idempotency key was already used for a different request';
        END IF;
        SELECT adm.* INTO v_existing
          FROM ${s}.workflow_admissions adm
         WHERE adm.session_id = v_request.session_id;
        RETURN QUERY SELECT
            v_existing.session_id, v_existing.definition_id,
            v_existing.primary_key_json, v_existing.primary_key_sha256,
            v_existing.attempt, v_existing.inputs_json,
            v_existing.parent_session_id, v_existing.owner_provider,
            v_existing.owner_subject, v_existing.owner_email,
            v_existing.owner_display_name, v_existing.group_id,
            v_existing.visibility, v_existing.rerun_reason,
            v_existing.orchestration_id, FALSE, TRUE,
            v_existing.status <> 'started';
        RETURN;
    END IF;

    IF p_primary_key_sha256 IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(
            hashtextextended(p_definition_id || E'\\n' || p_primary_key_sha256, 0)
        );
        SELECT adm.* INTO v_existing
          FROM ${s}.workflow_admissions adm
         WHERE adm.definition_id = p_definition_id
           AND adm.primary_key_sha256 = p_primary_key_sha256
         ORDER BY adm.attempt DESC
         LIMIT 1;
    END IF;

    IF COALESCE(p_force_rerun, FALSE) THEN
        IF p_primary_key_sha256 IS NULL OR v_existing.session_id IS NULL THEN
            RAISE EXCEPTION 'WORKFLOW_RERUN_REQUIRED: no prior keyed execution exists to rerun';
        END IF;
        IF NOT COALESCE(p_is_admin, FALSE)
            AND (
                v_existing.owner_provider IS DISTINCT FROM p_owner_provider
                OR v_existing.owner_subject IS DISTINCT FROM p_owner_subject
            )
        THEN
            RAISE EXCEPTION 'WORKFLOW_RERUN_FORBIDDEN: only the existing execution owner or an administrator may rerun it';
        END IF;
        v_attempt := v_existing.attempt + 1;
    ELSIF v_existing.session_id IS NOT NULL THEN
        IF NOT COALESCE(p_is_admin, FALSE)
            AND (
                v_existing.owner_provider IS DISTINCT FROM p_owner_provider
                OR v_existing.owner_subject IS DISTINCT FROM p_owner_subject
            )
        THEN
            RAISE EXCEPTION 'WORKFLOW_DUPLICATE_CONFLICT: this workflow entity already has an execution';
        END IF;
        INSERT INTO ${s}.workflow_admission_requests (
            owner_provider, owner_subject, idempotency_key, request_sha256, session_id
        ) VALUES (
            p_owner_provider, p_owner_subject, p_idempotency_key, p_request_sha256,
            v_existing.session_id
        );
        RETURN QUERY SELECT
            v_existing.session_id, v_existing.definition_id,
            v_existing.primary_key_json, v_existing.primary_key_sha256,
            v_existing.attempt, v_existing.inputs_json,
            v_existing.parent_session_id, v_existing.owner_provider,
            v_existing.owner_subject, v_existing.owner_email,
            v_existing.owner_display_name, v_existing.group_id,
            v_existing.visibility, v_existing.rerun_reason,
            v_existing.orchestration_id, FALSE, TRUE,
            v_existing.status <> 'started';
        RETURN;
    END IF;

    INSERT INTO ${s}.workflow_admissions (
        session_id, definition_id, primary_key_json, primary_key_sha256,
        attempt, inputs_json, parent_session_id,
        owner_provider, owner_subject, owner_email, owner_display_name,
        group_id, visibility, rerun_reason, orchestration_id
    ) VALUES (
        p_session_id, p_definition_id, p_primary_key_json, p_primary_key_sha256,
        v_attempt, p_inputs_json, p_parent_session_id,
        CASE WHEN COALESCE(p_force_rerun, FALSE)
            THEN v_existing.owner_provider ELSE p_owner_provider END,
        CASE WHEN COALESCE(p_force_rerun, FALSE)
            THEN v_existing.owner_subject ELSE p_owner_subject END,
        CASE WHEN COALESCE(p_force_rerun, FALSE)
            THEN v_existing.owner_email ELSE p_owner_email END,
        CASE WHEN COALESCE(p_force_rerun, FALSE)
            THEN v_existing.owner_display_name ELSE p_owner_display_name END,
        CASE WHEN COALESCE(p_force_rerun, FALSE)
            THEN v_existing.group_id ELSE p_group_id END,
        p_visibility, v_reason, 'session-' || p_session_id
    )
    RETURNING * INTO v_existing;

    INSERT INTO ${s}.workflow_admission_requests (
        owner_provider, owner_subject, idempotency_key, request_sha256, session_id
    ) VALUES (
        p_owner_provider, p_owner_subject, p_idempotency_key, p_request_sha256,
        v_existing.session_id
    );

    RETURN QUERY SELECT
        v_existing.session_id, v_existing.definition_id,
        v_existing.primary_key_json, v_existing.primary_key_sha256,
        v_existing.attempt, v_existing.inputs_json,
        v_existing.parent_session_id, v_existing.owner_provider,
        v_existing.owner_subject, v_existing.owner_email,
        v_existing.owner_display_name, v_existing.group_id,
        v_existing.visibility, v_existing.rerun_reason,
        v_existing.orchestration_id, TRUE, FALSE, TRUE;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_mark_workflow_admission_started(
    p_session_id TEXT,
    p_orchestration_id TEXT
) RETURNS VOID AS $$
DECLARE
    v_existing ${s}.workflow_admissions%ROWTYPE;
BEGIN
    SELECT * INTO v_existing
      FROM ${s}.workflow_admissions
     WHERE workflow_admissions.session_id = p_session_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'WORKFLOW_ADMISSION_NOT_FOUND: workflow admission is unavailable';
    END IF;
    IF v_existing.orchestration_id IS DISTINCT FROM p_orchestration_id THEN
        RAISE EXCEPTION 'WORKFLOW_ADMISSION_CONFLICT: orchestration identity does not match admission';
    END IF;
    UPDATE ${s}.workflow_admissions
       SET status = 'started',
           started_at = COALESCE(started_at, now()),
           updated_at = now()
     WHERE workflow_admissions.session_id = p_session_id;
END;
$$ LANGUAGE plpgsql;
`;
}
