import type { CapabilitySource } from "../capability-catalog.js";
import { WorkflowToolAuthorityError } from "./tool-policy.js";

export type WorkflowPackageOwnership = "static" | "owned" | "other_shared";
export type WorkflowPackageLossReason = "deleted" | "disabled" | "private" | "version_removed";

/** Display labels only. Registry scope and owner, never these fields, decide access. */
export interface WorkflowPackageLabel {
    package: string;
    version: string;
    ownership: WorkflowPackageOwnership;
}

export interface WorkflowToolLabels {
    packagePins: Record<string, WorkflowPackageLabel>;
    toolSources: Record<string, string>;
}

export interface WorkflowPackagePin {
    packageId: string;
    package: string | null;
    version: string | null;
    revision: string;
    ownership: WorkflowPackageOwnership | null;
    state: "current" | "newer_available" | "rolled_back" | "unavailable";
    reason?: WorkflowPackageLossReason;
    activeVersion?: string;
}

/** A host-created view; pinned sources never enter ordinary capability discovery. */
export interface WorkflowCapabilitySnapshot {
    sources: CapabilitySource[];
    pins: WorkflowPackagePin[];
    labels: WorkflowToolLabels;
}

const lossWords: Record<WorkflowPackageLossReason, string> = {
    deleted: "was deleted",
    disabled: "was disabled",
    private: "is now private to its owner",
    version_removed: "is no longer in the package",
};

export class WorkflowPackageToolError extends WorkflowToolAuthorityError {
    readonly details: {
        package: string | null;
        version: string | null;
        revision: string;
        reason: WorkflowPackageLossReason;
    };

    constructor(tool: string, pin: WorkflowPackagePin & { reason: WorkflowPackageLossReason }) {
        let message: string;
        if (pin.package !== null && pin.version !== null) {
            message = `Tool '${tool}' is not available. This Workflow is pinned to ${pin.package} ${pin.version}, `
                + `and that version ${lossWords[pin.reason]}. Start a new Workflow to use a current version.`;
        } else {
            if (pin.reason !== "deleted") {
                throw new Error(`The recorded labels of pinned package '${pin.packageId}' revision '${pin.revision}' are unavailable.`);
            }
            message = `Tool '${tool}' is not available. This Workflow is pinned to a package version that was deleted `
                + `(package id ${pin.packageId}, revision ${pin.revision.slice(0, 12)}). `
                + "Its name and version number were not recorded. Start a new Workflow to use a current version.";
        }
        super(message);
        this.name = "WorkflowPackageToolError";
        this.details = {
            package: pin.package,
            version: pin.version,
            revision: pin.revision,
            reason: pin.reason,
        };
    }
}
