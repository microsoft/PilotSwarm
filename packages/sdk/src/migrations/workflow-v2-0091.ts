/**
 * Migration 0091 — workflow v2 run KV and pause.
 *
 * - Open run KV: the current map and its revision on the run row, and every
 *   revision as an immutable row (a node execution pins the revision it was
 *   admitted with; replay reads that revision, never "the latest").
 * - Pause: a run may be `paused` (it admits no new node execution; work
 *   already admitted finishes and its result is kept). `paused_from` records
 *   the status a resume returns to.
 * - The session deletion trigger also ends paused runs.
 *
 * Additive: existing runs get an empty map at revision 1.
 */
export function workflowV2KvPauseMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0091_workflow_v2_kv_pause

ALTER TABLE ${s}.workflow_runs ADD COLUMN IF NOT EXISTS kv TEXT NOT NULL DEFAULT '{}';
ALTER TABLE ${s}.workflow_runs ADD COLUMN IF NOT EXISTS kv_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ${s}.workflow_runs ADD COLUMN IF NOT EXISTS paused_from TEXT;
ALTER TABLE ${s}.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_status_check;
ALTER TABLE ${s}.workflow_runs ADD CONSTRAINT workflow_runs_status_check
    CHECK (status IN ('admitted', 'running', 'paused', 'completed', 'failed', 'cancelled'));
ALTER TABLE ${s}.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_paused_from;
ALTER TABLE ${s}.workflow_runs ADD CONSTRAINT workflow_runs_paused_from
    CHECK ((status = 'paused') = (paused_from IS NOT NULL) AND (paused_from IS NULL OR paused_from IN ('admitted', 'running')));

CREATE TABLE IF NOT EXISTS ${s}.workflow_kv_revisions (
    run_id       TEXT NOT NULL REFERENCES ${s}.workflow_runs (run_id),
    revision     INTEGER NOT NULL CHECK (revision >= 1),
    kv           TEXT NOT NULL,
    operation_id TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, revision)
);
INSERT INTO ${s}.workflow_kv_revisions (run_id, revision, kv)
SELECT run_id, 1, '{}' FROM ${s}.workflow_runs
ON CONFLICT (run_id, revision) DO NOTHING;

ALTER TABLE ${s}.workflow_node_executions ADD COLUMN IF NOT EXISTS kv_revision INTEGER;

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
           AND run.status IN ('admitted', 'running', 'paused')
           AND node.state = 'pending';
        UPDATE ${s}.workflow_runs
           SET status = 'cancelled', paused_from = NULL, terminal_error = v_envelope, updated_at = now(), finished_at = now()
         WHERE workflow_session_id = NEW.session_id
           AND status IN ('admitted', 'running', 'paused');
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
`;
}
