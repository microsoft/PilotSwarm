import type { SessionCatalog } from "../cms.js";
import type { ArtifactStore } from "../session-store.js";
import type { WorkflowSessionResult } from "../types.js";
import type {
    ExecuteWorkflowTransitionInput,
    ResolvedWorkflowExecutionPlan,
    WorkflowDefinitionProvider,
} from "./definition-provider.js";
import {
    CmsWorkflowDefinitionProvider,
} from "./definition-provider.js";
import {
    resolveInMemoryWorkflowGraph,
    type WorkflowExecutionRecord,
    type WorkflowStateExecutionResult,
} from "./graph.js";
import {
    ACCEPT_WORKFLOW_STATE_RESULT_ACTIVITY,
    COMPLETE_WORKFLOW_ACTIVITY,
    EXECUTE_WORKFLOW_STATE_ACTIVITY,
    RECORD_WORKFLOW_STATE_EXECUTION_ACTIVITY,
} from "../workflow-orchestration_1_0_0/contracts.js";
import {
    EXECUTE_WORKFLOW_TRANSITION_ACTIVITY,
    RESOLVE_WORKFLOW_DEFINITION_ACTIVITY,
} from "./registered-contracts.js";

export {
    ACCEPT_WORKFLOW_STATE_RESULT_ACTIVITY,
    COMPLETE_WORKFLOW_ACTIVITY,
    EXECUTE_WORKFLOW_STATE_ACTIVITY,
    RECORD_WORKFLOW_STATE_EXECUTION_ACTIVITY,
    EXECUTE_WORKFLOW_TRANSITION_ACTIVITY,
    RESOLVE_WORKFLOW_DEFINITION_ACTIVITY,
};

export interface ExecuteWorkflowStateActivityInput {
    graphId: string;
    sessionId: string;
    stateId: string;
    executionSequence: number;
    workflowInputs: Record<string, unknown>;
    latestStateOutputs: Record<string, WorkflowStateExecutionResult>;
    executionHistory: WorkflowExecutionRecord[];
}

export interface CompleteWorkflowActivityInput {
    result: WorkflowSessionResult;
}

export interface RecordWorkflowStateExecutionActivityInput {
    workflowSessionId: string;
    executionSequence: number;
    graphId: string;
    stateId: string;
    childSessionId?: string;
    waitingOn: "activity" | "agent-result";
}

export interface AcceptWorkflowStateResultActivityInput {
    workflowSessionId: string;
    childSessionId?: string;
    graphId: string;
    stateId: string;
    executionSequence: number;
    outcome: string;
    output: unknown;
}

export interface WorkflowActivityHandlers {
    resolveDefinition(
        source: import("../types.js").WorkflowDefinitionSource,
    ): Promise<ResolvedWorkflowExecutionPlan>;
    executeTransition(
        input: ExecuteWorkflowTransitionInput,
    ): ReturnType<WorkflowDefinitionProvider["executeTransition"]>;
    recordStateExecution(input: RecordWorkflowStateExecutionActivityInput): Promise<void>;
    executeState(input: ExecuteWorkflowStateActivityInput): Promise<WorkflowStateExecutionResult>;
    acceptStateResult(input: AcceptWorkflowStateResultActivityInput): Promise<WorkflowStateExecutionResult>;
    completeWorkflow(input: CompleteWorkflowActivityInput): Promise<WorkflowSessionResult>;
}

function workflowActivityError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}

export function createWorkflowActivityHandlers(
    catalog: Pick<
        SessionCatalog,
        | "acceptWorkflowExecution"
        | "completeWorkflowProjection"
        | "recordWorkflowExecution"
    > | null,
    definitionProvider: WorkflowDefinitionProvider | null = null,
): WorkflowActivityHandlers {
    return {
        async resolveDefinition(source) {
            if (!definitionProvider) {
                throw workflowActivityError(
                    "Registered workflow definitions require a configured definition provider.",
                    "WORKFLOW_DEFINITION_PROVIDER_REQUIRED",
                );
            }
            return definitionProvider.resolve(source);
        },

        async executeTransition(input) {
            if (!definitionProvider) {
                throw workflowActivityError(
                    "Registered workflow transitions require a configured definition provider.",
                    "WORKFLOW_DEFINITION_PROVIDER_REQUIRED",
                );
            }
            return definitionProvider.executeTransition(input);
        },

        async recordStateExecution(input) {
            if (!catalog) {
                throw workflowActivityError(
                    `Workflow state execution '${input.workflowSessionId}/${input.executionSequence}' cannot be admitted without a session catalog.`,
                    "WORKFLOW_RESULT_CATALOG_REQUIRED",
                );
            }
            await catalog.recordWorkflowExecution(input);
        },

        async executeState(input) {
            const graph = resolveInMemoryWorkflowGraph(input.graphId);
            const state = graph.states[input.stateId];
            if (!state || state.type !== "activity") {
                throw workflowActivityError(
                    `Workflow state '${input.stateId}' is not executable.`,
                    "WORKFLOW_STATE_NOT_EXECUTABLE",
                );
            }
            return await state.execute({
                sessionId: input.sessionId,
                stateId: input.stateId,
                executionSequence: input.executionSequence,
                workflowInputs: input.workflowInputs,
                latestStateOutputs: input.latestStateOutputs,
                executionHistory: input.executionHistory,
            });
        },

        async acceptStateResult(input) {
            if (!catalog) {
                throw workflowActivityError(
                    `Workflow state execution '${input.workflowSessionId}/${input.executionSequence}' cannot record its result without a session catalog.`,
                    "WORKFLOW_RESULT_CATALOG_REQUIRED",
                );
            }
            await catalog.acceptWorkflowExecution({
                workflowSessionId: input.workflowSessionId,
                executionSequence: input.executionSequence,
                graphId: input.graphId,
                stateId: input.stateId,
                childSessionId: input.childSessionId,
                outcome: input.outcome,
                output: input.output,
            });
            return {
                outcome: input.outcome,
                output: input.output,
            };
        },

        async completeWorkflow({ result }) {
            if (!catalog) {
                throw workflowActivityError(
                    `Workflow session '${result.sessionId}' cannot record completion without a session catalog.`,
                    "WORKFLOW_RESULT_CATALOG_REQUIRED",
                );
            }
            const graphId = result.metadata?.graphId;
            const terminalStateId = result.metadata?.terminalStateId;
            if (typeof graphId !== "string" || typeof terminalStateId !== "string") {
                throw workflowActivityError(
                    `Workflow session '${result.sessionId}' completion metadata is invalid.`,
                    "WORKFLOW_COMPLETION_INVALID",
                );
            }
            await catalog.completeWorkflowProjection({
                workflowSessionId: result.sessionId,
                parentSessionId: result.parentSessionId,
                graphId,
                terminalStateId,
                outcome: result.outcome,
                summary: result.summary,
                result: {
                    outcome: result.outcome,
                    summary: result.summary,
                    ...(Object.prototype.hasOwnProperty.call(result, "result")
                        ? { result: result.result }
                        : {}),
                    ...(result.metadata ? { metadata: result.metadata } : {}),
                },
                completedAt: new Date(result.completedAt),
            });
            return result;
        },
    };
}

export function registerWorkflowActivities(
    runtime: {
        registerActivity(
            name: string,
            handler: (activityContext: any, input: any) => Promise<unknown>,
        ): void;
    },
    catalog: Pick<
        SessionCatalog,
        | "acceptWorkflowExecution"
        | "completeWorkflowProjection"
        | "getWorkflowDefinition"
        | "recordWorkflowExecution"
    > | null,
    artifactStore: ArtifactStore | null = null,
): void {
    const definitionProvider = catalog && artifactStore
        ? new CmsWorkflowDefinitionProvider(catalog, artifactStore)
        : null;
    const handlers = createWorkflowActivityHandlers(catalog, definitionProvider);
    runtime.registerActivity(
        RESOLVE_WORKFLOW_DEFINITION_ACTIVITY,
        async (_activityContext, input: { source: import("../types.js").WorkflowDefinitionSource }) =>
            handlers.resolveDefinition(input.source),
    );
    runtime.registerActivity(
        EXECUTE_WORKFLOW_TRANSITION_ACTIVITY,
        async (_activityContext, input: ExecuteWorkflowTransitionInput) =>
            handlers.executeTransition(input),
    );
    runtime.registerActivity(
        RECORD_WORKFLOW_STATE_EXECUTION_ACTIVITY,
        async (_activityContext, input: RecordWorkflowStateExecutionActivityInput) =>
            handlers.recordStateExecution(input),
    );
    runtime.registerActivity(
        EXECUTE_WORKFLOW_STATE_ACTIVITY,
        async (_activityContext, input: ExecuteWorkflowStateActivityInput) =>
            handlers.executeState(input),
    );
    runtime.registerActivity(
        ACCEPT_WORKFLOW_STATE_RESULT_ACTIVITY,
        async (_activityContext, input: AcceptWorkflowStateResultActivityInput) =>
            handlers.acceptStateResult(input),
    );
    runtime.registerActivity(
        COMPLETE_WORKFLOW_ACTIVITY,
        async (_activityContext, input: CompleteWorkflowActivityInput) =>
            handlers.completeWorkflow(input),
    );
}
