// FU-11: a worker's graceful shutdown outlived its 60 s drain limit by minutes when database calls hung (a cluster DNS
// fault, 2026-11-06 06:54Z): the release steps after the runtime drain and stop()'s closes had no deadline, and the
// heartbeat kept running. Now every step races one deadline (the drain budget plus PILOTSWARM_WORKER_SHUTDOWN_GRACE_MS),
// so gracefulShutdown returns and the process exits whatever the database does, and the heartbeat stops after the drain.
import test from "node:test";
import assert from "node:assert/strict";

const hang = () => new Promise(() => {});

/** A worker as gracefulShutdown sees it, every database-backed step hanging. */
function hungWorker({ runtimeHangs = false } = {}) {
    const calls = [];
    const heartbeat = setInterval(() => calls.push("heartbeat"), 5);
    return {
        calls,
        heartbeat,
        worker: {
            config: { workerNodeId: "fu11-fixture" },
            _stopProviderPolling() { calls.push("polling stopped"); },
            _agentPackagesCacheDir: null,
            _agentPackagesTimer: heartbeat,
            _evictionTimer: null,
            _runtimeStartup: null,
            runtime: { shutdown: async (ms) => { calls.push(`drain ${ms}`); if (runtimeHangs) await hang(); } },
            sessionStore: {},
            sessionManager: {
                releaseIdleWorkspaces: () => { calls.push("workspace release"); return hang(); },
                sweepIdleSessions: () => { calls.push("release sweep"); return hang(); },
            },
            stop: () => { calls.push("stop"); return hang(); },
        },
    };
}

async function withEnv(values, fn) {
    const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    Object.assign(process.env, values);
    try { return await fn(); } finally {
        for (const [key, value] of Object.entries(before)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
}

test("a graceful shutdown whose release, sweep and closes hang returns at the drain deadline, and the heartbeat stops", async (t) => {
    const { PilotSwarmWorker } = await import("../../dist/worker.js");
    const errors = [];
    t.mock.method(console, "error", (line) => errors.push(String(line)));
    t.mock.method(console, "warn", () => {});
    const { worker, calls, heartbeat } = hungWorker();
    t.after(() => clearInterval(heartbeat));
    await withEnv({ PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS: "100", PILOTSWARM_WORKER_SHUTDOWN_GRACE_MS: "300" }, async () => {
        const started = Date.now();
        await PilotSwarmWorker.prototype.gracefulShutdown.call(worker);
        const took = Date.now() - started;
        assert.ok(took >= 350 && took < 2_000, `returned after ${took} ms (deadline 400 ms)`);
    });
    // Every step was tried, in order; the ones still waiting at the deadline were left behind, each said so once.
    assert.deepEqual(calls.filter((call) => call !== "heartbeat"), ["polling stopped", "drain 100", "workspace release", "release sweep", "stop"]);
    assert.equal(worker._agentPackagesTimer, null, "the heartbeat timer is cleared after the drain");
    const heartbeats = calls.filter((call) => call === "heartbeat").length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(calls.filter((call) => call === "heartbeat").length, heartbeats, "no heartbeat after the drain");
    for (const step of ["the workspace release", "the release sweep", "closing the worker"]) {
        assert.equal(errors.filter((line) => line.includes(`shutdown: ${step} did not finish by the drain deadline`)).length, 1, step);
    }
});

test("a runtime drain that does not return by the deadline does not hold the shutdown either", async (t) => {
    const { PilotSwarmWorker } = await import("../../dist/worker.js");
    t.mock.method(console, "error", () => {});
    t.mock.method(console, "warn", () => {});
    const { worker, calls, heartbeat } = hungWorker({ runtimeHangs: true });
    t.after(() => clearInterval(heartbeat));
    await withEnv({ PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS: "100", PILOTSWARM_WORKER_SHUTDOWN_GRACE_MS: "100" }, async () => {
        const started = Date.now();
        await PilotSwarmWorker.prototype.gracefulShutdown.call(worker);
        assert.ok(Date.now() - started < 1_500);
    });
    assert.equal(worker.runtime, null);
    assert.ok(calls.includes("stop"), "the closes are still started");
});

test("a shutdown whose steps finish in time waits for each, and returns as soon as they are done", async (t) => {
    const { PilotSwarmWorker } = await import("../../dist/worker.js");
    t.mock.method(console, "error", () => {});
    const calls = [];
    const worker = {
        config: {}, _stopProviderPolling() {}, _agentPackagesCacheDir: null, _agentPackagesTimer: null, _evictionTimer: null,
        _runtimeStartup: null, runtime: { shutdown: async () => { calls.push("drain"); } }, sessionStore: {},
        sessionManager: { releaseIdleWorkspaces: async () => { calls.push("release"); return 0; }, sweepIdleSessions: async () => { calls.push("sweep"); return 0; } },
        stop: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); calls.push("stopped"); },
    };
    const started = Date.now();
    await withEnv({ PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS: "60000" }, () => PilotSwarmWorker.prototype.gracefulShutdown.call(worker));
    assert.deepEqual(calls, ["drain", "release", "sweep", "stopped"]);
    assert.ok(Date.now() - started < 1_000);
});

// Review RT-D4: the draining report (sent first, with an agent-packages cache) ran under its own fixed 5 s, so a shorter
// drain budget plus grace did not bound it, and its timer stayed scheduled after a fast report. It now runs under the
// earlier of its 5 s and the shared deadline, and clears its timer.
test("the draining report is bounded by the shared deadline when that comes first, and leaves no timer behind", async (t) => {
    const { PilotSwarmWorker } = await import("../../dist/worker.js");
    t.mock.method(console, "error", () => {});
    t.mock.method(console, "warn", () => {});
    for (const [drain, grace] of [["100", "100"], ["0", "0"]]) {
        const { worker, calls, heartbeat } = hungWorker();
        clearInterval(heartbeat);
        worker._agentPackagesCacheDir = "/tmp/agent-packages";
        worker._reportAgentWorkerState = () => { calls.push("draining report"); return hang(); };
        await withEnv({ PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS: drain, PILOTSWARM_WORKER_SHUTDOWN_GRACE_MS: grace }, async () => {
            const started = Date.now();
            await PilotSwarmWorker.prototype.gracefulShutdown.call(worker);
            const took = Date.now() - started;
            assert.ok(took < Number(drain) + Number(grace) + 500, `drain ${drain} + grace ${grace}: took ${took} ms, not the report's 5 s`);
        });
        assert.equal(calls[0], "polling stopped");
        assert.ok(calls.includes("draining report"));
    }
});

test("a fast draining report leaves no timer scheduled", async (t) => {
    const { PilotSwarmWorker } = await import("../../dist/worker.js");
    t.mock.method(console, "error", () => {});
    const scheduled = [];
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const live = new Set();
    t.mock.method(globalThis, "setTimeout", (fn, ms, ...args) => {
        const handle = realSetTimeout(fn, ms, ...args);
        scheduled.push(ms);
        live.add(handle);
        return handle;
    });
    t.mock.method(globalThis, "clearTimeout", (handle) => { live.delete(handle); return realClearTimeout(handle); });
    const worker = {
        config: {}, _stopProviderPolling() {}, _agentPackagesCacheDir: "/tmp/agent-packages", _reportAgentWorkerState: async () => {},
        _agentPackagesTimer: null, _evictionTimer: null, _runtimeStartup: null, runtime: null, sessionStore: null,
        sessionManager: { releaseIdleWorkspaces: async () => 0 }, stop: async () => {},
    };
    await withEnv({ PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS: "60000" }, () => PilotSwarmWorker.prototype.gracefulShutdown.call(worker));
    assert.ok(scheduled.includes(5_000), "the report's own 5 s cap (the deadline is later)");
    assert.equal(live.size, 0, "every step's timer was cleared");
});

// Final review FRT-F2 (formal correspondence, worker shutdown; current behaviour, no code change): after a runtime drain
// held past the shared deadline, the later steps are still started, each with no time left. A step whose work is quick
// still finishes (the sweep, the closes); a step whose work is still pending is left behind: only the wait for it is
// abandoned, not its work, which goes on after the shutdown returned, overlapping the steps that follow it.
test("FRT-F2: after a drain past the deadline the release, the sweep and the closes still start; a pending release goes on behind them", async (t) => {
    const { PilotSwarmWorker } = await import("../../dist/worker.js");
    const errors = [];
    t.mock.method(console, "error", (line) => errors.push(String(line)));
    t.mock.method(console, "warn", () => {});
    const calls = [];
    let releaseWork;
    const releaseHeld = new Promise((resolve) => { releaseWork = resolve; });
    const worker = {
        config: { workerNodeId: "frt-f2-fixture" }, _stopProviderPolling() {}, _agentPackagesCacheDir: null, _agentPackagesTimer: null,
        _evictionTimer: null, _runtimeStartup: null,
        runtime: { shutdown: async () => { calls.push("drain started"); await hang(); } },
        sessionStore: {},
        sessionManager: {
            releaseIdleWorkspaces: async () => { calls.push("release started"); const released = await releaseHeld; calls.push("release finished"); return released; },
            sweepIdleSessions: async () => { calls.push("sweep started"); calls.push("sweep finished"); return 0; },
        },
        stop: async () => { calls.push("stop started"); calls.push("stop finished"); },
    };
    let deadline;
    const startedAt = {};
    for (const key of ["releaseIdleWorkspaces", "sweepIdleSessions"]) {
        const work = worker.sessionManager[key];
        worker.sessionManager[key] = (...args) => { startedAt[key] = Date.now(); return work(...args); };
    }
    const stopWork = worker.stop;
    worker.stop = () => { startedAt.stop = Date.now(); return stopWork(); };
    await withEnv({ PILOTSWARM_WORKER_SHUTDOWN_TIMEOUT_MS: "100", PILOTSWARM_WORKER_SHUTDOWN_GRACE_MS: "100" }, async () => {
        deadline = Date.now() + 200;
        await PilotSwarmWorker.prototype.gracefulShutdown.call(worker);
    });
    // The drain was cut at the deadline; every later step was still started after it, with no time left.
    assert.equal(worker.runtime, null);
    for (const step of ["releaseIdleWorkspaces", "sweepIdleSessions", "stop"]) {
        assert.ok(startedAt[step] >= deadline - 5, `${step} started ${deadline - startedAt[step]} ms before the deadline`);
    }
    assert.equal(errors.filter((line) => line.includes("shutdown: the runtime drain did not finish by the drain deadline")).length, 1);
    // The release was abandoned (its wait), the sweep and the closes started while it was still pending, and finished.
    assert.deepEqual(calls, ["drain started", "release started", "sweep started", "sweep finished", "stop started", "stop finished"]);
    assert.equal(errors.filter((line) => line.includes("shutdown: the workspace release did not finish by the drain deadline")).length, 1);
    for (const step of ["the release sweep", "closing the worker"]) {
        assert.equal(errors.filter((line) => line.includes(`shutdown: ${step} did not finish`)).length, 0, step);
    }
    // Its work was not cancelled: once its call returns, after the shutdown returned, it goes on to its end.
    releaseWork(2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls.slice(-1), ["release finished"]);
    assert.ok(errors.some((line) => line.includes("drain released 2 workspace session(s)")), "the abandoned release's work completed");
});
