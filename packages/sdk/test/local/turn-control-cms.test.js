/**
 * Session turn control, phase A2: migration 0082 procedures against real
 * PostgreSQL (design 7.1, Spec FR-001..FR-004, FR-009, FR-010, FR-014,
 * FR-015, FR-021; plan P17, P19, P20).
 *
 * No model, worker or orchestration: the procedures are driven directly
 * through PgSessionCatalog, the way the worker and the management client
 * will call them.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { DATABASE_URL, TEST_SCHEMA_PREFIX } from "../helpers/local-env.js";
import { PgSessionCatalogProvider } from "../../src/index.ts";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { runCmsMigrations } from "../../src/cms-migrator.ts";

const TIMEOUT = 120_000;

let env;
let catalog;
let pool;

const sid = () => `tc-${randomUUID()}`;
const rid = () => randomUUID();

async function newSession(opts = {}) {
    const id = sid();
    await catalog.createSession(id, { model: "m", ...opts });
    return id;
}

async function events(sessionId, types) {
    return catalog.getSessionEvents(sessionId, 0, 500, types);
}

async function outcomes(sessionId) {
    const rows = await events(sessionId, ["session.control_outcome"]);
    return Object.fromEntries(rows.map((e) => [e.data.seq, e.data.outcome]));
}

async function closings(sessionId) {
    return (await events(sessionId, ["session.carried_steers_closed"])).map((e) => e.data);
}

async function sessionRow(sessionId) {
    const { rows } = await pool.query(
        `SELECT active_turn_index, turn_high, turn_base_seq FROM "${env.cmsSchema}".sessions WHERE session_id = $1`,
        [sessionId],
    );
    return rows[0];
}

function writebackInput(sessionId, turnIndex, extra = {}) {
    return {
        sessionId, agentId: null, model: "m", reasoningEffort: null, turnIndex,
        startedAt: new Date(), endedAt: new Date(), durationMs: 1,
        tokensInput: 0, tokensOutput: 0, tokensCacheRead: 0, tokensCacheWrite: 0,
        toolCalls: 0, toolErrors: 0, toolNames: [], resultType: "completed", errorMessage: null,
        workerNodeId: "w", state: "idle", lastActiveAt: new Date(), lastError: null, waitReason: null,
        currentIteration: turnIndex + 1, ...extra,
    };
}

const steer = (s, text = "guidance", requestId = rid()) => catalog.turnControlAdd(s, "steer", text, requestId, { kind: "user", provider: "dev", subject: "alice" });
const stop = (s, reason = "Stopped by user", requestId = rid()) => catalog.turnControlAdd(s, "stop", reason, requestId, null);

// One schema for the whole file (the suite env resets its schemas after each test).
beforeAll(async () => {
    env = { store: DATABASE_URL, cmsSchema: `${TEST_SCHEMA_PREFIX}_turn_control_cms_${randomUUID().replaceAll("-", "").slice(0, 12)}` };
    catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
    await catalog.initialize();
    pool = new pg.Pool({ connectionString: env.store, max: 4 });
}, TIMEOUT);

afterAll(async () => {
    await catalog?.close();
    await pool?.query(`DROP SCHEMA IF EXISTS "${env.cmsSchema}" CASCADE`).catch(() => {});
    await pool?.end();
});

describe("turn control procedures (migration 0082)", () => {
    it("adds a steer to a running turn, records it, and notifies", async () => {
        const s = await newSession();
        await catalog.turnStart(s, 3);
        const listener = new pg.Client({ connectionString: env.store });
        await listener.connect();
        const got = new Promise((resolve) => listener.on("notification", (m) => resolve(m)));
        await listener.query("LISTEN pilotswarm_turn_control");
        try {
            const requestId = rid();
            const added = await steer(s, "use the v2 API", requestId);
            expect(added).toEqual({ seq: expect.any(Number), turn: 3 });
            const note = await got;
            expect(JSON.parse(note.payload)).toEqual({ schema: env.cmsSchema, sessionId: s });
            const [event] = await events(s, ["user.steer"]);
            expect(event.seq).toBe(added.seq);
            expect(event.data).toEqual({ turn: 3, text: "use the v2 API", requestId, actor: { kind: "user", provider: "dev", subject: "alice" } });
        } finally {
            await listener.end();
        }
    }, TIMEOUT);

    it("refuses with a distinct reason", async () => {
        expect(await steer("missing-session")).toEqual({ refused: "not_found" });

        const idle = await newSession();
        expect(await steer(idle)).toEqual({ refused: "no_turn" });
        expect(await stop(idle)).toEqual({ refused: "no_turn" });

        const legacy = await newSession();
        await catalog.setActiveTurnIndex(legacy, 2);
        expect(await steer(legacy)).toEqual({ refused: "legacy_turn" });

        const full = await newSession();
        await catalog.turnStart(full, 1);
        for (let i = 0; i < 20; i++) expect((await steer(full, `s${i}`)).seq).toEqual(expect.any(Number));
        expect(await steer(full, "21st")).toEqual({ refused: "too_many" });

        const reused = await newSession();
        await catalog.turnStart(reused, 1);
        const id = rid();
        await steer(reused, "first", id);
        expect(await steer(reused, "other text", id)).toEqual({ refused: "request_id_reused" });
        expect(await stop(reused, "first", id)).toEqual({ refused: "request_id_reused" });
        expect((await events(reused, ["user.steer", "user.stop"])).length).toBe(1);
    }, TIMEOUT);

    it("returns the first answer for a retried request id, also after the turn ended", async () => {
        const s = await newSession();
        await catalog.turnStart(s, 4);
        const id = rid();
        const first = await steer(s, "again", id);
        expect(await steer(s, "again", id)).toEqual({ ...first, repeat: true });
        await catalog.completeTurnWriteback(writebackInput(s, 4));
        await catalog.turnEnd(s, 4, 0, "other", []);
        expect(await steer(s, "again", id)).toEqual({ ...first, repeat: true });
        expect((await events(s, ["user.steer"])).length).toBe(1);
    }, TIMEOUT);

    it("turn start marks the turn running, returns open controls in order, refuses stale starts and reports stopped", async () => {
        const s = await newSession();
        expect(await catalog.turnStart(s, 2)).toEqual({ stopped: false, controls: [] });
        expect(await sessionRow(s)).toMatchObject({ active_turn_index: 2, turn_high: 2 });
        const row = await catalog.getSession(s);
        expect(row.turnHigh).toBe(2);
        expect(row.activeTurnIndex).toBe(2);

        const a = await steer(s, "a");
        const b = await stop(s, "halt");
        const again = await catalog.turnStart(s, 2);
        expect(again.stopped).toBe(false);
        expect(again.controls.map((c) => [c.seq, c.kind, c.text])).toEqual([[a.seq, "steer", "a"], [b.seq, "stop", "halt"]]);
        for (const c of again.controls) expect(Number.isNaN(Date.parse(c.createdAt))).toBe(false);

        expect(await catalog.turnStart(s, 1)).toEqual({ stale: true });

        await catalog.completeTurnWriteback(writebackInput(s, 2));
        await catalog.turnEnd(s, 2, 0, "stopped", []);
        expect(await catalog.turnStart(s, 2)).toEqual({ stopped: true, controls: [] });
    }, TIMEOUT);

    it("look returns only controls after the cursor, per running turn", async () => {
        const s1 = await newSession();
        const s2 = await newSession();
        await catalog.turnStart(s1, 1);
        await catalog.turnStart(s2, 7);
        const a = await steer(s1, "a");
        const b = await steer(s1, "b");
        const c = await stop(s2, "c");
        const rows = await catalog.turnLook([
            { sessionId: s1, turn: 1, after: a.seq },
            { sessionId: s2, turn: 7, after: 0 },
            { sessionId: s2, turn: 6, after: 0 },
        ]);
        const bySession = Object.fromEntries(rows.map((r) => [`${r.sessionId}/${r.turn}`, r.controls.map((x) => x.seq)]));
        expect(bySession).toEqual({ [`${s1}/1`]: [b.seq], [`${s2}/7`]: [c.seq], [`${s2}/6`]: [] });
        expect(await catalog.turnLook([])).toEqual([]);
    }, TIMEOUT);

    describe("turn end gives every open control one outcome (Spec FR-009)", () => {
        async function turnWith({ result, cursorAfterFirst, withStop }) {
            const s = await newSession();
            await catalog.turnStart(s, 5);
            const first = await steer(s, "first");
            const second = await steer(s, "second");
            const st = withStop ? await stop(s, "halt") : null;
            const writeback = await catalog.completeTurnWriteback(writebackInput(s, 5));
            expect(writeback).toBe(true);
            const cursor = cursorAfterFirst ? first.seq : 0;
            const end = await catalog.turnEnd(s, 5, cursor, result, []);
            return { s, first, second, st, cursor, end };
        }

        it("a turn that finished otherwise: delivered, carried, too late", async () => {
            const { s, first, second, end } = await turnWith({ result: "other", cursorAfterFirst: true });
            expect(await outcomes(s)).toEqual({ [first.seq]: "delivered", [second.seq]: "carried" });
            expect(end).toEqual({ stopped: false, late: [{ seq: second.seq, text: "second" }] });

            const withStop = await turnWith({ result: "other", cursorAfterFirst: true, withStop: true });
            expect(await outcomes(withStop.s)).toEqual({
                [withStop.first.seq]: "delivered", [withStop.second.seq]: "not_delivered", [withStop.st.seq]: "too_late",
            });
            expect(withStop.end).toEqual({ stopped: false, late: [] });
        }, TIMEOUT);

        it("a turn that returned an error: delivered, carried into the retry, or stopped by an open Stop", async () => {
            const plain = await turnWith({ result: "error", cursorAfterFirst: true });
            expect(await outcomes(plain.s)).toEqual({ [plain.first.seq]: "delivered", [plain.second.seq]: "carried" });
            expect(plain.end).toEqual({ stopped: false, late: [{ seq: plain.second.seq, text: "second" }] });

            const stopped = await turnWith({ result: "error", cursorAfterFirst: true, withStop: true });
            expect(await outcomes(stopped.s)).toEqual({
                [stopped.first.seq]: "delivered", [stopped.second.seq]: "not_delivered", [stopped.st.seq]: "stopped",
            });
            expect(stopped.end).toEqual({ stopped: true, late: [] });
        }, TIMEOUT);

        it("a stopped turn: every steer not delivered, even one at or below the cursor", async () => {
            const { s, first, second, st, end } = await turnWith({ result: "stopped", cursorAfterFirst: true, withStop: true });
            expect(await outcomes(s)).toEqual({ [first.seq]: "not_delivered", [second.seq]: "not_delivered", [st.seq]: "stopped" });
            expect(end).toEqual({ stopped: true, late: [] });
        }, TIMEOUT);

        it("is idempotent: a second call writes nothing and answers the same", async () => {
            const { s, end } = await turnWith({ result: "other", cursorAfterFirst: true, withStop: false });
            const before = (await events(s, ["session.control_outcome"])).length;
            const again = await catalog.turnEnd(s, 5, 0, "other", []);
            expect(again).toEqual(end);
            expect((await events(s, ["session.control_outcome"])).length).toBe(before);
            expect((await sessionRow(s)).active_turn_index).toBe(null);
        }, TIMEOUT);
    });

    it("closes carried steers folded into a turn as ran or stopped, never on an error, once", async () => {
        const s = await newSession();
        await catalog.turnStart(s, 1);
        const late1 = await steer(s, "late one");
        const late2 = await steer(s, "late two");
        await catalog.completeTurnWriteback(writebackInput(s, 1));
        await catalog.turnEnd(s, 1, 0, "other", []);
        const carried = [late1.seq, late2.seq];

        await catalog.turnStart(s, 2);
        await catalog.completeTurnWriteback(writebackInput(s, 2));
        await catalog.turnEnd(s, 2, 0, "error", carried);
        expect(await closings(s)).toEqual([]);

        await catalog.turnStart(s, 3);
        expect(await catalog.completeTurnWriteback(writebackInput(s, 3))).toBe(false);
        await catalog.turnEnd(s, 3, 0, "other", carried);
        expect(await closings(s)).toEqual([{ seqs: carried, turnIndex: 3, reason: "ran" }]);
        await catalog.turnEnd(s, 3, 0, "other", carried);
        await catalog.turnEnd(s, 3, 0, "stopped", carried);
        expect((await closings(s)).length).toBe(1);

        const t = await newSession();
        await catalog.turnStart(t, 1);
        const late = await steer(t, "late");
        await catalog.completeTurnWriteback(writebackInput(t, 1));
        await catalog.turnEnd(t, 1, 0, "other", []);
        await catalog.turnStart(t, 2);
        await catalog.turnEnd(t, 2, 0, "stopped", [late.seq]);
        expect(await closings(t)).toEqual([{ seqs: [late.seq], turnIndex: 2, reason: "stopped" }]);
    }, TIMEOUT);

    it("the end-of-turn write reports open controls, ordered against a concurrent add by the row lock", async () => {
        const s = await newSession();
        await catalog.turnStart(s, 1);
        expect(await catalog.completeTurnWriteback(writebackInput(s, 1))).toBe(false);

        // Add first, inside a transaction that holds the row lock; the write waits, then sees it.
        const a = await newSession();
        await catalog.turnStart(a, 1);
        const adder = await pool.connect();
        try {
            await adder.query("BEGIN");
            const added = await adder.query(`SELECT "${env.cmsSchema}".cms_turn_control_add($1, 'steer', 'x', $2, NULL) AS r`, [a, rid()]);
            expect(added.rows[0].r.seq).toEqual(expect.any(Number));
            const writeback = catalog.completeTurnWriteback(writebackInput(a, 1));
            await adder.query("SELECT pg_sleep(0.3)");
            await adder.query("COMMIT");
            expect(await writeback).toBe(true);
        } finally {
            adder.release();
        }

        // Write first, inside a transaction that holds the row lock; the add waits, then is refused.
        const b = await newSession();
        await catalog.turnStart(b, 1);
        const writer = await pool.connect();
        try {
            await writer.query("BEGIN");
            await writer.query(`UPDATE "${env.cmsSchema}".sessions SET active_turn_index = NULL WHERE session_id = $1`, [b]);
            const add = steer(b, "too late");
            await writer.query("SELECT pg_sleep(0.3)");
            await writer.query("COMMIT");
            expect(await add).toEqual({ refused: "no_turn" });
        } finally {
            writer.release();
        }
    }, TIMEOUT);

    it("a give-up write closes open controls and unclosed carried steers as gave_up", async () => {
        const s = await newSession();
        await catalog.turnStart(s, 1);
        const late = await steer(s, "late");
        await catalog.completeTurnWriteback(writebackInput(s, 1));
        await catalog.turnEnd(s, 1, 0, "other", []);
        await catalog.turnStart(s, 2);
        const open = await steer(s, "open");
        const halt = await stop(s, "halt");
        await catalog.updateSession(s, { state: "error", lastError: "boom", closeControls: true });
        expect(await outcomes(s)).toMatchObject({ [late.seq]: "carried", [open.seq]: "not_delivered", [halt.seq]: "stopped" });
        expect(await closings(s)).toEqual([{ seqs: [late.seq], turnIndex: expect.any(Number), reason: "gave_up" }]);

        await catalog.updateSession(s, { state: "error", closeControls: true });
        expect((await closings(s)).length).toBe(1);
        expect((await events(s, ["session.control_outcome"])).length).toBe(3);
    }, TIMEOUT);

    it("terminal states close open controls and unclosed carried steers as terminal; other updates close nothing", async () => {
        for (const state of ["completed", "failed", "cancelled"]) {
            const s = await newSession();
            await catalog.turnStart(s, 1);
            const late = await steer(s, "late");
            await catalog.completeTurnWriteback(writebackInput(s, 1));
            await catalog.turnEnd(s, 1, 0, "other", []);
            await catalog.turnStart(s, 2);
            const open = await steer(s, "open");
            await catalog.updateSession(s, { state: "idle" });
            await catalog.updateSession(s, { title: "renamed" });
            expect(await closings(s)).toEqual([]);
            expect((await outcomes(s))[open.seq]).toBeUndefined();
            await catalog.updateSession(s, { state });
            expect((await outcomes(s))[open.seq]).toBe("not_delivered");
            expect(await closings(s)).toEqual([{ seqs: [late.seq], turnIndex: expect.any(Number), reason: "terminal" }]);
        }
    }, TIMEOUT);

    it("a steer closed as ran is never closed again", async () => {
        const s = await newSession();
        await catalog.turnStart(s, 1);
        const late = await steer(s, "late");
        await catalog.turnEnd(s, 1, 0, "other", []);
        await catalog.turnStart(s, 2);
        await catalog.turnEnd(s, 2, 0, "other", [late.seq]);
        await catalog.updateSession(s, { state: "completed" });
        expect(await closings(s)).toEqual([{ seqs: [late.seq], turnIndex: 2, reason: "ran" }]);
    }, TIMEOUT);

    it("a revived session starts a new lifetime: old outcomes, open controls and carried steers do not reach its turns", async () => {
        const s = await newSession();
        await catalog.turnStart(s, 0);
        await stop(s, "old stop");
        await catalog.turnEnd(s, 0, 0, "stopped", []);
        await catalog.turnStart(s, 1);
        const late = await steer(s, "old late");
        await catalog.turnEnd(s, 1, 0, "other", []);
        await catalog.turnStart(s, 2);
        const open = await steer(s, "old open");

        await catalog.softDeleteSession(s);
        await catalog.createSession(s, { model: "m" });

        const row = await sessionRow(s);
        expect(row.turn_high).toBe(-1);
        expect(row.active_turn_index).toBe(null);
        const maxSeq = Math.max(...(await events(s)).map((e) => e.seq));
        expect(Number(row.turn_base_seq)).toBe(maxSeq);
        expect((await outcomes(s))[open.seq]).toBe("not_delivered");
        expect(await closings(s)).toEqual([{ seqs: [late.seq], turnIndex: expect.any(Number), reason: "terminal" }]);

        expect(await catalog.turnStart(s, 0)).toEqual({ stopped: false, controls: [] });
        await catalog.turnStart(s, 1);
        expect(await catalog.turnEnd(s, 1, 0, "other", [])).toEqual({ stopped: false, late: [] });
        await catalog.turnStart(s, 2);
        const fresh = await steer(s, "new", rid());
        expect(fresh.turn).toBe(2);
    }, TIMEOUT);

    it("a system-session restart archive resets the turn columns, and its revive starts at turn 0", async () => {
        const s = await newSession({ isSystem: true });
        await catalog.turnStart(s, 9);
        await steer(s, "old");
        await catalog.archiveSystemSessionForRestart(s, "completed");
        expect(await sessionRow(s)).toMatchObject({ active_turn_index: null, turn_high: -1 });
        await catalog.createSession(s, { model: "m", isSystem: true });
        expect(await catalog.turnStart(s, 0)).toEqual({ stopped: false, controls: [] });
        expect((await steer(s, "new")).turn).toBe(0);
    }, TIMEOUT);

    it("0081-era catalog calls keep working against 0082", async () => {
        const s = await newSession();
        await catalog.setActiveTurnIndex(s, 3);
        const input = writebackInput(s, 3);
        await pool.query(
            `SELECT "${env.cmsSchema}".cms_complete_turn_writeback($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)`,
            [input.sessionId, null, "m", null, 3, input.startedAt, input.endedAt, 1, 0, 0, 0, 0, 0, 0, [], "completed", null, "w", "idle", input.lastActiveAt, null, null, 4],
        );
        expect((await sessionRow(s)).active_turn_index).toBe(null);
        await catalog.updateSession(s, { state: "running", title: "t" });
        const row = await catalog.getSession(s);
        expect(row.title).toBe("t");
        expect(row.turnHigh).toBe(-1);
        expect((await catalog.listSessions()).some((r) => r.sessionId === s)).toBe(true);
    }, TIMEOUT);

    it("upgrades a database at 0081 with a running legacy turn", async () => {
        const schema = `${TEST_SCHEMA_PREFIX}_turn_control_up_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        try {
            await runMigrations(pool, schema, CMS_MIGRATIONS(schema).filter((m) => m.version <= "0081"), 0x63_6D_73);
            const q = (text, values) => pool.query(text.replaceAll("SCHEMA", `"${schema}"`), values);
            await q("SELECT SCHEMA.cms_create_session($1, 'm', NULL, NULL, false, NULL, NULL, NULL, NULL, 'private')", ["legacy"]);
            await q("SELECT SCHEMA.cms_set_active_turn_index($1, 6)", ["legacy"]);
            expect((await q("SELECT to_regproc($1) AS f", [`"${schema}".cms_turn_start`])).rows[0].f).toBe(null);

            await runCmsMigrations(pool, schema);
            const upgraded = await PgSessionCatalogProvider.create(env.store, schema);
            await upgraded.initialize();
            try {
                const row = await upgraded.getSession("legacy");
                expect(row).toMatchObject({ activeTurnIndex: 6, turnHigh: -1 });
                expect(await upgraded.turnControlAdd("legacy", "stop", "halt", rid(), null)).toEqual({ refused: "legacy_turn" });
                expect(await upgraded.completeTurnWriteback(writebackInput("legacy", 6))).toBe(false);
                expect((await upgraded.getSession("legacy")).activeTurnIndex).toBe(null);
            } finally {
                await upgraded.close();
            }
        } finally {
            await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        }
    }, TIMEOUT);

    it("publishes the sessions.steering flag off, without user override", async () => {
        const { rows } = await pool.query(
            `SELECT default_enabled, default_allow_user_override, required_capability FROM "${env.cmsSchema}".feature_flags WHERE feature_key = 'sessions.steering'`,
        );
        expect(rows).toEqual([{ default_enabled: false, default_allow_user_override: false, required_capability: null }]);
        const settings = await pool.query(
            `SELECT enabled, allow_user_override FROM "${env.cmsSchema}".feature_flag_settings WHERE feature_key = 'sessions.steering' AND scope = 'cluster'`,
        );
        expect(settings.rows).toEqual([{ enabled: false, allow_user_override: false }]);
    }, TIMEOUT);
});
