/**
 * The latest controller. New runs are admitted at it, and every continue-as-new moves a running Workflow to it. The run's
 * stored version stays its admission version, which still gates its features (controller-features.ts).
 */
export const WORKFLOW_CONTROLLER_VERSION = "1.1.0";

export const WORKFLOW_CONTROLLER_VERSIONS = ["1.0.0", WORKFLOW_CONTROLLER_VERSION] as const;
export type WorkflowControllerVersion = typeof WORKFLOW_CONTROLLER_VERSIONS[number];
