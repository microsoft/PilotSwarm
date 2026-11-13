import { WORKFLOW_CONTROLLER_VERSIONS, type WorkflowControllerVersion } from "./controller-version.js";
export { WORKFLOW_CONTROLLER_VERSIONS, type WorkflowControllerVersion } from "./controller-version.js";

/**
 * Shared activity compatibility, read from the run's admission version; generators are selected by controller-registry.ts.
 * A run keeps its admission version after continue-as-new moves it to the latest controller (FB-064), so a version's
 * entry here must outlive its handler.
 */
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
    // The live controller uses these behaviors unconditionally; shared activities still serve both versions.
    "1.1.0": Object.freeze({
        carry: true,
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
