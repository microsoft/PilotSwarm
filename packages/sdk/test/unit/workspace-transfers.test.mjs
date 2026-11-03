import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { WorkspaceTransferCoordinator, acquireWorkspaceTransferCoordinator } from "../../dist/workspace-transfers.js";
import { runWorkspaceTransferProcess } from "../../dist/workspace-transfer-process.js";
import { WORKSPACE_UPLOAD_SCRIPT } from "../../dist/workspace-upload-process.js";
import { WORKSPACE_FILE_ERROR_CODES } from "../../dist/workspace-files.js";
import { watch } from "node:fs";

async function fixture(fn, { partBytes = 16384, maxBytes = 20971520, targetParent = os.tmpdir() } = {}) {
    const root = await fs.mkdtemp(path.join(targetParent, "ps-upload-test-"));
    const spool = await fs.mkdtemp(path.join(os.tmpdir(), "ps-spool-test-"));
    await fs.writeFile(path.join(root, ".pilotswarm-export"), "");
    const c = new WorkspaceTransferCoordinator({ roots: [{ name: "test", path: root }], uploadPartBytes: partBytes, maxBytes, transferDir: spool });
    const context = { sessionId: "test", principal: "owner", folder: "working", root: "test", base: root, rootPath: root };
    try { await fn(c, context, root, spool); }
    finally { await c.stop(); await fs.rm(root, { recursive: true }); await fs.rm(spool, { recursive: true }); }
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("busy data lanes do not leak an admitted start's storage reservation", async () => fixture(async (c, ctx) => {
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    const lanes = [c.runData(() => pending), c.runData(() => pending)];
    try {
        await assert.rejects(c.start(ctx, { folder: "working", path: "busy.bin", size: 0 }), { code: "WORKSPACE_FILES_UPLOAD_BUSY" });
        assert.equal(c.claims.size, 0);
    } finally { finish(); await Promise.all(lanes); }
}));

test("changed private spool identity retains capacity and leaves replacement files untouched", async () => fixture(async (c, ctx) => {
    const started = await c.start(ctx, { folder: "working", path: "target.bin", size: 0 });
    const t = c.records.get(started.uploadId), displaced = t.spool + "-displaced";
    await fs.rename(t.spool, displaced);
    await fs.mkdir(t.spool);
    await fs.writeFile(path.join(t.spool, "unrelated"), "keep");
    try {
        await assert.rejects(c.abort(ctx, started.uploadId), { code: "WORKSPACE_FILES_UPLOAD_CLEANUP" });
        assert.equal(await fs.readFile(path.join(t.spool, "unrelated"), "utf8"), "keep");
        assert.equal(c.claims.size, 1);
    } finally {
        await fs.unlink(path.join(t.spool, "unrelated"));
        await fs.rmdir(t.spool);
        await fs.rename(displaced, t.spool);
    }
    await c.abort(ctx, started.uploadId);
    assert.equal(c.claims.size, 0);
}));

test("shutdown cannot discard an external snapshot claim or reopen its admission pool", async () => {
    const config = { roots: [], transferDir: path.join(os.tmpdir(), "ps-shutdown-claim-test") };
    const lease = acquireWorkspaceTransferCoordinator(config);
    const claim = await lease.coordinator.reserve({ bytes: 4096, principal: '["provider","subject"]', root: "root" });
    await assert.rejects(lease.release(), { code: "WORKSPACE_FILES_UPLOAD_CLEANUP" });
    assert.throws(() => acquireWorkspaceTransferCoordinator(config), { code: "WORKSPACE_FILES_UPLOAD_BUSY" });
    await claim.release();
    await Promise.all([lease.release(), lease.release()]);
});

async function send(c, context, bytes, input = {}) {
    const started = await c.start(context, { folder: "working", path: "target.bin", size: bytes.length, ifMatch: null, ...input });
    for (let i = 0; i < started.partCount; i++) await c.put(context, started.uploadId, i, bytes.subarray(i * started.partBytes, (i + 1) * started.partBytes));
    return started;
}

for (const size of [0, 1, 16383, 16384, 16385]) {
    test(`bounded upload publishes ${size} bytes and repeats receipt once`, async () => fixture(async (c, context, root) => {
        const bytes = Buffer.alloc(size, 73), started = await send(c, context, bytes);
        await assert.rejects(fs.stat(path.join(root, "target.bin")), { code: "ENOENT" });
        let events = 0;
        const result = await c.complete(context, started.uploadId, async () => { events++; });
        assert.equal(result.size, size); assert.equal(result.etag, "sha256:" + hash(bytes));
        assert.deepEqual(await fs.readFile(path.join(root, "target.bin")), bytes);
        assert.deepEqual(await c.complete(context, started.uploadId, async () => { events++; }), result);
        assert.equal(events, 1);
        assert.equal((await c.status(context, started.uploadId)).state, "completed");
    }));
}

test("parts are exact, contiguous and immutable under replay", async () => fixture(async (c, ctx) => {
    const s = await c.start(ctx, { folder: "working", path: "target.bin", size: 16385 });
    await assert.rejects(c.put(ctx, s.uploadId, 1, Buffer.alloc(1)), { code: "WORKSPACE_FILES_UPLOAD_INCOMPLETE" });
    await assert.rejects(c.put(ctx, s.uploadId, 0, Buffer.alloc(1)), { code: "WORKSPACE_FILES_UPLOAD_INCOMPLETE" });
    await c.put(ctx, s.uploadId, 0, Buffer.alloc(16384, 1));
    await c.put(ctx, s.uploadId, 0, Buffer.alloc(16384, 1));
    await assert.rejects(c.put(ctx, s.uploadId, 0, Buffer.alloc(16384, 2)), { code: "WORKSPACE_FILES_UPLOAD_PART_CONFLICT" });
    await assert.rejects(c.complete(ctx, s.uploadId, async () => {}), { code: "WORKSPACE_FILES_UPLOAD_INCOMPLETE" });
    await c.abort(ctx, s.uploadId);
    await c.abort(ctx, s.uploadId);
}));

test("whole digest and stale overwrite do not change destination", async () => fixture(async (c, ctx, root) => {
    const target = path.join(root, "target.bin");
    await fs.writeFile(target, "old");
    const first = await send(c, ctx, Buffer.from("new"), { sha256: "0".repeat(64), ifMatch: "sha256:" + hash("old") });
    await assert.rejects(c.complete(ctx, first.uploadId, async () => {}), { code: "WORKSPACE_FILES_UPLOAD_INTEGRITY" });
    assert.equal(await fs.readFile(target, "utf8"), "old");
    const second = await send(c, ctx, Buffer.from("new"), { ifMatch: "sha256:" + hash("old") });
    await fs.writeFile(target, "changed");
    await assert.rejects(c.complete(ctx, second.uploadId, async () => {}), { code: "WORKSPACE_FILES_CONFLICT" });
    assert.equal(await fs.readFile(target, "utf8"), "changed");
}));

test("bindings, limits and finite empty-transfer quota", async () => fixture(async (c, ctx) => {
    await assert.rejects(c.start(ctx, { folder: "working", path: "a", size: -1 }));
    await assert.rejects(c.start(ctx, { folder: "working", path: "a", size: 20971521 }));
    const s = await c.start(ctx, { folder: "working", path: "a", size: 0 });
    await assert.rejects(c.status({ ...ctx, principal: "someone-else" }, s.uploadId), { code: "WORKSPACE_FILES_UPLOAD_EXPIRED" });
    await c.start(ctx, { folder: "working", path: "b", size: 0 });
    await assert.rejects(c.start(ctx, { folder: "working", path: "c", size: 0 }), { code: "WORKSPACE_FILES_UPLOAD_QUOTA" });
}));

test("separate local and destination filesystems publish successfully", { skip: process.platform !== "linux" }, async () => fixture(async (c, ctx, root, spool) => {
    assert.notEqual((await fs.stat(root)).dev, (await fs.stat(spool)).dev);
    const s = await send(c, ctx, Buffer.from("cross-device"));
    await c.complete(ctx, s.uploadId, async () => {});
    assert.equal(await fs.readFile(path.join(root, "target.bin"), "utf8"), "cross-device");
}, { targetParent: "/dev/shm" }));

test("shared acquisition rejects conflicting limits and preserves lease ownership", async () => {
    const config = { roots: [{ name: "test", path: os.tmpdir() }] };
    const one = acquireWorkspaceTransferCoordinator(config);
    const two = acquireWorkspaceTransferCoordinator({ ...config });
    assert.equal(one.coordinator, two.coordinator);
    assert.throws(() => acquireWorkspaceTransferCoordinator({ ...config, uploadPartBytes: 16384 }), { code: "WORKSPACE_FILES_UPLOAD_INVALID" });
    await one.release();
    const claim = await two.coordinator.reserve({ bytes: 4096, principal: JSON.stringify(["a:b", "c"]), root: "test" });
    const other = await two.coordinator.reserve({ bytes: 4096, principal: JSON.stringify(["a", "b:c"]), root: "test" });
    assert.notEqual(JSON.stringify(["a:b", "c"]), JSON.stringify(["a", "b:c"]));
    await claim.release(); await other.release(); await two.release();
});

test("abort waits for an admitted body reader before cleaning up its files and claim", async () => fixture(async (c, ctx, root) => {
    const s = await c.start(ctx, { folder: "working", path: "target.bin", size: 1 });
    let readerReady, releaseReader;
    const ready = new Promise((resolve) => { readerReady = resolve; });
    const put = c.put(ctx, s.uploadId, 0, () => {
        readerReady();
        return new Promise((resolve) => { releaseReader = () => resolve(Buffer.from([1])); });
    });
    const rejected = assert.rejects(put, { code: "WORKSPACE_FILES_UPLOAD_CANCELLED" });
    await ready;
    const abort = c.abort(ctx, s.uploadId);
    releaseReader();
    await rejected; await abort;
    await assert.rejects(fs.stat(path.join(root, "target.bin")), { code: "ENOENT" });
    assert.equal((await c.status(ctx, s.uploadId)).state, "aborted");
}));

test("a killed helper's resource promise settles only after its PID has exited", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ps-helper-exit-"));
    const marker = path.join(dir, "pid");
    const controller = new AbortController();
    let ready;
    const started = new Promise((resolve) => { ready = resolve; });
    const watcher = watch(dir, (_event, file) => { if (file === "pid") ready(); });
    const operation = runWorkspaceTransferProcess(
        'const fs=require("node:fs");let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const p=JSON.parse(s).marker;fs.writeFileSync(p+".next",String(process.pid));fs.renameSync(p+".next",p);setInterval(()=>{},1000);});',
        { marker }, 30_000, controller.signal,
    );
    const rejected = assert.rejects(operation, { code: "WORKSPACE_FILES_TIMEOUT" });
    try {
        await started;
        const pid = Number(await fs.readFile(marker, "utf8"));
        controller.abort();
        await rejected;
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally { watcher.close(); controller.abort(); await operation.catch(() => {}); await fs.rm(dir, { recursive: true }); }
});

test("create-only completion cannot overwrite a target created after start", async () => fixture(async (c, ctx, root) => {
    const s = await send(c, ctx, Buffer.from("new"));
    await fs.writeFile(path.join(root, "target.bin"), "external");
    await assert.rejects(c.complete(ctx, s.uploadId, async () => {}), { code: "WORKSPACE_FILES_EXISTS" });
    assert.equal(await fs.readFile(path.join(root, "target.bin"), "utf8"), "external");
}));

test("disk-full assembly leaves no target and releases capacity only after candidate cleanup", async () => fixture(async (c, ctx, root) => {
    const s = await send(c, ctx, Buffer.from("data"));
    const original = c.helper.bind(c);
    c.helper = (t, op, extra = {}, signal) => {
        if (op !== "assemble") return original(t, op, extra, signal);
        const inject = 'const faultFs=require("node:fs");const savedWrite=faultFs.writeSync;faultFs.writeSync=function(fd,...args){if(faultFs.fstatSync(fd).isFile())throw Object.assign(new Error("injected full disk"),{code:"ENOSPC"});return savedWrite.call(this,fd,...args);};';
        return runWorkspaceTransferProcess(inject + WORKSPACE_UPLOAD_SCRIPT, {
            ...t.input, ...t.context, ...t.prepared, candidate: t.candidate, id: t.id, op,
            spool: t.spool, partBytes: c.partBytes, partCount: 1, maxBytes: 20971520,
            codes: WORKSPACE_FILE_ERROR_CODES, requireMarker: true, ...extra,
        }, 30_000, signal);
    };
    await assert.rejects(c.complete(ctx, s.uploadId, async () => {}), { code: "WORKSPACE_FILES_UPLOAD_QUOTA", status: 507 });
    await assert.rejects(fs.stat(path.join(root, "target.bin")), { code: "ENOENT" });
    assert.ok(!(await fs.readdir(root)).some((name) => name.startsWith(".pilotswarm-transfer-")));
    await c.start(ctx, { folder: "working", path: "one", size: 0 });
    await c.start(ctx, { folder: "working", path: "two", size: 0 });
}));

test("notification failure is a known committed receipt, not another publication attempt", async () => fixture(async (c, ctx, root) => {
    const s = await send(c, ctx, Buffer.from("committed"));
    let attempts = 0;
    const result = await c.complete(ctx, s.uploadId, async () => { attempts++; throw Error("injected notification failure"); });
    assert.equal(result.notificationFailed, true);
    assert.equal(await fs.readFile(path.join(root, "target.bin"), "utf8"), "committed");
    assert.deepEqual(await c.complete(ctx, s.uploadId, async () => { attempts++; }), result);
    assert.equal(attempts, 1);
}));

test("shutdown drains starts admitted before the process lifetime is cancelled", async () => fixture(async (c, ctx) => {
    const start = c.start(ctx, { folder: "working", path: "target.bin", size: 0 });
    const rejected = assert.rejects(start, { code: "WORKSPACE_FILES_UPLOAD_BUSY" });
    await c.stop(); await rejected;
    assert.equal(c.lifetimeSignal.aborted, true);
}));
