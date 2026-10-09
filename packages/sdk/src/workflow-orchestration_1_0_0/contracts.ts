export const WORKFLOW_ORCHESTRATION_VERSION = "1.0.0";

export const EXECUTE_WORKFLOW_STATE_ACTIVITY = "executeWorkflowStateV1";
export const RECORD_WORKFLOW_STATE_EXECUTION_ACTIVITY = "recordWorkflowStateExecutionV1";
export const ACCEPT_WORKFLOW_STATE_RESULT_ACTIVITY = "acceptWorkflowStateResultV1";
export const COMPLETE_WORKFLOW_ACTIVITY = "completeWorkflowSessionV1";

export const SPAWN_AGENT_CHILD_ACTIVITY = "spawnChildSessionV2";
export const AGENT_HANDOFF_CAPABILITY = "pilotswarm.agent-handoff.v2";

export const SUBMIT_WORKFLOW_RESULT_TOOL = "submit_workflow_result";
export const WORKFLOW_RESULT_QUEUE_PREFIX = "workflow-result-";

export interface WorkflowExecutionBinding {
    kind: "workflow-state-execution";
    workflowSessionId: string;
    graphId: string;
    stateId: string;
    executionSequence: number;
    allowedOutcomes: readonly string[];
}

export interface WorkflowResultEvent {
    workflowSessionId: string;
    childSessionId: string;
    graphId: string;
    stateId: string;
    executionSequence: number;
    outcome: string;
    output: unknown;
}

export function workflowResultQueueName(executionSequence: number): string {
    return `${WORKFLOW_RESULT_QUEUE_PREFIX}${executionSequence}`;
}
