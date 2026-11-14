import { workflowController_1_0_0 } from "./controller_1_0_0/index.js";
import { workflowController_1_1_0 } from "./controller/index.js";
import { WORKFLOW_CONTROLLER_VERSION } from "./controller-version.js";

/**
 * Frozen versions first, live last. A run's first execution starts at its stored admission version; each later execution
 * runs on the latest version, which every continue-as-new targets. A version stays registered while an execution of it
 * can still run or replay.
 */
export const WORKFLOW_CONTROLLER_REGISTRY = [
    { version: "1.0.0", handler: workflowController_1_0_0 },
    { version: WORKFLOW_CONTROLLER_VERSION, handler: workflowController_1_1_0 },
] as const;

/** Compares two `major.minor.patch` controller versions numerically. */
export function compareWorkflowControllerVersions(left: string, right: string): number {
    const parse = (version: string) => {
        const parts = version.split(".").map(Number);
        if (parts.length !== 3 || !parts.every(part => Number.isSafeInteger(part) && part >= 0)) {
            throw new Error(`Workflow controller version ${version} is not major.minor.patch.`);
        }
        return parts;
    };
    const [a, b] = [parse(left), parse(right)];
    for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
    return 0;
}

/**
 * Never move a run down, as the session orchestration's assertIntakeContinueAsNewTarget: every continue-as-new targets
 * `target`, so no registered version may be newer than it.
 */
export function assertWorkflowControllerContinueAsNewTarget(versions: readonly string[], target: string): void {
    for (const version of versions) {
        if (compareWorkflowControllerVersions(target, version) < 0) {
            throw new Error(`Workflow controller ${version} is newer than the continue-as-new target ${target}; a run would move down.`);
        }
    }
}

assertWorkflowControllerContinueAsNewTarget(WORKFLOW_CONTROLLER_REGISTRY.map(entry => entry.version), WORKFLOW_CONTROLLER_VERSION);
