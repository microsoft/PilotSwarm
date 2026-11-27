/**
 * Migration 0104 — Workflow re-run from a chosen visit (run_again, continue, supply):
 * run-level link/guard columns and visit-level reused/supplied provenance columns.
 *
 * Uses `steps` (individually autocommitted, idempotent statements) so:
 *   1. Step 1 adds the nullable columns and `CHECK (...) NOT VALID` constraints under a bounded 5 s lock_timeout
 *      (also self-upgrading any pre-supply 3A constraint via pg_get_constraintdef) and commits immediately,
 *      releasing ACCESS EXCLUSIVE without a full-table scan.
 *   2. Steps 2 and 3 run `VALIDATE CONSTRAINT` in separate transactions under SHARE UPDATE EXCLUSIVE (allowing concurrent
 *      reads and writes).
 *   3. Steps 4–7 drop any invalid leftover index (`NOT i.indisvalid`, as migration 0088 does) under a 5 s lock_timeout
 *      before building each partial rerun index `CONCURRENTLY IF NOT EXISTS`.
 */
export function workflowRerunMigration(schema: string): string[] {
    const s = `"${schema.replace(/"/g, "\"\"")}"`;
    const name = schema.replace(/'/g, "''");
    const dropInvalidIndex = (indexName: string, tag: string) => `
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $${tag}$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = '${name}'
          AND c.relname = '${indexName}'
          AND NOT i.indisvalid
    ) THEN
        EXECUTE format('DROP INDEX %I.%I', '${name}', '${indexName}');
    END IF;
END
$${tag}$;
COMMIT;
`;
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
    IF EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = '${name}' AND t.relname = 'workflow_runs' AND c.conname = 'workflow_runs_rerun_check'
          AND pg_get_constraintdef(c.oid) NOT LIKE '%supply%'
    ) THEN
        ALTER TABLE ${s}.workflow_runs DROP CONSTRAINT workflow_runs_rerun_check;
    END IF;
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
             AND rerun_mode IN ('run_again', 'continue', 'supply') AND rerun_resume IS NOT NULL
             AND rerun_reused IS NOT NULL AND rerun_unwalked IS NOT NULL AND rerun_unwalked >= 0
             AND (
                 (rerun_mode IN ('run_again', 'continue') AND rerun_reused >= 1 AND rerun_unwalked < rerun_reused)
                 OR
                 (rerun_mode = 'supply' AND (
                     (rerun_reused = 0 AND rerun_unwalked = 0)
                     OR (rerun_reused >= 1 AND rerun_unwalked < rerun_reused)
                 ))
             )
             AND rerun_actor IS NOT NULL)
        ) NOT VALID;
    END IF;
END
$runs_check$;

ALTER TABLE ${s}.workflow_node_executions
    ADD COLUMN IF NOT EXISTS reused_from_execution_id TEXT,
    ADD COLUMN IF NOT EXISTS reused_from_run_id TEXT,
    ADD COLUMN IF NOT EXISTS reused_from_workflow_session_id TEXT,
    ADD COLUMN IF NOT EXISTS reused_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS supplied_from_execution_id TEXT,
    ADD COLUMN IF NOT EXISTS supplied_from_run_id TEXT,
    ADD COLUMN IF NOT EXISTS supplied_from_workflow_session_id TEXT,
    ADD COLUMN IF NOT EXISTS supplied_actor TEXT,
    ADD COLUMN IF NOT EXISTS supplied_note TEXT,
    ADD COLUMN IF NOT EXISTS supplied_at TIMESTAMPTZ;

DO $nodes_check$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = '${name}' AND t.relname = 'workflow_node_executions' AND c.conname = 'workflow_node_executions_reused_check'
          AND pg_get_constraintdef(c.oid) NOT LIKE '%supplied_from_execution_id%'
    ) THEN
        ALTER TABLE ${s}.workflow_node_executions DROP CONSTRAINT workflow_node_executions_reused_check;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = '${name}' AND t.relname = 'workflow_node_executions' AND c.conname = 'workflow_node_executions_reused_check'
    ) THEN
        ALTER TABLE ${s}.workflow_node_executions ADD CONSTRAINT workflow_node_executions_reused_check CHECK (
            (
                (reused_from_execution_id IS NULL AND reused_from_run_id IS NULL
                 AND reused_from_workflow_session_id IS NULL AND reused_at IS NULL)
                OR
                (reused_from_execution_id IS NOT NULL AND reused_from_run_id IS NOT NULL
                 AND reused_from_workflow_session_id IS NOT NULL AND reused_at IS NOT NULL)
            )
            AND
            (
                (supplied_from_execution_id IS NULL AND supplied_from_run_id IS NULL
                 AND supplied_from_workflow_session_id IS NULL AND supplied_actor IS NULL
                 AND supplied_note IS NULL AND supplied_at IS NULL
                 AND winner IS DISTINCT FROM 'supplied')
                OR
                (supplied_from_execution_id IS NOT NULL AND supplied_from_run_id IS NOT NULL
                 AND supplied_from_workflow_session_id IS NOT NULL AND supplied_actor IS NOT NULL
                 AND supplied_note IS NOT NULL AND length(btrim(supplied_note)) >= 1 AND char_length(supplied_note) <= 2000
                 AND supplied_at IS NOT NULL
                 AND winner = 'supplied' AND result_kind = 'business' AND effect_attempts = 0)
            )
            AND
            (
                (reused_from_execution_id IS NULL AND supplied_from_execution_id IS NULL)
                OR
                (state = 'completed' AND deadline_at IS NULL)
            )
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
        dropInvalidIndex("workflow_runs_by_rerun_of_run", "rerun_run_idx"),
        `
CREATE INDEX CONCURRENTLY IF NOT EXISTS workflow_runs_by_rerun_of_run
    ON ${s}.workflow_runs (rerun_of_run_id, created_at) WHERE rerun_of_run_id IS NOT NULL;
`,
        dropInvalidIndex("workflow_runs_by_rerun_of_workflow", "rerun_wf_idx"),
        `
CREATE INDEX CONCURRENTLY IF NOT EXISTS workflow_runs_by_rerun_of_workflow
    ON ${s}.workflow_runs (rerun_of_workflow_session_id, created_at) WHERE rerun_of_workflow_session_id IS NOT NULL;
`,
    ];
}
