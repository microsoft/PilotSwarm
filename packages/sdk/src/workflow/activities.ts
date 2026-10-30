import type { SessionCatalog } from "../cms.js";
import { compileWorkflow, validateWorkflowInputs, workflowUsesScripts, type CompiledWorkflow } from "./compiler.js";
import type { ScriptToolCall } from "./executor.js";
import {
    WORKFLOW_ACTIVITIES,
    type WorkflowBeginResult,
    type WorkflowFinishInput,
    type WorkflowRunStateInput,
    type WorkflowRunStateResult,
} from "./orchestration.js";
import { runScriptNode, type RunScriptNodeResult, type ScriptRunnerOptions } from "./runner.js";
import { parseScriptMcpToolName, ScriptMcpConnections } from "./mcp.js";
import { buildWorkflowCanvasHtml, foldWorkflowCanvasState, type WorkflowCanvasPublisher } from "./canvas.js";

/** The events a workflow writes; the canvas state is folded from them. */
export const WORKFLOW_LOG_EVENT_TYPES = [
    "workflow.started",
    "workflow.state_started",
    "workflow.state_completed",
    "workflow.state_failed",
    "workflow.state_cancelled",
    "workflow.completed",
    "workflow.failed",
    "workflow.cancelled",
];

export type ScriptToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface WorkflowActivityDeps {
    catalog: (Pick<SessionCatalog, "updateSession" | "recordEvents"> & Partial<Pick<SessionCatalog, "getSessionEvents">>) | null;
    /** Draws and updates the live execution canvas. Absent: no canvas. */
    canvas?: WorkflowCanvasPublisher | null;
    /** Whether this worker runs workflow scripts. A workflow with script states fails at its start where it is off. */
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

export const WORKFLOW_SCRIPTS_DISABLED_MESSAGE =
    "Workflow scripts are disabled on this worker. An operator enables them with PILOTSWARM_WORKFLOW_SCRIPTS=1 "
    + "(or the worker option workflowScripts.enabled), because scripts run as processes on the worker.";

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
    deps: WorkflowActivityDeps,
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
async function refreshCanvas(deps: WorkflowActivityDeps, sessionId: string): Promise<void> {
    if (!deps.canvas || typeof deps.catalog?.getSessionEvents !== "function") return;
    try {
        const events = await deps.catalog.getSessionEvents(sessionId, 0, 5_000, WORKFLOW_LOG_EVENT_TYPES);
        await deps.canvas.tick(sessionId, foldWorkflowCanvasState(events as any));
    } catch {
        // The transcript log is the record; the canvas is a view of it.
    }
}

export function buildParentNotification(input: WorkflowFinishInput): string {
    const name = input.workflowName ? `"${input.workflowName}"` : "(unnamed)";
    if (input.outcome !== undefined) {
        return `[SYSTEM: Workflow session ${input.sessionId} ${name} ended at state '${input.stateId}' with outcome ${input.outcome} after ${input.steps} step(s). `
            + `${input.summary ?? ""} Output: ${preview(input.output)}]`;
    }
    const header = `[SYSTEM: Workflow session ${input.sessionId} ${name} ${input.status} after ${input.steps} step(s).`;
    if (input.status === "failed") return `${header} Error: ${input.error ?? "unknown error"}]`;
    return `${header} Reason: ${input.reason ?? input.status}]`;
}

/** The graph as the `workflow.started` event and the views describe it. */
export function describeStates(workflow: CompiledWorkflow): Array<Record<string, unknown>> {
    return Object.values(workflow.states).map((state) => state.type === "script"
        ? { id: state.id, type: "script", runtime: state.runtime, timeoutSeconds: state.timeoutSeconds, next: state.next }
        : { id: state.id, type: "terminal", outcome: state.outcome });
}

const END_EVENT: Record<WorkflowFinishInput["status"], string> = {
    completed: "workflow.completed",
    failed: "workflow.failed",
    cancelled: "workflow.cancelled",
    deleted: "workflow.cancelled",
};

/** Register the three activities behind the workflow controller. */
export function registerWorkflowActivities(runtime: any, deps: WorkflowActivityDeps): void {
    const runNode = deps.runNode ?? runScriptNode;

    runtime.registerActivity(WORKFLOW_ACTIVITIES.begin, async (
        _ctx: any,
        input: { sessionId: string; yaml: string; inputs?: Record<string, unknown> },
    ): Promise<WorkflowBeginResult> => {
        const workflow = compileWorkflow(input.yaml);
        if (workflowUsesScripts(workflow) && !deps.enabled()) throw new Error(WORKFLOW_SCRIPTS_DISABLED_MESSAGE);
        validateWorkflowInputs(workflow, input.inputs ?? {});
        await deps.catalog?.updateSession(input.sessionId, { state: "running", lastError: null, lastActiveAt: new Date() })
            .catch(() => undefined);
        await record(deps, input.sessionId, "workflow.started", {
            name: workflow.name,
            version: workflow.version,
            initial: workflow.initial,
            states: describeStates(workflow),
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

    runtime.registerActivity(WORKFLOW_ACTIVITIES.runScript, async (
        activityCtx: any,
        input: WorkflowRunStateInput,
    ): Promise<WorkflowRunStateResult> => {
        if (!deps.enabled()) throw new Error(WORKFLOW_SCRIPTS_DISABLED_MESSAGE);
        await record(deps, input.sessionId, "workflow.state_started", {
            stateId: input.stateId,
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
            await record(deps, input.sessionId, "workflow.state_failed", {
                stateId: input.stateId,
                step: input.step,
                error: errorMessage(error),
            });
            await refreshCanvas(deps, input.sessionId);
            throw error;
        } finally {
            await (mcp as ScriptMcpConnections | null)?.close();
        }

        if (result.resultSource === "cancelled") {
            await record(deps, input.sessionId, "workflow.state_cancelled", {
                stateId: input.stateId,
                step: input.step,
                durationMs: result.durationMs,
                toolCalls: result.toolCalls,
            });
            await refreshCanvas(deps, input.sessionId);
            return { outcome: result.outcome, output: result.output };
        }
        await record(deps, input.sessionId, "workflow.state_completed", {
            stateId: input.stateId,
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

    runtime.registerActivity(WORKFLOW_ACTIVITIES.finish, async (
        _ctx: any,
        input: WorkflowFinishInput,
    ): Promise<null> => {
        const stopped = input.status === "cancelled" && input.outcome === undefined || input.status === "deleted";
        await record(deps, input.sessionId, END_EVENT[input.status], {
            name: input.workflowName,
            steps: input.steps,
            ...(input.stateId ? { stateId: input.stateId } : {}),
            ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
            ...(input.summary ? { summary: input.summary } : {}),
            ...(input.outcome !== undefined ? { outputPreview: preview(input.output) } : {}),
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
                    ? (input.error ?? input.summary ?? "Workflow failed")
                    : stopped ? (input.reason ?? "Cancelled") : null,
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
