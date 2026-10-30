import type { SessionCatalog } from "../cms.js";
import { compileScriptWorkflow } from "./compiler.js";
import type { ScriptToolCall } from "./executor.js";
import {
    SCRIPT_WORKFLOW_ACTIVITIES,
    type ScriptWorkflowBeginResult,
    type ScriptWorkflowFinishInput,
    type ScriptWorkflowRunNodeInput,
    type ScriptWorkflowRunNodeResult,
} from "./orchestration.js";
import { runScriptNode, type RunScriptNodeResult, type ScriptRunnerOptions } from "./runner.js";
import { parseScriptMcpToolName, ScriptMcpConnections } from "./mcp.js";
import { buildWorkflowCanvasHtml, foldWorkflowCanvasState, type WorkflowCanvasPublisher } from "./canvas.js";

/** The events a workflow writes; the canvas state is folded from them. */
export const WORKFLOW_LOG_EVENT_TYPES = [
    "workflow.started",
    "workflow.node_started",
    "workflow.node_completed",
    "workflow.node_failed",
    "workflow.node_cancelled",
    "workflow.completed",
    "workflow.failed",
    "workflow.cancelled",
];

export type ScriptToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface ScriptWorkflowActivityDeps {
    catalog: (Pick<SessionCatalog, "updateSession" | "recordEvents"> & Partial<Pick<SessionCatalog, "getSessionEvents">>) | null;
    /** Draws and updates the live execution canvas. Absent: no canvas. */
    canvas?: WorkflowCanvasPublisher | null;
    /** Whether this worker runs script workflows. A disabled worker fails them at the first step. */
    enabled: () => boolean;
    /** The tools a script in this workflow session may call, by name. */
    resolveTools: (sessionId: string) => Promise<Map<string, ScriptToolHandler>>;
    /** The MCP servers a script may call as `<server>/<tool>`. Absent: none. */
    resolveMcpServers?: (sessionId: string) => Record<string, any> | Promise<Record<string, any>>;
    /** Remove a deleted workflow session: CMS soft delete and its session facts. */
    deleteSession?: (sessionId: string) => Promise<void>;
    /** Deliver a system prompt to the parent session's message queue. */
    notifyParent: (parentSessionId: string, prompt: string, sender: { kind: "system"; display: string }) => Promise<void>;
    runnerOptions?: ScriptRunnerOptions;
    /** Replaceable for tests. */
    runNode?: typeof runScriptNode;
}

export const SCRIPT_WORKFLOWS_DISABLED_MESSAGE =
    "Script workflows are disabled on this worker. An operator enables them with PILOTSWARM_SCRIPT_WORKFLOWS=1 "
    + "(or the worker option scriptWorkflows.enabled), because scripts run as processes on the worker.";

const PREVIEW_CHARS = 1_000;

/** Lists the MCP tools a script may call. */
export const LIST_MCP_TOOLS = "list_mcp_tools";

function preview(value: unknown): string {
    let text: string;
    try { text = typeof value === "string" ? value : JSON.stringify(value) ?? "null"; }
    catch { text = String(value); }
    return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function record(
    deps: ScriptWorkflowActivityDeps,
    sessionId: string,
    eventType: string,
    data: Record<string, unknown>,
): Promise<void> {
    try {
        await deps.catalog?.recordEvents(sessionId, [{ eventType, data }]);
    } catch {
        // Execution telemetry is best-effort; it never fails a workflow.
    }
}

/** Re-render the live canvas from the session's workflow events. Best effort. */
async function refreshCanvas(deps: ScriptWorkflowActivityDeps, sessionId: string): Promise<void> {
    if (!deps.canvas || typeof deps.catalog?.getSessionEvents !== "function") return;
    try {
        const events = await deps.catalog.getSessionEvents(sessionId, 0, 5_000, WORKFLOW_LOG_EVENT_TYPES);
        await deps.canvas.tick(sessionId, foldWorkflowCanvasState(events as any));
    } catch {
        // The transcript log is the record; the canvas is a view of it.
    }
}

export function buildParentNotification(input: ScriptWorkflowFinishInput): string {
    const name = input.workflowName ? `"${input.workflowName}"` : "(unnamed)";
    const header = `[SYSTEM: Workflow session ${input.sessionId} ${name} ${input.status} after ${input.steps} step(s).`;
    if (input.status === "failed") {
        return `${header} Error: ${input.error ?? "unknown error"}]`;
    }
    if (input.status === "cancelled" || input.status === "deleted") {
        return `${header} Reason: ${input.reason ?? input.status}]`;
    }
    return `${header} Outcome: ${input.outcome}. Output: ${preview(input.output)}]`;
}

const END_EVENT: Record<ScriptWorkflowFinishInput["status"], string> = {
    completed: "workflow.completed",
    failed: "workflow.failed",
    cancelled: "workflow.cancelled",
    deleted: "workflow.cancelled",
};

/** Register the three activities behind the script workflow controller. */
export function registerScriptWorkflowActivities(runtime: any, deps: ScriptWorkflowActivityDeps): void {
    const runNode = deps.runNode ?? runScriptNode;

    runtime.registerActivity(SCRIPT_WORKFLOW_ACTIVITIES.begin, async (
        _ctx: any,
        input: { sessionId: string; yaml: string },
    ): Promise<ScriptWorkflowBeginResult> => {
        if (!deps.enabled()) throw new Error(SCRIPT_WORKFLOWS_DISABLED_MESSAGE);
        const workflow = compileScriptWorkflow(input.yaml);
        await deps.catalog?.updateSession(input.sessionId, { state: "running", lastError: null, lastActiveAt: new Date() })
            .catch(() => undefined);
        await record(deps, input.sessionId, "workflow.started", {
            name: workflow.name,
            entry: workflow.entry,
            nodes: Object.values(workflow.nodes).map((node) => ({
                id: node.id,
                runtime: node.runtime,
                timeoutSeconds: node.timeoutSeconds,
                next: node.next,
            })),
        });
        if (deps.canvas) {
            try {
                await deps.canvas.draw(input.sessionId, buildWorkflowCanvasHtml(workflow, foldWorkflowCanvasState([], workflow)));
            } catch {
                // A run never fails because its view could not be drawn.
            }
        }
        return { workflow };
    });

    runtime.registerActivity(SCRIPT_WORKFLOW_ACTIVITIES.runNode, async (
        activityCtx: any,
        input: ScriptWorkflowRunNodeInput,
    ): Promise<ScriptWorkflowRunNodeResult> => {
        if (!deps.enabled()) throw new Error(SCRIPT_WORKFLOWS_DISABLED_MESSAGE);
        await record(deps, input.sessionId, "workflow.node_started", {
            nodeId: input.nodeId,
            runtime: input.node.runtime,
            step: input.step,
        });
        await refreshCanvas(deps, input.sessionId);
        let tools: Map<string, ScriptToolHandler> | null = null;
        let mcp: ScriptMcpConnections | null = null;
        const mcpConnections = async () => {
            mcp ??= new ScriptMcpConnections((await deps.resolveMcpServers?.(input.sessionId)) ?? {});
            return mcp;
        };
        const callTool = async (call: ScriptToolCall): Promise<unknown> => {
            tools ??= await deps.resolveTools(input.sessionId);
            const handler = tools.get(call.name);
            if (handler) return handler(call.arguments);
            if (call.name === LIST_MCP_TOOLS) {
                const connections = await mcpConnections();
                const wanted = typeof call.arguments.server === "string" ? [call.arguments.server] : connections.serverNames;
                const listed: Array<{ name: string; description?: string }> = [];
                for (const server of wanted) listed.push(...await connections.listTools(server));
                return { servers: connections.serverNames, tools: listed };
            }
            const mcpName = parseScriptMcpToolName(call.name);
            if (mcpName && (await mcpConnections()).has(mcpName.server)) {
                return (await mcpConnections()).call(mcpName.server, mcpName.tool, call.arguments);
            }
            const servers = (await mcpConnections()).serverNames;
            throw new Error(
                `Tool '${call.name}' is not available to workflow scripts. Available: ${[...tools.keys()].sort().join(", ") || "(none)"}`
                + (servers.length ? `; MCP servers (call as <server>/<tool>, or ${LIST_MCP_TOOLS}): ${servers.join(", ")}` : "")
                + ".",
            );
        };

        let result: RunScriptNodeResult;
        try {
            result = await runNode({
                sessionId: input.sessionId,
                workflowName: input.workflowName,
                node: input.node,
                inputs: input.inputs,
                priorOutput: input.priorOutput,
                step: input.step,
                callTool,
                ...(typeof activityCtx?.isCancelled === "function"
                    ? { isCancelled: () => { try { return activityCtx.isCancelled() === true; } catch { return false; } } }
                    : {}),
            }, deps.runnerOptions);
        } catch (error) {
            await record(deps, input.sessionId, "workflow.node_failed", {
                nodeId: input.nodeId,
                step: input.step,
                error: errorMessage(error),
            });
            await refreshCanvas(deps, input.sessionId);
            throw error;
        } finally {
            await (mcp as ScriptMcpConnections | null)?.close();
        }

        if (result.resultSource === "cancelled") {
            await record(deps, input.sessionId, "workflow.node_cancelled", {
                nodeId: input.nodeId,
                step: input.step,
                durationMs: result.durationMs,
                toolCalls: result.toolCalls,
            });
            await refreshCanvas(deps, input.sessionId);
            return { outcome: result.outcome, output: result.output };
        }
        await record(deps, input.sessionId, "workflow.node_completed", {
            nodeId: input.nodeId,
            step: input.step,
            outcome: result.outcome,
            resultSource: result.resultSource,
            exitCode: result.exitCode,
            durationMs: result.durationMs,
            toolCalls: result.toolCalls,
            outputPreview: preview(result.output),
            ...(result.exitCode !== 0 && result.stderrTail.trim()
                ? { stderrTail: result.stderrTail.trim().slice(-2_000) }
                : {}),
        });
        await refreshCanvas(deps, input.sessionId);
        return { outcome: result.outcome, output: result.output };
    });

    runtime.registerActivity(SCRIPT_WORKFLOW_ACTIVITIES.finish, async (
        _ctx: any,
        input: ScriptWorkflowFinishInput,
    ): Promise<null> => {
        const stopped = input.status === "cancelled" || input.status === "deleted";
        await record(deps, input.sessionId, END_EVENT[input.status], {
            name: input.workflowName,
            steps: input.steps,
            ...(input.terminalNodeId ? { terminalNodeId: input.terminalNodeId } : {}),
            ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
            ...(input.status === "completed" ? { outputPreview: preview(input.output) } : {}),
            ...(input.error ? { error: input.error } : {}),
            ...(stopped ? { reason: input.reason ?? input.status } : {}),
            ...(input.status === "deleted" ? { deleted: true } : {}),
        });
        if (input.status !== "deleted") await refreshCanvas(deps, input.sessionId);
        if (input.status === "deleted") {
            await deps.deleteSession?.(input.sessionId).catch(() => undefined);
        } else {
            await deps.catalog?.updateSession(input.sessionId, {
                state: input.status,
                lastError: input.status === "failed"
                    ? (input.error ?? "Workflow failed")
                    : input.status === "cancelled" ? (input.reason ?? "Cancelled") : null,
                lastActiveAt: new Date(),
            }).catch(() => undefined);
        }
        // A parent that stopped its own workflow does not need to be told.
        const parentAsked = Boolean(input.requestedBy) && input.requestedBy === input.parentSessionId;
        if (input.notifyParent && input.parentSessionId && !parentAsked) {
            await deps.notifyParent(
                input.parentSessionId,
                buildParentNotification(input),
                { kind: "system", display: `workflow ${input.workflowName ?? input.sessionId.slice(0, 8)}` },
            ).catch(() => undefined);
        }
        return null;
    });
}
