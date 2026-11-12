import { capabilityOwnership, type CapabilitySource } from "../capability-catalog.js";
import { compareSemver } from "../agent-package-format.js";
import type { SessionCatalog } from "../cms.js";
import { readWorkflowToolBinding, WorkflowToolAuthorityError, type WorkflowToolBinding } from "./tool-policy.js";

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

/** Registry failures propagate; absence is meaningful only after a successful registry read. */
export async function resolveWorkflowCapabilitySnapshot(
    binding: WorkflowToolBinding,
    retained: WorkflowToolLabels | undefined,
    catalog: Pick<SessionCatalog, "listAgentPackages" | "getAgentPackage">,
    liveSources: CapabilitySource[],
    loadSource?: (packageId: string, revision: string) => Promise<CapabilitySource>,
): Promise<WorkflowCapabilitySnapshot> {
    const labels: WorkflowToolLabels = {
        packagePins: { ...retained?.packagePins, ...binding.packagePins },
        toolSources: { ...retained?.toolSources, ...binding.toolSources },
    };
    const sources = liveSources.filter(source => source.source === "static");
    for (const source of sources) {
        for (const tool of binding.tools) {
            if (source.tools.has(tool.name) || (tool.mcpServerName && source.mcpServers[tool.mcpServerName])) {
                labels.toolSources[tool.name] ??= source.id;
            }
        }
    }
    const pins: WorkflowPackagePin[] = [];
    const packages = await catalog.listAgentPackages(null, true);
    for (const [id, revision] of Object.entries(binding.sourceRevisions)) {
        if (id.startsWith("static:")) continue;
        const pkg = packages.find(candidate => candidate.packageId === id);
        const detail = pkg ? await catalog.getAgentPackage(pkg.name, null, true,
            { scope: pkg.scope, owner: pkg.scope === "user" ? pkg.owner : null }) : null;
        if (detail && detail.packageId !== id) throw new Error(`Pinned package '${id}' resolved to a different registry identity.`);
        const version = detail?.versions.find(candidate => candidate.sha256 === revision);
        const ownership = pkg ? capabilityOwnership({
            id, name: pkg.name, source: "published", revision, scope: pkg.scope, owner: pkg.owner,
            tools: new Map(), mcpServers: {}, artifacts: [],
        }, binding.owner) : labels.packagePins[id]?.ownership ?? null;
        if (pkg && version && ownership) labels.packagePins[id] = { package: pkg.name, version: version.semver, ownership };
        const label = labels.packagePins[id];
        const reason: WorkflowPackageLossReason | undefined = !pkg || !detail ? "deleted"
            : !detail.enabled ? "disabled"
            : detail.scope !== "shared" && (detail.owner?.provider !== binding.owner.provider
                || detail.owner.subject !== binding.owner.subject) ? "private"
            : !version ? "version_removed" : undefined;
        const activeVersion = pkg?.active?.semver;
        const ordering = activeVersion && version ? compareSemver(activeVersion, version.semver) : 0;
        pins.push({
            packageId: id, package: label?.package ?? null, version: label?.version ?? null, revision, ownership,
            state: reason ? "unavailable" : ordering > 0 ? "newer_available" : ordering < 0 ? "rolled_back" : "current",
            ...(reason ? { reason } : {}), ...(activeVersion ? { activeVersion } : {}),
        });
        let source = liveSources.find(candidate => candidate.id === id && candidate.revision === revision);
        if (!reason && loadSource) source = await loadSource(id, revision);
        if (!reason && source) sources.push({ ...source, id, packageId: id, revision, scope: detail!.scope, owner: detail!.owner });
        for (const selection of binding.capabilities.selections.filter(candidate => candidate.sourceId === id)) {
            for (const tool of selection.tools) labels.toolSources[tool] ??= id;
            for (const tool of binding.tools.filter(grant => grant.mcpServerName && selection.mcpServers.includes(grant.mcpServerName))) {
                labels.toolSources[tool.name] ??= id;
            }
        }
        if (source) {
            for (const tool of binding.tools) {
                if (source.tools.has(tool.name) || (tool.mcpServerName && source.mcpServers[tool.mcpServerName])) {
                    labels.toolSources[tool.name] ??= id;
                }
            }
        }
    }
    return { sources, pins, labels };
}

export function refuseLostWorkflowTool(tool: string, snapshot: WorkflowCapabilitySnapshot): void {
    const source = snapshot.labels.toolSources[tool];
    const pin = snapshot.pins.find(candidate => candidate.packageId === source);
    if (pin?.reason) throw new WorkflowPackageToolError(tool, { ...pin, reason: pin.reason });
}

export async function readWorkflowPackagePins(catalog: SessionCatalog, sessionId: string): Promise<WorkflowPackagePin[]> {
    const creation = await catalog.getSessionCreationConfig?.(sessionId);
    const binding = readWorkflowToolBinding(creation?.workflowToolBinding);
    if (!binding) return [];
    return (await resolveWorkflowCapabilitySnapshot(binding, creation?.workflowToolLabels as WorkflowToolLabels | undefined,
        catalog, [])).pins;
}

export function workflowUnavailableToolMessages(snapshot: WorkflowCapabilitySnapshot | null): Map<string, string> {
    const messages = new Map<string, string>();
    if (!snapshot) return messages;
    for (const [tool, id] of Object.entries(snapshot.labels.toolSources)) {
        const pin = snapshot.pins.find(candidate => candidate.packageId === id);
        if (pin?.reason) messages.set(tool, new WorkflowPackageToolError(tool, { ...pin, reason: pin.reason }).message);
    }
    return messages;
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
