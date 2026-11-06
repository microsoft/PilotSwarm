/**
 * Migration 0106 — workflow v2 agent chats that continue (owner decision
 * agent-node-continue-20261106: an agent state with `chat: continue` keeps
 * one agent chat per run and state, and each later visit of the state is a
 * new cycle prompt in that same chat).
 *
 * - workflow_agent_invocations.child_session_id is no longer UNIQUE: the
 *   visits of a continued chat are one invocation each (node_execution_id
 *   stays the primary key) that all name the same child session. A plain
 *   index keeps the lookups by child (a completion, a reminder) fast. A
 *   state without `chat: continue` still names one child per visit, as
 *   before.
 *
 * Additive in effect: one constraint dropped, one index added; no row
 * changes. The only ON CONFLICT on a child_session_id is on another table
 * (session_child_outcomes).
 */
export function workflowV2AgentChatContinuesMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0106_workflow_v2_agent_chat_continues

ALTER TABLE ${s}.workflow_agent_invocations DROP CONSTRAINT IF EXISTS workflow_agent_invocations_child_session_id_key;
CREATE INDEX IF NOT EXISTS workflow_agent_invocations_by_child ON ${s}.workflow_agent_invocations (child_session_id, created_at);
`;
}
