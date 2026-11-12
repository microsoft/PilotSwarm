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

/**
 * The refusal when the calling session has no live tool context on this worker to hand to a workflow (no warm session, or
 * none recorded for it). spawn_workflow answers it with this code and these words, which an agent can relay as they are.
 */
export const WORKFLOW_PARENT_CONTEXT_UNAVAILABLE = "WORKFLOW_PARENT_CONTEXT_UNAVAILABLE" as const;
export const WORKFLOW_PARENT_CONTEXT_UNAVAILABLE_MESSAGE = "The workflow was not created: this session's tools were not ready to hand to a "
    + "workflow. Nothing was started. Call spawn_workflow again; if it is refused again, tell the user.";

/** The coded error captureWorkflowToolBinding throws when the parent's tool context is not available. */
export function workflowParentContextUnavailable(): Error & { code: typeof WORKFLOW_PARENT_CONTEXT_UNAVAILABLE } {
    const coded: { code: typeof WORKFLOW_PARENT_CONTEXT_UNAVAILABLE } = { code: WORKFLOW_PARENT_CONTEXT_UNAVAILABLE };
    return Object.assign(new Error(WORKFLOW_PARENT_CONTEXT_UNAVAILABLE_MESSAGE), coded);
}

/** Whether an error is that refusal. */
export function isWorkflowParentContextUnavailable(error: unknown): boolean {
    return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === WORKFLOW_PARENT_CONTEXT_UNAVAILABLE;
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
    "task", "read_agent", "write_agent", "spawn_agent", "spawn_workflow", "update_workflow", "read_workflow", "send_workflow_input",
    "create_agent_session", "create_session", "create_workflow_session",
    "message_agent", "message_agent_session", "manage_agent_session",
    "complete_agent", "cancel_agent", "delete_agent", "stop_agent_turn", "wait_for_agents",
    "send_message", "send_and_wait", "stop_session", "delete_session", "restart_session", "fork_session",
    "ask_user", "report_cycle", "task_complete", "set_session_model", "regenerate_context",
    "regenerate_agent", "use_package", "enable_workflows", "load_agent", "set_session_workspace",
    "run_factory", "factories_manage", "execute_sampling", "mcp_sampling",
    "manage_system_session_model", "force_terminate_session", "cleanup_session", "prune_orchestrations",
    "manage_embedder", "context_health",
    // Review PRW-T1: a Workflow's tool and script states never edit definitions, answer a Workflow's request or complete a
    // Workflow agent state through the parent's grant.
    "workflow_definition", "respond_session_request", "complete_workflow_node",
    // A Workflow messages sessions through its own send and request states, never as its parent.
    "send_session_message", "reply_session_message",
    // Review DS2-002: the same controls under the names the bundled PilotSwarm MCP server (packages/app/mcp) and the
    // SDK's management tools give them. A session's lifecycle, conversation and turn: an answer, an abort, a regeneration,
    // a turn's stop or steer, a completion, queued-message cancels, custom events, workspace retries, a model switch, a raw
    // orchestration command, a system session's restart.
    "send_answer", "abort_session", "regenerate_session", "stop_turn", "steer_session_turn", "complete_session",
    "cancel_pending_messages", "send_session_event", "retry_session_workspace", "switch_model", "send_command",
    "restart_system_session",
    // Who may see or change a session or a package.
    "set_session_visibility", "grant_session_share", "revoke_session_share", "grant_agent_package_editor",
    "revoke_agent_package_editor",
    // What the deployment offers: model providers and defaults, agent packages, feature flags, notices to every user.
    "manage_provider", "set_provider_limit", "set_provider_allowance", "provider_hold", "set_provider_default",
    "set_model_default", "set_provider_system_use", "set_system_model_default", "adopt_legacy_system_github_key",
    "push_agent_package", "publish_agent_package", "import_agent_package", "republish_agent_package_version",
    "pin_agent_package_version", "set_agent_package_enabled", "set_agent_package_scope", "delete_agent_package",
    "set_cluster_feature_flag", "reset_cluster_feature_flag", "set_user_feature_flag", "unset_user_feature_flag",
    "set_my_feature_flag", "unset_my_feature_flag", "create_motd", "delete_motd",
    // System maintenance.
    "start_embedder", "stop_embedder", "facts_admin", "scale_workers", "compact_database", "purge_old_events",
    "purge_orphaned_blobs", "facts_force_purge", "facts_purge_tombstones",
]);

export function isWorkflowControlTool(name: string): boolean {
    const leaf = name.split(/[/.]/).pop() ?? name;
    return controls.has(name) || controls.has(leaf)
        || /^(?:session[._])?(?:factory|schedule)[._]/.test(leaf);
}

const liveSessionCanvasTools = new Set([
    "draw_canvas", "update_canvas", "show_canvas", "read_canvas", "canvas_kv", "publish_canvas_app", "find_canvas_app",
]);

/** These handlers need the live agent session's bridge, which a script's delegated tool session does not have. */
export function isWorkflowLiveSessionTool(name: string): boolean {
    return liveSessionCanvasTools.has(name) || liveSessionCanvasTools.has(name.split(/[/.]/).pop() ?? name);
}

export function workflowLiveSessionToolMessage(name: string): string {
    return `Canvas tool '${name}' needs a live agent session and cannot run in a Workflow script. `
        + "Use an agent step, or send the update to the parent session.";
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
    const unavailable = (name: string) => isWorkflowControlTool(name) || isWorkflowLiveSessionTool(name);
    return !workflowToolAliases(tool).some(unavailable) && !(tool.mcpToolName && unavailable(tool.mcpToolName));
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
    if (isWorkflowLiveSessionTool(name)) throw new Error(workflowLiveSessionToolMessage(name));
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

/**
 * The grant a workflow script's call of `name` uses, judged by the grants alone, for a call that reaches no live tool
 * catalog (a workflow test run's intercepted call): a workflow control tool is never admitted, and the name
 * must match exactly one admitted grant, as resolveWorkflowTool decides before it reads the catalog.
 */
export function admittedWorkflowToolGrant(name: string, grants: WorkflowToolGrant[], exclusions: readonly string[] = []): WorkflowToolGrant {
    if (isWorkflowControlTool(name)) throw new Error(`Workflow control tool '${name}' is not permitted.`);
    if (isWorkflowLiveSessionTool(name)) throw new Error(workflowLiveSessionToolMessage(name));
    const admitted = grants.filter(grant => allowedWorkflowTool(grant) && !isExcluded(grant, exclusions) && workflowToolAliases(grant).includes(name));
    if (admitted.length !== 1) throw new Error(`Tool '${name}' is not uniquely admitted for this workflow.`);
    return admitted[0];
}

/** Arguments a script may not pass even to a tool it was given. */
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
