import type { WorkflowDiagnostic, WorkflowIR } from "./compiler.js";
import { WorkflowStoreError } from "./store.js";
import { scriptToolRequirements } from "./script-analysis.js";
import type { WorkflowAgentToolOffer } from "./agent-tools.js";
export { scriptToolRequirements } from "./script-analysis.js";
import {
    admittedWorkflowToolGrant, isWorkflowControlTool, isWorkflowLiveSessionTool, workflowLiveSessionToolMessage,
    type WorkflowToolBinding,
} from "./tool-policy.js";

export function scriptToolWarnings(source: string, path: string): WorkflowDiagnostic[] {
    const requirements = scriptToolRequirements(source);
    const warnings: WorkflowDiagnostic[] = [];
    if (requirements.dynamic) warnings.push({
        severity: "warning", code: "WORKFLOW_TOOLS_DYNAMIC", path,
        message: "This script uses a dynamic callTool name. Save and Start cannot check which tool it will use; it must be in the captured grant when the call runs.",
    });
    if (requirements.unchecked) warnings.push({
        severity: "warning", code: "WORKFLOW_TOOLS_UNCHECKED", path,
        message: "The script's syntax could not be analyzed for tool names. Save and Start cannot check its tool requirements; run-time tool checks still apply.",
    });
    return warnings;
}

export function workflowToolDiagnostics(ir: Pick<WorkflowIR, "nodes"> | null | undefined,
    binding: WorkflowToolBinding | null, grantKnown = true, agentOffers: Record<string, WorkflowAgentToolOffer> = {}): WorkflowDiagnostic[] {
    const diagnostics: WorkflowDiagnostic[] = [];
    for (const node of Object.values(ir?.nodes ?? {})) {
        if (node.type === "agent") {
            const offer = agentOffers[node.id];
            const required = [...new Set([...(node.requiredTools ?? []), ...(offer?.initialRequiredTool ? [offer.initialRequiredTool] : [])])];
            for (const tool of required) {
                const insideCeiling = !node.tools || node.tools.includes(tool) || node.tools.includes(`custom:${tool}`);
                if (insideCeiling && ((!grantKnown && !offer) || (!offer?.offered.includes(tool)
                    && (offer?.unchecked || offer?.uncheckedMcpServers?.some(server => tool.startsWith(`${server}-`)))))) {
                    diagnostics.push({ severity: "warning", code: "WORKFLOW_TOOLS_UNCHECKED", path: `states.${node.id}.requiredTools`,
                        message: `Start will check whether this step is offered required tool '${tool}'.` });
                } else if (!offer?.offered.includes(tool) || !insideCeiling) {
                    diagnostics.push({ severity: "warning", code: "WORKFLOW_TOOL_NOT_GRANTED", path: `states.${node.id}.requiredTools`,
                        message: `Required tool '${tool}' is not offered to this step inside its tools ceiling. Activate its package in the session that starts the Workflow, or change the ceiling.` });
                }
            }
            continue;
        }
        if (node.type !== "script") continue;
        let path = `states.${node.id}`;
        let scoped = node.id;
        const seen = new Set<string>();
        for (;;) {
            if (seen.has(scoped)) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "A script's Workflow scope is cyclic.");
            seen.add(scoped);
            const parent = Object.values(ir?.nodes ?? {}).find(candidate => candidate.type === "parallel" && candidate.body.states.includes(scoped));
            if (!parent || parent.type !== "parallel") break;
            const branch = parent.branches?.find(item => item.states.includes(scoped));
            path = `states.${parent.id}.${branch ? `branches.${branch.name}` : "body"}.${path}`;
            scoped = parent.id;
        }
        path += ".source";
        const requirements = scriptToolRequirements(node.source);
        diagnostics.push(...scriptToolWarnings(node.source, path));
        for (const tool of requirements.tools) {
            if (isWorkflowLiveSessionTool(tool)) {
                diagnostics.push({ severity: "warning", code: "WORKFLOW_TOOL_LIVE_SESSION", path, message: workflowLiveSessionToolMessage(tool) });
            } else if (isWorkflowControlTool(tool)) {
                diagnostics.push({ severity: "warning", code: "WORKFLOW_TOOL_NOT_GRANTED", path, message: `Workflow control tool '${tool}' cannot run in a script.` });
            } else if (grantKnown) {
                try { admittedWorkflowToolGrant(tool, binding?.tools ?? [], binding?.excludedTools ?? []); }
                catch {
                    diagnostics.push({ severity: "warning", code: "WORKFLOW_TOOL_NOT_GRANTED", path,
                        message: binding ? `Tool '${tool}' is not uniquely available in this session's captured tool grant. Attach or enable it before Start.`
                            : `Tool '${tool}' has no captured tool grant on this start. Ask the session's agent to start it with workflow_definition after enabling the tool.` });
                }
            }
        }
        if (!grantKnown && requirements.tools.length) diagnostics.push({
            severity: "warning", code: "WORKFLOW_TOOLS_UNCHECKED", path,
            message: "This session's tool grant could not be checked at Save. Start will check its captured grant before creating a Workflow.",
        });
    }
    return diagnostics;
}

/** Check new admissions and resumed claims, never replace the grant of an already admitted Workflow. */
export function requireWorkflowToolRequirements(ir: Pick<WorkflowIR, "nodes"> | null | undefined,
    binding: WorkflowToolBinding | null, name: string, agentOffers: Record<string, WorkflowAgentToolOffer> = {}): WorkflowDiagnostic[] {
    const diagnostics = workflowToolDiagnostics(ir, binding, true, agentOffers);
    const missing = diagnostics.filter(item => ["WORKFLOW_TOOL_NOT_GRANTED", "WORKFLOW_TOOL_LIVE_SESSION"].includes(item.code));
    if (missing.length) {
        throw new WorkflowStoreError("WORKFLOW_TOOLS_UNAVAILABLE", `${name} was not started: `
            + missing.slice(0, 10).map(item => `${item.path}: ${item.message}`).join(" ")
            + (missing.length > 10 ? ` And ${missing.length - 10} more tool requirements.` : "")
            + " Nothing was started.", { diagnostics: missing.map(item => ({ code: item.code, path: item.path, message: item.message })) });
    }
    return diagnostics;
}
