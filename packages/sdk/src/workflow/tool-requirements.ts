import type { WorkflowDiagnostic, WorkflowIR } from "./compiler.js";
import { WorkflowStoreError } from "./store.js";
import { scriptToolRequirements } from "./script-analysis.js";
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
    binding: WorkflowToolBinding | null, grantKnown = true): WorkflowDiagnostic[] {
    const diagnostics: WorkflowDiagnostic[] = [];
    for (const node of Object.values(ir?.nodes ?? {})) {
        if (node.type !== "script") continue;
        const path = `states.${node.id}.source`;
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
                        message: `Tool '${tool}' is not uniquely available in this session's captured tool grant. Attach or enable it before Start.` });
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
    binding: WorkflowToolBinding | null, name: string): WorkflowDiagnostic[] {
    const diagnostics = workflowToolDiagnostics(ir, binding);
    const missing = diagnostics.filter(item => ["WORKFLOW_TOOL_NOT_GRANTED", "WORKFLOW_TOOL_LIVE_SESSION"].includes(item.code));
    if (missing.length) {
        throw new WorkflowStoreError("WORKFLOW_TOOLS_UNAVAILABLE", `${name} was not started: `
            + missing.slice(0, 10).map(item => `${item.path}: ${item.message}`).join(" ")
            + (missing.length > 10 ? ` And ${missing.length - 10} more tool requirements.` : "")
            + " Nothing was started.", { diagnostics: missing.map(item => ({ code: item.code, path: item.path, message: item.message })) });
    }
    return diagnostics;
}
