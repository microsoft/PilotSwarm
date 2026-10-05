/**
 * Footprint sensor unit tests — pure, no database.
 *
 * Covers the assessment thresholds and their exact definitions
 * (docs/proposals/session-regen-and-footprint.md §11), the TTL-only cache
 * contract, optional-axis failure isolation, the 0035 migration shape, and
 * the regen eligibility read model with its per-epoch turn count.
 *
 * Run: node --test test/unit/footprint.test.mjs   (requires a prior build)
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    computeSessionFootprint,
    FootprintCache,
    FOOTPRINT_SUSTAINED_WINDOW,
    FOOTPRINT_EVENTS_PRUNE_BYTES,
    FOOTPRINT_STUCK_COMPACTION_MS,
} from "../../dist/footprint.js";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";

const SESSION = "11111111-2222-3333-4444-555555555555";

const noCompactions = () => ({ starts: 0, completes: 0, failed: 0, tokensRemoved: 0, lastStartAtMs: null, lastCompleteAtMs: null });
const compactions = (over) => ({ ...noCompactions(), ...over });

/** Build fake sources; overrides patch individual axes. */
function fakeSources(overrides = {}) {
    return {
        getSession: async () => ({ createdAt: Date.now() - 86_400_000, currentIteration: 12 }),
        getSessionEventStats: async () => ({ eventCount: 100, dataBytes: 50_000, maxSeq: 100 }),
        getSessionCompactionStats: async () => noCompactions(),
        getSessionEventsBefore: async () => [],
        getSessionMetricSummary: async () => ({ snapshotSizeBytes: 1_000_000, rawSizeBytes: 4_000_000 }),
        ...overrides,
    };
}

function usageEvents(utilizations, tokenLimit = 200_000) {
    return utilizations.map((u, i) => ({
        seq: i + 1,
        data: { tokenLimit, currentTokens: Math.round(u * tokenLimit), messagesLength: 10 },
    }));
}

test("healthy session reads ok with recommendation none", async () => {
    const fp = await computeSessionFootprint(
        fakeSources({ getSessionEventsBefore: async () => usageEvents([0.2, 0.3]) }),
        SESSION,
    );
    assert.equal(fp.assessment.level, "ok");
    assert.equal(fp.assessment.recommendation, "none");
    assert.equal(fp.context.compactionGeneration, 0);
    assert.equal(fp.context.utilization, 0.3);
});

test("one compaction or 0.7+ utilization reads elevated", async () => {
    const compacted = await computeSessionFootprint(
        fakeSources({
            getSessionCompactionStats: async () => compactions({ starts: 1, completes: 1, tokensRemoved: 5000 }),
        }),
        SESSION,
    );
    assert.equal(compacted.assessment.level, "elevated");

    const hot = await computeSessionFootprint(
        fakeSources({ getSessionEventsBefore: async () => usageEvents([0.75]) }),
        SESSION,
    );
    assert.equal(hot.assessment.level, "elevated");
});

test("compactionGeneration = completes - 1 and >= 2 reads degraded", async () => {
    const fp = await computeSessionFootprint(
        fakeSources({
            getSessionCompactionStats: async () => compactions({ starts: 3, completes: 3, tokensRemoved: 90_000 }),
        }),
        SESSION,
    );
    assert.equal(fp.context.compactionGeneration, 2);
    assert.equal(fp.assessment.level, "degraded");
    assert.equal(fp.assessment.recommendation, "regenerate");
    assert.equal(fp.context.tokensRemovedCumulative, 90_000);
});

test("sustained utilization needs the FULL window, never a single reading", async () => {
    // Distinct readings — identical ones collapse (see the dedupe test).
    const shortReadings = [0.86, 0.88].slice(0, FOOTPRINT_SUSTAINED_WINDOW - 1);
    const short = await computeSessionFootprint(
        fakeSources({ getSessionEventsBefore: async () => usageEvents(shortReadings) }),
        SESSION,
    );
    assert.equal(short.context.sustainedHighUtilization, false);
    assert.notEqual(short.assessment.level, "degraded");

    const sustained = await computeSessionFootprint(
        fakeSources({
            getSessionEventsBefore: async () => usageEvents([0.86, 0.88, 0.9]),
        }),
        SESSION,
    );
    assert.equal(sustained.context.sustainedHighUtilization, true);
    assert.equal(sustained.assessment.level, "degraded");
});

test("a recovery reading breaks sustainment even after high ones", async () => {
    const fp = await computeSessionFootprint(
        fakeSources({
            getSessionEventsBefore: async () => usageEvents([0.9, 0.9, 0.9, 0.5]),
        }),
        SESSION,
    );
    assert.equal(fp.context.sustainedHighUtilization, false);
});

test("an unmatched start is RUNNING until the stuck timeout, then degrades", async () => {
    // In flight: the newest start is recent — not stuck, not degraded.
    const live = await computeSessionFootprint(
        fakeSources({
            getSessionCompactionStats: async () =>
                compactions({ starts: 1, completes: 0, lastStartAtMs: Date.now() - 5_000 }),
        }),
        SESSION,
    );
    assert.equal(live.context.failedOrStuckCompactions, 0);
    assert.notEqual(live.assessment.level, "degraded");

    // Crashed: the start aged past the timeout — stuck, degraded.
    const stuck = await computeSessionFootprint(
        fakeSources({
            getSessionCompactionStats: async () =>
                compactions({ starts: 2, completes: 1, lastStartAtMs: Date.now() - FOOTPRINT_STUCK_COMPACTION_MS - 1000 }),
        }),
        SESSION,
    );
    assert.equal(stuck.context.failedOrStuckCompactions, 1);
    assert.equal(stuck.assessment.level, "degraded");
});

test("failed completes cannot deepen the generation count", async () => {
    const fp = await computeSessionFootprint(
        fakeSources({
            getSessionCompactionStats: async () =>
                compactions({ starts: 3, completes: 3, failed: 2, tokensRemoved: 10_000 }),
        }),
        SESSION,
    );
    // Only 1 succeeded — no summaries-of-summaries, but failures still degrade.
    assert.equal(fp.context.compactionCount, 1);
    assert.equal(fp.context.compactionGeneration, 0);
    assert.equal(fp.assessment.level, "degraded");
    assert.ok(fp.assessment.reasons.some((r) => r.includes("failed")));
});

test("consecutive identical usage readings collapse for the sustained window", async () => {
    // One long turn echoing the same hot number must not read sustained.
    const fp = await computeSessionFootprint(
        fakeSources({
            getSessionEventsBefore: async () => [
                { seq: 1, data: { tokenLimit: 100, currentTokens: 90, messagesLength: 1 } },
                { seq: 2, data: { tokenLimit: 100, currentTokens: 90, messagesLength: 1 } },
                { seq: 3, data: { tokenLimit: 100, currentTokens: 90, messagesLength: 1 } },
            ],
        }),
        SESSION,
    );
    assert.equal(fp.context.sustainedHighUtilization, false);
});

test("a regenerated session refuses whole-session counters without a boundary", async () => {
    await assert.rejects(
        computeSessionFootprint(
            fakeSources({ getSession: async () => ({ createdAt: Date.now(), transcriptEpoch: 2 }) }),
            SESSION,
        ),
        /epoch boundary/,
    );
    // With a boundary wired, the epoch axes scope to it.
    const fp = await computeSessionFootprint(
        fakeSources({
            getSession: async () => ({ createdAt: Date.now(), transcriptEpoch: 2, lastRegeneratedAt: Date.now() }),
            getEpochBoundarySeq: async () => 50,
            getSessionEventStats: async (_id, afterSeq) =>
                afterSeq != null
                    ? { eventCount: 10, dataBytes: 5_000, maxSeq: 100 }
                    : { eventCount: 100, dataBytes: 50_000, maxSeq: 100 },
        }),
        SESSION,
    );
    assert.equal(fp.events.count, 100);
    assert.equal(fp.events.sinceEpochStart, 10);
});

test("large event log with healthy context recommends prune-events", async () => {
    const fp = await computeSessionFootprint(
        fakeSources({
            getSessionEventStats: async () => ({
                eventCount: 50_000,
                dataBytes: FOOTPRINT_EVENTS_PRUNE_BYTES + 1,
                maxSeq: 50_000,
            }),
        }),
        SESSION,
    );
    assert.equal(fp.assessment.level, "ok");
    assert.equal(fp.assessment.recommendation, "prune-events");
});

test("optional axes fail independently without sinking the assessment", async () => {
    const fp = await computeSessionFootprint(
        fakeSources({
            getSessionFactsStats: async () => { throw new Error("facts store down"); },
            getDescendantSessionIds: async () => { throw new Error("cms hiccup"); },
            getOrchestrationStats: async () => { throw new Error("duroxide down"); },
        }),
        SESSION,
    );
    assert.equal(fp.facts, null);
    assert.equal(fp.children, null);
    assert.equal(fp.orchestration, null);
    assert.equal(fp.assessment.level, "ok");
});

test("unsorted usage readings are ordered by seq before windowing", async () => {
    // Latest (seq 4) is low; earlier readings were high. Must NOT be sustained.
    const events = [
        { seq: 4, data: { tokenLimit: 100, currentTokens: 10, messagesLength: 1 } },
        { seq: 1, data: { tokenLimit: 100, currentTokens: 95, messagesLength: 1 } },
        { seq: 3, data: { tokenLimit: 100, currentTokens: 95, messagesLength: 1 } },
        { seq: 2, data: { tokenLimit: 100, currentTokens: 95, messagesLength: 1 } },
    ];
    const fp = await computeSessionFootprint(
        fakeSources({ getSessionEventsBefore: async () => events }),
        SESSION,
    );
    assert.equal(fp.context.utilization, 0.1);
    assert.equal(fp.context.sustainedHighUtilization, false);
});

test("missing session throws", async () => {
    await assert.rejects(
        computeSessionFootprint(fakeSources({ getSession: async () => null }), SESSION),
        /session not found/,
    );
});

test("cache is TTL-only: serves within TTL, expires after", async () => {
    const cache = new FootprintCache(40);
    const fp = await computeSessionFootprint(fakeSources(), SESSION);
    cache.set(fp);
    assert.equal(cache.get(SESSION), fp);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(cache.get(SESSION), null);
});

test("migration 0035 registers both footprint procs with session-scoped predicates", () => {
    const m = CMS_MIGRATIONS("fp_check").find((x) => x.version === "0035");
    assert.ok(m, "migration 0035 must be registered");
    assert.equal(m.name, "footprint_stat_procs");
    for (const fn of ["cms_get_session_event_stats", "cms_get_session_compaction_stats"]) {
        assert.ok(m.sql.includes(fn), `${fn} must be defined`);
    }
    // Both aggregates must carry the session_id predicate — there is no
    // full-coverage index for an unscoped scan.
    const bodies = m.sql.split("CREATE OR REPLACE FUNCTION").slice(1);
    for (const body of bodies) {
        assert.ok(body.includes("session_id = p_session_id"), "aggregate must be session-scoped");
    }
});

// ── Regen eligibility read model (issue #111) ───────────────────

/** Six hours: the regenerate command's cooldown for agent and parent requests. */
const REGEN_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * A fake event log read the way the CMS proc reads it: only the asked-for
 * types, only rows before `beforeSeq`, the newest `limit` rows, returned in
 * seq order.
 */
function eventLog(events) {
    return async (_id, beforeSeq, limit = 1000, eventTypes) => events
        .filter((e) => e.seq < beforeSeq && (!eventTypes || eventTypes.includes(e.eventType)))
        .sort((a, b) => b.seq - a.seq)
        .slice(0, limit)
        .reverse();
}

/** `session.turn_started` rows at consecutive seqs, one per iteration given. */
function turnsStarted(firstSeq, iterations) {
    return iterations.map((iteration, i) => ({
        seq: firstSeq + i, eventType: "session.turn_started", data: { iteration },
    }));
}

const range = (from, count) => Array.from({ length: count }, (_, i) => from + i);
const event = (seq, eventType, data = {}) => ({ seq, eventType, data });
const degraded = async () => compactions({ starts: 3, completes: 3, tokensRemoved: 90_000 });

test("a degraded session with 12 turns at epoch 0 can be regenerated", async () => {
    const fp = await computeSessionFootprint(
        fakeSources({
            getSessionCompactionStats: degraded,
            getSessionEventsBefore: eventLog(turnsStarted(1, range(0, 12))),
        }),
        SESSION,
    );
    assert.equal(fp.assessment.level, "degraded");
    assert.equal(fp.assessment.recommendation, "regenerate");
    assert.equal(fp.turnsThisEpoch, 12);
    assert.deepEqual(fp.regenEligibility, { eligible: true });
});

test("system and service sessions are never eligible", async () => {
    for (const [extra, reason] of [[{ isSystem: true }, "is_system"], [{ serviceKind: "distiller" }, "is_service"]]) {
        const fp = await computeSessionFootprint(
            fakeSources({
                getSession: async () => ({ createdAt: Date.now() - 86_400_000, currentIteration: 12, ...extra }),
                getSessionCompactionStats: degraded,
                getSessionEventsBefore: eventLog(turnsStarted(1, range(0, 12))),
            }),
            SESSION,
        );
        assert.deepEqual(fp.regenEligibility, { eligible: false, reason });
    }
});

test("a requested regeneration reads already_pending until it fails", async () => {
    const turns = turnsStarted(1, range(0, 12));
    const pending = await computeSessionFootprint(
        fakeSources({
            getSessionEventsBefore: eventLog([...turns, event(20, "session.regenerate_requested")]),
        }),
        SESSION,
    );
    assert.deepEqual(pending.regenEligibility, { eligible: false, reason: "already_pending" });

    // The newest regen event decides: a failure clears the pending attempt.
    const failed = await computeSessionFootprint(
        fakeSources({
            getSessionEventsBefore: eventLog([
                ...turns,
                event(20, "session.regenerate_requested"),
                event(21, "session.regenerate_failed", { stage: "cancelled" }),
            ]),
        }),
        SESSION,
    );
    assert.deepEqual(failed.regenEligibility, { eligible: true });
});

test("a flipped epoch reads epoch_unsettled until its first turn proves it", async () => {
    const lastRegeneratedAt = Date.now() - 7 * HOUR_MS;
    const fp = await computeSessionFootprint(
        fakeSources({
            getSession: async () => ({ createdAt: Date.now() - 86_400_000, transcriptEpoch: 1, lastRegeneratedAt }),
            getEpochBoundarySeq: async () => 30,
            getSessionEventsBefore: eventLog([
                ...turnsStarted(1, range(0, 12)),
                event(20, "session.regenerate_requested"),
                event(30, "session.epoch_committed", { fromEpoch: 0, toEpoch: 1 }),
                ...turnsStarted(31, [12]),
            ]),
        }),
        SESSION,
    );
    assert.deepEqual(fp.regenEligibility, { eligible: false, reason: "epoch_unsettled" });
    assert.equal(fp.turnsThisEpoch, 1);
});

test("an epoch with fewer than 5 turns reads too_young, which an operator can force", async () => {
    const lastRegeneratedAt = Date.now() - 7 * HOUR_MS;
    const fp = await computeSessionFootprint(
        fakeSources({
            // current_iteration counts every turn of the session; it must not be used.
            getSession: async () => ({
                createdAt: Date.now() - 86_400_000, currentIteration: 41, transcriptEpoch: 3, lastRegeneratedAt,
            }),
            getEpochBoundarySeq: async () => 100,
            getSessionEventsBefore: eventLog([
                ...turnsStarted(1, range(0, 40)),
                event(100, "session.epoch_committed", { fromEpoch: 2, toEpoch: 3 }),
                ...turnsStarted(101, [40]),
                event(102, "session.regenerated", { epoch: 3 }),
                // Iteration 41 started twice (a retry): one turn.
                ...turnsStarted(103, [41, 41]),
            ]),
        }),
        SESSION,
    );
    assert.equal(fp.turnsThisEpoch, 2);
    assert.deepEqual(fp.regenEligibility, { eligible: false, reason: "too_young", forceable: true });
});

test("a recent regeneration adds cooldownUntil but stays eligible", async () => {
    const lastRegeneratedAt = Date.now() - HOUR_MS;
    const fp = await computeSessionFootprint(
        fakeSources({
            getSession: async () => ({ createdAt: Date.now() - 86_400_000, transcriptEpoch: 1, lastRegeneratedAt }),
            getEpochBoundarySeq: async () => 30,
            getSessionEventsBefore: eventLog([
                ...turnsStarted(1, range(0, 12)),
                event(30, "session.epoch_committed", { fromEpoch: 0, toEpoch: 1 }),
                ...turnsStarted(31, [12]),
                event(32, "session.regenerated", { epoch: 1 }),
                ...turnsStarted(33, range(13, 5)),
            ]),
        }),
        SESSION,
    );
    assert.equal(fp.turnsThisEpoch, 6);
    assert.deepEqual(fp.regenEligibility, { eligible: true, cooldownUntil: lastRegeneratedAt + REGEN_COOLDOWN_MS });
});

test("an epoch longer than the turn read window still counts every turn", async () => {
    // 250 turns is more than the newest-turns window the footprint reads.
    const epoch0 = await computeSessionFootprint(
        fakeSources({ getSessionEventsBefore: eventLog(turnsStarted(1, range(0, 250))) }),
        SESSION,
    );
    assert.equal(epoch0.turnsThisEpoch, 250);

    const epoch2 = await computeSessionFootprint(
        fakeSources({
            getSession: async () => ({ createdAt: Date.now(), transcriptEpoch: 2, lastRegeneratedAt: Date.now() - 7 * HOUR_MS }),
            getEpochBoundarySeq: async () => 1000,
            getSessionEventsBefore: eventLog([
                ...turnsStarted(1, range(0, 300)),
                event(1000, "session.epoch_committed", { fromEpoch: 1, toEpoch: 2 }),
                ...turnsStarted(1001, [300]),
                event(1002, "session.regenerated", { epoch: 2 }),
                ...turnsStarted(1003, range(301, 249)),
            ]),
        }),
        SESSION,
    );
    assert.equal(epoch2.turnsThisEpoch, 250);
    assert.deepEqual(epoch2.regenEligibility, { eligible: true });
});
