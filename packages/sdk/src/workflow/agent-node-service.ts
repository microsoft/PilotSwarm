import { WORKFLOW_COMMAND_QUEUE } from "./commands.js";
import { AGENT_REPORTED_ERROR_CODES, WORKFLOW_AGENT_COMPLETION_TOOL } from "./compiler.js";
import { workflowStoreFailure } from "./failure.js";
import { jsonbSafeText, type JsonValue } from "./json.js";
import { promptSafeJson } from "./parent-messages.js";
import { redactWorkflowErrorValue } from "./redact.js";
import {
    WORKFLOW_AGENT_MAX_INVALID_COMPLETIONS,
    WorkflowStoreError,
    type WorkflowAgentCompletionRefusal,
    type WorkflowRerunRecapPayload,
    type WorkflowStore,
} from "./store.js";

/**
 * Workflow agent states (design 03 agent node, 04 tool surface):
 * the child's completion tool, which an agent state's own child is given on
 * its 1.0.83 turns (session-proxy, from the session's stored lineage).
 */

/** The tool an agent state's child finishes its state with. */
export const COMPLETE_WORKFLOW_NODE_TOOL = WORKFLOW_AGENT_COMPLETION_TOOL;

/** The complete_workflow_node tool's description and parameters. */
export const COMPLETE_WORKFLOW_NODE_TOOL_SPEC = {
    description:
        "Finish the workflow state this session runs, once, with a typed result. Give outcome (one of the state's outcomes) and output "
        + "(a JSON value that matches the state's output schema, when it has one), or error with code needs_input (you need a decision you "
        + "cannot get from the controlling parent agent) or execution_failed (you cannot do the task), and a message. operation_id is an id "
        + "you choose: repeat the same call with it to retry, and you get the same receipt. Final reply text does not finish the state, and "
        + "nothing else does. Returns the receipt as JSON, or a refusal: OUTPUT_INVALID (field errors in problems; attemptsLeft more invalid "
        + "completions are taken), OUTPUT_ATTEMPTS_EXHAUSTED (the state failed invalid_output), NODE_EXPIRED (its deadline passed), "
        + "NODE_CLOSED (the workflow ended the state), COMPLETION_CONFLICT (it was completed with another result), OPERATION_CONFLICT "
        + "(this operation_id gave another result), COMPLETION_INVALID (the call's shape) or AGENT_NODE_NOT_FOUND (this session runs no "
        + "workflow state). Call it alone and last: after it no tool runs in this turn, and background work this turn started is stopped.",
    parameters: {
        type: "object",
        properties: {
            outcome: { type: "string", description: "The business outcome: one of the state's outcomes." },
            output: { description: "The output: a JSON value that matches the state's output schema. Default null." },
            error: {
                type: "object",
                description: "Instead of an outcome: why the state cannot be completed.",
                properties: {
                    code: { type: "string", enum: [...AGENT_REPORTED_ERROR_CODES] },
                    message: { type: "string", description: "What you need, or what failed, in 1 to 2,000 characters." },
                    details: { description: "Optional JSON details." },
                },
                required: ["code", "message"],
                additionalProperties: false,
            },
            operation_id: { type: "string", description: "Your idempotency id for this completion." },
            node_execution_id: {
                type: "string",
                description: "The node execution your prompt names. Required when your prompt says this agent session continues across cycles: "
                    + "give the id in the cycle's prompt. A missing id there, or one that is not this session's, is refused AGENT_NODE_NOT_FOUND.",
            },
        },
        required: ["operation_id"],
    },
} as const;

/** The durable client call a completion's wake makes. */
export interface WorkflowAgentWakeClient {
    enqueueEvent(instanceId: string, queueName: string, data: string): Promise<void>;
}

const REFUSAL_MESSAGES: Record<WorkflowAgentCompletionRefusal, string> = {
    OUTPUT_INVALID: "The completion does not match the state's contract; fix the fields in problems and complete again.",
    REQUIRED_TOOLS_NOT_CALLED: "Required tools have not been called in this cycle.",
    OUTPUT_ATTEMPTS_EXHAUSTED: `The state failed invalid_output: ${WORKFLOW_AGENT_MAX_INVALID_COMPLETIONS} completions did not match its contract.`,
    NODE_EXPIRED: "The state's deadline passed; the workflow decides it now.",
    NODE_CLOSED: "The workflow already ended this state; nothing you complete changes it.",
    COMPLETION_CONFLICT: "The state was already completed with another result.",
    OPERATION_CONFLICT: "This operation_id was already used for another result.",
};

/**
 * complete_workflow_node: the caller is the host-stamped session, never an
 * argument (store.completeAgentNode finds its state by its child id). A
 * completion that decided the state, a repeat of it, and the invalid one
 * that spent the correction budget wake the run's controller (a hint; its
 * backstop collection finds the result too, so a failed wake is not an
 * error). Returns JSON.
 */
/**
 * complete_workflow_node's answer for a failure (adversarial reviews R2-SF-4 and R2-RT-3): the shared workflow failure
 * (workflowStoreFailure: a refusal keeps its code, with the secrets in its message and details hidden; anything else is
 * coded, with its message sanitized), never an error's own text. For the tool's handler and the bridge that runs it too.
 */
export function workflowCompletionFailure(error: unknown): string {
    const failure = workflowStoreFailure(error);
    return JSON.stringify({ ok: false, error: { code: failure.code, message: jsonbSafeText(failure.message, 2_000),
        ...(error instanceof WorkflowStoreError && failure.details !== undefined ? { details: failure.details } : {}) } });
}

/**
 * Issue I1: how long a Workflow agent step's turn may go on writing its reply after its result is recorded before it is
 * stopped (session-proxy's runTurn). Not turned off by `turnTimeoutMs: 0`; tests shorten `ms`.
 */
export const WORKFLOW_AGENT_REPLY_SETTLE = { ms: 5 * 60_000 };

/** A later cycle's prompt says the earlier cycles' conversation is in the session (issue I1: it is, once committed). */
export const WORKFLOW_AGENT_CYCLE_MEMORY_WORDS = "in this same agent session: what you did in earlier cycles is above.";

/**
 * Design §5.4 sentence appended to a later cycle's prompt when pre-cut cycles 1..K were reused or supplied before this re-run:
 * their summary is in the prompt of `recapCycle`, the first cycle of this agent session (K+1, or the first cycle of a
 * replacement session; review I-2).
 */
export function workflowAgentPreCutMemorySentence(preCutCount: number, recapCycle = preCutCount + 1): string {
    if (!Number.isSafeInteger(preCutCount) || preCutCount <= 0) return "";
    if (preCutCount === 1) {
        return ` Cycle 1 was reused or supplied before this re-run started; its summary is in cycle ${recapCycle}'s prompt above.`;
    }
    return ` Cycles 1 to ${preCutCount} were reused or supplied before this re-run started; their summary is in cycle ${recapCycle}'s prompt above.`;
}

/**
 * Issue I1, review D-2: a later cycle's prompt when the conversation of earlier cycles `lost` of its session was not saved
 * after they reported their result (a reply stopped at its limit or by force, a lost Copilot session or worker, a snapshot
 * not committed). It says plainly that their conversation is not available instead of saying it is above. The worker applies
 * it as the cycle's turn starts, the first point where a loss is known (the prompt is sent while the earlier reply may still run).
 * Cycles before `firstSessionCycle` (this session's first cycle: earlier ones ran in an ended session, or were reused or
 * supplied before a re-run) are not counted as "other earlier cycles above". In a re-run with pre-cut cycles 1..`preCutCount`,
 * when `recapCycle` (default `firstSessionCycle`: the cycle whose prompt carried their summary) was lost, the "summary is in
 * cycle R's prompt above" note is replaced and `rerunRecap` is carried again in the JSON line (review I-2).
 */
export function workflowAgentCycleMemoryLostPrompt(
    prompt: string,
    cycle: number,
    lost: readonly number[],
    options?: { firstSessionCycle?: number; preCutCount?: number; recapCycle?: number; rerunRecap?: WorkflowRerunRecapPayload | null },
): string {
    const firstSessionCycle = options?.firstSessionCycle !== undefined
        && Number.isSafeInteger(options.firstSessionCycle) && options.firstSessionCycle >= 1
        ? options.firstSessionCycle : 1;
    const preCutCount = options?.preCutCount !== undefined && Number.isSafeInteger(options.preCutCount) && options.preCutCount > 0
        ? options.preCutCount : 0;
    const recapCycle = options?.recapCycle !== undefined && Number.isSafeInteger(options.recapCycle) ? options.recapCycle : firstSessionCycle;
    const cycles = [...new Set(lost)]
        .filter(n => Number.isSafeInteger(n) && n >= firstSessionCycle && n < cycle)
        .sort((a, b) => a - b);
    if (cycles.length === 0 || !prompt.includes(WORKFLOW_AGENT_CYCLE_MEMORY_WORDS)) return prompt;
    const one = cycles.length === 1;
    const named = one ? `cycle ${cycles[0]}` : `cycles ${cycles.slice(0, -1).join(", ")} and ${cycles[cycles.length - 1]}`;
    const sessionEarlier = Math.max(0, cycle - firstSessionCycle);
    const others = sessionEarlier > cycles.length ? " What you did in the other earlier cycles is above." : "";
    let out = prompt.replace(WORKFLOW_AGENT_CYCLE_MEMORY_WORDS, `in this same agent session. The conversation of ${named} is not available: it `
        + `was lost after ${one ? "that cycle" : "those cycles"} reported ${one ? "its" : "their"} result, before it was saved, so it is not `
        + `above. previousResult and the variables in the JSON say where the earlier cycles ended.${others}`);
    if (preCutCount > 0 && cycles.includes(recapCycle)) {
        const preCutAbove = workflowAgentPreCutMemorySentence(preCutCount, recapCycle);
        const replacement = preCutCount === 1
            ? ` Cycle 1 was reused or supplied before this re-run started; because cycle ${recapCycle}'s conversation was lost, rerunRecap in the JSON carries its summary again.`
            : ` Cycles 1 to ${preCutCount} were reused or supplied before this re-run started; because cycle ${recapCycle}'s conversation was lost, rerunRecap in the JSON carries their summary again.`;
        if (preCutAbove && out.includes(preCutAbove)) {
            out = out.replace(preCutAbove, replacement);
        }
        if (options?.rerunRecap) {
            const lines = out.split("\n");
            if (lines.length >= 2) {
                try {
                    const parsed = JSON.parse(lines[1]) as Record<string, JsonValue>;
                    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                        lines[1] = promptSafeJson({ ...parsed, rerunRecap: options.rerunRecap as unknown as JsonValue });
                        out = lines.join("\n");
                    }
                } catch {
                    // Leave JSON line untouched if caller passed a non-standard test prompt.
                }
            }
        }
    }
    return out;
}

export async function completeWorkflowNodeFromTool(args: Record<string, unknown>, context: {
    callerSessionId: string;
    store: Pick<WorkflowStore, "completeAgentNode">;
    client?: WorkflowAgentWakeClient | null;
    /** A continued session's turn visit (the turn-to-visit fence; review RT-3): only that visit may be completed in this turn. */
    turnVisit?: string | null;
    /** Close local tool admission before waiting for the controller wake. */
    onDecided?: () => void;
    /**
     * Issue I1 (review R2-3): whether the store has the turn's visit decided, read after a completion write whose outcome is
     * unknown (it failed with anything but a store refusal, so it may have committed). True or a read that fails: onDecided
     * runs (the visit is decided, or that cannot be verified: no more tools run in the turn). False: the call can be retried.
     */
    visitDecided?: () => Promise<boolean | null>;
}): Promise<string> {
    try {
        const call: Record<string, unknown> = {};
        if (Object.hasOwn(args, "outcome")) call.outcome = args.outcome;
        if (Object.hasOwn(args, "output")) call.output = args.output;
        if (Object.hasOwn(args, "error")) call.error = args.error;
        const result = await context.store.completeAgentNode({
            childSessionId: context.callerSessionId, operationId: args.operation_id as string, call,
            ...(typeof args.node_execution_id === "string" && args.node_execution_id ? { nodeExecutionId: args.node_execution_id } : {}),
            ...(typeof context.turnVisit === "string" || context.turnVisit === null ? { turnVisit: context.turnVisit } : {}),
        });
        const decided = result.kind === "accepted" || result.code === "OUTPUT_ATTEMPTS_EXHAUSTED";
        if (decided || result.code === "NODE_CLOSED" || result.code === "NODE_EXPIRED" || result.code === "COMPLETION_CONFLICT") {
            context.onDecided?.();
        }
        if (decided && context.client) {
            try {
                await context.client.enqueueEvent(result.controllerInstanceId, WORKFLOW_COMMAND_QUEUE,
                    JSON.stringify({ type: "workflow-wake", reason: "agent", ...(result.kind === "accepted" ? { runId: result.receipt.runId } : {}) }));
            } catch {
                // A hint only: the controller's backstop collection finds the result.
            }
        }
        if (result.kind === "accepted") {
            const receipt = result.receipt;
            return JSON.stringify({
                ok: true, replayed: result.replayed, nodeExecutionId: receipt.nodeExecutionId, workflowId: receipt.workflowSessionId,
                runId: receipt.runId, stateId: receipt.stateId, kind: receipt.kind, outcome: receipt.outcome, operationId: receipt.operationId,
                resultSha256: receipt.resultSha256, decidedAt: receipt.decidedAt,
            });
        }
        let message = REFUSAL_MESSAGES[result.code];
        if (result.code === "REQUIRED_TOOLS_NOT_CALLED" && result.problems && !Array.isArray(result.problems)
            && typeof result.problems === "object" && Array.isArray(result.problems.required) && Array.isArray(result.problems.missing)) {
            message = `This step requires a call of each of these tools before it completes with an outcome: ${result.problems.required.join(", ")}. `
                + `Not called in this cycle: ${result.problems.missing.join(", ")}. Call it, then complete again with a new operation_id. `
                + "If a required tool is unavailable or keeps failing, complete with error execution_failed and say why.";
        }
        const error: { [key: string]: JsonValue } = { code: result.code, message };
        // Adversarial review R2-SF-4: the problems, with any secret in them hidden.
        if (result.problems !== null) error.problems = redactWorkflowErrorValue(result.problems);
        if (result.attemptsLeft !== null) error.attemptsLeft = result.attemptsLeft;
        return JSON.stringify({ ok: false, replayed: result.replayed, error, state: result.state });
    } catch (error) {
        if (!(error instanceof WorkflowStoreError) && context.visitDecided && context.onDecided) {
            const decided = await context.visitDecided().catch(() => null);
            if (decided !== false) context.onDecided();
        }
        return workflowCompletionFailure(error);
    }
}
