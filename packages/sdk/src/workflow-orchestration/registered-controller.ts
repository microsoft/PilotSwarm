import type {
    CompiledWorkflowAgentStateManifest,
    CompiledWorkflowStateManifest,
    WorkflowAdvanceDirective,
} from "./compiler.js";
import {
    resolveWorkflowTemplate,
} from "./compiler.js";
import type {
    ResolvedWorkflowExecutionPlan,
} from "./definition-provider.js";
import type {
    WorkflowExecutionRecord,
    WorkflowStateExecutionResult,
} from "./graph.js";
import type {
    AcceptWorkflowStateResultActivityInput,
    RecordWorkflowStateExecutionActivityInput,
} from "./activities.js";
import type { WorkflowDefinitionSource, WorkflowSessionResult } from "../types.js";
import {
    routeAgentStateDispatch,
} from "../workflow-orchestration_1_0_0/agent-dispatch.js";
import {
    ACCEPT_WORKFLOW_STATE_RESULT_ACTIVITY,
    COMPLETE_WORKFLOW_ACTIVITY,
    RECORD_WORKFLOW_STATE_EXECUTION_ACTIVITY,
    type WorkflowResultEvent,
} from "../workflow-orchestration_1_0_0/contracts.js";
import {
    createCompiledAgentStateDispatchPlan,
} from "./registered-agent-dispatch.js";
import {
    EXECUTE_WORKFLOW_TRANSITION_ACTIVITY,
    RESOLVE_WORKFLOW_DEFINITION_ACTIVITY,
} from "./registered-contracts.js";

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
    if (
        typeof result.outcome !== "string"
        || !Object.prototype.hasOwnProperty.call(result, "output")
    ) {
        throw workflowControllerError(
            `Workflow state '${stateId}' must return an outcome and output.`,
            "WORKFLOW_STATE_RESULT_INVALID",
        );
    }
    return result as WorkflowStateExecutionResult;
}

function requireDeclaredOutcome(
    state: CompiledWorkflowAgentStateManifest,
    result: WorkflowStateExecutionResult,
): WorkflowStateExecutionResult {
    if (!state.completion.outcomes.includes(result.outcome)) {
        throw workflowControllerError(
            `Workflow state '${state.id}' returned undeclared outcome '${result.outcome}'.`,
            "WORKFLOW_STATE_OUTCOME_INVALID",
        );
    }
    return result;
}

function requireState(
    states: readonly CompiledWorkflowStateManifest[],
    stateId: string,
): CompiledWorkflowStateManifest {
    const state = states.find(candidate => candidate.id === stateId);
    if (!state) {
        throw workflowControllerError(
            `Workflow entered unknown state '${stateId}'.`,
            "WORKFLOW_STATE_UNKNOWN",
        );
    }
    return state;
}

export function* durableRegisteredWorkflowSessionOrchestration(
    ctx: {
        scheduleActivity(name: string, input: unknown): unknown;
        dequeueEvent(name: string): unknown;
        newGuid(): unknown;
        utcNow(): unknown;
    },
    input: {
        sessionId: string;
        parentSessionId?: string;
        definition: Extract<WorkflowDefinitionSource, { kind: "registered" }>;
        inputs: Record<string, unknown>;
    },
): Generator<unknown, WorkflowSessionResult, unknown> {
    const resolved = (yield ctx.scheduleActivity(
        RESOLVE_WORKFLOW_DEFINITION_ACTIVITY,
        { source: input.definition },
    )) as ResolvedWorkflowExecutionPlan;
    if (
        !resolved
        || resolved.definitionId !== input.definition.definitionId
        || !resolved.manifest
    ) {
        throw workflowControllerError(
            `Workflow definition '${input.definition.definitionId}' resolved to an invalid execution plan.`,
            "WORKFLOW_DEFINITION_INVALID",
        );
    }

    const manifest = resolved.manifest;
    const latestStateOutputs: Record<string, WorkflowStateExecutionResult> = {};
    const executionHistory: WorkflowExecutionRecord[] = [];
    let currentStateId = manifest.initialState;
    let transitionCount = 0;
    let executionSequence = 0;
    const maxTransitions = 100;

    while (true) {
        const state = requireState(manifest.states, currentStateId);
        if (state.type === "terminal") {
            const completedAtValue = yield ctx.utcNow();
            const completedAt = new Date(
                completedAtValue as number | string | Date,
            ).toISOString();
            const result = {
                sessionId: input.sessionId,
                ...(input.parentSessionId
                    ? { parentSessionId: input.parentSessionId }
                    : {}),
                outcome: state.outcome,
                summary: state.summary,
                ...(state.hasOutput
                    ? {
                        result: resolveWorkflowTemplate(
                            state.output,
                            `states.${state.id}.output`,
                            {
                                inputs: input.inputs,
                                configuration: manifest.configuration,
                                latestStateOutputs,
                            },
                        ),
                    }
                    : {}),
                completedAt,
                metadata: {
                    definitionId: resolved.definitionId,
                    graphId: manifest.graphId,
                    terminalStateId: currentStateId,
                    transitionCount,
                },
            };
            return (yield ctx.scheduleActivity(
                COMPLETE_WORKFLOW_ACTIVITY,
                { result },
            )) as WorkflowSessionResult;
        }

        if (transitionCount >= maxTransitions) {
            throw workflowControllerError(
                `Workflow graph '${manifest.graphId}' exceeded ${maxTransitions} transitions.`,
                "WORKFLOW_TRANSITION_LIMIT_EXCEEDED",
            );
        }

        executionSequence += 1;
        const childSessionId = String(yield ctx.newGuid());
        const dispatch = createCompiledAgentStateDispatchPlan({
            workflowSessionId: input.sessionId,
            graphId: manifest.graphId,
            stateId: currentStateId,
            executionSequence,
            childSessionId,
            workflowInputs: input.inputs,
            configuration: manifest.configuration,
            latestStateOutputs,
            executionHistory,
            state,
        });
        const admission: RecordWorkflowStateExecutionActivityInput = {
            workflowSessionId: input.sessionId,
            executionSequence,
            graphId: manifest.graphId,
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
            || event.graphId !== manifest.graphId
            || event.stateId !== currentStateId
            || event.executionSequence !== executionSequence
        ) {
            throw workflowControllerError(
                `Workflow state '${currentStateId}' received a result for a different execution.`,
                "WORKFLOW_STATE_RESULT_MISMATCH",
            );
        }
        const submittedOutput = requireDeclaredOutcome(
            state,
            requireExecutionResult(currentStateId, {
                outcome: event.outcome,
                output: event.output,
            }),
        );
        const acceptInput: AcceptWorkflowStateResultActivityInput = {
            workflowSessionId: input.sessionId,
            childSessionId,
            graphId: manifest.graphId,
            stateId: currentStateId,
            executionSequence,
            outcome: submittedOutput.outcome,
            output: submittedOutput.output,
        };
        const recordedOutput = requireDeclaredOutcome(
            state,
            requireExecutionResult(
                currentStateId,
                yield ctx.scheduleActivity(
                    ACCEPT_WORKFLOW_STATE_RESULT_ACTIVITY,
                    acceptInput,
                ),
            ),
        );

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
        const directive = (yield ctx.scheduleActivity(
            EXECUTE_WORKFLOW_TRANSITION_ACTIVITY,
            {
                definitionId: resolved.definitionId,
                stateId: currentStateId,
                context: transitionContext,
            },
        )) as WorkflowAdvanceDirective;
        if (
            !directive
            || directive.kind !== "advance"
            || !state.transition.allowedTargets.includes(directive.target)
        ) {
            throw workflowControllerError(
                `Workflow state '${currentStateId}' selected an undeclared transition target.`,
                "WORKFLOW_TRANSITION_TARGET_INVALID",
            );
        }

        currentStateId = directive.target;
        transitionCount += 1;
    }
}
