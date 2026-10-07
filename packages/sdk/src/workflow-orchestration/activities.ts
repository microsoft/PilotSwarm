import type { SessionCatalog } from "../cms.js";
import type { WorkflowSessionResult } from "../types.js";
import {
    resolveInMemoryWorkflowGraph,
    type WorkflowExecutionRecord,
    type WorkflowStateExecutionResult,
} from "./graph.js";
import {
    ACCEPT_WORKFLOW_STATE_RESULT_ACTIVITY,
    COMPLETE_WORKFLOW_ACTIVITY,
    EXECUTE_WORKFLOW_STATE_ACTIVITY,
} from "../workflow-orchestration_1_0_0/contracts.js";

export {
    ACCEPT_WORKFLOW_STATE_RESULT_ACTIVITY,
    COMPLETE_WORKFLOW_ACTIVITY,
    EXECUTE_WORKFLOW_STATE_ACTIVITY,
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

export interface AcceptWorkflowStateResultActivityInput {
    workflowSessionId: string;
    childSessionId: string;
    graphId: string;
    stateId: string;
    executionSequence: number;
    outcome: string;
    output: unknown;
}

export interface WorkflowActivityHandlers {
    executeState(input: ExecuteWorkflowStateActivityInput): Promise<WorkflowStateExecutionResult>;
    acceptStateResult(input: AcceptWorkflowStateResultActivityInput): Promise<WorkflowStateExecutionResult>;
    completeWorkflow(input: CompleteWorkflowActivityInput): Promise<WorkflowSessionResult>;
}

function workflowActivityError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}

export function createWorkflowActivityHandlers(
    catalog: Pick<SessionCatalog, "upsertChildOutcome"> | null,
): WorkflowActivityHandlers {
    return {
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
            await catalog.upsertChildOutcome({
                childSessionId: input.childSessionId,
                parentSessionId: input.workflowSessionId,
                resultJson: {
                    kind: "workflow-state-result",
                    graphId: input.graphId,
                    stateId: input.stateId,
                    executionSequence: input.executionSequence,
                    outcome: input.outcome,
                    output: input.output,
                },
                verdict: input.outcome,
                summary: `Workflow state '${input.stateId}' completed with outcome '${input.outcome}'.`,
                completedAt: new Date(),
            });
            return {
                outcome: input.outcome,
                output: input.output,
            };
        },

        async completeWorkflow({ result }) {
            const resultCatalog = catalog;
            if (result.parentSessionId && !resultCatalog) {
                throw workflowActivityError(
                    `Workflow session '${result.sessionId}' cannot record its child result without a session catalog.`,
                    "WORKFLOW_RESULT_CATALOG_REQUIRED",
                );
            }
            if (result.parentSessionId && resultCatalog) {
                await resultCatalog.upsertChildOutcome({
                    childSessionId: result.sessionId,
                    parentSessionId: result.parentSessionId,
                    resultJson: {
                        outcome: result.outcome,
                        summary: result.summary,
                        ...(Object.prototype.hasOwnProperty.call(result, "result")
                            ? { result: result.result }
                            : {}),
                        ...(result.metadata ? { metadata: result.metadata } : {}),
                    },
                    verdict: result.outcome,
                    summary: result.summary,
                    completedAt: new Date(result.completedAt),
                });
            }
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
    catalog: Pick<SessionCatalog, "upsertChildOutcome"> | null,
): void {
    const handlers = createWorkflowActivityHandlers(catalog);
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
