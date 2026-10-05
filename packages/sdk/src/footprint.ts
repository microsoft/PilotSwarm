/**
 * Session footprint — the "how degraded is this session" sensor
 * (docs/proposals/session-regen-and-footprint.md §11).
 *
 * Control-plane only by construction: every axis is answered from CMS
 * aggregates, persisted metric summaries, and orchestration runtime stats —
 * computing a footprint never wakes a dehydrated session.
 *
 * The context/compaction counters are DERIVED from persisted SDK transcript
 * events (`session.usage_info`, `session.compaction_start/_complete` — none
 * of which are in the ephemeral filter), using the type-scoped event index.
 * Definitions (per the proposal):
 *   - compactionCount        completes observed this epoch
 *   - compactionGeneration   summaries-of-summaries depth. Under infinite
 *                            sessions the transcript permanently contains a
 *                            summary after the first compaction, so every
 *                            subsequent compaction's input includes one:
 *                            generation = max(0, completes - 1).
 *   - failedOrStuck          explicitly failed completes + a stuck trailing start
 *   - unknownCompactions      starts with no recorded complete. NOT failures:
 *                             the CLI frequently omits the complete event even
 *                             when the compaction succeeded.
 *   - sustained utilization  the last SUSTAINED_WINDOW usage readings all
 *                            above the threshold — never a single reading.
 */

import type {
    SessionCompactionStats,
    SessionEventStats,
    SessionMetricSummary,
} from "./cms.js";

// ── Assessment thresholds (exported for tests) ──────────────────

export const FOOTPRINT_UTILIZATION_ELEVATED = 0.7;
export const FOOTPRINT_UTILIZATION_DEGRADED = 0.85;
export const FOOTPRINT_SUSTAINED_WINDOW = 3;
export const FOOTPRINT_GENERATION_DEGRADED = 2;
export const FOOTPRINT_EVENTS_PRUNE_BYTES = 64 * 1024 * 1024;
export const FOOTPRINT_CACHE_TTL_MS = 15_000;
/** An unmatched compaction start younger than this is RUNNING, not stuck. */
export const FOOTPRINT_STUCK_COMPACTION_MS = 10 * 60 * 1000;
/** Sweep threshold: entries are pruned on write once the cache exceeds this. */
export const FOOTPRINT_CACHE_SWEEP_SIZE = 512;
/**
 * The regenerate command refuses an epoch with fewer turns than this
 * (`too_young`). Same value as the command handler in orchestration/lifecycle.ts.
 */
export const FOOTPRINT_REGEN_MIN_TURNS = 5;
/**
 * After a regeneration, requests from the agent itself or its parent are
 * refused for this long (`cooldown`). Same value as the command handler.
 */
export const FOOTPRINT_REGEN_COOLDOWN_MS = 6 * 60 * 60 * 1000;
/** How many of the newest `session.turn_started` events the turn count reads. */
export const FOOTPRINT_TURN_WINDOW = 100;

/** Sentinel "after everything" seq for reverse event reads. */
const MAX_SEQ = Number.MAX_SAFE_INTEGER;

/** The events that move a regeneration along. The newest one says where it is. */
const REGEN_PROGRESS_EVENTS = [
    "session.regenerate_requested",
    "session.regenerate_failed",
    "session.epoch_committed",
    "session.regenerated",
];

export type FootprintLevel = "ok" | "elevated" | "degraded" | "rebuilding";
export type FootprintRecommendation = "none" | "regenerate" | "prune-events";

/**
 * Why a regenerate request would be refused now.
 *
 * - `is_system`, `is_service`: this kind of session is never regenerated.
 * - `already_pending`: a regeneration is running.
 * - `epoch_unsettled`: the last regeneration has not finished its first turn.
 * - `too_young`: fewer than FOOTPRINT_REGEN_MIN_TURNS turns in this epoch.
 *   An operator can force past this one.
 */
export type RegenIneligibleReason =
    | "is_system"
    | "is_service"
    | "already_pending"
    | "epoch_unsettled"
    | "too_young";

/**
 * Regen eligibility read model (§10.2). It reads only durable state, so it
 * cannot see a session that is shutting down. The command handler decides.
 */
export interface RegenEligibility {
    eligible: boolean;
    reason?: RegenIneligibleReason;
    /** True when an operator can force the request anyway (`too_young` only). */
    forceable?: boolean;
    /**
     * Epoch ms. Until then a request from the agent itself or its parent is
     * refused as `cooldown`. Operator requests are not affected, so this
     * does not change `eligible`.
     */
    cooldownUntil?: number;
}

export interface SessionFootprint {
    sessionId: string;
    transcriptEpoch: number;
    regenCount: number;
    epochAgeDays: number | null;
    turnsThisEpoch: number | null;
    context: {
        tokenLimit: number | null;
        currentTokens: number | null;
        utilization: number | null;
        /** True when the last SUSTAINED_WINDOW readings all exceed the degraded threshold. */
        sustainedHighUtilization: boolean;
        compactionCount: number;
        compactionGeneration: number;
        tokensRemovedCumulative: number;
        failedOrStuckCompactions: number;
        /** Starts with no recorded complete — the CLI often omits the event, so these are UNKNOWN outcomes, not failures. */
        unknownCompactions: number;
    };
    transcript: {
        snapshotSizeBytes: number | null;
        rawSizeBytes: number | null;
    };
    events: {
        count: number;
        bytes: number;
        maxSeq: number;
        sinceEpochStart: number;
    };
    facts: { count: number; bytes: number } | null;
    children: { descendantCount: number } | null;
    orchestration: {
        historyEventCount?: number;
        historySizeBytes?: number;
        queuePendingCount?: number;
        orchestrationVersion?: string;
    } | null;
    /** Regen eligibility read model (§10.2). Advisory; the cmd handler is the authority. */
    regenEligibility: RegenEligibility;
    assessment: {
        level: FootprintLevel;
        reasons: string[];
        recommendation: FootprintRecommendation;
    };
    computedAt: number;
}

/** Structural dependencies — satisfied by ManagementClient's catalog + helpers. */
export interface FootprintSources {
    getSession(sessionId: string): Promise<
        | {
              createdAt?: number | Date | null;
              currentIteration?: number | null;
              transcriptEpoch?: number | null;
              lastRegeneratedAt?: number | Date | null;
              /** System sessions are never regenerated. */
              isSystem?: boolean | null;
              /** Set on service sessions (runtime machinery), which are never regenerated. */
              serviceKind?: string | null;
          }
        | null
    >;
    getSessionEventStats(sessionId: string, afterSeq?: number): Promise<SessionEventStats>;
    getSessionCompactionStats(sessionId: string, afterSeq?: number): Promise<SessionCompactionStats>;
    /** Reverse-ordered read of typed events (existing getSessionEventsBefore proc). */
    getSessionEventsBefore(
        sessionId: string,
        beforeSeq: number,
        limit?: number,
        eventTypes?: string[],
    ): Promise<Array<{ seq: number; eventType?: string; data?: unknown }>>;
    getSessionMetricSummary(sessionId: string): Promise<SessionMetricSummary | null>;
    getDescendantSessionIds?(sessionId: string): Promise<string[]>;
    getSessionFactsStats?(
        sessionId: string,
    ): Promise<{ totalCount: number; totalBytes: number }>;
    getOrchestrationStats?(sessionId: string): Promise<Record<string, unknown> | null>;
    /**
     * Epoch boundary seq (the session.epoch_committed event) when the session
     * has regenerated. Absent/0 → epoch 0, whole-session axes. Wired in M1.
     */
    getEpochBoundarySeq?(sessionId: string): Promise<number | null>;
}

function toEpochMs(value: number | Date | null | undefined): number | null {
    if (value == null) return null;
    if (value instanceof Date) return value.getTime();
    return Number.isFinite(value) ? Number(value) : null;
}

function finite(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** `data.iteration` of a `session.turn_started` event, or null. */
function turnIteration(event: { data?: unknown }): number | null {
    return finite((event.data as Record<string, unknown> | null | undefined)?.iteration);
}

/**
 * Turns started in the current epoch: the distinct `data.iteration` values of
 * the `session.turn_started` events after the epoch boundary. A retried turn
 * starts again with the same iteration, so it counts once.
 *
 * Only the newest FOOTPRINT_TURN_WINDOW events are read. When all of them are
 * after the boundary, the epoch's older turns are out of view. Iterations only
 * go up, so the count is then the newest iteration minus the epoch's first.
 */
async function countTurnsThisEpoch(
    sources: FootprintSources,
    sessionId: string,
    boundarySeq: number,
): Promise<number> {
    const TURN = "session.turn_started";
    const window = await sources.getSessionEventsBefore(sessionId, MAX_SEQ, FOOTPRINT_TURN_WINDOW, [TURN]);
    const turns = window.filter((e) => e.eventType === TURN);
    const iterations = turns
        .filter((e) => e.seq > boundarySeq)
        .map(turnIteration)
        .filter((n): n is number => n != null);
    const reachedBoundary = window.length < FOOTPRINT_TURN_WINDOW || turns.some((e) => e.seq <= boundarySeq);
    if (reachedBoundary || iterations.length === 0) return new Set(iterations).size;

    // The epoch's first iteration follows the last turn before the boundary.
    // Epoch 0 has no boundary, and its first iteration is 0.
    let firstIteration = 0;
    if (boundarySeq > 0) {
        const before = await sources.getSessionEventsBefore(sessionId, boundarySeq, 1, [TURN]);
        const last = before.find((e) => e.eventType === TURN);
        const iteration = last ? turnIteration(last) : null;
        if (iteration != null) firstIteration = iteration + 1;
    }
    return Math.max(0, Math.max(...iterations) - firstIteration + 1);
}

/**
 * Predict the regenerate command's answer from durable state. The checks and
 * their order match ManagementClient.regenerateSession (system, service) and
 * then the command handler in orchestration/lifecycle.ts.
 */
function regenEligibilityFor(input: {
    isSystem: boolean;
    serviceKind: string | null;
    /** Type of the newest REGEN_PROGRESS_EVENTS event, if any. */
    regenProgress: string | null;
    turnsThisEpoch: number;
    lastRegenMs: number | null;
    nowMs: number;
}): RegenEligibility {
    const cooldownUntil = input.lastRegenMs != null && input.nowMs - input.lastRegenMs < FOOTPRINT_REGEN_COOLDOWN_MS
        ? input.lastRegenMs + FOOTPRINT_REGEN_COOLDOWN_MS
        : null;
    const cooldown = cooldownUntil != null ? { cooldownUntil } : {};
    if (input.isSystem) return { eligible: false, reason: "is_system", ...cooldown };
    if (input.serviceKind) return { eligible: false, reason: "is_service", ...cooldown };
    // Requested, and not yet failed or flipped: the pipeline is still running.
    if (input.regenProgress === "session.regenerate_requested") {
        return { eligible: false, reason: "already_pending", ...cooldown };
    }
    // Flipped, but the new epoch's first turn has not proven it yet.
    if (input.regenProgress === "session.epoch_committed") {
        return { eligible: false, reason: "epoch_unsettled", ...cooldown };
    }
    if (input.turnsThisEpoch < FOOTPRINT_REGEN_MIN_TURNS) {
        return { eligible: false, reason: "too_young", forceable: true, ...cooldown };
    }
    return { eligible: true, ...cooldown };
}

/**
 * Compute a session's footprint. `notFoundOk` is false: callers should have
 * resolved the session first; a missing session throws.
 */
export async function computeSessionFootprint(
    sources: FootprintSources,
    sessionId: string,
): Promise<SessionFootprint> {
    const session = await sources.getSession(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);

    const transcriptEpoch = finite(session.transcriptEpoch as number) ?? 0;
    let boundarySeq = 0;
    if (transcriptEpoch > 0) {
        // A regenerated session assessed from WHOLE-SESSION counters would
        // inherit the dead epoch's degradation — refuse loudly rather than
        // silently lie (the caller wires getEpochBoundarySeq; its absence or
        // failure here is a bug, not a fallback).
        if (!sources.getEpochBoundarySeq) {
            throw new Error(
                `footprint: session ${sessionId} is at epoch ${transcriptEpoch} but no epoch boundary source is wired`,
            );
        }
        const seq = await sources.getEpochBoundarySeq(sessionId);
        if (seq == null || seq <= 0) {
            throw new Error(
                `footprint: session ${sessionId} is at epoch ${transcriptEpoch} but the epoch boundary seq is unavailable`,
            );
        }
        boundarySeq = seq;
    }
    const afterSeq = boundarySeq > 0 ? boundarySeq : undefined;

    const [eventStatsAll, eventStatsEpoch, compaction, usageEvents, summary, turnsThisEpoch, regenEvents] = await Promise.all([
        sources.getSessionEventStats(sessionId),
        afterSeq != null
            ? sources.getSessionEventStats(sessionId, afterSeq)
            : Promise.resolve<SessionEventStats | null>(null),
        sources.getSessionCompactionStats(sessionId, afterSeq),
        sources.getSessionEventsBefore(sessionId, MAX_SEQ, FOOTPRINT_SUSTAINED_WINDOW + 3, [
            "session.usage_info",
        ]),
        sources.getSessionMetricSummary(sessionId),
        // Counted from turn events, not the CMS current_iteration: that one
        // counts every turn of the session and is never reset by a regeneration.
        countTurnsThisEpoch(sources, sessionId, boundarySeq),
        sources.getSessionEventsBefore(sessionId, MAX_SEQ, 1, REGEN_PROGRESS_EVENTS),
    ]);

    // Optional axes degrade independently — a failure in one never sinks the rest.
    const [factsResult, descendantsResult, orchResult] = await Promise.allSettled([
        sources.getSessionFactsStats?.(sessionId) ?? Promise.resolve(null),
        sources.getDescendantSessionIds?.(sessionId) ?? Promise.resolve(null),
        sources.getOrchestrationStats?.(sessionId) ?? Promise.resolve(null),
    ]);

    // ── context axis from the most recent usage readings ────────
    const readings = usageEvents
        .slice()
        .sort((a, b) => a.seq - b.seq)
        .map((e) => {
            const data = (e.data ?? {}) as Record<string, unknown>;
            const tokenLimit = finite(data.tokenLimit);
            const currentTokens = finite(data.currentTokens);
            return tokenLimit != null && currentTokens != null && tokenLimit > 0
                ? { tokenLimit, currentTokens, utilization: currentTokens / tokenLimit }
                : null;
        })
        .filter((r): r is NonNullable<typeof r> => r != null)
        // Collapse consecutive identical readings: usage_info fires more than
        // once per turn, and the sustained window must span distinct states,
        // not one long turn echoing the same number.
        .filter((r, i, all) => i === 0 || r.currentTokens !== all[i - 1].currentTokens);
    const latest = readings.length > 0 ? readings[readings.length - 1] : null;
    const window = readings.slice(-FOOTPRINT_SUSTAINED_WINDOW);
    const sustainedHighUtilization =
        window.length >= FOOTPRINT_SUSTAINED_WINDOW &&
        window.every((r) => r.utilization > FOOTPRINT_UTILIZATION_DEGRADED);

    // Failed completes inject no summary — they cannot deepen the
    // summaries-of-summaries chain, so depth counts SUCCEEDED compactions only.
    const succeeded = Math.max(0, compaction.completes - compaction.failed);
    const compactionCount = succeeded;
    const compactionGeneration = Math.max(0, succeeded - 1);
    // A single unmatched start is a compaction IN FLIGHT until the stuck
    // timeout passes — without the age gate every live compaction (and,
    // permanently, one crashed worker) would read degraded.
    // A start with no matching complete is UNKNOWN, not failed. The Copilot
    // CLI does not reliably emit `session.compaction_complete`: a healthy
    // session was observed with 67 starts against 4 completes while its
    // conversation token count demonstrably fell by tens of thousands of
    // tokens between starts — i.e. the compactions ran and succeeded, the
    // completion event simply was not recorded. Counting those as failures
    // reported a working session as `degraded` and recommended regeneration
    // it did not need. Only an EXPLICITLY failed complete is a failure; the
    // trailing unmatched start is still treated as in-flight/stuck (that one
    // is age-gated and genuinely actionable).
    const unmatchedStarts = Math.max(0, compaction.starts - compaction.completes);
    const newestStartMs = compaction.lastStartAtMs ?? 0;
    const trailingStartIsStuck =
        unmatchedStarts > 0 &&
        (newestStartMs === 0 || Date.now() - newestStartMs > FOOTPRINT_STUCK_COMPACTION_MS);
    const stuck = trailingStartIsStuck ? 1 : 0;
    // The trailing unmatched start is accounted for separately — it is either
    // in flight (fresh, counted nowhere) or stuck (counted in failedOrStuck).
    // Every unmatched start BEHIND it has an unknown outcome.
    const unknownCompactions = Math.max(0, unmatchedStarts - 1);
    const failedOrStuck = compaction.failed + stuck;

    // ── assessment ──────────────────────────────────────────────
    const reasons: string[] = [];
    if (compactionGeneration >= FOOTPRINT_GENERATION_DEGRADED) {
        reasons.push(`compactionGeneration >= ${FOOTPRINT_GENERATION_DEGRADED}`);
    }
    if (sustainedHighUtilization) {
        reasons.push(`utilization > ${FOOTPRINT_UTILIZATION_DEGRADED} sustained`);
    }
    if (failedOrStuck >= 1) reasons.push("failed or stuck compaction");

    let level: FootprintLevel;
    if (reasons.length > 0) {
        level = "degraded";
    } else if (
        compactionCount >= 1 ||
        (latest != null && latest.utilization > FOOTPRINT_UTILIZATION_ELEVATED)
    ) {
        level = "elevated";
        if (compactionCount >= 1) reasons.push("compaction has occurred");
        if (latest != null && latest.utilization > FOOTPRINT_UTILIZATION_ELEVATED) {
            reasons.push(`utilization > ${FOOTPRINT_UTILIZATION_ELEVATED}`);
        }
    } else {
        level = "ok";
    }

    let recommendation: FootprintRecommendation = "none";
    if (level === "degraded") recommendation = "regenerate";
    else if (eventStatsAll.dataBytes > FOOTPRINT_EVENTS_PRUNE_BYTES) recommendation = "prune-events";

    const createdAtMs = toEpochMs(session.createdAt);
    const lastRegenMs = toEpochMs(session.lastRegeneratedAt);
    const epochStartMs = transcriptEpoch > 0 ? lastRegenMs : createdAtMs;
    const epochAgeDays =
        epochStartMs != null ? (Date.now() - epochStartMs) / (24 * 60 * 60 * 1000) : null;

    const latestRegenEvent = regenEvents
        .filter((e) => typeof e.eventType === "string" && REGEN_PROGRESS_EVENTS.includes(e.eventType))
        .reduce<{ seq: number; eventType?: string } | null>(
            (newest, e) => (newest == null || e.seq > newest.seq ? e : newest),
            null,
        );
    const regenEligibility = regenEligibilityFor({
        isSystem: session.isSystem === true,
        serviceKind: session.serviceKind ?? null,
        regenProgress: latestRegenEvent?.eventType ?? null,
        turnsThisEpoch,
        lastRegenMs,
        nowMs: Date.now(),
    });

    const facts =
        factsResult.status === "fulfilled" && factsResult.value
            ? { count: factsResult.value.totalCount, bytes: factsResult.value.totalBytes }
            : null;
    const descendants =
        descendantsResult.status === "fulfilled" && Array.isArray(descendantsResult.value)
            ? { descendantCount: descendantsResult.value.length }
            : null;
    const orchStatsRaw = orchResult.status === "fulfilled" ? orchResult.value : null;
    const orchestration = orchStatsRaw
        ? {
              ...(finite((orchStatsRaw as any).historyEventCount) != null
                  ? { historyEventCount: Number((orchStatsRaw as any).historyEventCount) }
                  : {}),
              ...(finite((orchStatsRaw as any).historySizeBytes) != null
                  ? { historySizeBytes: Number((orchStatsRaw as any).historySizeBytes) }
                  : {}),
              ...(finite((orchStatsRaw as any).queuePendingCount) != null
                  ? { queuePendingCount: Number((orchStatsRaw as any).queuePendingCount) }
                  : {}),
              ...(typeof (orchStatsRaw as any).orchestrationVersion === "string"
                  ? { orchestrationVersion: (orchStatsRaw as any).orchestrationVersion }
                  : {}),
          }
        : null;

    return {
        sessionId,
        transcriptEpoch,
        regenCount: (summary as any)?.regenCount ?? transcriptEpoch,
        epochAgeDays,
        turnsThisEpoch,
        context: {
            tokenLimit: latest?.tokenLimit ?? null,
            currentTokens: latest?.currentTokens ?? null,
            utilization: latest != null ? Number(latest.utilization.toFixed(4)) : null,
            sustainedHighUtilization,
            compactionCount,
            compactionGeneration,
            tokensRemovedCumulative: compaction.tokensRemoved,
            failedOrStuckCompactions: failedOrStuck,
            unknownCompactions,
        },
        transcript: {
            snapshotSizeBytes: summary?.snapshotSizeBytes ?? null,
            rawSizeBytes: summary?.rawSizeBytes ?? null,
        },
        events: {
            count: eventStatsAll.eventCount,
            bytes: eventStatsAll.dataBytes,
            maxSeq: eventStatsAll.maxSeq,
            sinceEpochStart: (eventStatsEpoch ?? eventStatsAll).eventCount,
        },
        facts,
        children: descendants,
        orchestration,
        regenEligibility,
        assessment: { level, reasons, recommendation },
        computedAt: Date.now(),
    };
}

// ── TTL cache ───────────────────────────────────────────────────
//
// TTL-only by design: no cross-process invalidation is claimed — checking
// max seq is itself a query, and every consumer tolerates seconds of
// staleness. A maintained aggregate row is the upgrade path if this bites.

export class FootprintCache {
    private readonly entries = new Map<string, { at: number; value: SessionFootprint }>();

    constructor(private readonly ttlMs: number = FOOTPRINT_CACHE_TTL_MS) {}

    get(sessionId: string): SessionFootprint | null {
        const entry = this.entries.get(sessionId);
        if (!entry) return null;
        if (Date.now() - entry.at > this.ttlMs) {
            this.entries.delete(sessionId);
            return null;
        }
        return entry.value;
    }

    set(footprint: SessionFootprint): void {
        if (this.entries.size > FOOTPRINT_CACHE_SWEEP_SIZE) {
            const cutoff = Date.now() - this.ttlMs;
            for (const [key, entry] of this.entries) {
                if (entry.at < cutoff) this.entries.delete(key);
            }
            // Pathological churn (fleet-wide pollers): hard reset beats growth.
            if (this.entries.size > FOOTPRINT_CACHE_SWEEP_SIZE * 8) this.entries.clear();
        }
        this.entries.set(footprint.sessionId, { at: Date.now(), value: footprint });
    }

    clear(): void {
        this.entries.clear();
    }
}
