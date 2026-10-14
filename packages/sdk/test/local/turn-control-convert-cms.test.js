/**
 * Session turn control: converting a queued message to a steer (migration
 * 0083) against real PostgreSQL. Design doc section "Convert a queued
 * message" (revision 9).
 *
 * - Turn start records the turn's prompt in its own transaction, so a
 *   prompt is "received" before its turn can accept any control.
 * - A steer that replaces a queued message X is refused `already_received`
 *   once X is recorded, repeats its first answer for the same X while it is
 *   open or delivered, and is never carried.
 * - Turn end and `turnReplaced` report the X of delivered converted steers.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { DATABASE_URL, TEST_SCHEMA_PREFIX } from "../helpers/local-env.js";
import { PgSessionCatalogProvider } from "../../src/index.ts";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { runCmsMigrations } from "../../src/cms-migrator.ts";
import { makeRunTurnHarness } from "../helpers/run-turn-activity-harness.mjs";

const TIMEOUT = 120_000;

let env;
let catalog;
let pool;

const sid = () => `tcv-${randomUUID()}`;
const rid = () => randomUUID();
const alice = { kind: "user", provider: "dev", subject: "alice" };

async function newSession() {
    const id = sid();
    await catalog.createSession(id, { model: "m" });
    return id;
}

const events = (s, types) => catalog.getSessionEvents(s, 0, 500, types);
const prompt = (content, ids) => ({ eventType: "user.message", data: { content, ...(ids ? { clientMessageIds: ids } : {}) } });
const note = (content) => ({ eventType: "system.message", data: { content } });
const steer = (s, text = "guidance", requestId = rid(), replaces) => catalog.turnControlAdd(s, "steer", text, requestId, alice, true, replaces);
const convert = (s, x, text = "queued text", requestId = rid()) => steer(s, text, requestId, x);

async function outcomes(s) {
    return Object.fromEntries((await events(s, ["session.control_outcome"])).map((e) => [e.data.seq, e.data.outcome]));
}

async function promptRecords(s) {
    return (await events(s, ["user.message", "system.message"])).map((e) => ({ type: e.eventType, ...e.data }));
}

beforeAll(async () => {
    env = { store: DATABASE_URL, cmsSchema: `${TEST_SCHEMA_PREFIX}_tc_convert_${randomUUID().replaceAll("-", "").slice(0, 12)}` };
    catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
    await catalog.initialize();
    pool = new pg.Pool({ connectionString: env.store, max: 4 });
}, TIMEOUT);

afterAll(async () => {
    await catalog?.close();
    await pool?.query(`DROP SCHEMA IF EXISTS "${env.cmsSchema}" CASCADE`).catch(() => {});
    await pool?.end();
});

describe("turn start records the turn's prompt (migration 0083)", () => {
    it("records the prompt and the system message in order, in the turn-start transaction, once", async () => {
        const s = await newSession();
        const started = await catalog.turnStart(s, 1, [note("turn note"), prompt("hello", ["x1"])], "w1");
        expect(started).toEqual({ stopped: false, controls: [] });
        const recorded = await events(s, ["user.message", "system.message"]);
        expect(recorded.map((e) => [e.eventType, e.data.content, e.workerNodeId])).toEqual([
            ["system.message", "turn note", "w1"],
            ["user.message", "hello", "w1"],
        ]);
        // A repeat start of the same turn (worker loss, retry after turn start) records nothing again.
        await catalog.turnStart(s, 1, [note("turn note"), prompt("hello", ["x1"])], "w2");
        expect(await promptRecords(s)).toHaveLength(2);
    }, TIMEOUT);

    it("a record with ids is skipped when a prompt record already holds one of them; a record without ids is first-start only", async () => {
        const s = await newSession();
        await catalog.turnStart(s, 1, [prompt("merged", ["x1", "x2"])], "w");
        // A later turn retries the same prompt (a returned error advances the turn index).
        await catalog.turnStart(s, 2, [note("note 2"), prompt("merged", ["x2", "x1"])], "w");
        // A later turn whose prompt has no ids records it on its first start.
        await catalog.turnStart(s, 3, [prompt("agent prompt")], "w");
        await catalog.turnStart(s, 3, [prompt("agent prompt")], "w");
        expect((await promptRecords(s)).map((r) => [r.type, r.content])).toEqual([
            ["user.message", "merged"],
            ["system.message", "note 2"],
            ["user.message", "agent prompt"],
        ]);
    }, TIMEOUT);

    it("repairs a started turn whose prompt record is missing: a record with ids is recorded on a repeat start", async () => {
        const s = await newSession();
        // An earlier start passed turn start without recording (an 0082 worker whose best-effort write failed).
        await catalog.turnStart(s, 4);
        await catalog.turnStart(s, 4, [note("note"), prompt("lost prompt", ["x9"])], "w");
        expect((await promptRecords(s)).map((r) => [r.type, r.content])).toEqual([["user.message", "lost prompt"]]);
        await catalog.turnStart(s, 4, [prompt("lost prompt", ["x9"])], "w");
        expect(await promptRecords(s)).toHaveLength(1);
    }, TIMEOUT);

    it("a stale start records nothing", async () => {
        const s = await newSession();
        await catalog.turnStart(s, 5, [], "w");
        expect(await catalog.turnStart(s, 4, [prompt("old", ["x4"])], "w")).toEqual({ stale: true });
        expect(await promptRecords(s)).toEqual([]);
    }, TIMEOUT);

    it("the 0082 two-argument turn start no longer exists", async () => {
        const s = await newSession();
        await expect(pool.query(`SELECT "${env.cmsSchema}".cms_turn_start($1, $2)`, [s, 1])).rejects.toMatchObject({ code: "42883" });
    }, TIMEOUT);
});

describe("a steer that replaces a queued message (migration 0083)", () => {
    it("stores the replaced id on the steer", async () => {
        const s = await newSession();
        await catalog.turnStart(s, 1, [prompt("running", ["y1"])], "w");
        const requestId = rid();
        const added = await convert(s, "x1", "queued text", requestId);
        expect(added).toEqual({ seq: expect.any(Number), turn: 1 });
        const [event] = await events(s, ["user.steer"]);
        expect(event.data).toEqual({ turn: 1, text: "queued text", requestId, actor: alice, replacesClientMessageId: "x1" });
    }, TIMEOUT);

    it("refuses already_received when the message is the running turn's prompt, part of a merged prompt, a system prompt, or ran in an earlier lifetime", async () => {
        const s = await newSession();
        await catalog.turnStart(s, 1, [prompt("merged", ["y1", "x1"])], "w");
        expect(await convert(s, "x1")).toEqual({ refused: "already_received" });
        expect(await convert(s, "y1")).toEqual({ refused: "already_received" });
        // A user.message recorded outside turn start (the budget/workspace stash) counts too.
        await catalog.recordEvents(s, [{ eventType: "user.message", data: { content: "held", clientMessageIds: ["x2"], budgetQueued: true } }]);
        expect(await convert(s, "x2")).toEqual({ refused: "already_received" });
        await catalog.recordEvents(s, [{ eventType: "system.message", data: { content: "sys", clientMessageIds: ["x3"] } }]);
        expect(await convert(s, "x3")).toEqual({ refused: "already_received" });
        expect(await convert(s, "x4")).toEqual({ seq: expect.any(Number), turn: 1 });

        const revived = await newSession();
        await catalog.turnStart(revived, 0, [prompt("old lifetime", ["x5"])], "w");
        await catalog.softDeleteSession(revived);
        await catalog.createSession(revived, { model: "m" });
        await catalog.turnStart(revived, 0, [prompt("new lifetime", ["y5"])], "w");
        expect(await convert(revived, "x5")).toEqual({ refused: "already_received" });
    }, TIMEOUT);

    it("checks in order: request-id retry, same message, steering off, already received, no turn", async () => {
        const s = await newSession();
        const requestId = rid();
        expect(await convert(s, "x1", "t", requestId)).toEqual({ refused: "no_turn" });
        await catalog.recordEvents(s, [{ eventType: "user.message", data: { content: "ran", clientMessageIds: ["x0"] } }]);
        expect(await convert(s, "x0")).toEqual({ refused: "already_received" });
        expect(await catalog.turnControlAdd(s, "steer", "t", rid(), alice, false, "x0")).toEqual({ refused: "steering_disabled" });

        await catalog.turnStart(s, 1, [prompt("running", ["y1"])], "w");
        const first = await convert(s, "x1", "t", requestId);
        expect(first.seq).toEqual(expect.any(Number));
        // The same request id: the first answer; another message under it: reused.
        expect(await convert(s, "x1", "t", requestId)).toEqual({ ...first, repeat: true });
        expect(await convert(s, "x9", "t", requestId)).toEqual({ refused: "request_id_reused" });
        // A new request id for the same message while its steer is open: the first answer, also when steering is off.
        expect(await convert(s, "x1", "t", rid())).toEqual({ ...first, repeat: true });
        expect(await catalog.turnControlAdd(s, "steer", "t", rid(), alice, false, "x1")).toEqual({ ...first, repeat: true });
        expect(await events(s, ["user.steer"])).toHaveLength(1);
    }, TIMEOUT);

    it("the same message after delivered repeats the first answer; after not_delivered a new attempt is accepted", async () => {
        const s = await newSession();
        await catalog.turnStart(s, 1, [prompt("running", ["y1"])], "w");
        const delivered = await convert(s, "x1");
        await catalog.turnEnd(s, 1, delivered.seq, "other", []);
        await catalog.turnStart(s, 2, [prompt("next", ["y2"])], "w");
        expect(await convert(s, "x1")).toEqual({ ...delivered, repeat: true });

        const missed = await convert(s, "x2");
        await catalog.turnEnd(s, 2, 0, "other", []);
        expect((await outcomes(s))[missed.seq]).toBe("not_delivered");
        await catalog.turnStart(s, 3, [prompt("third", ["y3"])], "w");
        const again = await convert(s, "x2");
        expect(again).toEqual({ seq: expect.any(Number), turn: 3 });
        expect(again.seq).not.toBe(missed.seq);
    }, TIMEOUT);
});

describe("turn end and converted steers (migration 0083)", () => {
    it("a converted steer is never carried: after the cursor it is not delivered while an ordinary steer is carried", async () => {
        const s = await newSession();
        await catalog.turnStart(s, 1, [prompt("running", ["y1"])], "w");
        const read = await convert(s, "x1", "read");
        const missed = await convert(s, "x2", "missed");
        const ordinary = await steer(s, "ordinary");
        const end = await catalog.turnEnd(s, 1, read.seq, "other", []);
        expect(await outcomes(s)).toEqual({ [read.seq]: "delivered", [missed.seq]: "not_delivered", [ordinary.seq]: "carried" });
        expect(end).toEqual({ stopped: false, late: [{ seq: ordinary.seq, text: "ordinary" }], replaced: ["x1"] });
    }, TIMEOUT);

    it("an error result: a delivered converted steer replaces its message; an unread one is not carried into the retry", async () => {
        const s = await newSession();
        await catalog.turnStart(s, 1, [prompt("running", ["y1"])], "w");
        const read = await convert(s, "x1");
        const missed = await convert(s, "x2");
        const end = await catalog.turnEnd(s, 1, read.seq, "error", []);
        expect(await outcomes(s)).toEqual({ [read.seq]: "delivered", [missed.seq]: "not_delivered" });
        expect(end).toEqual({ stopped: false, late: [], replaced: ["x1"] });
    }, TIMEOUT);

    it("a stopped turn replaces nothing, even a converted steer the model read", async () => {
        const s = await newSession();
        await catalog.turnStart(s, 1, [prompt("running", ["y1"])], "w");
        const read = await convert(s, "x1");
        await catalog.turnControlAdd(s, "stop", "halt", rid(), null);
        const end = await catalog.turnEnd(s, 1, read.seq, "stopped", []);
        expect((await outcomes(s))[read.seq]).toBe("not_delivered");
        expect(end).toEqual({ stopped: true, late: [], replaced: [] });
    }, TIMEOUT);

    it("replaced is recomputed: a second turn end and turnReplaced answer the same, per turn and for the latest started turn", async () => {
        const s = await newSession();
        await catalog.turnStart(s, 1, [prompt("running", ["y1"])], "w");
        const a = await convert(s, "x1");
        const b = await convert(s, "x2");
        const end = await catalog.turnEnd(s, 1, b.seq, "other", []);
        expect(end.replaced).toEqual(["x1", "x2"]);
        expect(await catalog.turnEnd(s, 1, 0, "other", [])).toEqual(end);
        expect(await catalog.turnReplaced(s, 1)).toEqual(["x1", "x2"]);
        expect(await catalog.turnReplaced(s)).toEqual(["x1", "x2"]);
        await catalog.turnStart(s, 2, [prompt("next", ["y2"])], "w");
        expect(await catalog.turnReplaced(s)).toEqual([]);
        expect(await catalog.turnReplaced(s, 1)).toEqual(["x1", "x2"]);
        expect(a.turn).toBe(1);
    }, TIMEOUT);

    it("a give-up write closes an open converted steer as not delivered and replaces nothing", async () => {
        const s = await newSession();
        await catalog.turnStart(s, 1, [prompt("running", ["y1"])], "w");
        const open = await convert(s, "x1");
        await catalog.updateSession(s, { state: "error", lastError: "gave up", closeControls: true });
        expect((await outcomes(s))[open.seq]).toBe("not_delivered");
        expect(await catalog.turnReplaced(s)).toEqual([]);
    }, TIMEOUT);
});

describe("upgrade from 0082", () => {
    it("clears the running mark of turns that 0082 started, keeps turn_high, and leaves legacy turns alone", async () => {
        const schema = `${TEST_SCHEMA_PREFIX}_tc_convert_up_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        try {
            await runMigrations(pool, schema, CMS_MIGRATIONS(schema).filter((m) => m.version <= "0082"), 0x63_6D_73);
            const q = (text, values) => pool.query(text.replaceAll("SCHEMA", `"${schema}"`), values);
            for (const id of ["v4", "legacy"]) {
                await q("SELECT SCHEMA.cms_create_session($1, 'm', NULL, NULL, false, NULL, NULL, NULL, NULL, 'private')", [id]);
            }
            await q("SELECT SCHEMA.cms_turn_start($1, 3)", ["v4"]);
            await q("SELECT SCHEMA.cms_set_active_turn_index($1, 6)", ["legacy"]);

            await runCmsMigrations(pool, schema);
            const upgraded = await PgSessionCatalogProvider.create(env.store, schema);
            await upgraded.initialize();
            try {
                expect(await upgraded.getSession("v4")).toMatchObject({ activeTurnIndex: null, turnHigh: 3 });
                expect(await upgraded.getSession("legacy")).toMatchObject({ activeTurnIndex: 6, turnHigh: -1 });
                // No control reaches the 0082-started turn until its retry passes the new turn start.
                expect(await upgraded.turnControlAdd("v4", "steer", "t", rid(), alice, true, "x1")).toEqual({ refused: "no_turn" });
                await upgraded.turnStart("v4", 3, [prompt("retried", ["x1"])], "w");
                expect(await upgraded.turnControlAdd("v4", "steer", "t", rid(), alice, true, "x1")).toEqual({ refused: "already_received" });
                expect((await upgraded.getSessionEvents("v4", 0, 50, ["user.message"])).map((e) => e.data.content)).toEqual(["retried"]);
            } finally {
                await upgraded.close();
            }
        } finally {
            await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        }
    }, TIMEOUT);
});

describe("the runTurnV4 activity records the prompt exactly once (real catalog)", () => {
    const CATALOG_METHODS = ["getSession", "recordEvents", "updateSession", "upsertSessionMetricSummary", "completeTurnWriteback", "turnStart", "turnEnd", "turnReplaced", "setActiveTurnIndex"];
    const realCatalog = (overrides = {}) => ({
        ...Object.fromEntries(CATALOG_METHODS.map((name) => [name, (...args) => catalog[name](...args)])),
        // The harness has no model admission: present the row without a model.
        getSession: async (id) => ({ ...(await catalog.getSession(id)), model: null }),
        ...overrides,
    });
    const input = { prompt: "check the build", clientMessageIds: ["x1"], config: { turnSystemPrompt: "turn note" } };
    const promptCount = async (s) => (await events(s, ["user.message"])).filter((e) => e.data.clientMessageIds?.includes("x1")).length;

    it("first start, a re-dispatch after turn start, a retry after a throw before turn start, and a later retry", async () => {
        const first = await newSession();
        const h = makeRunTurnHarness({ catalogExtras: realCatalog() });
        await h.runTurn(first, { ...input, turnIndex: 1 }, "runTurnV4");
        await h.runTurn(first, { ...input, turnIndex: 1 }, "runTurnV4");            // worker loss: same input again
        expect((await promptRecords(first)).map((r) => r.type)).toEqual(["system.message", "user.message"]);
        expect(await promptCount(first)).toBe(1);

        const thrown = await newSession();
        let failStart = true;
        const t = makeRunTurnHarness({ catalogExtras: realCatalog({
            turnStart: async (...args) => {
                if (failStart) throw new Error("turn start failed");
                return catalog.turnStart(...args);
            },
        }) });
        await expect(t.runTurn(thrown, { ...input, turnIndex: 1 }, "runTurnV4")).rejects.toThrow(/turn start failed/);
        expect(await promptCount(thrown)).toBe(0);
        failStart = false;
        await t.runTurn(thrown, { ...input, turnIndex: 1, retryCount: 1 }, "runTurnV4");   // the retry after the throw
        await t.runTurn(thrown, { ...input, turnIndex: 1, retryCount: 1 }, "runTurnV4");   // re-dispatched after its turn start
        await t.runTurn(thrown, { ...input, turnIndex: 2, retryCount: 2 }, "runTurnV4");   // a returned error's retry: next turn index
        expect(await promptCount(thrown)).toBe(1);
    }, TIMEOUT);
});
