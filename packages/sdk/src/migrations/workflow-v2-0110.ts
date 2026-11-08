/**
 * Migration 0110 — OF-S2-7 (owner, 2026-11-07T21:32Z): per-node models chosen at start.
 *
 * A start may map agent nodes to a concrete provider:model, reasoning effort and context tier (agent-models.ts); the map
 * is stored with its run, as canonical JSON, and read at each spawn. Nullable: a run started without one (every run before
 * this migration) inherits each agent node's model from the chat that owns the Workflow. A run admission names the column
 * only when it has a map, so a schema before 0110 admits every other run as before.
 *
 * Additive, idempotent, one transaction, no data rewritten.
 */
export function workflowRunAgentModelsMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0110_workflow_run_agent_models
ALTER TABLE ${s}.workflow_runs ADD COLUMN IF NOT EXISTS agent_models TEXT;
`;
}
