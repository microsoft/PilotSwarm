import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { MOTD_OPERATION_SPECS } from "pilotswarm-sdk";
import { OPERATIONS, ApiClient, HttpApiTransport } from "pilotswarm-sdk/api";
import { PortalRuntime } from "../runtime.js";
import { createApiRouter } from "../api/router.js";
import { installJsonBodyLimits } from "../server.js";

async function harness(run) {
    const calls = [];
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.transport = { mgmt: Object.fromEntries(MOTD_OPERATION_SPECS.map(spec => [spec.method, async (...args) => {
        calls.push({ method: spec.method, args }); return spec.kind === "current" ? null : { motdId: "1" };
    }])) };
    runtime.authz = { ...runtime.authz, enforce: true };
    runtime._recordAudit = () => {};
    const app = express(); installJsonBodyLimits(app);
    app.use("/api/v1", createApiRouter({ runtime, requireAuth: (req, res, next) => {
        const subject = req.headers["x-test-actor"];
        if (!["alice", "admin"].includes(subject)) return res.status(401).json({ ok: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } });
        req.auth = { principal: { provider: "test", subject }, authorization: { role: subject === "admin" ? "admin" : "user" } }; next();
    } }));
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ ok: false, error: { code: error.type, message: "Request rejected" } }));
    const server = await new Promise(resolve => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const url = `http://127.0.0.1:${server.address().port}`;
    const client = actor => new ApiClient({ apiUrl: url, fetchImpl: (uri, options) => fetch(uri, { ...options,
        headers: { ...options.headers, "x-test-actor": actor } }) });
    try { await run({ calls, runtime, url, admin: client("admin"), alice: client("alice") }); }
    finally { await new Promise(resolve => server.close(resolve)); }
}
test("all six MoTD operations have matching wire access classifications", () => {
    for (const spec of MOTD_OPERATION_SPECS) assert.equal(OPERATIONS.find(op => op.name === spec.method).access, spec.access);
});
test("MoTD routes reach the authenticated runtime and cannot spoof their viewer", async () => {
    await harness(async ({ admin, alice, calls, runtime }) => {
        const request = { fromAt: "2020-01-01T00:00:00Z", toAt: "2090-01-01T00:00:00Z", bodyMd: "Hello", requestId: "one" };
        await admin.call("createMotd", { ...request, isAdmin: false, principal: { provider: "fake", subject: "fake" } });
        assert.deepEqual(calls[0], { method: "createMotd", args: [{ principal: { provider: "test", subject: "admin", email: null, displayName: null }, isAdmin: true }, request] });
        await alice.call("getCurrentMotd"); await alice.call("dismissMotd", { motdId: "1" });
        await alice.call("getMotdImage", { motdId: "1", mobile: true });
        await admin.call("listMotds", { limit: 2, before: "9" }); await admin.call("deleteMotd", { motdId: "1" });
        assert.equal(calls.length, 6);
        assert.deepEqual(calls[3].args.slice(1), ["1", true]);
        assert.deepEqual(calls[4].args.slice(1), [2, "9"]);
        for (const method of ["createMotd", "deleteMotd", "listMotds"]) {
            await assert.rejects(alice.call(method, { ...request, motdId: "1", isAdmin: true }), { status: 403 });
            await assert.rejects(runtime.call(method, { ...request, motdId: "1", isAdmin: true }, {
                principal: { provider: "test", subject: "alice" }, authorization: { role: "user" },
            }), error => error.status === 403 || error.code === "FORBIDDEN");
        }
        assert.equal(calls.length, 6);
    });
});
test("create alone accepts two 2 MB base64 pictures within 6 MB; default and oversize requests refuse", async () => {
    await harness(async ({ url, calls }) => {
        const picture = { base64: Buffer.alloc(2 * 1024 * 1024).toString("base64"), contentType: "image/png", alt: "Picture" };
        const body = JSON.stringify({ fromAt: "2020-01-01T00:00:00Z", toAt: "2090-01-01T00:00:00Z",
            bodyMd: "Hello", requestId: "large", image: picture, mobileImage: picture });
        const post = (path, payload) => fetch(`${url}/api/v1${path}`, { method: "POST",
            headers: { "content-type": "application/json", "x-test-actor": "admin" }, body: payload });
        assert.equal((await post("/management/motd", body)).status, 200);
        assert.equal(calls[0].args[1].image.base64.length, picture.base64.length);
        assert.equal((await post("/management/motd", JSON.stringify({ bodyMd: "x".repeat(6 * 1024 * 1024) }))).status, 413);
        assert.equal((await post("/sessions/session-1/messages", body)).status, 413);
        assert.equal(calls.length, 1);
    });
});
test("HTTP transport uses the canonical operation names and parameters", async () => {
    const calls = [];
    const api = new ApiClient({ apiUrl: "https://example.invalid" });
    api.call = async (...args) => { calls.push(args); };
    const transport = new HttpApiTransport({ api });
    await transport.getCurrentMotd(); await transport.dismissMotd("1"); await transport.getMotdImage("1", true);
    await transport.listMotds(2, "9"); await transport.createMotd({ bodyMd: "body" }); await transport.deleteMotd("1");
    assert.deepEqual(calls.map(c => c[0]), MOTD_OPERATION_SPECS.map(s => s.method));
});
