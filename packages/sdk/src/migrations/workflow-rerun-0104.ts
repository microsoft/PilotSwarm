/**
 * Migration 0104 — Workflow re-run from a chosen visit (run_again, continue, supply):
 * run-level link/guard columns, visit-level reused/supplied provenance columns, and the first acceptance time of a
 * carried inbox message (workflow_inbox.origin_accepted_at).
 *
 * Uses `steps` (individually autocommitted, idempotent statements) so:
 *   1. Step 1 adds the nullable columns and `CHECK (...) NOT VALID` constraints under a bounded 5 s lock_timeout
 *      (also replacing an earlier form of either CHECK constraint when the steps run over one, via pg_get_constraintdef,
 *      read only for this schema's own table so a concurrently dropped schema's same-named constraint is never decompiled)
 *      and commits immediately, releasing ACCESS EXCLUSIVE without a full-table scan. An earlier run check is one without
 *      supply mode, or one without the explicit `rerun_mode IS NOT NULL` guard (a SQL-null mode made its re-run branch
 *      UNKNOWN, which a CHECK accepts).
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
DECLARE
    v_table regclass := to_regclass(format('%I.%I', '${name}', 'workflow_runs'));
    v_def text;
BEGIN
    SELECT pg_get_constraintdef(c.oid) INTO v_def
      FROM pg_constraint c
     WHERE c.conrelid = v_table AND c.conname = 'workflow_runs_rerun_check';
    IF v_def IS NOT NULL AND v_def NOT LIKE '%supply%'
       OR v_def IS NOT NULL AND v_def NOT LIKE '%rerun_mode IS NOT NULL%' THEN
        ALTER TABLE ${s}.workflow_runs DROP CONSTRAINT workflow_runs_rerun_check;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conrelid = v_table AND c.conname = 'workflow_runs_rerun_check'
    ) THEN
        ALTER TABLE ${s}.workflow_runs ADD CONSTRAINT workflow_runs_rerun_check CHECK (
            (rerun_of_workflow_session_id IS NULL AND rerun_of_run_id IS NULL AND rerun_from_execution_id IS NULL
             AND rerun_mode IS NULL AND rerun_resume IS NULL AND rerun_resumed_at IS NULL
             AND rerun_reused IS NULL AND rerun_unwalked IS NULL AND rerun_actor IS NULL)
            OR
            (rerun_of_workflow_session_id IS NOT NULL AND rerun_of_run_id IS NOT NULL AND rerun_from_execution_id IS NOT NULL
             AND rerun_mode IS NOT NULL AND rerun_mode IN ('run_again', 'continue', 'supply') AND rerun_resume IS NOT NULL
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
DECLARE
    v_table regclass := to_regclass(format('%I.%I', '${name}', 'workflow_node_executions'));
    v_def text;
BEGIN
    SELECT pg_get_constraintdef(c.oid) INTO v_def
      FROM pg_constraint c
     WHERE c.conrelid = v_table AND c.conname = 'workflow_node_executions_reused_check';
    IF v_def IS NOT NULL AND v_def NOT LIKE '%supplied_from_execution_id%' THEN
        ALTER TABLE ${s}.workflow_node_executions DROP CONSTRAINT workflow_node_executions_reused_check;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        WHERE c.conrelid = v_table AND c.conname = 'workflow_node_executions_reused_check'
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

-- Review RR-1: a carried inbox row keeps the time its message was first accepted (copied visits keep their entry times),
-- so a re-run that cuts inside a re-run's copied prefix compares like with like. NULL for a message accepted into its run.
ALTER TABLE ${s}.workflow_inbox
    ADD COLUMN IF NOT EXISTS origin_accepted_at TIMESTAMPTZ;
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
