/**
 * Migration 0085 — workflow v2 definitions, revisions, runs and node executions.
 *
 * Additive only: legacy workflow sessions (controller 1.0/1.1) keep their
 * creation_config admission and are not read from these tables.
 *
 * Values that a workflow author or caller supplies (inputs, outputs, error
 * envelopes, receipts, IR) are canonical JSON TEXT, not JSONB, because JSONB
 * rejects some valid JSON strings (`\u0000`, lone surrogates).
 *
 * Concurrency: every mutation of a definition locks its row first; every
 * mutation of run state locks the run row first. A node execution's terminal
 * result is a single compare-and-swap from 'pending'.
 */
export function workflowV2Migration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0085_workflow_v2

CREATE TABLE IF NOT EXISTS ${s}.workflow_definitions (
    workflow_session_id   TEXT PRIMARY KEY,
    parent_session_id     TEXT,
    api_version           TEXT NOT NULL,
    semver                TEXT,
    state                 TEXT NOT NULL CHECK (state IN ('draft', 'published', 'deleted')),
    current_revision      INTEGER NOT NULL CHECK (current_revision >= 1),
    published_revision    INTEGER,
    published_yaml_sha256 TEXT,
    published_ir_sha256   TEXT,
    notify_parent         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at          TIMESTAMPTZ,
    CONSTRAINT workflow_definitions_published_pins CHECK (
        state <> 'published'
        OR (published_revision IS NOT NULL AND published_yaml_sha256 IS NOT NULL AND published_ir_sha256 IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS ${s}.workflow_revisions (
    workflow_session_id TEXT NOT NULL REFERENCES ${s}.workflow_definitions (workflow_session_id),
    revision            INTEGER NOT NULL CHECK (revision >= 1),
    yaml                TEXT NOT NULL,
    yaml_sha256         TEXT NOT NULL,
    valid               BOOLEAN NOT NULL,
    diagnostics         TEXT NOT NULL,
    name                TEXT,
    semver              TEXT,
    ir                  TEXT,
    ir_sha256           TEXT,
    actor               TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workflow_session_id, revision),
    CONSTRAINT workflow_revisions_valid_ir CHECK (valid = (ir IS NOT NULL AND ir_sha256 IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS ${s}.workflow_operations (
    workflow_session_id TEXT NOT NULL,
    operation_id        TEXT NOT NULL,
    kind                TEXT NOT NULL,
    request_sha256      TEXT NOT NULL,
    receipt             TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workflow_session_id, operation_id)
);

CREATE TABLE IF NOT EXISTS ${s}.workflow_runs (
    run_id                 TEXT PRIMARY KEY,
    workflow_session_id    TEXT NOT NULL REFERENCES ${s}.workflow_definitions (workflow_session_id),
    mode                   TEXT NOT NULL CHECK (mode IN ('live', 'test')),
    revision               INTEGER NOT NULL,
    yaml_sha256            TEXT NOT NULL,
    ir_sha256              TEXT NOT NULL,
    inputs                 TEXT NOT NULL,
    controller_instance_id TEXT NOT NULL UNIQUE,
    status                 TEXT NOT NULL CHECK (status IN ('admitted', 'running', 'completed', 'failed', 'cancelled')),
    test_agent_mode        TEXT CHECK (test_agent_mode IN ('mocked', 'real')),
    terminal_node_id       TEXT,
    terminal_outcome       TEXT,
    terminal_output        TEXT,
    terminal_error         TEXT,
    start_operation_id     TEXT NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at            TIMESTAMPTZ,
    FOREIGN KEY (workflow_session_id, revision) REFERENCES ${s}.workflow_revisions (workflow_session_id, revision),
    CONSTRAINT workflow_runs_test_mode CHECK ((mode = 'test') = (test_agent_mode IS NOT NULL)),
    CONSTRAINT workflow_runs_terminal CHECK (
        (status IN ('completed', 'failed', 'cancelled')) = (finished_at IS NOT NULL)
    )
);

-- One live run per published workflow child (D04).
CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_one_live
    ON ${s}.workflow_runs (workflow_session_id) WHERE mode = 'live';
CREATE INDEX IF NOT EXISTS workflow_runs_by_workflow
    ON ${s}.workflow_runs (workflow_session_id, created_at);

CREATE TABLE IF NOT EXISTS ${s}.workflow_node_executions (
    node_execution_id TEXT PRIMARY KEY,
    run_id            TEXT NOT NULL REFERENCES ${s}.workflow_runs (run_id),
    scope_id          TEXT NOT NULL,
    node_id           TEXT NOT NULL,
    ordinal           INTEGER NOT NULL CHECK (ordinal >= 1),
    node_type         TEXT NOT NULL,
    predecessor_id    TEXT REFERENCES ${s}.workflow_node_executions (node_execution_id),
    arrival_route     TEXT,
    input             TEXT NOT NULL,
    input_sha256      TEXT NOT NULL,
    state             TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
    outcome           TEXT,
    result_kind       TEXT CHECK (result_kind IN ('business', 'runtime_error')),
    output            TEXT,
    error             TEXT,
    winner            TEXT,
    effect_attempts   INTEGER NOT NULL DEFAULT 0,
    entered_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at      TIMESTAMPTZ,
    UNIQUE (run_id, scope_id, node_id, ordinal),
    CONSTRAINT workflow_node_executions_terminal CHECK (
        (state = 'completed') = (outcome IS NOT NULL AND result_kind IS NOT NULL AND winner IS NOT NULL AND completed_at IS NOT NULL)
    ),
    CONSTRAINT workflow_node_executions_result CHECK (
        result_kind IS NULL
        OR (result_kind = 'business' AND output IS NOT NULL AND error IS NULL)
        OR (result_kind = 'runtime_error' AND error IS NOT NULL AND output IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS workflow_node_executions_by_run
    ON ${s}.workflow_node_executions (run_id, entered_at);

-- Exclusive creation of a v2 workflow session row. The INSERT is the claim:
-- when any row with this id exists (live or deleted, of any kind, committed
-- or being inserted concurrently), nothing is changed and FALSE is returned.
-- Root, group and visibility resolve as in cms_create_session.
CREATE OR REPLACE FUNCTION ${s}.cms_create_workflow_session_v2(
    p_session_id        TEXT,
    p_parent_session_id TEXT,
    p_creation_config   JSONB
) RETURNS BOOLEAN AS $$
DECLARE
    v_root    TEXT;
    v_group   TEXT;
    v_claimed TEXT;
BEGIN
    IF p_parent_session_id IS NOT NULL THEN
        SELECT COALESCE(parent.root_session_id, parent.session_id), parent.group_id
          INTO v_root, v_group
          FROM ${s}.sessions parent
         WHERE parent.session_id = p_parent_session_id;
    END IF;
    v_root := COALESCE(v_root, p_session_id);

    INSERT INTO ${s}.sessions
        (session_id, parent_session_id, is_system, group_id, root_session_id, visibility, session_kind, creation_config)
    VALUES
        (p_session_id, p_parent_session_id, FALSE, v_group, v_root, 'private', 'workflow', p_creation_config)
    ON CONFLICT (session_id) DO NOTHING
    RETURNING session_id INTO v_claimed;

    IF v_claimed IS NULL THEN
        RETURN FALSE;
    END IF;

    INSERT INTO ${s}.session_metric_summaries (session_id, parent_session_id)
    VALUES (p_session_id, p_parent_session_id)
    ON CONFLICT (session_id) DO UPDATE
    SET parent_session_id = COALESCE(${s}.session_metric_summaries.parent_session_id, EXCLUDED.parent_session_id),
        updated_at        = now();
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Deleting a workflow session ends its v2 workflow in the same transaction,
-- whatever deletes it: the definition becomes a permanent tombstone, active
-- runs are cancelled and their pending node executions lose to the deletion.
-- Every v2 transition locks the session row first and re-checks deleted_at,
-- so nothing admits, starts or completes work after this commits.
CREATE OR REPLACE FUNCTION ${s}.workflow_v2_on_session_deleted() RETURNS TRIGGER AS $$
DECLARE
    v_envelope CONSTANT TEXT := '{"code":"cancelled","message":"The workflow session was deleted."}';
BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        UPDATE ${s}.workflow_definitions
           SET state = 'deleted', updated_at = now()
         WHERE workflow_session_id = NEW.session_id
           AND state <> 'deleted';
        UPDATE ${s}.workflow_node_executions AS node
           SET state = 'completed', outcome = 'cancelled', result_kind = 'runtime_error',
               error = v_envelope, output = NULL, winner = 'delete', completed_at = now()
          FROM ${s}.workflow_runs AS run
         WHERE run.run_id = node.run_id
           AND run.workflow_session_id = NEW.session_id
           AND run.status IN ('admitted', 'running')
           AND node.state = 'pending';
        UPDATE ${s}.workflow_runs
           SET status = 'cancelled', terminal_error = v_envelope, updated_at = now(), finished_at = now()
         WHERE workflow_session_id = NEW.session_id
           AND status IN ('admitted', 'running');
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_v2_session_deleted ON ${s}.sessions;
CREATE TRIGGER workflow_v2_session_deleted
    AFTER UPDATE OF deleted_at ON ${s}.sessions
    FOR EACH ROW EXECUTE FUNCTION ${s}.workflow_v2_on_session_deleted();
`;
}
