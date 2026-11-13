import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { capabilityOwnership, visibleCapabilitySource, type CapabilitySource } from "../capability-catalog.js";
import { parsePinnedAgentPackageId } from "../agent-package-pins.js";
import { compareSemver } from "../agent-package-format.js";
import type { SessionCatalog } from "../cms.js";
import { readWorkflowToolBinding, workflowAgentStepBinding, WorkflowToolAuthorityError, type WorkflowToolBinding } from "./tool-policy.js";

export type WorkflowPackageOwnership = "static" | "owned" | "other_shared";
export type WorkflowPackageLossReason = "deleted" | "disabled" | "private" | "version_removed";

interface PackageCheckContext { deadline: number; isStopped: () => boolean; active: boolean }
const packageCheckContext = new AsyncLocalStorage<PackageCheckContext>();

/** Pooled transports and shared setup outlive the call that happened to create them. */
export function withoutWorkflowPackageCheck<T>(work: () => T): T {
    return packageCheckContext.exit(work);
}

/** Only registry and bundle reads create this error; an executed tool is never retried. */
export class WorkflowPackageCheckError extends Error {
    constructor(readonly stage: "registry" | "load", readonly packageLabel: {
        package: string | null; version: string | null; revision: string | null;
    }, cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause), { cause });
        this.name = "WorkflowPackageCheckError";
    }
}

export class WorkflowTemporaryToolError extends WorkflowToolAuthorityError {
    readonly details;
    constructor(tool: string, check: WorkflowPackageCheckError) {
        const { package: name, version, revision } = check.packageLabel;
        super(`Tool '${tool}' could not be checked just now: `
            + (check.stage === "registry" ? "the package registry did not answer"
                : `${name ?? "the pinned package"}${version ? ` ${version}` : ""} could not be loaded`)
            + ". The package is not lost. Call the tool again.");
        this.name = "WorkflowTemporaryToolError";
        this.details = { tool, package: name, version, revision, reason: "temporary" as const, retryable: true };
    }
}

async function checkedPackageRead<T>(read: () => Promise<T>, stage: "registry" | "load",
    label = { package: null as string | null, version: null as string | null, revision: null as string | null }): Promise<T> {
    const stored = packageCheckContext.getStore();
    const context = stored?.active ? stored : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const remaining = context ? context.deadline - Date.now() : 3000;
        if (remaining <= 0 || context?.isStopped()) throw new Error("Package check deadline elapsed.");
        return await Promise.race([read(), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Package check deadline elapsed.")), remaining);
        })]);
    } catch (error) {
        if (error instanceof WorkflowPackageCheckError) throw error;
        throw new WorkflowPackageCheckError(stage, label, error);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/** Retries checks, not scripts or effects, within one shared call budget. */
export async function retryWorkflowPackageCheck<T>(tool: string, check: () => Promise<T>,
    options: { deadline?: number; isStopped?: () => boolean } = {}): Promise<T> {
    if (packageCheckContext.getStore()?.active) return check();
    const context: PackageCheckContext = {
        deadline: Math.min(Date.now() + 3000, options.deadline ?? Infinity),
        isStopped: options.isStopped ?? (() => false),
        active: true,
    };
    return packageCheckContext.run(context, async () => {
        try {
            for (let attempt = 0; ; attempt++) {
                try { return await check(); }
                catch (error) {
                    if (!(error instanceof WorkflowPackageCheckError)) throw error;
                    if (attempt === 2 || context.isStopped() || Date.now() + 1000 >= context.deadline) {
                        throw new WorkflowTemporaryToolError(tool, error);
                    }
                    await delay(1000);
                    if (context.isStopped() || Date.now() >= context.deadline) throw new WorkflowTemporaryToolError(tool, error);
                }
            }
        } finally { context.active = false; }
    });
}

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
    const offered = new Set(binding.tools.map(tool => tool.name));
    const boundId = binding.config.boundAgentPackageId;
    const boundPackage = boundId ? parsePinnedAgentPackageId(boundId)?.packageId ?? boundId : undefined;
    const providers = new Set<string>([
        ...binding.capabilities.selections.map(selection => selection.sourceId),
        ...Object.values(labels.toolSources), ...(boundPackage ? [boundPackage] : []),
    ]);
    for (const selection of binding.capabilities.selections) {
        for (const tool of selection.tools) if (offered.has(tool)) labels.toolSources[tool] = selection.sourceId;
        for (const tool of binding.tools) {
            if (tool.mcpServerName && selection.mcpServers.includes(tool.mcpServerName)) {
                labels.toolSources[tool.name] = selection.sourceId;
            }
        }
    }
    const boundSource = liveSources.find(source => source.id === boundPackage);
    for (const tool of binding.tools) {
        if (boundSource?.tools.has(tool.name) || (tool.mcpServerName && boundSource?.mcpServers[tool.mcpServerName])) {
            labels.toolSources[tool.name] ??= boundPackage!;
        }
    }
    const visible = liveSources.filter(source => visibleCapabilitySource(source, binding.owner));
    const sources = visible.filter(source => source.source === "static");
    for (const source of sources) {
        for (const tool of binding.tools) {
            if (source.tools.has(tool.name) || (tool.mcpServerName && source.mcpServers[tool.mcpServerName])) {
                labels.toolSources[tool.name] ??= source.id;
            }
        }
    }
    for (const tool of binding.tools.filter(tool => !labels.toolSources[tool.name])) {
        const matches = visible.filter(source => source.source === "published" && binding.sourceRevisions[source.id]
            && (source.tools.has(tool.name) || (tool.mcpServerName && source.mcpServers[tool.mcpServerName])));
        if (matches.length === 1) {
            labels.toolSources[tool.name] = matches[0]!.id;
            providers.add(matches[0]!.id);
        }
    }
    for (const id of Object.keys(labels.packagePins)) if (!providers.has(id)) delete labels.packagePins[id];
    const pins: WorkflowPackagePin[] = [];
    const packages = Object.keys(binding.sourceRevisions).some(id => !id.startsWith("static:") && providers.has(id))
        ? await checkedPackageRead(() => catalog.listAgentPackages(null, true), "registry") : [];
    for (const [id, revision] of Object.entries(binding.sourceRevisions)) {
        if (id.startsWith("static:") || !providers.has(id)) continue;
        const pkg = packages.find(candidate => candidate.packageId === id);
        const known = { package: labels.packagePins[id]?.package ?? pkg?.name ?? null,
            version: labels.packagePins[id]?.version ?? null, revision };
        const detail = pkg ? await checkedPackageRead(() => catalog.getAgentPackage(pkg.name, null, true,
            { scope: pkg.scope, owner: pkg.scope === "user" ? pkg.owner : null }), "registry", known) : null;
        if (pkg && !detail) throw new WorkflowPackageCheckError("registry", known,
            new Error(`Pinned package '${id}' changed during its registry read. Retry the lookup.`));
        if (detail && detail.packageId !== id) throw new WorkflowPackageCheckError("registry", known,
            new Error(`Pinned package '${id}' resolved to a different registry identity.`));
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
            packageId: id, package: label?.package ?? pkg?.name ?? null, version: label?.version ?? null, revision, ownership,
            state: reason ? "unavailable" : ordering > 0 ? "newer_available" : ordering < 0 ? "rolled_back" : "current",
            ...(reason ? { reason } : {}), ...(activeVersion ? { activeVersion } : {}),
        });
        let source = liveSources.find(candidate => candidate.id === id && candidate.revision === revision);
        if (!reason && !source && loadSource) source = await checkedPackageRead(() => loadSource(id, revision), "load",
            { package: label?.package ?? pkg?.name ?? null, version: label?.version ?? null, revision });
        if (!reason && source) sources.push({ ...source, id, packageId: id, revision, scope: detail!.scope, owner: detail!.owner });
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
    const bindings = [binding, ...Object.keys(binding.agentStepBindings ?? {}).map(id => workflowAgentStepBinding(binding, id))];
    const distinct = new Map<string, WorkflowToolBinding>();
    for (const item of bindings) {
        const key = JSON.stringify(Object.entries(item.sourceRevisions).sort());
        if (!distinct.has(key)) distinct.set(key, item);
    }
    const snapshots = await Promise.all([...distinct.values()].map(item => resolveWorkflowCapabilitySnapshot(item,
        item.agentStepStateId ? undefined : creation?.workflowToolLabels as WorkflowToolLabels | undefined, catalog, [])));
    return [...new Map(snapshots.flatMap(snapshot => snapshot.pins)
        .map(pin => [`${pin.packageId}:${pin.revision}`, pin])).values()];
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
            message = `Tool '${tool}' is not available. This Workflow is pinned to a package version that ${lossWords[pin.reason]} `
                + `(package id ${pin.packageId}, revision ${pin.revision.slice(0, 12)}). `
                + (pin.package ? `Its package is ${pin.package}; its version number was not recorded. `
                    : "Its name and version number were not recorded. ")
                + "Start a new Workflow to use a current version.";
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
