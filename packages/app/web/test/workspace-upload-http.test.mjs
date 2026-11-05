import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { ApiClient } from "../../../sdk/api/src/api-client.js";
import { uploadHttpFixture } from "./workspace-upload-harness.mjs";
import http from "node:http";
import { uploadWorkspaceBlob } from "../../ui/react/src/workspace-upload.js";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

for (const concurrency of [3, 4]) {
    test(`${concurrency} concurrent owners upload through the real HTTP path with bounded BUSY backoff`, { timeout: 60_000 }, async () => {
        const sessionOwners = Object.fromEntries(Array.from({ length: concurrency }, (_, n) => [`session-${n}`, { provider: "dev", subject: `owner-${n}` }]));
        const f = await uploadHttpFixture({ sessionOwners });
        const coordinator = f.mgmt._getWorkspaceTransfers();
        let finish, rejections = 0, releaseInitial;
        const rejected = new Promise((resolve) => { releaseInitial = resolve; });
        const held = new Promise((resolve) => { finish = resolve; });
        const lanes = [coordinator.runData(() => held), coordinator.runData(() => held)];
        const originalRunData = coordinator.runData.bind(coordinator);
        let peakDataCalls = 0, active = 0;
        coordinator.runData = (operation) => originalRunData(async () => {
            peakDataCalls = Math.max(peakDataCalls, ++active);
            try { return await operation(); } finally { active--; }
        });
        const bytes = Buffer.alloc(524289, 37);
        try {
            const uploads = Object.keys(sessionOwners).map((sessionId, n) => {
                const api = new ApiClient({
                    apiUrl: f.direct,
                    fetchImpl: async (url, options) => {
                        const response = await fetch(url, { ...options, headers: { ...options.headers, "x-upload-owner": `owner-${n}` } });
                        if (response.status === 503) {
                            assert.equal(response.headers.get("retry-after"), "1");
                            if (++rejections === concurrency) releaseInitial();
                        }
                        return response;
                    },
                });
                const transport = {
                    startSessionWorkspaceUpload: (sid, input) => api.call("startSessionWorkspaceUpload", { sessionId: sid, input }),
                    putSessionWorkspaceUploadPart: (...args) => api.putSessionWorkspaceUploadPart(...args),
                    completeSessionWorkspaceUpload: (sid, uploadId) => api.call("completeSessionWorkspaceUpload", { sessionId: sid, uploadId }),
                    abortSessionWorkspaceUpload: (sid, uploadId) => api.call("abortSessionWorkspaceUpload", { sessionId: sid, uploadId }),
                };
                return uploadWorkspaceBlob({ transport, sessionId, folder: "working", path: `parallel-${n}.bin`, ifMatch: null, blob: new Blob([bytes]), upload: { partBytes: 524288 }, uploads: true });
            });
            // Keep both real admission lanes occupied until every uploader has
            // received a denial; this does not serialize their subsequent work.
            const results = Promise.all(uploads);
            await rejected;
            finish(); await Promise.all(lanes);
            await results;
            assert.ok(rejections >= concurrency);
            assert.ok(peakDataCalls <= 2);
            assert.equal(f.events.length, concurrency);
            for (let n = 0; n < concurrency; n++) assert.equal(digest(await fs.readFile(path.join(f.root, `parallel-${n}.bin`))), digest(bytes));
        } finally { finish(); await Promise.all(lanes); await f.close(); }
    });
}

test("raw HTTP validates the workspace once per accepted part and never reads a busy request body", async () => {
    const f = await uploadHttpFixture(), api = new ApiClient({ apiUrl: f.direct });
    try {
        const started = await api.call("startSessionWorkspaceUpload", { sessionId: "session", input: { folder: "working", path: "once.bin", size: 1 } });
        const c = f.mgmt._getWorkspaceTransfers(), helper = c.helper.bind(c);
        const calls = [];
        c.helper = (t, op, ...args) => { calls.push(op); return helper(t, op, ...args); };
        let finish;
        const held = new Promise((resolve) => { finish = resolve; });
        const lanes = [c.runData(() => held), c.runData(() => held)];
        try {
            await assert.rejects(api.putSessionWorkspaceUploadPart("session", started.uploadId, 0, new Uint8Array([17])), (error) => {
                assert.equal(error.code, "WORKSPACE_FILES_UPLOAD_BUSY");
                assert.equal(error.retryAfterMs, 1000);
                return true;
            });
            assert.deepEqual(calls, [], "busy admission does not even launch validation");
        } finally { finish(); await Promise.all(lanes); }
        await api.putSessionWorkspaceUploadPart("session", started.uploadId, 0, new Uint8Array([17]));
        assert.deepEqual(calls, ["validate"], "raw HTTP no longer validates through a separate status helper");
        await api.call("abortSessionWorkspaceUpload", { sessionId: "session", uploadId: started.uploadId });
    } finally { await f.close(); }
});

test("raw HTTP rejects wrong encodings, oversized chunked bodies and foreign owners without accepting a part", async () => {
    const f = await uploadHttpFixture(), api = new ApiClient({ apiUrl: f.direct });
    try {
        const start = await api.call("startSessionWorkspaceUpload", { sessionId: "session", input: { folder: "working", path: "bounded.bin", size: 1 } });
        const url = `${f.direct}/api/v1/management/sessions/session/workspace/uploads/${start.uploadId}/parts/0`;
        for (const [headers, expected] of [
            [{ "content-type": "application/json" }, 415],
            [{ "content-type": "application/octet-stream", "content-encoding": "gzip" }, 415],
            [{ "content-type": "application/octet-stream", "x-other-user": "yes", "x-admin": "yes" }, 403],
        ]) {
            const response = await fetch(url, { method: "PUT", headers, body: Buffer.from([1]) });
            assert.equal(response.status, expected);
        }
        const response = await new Promise((resolve, reject) => {
            const request = http.request(url, { method: "PUT", headers: { "content-type": "application/octet-stream" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
            request.on("error", reject);
            request.write(Buffer.from([1])); request.end(Buffer.from([2]));
        });
        assert.equal(response, 413);
        const status = await api.call("getSessionWorkspaceUpload", { sessionId: "session", uploadId: start.uploadId });
        assert.equal(status.acceptedParts, 0);
        await api.call("abortSessionWorkspaceUpload", { sessionId: "session", uploadId: start.uploadId });
        await assert.rejects(fs.stat(path.join(f.root, "bounded.bin")), { code: "ENOENT" });
    } finally { await f.close(); }
});
test("20 MiB real management upload crosses a 1,000,000-byte proxy in raw bounded parts", async () => {
    const f = await uploadHttpFixture();
    const bytes = Buffer.alloc(20_971_520);
    for (let offset = 0, counter = 0; offset < bytes.length; counter++, offset += 32) createHash("sha256").update(`PilotSwarm-191-repro-v1:${counter}`).digest().copy(bytes, offset);
    assert.equal(digest(bytes), "5c2d77e8373cace5e48f3d0f34b71eab1eb12ac599d28da1d1785198d6d5295c");
    const api = new ApiClient({ apiUrl: f.proxy });
    const legacy = (url, name, content) => fetch(`${url}/api/v1/management/sessions/session/workspace/files`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ call: { op: "write", folder: "working", path: name, contentBase64: content.toString("base64"), ifMatch: null } }),
    });
    try {
        assert.equal((await legacy(f.direct, "direct.bin", bytes)).status, 200);
        assert.equal((await legacy(f.proxy, "small.bin", bytes.subarray(0, 4096))).status, 200);
        const before = f.upstream.length;
        const rejected = await legacy(f.proxy, "rejected.bin", bytes);
        assert.equal(rejected.status, 413); assert.match(await rejected.text(), /Payload Too Large/);
        assert.equal(f.upstream.length, before, "proxy rejection never reaches the portal");
        await assert.rejects(fs.stat(path.join(f.root, "rejected.bin")), { code: "ENOENT" });
        const oversized = await fetch(`${f.proxy}/api/v1/management/sessions/session/workspace/files`, { method: "POST", body: Buffer.alloc(1_000_001) });
        assert.equal(oversized.status, 413);
        const start = await api.call("startSessionWorkspaceUpload", { sessionId: "session", input: { folder: "working", path: "uploaded.bin", size: bytes.length, sha256: digest(bytes), ifMatch: null } });
        assert.equal(start.partCount, 40);
        for (let part = 0; part < start.partCount; part++) {
            await api.putSessionWorkspaceUploadPart("session", start.uploadId, part, bytes.subarray(part * start.partBytes, (part + 1) * start.partBytes));
        }
        const result = await api.call("completeSessionWorkspaceUpload", { sessionId: "session", uploadId: start.uploadId });
        assert.equal(result.size, bytes.length); assert.equal(result.etag, "sha256:" + digest(bytes));
        assert.equal(digest(await fs.readFile(path.join(f.root, "uploaded.bin"))), digest(bytes));
        const writes = f.events.filter((event) => event.data.path === "uploaded.bin");
        assert.equal(writes.length, 1);
        await api.call("completeSessionWorkspaceUpload", { sessionId: "session", uploadId: start.uploadId });
        assert.equal(f.events.filter((event) => event.data.path === "uploaded.bin").length, 1);
        const data = f.requests.filter((row) => row.method === "PUT");
        assert.equal(data.length, 40);
        assert.ok(data.every((row) => row.bytes <= 524288 && row.status === 200 && row.forwarded && row.responseBytes <= 524288));
        const evidence = {
            fileBytes: bytes.length, sha256: digest(bytes), proxyLimitBytes: 1_000_000,
            targetBytes: result.size, etag: result.etag, requests: f.requests,
            fixtureBoundaries: ["catalog startup and metadata", "owner access snapshot", "event persistence", "authenticated fixture principal"],
        };
        if (process.env.WORKSPACE_UPLOAD_EVIDENCE_FILE) await fs.writeFile(process.env.WORKSPACE_UPLOAD_EVIDENCE_FILE, JSON.stringify(evidence, null, 2));
        console.log(JSON.stringify({ fileBytes: bytes.length, sha256: digest(bytes), parts: data.length, maxRequestBodyBytes: Math.max(...data.map((r) => r.bytes)), legacyProxyStatus: rejected.status, result }));
    } finally { await f.close(); }
});
