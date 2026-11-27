/**
 * Migration 0104 — Workflow re-run from a chosen visit: run-level link/guard columns and visit-level origin columns.
 *
 * Uses `steps` (individually autocommitted, idempotent statements) so:
 *   1. Step 1 adds the nullable columns and `CHECK (...) NOT VALID` constraints under a bounded 5 s lock_timeout and
 *      commits immediately, releasing ACCESS EXCLUSIVE without a full-table scan.
 *   2. Steps 2 and 3 run `VALIDATE CONSTRAINT` in separate transactions under SHARE UPDATE EXCLUSIVE (allowing concurrent
 *      reads and writes).
 *   3. Steps 4 and 5 build the partial rerun indexes `CONCURRENTLY IF NOT EXISTS`.
 */
export function workflowRerunMigration(schema: string): string[] {
    const s = `"${schema.replace(/"/g, "\"\"")}"`;
    const name = schema.replace(/'/g, "''");
    return [
        `
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE ${s}.workflow_runs
    ADD COLUMN IF NOT EXISTS rerun_of_workflow_session_id TEXT,
    ADD COLUMN IF NOT EXISTS rerun_of_run_id TEXT,
    ADD COLUMN IF NOT EXISTS rerun_from_execution_id TEXT,
    ADD COLUMN IF NOT EXISTS rerun_mode TEXT,
    ADD COLUMN IF NOT EXISTS rerun_resume TEXT,
    ADD COLUMN IF NOT EXISTS rerun_resumed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS rerun_reused INTEGER,
    ADD COLUMN IF NOT EXISTS rerun_unwalked INTEGER,
    ADD COLUMN IF NOT EXISTS rerun_actor TEXT;

DO $runs_check$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = '${name}' AND t.relname = 'workflow_runs' AND c.conname = 'workflow_runs_rerun_check'
    ) THEN
        ALTER TABLE ${s}.workflow_runs ADD CONSTRAINT workflow_runs_rerun_check CHECK (
            (rerun_of_workflow_session_id IS NULL AND rerun_of_run_id IS NULL AND rerun_from_execution_id IS NULL
             AND rerun_mode IS NULL AND rerun_resume IS NULL AND rerun_resumed_at IS NULL
             AND rerun_reused IS NULL AND rerun_unwalked IS NULL AND rerun_actor IS NULL)
            OR
            (rerun_of_workflow_session_id IS NOT NULL AND rerun_of_run_id IS NOT NULL AND rerun_from_execution_id IS NOT NULL
             AND rerun_mode IN ('run_again', 'continue') AND rerun_resume IS NOT NULL
             AND rerun_reused IS NOT NULL AND rerun_reused >= 1
             AND rerun_unwalked IS NOT NULL AND rerun_unwalked >= 0 AND rerun_unwalked < rerun_reused
             AND rerun_actor IS NOT NULL)
        ) NOT VALID;
    END IF;
END
$runs_check$;

ALTER TABLE ${s}.workflow_node_executions
    ADD COLUMN IF NOT EXISTS reused_from_execution_id TEXT,
    ADD COLUMN IF NOT EXISTS reused_from_run_id TEXT,
    ADD COLUMN IF NOT EXISTS reused_from_workflow_session_id TEXT,
    ADD COLUMN IF NOT EXISTS reused_at TIMESTAMPTZ;

DO $nodes_check$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = '${name}' AND t.relname = 'workflow_node_executions' AND c.conname = 'workflow_node_executions_reused_check'
    ) THEN
        ALTER TABLE ${s}.workflow_node_executions ADD CONSTRAINT workflow_node_executions_reused_check CHECK (
            (reused_from_execution_id IS NULL AND reused_from_run_id IS NULL
             AND reused_from_workflow_session_id IS NULL AND reused_at IS NULL)
            OR
            (reused_from_execution_id IS NOT NULL AND reused_from_run_id IS NOT NULL
             AND reused_from_workflow_session_id IS NOT NULL AND reused_at IS NOT NULL
             AND state = 'completed' AND deadline_at IS NULL)
        ) NOT VALID;
    END IF;
END
$nodes_check$;
COMMIT;
`,
        `
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE ${s}.workflow_runs VALIDATE CONSTRAINT workflow_runs_rerun_check;
COMMIT;
`,
        `
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE ${s}.workflow_node_executions VALIDATE CONSTRAINT workflow_node_executions_reused_check;
COMMIT;
`,
        `
CREATE INDEX CONCURRENTLY IF NOT EXISTS workflow_runs_by_rerun_of_run
    ON ${s}.workflow_runs (rerun_of_run_id, created_at) WHERE rerun_of_run_id IS NOT NULL;
`,
        `
CREATE INDEX CONCURRENTLY IF NOT EXISTS workflow_runs_by_rerun_of_workflow
    ON ${s}.workflow_runs (rerun_of_workflow_session_id, created_at) WHERE rerun_of_workflow_session_id IS NOT NULL;
`,
    ];
}
