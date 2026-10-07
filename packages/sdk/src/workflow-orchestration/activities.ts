import type { SessionCatalog } from "../cms.js";
import type { WorkflowSessionResult } from "../types.js";
import {
    resolveInMemoryWorkflowGraph,
    type WorkflowStateExecutionResult,
} from "./graph.js";

export const EXECUTE_WORKFLOW_STATE_ACTIVITY = "executeWorkflowStateV1";
export const COMPLETE_WORKFLOW_ACTIVITY = "completeWorkflowSessionV1";

export interface ExecuteWorkflowStateActivityInput {
    graphId: string;
    sessionId: string;
    stateId: string;
    workflowInputs: Record<string, unknown>;
    recordedStateOutputs: Record<string, WorkflowStateExecutionResult>;
}

export interface CompleteWorkflowActivityInput {
    result: WorkflowSessionResult;
}

export interface WorkflowActivityHandlers {
    executeState(input: ExecuteWorkflowStateActivityInput): Promise<WorkflowStateExecutionResult>;
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
                workflowInputs: input.workflowInputs,
                recordedStateOutputs: input.recordedStateOutputs,
            });
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
        COMPLETE_WORKFLOW_ACTIVITY,
        async (_activityContext, input: CompleteWorkflowActivityInput) =>
            handlers.completeWorkflow(input),
    );
}
