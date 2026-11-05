// This fixture runs outside the SDK directory and uses public package exports only.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
    ComputeNativeStateClient, ComputeExecutionAttempt, FilesystemSessionStore,
    startComputeHost, newComputeHandshakeSecret, stageNativeCapture, readNativeStaging,
} from "pilotswarm-sdk";

const root = process.cwd();
const stateDirectory = path.join(root, "executor", "session");
await fs.mkdir(stateDirectory, { recursive: true });
const profile = {
    id: "public-fixture-v1", sdkVersion: "fixture-sdk", runtimeVersion: "fixture-runtime",
    roots: [{ name: "session", directory: stateDirectory, requiredFiles: ["workspace.yaml", "events.jsonl"] }],
    unsupportedFeatures: ["real runtime supervision is not qualified by this fixture"],
};
const identity = {
    sessionId: "session", transcriptEpoch: 0, turnKey: "one", attemptId: "attempt-one",
    workerNodeId: "fixture-worker", generation: "fixture-generation",
};
let held = false, verified = false;
let runtimeGeneration = 0;
const secret = newComputeHandshakeSecret();
const serving = await startComputeHost({
    bindingId: "fixture-host", secret, runtimeAddress: "127.0.0.1:1",
    listen: { host: "127.0.0.1", port: 0 }, idleTimeoutMs: 0,
    services: { directory: path.join(root, "assets-next") },
    nativeState: {
        sessionId: identity.sessionId, profile,
        supervisor: {
            prepare: async () => {
                runtimeGeneration++;
                await fs.writeFile(path.join(stateDirectory, "workspace.yaml"), "fixture");
                await fs.writeFile(path.join(stateDirectory, "events.jsonl"), '{"fixture":1}\n');
                return { runtimeAddress: "127.0.0.1:1", connectionToken: "fixture-token", runtimeGeneration: `runtime-${runtimeGeneration}` };
            },
            checkpoint: async current => {
                held = true;
                return { identity: current, runtimeGeneration: `runtime-${runtimeGeneration}`, barrierId: "barrier-one",
                    kind: "writer-hold", evidence: { fixture: "fake-scope-one" } };
            },
            endCheckpoint: async () => { assert.equal(verified, true); held = false; },
            retire: async () => { held = false; return { runtimeGeneration: `runtime-${runtimeGeneration}`, evidence: { fixture: "fake-scope-one" } }; },
        },
    },
});
let client;
try {
    client = await ComputeNativeStateClient.connect({
        transport: "uri", address: serving.address, connectionToken: "fixture-token",
        handshake: { bindingId: "fixture-host", secret },
    }, AbortSignal.timeout(5_000));
    assert.equal((await client.describe()).profile.id, profile.id);
    await client.prepare(identity);
    const pending = new Set();
    const authority = {
        async runCurrent(current, id, operation) {
            assert.equal(current.generation, identity.generation);
            pending.add(id);
            try { return await operation(); } finally { pending.delete(id); }
        },
        seal: async () => assert.equal(pending.size, 0),
        finish: async () => assert.equal(pending.size, 0),
    };
    const attempt = new ComputeExecutionAttempt(identity, authority);
    await attempt.callback(async () => {});
    await attempt.drain();
    const barrier = await attempt.lifecycle(() => client.beginCheckpoint(identity));
    assert.equal(held, true);
    assert.equal(barrier.evidence.fixture, "fake-scope-one");
    verified = true; // Explicit fixture verifier, not a production containment assertion.
    const capture = await attempt.lifecycle(() => client.exportState(identity, barrier.barrierId));
    const cache = path.join(root, "worker-state");
    await fs.mkdir(cache);
    await stageNativeCapture(path.join(cache, "session"), capture.state, { sessionId: "session", profile });
    const store = new FilesystemSessionStore(path.join(root, "archives"), cache);
    const committed = await attempt.lifecycle(() => store.commitSnapshot("session", { baseVersion: 0, turnKey: identity.turnKey }));
    assert.equal(committed.version, 1);
    await attempt.finish("committed");
    await client.endCheckpoint(identity, capture.barrier.barrierId, "committed");
    assert.equal(held, true, "committed state remains parked until another admission or retirement");
    await fs.rm(path.join(cache, "session"), { recursive: true });
    await store.hydrateSnapshot("session");
    assert.deepEqual(await readNativeStaging(path.join(cache, "session"), { sessionId: "session", profile }), capture.state);
    await assert.rejects(client.retire({ ...identity, attemptId: "stale" }), /not current/);
    assert.equal((await client.retire(identity)).runtimeGeneration, "runtime-1");
    await fs.writeFile(path.join(stateDirectory, "stale.txt"), "not part of accepted state");
    const restoredState = await readNativeStaging(path.join(cache, "session"), { sessionId: "session", profile });
    const replacement = { ...identity, turnKey: "two", attemptId: "attempt-two", generation: "next-generation" };
    assert.equal((await client.prepare(replacement, restoredState)).runtimeGeneration, "runtime-2");
    await assert.rejects(fs.stat(path.join(stateDirectory, "stale.txt")), { code: "ENOENT" });
    const nextBarrier = await client.beginCheckpoint(replacement);
    assert.equal(nextBarrier.evidence.fixture, "fake-scope-one");
    assert.deepEqual((await client.exportState(replacement, nextBarrier.barrierId)).state, restoredState);
    await client.endCheckpoint(replacement, "barrier-one", "committed");
    console.log("public consumer: native prepare/capture/CAS/cold restore passed; fake supervision/authority only");
} finally {
    client?.close();
    await serving.close();
}
