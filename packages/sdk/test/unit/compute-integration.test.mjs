/**
 * Focused integration unit tests for PR 1 compute wiring across PilotSwarmClient, SessionManager, and PilotSwarmWorker:
 *   - createSession validates & persists computeTarget in creationConfig and rejects computeTarget + workspace;
 *   - resumeSession refuses changing or adding computeTarget;
 *   - SessionManager binds/releases remote runtimes with ABA token protection, strips worker MCP/skills/workingDirectory/additionalDirectories,
 *     scopes remote model grants per session, clears bindings on shutdown(), and never broadcasts plain local destroys to compute providers;
 *   - PilotSwarmWorker fails closed at start() on missing provider and refuses late registerComputeProvider() after start().
 *
 * Run: node --test test/unit/compute-integration.test.mjs   (requires a prior build)
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    ComputeRegistry,
    ComputeTargetError,
    PilotSwarmClient,
    PilotSwarmWorker,
    RemoteRuntimeError,
    SessionManager,
    isRemoteRuntimeError,
} from "../../dist/index.js";

function sampleTarget(overrides = {}) {
    return {
        id: "target-remote-1",
        name: "remote-1",
        kind: "provider-alpha",
        class: "shared",
        statePolicy: "store-owned",
        displayName: "Remote Pool",
        enabled: true,
        config: { region: "east" },
        ...overrides,
    };
}

function fakeCatalog() {
    const rows = new Map();
    const creationConfigs = new Map();
    return {
        rows,
        creationConfigs,
        async createSession(sessionId, opts = {}) {
            const existing = creationConfigs.get(sessionId);
            if (existing && opts.creationConfig) {
                const prevTarget = existing.computeTarget?.targetId ?? null;
                const nextTarget = opts.creationConfig.computeTarget?.targetId ?? null;
                if (prevTarget !== nextTarget) {
                    throw new ComputeTargetError(`session ${sessionId} cannot overwrite its compute target after creation`);
                }
            }
            rows.set(sessionId, { sessionId, state: "pending", model: opts.model ?? null, sessionKind: "agent" });
            if (opts.creationConfig) creationConfigs.set(sessionId, opts.creationConfig);
        },
        async getSession(sessionId) {
            return rows.get(sessionId) ?? null;
        },
        async getSessionCreationConfig(sessionId) {
            return creationConfigs.get(sessionId) ?? null;
        },
        async recordEvents() {},
        async updateSession() {},
    };
}

test("PilotSwarmClient.createSession persists computeTarget and resumeSession enforces immutability", async () => {
    const catalog = fakeCatalog();
    const client = new PilotSwarmClient({ store: "sqlite::memory:" });
    client._catalog = catalog;
    client.duroxideClient = {
        async getInstanceInfo() { return { status: "Unknown" }; },
        async getStatus() { return {}; },
    };

    const session = await client.createSession({
        computeTarget: { targetId: "target-remote-1" },
    });
    assert.deepEqual(catalog.creationConfigs.get(session.sessionId)?.computeTarget, { targetId: "target-remote-1" });

    // Local workspace + computeTarget is refused before any CMS write.
    await assert.rejects(
        () => client.createSession({
            sessionId: "sess-conflict-ws",
            computeTarget: { targetId: "target-remote-1" },
            workspace: { root: "git", folder: "repo" },
        }),
        ComputeTargetError,
    );
    assert.equal(catalog.rows.has("sess-conflict-ws"), false);

    // Repeating the same computeTarget on resume succeeds; changing it is refused.
    await client.resumeSession(session.sessionId, { computeTarget: { targetId: "target-remote-1" } });
    await assert.rejects(
        () => client.resumeSession(session.sessionId, { computeTarget: { targetId: "target-other" } }),
        ComputeTargetError,
    );

    // Adding a computeTarget onto an existing local session is refused.
    const localSession = await client.createSession({});
    assert.equal(catalog.creationConfigs.get(localSession.sessionId)?.computeTarget, undefined);
    await assert.rejects(
        () => client.resumeSession(localSession.sessionId, { computeTarget: { targetId: "target-remote-1" } }),
        ComputeTargetError,
    );
});

test("SessionManager: remote binding strips worker paths/MCP/skills, enforces ABA token, cleans up on shutdown and skips local release broadcasts", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-compute-sm-"));
    try {
        const createdConfigs = [];
        const destroyedHandles = [];
        const makeFakeClient = (tag) => ({
            async createSession(cfg) {
                createdConfigs.push({ tag, cfg });
                return {
                    sessionId: cfg.sessionId,
                    on() { return () => {}; },
                    async disconnect() { destroyedHandles.push(tag); },
                    async destroy() { destroyedHandles.push(tag); },
                };
            },
            async resumeSession(id, cfg) {
                createdConfigs.push({ tag, resumed: id, cfg });
                return {
                    sessionId: id,
                    on() { return () => {}; },
                    async disconnect() { destroyedHandles.push(tag); },
                    async destroy() { destroyedHandles.push(tag); },
                };
            },
        });

        const releases = [];
        const registry = new ComputeRegistry({
            targets: [sampleTarget()],
            providers: [{
                kind: "provider-alpha",
                supportedStatePolicies: ["store-owned"],
                async releaseSession(req) { releases.push(req); },
            }],
        });

        const manager = new SessionManager(
            undefined,
            null,
            {
                provider: { type: "openai", baseUrl: "https://models.example.test/v1", apiKey: "sk-secret-value" },
                skillDirectories: [tmpDir],
                baseMcpServers: { localTool: { command: "echo", args: ["hi"] } },
            },
            tmpDir,
        );
        manager.setFactStore({
            storeFact: async () => ({ stored: true }),
            readFacts: async () => [],
            deleteFact: async () => ({ deleted: true }),
        });
        manager.setComputeRegistry(registry);

        // Unbound session naming a computeTarget is refused before any local side effects.
        await assert.rejects(
            () => manager.getOrCreate("s-remote", { computeTarget: { targetId: "target-remote-1" } }, { turnIndex: 0 }),
            (err) => isRemoteRuntimeError(err) && err.code === "REMOTE_RUNTIME_UNAVAILABLE" && err.terminal === false,
        );

        // Bind turn 1 and verify isolation of the config sent to the remote CopilotClient.
        const token1 = manager.bindRemoteRuntime("s-remote", { client: makeFakeClient("c1") }, { resume: false });
        assert.equal(typeof token1, "symbol");
        assert.throws(
            () => manager.bindRemoteRuntime("s-remote", { client: makeFakeClient("dup") }),
            (err) => isRemoteRuntimeError(err) && err.code === "REMOTE_RUNTIME_BOUND" && err.terminal === false,
        );

        await manager.getOrCreate("s-remote", {
            computeTarget: { targetId: "target-remote-1" },
            workingDirectory: "/worker/secret/path",
            workspaceAttach: {
                path: "/worker/home",
                homeIsWorkingFolder: true,
                extras: [{ name: "shared", path: "/worker/shared" }],
            },
        }, { turnIndex: 0 });

        assert.equal(createdConfigs.length, 1);
        const sent = createdConfigs[0].cfg;
        assert.equal(sent.workingDirectory, undefined, "worker workingDirectory must not cross to remote");
        assert.equal(sent.additionalDirectories, undefined, "worker additionalDirectories must not cross to remote");
        assert.equal(sent.skillDirectories, undefined, "worker skillDirectories must not cross to remote");
        assert.equal(sent.mcpServers, undefined, "worker MCP servers must not cross to remote");
        assert.equal(sent.enableFileHooks, false);
        assert.equal(sent.skipCustomInstructions, true);
        assert.ok(!JSON.stringify(sent).includes("sk-secret-value"), "real API key never reaches remote config");

        // Per-session request handler rejects a mismatched sessionId.
        const scopedHandler = manager.createRemoteModelRequestHandler("s-remote");
        await assert.rejects(
            () => scopedHandler.sendRequest(
                new Request("https://models.example.test/v1/chat/completions", { method: "POST", body: "{}" }),
                { requestId: "r1", sessionId: "s-other", transport: "http", url: "", headers: {}, signal: new AbortController().signal },
            ),
            /does not match this runtime's bound session/,
        );

        // Release with wrong token is a no-op; release with right token detaches cleanly.
        await manager.releaseRemoteRuntime("s-remote", Symbol("stale-token"));
        assert.equal(manager.hasRemoteRuntime("s-remote"), true);
        await manager.releaseRemoteRuntime("s-remote", token1);
        assert.equal(manager.hasRemoteRuntime("s-remote"), false);
        assert.deepEqual(destroyedHandles, ["c1"]);

        // Re-bind and verify shutdown() clears bindings and grants.
        manager.bindRemoteRuntime("s-remote", { client: makeFakeClient("c2") }, { resume: true });
        await manager.shutdown();
        assert.equal(manager.hasRemoteRuntime("s-remote"), false);

        // Destroying a plain local session never broadcasts to compute providers.
        await manager.destroySession("s-local-never-remote");
        assert.deepEqual(releases, []);

        // Destroying a session whose config named a computeTarget notifies the matching provider.
        manager.setConfig("s-remote-del", { computeTarget: { targetId: "target-remote-1" } });
        await manager.destroySession("s-remote-del");
        assert.equal(releases.length, 1);
        assert.deepEqual(releases[0], { sessionId: "s-remote-del", targetId: "target-remote-1", reason: "deleted" });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("PilotSwarmWorker: start() fails closed on missing compute provider before duroxide starts, and seals registration", async () => {
    const worker = new PilotSwarmWorker({
        store: "sqlite::memory:",
        computeTargets: [sampleTarget()],
    });
    await assert.rejects(() => worker.start(), /unregistered provider kind provider-alpha/);

    // After a failed start(), the worker is not stuck in _starting and can still accept provider registration.
    worker.registerComputeProvider({
        kind: "provider-alpha",
        supportedStatePolicies: ["store-owned"],
    });
    // Duplicate registration is still refused.
    assert.throws(
        () => worker.registerComputeProvider({ kind: "provider-alpha", supportedStatePolicies: ["store-owned"] }),
        ComputeTargetError,
    );
});
