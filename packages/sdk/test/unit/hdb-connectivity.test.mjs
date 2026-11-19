/**
 * The local suite's connection handling on HorizonDB (test/helpers/hdb-connectivity.js): the cleanup connect policy and its
 * one retry, the 30 s probe, and that everything is a no-op on PostgreSQL.
 *
 * Run: node --test test/unit/hdb-connectivity.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    CLEANUP_CONNECT_TIMEOUT_MS,
    CLEANUP_RETRY_BACKOFF_MS,
    CONNECTION_COUNT_SQL,
    PROBE_INTERVAL_MS,
    cleanupConnectPolicy,
    connectWithRetry,
    createRefCounted,
    probeIntervalFor,
    startConnectionProbe,
} from "../helpers/hdb-connectivity.js";

/** A client whose connect results come from `connects` (an Error rejects) and whose query results from `rows`. */
function fakeClientFactory({ connects = [], count = 7, connectDelay = 0, onQuery } = {}) {
    const made = [];
    const createClient = async connectionTimeoutMillis => {
        const client = {
            connectionTimeoutMillis,
            connected: false,
            ended: false,
            queries: [],
            async connect() {
                if (connectDelay) await new Promise(resolve => setTimeout(resolve, connectDelay));
                const next = connects.shift();
                if (next instanceof Error) throw next;
                client.connected = true;
            },
            async query(sql) {
                client.queries.push(sql);
                onQuery?.(sql);
                return { rows: [{ count: String(count) }] };
            },
            async end() { client.ended = true; },
        };
        made.push(client);
        return client;
    };
    return { createClient, made };
}

test("the cleanup policy: bounded connect and one retry on HorizonDB, one plain attempt elsewhere", () => {
    assert.deepEqual(cleanupConnectPolicy("postgres", {}), { connectionTimeoutMillis: undefined, attempts: 1, backoffMs: 0 });
    assert.deepEqual(cleanupConnectPolicy("postgres", { PS_TEST_CLEANUP_CONNECT_TIMEOUT_MS: "5000" }), { connectionTimeoutMillis: undefined, attempts: 1, backoffMs: 0 });
    assert.deepEqual(cleanupConnectPolicy("horizondb", {}), { connectionTimeoutMillis: CLEANUP_CONNECT_TIMEOUT_MS, attempts: 2, backoffMs: CLEANUP_RETRY_BACKOFF_MS });
    assert.equal(CLEANUP_CONNECT_TIMEOUT_MS, 15_000);
    assert.equal(cleanupConnectPolicy("horizondb", { PS_TEST_CLEANUP_CONNECT_TIMEOUT_MS: "3000" }).connectionTimeoutMillis, 3000);
    for (const ignored of ["", "0", "-1", "soon", "1.5"]) {
        assert.equal(cleanupConnectPolicy("horizondb", { PS_TEST_CLEANUP_CONNECT_TIMEOUT_MS: ignored }).connectionTimeoutMillis, CLEANUP_CONNECT_TIMEOUT_MS, ignored);
    }
});

test("a connect that works the first time logs nothing and does not sleep", async () => {
    const { createClient, made } = fakeClientFactory();
    const logs = [];
    const sleeps = [];
    const client = await connectWithRetry({ createClient, policy: cleanupConnectPolicy("horizondb", {}), log: l => logs.push(l), sleep: ms => sleeps.push(ms) });
    assert.equal(made.length, 1);
    assert.equal(client, made[0]);
    assert.equal(made[0].connectionTimeoutMillis, 15_000);
    assert.deepEqual(logs, []);
    assert.deepEqual(sleeps, []);
});

test("a failed connect is retried once with a new client, a back-off and one log line", async () => {
    const { createClient, made } = fakeClientFactory({ connects: [new Error("Connection terminated due to connection timeout")] });
    const logs = [];
    const sleeps = [];
    const client = await connectWithRetry({
        createClient, label: "schema cleanup", policy: cleanupConnectPolicy("horizondb", {}),
        log: l => logs.push(l), sleep: async ms => { sleeps.push(ms); },
    });
    assert.equal(made.length, 2);
    assert.equal(client, made[1]);
    assert.equal(made[0].ended, true, "the failed client is closed");
    assert.equal(made[1].connected, true);
    assert.deepEqual(sleeps, [CLEANUP_RETRY_BACKOFF_MS]);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /schema cleanup: connect failed \(Connection terminated due to connection timeout\); retrying in 2000 ms/);
});

test("when the retry fails too the last error is thrown and no more attempts are made", async () => {
    const { createClient, made } = fakeClientFactory({ connects: [new Error("first"), new Error("second")] });
    const logs = [];
    await assert.rejects(
        connectWithRetry({ createClient, policy: cleanupConnectPolicy("horizondb", {}), log: l => logs.push(l), sleep: async () => {} }),
        /second/,
    );
    assert.equal(made.length, 2);
    assert.equal(made.every(c => c.ended), true);
    assert.equal(logs.length, 1);
});

test("on PostgreSQL a failed connect is thrown at once with no timeout, no retry and no log", async () => {
    const { createClient, made } = fakeClientFactory({ connects: [new Error("ECONNREFUSED")] });
    const logs = [];
    await assert.rejects(
        connectWithRetry({ createClient, policy: cleanupConnectPolicy("postgres", {}), log: l => logs.push(l), sleep: async () => assert.fail("no back-off on PostgreSQL") }),
        /ECONNREFUSED/,
    );
    assert.equal(made.length, 1);
    assert.equal(made[0].connectionTimeoutMillis, undefined);
    assert.deepEqual(logs, []);
});

test("the probe interval: 30 s on HorizonDB, off elsewhere, overridable, 0 turns it off", () => {
    assert.equal(PROBE_INTERVAL_MS, 30_000);
    assert.equal(probeIntervalFor("postgres", {}), 0);
    assert.equal(probeIntervalFor("postgres", { PS_TEST_DB_PROBE_INTERVAL_MS: "1000" }), 0);
    assert.equal(probeIntervalFor("horizondb", {}), 30_000);
    assert.equal(probeIntervalFor("horizondb", { PS_TEST_DB_PROBE_INTERVAL_MS: "5000" }), 5000);
    assert.equal(probeIntervalFor("horizondb", { PS_TEST_DB_PROBE_INTERVAL_MS: "0" }), 0);
    assert.equal(probeIntervalFor("horizondb", { PS_TEST_DB_PROBE_INTERVAL_MS: "x" }), 30_000);
});

test("a probe prints the connection count and connect latency, then closes its connection", async () => {
    const { createClient, made } = fakeClientFactory({ count: 42 });
    const lines = [];
    let t = 1000;
    const probe = startConnectionProbe({
        createClient, label: "pid=9", write: l => lines.push(l), clock: () => "T",
        now: () => (t += 25), setTimer: () => ({ unref() {} }), clearTimer: () => {},
    });
    await probe.stop();
    assert.equal(made.length, 1);
    assert.deepEqual(made[0].queries, [CONNECTION_COUNT_SQL]);
    assert.equal(made[0].ended, true);
    assert.equal(made[0].connectionTimeoutMillis, 10_000);
    assert.deepEqual(lines, ["[hdb-probe pid=9] T connections=42 connect_ms=25\n"]);
});

test("a probe that cannot connect says so and still closes the client", async () => {
    const { createClient, made } = fakeClientFactory({ connects: [new Error("Connection terminated due to connection timeout")] });
    const lines = [];
    const probe = startConnectionProbe({ createClient, write: l => lines.push(l), clock: () => "T", setTimer: () => ({ unref() {} }), clearTimer: () => {} });
    await probe.stop();
    assert.equal(made[0].ended, true);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[hdb-probe\] T probe failed after \d+ ms \(connect\): Connection terminated due to connection timeout\n$/);
});

test("ticks do not overlap, the timer is unref'd, and stop clears it and waits for a probe in flight", async () => {
    const { createClient, made } = fakeClientFactory({ connectDelay: 20 });
    const lines = [];
    let tick;
    let cleared = 0;
    let unref = 0;
    const timer = { unref() { unref += 1; } };
    const probe = startConnectionProbe({
        createClient, write: l => lines.push(l), clock: () => "T",
        setTimer: fn => { tick = fn; return timer; }, clearTimer: t => { assert.equal(t, timer); cleared += 1; },
    });
    tick();
    tick();
    assert.equal(made.length, 1, "the first probe is still in flight");
    await probe.stop();
    assert.equal(cleared, 1);
    assert.equal(unref, 1);
    assert.equal(made[0].ended, true);
    assert.equal(lines.length, 1);
    tick();
    await probe.probeOnce();
    assert.equal(made.length, 1, "a stopped probe starts nothing");
});

test("a real interval keeps ticking, holds no connection between ticks and stops cleanly", async () => {
    let open = 0;
    let peak = 0;
    const createClient = async () => ({
        async connect() { open += 1; peak = Math.max(peak, open); },
        async query() { return { rows: [{ count: "1" }] }; },
        async end() { open -= 1; },
    });
    const lines = [];
    const probe = startConnectionProbe({ createClient, intervalMs: 10, write: l => lines.push(l) });
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(open <= 1, true);
    await probe.stop();
    const after = lines.length;
    assert.equal(open, 0);
    assert.equal(peak, 1);
    assert.equal(after >= 2, true, `expected several probes, saw ${after}`);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(lines.length, after, "no probe after stop");
});

test("a ref-counted probe starts with the first holder and stops with the last", async () => {
    let started = 0;
    let stopped = 0;
    const shared = createRefCounted(() => { started += 1; return { async stop() { stopped += 1; } }; });
    await shared.release();
    assert.equal(stopped, 0);
    shared.acquire();
    shared.acquire();
    assert.equal(started, 1);
    await shared.release();
    assert.equal(stopped, 0);
    await shared.release();
    assert.equal(stopped, 1);
    shared.acquire();
    assert.equal(started, 2);
    await shared.release();
    assert.equal(stopped, 2);
});
