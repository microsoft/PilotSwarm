import { sanitizePromptAttachmentRefs } from "../types.js";
import type { MessageSender } from "../message-sender.js";
import type { PromptAttachmentRef } from "../types.js";
import type { RegenState, PendingEpochCommit } from "../types.js";
export type { RegenState, PendingEpochCommit } from "../types.js";
import type {
    OrchestrationInput,
    SerializableSessionConfig,
    SessionContextUsage,
    SubAgentEntry,
    TurnAction,
} from "../types.js";
import { cloneContextUsage } from "./utils.js";

export interface ActiveTimer {
    deadlineMs: number;
    originalDurationMs: number;
    reason: string;
    type: "wait" | "cron" | "cron_at" | "idle" | "agent-poll" | "input-grace" | "workspace_retry";
    shouldRehydrate?: boolean;
    waitPlan?: { shouldDehydrate: boolean; resetAffinityOnDehydrate: boolean; preserveAffinityOnHydrate: boolean };
    content?: string;
    question?: string;
    choices?: string[];
    allowFreeform?: boolean;
    agentIds?: string[];
    /** Set by the provider-budget gate. See TurnResult's wait variant. */
    budget?: boolean;
    /** 1.0.80: the gate that created this wait. Read with timerGate(), which falls back to `budget`. */
    gate?: "budget" | "workspace";
}

export type ShutdownMode = NonNullable<OrchestrationInput["pendingShutdown"]>["mode"];
export type PendingShutdownState = NonNullable<OrchestrationInput["pendingShutdown"]>;
export type PendingChildDigest = NonNullable<OrchestrationInput["pendingChildDigest"]>;
export type PendingInputQuestion = NonNullable<OrchestrationInput["pendingInputQuestion"]>;
export type CronSchedule = NonNullable<OrchestrationInput["cronSchedule"]>;
export type CronAtSchedule = NonNullable<OrchestrationInput["cronAtSchedule"]>;

export interface InterruptedWaitTimer {
    remainingSec: number;
    reason: string;
    shouldRehydrate: boolean;
    waitPlan?: ActiveTimer["waitPlan"];
    interruptKind?: "child" | "user";
    /** A budget pause is re-derived by the next turn, never re-armed. */
    budget?: boolean;
    /** 1.0.80: a gate wait (budget or workspace) is never re-armed. */
    gate?: "budget" | "workspace";
}

export interface InterruptedCronTimer {
    remainingMs: number;
    reason: string;
    originalDurationMs?: number;
    shouldRehydrate?: boolean;
}

/** Mutable orchestration state — replaces the closure of `let`s in the prior monolith. */
export interface BudgetStashedPrompt {
    prompt: string;
    clientMessageIds?: string[];
    /** Turn-level contract that must survive a provider-budget refusal with its prompt. */
    requiredTool?: string;
    /** 1.0.80: image refs held with the prompt; they ride the recovery turn as `attachments`. */
    attachments?: PromptAttachmentRef[];
    /** 1.0.80: who wrote the held prompt, also stamped on its stash-time user.message. */
    sender?: MessageSender;
}

/** Session workspaces (1.0.80): the retry state behind a held workspace wait. */
export interface WorkspaceRetryState {
    /** How many failed attempts in a row; picks the next wait from the schedule. */
    step: number;
    /** Consecutive failures on one worker; two in a row release affinity. */
    failures: { workerNodeId: string; count: number };
}

export interface DurableSessionState {
    config: SerializableSessionConfig;
    affinityKey: string;

    iteration: number;
    loopIteration: number;
    retryCount: number;

    needsHydration: boolean;
    /**
     * Session lifecycle protocol: last committed snapshot-store version,
     * recorded from each runTurn result. 0 = no commit recorded yet.
     * Threaded through continue-as-new; the next turn's activity input
     * carries it as `snapshot.expectedVersion` for worker self-validation.
     */
    snapshotVersion: number;
    preserveAffinityOnHydrate: boolean;
    blobEnabled: boolean;
    pendingRehydrationMessage?: string;

    pendingPrompt?: string;
    /** Attachment refs for the carried pendingPrompt — dropped silently before 1.0.65's carry fix. */
    pendingAttachments?: import("../types.js").PromptAttachmentRef[];
    pendingRequiredTool?: string;
    pendingSystemPrompt?: string;
    runtimeModelNotice?: string;
    blockedError?: { message: string; authFailure?: boolean };
    pendingCycleOrigin?: "cron" | "cron_at";
    bootstrapPrompt: boolean;

    pendingToolActions: TurnAction[];
    subAgents: SubAgentEntry[];
    /** Child-side: first completion report already sent to the parent. */
    reportedFirstCompletionToParent: boolean;

    taskContext?: string;
    cronSchedule?: CronSchedule;
    cronAtSchedule?: CronAtSchedule;
    nextSummarizeAt: number;

    contextUsage?: SessionContextUsage;

    activeTimer: ActiveTimer | null;
    pendingInputQuestion: PendingInputQuestion | null;
    waitingForAgentIds: string[] | null;
    interruptedWaitTimer: InterruptedWaitTimer | null;
    /**
     * Prompts the budget gate refused before their turn could run.
     *
     * The turn is what records a prompt into the transcript, so a prompt
     * whose turn the gate refuses was — before 1.0.70 — simply destroyed:
     * consumed from the queue, never recorded, never replayed. Each entry
     * here has already been written as a durable user.message (at stash
     * time), and rides into the next turn attempt as `stashedPrompts` so
     * the model finally sees it when the gate clears. Cleared the moment a
     * turn actually runs.
     */
    budgetStash: BudgetStashedPrompt[] | null;
    interruptedCronTimer: InterruptedCronTimer | null;

    // ── Session workspaces (1.0.80) ──────────────────────────────
    /** Rises by one on every set or clear. 0 = never set. */
    workspaceRevision: number;
    /** `unavailable` while a workspace wait holds prompts; cleared on recovery. */
    workspaceStatus: { state: "ready" | "unavailable"; code?: string } | null;
    /** The changed-cwd note for the next turn of any kind that gets past the workspace check. */
    workspaceNotice?: string;
    /**
     * The notes of turns the workspace check refused (a child update, a
     * cron or wait wake-up, a model notice). They ride the next turn that
     * gets past the check, with the held prompts.
     */
    workspaceHeldNote?: string;
    /**
     * The workspace was cleared, and the worker that holds the session may
     * still have the old folder attached, with shells running in it. The
     * next affinity release tells that worker to release it.
     */
    workspaceReleasePending: boolean;
    workspaceRetry: WorkspaceRetryState | null;
    /** Test only: the retry schedule in milliseconds, replacing WORKSPACE_RETRY_SCHEDULE_SECONDS. */
    workspaceRetryScheduleMs?: number[];
    pendingChildDigest: PendingChildDigest | null;
    pendingShutdown: PendingShutdownState | null;

    lastResponseVersion: number;
    lastCommandVersion: number;
    lastCommandId?: string;

    cancelledMessageIds: Set<string>;
    emittedCancelledMessageIds: Set<string>;
    recentClientMessageIds: string[];

    legacyPendingMessage: unknown;

    orchestrationResult: string | null;

    // ── Multi-writer attribution (security model) ────────────────
    // Distinct sender identity keys observed on sender-carrying messages.
    // Only populated when payloads carry the (optional) sender field, so
    // pre-sender histories replay identically.
    observedSenderKeys: string[];
    /** True once a non-owner sender (or a second distinct sender) appears. */
    multiWriter: boolean;
    /** Whether the [SHARED SESSION] preamble has been issued to the agent. */
    sharedPreambleSent: boolean;
    /** Owner display name learned from an owner-relation sender. */
    ownerDisplay?: string;

    // ── Session regeneration (epoch rebirth, 1.0.67) ─────────────
    /**
     * Which incarnation of the SDK transcript is live. 0 = original.
     * Carried across every continue-as-new; incremented only by the
     * regenerate flip. The turn index is NEVER reset (stopTurn queues,
     * turn metrics, cascade ids all rely on its monotonicity).
     */
    transcriptEpoch: number;
    /**
     * One-shot: the next turn is the first of a fresh epoch and dispatches
     * as the runTurn2 activity (conditional epoch init). Cleared once that
     * turn's result is recorded.
     */
    epochStartPending: boolean;
    /** In-flight regeneration pipeline (cleared at the flip and on abort). */
    regen: RegenState | null;
    /** iteration at the current epoch's start (min-age gate baseline). */
    epochStartIteration: number;
    /** Epoch-ms of the last completed flip (agent cooldown baseline). */
    lastRegenAtMs: number;
    /**
     * Post-flip boundary record: set by the flip CAN, consumed by the new
     * execution's first drain, which emits session.epoch_committed + sets
     * sessions.transcript_epoch in one CMS transaction, then clears this.
     */
    pendingEpochCommit: PendingEpochCommit | null;
}


/** Immutable per-execution configuration derived from the orchestration input. */
export interface DurableSessionOptions {
    idleTimeout: number;
    inputGracePeriod: number;
    isSystem: boolean;
    parentSessionId?: string;
    nestingLevel: number;
    baseSystemMessage?: string | { mode: "append" | "replace"; content: string };
}

/** Single object passed through every orchestration helper. */
export interface DurableSessionRuntime {
    ctx: any;
    input: OrchestrationInput;
    versions: { currentVersion: string; latestVersion: string };
    manager: any;
    /** Mutable: reassigned when affinity rotates on hydrate/dehydrate. */
    session: any;
    state: DurableSessionState;
    options: DurableSessionOptions;
}

// ─── Constants ──────────────────────────────────────────────

export const INTERNAL_SYSTEM_TURN_PROMPT =
    "Internal orchestration wake-up. The user did not send a new message. Continue with the latest system instructions.";

/**
 * Session workspaces: how long to wait before the next attempt after a failed
 * attach or path check: 30 s, 2 min, 5 min, then every 15 min, or the
 * provider's retryAfterMs when larger (docs/proposals/session-workspaces.md 4.7).
 */
export const WORKSPACE_RETRY_SCHEDULE_SECONDS = [30, 120, 300, 900];

/**
 * The prompt a workspace retry wakes with. It is [SYSTEM:] traffic, so it is
 * never stashed as a user message; when prompts are held, the activity runs
 * them instead of this text.
 */
export const WORKSPACE_RETRY_WAKE_PROMPT =
    "[SYSTEM: Retrying the workspace that held this session. The user did not send a new message. Continue with your task.]";

/** The system-only turn after the agent's set_session_workspace; the worker adds the changed-cwd note. */
export const WORKSPACE_CHANGED_CONTINUE_PROMPT =
    "[SYSTEM: The working directory changed at your request. Continue your task in the new working directory.]";

/**
 * 1.0.80: the prompt a budget wait's own timer wakes with. Before 1.0.80 it
 * woke with "The N second wait is now complete. Continue with your task.",
 * which the stash recorded as a queued USER message whenever the gate still
 * refused (test F11).
 */
export const BUDGET_TIMER_WAKE_PROMPT =
    "[SYSTEM: Checking again whether the budget that paused this session allows a turn. The user did not send a new message. Continue with your task.]";

/**
 * Session workspaces: how long the orchestration waits for releaseWorkspace
 * before it releases affinity anyway. Under the 15 s retry floor.
 */
export const WORKSPACE_RELEASE_CAP_MS = 10_000;

/** How a note names a workspace: its root and folder, or the default working directory. */
export function describeWorkspace(workspace: { root: string; folder?: string } | null | undefined): string {
    if (!workspace) return "the default working directory";
    return workspace.folder ? `root "${workspace.root}", folder "${workspace.folder}"` : `root "${workspace.root}"`;
}

/** The changed-cwd note the next turn gets after a workspace set or clear. */
export function workspaceChangedNote(
    from: { root: string; folder?: string } | null | undefined,
    to: { root: string; folder?: string } | null | undefined,
    path?: string | null,
): string {
    return `The working directory changed from ${describeWorkspace(from)} to ${describeWorkspace(to)}${path ? ` (${path})` : ""}.`;
}

/**
 * The note the next turn gets when extra folders changed (section 4.10):
 * added, moved or removed, with the paths when known. undefined when the
 * folders stayed the same.
 */
export function extraFoldersChangedNote(
    from: { extra?: Record<string, { root: string; folder?: string }> } | null | undefined,
    to: { extra?: Record<string, { root: string; folder?: string }> } | null | undefined,
    paths?: Record<string, string> | null,
): string | undefined {
    const before = from?.extra ?? {};
    const after = to?.extra ?? {};
    const own = (map: Record<string, { root: string; folder?: string }>, name: string) =>
        (Object.prototype.hasOwnProperty.call(map, name) ? map[name] : undefined);
    const parts: string[] = [];
    for (const name of Object.keys(after).sort()) {
        const next = after[name];
        const old = own(before, name);
        if (old && old.root === next.root && (old.folder ?? "") === (next.folder ?? "")) continue;
        const at = paths?.[name] ? `, at ${paths[name]}` : "";
        parts.push(`${old ? "moved" : "added"} "${name}" (${describeWorkspace(next)}${at})`);
    }
    for (const name of Object.keys(before).sort()) {
        if (!own(after, name)) parts.push(`removed "${name}"`);
    }
    return parts.length > 0 ? `Your extra folders changed: ${parts.join("; ")}.` : undefined;
}

/** The gate behind a wait result, a timer or an interrupted wait. `budget: true` is the pre-1.0.80 spelling. */
export function timerGate(value: { gate?: unknown; budget?: unknown } | null | undefined): "budget" | "workspace" | undefined {
    if (!value) return undefined;
    if (value.gate === "workspace") return "workspace";
    if (value.gate === "budget" || value.budget === true) return "budget";
    return undefined;
}

/** Milliseconds before the next workspace attempt. */
export function workspaceRetryDelayMs(step: number, retryAfterMs: unknown, scheduleMs?: number[]): number {
    const index = Math.max(0, Math.floor(step));
    const schedule = Array.isArray(scheduleMs) && scheduleMs.length > 0
        ? scheduleMs
        : WORKSPACE_RETRY_SCHEDULE_SECONDS.map((seconds) => seconds * 1000);
    const base = Number(schedule[Math.min(index, schedule.length - 1)]) || 0;
    const provider = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : 0;
    return Math.max(base, provider);
}

export const MAX_RETRIES = 3;
export const MAX_SUB_AGENTS = 50;
export const MAX_NESTING_LEVEL = 2;
export const CHILD_UPDATE_BATCH_MS = 30_000;

/**
 * How long a parent buffers child updates before it wakes for them, scaled
 * with fan-out. A parent with two children keeps the 30-second window; one
 * with twenty buffers for five minutes. Furiosa on chk (20+ children) woke
 * three times in two minutes on child updates and made no tool call each
 * time, ~687K input tokens per wake-up. Pure in its inputs, so replay is
 * deterministic: `subAgentCount` comes from replayed state.
 */
export const CHILD_UPDATE_BATCH_MAX_MS = 300_000;
export function childUpdateBatchMs(subAgentCount: number): number {
    const n = Number.isFinite(subAgentCount) && subAgentCount > 0 ? Math.floor(subAgentCount) : 0;
    return Math.min(CHILD_UPDATE_BATCH_MAX_MS, Math.max(CHILD_UPDATE_BATCH_MS, 15_000 * n));
}

/**
 * If the parent's own timer will fire within this window, a buffered child
 * digest waits for that wake-up instead of causing one of its own. The
 * digest rides into the timer turn's prompt (processTimer flushes it).
 */
export const CHILD_DIGEST_COALESCE_MS = 60_000;
export const SHUTDOWN_TIMEOUT_MS = 60_000;
export const SHUTDOWN_POLL_INTERVAL_MS = 5_000;

export const FIRST_SUMMARIZE_DELAY = 60_000;
export const REPEAT_SUMMARIZE_DELAY = 300_000;

export const FIFO_BUCKET_COUNT = 20;
export const MAX_BUCKET_BYTES = 14 * 1024;
export const MAX_DRAIN_PER_TURN = 50;
export const MAX_PREDISPATCH_SWEEP = 50;
export const MAX_ITERATIONS_PER_EXECUTION = 10;
export const MAX_HISTORY_SIZE_BEFORE_CONTINUE_AS_NEW_BYTES = 800 * 1024;
export const HISTORY_SIZE_CHECK_INTERVAL_ITERATIONS = 3;
export const NON_BLOCKING_TIMER_MS = 10;
export const PREDISPATCH_CANCEL_SWEEP_MS = 100;
export const RECENT_CLIENT_MESSAGE_ID_LIMIT = 20;

// ─── Initial state construction ─────────────────────────────

function clonePendingChildDigest(input: OrchestrationInput["pendingChildDigest"]): PendingChildDigest | null {
    if (!input) return null;
    return {
        startedAtMs: input.startedAtMs,
        ...(input.ready ? { ready: true } : {}),
        updates: [...(input.updates || [])],
    };
}

function clonePendingShutdown(input: OrchestrationInput["pendingShutdown"]): PendingShutdownState | null {
    if (!input) return null;
    return {
        ...input,
        targetAgentIds: [...(input.targetAgentIds || [])],
    };
}

export function normalizeRecentClientMessageIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const ids: string[] = [];
    for (const raw of value) {
        if (typeof raw !== "string" || !raw || ids.includes(raw)) continue;
        ids.push(raw);
    }
    return ids.slice(-RECENT_CLIENT_MESSAGE_ID_LIMIT);
}

export function touchRecentClientMessageIds(state: DurableSessionState, ids: string[]): void {
    const validIds = ids.filter((id, index) => Boolean(id) && ids.indexOf(id) === index);
    if (validIds.length === 0) return;
    const touched = new Set(validIds);
    state.recentClientMessageIds = state.recentClientMessageIds.filter((id) => !touched.has(id));
    state.recentClientMessageIds.push(...validIds);
    state.recentClientMessageIds = state.recentClientMessageIds.slice(-RECENT_CLIENT_MESSAGE_ID_LIMIT);
}

export function createInitialState(input: OrchestrationInput, options: DurableSessionOptions): DurableSessionState {
    const config = { ...input.config };
    if (input.taskContext) {
        const base = typeof options.baseSystemMessage === "string"
            ? options.baseSystemMessage ?? ""
            : (options.baseSystemMessage as any)?.content ?? "";
        config.systemMessage = base + (base ? "\n\n" : "") +
            "[RECURRING TASK]\n" +
            "Original user request (always remember, even if conversation history is truncated):\n\"" +
            input.taskContext + "\"";
    }
    if (input.agentId) {
        config.agentIdentity = input.agentId;
    }

    return {
        config,
        affinityKey: input.affinityKey ?? input.sessionId,

        iteration: input.iteration ?? 0,
        loopIteration: 0,
        retryCount: input.retryCount ?? 0,

        needsHydration: input.needsHydration ?? false,
        snapshotVersion: input.snapshotVersion ?? 0,
        preserveAffinityOnHydrate: input.preserveAffinityOnHydrate ?? false,
        blobEnabled: input.blobEnabled ?? false,
        pendingRehydrationMessage: input.rehydrationMessage,

        pendingPrompt: input.prompt,
        pendingAttachments: sanitizePromptAttachmentRefs(input.attachments),
        pendingRequiredTool: input.requiredTool,
        pendingSystemPrompt: input.systemPrompt,
        runtimeModelNotice: input.runtimeModelNotice,
        blockedError: input.blockedError ? { ...input.blockedError } : undefined,
        pendingCycleOrigin: input.cycleOrigin,
        bootstrapPrompt: input.bootstrapPrompt ?? false,

        pendingToolActions: input.pendingToolActions ? [...input.pendingToolActions] : [],
        subAgents: input.subAgents ? [...input.subAgents] : [],
        reportedFirstCompletionToParent: Boolean(input.reportedFirstCompletionToParent),

        taskContext: input.taskContext,
        cronSchedule: input.cronSchedule ? { ...input.cronSchedule } : undefined,
        cronAtSchedule: input.cronAtSchedule ? { ...input.cronAtSchedule } : undefined,
        nextSummarizeAt: input.nextSummarizeAt ?? 0,

        contextUsage: cloneContextUsage(input.contextUsage),

        activeTimer: null,
        pendingInputQuestion: input.pendingInputQuestion ?? null,
        waitingForAgentIds: input.waitingForAgentIds ?? null,
        interruptedWaitTimer: input.interruptedWaitTimer ?? null,
        budgetStash: input.budgetStash ?? null,
        interruptedCronTimer: input.interruptedCronTimer ?? null,

        workspaceRevision: typeof input.workspaceRevision === "number" && input.workspaceRevision > 0 ? input.workspaceRevision : 0,
        workspaceStatus: input.workspaceStatus ? { ...input.workspaceStatus } : null,
        workspaceNotice: typeof input.workspaceNotice === "string" && input.workspaceNotice ? input.workspaceNotice : undefined,
        workspaceHeldNote: typeof input.workspaceHeldNote === "string" && input.workspaceHeldNote ? input.workspaceHeldNote : undefined,
        workspaceReleasePending: input.workspaceReleasePending === true,
        workspaceRetry: input.workspaceRetry
            ? { step: input.workspaceRetry.step ?? 0, failures: { ...(input.workspaceRetry.failures ?? { workerNodeId: "", count: 0 }) } }
            : null,
        workspaceRetryScheduleMs: Array.isArray(input.workspaceRetryScheduleMs) && input.workspaceRetryScheduleMs.length > 0
            ? [...input.workspaceRetryScheduleMs]
            : undefined,
        pendingChildDigest: clonePendingChildDigest(input.pendingChildDigest),
        pendingShutdown: clonePendingShutdown(input.pendingShutdown),

        lastResponseVersion: 0,
        lastCommandVersion: 0,
        lastCommandId: undefined,

        cancelledMessageIds: new Set<string>(),
        emittedCancelledMessageIds: new Set<string>(),
        recentClientMessageIds: normalizeRecentClientMessageIds(input.recentClientMessageIds),

        legacyPendingMessage: undefined,

        orchestrationResult: null,

        // Multi-writer attribution: carried across continue-as-new so a
        // shared session keeps its attribution posture (fields absent on
        // legacy CAN inputs normalize to single-writer defaults).
        observedSenderKeys: Array.isArray((input as any).observedSenderKeys) ? [...(input as any).observedSenderKeys] : [],
        multiWriter: (input as any).multiWriter === true,
        sharedPreambleSent: (input as any).sharedPreambleSent === true,
        ownerDisplay: typeof (input as any).ownerDisplay === "string" ? (input as any).ownerDisplay : undefined,

        // Session regeneration (1.0.67): epoch 0 when absent — every
        // pre-regen chain migrates in as the legacy epoch, zero migration.
        transcriptEpoch: typeof input.transcriptEpoch === "number" && Number.isFinite(input.transcriptEpoch)
            ? input.transcriptEpoch
            : 0,
        epochStartPending: input.epochStartPending === true,
        regen: input.regen ? { ...input.regen } : null,
        epochStartIteration: typeof input.epochStartIteration === "number" ? input.epochStartIteration : 0,
        lastRegenAtMs: typeof input.lastRegenAtMs === "number" ? input.lastRegenAtMs : 0,
        pendingEpochCommit: input.pendingEpochCommit ? { ...input.pendingEpochCommit } : null,
    };
}

export function deriveOptions(input: OrchestrationInput): DurableSessionOptions {
    return {
        // Lifecycle protocol: the idle timer is the affinity HOLD WINDOW —
        // its fire releases the worker (GUID rotation), it no longer
        // dehydrates. 30 minutes, not 60 seconds. Legacy executions CAN in
        // with an explicit 60 (the old system default, threaded through
        // every historical CAN input) — treat that sentinel as unset so
        // migrated sessions actually get the hold window.
        // (dehydrateThreshold / checkpointInterval inputs are accepted but
        // meaningless here: turns commit inside the runTurn activity and
        // waits never dehydrate — the fields live on only for ≤1.0.56.)
        idleTimeout: input.idleTimeout == null || input.idleTimeout === 60
            ? 1_800
            : input.idleTimeout,
        inputGracePeriod: input.inputGracePeriod ?? 30,
        isSystem: input.isSystem ?? false,
        parentSessionId: input.parentSessionId
            ?? (input.parentOrchId ? input.parentOrchId.replace(/^session-/, "") : undefined),
        nestingLevel: input.nestingLevel ?? 0,
        baseSystemMessage: input.baseSystemMessage ?? input.config?.systemMessage,
    };
}
