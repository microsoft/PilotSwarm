/** Supported versions, oldest first; each admitted run keeps its version. */
export const WORKFLOW_CONTROLLER_VERSIONS = ["1.0.0", "1.1.0"] as const;
export type WorkflowControllerVersion = typeof WORKFLOW_CONTROLLER_VERSIONS[number];

export interface WorkflowControllerFeatures {
    carry: boolean;
    approval: boolean;
    succession: boolean;
}

const NO_CONTROLLER_FEATURES: Readonly<WorkflowControllerFeatures> = Object.freeze({ carry: false, approval: false, succession: false });
const CONTROLLER_FEATURES: Readonly<Record<WorkflowControllerVersion, Readonly<WorkflowControllerFeatures>>> = Object.freeze({
    "1.0.0": NO_CONTROLLER_FEATURES,
    "1.1.0": Object.freeze({
        carry: false,
        approval: true,
        succession: false,
    }),
});

export function isWorkflowControllerVersion(version: unknown): version is WorkflowControllerVersion {
    return typeof version === "string" && (WORKFLOW_CONTROLLER_VERSIONS as readonly string[]).includes(version);
}

export function workflowControllerFeatures(version: string): Readonly<WorkflowControllerFeatures> {
    if (!isWorkflowControllerVersion(version)) throw new Error(`Workflow controller ${version} is not one this build runs.`);
    return CONTROLLER_FEATURES[version];
}
