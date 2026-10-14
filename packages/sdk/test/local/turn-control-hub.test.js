/**
 * Session turn control, phase A3: the worker's TurnControlHub (design 4.4,
 * 7.3; Spec FR-005, FR-022, SC-007; plan P21).
 *
 * Two parts:
 * - lifecycle and timing with in-memory clients and hand-driven timers, so
 *   connection setup, stop, reconnect and the periodic look are deterministic;
 * - delivery against real PostgreSQL with a PgSessionCatalog (migration 0082),
 *   where notification delivery and connection counts are the requirement.
 */
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { DATABASE_URL, TEST_SCHEMA_PREFIX } from "../helpers/local-env.js";
import { PgSessionCatalogProvider } from "../../src/index.ts";
import { TurnControlHub } from "../../src/turn-control.ts";

const TIMEOUT = 60_000;

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const within = (promise, ms, label) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}: not within ${ms} ms`)), ms).unref?.()),
]);

/** Timers the test fires by hand. */
function manualTimers() {
    const t = {
        intervals: [],
        timeouts: [],
        setInterval(fn, ms) { const h = { fn, ms, cleared: false }; t.intervals.push(h); return h; },
        clearInterval(h) { if (h) h.cleared = true; },
        setTimeout(fn, ms) { const h = { fn, ms, cleared: false, fired: false }; t.timeouts.push(h); return h; },
        clearTimeout(h) { if (h) h.cleared = true; },
        tick() { for (const h of t.intervals) if (!h.cleared) h.fn(); },
        fireTimeouts() {
            for (const h of t.timeouts.splice(0)) if (!h.cleared && !h.fired) { h.fired = true; h.fn(); }
        },
        active() {
            return [...t.intervals, ...t.timeouts].filter((h) => !h.cleared && !h.fired).length;
        },
    };
    return t;
}

/** In-memory LISTEN client whose connect and LISTEN steps the test controls. */
function fakeClient({ holdConnect = false, holdListen = false, failListen = null } = {}) {
    const handlers = { notification: [], error: [], end: [] };
    const c = {
        ended: false,
        connectGate: deferred(),
        listenGate: deferred(),
        on(event, fn) { handlers[event].push(fn); },
        async connect() {
            if (!holdConnect) c.connectGate.resolve();
            await c.connectGate.promise;
            if (c.ended) throw new Error("ended during connect");
        },
        async query() {
            if (failListen) throw failListen;
            if (!holdListen) c.listenGate.resolve();
            await c.listenGate.promise;
            if (c.ended) throw new Error("ended during LISTEN");
        },
        async end() {
            if (c.ended) return;
            c.ended = true;
            c.connectGate.reject?.(new Error("ended"));
            c.listenGate.reject?.(new Error("ended"));
            for (const fn of handlers.end) fn();
        },
        emit(event, payload) { for (const fn of handlers[event]) fn(payload); },
    };
    c.connectGate.promise.catch(() => {});
    c.listenGate.promise.catch(() => {});
    return c;
}

/** A running turn as the hub sees it: records what it is handed, advances `sent`. */
function stubTurn(sessionId, turn) {
    const stub = {
        sessionId,
        turn,
        sent: 0,
        received: [],
        next: deferred(),
        get key() { return `${sessionId}/${turn}`; },
        lookArgs() { return { sessionId, turn, after: stub.sent }; },
        async enqueue(controls) {
            for (const c of controls) {
                if (c.seq <= stub.sent) continue;
                stub.sent = c.seq;
                stub.received.push(c);
            }
            if (controls.length > 0) { const d = stub.next; stub.next = deferred(); d.resolve(); }
        },
    };
    return stub;
}

function countingCatalog(rowsFor = () => []) {
    const catalog = {
        calls: [],
        async turnLook(turns) {
            catalog.calls.push(turns);
            return turns.map((t) => ({ sessionId: t.sessionId, turn: t.turn, controls: rowsFor(t) }));
        },
    };
    return catalog;
}

describe("turn control hub: lifecycle (in-memory clients, hand-driven timers)", () => {
    it("looks every 5 s by default, batched, and never while no turn runs", async () => {
        const timers = manualTimers();
        const catalog = countingCatalog();
        const hub = new TurnControlHub({ catalog, schema: "s", createClient: null, timers });
        await hub.start();
        expect(timers.intervals.map((h) => h.ms)).toEqual([5_000]);
        timers.tick();
        await flush();
        expect(catalog.calls).toEqual([]);
        const turns = [stubTurn("a", 1), stubTurn("b", 1), stubTurn("c", 1)];
        for (const t of turns) await hub.register(t);
        expect(catalog.calls.map((c) => c.length)).toEqual([1, 1, 1]);
        catalog.calls.length = 0;
        timers.tick();
        await flush();
        expect(catalog.calls.map((c) => c.length)).toEqual([3]);
        for (const t of turns) hub.unregister(t);
        catalog.calls.length = 0;
        timers.tick();
        await flush();
        expect(catalog.calls).toEqual([]);
        await hub.stop();
        expect(timers.active()).toBe(0);
    });

    it("keeps delivering by the periodic look while reconnect is unavailable, then looks at once on recovery", async () => {
        const timers = manualTimers();
        let rows = [];
        const catalog = countingCatalog(() => rows);
        let attempts = 0;
        const healthy = fakeClient();
        const hub = new TurnControlHub({
            catalog, schema: "s", timers,
            createClient: () => { attempts += 1; return attempts === 1 ? healthy : fakeClient({ failListen: new Error("database down") }); },
        });
        await hub.start();
        expect(hub.listening).toBe(true);
        const turn = stubTurn("a", 1);
        await hub.register(turn);
        healthy.emit("end");
        expect(hub.listening).toBe(false);
        expect(timers.timeouts.length).toBe(1);
        timers.fireTimeouts();                     // reconnect attempt fails: LISTEN refused
        await flush();
        expect(hub.listening).toBe(false);
        rows = [{ seq: 7, kind: "steer", text: "x", createdAt: "t" }];
        timers.tick();                             // the periodic look still delivers
        await flush();
        expect(turn.received.map((c) => c.seq)).toEqual([7]);

        // Recovery: the next reconnect succeeds and looks at once.
        attempts = 0;
        const recovered = fakeClient();
        hub.opts.createClient = () => recovered;
        rows = [{ seq: 8, kind: "steer", text: "y", createdAt: "t" }];
        catalog.calls.length = 0;
        timers.fireTimeouts();
        await flush();
        expect(hub.listening).toBe(true);
        expect(catalog.calls.length).toBe(1);
        expect(turn.received.map((c) => c.seq)).toEqual([7, 8]);
        await hub.stop();
        expect(recovered.ended).toBe(true);
    });

    for (const step of ["create", "connect", "LISTEN"]) {
        it(`stop() while ${step} is in flight closes the client and publishes no listener`, async () => {
            const timers = manualTimers();
            const created = deferred();
            const client = fakeClient({ holdConnect: step === "connect", holdListen: step === "LISTEN" });
            const hub = new TurnControlHub({
                catalog: countingCatalog(), schema: "s", timers,
                createClient: () => (step === "create" ? created.promise : client),
            });
            const started = hub.start();
            await flush();
            const stopped = hub.stop();
            if (step === "create") created.resolve(client);
            await stopped;
            await started;
            expect(hub.listening).toBe(false);
            expect(client.ended).toBe(true);
            expect(timers.active()).toBe(0);
        });
    }

    it("an error during setup publishes no dead listener and schedules a reconnect", async () => {
        const timers = manualTimers();
        const client = fakeClient({ holdListen: true });
        const logs = [];
        const hub = new TurnControlHub({ catalog: countingCatalog(), schema: "s", timers, createClient: () => client, log: (m) => logs.push(m) });
        const started = hub.start();
        await flush();
        client.emit("error", new Error("socket reset"));
        client.listenGate.resolve();
        await started;
        expect(hub.listening).toBe(false);
        expect(client.ended).toBe(true);
        expect(timers.timeouts.filter((h) => !h.cleared).length).toBe(1);
        expect(logs.some((m) => m.includes("LISTEN unavailable"))).toBe(true);
        await hub.stop();
    });

    it("stop then start with an old attempt finishing late: one listener, from the new start", async () => {
        const timers = manualTimers();
        const old = fakeClient({ holdListen: true });
        const fresh = fakeClient();
        let n = 0;
        const hub = new TurnControlHub({ catalog: countingCatalog(), schema: "s", timers, createClient: () => (++n === 1 ? old : fresh) });
        const first = hub.start();
        await flush();
        await hub.stop();
        await first;
        await hub.start();
        expect(hub.listening).toBe(true);
        expect(old.ended).toBe(true);
        expect(fresh.ended).toBe(false);
        expect(n).toBe(2);
        await hub.stop();
    });

    for (const restarts of [1, 2]) {
        it(`${restarts === 2 ? "two restarts" : "a restart"} waiting on an obsolete attempt: one replacement listener, one interval, nothing left after stop`, async () => {
            const timers = manualTimers();
            const catalog = countingCatalog();
            const created = deferred();
            const old = fakeClient();
            const clients = [];
            const hub = new TurnControlHub({
                catalog, schema: "s", timers,
                createClient: () => {
                    if (clients.length === 0) { clients.push(old); return created.promise; }
                    const c = fakeClient();
                    clients.push(c);
                    return c;
                },
            });
            const first = hub.start();                        // 1. blocked in client creation
            await flush();
            const stopping = hub.stop();                      // 2. not awaited
            const starts = Array.from({ length: restarts }, () => hub.start());   // 3. wait on the old attempt
            await flush();
            created.resolve(old);                             // 4. the obsolete client is closed
            await Promise.all([first, stopping, ...starts]);  // 5, 6. the restarts continue
            expect(old.ended).toBe(true);
            expect(clients.length).toBe(2);
            expect(clients[1].ended).toBe(false);
            expect(hub.listening).toBe(true);
            expect(timers.intervals.filter((h) => !h.cleared).length).toBe(1);
            await hub.register(stubTurn("a", 1));
            await hub.stop();
            expect(clients[1].ended).toBe(true);
            expect(timers.active()).toBe(0);
            const looks = catalog.calls.length;
            for (const h of timers.intervals) if (!h.cleared) h.fn();
            await flush();
            expect(catalog.calls.length).toBe(looks);
        });
    }

    it("a start racing a later stop leaves the hub stopped", async () => {
        const timers = manualTimers();
        const created = deferred();
        const old = fakeClient();
        let n = 0;
        const hub = new TurnControlHub({ catalog: countingCatalog(), schema: "s", timers, createClient: () => (++n === 1 ? created.promise : fakeClient()) });
        const first = hub.start();
        await flush();
        const stop1 = hub.stop();
        const restart = hub.start();
        const stop2 = hub.stop();
        created.resolve(old);
        await Promise.all([first, stop1, restart, stop2]);
        expect(hub.listening).toBe(false);
        expect(n).toBe(1);
        expect(timers.active()).toBe(0);
    });

    it("a repeated start makes no second connection", async () => {
        const timers = manualTimers();
        let n = 0;
        const hub = new TurnControlHub({ catalog: countingCatalog(), schema: "s", timers, createClient: () => { n += 1; return fakeClient(); } });
        await Promise.all([hub.start(), hub.start()]);
        expect(n).toBe(1);
        expect(timers.intervals.length).toBe(1);
        await hub.stop();
        expect(timers.active()).toBe(0);
    });

    it("ignores notifications for another schema", async () => {
        const timers = manualTimers();
        const client = fakeClient();
        const catalog = countingCatalog();
        const hub = new TurnControlHub({ catalog, schema: "mine", timers, createClient: () => client });
        await hub.start();
        await hub.register(stubTurn("a", 1));
        catalog.calls.length = 0;
        client.emit("notification", { channel: "pilotswarm_turn_control", payload: JSON.stringify({ schema: "other", sessionId: "a" }) });
        await flush();
        expect(catalog.calls).toEqual([]);
        client.emit("notification", { channel: "pilotswarm_turn_control", payload: JSON.stringify({ schema: "mine", sessionId: "a" }) });
        await flush();
        expect(catalog.calls.length).toBe(1);
        await hub.stop();
    });
});

describe("turn control hub: real PostgreSQL", () => {
    const schema = `${TEST_SCHEMA_PREFIX}_turn_control_hub_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    let catalog;
    let pool;
    const appName = () => `tc-hub-test-${randomUUID().slice(0, 8)}`;

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

    async function runningTurn(turn = 1) {
        const sessionId = `hub-${randomUUID()}`;
        await catalog.createSession(sessionId, { model: "m" });
        await catalog.turnStart(sessionId, turn);
        return sessionId;
    }
    const steer = (sessionId, text = "guidance") => catalog.turnControlAdd(sessionId, "steer", text, randomUUID(), null);
    async function connections(applicationName) {
        const { rows } = await pool.query("SELECT pid FROM pg_stat_activity WHERE application_name = $1", [applicationName]);
        return rows.length;
    }
    function hubWith(opts = {}) {
        const applicationName = appName();
        const hub = new TurnControlHub({
            catalog, schema,
            // A plain LISTEN client with its own application name, so the test can count its connections.
            createClient: () => new pg.Client({ connectionString: DATABASE_URL, application_name: applicationName, keepAlive: true }),
            lookIntervalMs: 60_000,
            ...opts,
        });
        return { hub, applicationName };
    }

    it("a notification wakes the right turn without waiting for the periodic look", async () => {
        const { hub } = hubWith();
        await hub.start();
        try {
            expect(hub.listening).toBe(true);
            const a = stubTurn(await runningTurn(), 1);
            const b = stubTurn(await runningTurn(), 1);
            await hub.register(a);
            await hub.register(b);
            const delivered = a.next.promise;
            const added = await steer(a.sessionId, "for a");
            await within(delivered, 2_000, "notification delivery");
            expect(a.received).toEqual([expect.objectContaining({ seq: added.seq, kind: "steer", text: "for a" })]);
            expect(b.received).toEqual([]);
        } finally {
            await hub.stop();
        }
    }, TIMEOUT);

    it("registering a turn finds controls accepted before it registered", async () => {
        const { hub } = hubWith({ createClient: null });
        await hub.start();
        try {
            const sessionId = await runningTurn(2);
            const early = await steer(sessionId, "early");
            const turn = stubTurn(sessionId, 2);
            await hub.register(turn);
            expect(turn.received.map((c) => c.seq)).toEqual([early.seq]);
        } finally {
            await hub.stop();
        }
    }, TIMEOUT);

    it("holds exactly one connection while running and closes it on stop; a killed connection is replaced", async () => {
        const { hub, applicationName } = hubWith();
        expect(await connections(applicationName)).toBe(0);
        await hub.start();
        expect(await connections(applicationName)).toBe(1);
        await pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1", [applicationName]);
        // Reconnect after the 1 s backoff is the requirement here: a real elapsed-time wait.
        const deadline = Date.now() + 10_000;
        while (!(hub.listening && await connections(applicationName) === 1) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 100));
        }
        expect(hub.listening).toBe(true);
        expect(await connections(applicationName)).toBe(1);
        await hub.stop();
        expect(hub.listening).toBe(false);
        expect(await connections(applicationName)).toBe(0);
    }, TIMEOUT);

    it("the catalog supplies the listener connection with its own settings", async () => {
        const client = await catalog.createTurnControlListener();
        try {
            await client.connect();
            const { rows } = await client.query("SELECT current_setting('application_name') AS name");
            expect(rows[0].name).toBe("pilotswarm-turn-control");
        } finally {
            await client.end();
        }
    }, TIMEOUT);
});
