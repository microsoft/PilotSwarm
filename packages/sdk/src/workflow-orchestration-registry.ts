import {
    durableWorkflowSessionOrchestration_1_0_0,
    WORKFLOW_ORCHESTRATION_VERSION,
} from "./workflow-orchestration/index.js";

export const WORKFLOW_SESSION_ORCHESTRATION_NAME = "workflow-session-v1";
export const WORKFLOW_SESSION_LATEST_VERSION = WORKFLOW_ORCHESTRATION_VERSION;

export const WORKFLOW_SESSION_ORCHESTRATION_REGISTRY = [
    {
        version: WORKFLOW_SESSION_LATEST_VERSION,
        handler: durableWorkflowSessionOrchestration_1_0_0,
    },
] as const;
