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
    /**
     * Stop only this handle's background work, disconnect, then release its folders. Called once, after this handle's
     * own call has ended; `settled` is false when that call did not end after its abort within the cleanup deadline.
     */
    dispose: (outcome: { settled: boolean }) => Promise<void>;
    invocationPrefix: string;
    maxCalls?: number;
    cleanupTimeoutMs?: number;
    /**
     * Run one call when its turn comes on a session other handles share (workflow v2 RT-2, E1b): the call's checks,
     * authority and native execution all happen in its turn. Unset: the call runs at once.
     */
    serially?: <T>(run: () => Promise<T>) => Promise<T>;
    /** The script ended (E1b): a call that has not started never starts. */
    signal?: AbortSignal;
    /**
     * What else stops a call that has not started (E1b-R2): it throws to refuse. Called when the call's turn comes,
     * after its authorization and again just before the native execution.
     */
    check?: () => void;
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

/**
 * No prompt is sent: the native CLI pipeline executes an already-selected tool.
 *
 * On a shared session (`serially`, workflow v2 RT-2 and E1b), a call waits for its turn; when its turn comes it is
 * refused if this handle was closed, its script ended or `check` refuses, then authority is checked, then the same
 * refusals are checked again after the authorization and just before it runs (E1b-R2). A close rejects a
 * call still waiting at once (its turn then runs nothing), aborts the session only while this handle's own call runs,
 * waits for that call to end, and only then disposes the handle.
 */
export async function createWorkflowToolExecutor(options: WorkflowToolExecutorOptions): Promise<WorkflowToolExecutor> {
    await options.session.rpc.tools.initializeAndValidate();
    const initial = await options.session.rpc.tools.getCurrentMetadata();
    if (!initial.tools) throw new Error("The Copilot runtime did not initialize a workflow tool catalog.");
    let closed = false;
    let calls = 0;
    let active = false;
    /** This handle's call is in its turn (its checks or its native execution). */
    let running = false;
    let pending: Promise<unknown> | undefined;
    let closePromise: Promise<void> | undefined;
    let rejectWaiting!: (error: Error) => void;
    const closedWhileWaiting = new Promise<never>((_, reject) => { rejectWaiting = reject; });
    closedWhileWaiting.catch(() => undefined);
    const ended = () => options.signal?.aborted === true;
    const refuse = () => {
        if (closed) throw new Error("Workflow tool executor was cancelled.");
        if (ended()) throw new Error("The script ended; its workflow tool call did not run.");
        options.check?.();
    };
    return {
        async call(name, args) {
            if (closed) throw new Error("Workflow tool executor is closed.");
            if (ended()) throw new Error("The script ended; its workflow tool call did not run.");
            if (active) throw new Error("Concurrent workflow tool calls are not supported.");
            if (calls >= (options.maxCalls ?? 100)) throw new Error("Workflow tool call limit exceeded.");
            calls++;
            active = true;
            const invocationId = `${options.invocationPrefix}/${calls}`;
            const execute = async () => {
                // Its turn: a closed handle or an ended script never starts the call (VR-1).
                refuse();
                running = true;
                try {
                    await options.authorize();
                    refuse();
                    const current = await options.session.rpc.tools.getCurrentMetadata();
                    if (!current.tools) throw new Error("The Copilot tool catalog is unavailable.");
                    const tool = resolveWorkflowTool(name, options.grants, current.tools, options.excludedTools);
                    validateWorkflowToolArguments(tool.name, args);
                    refuse();
                    return workflowToolResult(await options.session.rpc.tools.execute({
                        name: tool.name,
                        arguments: args as Parameters<CopilotSession["rpc"]["tools"]["execute"]>[0]["arguments"],
                        toolCallId: invocationId,
                    }));
                } finally {
                    running = false;
                }
            };
            const turn = options.serially ? options.serially(execute) : execute();
            pending = turn;
            try { return await Promise.race([turn, closedWhileWaiting]); }
            finally { active = false; if (pending === turn) pending = undefined; }
        },
        close() {
            closePromise ??= (async () => {
                closed = true;
                rejectWaiting(new Error("Workflow tool executor is closed."));
                const inFlight = running ? pending : undefined;
                const errors: unknown[] = [];
                const deadline = options.cleanupTimeoutMs ?? 10_000;
                let settled = true;
                if (inFlight) {
                    // Only this handle's own running call is aborted; a call still waiting for its turn never starts.
                    try { await cleanupWithin(options.session.abort(), deadline); }
                    catch (error) { errors.push(error); }
                    try { await cleanupWithin(Promise.allSettled([inFlight]), deadline); }
                    catch (error) { errors.push(error); settled = false; }
                }
                // Abort failure must not skip stopping this handle's native background work.
                try { await cleanupWithin(options.dispose({ settled }), deadline); }
                catch (error) { errors.push(error); }
                if (errors.length) {
                    throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join("; "));
                }
            })();
            return closePromise;
        },
    };
}
