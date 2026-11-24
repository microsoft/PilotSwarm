/**
 * Issue #331: pooled Copilot runtimes are stopped once idle, and every
 * teardown stops a session's background shells first.
 *
 * The real pool path runs (ensureClient, start, leases, idle timers); only
 * the CopilotClient methods that would reach a CLI process are mocked. The
 * tests that count milliseconds run on node:test's mock clock; processes are
 * an in-memory table (fake-process-host.mjs), so every test runs the same on
 * every platform.
 *
 * Run: node --test test/unit/copilot-runtime-idle-stop.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import { SessionManager } from "../../dist/session-manager.js";
import { createCopilotClient, sendCopilotPrompt, stopCopilotClient } from "../../dist/copilot-client.js";
import { registerActivities, SUMMARIZE_SESSION_TIMEOUT_MS } from "../../dist/session-proxy.js";
import { resolveCopilotClientIdleStopMs } from "../../dist/worker.js";
import { fakeProcessHost } from "../helpers/fake-process-host.mjs";

const IDLE_MS = 40;
const WORKSPACE = { schema: 1, root: "a", folder: "repo-x" };
const attach = (root = "a") => ({ root, rootPath: `/ws/${root}`, path: `/ws/${root}/repo-x`, realPath: `/ws/${root}/repo-x` });
const VISION_MODEL = { id: "vision-model", capabilities: { supports: { vision: true } } };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Let pending promise chains run, on the real event loop (the mock clock does not mock setImmediate). */
async function flush(turns = 50) {
    for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
}
/** Run `body` on the mock clock (setTimeout and Date), restored before the fixture's teardown. */
async function onMockClock(t, body) {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    try {
        return await body(t.mock.timers);
    } finally {
        t.mock.timers.reset();
    }
}
/** A promise's state, read without waiting for it. */
function track(promise) {
    const state = { settled: false, value: undefined, error: undefined };
    promise.then((value) => { state.settled = true; state.value = value; }, (error) => { state.settled = true; state.error = error; });
    return state;
}
/** A shell's process table: this worker (1000), a CLI below it and a shell below that, leading its own session. */
function shellHost(shells) {
    return fakeProcessHost({
        processes: [
            { pid: 1000, ppid: 1, start: 1 },
            ...shells.flatMap(({ cli, pid, startedAt }) => [
                { pid: cli, ppid: 1000, pgid: 1000, sid: 1000, start: 2 },
                { pid, ppid: cli, start: startedAt - 100 },
            ]),
        ],
    });
}
async function waitFor(predicate, what, ms = 3000) {
    const deadline = Date.now() + ms;
    while (!predicate()) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
        await sleep(5);
    }
}
function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

/** Mock the CLI-facing CopilotClient methods; each client gets a number in creation order. */
function mockRuntimes(t) {
    const runtimes = [];
    const log = [];
    const info = (client) => {
        let entry = runtimes.find((r) => r.client === client);
        if (!entry) {
            entry = { client, id: runtimes.length + 1, started: 0, stopped: 0, forced: 0, connected: false };
            runtimes.push(entry);
        }
        return entry;
    };
    // Each hook, when set, runs inside the mocked method; `proceed` runs the default behaviour.
    const hooks = {
        start: null, stop: null, listModels: null, deleteSession: null, createSession: null, resumeSession: null,
        list: null, disconnect: null,
    };
    const handles = new Map();
    const bound = new Map();
    const open = (client, kind, config, home) => {
        const tasks = new Map();
        const handle = {
            tasks,
            disconnect: async () => {
                log.push(`disconnect:${config.sessionId}`);
                if (hooks.disconnect) await hooks.disconnect(config.sessionId);
            },
            rpc: {
                tasks: {
                    list: async () => {
                        log.push(`list:${config.sessionId}`);
                        if (hooks.list) await hooks.list(config.sessionId);
                        return { tasks: [...tasks.values()] };
                    },
                    cancel: async ({ id }) => { log.push(`cancel:${config.sessionId}:${id}`); tasks.delete(id); return { cancelled: true }; },
                },
            },
        };
        log.push(`${kind}:${config.sessionId}:runtime${info(client).id}`);
        handles.set(config.sessionId, handle);
        bound.set(config.sessionId, info(client));
        mkdirSync(join(home, config.sessionId), { recursive: true });
        return handle;
    };
    // As the SDK client: a request before start() or after a stop fails.
    const connected = (entry) => {
        if (!entry.connected) throw new Error("Client not connected. Call start() first.");
    };
    let home = "";
    t.mock.method(CopilotClient.prototype, "start", async function () {
        const entry = info(this);
        entry.started++;
        log.push(`start:runtime${entry.id}`);
        if (hooks.start) await hooks.start(this);
        entry.connected = true;
    });
    t.mock.method(CopilotClient.prototype, "stop", async function () {
        const entry = info(this);
        entry.stopped++;
        entry.connected = false;
        log.push(`stop:runtime${entry.id}`);
        if (hooks.stop) return hooks.stop(this);
        return [];
    });
    t.mock.method(CopilotClient.prototype, "forceStop", async function () {
        const entry = info(this);
        entry.forced++;
        entry.connected = false;
        log.push(`forceStop:runtime${entry.id}`);
    });
    t.mock.method(CopilotClient.prototype, "createSession", async function (config) {
        info(this);
        if (hooks.createSession) return hooks.createSession(config, () => open(this, "create", config, home));
        return open(this, "create", config, home);
    });
    t.mock.method(CopilotClient.prototype, "resumeSession", async function (_id, config) {
        if (hooks.resumeSession) return hooks.resumeSession(config, () => open(this, "resume", config, home));
        return open(this, "resume", config, home);
    });
    t.mock.method(CopilotClient.prototype, "deleteSession", async function (id) {
        const entry = info(this);
        log.push(`deleteSession:${id}:runtime${entry.id}`);
        connected(entry);
        if (hooks.deleteSession) await hooks.deleteSession();
    });
    t.mock.method(CopilotClient.prototype, "listModels", async function () {
        const entry = info(this);
        log.push(`listModels:runtime${entry.id}`);
        connected(entry);
        const models = hooks.listModels ? await hooks.listModels() : undefined;
        return models ?? [VISION_MODEL];
    });
    return { runtimes, log, info, hooks, handles, bound, setHome: (dir) => { home = dir; } };
}

function fixture(t, workerDefaults = { copilotClientIdleStopMs: IDLE_MS }, { sessionStore = null } = {}) {
    const mocks = mockRuntimes(t);
    const home = mkdtempSync(join(tmpdir(), "ps-idle-stop-"));
    mocks.setHome(home);
    const manager = new SessionManager(undefined, sessionStore, workerDefaults, home);
    manager.setFactStore({
        readFacts: async () => ({ count: 0, facts: [] }),
        storeFact: async () => ({ stored: true }),
        deleteFact: async () => ({ deleted: true }),
    });
    t.after(async () => {
        await manager.shutdown();
        rmSync(home, { recursive: true, force: true });
    });
    const runtimeOf = (sessionId) => mocks.bound.get(sessionId);
    const sequence = (sessionId) => mocks.log
        .filter((e) => e.startsWith("list:") || e.startsWith("cancel:") || e.startsWith("disconnect:"))
        .filter((e) => e.split(":")[1] === sessionId)
        .map((e) => e.split(":")[0]);
    return { manager, home, ...mocks, runtimeOf, sequence };
}

test("an unused pooled runtime stops after the idle period; the next turn starts a fresh one and resumes", async (t) => {
    const h = fixture(t);
    await h.manager.getOrCreate("s1", {}, { turnIndex: 0 });
    const first = h.runtimeOf("s1");
    assert.equal(first.started, 1);

    await sleep(IDLE_MS * 3);
    assert.equal(first.stopped, 0, "a warm session keeps its runtime running");

    await h.manager.dropWarmSession("s1");
    await waitFor(() => first.stopped === 1, "the idle stop");
    assert.equal(h.manager.clients.size, 0, "the stopped runtime left the pool before it was stopped");
    assert.equal(first.forced, 0);

    await h.manager.getOrCreate("s1", {}, { turnIndex: 1 });
    const second = h.runtimeOf("s1");
    assert.notEqual(second.client, first.client, "a fresh runtime");
    assert.equal(second.started, 1);
    assert.equal(h.log.findLast((e) => e.startsWith("resume:s1:") || e.startsWith("create:s1:")), `resume:s1:runtime${second.id}`,
        "the conversation resumes from its local state on the fresh runtime");
    await sleep(IDLE_MS * 3);
    assert.equal(second.stopped, 0);
});

test("a lease keeps an unused runtime running while listModels or a state reset runs on it", async (t) => {
    const h = fixture(t);
    await h.manager.getOrCreate("s1", {}, { turnIndex: 0 });
    const runtime = h.runtimeOf("s1");
    await h.manager.dropWarmSession("s1");

    const models = deferred();
    h.hooks.listModels = () => models.promise;
    const lookup = h.manager.getModelVisionInfo("some-model", { sessionId: "s1" });
    await waitFor(() => h.log.includes(`listModels:runtime${runtime.id}`), "listModels");
    await sleep(IDLE_MS * 3);
    assert.equal(runtime.stopped, 0, "listModels holds a lease");
    models.resolve();
    assert.equal((await lookup).known, false);
    await waitFor(() => runtime.stopped === 1, "the idle stop after the lease");

    // A reset deletes the session on its runtime under a lease too.
    await h.manager.getOrCreate("s2", {}, { turnIndex: 0 });
    const second = h.runtimeOf("s2");
    const deleted = deferred();
    h.hooks.deleteSession = () => deleted.promise;
    const reset = h.manager.resetSessionState("s2");
    await waitFor(() => h.log.includes(`deleteSession:s2:runtime${second.id}`), "deleteSession");
    await sleep(IDLE_MS * 3);
    assert.equal(second.stopped, 0, "deleteSession holds a lease");
    deleted.resolve();
    await reset;
    await waitFor(() => second.stopped === 1, "the idle stop after the reset");
});

test("a session that moves to another pool key releases the old runtime, which then stops", async (t) => {
    const h = fixture(t);
    await h.manager.getOrCreate("s1", { workspace: WORKSPACE, workspaceAttach: attach("a") }, { turnIndex: 0 });
    const onA = h.runtimeOf("s1");
    await h.manager.getOrCreate("s1", { workspace: { ...WORKSPACE, root: "b" }, workspaceAttach: attach("b") }, { turnIndex: 1 });
    const onB = h.runtimeOf("s1");
    assert.notEqual(onB.client, onA.client, "another root is another runtime");
    await waitFor(() => onA.stopped === 1, "the old key's idle stop");
    await sleep(IDLE_MS * 3);
    assert.equal(onB.stopped, 0, "the runtime the session moved to keeps running");
});

test("a runtime shared by two sessions stops only after both leave it", async (t) => {
    const h = fixture(t);
    await h.manager.getOrCreate("s1", {}, { turnIndex: 0 });
    await h.manager.getOrCreate("s2", {}, { turnIndex: 0 });
    const runtime = h.runtimeOf("s1");
    assert.equal(h.runtimeOf("s2").client, runtime.client, "one pooled runtime per key");
    await h.manager.destroySession("s1");
    await sleep(IDLE_MS * 3);
    assert.equal(runtime.stopped, 0, "s2 still runs on it");
    await h.manager.destroySession("s2");
    await waitFor(() => runtime.stopped === 1, "the idle stop");
});

test("the idle stop is off at 0, and a caller-supplied client is never stopped for idleness", async (t) => {
    const off = fixture(t, { copilotClientIdleStopMs: 0 });
    await off.manager.getOrCreate("s1", {}, { turnIndex: 0 });
    const runtime = off.runtimeOf("s1");
    await off.manager.dropWarmSession("s1");
    await sleep(IDLE_MS * 3);
    assert.equal(runtime.stopped, 0);
    assert.equal(off.manager.clients.size, 1);

    const pinned = fixture(t);
    const supplied = createCopilotClient({ useLoggedInUser: false });
    pinned.manager.client = supplied;
    await pinned.manager.getOrCreate("s2", {}, { turnIndex: 0 });
    assert.equal(pinned.runtimeOf("s2").client, supplied);
    await pinned.manager.dropWarmSession("s2");
    await sleep(IDLE_MS * 3);
    assert.equal(pinned.info(supplied).stopped, 0, "the caller owns its lifetime");
});

test("a runtime whose stop() hangs or fails is forced to stop", async () => {
    const calls = [];
    const hung = { stop: () => new Promise(() => {}), forceStop: async () => { calls.push("hung:forceStop"); } };
    await stopCopilotClient(hung, 20, "[test]");
    const failed = { stop: async () => [new Error("detach failed")], forceStop: async () => { calls.push("failed:forceStop"); } };
    await stopCopilotClient(failed, 1000, "[test]");
    const clean = { stop: async () => [], forceStop: async () => { calls.push("clean:forceStop"); } };
    await stopCopilotClient(clean, 1000, "[test]");
    const broken = { stop: async () => { throw new Error("gone"); }, forceStop: async () => { throw new Error("also gone"); } };
    await stopCopilotClient(broken, 1000, "[test]");
    assert.deepEqual(calls, ["hung:forceStop", "failed:forceStop"]);
});

test("the grace period is waited out in full; a key taken while its runtime's stop is pending gets a fresh runtime", async (t) => {
    const h = fixture(t);
    await onMockClock(t, async (clock) => {
        await h.manager.getOrCreate("s1", {}, { turnIndex: 0 });
        await h.manager.getOrCreate("s2", { workspace: WORKSPACE, workspaceAttach: attach("b") }, { turnIndex: 0 });
        const a = h.runtimeOf("s1");
        const b = h.runtimeOf("s2");
        const releaseA = deferred();
        h.hooks.stop = (client) => (client === a.client ? releaseA.promise.then(() => []) : []);
        try {
            await h.manager.dropWarmSession("s1");
            clock.tick(IDLE_MS - 1);
            await flush();
            assert.equal(a.stopped, 0, "not before the grace period ends");
            clock.tick(1);
            await flush();
            assert.equal(a.stopped, 1, "stopped when the grace period ends");
            assert.equal(h.manager.clients.size, 1, "the runtime left the pool before its stop finished");

            // Its key is taken while the stop is still pending: a fresh runtime, never the retiring one.
            await h.manager.getOrCreate("s1", {}, { turnIndex: 1 });
            const fresh = h.runtimeOf("s1");
            assert.notEqual(fresh.client, a.client);
            assert.equal(fresh.started, 1);
            assert.equal(h.log.findLast((e) => e.startsWith("resume:s1:")), `resume:s1:runtime${fresh.id}`);

            // Another runtime falls due during that stop pass: it is stopped by the next pass, not lost.
            await h.manager.dropWarmSession("s2");
            clock.tick(IDLE_MS);
            await flush();
            assert.equal(b.stopped, 0, "stop passes do not overlap");
            releaseA.resolve();
            await flush();
            assert.equal(b.stopped, 1, "the next pass stops it");

            // A warm rebind keeps its runtime: the open holds it while the old handle goes.
            await h.manager.getOrCreate("s1", { model: "other-model" }, { turnIndex: 2 });
            assert.match(h.log.findLast((e) => e.startsWith("resume:s1:")), new RegExp(`runtime${fresh.id}$`));
            clock.tick(IDLE_MS * 3);
            await flush();
            assert.equal(fresh.stopped, 0, "the rebound session runs on it");
        } finally {
            releaseA.resolve();
        }
    });
});

test("overlapping leases on one runtime: it stops only once the last one is released", async (t) => {
    const h = fixture(t);
    await onMockClock(t, async (clock) => {
        await h.manager.getOrCreate("s1", {}, { turnIndex: 0 });
        await h.manager.getOrCreate("s2", {}, { turnIndex: 0 });
        const runtime = h.runtimeOf("s1");
        await h.manager.dropWarmSession("s1");
        await h.manager.dropWarmSession("s2");
        const answers = [];
        h.hooks.listModels = () => {
            const answer = deferred();
            answers.push(answer);
            return answer.promise;
        };
        try {
            const lookups = [
                h.manager.getModelVisionInfo("vision-model", { sessionId: "s1" }),
                h.manager.getModelVisionInfo("vision-model", { sessionId: "s2" }),
            ];
            await flush();
            assert.equal(answers.length, 2, "both lookups read the catalog on the one runtime");
            answers[0].resolve();
            await flush();
            clock.tick(IDLE_MS * 3);
            await flush();
            assert.equal(runtime.stopped, 0, "the second lookup still holds it");
            answers[1].resolve();
            await Promise.all(lookups);
            clock.tick(IDLE_MS - 1);
            await flush();
            assert.equal(runtime.stopped, 0, "the grace period starts at the last release");
            clock.tick(1);
            await flush();
            assert.equal(runtime.stopped, 1);
        } finally {
            for (const answer of answers) answer.resolve();
        }
    });
});

test("opening a session holds its runtime through the resume, an epoch reset and a hydration, and releases it when the open fails", async (t) => {
    let stored = false;
    const hydration = deferred();
    const sessionStore = {
        exists: async () => stored,
        hydrate: async (sessionId) => {
            await hydration.promise;
            mkdirSync(join(h.home, sessionId), { recursive: true });
        },
        delete: async () => {},
    };
    const h = fixture(t, undefined, { sessionStore });
    await onMockClock(t, async (clock) => {
        await h.manager.getOrCreate("s1", {}, { turnIndex: 0 });
        const runtime = h.runtimeOf("s1");
        await h.manager.dropWarmSession("s1");
        const holds = async (what) => {
            clock.tick(IDLE_MS * 3);
            await flush();
            assert.equal(runtime.stopped, 0, what);
            assert.equal(h.manager.clients.size, 1, what);
        };
        const gates = [];
        const gate = (proceed) => {
            const open = deferred();
            gates.push(open);
            return open.promise.then(proceed);
        };
        try {
            // A resume that has not answered yet; a lookup that completes meanwhile does not end the open's lease.
            h.hooks.resumeSession = (_config, proceed) => gate(proceed);
            const resumed = h.manager.getOrCreate("s1", {}, { turnIndex: 1 });
            await flush();
            await holds("the open holds its runtime while the resume runs");
            assert.equal((await h.manager.getModelVisionInfo("vision-model", { sessionId: "s1" })).known, true);
            await holds("a lookup's release leaves the open's lease");
            gates.shift().resolve();
            await resumed;
            h.hooks.resumeSession = null;
            await h.manager.dropWarmSession("s1");

            // An epoch start: the reset and the create both run under the open's lease.
            h.hooks.createSession = (_config, proceed) => gate(proceed);
            const epoch = h.manager.getOrCreate("s1", {}, { turnIndex: 2, epochStart: true, transcriptEpoch: 1 });
            await flush();
            await holds("the open holds its runtime while the epoch's create runs");
            gates.shift().resolve();
            await epoch;
            h.hooks.createSession = null;
            await h.manager.dropWarmSession("s1");

            // No local files: the open hydrates them from the store first.
            rmSync(join(h.home, "s1"), { recursive: true, force: true });
            stored = true;
            const hydrated = h.manager.getOrCreate("s1", {}, { turnIndex: 3, transcriptEpoch: 1 });
            await flush();
            await holds("the open holds its runtime while the session is hydrated");
            hydration.resolve();
            await hydrated;
            await h.manager.dropWarmSession("s1");
            stored = false;

            // An open that fails releases its lease.
            h.hooks.createSession = async () => { throw new Error("model unavailable"); };
            await assert.rejects(h.manager.getOrCreate("s2", {}, { turnIndex: 0 }), /model unavailable/);
            clock.tick(IDLE_MS - 1);
            await flush();
            assert.equal(runtime.stopped, 0);
            clock.tick(1);
            await flush();
            assert.equal(runtime.stopped, 1, "the failed open released the runtime");
        } finally {
            for (const open of gates) open.resolve();
            hydration.resolve();
        }
    });
});

test("the vision lookup uses the runtime the session runs on, also after a state reset (C-1)", async (t) => {
    const h = fixture(t, { copilotClientIdleStopMs: 0 });
    // A turn 0 that finds the session warm resets its state, and that reset forgets the session's pool key.
    await h.manager.getOrCreate("s1", { workspace: WORKSPACE, workspaceAttach: attach("a") }, { turnIndex: 0 });
    await h.manager.getOrCreate("s1", { workspace: WORKSPACE, workspaceAttach: attach("a") }, { turnIndex: 0 });
    const onA = h.runtimeOf("s1");
    await h.manager.dropWarmSession("s1");
    const cold = await h.manager.getModelVisionInfo("vision-model", { sessionId: "s1" });
    assert.deepEqual([cold.known, cold.vision], [true, true], "the lookup finds the session's own runtime after the reset");
    assert.equal(h.runtimes.length, 1, "no other runtime was made for the lookup");

    // An epoch start resets the state of a session that stays warm on its runtime.
    await h.manager.getOrCreate("s2", { workspace: { ...WORKSPACE, root: "b" }, workspaceAttach: attach("b") }, { turnIndex: 0 });
    await h.manager.getOrCreate("s2", { workspace: { ...WORKSPACE, root: "b" }, workspaceAttach: attach("b") },
        { turnIndex: 1, epochStart: true, transcriptEpoch: 1 });
    const onB = h.runtimeOf("s2");
    assert.notEqual(onB.client, onA.client);
    const warm = await h.manager.getModelVisionInfo("vision-model", { sessionId: "s2" });
    assert.deepEqual([warm.known, warm.vision], [true, true]);
    assert.equal(h.log.at(-1), `listModels:runtime${onB.id}`, "the catalog of the runtime the session is warm on");

    // The warm runtime wins even when the session's key is not recorded (the binding is lost, not the session).
    h.manager.sessionClientKeys.delete("s2");
    const unrecorded = await h.manager.getModelVisionInfo("vision-model", { sessionId: "s2" });
    assert.deepEqual([unrecorded.known, unrecorded.vision], [true, true]);
    assert.equal(h.runtimes.length, 2, "no runtime was made for the lookup");
});

test("a state reset after an idle stop deletes no session on a runtime that never started (C-2)", async (t) => {
    const h = fixture(t);
    await onMockClock(t, async (clock) => {
        await h.manager.getOrCreate("s1", {}, { turnIndex: 0 });
        const runtime = h.runtimeOf("s1");
        await h.manager.dropWarmSession("s1");
        clock.tick(IDLE_MS);
        await flush();
        assert.equal(runtime.stopped, 1);
        await h.manager.resetSessionState("s1");
        assert.equal(h.log.some((e) => e.startsWith("deleteSession:s1:")), false, "no delete on a runtime that holds no session");
        assert.equal(h.runtimes.length, 1, "no runtime was started for the reset");
        assert.equal(existsSync(join(h.manager.getSessionStateDir(), "s1")), false, "the files go regardless");
    });
});

test("an idle period beyond a timer's limit never stops a runtime early (C-3)", async (t) => {
    const warnings = [];
    const onWarning = (warning) => warnings.push(warning.name);
    process.on("warning", onWarning);
    t.after(() => process.off("warning", onWarning));
    for (const idleMs of [2 ** 31, 2 ** 31 - 1]) {
        const h = fixture(t, { copilotClientIdleStopMs: idleMs });
        await h.manager.getOrCreate("s1", {}, { turnIndex: 0 });
        const runtime = h.runtimeOf("s1");
        await h.manager.dropWarmSession("s1");
        await sleep(IDLE_MS * 3);
        assert.equal(runtime.stopped, 0, `idle ${idleMs} ms`);
        assert.equal(h.manager.clients.size, 1, `idle ${idleMs} ms`);
    }
    assert.equal(warnings.includes("TimeoutOverflowWarning"), false);
});

test("the idle period setting takes only a whole number of milliseconds; anything else warns and uses the default (C-3)", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const DEFAULT = 30_000;
    for (const junk of ["30s", "1e3", "3e+06", "-1", "abc", "0x10", "1.5", -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const before = warn.mock.callCount();
        assert.equal(resolveCopilotClientIdleStopMs(undefined, junk), DEFAULT, `env ${String(junk)}`);
        assert.equal(warn.mock.callCount(), before + 1, `env ${String(junk)} warns`);
        assert.equal(resolveCopilotClientIdleStopMs(junk, undefined), DEFAULT, `option ${String(junk)}`);
    }
    const before = warn.mock.callCount();
    assert.equal(resolveCopilotClientIdleStopMs(undefined, "45000"), 45_000);
    assert.equal(resolveCopilotClientIdleStopMs(undefined, " 7 "), 7);
    assert.equal(resolveCopilotClientIdleStopMs(undefined, "0"), 0, "0 turns the stop off");
    assert.equal(resolveCopilotClientIdleStopMs(0, "45000"), 0, "the option wins over the environment");
    assert.equal(resolveCopilotClientIdleStopMs(12_000, undefined), 12_000);
    assert.equal(resolveCopilotClientIdleStopMs(undefined, undefined), DEFAULT);
    assert.equal(resolveCopilotClientIdleStopMs(undefined, ""), DEFAULT);
    assert.equal(warn.mock.callCount(), before, "valid values do not warn");
});

test("every teardown of a session without a workspace stops its background shells before the disconnect; a shutdown kills them after the stop", async (t) => {
    const h = fixture(t);
    const warmWithShell = async (id) => {
        await h.manager.getOrCreate(id, {}, { turnIndex: 0 });
        h.handles.get(id).tasks.set("shell-1", { id: "shell-1", type: "shell", status: "running" });
    };
    const runs = {
        destroy: (id) => h.manager.destroySession(id),
        dehydrate: (id) => h.manager.dehydrate(id, "idle"),
        invalidate: (id) => h.manager.invalidateWarmSession(id),
        evict: async () => { await sleep(5); return h.manager.sweepIdleSessions(1); },
        reset: (id) => h.manager.getOrCreate(id, {}, { turnIndex: 0 }),
        epoch: (id) => h.manager.getOrCreate(id, {}, { turnIndex: 1, epochStart: true, transcriptEpoch: 1 }),
        rebind: (id) => h.manager.getOrCreate(id, { model: "other-model" }, { turnIndex: 1 }),
    };
    for (const [name, run] of Object.entries(runs)) {
        const id = `plain-${name}`;
        await warmWithShell(id);
        await run(id);
        assert.deepEqual(h.sequence(id), ["list", "cancel", "list", "disconnect"], name);
    }

    await warmWithShell("plain-shutdown");
    // A process table stands in for the shell (below a CLI below this worker), so the kill after the stop is observed.
    const startedAt = Date.now();
    const host = shellHost([{ cli: 900, pid: 500, startedAt }]);
    h.manager.sessions.get("plain-shutdown").processHost = host;
    h.handles.get("plain-shutdown").tasks.set("shell-1", { id: "shell-1", type: "shell", status: "running", pid: 500, startedAt: new Date(startedAt).toISOString() });
    let killsAtStop;
    h.hooks.stop = () => { killsAtStop ??= [...host.kills]; return []; };
    await h.manager.shutdown();
    assert.deepEqual(h.sequence("plain-shutdown"), ["list"], "shutdown only lists the shells before the runtime stops");
    assert.deepEqual(killsAtStop, [], "nothing ends a shell (or the turn running it) before CopilotClient.stop");
    const stopAt = h.log.findIndex((e) => e.startsWith("stop:"));
    assert.ok(h.log.indexOf("list:plain-shutdown") < stopAt, "the shells are listed before the runtime stops");
    assert.deepEqual(host.kills, [500], "the shell is killed after the stop");
});

test("an eviction sweep tears sessions down side by side, and one deadline bounds a hung cancel or disconnect (SF-6)", async (t) => {
    const h = fixture(t, { copilotClientIdleStopMs: 0 });
    // WORKSPACE_RELEASE_DEADLINE_MS in session-manager.ts.
    const DEADLINE_MS = 20_000;
    const hang = new Promise(() => {});
    h.hooks.list = (id) => (id === "hung-list" ? hang : undefined);
    h.hooks.disconnect = (id) => (id === "hung-disconnect" ? hang : undefined);
    await onMockClock(t, async (clock) => {
        // The healthy session is swept last: one at a time, it would wait for both hung ones.
        for (const id of ["hung-list", "hung-disconnect", "healthy"]) {
            await h.manager.getOrCreate(id, {}, { turnIndex: 0 });
            h.handles.get(id).tasks.set("shell-1", { id: "shell-1", type: "shell", status: "running" });
        }
        clock.tick(1);
        const sweep = track(h.manager.sweepIdleSessions(1));
        await flush();
        assert.equal(h.manager.sessions.has("healthy"), false, "the healthy session is torn down while the others hang");
        assert.deepEqual(h.sequence("healthy"), ["list", "cancel", "list", "disconnect"]);
        assert.deepEqual(h.sequence("hung-disconnect"), ["list", "cancel", "list", "disconnect"]);
        clock.tick(DEADLINE_MS - 1);
        await flush();
        assert.equal(sweep.settled, false, "a hung session is waited for until the deadline");
        clock.tick(1);
        await flush();
        assert.equal(sweep.settled, true, "the cancel and the disconnect share one deadline");
        assert.equal(sweep.error, undefined);
        assert.deepEqual([...h.manager.sessions.keys()], [], "every session was dropped");
    });
});

test("a worker shutdown kills each runtime's shells once that runtime has stopped, not after every runtime has (SF-7)", async (t) => {
    const h = fixture(t);
    const startedAt = Date.now();
    const host = shellHost([{ cli: 900, pid: 500, startedAt }, { cli: 901, pid: 501, startedAt }]);
    const shells = { s1: 500, s2: 501 };
    await h.manager.getOrCreate("s1", { workspace: WORKSPACE, workspaceAttach: attach("a") }, { turnIndex: 0 });
    await h.manager.getOrCreate("s2", { workspace: { ...WORKSPACE, root: "b" }, workspaceAttach: attach("b") }, { turnIndex: 0 });
    assert.notEqual(h.runtimeOf("s1").client, h.runtimeOf("s2").client);
    for (const [id, pid] of Object.entries(shells)) {
        h.manager.sessions.get(id).processHost = host;
        h.handles.get(id).tasks.set("shell-1", { id: "shell-1", type: "shell", status: "running", pid, startedAt: new Date(startedAt).toISOString() });
    }
    const releaseA = deferred();
    const a = h.runtimeOf("s1").client;
    h.hooks.stop = (client) => (client === a ? releaseA.promise.then(() => []) : []);
    let shutdown;
    try {
        shutdown = h.manager.shutdown();
        await waitFor(() => host.kills.includes(501), "the kill of the shell on the runtime that stopped");
        assert.equal(host.kills.includes(500), false, "the other runtime has not stopped yet");
    } finally {
        releaseA.resolve();
    }
    await shutdown;
    assert.deepEqual(host.kills.sort(), [500, 501]);
});

test("a one-shot prompt that never goes idle times out, aborts, and rejects", async () => {
    const listeners = new Map();
    let aborted = 0;
    const session = {
        on: (event, fn) => { listeners.set(event, fn); },
        send: async () => {},
        abort: async () => { aborted++; },
    };
    await assert.rejects(sendCopilotPrompt(session, "title?", 20), /timed out/);
    assert.equal(aborted, 1);

    const answering = {
        on: (event, fn) => { listeners.set(event, fn); },
        send: async () => {
            listeners.get("assistant.message")({ data: { content: "  A Title  " } });
            listeners.get("session.idle")({});
        },
        abort: async () => { aborted++; },
    };
    assert.equal(await sendCopilotPrompt(answering, "title?", 1000), "A Title");
    assert.equal(aborted, 1, "no abort without a timeout");
});

/** The summarizeSession activity on mocked runtimes, with the default provider given. */
function summarizeFixture(t) {
    const mocks = mockRuntimes(t);
    const titles = [];
    const catalog = {
        getSession: async (id) => ({ sessionId: id, title: "", isSystem: false, titleLocked: false }),
        getSessionEvents: async () => [{ eventType: "user.message", data: { content: "Plan the retained-marker migration" } }],
        updateSessionTitleIfUnlocked: async (_id, title) => { titles.push(title); return true; },
    };
    const summarizeWith = (provider) => {
        const handlers = new Map();
        registerActivities({ registerActivity: (name, fn) => handlers.set(name, fn) }, { resolveDefaultProvider: () => provider }, null, undefined, catalog);
        return (id) => handlers.get("summarizeSession")({ traceInfo() {}, traceWarn() {} }, { sessionId: id });
    };
    const provider = { modelName: "m", sdkProvider: { type: "openai", baseUrl: "https://example.invalid/v1", apiKey: "k" } };
    return { mocks, titles, summarizeWith, summarize: summarizeWith(provider) };
}

test("summarizeSession stops its one-shot runtime on success, failure and the early return", async (t) => {
    const { mocks, titles, summarizeWith, summarize } = summarizeFixture(t);

    // No provider and no token: the early return still stops the runtime.
    assert.equal(await summarizeWith(undefined)("s0"), "");
    assert.equal(mocks.runtimes.at(-1).stopped, 1);

    // createSession fails: the fallback title is written and the runtime stopped.
    mocks.hooks.createSession = async () => { throw new Error("model unavailable"); };
    assert.equal(await summarize("s1"), "Plan the retained-marker");
    assert.equal(mocks.runtimes.at(-1).stopped, 1);

    // A title from the model: the runtime is stopped too.
    const listeners = new Map();
    mocks.hooks.createSession = async () => ({
        on: (event, fn) => { listeners.set(event, fn); },
        send: async () => {
            listeners.get("assistant.message")({ data: { content: "Retained Marker Migration Plan" } });
            listeners.get("session.idle")({});
        },
        abort: async () => {},
    });
    assert.equal(await summarize("s2"), "Retained Marker Migration Plan");
    assert.equal(mocks.runtimes.at(-1).stopped, 1);
    assert.equal(mocks.runtimes.length, 3, "one runtime per activity");
    assert.deepEqual(titles, ["Plan the retained-marker", "Retained Marker Migration Plan"]);
});

test("summarizeSession's one budget covers the runtime start, the session create and the prompt; past it the runtime is forced to stop (SF-8, SF-14)", async (t) => {
    const { mocks, titles, summarize } = summarizeFixture(t);
    const never = () => new Promise(() => {});
    const late = [];
    /** Run one summary on the mock clock; it must settle exactly at the budget. */
    const timesOut = async (clock, id, beforeMs = 0) => {
        const run = track(summarize(id));
        await flush();
        if (beforeMs > 0) {
            clock.tick(beforeMs);
            await flush();
        }
        clock.tick(SUMMARIZE_SESSION_TIMEOUT_MS - beforeMs - 1);
        await flush();
        assert.equal(run.settled, false, `${id}: still within the budget`);
        clock.tick(1);
        await flush();
        assert.equal(run.settled, true, `${id}: settled at the budget`);
        assert.equal(run.error, undefined);
        assert.equal(run.value, "Plan the retained-marker", `${id}: the fallback title`);
        const runtime = mocks.runtimes.at(-1);
        assert.deepEqual([runtime.forced, runtime.stopped], [1, 0], `${id}: forced to stop, not stopped gracefully`);
    };
    await onMockClock(t, async (clock) => {
        try {
            // The runtime never starts: no session is created.
            let creates = 0;
            mocks.hooks.start = never;
            mocks.hooks.createSession = () => { creates++; return never(); };
            await timesOut(clock, "pending-start");
            assert.equal(creates, 0);

            // The session create never answers; one that answers late is not used.
            mocks.hooks.start = null;
            const created = deferred();
            late.push(created);
            mocks.hooks.createSession = () => created.promise;
            await timesOut(clock, "pending-create");
            let used = 0;
            created.resolve({ on() {}, send: async () => { used++; }, abort: async () => { used++; } });
            await flush();
            assert.equal(used, 0, "no prompt and no abort on a session created after the budget");

            // The prompt never goes idle: it is aborted once.
            let aborted = 0;
            mocks.hooks.createSession = async () => ({ on() {}, send: async () => {}, abort: async () => { aborted++; } });
            await timesOut(clock, "pending-prompt");
            assert.equal(aborted, 1);

            // A slow start spends part of the budget: the create gets only what is left.
            mocks.hooks.start = () => new Promise((resolve) => setTimeout(resolve, SUMMARIZE_SESSION_TIMEOUT_MS / 2));
            creates = 0;
            mocks.hooks.createSession = () => { creates++; return never(); };
            await timesOut(clock, "slow-start", SUMMARIZE_SESSION_TIMEOUT_MS / 2);
            assert.equal(creates, 1);
        } finally {
            for (const created of late) created.resolve(undefined);
        }
    });
    assert.equal(titles.length, 4);
});

