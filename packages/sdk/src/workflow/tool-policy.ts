import { createHash } from "node:crypto";
import type { CopilotSession, PermissionRequestResult } from "@github/copilot-sdk";
import type { CapabilityState } from "../capability-catalog.js";
import type { SerializableSessionConfig, SessionOwnerInfo } from "../types.js";
import { sessionApprovalForPermissionRequest } from "../permissions.js";
import type { CompiledWorkflow } from "./compiler.js";
import { WORKFLOW_CANVAS_SLOT } from "./canvas.js";

/**
 * The tool rule for workflow scripts: the tools of the parent agent, captured
 * from its live Copilot CLI session when it called spawn_workflow, minus the
 * excluded list below. Design after Affan Dar's parent-native tool executor.
 */
export const WORKFLOW_TOOL_POLICY = "parent-tools-v1" as const;
export type WorkflowToolMetadata = NonNullable<Awaited<ReturnType<CopilotSession["rpc"]["tools"]["getCurrentMetadata"]>>["tools"]>[number];

export interface WorkflowToolGrant {
    name: string;
    namespacedName?: string;
    mcpServerName?: string;
    mcpToolName?: string;
    /** The input schema's hash at capture. Recorded only: a changed schema does not refuse the call. */
    schemaHash: string;
}

/**
 * Created by the worker from the parent's live session. Never accepted from
 * YAML, a tool argument or a public creation payload.
 */
export interface WorkflowToolBinding {
    policy: typeof WORKFLOW_TOOL_POLICY;
    parentSessionId: string;
    owner: SessionOwnerInfo;
    /** The parent's effective session config; the per-state tool session is configured from it. */
    config: SerializableSessionConfig;
    /** The parent's capability selections; a selection removed later revokes its tools. */
    capabilities: CapabilityState;
    tools: WorkflowToolGrant[];
    /** The parent's own excluded CLI tools (deployment and session config). */
    excludedTools: string[];
    /** Recorded only: tool sources and their revisions at capture. A new revision does not refuse a call. */
    sourceRevisions?: Record<string, string>;
    /** Recorded only: the parent's bound agent definition at capture. */
    boundAgentFingerprint?: string;
    capturedAt?: string;
}

/** A refusal a script sees as the call's error; the message starts with the code. */
export class WorkflowToolError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(`${code}: ${message}`);
        this.name = "WorkflowToolError";
        this.code = code;
    }
}

export function readWorkflowToolBinding(value: unknown): WorkflowToolBinding | null {
    if (value === undefined || value === null) return null;
    const v = value as Record<string, any>;
    if (typeof value !== "object" || v.policy !== WORKFLOW_TOOL_POLICY
        || typeof v.parentSessionId !== "string"
        || !v.owner || typeof v.owner !== "object"
        || typeof v.owner.provider !== "string" || typeof v.owner.subject !== "string"
        || !v.config || typeof v.config !== "object"
        || !v.capabilities || typeof v.capabilities !== "object" || !Array.isArray(v.capabilities.selections)
        || !Array.isArray(v.tools)
        || !v.tools.every((tool: any) => tool && typeof tool.name === "string" && typeof tool.schemaHash === "string")
        || !Array.isArray(v.excludedTools)) {
        throw new Error("Invalid saved workflow tool binding.");
    }
    return value as WorkflowToolBinding;
}

/**
 * The excluded list, by group. A script has no conversation and no turn,
 * so it cannot use the tools that act on one; and it must not change what
 * its parent may do.
 */
export const WORKFLOW_EXCLUDED_TOOL_GROUPS: Readonly<Record<string, { reason: string; tools: readonly string[] }>> = {
    scheduling: {
        reason: "a script cannot wait or schedule wake-ups; use a workflow wait state",
        tools: ["wait", "wait_on_worker", "cron", "cron_at", "schedule", "manage_schedule"],
    },
    delegation: {
        reason: "a script cannot start or manage agents or workflows",
        tools: [
            "task", "read_agent", "write_agent", "spawn_agent", "spawn_workflow",
            "create_agent_session", "create_session", "create_workflow_session",
            "message_agent", "message_agent_session", "manage_agent_session",
            "complete_agent", "cancel_agent", "delete_agent", "stop_agent_turn", "wait_for_agents",
            "read_workflow_result",
        ],
    },
    conversation: {
        reason: "a script has no conversation to ask in or report to",
        tools: ["ask_user", "report_cycle", "task_complete", "send_message", "send_and_wait"],
    },
    lifecycle: {
        reason: "a script cannot stop, restart, fork or clean up sessions",
        tools: [
            "stop_session", "delete_session", "restart_session", "fork_session",
            "regenerate_context", "regenerate_agent",
            "force_terminate_session", "cleanup_session", "prune_orchestrations",
        ],
    },
    capabilities: {
        reason: "a script cannot change models, packages, agents, folders or deployment settings",
        tools: [
            "set_session_model", "use_package", "load_agent", "set_session_workspace",
            "run_factory", "factories_manage", "manage_system_session_model", "manage_embedder",
        ],
    },
    sampling: {
        reason: "a script never asks a model for anything",
        tools: ["execute_sampling", "mcp_sampling"],
    },
    context: {
        reason: "a script has no model context to report on",
        tools: ["context_health"],
    },
};

const EXCLUDED = new Map<string, string>();
for (const [group, { tools }] of Object.entries(WORKFLOW_EXCLUDED_TOOL_GROUPS)) {
    for (const tool of tools) EXCLUDED.set(tool, group);
}
/** factory_*, schedule_* and session_factory_* / session_schedule_* tools change deployment state. */
const EXCLUDED_PATTERN = /^(?:session[._])?(?:factory|schedule)[._]/;

/** The excluded group of a tool name, matching its last `/` or `.` segment too. Null when allowed. */
export function workflowExcludedGroup(name: string): string | null {
    const leaf = name.split(/[/.]/).pop() ?? name;
    const group = EXCLUDED.get(name) ?? EXCLUDED.get(leaf);
    if (group) return group;
    return EXCLUDED_PATTERN.test(leaf) ? "capabilities" : null;
}

export function isWorkflowControlTool(name: string): boolean {
    return workflowExcludedGroup(name) !== null;
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

type ToolIdentity = Pick<WorkflowToolGrant, "name" | "namespacedName" | "mcpServerName" | "mcpToolName">;

/** The names a script may call a tool by: its CLI name, its namespaced name, and `<server>/<tool>` for MCP. */
export function workflowToolAliases(tool: ToolIdentity): string[] {
    return [...new Set([
        tool.name,
        ...(tool.namespacedName ? [tool.namespacedName] : []),
        ...(tool.mcpServerName && tool.mcpToolName ? [`${tool.mcpServerName}/${tool.mcpToolName}`] : []),
    ])];
}

function excludedGroupOf(tool: ToolIdentity): string | null {
    for (const alias of workflowToolAliases(tool)) {
        const group = workflowExcludedGroup(alias);
        if (group) return group;
    }
    return tool.mcpToolName ? workflowExcludedGroup(tool.mcpToolName) : null;
}

export function allowedWorkflowTool(tool: ToolIdentity): boolean {
    return excludedGroupOf(tool) === null;
}

function isExcluded(tool: ToolIdentity, exclusions: readonly string[]): boolean {
    return workflowToolAliases(tool).some(name => exclusions.includes(name));
}

/** tools(workflow) = tools(parent) − excluded list − the parent's own excluded tools. */
export function captureWorkflowTools(tools: WorkflowToolMetadata[], exclusions: readonly string[] = []): WorkflowToolGrant[] {
    return tools.filter(tool => allowedWorkflowTool(tool) && !isExcluded(tool, exclusions)).map(workflowToolGrant);
}

/** The Copilot CLI shell tools: bash on Linux and macOS, powershell on Windows. */
export const WORKFLOW_SHELL_TOOLS: readonly string[] = ["bash", "powershell"];

/** Whether the captured tools include a CLI shell (not an MCP tool that happens to share the name). */
export function workflowToolsIncludeShell(tools: readonly ToolIdentity[]): boolean {
    return tools.some(tool => !tool.mcpServerName && WORKFLOW_SHELL_TOOLS.includes(tool.name));
}

export const WORKFLOW_RUNTIME_REQUIRES_SHELL_MESSAGE =
    "Python and PowerShell scripts need the parent agent to have a shell tool (bash or powershell); use runtime: node.";

/**
 * Python and PowerShell scripts run as unrestricted processes on the
 * worker, which is what a shell tool gives the parent already. Without a
 * shell they are refused; node scripts always run under Node's permission model.
 */
export function workflowRuntimeRefusal(workflow: CompiledWorkflow, tools: readonly ToolIdentity[]): string | null {
    if (workflowToolsIncludeShell(tools)) return null;
    const states = Object.values(workflow.states)
        .filter(state => state.type === "script" && state.runtime !== "node")
        .map(state => `'${state.id}' (${(state as { runtime: string }).runtime})`);
    return states.length ? `${WORKFLOW_RUNTIME_REQUIRES_SHELL_MESSAGE} States: ${states.join(", ")}.` : null;
}

/**
 * Resolve a script's tool name against the captured grants and the tools
 * offered now. The call is refused only when the tool is excluded, was not
 * the parent's, or is no longer offered; a changed schema or a new package
 * revision runs against the current version.
 */
export function resolveWorkflowTool(
    name: string,
    grants: WorkflowToolGrant[],
    offered: WorkflowToolMetadata[],
    exclusions: readonly string[] = [],
): WorkflowToolMetadata {
    const group = workflowExcludedGroup(name);
    if (group) {
        throw new WorkflowToolError("WORKFLOW_TOOL_EXCLUDED",
            `Tool '${name}' is excluded from workflow scripts: ${WORKFLOW_EXCLUDED_TOOL_GROUPS[group]?.reason ?? group}.`);
    }
    const named = grants.filter(grant => workflowToolAliases(grant).includes(name));
    if (named.some(grant => excludedGroupOf(grant) !== null)) {
        throw new WorkflowToolError("WORKFLOW_TOOL_EXCLUDED", `Tool '${name}' is excluded from workflow scripts.`);
    }
    const admitted = named.filter(grant => !isExcluded(grant, exclusions));
    if (admitted.length === 0) {
        throw new WorkflowToolError("WORKFLOW_TOOL_NOT_GRANTED",
            `Tool '${name}' was not among the parent agent's tools when it started this workflow.`);
    }
    if (admitted.length > 1) {
        throw new WorkflowToolError("WORKFLOW_TOOL_AMBIGUOUS",
            `Tool name '${name}' matches ${admitted.length} tools; call it by its full name (for MCP: <server>/<tool>).`);
    }
    const grant = admitted[0];
    const matches = offered.filter(tool => tool.name === grant.name
        && (tool.mcpServerName ?? undefined) === grant.mcpServerName
        && (tool.mcpToolName ?? undefined) === grant.mcpToolName);
    if (matches.length !== 1) {
        throw new WorkflowToolError("WORKFLOW_TOOL_UNAVAILABLE",
            `Tool '${name}' is no longer available to the parent agent.`);
    }
    return matches[0];
}

/** Arguments a script may not pass even to a tool it was given. */
/** Canvas tools that change a canvas, and for canvas_kv the operations that write. */
const CANVAS_WRITE_TOOLS: readonly string[] = ["draw_canvas", "update_canvas", "canvas_kv"];

function writesOwnLiveCanvas(name: string, args: Record<string, unknown>, workflowSessionId: string | undefined): boolean {
    if (!CANVAS_WRITE_TOOLS.includes(name)) return false;
    if (name === "canvas_kv" && args.op !== "put" && args.op !== "delete") return false;
    const target = typeof args.session_id === "string" ? args.session_id.trim().replace(/^session-/, "") : "";
    if (target && target !== workflowSessionId) return false;
    const slot = args.slot === undefined || args.slot === null ? 1 : Number(args.slot);
    return slot === WORKFLOW_CANVAS_SLOT;
}

export function validateWorkflowToolArguments(name: string, args: Record<string, unknown>, context: { workflowSessionId?: string } = {}): void {
    const refuse = (message: string) => { throw new WorkflowToolError("WORKFLOW_TOOL_ARGUMENTS_REFUSED", message); };
    if (writesOwnLiveCanvas(name, args, context.workflowSessionId)) {
        refuse(`Canvas slot ${WORKFLOW_CANVAS_SLOT} shows this workflow's live diagram; use slots 2-5, or the parent's canvas with session_id.`);
    }
    if (WORKFLOW_SHELL_TOOLS.includes(name) && args.detach === true) {
        refuse("A workflow shell must stay attached to the state that started it (detach: true is refused).");
    }
    if (name === "load_skill" && (args.path !== undefined || args.unload !== undefined)) {
        refuse("A workflow script cannot load or unload skills by path.");
    }
    if (name === "send_session_message" && args.expects_response === true) {
        refuse("A workflow session cannot receive replies (expects_response: true is refused).");
    }
}

/** Tool execution can ask for permissions, but never for model inference. */
export function workflowToolPermission(request: Parameters<typeof sessionApprovalForPermissionRequest>[0]): PermissionRequestResult {
    if (request?.kind === "mcp-sampling" || (request?.kind !== "url" && !sessionApprovalForPermissionRequest(request))) {
        return { kind: "reject", feedback: "Workflow tools cannot request model sampling or unknown permissions." };
    }
    return { kind: "approve-once" };
}
