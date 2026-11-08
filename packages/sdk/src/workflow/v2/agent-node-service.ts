import { WORKFLOW_COMMAND_QUEUE } from "../orchestration.js";
import { AGENT_REPORTED_ERROR_CODES, WORKFLOW_V2_AGENT_COMPLETION_TOOL } from "./compiler.js";
import { workflowStoreFailure } from "./failure.js";
import { jsonbSafeText, type JsonValue } from "./json.js";
import { redactWorkflowErrorValue } from "./redact.js";
import {
    WORKFLOW_V2_AGENT_MAX_INVALID_COMPLETIONS,
    WorkflowStoreError,
    type WorkflowAgentCompletionRefusal,
    type WorkflowStore,
} from "./store.js";

/**
 * Workflow v2 agent states (IR 8; design 03 agent node, 04 tool surface):
 * the child's completion tool. INACTIVE: only a test gives an agent state's
 * child this tool (on a turn of a worker that runs controller 1.9.0).
 */

/** The tool an agent state's child finishes its state with. */
export const COMPLETE_WORKFLOW_NODE_TOOL = WORKFLOW_V2_AGENT_COMPLETION_TOOL;

/** The complete_workflow_node tool's description and parameters. */
export const COMPLETE_WORKFLOW_NODE_TOOL_SPEC = {
    description:
        "Finish the workflow state this session runs, once, with a typed result. Give outcome (one of the state's outcomes) and output "
        + "(a JSON value that matches the state's output schema, when it has one), or error with code needs_input (you need a decision you "
        + "cannot get from the controlling parent agent) or execution_failed (you cannot do the task), and a message. operation_id is an id "
        + "you choose: repeat the same call with it to retry, and you get the same receipt. Final chat text does not finish the state, and "
        + "nothing else does. Returns the receipt as JSON, or a refusal: OUTPUT_INVALID (field errors in problems; attemptsLeft more invalid "
        + "completions are taken), OUTPUT_ATTEMPTS_EXHAUSTED (the state failed invalid_output), NODE_EXPIRED (its deadline passed), "
        + "NODE_CLOSED (the workflow ended the state), COMPLETION_CONFLICT (it was completed with another result), OPERATION_CONFLICT "
        + "(this operation_id gave another result), COMPLETION_INVALID (the call's shape) or AGENT_NODE_NOT_FOUND (this session runs no "
        + "workflow state).",
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
                description: "The node execution your prompt names. Required when your prompt says this chat continues across cycles: give "
                    + "the id in the cycle's prompt. A missing id there, or one that is not this chat's, is refused AGENT_NODE_NOT_FOUND.",
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
    OUTPUT_ATTEMPTS_EXHAUSTED: `The state failed invalid_output: ${WORKFLOW_V2_AGENT_MAX_INVALID_COMPLETIONS} completions did not match its contract.`,
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

export async function completeWorkflowNodeFromTool(args: Record<string, unknown>, context: {
    callerSessionId: string;
    store: Pick<WorkflowStore, "completeAgentNode">;
    client?: WorkflowAgentWakeClient | null;
    /** A continued chat's turn visit (the turn-to-visit fence; review RT-3): only that visit may be completed in this turn. */
    turnVisit?: string | null;
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
        const error: { [key: string]: JsonValue } = { code: result.code, message: REFUSAL_MESSAGES[result.code] };
        // Adversarial review R2-SF-4: the problems, with any secret in them hidden.
        if (result.problems !== null) error.problems = redactWorkflowErrorValue(result.problems);
        if (result.attemptsLeft !== null) error.attemptsLeft = result.attemptsLeft;
        return JSON.stringify({ ok: false, replayed: result.replayed, error, state: result.state });
    } catch (error) {
        return workflowCompletionFailure(error);
    }
}
