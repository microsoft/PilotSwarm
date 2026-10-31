import type { CopilotSession } from "@github/copilot-sdk";
import { resolveWorkflowTool, validateWorkflowToolArguments, type WorkflowToolGrant } from "./tool-policy.js";

export interface WorkflowToolExecutor {
    call(name: string, args: Record<string, unknown>): Promise<unknown>;
    close(): Promise<void>;
}

export interface WorkflowToolExecutorOptions {
    session: Pick<CopilotSession, "rpc" | "abort">;
    grants: WorkflowToolGrant[];
    /** Recheck authority before every invocation, not only session creation. */
    authorize: () => Promise<void>;
    /** Stop only this handle's background work, disconnect, then release its folders. */
    dispose: () => Promise<void>;
    invocationPrefix: string;
    maxCalls?: number;
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
                const tool = resolveWorkflowTool(name, options.grants, current.tools);
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
                if (inFlight) await options.session.abort();
                // Disposal stops native background work before waiting on a blocked shell result.
                await options.dispose();
                if (inFlight) await Promise.allSettled([inFlight]);
            })();
            return closePromise;
        },
    };
}
