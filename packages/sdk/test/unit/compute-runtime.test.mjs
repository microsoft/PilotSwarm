/**
 * Remote runtime credential brokerage unit tests: the provider config sent to a remote runtime holds placeholders only, the worker's request handler enforces the
 * session's grant, and a compute target reference is exactly an opaque id. No network beyond a loopback server, no cloud services.
 *
 * Run: node --test test/unit/compute-runtime.test.mjs   (requires a prior build)
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
    RemoteRuntimeRequestHandler,
    checkModelRequest,
    containsWorkerPlaceholder,
    injectSecrets,
    redactProviderSecrets,
    remoteSessionGrant,
} from "../../dist/compute-runtime.js";
import { COMPUTE_KIND_PATTERN, parseSessionComputeTargetRef } from "../../dist/compute-target.js";
import { RemoteRuntimeError, assertRemoteRuntimeBinding, isRemoteRuntimeError } from "../../dist/remote-runtime.js";

const REAL_KEY = "sk-real-key-value";
const REAL_HEADER = "real-header-value";

function provider(baseUrl = "https://models.example.test/v1") {
    return { type: "openai", baseUrl, apiKey: REAL_KEY, headers: { "x-api-token": REAL_HEADER } };
}

function context(sessionId = "s1") {
    return { requestId: "r1", sessionId, transport: "http", url: "", headers: {}, signal: new AbortController().signal };
}

test("redactProviderSecrets: the runtime sees placeholders, never the real credentials, and unknown provider fields are refused", async () => {
    const input = provider();
    const { provider: redacted, secrets } = redactProviderSecrets(input, "s1");
    const text = JSON.stringify(redacted);
    assert.ok(!text.includes(REAL_KEY));
    assert.ok(!text.includes(REAL_HEADER));
    assert.equal(input.apiKey, REAL_KEY, "input provider object is never mutated");
    assert.ok(containsWorkerPlaceholder(redacted.apiKey));
    assert.ok(containsWorkerPlaceholder(redacted.headers["x-api-token"]));
    assert.equal(secrets.size, 2);
    assert.equal(await secrets.get(redacted.apiKey).resolve(), REAL_KEY);
    const again = redactProviderSecrets(provider(), "s1").provider;
    assert.notEqual(again.apiKey, redacted.apiKey, "each call gets fresh placeholders");

    // Allowlist enforcement: unknown fields that might carry credentials are refused.
    assert.throws(
        () => redactProviderSecrets({ ...provider(), clientSecret: "top-secret" }, "s1"),
        (err) => isRemoteRuntimeError(err) && err.code === "REMOTE_RUNTIME_REFUSED",
    );
    assert.throws(
        () => redactProviderSecrets({ ...provider(), azure: { apiVersion: "2024-06-01", secretKey: "bad" } }, "s1"),
        (err) => isRemoteRuntimeError(err) && err.code === "REMOTE_RUNTIME_REFUSED",
    );
});

test("redactProviderSecrets: a bearer token provider answers with a placeholder; the real token stays on the worker", async () => {
    let calls = 0;
    const { provider: redacted, secrets } = redactProviderSecrets({ type: "openai", baseUrl: "https://m.example.test/v1", bearerTokenProvider: async () => `real-${++calls}` }, "s1");
    const placeholder = await redacted.bearerTokenProvider();
    assert.ok(containsWorkerPlaceholder(placeholder));
    assert.equal(await secrets.get(placeholder).resolve(), "real-1");
    assert.equal(await secrets.get(placeholder).resolve(), "real-2", "a fresh real token per request");
});

test("remoteSessionGrant: https only, plain http only for loopback, never a URL with credentials, query strings or fragments", () => {
    const secrets = new Map();
    const grant = remoteSessionGrant("https://models.example.test/v1/", secrets);
    assert.equal(grant.origin, "https://models.example.test");
    assert.equal(grant.pathPrefix, "/v1/");
    assert.equal(remoteSessionGrant("http://models.example.test/v1", secrets), null);
    assert.equal(remoteSessionGrant("http://localhost:8080/v1", secrets)?.origin, "http://localhost:8080");
    assert.equal(remoteSessionGrant("http://127.0.0.1:8080/v1", secrets)?.origin, "http://127.0.0.1:8080");
    assert.equal(remoteSessionGrant("http://[::1]:8080/v1", secrets)?.origin, "http://[::1]:8080");
    assert.equal(remoteSessionGrant("https://user:pw@models.example.test/v1", secrets), null);
    assert.equal(remoteSessionGrant("https://models.example.test/v1?api-key=secret", secrets), null);
    assert.equal(remoteSessionGrant("https://models.example.test/v1#frag", secrets), null);
    assert.equal(remoteSessionGrant("ftp://models.example.test/v1", secrets), null);
    assert.equal(remoteSessionGrant("not a url", secrets), null);
    assert.equal(remoteSessionGrant(undefined, secrets), null);
});

test("checkModelRequest: refuses another origin, a path outside the prefix, dot or encoded traversal, credentials in the URL and other methods", () => {
    const grant = remoteSessionGrant("https://models.example.test/v1", new Map());
    const post = (url, init = {}) => new Request(url, { method: "POST", body: "{}", ...init });
    assert.doesNotThrow(() => checkModelRequest(post("https://models.example.test/v1/chat/completions"), grant));
    assert.doesNotThrow(() => checkModelRequest(new Request("https://models.example.test/v1/models", { method: "GET" }), grant));
    assert.throws(() => checkModelRequest(post("https://other.example.test/v1/chat/completions"), grant), /refusing a model request to/);
    assert.throws(() => checkModelRequest(post("https://models.example.test/v2/chat/completions"), grant), /outside this session's model provider path/);
    assert.throws(() => checkModelRequest(post("https://models.example.test/v1/../v2/x"), grant), /outside this session's model provider path|refusing/);
    assert.throws(() => checkModelRequest(post("https://models.example.test/v1/%2e%2e/v2/x"), grant), /outside this session's model provider path|refusing/);
    assert.throws(() => checkModelRequest(post("https://models.example.test/v1/foo%2fbar"), grant), /outside this session's model provider path|refusing/);
    assert.throws(() => checkModelRequest(post("https://models.example.test:8443/v1/x"), grant), /refusing a model request to/);
    assert.throws(() => checkModelRequest(new Request("https://models.example.test/v1/x", { method: "DELETE" }), grant), /method DELETE/);
});

test("injectSecrets: swaps placeholders strictly in permitted headers and refuses relocated or unknown placeholders", async () => {
    const { provider: redacted, secrets } = redactProviderSecrets(provider(), "s1");
    const request = new Request("https://models.example.test/v1/x", {
        method: "POST",
        body: "{}",
        headers: { authorization: `Bearer ${redacted.apiKey}`, "x-api-token": redacted.headers["x-api-token"] },
    });
    const out = await injectSecrets(request, secrets);
    assert.equal(out.headers.get("authorization"), `Bearer ${REAL_KEY}`);
    assert.equal(out.headers.get("x-api-token"), REAL_HEADER);

    // Relocating a placeholder to an unauthorized header (e.g. user-agent or x-echo) is refused.
    const relocatedApiKey = new Request("https://models.example.test/v1/x", {
        method: "POST",
        body: "{}",
        headers: { "user-agent": `probe ${redacted.apiKey}` },
    });
    await assert.rejects(injectSecrets(relocatedApiKey, secrets), /not allowed in header/);

    const relocatedCustom = new Request("https://models.example.test/v1/x", {
        method: "POST",
        body: "{}",
        headers: { "x-echo": redacted.headers["x-api-token"] },
    });
    await assert.rejects(injectSecrets(relocatedCustom, secrets), /not allowed in header/);

    const foreign = new Request("https://models.example.test/v1/x", { method: "POST", body: "{}", headers: { authorization: "Bearer pilotswarm-worker-secret-apiKey-other-0000" } });
    await assert.rejects(injectSecrets(foreign, secrets), /credential placeholder this worker cannot resolve/);
    const plain = new Request("https://models.example.test/v1/x", { headers: { accept: "application/json" } });
    assert.equal(await injectSecrets(plain, secrets), plain, "a request with no placeholder passes through untouched");
});

test("RemoteRuntimeRequestHandler: enforces expectedSessionId binding, missing grant refusal, and WebSocket refusal", async () => {
    const { secrets } = redactProviderSecrets(provider(), "s1");
    const grant = remoteSessionGrant("https://models.example.test/v1", secrets);
    const scopedHandler = new RemoteRuntimeRequestHandler((sid) => (sid === "s1" ? grant : undefined), undefined, "s1");
    const request = new Request("https://models.example.test/v1/chat/completions", { method: "POST", body: "{}" });
    await assert.rejects(scopedHandler.sendRequest(request, context("s2")), /does not match this runtime's bound session/);

    const emptyHandler = new RemoteRuntimeRequestHandler(() => undefined);
    await assert.rejects(emptyHandler.sendRequest(request, context("nobody")), /no session on this runtime matches/);
    await assert.rejects(emptyHandler.openWebSocket(context()), /WebSocket/);
});

test("RemoteRuntimeRequestHandler: forwards inside the grant with the real credential and refuses a redirect to a live destination", async (t) => {
    const seen = [];
    const redirectHits = [];
    const redirectTarget = http.createServer((req, res) => {
        redirectHits.push({ url: req.url, authorization: req.headers.authorization });
        res.writeHead(200);
        res.end("leaked");
    });
    await new Promise((resolve) => redirectTarget.listen(0, "127.0.0.1", resolve));
    t.after(() => redirectTarget.close());

    const server = http.createServer((req, res) => {
        seen.push({ url: req.url, authorization: req.headers.authorization });
        if (req.url.startsWith("/v1/redirect")) {
            res.writeHead(302, { location: `http://127.0.0.1:${redirectTarget.address().port}/capture` });
            res.end();
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${server.address().port}/v1`;
    const { provider: redacted, secrets } = redactProviderSecrets({ type: "openai", baseUrl: base, apiKey: REAL_KEY }, "s1");
    const grant = remoteSessionGrant(base, secrets);
    const handler = new RemoteRuntimeRequestHandler((sessionId) => (sessionId === "s1" ? grant : undefined), undefined, "s1");
    const send = (path) => handler.sendRequest(
        new Request(`${base}${path}`, { method: "POST", body: "{}", headers: { authorization: `Bearer ${redacted.apiKey}`, "content-type": "application/json" } }),
        context("s1"),
    );
    const ok = await send("/chat/completions");
    assert.equal(ok.status, 200);
    assert.equal(seen[0].authorization, `Bearer ${REAL_KEY}`);
    await assert.rejects(send("/redirect"));
    assert.equal(seen.length, 2);
    assert.equal(redirectHits.length, 0, "the reachable redirect destination never received credentials");
});

test("parseSessionComputeTargetRef: exactly { targetId } with an opaque id", () => {
    assert.equal(parseSessionComputeTargetRef(undefined), undefined);
    assert.deepEqual({ ...parseSessionComputeTargetRef({ targetId: "target-1" }) }, { targetId: "target-1" });
    assert.throws(() => parseSessionComputeTargetRef({ targetId: "target-1", extra: true }), /exactly \{ targetId \}/);
    assert.throws(() => parseSessionComputeTargetRef({}), /exactly \{ targetId \}/);
    assert.throws(() => parseSessionComputeTargetRef({ targetId: "has space" }), /opaque id/);
    assert.throws(() => parseSessionComputeTargetRef({ targetId: "" }), /opaque id/);
    assert.throws(() => parseSessionComputeTargetRef(null), /exactly \{ targetId \}/);
    assert.throws(() => parseSessionComputeTargetRef("target-1"), /exactly \{ targetId \}/);
    assert.ok(COMPUTE_KIND_PATTERN.test("my-provider"));
    assert.ok(!COMPUTE_KIND_PATTERN.test("My Provider"));
});

test("assertRemoteRuntimeBinding and isRemoteRuntimeError: enforce typed fields", () => {
    const client = { createSession() {}, resumeSession() {} };
    assert.equal(assertRemoteRuntimeBinding({ client }).client, client);
    assert.throws(() => assertRemoteRuntimeBinding({}), (error) => isRemoteRuntimeError(error) && error.code === "REMOTE_RUNTIME_INVALID" && error.terminal === true);
    assert.throws(() => assertRemoteRuntimeBinding({ client: { createSession() {} } }), RemoteRuntimeError);
    assert.equal(isRemoteRuntimeError({ name: "RemoteRuntimeError" }), false, "name alone is not enough");
    assert.equal(isRemoteRuntimeError({ name: "RemoteRuntimeError", code: "BOGUS", terminal: true }), false);
    assert.equal(isRemoteRuntimeError({ name: "RemoteRuntimeError", code: "REMOTE_RUNTIME_REFUSED", terminal: true }), true);
});
