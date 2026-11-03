import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { ApiClient } from "../../../sdk/api/src/api-client.js";
import { uploadHttpFixture } from "./workspace-upload-harness.mjs";
import http from "node:http";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

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
