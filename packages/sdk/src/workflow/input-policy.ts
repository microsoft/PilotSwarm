import { normalizeMessageSender, type MessageSender } from "../message-sender.js";
import type { WorkflowLineage, WorkflowStore } from "./store.js";

/**
 * Workflow: direct human input to an agent state's subtree (design 03
 * human-input denial and depth; R12 to R14, R16). The policy reads a
 * session's lineage from the store (readWorkflowLineage: the session rows and
 * the agent states' immutable invocation records), never from a caller's
 * claim, so it holds whichever transport the input came through. A session
 * is in an agent state's subtree when it, or an ancestor, is an agent state's
 * child; the controller creates such children (the session of an agent
 * state). A session outside every agent state's subtree is not affected.
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
 * - An agent step is at the level of its Workflow; every other session is one
 *   level deeper than its parent; no session may be deeper than
 *   SESSION_MAX_NESTING_LEVEL (2), counted on the stored lineage, not on a
 *   nesting level a caller passes.
 * - ask_user is refused there: the agent consults its controlling parent
 *   agent or completes its state with needs_input.
 */

export const WORKFLOW_HUMAN_INPUT_DENIED = "WORKFLOW_HUMAN_INPUT_DENIED";

/**
 * The human input a workflow agent state's subtree refuses. `workflow`: a person's command that changes or drives a
 * workflow session in such a subtree (its definition, inputs, KV, runs or tests: human-commands.ts); its brakes (pause,
 * stop, cancel) are lifecycle controls and stay allowed.
 */
export type WorkflowHumanInputAction = "prompt" | "answer" | "steer" | "event" | "canvas" | "workspace" | "workflow" | "definitions";

const ACTION_WORDS: Record<WorkflowHumanInputAction, string> = {
    prompt: "send it prompts", answer: "answer its questions", steer: "steer its turns", event: "send it session events",
    canvas: "write its canvases", workspace: "change its workspace",
    workflow: "change its definition, inputs, runs or tests (pause, stop and cancel stay available)",
    definitions: "save, start, test, copy, update or delete its Workflow Definitions",
};

/** The deepest level any session may be (root is 0; first Workflow is free; an agent step is at its Workflow's level; every other child is +1). */
export const SESSION_MAX_NESTING_LEVEL = 2;

export interface SessionLevelNode {
    sessionId: string;
    parentSessionId: string | null;
    isWorkflow: boolean;
    isSystem: boolean;
    isAgentStep?: boolean;
}

export interface EffectiveLevelDetail {
    level: number;
    /** True when the active delegation segment (at or below its root/system reset) contains at least one Workflow session. */
    hasWorkflow: boolean;
}

/**
 * Walk `chain` (ordered from the target session [0] up to its ancestor root) up to its segment root
 * (`isSystem === true` or `parentSessionId === null`), then evaluate from segment root down to target:
 * - segment root: level 0 (hasWorkflow = Boolean(root.isWorkflow && !root.isSystem))
 * - agent step (`isAgentStep === true`): +0
 * - first Workflow in segment (`isWorkflow === true && !hasWorkflow`): +0, sets hasWorkflow = true
 * - any later Workflow or any sub-agent: +1
 * Returns null when `chain` is empty, has a cycle before reaching a segment root, or never reaches a segment root.
 */
export function effectiveLevelDetail(chain: readonly SessionLevelNode[]): EffectiveLevelDetail | null {
    if (chain.length === 0) return null;
    const seen = new Set<string>();
    const segment: SessionLevelNode[] = [];
    let reachedRoot = false;
    for (const node of chain) {
        if (seen.has(node.sessionId)) return null;
        seen.add(node.sessionId);
        segment.push(node);
        if (node.isSystem === true || node.parentSessionId === null) {
            reachedRoot = true;
            break;
        }
    }
    if (!reachedRoot) return null;
    segment.reverse();
    let level = 0;
    let hasWorkflow = segment[0].isWorkflow === true && segment[0].isSystem !== true;
    for (let i = 1; i < segment.length; i += 1) {
        const node = segment[i];
        if (node.isAgentStep === true) continue;
        if (node.isWorkflow === true) {
            if (!hasWorkflow) hasWorkflow = true;
            else level += 1;
        } else {
            level += 1;
        }
    }
    return { level, hasWorkflow };
}

export function effectiveLevel(chain: readonly SessionLevelNode[]): number | null {
    return effectiveLevelDetail(chain)?.level ?? null;
}

/** Alias preserved for existing imports. */
export const computeSessionLevel = effectiveLevel;

/**
 * Given a parent's EffectiveLevelDetail, compute the effective level of a direct child of kind `childKind`.
 * Equivalent to appending the child to the parent's chain and calling `effectiveLevel`.
 */
export function effectiveChildLevel(
    parent: EffectiveLevelDetail,
    childKind: "sub_agent" | "workflow" | "agent_step",
): number {
    if (childKind === "agent_step") return parent.level;
    if (childKind === "workflow") return parent.hasWorkflow ? parent.level + 1 : parent.level;
    return parent.level + 1;
}

/**
 * A1 (Workflow Simplified, spec 14; owner decision E4): sessions inside a Workflow (an agent node's session and its
 * sub-agents: any session in an agent state's subtree) get no definition tools, and the server refuses the calls too.
 * Ordinary sub-agents outside every Workflow keep them (O3). The tools that create or change a definition:
 */
export const WORKFLOW_DEFINITION_TOOLS: readonly string[] = ["spawn_workflow", "update_workflow", "workflow_definition"];

/** The code of the A1 refusal. */
export const WORKFLOW_DEFINITION_TOOLS_REFUSED = "WORKFLOW_DEFINITION_TOOLS_REFUSED";

/** The A1 refusal, in words (spec 14 mock: "Sessions inside a Workflow cannot create definitions."). */
export const WORKFLOW_DEFINITION_TOOLS_REFUSAL_TEXT = "Sessions inside a Workflow cannot create or change workflow definitions. "
    + "Do this work with your other tools; the session that owns the Workflow changes its definition.";

/** Whether a session, by its stored lineage, is inside a Workflow and so gets no definition tools (A1). */
export function workflowDefinitionToolsRefused(lineage: WorkflowLineage | null | undefined): boolean {
    return Boolean(lineage?.agentRoot);
}

/** A1 by the store: whether `sessionId` is inside a Workflow, read from its stored lineage. Throws when it cannot be read. */
export async function sessionInsideWorkflow(store: Pick<WorkflowStore, "readWorkflowLineage">, sessionId: string): Promise<boolean> {
    return workflowDefinitionToolsRefused(await store.readWorkflowLineage(sessionId));
}

/**
 * A1 for every tool registry (review SF-2): a session inside a Workflow is offered no MCP server's tool named as a
 * definition tool either (a person-mode update_workflow of the PilotSwarm MCP server, or any server's spawn_workflow or
 * update_workflow). These are the session's tool filters for the MCP servers it has (`serverNames`): the runtime names an
 * MCP tool `<server>-<tool>`, matched as an MCP tool and by that name.
 */
export function workflowDefinitionMcpToolFilters(serverNames: Iterable<string>): string[] {
    const filters: string[] = [];
    for (const server of serverNames) {
        for (const tool of WORKFLOW_DEFINITION_TOOLS) filters.push(`mcp:${server}-${tool}`, `${server}-${tool}`);
    }
    return filters;
}

/**
 * The same, where a call is permitted: a session inside a Workflow is refused any MCP tool named as a definition tool,
 * whatever its server and however it was offered, with the A1 words; every other request goes to `base` unchanged.
 */
export function workflowDefinitionMcpPermission<A extends unknown[], R>(base: (request: { kind?: string; toolName?: string } | undefined, ...rest: A) => R)
    : (request: { kind?: string; toolName?: string } | undefined, ...rest: A) => R | { kind: "reject"; feedback: string } {
    return (request, ...rest) => (request?.kind === "mcp" && typeof request.toolName === "string" && WORKFLOW_DEFINITION_TOOLS.includes(request.toolName)
        ? { kind: "reject", feedback: WORKFLOW_DEFINITION_TOOLS_REFUSAL_TEXT }
        : base(request, ...rest));
}

/** The A1 refusal as the tool answers it: the workflow tools' JSON refusal with its code. */
export function workflowDefinitionToolsRefusal(): string {
    return JSON.stringify({ ok: false, error: { code: WORKFLOW_DEFINITION_TOOLS_REFUSED, message: WORKFLOW_DEFINITION_TOOLS_REFUSAL_TEXT } });
}

/**
 * The nesting refusal reason of spawn_agent in words. `level` is the calling session's effective level (or null when
 * its stored delegation chain cannot be verified); `max` is the deepest level any session may be.
 */
export function spawnNestingRefusalReason(level: number | null, max: number, insideWorkflow: boolean): string {
    if (level === null) {
        return `this session's delegation chain cannot be verified, and nothing goes past level ${max}. Do this work yourself.`;
    }
    return insideWorkflow
        ? `this session is at level ${level}, and nothing goes past level ${max} (your session is level 0; each sub-agent or Workflow is one level below whoever started it, the first Workflow in a chain is free, and an agent step sits at its Workflow's level). A sub-agent here would be at level ${level + 1}. Do this work yourself.`
        : `you are already at nesting level ${level} (max ${max}). Sub-agents at this depth cannot spawn further sub-agents. Handle the task directly instead.`;
}

/**
 * The nesting refusal of spawn_agent in words. `level` is the calling session's level (or null when unverified);
 * `max` the deepest a session may be.
 */
export function spawnNestingRefusal(level: number | null, max: number, insideWorkflow: boolean): string {
    return `[SYSTEM: spawn_agent failed — ${spawnNestingRefusalReason(level, max, insideWorkflow)}]`;
}

/** The refusal of human input to a session in an agent state's subtree: 403, with the workflow and its controlling agent. */
export function workflowHumanInputError(sessionId: string, action: WorkflowHumanInputAction, lineage: WorkflowLineage): Error & { code: string; status: number; details: unknown } {
    const root = lineage.agentRoot!;
    const via = root.controllingSessionId ? ` Message the workflow's parent agent (session ${root.controllingSessionId}) instead;` : "";
    return Object.assign(new Error(`Session ${sessionId} runs a step of workflow ${root.workflowSessionId}: people cannot ${ACTION_WORDS[action]}.`
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
        reason: "This session runs a step of a workflow. People cannot send it prompts, answers or instructions; message the workflow's parent agent instead.",
        workflowSessionId: root.workflowSessionId, controllingSessionId: root.controllingSessionId,
    };
}

/**
 * The nesting of a child a session spawns (spawn_agent): its level and the
 * most it may be. Whenever stored lineage is present, the child's level comes
 * from `lineage.level + 1` (failing closed when `lineage.level === null`) and
 * the cap is SESSION_MAX_NESTING_LEVEL; only when no lineage is passed does
 * the session's own nesting level and ordinary limit apply.
 */
export function spawnNesting(sessionNestingLevel: number, ordinaryMax: number, lineage: WorkflowLineage | null): { childNestingLevel: number; maxNestingLevel: number } {
    if (lineage !== null) {
        const max = SESSION_MAX_NESTING_LEVEL;
        if (lineage.level === null) return { childNestingLevel: max + 1, maxNestingLevel: max };
        return { childNestingLevel: lineage.level + 1, maxNestingLevel: max };
    }
    return { childNestingLevel: sessionNestingLevel + 1, maxNestingLevel: ordinaryMax };
}

/** The ask_user refusal a session in an agent state's subtree gets instead of a question to a person (R14). */
export const WORKFLOW_ASK_USER_REFUSAL = "[SYSTEM: ask_user refused — this session runs a workflow state, and people cannot answer it here. "
    + "Message the workflow's controlling parent agent (send_session_message) for a decision, or complete the state with "
    + "complete_workflow_node error code needs_input and say what you need.]";
