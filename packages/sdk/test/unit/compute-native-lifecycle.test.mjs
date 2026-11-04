import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "../../dist/session-manager.js";
import { ModelProviderRegistry } from "../../dist/model-providers.js";
import { FilesystemSessionStore } from "../../dist/session-store.js";
import { registerActivities } from "../../dist/session-proxy.js";
import { startComputeHost } from "../../dist/compute-host.js";
import { newComputeHandshakeSecret } from "../../dist/compute-handshake.js";
import { readTurnCommitFile } from "../../dist/snapshot-protocol.js";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { createInspectTools } from "../../dist/inspect-tools.js";
import { createArtifactTools } from "../../dist/artifact-tools.js";

// Real manager, common host/control, lifecycle and archive/CAS. Only SDK model
// execution, durable CMS authority and platform supervision are owned fakes.
async function fixture(t, { sessionId = "fixture-session", rootSessionId = sessionId, nativeTasks = false, artifacts = false, runtimeDrift = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ps-native-turn-"));
    let manager, host;
    t.after(async () => {
        try {
            await manager?.dropWarmSession(sessionId);
            await manager?.releaseCompute(sessionId, "shutdown");
        } finally {
            try { await host?.close(); }
            finally { fs.rmSync(root, { recursive: true, force: true }); }
        }
    });
    const cache = path.join(root, "cache"), native = path.join(root, "executor");
    fs.mkdirSync(cache);
    fs.mkdirSync(native);
    const profile = { id: "fixture-v1", sdkVersion: "1.0.13", runtimeVersion: "fixture-runtime",
        roots: [{ name: "session", directory: native, requiredFiles: ["workspace.yaml", "events.jsonl"] }], unsupportedFeatures: [] };
    const secret = newComputeHandshakeSecret();
    const scopes = new Map(), pending = new Set(), completions = new Map(), log = [], configs = [];
    let held = false, bodyCalls = 0, failCompletion = false, failBarrier = false;
    let stop = false, failVerification = false, emitAtBarrier = false, lastOnEvent;
    const authority = {
        async acquire(request) {
            if (scopes.has(request.sessionId)) throw new Error("prior generation requires reconciliation");
            const identity = { ...request, generation: request.attemptId };
            scopes.set(request.sessionId, identity);
            return identity;
        },
        async runCurrent(identity, id, operation) {
            assert.deepEqual(scopes.get(identity.sessionId), identity, "stale authority");
            pending.add(id);
            try { return await operation(); } finally { pending.delete(id); }
        },
        async seal() { assert.equal(pending.size, 0); log.push("seal"); },
        async finish(identity, disposition) {
            assert.equal(pending.size, 0);
            log.push(disposition);
            if (disposition === "released") scopes.delete(identity.sessionId);
        },
        async inspect(id) { return scopes.has(id) ? { identity: scopes.get(id), phase: "unknown", pendingOperations: pending.size } : null; },
        async recordBinding() {},
    };
    host = await startComputeHost({
        bindingId: sessionId, secret, listen: { host: "127.0.0.1", port: 0 }, runtimeAddress: "127.0.0.1:1", idleTimeoutMs: 0,
        services: { directory: path.join(root, "assets") },
        nativeState: {
            sessionId, profile,
            supervisor: {
                prepare: async () => {
                    if (!fs.existsSync(path.join(native, "workspace.yaml"))) fs.writeFileSync(path.join(native, "workspace.yaml"), "fixture");
                    if (!fs.existsSync(path.join(native, "events.jsonl"))) fs.writeFileSync(path.join(native, "events.jsonl"), "");
                    return { runtimeAddress: "127.0.0.1:1", connectionToken: "fixture-runtime-token", runtimeGeneration: "runtime-one" };
                },
                checkpoint: async identity => {
                    if (failBarrier) throw new Error("fixture barrier unverified");
                    if (emitAtBarrier) lastOnEvent?.({ eventType: "tool.execution_start", data: { toolName: "fixture-final-observation" } });
                    held = true; log.push("barrier");
                    return { identity, runtimeGeneration: "runtime-one", barrierId: identity.attemptId, kind: "writer-hold", evidence: { fixture: "trusted-fake-supervisor" } };
                },
                endCheckpoint: async (barrier, _disposition, nextIdentity) => {
                    assert.equal(held, true);
                    assert.deepEqual(scopes.get(sessionId), nextIdentity, "reopen requires the new current admission");
                    assert.notEqual(barrier.identity.attemptId, nextIdentity.attemptId);
                    log.push("reopen"); held = false;
                },
                retire: async () => { held = false; return { runtimeGeneration: "runtime-one", evidence: { fixture: true } }; },
            },
        },
    });
    const target = { id: "fixture-target", name: "shared/fixture", enabled: true, kind: "fixture", config: {}, class: "shared" };
    const row = { sessionId, rootSessionId, model: "fixture:model", isSystem: !nativeTasks, state: "running",
        ...(nativeTasks ? { owner: { provider: "fixture", subject: "synthetic-owner" } } : {}) };
    const events = [];
    const catalog = {
        computeExecution: authority,
        computeTargets: { resolveForSession: async () => target },
        getSession: async () => row,
        getSessionCreationConfig: async () => ({ computeTarget: target.name, computeTargetId: target.id }),
        recordEvents: async (_id, values) => events.push(...values),
        updateSession: async () => {},
        upsertSessionMetricSummary: async () => {},
        getComputeChargeIdentity: async (_id, turnIndex) => ({ ownerUserId: 7, isSystem: true, ledgerTurnIndex: 100 + turnIndex }),
        providers: {
            lookupUserId: async () => 7,
            listProviders: async () => [{ name: "fixture", usableByMe: true }],
            allCredentials: async () => [{ name: "fixture", class: "shared" }],
            checkTurn: async () => ({ exempt: true, providerName: "fixture", modelQualified: "fixture:model" }),
        },
        completeExecutionTurnWriteback: async input => {
            if (input.turn.resultType !== "stopped") assert.ok(fs.existsSync(path.join(root, "archives", `${sessionId}.meta.json`)), "archive CAS precedes completion");
            assert.equal(held, true, "completion occurs under the checkpoint barrier");
            if (failCompletion) throw new Error("fixture completion interrupted");
            if (!completions.has(input.turnKey)) completions.set(input.turnKey, input);
            log.push("complete");
            return false;
        },
        getComputeStoppedOutcome: async (_id, key) => {
            const completed = completions.get(key);
            return completed?.turn.resultType === "stopped" ? completed.turn.stoppedOutcome : null;
        },
    };
    const store = new FilesystemSessionStore(path.join(root, "archives"), cache);
    const registry = new ModelProviderRegistry({ providers: [{
        id: "fixture", type: "openai", wireApi: "completions", baseUrl: "https://model.example.invalid/v1", apiKey: "fixture-worker-key",
        models: ["model"],
    }] });
    manager = new SessionManager(undefined, store, { modelProviders: registry, nativeSubagents: nativeTasks ? "sync" : "off" }, cache);
    manager.setSessionCatalog(catalog);
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
    if (nativeTasks) manager.setFeatureFlagCache({
        resolve: name => ({ enabled: name === "copilot.native_tasks", source: "fixture" }),
        onChange: () => () => {},
    });
    manager.registerComputeProvider({
        kind: "fixture", capabilities: { files: "none", nativeState: {
            protocol: 1, profileId: profile.id, sdkVersion: profile.sdkVersion, runtimeVersion: profile.runtimeVersion,
        } },
        bind: async request => {
            assert.equal(request.sessionId, sessionId);
            return { ok: true, host: { kind: "fixture", id: sessionId, incarnation: "allocation-one" } };
        },
        connect: async () => ({
            ok: true, endpoint: { transport: "uri", address: host.address, connectionToken: "fixture-runtime-token", handshake: { bindingId: sessionId, secret } },
            workspace: {},
        }),
        verifyCheckpoint: async request => {
            assert.equal(request.barrier.evidence.fixture, "trusted-fake-supervisor");
            assert.equal(held, true); log.push("verify");
            return failVerification ? { ok: false, code: "COMPUTE_UNAVAILABLE", message: "trusted verifier refused" } : { ok: true };
        },
        inspectExecution: async () => ({ state: "retired", runtimeGeneration: "runtime-one", evidence: { fixture: true } }),
        retireExecution: async () => ({ state: "retired", runtimeGeneration: "runtime-one", evidence: { fixture: true } }),
    });
    manager.ensureClient = async () => ({
        getStatus: async () => ({ version: runtimeDrift ? "unexpected-runtime" : profile.runtimeVersion, protocolVersion: 3 }),
        createSession: async config => { configs.push(config); return { disconnect: async () => {} }; },
        resumeSession: async (_id, config) => { configs.push(config); return { disconnect: async () => {} }; },
    });
    const getOrCreate = manager.getOrCreate.bind(manager);
    manager.getOrCreate = async (...args) => {
        const managed = await getOrCreate(...args);
        managed.runTurn = async (_prompt, options) => {
            bodyCalls++;
            lastOnEvent = options.onEvent;
            fs.appendFileSync(path.join(native, "events.jsonl"), `{"turn":${bodyCalls}}\n`);
            if (artifacts) {
                const bytes = Buffer.from([0, 255, 13, 10]);
                fs.mkdirSync(path.join(native, "files"), { recursive: true });
                fs.writeFileSync(path.join(native, "files", "source.bin"), bytes);
                let saved;
                const metadata = { filename: "source.bin", sizeBytes: bytes.length, contentType: "application/octet-stream", isBinary: true };
                const tools = createArtifactTools({
                    blobStore: {
                        uploadArtifact: async (_id, _name, body) => { saved = body; return metadata; },
                        downloadArtifact: async () => ({ ...metadata, body: saved }),
                        statArtifact: async () => metadata,
                    },
                    localPathRootsFor: id => manager.computeLocalPathRoots(id),
                    nativeFilesFor: (id, candidate) => manager.nativeArtifactFiles(id, candidate),
                });
                const context = { durableSessionId: sessionId };
                const uploaded = JSON.parse(await tools.find(tool => tool.name === "write_artifact").handler({
                    fromFile: path.join(native, "files", "source.bin"),
                }, context));
                assert.equal(uploaded.success, true);
                assert.deepEqual(saved, bytes);
                const read = tools.find(tool => tool.name === "read_artifact");
                const hint = JSON.parse(await read.handler({ sessionId, filename: metadata.filename }, context));
                assert.match(hint.hint, /Use toFile/);
                const restored = JSON.parse(await read.handler({
                    sessionId, filename: metadata.filename, toFile: path.join(native, "files", "restored.bin"),
                }, context));
                assert.equal(restored.success, true);
                assert.deepEqual(fs.readFileSync(restored.path), bytes);
            }
            if (failVerification) fs.writeFileSync(path.join(native, ".ps-forged"), "must not be read before verification");
            if (stop) return { type: "stopped", reason: "fixture user Stop", events: [] };
            return { type: "completed", content: `native turn ${bodyCalls}`, events: [] };
        };
        return managed;
    };
    const handlers = {};
    registerActivities({ registerActivity: (name, handler) => { handlers[name] = handler; } },
        manager, store, undefined, catalog);
    return {
        manager, store, catalog, root, cache, native, sessionId, configs, log, completions, events, scopes,
        bodyCalls: () => bodyCalls, held: () => held,
        failCompletion: value => { failCompletion = value; }, failBarrier: value => { failBarrier = value; },
        stop: value => { stop = value; }, failVerification: value => { failVerification = value; },
        emitAtBarrier: value => { emitAtBarrier = value; },
        stoppedReplay: () => handlers.runTurnV4({
            traceInfo() {}, traceWarn() {}, isCancelled: () => false,
        }, { sessionId, prompt: "must not run", config: { model: row.model, computeTarget: target.name }, turnIndex: 0,
            carriedSteers: [{ seq: 5, text: "carried" }], snapshot: { expectedVersion: 0, turnKey: "durable-turn" } }),
        turn: (turnIndex = 0, turnKey = "durable-turn") => handlers.runTurn({
            traceInfo() {}, traceWarn() {}, isCancelled: () => false,
        }, { sessionId, prompt: "fixture", config: { model: row.model, computeTarget: target.name }, turnIndex,
            snapshot: { expectedVersion: 0, turnKey } }),
    };
}

test("registered activity executes native prepare/capture/CAS/completion under one verified boundary", { timeout: 30_000 }, async t => {
    const h = await fixture(t);
    const result = await h.turn();
    assert.equal(result.content, "native turn 1");
    assert.equal(result.snapshotVersion, 1);
    assert.equal(h.bodyCalls(), 1);
    assert.equal(h.completions.size, 1);
    assert.deepEqual(h.log, ["seal", "barrier", "verify", "seal", "complete", "committed", "released"]);
    assert.equal(h.held(), true);
    assert.equal(h.scopes.size, 0);
    assert.equal(h.configs[0].createSessionFsProvider, undefined);
    assert.equal(JSON.stringify(h.configs[0]).includes("fixture-worker-key"), false);
});

test("crash after CAS repairs the original winning completion without executing another body or provider admission", { timeout: 30_000 }, async t => {
    const h = await fixture(t);
    h.failCompletion(true);
    await assert.rejects(h.turn(), /completion interrupted/);
    assert.equal((await h.store.probeSnapshot(h.sessionId)).version, 1);
    assert.equal(h.completions.size, 0);
    const saved = readTurnCommitFile(path.join(h.cache, h.sessionId));
    assert.equal(saved.writeback.providerCharge.ledgerTurnIndex, 100);
    h.catalog.providers.checkTurn = async () => assert.fail("committed recovery must not re-admit a provider");
    h.catalog.getComputeChargeIdentity = async () => assert.fail("committed recovery must not select today's charge identity");
    h.failCompletion(false);
    const result = await h.turn();
    assert.equal(result.content, "native turn 1");
    assert.equal(h.bodyCalls(), 1);
    assert.equal(h.completions.size, 1);
    assert.equal(h.completions.get("durable-turn").providerCharge.ownerUserId, 7);
    assert.equal(h.scopes.size, 1, "unknown prior scope is not silently released by result recovery");
});

test("an unverified native barrier cannot become a successful checkpoint or authorize a replacement", { timeout: 30_000 }, async t => {
    const h = await fixture(t);
    h.failBarrier(true);
    await assert.rejects(h.turn(), /barrier unverified/);
    assert.equal((await h.store.probeSnapshot(h.sessionId)).exists, false);
    assert.equal(h.completions.size, 0);
    assert.equal(h.scopes.size, 1);
    await assert.rejects(h.turn(0, "replacement"), /prior generation requires reconciliation/);
    assert.equal(h.bodyCalls(), 1);
});

test("sequential native turns retain the environment but refresh attempt-scoped SDK handles", { timeout: 30_000 }, async t => {
    const h = await fixture(t);
    await h.turn();
    const second = await h.turn(1, "next-turn");
    assert.equal(second.snapshotVersion, 2);
    assert.equal(h.bodyCalls(), 2);
    assert.equal(h.completions.size, 2);
    assert.notEqual(h.configs[0], h.configs[1]);
    assert.equal(h.scopes.size, 0);
    assert.equal(h.held(), true);
    assert.equal(h.log.filter(value => value === "reopen").length, 1, "the hold is reopened only during the next admitted preparation");
});

test("trusted barrier refusal happens before export and cannot publish host-provided state", async t => {
    const h = await fixture(t);
    h.failVerification(true);
    await assert.rejects(h.turn(), /trusted verifier refused/);
    assert.equal((await h.store.probeSnapshot(h.sessionId)).exists, false);
    assert.equal(h.completions.size, 0);
    assert.equal(h.held(), true);
});

test("final observations during the held native barrier are included in the original completion receipt", async t => {
    const h = await fixture(t);
    h.emitAtBarrier(true);
    await h.turn();
    const receipt = h.completions.get("durable-turn");
    assert.equal(receipt.turn.toolCalls, 1);
    assert.deepEqual(receipt.turn.toolNames, ["fixture-final-observation"]);
});

test("stopped native memory is discarded and replay closes controls using the original outcome without executing again", async t => {
    const h = await fixture(t);
    h.stop(true);
    const first = await h.turn();
    assert.equal(first.type, "stopped");
    assert.equal(first.snapshotVersion, 0);
    assert.equal((await h.store.probeSnapshot(h.sessionId)).exists, false);
    assert.equal(h.scopes.size, 0);
    h.catalog.providers.checkTurn = async () => assert.fail("Stop recovery must not re-admit a provider");
    h.catalog.getComputeChargeIdentity = async () => assert.fail("Stop recovery must retain the original charge");
    const closed = [];
    h.catalog.turnEnd = async (...args) => {
        closed.push(args);
        return { stopped: true, late: [], replaced: [] };
    };
    const recovered = await h.stoppedReplay();
    assert.equal(recovered.reason, first.reason);
    assert.equal(recovered.snapshotVersion, first.snapshotVersion);
    assert.equal(recovered.carriedSteersConsumed, true);
    assert.deepEqual(closed, [[h.sessionId, 0, 0, "stopped", [5]]]);
    assert.equal(h.bodyCalls(), 1);
    assert.equal(h.completions.size, 1);
});

test("native compute never exposes same-process SDK subtasks as isolated delegated sessions", async t => {
    const h = await fixture(t, { nativeTasks: true });
    await h.turn();
    assert.ok(h.configs[0].excludedTools.includes("task"));
    assert.equal(h.events.some(event => event.eventType === "session.compute_capability_unavailable"), true);
});

test("management and tuner diagnostics expose the same durable unknown authority without granting takeover", async () => {
    const status = { identity: { sessionId: "session", transcriptEpoch: 0, turnKey: "turn", generation: "held",
        attemptId: "attempt", workerNodeId: "fixture" }, phase: "unknown", pendingOperations: 2, detail: "owned unresolved work" };
    const requests = [];
    const catalog = {
        getSession: async () => ({ sessionId: "session", isSystem: false }),
        computeExecution: { inspect: async () => status, requestReconciliation: async id => requests.push(id) },
    };
    const management = Object.assign(Object.create(PilotSwarmManagementClient.prototype), {
        _catalog: catalog, _ensureStarted() {},
    });

    test("actual artifact tools transfer native binaries without worker-local file access", async t => {
        const h = await fixture(t, { artifacts: true });
        await h.turn();
        assert.equal(h.bodyCalls(), 1);
        assert.equal(h.completions.size, 1);
    });

    test("actual connected-runtime version drift is refused before SDK session creation or model work", async t => {
        const h = await fixture(t, { runtimeDrift: true });
        await assert.rejects(h.turn(), /runtime version/i);
        assert.equal(h.configs.length, 0);
        assert.equal(h.bodyCalls(), 0);
        assert.equal(h.completions.size, 0);
        assert.equal((await h.store.probeSnapshot(h.sessionId)).exists, false);
    });
    assert.deepEqual(await management.getSessionComputeExecution("session"), status);
    await management.reconcileSessionComputeExecution("session");
    assert.deepEqual(requests, ["session"]);
    assert.equal(status.phase, "unknown");
    const options = { catalog, agentIdentity: "agent-tuner",
        resolveViewer: () => ({ provider: "", subject: "", isAdmin: false, isSystemPrincipal: true }) };
    const tool = createInspectTools(options).find(entry => entry.name === "read_session_compute_execution");
    assert.ok(tool);
    assert.deepEqual(await tool.handler({ session_id: "session" }, {}), { sessionId: "session", execution: status });
    assert.equal(createInspectTools({ ...options, agentIdentity: "ordinary" }).some(entry => entry.name === tool.name), false);
});
