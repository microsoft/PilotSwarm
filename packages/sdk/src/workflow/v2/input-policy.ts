import { normalizeMessageSender, type MessageSender } from "../../message-sender.js";
import type { WorkflowLineage, WorkflowStore } from "./store.js";

/**
 * Workflow v2: direct human input to an agent state's subtree (design 03
 * human-input denial and depth; R12 to R14, R16). The policy reads a
 * session's lineage from the store (readWorkflowLineage: the session rows and
 * the agent states' immutable invocation records), never from a caller's
 * claim, so it holds whichever transport the input came through. A session
 * is in an agent state's subtree when it, or an ancestor, is an agent state's
 * child; only controller 1.9.0 creates such children, so outside its tests
 * no session is in one and nothing here changes.
 *
 * - Human conversational input (a prompt, an answer, a steer, a custom
 *   session event, a canvas write or action, a workspace command) to such a
 *   session is refused before anything is queued (WORKFLOW_HUMAN_INPUT_DENIED).
 *   Reading it, and the authorized lifecycle controls of its workflow (pause,
 *   stop, cancel, delete), stay as they are.
 * - Input stamped as an agent's by the host (`sender.kind === "agent"`: the
 *   portal stamps every caller as a user, so an API caller cannot claim it)
 *   is not human input; an agent's authority to message a session is decided
 *   where it sends (message_agent's lineage rule).
 * - Its sessions may nest one level deeper than an ordinary lineage: an
 *   agent state's child is at level 2 and may spawn one child, at level 3
 *   (WORKFLOW_V2_MAX_DESCENDANT_LEVEL), counted on the stored lineage, not
 *   on a nesting level a caller passes.
 * - ask_user is refused there: the agent consults its controlling parent
 *   agent or completes its state with needs_input.
 */

export const WORKFLOW_HUMAN_INPUT_DENIED = "WORKFLOW_HUMAN_INPUT_DENIED";

/**
 * The human input a workflow agent state's subtree refuses. `workflow`: a person's command that changes or drives a
 * workflow session in such a subtree (its definition, inputs, KV, runs or tests: human-commands.ts); its brakes (pause,
 * stop, cancel) are lifecycle controls and stay allowed.
 */
export type WorkflowHumanInputAction = "prompt" | "answer" | "steer" | "event" | "canvas" | "workspace" | "workflow";

const ACTION_WORDS: Record<WorkflowHumanInputAction, string> = {
    prompt: "send it prompts", answer: "answer its questions", steer: "steer its turns", event: "send it session events",
    canvas: "write its canvases", workspace: "change its workspace",
    workflow: "change its definition, inputs, runs or tests (pause, stop and cancel stay available)",
};

/** The deepest level of a workflow agent state's subtree: parent 0, workflow 1, node agent 2 and its child 3 (R16, D02). */
export const WORKFLOW_V2_MAX_DESCENDANT_LEVEL = 3;

/** The refusal of human input to a session in an agent state's subtree: 403, with the workflow and its controlling agent. */
export function workflowHumanInputError(sessionId: string, action: WorkflowHumanInputAction, lineage: WorkflowLineage): Error & { code: string; status: number; details: unknown } {
    const root = lineage.agentRoot!;
    const via = root.controllingSessionId ? ` Message the workflow's parent agent (session ${root.controllingSessionId}) instead;` : "";
    return Object.assign(new Error(`Session ${sessionId} runs a workflow state for workflow ${root.workflowSessionId}: people cannot ${ACTION_WORDS[action]}.`
        + `${via} you can still read its transcript and stop or cancel the workflow.`), {
        code: WORKFLOW_HUMAN_INPUT_DENIED, status: 403,
        details: { sessionId, action, workflowSessionId: root.workflowSessionId, nodeExecutionId: root.nodeExecutionId,
            controllingSessionId: root.controllingSessionId },
    });
}

/** Whether input carries the host's agent stamp (it is not a person's input). */
export function isAgentInput(sender: MessageSender | null | undefined): boolean {
    return normalizeMessageSender(sender)?.kind === "agent";
}

/**
 * Refuse human input to a session in an agent state's subtree. Agent-stamped
 * input passes; a store that cannot read lineage (no workflow store) has no
 * agent states. Throws WORKFLOW_HUMAN_INPUT_DENIED.
 */
export async function assertWorkflowHumanInputAllowed(
    store: Pick<WorkflowStore, "readWorkflowLineage"> | null | undefined,
    sessionId: string,
    action: WorkflowHumanInputAction,
    sender?: MessageSender | null,
): Promise<void> {
    if (isAgentInput(sender) || !store) return;
    const lineage = await store.readWorkflowLineage(sessionId);
    if (lineage?.agentRoot) throw workflowHumanInputError(sessionId, action, lineage);
}

/** What a person may send to a session, by its workflow lineage (read access and lifecycle controls are decided elsewhere). */
export interface WorkflowInputCapabilities {
    canSendPrompt: boolean;
    canAnswer: boolean;
    canSteer: boolean;
    /** Why a person may not, for a session in an agent state's subtree. */
    reason: string | null;
    workflowSessionId: string | null;
    controllingSessionId: string | null;
}

export function workflowInputCapabilities(lineage: WorkflowLineage | null): WorkflowInputCapabilities {
    const root = lineage?.agentRoot ?? null;
    if (root === null) return { canSendPrompt: true, canAnswer: true, canSteer: true, reason: null, workflowSessionId: null, controllingSessionId: null };
    return {
        canSendPrompt: false, canAnswer: false, canSteer: false,
        reason: "This session runs a workflow state. People cannot send it prompts, answers or steers; message the workflow's parent agent instead.",
        workflowSessionId: root.workflowSessionId, controllingSessionId: root.controllingSessionId,
    };
}

/**
 * The most a session may nest at, by its lineage: WORKFLOW_V2_MAX_DESCENDANT_LEVEL
 * in an agent state's subtree, otherwise null (the ordinary limit applies).
 */
export function workflowMaxNestingLevel(lineage: WorkflowLineage | null): number | null {
    return lineage?.agentRoot ? WORKFLOW_V2_MAX_DESCENDANT_LEVEL : null;
}

/**
 * The nesting of a child a session spawns (spawn_agent): its level and the
 * most it may be. In a workflow agent state's subtree, with a readable stored
 * lineage, the child's level is the session's stored level plus one and the
 * most is WORKFLOW_V2_MAX_DESCENDANT_LEVEL (a nesting level a caller passes
 * does not count); elsewhere the session's own nesting level plus one and the
 * ordinary limit, exactly as before.
 */
export function spawnNesting(sessionNestingLevel: number, ordinaryMax: number, lineage: WorkflowLineage | null): { childNestingLevel: number; maxNestingLevel: number } {
    if (lineage?.agentRoot && lineage.level !== null) return { childNestingLevel: lineage.level + 1, maxNestingLevel: WORKFLOW_V2_MAX_DESCENDANT_LEVEL };
    return { childNestingLevel: sessionNestingLevel + 1, maxNestingLevel: ordinaryMax };
}

/** The ask_user refusal a session in an agent state's subtree gets instead of a question to a person (R14). */
export const WORKFLOW_ASK_USER_REFUSAL = "[SYSTEM: ask_user refused — this session runs a workflow state, and people cannot answer it here. "
    + "Message the workflow's controlling parent agent (send_session_message) for a decision, or complete the state with "
    + "complete_workflow_node error code needs_input and say what you need.]";
