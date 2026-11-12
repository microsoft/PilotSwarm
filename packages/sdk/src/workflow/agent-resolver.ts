import type { AgentPackageInstallEntry, SessionCatalog } from "../cms.js";
import { resolveEffectiveSpawnOwner } from "../cms.js";
import type { WorkflowAgentDefinition } from "./agent-host.js";
import { isJsonObject, type JsonObject } from "./json.js";
import { WorkflowStoreError } from "./store.js";

/**
 * Workflow named agents as a host resolves them (design 03 "package
 * agents", 02 publication; R09, R18). These hosts
 * resolve agents: every worker's turn host (session-proxy) and agent host
 * (milestone-worker.ts), and a management client that takes a person's
 * commands, as it does by default (registry packages only).
 *
 * A publication pins each named agent state to what its workflow's owner
 * sees by that name (WorkflowHost.resolveAgent, service.ts). The name
 * goes through spawn_agent's own rule (session-proxy
 * resolveAgentDefinitionForCaller: owner privacy and own-copy shadowing,
 * with the owner from the caller's lineage as for a spawn), over:
 *
 * - the agent registry's enabled packages at their active versions
 *   (getAgentPackagesInstallManifest). A package agent's version and exact
 *   revision (the content hash of that version) come from the registry,
 *   never from a worker's installed copy, which can lag a republish;
 * - the host's deployment agents and system agents, when it has them (a
 *   worker). A package agent a worker loaded is not one of them.
 *
 * The order is a worker's: deployment agents, then the registry's packages
 * by name, scope and owner; the caller's own copy comes first, as for a
 * spawn. A state that names a package resolves among that package's agents
 * only, so another package's agent of the same name never takes its place.
 * A package agent's definition carries the workflow interface its manifest
 * exports at that revision, as the registry keeps it (workflowInterface).
 */

/** An agent as a worker loads it (registerActivities' userAgents and systemAgents); its other fields are carried as they are. */
export interface WorkflowHostAgent {
    name: string;
    packageId?: string;
    /** Stage 2.3: the Workflow Definitions it names (A2: an agent state may not use it). */
    workflows?: string[];
}

export interface WorkflowAgentResolverOptions {
    catalog: Pick<SessionCatalog, "getSession" | "getAgentPackagesInstallManifest"> & Partial<Pick<SessionCatalog, "getAgentPackage">>;
    /**
     * The host's deployment and system agents, read at each resolution (a
     * worker's lists change in place when its packages are refreshed). Absent:
     * the host resolves package agents only.
     */
    deploymentAgents?: () => WorkflowHostAgents;
}

export interface WorkflowHostAgents {
    userAgents?: readonly WorkflowHostAgent[];
    systemAgents?: readonly WorkflowHostAgent[];
}

/** A named agent as the workflow owner of `callerSessionId` sees it, or null. `packageName` restricts it to that package. */
export type WorkflowAgentResolver = (name: string, callerSessionId: string, packageName?: string | null, revision?: string) => Promise<WorkflowAgentDefinition | null>;

/** session-proxy imports this module; its resolution rule is imported on first use. */
let spawnResolution: Promise<typeof import("../session-proxy.js")> | null = null;

function manifestAgents(entry: AgentPackageInstallEntry): JsonObject[] {
    const agents = isJsonObject(entry.manifest) ? entry.manifest.agents : undefined;
    return Array.isArray(agents) ? agents.filter((agent): agent is JsonObject => isJsonObject(agent) && typeof agent.name === "string" && agent.name !== "") : [];
}

/** The registry's package agents as spawn resolution reads a worker's loaded package agents. */
function registryCandidates(entries: readonly AgentPackageInstallEntry[], packageName: string | null) {
    const candidates: Array<{ [key: string]: unknown }> = [];
    for (const entry of entries) {
        if (packageName !== null && entry.name !== packageName) continue;
        for (const agent of manifestAgents(entry)) {
            candidates.push({
                name: agent.name,
                ...(typeof agent.title === "string" && agent.title ? { title: agent.title } : {}),
                ...(Array.isArray(agent.tools) ? { tools: agent.tools.filter((tool): tool is string => typeof tool === "string") } : {}),
                ...(typeof agent.initialRequiredTool === "string" && agent.initialRequiredTool ? { initialRequiredTool: agent.initialRequiredTool } : {}),
                // Stage 2.3 (A2): the definitions it names, as its manifest exports them.
                ...(Array.isArray(agent.workflows) && agent.workflows.length > 0 ? { workflows: agent.workflows.filter((ref): ref is string => typeof ref === "string") } : {}),
                namespace: entry.name,
                packageId: entry.packageId,
                // A user-scope package without an owner is visible to nobody (fail closed).
                packageScope: entry.scope === "user" ? "user" : "shared",
                ...(entry.scope === "user" ? { packageOwner: entry.owner ?? null } : {}),
            });
        }
    }
    return candidates;
}

export function createWorkflowAgentResolver(options: WorkflowAgentResolverOptions): WorkflowAgentResolver {
    const { catalog } = options;
    return async (name, callerSessionId, packageName = null, revision) => {
        const named = typeof packageName === "string" && packageName ? packageName : null;
        let entries = await catalog.getAgentPackagesInstallManifest();
        const local: WorkflowHostAgents = named === null && options.deploymentAgents ? options.deploymentAgents() : {};
        let userAgents = [
            ...(local.userAgents ?? []).filter(agent => !agent.packageId),
            ...registryCandidates(entries, named),
        ];
        const systemAgents = [...(local.systemAgents ?? [])];
        spawnResolution ??= import("../session-proxy.js");
        const { resolveAgentDefinitionForCaller, resolveCallerAgentOwnerKey } = await spawnResolution;
        let resolved = await resolveAgentDefinitionForCaller({
            agentName: name, userAgents, systemAgents,
            getCallerOwnerKey: () => resolveCallerAgentOwnerKey(catalog, callerSessionId),
        });
        if (!resolved) return null;
        if (revision !== undefined) {
            const packageId = resolved.packageId;
            const entry = entries.find(candidate => candidate.packageId === packageId);
            if (!entry || !catalog.getAgentPackage) return null;
            const owner = await resolveEffectiveSpawnOwner(id => catalog.getSession(id), callerSessionId);
            const detail = await catalog.getAgentPackage(entry.name, owner, false, { scope: entry.scope, owner: entry.owner });
            if (!detail?.enabled || detail.packageId !== entry.packageId) return null;
            const version = detail.versions.find(candidate => candidate.sha256 === revision.toLowerCase());
            if (!version) return null;
            // Visibility is resolved against the active package; startup metadata belongs to the pinned version.
            entries = [{ ...entry, ...version }];
            userAgents = registryCandidates(entries, named);
            resolved = await resolveAgentDefinitionForCaller({
                agentName: name, userAgents,
                getCallerOwnerKey: () => resolveCallerAgentOwnerKey(catalog, callerSessionId),
            });
            if (!resolved) return null;
        }
        const selected = resolved;
        // Stage 2.3 (A2): the resolution returns a new definition without the candidate's workflows list, so read it from the
        // candidate it chose (as agent-discovery.ts maps a resolution back to its candidate): same pool, name, package and
        // namespace.
        const pool: ReadonlyArray<{ [key: string]: unknown }> = (selected.creatable === false ? systemAgents : userAgents) as ReadonlyArray<{ [key: string]: unknown }>;
        const chosen = pool.find(candidate =>
            candidate.name === selected.name && (candidate.packageId ?? undefined) === (selected.packageId ?? undefined)
            && (candidate.namespace ?? undefined) === (selected.namespace ?? undefined)) as { workflows?: unknown } | undefined;
        const workflows = Array.isArray(chosen?.workflows) ? chosen!.workflows.filter((ref): ref is string => typeof ref === "string") : [];
        const definition: WorkflowAgentDefinition = {
            name: selected.name,
            ...(selected.namespace ? { namespace: selected.namespace } : {}),
            ...(selected.tools ? { tools: [...selected.tools] } : {}),
            ...(selected.initialRequiredTool ? { initialRequiredTool: selected.initialRequiredTool } : {}),
            ...(selected.system !== undefined ? { system: selected.system } : {}),
            creatable: selected.creatable !== false,
            ...(selected.id ? { id: selected.id } : {}),
            ...(selected.title ? { title: selected.title } : {}),
            // Stage 2.3 (A2): a deployment agent's loaded workflows list, or a package agent's from its manifest.
            ...(workflows.length > 0 ? { bringsWorkflows: true } : {}),
        };
        if (!selected.packageId) return definition;
        const entry = entries.find(candidate => candidate.packageId === selected.packageId);
        // Only the registry's agents carry a package id here.
        if (!entry) return null;
        // The workflow interface the agent exports at this exact revision, as the registry keeps it (checked where it is
        // used: publication matches it against the state's contract, package-interface.ts).
        const exported = manifestAgents(entry).find(agent => agent.name === selected.name)?.workflowInterface;
        return { ...definition, packageId: entry.packageId, packageName: entry.name, packageVersion: entry.semver, packageRevision: entry.sha256,
            ...(exported !== undefined ? { workflowInterface: exported } : {}) };
    };
}

/**
 * A host without deployment agents (a management client): it pins package
 * agents only, and refuses any other name as unavailable from it.
 */
export function createRegistryWorkflowAgentResolver(catalog: WorkflowAgentResolverOptions["catalog"]): WorkflowAgentResolver {
    const resolve = createWorkflowAgentResolver({ catalog });
    return async (name, callerSessionId, packageName = null, revision) => {
        const resolved = await resolve(name, callerSessionId, packageName, revision);
        if (resolved) return resolved;
        throw new WorkflowStoreError("AGENT_UNAVAILABLE", `Agent "${name}"${packageName ? ` of package "${packageName}"` : ""} is not a published `
            + "package agent that this workflow's owner can use. A person's publication pins package agents from the agent registry only; "
            + "a workflow that names a deployment agent is published by its parent agent (update_workflow).",
        { agent: name, package: packageName ?? null, registryOnly: true });
    };
}
