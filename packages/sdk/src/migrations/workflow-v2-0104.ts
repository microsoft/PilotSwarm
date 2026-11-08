/**
 * Migration 0104 — workflow v2 run deadlines (design 02 run lifecycle and
 * the canonical `limits: { timeoutSeconds, onExceeded }`; INACTIVE: only
 * controller 1.9.0 sets or enforces one).
 *
 * - workflow_runs.deadline_at: when a run whose pinned definition declares
 *   limits.timeoutSeconds must have ended: the run's clock when it began
 *   (the store's clock, or a test run's virtual clock) plus those seconds,
 *   written once by the begin transaction; null for every other run. From
 *   then on no node execution is admitted, and the run's controller ends it
 *   failed with timed_out (onExceeded expired), cancelling what is still
 *   pending. Pause does not stop the clock (D03).
 *
 * Additive: one nullable column; no existing row changes.
 */
export function workflowV2RunDeadlineMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0104_workflow_v2_run_deadline

ALTER TABLE ${s}.workflow_runs ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;
`;
}
