/**
 * Review DRR-3b: the worker's final release sweep (gracefulShutdown) uploads a legacy (unmarked) session even when its
 * close in the Copilot CLI is not confirmed: the worker stops right after, so the files matter more than the close. An
 * ordinary sweep keeps such a session here for the next sweep (DRR-3). The Copilot client and the session store are stubbed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../dist/session-manager.js";

function fixture(t) {
    const home = mkdtempSync(join(tmpdir(), "ps-final-sweep-"));
    const uploaded = [];
    const store = { dehydrate: async (sessionId) => { uploaded.push(sessionId); } };
    const manager = new SessionManager(undefined, store, {}, home);
    const closes = [];
    manager.clients.set("client-a", {
        sessions: new Map([["legacy-1", {}]]),
        rpc: { sessions: { close: async ({ sessionId }) => { closes.push(sessionId); throw new Error("the CLI refused the close"); } } },
    });
    // A legacy session this worker served: local files, no snapshot marker, idle.
    mkdirSync(join(home, "legacy-1"), { recursive: true });
    writeFileSync(join(home, "legacy-1", "events.jsonl"), "{}\n");
    manager.sessionClientKeys.set("legacy-1", "client-a");
    manager.sessionLastTouchedAt.set("legacy-1", Date.now() - 60_000);
    t.mock.method(console, "warn", () => {});
    t.after(() => rmSync(home, { recursive: true, force: true }));
    return { manager, uploaded, closes, home };
}

test("an ordinary sweep keeps a legacy session whose close fails; the final sweep uploads it", async (t) => {
    const h = fixture(t);
    await h.manager.sweepIdleSessions(1_000);
    assert.deepEqual(h.uploaded, [], "an ordinary sweep defers it");
    assert.equal(existsSync(join(h.home, "legacy-1")), true);
    assert.deepEqual([...h.manager.cliClosesOwed.get("legacy-1")], ["client-a"]);

    await h.manager.sweepIdleSessions(1, { final: true });
    assert.deepEqual(h.uploaded, ["legacy-1"], "the final sweep uploads it");
    // Review DR2-006: the final sweep does not wait again on the owed close (the worker stops right after).
    assert.equal(h.closes.length, 1, "the owed close is not tried again");
    assert.equal(h.manager.sessionLastTouchedAt.has("legacy-1"), false);
});

test("the worker's shutdown runs its release sweep as the final one", async (t) => {
    const { PilotSwarmWorker } = await import("../../dist/worker.js");
    t.mock.method(console, "error", () => {});
    const sweeps = [];
    const worker = {
        config: {}, _stopProviderPolling() {}, _agentPackagesCacheDir: null, _agentPackagesTimer: null, _evictionTimer: null,
        _runtimeStartup: null, runtime: { shutdown: async () => {} }, sessionStore: {},
        sessionManager: { releaseIdleWorkspaces: async () => 0, sweepIdleSessions: async (ms, options) => { sweeps.push([ms, options]); return 0; } },
        stop: async () => {},
    };
    await PilotSwarmWorker.prototype.gracefulShutdown.call(worker);
    assert.deepEqual(sweeps, [[1, { final: true }]]);
});

// Review DR2-006: the final sweep spends the worker's shutdown deadline on the files. With two sessions whose closes never
// settle (owed, still in flight) ahead of a legacy session in the sweep's order, a shutdown with a 3 s deadline still
// uploads the legacy session: the owed closes are not retried first, nor waited on again, and the legacy session goes first.
test("a shutdown with a short deadline uploads a legacy session although two closes never settle ahead of it", async (t) => {
    const { PilotSwarmWorker } = await import("../../dist/worker.js");
    const home = mkdtempSync(join(tmpdir(), "ps-final-sweep-deadline-"));
    t.after(() => rmSync(home, { recursive: true, force: true }));
    t.mock.method(console, "warn", () => {});
    t.mock.method(console, "error", () => {});
    const uploaded = [];
    const manager = new SessionManager(undefined, { dehydrate: async (sessionId) => { uploaded.push(sessionId); } }, {}, home);
    const never = new Promise(() => {});
    const slow = { sessions: new Map([["owed-1", {}], ["owed-2", {}]]), rpc: { sessions: { close: async () => never } } };
    const fast = { sessions: new Map([["legacy-1", {}]]), rpc: { sessions: { close: async () => {} } } };
    manager.clients.set("slow", slow);
    manager.clients.set("fast", fast);
    for (const id of ["owed-1", "owed-2", "legacy-1"]) {
        mkdirSync(join(home, id), { recursive: true });
        writeFileSync(join(home, id, "events.jsonl"), "{}\n");
        manager.sessionClientKeys.set(id, id === "legacy-1" ? "fast" : "slow");
        manager.sessionLastTouchedAt.set(id, Date.now() - 60_000);
    }
    // The two closes were tried before (an ordinary sweep) and never settled: in flight and owed.
    manager.cliCloseTimeoutMs = 20;
    for (const id of ["owed-1", "owed-2"]) assert.equal(await manager._closeCliSession(id, "slow"), false);
    manager.cliCloseTimeoutMs = 10_000;
    const worker = {
        config: {}, _stopProviderPolling() {}, _agentPackagesCacheDir: null, _agentPackagesTimer: null, _evictionTimer: null,
        _runtimeStartup: null, runtime: { shutdown: async () => {} }, sessionStore: {}, sessionManager: manager, stop: async () => {},
    };
    const env = { PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS: process.env.PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS,
        PILOTSWARM_WORKER_SHUTDOWN_GRACE_MS: process.env.PILOTSWARM_WORKER_SHUTDOWN_GRACE_MS };
    process.env.PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS = "0";
    process.env.PILOTSWARM_WORKER_SHUTDOWN_GRACE_MS = "3000";
    const started = Date.now();
    try {
        await PilotSwarmWorker.prototype.gracefulShutdown.call(worker);
    } finally {
        for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.ok(uploaded.includes("legacy-1"), `the legacy session was uploaded (uploaded: ${JSON.stringify(uploaded)})`);
    assert.equal(uploaded[0], "legacy-1", "it went first");
    assert.ok(Date.now() - started < 3_500, "within the shutdown deadline");
});
