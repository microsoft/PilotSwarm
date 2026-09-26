import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { SessionConfig, SessionEvent, PermissionRequestResult } from "@github/copilot-sdk";
import type {
    EphemeralSessionRequest, EphemeralSessionResult, EphemeralSessionRunner, EphemeralSessionUsage,
    EphemeralSessionDecision,
} from "./host-services.js";
import type { ModelProviderRegistry, ReasoningEffort } from "./model-providers.js";
import type { ProviderStore } from "./provider-store.js";
import type { SessionCatalog } from "./cms.js";
import { createEphemeralClient, ephemeralClientOptions, cleanupStep, type EphemeralClient, type EphemeralSession } from "./ephemeral-client.js";
import { ephemeralProviderOptions, validateEphemeralModelSelection } from "./ephemeral-provider.js";
import { createEphemeralScratch, removeEphemeralScratch, type EphemeralScratch } from "./ephemeral-scratch.js";
import { EphemeralUsageAccumulator, emptyUsageDiagnostics, sumUsageDiagnostics } from "./ephemeral-usage.js";
import { EphemeralSessionError, type EphemeralSessionErrorCode } from "./ephemeral-errors.js";
import { nativeSubagentDefinitions, nativeSubagentHooks, settleNativeSubagents } from "./native-subagents.js";
import { DEFAULT_TURN_TIMEOUT_MS, DEFAULT_TURN_INACTIVITY_TIMEOUT_MS } from "./managed-session.js";
import { CHILD_PROGRESS_TOOL, EphemeralNativeChildren, validateNativeChildren } from "./ephemeral-native-children.js";
import { RESET_TOOL, RESET_SEED, resetPrompt, RESET_ATTEMPTS, assertResetSupported } from "./ephemeral-context-reset.js";
import { isRecoverableRateLimit } from "./ephemeral-model-recovery.js";

type CredentialCatalog = Pick<SessionCatalog, "getUserRole"> & {
    providers: Pick<ProviderStore, "lookupUserId" | "getCredential">;
};
type Model = ReturnType<typeof ephemeralProviderOptions>;
type Phase = "resolve" | "isolation" | "invoke" | "callback" | "cleanup";

/** @internal Host runtime controls, never browser or model request fields. */
export interface EphemeralSessionDependencies {
    createClient?: (options: Parameters<typeof createEphemeralClient>[0], provider: unknown,
        onFailure: () => void, onDiagnostic: () => void) => EphemeralClient;
    scratchRoot?: string;
    createScratch?: typeof createEphemeralScratch;
    removeScratch?: typeof removeEphemeralScratch;
    turnTimeoutMs?: number;
    turnInactivityTimeoutMs?: number;
    signal?: AbortSignal;
    diagnostic?: (entry: { phase: Phase; code: EphemeralSessionErrorCode }) => void;
}

export const EPHEMERAL_LOCAL_TOOLS = [
    "view", "grep", "rg", "glob", "edit", "create", "apply_patch",
    "bash", "read_bash", "list_bash", "stop_bash",
];
const KEYS = new Set(["actor", "executionId", "model", "reasoningEffort", "contextTier",
    "workingDirectory", "systemMessage", "prompt", "signal", "progressStages", "onProgress", "onUsage", "onResponse",
    "nativeChildren", "onChildProgress", "contextReset"]);
const ZERO: EphemeralSessionUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, apiCalls: 0 };
// CLI 1.0.83 advertises overrides but dispatches report_progress to its native
// commit/PR tool. Never allow that path in the ephemeral runtime.
const PROGRESS_TOOL = "ephemeral_report_progress";

/** Observation correlation only; this key is not a durable claim or replay guard. */
export function ephemeralInvocationId(executionId: string, iteration: number): string {
    return `ephemeral:${createHash("sha256").update(executionId).digest("hex")}:${iteration}`;
}

function safe(error: unknown, fallback: EphemeralSessionErrorCode): EphemeralSessionError {
    return new EphemeralSessionError(error instanceof EphemeralSessionError ? error.code : fallback);
}

function sumUsage(a: EphemeralSessionUsage, b: EphemeralSessionUsage): EphemeralSessionUsage {
    const result = { ...a };
    for (const key of Object.keys(ZERO) as (keyof EphemeralSessionUsage)[]) {
        result[key] = a[key] == null || b[key] == null ? null : a[key]! + b[key]!;
        if (result[key] !== null && !Number.isSafeInteger(result[key])) throw new EphemeralSessionError("EPHEMERAL_INVALID_USAGE");
    }
    return result;
}

function decision(value: unknown): EphemeralSessionDecision {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new EphemeralSessionError("EPHEMERAL_CALLBACK_FAILED");
    const result = value as EphemeralSessionDecision;
    if (result.action === "complete" && Object.keys(result).length === 1) return result;
    if ((result.action === "continue" || result.action === "clear_context")
        && Object.keys(result).length === 2 && typeof result.prompt === "string" && result.prompt) return result;
    throw new EphemeralSessionError("EPHEMERAL_CALLBACK_FAILED");
}

/** @internal One non-durable session, multiple separately authorized submitted turns. */
export function createEphemeralSessionRunner(
    catalog: CredentialCatalog,
    getProviderTypes: () => ModelProviderRegistry | null,
    deps: EphemeralSessionDependencies = {},
): EphemeralSessionRunner {
    return async (input): Promise<EphemeralSessionResult> => {
        let phase: Phase = "resolve";
        let failure: EphemeralSessionError | undefined;
        let scratch: EphemeralScratch | undefined, client: EphemeralClient | undefined, session: EphemeralSession | undefined;
        let iteration = 0, turns = 0, sequence = 0, sent = false, idle = false, acceptingProgress = false;
        let usageFinalized = false, shutdownConfirmed = false, finalizing = false, usageCallbackUnavailable = false;
        let model: Model | undefined, invocationId = "";
        let children: EphemeralNativeChildren | undefined;
        // Internal context-reset turn. Its output is never host-visible work.
        let resetting = false, resetIdle = false, clearObserved: number | undefined;
        let resetToolInvoked = false, pendingReset = false, resetSpent = false;
        // True for exactly the sessions whose helper constructs a native
        // rate-limit recovery, so the host and the helper agree on which
        // failures are recoverable telemetry rather than terminal.
        let recoverRateLimits = false;
        let rootIdle = false;
        let currentUsage = new EphemeralUsageAccumulator(), totalUsage = { ...ZERO }, usageUncertain = false;
        let totalUsageDiagnostics = emptyUsageDiagnostics();
        let activeCompactions = 0, finishCompactions: (() => void) | undefined;
        let request = input, prompt = input?.prompt, finalText = "";
        const messages = new Map<string, string>();
        let finish: (() => void) | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined, inactivity: ReturnType<typeof setTimeout> | undefined;
        let queue: Promise<void> = Promise.resolve();
        let rejectInterrupted!: (error: EphemeralSessionError) => void;
        const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
        void interrupted.catch(() => {});
        const guarded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, interrupted]);
        const report = (code: EphemeralSessionErrorCode) => {
            try { (deps.diagnostic ?? (entry => console.warn(`[ephemeral] ${entry.phase}: ${entry.code}`)))({ phase, code }); }
            catch { /* Diagnostics cannot bypass shutdown. */ }
        };
        const interrupt = (code: EphemeralSessionErrorCode) => {
            failure ??= new EphemeralSessionError(code);
            acceptingProgress = false;
            rejectInterrupted(failure);
        };
        const abort = () => interrupt("EPHEMERAL_ABORTED");
        const check = () => { if (failure) throw failure; };
        const callback = (operation: () => Promise<void>) => {
            const next = queue.then(async () => { check(); await guarded(operation()); });
            queue = next.catch(() => { interrupt("EPHEMERAL_CALLBACK_FAILED"); });
            return guarded(next);
        };
        // An internal reset turn spends real tokens before the batch prompt is
        // sent, so its usage counts from the moment it happens rather than
        // being hidden until the send.
        const usageSnapshot = () => sent || resetSpent ? currentUsage.snapshot()
            : { usage: { ...ZERO }, usageDiagnostics: emptyUsageDiagnostics() };
        const notifyUsage = (completed: boolean) => {
            if (!request.onUsage || !model) return Promise.resolve();
            const { usage, usageDiagnostics } = usageSnapshot();
            const update = {
                invocationId, iteration, resolvedModel: model.resolvedModel, usage, usageDiagnostics, completed,
                usageUncertain: sent && (!completed || Object.values(usage).some(value => value === null)),
            };
            return callback(async () => {
                try { await guarded(request.onUsage!(update)); }
                catch (error) { usageCallbackUnavailable = true; throw error; }
            });
        };
        const resetInactivity = () => {
            if (inactivity) clearTimeout(inactivity);
            const ms = deps.turnInactivityTimeoutMs ?? DEFAULT_TURN_INACTIVITY_TIMEOUT_MS;
            if (!finalizing && sent && !idle && ms > 0) inactivity = setTimeout(abort, ms);
        };
        const armTurnDeadline = () => {
            if (timer) clearTimeout(timer);
            const ms = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
            if (!finalizing && ms > 0) timer = setTimeout(abort, ms);
        };
        const events = (event: SessionEvent) => {
            try {
                resetInactivity();
                if (resetting) {
                    // Internal reset turn. Its assistant output is not a batch
                    // result, so no messages, progress or host callbacks are
                    // produced from it — but it is real inference, so its usage
                    // is observed and reported with the batch it prepares for.
                    if (event.type === "session.error" || event.type === "model.call_failure") interrupt("EPHEMERAL_RESET_FAILED");
                    else if (event.type === "session.context_cleared") clearObserved = event.data.messagesCleared;
                    else if (!event.agentId && event.type === "session.idle") { resetIdle = true; finish?.(); }
                    currentUsage.observe(event as unknown as Parameters<EphemeralUsageAccumulator["observe"]>[0]);
                    return;
                }
                if (!sent || usageFinalized) return;
                currentUsage.observe(event as unknown as Parameters<EphemeralUsageAccumulator["observe"]>[0]);
                if (children && model) children.observe(event, model);
                if (event.type === "session.compaction_start") activeCompactions++;
                if (event.type === "session.compaction_complete") {
                    activeCompactions = Math.max(0, activeCompactions - 1);
                    if (!activeCompactions) { finishCompactions?.(); finishCompactions = undefined; }
                    if (!event.data.success) interrupt("EPHEMERAL_INVOCATION_FAILED");
                }
                if (event.type === "session.context_cleared") {
                    // Only the host-driven reset barrier may clear this window.
                    interrupt("EPHEMERAL_UNEXPECTED_CONTEXT_CLEAR");
                }
                if (event.type === "assistant.usage" || event.type === "model.call_failure" || event.type === "session.compaction_complete") {
                    void notifyUsage(false).catch(() => {});
                }
                if (event.type === "session.error"
                    || (event.type === "model.call_failure" && !(recoverRateLimits && isRecoverableRateLimit(event)))) {
                    interrupt("EPHEMERAL_INVOCATION_FAILED");
                } else if (!event.agentId && event.type === "assistant.turn_start") {
                    rootIdle = false;
                } else if (!event.agentId && event.type === "assistant.message" && typeof event.data.content === "string") {
                    messages.set(event.data.messageId ?? event.id, event.data.content);
                } else if (!event.agentId && event.type === "session.idle") {
                    rootIdle = true;
                    if (!children) {
                        if (!failure) idle = true;
                        acceptingProgress = false;
                        if (inactivity) clearTimeout(inactivity);
                    }
                    finish?.();
                }
            } catch (error) { interrupt(safe(error, "EPHEMERAL_INVOCATION_FAILED").code); }
        };
        const finishUsage = async () => {
            if (!iteration || usageFinalized) return;
            if (sent && (!idle || activeCompactions)) currentUsage.markIncomplete();
            const counters = usageSnapshot();
            usageFinalized = true;
            totalUsage = sumUsage(totalUsage, counters.usage);
            totalUsageDiagnostics = sumUsageDiagnostics(totalUsageDiagnostics, counters.usageDiagnostics);
            usageUncertain ||= sent && (!idle || Object.values(counters.usage).some(value => value === null));
            const deliver = async () => {
                if (!failure) await notifyUsage(idle);
                else if (request.onUsage && model && !usageCallbackUnavailable) {
                    // Do not retry a failed or interrupted observer. Other failures
                    // still receive their final usage observation after shutdown.
                    await request.onUsage({ invocationId, iteration, resolvedModel: model.resolvedModel,
                        ...counters, completed: idle, usageUncertain: sent && (!idle || Object.values(counters.usage).some(value => value === null)) });
                }
            };
            try {
                // Once runtime timers are stopped, terminal callbacks use the
                // existing teardown deadline rather than stranding host shutdown.
                if (finalizing) await cleanupStep(deliver());
                else await deliver();
            } catch {
                interrupt("EPHEMERAL_CALLBACK_FAILED");
                throw new EphemeralSessionError("EPHEMERAL_CALLBACK_FAILED");
            }
        };
        const settleCompactions = async () => {
            if (activeCompactions) await guarded(new Promise<void>(resolve => { finishCompactions = resolve; }));
            // Close a late background start before finalizing this turn's usage
            // or submitting another turn.
            const { cancelled } = await guarded(session!.rpc.history.cancelBackgroundCompaction());
            if (cancelled) {
                currentUsage.markIncomplete();
                interrupt("EPHEMERAL_INVOCATION_FAILED");
            }
            check();
        };
        try {
            validateEphemeralModelSelection(request);
            if (Object.keys(request).some(key => !KEYS.has(key))
                || typeof request.executionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(request.executionId)
                || typeof request.systemMessage !== "string" || typeof request.prompt !== "string"
                || typeof request.workingDirectory !== "string" || !path.isAbsolute(request.workingDirectory)
                || typeof request.onResponse !== "function"
                || (request.onUsage !== undefined && typeof request.onUsage !== "function")
                || (request.onProgress !== undefined && typeof request.onProgress !== "function")
                || (request.progressStages !== undefined && (!Array.isArray(request.progressStages)
                    || request.progressStages.some(stage => typeof stage !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(stage))
                    || new Set(request.progressStages).size !== request.progressStages.length))
                || Boolean(request.onProgress) !== Boolean(request.progressStages?.length)) {
                throw new EphemeralSessionError("EPHEMERAL_INVALID_REQUEST");
            }
            const nativeChildren = validateNativeChildren(request.nativeChildren, request.onChildProgress);
            if (request.contextReset !== undefined && typeof request.contextReset !== "boolean") {
                throw new EphemeralSessionError("EPHEMERAL_INVALID_REQUEST");
            }
            // A reset barrier must own the whole window, so it is incompatible
            // with native children.
            const contextReset = request.contextReset === true;
            if (contextReset && nativeChildren) throw new EphemeralSessionError("EPHEMERAL_RESET_UNSUPPORTED");
            children = nativeChildren ? new EphemeralNativeChildren(nativeChildren) : undefined;
            // A reset-enabled leaf runs the same batch work a native root does
            // and earns the same bounded 429 recovery. The reset window itself
            // is excluded by the helper gate, not by withholding recovery.
            recoverRateLimits = Boolean(nativeChildren) || contextReset;
            request = { ...request, actor: { ...request.actor }, progressStages: request.progressStages?.slice(),
                nativeChildren, contextReset };
            const stat = await lstat(request.workingDirectory);
            if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === "function"
                && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
                || await realpath(request.workingDirectory) !== path.resolve(request.workingDirectory)) {
                throw new EphemeralSessionError("EPHEMERAL_ISOLATION_FAILED");
            }
            for (const signal of [request.signal, deps.signal]) {
                if (signal?.aborted) abort();
                signal?.addEventListener("abort", abort, { once: true });
            }
            check();
            const types = getProviderTypes();
            if (!types) throw new EphemeralSessionError("EPHEMERAL_UNAVAILABLE");
            const resolveModel = async () => {
                const actorUserId = await guarded(catalog.providers.lookupUserId(request.actor));
                const role = await guarded(catalog.getUserRole(request.actor));
                if (!Number.isSafeInteger(actorUserId) || actorUserId === null || actorUserId <= 0
                    || (role.role !== "user" && role.role !== "admin")) {
                    throw new EphemeralSessionError("EPHEMERAL_MODEL_UNAVAILABLE");
                }
                const credential = await guarded(catalog.providers.getCredential(request.model.split(":")[0], actorUserId));
                if (!credential) throw new EphemeralSessionError("EPHEMERAL_MODEL_UNAVAILABLE");
                return ephemeralProviderOptions(types, credential, actorUserId, request);
            };
            model = await resolveModel();
            const recheck = async () => {
                check();
                if (getProviderTypes() !== types) {
                    throw new EphemeralSessionError("EPHEMERAL_MODEL_UNAVAILABLE");
                }
                const current = await resolveModel();
                if (JSON.stringify(current) !== JSON.stringify(model)) throw new EphemeralSessionError("EPHEMERAL_MODEL_UNAVAILABLE");
                check();
            };
            const verifyModel = async () => {
                const current = await guarded(session!.rpc.model.getCurrent());
                if (current.modelId !== model!.model
                    || (model!.reasoningEffort && current.reasoningEffort !== model!.reasoningEffort)
                    || (model!.contextTier && current.contextTier !== model!.contextTier)) throw new EphemeralSessionError("EPHEMERAL_MODEL_CHANGED");
            };
            /**
             * Internal reset turn that makes a batch boundary real on CLI 1.0.85.
             *
             * The runtime applies a clear one turn late: the turn that carries
             * the clear still runs against the stale window, and that turn's
             * assistant reply is carried into the first clean one. So the reset
             * is driven as its own turn against a fixed neutral seed, and the
             * host's real next batch is sent afterwards as a separate turn,
             * against a window that has actually been rebuilt.
             *
             * That surviving reply is model-written and was produced with the
             * finished batch still in view, so it can mention previous work.
             * This is a documented limitation, not total isolation.
             *
             * Fails closed: the clear is verified from the runtime's own event
             * rather than from the model's cooperation, and an unproven window
             * is an error rather than a quiet reuse.
             */
            const runReset = async () => {
                if (!contextReset || !session || !model) throw new EphemeralSessionError("EPHEMERAL_RESET_UNSUPPORTED");
                assertResetSupported(Boolean(children));
                phase = "invoke";
                // A clear drops the tool results its wipe orphans, so no
                // background compaction may be in flight across the boundary.
                await settleCompactions();
                check();
                // No native retry may run anywhere inside the barrier. A
                // replayed model call could call the reset tool a second time,
                // or repeat the continuation the clear seeds, so the helper's
                // recovery is closed before the first prompt and stays closed
                // for every model call the barrier can produce — across every
                // declined attempt, and after a clear has already been
                // observed. Nothing reopens it on a failure path: a barrier
                // that did not verifiably succeed leaves the window shut until
                // teardown, so a hook decision arriving late cannot land in a
                // reopened window. The helper refuses the retry itself; the
                // host's own fail-closed handling is a second line, not the
                // guarantee.
                //
                // The helper's IPC `call` carries no timeout of its own: a live
                // child that never answers leaves the promise pending forever.
                // Both gate hops therefore run under an armed turn deadline, so
                // `guarded` has something to lose the race to. Same budget a
                // turn gets — this adds no new timeout of its own.
                armTurnDeadline();
                await guarded(session.setModelRecoveryGate(true));
                // The tool call is the model's to make, and a live model does
                // decline it: measured on CLI 1.0.85, a single prompted turn
                // was honoured roughly one time in three, the rest answering in
                // prose. A declined call leaves the window untouched, so it is
                // safe to ask again; anything else is not retried. Attempts are
                // bounded, and every attempt's tokens are counted as usage.
                for (let attempt = 1; ; attempt++) {
                    resetting = true; resetSpent = true; resetIdle = false;
                    clearObserved = undefined; resetToolInvoked = false;
                    try {
                        armTurnDeadline();
                        const finished = new Promise<void>(resolve => { finish = resolve; });
                        await guarded(Promise.all([session.send({ prompt: resetPrompt(attempt) }), finished]));
                    } finally {
                        resetting = false;
                        if (timer) clearTimeout(timer);
                    }
                    check();
                    // Facts about what actually happened, not promises made in
                    // a prompt. A clear the runtime did not honour stops the
                    // run instead of silently reusing the previous window.
                    const cleared = resetIdle && resetToolInvoked
                        && clearObserved !== undefined && Number.isSafeInteger(clearObserved) && clearObserved > 0;
                    if (cleared) break;
                    // Only one situation is retryable: the turn ran to
                    // completion, the model never called the tool, and nothing
                    // was cleared. That leaves the window exactly as it was, so
                    // asking again is safe. Anything else — a turn that never
                    // reached idle, a tool call whose clear went unreported, or
                    // a clear observed without our tool — is ambiguous or
                    // partial, and re-running it could clear a second time.
                    // Provider and session errors never reach here at all; they
                    // interrupt the turn and fail the run directly.
                    const declined = resetIdle && !resetToolInvoked && clearObserved === undefined;
                    if (!declined || attempt >= RESET_ATTEMPTS) throw new EphemeralSessionError("EPHEMERAL_RESET_FAILED");
                }
                // The successful attempt's `finally` cleared the turn timer, so
                // the verified tail would otherwise run unarmed. Re-arm across
                // it and drop it once the reopen settles: the tail's awaits —
                // sub-agent drain, model re-check and the gate reopen — are
                // then bounded exactly as a turn is. Failure paths out of the
                // loop already left the timer cleared, and anything thrown here
                // clears it on the way out with the gate still shut.
                armTurnDeadline();
                try {
                    await guarded(settleNativeSubagents(session, { rejectRunning: true }));
                    await verifyModel();
                    // The barrier is verified — idle, the tool called, a positive
                    // clear reported — so the next batch turn is entitled to the
                    // same recovery as the first, and this is the only path that
                    // reopens. Awaited and guarded: a reopen that fails or hangs
                    // must fail the run rather than quietly leave the next batch
                    // with no recovery, which is the defect this whole change
                    // exists to remove.
                    await guarded(session.setModelRecoveryGate(false));
                } finally {
                    if (timer) clearTimeout(timer);
                }
            };
            while (true) {
                iteration++;
                turns++;
                invocationId = ephemeralInvocationId(request.executionId, iteration);
                usageFinalized = false; sent = false; resetSpent = false; idle = false; rootIdle = false; messages.clear();
                currentUsage = new EphemeralUsageAccumulator(Boolean(children));
                check();
                armTurnDeadline();                if (!client) {
                    phase = "isolation";
                    scratch = await (deps.createScratch ?? createEphemeralScratch)(deps.scratchRoot ?? path.resolve(".pilotswarm-ephemeral"));
                    check();
                    const clientOptions = { ...ephemeralClientOptions(scratch, model.gitHubToken), workingDirectory: request.workingDirectory };
                    client = (deps.createClient ?? createEphemeralClient)(clientOptions, model.provider, () => interrupt("EPHEMERAL_INVOCATION_FAILED"),
                            () => report("EPHEMERAL_RUNTIME_LOG_SUPPRESSED"));
                    const status = await guarded(client.getStatus());
                    if (status.version !== "1.0.85") throw new EphemeralSessionError("EPHEMERAL_RUNTIME_UNQUALIFIED");
                    const sessionId = randomUUID();
                    const allowed = [...EPHEMERAL_LOCAL_TOOLS, "task", ...(request.onProgress ? [PROGRESS_TOOL] : []),
                        ...(contextReset ? [RESET_TOOL] : []),
                        ...(children ? ["read_agent", CHILD_PROGRESS_TOOL] : [])];
                    const hooks = nativeSubagentHooks(model.model, {
                        onPreToolUse: async (input, invocation) => {
                            check();
                            const deny = (reason: string) => ({ permissionDecision: "deny" as const, permissionDecisionReason: reason });
                            if (!allowed.includes(input.toolName)) return deny("EPHEMERAL_TOOL_DENIED");
                            const args = input.toolArgs as Record<string, unknown> | undefined;
                            if (input.toolName === "bash" && (args?.detach === true || (args?.mode !== undefined && args.mode !== "sync"))) return deny("EPHEMERAL_SHELL_DENIED");
                            if (input.toolName === PROGRESS_TOOL && input.sessionId && input.sessionId !== invocation.sessionId) return deny("EPHEMERAL_CHILD_PROGRESS_DENIED");
                            // The reset tool exists only to give clearContext a pending
                            // tool call during an internal barrier. It is never the
                            // model's to choose, and never a child's.
                            if (input.toolName === RESET_TOOL && (!resetting || input.sessionId !== sessionId)) return deny("EPHEMERAL_RESET_DENIED");
                            // Nothing else runs inside a barrier turn.
                            if (resetting && input.toolName !== RESET_TOOL) return deny("EPHEMERAL_RESET_DENIED");
                            // An opted-in inter-batch reset makes this session a leaf
                            // worker. A cleared window cannot account for native children
                            // it no longer remembers spawning, so delegation is denied
                            // outright rather than reconciled. The descriptor stays
                            // registered — the isolation check below requires it — so
                            // only invocation is refused. Sessions that did not opt into
                            // contextReset keep ordinary synchronous delegation.
                            if (contextReset && input.toolName === "task") return deny("EPHEMERAL_NATIVE_DENIED");
                            if (input.toolName === "task") {
                                try { await recheck(); } catch (error) { interrupt(safe(error, "EPHEMERAL_MODEL_UNAVAILABLE").code); throw failure; }
                            }
                            return undefined;
                        },
                    }, () => true, undefined, children ? { background: true, additionalChildTools: [CHILD_PROGRESS_TOOL] } : {});
                    if (children) {
                        const nativeHook = hooks.onPreToolUse!;
                        hooks.onPreToolUse = async (input, invocation) => {
                            const result = await nativeHook(input, invocation);
                            if (result?.permissionDecision === "deny") return result;
                            const deny = (reason: string) => ({ permissionDecision: "deny" as const, permissionDecisionReason: reason });
                            if (input.toolName === "task") {
                                if (input.sessionId !== sessionId) return deny("Only the parent can launch assignments.");
                                const reason = children!.reserve(result?.modifiedArgs ?? input.toolArgs, iteration);
                                if (reason) return deny(reason);
                            } else if (input.toolName === "read_agent") {
                                const args = input.toolArgs as { agent_id?: unknown } | undefined;
                                if (input.sessionId !== sessionId) return deny("Only the parent can read assigned children.");
                                const tasks = await guarded(session!.rpc.tasks.list());
                                if (!children!.authorizeRead(args?.agent_id, tasks.tasks, model!.model)) {
                                    return deny("Read only this execution's assigned children.");
                                }
                            } else if (input.toolName === CHILD_PROGRESS_TOOL) {
                                const progress = acceptingProgress && input.sessionId
                                    ? children!.progress(input.sessionId, input.toolArgs) : undefined;
                                if (!progress) return deny("Invalid, duplicate or unavailable child progress. Use cumulative assigned references and ordered stages only.");
                                // CLI 1.0.83 external handlers carry the parent identity and may
                                // run twice. Record once here, using the trusted hook identity.
                                await callback(() => request.onChildProgress!(progress));
                            }
                            return result;
                        };
                    }
                    const config: SessionConfig = {
                        sessionId, model: model.model,
                        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
                        ...(model.contextTier ? { contextTier: model.contextTier } : {}),
                        ...(model.gitHubToken ? { gitHubToken: model.gitHubToken } : {}),
                        ...(model.provider ? { provider: model.provider, modelCapabilities: model.modelCapabilities } : {}),
                        systemMessage: { mode: "replace", content: request.systemMessage + (request.onProgress
                            ? `\nThe report_progress protocol uses the tool ${PROGRESS_TOOL} in this runtime. Call that exact tool, never the built-in report_progress. Only the parent reports global progress; native tasks return findings to the parent.` : "")
                            + (children ? `\nLaunch each host assignment exactly once using task(agent_type="swarm-task", mode="background", name=<assignment id>). At most ${children.options.maxConcurrent} children may run concurrently; excess launches are denied, not queued. Use read_agent with the returned child ID to await results and fill freed slots. No write_agent, respawning, or grandchildren. Every assignment must finish before returning. Children report agent-reported (not artifact-verified) work through ${CHILD_PROGRESS_TOOL} using an ordered stage and cumulative completedSessionRefs; no assignment ID or global counter arguments. Assignments: ${JSON.stringify(children.options.assignments)}. Stages: ${JSON.stringify(children.options.progressStages)}.` : "") },
                        workingDirectory: request.workingDirectory, configDirectory: scratch.copilotHome,
                        largeOutput: { enabled: false },
                        availableTools: allowed, excludedTools: ["mcp:*", "builtin:report_progress"],
                        customAgents: nativeSubagentDefinitions(model.model, undefined, children ? [CHILD_PROGRESS_TOOL] : []),
                        tools: request.onProgress ? [{
                            name: PROGRESS_TOOL, description: "Report parent progress using only an allowed stage and nonnegative integer counters. Unknown total is null.",
                            skipPermission: true, defer: "never",
                            parameters: { type: "object", additionalProperties: false, required: ["stage"],
                                properties: { stage: { type: "string", enum: request.progressStages },
                                    completed: { type: "integer", minimum: 0 }, total: { type: ["integer", "null"], minimum: 0 } } },
                            handler: async (value: unknown, invocation) => {
                                if (invocation.sessionId !== sessionId || !acceptingProgress) return "Progress unavailable.";
                                const data = value as { stage: string; completed?: number; total?: number | null };
                                if (!data || typeof data !== "object" || Array.isArray(data)
                                    || Object.keys(data).some(key => !["stage", "completed", "total"].includes(key))
                                    || !request.progressStages!.includes(data.stage)
                                    || (data.completed !== undefined && (!Number.isSafeInteger(data.completed) || data.completed < 0))
                                    || (data.total != null && (!Number.isSafeInteger(data.total) || data.total < (data.completed ?? 0)))) {
                                    return "Invalid progress. Use an allowed stage, nonnegative integer counters, completed <= total, and no extra fields.";
                                }
                                const progress = { stage: data.stage, completed: data.completed ?? 0, total: data.total ?? null,
                                    sequence: ++sequence, updatedAt: new Date().toISOString(), iteration };
                                await callback(() => request.onProgress!(progress));
                                return "Progress recorded.";
                            },
                        }] : [],
                        mcpServers: {}, pluginDirectories: [], skillDirectories: [], instructionDirectories: [],
                        additionalDirectories: [], includedBuiltinSkills: [],
                        enableConfigDiscovery: false, skipCustomInstructions: true,
                        enableOnDemandInstructionDiscovery: false, enableFileHooks: false,
                        enableHostGitOperations: false, enableSessionStore: false, enableSkills: false,
                        memory: { enabled: false }, skipEmbeddingRetrieval: true,
                        embeddingCacheStorage: "in-memory", mcpOAuthTokenStorage: "in-memory",
                        infiniteSessions: { enabled: true }, enableSessionTelemetry: false,
                        enableExperimentalMode: false, enableFileChangeTracking: false, remoteSession: "off",
                        requestExtensions: false, requestCanvasRenderer: false, enableMcpApps: false,
                        customAgentsLocalOnly: true, manageScheduleEnabled: false, coauthorEnabled: false, streaming: false,
                        onPermissionRequest: input => !failure && ["read", "write", "shell", "custom-tool"].includes(input.kind)
                            ? { kind: "approve-once" } as PermissionRequestResult : { kind: "denied-by-rules", rules: [] },
                        hooks, onEvent: events,
                    };
                    if (children) config.tools!.push({
                        name: CHILD_PROGRESS_TOOL,
                        description: "Report agent-reported completed work, not verified artifacts. Supply an ordered stage and cumulative assigned session references, no global counters or identity.",
                        skipPermission: true, defer: "never",
                        parameters: { type: "object", additionalProperties: false, required: ["stage", "completedSessionRefs"],
                            properties: { stage: { type: "string", enum: children.options.progressStages },
                                completedSessionRefs: { type: "array", uniqueItems: true, items: { type: "string" } } } },
                        handler: () => "Child progress checked by the host.",
                    });
                    if (contextReset) config.tools!.push({
                        name: RESET_TOOL,
                        description: "Internal host-driven context reset. When the host asks for it, call this tool immediately and call nothing else. It takes no arguments and needs no deliberation.",
                        skipPermission: true, defer: "never",
                        parameters: { type: "object", additionalProperties: false, required: [], properties: {} },
                        handler: async (_value: unknown, invocation) => {
                            if (!resetting || invocation.sessionId !== sessionId) return "Context reset unavailable.";
                            resetToolInvoked = true;
                            // clearContext drops the results of the tool calls its
                            // wipe orphans, so it is only legal from inside this
                            // handler, while this call is still pending.
                            // Qualified CLI 1.0.85 clears one turn late: this neutral
                            // seed can still see old context. runReset waits for its
                            // response and discards it from host output before sending
                            // the real next batch; the model-written reply can remain
                            // in the rebuilt window, so this is not total isolation.
                            const cleared = await guarded(session!.rpc.history.clearContext({ prompt: RESET_SEED }));
                            clearObserved ??= cleared.messagesCleared;
                            return "Context reset. Acknowledge and wait for the next instruction.";
                        },
                    });
                    session = await guarded(client.createSession(config, recoverRateLimits));
                    const updated = await guarded(session.rpc.options.update({
                        includedBuiltinAgents: [], sessionCapabilities: [], askUserDisabled: true, continueOnAutoMode: false,
                    }));
                    if (!updated.success) throw new EphemeralSessionError("EPHEMERAL_ISOLATION_FAILED");
                    await guarded(session.rpc.tools.initializeAndValidate());
                    const metadata = await guarded(session.rpc.tools.getCurrentMetadata());
                    const tools = metadata.tools;
                    if (!Array.isArray(tools) || tools.some(tool => !allowed.includes(tool.name))
                        || !["bash", "view", "task"].every(name => tools.some(tool => tool.name === name))) {
                        throw new EphemeralSessionError("EPHEMERAL_ISOLATION_FAILED");
                    }
                }
                // The boundary runs at the head of the batch it prepares for,
                // so the reset turn's inference lands in that batch's counters
                // and its invocationId rather than vanishing between turns.
                if (pendingReset) {
                    pendingReset = false;
                    await runReset();
                    // The verified barrier's tail cleared the turn timer, so
                    // re-arm before the batch turn it prepared. Without this the
                    // post-reset turn is bounded only by the inactivity
                    // deadline, while the identical turn on the ordinary path is
                    // capped by turnTimeoutMs — a turn that streams events but
                    // never reaches idle would run on here unbounded.
                    armTurnDeadline();
                }
                await verifyModel();
                await recheck();
                await notifyUsage(false);
                phase = "invoke";
                sent = true; acceptingProgress = true; resetInactivity();
                const finished = new Promise<void>(resolve => { finish = resolve; });
                await guarded(Promise.all([session!.send({ prompt }), finished]));
                if (children) {
                    // This RPC drains completion-triggered parent turns as well as children.
                    // It returns {} on its ten-minute timeout too. Fail closed at
                    // that boundary, then verify roots, assignments and task states.
                    const start = performance.now();
                    const drainTimeout = setTimeout(() => interrupt("EPHEMERAL_CHILDREN_FAILED"), 600_000);
                    try {
                        await guarded(session!.rpc.tasks.waitForPending());
                        if (performance.now() - start >= 600_000) throw new EphemeralSessionError("EPHEMERAL_CHILDREN_FAILED");
                    } finally { clearTimeout(drainTimeout); }
                    const tasks = (await guarded(session!.rpc.tasks.list())).tasks;
                    if (!rootIdle || tasks.some(task => task.type !== "agent" || !children!.owns(task.id)
                        || !["completed", "idle"].includes(task.status))) {
                        throw new EphemeralSessionError("EPHEMERAL_CHILDREN_FAILED");
                    }
                    children.assertComplete();
                    idle = true; acceptingProgress = false;
                    if (inactivity) clearTimeout(inactivity);
                }
                await guarded(settleNativeSubagents(session!, { rejectRunning: true }));
                await settleCompactions();
                await verifyModel();
                await guarded(queue); check();
                finalText = [...messages.values()].join("\n");
                if (!finalText) throw new EphemeralSessionError("EPHEMERAL_NO_RESULT");
                phase = "callback";
                let next: EphemeralSessionDecision;
                try {
                    next = decision(await guarded(request.onResponse({
                        text: finalText, iteration, resolvedModel: model.resolvedModel, ...usageSnapshot(),
                    })));
                } catch (error) { throw safe(error, "EPHEMERAL_CALLBACK_FAILED"); }
                await settleCompactions();
                check();
                if (next.action === "complete") break;
                await finishUsage(); check();
                if (timer) clearTimeout(timer);
                // A reset the run never opted into is an explicit error, never a
                // silently ignored decision that would reuse the stale window.
                if (next.action === "clear_context" && !contextReset) throw new EphemeralSessionError("EPHEMERAL_RESET_UNSUPPORTED");
                pendingReset = next.action === "clear_context";
                prompt = next.prompt;
            }
        } catch (error) {
            failure ??= safe(error, phase === "isolation" ? "EPHEMERAL_ISOLATION_FAILED" : "EPHEMERAL_INVOCATION_FAILED");
            report(failure.code);
        } finally {
            finalizing = true;
            acceptingProgress = false;
            if (timer) clearTimeout(timer);
            if (inactivity) clearTimeout(inactivity);
            phase = "cleanup";
            let cleanupFailed = false;
            const cleanup = async (operation: () => Promise<unknown>) => {
                try { await cleanupStep(operation()); } catch { cleanupFailed = true; report("EPHEMERAL_CLEANUP_FAILED"); }
            };
            if (client) {
                if (failure && session) await cleanup(() => session!.abort());
                if (session) await cleanup(() => settleNativeSubagents(session!));
                await cleanup(async () => { if ((await client!.stop()).length) throw new EphemeralSessionError("EPHEMERAL_CLEANUP_FAILED"); });
                // Always kill/reap the owned process group, including shells the CLI may have left behind.
                try { await cleanupStep(client.forceStop()); shutdownConfirmed = true; }
                catch { cleanupFailed = true; report("EPHEMERAL_CLEANUP_FAILED"); }
            } else shutdownConfirmed = true;
            if (scratch && shutdownConfirmed) await cleanup(() => (deps.removeScratch ?? removeEphemeralScratch)(scratch!));
            // A queued host callback that never settles must not hang the
            // returned promise after the child is already gone. Every other
            // teardown await is bounded; this one was not. A callback still in
            // flight when that bound expires is itself a cleanup failure — the
            // runtime process is drained but host-owned work is not — so the run
            // reports EPHEMERAL_CLEANUP_FAILED rather than a partial success.
            await cleanup(() => queue);
            // Teardown quality dominates deliberately. An undrained process
            // group or a lost usage observation is a global failure of the run,
            // and must not be downgraded to a reset-specific code just because
            // the barrier failed too: a host that saw EPHEMERAL_RESET_FAILED
            // would requeue the assignment while this session's resources are
            // still unaccounted for. The narrow "next batch prompt was never
            // dispatched" signal is therefore unavailable in that correlated
            // case. That is a known limitation of the code channel, not an
            // accident — report() still records what actually happened first.
            if (cleanupFailed) failure = new EphemeralSessionError("EPHEMERAL_CLEANUP_FAILED");
            try { await finishUsage(); } catch (error) {
                failure = safe(error, "EPHEMERAL_CALLBACK_FAILED"); report(failure.code);
            }
            for (const signal of [request?.signal, deps.signal]) signal?.removeEventListener("abort", abort);
        }
        if (failure) throw failure;
        if (!model || !shutdownConfirmed) throw new EphemeralSessionError("EPHEMERAL_INVOCATION_FAILED");
        return { text: finalText, resolvedModel: model.resolvedModel,
            ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort as ReasoningEffort } : {}),
            ...(model.contextTier ? { contextTier: model.contextTier } : {}),
            usage: totalUsage, usageDiagnostics: totalUsageDiagnostics, usageUncertain, turnCount: turns };
    };
}
