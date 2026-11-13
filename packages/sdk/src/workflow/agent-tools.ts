import { capabilityOwnership, resolveCapabilitySource, visibleCapabilitySource, type CapabilitySelection, type CapabilitySource } from "../capability-catalog.js";
import type { WorkflowIRAgent } from "./compiler.js";
import type { WorkflowAgentDefinition } from "./agent-host.js";
import type { JsonObject } from "./json.js";
import { mcpAllowlistAdmits, type McpAllowlistAgent } from "../mcp-loader.js";
import { isWorkflowControlTool, isWorkflowLiveSessionTool, workflowToolAliases, type WorkflowToolBinding } from "./tool-policy.js";

/** Filter per export before bindCapabilities, whose ordinary-session semantics reject a whole conflicting selection. */
export function workflowAgentSelections(binding: WorkflowToolBinding, sources: CapabilitySource[], originalTools: readonly { name: string }[],
    originalMcp: Record<string, unknown>, agent: McpAllowlistAgent | null, ceiling?: readonly string[] | null): CapabilitySelection[] {
    const tools = new Set(originalTools.map(tool => tool.name));
    const servers = new Set(Object.keys(originalMcp));
    const allowed = (name: string) => !isWorkflowControlTool(name) && !isWorkflowLiveSessionTool(name)
        && (!ceiling || ceiling.includes(name) || ceiling.includes(`custom:${name}`));
    return binding.capabilities.selections.map(selection => {
        const source = sources.find(item => item.id === selection.sourceId);
        const selectedTools = selection.tools.filter(name => {
            if (tools.has(name) || !allowed(name) || !binding.tools.some(grant => grant.name === name)) return false;
            tools.add(name);
            return true;
        });
        const selectedServers = selection.mcpServers.filter(name => {
            const config = source?.mcpServers[name];
            if (servers.has(name) || (config?.allowedAgents && !mcpAllowlistAdmits(config.allowedAgents, agent))) return false;
            if (!binding.tools.some(grant => grant.mcpServerName === name && workflowToolAliases(grant).some(allowed))) return false;
            servers.add(name);
            return true;
        });
        return { ...selection, ...(source?.source === "static" ? { sourceRef: undefined } : {}), tools: selectedTools, mcpServers: selectedServers };
    }).filter(selection => selection.tools.length || selection.mcpServers.length);
}

export interface WorkflowAgentToolOffer {
    offered: string[];
    initialRequiredTool?: string;
    delegated: JsonObject;
    /** The caller has no worker catalog, so an absent default cannot be treated as a positive miss. */
    unchecked?: boolean;
    /** Method discovery for these step-owned MCP servers happens only when the CLI opens. */
    uncheckedMcpServers?: string[];
}

export function workflowAgentToolOffer(node: WorkflowIRAgent, binding: WorkflowToolBinding | null, sources: CapabilitySource[],
    originalTools: readonly { name: string }[], originalMcp: Record<string, unknown>, agent: WorkflowAgentDefinition | null,
    nativeTools: readonly string[] = []): WorkflowAgentToolOffer {
    const identity = agent ? { name: agent.name, namespace: agent.namespace, packageId: agent.packageId,
        packageScope: agent.packageScope } : null;
    const candidates = binding?.agentStepTools === "selections"
        ? workflowAgentSelections(binding, sources, originalTools, originalMcp, identity, node.tools) : [];
    const selections = candidates.filter(selection => {
        const source = sources.find(item => item.id === selection.sourceId);
        if (!source || !binding || !visibleCapabilitySource(source, binding.owner)
            || (source.source !== "static" && source.revision !== binding.sourceRevisions[source.id])) return false;
        if (!selection.sourceRef || source.source === "static") return true;
        try {
            const exact = resolveCapabilitySource(sources, binding.owner, selection.sourceRef);
            return exact.ref.k === "source" && exact.source === source;
        } catch (error) {
            if (error instanceof Error && ["Invalid capability reference",
                "Capability source unavailable or inaccessible; search again",
                "Capability source changed; search again for the current revision"].includes(error.message)) return false;
            throw error;
        }
    });
    const allowed = (name: string) => !node.tools || node.tools.includes(name) || node.tools.includes(`custom:${name}`);
    const ownMcpTools = Object.entries(originalMcp).flatMap(([server, config]) => {
        if (!config || typeof config !== "object" || !("tools" in config) || !Array.isArray(config.tools)) return [];
        return config.tools.filter((name): name is string => typeof name === "string" && name !== "*")
            .map(name => `${server}-${name}`);
    });
    const passed = selections.flatMap(selection => {
        const source = sources.find(item => item.id === selection.sourceId);
        return [{ package: source?.name ?? selection.sourceId, ownership: source ? capabilityOwnership(source, binding!.owner) : "other_shared",
            tools: selection.tools, mcpServers: selection.mcpServers,
            mcpTools: (binding?.tools ?? []).filter(tool => tool.mcpServerName && selection.mcpServers.includes(tool.mcpServerName)
                && workflowToolAliases(tool).some(allowed)).map(tool => tool.name) }];
    });
    return {
        offered: [...new Set([...originalTools.map(tool => tool.name), ...nativeTools, ...ownMcpTools,
            ...passed.flatMap(source => [...source.tools, ...source.mcpTools])])].filter(allowed),
        ...(agent?.initialRequiredTool ? { initialRequiredTool: agent.initialRequiredTool } : {}),
        uncheckedMcpServers: Object.entries(originalMcp).filter(([, config]) => config && typeof config === "object"
            && (!("tools" in config) || !Array.isArray(config.tools) || config.tools.includes("*"))).map(([name]) => name),
        delegated: { state: node.id, agent: agent ? { name: agent.name, package: agent.packageName ?? null,
            owner: agent.packageOwner ? { provider: agent.packageOwner.provider, subject: agent.packageOwner.subject } : null }
            : "inline prompt", sources: passed },
    };
}
