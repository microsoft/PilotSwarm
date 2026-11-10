import { createHash } from "node:crypto";

/**
 * Workflow agent states: the ids of their agent chats (child sessions), derived, never random, so a retry, a replay
 * and the store all name the same session. Shared by the runtime and the store (which tells a continued chat from a
 * visit's own chat without a stored flag).
 */

/** A version 8 UUID derived from `prefix` and `value` (deterministic). */
function uuidOf(prefix: string, value: string): string {
    const hash = createHash("sha256").update(prefix).update(value).digest("hex");
    const variant = ((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16);
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

/**
 * The child session of an agent state's node execution: a UUID derived from
 * the node execution id, so every spawn attempt of the same execution names
 * the same session (a retry after a crash finds it) and another execution (a
 * later occurrence of the same state included) names another.
 */
export function workflowAgentChildSessionId(nodeExecutionId: string): string {
    return uuidOf("workflow-agent-node:", nodeExecutionId);
}

/**
 * The agent chat of a state that continues its chat (`chat: continue`; owner decision agent-node-continue-20261106):
 * ONE session per run and state, derived from both (deterministic), so every visit of the state in the run sends its
 * prompt to the same chat. Another run (another Workflow, a Run again, or a test run) gets another chat. When that chat
 * ended on its own before a later visit (deleted, failed, or ended by a person), the visit starts a replacement chat
 * whose id also names the visit number (`visit`), so it is derived too, and later visits continue in it.
 */
export function workflowAgentChatSessionId(runId: string, stateId: string, visit: number | null = null): string {
    const id = uuidOf("workflow-agent-chat:", visit === null ? `${runId}\u0000${stateId}` : `${runId}\u0000${stateId}\u0000${visit}`);
    // The last group starts with the chat mark, so a continued chat is known by its id alone (workflowAgentChatContinues).
    return `${id.slice(0, 24)}${CHAT_MARK}${id.slice(24 + CHAT_MARK.length)}`;
}

/**
 * Whether `sessionId` has the shape of an agent state's chat (a version 8 UUID, which only uuidOf above makes): a visit's
 * own child or a continued chat. A cheap necessary mark, not proof: the store decides whether the session is one.
 * Pure. The session orchestration reports a failed turn only for such a session (agent-turn-failure.ts).
 */
export function isWorkflowAgentSessionIdShape(sessionId: unknown): boolean {
    return typeof sessionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sessionId);
}

/** The first characters of the last group of a continued chat's id (hex, so the id stays a UUID). */
const CHAT_MARK = "c0a7";
const CHAT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-c0a7[0-9a-f]{8}$/;

/**
 * Whether an agent invocation's child is a chat that continues across its state's visits (chat: continue), known by
 * the chat's own id: one workflowAgentChatSessionId made (it carries the chat mark) that is not the visit's own child
 * id. Every other invocation (chat: new, whatever its child id) is a visit's own child, handled exactly as before
 * continue mode. Pure.
 */
export function workflowAgentChatContinues(invocation: { nodeExecutionId: string; childSessionId: string }): boolean {
    return CHAT_ID.test(invocation.childSessionId) && invocation.childSessionId !== workflowAgentChildSessionId(invocation.nodeExecutionId);
}
