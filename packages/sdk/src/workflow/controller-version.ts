/** New runs use this version; existing runs keep their admitted version, including across continue-as-new. */
export const WORKFLOW_CONTROLLER_VERSION = "1.1.0";

export const WORKFLOW_CONTROLLER_VERSIONS = ["1.0.0", WORKFLOW_CONTROLLER_VERSION] as const;
export type WorkflowControllerVersion = typeof WORKFLOW_CONTROLLER_VERSIONS[number];
