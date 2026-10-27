import type {
    InMemoryWorkflowAgentState,
    WorkflowExecutionRecord,
    WorkflowStateExecutionResult,
} from "../workflow-orchestration/graph.js";
import {
    AGENT_CHILD_BOOTSTRAP_CAPABILITY,
    ENQUEUE_AGENT_CHILD_BOOTSTRAP_ACTIVITY,
    ENSURE_AGENT_CHILD_SESSION_ACTIVITY,
    SUBMIT_WORKFLOW_RESULT_TOOL,
    workflowResultQueueName,
    type WorkflowExecutionBinding,
} from "./contracts.js";

export interface AgentStateDispatchPlan {
    activityTag: typeof AGENT_CHILD_BOOTSTRAP_CAPABILITY;
    ensureChild: {
        activityName: typeof ENSURE_AGENT_CHILD_SESSION_ACTIVITY;
        activityInput: {
            parentSessionId: string;
            config: {
                model?: string;
                boundAgentName: string;
                boundAgentPackageId?: string;
                boundAgentPackageVersionId?: string;
                detachedPackageToolPolicy: "reject";
                toolNames: string[];
                childContract: WorkflowExecutionBinding;
            };
            nestingLevel: 1;
            isSystem: false;
            title: string;
            agentId: string;
            titleIsExplicit: false;
            childSessionId: string;
        };
    };
    enqueueBootstrap: {
        activityName: typeof ENQUEUE_AGENT_CHILD_BOOTSTRAP_ACTIVITY;
        activityInput: {
            parentSessionId: string;
            childSessionId: string;
            task: string;
            requiredTool: typeof SUBMIT_WORKFLOW_RESULT_TOOL;
            clientMessageId: string;
        };
    };
    resultQueueName: string;
}

function agentDispatchError(message: string, code: string): Error {
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

export function createAgentStateDispatchPlan(input: {
    workflowSessionId: string;
    graphId: string;
    stateId: string;
    executionSequence: number;
    childSessionId: string;
    workflowInputs: Record<string, unknown>;
    model?: string;
    latestStateOutputs: Record<string, WorkflowStateExecutionResult>;
    executionHistory: WorkflowExecutionRecord[];
    state: Pick<
        InMemoryWorkflowAgentState,
        "agent" | "allowedOutcomes" | "prompt"
    >;
    agentPackageBinding?: {
        packageId: string;
        versionId: string;
    };
}): AgentStateDispatchPlan {
    const promptContext = deepFreeze({
        sessionId: input.workflowSessionId,
        stateId: input.stateId,
        executionSequence: input.executionSequence,
        workflowInputs: input.workflowInputs,
        latestStateOutputs: { ...input.latestStateOutputs },
        executionHistory: [...input.executionHistory],
    });
    const task = typeof input.state.prompt === "function"
        ? input.state.prompt(promptContext)
        : input.state.prompt;
    if (typeof task !== "string" || task.trim().length === 0) {
        throw agentDispatchError(
            `Workflow agent state '${input.stateId}' produced an empty prompt.`,
            "WORKFLOW_AGENT_PROMPT_INVALID",
        );
    }

    const binding: WorkflowExecutionBinding = {
        kind: "workflow-state-execution",
        workflowSessionId: input.workflowSessionId,
        graphId: input.graphId,
        stateId: input.stateId,
        executionSequence: input.executionSequence,
        allowedOutcomes: [...input.state.allowedOutcomes],
    };

    return {
        activityTag: AGENT_CHILD_BOOTSTRAP_CAPABILITY,
        ensureChild: {
            activityName: ENSURE_AGENT_CHILD_SESSION_ACTIVITY,
            activityInput: {
                parentSessionId: input.workflowSessionId,
                config: {
                    ...(input.model ? { model: input.model } : {}),
                    boundAgentName: input.state.agent,
                    ...(input.agentPackageBinding
                        ? {
                            boundAgentPackageId: input.agentPackageBinding.packageId,
                            boundAgentPackageVersionId: input.agentPackageBinding.versionId,
                        }
                        : {}),
                    detachedPackageToolPolicy: "reject",
                    toolNames: [SUBMIT_WORKFLOW_RESULT_TOOL],
                    childContract: binding,
                },
                nestingLevel: 1,
                isSystem: false,
                title: input.state.agent,
                agentId: input.state.agent,
                titleIsExplicit: false,
                childSessionId: input.childSessionId,
            },
        },
        enqueueBootstrap: {
            activityName: ENQUEUE_AGENT_CHILD_BOOTSTRAP_ACTIVITY,
            activityInput: {
                parentSessionId: input.workflowSessionId,
                childSessionId: input.childSessionId,
                task,
                requiredTool: SUBMIT_WORKFLOW_RESULT_TOOL,
                clientMessageId: `agent-bootstrap:${input.childSessionId}`,
            },
        },
        resultQueueName: workflowResultQueueName(input.executionSequence),
    };
}

export function routeAgentStateDispatch(task: any, tag: string): any {
    if (typeof task.withTag !== "function") {
        throw agentDispatchError(
            "Workflow agent dispatch requires Duroxide activity tag routing support.",
            "WORKFLOW_AGENT_ROUTING_UNAVAILABLE",
        );
    }
    return task.withTag(tag);
}
