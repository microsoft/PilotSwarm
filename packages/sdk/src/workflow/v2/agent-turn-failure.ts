/**
 * A failed turn of a Workflow agent state's chat (owner decision, PR 270: the agent step that waited for its deadline).
 *
 * An agent state ends when its chat calls complete_workflow_node, or at its deadline. A chat whose turn fails for good
 * (its retries spent, a non-retryable error, a credential failure) completes nothing and sends nothing, so the step
 * waited for its deadline. Session orchestration 1.0.83 now reports such a turn (orchestration/turn.ts
 * oweWorkflowTurnFailure, settleWorkflowTurnFailure) with this activity, which decides every visit the turn worked on
 * that is still pending: execution_failed, winner controller (as agentSpawnFailed decides a child that was never made),
 * then wakes the run's controller. The controller ends the visit (cancel, as for every decision that is not the agent's
 * own completion) and routes the error like any runtime error: its execution_failed route, else its failure route, else
 * the catch-all state.
 *
 * - The visits a turn worked on: a visit's own chat (chat: new) works on its one visit. A chat that continues across its
 *   state's visits works on the visits its turn's prompts name (their client message ids,
 *   `workflow:<wf>:<run>:agent:<nx>`), which must be this chat's; a turn whose prompts name none (a timer, a sub-agent's
 *   update) works on the visit of the chat's newest prompt that names one (store.readTurnVisit, as the completion and
 *   reminder fences read it). A state's visits are sequential (a continued chat is refused inside a parallel state), so
 *   at most one of them is pending: a turn that carried an earlier visit's late prompt and the next visit's prompt
 *   decides only the next one.
 * - The fence: each visit is decided by the node's single terminal compare-and-swap (store.completeNode: pending only,
 *   under the workflow session's lock), so a visit already decided (its completion, its deadline, a cancel, a stop, the
 *   run's end, a deletion) is left as it is: a late or repeated report is a no-op. A visit is the chat's own when its
 *   invocation names this chat, which never changes.
 * - The wake is a hint, as complete_workflow_node's is: the controller's backstop collection finds the result too.
 */
import type { ActivityContext } from "duroxide";
import { isTransientCmsError } from "../../cms-retry.js";
import { WORKFLOW_COMMAND_QUEUE } from "../commands.js";
import { workflowAgentChatContinues } from "./agent-ids.js";
import { workflowErrorWords } from "./error-words.js";
import { canonicalJson } from "./json.js";
import { redactErrorThenClip, redactThenClip } from "./redact.js";
import { workflowVisitOfPromptId, type NodeResultInput, type WorkflowStore } from "./store.js";

/**
 * The activity session orchestration 1.0.83 schedules for a chat's failed turn. The session proxy routes it with the
 * workflow-request tag (routeWorkflowRequestActivity), which every worker that runs 1.0.83 declares (milestone-worker.ts).
 */
export const WORKFLOW_AGENT_TURN_FAILURE_ACTIVITY = "reportWorkflowAgentTurnFailure";

/** The in-activity waits before each retry of a transient store error. */
export const WORKFLOW_AGENT_TURN_FAILURE_RETRY_DELAYS_MS: readonly number[] = [1_000, 5_000, 15_000];

/** What the session orchestration owes and sends: the chat, its failed turn's prompt ids and why it failed. */
export interface WorkflowAgentTurnFailureInput {
    sessionId: string;
    clientMessageIds: string[];
    cause: string;
}

/** The report's answer: the visits it decided now (possibly none), and why none when it decided none. */
export interface WorkflowAgentTurnFailureResult {
    decided: string[];
    reason: "decided" | "not_a_step" | "no_visit" | "already_decided";
}

/** The durable client call the wake makes. */
export interface WorkflowAgentTurnFailureWakeClient {
    enqueueEvent(instanceId: string, queueName: string, data: string): Promise<void>;
}

/** The input as the orchestration gives it, checked. */
export function parseWorkflowAgentTurnFailureInput(raw: unknown): WorkflowAgentTurnFailureInput {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A turn failure report is { sessionId, clientMessageIds, cause }.");
    const { sessionId, clientMessageIds, cause } = value as Record<string, unknown>;
    if (typeof sessionId !== "string" || !sessionId) throw new Error("A turn failure report needs the chat's sessionId.");
    const ids = Array.isArray(clientMessageIds) ? clientMessageIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
    return { sessionId, clientMessageIds: ids, cause: typeof cause === "string" && cause ? cause : "The turn failed." };
}

/** The visits the failed turn of chat `sessionId` worked on (see the module comment); [] when it is no agent state's chat. */
export async function workflowAgentTurnVisits(store: Pick<WorkflowStore, "readAgentInvocationByChild" | "readAgentInvocation" | "readTurnVisit">,
    input: WorkflowAgentTurnFailureInput): Promise<{ visits: string[]; reason: "not_a_step" | "no_visit" | null }> {
    const newest = await store.readAgentInvocationByChild(input.sessionId);
    if (!newest) return { visits: [], reason: "not_a_step" };
    if (!workflowAgentChatContinues(newest)) return { visits: [newest.nodeExecutionId], reason: null };
    const named = [...new Set(input.clientMessageIds.map(workflowVisitOfPromptId).filter((id): id is string => id !== null))];
    const own: string[] = [];
    for (const id of named) {
        const invocation = await store.readAgentInvocation(id);
        if (invocation?.childSessionId === input.sessionId) own.push(id);
    }
    if (named.length > 0) return own.length > 0 ? { visits: own, reason: null } : { visits: [], reason: "no_visit" };
    const inherited = await store.readTurnVisit(input.sessionId, []);
    return inherited?.nodeExecutionId ? { visits: [inherited.nodeExecutionId], reason: null } : { visits: [], reason: "no_visit" };
}

/**
 * Decide one visit of chat `childSessionId` execution_failed, winner controller, while it is still pending (the store
 * step the formal model calls ReportDecide). Returns the run's controller to wake when this call decided it, else null.
 */
export async function decideWorkflowAgentTurnFailure(store: Pick<WorkflowStore, "readNodeExecution" | "readAgentInvocation" | "completeNode" | "readRun">,
    nodeExecutionId: string, childSessionId: string, cause: string): Promise<{ controllerInstanceId: string; runId: string } | null> {
    const invocation = await store.readAgentInvocation(nodeExecutionId);
    if (!invocation || invocation.childSessionId !== childSessionId) return null;
    const node = await store.readNodeExecution(nodeExecutionId);
    if (!node || node.nodeType !== "agent" || node.state !== "pending") return null;
    const message = `The agent session ${childSessionId} of this step failed, so it cannot complete the step: ${redactThenClip(cause, 1_000)}`;
    const valueText = canonicalJson({ code: "execution_failed", message: redactThenClip(message, 4_000), details: { childSessionId } });
    const result: NodeResultInput = { outcome: "execution_failed", resultKind: "runtime_error", valueText, winner: "controller" };
    const words = workflowErrorWords(valueText);
    const { won } = await store.completeNode(nodeExecutionId, result, {
        sessionId: invocation.workflowSessionId,
        events: [{ eventType: "workflow.state_failed", data: {
            runId: invocation.runId, nodeExecutionId, stateId: node.nodeId, step: node.ordinal, outcome: "execution_failed", resultKind: "runtime_error",
            childSessionId, cause: "agent_turn_failed", error: redactErrorThenClip(valueText, 2_000), ...(words ? { errorWords: words } : {}),
        } }],
        update: { touch: true },
    });
    if (!won) return null;
    const run = await store.readRun(invocation.runId);
    return run ? { controllerInstanceId: run.controllerInstanceId, runId: run.runId } : null;
}

/** The whole report: the turn's visits, each decided while pending, then the controller of each decided visit woken. */
export async function reportWorkflowAgentTurnFailure(deps: {
    store: Pick<WorkflowStore, "readAgentInvocationByChild" | "readAgentInvocation" | "readTurnVisit" | "readNodeExecution" | "completeNode" | "readRun">;
    client: WorkflowAgentTurnFailureWakeClient | null;
}, rawInput: unknown): Promise<WorkflowAgentTurnFailureResult> {
    const input = parseWorkflowAgentTurnFailureInput(rawInput);
    const { visits, reason } = await workflowAgentTurnVisits(deps.store, input);
    if (reason !== null) return { decided: [], reason };
    const decided: string[] = [];
    for (const visit of visits) {
        const won = await decideWorkflowAgentTurnFailure(deps.store, visit, input.sessionId, input.cause);
        if (!won) continue;
        decided.push(visit);
        if (!deps.client) continue;
        try {
            await deps.client.enqueueEvent(won.controllerInstanceId, WORKFLOW_COMMAND_QUEUE,
                JSON.stringify({ type: "workflow-wake", reason: "agent", runId: won.runId }));
        } catch {
            // A hint only: the controller's backstop collection finds the result.
        }
    }
    return { decided, reason: decided.length > 0 ? "decided" : "already_decided" };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Register the report activity. Every worker registers it (milestone-worker.ts registerWorkflowMilestoneSessions). A
 * transient store error is retried in the activity; any other failure, or retries that run out, fail the activity, and
 * the orchestration keeps the report owed (it sends it again at its next execution's start and before its next turn).
 * A worker without a workflow store fails it the same way.
 */
export function registerWorkflowAgentTurnFailureActivity(runtime: {
    registerActivity(name: string, handler: (ctx: any, input: any) => Promise<unknown>): void;
}, deps: { store: WorkflowStore | null; retryDelaysMs?: readonly number[] }): void {
    runtime.registerActivity(WORKFLOW_AGENT_TURN_FAILURE_ACTIVITY, async (actx: ActivityContext & { traceInfo?: (message: string) => void }, input: unknown) => {
        if (!deps.store) throw new Error("This worker has no workflow store, so it cannot report a workflow agent's failed turn.");
        const store = deps.store;
        const client = (actx as { getClient?: () => WorkflowAgentTurnFailureWakeClient | null }).getClient?.() ?? null;
        const delays = deps.retryDelaysMs ?? WORKFLOW_AGENT_TURN_FAILURE_RETRY_DELAYS_MS;
        for (let attempt = 0; ; attempt += 1) {
            try {
                const result = await reportWorkflowAgentTurnFailure({ store, client }, input);
                actx.traceInfo?.(`[workflow-agent] failed turn reported: ${result.reason}${result.decided.length ? ` (${result.decided.join(", ")})` : ""}`);
                return result;
            } catch (error) {
                if (!isTransientCmsError(error) || attempt >= delays.length) throw error;
                actx.traceWarn(`[workflow-agent] failed turn report: transient store error, retrying in ${delays[attempt]} ms: ${String((error as Error)?.message ?? error)}`);
                await sleep(delays[attempt]);
            }
        }
    });
}
