/**
 * Session event page shaping — pure, no database (issue 148).
 *
 * Imports the PURE page-shaping module, not the management client. The client
 * reaches the database and so transitively pulls in the Postgres and Azure
 * credential stack; importing it here made the first version of this file fail
 * to load at all (ERR_MODULE_NOT_FOUND on @azure/identity via
 * pg-pool-factory.js, brokered run r1-20261017T190904Z). Nothing here touches
 * PostgreSQL or any provider.
 *
 * Covers: the three selection modes and which end the surplus probe row
 * occupies in each, the latest-page trap, probe headroom against the provider
 * clamp, cursor safety, and completeness strength.
 *
 * Run: node --test test/unit/session-events-page.test.mjs   (requires a prior build)
 *
 * STATUS: revised after run r1; not yet re-executed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
    classifyPageMode,
    resolvePageLimit,
    probeFetchSize,
    buildSessionEventPage,
    SESSION_EVENT_PROVIDER_CLAMP,
    SESSION_EVENT_PAGE_MAX,
    SESSION_EVENT_PAGE_DEFAULT,
} from "../../dist/session-events-page.js";

const SESSION = "11111111-2222-3333-4444-555555555555";

/** Ascending rows, as both stored procedures return them. */
function rows(...seqs) {
    return seqs.map((seq) => ({
        seq,
        sessionId: SESSION,
        eventType: "assistant.message",
        data: { content: `e${seq}` },
        createdAt: new Date(0),
    }));
}

/**
 * Drive the same sequence the management client does: classify the mode,
 * resolve the limit, compute the probe size, shape the page. `probe` comes
 * back so tests can assert the fetch size the client would ask of the
 * procedure.
 */
function page({ afterSeq, beforeSeq, limit, fetched = [] }) {
    const mode = classifyPageMode({ afterSeq, beforeSeq });
    const limitRequested = limit ?? null;
    const limitApplied = resolvePageLimit(limitRequested);
    const probe = probeFetchSize(limitApplied);
    return { ...buildSessionEventPage({ mode, fetched, limitApplied, limitRequested }), probe };
}

// ── mode classification ──────────────────────────────────────────

test("no cursor is latest mode, and continues BACKWARD (latest-page trap)", () => {
    // Four rows returned for a page of three: the latest branch selects
    // newest-first, so the surplus is the OLDEST row.
    const r = page({ limit: 3, fetched: rows(10, 11, 12, 13) });

    assert.equal(r.receipt.mode, "latest");
    assert.deepEqual(r.events.map((e) => e.seq), [11, 12, 13], "the OLDEST row is the surplus");
    assert.equal(r.receipt.hasMore, true);
    // The trap: more history lies BELOW a latest page. Continuing forward
    // would silently skip every older event.
    assert.equal(r.receipt.nextDirection, "backward");
    assert.equal(r.receipt.nextCursor, 11, "cursor is the oldest DELIVERED row");
});

test("afterSeq = 0 is latest mode, not from-the-beginning", () => {
    // The procedure guard is `p_after_seq IS NOT NULL AND p_after_seq > 0`,
    // so zero falls through to the latest branch.
    assert.equal(classifyPageMode({ afterSeq: 0 }), "latest");
    assert.equal(page({ afterSeq: 0, limit: 5, fetched: rows(7, 8) }).receipt.mode, "latest");
});

test("afterSeq > 0 is forward mode, surplus is the NEWEST row", () => {
    const r = page({ afterSeq: 20, limit: 3, fetched: rows(21, 22, 23, 24) });

    assert.equal(r.receipt.mode, "forward");
    assert.deepEqual(r.events.map((e) => e.seq), [21, 22, 23], "surplus is at the END");
    assert.equal(r.receipt.nextDirection, "forward");
    assert.equal(r.receipt.nextCursor, 23, "cursor is the newest DELIVERED row");
});

test("beforeSeq is backward mode, surplus is the OLDEST row", () => {
    const r = page({ beforeSeq: 40, limit: 3, fetched: rows(31, 32, 33, 34) });

    assert.equal(r.receipt.mode, "backward");
    assert.deepEqual(r.events.map((e) => e.seq), [32, 33, 34]);
    assert.equal(r.receipt.nextDirection, "backward");
    assert.equal(r.receipt.nextCursor, 32);
});

// ── eligible-existence, not arithmetic ───────────────────────────

test("hasMore is false when the probe row does not come back", () => {
    // Exactly `limit` rows: the probe found nothing beyond them. This is the
    // ambiguity the receipt exists to remove — a full-looking page that is
    // genuinely final.
    const r = page({ afterSeq: 0, limit: 3, fetched: rows(1, 2, 3) });

    assert.equal(r.events.length, 3);
    assert.equal(r.receipt.hasMore, false);
    assert.equal(r.receipt.truncatedReason, null);
    assert.equal(r.receipt.nextCursor, null);
    assert.equal(r.receipt.nextDirection, null);
});

test("the probe asks for exactly one row beyond the page", () => {
    assert.equal(page({ afterSeq: 4, limit: 1 }).probe, 2);
    assert.equal(page({ afterSeq: 4, limit: 50 }).probe, 51);
});

// ── clamp disclosure and probe headroom ──────────────────────────

test("an over-large request is capped, and both numbers are disclosed", () => {
    const r = page({ afterSeq: 1, limit: 5000, fetched: rows(1) });

    assert.equal(r.receipt.limitRequested, 5000, "what the caller asked for survives");
    assert.equal(r.receipt.limitApplied, 999, "capped one below the provider clamp");
    assert.equal(r.receipt.providerClamp, 1000);
    assert.equal(r.receipt.maxPageSize, 999);
    // The reason the cap is 999: the probe must fit INSIDE the clamp, or the
    // clamp would eat it and hasMore would become a guess again.
    assert.equal(r.probe, 1000, "probe sits exactly at the clamp, never above");
});

test("the probe can never exceed the provider clamp", () => {
    for (const limit of [1, 50, 998, 999, 1000, 5000, Number.MAX_SAFE_INTEGER]) {
        const { probe } = page({ afterSeq: 1, limit });
        assert.ok(probe <= SESSION_EVENT_PROVIDER_CLAMP, `probe ${probe} exceeded the clamp for limit ${limit}`);
    }
});

test("omitting limit applies the preserved default of 50", () => {
    const r = page({ afterSeq: 1, fetched: rows(1) });
    assert.equal(r.receipt.limitRequested, null);
    assert.equal(r.receipt.limitApplied, SESSION_EVENT_PAGE_DEFAULT);
    assert.equal(SESSION_EVENT_PAGE_DEFAULT, 50);
    assert.equal(r.probe, 51);
});

test("a zero or negative limit is floored at one", () => {
    assert.equal(resolvePageLimit(0), 1);
    assert.equal(resolvePageLimit(-5), 1);
});

test("the page cap is exactly one below the clamp", () => {
    assert.equal(SESSION_EVENT_PAGE_MAX, SESSION_EVENT_PROVIDER_CLAMP - 1);
});

// ── range, emptiness and completeness strength ───────────────────

test("an empty page reports a null range and no cursor", () => {
    const r = page({ afterSeq: 99, fetched: [] });

    assert.deepEqual(r.events, []);
    assert.equal(r.receipt.range, null);
    assert.equal(r.receipt.hasMore, false);
    assert.equal(r.receipt.nextCursor, null);
    assert.equal(r.receipt.nextDirection, null);
});

test("range spans exactly the delivered rows, never the probe", () => {
    const r = page({ afterSeq: 40, limit: 3, fetched: rows(41, 42, 43, 44) });
    assert.deepEqual(r.receipt.range, { fromSeq: 41, toSeq: 43 });
});

test("completeness is a strength, and a capped page is never complete", () => {
    const r = page({ afterSeq: 0, limit: 1, fetched: rows(1, 2) });

    // One read view — NOT an immutable membership snapshot, because a
    // late-committing transaction may still appear below this bound.
    assert.equal(r.receipt.completeness, "read-view");
    assert.notEqual(r.receipt.completeness, "retained-visible");
    assert.equal(r.receipt.truncatedReason, "limit");
    assert.equal(r.receipt.hasMore, true);
});

test("a single delivered row reports a degenerate but valid range", () => {
    const r = page({ beforeSeq: 10, limit: 1, fetched: rows(8, 9) });
    assert.deepEqual(r.events.map((e) => e.seq), [9]);
    assert.deepEqual(r.receipt.range, { fromSeq: 9, toSeq: 9 });
    assert.equal(r.receipt.nextCursor, 9);
});
