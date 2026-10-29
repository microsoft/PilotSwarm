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

export type ScriptToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface ScriptWorkflowActivityDeps {
    catalog: Pick<SessionCatalog, "updateSession" | "recordEvents"> | null;
    /** Whether this worker runs script workflows. A disabled worker fails them at the first step. */
    enabled: () => boolean;
    /** The tools a script in this workflow session may call, by name. */
    resolveTools: (sessionId: string) => Promise<Map<string, ScriptToolHandler>>;
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

export function buildParentNotification(input: ScriptWorkflowFinishInput): string {
    const name = input.workflowName ? `"${input.workflowName}"` : "(unnamed)";
    const header = `[SYSTEM: Workflow session ${input.sessionId} ${name} ${input.status} after ${input.steps} step(s).`;
    if (input.status === "failed") {
        return `${header} Error: ${input.error ?? "unknown error"}]`;
    }
    return `${header} Outcome: ${input.outcome}. Output: ${preview(input.output)}]`;
}

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
        return { workflow };
    });

    runtime.registerActivity(SCRIPT_WORKFLOW_ACTIVITIES.runNode, async (
        _ctx: any,
        input: ScriptWorkflowRunNodeInput,
    ): Promise<ScriptWorkflowRunNodeResult> => {
        if (!deps.enabled()) throw new Error(SCRIPT_WORKFLOWS_DISABLED_MESSAGE);
        await record(deps, input.sessionId, "workflow.node_started", {
            nodeId: input.nodeId,
            runtime: input.node.runtime,
            step: input.step,
        });
        let tools: Map<string, ScriptToolHandler> | null = null;
        const callTool = async (call: ScriptToolCall): Promise<unknown> => {
            tools ??= await deps.resolveTools(input.sessionId);
            const handler = tools.get(call.name);
            if (!handler) {
                const available = [...tools.keys()].sort();
                throw new Error(
                    `Tool '${call.name}' is not available to workflow scripts. Available: ${available.join(", ") || "(none)"}.`,
                );
            }
            return handler(call.arguments);
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
            }, deps.runnerOptions);
        } catch (error) {
            await record(deps, input.sessionId, "workflow.node_failed", {
                nodeId: input.nodeId,
                step: input.step,
                error: errorMessage(error),
            });
            throw error;
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
        return { outcome: result.outcome, output: result.output };
    });

    runtime.registerActivity(SCRIPT_WORKFLOW_ACTIVITIES.finish, async (
        _ctx: any,
        input: ScriptWorkflowFinishInput,
    ): Promise<null> => {
        await deps.catalog?.updateSession(input.sessionId, {
            state: input.status,
            lastError: input.status === "failed" ? (input.error ?? "Workflow failed") : null,
            lastActiveAt: new Date(),
        }).catch(() => undefined);
        await record(deps, input.sessionId, input.status === "completed" ? "workflow.completed" : "workflow.failed", {
            name: input.workflowName,
            steps: input.steps,
            ...(input.terminalNodeId ? { terminalNodeId: input.terminalNodeId } : {}),
            ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
            ...(input.status === "completed" ? { outputPreview: preview(input.output) } : {}),
            ...(input.error ? { error: input.error } : {}),
        });
        if (input.notifyParent && input.parentSessionId) {
            await deps.notifyParent(
                input.parentSessionId,
                buildParentNotification(input),
                { kind: "system", display: `workflow ${input.workflowName ?? input.sessionId.slice(0, 8)}` },
            ).catch(() => undefined);
        }
        return null;
    });
}
