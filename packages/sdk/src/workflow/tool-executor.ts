import type { CopilotSession } from "@github/copilot-sdk";
import { resolveWorkflowTool, validateWorkflowToolArguments, type WorkflowToolGrant } from "./tool-policy.js";

export interface WorkflowToolExecutor {
    call(name: string, args: Record<string, unknown>, observer?: WorkflowToolCallObserver): Promise<unknown>;
    close(): Promise<void>;
}

/**
 * Workflow Simplified stage 2.4 (FU-25): told when a call's turn on the (possibly shared) tool session begins, so its
 * real run window (start to settle) can be recorded; a call that never gets its turn never calls it.
 */
export interface WorkflowToolCallObserver {
    started?: (atMs: number) => void;
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
     * Run one call when its turn comes on a session other handles share (workflow RT-2, E1b): the call's checks,
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
 * On a shared session (`serially`, workflow RT-2 and E1b), a call waits for its turn; when its turn comes it is
 * refused if this handle was closed, its script ended or `check` refuses, then authority is checked, then the same
 * refusals are checked again after the authorization and just before it runs (E1b-R2). A close rejects a
 * call still waiting at once (its turn then runs nothing); a call whose turn has begun settles with its own outcome. A
 * close aborts the session only while this handle's own call runs,
 * waits for the whole turn of a call that began to end (on a shared session, the turn gives the tasks the call started
 * to this handle after the call; E1c-R2), and only then disposes the handle.
 */
export async function createWorkflowToolExecutor(options: WorkflowToolExecutorOptions): Promise<WorkflowToolExecutor> {
    await options.session.rpc.tools.initializeAndValidate();
    const initial = await options.session.rpc.tools.getCurrentMetadata();
    if (!initial.tools) throw new Error("The Copilot runtime did not initialize a workflow tool catalog.");
    let closed = false;
    let calls = 0;
    let active = false;
    /** This handle's call runs its checks or its native execution. */
    let running = false;
    /**
     * The turn of this handle's call once it has begun, until the turn has ended (E1c-R2): on a shared session the turn
     * goes on after the call, to give the tasks the call started to this handle, and a close waits for that.
     */
    let turnInProgress: { done: Promise<void> | null } | null = null;
    let closePromise: Promise<void> | undefined;
    /** Rejects this handle's call while it still waits for its turn (G1b): a close turns such a call away at once. */
    let rejectPending: (() => void) | null = null;
    const ended = () => options.signal?.aborted === true;
    const refuse = () => {
        if (closed) throw new Error("Workflow tool executor was cancelled.");
        if (ended()) throw new Error("The script ended; its workflow tool call did not run.");
        options.check?.();
    };
    return {
        async call(name, args, observer) {
            if (closed) throw new Error("Workflow tool executor is closed.");
            if (ended()) throw new Error("The script ended; its workflow tool call did not run.");
            if (active) throw new Error("Concurrent workflow tool calls are not supported.");
            if (calls >= (options.maxCalls ?? 100)) throw new Error("Workflow tool call limit exceeded.");
            calls++;
            active = true;
            const invocationId = `${options.invocationPrefix}/${calls}`;
            const token: { done: Promise<void> | null } = { done: null };
            // A call that has not begun its turn is rejected by a close at once ("closed"); once its turn has begun it
            // settles with its own outcome: its result, the refusal of a later check ("was cancelled") or the abort's error.
            let started = false;
            let rejectThis!: (error: Error) => void;
            const closedFirst = new Promise<never>((_, reject) => { rejectThis = reject; });
            closedFirst.catch(() => undefined);
            rejectPending = () => { if (!started) rejectThis(new Error("Workflow tool executor is closed.")); };
            const execute = async () => {
                started = true;
                // Its turn: a closed handle or an ended script never starts the call (VR-1).
                refuse();
                // FU-25: its real run window begins now (after any wait for its turn on a shared session).
                try { observer?.started?.(Date.now()); } catch { /* an observer never fails the call */ }
                turnInProgress = token;
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
            const done = turn.then(() => undefined, () => undefined);
            token.done = done;
            void done.then(() => { if (turnInProgress === token) turnInProgress = null; });
            try { return await Promise.race([turn, closedFirst]); }
            finally { active = false; rejectPending = null; }
        },
        close() {
            closePromise ??= (async () => {
                closed = true;
                rejectPending?.();
                const executing = running;
                const turnEnd = turnInProgress?.done ?? null;
                const errors: unknown[] = [];
                const deadline = options.cleanupTimeoutMs ?? 10_000;
                let settled = true;
                // Only this handle's own running call is aborted; a call still waiting for its turn never starts.
                if (executing) {
                    try { await cleanupWithin(options.session.abort(), deadline); }
                    catch (error) { errors.push(error); }
                }
                // The whole turn of a call that began, its listing of the tasks it started included (E1c-R2), ends first.
                if (turnEnd) {
                    try { await cleanupWithin(turnEnd, deadline); }
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
