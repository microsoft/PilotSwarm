import type { WorkflowDefinitionSource, WorkflowSessionResult } from "../types.js";
import type {
    ExecuteWorkflowStateActivityInput,
    RecordWorkflowStateExecutionActivityInput,
} from "../workflow-orchestration/activities.js";
import {
    resolveInMemoryWorkflowGraph,
    type WorkflowExecutionRecord,
    type WorkflowStateExecutionResult,
} from "../workflow-orchestration/graph.js";
import {
    createAgentStateDispatchPlan,
    routeAgentStateDispatch,
} from "./agent-dispatch.js";
import {
    durableRegisteredWorkflowSessionOrchestration,
} from "../workflow-orchestration/registered-controller.js";
import {
    ACCEPT_WORKFLOW_STATE_RESULT_ACTIVITY,
    COMPLETE_WORKFLOW_ACTIVITY,
    EXECUTE_WORKFLOW_STATE_ACTIVITY,
    RECORD_WORKFLOW_STATE_EXECUTION_ACTIVITY,
    WORKFLOW_ORCHESTRATION_VERSION,
    type WorkflowResultEvent,
} from "./contracts.js";

export { WORKFLOW_ORCHESTRATION_VERSION };

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

function requireDeclaredOutcome(
    stateId: string,
    allowedOutcomes: readonly string[],
    result: WorkflowStateExecutionResult,
): WorkflowStateExecutionResult {
    if (!allowedOutcomes.includes(result.outcome)) {
        throw workflowControllerError(
            `Workflow state '${stateId}' returned undeclared outcome '${result.outcome}'.`,
            "WORKFLOW_STATE_OUTCOME_INVALID",
        );
    }
    return result;
}

/**
 * First executable workflow controller.
 *
 * In-memory definitions resolve through the process-local graph registry.
 * Registered definitions resolve their persisted compiled plan through durable
 * activities without changing the orchestration version.
 *
 * @internal
 */
export function* durableWorkflowSessionOrchestration_1_0_0(
    ctx: {
        scheduleActivity(name: string, input: unknown): unknown;
        scheduleTimer(delayMs: number): unknown;
        dequeueEvent(name: string): unknown;
        scheduleTimer(delayMs: number): unknown;
        newGuid(): unknown;
        utcNow(): unknown;
    },
    input: WorkflowOrchestrationInput,
): Generator<unknown, WorkflowSessionResult, unknown> {
    if (input.definition.kind === "registered") {
        return yield* durableRegisteredWorkflowSessionOrchestration(ctx, {
            ...input,
            definition: input.definition,
        });
    }

    if (input.definition.kind !== "in-memory") {
        throw workflowControllerError(
            `Workflow definition kind '${input.definition.kind}' requires the workflow compiler.`,
            "WORKFLOW_DEFINITION_COMPILER_REQUIRED",
        );
    }

    const graph = resolveInMemoryWorkflowGraph(input.definition.graphId);
    const latestStateOutputs: Record<string, WorkflowStateExecutionResult> = {};
    const executionHistory: WorkflowExecutionRecord[] = [];
    let currentStateId = graph.initialState;
    let transitionCount = 0;
    let executionSequence = 0;
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
                latestStateOutputs: { ...latestStateOutputs },
                executionHistory: [...executionHistory],
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

        executionSequence += 1;
        let recordedOutput: WorkflowStateExecutionResult;
        if (state.type === "agent") {
            const childSessionId = String(yield ctx.newGuid());
            const dispatch = createAgentStateDispatchPlan({
                workflowSessionId: input.sessionId,
                graphId: graph.id,
                stateId: currentStateId,
                executionSequence,
                childSessionId,
                workflowInputs: input.inputs,
                latestStateOutputs,
                executionHistory,
                state,
            });
            const admission: RecordWorkflowStateExecutionActivityInput = {
                workflowSessionId: input.sessionId,
                executionSequence,
                graphId: graph.id,
                stateId: currentStateId,
                childSessionId,
                waitingOn: "agent-result",
            };
            yield ctx.scheduleActivity(RECORD_WORKFLOW_STATE_EXECUTION_ACTIVITY, admission);
            yield routeAgentStateDispatch(
                ctx.scheduleActivity(dispatch.activityName, dispatch.activityInput),
                dispatch.activityTag,
            );
            const rawEvent = yield ctx.dequeueEvent(dispatch.resultQueueName);
            const event = typeof rawEvent === "string"
                ? JSON.parse(rawEvent) as WorkflowResultEvent
                : rawEvent as WorkflowResultEvent;
            if (
                !event
                || event.workflowSessionId !== input.sessionId
                || event.childSessionId !== childSessionId
                || event.graphId !== graph.id
                || event.stateId !== currentStateId
                || event.executionSequence !== executionSequence
            ) {
                throw workflowControllerError(
                    `Workflow state '${currentStateId}' received a result for a different execution.`,
                    "WORKFLOW_STATE_RESULT_MISMATCH",
                );
            }
            const submittedOutput = requireDeclaredOutcome(
                currentStateId,
                state.allowedOutcomes,
                requireExecutionResult(currentStateId, {
                    outcome: event.outcome,
                    output: event.output,
                }),
            );
            recordedOutput = requireDeclaredOutcome(
                currentStateId,
                state.allowedOutcomes,
                requireExecutionResult(
                    currentStateId,
                    yield ctx.scheduleActivity(
                        ACCEPT_WORKFLOW_STATE_RESULT_ACTIVITY,
                        {
                            workflowSessionId: input.sessionId,
                            childSessionId,
                            graphId: graph.id,
                            stateId: currentStateId,
                            executionSequence,
                            outcome: submittedOutput.outcome,
                            output: submittedOutput.output,
                        },
                    ),
                ),
            );
        } else {
            const admission: RecordWorkflowStateExecutionActivityInput = {
                workflowSessionId: input.sessionId,
                executionSequence,
                graphId: graph.id,
                stateId: currentStateId,
                waitingOn: "activity",
            };
            yield ctx.scheduleActivity(RECORD_WORKFLOW_STATE_EXECUTION_ACTIVITY, admission);
            const activityInput: ExecuteWorkflowStateActivityInput = {
                graphId: graph.id,
                sessionId: input.sessionId,
                stateId: currentStateId,
                executionSequence,
                workflowInputs: input.inputs,
                latestStateOutputs: { ...latestStateOutputs },
                executionHistory: [...executionHistory],
            };
            const executedOutput = requireDeclaredOutcome(
                currentStateId,
                state.allowedOutcomes,
                requireExecutionResult(
                    currentStateId,
                    yield ctx.scheduleActivity(EXECUTE_WORKFLOW_STATE_ACTIVITY, activityInput),
                ),
            );
            recordedOutput = requireDeclaredOutcome(
                currentStateId,
                state.allowedOutcomes,
                requireExecutionResult(
                    currentStateId,
                    yield ctx.scheduleActivity(
                        ACCEPT_WORKFLOW_STATE_RESULT_ACTIVITY,
                        {
                            workflowSessionId: input.sessionId,
                            graphId: graph.id,
                            stateId: currentStateId,
                            executionSequence,
                            outcome: executedOutput.outcome,
                            output: executedOutput.output,
                        },
                    ),
                ),
            );
        }

        latestStateOutputs[currentStateId] = recordedOutput;
        executionHistory.push({
            stateId: currentStateId,
            executionSequence,
            outcome: recordedOutput.outcome,
            output: recordedOutput.output,
        });

        const transitionContext = deepFreeze({
            workflowInputs: input.inputs,
            currentStateId,
            stateOutcome: recordedOutput.outcome,
            stateOutput: recordedOutput.output,
            latestStateOutputs: { ...latestStateOutputs },
            executionHistory: [...executionHistory],
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
