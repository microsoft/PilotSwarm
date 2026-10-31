import type { CopilotSession } from "@github/copilot-sdk";
import { resolveWorkflowTool, validateWorkflowToolArguments, type WorkflowToolGrant } from "./tool-policy.js";

export interface WorkflowToolExecutor {
    call(name: string, args: Record<string, unknown>): Promise<unknown>;
    close(): Promise<void>;
}

export interface WorkflowToolExecutorOptions {
    session: Pick<CopilotSession, "rpc" | "abort">;
    grants: WorkflowToolGrant[];
    excludedTools?: string[];
    /** Recheck authority before every invocation, not only session creation. */
    authorize: () => Promise<void>;
    /** Stop only this handle's background work, disconnect, then release its folders. */
    dispose: () => Promise<void>;
    invocationPrefix: string;
    maxCalls?: number;
    cleanupTimeoutMs?: number;
}

async function cleanupWithin<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
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

export function workflowToolResult(result: ToolResult): unknown {
    if (typeof result === "string") return result;
    if (result.resultType !== "success") {
        throw new Error(result.error || result.textResultForLlm || `Tool returned ${result.resultType}.`);
    }
    if (result.structuredContent !== undefined) return result.structuredContent;
    if (result.contents?.length || result.binaryResultsForLlm?.length) {
        return {
            text: result.textResultForLlm,
            ...(result.contents ? { contents: result.contents } : {}),
            ...(result.binaryResultsForLlm ? { binaryResults: result.binaryResultsForLlm } : {}),
        };
    }
    return result.textResultForLlm;
}

/** No prompt is sent: the native CLI pipeline executes an already-selected tool. */
export async function createWorkflowToolExecutor(options: WorkflowToolExecutorOptions): Promise<WorkflowToolExecutor> {
    await options.session.rpc.tools.initializeAndValidate();
    const initial = await options.session.rpc.tools.getCurrentMetadata();
    if (!initial.tools) throw new Error("The Copilot runtime did not initialize a workflow tool catalog.");
    let closed = false;
    let calls = 0;
    let active = false;
    let pending: Promise<unknown> | undefined;
    let closePromise: Promise<void> | undefined;
    return {
        async call(name, args) {
            if (closed) throw new Error("Workflow tool executor is closed.");
            if (active) throw new Error("Concurrent workflow tool calls are not supported.");
            if (calls >= (options.maxCalls ?? 100)) throw new Error("Workflow tool call limit exceeded.");
            calls++;
            active = true;
            const invocationId = `${options.invocationPrefix}/${calls}`;
            const execute = async () => {
                await options.authorize();
                if (closed) throw new Error("Workflow tool executor was cancelled.");
                const current = await options.session.rpc.tools.getCurrentMetadata();
                if (!current.tools) throw new Error("The Copilot tool catalog is unavailable.");
                const tool = resolveWorkflowTool(name, options.grants, current.tools, options.excludedTools);
                validateWorkflowToolArguments(tool.name, args);
                if (closed) throw new Error("Workflow tool executor was cancelled.");
                return workflowToolResult(await options.session.rpc.tools.execute({
                    name: tool.name,
                    arguments: args as Parameters<CopilotSession["rpc"]["tools"]["execute"]>[0]["arguments"],
                    toolCallId: invocationId,
                }));
            };
            const run = execute();
            pending = run;
            try { return await run; }
            finally { active = false; if (pending === run) pending = undefined; }
        },
        close() {
            closePromise ??= (async () => {
                closed = true;
                const inFlight = pending;
                const errors: unknown[] = [];
                const deadline = options.cleanupTimeoutMs ?? 10_000;
                if (inFlight) {
                    try { await cleanupWithin(options.session.abort(), deadline); }
                    catch (error) { errors.push(error); }
                }
                // Abort failure must not skip stopping this handle's native background work.
                try { await cleanupWithin(options.dispose(), deadline); }
                catch (error) { errors.push(error); }
                if (inFlight) {
                    try { await cleanupWithin(Promise.allSettled([inFlight]), deadline); }
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
