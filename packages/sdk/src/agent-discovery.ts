import { defineTool } from "@github/copilot-sdk";
import { resolveAgentDefinitionForCaller } from "./session-proxy.js";
import { readWorkflowInterfaceExport } from "./workflow/v2/package-interface.js";
import type { JsonValue } from "./workflow/v2/json.js";

/**
 * A package agent's workflow interface as discovery shows it (design 04
 * "Package-agent I/O export"; R09): the contract a Workflow V2 agent state
 * names with `invoke.agent: { name, package, interface: <ref> }` and must
 * match exactly at publication (its outcomes and schemas, copied without
 * change), and the digest that publication pins.
 */
export interface AgentDiscoveryWorkflowInterface {
    /** `<name>@<version>`, as an agent state's `interface` names it. */
    ref: string;
    name: string;
    version: string;
    outcomes: string[];
    inputSchema: JsonValue | null;
    outputSchema: JsonValue;
    digest: string;
}

/** A selectable blueprint, with metadata from exactly the copy spawning binds. */
export interface AgentDiscoveryEntry {
    /** Pass this reference unchanged to spawn_agent. */
    agent_name: string;
    name: string;
    qualifiedName: string;
    namespace: string | null;
    description: string | null;
    tools: string[];
    skills: string[];
    /** Server names only. Connection details and credentials are never listed. */
    mcpServers: string[];
    initialRequiredTool: string | null;
    source: "static" | "published";
    scope: "cluster" | "user";
    system: boolean;
    creatable: boolean;
    id: string | null;
    parent: string | null;
    /**
     * The workflow interface the agent's installed package version exports
     * (agent schemaVersion 5). Present only for a published agent with a
     * well-formed export; every other entry is unchanged.
     */
    workflowInterface?: AgentDiscoveryWorkflowInterface;
}

export async function listAgentDefinitionsForCaller(opts: {
    userAgents: any[];
    systemAgents?: any[];
    getCallerOwnerKey: () => Promise<string | null>;
    systemOnly?: boolean;
    /**
     * The workflow interface the host's install manifest records for a listed
     * agent (a worker: its installed package version's export), or undefined.
     * Read once, with the agents' snapshot.
     */
    workflowInterfaceOf?: (agent: any) => unknown;
}): Promise<AgentDiscoveryEntry[]> {
    // Snapshot the arrays: worker package refresh mutates them in place while
    // owner lookup awaits the catalog. A listing must use one coherent set.
    const userAgents = [...opts.userAgents];
    const systemAgents = [...(opts.systemAgents ?? [])];
    // The interfaces in the same snapshot (no await in between), so a refresh cannot pair one revision's agent with
    // another revision's interface.
    const interfaces = new Map<any, unknown>();
    if (opts.workflowInterfaceOf && !opts.systemOnly) {
        for (const agent of userAgents) {
            const exported = agent?.packageId ? opts.workflowInterfaceOf(agent) : undefined;
            if (exported !== undefined) interfaces.set(agent, exported);
        }
    }
    let ownerKey: Promise<string | null> | undefined;
    const getCallerOwnerKey = () => ownerKey ??= Promise.resolve()
        .then(opts.getCallerOwnerKey).catch(() => null);
    const candidates: any[] = [];
    for (const candidate of opts.systemOnly ? systemAgents : userAgents) {
        // Do not even generate aliases from invisible metadata. A foreign
        // name can fuzzy-match a public role; returning that reference would
        // disclose the foreign name despite selecting a public definition.
        const visible = await resolveAgentDefinitionForCaller({
            agentName: candidate.name,
            userAgents: opts.systemOnly ? [] : [candidate],
            systemAgents: opts.systemOnly ? [candidate] : [],
            getCallerOwnerKey,
        });
        if (visible) candidates.push(candidate);
    }
    const references = new Set<string>();
    for (const agent of candidates) {
        if (!agent.name) continue;
        references.add(agent.name);
        if (agent.namespace) references.add(`${agent.namespace}:${agent.name}`);
        if (agent.packageScope !== "user") references.add(`__shared:${agent.name}`);
    }
    // IDs are existing resolver aliases. They can reach a public copy hidden
    // behind both an own-copy shadow and another namespace's same-name role.
    for (const agent of candidates) {
        if (!agent.id) continue;
        references.add(agent.id);
        if (agent.packageScope !== "user") references.add(`__shared:${agent.id}`);
    }

    const seen = new Set<any>();
    const entries: AgentDiscoveryEntry[] = [];
    for (const agentName of references) {
        const resolved = await resolveAgentDefinitionForCaller({
            agentName, userAgents: opts.systemOnly ? [] : userAgents, systemAgents, getCallerOwnerKey,
        });
        if (!resolved || (opts.systemOnly ? resolved.creatable !== false : resolved.creatable === false)) continue;
        const selected = candidates.find(agent => agent.name === resolved.name
            && agent.packageId === resolved.packageId
            && agent.namespace === resolved.namespace
            && agent.prompt === resolved.prompt);
        if (!selected || seen.has(selected)) continue;
        seen.add(selected);
        // Checked again (shape, schemas, digest): a record that is not well formed is not advertised; publication refuses it.
        const exported = resolved.packageId && interfaces.has(selected) ? readWorkflowInterfaceExport(interfaces.get(selected)) : null;
        entries.push({
            agent_name: agentName,
            name: resolved.name,
            qualifiedName: agentName,
            namespace: resolved.namespace ?? null,
            description: selected.description || null,
            tools: [...(resolved.tools ?? [])],
            skills: [...(selected.skills ?? [])],
            mcpServers: Array.isArray(selected.mcpServers)
                ? [...selected.mcpServers] : Object.keys(selected.mcpServers ?? {}),
            initialRequiredTool: resolved.initialRequiredTool ?? null,
            source: resolved.packageId ? "published" : "static",
            scope: resolved.packageScope === "user" ? "user" : "cluster",
            system: resolved.system === true,
            creatable: resolved.creatable !== false,
            id: resolved.id ?? null,
            parent: resolved.parent ?? null,
            ...(exported ? { workflowInterface: {
                ref: `${exported.name}@${exported.version}`, name: exported.name, version: exported.version, outcomes: [...exported.outcomes],
                inputSchema: exported.inputSchema, outputSchema: exported.outputSchema, digest: exported.digest,
            } } : {}),
        });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name) || a.agent_name.localeCompare(b.agent_name));
}

/** Live getters keep discovery consistent with worker package polling. */
export function createAgentDiscoveryTool(opts: {
    getUserAgents: () => any[];
    getSystemAgents: () => any[];
    getCallerOwnerKey: (durableSessionId?: string) => Promise<string | null>;
    /** A published agent's workflow interface from the host's install manifest (listAgentDefinitionsForCaller). */
    getWorkflowInterface?: (agent: any) => unknown;
}) {
    return defineTool("ps_list_agents", {
        description:
            "Discover the named agent blueprints available to this session: static deployment agents and enabled published agents visible to its owner. " +
            "Entries describe a role's purpose, declared tools, skills and source access. Pass an exact agent_name to spawn_agent to launch that named workflow. " +
            "Listing or reading a definition does not start a session or grant its capabilities. Choose execution using your base and workflow instructions. " +
            "These are blueprints, not running children; use check_agents for children already spawned. " +
            "systemOnly is for inspecting worker-managed definitions, which cannot be spawned.",
        parameters: {
            type: "object" as const,
            properties: {
                systemOnly: { type: "boolean", description: "Inspect worker-managed definitions only. These are not spawn targets. Default false." },
            },
        },
        handler: async (args: { systemOnly?: boolean }, invocation: any) => {
            const agents = await listAgentDefinitionsForCaller({
                userAgents: opts.getUserAgents(),
                systemAgents: opts.getSystemAgents(),
                getCallerOwnerKey: () => opts.getCallerOwnerKey(invocation?.durableSessionId),
                systemOnly: args.systemOnly === true,
                ...(opts.getWorkflowInterface ? { workflowInterfaceOf: opts.getWorkflowInterface } : {}),
            });
            return JSON.stringify({ agents, total: agents.length }, null, 2);
        },
    });
}
