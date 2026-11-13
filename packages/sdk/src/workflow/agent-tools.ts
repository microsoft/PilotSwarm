import { capabilityOwnership, capabilityRef, resolveCapabilitySource, visibleCapabilitySource, type CapabilitySelection, type CapabilitySource } from "../capability-catalog.js";
import type { WorkflowIRAgent } from "./compiler.js";
import type { WorkflowAgentDefinition } from "./agent-host.js";
import type { JsonObject } from "./json.js";
import { mcpAllowlistAdmits, type McpAllowlistAgent } from "../mcp-loader.js";
import { isWorkflowControlTool, isWorkflowLiveSessionTool, workflowToolAliases, type WorkflowToolBinding,
    type WorkflowToolGrant, type WorkflowAgentStepBinding } from "./tool-policy.js";
import { selectCapabilityToolGrant, type CapabilityToolGrant, type HeldCapabilityTool } from "../tool-grant.js";

export function workflowAgentGrantedToolNames(binding: WorkflowToolBinding | null, sources: CapabilitySource[],
    grant: CapabilityToolGrant): Set<string> {
    const held: HeldCapabilityTool[] = [];
    if (binding?.agentStepTools === "selections") {
        for (const selection of binding.capabilities.selections) {
            const source = sources.find(candidate => candidate.id === selection.sourceId);
            const packageName = source?.name ?? binding.packagePins?.[selection.sourceId]?.package;
            for (const tool of binding.tools) {
                if ((!tool.mcpServerName && selection.tools.includes(tool.name))
                    || (tool.mcpServerName && selection.mcpServers.includes(tool.mcpServerName))) {
                    held.push({ name: tool.name, ...(packageName ? { package: packageName } : {}),
                        ...(tool.mcpServerName ? { mcp: tool.mcpServerName } : {}) });
                }
            }
        }
        for (const tool of binding.tools) {
            const sourceId = binding.toolSources?.[tool.name];
            const source = sourceId ? sources.find(candidate => candidate.id === sourceId) : undefined;
            const packageName = source?.name ?? (sourceId ? binding.packagePins?.[sourceId]?.package : undefined);
            if (sourceId && binding.sourceRevisions[sourceId] !== undefined && !held.some(candidate => candidate.name === tool.name)) {
                held.push({ name: tool.name, ...(packageName ? { package: packageName } : {}),
                    ...(tool.mcpServerName ? { mcp: tool.mcpServerName } : {}) });
            }
        }
    }
    return selectCapabilityToolGrant(grant, held);
}

/** Compose only captured parent capabilities and explicitly declared providers, before any session is created. */
export function captureWorkflowAgentStepBinding(node: WorkflowIRAgent, binding: WorkflowToolBinding, sources: CapabilitySource[],
    declared: readonly { sourceId: string; tool: WorkflowToolGrant }[], agent: McpAllowlistAgent | null = null): WorkflowAgentStepBinding {
    const granted = workflowAgentGrantedToolNames(binding, sources, node.grant ?? ("agent" in node.invoke ? "none" : "all"));
    const allowed = (tool: WorkflowToolGrant) => !isWorkflowControlTool(tool.name) && !isWorkflowLiveSessionTool(tool.name)
        && (!node.tools || workflowToolAliases(tool).some(name => node.tools!.includes(name) || node.tools!.includes(`custom:${name}`)));
    const admitted = new Map<string, { sourceId: string; tool: WorkflowToolGrant }>();
    for (const tool of binding.tools) {
        if (!granted.has(tool.name) || !allowed(tool)) continue;
        const sourceId = binding.toolSources?.[tool.name]
            ?? binding.capabilities.selections.find(selection => tool.mcpServerName
                ? selection.mcpServers.includes(tool.mcpServerName) : selection.tools.includes(tool.name))?.sourceId;
        if (sourceId) admitted.set(tool.name, { sourceId, tool });
    }
    for (const item of declared) if (allowed(item.tool)) admitted.set(item.tool.name, item);
    const selections = new Map<string, CapabilitySelection>();
    const tools: WorkflowToolGrant[] = [];
    const toolSources: Record<string, string> = {};
    const sourceRevisions: Record<string, string> = {};
    for (const { sourceId, tool } of admitted.values()) {
        const source = sources.find(candidate => candidate.id === sourceId);
        if (!source || !visibleCapabilitySource(source, binding.owner)) continue;
        if (tool.mcpServerName) {
            const config = source.mcpServers[tool.mcpServerName];
            if (!config || (config.allowedAgents && !mcpAllowlistAdmits(config.allowedAgents, agent))) continue;
        }
        let selection = selections.get(sourceId);
        if (!selection) {
            selection = { sourceId, ...(source.source === "static" ? {}
                : { sourceRef: capabilityRef(source.id, source.revision, "source") }), tools: [], mcpServers: [] };
            selections.set(sourceId, selection);
        }
        const names = tool.mcpServerName ? selection.mcpServers : selection.tools;
        const name = tool.mcpServerName ?? tool.name;
        if (!names.includes(name)) names.push(name);
        tools.push(structuredClone(tool));
        toolSources[tool.name] = sourceId;
        sourceRevisions[sourceId] = source.revision;
    }
    return {
        capabilities: { revision: binding.capabilities.revision, selections: [...selections.values()] },
        tools, sourceRevisions, toolSources,
        ...(binding.packagePins ? { packagePins: Object.fromEntries(Object.entries(binding.packagePins)
            .filter(([id]) => sourceRevisions[id] !== undefined)) } : {}),
    };
}

/** Filter per export before bindCapabilities, whose ordinary-session semantics reject a whole conflicting selection. */
export function workflowAgentSelections(binding: WorkflowToolBinding, sources: CapabilitySource[], originalTools: readonly { name: string }[],
    originalMcp: Record<string, unknown>, agent: McpAllowlistAgent | null, ceiling?: readonly string[] | null,
    granted?: ReadonlySet<string>): CapabilitySelection[] {
    const tools = new Set(originalTools.map(tool => tool.name));
    const servers = new Set(Object.keys(originalMcp));
    const allowed = (name: string) => !isWorkflowControlTool(name) && !isWorkflowLiveSessionTool(name)
        && (!ceiling || ceiling.includes(name) || ceiling.includes(`custom:${name}`));
    const admitted = (tool: WorkflowToolBinding["tools"][number]) => (!granted || granted.has(tool.name))
        && workflowToolAliases(tool).some(allowed);
    const captured = structuredClone(binding.capabilities.selections);
    for (const tool of binding.tools) {
        const sourceId = binding.toolSources?.[tool.name];
        if (!sourceId || !admitted(tool)) continue;
        let selection = captured.find(candidate => candidate.sourceId === sourceId);
        if (!selection) {
            const source = sources.find(candidate => candidate.id === sourceId);
            selection = { sourceId, ...(source && source.source !== "static"
                ? { sourceRef: capabilityRef(sourceId, binding.sourceRevisions[sourceId] ?? source.revision, "source") } : {}),
                tools: [], mcpServers: [] };
            captured.push(selection);
        }
        const names = tool.mcpServerName ? selection.mcpServers : selection.tools;
        const name = tool.mcpServerName ?? tool.name;
        if (!names.includes(name)) names.push(name);
    }
    return captured.map(selection => {
        const source = sources.find(item => item.id === selection.sourceId);
        const selectedTools = selection.tools.filter(name => {
            if (tools.has(name) || !allowed(name) || !binding.tools.some(grant => grant.name === name && admitted(grant))) return false;
            tools.add(name);
            return true;
        });
        const selectedServers = selection.mcpServers.filter(name => {
            const config = source?.mcpServers[name];
            if (servers.has(name) || (config?.allowedAgents && !mcpAllowlistAdmits(config.allowedAgents, agent))) return false;
            if (!binding.tools.some(grant => grant.mcpServerName === name && admitted(grant))) return false;
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
    /** A declarative grant not currently held at Save; Start must positively check it. */
    grantRefusal?: string;
    /** Host-only state snapshot, persisted at Start, not a caller-supplied grant. */
    binding?: WorkflowAgentStepBinding;
}

export function workflowAgentToolOffer(node: WorkflowIRAgent, binding: WorkflowToolBinding | null, sources: CapabilitySource[],
    originalTools: readonly { name: string }[], originalMcp: Record<string, unknown>, agent: WorkflowAgentDefinition | null,
    nativeTools: readonly string[] = []): WorkflowAgentToolOffer {
    const identity = agent ? { name: agent.name, namespace: agent.namespace, packageId: agent.packageId,
        packageScope: agent.packageScope } : null;
    const granted = binding?.agentStepStateId ? new Set(binding.tools.map(tool => tool.name))
        : workflowAgentGrantedToolNames(binding, sources, node.grant ?? ("agent" in node.invoke ? "none" : "all"));
    const candidates = binding?.agentStepTools === "selections"
        ? workflowAgentSelections(binding, sources, originalTools, originalMcp, identity, node.tools, granted) : [];
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
                && granted.has(tool.name) && workflowToolAliases(tool).some(allowed)).map(tool => tool.name) }];
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
