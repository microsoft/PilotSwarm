/**
 * Session turn control, phase A3: the worker's TurnControlHub against real
 * PostgreSQL (design 4.4, 7.3; Spec FR-005, FR-022, SC-007; plan P21).
 *
 * A stub stands in for a running turn; the hub's catalog is a real
 * PgSessionCatalog with migration 0082.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { DATABASE_URL, TEST_SCHEMA_PREFIX } from "../helpers/local-env.js";
import { PgSessionCatalogProvider } from "../../src/index.ts";
import { TurnControlHub, pgListenClientFactory } from "../../src/turn-control.ts";

const TIMEOUT = 60_000;
const schema = `${TEST_SCHEMA_PREFIX}_turn_control_hub_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
let catalog;
let pool;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await sleep(20);
    }
    return predicate();
}

/** A running turn as the hub sees it: records what it is handed, advances `sent`. */
function stubTurn(sessionId, turn) {
    const stub = {
        sessionId,
        turn,
        sent: 0,
        received: [],
        get key() { return `${sessionId}/${turn}`; },
        lookArgs() { return { sessionId, turn, after: stub.sent }; },
        async enqueue(controls) {
            for (const c of controls) {
                if (c.seq <= stub.sent) continue;
                stub.sent = c.seq;
                stub.received.push(c);
            }
        },
    };
    return stub;
}

async function runningTurn(turn = 1) {
    const sessionId = `hub-${randomUUID()}`;
    await catalog.createSession(sessionId, { model: "m" });
    await catalog.turnStart(sessionId, turn);
    return sessionId;
}

const steer = (sessionId, text = "guidance") => catalog.turnControlAdd(sessionId, "steer", text, randomUUID(), null);

// Every hub in this file connects under its own application name, so the
// connection checks never see other test files' workers.
const appName = () => `tc-hub-test-${randomUUID().slice(0, 8)}`;

async function listenerConnections(applicationName) {
    const { rows } = await pool.query(
        "SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND datname = current_database()",
        [applicationName],
    );
    return rows.map((r) => r.pid);
}

function hubWith(opts = {}, applicationName = appName()) {
    const spyCatalog = {
        calls: [],
        async turnLook(turns) {
            spyCatalog.calls.push(turns);
            return catalog.turnLook(turns);
        },
    };
    const hub = new TurnControlHub({
        catalog: spyCatalog,
        schema,
        createClient: pgListenClientFactory({ connectionString: DATABASE_URL, application_name: applicationName }),
        lookIntervalMs: 60_000,
        ...opts,
    });
    return { hub, spyCatalog, applicationName };
}

beforeAll(async () => {
    catalog = await PgSessionCatalogProvider.create(DATABASE_URL, schema);
    await catalog.initialize();
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
}, TIMEOUT);

afterAll(async () => {
    await catalog?.close();
    await pool?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool?.end();
});

describe("turn control: worker hub", () => {
    it("a notification wakes the right turn well before the periodic look", async () => {
        const { hub } = hubWith();
        await hub.start();
        try {
            expect(hub.listening).toBe(true);
            const a = stubTurn(await runningTurn(), 1);
            const b = stubTurn(await runningTurn(), 1);
            hub.register(a);
            hub.register(b);
            await sleep(100);
            const added = await steer(a.sessionId, "for a");
            expect(await waitFor(() => a.received.length === 1, 2_000)).toBe(true);
            expect(a.received[0]).toMatchObject({ seq: added.seq, kind: "steer", text: "for a" });
            expect(b.received).toEqual([]);
        } finally {
            await hub.stop();
        }
    }, TIMEOUT);

    it("registering a turn looks once, so controls accepted before registration are found", async () => {
        const { hub } = hubWith({ createClient: null });
        await hub.start();
        try {
            const sessionId = await runningTurn(2);
            const early = await steer(sessionId, "early");
            const turn = stubTurn(sessionId, 2);
            hub.register(turn);
            expect(await waitFor(() => turn.received.length === 1, 2_000)).toBe(true);
            expect(turn.received[0].seq).toBe(early.seq);
        } finally {
            await hub.stop();
        }
    }, TIMEOUT);

    it("a killed LISTEN connection still delivers through the periodic look, then reconnects", async () => {
        const { hub, applicationName } = hubWith({ lookIntervalMs: 1_000 });
        await hub.start();
        try {
            const turn = stubTurn(await runningTurn(), 1);
            hub.register(turn);
            expect((await listenerConnections(applicationName)).length).toBe(1);
            await pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1", [applicationName]);
            expect(await waitFor(() => !hub.listening, 2_000)).toBe(true);
            await steer(turn.sessionId, "after the kill");
            const started = Date.now();
            expect(await waitFor(() => turn.received.length === 1, 5_000)).toBe(true);
            expect(Date.now() - started).toBeLessThan(5_000);
            expect(await waitFor(() => hub.listening, 10_000)).toBe(true);
        } finally {
            await hub.stop();
        }
    }, TIMEOUT);

    it("makes no look while no turn is registered, and one batched look for several turns", async () => {
        const { hub, spyCatalog } = hubWith({ createClient: null, lookIntervalMs: 50 });
        await hub.start();
        try {
            await sleep(300);
            expect(spyCatalog.calls.length).toBe(0);
            const turns = [stubTurn(await runningTurn(), 1), stubTurn(await runningTurn(), 1), stubTurn(await runningTurn(), 1)];
            for (const t of turns) hub.register(t);
            await sleep(80);
            spyCatalog.calls.length = 0;
            await sleep(120);
            expect(spyCatalog.calls.length).toBeGreaterThan(0);
            for (const call of spyCatalog.calls) expect(call.length).toBe(3);
            for (const t of turns) hub.unregister(t);
            await sleep(80);
            spyCatalog.calls.length = 0;
            await sleep(200);
            expect(spyCatalog.calls.length).toBe(0);
        } finally {
            await hub.stop();
        }
    }, TIMEOUT);

    it("a refused LISTEN degrades to the periodic look without failing start", async () => {
        const refusing = () => ({
            on() {},
            async connect() {},
            async query() { throw new Error("LISTEN is not supported"); },
            async end() {},
        });
        const logs = [];
        const { hub } = hubWith({ createClient: refusing, lookIntervalMs: 200, log: (m) => logs.push(m) });
        await hub.start();
        try {
            expect(hub.listening).toBe(false);
            expect(logs.some((m) => m.includes("LISTEN unavailable"))).toBe(true);
            const turn = stubTurn(await runningTurn(), 1);
            hub.register(turn);
            await sleep(100);
            await steer(turn.sessionId);
            expect(await waitFor(() => turn.received.length === 1, 2_000)).toBe(true);
        } finally {
            await hub.stop();
        }
    }, TIMEOUT);

    it("holds exactly one connection while running and closes it on stop", async () => {
        const { hub, applicationName } = hubWith();
        expect((await listenerConnections(applicationName)).length).toBe(0);
        await hub.start();
        expect(await waitFor(async () => (await listenerConnections(applicationName)).length === 1, 2_000)).toBe(true);
        await hub.stop();
        expect(hub.listening).toBe(false);
        expect(await waitFor(async () => (await listenerConnections(applicationName)).length === 0, 2_000)).toBe(true);
    }, TIMEOUT);

    it("ignores notifications for another schema", async () => {
        const { hub, spyCatalog } = hubWith();
        await hub.start();
        try {
            const turn = stubTurn(await runningTurn(), 1);
            hub.register(turn);
            await sleep(100);
            spyCatalog.calls.length = 0;
            await pool.query("SELECT pg_notify('pilotswarm_turn_control', $1)", [JSON.stringify({ schema: "some_other_schema", sessionId: turn.sessionId })]);
            await sleep(200);
            expect(spyCatalog.calls.length).toBe(0);
        } finally {
            await hub.stop();
        }
    }, TIMEOUT);
});
