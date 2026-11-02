/**
 * Migration 0096 — workflow v2 graceful stop and each run's controller version.
 *
 * Only controller 1.9.0 stops a run (design 02 run lifecycle, D03; INACTIVE:
 * only tests start runs at 1.9.0), so a run records the controller version
 * that its admission chose, and the stop is accepted only for a version
 * that runs it:
 *
 * - workflow_runs.controller_version: the controller version the run was
 *   admitted for. Null on runs admitted before this migration (1.8.0 or
 *   earlier); never changed after the admission.
 * - workflow_runs.stop_requested_at, stop_deadline_at and stop_request: an
 *   accepted stop, written once by the stop's transaction and never changed.
 *   The deadline is the store's clock at that transaction plus the stop's
 *   grace seconds; stop_request is the request as canonical JSON (its
 *   operation id, reason, actor and grace). A run with a stop admits no new
 *   node execution; work it admitted may settle until the deadline, then
 *   what is still pending is cancelled and the run ends `stopped`.
 * - workflow_runs.status admits `stopped`, a terminal status: finished_at is
 *   set exactly for completed, failed, cancelled and stopped. Only a run
 *   with a stop request ends stopped.
 *
 * Additive: existing rows keep their values (no controller version, no
 * stop). The session deletion trigger is unchanged: a run that is stopping
 * is still admitted, running or paused, and a deletion ends it cancelled.
 */
export function workflowV2StopMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0096_workflow_v2_stop

ALTER TABLE ${s}.workflow_runs ADD COLUMN IF NOT EXISTS controller_version TEXT;
ALTER TABLE ${s}.workflow_runs ADD COLUMN IF NOT EXISTS stop_requested_at TIMESTAMPTZ;
ALTER TABLE ${s}.workflow_runs ADD COLUMN IF NOT EXISTS stop_deadline_at TIMESTAMPTZ;
ALTER TABLE ${s}.workflow_runs ADD COLUMN IF NOT EXISTS stop_request TEXT;

ALTER TABLE ${s}.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_status_check;
ALTER TABLE ${s}.workflow_runs ADD CONSTRAINT workflow_runs_status_check
    CHECK (status IN ('admitted', 'running', 'paused', 'completed', 'failed', 'cancelled', 'stopped'));
ALTER TABLE ${s}.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_terminal;
ALTER TABLE ${s}.workflow_runs ADD CONSTRAINT workflow_runs_terminal CHECK (
    (status IN ('completed', 'failed', 'cancelled', 'stopped')) = (finished_at IS NOT NULL)
);
ALTER TABLE ${s}.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_stop;
ALTER TABLE ${s}.workflow_runs ADD CONSTRAINT workflow_runs_stop CHECK (
    (stop_requested_at IS NULL) = (stop_deadline_at IS NULL)
    AND (stop_requested_at IS NULL) = (stop_request IS NULL)
    AND (stop_deadline_at IS NULL OR stop_deadline_at >= stop_requested_at)
    AND (status <> 'stopped' OR stop_requested_at IS NOT NULL)
);
`;
}
