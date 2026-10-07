import type { WorkflowDefinitionSource, WorkflowSessionResult } from "../types.js";
import {
    COMPLETE_WORKFLOW_ACTIVITY,
    EXECUTE_WORKFLOW_STATE_ACTIVITY,
    type ExecuteWorkflowStateActivityInput,
} from "./activities.js";
import {
    resolveInMemoryWorkflowGraph,
    type WorkflowStateExecutionResult,
} from "./graph.js";

export const WORKFLOW_ORCHESTRATION_VERSION = "1.0.0";

export interface WorkflowOrchestrationInput {
    sessionId: string;
    parentSessionId?: string;
    definition: WorkflowDefinitionSource;
    inputs: Record<string, unknown>;
}

function workflowControllerError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}

function deepFreeze<T>(value: T): T {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
        deepFreeze(nested);
    }
    return value;
}

function requireExecutionResult(
    stateId: string,
    value: unknown,
): WorkflowStateExecutionResult {
    if (!value || typeof value !== "object") {
        throw workflowControllerError(
            `Workflow state '${stateId}' returned an invalid execution result.`,
            "WORKFLOW_STATE_RESULT_INVALID",
        );
    }
    const result = value as Partial<WorkflowStateExecutionResult>;
    if (typeof result.outcome !== "string" || !Object.prototype.hasOwnProperty.call(result, "output")) {
        throw workflowControllerError(
            `Workflow state '${stateId}' must return an outcome and output.`,
            "WORKFLOW_STATE_RESULT_INVALID",
        );
    }
    return result as WorkflowStateExecutionResult;
}

/**
 * First executable workflow controller.
 *
 * Graphs are resolved from the temporary process-local registry. Definition
 * compilation and durable graph storage are intentionally deferred.
 *
 * @internal
 */
export function* durableWorkflowSessionOrchestration_1_0_0(
    ctx: {
        scheduleActivity(name: string, input: unknown): unknown;
        utcNow(): unknown;
    },
    input: WorkflowOrchestrationInput,
): Generator<unknown, WorkflowSessionResult, unknown> {
    if (input.definition.kind !== "in-memory") {
        throw workflowControllerError(
            `Workflow definition kind '${input.definition.kind}' requires the workflow compiler.`,
            "WORKFLOW_DEFINITION_COMPILER_REQUIRED",
        );
    }

    const graph = resolveInMemoryWorkflowGraph(input.definition.graphId);
    const recordedStateOutputs: Record<string, WorkflowStateExecutionResult> = {};
    let currentStateId = graph.initialState;
    let transitionCount = 0;
    const maxTransitions = graph.maxTransitions ?? 100;

    while (true) {
        const state = graph.states[currentStateId];
        if (!state) {
            throw workflowControllerError(
                `Workflow entered unknown state '${currentStateId}'.`,
                "WORKFLOW_STATE_UNKNOWN",
            );
        }

        if (state.type === "terminal") {
            const completedAtValue = yield ctx.utcNow();
            const completedAt = new Date(completedAtValue as number | string | Date).toISOString();
            const terminalContext = deepFreeze({
                workflowInputs: input.inputs,
                recordedStateOutputs: { ...recordedStateOutputs },
            });
            const result: WorkflowSessionResult = {
                sessionId: input.sessionId,
                ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
                outcome: state.outcome,
                summary: state.summary,
                ...(state.result ? { result: state.result(terminalContext) } : {}),
                completedAt,
                metadata: {
                    graphId: graph.id,
                    terminalStateId: currentStateId,
                    transitionCount,
                },
            };
            return (yield ctx.scheduleActivity(COMPLETE_WORKFLOW_ACTIVITY, { result })) as WorkflowSessionResult;
        }

        if (transitionCount >= maxTransitions) {
            throw workflowControllerError(
                `Workflow graph '${graph.id}' exceeded ${maxTransitions} transitions.`,
                "WORKFLOW_TRANSITION_LIMIT_EXCEEDED",
            );
        }

        const activityInput: ExecuteWorkflowStateActivityInput = {
            graphId: graph.id,
            sessionId: input.sessionId,
            stateId: currentStateId,
            workflowInputs: input.inputs,
            recordedStateOutputs: { ...recordedStateOutputs },
        };
        const activityResult = yield ctx.scheduleActivity(
            EXECUTE_WORKFLOW_STATE_ACTIVITY,
            activityInput,
        );
        const recordedOutput = requireExecutionResult(currentStateId, activityResult);
        if (!state.allowedOutcomes.includes(recordedOutput.outcome)) {
            throw workflowControllerError(
                `Workflow state '${currentStateId}' returned undeclared outcome '${recordedOutput.outcome}'.`,
                "WORKFLOW_STATE_OUTCOME_INVALID",
            );
        }
        recordedStateOutputs[currentStateId] = recordedOutput;

        const transitionContext = deepFreeze({
            workflowInputs: input.inputs,
            currentStateId,
            stateOutcome: recordedOutput.outcome,
            stateOutput: recordedOutput.output,
            recordedStateOutputs: { ...recordedStateOutputs },
        });
        const nextStateId = state.transition(transitionContext);
        if (!state.allowedTargets.includes(nextStateId)) {
            throw workflowControllerError(
                `Workflow state '${currentStateId}' selected undeclared target '${nextStateId}'.`,
                "WORKFLOW_TRANSITION_TARGET_INVALID",
            );
        }

        currentStateId = nextStateId;
        transitionCount += 1;
    }
}
