/**
 * Driving a remote agent runtime (docs/proposals/compute-providers.md): the
 * runtime gets credential placeholders, the worker's request handler swaps
 * them back; native session state remains beside the executor.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    RemoteRuntimeRequestHandler,
    checkModelRequest,
    containsWorkerPlaceholder,
    injectSecrets,
    redactProviderSecrets,
    remoteSessionGrant,
} from "../../dist/compute-runtime.js";

test("redaction replaces every credential with a per-session placeholder", async () => {
    const provider = {
        type: "openai",
        baseUrl: "https://example.invalid/openai",
        apiKey: "real-key",
        bearerToken: "real-bearer",
        headers: { "x-api-key": "header-secret" },
        bearerTokenProvider: async () => "fresh-token",
    };
    const { provider: redacted, secrets } = redactProviderSecrets(provider, "s1");
    assert.equal(redacted.baseUrl, provider.baseUrl);
    for (const field of ["apiKey", "bearerToken"]) {
        assert.notEqual(redacted[field], provider[field]);
        assert.ok(containsWorkerPlaceholder(redacted[field]));
        assert.match(redacted[field], /-s1-[0-9a-f]{32}$/);
    }
    assert.ok(containsWorkerPlaceholder(redacted.headers["x-api-key"]));
    assert.ok(containsWorkerPlaceholder(await redacted.bearerTokenProvider({ providerName: "default" })));
    assert.equal(JSON.stringify(redacted).includes("real-key"), false);
    assert.equal(secrets.size, 4);
    assert.equal(provider.apiKey, "real-key", "the original config is not changed");

    const other = redactProviderSecrets(provider, "s2").provider;
    assert.notEqual(other.apiKey, redacted.apiKey, "placeholders differ between sessions");
    const again = redactProviderSecrets(provider, "s1").provider;
    assert.notEqual(again.apiKey, redacted.apiKey, "placeholders differ between bindings of one session");
});

test("a grant pins a session's model requests to its provider's origin and path", () => {
    const grant = remoteSessionGrant("https://models.example.invalid/v1/", new Map());
    assert.deepEqual({ origin: grant.origin, pathPrefix: grant.pathPrefix }, { origin: "https://models.example.invalid", pathPrefix: "/v1/" });
    assert.equal(remoteSessionGrant(undefined, new Map()), null);
    assert.equal(remoteSessionGrant("file:///etc/passwd", new Map()), null);
    const ok = (url, init) => checkModelRequest(new Request(url, { method: "POST", ...init }), grant);
    ok("https://models.example.invalid/v1/chat/completions?api-version=1");
    ok("https://models.example.invalid/v1");
    for (const [url, why] of [
        ["https://attacker.example.invalid/v1/chat/completions", /refusing a model request to/],
        ["http://models.example.invalid/v1/chat/completions", /refusing a model request to/],
        ["https://models.example.invalid:8443/v1/chat/completions", /refusing a model request to/],
        ["http://169.254.169.254/metadata", /refusing a model request to/],
        ["https://models.example.invalid/admin", /outside this session's model provider path/],
        ["https://models.example.invalid/v10/chat", /outside this session's model provider path/],
    ]) {
        assert.throws(() => ok(url), why, url);
    }
    assert.throws(() => ok("https://models.example.invalid/v1/x", { method: "PUT" }), /method PUT/);
});

test("the request handler serves only sessions bound to its runtime, within their grant", async () => {
    const { provider, secrets } = redactProviderSecrets({ apiKey: "k1", baseUrl: "https://models.example.invalid/v1" }, "s1");
    const grant = remoteSessionGrant(provider.baseUrl, secrets);
    const handler = new RemoteRuntimeRequestHandler((sessionId) => sessionId === "s1" ? grant : undefined);
    const forged = new Request("https://models.example.invalid/v1/chat/completions", { method: "POST", headers: { "api-key": provider.apiKey } });
    await assert.rejects(handler.sendRequest(forged, { sessionId: "s2", transport: "http" }), /no session on this runtime matches/);
    await assert.rejects(handler.sendRequest(forged, { transport: "http" }), /no session on this runtime matches/);
    const elsewhere = new Request("https://attacker.example.invalid/v1/chat", { method: "POST", headers: { "api-key": provider.apiKey } });
    await assert.rejects(handler.sendRequest(elsewhere, { sessionId: "s1", transport: "http" }), /refusing a model request to/);
    await assert.rejects(handler.openWebSocket({ sessionId: "s1", transport: "websocket" }), /WebSocket/);
});

test("redaction of no provider is a no-op", () => {
    const { provider, secrets } = redactProviderSecrets(undefined, "s1");
    assert.equal(provider, undefined);
    assert.equal(secrets.size, 0);
});

test("the request handler swaps placeholders back, including fresh tokens", async () => {
    const { provider, secrets } = redactProviderSecrets({ apiKey: "k1", bearerTokenProvider: async () => "t-123" }, "s1");
    const placeholderToken = await provider.bearerTokenProvider({ providerName: "default" });
    const request = new Request("https://example.invalid/v1/chat/completions", {
        method: "POST",
        headers: { "api-key": provider.apiKey, authorization: `Bearer ${placeholderToken}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "m" }),
    });
    const out = await injectSecrets(request, secrets);
    assert.equal(out.headers.get("api-key"), "k1");
    assert.equal(out.headers.get("authorization"), "Bearer t-123");
    assert.equal(await out.text(), JSON.stringify({ model: "m" }));
});

test("a request without placeholders passes through unchanged", async () => {
    const request = new Request("https://example.invalid/x", { headers: { authorization: "Bearer plain" } });
    assert.equal(await injectSecrets(request, new Map()), request);
});

test("a placeholder the worker cannot resolve is refused, never sent", async () => {
    const { provider } = redactProviderSecrets({ apiKey: "k1" }, "other-session");
    const request = new Request("https://example.invalid/x", { headers: { "api-key": provider.apiKey } });
    await assert.rejects(injectSecrets(request, new Map()), /cannot resolve/);
});
