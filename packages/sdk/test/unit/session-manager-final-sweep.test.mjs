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
    assert.ok(h.closes.length >= 2, "the close was tried again");
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
