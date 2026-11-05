import test from "node:test";
import assert from "node:assert/strict";
import { uploadWorkspaceBlob, workspaceUploadReceiptWarning } from "../../ui/react/src/workspace-upload.js";
import { workspaceErrorText } from "../../ui/react/src/workspace-pane.js";

const P = 524_288;
const busy = () => Object.assign(new Error("capacity busy"), { code: "WORKSPACE_FILES_UPLOAD_BUSY", status: 503 });
const RESULT = { etag: "sha256:new", size: P + 1, mtimeMs: 42, created: true };
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};

function fixture(size, overrides = {}) {
    const calls = [];
    const reads = [];
    // Not backed by a whole-file buffer: this also exercises a 20 MiB source
    // whose only allocations are one bounded part at a time.
    const blob = {
        size,
        arrayBuffer: async () => {
            reads.push(["whole", size]);
            assert.ok(size <= 65_536, "large uploads must not read the entire file");
            return new Uint8Array(size).buffer;
        },
        slice: (start, end) => {
            reads.push([start, end]);
            assert.ok(end - start <= P);
            return { arrayBuffer: async () => new Uint8Array(end - start).fill(17).buffer };
        },
    };
    const transport = {
        sessionWorkspaceFiles: async (...args) => { calls.push(["legacy", ...args]); return RESULT; },
        startSessionWorkspaceUpload: async (...args) => { calls.push(["start", ...args]); return { uploadId: "u1", partBytes: P, partCount: Math.ceil(size / P), expiresAt: 123 }; },
        putSessionWorkspaceUploadPart: async (sid, id, part, bytes, options) => {
            calls.push(["part", sid, id, part, bytes.length, options]);
            return { part, bytes: bytes.length, sha256: "part-hash" };
        },
        completeSessionWorkspaceUpload: async (...args) => { calls.push(["complete", ...args]); return RESULT; },
        abortSessionWorkspaceUpload: async (...args) => { calls.push(["abort", ...args]); return { state: "aborted" }; },
        ...overrides,
    };
    const progress = [];
    const input = {
        transport, sessionId: "original-session", folder: "original-folder", path: "original.txt", ifMatch: null,
        blob, upload: { partBytes: P, legacyMaxBytes: 65_536 }, uploads: true,
        onProgress: (value) => progress.push(value),
    };
    return { calls, reads, progress, transport, input, run: (options = {}) => uploadWorkspaceBlob({ ...input, ...options }) };
}

for (const size of [0, 1, 65_536, P, P + 1, 20 * 1024 * 1024]) {
    test(`bounded source reads and exact wire lengths at ${size} bytes`, async () => {
        const f = fixture(size);
        assert.equal(await f.run(), RESULT);
        const parts = f.calls.filter(([kind]) => kind === "part");
        if (size <= 65_536) {
            assert.deepEqual(f.calls.map(([kind]) => kind), ["legacy"]);
            assert.deepEqual(f.reads, [["whole", size]]);
            assert.equal(Buffer.from(f.calls[0][2].contentBase64, "base64").length, size);
        } else {
            const count = Math.ceil(size / P);
            assert.equal(parts.length, count);
            assert.deepEqual(parts.map((part) => part[3]), Array.from({ length: count }, (_, index) => index));
            assert.deepEqual(parts.map((part) => part[4]), Array.from({ length: count }, (_, index) => Math.min(P, size - index * P)));
            assert.deepEqual(f.reads, Array.from({ length: count }, (_, index) => [index * P, Math.min(size, (index + 1) * P)]));
            assert.ok(!f.calls.some(([kind]) => kind === "legacy"));
            assert.deepEqual(f.calls[0], ["start", "original-session", { folder: "original-folder", path: "original.txt", size, ifMatch: null }]);
            assert.deepEqual(f.calls.at(-1), ["complete", "original-session", "u1"]);
        }
        assert.equal(f.progress.at(-1).bytes, size);
    });
}

test("one-byte chunk and empty chunk policy with a zero legacy allowance", async () => {
    const one = fixture(1);
    await one.run({ upload: { partBytes: P, legacyMaxBytes: 0 } });
    assert.deepEqual(one.reads, [[0, 1]]);
    const empty = fixture(0);
    await empty.run({ upload: { partBytes: P, legacyMaxBytes: 0 } });
    assert.deepEqual(empty.calls.map(([kind]) => kind), ["legacy"], "empty writes remain a small legacy write");
});

test("parts are sequential and use the advertised negotiated bound", async () => {
    const first = deferred();
    const entered = deferred();
    const f = fixture(P + 1, {
        putSessionWorkspaceUploadPart: async (...args) => {
            f.calls.push(["part", ...args.slice(0, 3)]);
            if (args[2] === 0) { entered.resolve(); await first.promise; }
        },
    });
    const pending = f.run();
    await entered.promise;
    assert.deepEqual(f.reads, [[0, P]], "no read-ahead while a part is active");
    first.resolve();
    await pending;
    assert.deepEqual(f.reads, [[0, P], [P, P + 1]]);
});

test("smaller negotiated parts are sliced at that size", async () => {
    const f = fixture(P + 1, {
        startSessionWorkspaceUpload: async () => ({ uploadId: "u1", partBytes: P / 2, partCount: 3 }),
    });
    await f.run();
    assert.deepEqual(f.reads, [[0, P / 2], [P / 2, P], [P, P + 1]]);
});

for (const phase of ["start", "part", "complete"]) {
    test(`explicit BUSY ${phase} rejection backs off without rereading bytes or changing the target`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const waiting = deferred();
        let attempts = 0, originalBytes;
        const f = fixture(P + 1);
        const method = { start: "startSessionWorkspaceUpload", part: "putSessionWorkspaceUploadPart", complete: "completeSessionWorkspaceUpload" }[phase];
        const original = f.transport[method];
        f.transport[method] = async (...args) => {
            attempts++;
            if (phase === "part" && args[2] === 0) {
                if (!originalBytes) originalBytes = args[3];
                assert.equal(args[3], originalBytes);
            }
            if (attempts === 1) throw Object.assign(busy(), { retryAfterMs: 2000 });
            return original(...args);
        };
        const pending = f.run({ onProgress: (value) => { f.progress.push(value); if (value.phase === "waiting") waiting.resolve(); } });
        await waiting.promise;
        t.mock.timers.tick(1999);
        assert.equal(attempts, 1, "honor the server's minimum delay");
        t.mock.timers.tick(8000);
        assert.equal(await pending, RESULT);
        assert.deepEqual(f.reads, [[0, P], [P, P + 1]]);
        assert.equal(f.calls.filter(([kind]) => kind === "start").length, 1);
        assert.equal(f.calls.filter(([kind]) => kind === "complete").length, 1);
    });
}

test("persistent BUSY has exactly five backoffs then aborts once and reports the denial", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let attempts = 0, waiting = deferred();
    const error = busy();
    const f = fixture(P, { putSessionWorkspaceUploadPart: async () => { attempts++; throw error; } });
    const pending = f.run({ onProgress: (value) => { if (value.phase === "waiting") waiting.resolve(); } });
    const rejected = assert.rejects(pending, (caught) => caught === error && caught.uploadPart === 0);
    for (let retry = 0; retry < 5; retry++) {
        await waiting.promise;
        waiting = deferred();
        t.mock.timers.tick(8000);
    }
    await rejected;
    assert.equal(attempts, 6);
    assert.deepEqual(f.reads, [[0, P]]);
    assert.deepEqual(f.calls.map(([kind]) => kind), ["start", "abort"]);
});

for (const phase of ["part", "complete"]) {
    test(`Cancel during BUSY ${phase} backoff cancels the timer and cleans up the original upload`, async (t) => {
        t.mock.timers.enable({ apis: ["setTimeout"] });
        const controller = new AbortController(), waiting = deferred();
        let attempts = 0;
        const method = phase === "part" ? "putSessionWorkspaceUploadPart" : "completeSessionWorkspaceUpload";
        const f = fixture(P, { [method]: async () => { attempts++; throw busy(); } });
        const pending = f.run({ signal: controller.signal, onProgress: (value) => { if (value.phase === "waiting") waiting.resolve(); } });
        await waiting.promise;
        controller.abort();
        await assert.rejects(pending, (error) => error.name === "AbortError" && !error.completionUncertain);
        t.mock.timers.tick(8000);
        assert.equal(attempts, 1);
        assert.equal(f.calls.filter(([kind]) => kind === "abort").length, 1);
        assert.equal(f.calls.filter(([kind]) => kind === "complete").length, 0);
    });
}

test("untyped 503 and BUSY with another status are not retried", async () => {
    for (const error of [Object.assign(new Error("proxy unavailable"), { status: 503 }), Object.assign(busy(), { status: 409 })]) {
        let attempts = 0;
        const f = fixture(P, { completeSessionWorkspaceUpload: async () => { attempts++; throw error; } });
        await assert.rejects(f.run(), (caught) => caught === error);
        assert.equal(attempts, 1);
    }
});

for (const error of [
    Object.assign(new Error("proxy rejected body"), { status: 413 }),
    Object.assign(new Error("expired"), { code: "WORKSPACE_FILES_UPLOAD_EXPIRED" }),
    Object.assign(new Error("different part"), { code: "WORKSPACE_FILES_UPLOAD_PART_CONFLICT" }),
    new Error("network disconnected"),
]) {
    test(`a part failure aborts once, without retry or legacy fallback: ${error.message}`, async () => {
        let attempts = 0;
        const f = fixture(P + 1, { putSessionWorkspaceUploadPart: async () => { attempts++; throw error; } });
        await assert.rejects(f.run(), (caught) => caught === error && caught.uploadPart === 0);
        assert.equal(attempts, 1);
        assert.deepEqual(f.calls.map(([kind]) => kind), ["start", "abort"]);
    });
}

test("cancel aborts the active part signal and cleans up, without publication", async () => {
    const controller = new AbortController();
    const entered = deferred();
    const f = fixture(P + 1, {
        putSessionWorkspaceUploadPart: async (_sid, _id, _part, _bytes, { signal }) => {
            assert.equal(signal, controller.signal);
            entered.resolve();
            await new Promise((_resolve, reject) => signal.addEventListener("abort",
                () => reject(Object.assign(new Error("cancel"), { name: "AbortError" })), { once: true }));
        },
    });
    const result = f.run({ signal: controller.signal });
    await entered.promise;
    controller.abort();
    await assert.rejects(result, { name: "AbortError" });
    assert.deepEqual(f.calls.map(([kind]) => kind), ["start", "abort"]);
});

test("cancellation during start still aborts the returned original transfer", async () => {
    const controller = new AbortController();
    const start = deferred();
    const f = fixture(P, { startSessionWorkspaceUpload: () => start.promise });
    const result = f.run({ signal: controller.signal });
    controller.abort();
    start.resolve({ uploadId: "original-upload", partBytes: P, partCount: 1 });
    await assert.rejects(result, { name: "AbortError" });
    assert.deepEqual(f.calls, [["abort", "original-session", "original-upload"]]);
    assert.deepEqual(f.reads, []);
});

test("already-cancelled and unsupported-folder uploads do not read any bytes", async () => {
    const f = fixture(P);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(f.run({ signal: controller.signal }), { name: "AbortError" });
    await assert.rejects(f.run({ uploads: false }), { code: "WORKSPACE_FILES_UPLOAD_UNSUPPORTED" });
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.reads, []);
});

test("invalid part metadata is rejected and cleaned up before reading", async () => {
    const f = fixture(P, {
        startSessionWorkspaceUpload: async () => ({ uploadId: "u1", partBytes: P * 2, partCount: 1 }),
    });
    await assert.rejects(f.run(), { code: "WORKSPACE_FILES_UPLOAD_UNSUPPORTED" });
    assert.deepEqual(f.reads, []);
    assert.deepEqual(f.calls, [["abort", "original-session", "u1"]]);
});

for (const code of [undefined, "INTERNAL_ERROR", "WORKSPACE_FILES_UPLOAD_IN_PROGRESS", "WORKSPACE_FILES_UPLOAD_COMMIT_UNKNOWN"]) {
    test(`uncertain completion ${code ?? "lost receipt"} is not retried, aborted, or reported as progress success`, async () => {
        const error = Object.assign(new Error("no definite completion receipt"), code ? { code } : {});
        const f = fixture(P, { completeSessionWorkspaceUpload: async () => { f.calls.push(["complete"]); throw error; } });
        await assert.rejects(f.run(), (caught) => caught === error && caught.completionUncertain);
        assert.equal(f.calls.filter(([kind]) => kind === "complete").length, 1);
        assert.ok(!f.calls.some(([kind]) => ["legacy", "abort"].includes(kind)));
        assert.equal(f.progress.at(-1).phase, "completing");
        assert.match(workspaceErrorText(error), /uncertain.*inspect.*not retried/i);
    });
}

test("etag conflict remains typed, and replacement starts a fresh immutable target", async () => {
    const error = Object.assign(new Error("already exists"), { code: "WORKSPACE_FILES_EXISTS", etag: "sha256:old" });
    const f = fixture(P, { completeSessionWorkspaceUpload: async () => { throw error; } });
    await assert.rejects(f.run(), (caught) => caught === error && !caught.completionUncertain);
    assert.equal(f.calls.filter(([kind]) => kind === "abort").length, 1);
    f.transport.completeSessionWorkspaceUpload = async () => RESULT;
    await f.run({ path: "copy.txt", ifMatch: "sha256:old" });
    const starts = f.calls.filter(([kind]) => kind === "start");
    assert.equal(starts.length, 2);
    assert.deepEqual(starts.map((entry) => [entry[2].path, entry[2].ifMatch]), [["original.txt", null], ["copy.txt", "sha256:old"]]);
});

test("cleanup errors are preserved alongside the primary failure, not hidden", async () => {
    const primary = Object.assign(new Error("rejected"), { status: 413 });
    const cleanup = new Error("cleanup access revoked");
    const f = fixture(P, {
        putSessionWorkspaceUploadPart: async () => { throw primary; },
        abortSessionWorkspaceUpload: async () => { throw cleanup; },
    });
    await assert.rejects(f.run(), (error) => error === primary && error.cleanupError === cleanup);
    assert.match(workspaceErrorText(primary), /file part 1.*proxy body limit.*Cleanup.*access revoked/s);
});

test("nonterminal abort results are an explicit cleanup error", async () => {
    const primary = new Error("part rejected");
    const f = fixture(P, {
        putSessionWorkspaceUploadPart: async () => { throw primary; },
        abortSessionWorkspaceUpload: async () => ({ state: "completing" }),
    });
    await assert.rejects(f.run(), (error) => /completing/.test(error.cleanupError.message));
});

test("legacy compatibility is explicit and small writes keep exact conditions", async () => {
    let warnings = 0;
    const f = fixture(12);
    await f.run({ upload: undefined, onLegacy: () => warnings++, ifMatch: "sha256:original" });
    assert.equal(warnings, 0);
    assert.equal(f.calls[0][2].ifMatch, "sha256:original");
    const large = fixture(P);
    large.input.blob.arrayBuffer = async () => new Uint8Array(P).buffer;
    await large.run({ upload: undefined, onLegacy: () => warnings++ });
    assert.equal(warnings, 1);
    assert.deepEqual(large.calls.map(([kind]) => kind), ["legacy"]);
});

test("403 errors distinguish a raw proxy denial from a typed authorization denial", () => {
    assert.match(workspaceErrorText({ status: 403, message: "Forbidden" }), /proxy or firewall/);
    assert.doesNotMatch(workspaceErrorText({ status: 403, message: "Forbidden" }), /Only the session's owner|sign out/);
    assert.match(workspaceErrorText({ status: 403, code: "FORBIDDEN", message: "not owner" }), /owner/);
    assert.match(workspaceErrorText({ status: 403, code: "FORBIDDEN", message: "Request rejected (HTTP 403). A proxy or firewall may have rejected it." }), /possibly by a proxy or firewall/);
    assert.match(workspaceErrorText({ status: 403, code: "FORBIDDEN", message: "blocked", nonJson: true }), /proxy or firewall/);
    assert.match(workspaceErrorText({ status: 403, code: "FORBIDDEN", message: "blocked", responseIsJson: false }), /proxy or firewall/);
    assert.match(workspaceErrorText({ status: 403, code: "WORKSPACE_FILES_READ_ONLY" }), /read-only/i);
});

for (const flags of [
    { notificationFailed: true },
    { receiptPersistenceFailed: true },
    { notificationFailed: true, receiptPersistenceFailed: true },
]) {
    test(`known publication retains receipt warnings without retry/abort: ${Object.keys(flags).join(", ")}`, async () => {
        const receipt = { ...RESULT, ...flags };
        const f = fixture(P, { completeSessionWorkspaceUpload: async () => { f.calls.push(["complete"]); return receipt; } });
        assert.equal(await f.run(), receipt);
        assert.equal(f.progress.at(-1).phase, "completed");
        assert.equal(f.calls.filter(([kind]) => kind === "complete").length, 1);
        assert.equal(f.calls.filter(([kind]) => ["abort", "legacy"].includes(kind)).length, 0);
        const text = workspaceUploadReceiptWarning(receipt, "uploaded");
        assert.match(text, /File uploaded, but .* failed.*file is committed.*not retried/);
        if (flags.notificationFailed) assert.match(text, /notification/);
        if (flags.receiptPersistenceFailed) assert.match(text, /receipt persistence/);
    });
}

test("ordinary successful receipts have no warning", () => {
    assert.equal(workspaceUploadReceiptWarning(RESULT), null);
    assert.equal(workspaceUploadReceiptWarning({ ...RESULT, notificationFailed: false, receiptPersistenceFailed: false }), null);
});
