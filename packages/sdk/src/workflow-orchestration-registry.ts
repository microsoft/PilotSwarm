import {
    durableWorkflowSessionOrchestration_1_0_0,
} from "./workflow-orchestration_1_0_0/index.js";
import {
    WORKFLOW_ORCHESTRATION_VERSION as WORKFLOW_ORCHESTRATION_VERSION_1_0_0,
} from "./workflow-orchestration_1_0_0/contracts.js";

export const WORKFLOW_SESSION_ORCHESTRATION_NAME = "workflow-session-v1";
export const WORKFLOW_SESSION_LATEST_VERSION = WORKFLOW_ORCHESTRATION_VERSION_1_0_0;

export const WORKFLOW_SESSION_ORCHESTRATION_REGISTRY = [
    {
        version: WORKFLOW_ORCHESTRATION_VERSION_1_0_0,
        handler: durableWorkflowSessionOrchestration_1_0_0,
    },
] as const;
