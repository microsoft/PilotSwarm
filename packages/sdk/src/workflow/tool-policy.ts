import { createHash } from "node:crypto";
import type { CopilotSession, PermissionRequestResult } from "@github/copilot-sdk";
import type { CapabilityState } from "../capability-catalog.js";
import type { SerializableSessionConfig, SessionOwnerInfo } from "../types.js";
import { sessionApprovalForPermissionRequest } from "../permissions.js";

export const WORKFLOW_TOOL_POLICY = "node-parent-tools-v1" as const;
export type WorkflowToolMetadata = NonNullable<Awaited<ReturnType<CopilotSession["rpc"]["tools"]["getCurrentMetadata"]>>["tools"]>[number];

export interface WorkflowToolGrant {
    name: string;
    namespacedName?: string;
    mcpServerName?: string;
    mcpToolName?: string;
    schemaHash: string;
}

/** Host-created grant. Never accepted from YAML or a public creation payload. */
export interface WorkflowToolBinding {
    policy: typeof WORKFLOW_TOOL_POLICY;
    parentSessionId: string;
    owner: SessionOwnerInfo;
    config: SerializableSessionConfig;
    capabilities: CapabilityState;
    tools: WorkflowToolGrant[];
    sourceRevisions: Record<string, string>;
    excludedTools: string[];
    boundAgentFingerprint: string;
}

export function readWorkflowToolBinding(value: unknown): WorkflowToolBinding | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "object" || !("policy" in value) || value.policy !== WORKFLOW_TOOL_POLICY
        || !("parentSessionId" in value) || typeof value.parentSessionId !== "string"
        || !("owner" in value) || !value.owner || typeof value.owner !== "object"
        || !("provider" in value.owner) || typeof value.owner.provider !== "string"
        || !("subject" in value.owner) || typeof value.owner.subject !== "string"
        || !("config" in value) || !value.config || typeof value.config !== "object"
        || !("capabilities" in value) || !value.capabilities || typeof value.capabilities !== "object"
        || !("selections" in value.capabilities) || !Array.isArray(value.capabilities.selections)
        || !("tools" in value) || !Array.isArray(value.tools)
        || !value.tools.every(tool => tool && typeof tool.name === "string" && typeof tool.schemaHash === "string")
        || !("sourceRevisions" in value) || !value.sourceRevisions || typeof value.sourceRevisions !== "object"
        || !("excludedTools" in value) || !Array.isArray(value.excludedTools)
        || !("boundAgentFingerprint" in value) || typeof value.boundAgentFingerprint !== "string") {
        throw new Error("Invalid persisted workflow tool binding.");
    }
    return value as WorkflowToolBinding;
}

const controls = new Set([
    "wait", "wait_on_worker", "cron", "cron_at", "schedule", "manage_schedule",
    "task", "read_agent", "write_agent", "spawn_agent", "spawn_workflow",
    "create_agent_session", "create_session", "create_workflow_session",
    "message_agent", "message_agent_session", "manage_agent_session",
    "complete_agent", "cancel_agent", "delete_agent", "stop_agent_turn", "wait_for_agents",
    "send_message", "send_and_wait", "stop_session", "delete_session", "restart_session", "fork_session",
    "ask_user", "report_cycle", "task_complete", "set_session_model", "regenerate_context",
    "regenerate_agent", "use_package", "load_agent", "set_session_workspace",
    "run_factory", "factories_manage", "execute_sampling", "mcp_sampling",
    "manage_system_session_model", "force_terminate_session", "cleanup_session", "prune_orchestrations",
    "manage_embedder", "context_health",
]);

export function isWorkflowControlTool(name: string): boolean {
    const leaf = name.split(/[/.]/).pop() ?? name;
    return controls.has(name) || controls.has(leaf)
        || /^(?:session[._])?(?:factory|schedule)[._]/.test(leaf);
}

function canonical(value: unknown): string {
    if (value === undefined) return "null";
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
        return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

export function workflowToolGrant(tool: WorkflowToolMetadata): WorkflowToolGrant {
    return {
        name: tool.name,
        ...(tool.namespacedName ? { namespacedName: tool.namespacedName } : {}),
        ...(tool.mcpServerName ? { mcpServerName: tool.mcpServerName } : {}),
        ...(tool.mcpToolName ? { mcpToolName: tool.mcpToolName } : {}),
        schemaHash: createHash("sha256").update(canonical(tool.input_schema ?? {})).digest("hex"),
    };
}

export function workflowToolAliases(tool: Pick<WorkflowToolGrant, "name" | "namespacedName" | "mcpServerName" | "mcpToolName">): string[] {
    return [...new Set([
        tool.name,
        ...(tool.namespacedName ? [tool.namespacedName] : []),
        ...(tool.mcpServerName && tool.mcpToolName ? [`${tool.mcpServerName}/${tool.mcpToolName}`] : []),
    ])];
}

export function allowedWorkflowTool(tool: Pick<WorkflowToolGrant, "name" | "namespacedName" | "mcpServerName" | "mcpToolName">): boolean {
    return !workflowToolAliases(tool).some(isWorkflowControlTool)
        && !(tool.mcpToolName && isWorkflowControlTool(tool.mcpToolName));
}

function isExcluded(tool: WorkflowToolGrant, exclusions: readonly string[]): boolean {
    return workflowToolAliases(tool).some(name => exclusions.includes(name));
}

export function captureWorkflowTools(tools: WorkflowToolMetadata[], exclusions: readonly string[] = []): WorkflowToolGrant[] {
    return tools.filter(tool => allowedWorkflowTool(tool) && !isExcluded(workflowToolGrant(tool), exclusions)).map(workflowToolGrant);
}

export function resolveWorkflowTool(
    name: string,
    grants: WorkflowToolGrant[],
    offered: WorkflowToolMetadata[],
    exclusions: readonly string[] = [],
): WorkflowToolMetadata {
    if (isWorkflowControlTool(name)) throw new Error(`Workflow control tool '${name}' is not permitted.`);
    const admitted = grants.filter(grant => allowedWorkflowTool(grant) && !isExcluded(grant, exclusions) && workflowToolAliases(grant).includes(name));
    if (admitted.length !== 1) throw new Error(`Tool '${name}' is not uniquely admitted for this workflow.`);
    const grant = admitted[0];
    const matches = offered.filter(tool => tool.name === grant.name
        && tool.namespacedName === grant.namespacedName
        && tool.mcpServerName === grant.mcpServerName
        && tool.mcpToolName === grant.mcpToolName);
    if (matches.length !== 1 || workflowToolGrant(matches[0]).schemaHash !== grant.schemaHash) {
        throw new Error(`Tool '${name}' is unavailable or its contract changed since workflow admission.`);
    }
    return matches[0];
}

export function validateWorkflowToolArguments(name: string, args: Record<string, unknown>): void {
    if (["bash", "powershell"].includes(name) && args.detach === true) {
        throw new Error("Workflow shells must remain attached to the state that owns them.");
    }
    if (name === "load_skill" && (args.path !== undefined || args.unload !== undefined)) {
        throw new Error("Workflow scripts cannot change loaded capabilities.");
    }

    if (name === "send_session_message" && args.expects_response === true) {
        throw new Error("Workflow sessions cannot receive conversational replies.");
    }
}

/** Tool execution can request permissions, but must never request model inference. */
export function workflowToolPermission(request: Parameters<typeof sessionApprovalForPermissionRequest>[0]): PermissionRequestResult {
    if (request?.kind === "mcp-sampling" || (request?.kind !== "url" && !sessionApprovalForPermissionRequest(request))) {
        return { kind: "reject", feedback: "Workflow tools cannot request model sampling or unknown permissions." };
    }
    return { kind: "approve-once" };
}
