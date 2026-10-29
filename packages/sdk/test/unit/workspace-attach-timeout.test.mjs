import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { setImmediate } from "node:timers/promises";
import { registerActivities } from "../../dist/session-proxy.js";
import { PilotSwarmWorker } from "../../dist/worker.js";
import { PilotSwarmClient } from "../../dist/client.js";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { runtimeStorageProviders } from "../../dist/storage-providers.js";
import { createFakeWorkspaceProvider } from "../helpers/fake-workspace-provider.mjs";

const duroxide = createRequire(import.meta.url)("duroxide");
const context = { traceInfo() {}, isCancelled: () => false };
const request = {
    sessionId: "attach-timeout-test",
    workspace: { root: "repo" },
    revision: 1,
    turnIndex: 1,
};

function activityFixture(t, timeoutMs, { extra = false, bridge, release = false } = {}) {
    const provider = createFakeWorkspaceProvider({
        roots: [{ name: "repo", path: os.tmpdir() }, { name: "reference", path: os.tmpdir() }],
    });
    t.after(() => {
        provider.releaseHangs(undefined, { type: "fail", code: "TEST_CLEANUP" });
        provider.reset();
    });
    provider.script({ type: "hang" }, extra ? { attachment: "reference" } : {});
    if (release) provider.script({ type: "hang" }, { method: "release" });
    let started;
    const attaching = new Promise(resolve => { started = resolve; });
    let released;
    const releasing = new Promise(resolve => { released = resolve; });
    provider.onCall((call, phase) => {
        if (phase === "call" && call.method === "ensureAttached"
            && (!extra || call.req.attachment === "reference")) started();
        if (phase === "call" && call.method === "release") released();
    });
    const activities = new Map();
    const manager = {
        getModelSummary: async () => null,
        getWorkspaceProvider: () => provider,
        withRunTurnLock: async (_sessionId, _operation, fn) => fn(),
        holdWorkspaceFolders: () => {},
        settleCheckAttaches: async () => {},
        normalizeModelRef: model => model,
        getOrCreate: async () => ({
            abort() {},
            runTurn: async (_prompt, turn) => ({
                type: "completed", content: await bridge(turn.controlToolBridge), events: [],
            }),
        }),
    };
    registerActivities({
        registerActivity: (name, handler) => activities.set(name, handler),
    }, manager, null, undefined, null, undefined, "in-memory://attach-timeout", undefined,
    { workspaceAttachTimeoutMs: timeoutMs });
    const workspace = extra
        ? { root: "repo", extra: { reference: { root: "reference", required: true } } }
        : request.workspace;
    return {
        attaching,
        releasing,
        check: () => activities.get("checkWorkspace")(context, {
            ...request, workspace, ...(extra ? { previous: request.workspace } : {}),
        }),
        turn: () => activities.get("runTurn")(context, {
            sessionId: request.sessionId, prompt: "must not reach a model",
            config: bridge ? {} : { workspace }, turnIndex: 1,
        }),
        spawn: () => activities.get("spawnChildSession")(context, {
            parentSessionId: request.sessionId, config: { workspace },
            task: "must not create a child", workspaceChosen: true,
        }),
    };
}

function deadlineResult(pending) {
    return Promise.race([
        pending,
        setImmediate().then(() => assert.fail("activity did not settle at its attachment deadline")),
    ]);
}

for (const [label, configured, deadline] of [["default", undefined, 30_000], ["configured", 90_000, 90_000]]) {
    test(`the real runTurn activity uses the ${label} workspace attachment deadline`, { timeout: 10_000 }, async t => {
        const fixture = activityFixture(t, configured);
        t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
        let settled = false;
        const pending = fixture.turn().then(result => { settled = true; return result; });
        await Promise.race([fixture.attaching, pending.then(result => assert.fail(`turn ended before attachment: ${JSON.stringify(result)}`))]);
        t.mock.timers.tick(deadline - 1);
        await setImmediate();
        assert.equal(settled, false);
        t.mock.timers.tick(1);
        const result = await deadlineResult(pending);
        assert.equal(result.type, "wait");
        assert.equal(result.gate, "workspace");
        assert.equal(result.code, "WORKSPACE_ATTACH_TIMEOUT");
        assert.match(result.reason, new RegExp(`${deadline} ms`));
    });
}

for (const activity of ["turn", "check"]) {
    for (const extra of [false, true]) {
        if (activity === "turn" && !extra) continue;
        test(`the configured deadline reaches ${activity} ${extra ? "extra" : "working"} folder preparation`, { timeout: 10_000 }, async t => {
            const fixture = activityFixture(t, 200, { extra });
            t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
            const pending = fixture[activity]();
            await Promise.race([fixture.attaching, pending.then(result => assert.fail(`activity ended before attachment: ${JSON.stringify(result)}`))]);
            t.mock.timers.tick(200);
            const result = await deadlineResult(pending);
            assert.equal(result.code, "WORKSPACE_ATTACH_TIMEOUT");
            assert.match(result.message ?? result.reason, /200 ms/);
        });
    }
}

test("the configured deadline reaches the spawnChildSession activity", { timeout: 10_000 }, async t => {
    t.mock.method(PilotSwarmClient.prototype, "start", async () => {});
    t.mock.method(PilotSwarmClient.prototype, "stop", async () => {});
    t.mock.method(PilotSwarmClient.prototype, "createSession", async () => assert.fail("child must not be created"));
    const fixture = activityFixture(t, 200);
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const pending = fixture.spawn();
    const rejected = assert.rejects(pending, /WORKSPACE_ATTACH_TIMEOUT:.*200 ms/);
    await fixture.attaching;
    t.mock.timers.tick(200);
    await deadlineResult(rejected);
});

test("spawn checks reserve one parallel release budget after working and extra attachment", { timeout: 10_000 }, async t => {
    t.mock.method(PilotSwarmClient.prototype, "start", async () => {});
    t.mock.method(PilotSwarmClient.prototype, "stop", async () => {});
    const fixture = activityFixture(t, 200, { extra: true, release: true });
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let settled = false;
    const pending = fixture.spawn().finally(() => { settled = true; });
    const rejected = assert.rejects(pending, /WORKSPACE_ATTACH_TIMEOUT:.*200 ms/);
    await fixture.attaching;
    t.mock.timers.tick(200);
    await fixture.releasing;
    t.mock.timers.tick(9_999);
    await setImmediate();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    await deadlineResult(rejected);
});

for (const method of ["spawnAgent", "checkWorkspace"]) {
    test(`the configured deadline reaches the in-turn ${method} bridge`, { timeout: 10_000 }, async t => {
        t.mock.method(PilotSwarmClient.prototype, "start", async () => {});
        t.mock.method(PilotSwarmClient.prototype, "stop", async () => {});
        t.mock.method(PilotSwarmClient.prototype, "listSessions", async () => []);
        const fixture = activityFixture(t, 200, {
            bridge: async bridge => {
                const result = await bridge[method]({ workspace: request.workspace, task: "must not create a child" });
                return typeof result === "string" ? result : result.message;
            },
        });
        t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
        const pending = fixture.turn();
        await fixture.attaching;
        t.mock.timers.tick(200);
        const result = await deadlineResult(pending);
        assert.equal(result.type, "completed");
        assert.match(result.content, /200 ms/);
    });
}

test("worker startup forwards its configured deadline into the registered turn activity", { timeout: 10_000 }, async t => {
    const activities = new Map();
    const registered = new Error("stop before dispatch");
    t.mock.method(duroxide, "Runtime", function () {
        return {
            registerActivity: (name, handler) => activities.set(name, handler),
            registerOrchestrationVersioned() { throw registered; },
            shutdown: async () => {},
        };
    });
    t.mock.method(duroxide, "Client", function () {});
    // Re-evaluate only the worker's CJS bindings; no native runtime is created.
    const { PilotSwarmWorker: TestWorker } = await import("../../dist/worker.js?attach-timeout-test");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-worker-attach-timeout-"));
    const provider = createFakeWorkspaceProvider({ roots: [{ name: "repo", path: root }] });
    provider.script({ type: "hang" });
    const worker = new TestWorker({
        store: "sqlite::memory:", sessionStateDir: path.join(root, "sessions"),
        disableManagementAgents: true, workspaceProvider: provider, workspaceAttachTimeoutMs: 90_000,
        storageConfig: {
            runtime: { provider: "postgres", url: "in-memory://attach-timeout", cmsSchema: "test_cms" },
            duroxide: { provider: "postgres", url: "sqlite::memory:" },
        },
    });
    t.after(async () => {
        provider.reset();
        await worker.stop();
        fs.rmSync(root, { recursive: true, force: true });
    });
    const catalog = { initialize: async () => {}, close: async () => {} };
    t.mock.method(runtimeStorageProviders.postgres, "createSessionCatalog", async () => catalog);
    t.mock.method(runtimeStorageProviders.postgres, "createFactStore", async () => ({
        initialize: async () => {}, close: async () => {},
    }));
    t.mock.method(worker, "_createProvider", async () => ({}));
    await assert.rejects(worker.start(), error => error === registered);
    t.mock.method(worker.sessionManager, "getModelSummary", async () => null);
    t.mock.method(worker.sessionManager, "withRunTurnLock", async (_id, _operation, fn) => fn());
    let started;
    const attaching = new Promise(resolve => { started = resolve; });
    provider.onCall((call, phase) => {
        if (phase === "call" && call.method === "ensureAttached") started();
    });
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let settled = false;
    const pending = activities.get("runTurn")(context, {
        sessionId: request.sessionId, prompt: "must not reach a model",
        config: { workspace: request.workspace }, turnIndex: 1,
    }).then(result => { settled = true; return result; });
    await attaching;
    t.mock.timers.tick(30_000);
    await setImmediate();
    assert.equal(settled, false, "worker option must override the default");
    t.mock.timers.tick(60_000);
    const result = await deadlineResult(pending);
    assert.equal(result.code, "WORKSPACE_ATTACH_TIMEOUT");
    assert.match(result.reason, /90000 ms/);
});

test("workers reject attachment deadlines that disable or overflow a finite timer", () => {
    for (const timeout of [0, -1, 0.5, NaN, Infinity, 2_147_483_648, null, "90000"]) {
        assert.throws(() => new PilotSwarmWorker({
            store: "unused", workspaceAttachTimeoutMs: timeout,
        }), /workspaceAttachTimeoutMs must be an integer between 1 and 2147483647/);
    }
});

test("workers reject attachment budgets that leave no watchdog margin for working and extra folders", () => {
    for (const options of [
        { workspaceAttachTimeoutMs: 130_000 },
        { workspaceAttachTimeoutMs: 90_000, turnInactivityTimeoutMs: 220_000 },
        { workspaceAttachTimeoutMs: 90_000, turnInactivityTimeoutMs: 200_000 },
        { workspaceAttachTimeoutMs: 90_000, turnInactivityTimeoutMs: 100_000 },
        { workspaceRoots: [{ name: "repo", path: os.tmpdir() }], turnInactivityTimeoutMs: 1 },
        { workspaceProvider: createFakeWorkspaceProvider(), turnInactivityTimeoutMs: 100_000 },
    ]) {
        assert.throws(() => new PilotSwarmWorker({
            store: "unused", ...options,
        }), /Workspace preparation budget.*must be below turnInactivityTimeoutMs/);
    }
});

test("workspace budgets also fit the resolved wall-clock cap when the watchdog is disabled", () => {
    for (const options of [
        { workspaceAttachTimeoutMs: 90_000, turnTimeoutMs: 220_000 },
        { workspaceProvider: createFakeWorkspaceProvider(), turnTimeoutMs: 100_000 },
        { workspaceAttachTimeoutMs: 2_147_483_647 },
    ]) {
        assert.throws(() => new PilotSwarmWorker({
            store: "unused", turnInactivityTimeoutMs: 0, ...options,
        }), /Workspace preparation budget.*must be below turnTimeoutMs/);
    }
});

test("workspace sizing uses the environment-resolved wall-clock cap", t => {
    const previous = process.env.PILOTSWARM_TURN_TIMEOUT_MS;
    t.after(() => {
        if (previous === undefined) delete process.env.PILOTSWARM_TURN_TIMEOUT_MS;
        else process.env.PILOTSWARM_TURN_TIMEOUT_MS = previous;
    });
    process.env.PILOTSWARM_TURN_TIMEOUT_MS = "220000";
    assert.throws(() => new PilotSwarmWorker({
        store: "unused", workspaceAttachTimeoutMs: 90_000, turnInactivityTimeoutMs: 0,
    }), /must be below turnTimeoutMs \(220000 ms\)/);
});

test("enabling a provider later validates the default budget without changing non-workspace workers", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-late-workspace-"));
    const worker = new PilotSwarmWorker({
        store: "unused", sessionStateDir: path.join(root, "sessions"),
        disableManagementAgents: true, turnInactivityTimeoutMs: 1, turnTimeoutMs: 4_000,
    });
    t.after(async () => {
        await worker.sessionManager.shutdown();
        fs.rmSync(root, { recursive: true, force: true });
    });
    assert.throws(() => worker.setWorkspaceProvider(createFakeWorkspaceProvider()),
        /Workspace preparation budget.*must be below turnInactivityTimeoutMs/);
    assert.equal(worker.sessionManager.getWorkspaceProvider(), null);
    worker.setWorkspaceProvider(null);
});

test("workers accept larger budgets with a matching watchdog or an explicitly disabled watchdog", async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-attach-watchdog-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    for (const options of [
        { workspaceAttachTimeoutMs: 129_999 },
        { workspaceAttachTimeoutMs: 90_000, turnInactivityTimeoutMs: 220_001, turnTimeoutMs: 220_001 },
        { workspaceAttachTimeoutMs: 180_000, turnInactivityTimeoutMs: 400_001 },
        { workspaceAttachTimeoutMs: 2_147_483_647, turnInactivityTimeoutMs: 0, turnTimeoutMs: 0 },
        { turnInactivityTimeoutMs: 1 },
        { workspaceProvider: createFakeWorkspaceProvider(), turnTimeoutMs: 100_001 },
    ]) {
        const worker = new PilotSwarmWorker({
            store: "unused", sessionStateDir: path.join(root, "sessions"),
            disableManagementAgents: true, ...options,
        });

        await worker.sessionManager.shutdown();
    }
});

for (const answerAt of [90_000, null]) {
    test(`external workspace commands ${answerAt ? "can complete after 30 seconds" : "return pending rather than failure when their wait expires"}`, async t => {
        const client = Object.create(PilotSwarmManagementClient.prototype);
        client._ensureStarted = () => {};
        client._sendWorkspaceCommand = async () => {};
        t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
        const startedAt = Date.now();
        client.getCommandResponse = async () => answerAt !== null && Date.now() - startedAt >= answerAt
            ? { result: { changed: true, revision: 2, workspace: request.workspace } } : null;
        let settled = false;
        const pending = client.setSessionWorkspace(request.sessionId, {
            expectedRevision: 1, workspace: request.workspace,
        }).then(result => { settled = true; return result; });
        await setImmediate();
        t.mock.timers.tick(30_000);
        await setImmediate();
        assert.equal(settled, false);
        t.mock.timers.tick((answerAt ?? 120_000) - 30_000);
        const result = await deadlineResult(pending);
        assert.equal(result.status, answerAt ? "changed" : "pending");
        if (!answerAt) assert.ok(result.commandId);
    });
}
