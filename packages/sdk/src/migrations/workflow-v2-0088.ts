/**
 * Migration 0088 — workflow v2 wait states.
 *
 * A wait state's node execution records its absolute deadline, fixed in the
 * store's clock when it is admitted (now() plus its seconds): it elapses
 * only once the store's clock reaches it, a restart or continue-as-new keeps
 * it, and read_workflow shows it.
 *
 * Additive: existing node executions have no deadline.
 */
export function workflowV2WaitMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0088_workflow_v2_wait

ALTER TABLE ${s}.workflow_node_executions ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;
`;
}
