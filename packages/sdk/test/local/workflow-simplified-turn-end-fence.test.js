/**
 * Workflow Simplified, delta review of 5d687726 (RT-D2; formal t4b, design note + C2, C3): turn end with a visit fence,
 * against real PostgreSQL. A continued workflow session's turn ends in one transaction: the session row's lock, then each
 * open Stop that names another visit gets too_late (the classifier and insert live admission uses), then cms_turn_end.
 * - A Stop of another visit added after the live reader retired never turns this turn's error into stopped: the turn
 *   keeps its error (it is retried) and that Stop is too_late.
 * - The turn visit's own Stop, a person's Stop, and (no named visit) none but a person's stop the turn.
 * - The classification reads after the lock: a Stop committed by a holder of the session row's lock while the end waits
 *   for it is classified (not missed by a read taken before the lock).
 * - Idempotent: a Stop live admission already gave too_late keeps one outcome; a second end writes nothing.
 * - Without a fence (every other session) turn end is unchanged.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { DATABASE_URL, TEST_SCHEMA_PREFIX } from "../helpers/local-env.js";
import { PgSessionCatalogProvider } from "../../src/index.ts";

const TIMEOUT = 120_000;
const NX1 = "nx-1111111111111111111111111111111111111111";
const NX2 = "nx-2222222222222222222222222222222222222222";

let env;
let catalog;
let pool;

const sid = () => `tef-${randomUUID()}`;
const stopFor = (s, requestId, text = "cycle ended") => catalog.turnControlAdd(s, "stop", text, requestId, null);

async function outcomes(sessionId) {
    const rows = await catalog.getSessionEvents(sessionId, 0, 500, ["session.control_outcome"]);
    return Object.fromEntries(rows.map((e) => [e.data.seq, e.data.outcome]));
}

async function startedTurn(turn = 5) {
    const s = sid();
    await catalog.createSession(s, { model: "m" });
    expect(await catalog.turnStart(s, turn)).toMatchObject({ stopped: false });
    return s;
}

beforeAll(async () => {
    env = { store: DATABASE_URL, cmsSchema: `${TEST_SCHEMA_PREFIX}_turn_end_fence_${randomUUID().replaceAll("-", "").slice(0, 12)}` };
    catalog = await PgSessionCatalogProvider.create(env.store, env.cmsSchema);
    await catalog.initialize();
    pool = new pg.Pool({ connectionString: env.store, max: 4 });
}, TIMEOUT);

afterAll(async () => {
    await catalog?.close();
    await pool?.query(`DROP SCHEMA IF EXISTS "${env.cmsSchema}" CASCADE`).catch(() => {});
    await pool?.end();
}, TIMEOUT);

describe("RT-D2: turn end with a visit fence", () => {
    it("another visit's Stop after the live reader retired: the turn keeps its error (retried), that Stop is too_late", async () => {
        const s = await startedTurn();
        const foreign = await stopFor(s, `workflow-cycle-stop:${NX1}:sent`);
        const end = await catalog.turnEnd(s, 5, 0, "error", [], { visitFence: { visit: NX2 } });
        expect(end.stopped).toBe(false);
        expect(await outcomes(s)).toEqual({ [foreign.seq]: "too_late" });
        // Without the fence (the defect): the same open Stop turns the error into stopped.
        const unfenced = await startedTurn();
        const open = await stopFor(unfenced, `workflow-cycle-stop:${NX1}:sent`);
        expect((await catalog.turnEnd(unfenced, 5, 0, "error", [])).stopped).toBe(true);
        expect(await outcomes(unfenced)).toEqual({ [open.seq]: "stopped" });
    }, TIMEOUT);

    it("the turn visit's own Stop (direct or inherited) and a person's Stop still stop the turn", async () => {
        const own = await startedTurn();
        const mine = await stopFor(own, `workflow-cycle-stop:${NX2}`);
        expect((await catalog.turnEnd(own, 5, 0, "error", [], { visitFence: { visit: NX2 } })).stopped).toBe(true);
        expect(await outcomes(own)).toEqual({ [mine.seq]: "stopped" });

        const person = await startedTurn();
        const theirs = await stopFor(person, randomUUID(), "Stopped by user");
        const foreign = await stopFor(person, `workflow-cycle-stop:${NX1}`);
        expect((await catalog.turnEnd(person, 5, 0, "error", [], { visitFence: { visit: NX2 } })).stopped).toBe(true);
        expect(await outcomes(person)).toEqual({ [theirs.seq]: "stopped", [foreign.seq]: "too_late" });
    }, TIMEOUT);

    it("a continued session that names no visit (null): every workflow Stop is too_late; a person's Stop applies", async () => {
        const s = await startedTurn();
        const workflowStop = await stopFor(s, `workflow-cycle-stop:${NX1}`);
        expect((await catalog.turnEnd(s, 5, 0, "error", [], { visitFence: { visit: null } })).stopped).toBe(false);
        expect(await outcomes(s)).toEqual({ [workflowStop.seq]: "too_late" });
        const withPerson = await startedTurn();
        const person = await stopFor(withPerson, randomUUID(), "Stopped by user");
        expect((await catalog.turnEnd(withPerson, 5, 0, "error", [], { visitFence: { visit: null } })).stopped).toBe(true);
        expect(await outcomes(withPerson)).toEqual({ [person.seq]: "stopped" });
    }, TIMEOUT);

    it("the classification reads after the session row's lock: a Stop committed while the end waits for the lock is classified", async () => {
        const s = await startedTurn();
        const holder = await pool.connect();
        try {
            await holder.query("BEGIN");
            await holder.query(`SELECT 1 FROM "${env.cmsSchema}".sessions WHERE session_id = $1 FOR UPDATE`, [s]);
            const ending = catalog.turnEnd(s, 5, 0, "error", [], { visitFence: { visit: NX2 } });
            // The end waits for the lock (its id read is in flight behind it); the holder adds another visit's Stop, then commits.
            await new Promise((resolve) => setTimeout(resolve, 200));
            const { rows } = await holder.query(
                `SELECT "${env.cmsSchema}".cms_turn_control_add($1, 'stop', 'cycle ended', $2, NULL::jsonb, true, NULL::text) AS r`,
                [s, `workflow-cycle-stop:${NX1}`]);
            const seq = Number(rows[0].r.seq);
            await holder.query("COMMIT");
            const end = await ending;
            expect(end.stopped).toBe(false);
            expect(await outcomes(s)).toEqual({ [seq]: "too_late" });
        } finally {
            holder.release();
        }
    }, TIMEOUT);

    it("is idempotent: a Stop live admission already gave too_late keeps one outcome; a second end writes nothing", async () => {
        const s = await startedTurn();
        const foreign = await stopFor(s, `workflow-cycle-stop:${NX1}`);
        await pool.query(
            `INSERT INTO "${env.cmsSchema}".session_events (session_id, event_type, data)
             VALUES ($1, 'session.control_outcome', jsonb_build_object('seq', $2::bigint, 'turn', 5, 'outcome', 'too_late'))`, [s, foreign.seq]);
        const first = await catalog.turnEnd(s, 5, 0, "error", [], { visitFence: { visit: NX2 } });
        const count = (await catalog.getSessionEvents(s, 0, 500, ["session.control_outcome"])).length;
        expect(count).toBe(1);
        const again = await catalog.turnEnd(s, 5, 0, "error", [], { visitFence: { visit: NX2 } });
        expect(again).toEqual(first);
        expect((await catalog.getSessionEvents(s, 0, 500, ["session.control_outcome"])).length).toBe(count);
        expect(first.stopped).toBe(false);
    }, TIMEOUT);
});
