import type { CapabilitySelection, CapabilitySource } from "../capability-catalog.js";
import { mcpAllowlistAdmits, type McpAllowlistAgent } from "../mcp-loader.js";
import { isWorkflowControlTool, isWorkflowLiveSessionTool, type WorkflowToolBinding } from "./tool-policy.js";

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
            if (!binding.tools.some(grant => grant.mcpServerName === name && allowed(grant.namespacedName ?? grant.name))) return false;
            servers.add(name);
            return true;
        });
        return { ...selection, tools: selectedTools, mcpServers: selectedServers };
    }).filter(selection => selection.tools.length || selection.mcpServers.length);
}
