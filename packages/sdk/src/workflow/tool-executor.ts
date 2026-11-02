import type { CopilotSession } from "@github/copilot-sdk";
import { resolveWorkflowTool, validateWorkflowToolArguments, WorkflowToolError, type WorkflowToolGrant } from "./tool-policy.js";

/**
 * Runs a script's tool calls through a dedicated Copilot CLI session that is
 * configured like the parent agent's. No prompt is ever sent: the CLI's own
 * tool pipeline (permissions, MCP, built-ins) executes an already-chosen
 * tool. After Affan Dar's executor.
 */
export interface WorkflowToolExecutor {
    call(name: string, args: Record<string, unknown>): Promise<unknown>;
    close(): Promise<void>;
}

export interface WorkflowToolExecutorOptions {
    session: Pick<CopilotSession, "rpc" | "abort">;
    grants: WorkflowToolGrant[];
    excludedTools?: string[];
    /** Re-checks the parent's authority for this tool before every call. Throws to refuse the call. */
    authorize: (tool: { name: string; mcpServerName?: string }) => Promise<void>;
    /** Stops this session's background work, disconnects it and releases its folders. */
    dispose: () => Promise<void>;
    invocationPrefix: string;
    /** The workflow session the calls act as; guards its live canvas slot. */
    workflowSessionId?: string;
    maxCalls?: number;
    cleanupTimeoutMs?: number;
}

async function within<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([work, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Workflow tool cleanup timed out.")), timeoutMs);
        })]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

type ToolResult = Awaited<ReturnType<CopilotSession["rpc"]["tools"]["execute"]>>;

/** What the script receives: structured content when the tool has it, else its text. */
export function workflowToolResult(result: ToolResult): unknown {
    if (typeof result === "string") return result;
    if (result.resultType !== "success") {
        throw new Error(result.error || result.textResultForLlm || `Tool returned ${result.resultType}.`);
    }
    if (result.structuredContent !== undefined) return result.structuredContent;
    const contents = (result.contents ?? []) as Array<{ type?: string }>;
    const binary = result.binaryResultsForLlm ?? [];
    // Text-only content (an MCP tool's usual answer) reaches the script as its text.
    if (binary.length || contents.some((item) => item?.type !== "text")) {
        return {
            text: result.textResultForLlm,
            ...(contents.length ? { contents } : {}),
            ...(binary.length ? { binaryResults: binary } : {}),
        };
    }
    // Text stays text: a shell printing JSON is still a string to the script.
    return result.textResultForLlm;
}

export async function createWorkflowToolExecutor(options: WorkflowToolExecutorOptions): Promise<WorkflowToolExecutor> {
    await options.session.rpc.tools.initializeAndValidate();
    const initial = await options.session.rpc.tools.getCurrentMetadata();
    if (!initial.tools) throw new Error("The Copilot runtime did not initialize a workflow tool catalog.");
    let closed = false;
    let calls = 0;
    // Calls run one at a time, in the order the script made them.
    let queue: Promise<unknown> = Promise.resolve();
    let pending: Promise<unknown> | undefined;
    let closePromise: Promise<void> | undefined;
    const cancelled = () => new WorkflowToolError("WORKFLOW_STATE_STOPPING", "The workflow state is stopping; the tool call did not run.");
    return {
        call(name, args) {
            if (closed) return Promise.reject(cancelled());
            if (calls >= (options.maxCalls ?? 500)) {
                return Promise.reject(new WorkflowToolError("WORKFLOW_TOOL_LIMIT", "This state made too many tool calls."));
            }
            calls++;
            const invocationId = `${options.invocationPrefix}/${calls}`;
            const run = queue.catch(() => undefined).then(async () => {
                if (closed) throw cancelled();
                const current = await options.session.rpc.tools.getCurrentMetadata();
                if (!current.tools) throw new Error("The Copilot tool catalog is unavailable.");
                const tool = resolveWorkflowTool(name, options.grants, current.tools, options.excludedTools);
                validateWorkflowToolArguments(tool.name, args, { workflowSessionId: options.workflowSessionId });
                await options.authorize({ name: tool.name, ...(tool.mcpServerName ? { mcpServerName: tool.mcpServerName } : {}) });
                if (closed) throw cancelled();
                const execution = options.session.rpc.tools.execute({
                    name: tool.name,
                    arguments: args as Parameters<CopilotSession["rpc"]["tools"]["execute"]>[0]["arguments"],
                    toolCallId: invocationId,
                });
                pending = execution;
                try { return workflowToolResult(await execution); }
                finally { if (pending === execution) pending = undefined; }
            });
            queue = run;
            return run;
        },
        close() {
            closePromise ??= (async () => {
                closed = true;
                const inFlight = pending;
                const errors: unknown[] = [];
                const deadline = options.cleanupTimeoutMs ?? 10_000;
                if (inFlight) {
                    try { await within(options.session.abort(), deadline); }
                    catch (error) { errors.push(error); }
                }
                // An abort failure must not skip stopping this session's background shells.
                try { await within(options.dispose(), deadline); }
                catch (error) { errors.push(error); }
                if (inFlight) {
                    try { await within(Promise.allSettled([inFlight]), deadline); }
                    catch (error) { errors.push(error); }
                }
                if (errors.length) {
                    throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join("; "));
                }
            })();
            return closePromise;
        },
    };
}
