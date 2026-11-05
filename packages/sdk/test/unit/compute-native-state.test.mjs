import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { DatabaseSync, backup } from "node:sqlite";
import { ComputeNativeStateHost, validateNativeState, stageNativeCapture, readNativeStaging, assertNativeAttachmentsSeparate } from "../../dist/compute-native-state.js";
import { ComputeExecutionAttempt } from "../../dist/compute-execution.js";
import { startComputeHost } from "../../dist/compute-host.js";

const identity = (id = "session", turn = "turn") => ({
    sessionId: id, transcriptEpoch: 0, turnKey: turn, attemptId: `attempt-${turn}`, workerNodeId: "fixture", generation: "one",
});
// Local fake-supervisor component tests. Trusted verification order is exercised
// separately through SessionManager and the public loopback consumer.
async function captureFixture(host, current = identity()) {
    const barrier = await host.beginCheckpoint(current);
    return host.exportState(current, barrier.barrierId);
}

async function fixture(t, { aliasDirectory = directory => directory } = {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ps-native-"));
    const cleanup = [];
    t.after(async () => { for (const dispose of cleanup) await dispose(); await fs.rm(root, { recursive: true, force: true }); });
    const home = path.join(root, "native-session");
    await fs.mkdir(home);
    let held = false, ended = 0;
    const options = {
        sessionId: "session",
        profile: { id: "fixture-v1", sdkVersion: "fixture-sdk", runtimeVersion: "fixture-runtime",
            roots: [{ name: "session", directory: aliasDirectory(home), requiredFiles: ["workspace.yaml"] }], unsupportedFeatures: [] },
        supervisor: {
            prepare: async () => {
                await fs.writeFile(path.join(home, "workspace.yaml"), "fixture");
                await fs.mkdir(path.join(home, "files", "empty"), { recursive: true });
                await fs.writeFile(path.join(home, "files", "binary"), Buffer.from([0, 255, 13, 10]));
                return { runtimeAddress: "127.0.0.1:1", connectionToken: "fixture-token", runtimeGeneration: "one" };
            },
            checkpoint: async current => {
                held = true;
                return { identity: current, runtimeGeneration: "one", barrierId: "held", kind: "writer-hold", evidence: { fixture: true } };
            },
            endCheckpoint: async () => { held = false; ended++; },
            retire: async () => { held = false; return { runtimeGeneration: "one", evidence: { fixture: true } }; },
        },
    };
    const host = new ComputeNativeStateHost(options);
    await host.prepare(identity());
    return { root, home, host, options, cleanup, held: () => held, ended: () => ended };
}

test("native checkpoint holds its verified supervisor boundary through export and worker CAS staging", async t => {
    const h = await fixture(t);
    const capture = await captureFixture(h.host);
    assert.equal(h.held(), true);
    const directory = path.join(h.root, "worker");
    await stageNativeCapture(directory, capture.state, h.options);
    assert.deepEqual(await readNativeStaging(directory, h.options), capture.state);
    assert.deepEqual(await fs.readFile(path.join(directory, "files", "binary")), Buffer.from([0, 255, 13, 10]));
    assert.equal(h.held(), true, "staging must not release the runtime barrier");
    await assert.rejects(h.host.prepare(identity()), /already owned/);
    await h.host.endCheckpoint(identity(), capture.barrier.barrierId, "committed");
    await h.host.endCheckpoint(identity(), capture.barrier.barrierId, "committed");
    await assert.rejects(h.host.endCheckpoint(identity(), capture.barrier.barrierId, "discarded"), /cannot change/);
    assert.equal(h.held(), true, "accepted native writers stay parked between admissions");
    assert.equal(h.ended(), 0);
    await h.host.prepare(identity("session", "next"), capture.state);
    assert.equal(h.held(), false, "only next admission may reopen the accepted writer hold");
    assert.equal(h.ended(), 1);
});

test("native state rejects corrupt/missing/duplicate/reserved and case-colliding entries", async t => {
    const h = await fixture(t);
    const { state } = await captureFixture(h.host);
    for (const change of [
        copy => { copy.roots.session.files[0].sha256 = "0".repeat(64); },
        copy => { copy.roots.session.files = []; },
        copy => { copy.roots.session.files[0].path = "../escape"; },
        copy => { copy.roots.session.files[0].path = ".ps-turn-commit.json"; },
        copy => { copy.roots.session.files[0].path = ".PS-turn-commit.json"; },
        copy => { copy.roots.session.files.push({ ...copy.roots.session.files[0], path: copy.roots.session.files[0].path.toUpperCase() }); },
    ]) {
        const copy = structuredClone(state);
        change(copy);
        assert.throws(() => validateNativeState(copy, h.options));
    }
    await assert.rejects(h.host.endCheckpoint(identity("other"), "held", "committed"), /not current/);
    assert.equal(h.held(), true);
});

test("a failed native capture leaves the barrier held and the accepted worker tree unchanged", async t => {
    const h = await fixture(t);
    const directory = path.join(h.root, "accepted");
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "accepted"), "before");
    await fs.writeFile(path.join(h.home, ".ps-forged"), "not authority");
    await assert.rejects(captureFixture(h.host), /reserved/);
    assert.equal(h.held(), true);
    assert.equal(await fs.readFile(path.join(directory, "accepted"), "utf8"), "before");
    await assert.rejects(h.host.prepare(identity("session", "next")), /already owned/);
});

test("native capture refuses hardlinked data and independently attached repos stay outside state", async t => {
    const h = await fixture(t);
    const repo = path.join(h.root, "repo");
    await fs.mkdir(repo);
    await fs.writeFile(path.join(repo, "dirty"), "partial independent edit");
    await fs.link(path.join(h.home, "files", "binary"), path.join(h.home, "linked"));
    await assert.rejects(captureFixture(h.host), /links/);
    assert.equal(await fs.readFile(path.join(repo, "dirty"), "utf8"), "partial independent edit");
});

test("real SQLite WAL backup restores committed logical rows and integrity, not WAL filenames", async t => {
    const h = await fixture(t);
    const source = new DatabaseSync(path.join(h.root, "live.db"));
    h.cleanup.push(() => source.close());
    source.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE durable_fixture(id INTEGER PRIMARY KEY, payload BLOB)");
    source.prepare("INSERT INTO durable_fixture VALUES(?,?)").run(1, Buffer.from([0, 255, 10]));
    assert.ok((await fs.stat(path.join(h.root, "live.db-wal"))).size > 0);
    h.options.profile.roots[0].requiredFiles.push("session.db");
    h.options.profile.roots[0].databases = ["session.db"];
    const checkpoint = h.options.supervisor.checkpoint;
    h.options.supervisor.checkpoint = async current => {
        const barrier = await checkpoint(current);
        await backup(source, path.join(h.home, "session.db"));
        return barrier;
    };
    const capture = await captureFixture(h.host);
    const directory = path.join(h.root, "restored");
    await stageNativeCapture(directory, capture.state, h.options);
    const restored = new DatabaseSync(path.join(directory, "session.db"), { readOnly: true });
    try {
        assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
        assert.deepEqual(Buffer.from(restored.prepare("SELECT payload FROM durable_fixture WHERE id=1").get().payload), Buffer.from([0, 255, 10]));
    } finally { restored.close(); }
});

test("attempt drains all admitted effects, rejects late callbacks and retains failed authority", async () => {
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    const log = [];
    const authority = {
        runCurrent: async (_id, _op, action) => action(),
        seal: async () => log.push("sealed"),
        finish: async (_id, disposition) => log.push(disposition),
    };
    const attempt = new ComputeExecutionAttempt(identity(), authority);
    const effect = attempt.callback(async () => { entered.resolve(); await resume.promise; });
    await entered.promise;
    let drained = false;
    const drain = attempt.drain().then(() => { drained = true; });
    await assert.rejects(attempt.callback(async () => {}), /boundary/);
    assert.equal(drained, false);
    resume.resolve();
    await Promise.all([effect, drain]);
    assert.deepEqual(log, ["sealed"]);
    await attempt.finish("committed");
    await assert.rejects(attempt.current(async () => {}), /no longer current/);
});

test("nested admitted work remains pinned after admission closes, including unawaited work", async () => {
    const entered = Promise.withResolvers(), proceed = Promise.withResolvers(), nested = Promise.withResolvers();
    const log = [];
    const authority = {
        runCurrent: async (_id, _op, action) => { log.push("begin"); try { return await action(); } finally { log.push("end"); } },
        seal: async () => log.push("sealed"),
    };
    const attempt = new ComputeExecutionAttempt(identity(), authority);
    const outer = attempt.callback(async () => {
        entered.resolve(); await proceed.promise;
        void attempt.current(async () => { await nested.promise; log.push("nested"); });
    });
    await entered.promise;
    const drain = attempt.drain();
    proceed.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(log, ["begin"], "returning from the outer handler cannot unpin nested work");
    nested.resolve();
    await Promise.all([outer, drain]);
    assert.deepEqual(log, ["begin", "nested", "end", "sealed"]);
});

test("detached continuations cannot reuse expired admission and nested failure prevents a successful drain", async () => {
    const later = Promise.withResolvers();
    const authority = { runCurrent: async (_id, _op, action) => action(), seal: async () => assert.fail("failed work must not seal") };
    const attempt = new ComputeExecutionAttempt(identity(), authority);
    let detached;
    await attempt.current(async () => {
        detached = later.promise.then(() => attempt.current(async () => assert.fail("expired admission")));
    });
    later.resolve();
    await assert.rejects(detached, /detached continuation/);
    await assert.rejects(attempt.callback(async () => {
        await attempt.current(async () => { throw new Error("nested mutation failed"); }).catch(() => {});
    }), /nested mutation failed/);
    await assert.rejects(attempt.drain(), /drain failed/);
});

test("streamed model work stays admitted until its response body is consumed or cancelled", async () => {
    for (const cancel of [false, true]) {
        const log = [];
        const attempt = new ComputeExecutionAttempt(identity(), {
            runCurrent: async (_id, _op, action) => { try { return await action(); } finally { log.push("settled"); } },
            seal: async () => log.push("sealed"),
        });
        const response = await attempt.forward(async () => new Response(new ReadableStream({
            start(controller) { controller.enqueue(new Uint8Array([1, 2])); controller.close(); },
        })));
        const drain = attempt.drain();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(log, [], "response headers are not the end of admitted model work");
        if (cancel) await response.body.cancel(); else assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2]);
        await drain;
        assert.deepEqual(log, ["settled", "sealed"]);
    }
});

test("common host drains an admitted artifact write before starting the native writer barrier", async t => {
    const h = await fixture(t);
    const entered = Promise.withResolvers(), resume = Promise.withResolvers();
    const original = fs.open;
    t.mock.method(fs, "open", async (...args) => {
        const handle = await original(...args);
        if (typeof args[1] === "number" && (args[1] & constants.O_WRONLY)) {
            const write = handle.writeFile.bind(handle);
            t.mock.method(handle, "writeFile", async (...values) => { entered.resolve(); await resume.promise; return write(...values); });
        }
        return handle;
    });
    const body = Buffer.from("after"), hash = createHash("sha256").update(body).digest("hex");
    const write = h.host.writeArtifact(identity(), "paused", body.toString("base64"), hash);
    await entered.promise;
    const barrier = h.host.beginCheckpoint(identity());
    await assert.rejects(h.host.writeArtifact(identity(), "late", body.toString("base64"), hash), /closed/);
    assert.equal(h.held(), false);
    resume.resolve();
    await write;
    const captured = await h.host.exportState(identity(), (await barrier).barrierId);
    assert.equal(captured.state.roots.session.files.find(file => file.path === "files/paused").data, body.toString("base64"));
});

test("failed artifact mutation and capture-less commit cannot masquerade as a successful checkpoint", async t => {
    const h = await fixture(t);
    const original = fs.open;
    t.mock.method(fs, "open", async (...args) => {
        if (typeof args[1] === "number" && (args[1] & constants.O_WRONLY)) throw new Error("owned mutation failure");
        return original(...args);
    });
    const body = Buffer.from("data");
    await assert.rejects(h.host.writeArtifact(identity(), "failed", body.toString("base64"), createHash("sha256").update(body).digest("hex")), /mutation failure/);
    await assert.rejects(h.host.beginCheckpoint(identity()), /mutation failed/);
    assert.equal(h.held(), false);
    const fresh = await fixture(t);
    const barrier = await fresh.host.beginCheckpoint(identity());
    await assert.rejects(fresh.host.endCheckpoint(identity(), barrier.barrierId, "committed"), /complete capture/);
    assert.equal(fresh.held(), true);
});

test("native artifact access is identity-bound, bounded, and closed during capture", async t => {
    const h = await fixture(t);
    const body = Buffer.from([1, 0, 255]), hash = createHash("sha256").update(body).digest("hex");
    await h.host.writeArtifact(identity(), "nested/result.bin", body.toString("base64"), hash);
    assert.deepEqual(Buffer.from((await h.host.readArtifact(identity(), "nested/result.bin")).data, "base64"), body);
    await assert.rejects(h.host.readArtifact(identity(), "../workspace.yaml"), /reserved/);
    await assert.rejects(h.host.readArtifact(identity("other"), "nested/result.bin"), /not current/);
    await fs.link(path.join(h.home, "files", "binary"), path.join(h.home, "files", "hardlink"));
    await assert.rejects(h.host.readArtifact(identity(), "hardlink"), /unlinked file/);
    await fs.unlink(path.join(h.home, "files", "hardlink"));
    await h.host.beginCheckpoint(identity());
    await assert.rejects(h.host.readArtifact(identity(), "nested/result.bin"), /closed/);
    await assert.rejects(h.host.writeArtifact(identity(), "late", body.toString("base64"), hash), /closed/);
});

test("Windows spelling aliases preserve native artifact access without relaxing file identity", { skip: process.platform !== "win32" }, async t => {
    const h = await fixture(t, { aliasDirectory: directory => directory.toUpperCase() });
    const configured = path.join(h.options.profile.roots[0].directory, "files");
    assert.notEqual(await fs.realpath(configured), configured, "The fixture must exercise a real canonical spelling difference");
    const body = Buffer.from([0, 255, 13, 10]), hash = createHash("sha256").update(body).digest("hex");
    await h.host.writeArtifact(identity(), "alias.bin", body.toString("base64"), hash);
    assert.deepEqual(Buffer.from((await h.host.readArtifact(identity(), "alias.bin")).data, "base64"), body);
    await fs.link(path.join(h.home, "files", "alias.bin"), path.join(h.home, "files", "second-link"));
    await assert.rejects(h.host.readArtifact(identity(), "alias.bin"), /unlinked file|changed or escaped/);
});

test("native artifact roots cannot escape through a linked session ancestor", async t => {
    const h = await fixture(t);
    const linked = path.join(h.root, "linked-session");
    await fs.symlink(h.home, linked, process.platform === "win32" ? "junction" : "dir");
    h.options.profile.roots[0].directory = linked;
    await assert.rejects(h.host.readArtifact(identity(), "binary"), /link|changed or escaped/);
    const body = Buffer.from("not allowed"), hash = createHash("sha256").update(body).digest("hex");
    await assert.rejects(h.host.writeArtifact(identity(), "rejected", body.toString("base64"), hash), /link|changed or escaped/);
    await assert.rejects(fs.stat(path.join(h.home, "files", "rejected")), { code: "ENOENT" });
});

test("native artifact descriptors cannot be substituted between open and validation", async t => {
    for (const writing of [false, true]) await t.test(writing ? "write" : "read", async st => {
        const h = await fixture(st);
        const file = path.join(h.home, "files", "binary");
        const before = await fs.readFile(file);
        const original = fs.open;
        st.mock.method(fs, "open", async (...args) => {
            const handle = await original(...args);
            if (args[0] === file) {
                await fs.rename(file, file + ".previous");
                await fs.writeFile(file, "replacement");
            }
            return handle;
        });
        const body = Buffer.from("must not write");
        await assert.rejects(writing
            ? h.host.writeArtifact(identity(), "binary", body.toString("base64"), createHash("sha256").update(body).digest("hex"))
            : h.host.readArtifact(identity(), "binary"), /changed or escaped/);
        assert.deepEqual(await fs.readFile(file + ".previous"), before);
        assert.equal(await fs.readFile(file, "utf8"), "replacement");
    });
});

test("manifest limits are enforced at exact byte and entry thresholds", async t => {
    const h = await fixture(t);
    const { state } = await captureFixture(h.host);
    const tree = state.roots.session;
    const bytes = tree.files.reduce((sum, file) => sum + file.size, 0);
    const entries = tree.files.length + tree.directories.length;
    validateNativeState(state, { ...h.options, maxBytes: bytes, maxEntries: entries });
    assert.throws(() => validateNativeState(state, { ...h.options, maxBytes: bytes - 1 }), /budget/);
    assert.throws(() => validateNativeState(state, { ...h.options, maxEntries: entries - 1 }), /budget/);
});

test("fresh preparation refuses stale roots and retired cold restore replaces native files without touching attachments", async t => {
    const h = await fixture(t);
    const capture = await captureFixture(h.host);
    await h.host.endCheckpoint(identity(), "held", "committed");
    await h.host.retire(identity());
    const independent = path.join(h.root, "repo");
    await fs.mkdir(independent);
    await fs.writeFile(path.join(independent, "dirty"), "keep");
    await fs.writeFile(path.join(h.home, "stale"), "discard");
    await h.host.prepare(identity("session", "next"), capture.state);
    await assert.rejects(fs.stat(path.join(h.home, "stale")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(independent, "dirty"), "utf8"), "keep");
    const fresh = new ComputeNativeStateHost(h.options);
    await assert.rejects(fresh.prepare(identity()), error => error.errors?.some(cause => /empty declared/.test(cause.message)));
    assert.throws(() => assertNativeAttachmentsSeparate(h.options.profile, [h.home]), /overlap/);
    assert.throws(() => assertNativeAttachmentsSeparate(h.options.profile, [path.join(h.home, "files")]), /overlap/);
    assertNativeAttachmentsSeparate(h.options.profile, [independent]);
});

test("a corrupt declared SQLite database cannot replace accepted worker staging", async t => {
    const h = await fixture(t);
    await fs.writeFile(path.join(h.home, "corrupt.db"), "not a database");
    h.options.profile.roots[0].databases = ["corrupt.db"];
    const capture = await captureFixture(h.host);
    const previous = path.join(h.root, "accepted");
    await fs.mkdir(previous);
    await fs.writeFile(path.join(previous, "marker"), "accepted");
    await assert.rejects(stageNativeCapture(previous, capture.state, h.options), /database|SQLite/);
    assert.equal(await fs.readFile(path.join(previous, "marker"), "utf8"), "accepted");
});

test("host transport/skill services cannot be placed inside native checkpoint roots", async t => {
    const h = await fixture(t);
    await assert.rejects(startComputeHost({
        bindingId: "fixture", secret: "f".repeat(64), listen: { host: "127.0.0.1", port: 0 },
        nativeState: h.options, services: { directory: path.join(h.home, "service-assets") },
    }), /overlap/);
});

test("native restore requires trusted profile/version evidence rather than silently importing a legacy directory", async t => {
    const h = await fixture(t);
    const capture = await captureFixture(h.host);
    const staging = path.join(h.root, "worker");
    await stageNativeCapture(staging, capture.state, h.options);
    const evidence = JSON.parse(await fs.readFile(path.join(staging, ".ps-native-state.json"), "utf8"));
    assert.equal(evidence.locations.session, h.home);
    await assert.rejects(readNativeStaging(staging, { ...h.options,
        profile: { ...h.options.profile, runtimeVersion: "different-runtime" } }), /incompatible/);
    await fs.unlink(path.join(staging, ".ps-native-state.json"));
    await assert.rejects(readNativeStaging(staging, h.options), /evidence is missing/);
});

test("selected global files beside the session tree preserve unselected home contents and remove absent optional sidecars", async t => {
    const scratch = await fixture(t);
    const home = path.join(scratch.root, "complete-home"), session = path.join(home, "session-state", "session");
    const global = { name: "global", directory: home, requiredFiles: ["store.db"],
        includeFiles: ["store.db", "store.db-wal", "store.db-shm"] };
    const options = { ...scratch.options, profile: { ...scratch.options.profile, roots: [
        { name: "session", directory: session, requiredFiles: ["workspace.yaml"] }, global,
    ] }, supervisor: { ...scratch.options.supervisor, prepare: async () => {
        for (const [file, value] of [[path.join(session, "workspace.yaml"), "session-before"],
            [path.join(home, "store.db"), "global-before"], [path.join(home, "store.db-wal"), "wal-before"]]) {
            try { await fs.writeFile(file, value, { flag: "wx" }); }
            catch (error) { if (error.code !== "EEXIST") throw error; }
        }
        return { runtimeAddress: "127.0.0.1:1", connectionToken: "fixture", runtimeGeneration: "one" };
    } } };
    const host = new ComputeNativeStateHost(options);
    await host.prepare(identity());
    const assets = path.join(home, "unselected-assets");
    await fs.mkdir(assets); await fs.writeFile(path.join(assets, "sentinel"), "leave untouched");
    assertNativeAttachmentsSeparate(options.profile, [assets]);
    const captured = await captureFixture(host);
    assert.deepEqual(captured.state.roots.global.files.map(file => file.path).sort(), ["store.db", "store.db-wal"]);
    const worker = path.join(scratch.root, "worker-selected");
    await stageNativeCapture(worker, captured.state, options);
    assert.deepEqual(await readNativeStaging(worker, options), captured.state);
    await host.endCheckpoint(identity(), "held", "committed");
    await host.retire(identity());
    await fs.writeFile(path.join(home, "store.db"), "unaccepted");
    await fs.writeFile(path.join(home, "store.db-shm"), "stale sidecar");
    await host.prepare(identity("session", "next"), captured.state);
    assert.equal(await fs.readFile(path.join(session, "workspace.yaml"), "utf8"), "session-before");
    assert.equal(await fs.readFile(path.join(home, "store.db"), "utf8"), "global-before");
    await assert.rejects(fs.stat(path.join(home, "store.db-shm")), { code: "ENOENT" });
    assert.equal(await fs.readFile(path.join(assets, "sentinel"), "utf8"), "leave untouched");
    assert.throws(() => new ComputeNativeStateHost({ ...options, profile: { ...options.profile, roots: [
        options.profile.roots[0], { ...global, requiredFiles: [], includeFiles: ["session-state/session/workspace.yaml"] },
    ] } }), /overlap/);
    const poisoned = structuredClone(captured.state);
    poisoned.roots.global.files[0].path = "unselected-assets/sentinel";
    assert.throws(() => validateNativeState(poisoned, options), /selected-file/);
});
