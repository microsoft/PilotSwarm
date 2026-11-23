/**
 * Issue #331: pooled Copilot runtimes are stopped once idle, and every
 * teardown stops a session's background shells first.
 *
 * The real pool path runs (ensureClient, start, leases, idle timers); only
 * the CopilotClient methods that would reach a CLI process are mocked.
 *
 * Run: node --test test/unit/copilot-runtime-idle-stop.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import { SessionManager } from "../../dist/session-manager.js";
import { createCopilotClient, sendCopilotPrompt, stopCopilotClient } from "../../dist/copilot-client.js";
import { registerActivities } from "../../dist/session-proxy.js";

const IDLE_MS = 40;
const WORKSPACE = { schema: 1, root: "a", folder: "repo-x" };
const attach = (root = "a") => ({ root, rootPath: `/ws/${root}`, path: `/ws/${root}/repo-x`, realPath: `/ws/${root}/repo-x` });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
            entry = { client, id: runtimes.length + 1, started: 0, stopped: 0, forced: 0 };
            runtimes.push(entry);
        }
        return entry;
    };
    const hooks = { listModels: null, deleteSession: null, stop: null, createSession: null };
    const handles = new Map();
    const bound = new Map();
    const open = (client, kind, config, home) => {
        const tasks = new Map();
        const handle = {
            tasks,
            disconnect: async () => { log.push(`disconnect:${config.sessionId}`); },
            rpc: {
                tasks: {
                    list: async () => { log.push(`list:${config.sessionId}`); return { tasks: [...tasks.values()] }; },
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
    let home = "";
    t.mock.method(CopilotClient.prototype, "start", async function () { info(this).started++; });
    t.mock.method(CopilotClient.prototype, "stop", async function () {
        const entry = info(this);
        entry.stopped++;
        log.push(`stop:runtime${entry.id}`);
        if (hooks.stop) return hooks.stop(this);
        return [];
    });
    t.mock.method(CopilotClient.prototype, "forceStop", async function () { info(this).forced++; log.push(`forceStop:runtime${info(this).id}`); });
    t.mock.method(CopilotClient.prototype, "createSession", async function (config) {
        info(this);
        if (hooks.createSession) return hooks.createSession(config);
        return open(this, "create", config, home);
    });
    t.mock.method(CopilotClient.prototype, "resumeSession", async function (_id, config) { return open(this, "resume", config, home); });
    t.mock.method(CopilotClient.prototype, "deleteSession", async function (id) {
        log.push(`deleteSession:${id}:runtime${info(this).id}`);
        if (hooks.deleteSession) await hooks.deleteSession();
    });
    t.mock.method(CopilotClient.prototype, "listModels", async function () {
        log.push(`listModels:runtime${info(this).id}`);
        if (hooks.listModels) await hooks.listModels();
        return [];
    });
    return { runtimes, log, info, hooks, handles, bound, setHome: (dir) => { home = dir; } };
}

function fixture(t, workerDefaults = { copilotClientIdleStopMs: IDLE_MS }) {
    const mocks = mockRuntimes(t);
    const home = mkdtempSync(join(tmpdir(), "ps-idle-stop-"));
    mocks.setHome(home);
    const manager = new SessionManager(undefined, null, workerDefaults, home);
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
    return { manager, ...mocks, runtimeOf, sequence };
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

test("every teardown of a session without a workspace stops its background shells before the disconnect", async (t) => {
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
    };
    for (const [name, run] of Object.entries(runs)) {
        const id = `plain-${name}`;
        await warmWithShell(id);
        await run(id);
        assert.deepEqual(h.sequence(id), ["list", "cancel", "list", "disconnect"], name);
    }

    await warmWithShell("plain-shutdown");
    await h.manager.shutdown();
    assert.deepEqual(h.sequence("plain-shutdown"), ["list", "cancel", "list"], "shutdown cancels, then the runtime stops");
    const cancelAt = h.log.indexOf("cancel:plain-shutdown:shell-1");
    const stopAt = h.log.findIndex((e) => e.startsWith("stop:"));
    assert.ok(cancelAt >= 0 && stopAt > cancelAt, "shells are cancelled before the runtime stops");
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

test("summarizeSession stops its one-shot runtime on success, failure and the early return", async (t) => {
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

    // No provider and no token: the early return still stops the runtime.
    assert.equal(await summarizeWith(undefined)("s0"), "");
    assert.equal(mocks.runtimes.at(-1).stopped, 1);

    // createSession fails: the fallback title is written and the runtime stopped.
    mocks.hooks.createSession = async () => { throw new Error("model unavailable"); };
    assert.equal(await summarizeWith(provider)("s1"), "Plan the retained-marker");
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
    assert.equal(await summarizeWith(provider)("s2"), "Retained Marker Migration Plan");
    assert.equal(mocks.runtimes.at(-1).stopped, 1);
    assert.equal(mocks.runtimes.length, 3, "one runtime per activity");
    assert.deepEqual(titles, ["Plan the retained-marker", "Retained Marker Migration Plan"]);
});
