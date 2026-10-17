/**
 * getSessionEventsPage unit tests — pure, no database (issue 148).
 *
 * Covers the continuation receipt: eligible-existence `hasMore` (never count
 * equality or sequence arithmetic), the three selection modes and which end
 * the surplus probe row occupies in each, the latest-page trap, provider-clamp
 * disclosure, probe headroom, and cursor safety.
 *
 * The catalog is a recording stub, so these assertions are about the paging
 * contract only. Nothing here touches PostgreSQL.
 *
 * Run: node --test test/unit/session-events-page.test.mjs   (requires a prior build)
 *
 * STATUS: WRITTEN BUT NEVER EXECUTED. No install/build/test grant exists at
 * the time of writing, so this file has not been compiled against, run, or
 * linted. Treat every assertion as unverified until a real run reports.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";

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
 * A client whose catalog is a stub. `calls` records every argument the method
 * passed down, so the tests can assert the probe used the SAME filter,
 * direction and range as the page.
 */
function clientWith({ forward = [], backward = [] } = {}) {
    const calls = [];
    const client = Object.create(PilotSwarmManagementClient.prototype);
    client._ensureStarted = () => {};
    client._catalog = {
        async getSessionEvents(sessionId, afterSeq, limit, eventTypes) {
            calls.push({ fn: "getSessionEvents", sessionId, afterSeq, limit, eventTypes });
            return forward;
        },
        async getSessionEventsBefore(sessionId, beforeSeq, limit, eventTypes) {
            calls.push({ fn: "getSessionEventsBefore", sessionId, beforeSeq, limit, eventTypes });
            return backward;
        },
    };
    return { client, calls };
}

// ── mode classification ──────────────────────────────────────────

test("no cursor is latest mode, and continues BACKWARD (latest-page trap)", async () => {
    // Procedure returned 4 rows for a requested page of 3: surplus is the
    // OLDEST row, because the latest branch selects newest-first.
    const { client } = clientWith({ forward: rows(10, 11, 12, 13) });
    const page = await client.getSessionEventsPage(SESSION, { limit: 3 });

    assert.equal(page.receipt.mode, "latest");
    // The OLDEST row is the surplus and must be dropped, not the newest.
    assert.deepEqual(page.events.map((e) => e.seq), [11, 12, 13]);
    assert.equal(page.receipt.hasMore, true);
    // The trap: more history lies BELOW a latest page. Continuing forward
    // would silently skip every older event.
    assert.equal(page.receipt.nextDirection, "backward");
    assert.equal(page.receipt.nextCursor, 11, "cursor is the oldest DELIVERED row");
});

test("afterSeq = 0 is latest mode, not from-the-beginning", async () => {
    // The procedure guard is `p_after_seq IS NOT NULL AND p_after_seq > 0`,
    // so zero falls through to the latest branch. The receipt must say so
    // rather than claiming a forward page.
    const { client } = clientWith({ forward: rows(7, 8) });
    const page = await client.getSessionEventsPage(SESSION, { afterSeq: 0, limit: 5 });
    assert.equal(page.receipt.mode, "latest");
});

test("afterSeq > 0 is forward mode, surplus is the NEWEST row", async () => {
    const { client } = clientWith({ forward: rows(21, 22, 23, 24) });
    const page = await client.getSessionEventsPage(SESSION, { afterSeq: 20, limit: 3 });

    assert.equal(page.receipt.mode, "forward");
    // Forward selects oldest-above-cursor, so the surplus is at the END.
    assert.deepEqual(page.events.map((e) => e.seq), [21, 22, 23]);
    assert.equal(page.receipt.nextDirection, "forward");
    assert.equal(page.receipt.nextCursor, 23, "cursor is the newest DELIVERED row");
});

test("beforeSeq is backward mode, surplus is the OLDEST row", async () => {
    const { client } = clientWith({ backward: rows(31, 32, 33, 34) });
    const page = await client.getSessionEventsPage(SESSION, { beforeSeq: 40, limit: 3 });

    assert.equal(page.receipt.mode, "backward");
    assert.deepEqual(page.events.map((e) => e.seq), [32, 33, 34]);
    assert.equal(page.receipt.nextDirection, "backward");
    assert.equal(page.receipt.nextCursor, 32);
});

test("afterSeq and beforeSeq together is rejected", async () => {
    const { client } = clientWith();
    await assert.rejects(
        () => client.getSessionEventsPage(SESSION, { afterSeq: 1, beforeSeq: 2 }),
        /mutually exclusive/,
    );
});

// ── eligible-existence, not arithmetic ───────────────────────────

test("hasMore is false when the probe row does not come back", async () => {
    // Exactly `limit` rows: the probe found nothing beyond them.
    const { client } = clientWith({ forward: rows(1, 2, 3) });
    const page = await client.getSessionEventsPage(SESSION, { afterSeq: 0, limit: 3 });

    // This is the ambiguity the whole receipt exists to remove: a full-looking
    // page that is genuinely final.
    assert.equal(page.events.length, 3);
    assert.equal(page.receipt.hasMore, false);
    assert.equal(page.receipt.truncatedReason, null);
    assert.equal(page.receipt.nextCursor, null);
    assert.equal(page.receipt.nextDirection, null);
});

test("the probe uses the SAME session, filter, direction and range", async () => {
    const { client, calls } = clientWith({ forward: rows(5, 6) });
    const eventTypes = ["assistant.message", "tool.execution_complete"];
    await client.getSessionEventsPage(SESSION, { afterSeq: 4, limit: 1, eventTypes });

    assert.equal(calls.length, 1, "page and existence evidence come from ONE read view");
    const only = calls[0];
    assert.equal(only.fn, "getSessionEvents", "same direction as the page");
    assert.equal(only.sessionId, SESSION);
    assert.equal(only.afterSeq, 4, "same range");
    assert.deepEqual(only.eventTypes, eventTypes, "same filter");
    assert.equal(only.limit, 2, "exactly one probe row beyond the page");
});

test("backward probe goes through the backward procedure", async () => {
    const { client, calls } = clientWith({ backward: rows(9) });
    await client.getSessionEventsPage(SESSION, { beforeSeq: 10, limit: 4 });
    assert.equal(calls[0].fn, "getSessionEventsBefore");
    assert.equal(calls[0].beforeSeq, 10);
    assert.equal(calls[0].limit, 5);
});

// ── clamp disclosure and probe headroom ──────────────────────────

test("an over-large request is capped, and both numbers are disclosed", async () => {
    const { client, calls } = clientWith({ forward: rows(1) });
    const page = await client.getSessionEventsPage(SESSION, { afterSeq: 1, limit: 5000 });

    assert.equal(page.receipt.limitRequested, 5000, "what the caller asked for survives");
    assert.equal(page.receipt.limitApplied, 999, "capped one below the provider clamp");
    assert.equal(page.receipt.providerClamp, 1000);
    assert.equal(page.receipt.maxPageSize, 999);
    // The reason the cap is 999: the probe must fit inside the clamp, or the
    // clamp would eat it and `hasMore` would become a guess again.
    assert.equal(calls[0].limit, 1000, "probe sits exactly at the clamp, never above");
});

test("the probe can never exceed the provider clamp", async () => {
    const { client, calls } = clientWith({ forward: rows(1) });
    await client.getSessionEventsPage(SESSION, { afterSeq: 1, limit: 999 });
    assert.ok(calls[0].limit <= 1000, `probe ${calls[0].limit} must stay within the clamp`);
});

test("omitting limit applies the preserved default of 50", async () => {
    const { client, calls } = clientWith({ forward: rows(1) });
    const page = await client.getSessionEventsPage(SESSION, { afterSeq: 1 });
    assert.equal(page.receipt.limitRequested, null);
    assert.equal(page.receipt.limitApplied, 50);
    assert.equal(calls[0].limit, 51);
});

test("a zero or negative limit is floored at one", async () => {
    const { client } = clientWith({ forward: rows(1) });
    const page = await client.getSessionEventsPage(SESSION, { afterSeq: 1, limit: 0 });
    assert.equal(page.receipt.limitApplied, 1);
});

// ── range, emptiness and completeness strength ───────────────────

test("an empty page reports a null range and no cursor", async () => {
    const { client } = clientWith({ forward: [] });
    const page = await client.getSessionEventsPage(SESSION, { afterSeq: 99 });

    assert.deepEqual(page.events, []);
    assert.equal(page.receipt.range, null);
    assert.equal(page.receipt.hasMore, false);
    assert.equal(page.receipt.nextCursor, null);
});

test("range spans exactly the delivered rows, never the probe", async () => {
    const { client } = clientWith({ forward: rows(41, 42, 43, 44) });
    const page = await client.getSessionEventsPage(SESSION, { afterSeq: 40, limit: 3 });
    assert.deepEqual(page.receipt.range, { fromSeq: 41, toSeq: 43 });
});

test("completeness is a strength, and a capped page is never complete", async () => {
    const { client } = clientWith({ forward: rows(1, 2) });
    const page = await client.getSessionEventsPage(SESSION, { afterSeq: 0, limit: 1 });

    // One read view — not an immutable membership snapshot, because a
    // late-committing transaction may still appear below this bound.
    assert.equal(page.receipt.completeness, "read-view");
    assert.notEqual(page.receipt.completeness, "retained-visible");
    assert.equal(page.receipt.truncatedReason, "limit");
    assert.equal(page.receipt.hasMore, true);
});

// ── the legacy surface is untouched ──────────────────────────────

test("getSessionEvents still returns a bare array", async () => {
    const { client } = clientWith({ forward: rows(1, 2, 3) });
    const legacy = await client.getSessionEvents(SESSION, 0, 3);
    assert.ok(Array.isArray(legacy), "fifteen call sites depend on this shape");
    assert.equal(legacy.length, 3);
    assert.equal(legacy.receipt, undefined);
});

test("getSessionEventsBefore still returns a bare array", async () => {
    const { client } = clientWith({ backward: rows(1, 2) });
    const legacy = await client.getSessionEventsBefore(SESSION, 10, 2);
    assert.ok(Array.isArray(legacy));
    assert.equal(legacy.receipt, undefined);
});
