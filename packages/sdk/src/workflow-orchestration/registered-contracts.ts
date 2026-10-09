export const RESOLVE_WORKFLOW_DEFINITION_ACTIVITY = "resolveWorkflowDefinitionV2";
export const EXECUTE_WORKFLOW_TRANSITION_ACTIVITY = "executeWorkflowTransitionV2";
export const EXECUTE_WORKFLOW_ACTION_ACTIVITY = "executeWorkflowActionV1";
export const OBSERVE_WORKFLOW_CONDITION_ACTIVITY = "observeWorkflowConditionV1";
export const WORKFLOW_QUESTION_QUEUE_PREFIX = "workflow-question-";

export function workflowQuestionQueueName(executionSequence: number): string {
    return `${WORKFLOW_QUESTION_QUEUE_PREFIX}${executionSequence}`;
}
