import type { CommandMessage, OrchestrationInput, TurnResult } from "../types.js";
import { sanitizePromptAttachmentRefs, ATTACHMENTS_MAX_COUNT } from "../types.js";
import { messageSenderKey } from "../message-sender.js";
import { CARRIED_STEERS_WAKE_PROMPT } from "../turn-control-contract.js";
import {
    applyChildUpdate,
    maybeResolveAgentWaitCompletion,
    parseChildUpdate,
    isAgentWaitSettledStatus,
} from "./agents.js";
import {
    bufferChildUpdate,
    drainLeadingQueuedScheduleActions,
    flushPendingChildDigestIntoPrompt,
    handleCommand,
    promptIdsIntersectCancellation,
    publishStatus,
    queueFollowup,
    dropCancelledPrompt,
    restorePendingChildDigest,
    wrapWithResumeContext,
} from "./lifecycle.js";
import { shouldWakeParentForChildDigest } from "../child-notifications.js";
import { pendingChildDigestHasError } from "./lifecycle.js";
import {
    CHILD_UPDATE_BATCH_MS,
    CHILD_DIGEST_COALESCE_MS,
    childUpdateBatchMs,
    FIFO_BUCKET_COUNT,
    MAX_BUCKET_BYTES,
    MAX_FIFO_ITEM_BYTES,
    MAX_DRAIN_PER_TURN,
    MAX_PREDISPATCH_SWEEP,
    NON_BLOCKING_TIMER_MS,
    PREDISPATCH_CANCEL_SWEEP_MS,
    addCancelledMessageIds,
    touchRecentClientMessageIds,
    timerGate,
    type ActiveTimer,
    type DurableSessionRuntime,
    type PendingChildDigest,
    type ReleasedTimerRecord,
} from "./state.js";
import { handleTurnResult, processPrompt, processTimer } from "./turn.js";
import { validClientMessageIds , noteMessageSender, applySenderAttribution, maybeQueueSharedPreamble } from "./utils.js";

// ─── KV FIFO bucket primitives ──────────────────────────────

function fifoBucketKey(index: number): string {
    return `fifo.${index}`;
}

function readFifoBucket(ctx: any, index: number): any[] {
    const raw = ctx.getValue(fifoBucketKey(index));
    if (!raw) return [];
    try { return JSON.parse(raw); } catch { return []; }
}

function writeFifoBucket(ctx: any, index: number, items: any[]): void {
    if (items.length === 0) {
        ctx.clearValue(fifoBucketKey(index));
    } else {
        ctx.setValue(fifoBucketKey(index), JSON.stringify(items));
    }
}

function fitsInBucket(bucket: any[]): boolean {
    return JSON.stringify(bucket).length <= MAX_BUCKET_BYTES;
}

/**
 * 1.0.82 (defect E): an item too large to store even in a bucket of its own.
 * Measured in UTF-8 bytes, as the runtime measures KV values.
 */
export function isFifoItemTooLarge(item: any): boolean {
    return Buffer.byteLength(JSON.stringify([item]), "utf8") > MAX_FIFO_ITEM_BYTES;
}

/** A queued timer's reason is display text; this much of it is kept in a compact timer item. */
const COMPACT_TIMER_REASON_CHARS = 2_000;

/**
 * 1.0.82 (defect E): the fields a queued timer item needs to run. A fired
 * timer is copied from the armed one, which may carry the whole turn's text
 * (a wait's `content`) or an input question and its choices; running the
 * item reads none of them. A timer item is the only copy of a fire the
 * session owes, so it is never refused: when it is too large, this compact
 * copy is stored instead. Timer items that fit are stored unchanged.
 */
function compactTimerItem(item: any): any {
    const timer = item?.timer ?? {};
    return {
        kind: "timer",
        timer: {
            type: timer.type,
            deadlineMs: timer.deadlineMs,
            originalDurationMs: timer.originalDurationMs,
            reason: typeof timer.reason === "string" ? timer.reason.slice(0, COMPACT_TIMER_REASON_CHARS) : timer.reason,
            ...(timer.shouldRehydrate ? { shouldRehydrate: true } : {}),
            ...(timer.gate ? { gate: timer.gate } : {}),
            ...(timer.budget ? { budget: true } : {}),
        },
        firedAtMs: item?.firedAtMs,
    };
}

function lastNonEmptyFifoBucket(ctx: any): number {
    for (let i = FIFO_BUCKET_COUNT - 1; i >= 0; i--) {
        if (readFifoBucket(ctx, i).length > 0) return i;
    }
    return 0;
}

/**
 * 1.0.82 (issue 192): re-pack every queued item from bucket 0, in order.
 *
 * Appends go after the last non-empty bucket and pops come from the first,
 * so while the FIFO is never empty the write position only moves forward.
 * Before 1.0.82 an append that reached a full last bucket was dropped, even
 * with every earlier bucket empty. Packing greedily from bucket 0 never needs
 * more buckets than the items already used, and it keeps their order.
 */
function compactFifo(runtime: DurableSessionRuntime): void {
    const { ctx } = runtime;
    const before: any[][] = [];
    for (let i = 0; i < FIFO_BUCKET_COUNT; i++) before.push(readFifoBucket(ctx, i));
    const packed: any[][] = [];
    let current: any[] = [];
    for (const item of before.flat()) {
        current.push(item);
        if (current.length > 1 && !fitsInBucket(current)) {
            current.pop();
            packed.push(current);
            current = [item];
        }
    }
    if (current.length > 0) packed.push(current);
    for (let i = 0; i < FIFO_BUCKET_COUNT; i++) {
        const next = packed[i] ?? [];
        if (JSON.stringify(next) !== JSON.stringify(before[i])) writeFifoBucket(ctx, i, next);
    }
    ctx.traceInfo(`[fifo] compacted ${before.flat().length} item(s) into ${packed.length} bucket(s) from bucket 0`);
}

/** Why an item was not stored: over the item cap, or no room even after compaction. */
export type FifoRefusalReason = "too-large" | "full";

/** The form an item is stored in: a timer item too large to queue is stored compact (defect E). */
function fifoStoredForm(item: any): any {
    return item?.kind === "timer" && isFifoItemTooLarge(item) ? compactTimerItem(item) : item;
}

/**
 * Append items in order. Returns the items that were not stored, in order,
 * as passed in: empty unless an item is too large for any bucket (defect E:
 * the runtime would fail the orchestration on the write) or all
 * FIFO_BUCKET_COUNT buckets are full even after compaction (1.0.82). When
 * `reasons` is given, it receives each returned item's reason, in the same
 * order. An item larger than a bucket but within MAX_FIFO_ITEM_BYTES still
 * gets a bucket of its own, as before.
 */
export function appendToFifo(runtime: DurableSessionRuntime, newItems: any[], reasons?: FifoRefusalReason[]): any[] {
    const { ctx } = runtime;
    let writeBucketIdx = lastNonEmptyFifoBucket(ctx);
    let compacted = false;
    const notStored: any[] = [];
    const refuse = (original: any, reason: FifoRefusalReason) => {
        notStored.push(original);
        reasons?.push(reason);
    };
    for (let n = 0; n < newItems.length; n++) {
        const original = newItems[n];
        const item = fifoStoredForm(original);
        if (isFifoItemTooLarge(item)) {
            refuse(original, "too-large");
            continue;
        }
        const bucket = readFifoBucket(ctx, writeBucketIdx);
        bucket.push(item);
        let stored = false;
        if (bucket.length === 1 || fitsInBucket(bucket)) {
            writeFifoBucket(ctx, writeBucketIdx, bucket);
            stored = true;
        } else if (writeBucketIdx + 1 < FIFO_BUCKET_COUNT) {
            writeBucketIdx++;
            writeFifoBucket(ctx, writeBucketIdx, [item]);
            stored = true;
        } else if (!compacted) {
            compacted = true;
            compactFifo(runtime);
            writeBucketIdx = lastNonEmptyFifoBucket(ctx);
            n--;
            continue;
        }
        if (stored) {
            if (item !== original) ctx.traceInfo(`[fifo] a ${item.timer.type} timer item was too large to queue; queued its compact form`);
            continue;
        }
        for (const rest of newItems.slice(n)) refuse(rest, isFifoItemTooLarge(fifoStoredForm(rest)) ? "too-large" : "full");
        return notStored;
    }
    return notStored;
}

function popFifoItem(runtime: DurableSessionRuntime): any | null {
    const { ctx } = runtime;
    for (let i = 0; i < FIFO_BUCKET_COUNT; i++) {
        const items = readFifoBucket(ctx, i);
        if (items.length > 0) {
            const [first, ...rest] = items;
            writeFifoBucket(ctx, i, rest);
            return first;
        }
    }
    return null;
}

function isInteractiveFifoItem(item: any): boolean {
    return item?.kind === "prompt" || item?.kind === "answer";
}

/**
 * Pop the next item to dispatch: the first prompt or answer anywhere in the
 * FIFO, else the head. `before` is how many queued items preceded it; they
 * are all non-interactive, and the merge scan starts right after them.
 */
function popNextDispatchFifoItem(runtime: DurableSessionRuntime): { item: any; before: number } | null {
    const { ctx } = runtime;
    let before = 0;
    for (let i = 0; i < FIFO_BUCKET_COUNT; i++) {
        const items = readFifoBucket(ctx, i);
        const index = items.findIndex(isInteractiveFifoItem);
        if (index >= 0) {
            const [item] = items.splice(index, 1);
            writeFifoBucket(ctx, i, items);
            if (before + index > 0) ctx.traceInfo(`[fifo] dispatching interactive ${item.kind} before queued timers`);
            return { item, before: before + index };
        }
        before += items.length;
    }
    const head = popFifoItem(runtime);
    return head ? { item: head, before: 0 } : null;
}

/** Timer items of one kind are interchangeable: one fire runs the schedule once. */
function timerItemKind(item: any): string | null {
    if (item?.kind !== "timer" || !item.timer) return null;
    return `${item.timer.type}|${timerGate(item.timer) ?? ""}`;
}

/** 1.0.82 (R5): running a timer item removes the other queued items of its kind. */
function removeQueuedTimerItemsOfKind(runtime: DurableSessionRuntime, kind: string): number {
    const { ctx } = runtime;
    let removed = 0;
    for (let i = 0; i < FIFO_BUCKET_COUNT; i++) {
        const items = readFifoBucket(ctx, i);
        const kept = items.filter((item) => timerItemKind(item) !== kind);
        if (kept.length !== items.length) {
            removed += items.length - kept.length;
            writeFifoBucket(ctx, i, kept);
        }
    }
    if (removed > 0) ctx.traceInfo(`[fifo] coalesced ${removed} queued ${kind.split("|")[0]} timer item(s) into the one now running`);
    return removed;
}

function queuedTimerItemKinds(runtime: DurableSessionRuntime): Set<string> {
    const kinds = new Set<string>();
    for (let i = 0; i < FIFO_BUCKET_COUNT; i++) {
        for (const item of readFifoBucket(runtime.ctx, i)) {
            const kind = timerItemKind(item);
            if (kind) kinds.add(kind);
        }
    }
    return kinds;
}

function fifoHasInteractiveItems(runtime: DurableSessionRuntime): boolean {
    for (let i = 0; i < FIFO_BUCKET_COUNT; i++) {
        if (readFifoBucket(runtime.ctx, i).some(isInteractiveFifoItem)) return true;
    }
    return false;
}

function hasFifoItems(runtime: DurableSessionRuntime): boolean {
    const { ctx } = runtime;
    for (let i = 0; i < FIFO_BUCKET_COUNT; i++) {
        if (readFifoBucket(ctx, i).length > 0) return true;
    }
    return false;
}

/**
 * 1.0.82 (R8, defect E): report items that were not stored, with an error
 * trace and one session.fifo_overflow event naming each item's reason
 * (`too-large` or `full`). Their ids are not marked as seen, so a resend runs.
 */
function* reportUnstoredItems(runtime: DurableSessionRuntime, lostItems: any[], reasons: string[]): Generator<any, void, any> {
    const { ctx } = runtime;
    if (lostItems.length === 0) return;
    const lostIds = lostItems.flatMap((item) => validClientMessageIds(item?.clientMessageIds));
    const tooLarge = reasons.filter((reason) => reason === "too-large").length;
    const message = `[fifo] ${lostItems.length} item(s) not stored: ` +
        [
            tooLarge > 0 ? `${tooLarge} over the ${MAX_FIFO_ITEM_BYTES}-byte item limit` : "",
            tooLarge < lostItems.length ? `${lostItems.length - tooLarge} because the FIFO is full` : "",
        ].filter(Boolean).join(", ") +
        (lostIds.length > 0 ? ` (clientMessageIds=${lostIds.join(",")})` : "");
    // R8: an item that is really lost is an error, not a warning.
    if (typeof ctx.traceError === "function") ctx.traceError(message);
    else ctx.traceInfo(message);
    yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
        eventType: "session.fifo_overflow",
        data: {
            lostCount: lostItems.length,
            clientMessageIds: lostIds,
            kinds: lostItems.map((item) => item?.kind ?? "unknown"),
            reasons,
            maxItemBytes: MAX_FIFO_ITEM_BYTES,
        },
    }]);
}

/**
 * Move a drain stash into the FIFO. Returns the stash items that were not
 * stored, so a caller can forget their ids as pending and give back the
 * owed work they carried.
 *
 * 1.0.82: a timer item whose kind is already queued is not added (R5); a
 * single fire runs the schedule once. Items that do not fit even after
 * compaction are reported, with their client message ids, instead of being
 * dropped with an info line; their ids are not marked as seen, so a resend
 * runs (R8).
 */
function* appendPromptStashToFifo(runtime: DurableSessionRuntime, stash: any[]): Generator<any, any[], any> {
    const { ctx, state } = runtime;
    const kinds = queuedTimerItemKinds(runtime);
    const items = stash.filter((item) => {
        const kind = timerItemKind(item);
        if (!kind) return true;
        if (kinds.has(kind)) {
            ctx.traceInfo(`[fifo] a ${item.timer.type} timer item is already queued; not queueing another`);
            return false;
        }
        kinds.add(kind);
        return true;
    });
    const reasons: FifoRefusalReason[] = [];
    const lostItems = appendToFifo(runtime, items, reasons);
    const lost = new Set(lostItems);
    for (const item of items) {
        if (item?.kind !== "prompt" || lost.has(item)) continue;
        touchRecentClientMessageIds(state, validClientMessageIds(item.clientMessageIds));
    }
    if (lostItems.length === 0) return [];
    yield* reportUnstoredItems(runtime, lostItems, reasons);
    return lostItems;
}

/**
 * 1.0.82 (issue 192, defect E review): owed work that a stashed prompt took
 * into its text. When the prompt is not queued after all (the FIFO is full,
 * or it is cancelled in the same pass), the work is given back.
 */
interface CarriedWork {
    digest?: PendingChildDigest;
    rehydrationMessage?: string;
}

function giveBackCarriedWork(
    runtime: DurableSessionRuntime,
    carriedByItem: Map<any, CarriedWork>,
    items: any[],
    chronology: (entry: PendingChildDigest["updates"][number]) => number,
): void {
    const { ctx, state } = runtime;
    for (const item of items) {
        const carried = carriedByItem.get(item);
        if (!carried) continue;
        carriedByItem.delete(item);
        if (carried.digest) {
            restorePendingChildDigest(runtime, carried.digest, chronology);
            ctx.traceInfo(`[drain] a prompt that was not queued gave back the child digest it carried (${carried.digest.updates.length} update(s))`);
        }
        if (carried.rehydrationMessage !== undefined && state.pendingRehydrationMessage === undefined) {
            state.pendingRehydrationMessage = carried.rehydrationMessage;
        }
    }
}

function duplicateClientMessageIds(
    runtime: DurableSessionRuntime,
    ids: string[],
    pendingIds: Set<string>,
): string[] {
    if (ids.length === 0) return [];
    const recent = new Set(runtime.state.recentClientMessageIds);
    return ids.filter((id) => recent.has(id) || pendingIds.has(id));
}

function* recordDuplicatePrompt(
    runtime: DurableSessionRuntime,
    ids: string[],
    duplicateIds: string[],
    source: string,
): Generator<any, void, any> {
    const recent = new Set(runtime.state.recentClientMessageIds);
    touchRecentClientMessageIds(runtime.state, duplicateIds.filter((id) => recent.has(id)));
    runtime.ctx.traceInfo(`[${source}] suppressing duplicate prompt (duplicateIds=${duplicateIds.join(",")})`);
    yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
        eventType: "session.message_duplicate_suppressed",
        data: {
            clientMessageIds: ids,
            duplicateClientMessageIds: duplicateIds,
            windowSize: 20,
            source,
        },
    }]);
}

// ─── Timer race candidate selection ─────────────────────────

/** Timer types whose expiry runs a turn — the only ones a child digest can ride into. */
const TURN_RUNNING_TIMER_TYPES: ReadonlySet<ActiveTimer["type"]> = new Set(["wait", "cron", "cron_at"]);

function nextTimerCandidate(
    activeTimer: ActiveTimer | null,
    pendingChildDigest: PendingChildDigest | null,
    now: number,
    opts: { batchMs?: number; digestHasError?: boolean } = {},
): { kind: "active" | "child-digest"; remainingMs: number; timer?: ActiveTimer } | null {
    const candidates: Array<{ kind: "active" | "child-digest"; remainingMs: number; timer?: ActiveTimer }> = [];
    if (activeTimer) {
        candidates.push({
            kind: "active",
            remainingMs: Math.max(0, activeTimer.deadlineMs - now),
            timer: activeTimer,
        });
    }
    if (pendingChildDigest && !pendingChildDigest.ready && pendingChildDigest.updates.length > 0) {
        // ≥1.0.71: if the parent's own wait/cron fires within the coalesce
        // window anyway, the digest waits for that turn and rides into its
        // prompt (processTimer flushes it) instead of waking the parent on
        // its own. A child failure or cancellation still wakes at once.
        // Idle / agent-poll / input-grace timers do not run a turn on expiry,
        // so they never count as "will wake anyway".
        const holdForTimer = Boolean(
            activeTimer
            && TURN_RUNNING_TIMER_TYPES.has(activeTimer.type)
            && activeTimer.deadlineMs - now <= CHILD_DIGEST_COALESCE_MS
            && !opts.digestHasError,
        );
        if (!holdForTimer) {
            const batchMs = opts.batchMs ?? CHILD_UPDATE_BATCH_MS;
            candidates.push({
                kind: "child-digest",
                remainingMs: Math.max(0, pendingChildDigest.startedAtMs + batchMs - now),
            });
        }
    }
    if (candidates.length === 0) return null;
    candidates.sort((left, right) => left.remainingMs - right.remainingMs);
    return candidates[0];
}

// ─── drain: greedily move queue events + timer fires into KV FIFO ──

function hasReadyPendingChildDigest(runtime: DurableSessionRuntime): boolean {
    const digest = runtime.state.pendingChildDigest;
    return Boolean(digest?.ready && digest.updates.length > 0);
}

function needsBlockingDequeue(runtime: DurableSessionRuntime): boolean {
    const { state } = runtime;
    return (
        state.legacyPendingMessage === undefined &&
        !state.activeTimer &&
        !hasReadyPendingChildDigest(runtime) &&
        state.pendingToolActions.length === 0 &&
        !state.pendingPrompt &&
        !hasFifoItems(runtime)
    );
}

/**
 * 1.0.82 (issue 192, R3): queued work runs at once instead of waiting for the
 * armed timer, the next message or the digest window to close.
 *
 * A queued prompt or answer never waits for a timer: a person's message goes
 * right after the previous turn, in the order it arrived. A queued timer item
 * (a fired cron, wait or idle timer) runs at once under idle, cron, cron_at or
 * an ungated wait; behind a gate, input-grace or an agent wait it waits as
 * before. With no timer armed and only a digest window open, timer items keep
 * the window's deadline. Nothing changes during a graceful shutdown.
 */
function shouldRunQueuedWorkNow(runtime: DurableSessionRuntime, stash: any[]): boolean {
    const { state } = runtime;
    if (state.pendingShutdown) return false;
    const timer = state.activeTimer;
    const digestOpen = Boolean(state.pendingChildDigest && !state.pendingChildDigest.ready);
    if (!timer && !digestOpen) return false;
    if (stash.some(isInteractiveFifoItem) || fifoHasInteractiveItems(runtime)) return true;
    if (!timer || (stash.length === 0 && !hasFifoItems(runtime))) return false;
    return timer.type === "idle" || timer.type === "cron" || timer.type === "cron_at"
        || (timer.type === "wait" && !timerGate(timer));
}

/**
 * Release the armed timer for queued work, exactly as a newly arrived message
 * releases it in drain below, but without adding text to any prompt: a cron or
 * wait keeps its remaining time and is re-armed after the turn; a cron_at keeps
 * its next fire; idle is armed again after the turn; an agent wait ends; a gate
 * is asked again by the turn. New in 1.0.82: input-grace ends early, and the
 * question stays open.
 *
 * A due cron, cron_at or plain wait is a fire the session still owes, so it
 * becomes a timer item that runs after the waiting work. Any other released
 * timer is recorded, and armed again as it was if no turn runs
 * (settleQueuedWorkAfterDecide): the queued prompt can be cancelled, or the
 * queued timer item can be one that runs no turn.
 */
function* releaseTimerForQueuedWork(runtime: DurableSessionRuntime, stash: any[]): Generator<any, void, any> {
    const { ctx, state } = runtime;
    const timer = state.activeTimer;
    if (!timer) return;
    const now: number = yield ctx.utcNow();
    const remainingMs = Math.max(0, timer.deadlineMs - now);
    const interactive = stash.some(isInteractiveFifoItem) || fifoHasInteractiveItems(runtime);
    state.activeTimer = null;
    // A wait with under half a second left would be saved as 0 s and never
    // resumed (schedulePostTurnContinuation needs remainingSec > 0), so it
    // counts as due.
    const due = remainingMs === 0 || (timer.type === "wait" && Math.round(remainingMs / 1000) === 0);
    const owedFire = timer.type === "cron" || timer.type === "cron_at" || (timer.type === "wait" && !timerGate(timer));
    if (due && owedFire) {
        stash.push({ kind: "timer", timer: { ...timer }, firedAtMs: now });
        ctx.traceInfo(`[drain] ${timer.type} timer was due; queued it after the waiting work`);
        return;
    }
    const released: ReleasedTimerRecord = {
        timer: { ...timer },
        priorInterruptedWait: state.interruptedWaitTimer,
        priorInterruptedCron: state.interruptedCronTimer,
        waitingForAgentIds: state.waitingForAgentIds,
    };
    if (!due && timer.type === "wait") {
        state.interruptedWaitTimer = {
            remainingSec: Math.round(remainingMs / 1000),
            reason: timer.reason,
            shouldRehydrate: timer.shouldRehydrate ?? false,
            waitPlan: timer.waitPlan,
            interruptKind: interactive ? "user" : "child",
            budget: timer.budget === true,
            ...(timerGate(timer) ? { gate: timerGate(timer) } : {}),
        };
        released.savedInterruptedWait = state.interruptedWaitTimer;
    } else if (!due && timer.type === "cron") {
        state.interruptedCronTimer = {
            remainingMs,
            reason: timer.reason,
            originalDurationMs: timer.originalDurationMs,
            ...(timer.shouldRehydrate ? { shouldRehydrate: true } : {}),
        };
        released.savedInterruptedCron = state.interruptedCronTimer;
    }
    // Queued work ends an agent wait whether or not its poll is already due;
    // a due poll is not queued, so it cannot revive the wait after the turn.
    if (timer.type === "agent-poll") state.waitingForAgentIds = null;
    runtime.releasedForQueuedWork = released;
    ctx.traceInfo(`[drain] queued ${interactive ? "prompts" : "timer items"} released the ${timer.type} timer, ${Math.round(remainingMs / 1000)}s remained`);
}

/** Turns processPrompt has started in this execution (see DurableSessionRuntime.turnsStarted). */
export function turnsStarted(runtime: DurableSessionRuntime): number {
    return runtime.turnsStarted ?? 0;
}

/** Timer items whose only effect is on the hold window; they run no turn. */
const HOLD_TIMER_TYPES = new Set(["idle", "input-grace"]);

/**
 * 1.0.82: whether a queued timer item is stale while a live timer is released
 * for it. Idle and input-grace items only act on the hold window, which the
 * live timer owns. An agent-poll item is stale only when no agent wait is
 * live: while one is, the poll is what resolves it or arms its next poll.
 */
function isStaleWhileReleased(runtime: DurableSessionRuntime, item: any): boolean {
    const type = item?.timer?.type;
    if (HOLD_TIMER_TYPES.has(type)) return true;
    return type === "agent-poll" && !runtime.state.waitingForAgentIds;
}

/**
 * 1.0.82 (issue 192): called by the run loop after every decide, and before
 * each regeneration stage (which bypasses decide).
 *
 * When a turn was attempted (whatever its outcome), the turn path owns the
 * timers: the record is dropped, and queued idle and input-grace items are
 * removed, because the turn restarted the hold window and running them would
 * release the worker or replace the timer the turn armed.
 *
 * When no turn was attempted:
 * - if work that will run a turn next is now pending (a follow-up the agent
 *   wait does not hold, or queued tool actions), the record is kept, so that
 *   work runs at once and its turn re-arms the timer as usual;
 * - otherwise, unless something armed a newer timer, the released timer is
 *   armed again exactly as it was and what the release saved is undone, so a
 *   schedule, a wait or a gate retry is never stranded (a cancelled prompt, a
 *   timer item that ran no turn).
 */
export function settleQueuedWorkAfterDecide(runtime: DurableSessionRuntime, turnsBefore: number): void {
    const { ctx, state } = runtime;
    const released = runtime.releasedForQueuedWork;
    if (turnsStarted(runtime) !== turnsBefore) {
        runtime.releasedForQueuedWork = undefined;
        removeQueuedTimerItemsOfKind(runtime, "idle|");
        removeQueuedTimerItemsOfKind(runtime, "input-grace|");
        return;
    }
    if (!released) return;
    if (state.activeTimer) {
        // Something armed a newer timer without a turn; it stands.
        runtime.releasedForQueuedWork = undefined;
        return;
    }
    const waitingAfterRestore = state.waitingForAgentIds
        ?? (released.timer.type === "agent-poll" ? released.waitingForAgentIds : null);
    if (state.pendingToolActions.length > 0 || (state.pendingPrompt && !waitingAfterRestore)) {
        ctx.traceInfo(`[orch] queued work left a follow-up to run; the ${released.timer.type} timer stays released for it`);
        return;
    }
    runtime.releasedForQueuedWork = undefined;
    state.activeTimer = released.timer;
    if (released.savedInterruptedWait && state.interruptedWaitTimer === released.savedInterruptedWait) {
        state.interruptedWaitTimer = released.priorInterruptedWait;
    }
    if (released.savedInterruptedCron && state.interruptedCronTimer === released.savedInterruptedCron) {
        state.interruptedCronTimer = released.priorInterruptedCron;
    }
    if (released.timer.type === "agent-poll" && !state.waitingForAgentIds && released.waitingForAgentIds) {
        state.waitingForAgentIds = released.waitingForAgentIds;
    }
    ctx.traceInfo(`[orch] no turn ran for the queued work; the ${released.timer.type} timer is armed again`);
}

export function* drain(runtime: DurableSessionRuntime): Generator<any, void, any> {
    const { ctx, state } = runtime;
    const stash: any[] = [];
    const seenChildUpdates = new Set<string>();
    const cancelledThisDrain = new Set<string>();
    const pendingClientMessageIds = new Set<string>();
    // 1.0.82 (defect E): a prompt or answer refused on arrival collected
    // nothing, but the pass goes on sweeping for the messages behind it.
    let refusedThisPass = false;
    // 1.0.82 (defect E review): the owed work each stashed prompt carries,
    // and for each child update, the n-th digest a prompt took it in this
    // pass. An update no prompt has taken is newer than every taken one, so
    // giving back several digests keeps each child's newest update.
    const carriedByItem = new Map<any, CarriedWork>();
    const digestTakenAt = new WeakMap<object, number>();
    let digestsTaken = 0;
    const updateChronology = (entry: object) => digestTakenAt.get(entry) ?? Number.MAX_SAFE_INTEGER;

    for (let i = 0; i < MAX_DRAIN_PER_TURN; i++) {
        let msg: any = null;

        if (state.legacyPendingMessage !== undefined) {
            msg = state.legacyPendingMessage;
            state.legacyPendingMessage = undefined;

        } else if (state.regen) {
            // Session regeneration: while a pipeline is pending, drain does a
            // SINGLE non-blocking sweep for a pre-empting control cmd
            // (cancel_regen / cancel / delete) and then yields to the run loop
            // to advance the next stage. It must never park on the session's
            // armed idle/affinity/cron timer (up to 30 min) or on a blocking
            // dequeue — either would stall the flip indefinitely.
            const msgTask = ctx.dequeueEvent("messages");
            const timerTask = ctx.scheduleTimer(NON_BLOCKING_TIMER_MS);
            const race: any = yield ctx.race(msgTask, timerTask);
            if (race.index === 1) break;
            msg = typeof race.value === "string" ? JSON.parse(race.value) : race.value;

        } else if (shouldRunQueuedWorkNow(runtime, stash)) {
            // 1.0.82 (R3, R4): queued work goes now; the armed timer is
            // released as a new message would release it. This comes before
            // the carried-steers branch, so queued work that carries steers
            // also keeps its timer's time (issue 192 review).
            yield* releaseTimerForQueuedWork(runtime, stash);
            const raced: any = yield ctx.race(
                ctx.dequeueEvent("messages"),
                ctx.scheduleTimer(NON_BLOCKING_TIMER_MS),
            );
            if (raced.index === 1) break;
            msg = typeof raced.value === "string" ? JSON.parse(raced.value) : raced.value;

        } else if (state.carriedSteers.length > 0 && !state.pendingInputQuestion && !state.pendingShutdown && !timerGate(state.activeTimer)) {
            // A follow-up held by an agent wait is pending work that decide
            // will not dispatch. End the wait as a new message would, and let
            // the follow-up carry the steers; breaking with it still held
            // made the run loop spin without yielding.
            if (state.pendingPrompt && state.waitingForAgentIds) {
                ctx.traceInfo(`[drain] carried steers interrupted agent wait`);
                state.waitingForAgentIds = null;
                if (state.activeTimer?.type === "agent-poll") state.activeTimer = null;
            }
            // Give already-pending work priority. Otherwise the carry enters
            // the same timer-interrupt path as a newly arrived message.
            if (state.pendingPrompt || state.pendingToolActions.length > 0) break;
            const raced: any = yield ctx.race(
                ctx.dequeueEvent("messages"),
                ctx.scheduleTimer(NON_BLOCKING_TIMER_MS),
            );
            if (raced.index === 1) {
                // 1.0.82 (R10): queued or collected work carries the steers;
                // the wake marker is only for a session with nothing else.
                if (stash.length > 0 || hasFifoItems(runtime)) break;
                msg = { prompt: CARRIED_STEERS_WAKE_PROMPT, bootstrap: true, carriedSteersWake: true };
            } else {
                msg = typeof raced.value === "string" ? JSON.parse(raced.value) : raced.value;
            }

        } else if (state.activeTimer || (state.pendingChildDigest && !state.pendingChildDigest.ready)) {
            const now: number = yield ctx.utcNow();
            const candidate = nextTimerCandidate(state.activeTimer, state.pendingChildDigest, now, {
                batchMs: childUpdateBatchMs(state.subAgents?.length ?? 0),
                digestHasError: pendingChildDigestHasError(runtime),
            });
            if (!candidate) continue;

            if (candidate.remainingMs === 0) {
                if (candidate.kind === "active" && candidate.timer) {
                    stash.push({ kind: "timer", timer: { ...candidate.timer }, firedAtMs: now });
                    state.activeTimer = null;
                } else if (state.pendingChildDigest && state.pendingChildDigest.updates.length > 0) {
                    state.pendingChildDigest.ready = true;
                    break;
                }
                continue;
            }

            const msgTask = ctx.dequeueEvent("messages");
            const timerTask = ctx.scheduleTimer(candidate.remainingMs);
            const race: any = yield ctx.race(msgTask, timerTask);

            if (race.index === 1) {
                if (candidate.kind === "active" && candidate.timer) {
                    const firedAt: number = yield ctx.utcNow();
                    stash.push({ kind: "timer", timer: { ...candidate.timer }, firedAtMs: firedAt });
                    state.activeTimer = null;
                } else if (state.pendingChildDigest && state.pendingChildDigest.updates.length > 0) {
                    state.pendingChildDigest.ready = true;
                    break;
                }
                continue;
            }

            msg = typeof race.value === "string" ? JSON.parse(race.value) : race.value;

        } else if (!state.regen && needsBlockingDequeue(runtime) && !stash.some((item) => item.kind !== "timer")
            && !(refusedThisPass && stash.length === 0)) {
            // 1.0.82 (R10): once this pass has collected a message, the
            // 10 ms sweep below keeps collecting until the queue is empty, so
            // messages that arrived during one turn run together in the next.
            // A fired timer alone still runs at once, at its scheduled time.
            // A refusal with nothing collected yet also sweeps (defect E).
            if (i > 0) break;
            if (state.pendingInputQuestion) {
                publishStatus(runtime, "input_required");
            } else if (state.blockedError) {
                publishStatus(runtime, "error", {
                    error: state.blockedError.message,
                    retriesExhausted: true,
                    ...(state.blockedError.authFailure ? { authFailure: true } : {}),
                });
            } else {
                publishStatus(runtime, "idle");
            }
            const rawMsg: any = yield ctx.dequeueEvent("messages");
            msg = typeof rawMsg === "string" ? JSON.parse(rawMsg) : rawMsg;

        } else {
            const msgTask = ctx.dequeueEvent("messages");
            const timerTask = ctx.scheduleTimer(NON_BLOCKING_TIMER_MS);
            const race: any = yield ctx.race(msgTask, timerTask);
            if (race.index === 1) break;
            msg = typeof race.value === "string" ? JSON.parse(race.value) : race.value;
        }

        if (!msg) continue;

        if (msg && Array.isArray(msg.cancelPending) && msg.cancelPending.length > 0) {
            const validCancelIds: string[] = [];
            for (const id of msg.cancelPending) {
                if (typeof id === "string" && id) {
                    validCancelIds.push(id);
                    cancelledThisDrain.add(id);
                }
            }
            addCancelledMessageIds(state, validCancelIds);
            if (validCancelIds.length > 0) {
                ctx.traceInfo(`[drain] received cancel tombstone (ids=${validCancelIds.join(",")})`);
            }
            for (let s = stash.length - 1; s >= 0; s--) {
                const item = stash[s];
                if (item?.kind !== "prompt") continue;
                const ids: string[] = Array.isArray(item.clientMessageIds) ? item.clientMessageIds : [];
                if (ids.some((id) => cancelledThisDrain.has(id))) {
                    ctx.traceInfo(`[drain] dropping stashed prompt cancelled by tombstone (ids=${ids.join(",")})`);
                    yield* dropCancelledPrompt(runtime, ids, "drain-stash");
                    giveBackCarriedWork(runtime, carriedByItem, [item], updateChronology);
                    stash.splice(s, 1);
                }
            }
            continue;
        }

        if (msg.type === "cmd") {
            if (stash.length > 0) {
                // 1.0.82 (R8): an id that was not stored is not pending, so a
                // resend later in this pass is not taken for a duplicate; the
                // owed work a refused prompt carried is given back.
                const lostItems: any[] = yield* appendPromptStashToFifo(runtime, stash);
                giveBackCarriedWork(runtime, carriedByItem, lostItems, updateChronology);
                for (const item of lostItems) {
                    for (const id of validClientMessageIds(item?.clientMessageIds)) pendingClientMessageIds.delete(id);
                }
                carriedByItem.clear();
                stash.length = 0;
            }
            yield* handleCommand(runtime, msg as CommandMessage);
            if (state.orchestrationResult !== null) return;
            // Session regeneration: a pending pipeline is advanced by the run
            // loop — return control instead of draining on (a blocking
            // dequeue here would park the session with the regen never
            // starting). Later cmds still pre-empt: the loop re-enters drain
            // between stages and this pass is non-blocking while regen is set.
            if (state.regen) return;
            continue;
        }

        const childUpdate = parseChildUpdate(msg.prompt);
        if (childUpdate) {
            const key = `${childUpdate.sessionId}|${childUpdate.updateType}|${childUpdate.content ?? ""}`;
            if (!seenChildUpdates.has(key)) {
                seenChildUpdates.add(key);
                const wasExpectingReport = state.subAgents.find(
                    (agent) => agent.sessionId === childUpdate.sessionId,
                )?.expectsReport === true;
                const tracked = yield* applyChildUpdate(runtime, childUpdate);
                if (tracked && !state.pendingShutdown) {
                    const childObservedAt: number = yield ctx.utcNow();
                    bufferChildUpdate(runtime, childUpdate, childObservedAt);
                    // Fast-path only on a FIRST report from a child spawned with
                    // an outstanding expectation — routine later updates keep
                    // the normal batch window.
                    if (wasExpectingReport) markDigestReadyIfAllAgentsSettled(runtime);
                }
                if (tracked && state.waitingForAgentIds) {
                    yield* maybeResolveAgentWaitCompletion(runtime);
                }
            }
            continue;
        }

        if (msg.answer !== undefined) {
            const answerItem = { kind: "answer", expectedQuestion: msg.expectedQuestion !== undefined ? msg.expectedQuestion : state.pendingInputQuestion ? { question: state.pendingInputQuestion.question, iteration: state.pendingInputQuestion.iteration ?? state.iteration } : null, answer: msg.answer, wasFreeform: msg.wasFreeform, ...(msg.sender && typeof msg.sender === "object" ? { sender: msg.sender } : {}) };
            // 1.0.82 (defect E): an answer too large to queue is refused
            // before anything changes: the question stays open and its hold
            // timer keeps running.
            if (isFifoItemTooLarge(answerItem)) {
                yield* reportUnstoredItems(runtime, [answerItem], ["too-large"]);
                refusedThisPass = true;
                continue;
            }
            const interruptsInputHold = Boolean(state.pendingInputQuestion)
                && (state.activeTimer?.type === "input-grace" || state.activeTimer?.type === "idle");
            if (interruptsInputHold) {
                ctx.traceInfo(`[drain] answer interrupted ${state.activeTimer!.type} timer`);
                // 1.0.82: an answer that runs no turn (not stored because the
                // FIFO is full) gets its hold timer back after decide, as a
                // prompt does.
                if (!runtime.releasedForQueuedWork) {
                    runtime.releasedForQueuedWork = {
                        timer: { ...state.activeTimer! },
                        priorInterruptedWait: state.interruptedWaitTimer,
                        priorInterruptedCron: state.interruptedCronTimer,
                        waitingForAgentIds: state.waitingForAgentIds,
                    };
                }
                state.activeTimer = null;
            }
            stash.push(answerItem);
            if (interruptsInputHold) break;
            continue;
        }

        if (msg.prompt) {
            const incomingClientMessageIds: string[] = validClientMessageIds(msg.clientMessageIds);
            if (promptIdsIntersectCancellation(runtime, incomingClientMessageIds)) {
                ctx.traceInfo(`[drain] dropping incoming prompt cancelled by tombstone (ids=${incomingClientMessageIds.join(",")})`);
                yield* dropCancelledPrompt(runtime, incomingClientMessageIds, "drain-incoming");
                continue;
            }

            const duplicateIds = duplicateClientMessageIds(runtime, incomingClientMessageIds, pendingClientMessageIds);
            if (duplicateIds.length > 0) {
                yield* recordDuplicatePrompt(runtime, incomingClientMessageIds, duplicateIds, "drain");
                continue;
            }

            // The item as it is queued; drain may add a timer note and the
            // buffered child digest to its prompt below.
            const incomingAttachments = sanitizePromptAttachmentRefs(msg.attachments);
            const baseItem = {
                kind: "prompt",
                prompt: msg.prompt,
                bootstrap: Boolean(msg.bootstrap),
                ...(msg.carriedSteersWake === true ? { carriedSteersWake: true } : {}),
                ...(msg.requiredTool ? { requiredTool: msg.requiredTool } : {}),
                ...(incomingClientMessageIds.length > 0 ? { clientMessageIds: incomingClientMessageIds } : {}),
                ...(msg.sender && typeof msg.sender === "object" ? { sender: msg.sender } : {}),
                ...(incomingAttachments.length > 0 ? { attachments: incomingAttachments } : {}),
            };
            // 1.0.82 (defect E): a prompt too large to queue is refused before
            // anything changes: no timer is released, no child digest is
            // taken, and its id is not pending, so a resend that fits runs.
            if (isFifoItemTooLarge(baseItem)) {
                yield* reportUnstoredItems(runtime, [baseItem], ["too-large"]);
                refusedThisPass = true;
                continue;
            }
            const rehydrationMessageBefore = state.pendingRehydrationMessage;

            let userPrompt = msg.prompt;
            state.blockedError = undefined;
            // 1.0.82: remember the timer this message releases, so that it is
            // armed again if the message is cancelled before its turn runs
            // (settleQueuedWorkAfterDecide).
            const releasing = runtime.releasedForQueuedWork ? null : state.activeTimer;
            const priorInterruptedWait = state.interruptedWaitTimer;
            const priorInterruptedCron = state.interruptedCronTimer;
            const priorWaitingForAgentIds = state.waitingForAgentIds;

            if (state.activeTimer?.type === "wait") {
                const now: number = yield ctx.utcNow();
                const remainingMs = Math.max(0, state.activeTimer.deadlineMs - now);
                const remainingSec = Math.round(remainingMs / 1000);
                const elapsedMs = state.activeTimer.originalDurationMs - remainingMs;
                const elapsedSec = Math.round(elapsedMs / 1000);
                const totalSec = Math.round(state.activeTimer.originalDurationMs / 1000);
                ctx.traceInfo(`[drain] user prompt interrupted wait timer, ${remainingSec}s remain — orchestration will auto-resume`);

                state.interruptedWaitTimer = {
                    remainingSec,
                    reason: state.activeTimer.reason,
                    shouldRehydrate: state.activeTimer.shouldRehydrate ?? false,
                    waitPlan: state.activeTimer.waitPlan,
                    interruptKind: "user",
                    budget: state.activeTimer.budget === true,
                    ...(timerGate(state.activeTimer) ? { gate: timerGate(state.activeTimer) } : {}),
                };

                if (state.activeTimer.shouldRehydrate && userPrompt) {
                    userPrompt = wrapWithResumeContext(
                        runtime,
                        userPrompt,
                        `Your ${totalSec}s timer (reason: "${state.activeTimer.reason}") was interrupted by the above message. ` +
                        `${elapsedSec}s elapsed, ${remainingSec}s remain. ` +
                        `Reply to the message. The timer will be automatically resumed after your reply.`,
                    );
                } else if (userPrompt) {
                    userPrompt = `${userPrompt}\n\n` +
                        `[SYSTEM: The above is a message that interrupted your ${totalSec}s timer (reason: "${state.activeTimer.reason}"). ` +
                        `${elapsedSec}s elapsed, ${remainingSec}s remain. ` +
                        `Reply to the message. The timer will be automatically resumed after your reply.]`;
                }
                state.activeTimer = null;
            } else if (state.activeTimer?.type === "cron") {
                const activeCron = state.cronSchedule;
                const now: number = yield ctx.utcNow();
                const remainingMs = Math.max(0, state.activeTimer.deadlineMs - now);
                state.interruptedCronTimer = {
                    remainingMs,
                    reason: state.activeTimer.reason,
                    originalDurationMs: state.activeTimer.originalDurationMs,
                    ...(state.activeTimer.shouldRehydrate ? { shouldRehydrate: true } : {}),
                };
                const cronResumeNote =
                    `This is an internal recurring schedule, not a new user prompt. ` +
                    `There is an active recurring schedule every ${activeCron?.intervalSeconds ?? "?"} seconds for "${activeCron?.reason ?? state.activeTimer.reason}". ` +
                    `The next cron wake-up will keep the original schedule and resume after the remaining ${Math.round(remainingMs / 1000)} seconds unless you explicitly reset cron. ` +
                    `Do NOT call wait() just to keep the recurring loop alive. ` +
                    `Call cron(action="cancel") only if you need to stop it.`;
                if (state.activeTimer.shouldRehydrate && userPrompt) {
                    userPrompt = wrapWithResumeContext(runtime, userPrompt, cronResumeNote);
                } else if (userPrompt) {
                    userPrompt = `${userPrompt}\n\n[SYSTEM: ${cronResumeNote}]`;
                }
                ctx.traceInfo(`[drain] user prompt interrupted cron timer`);
                state.activeTimer = null;
            } else if (state.activeTimer?.type === "cron_at") {
                const activeCronAt = state.cronAtSchedule;
                const now: number = yield ctx.utcNow();
                const remainingMs = Math.max(0, state.activeTimer.deadlineMs - now);
                const scheduledAt = activeCronAt?.nextFireAtMs ? new Date(activeCronAt.nextFireAtMs).toISOString() : "unknown";
                const cronAtResumeNote =
                    `This is an internal wall-clock recurring schedule, not a new user prompt. ` +
                    `There is an active wall-clock schedule for "${activeCronAt?.reason ?? state.activeTimer.reason}". ` +
                    `The pending scheduled fire (${scheduledAt}) is preserved and will run after this turn completes; ` +
                    `if the scheduled time passes while you respond, it will fire immediately afterward unless you explicitly cancel or reset the schedule. ` +
                    `Do NOT call wait() just to keep the recurring loop alive. ` +
                    `Call cron_at(action="cancel") only if you need to stop it.`;
                if (state.activeTimer.shouldRehydrate && userPrompt) {
                    userPrompt = wrapWithResumeContext(runtime, userPrompt, cronAtResumeNote);
                } else if (userPrompt) {
                    userPrompt = `${userPrompt}\n\n[SYSTEM: ${cronAtResumeNote}]`;
                }
                ctx.traceInfo(`[drain] user prompt interrupted cron_at timer (${Math.round(remainingMs / 1000)}s remain)`);
                state.activeTimer = null;
            } else if (state.activeTimer?.type === "idle") {
                ctx.traceInfo(`[drain] user prompt within idle window, cancelling idle timer`);
                state.activeTimer = null;
            } else if (state.activeTimer?.type === "agent-poll") {
                ctx.traceInfo(`[drain] user prompt interrupted agent wait`);
                state.waitingForAgentIds = null;
                state.activeTimer = null;
            } else if (state.activeTimer?.type === "workspace_retry") {
                // Session workspaces: the message's own turn is the next
                // attempt. A gate wait is never re-armed (test F9); if the
                // workspace is still unavailable, that turn holds again.
                ctx.traceInfo(`[drain] user prompt interrupted a workspace wait; the next turn attempts the workspace`);
                state.activeTimer = null;
            }
            if (releasing && !state.activeTimer) {
                runtime.releasedForQueuedWork = {
                    timer: { ...releasing },
                    priorInterruptedWait,
                    priorInterruptedCron,
                    waitingForAgentIds: priorWaitingForAgentIds,
                    ...(state.interruptedWaitTimer !== priorInterruptedWait && state.interruptedWaitTimer
                        ? { savedInterruptedWait: state.interruptedWaitTimer } : {}),
                    ...(state.interruptedCronTimer !== priorInterruptedCron && state.interruptedCronTimer
                        ? { savedInterruptedCron: state.interruptedCronTimer } : {}),
                };
            }

            // 1.0.82 (defect E): a timer note must not push a prompt that fits
            // over the item cap. Without the note the prompt is queued as
            // sent; the released timer keeps its saved time either way.
            if (userPrompt !== msg.prompt && isFifoItemTooLarge({ ...baseItem, prompt: userPrompt })) {
                ctx.traceInfo(`[drain] the timer note would make the prompt too large to queue; queued it without the note`);
                userPrompt = msg.prompt;
                state.pendingRehydrationMessage = rehydrationMessageBefore;
            }

            let carriedDigest: PendingChildDigest | undefined;
            if (state.pendingChildDigest?.updates.length) {
                const digestBefore = state.pendingChildDigest;
                let withDigest: string;
                if (msg.carriedSteersWake === true) {
                    // The wake marker is itself a [SYSTEM: ...] text; merging
                    // the digest into it would dissolve the marker. Merge the
                    // digest into the notes after it instead.
                    const notes = flushPendingChildDigestIntoPrompt(
                        runtime,
                        userPrompt.slice(CARRIED_STEERS_WAKE_PROMPT.length).trim() || undefined,
                    );
                    withDigest = notes ? `${CARRIED_STEERS_WAKE_PROMPT}\n\n${notes}` : CARRIED_STEERS_WAKE_PROMPT;
                } else {
                    withDigest = flushPendingChildDigestIntoPrompt(runtime, userPrompt) ?? userPrompt;
                }
                if (isFifoItemTooLarge({ ...baseItem, prompt: withDigest })) {
                    // 1.0.82 (defect E): the digest stays buffered for a later
                    // turn rather than making this prompt too large to queue.
                    ctx.traceInfo(`[drain] the child digest would make the prompt too large to queue; kept the digest buffered`);
                    state.pendingChildDigest = digestBefore;
                } else {
                    userPrompt = withDigest;
                    carriedDigest = digestBefore;
                    digestsTaken += 1;
                    for (const entry of digestBefore.updates) digestTakenAt.set(entry, digestsTaken);
                }
            }

            const stashedPrompt = { ...baseItem, prompt: userPrompt };
            stash.push(stashedPrompt);
            // 1.0.82 (defect E review): remember the owed work this prompt
            // took, so a refusal or a same-pass cancel gives it back.
            const carriedRehydration = typeof rehydrationMessageBefore === "string"
                && state.pendingRehydrationMessage === undefined ? rehydrationMessageBefore : undefined;
            if (carriedDigest || carriedRehydration !== undefined) {
                carriedByItem.set(stashedPrompt, {
                    ...(carriedDigest ? { digest: carriedDigest } : {}),
                    ...(carriedRehydration !== undefined ? { rehydrationMessage: carriedRehydration } : {}),
                });
            }
            for (const id of incomingClientMessageIds) pendingClientMessageIds.add(id);
            continue;
        }

        ctx.traceInfo(`[drain] skipping unknown: ${JSON.stringify(msg).slice(0, 120)}`);
    }

    if (stash.length > 0) {
        const lostItems: any[] = yield* appendPromptStashToFifo(runtime, stash);
        giveBackCarriedWork(runtime, carriedByItem, lostItems, updateChronology);
    }
}

// ─── Pre-dispatch sweep: grab any pending cancel tombstone ──

function* sweepMessagesBeforePromptDispatch(runtime: DurableSessionRuntime): Generator<any, void, any> {
    const { ctx, state } = runtime;
    const stash: any[] = [];
    const seenChildUpdates = new Set<string>();
    const pendingClientMessageIds = new Set<string>();

    for (let i = 0; i < MAX_PREDISPATCH_SWEEP; i++) {
        const msgTask = ctx.dequeueEvent("messages");
        const timerTask = ctx.scheduleTimer(PREDISPATCH_CANCEL_SWEEP_MS);
        const race: any = yield ctx.race(msgTask, timerTask);
        if (race.index === 1) break;

        const msg = typeof race.value === "string" ? JSON.parse(race.value) : race.value;
        if (!msg) continue;

        if (msg && Array.isArray(msg.cancelPending) && msg.cancelPending.length > 0) {
            const validCancelIds = validClientMessageIds(msg.cancelPending);
            addCancelledMessageIds(state, validCancelIds);
            if (validCancelIds.length > 0) {
                ctx.traceInfo(`[predispatch] received cancel tombstone (ids=${validCancelIds.join(",")})`);
                for (let s = stash.length - 1; s >= 0; s--) {
                    const item = stash[s];
                    if (item?.kind !== "prompt") continue;
                    const ids: string[] = Array.isArray(item.clientMessageIds) ? item.clientMessageIds : [];
                    if (ids.some((id) => validCancelIds.includes(id))) {
                        ctx.traceInfo(`[predispatch] dropping stashed prompt cancelled by tombstone (ids=${ids.join(",")})`);
                        yield* dropCancelledPrompt(runtime, ids, "predispatch-stash");
                        stash.splice(s, 1);
                    }
                }
            }
            continue;
        }

        if (msg.type === "cmd") {
            if (stash.length > 0) {
                // 1.0.82 (R8): an id that was not stored is not pending, so a
                // resend later in this pass is not taken for a duplicate.
                const lostItems: any[] = yield* appendPromptStashToFifo(runtime, stash);
                for (const item of lostItems) {
                    for (const id of validClientMessageIds(item?.clientMessageIds)) pendingClientMessageIds.delete(id);
                }
                stash.length = 0;
            }
            yield* handleCommand(runtime, msg as CommandMessage);
            if (state.orchestrationResult !== null) return;
            // Session regeneration: a pending pipeline is advanced by the run
            // loop — return control instead of draining on (a blocking
            // dequeue here would park the session with the regen never
            // starting). Later cmds still pre-empt: the loop re-enters drain
            // between stages and this pass is non-blocking while regen is set.
            if (state.regen) return;
            continue;
        }

        const childUpdate = parseChildUpdate(msg.prompt);
        if (childUpdate) {
            const key = `${childUpdate.sessionId}|${childUpdate.updateType}|${childUpdate.content ?? ""}`;
            if (!seenChildUpdates.has(key)) {
                seenChildUpdates.add(key);
                const wasExpectingReport = state.subAgents.find(
                    (agent) => agent.sessionId === childUpdate.sessionId,
                )?.expectsReport === true;
                const tracked = yield* applyChildUpdate(runtime, childUpdate);
                if (tracked && !state.pendingShutdown) {
                    const childObservedAt: number = yield ctx.utcNow();
                    bufferChildUpdate(runtime, childUpdate, childObservedAt);
                    // Fast-path only on a FIRST report from a child spawned with
                    // an outstanding expectation — routine later updates keep
                    // the normal batch window.
                    if (wasExpectingReport) markDigestReadyIfAllAgentsSettled(runtime);
                }
                if (tracked && state.waitingForAgentIds) {
                    yield* maybeResolveAgentWaitCompletion(runtime);
                }
            }
            continue;
        }

        if (msg.answer !== undefined) {
            const answerItem = { kind: "answer", expectedQuestion: msg.expectedQuestion !== undefined ? msg.expectedQuestion : state.pendingInputQuestion ? { question: state.pendingInputQuestion.question, iteration: state.pendingInputQuestion.iteration ?? state.iteration } : null, answer: msg.answer, wasFreeform: msg.wasFreeform, ...(msg.sender && typeof msg.sender === "object" ? { sender: msg.sender } : {}) };
            // 1.0.82 (defect E): refused at arrival, as in drain.
            if (isFifoItemTooLarge(answerItem)) {
                yield* reportUnstoredItems(runtime, [answerItem], ["too-large"]);
                continue;
            }
            stash.push(answerItem);
            continue;
        }

        if (msg.prompt) {
            const incomingClientMessageIds = validClientMessageIds(msg.clientMessageIds);
            if (promptIdsIntersectCancellation(runtime, incomingClientMessageIds)) {
                ctx.traceInfo(`[predispatch] dropping incoming prompt cancelled by tombstone (ids=${incomingClientMessageIds.join(",")})`);
                yield* dropCancelledPrompt(runtime, incomingClientMessageIds, "predispatch-incoming");
                continue;
            }
            const duplicateIds = duplicateClientMessageIds(runtime, incomingClientMessageIds, pendingClientMessageIds);
            if (duplicateIds.length > 0) {
                yield* recordDuplicatePrompt(runtime, incomingClientMessageIds, duplicateIds, "predispatch");
                continue;
            }
            const sweepAttachments = sanitizePromptAttachmentRefs(msg.attachments);
            const sweepItem = {
                kind: "prompt",
                prompt: msg.prompt,
                bootstrap: Boolean(msg.bootstrap),
                ...(msg.requiredTool ? { requiredTool: msg.requiredTool } : {}),
                ...(incomingClientMessageIds.length > 0 ? { clientMessageIds: incomingClientMessageIds } : {}),
                ...(msg.sender && typeof msg.sender === "object" ? { sender: msg.sender } : {}),
                ...(sweepAttachments.length > 0 ? { attachments: sweepAttachments } : {}),
            };
            // 1.0.82 (defect E): refused at arrival, as in drain, so its id is
            // never pending and a resend that fits runs.
            if (isFifoItemTooLarge(sweepItem)) {
                yield* reportUnstoredItems(runtime, [sweepItem], ["too-large"]);
                continue;
            }
            stash.push(sweepItem);
            for (const id of incomingClientMessageIds) pendingClientMessageIds.add(id);
            continue;
        }

        ctx.traceInfo(`[predispatch] skipping unknown: ${JSON.stringify(msg).slice(0, 120)}`);
    }

    if (stash.length > 0) yield* appendPromptStashToFifo(runtime, stash);
}

// ─── decide: pop and process one item from FIFO ─────────────

function* processAnswer(runtime: DurableSessionRuntime, answerItem: any): Generator<any, void, any> {
    const pending = runtime.state.pendingInputQuestion?.question;
    // New callers bind to the question they observed at enqueue. Queue-drain
    // snapshots cover older callers; old persisted FIFO entries remain valid.
    const expected = answerItem.expectedQuestion;
    const matchesQuestion = expected === undefined || (expected !== null
        && expected.question === pending
        && (expected.iteration === undefined
            || expected.iteration === (runtime.state.pendingInputQuestion?.iteration ?? runtime.state.iteration)));
    const question = matchesQuestion ? pending : undefined;
    if (matchesQuestion) runtime.state.pendingInputQuestion = null;
    // Any writer may answer (security model); attribution shows who did.
    const sender = noteMessageSender(runtime, answerItem.sender);
    const answeredBy = runtime.state.multiWriter && sender?.display ? ` (answered by ${sender.display})` : "";
    // Another writer can already have answered, or a reconnecting client can
    // send against stale question state. Preserve that message as ordinary
    // input instead of inventing a question the agent never asked.
    const answerPrompt = question
        ? `The user was asked: "${question}"\nThe user responded${answeredBy}: "${answerItem.answer}"`
        : String(answerItem.answer);
    maybeQueueSharedPreamble(runtime);
    yield* processPrompt(runtime, answerPrompt, false, undefined, undefined, undefined, sender);
}

/**
 * The prompts that merge into the turn of `first`, in arrival order, removed
 * from the FIFO. Scans from position `start` (the items before it were queued
 * ahead of `first` and are all non-interactive) without moving anything:
 * timer items and agents-done items (an older version's queued follow-up)
 * are stepped over and stay, as dispatch already runs prompts ahead of them;
 * an answer or any other item kind ends the scan; so does a carried-steers
 * wake, whose marker must stay the whole prompt. Cancelled prompts on the way
 * are dropped and recorded, as before.
 *
 * Never merge an agent's bootstrap kickoff with a person's words (1.0.70).
 * Bootstrap is what the record keys on: the normal path does not record a
 * bootstrap prompt as a user.message, and the budget stash stamps one as
 * machine-authored, so a merged prompt hid the person's message. A kickoff
 * and a person's prompt run as two turns, in order.
 *
 * Before 1.0.82 the merge popped the FIFO head to peek and put a non-mergeable
 * item back at the head. A timer item at the head therefore stopped every
 * merge and never moved: one prompt per wake (issue 192). Reading in place
 * removes the put-back, so nothing can be reordered or dropped by it.
 */
function* collectMergeablePrompts(
    runtime: DurableSessionRuntime,
    first: any,
    start: number,
): Generator<any, any[], any> {
    const { ctx } = runtime;
    const buckets: any[][] = [];
    for (let i = 0; i < FIFO_BUCKET_COUNT; i++) buckets.push(readFifoBucket(ctx, i));
    const flat: Array<{ bucket: number; index: number; item: any }> = [];
    buckets.forEach((items, bucket) => items.forEach((item, index) => flat.push({ bucket, index, item })));

    const taken: any[] = [];
    const removed = new Set<string>();
    let stepped = 0;
    for (let k = start; k < flat.length; k++) {
        const { bucket, index, item: peek } = flat[k];
        if (peek?.kind === "timer" || peek?.kind === "agents-done") { stepped++; continue; }
        if (peek?.kind !== "prompt") break;
        const peekIds = validClientMessageIds(peek.clientMessageIds);
        if (promptIdsIntersectCancellation(runtime, peekIds)) {
            ctx.traceInfo(`[decide] dropping merged FIFO prompt cancelled by tombstone (ids=${peekIds.join(",")})`);
            removed.add(`${bucket}:${index}`);
            yield* dropCancelledPrompt(runtime, peekIds, "decide-merge");
            continue;
        }
        if (first.carriedSteersWake === true || peek.carriedSteersWake === true
            || Boolean(peek.bootstrap) !== Boolean(first.bootstrap)) {
            break;
        }
        removed.add(`${bucket}:${index}`);
        taken.push(peek);
    }
    if (removed.size > 0) {
        buckets.forEach((items, bucket) => {
            const kept = items.filter((_, index) => !removed.has(`${bucket}:${index}`));
            if (kept.length !== items.length) writeFifoBucket(ctx, bucket, kept);
        });
    }
    if (taken.length > 0 && stepped > 0) {
        ctx.traceInfo(`[decide] merged ${taken.length} queued prompt(s) past ${stepped} queued timer or follow-up item(s)`);
    }
    return taken;
}

export function* decide(runtime: DurableSessionRuntime): Generator<any, boolean, any> {
    const { ctx, state } = runtime;

    // Priority 1: pending tool actions (in-memory, replay carry-forward).
    yield* drainLeadingQueuedScheduleActions(runtime);
    if (state.pendingToolActions.length > 0) {
        const action = state.pendingToolActions.shift()!;
        ctx.traceInfo(`[orch] replaying queued action: ${action.type} remaining=${state.pendingToolActions.length}`);
        yield* handleTurnResult(runtime, action as unknown as TurnResult, "");
        return true;
    }

    // Priority 2: pending prompt (CAN carry-forward or queueFollowup).
    // Hold while waiting for agents — let confirmations accumulate and merge
    // with the agents-done summary for one combined LLM turn.
    if (state.pendingPrompt && !state.waitingForAgentIds) {
        const prompt = state.pendingPrompt;
        const isBootstrap = state.bootstrapPrompt;
        const requiredTool = state.pendingRequiredTool;
        const cycleOrigin = state.pendingCycleOrigin;
        const pendingAttachments = state.pendingAttachments;
        const pendingClientMessageIds = state.pendingClientMessageIds;
        const pendingSender = state.pendingSender;
        state.pendingPrompt = undefined;
        state.bootstrapPrompt = false;
        state.pendingRequiredTool = undefined;
        state.pendingCycleOrigin = undefined;
        state.pendingAttachments = undefined;
        state.pendingClientMessageIds = undefined;
        state.pendingSender = undefined;
        yield* processPrompt(
            runtime,
            prompt,
            isBootstrap,
            requiredTool,
            pendingClientMessageIds,
            cycleOrigin,
            pendingSender,
            pendingAttachments && pendingAttachments.length > 0 ? pendingAttachments : undefined,
        );
        return true;
    }

    // Priority 3: FIFO — next item in arrival order, with prompt batching.
    const picked = popNextDispatchFifoItem(runtime);
    if (picked) {
        const item = picked.item;
        switch (item.kind) {
            case "prompt": {
                const ids: string[] = Array.isArray(item.clientMessageIds) ? item.clientMessageIds : [];
                if (ids.length > 0) {
                    yield* sweepMessagesBeforePromptDispatch(runtime);
                    if (state.orchestrationResult !== null) return true;
                }
                if (promptIdsIntersectCancellation(runtime, ids)) {
                    ctx.traceInfo(`[decide] dropping FIFO prompt cancelled by tombstone (ids=${ids.join(",")})`);
                    yield* dropCancelledPrompt(runtime, ids, "decide-fifo");
                    return true;
                }

                // Batch consecutive prompt FIFO items into a single Copilot turn.
                // Multi-writer attribution: note each item's sender (may flip
                // the session to multi-writer), prefix segments with [FROM:]
                // once flipped, and keep a single turn-level sender only when
                // every merged segment came from the same identity.
                const firstSender = noteMessageSender(runtime, item.sender);
                let mergedPrompt = item.carriedSteersWake === true
                    ? String(item.prompt || "")
                    : applySenderAttribution(runtime, firstSender, String(item.prompt || ""));
                const mergedBootstrap = item.bootstrap ?? false;
                let mergedRequiredTool = item.requiredTool;
                const mergedClientMessageIds: string[] = [...ids];
                const mergedAttachments = sanitizePromptAttachmentRefs(item.attachments);
                let turnSender = firstSender;
                let mixedSenders = false;
                // 1.0.82 (R1, R2, R7): scan forward from where the dispatched
                // prompt stood, reading without moving anything. Timer items
                // are stepped over and stay where they are; an answer or any
                // other item kind stops the merge; so do a kickoff next to a
                // person's words and a carried-steers wake. There is no size
                // limit. Only the merged and cancelled prompts are removed.
                const merged = yield* collectMergeablePrompts(runtime, item, picked.before);
                for (const peek of merged) {
                    const peekIds: string[] = Array.isArray(peek.clientMessageIds) ? peek.clientMessageIds : [];
                    const peekSender = noteMessageSender(runtime, peek.sender);
                    if (messageSenderKey(peekSender ?? null) !== messageSenderKey(turnSender ?? null)) {
                        mixedSenders = true;
                    }
                    mergedPrompt = `${mergedPrompt}\n\n${applySenderAttribution(runtime, peekSender, String(peek.prompt || ""))}`;
                    if (!mergedRequiredTool && peek.requiredTool) mergedRequiredTool = peek.requiredTool;
                    for (const id of peekIds) mergedClientMessageIds.push(id);
                    // Merged messages pool their image attachments in arrival
                    // order, bounded by the per-turn cap (overflow is dropped
                    // here deterministically rather than failing the turn).
                    for (const ref of sanitizePromptAttachmentRefs(peek.attachments)) {
                        if (mergedAttachments.length >= ATTACHMENTS_MAX_COUNT) break;
                        mergedAttachments.push(ref);
                    }
                }
                maybeQueueSharedPreamble(runtime);
                // Top-level named-agent metadata is translated into the same
                // pending turn field as every other requiredTool. An explicit
                // requirement on the queued prompt still wins.
                mergedRequiredTool ??= state.pendingRequiredTool;
                state.pendingRequiredTool = undefined;
                yield* processPrompt(
                    runtime,
                    mergedPrompt,
                    mergedBootstrap,
                    mergedRequiredTool,
                    mergedClientMessageIds.length > 0 ? mergedClientMessageIds : undefined,
                    undefined,
                    mixedSenders ? undefined : turnSender,
                    mergedAttachments.length > 0 ? mergedAttachments : undefined,
                );
                break;
            }
            case "answer":
                yield* processAnswer(runtime, item);
                break;
            case "timer": {
                const kind = timerItemKind(item);
                if (kind) removeQueuedTimerItemsOfKind(runtime, kind);
                // 1.0.82: an idle or input-grace item, or an agent-poll item
                // with no live agent wait, that runs while a live timer is
                // released for it is stale: it would release the worker or arm
                // its own timer in place of the live one. The live timer is
                // armed again after decide.
                if (runtime.releasedForQueuedWork && isStaleWhileReleased(runtime, item)) {
                    ctx.traceInfo(`[decide] a queued ${item.timer.type} item is stale while the ${runtime.releasedForQueuedWork.timer.type} timer is live; dropped it`);
                    break;
                }
                yield* processTimer(runtime, item);
                break;
            }
            case "agents-done":
                queueFollowup(runtime, item.summary);
                break;
            default:
                ctx.traceInfo(`[decide] unknown FIFO item kind: ${item.kind}`);
        }
        return true;
    }

    // Priority 4: buffered child digest — only after user/FIFO work is drained.
    // Session workspaces: not while a workspace retry is pending. A digest is
    // [SYSTEM:] traffic, which a refused turn does not hold, so it would be
    // lost; it runs after the workspace is back.
    if (state.pendingChildDigest?.ready && state.pendingChildDigest.updates.length > 0 && !state.waitingForAgentIds
        && state.activeTimer?.type !== "workspace_retry") {
        yield* processPendingChildDigest(runtime);
        return true;
    }

    return false;
}

// ─── pending child digest dispatch (timer-aware) ────────────

import {
    buildPendingChildDigestSystemPrompt,
    clearPendingChildDigest,
} from "./lifecycle.js";

/**
 * All-quiet fast path: a freshly buffered child update revealed that EVERY
 * tracked sub-agent is settled (terminal, idle, or blocked on input) — nothing
 * will ever act again unprompted. Deliver the digest immediately instead of
 * waiting out the remainder of the batch window so the parent looks at its
 * children NOW rather than after a human pokes it.
 */
function markDigestReadyIfAllAgentsSettled(runtime: DurableSessionRuntime): void {
    const { state } = runtime;
    if (state.waitingForAgentIds) return; // wait resolution handles this case
    if (!state.pendingChildDigest || state.pendingChildDigest.updates.length === 0) return;
    if (state.subAgents.length === 0) return;
    if (!state.subAgents.every((agent) => isAgentWaitSettledStatus(agent.status))) return;
    state.pendingChildDigest.ready = true;
}


function* processPendingChildDigest(runtime: DurableSessionRuntime): Generator<any, void, any> {
    const { ctx, state } = runtime;
    const digestPrompt = buildPendingChildDigestSystemPrompt(runtime);
    if (!digestPrompt) {
        clearPendingChildDigest(runtime);
        return;
    }

    const digestDecision = shouldWakeParentForChildDigest(
        state.pendingChildDigest!.updates.map((update) => {
            const agent = state.subAgents.find((entry) => entry.sessionId === update.sessionId);
            return {
                update: {
                    kind: update.updateType === "wait"
                        ? "wait"
                        : update.updateType === "failed"
                            ? "error"
                            : update.updateType === "cancelled" || update.updateType === "deleted"
                                ? "cancelled"
                                : update.updateType === "completed"
                                    ? "completed"
                                    : "progress",
                    summary: update.content,
                    ...(update.cycleOrigin ? { cyclic: true } : {}),
                    ...(update.cycleStatus === "material" || update.cycleStatus === "blocked"
                        ? { material: true }
                        : update.cycleStatus === "quiet"
                            ? { material: false }
                            : {}),
                            ...(update.verdict ? { result: { verdict: update.verdict } } : update.cycleStatus === "blocked" ? { result: { verdict: "blocked" as const } } : {}),
                },
                contract: agent?.contract,
            } as const;
        }),
    );
    if (!digestDecision.wake) {
        yield runtime.manager.recordSessionEvent(runtime.input.sessionId, [{
            eventType: "session.child_update_suppressed",
            data: {
                reason: digestDecision.reason,
                policy: digestDecision.policy,
                classification: digestDecision.classification,
                updateCount: state.pendingChildDigest!.updates.length,
            },
        }]);
        clearPendingChildDigest(runtime);
        return;
    }

    if (state.activeTimer?.type === "wait") {
        const now: number = yield ctx.utcNow();
        const remainingMs = Math.max(0, state.activeTimer.deadlineMs - now);
        const remainingSec = Math.round(remainingMs / 1000);
        const elapsedMs = state.activeTimer.originalDurationMs - remainingMs;
        const elapsedSec = Math.round(elapsedMs / 1000);
        const totalSec = Math.round(state.activeTimer.originalDurationMs / 1000);
        state.interruptedWaitTimer = {
            remainingSec,
            reason: state.activeTimer.reason,
            shouldRehydrate: state.activeTimer.shouldRehydrate ?? false,
            waitPlan: state.activeTimer.waitPlan,
            interruptKind: "child",
            ...(timerGate(state.activeTimer) ? { gate: timerGate(state.activeTimer), budget: timerGate(state.activeTimer) === "budget" } : {}),
        };
        state.activeTimer = null;
        clearPendingChildDigest(runtime);
        yield* processPrompt(
            runtime,
            `[SYSTEM: Buffered child updates interrupted your ${totalSec}s timer (reason: "${state.interruptedWaitTimer.reason}"). ` +
                `${elapsedSec}s elapsed, ${remainingSec}s remain. ` +
                `Review the updates and continue your task now. The remaining wait will be resumed automatically after this turn completes.\n\n${digestPrompt}]`,
            true,
        );
        return;
    }

    if (state.activeTimer?.type === "cron") {
        const activeCron = state.cronSchedule;
        const now: number = yield ctx.utcNow();
        const remainingMs = Math.max(0, state.activeTimer.deadlineMs - now);
        state.interruptedCronTimer = {
            remainingMs,
            reason: state.activeTimer.reason,
            originalDurationMs: state.activeTimer.originalDurationMs,
            ...(state.activeTimer.shouldRehydrate ? { shouldRehydrate: true } : {}),
        };
        state.activeTimer = null;
        clearPendingChildDigest(runtime);
        yield* processPrompt(
            runtime,
            `[SYSTEM: This is an internal orchestration wake-up caused by child session updates; the user did not send a new message. ` +
                `Buffered child updates arrived while your recurring schedule was waiting for the next wake-up${activeCron ? ` ("${activeCron.reason}")` : ""}. ` +
                `Review the updates and continue your task now. The recurring cron schedule remains active and will be re-armed automatically after this turn completes.\n\n${digestPrompt}]`,
            true,
        );
        return;
    }

    if (state.activeTimer?.type === "cron_at") {
        const activeCronAt = state.cronAtSchedule;
        const scheduledAt = activeCronAt?.nextFireAtMs ? new Date(activeCronAt.nextFireAtMs).toISOString() : "unknown";
        state.activeTimer = null;
        clearPendingChildDigest(runtime);
        yield* processPrompt(
            runtime,
            `[SYSTEM: This is an internal orchestration wake-up caused by child session updates; the user did not send a new message. ` +
                `Buffered child updates arrived while your wall-clock schedule was waiting for its next fire${activeCronAt ? ` ("${activeCronAt.reason}", scheduled ${scheduledAt})` : ""}. ` +
                `Review the updates and continue your task now. The wall-clock cron schedule remains active and will be re-armed automatically after this turn completes.\n\n${digestPrompt}]`,
            true,
        );
        return;
    }

    if (state.activeTimer?.type === "idle") {
        state.activeTimer = null;
    } else if (state.activeTimer?.type === "agent-poll") {
        state.waitingForAgentIds = null;
        state.activeTimer = null;
    }

    clearPendingChildDigest(runtime);
    yield* processPrompt(runtime, `[SYSTEM: ${digestPrompt}]`, true);
}

// Re-export for any external consumers (e.g. legacy compat shims).
export { OrchestrationInput };
