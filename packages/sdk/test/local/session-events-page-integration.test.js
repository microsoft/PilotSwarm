/**
 * getSessionEventsPage against a REAL catalog (issue 148).
 *
 * Why this file exists: the pure unit suite
 * (test/unit/session-events-page.test.mjs) exercises page SHAPING only. It
 * never touches the catalog, so it cannot show that the right stored
 * procedure is called per mode, that the event-type filter and the probe
 * limit reach that procedure unmodified, or that a page and its
 * existence evidence come from ONE read. A green pure suite could sit on
 * top of a broken client. These tests close that gap.
 *
 * It also carries the R4 ordering reproduction: a deterministic
 * two-connection late-commit scenario that shows, rather than argues, why
 * the receipt must not promise gap-freeness on a live session.
 *
 * Synthetic data only. No live session, no model, no customer content.
 *
 * Run: npx vitest run test/local/session-events-page-integration.test.js
 *
 * STATUS: authored against the documented harness; NOT YET EXECUTED. No
 * database has been granted at the time of writing.
 */

import { describe, it, beforeAll } from "vitest";
import pg from "pg";
import { PilotSwarmManagementClient } from "../../src/index.ts";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { assert, assertEqual, assertNotNull } from "../helpers/assertions.js";

const TIMEOUT = 60_000;
const getEnv = useSuiteEnv(import.meta.url);

beforeAll(async () => {
    await preflightChecks();
});

const SESSION = () => `11111111-2222-3333-4444-${Date.now().toString(16).padStart(12, "0").slice(-12)}`;

/** Seed N synthetic events through the catalog, returning their seqs. */
async function seed(catalog, sessionId, specs) {
    for (const [eventType, content] of specs) {
        await catalog.recordEvents(sessionId, [{ eventType, data: { content } }]);
    }
    const rows = await catalog.getSessionEvents(sessionId, undefined, 1000);
    return rows.map((r) => r.seq);
}

/** A management client bound to the suite's catalog, started. */
async function managementFor(env) {
    const mgmt = new PilotSwarmManagementClient({ store: env.store, cmsSchema: env.cmsSchema });
    await mgmt.start();
    return mgmt;
}

describe("getSessionEventsPage against a real catalog", () => {
    it("routes each mode to the correct stored procedure and returns real rows", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const mgmt = await managementFor(env);
        const sessionId = SESSION();
        await catalog.createSession(sessionId, { title: "paging-integration" });

        const seqs = await seed(catalog, sessionId, [
            ["assistant.message", "a"],
            ["assistant.message", "b"],
            ["assistant.message", "c"],
            ["assistant.message", "d"],
        ]);
        assertEqual(seqs.length, 4, "four synthetic events seeded");

        // latest: newest rows, continuation BACKWARD
        const latest = await mgmt.getSessionEventsPage(sessionId, { limit: 2 });
        assertEqual(latest.receipt.mode, "latest");
        assertEqual(latest.events.length, 2);
        assertEqual(latest.events[1].seq, seqs[3], "latest page ends at the newest event");
        assertEqual(latest.receipt.hasMore, true);
        assertEqual(latest.receipt.nextDirection, "backward",
            "a latest page must continue backward; forward would skip all older history");

        // forward: oldest rows above the cursor
        const forward = await mgmt.getSessionEventsPage(sessionId, { afterSeq: seqs[0], limit: 2 });
        assertEqual(forward.receipt.mode, "forward");
        assertEqual(forward.events[0].seq, seqs[1], "forward starts just above the cursor");
        assertEqual(forward.receipt.nextDirection, "forward");

        // backward: newest rows below the cursor
        const backward = await mgmt.getSessionEventsPage(sessionId, { beforeSeq: seqs[3], limit: 2 });
        assertEqual(backward.receipt.mode, "backward");
        assertEqual(backward.events[1].seq, seqs[2], "backward ends just below the cursor");
        assertEqual(backward.receipt.nextDirection, "backward");

        await mgmt.stop?.();
    });

    it("drains the whole session with no gaps and no duplicates", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const mgmt = await managementFor(env);
        const sessionId = SESSION();
        await catalog.createSession(sessionId, { title: "paging-drain" });

        const specs = Array.from({ length: 25 }, (_, i) => ["assistant.message", `e${i}`]);
        const seqs = await seed(catalog, sessionId, specs);

        // Drain backward from the latest page, following the receipt only.
        const seen = [];
        let page = await mgmt.getSessionEventsPage(sessionId, { limit: 4 });
        seen.unshift(...page.events.map((e) => e.seq));
        let guard = 0;
        while (page.receipt.hasMore && guard++ < 50) {
            assertEqual(page.receipt.nextDirection, "backward");
            page = await mgmt.getSessionEventsPage(sessionId, { beforeSeq: page.receipt.nextCursor, limit: 4 });
            seen.unshift(...page.events.map((e) => e.seq));
        }

        assertEqual(seen.length, seqs.length, "every seeded event was delivered exactly once");
        assertEqual(new Set(seen).size, seen.length, "no duplicates across pages");
        assertEqual(JSON.stringify(seen), JSON.stringify([...seen].sort((a, b) => a - b)), "ordering preserved");
        assertEqual(JSON.stringify(seen), JSON.stringify(seqs), "the drained set equals the seeded set");

        await mgmt.stop?.();
    });

    it("passes the event-type filter through to the procedure unmodified", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const mgmt = await managementFor(env);
        const sessionId = SESSION();
        await catalog.createSession(sessionId, { title: "paging-filter" });

        await seed(catalog, sessionId, [
            ["assistant.message", "keep-1"],
            ["user.message", "drop-1"],
            ["assistant.message", "keep-2"],
            ["user.message", "drop-2"],
        ]);

        const page = await mgmt.getSessionEventsPage(sessionId, {
            limit: 10,
            eventTypes: ["assistant.message"],
        });

        assertEqual(page.events.length, 2, "filter narrows to the requested type");
        assert(page.events.every((e) => e.eventType === "assistant.message"),
            "no event of an unrequested type may appear");
        // A filter must NARROW. If it ever widened, this is where it shows.
        assert(!page.events.some((e) => e.eventType === "user.message"),
            "the filter must never widen the result set");

        await mgmt.stop?.();
    });

    it("the existence probe does not leak an extra row into the page", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const mgmt = await managementFor(env);
        const sessionId = SESSION();
        await catalog.createSession(sessionId, { title: "paging-probe" });

        const seqs = await seed(catalog, sessionId, [
            ["assistant.message", "a"],
            ["assistant.message", "b"],
            ["assistant.message", "c"],
        ]);

        const page = await mgmt.getSessionEventsPage(sessionId, { afterSeq: seqs[0], limit: 1 });
        assertEqual(page.events.length, 1, "exactly the requested page size is delivered");
        assertEqual(page.receipt.hasMore, true, "the probe found a further eligible row");
        assertEqual(page.receipt.range.toSeq, page.events[0].seq, "range covers delivered rows only");
        assertEqual(page.receipt.nextCursor, page.events[0].seq,
            "cursor is the last DELIVERED row, never the probe row");

        await mgmt.stop?.();
    });

    it("reports the provider clamp and never exceeds it", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const mgmt = await managementFor(env);
        const sessionId = SESSION();
        await catalog.createSession(sessionId, { title: "paging-clamp" });
        await seed(catalog, sessionId, [["assistant.message", "only"]]);

        const page = await mgmt.getSessionEventsPage(sessionId, { afterSeq: 0, limit: 5000 });
        assertEqual(page.receipt.limitRequested, 5000);
        assertEqual(page.receipt.limitApplied, 999, "capped one below the provider clamp");
        assertEqual(page.receipt.providerClamp, 1000);

        await mgmt.stop?.();
    });
});

/**
 * R4 — the ordering obligation, reproduced rather than argued.
 *
 * `seq` is a GLOBAL BIGSERIAL allocated at INSERT. Allocation order is not
 * commit order, and every event writer is a multi-statement plpgsql function,
 * so a transaction can allocate an earlier seq and commit later. A reader that
 * advances a cursor past the later-but-already-visible row never sees the
 * earlier one.
 *
 * This is PRE-EXISTING behaviour of the event log, not something this change
 * introduced. These tests exist so the hazard is demonstrated on real
 * PostgreSQL instead of asserted from source reading, and so the receipt's
 * refusal to promise gap-freeness on a live session is grounded in evidence.
 */
describe("R4 ordering: late commit below an already-read bound", () => {
    it("a later-allocated row can become visible before an earlier-allocated one", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const mgmt = await managementFor(env);
        const sessionId = SESSION();
        await catalog.createSession(sessionId, { title: "r4-ordering" });

        const schema = env.cmsSchema;
        const a = new pg.Client({ connectionString: env.store });
        const b = new pg.Client({ connectionString: env.store });
        await a.connect();
        await b.connect();

        try {
            // A allocates the EARLIER seq, then holds its transaction open.
            await a.query("BEGIN");
            const aRow = await a.query(
                `INSERT INTO "${schema}".session_events (session_id, event_type, data)
                 VALUES ($1, 'assistant.message', $2::jsonb) RETURNING seq`,
                [sessionId, JSON.stringify({ content: "EARLY-allocated, LATE-committed" })],
            );
            const earlySeq = Number(aRow.rows[0].seq);

            // B allocates a LATER seq and commits immediately.
            await b.query("BEGIN");
            const bRow = await b.query(
                `INSERT INTO "${schema}".session_events (session_id, event_type, data)
                 VALUES ($1, 'assistant.message', $2::jsonb) RETURNING seq`,
                [sessionId, JSON.stringify({ content: "LATE-allocated, EARLY-committed" })],
            );
            const lateSeq = Number(bRow.rows[0].seq);
            await b.query("COMMIT");

            assert(earlySeq < lateSeq, `allocation order holds: ${earlySeq} < ${lateSeq}`);

            // A reader now sees ONLY B, even though A's row has a lower seq.
            const beforeCommit = await mgmt.getSessionEventsPage(sessionId, { afterSeq: 0, limit: 100 });
            const visible = beforeCommit.events.map((e) => e.seq);
            assert(visible.includes(lateSeq), "the later-allocated, committed row is visible");
            assert(!visible.includes(earlySeq), "the earlier-allocated, uncommitted row is NOT visible");

            // A follower would advance its cursor to the highest row it saw.
            const cursor = Math.max(...visible);
            assertEqual(cursor, lateSeq, "the follower's cursor is now past the earlier row");

            // Now A commits. Its row appears BELOW the cursor already taken.
            await a.query("COMMIT");

            const afterCursor = await mgmt.getSessionEventsPage(sessionId, { afterSeq: cursor, limit: 100 });
            const afterSeqs = afterCursor.events.map((e) => e.seq);
            assert(!afterSeqs.includes(earlySeq),
                "THE HAZARD: a forward follower never returns the late-committed earlier row");

            // It is retained and readable — it was never lost, only skipped by a
            // forward cursor. A full re-read still finds it.
            const full = await mgmt.getSessionEventsPage(sessionId, { afterSeq: 0, limit: 100 });
            assert(full.events.map((e) => e.seq).includes(earlySeq),
                "the row exists; only forward-cursor following skipped it");

            await mgmt.stop?.();
        } finally {
            await a.query("ROLLBACK").catch(() => {});
            await b.query("ROLLBACK").catch(() => {});
            await a.end().catch(() => {});
            await b.end().catch(() => {});
        }
    });

    it("the receipt never claims gap-freeness on a live read", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await createCatalog(env);
        const mgmt = await managementFor(env);
        const sessionId = SESSION();
        await catalog.createSession(sessionId, { title: "r4-claims" });
        await seed(catalog, sessionId, [["assistant.message", "x"], ["assistant.message", "y"]]);

        const page = await mgmt.getSessionEventsPage(sessionId, { afterSeq: 0, limit: 10 });

        // Completeness is a STRENGTH, not a promise. Given the hazard above,
        // "read-view" is the strongest honest claim for a live session.
        assertNotNull(page.receipt.completeness, "a completeness strength is always reported");
        assertEqual(page.receipt.completeness, "read-view");
        assert(page.receipt.completeness !== "retained-visible",
            "a single read view must not be reported as retained-visible membership");

        await mgmt.stop?.();
    });
});
