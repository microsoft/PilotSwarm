/** Supported versions, oldest first; each admitted run keeps its version. */
export const WORKFLOW_CONTROLLER_VERSIONS = ["1.0.0", "1.1.0"] as const;
export type WorkflowControllerVersion = typeof WORKFLOW_CONTROLLER_VERSIONS[number];

/** Each owning change enables only its gate; 1.0.0 must keep all gates off. */
export interface WorkflowControllerFeatures {
    /** FB-005: loop data across error and sent routes. */
    carry: boolean;
    /** FB-007: owner consent. */
    approval: boolean;
    /** FB-002: successor-session handover (not enabled). */
    succession: boolean;
}

const NO_CONTROLLER_FEATURES: Readonly<WorkflowControllerFeatures> = Object.freeze({ carry: false, approval: false, succession: false });
const CONTROLLER_FEATURES: Readonly<Record<WorkflowControllerVersion, Readonly<WorkflowControllerFeatures>>> = Object.freeze({
    "1.0.0": NO_CONTROLLER_FEATURES,
    // One flag per line keeps the owning changes independent at integration.
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
