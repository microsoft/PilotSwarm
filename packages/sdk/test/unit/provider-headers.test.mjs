import test from "node:test";
import assert from "node:assert/strict";
import { ModelProviderRegistry } from "../../dist/model-providers.js";
import { buildRuntimeRegistry, loadProviderTypes, resolveProviderCredential } from "../../dist/provider-catalog.js";
import { SessionManager } from "../../dist/session-manager.js";

const HEADERS = { "Copilot-Integration-Id": "example-integration", "X-Route": "blue" };

const openai = (over = {}) => ({
    id: "chat", type: "openai", wireApi: "completions", baseUrl: "https://example.invalid/v1",
    models: ["chat-model"], ...over,
});

function credentialFor(typeId, over = {}) {
    return {
        name: `shared-${typeId}`, typeId, class: "shared", ownerUserId: null,
        baseUrl: null, secretRef: { kind: "apiKey", value: "instance-key" }, ...over,
    };
}

/**
 * The SDK provider for one model on every path a worker uses: the file's own
 * resolve(), resolveProviderCredential() for a database provider, the runtime
 * registry, and what SessionManager hands to the Copilot SDK.
 */
function resolveOnEveryPath(typeConfig, modelName, credential = credentialFor(typeConfig.id)) {
    const types = loadProviderTypes({ providers: [typeConfig] });
    const runtime = buildRuntimeRegistry(types, [credential], `${credential.name}:${modelName}`);
    const manager = new SessionManager(undefined, null, { modelProviders: runtime });
    return {
        credential: resolveProviderCredential(types, credential, modelName).sdkProvider,
        runtime: runtime.resolve(`${credential.name}:${modelName}`).sdkProvider,
        session: manager._resolveProviderConfig(`${credential.name}:${modelName}`).provider,
    };
}

test("a type's headers reach the SDK provider on every path", () => {
    const direct = new ModelProviderRegistry({ providers: [openai({ apiKey: "type-key", headers: HEADERS })] })
        .resolve("chat:chat-model").sdkProvider;
    assert.deepEqual(direct.headers, HEADERS);
    assert.equal(direct.apiKey, "type-key");
    for (const [name, provider] of Object.entries(resolveOnEveryPath(openai({ headers: HEADERS }), "chat-model"))) {
        assert.deepEqual(provider.headers, HEADERS, `${name} path`);
        assert.equal(provider.apiKey, "instance-key", `${name} path`);
        assert.equal(provider.wireApi, "completions", `${name} path`);
    }
});

test("a type without headers leaves the key out on every path", () => {
    for (const config of [openai(), openai({ headers: {} })]) {
        for (const [name, provider] of Object.entries(resolveOnEveryPath(config, "chat-model"))) {
            assert.equal(Object.hasOwn(provider, "headers"), false, `${name} path`);
        }
    }
});

test("every resolve hands out its own copy of the headers", () => {
    const types = loadProviderTypes({ providers: [openai({ headers: HEADERS })] });
    const credential = credentialFor("chat");
    const first = resolveProviderCredential(types, credential, "chat-model").sdkProvider;
    first.headers["X-Route"] = "green";
    first.headers.Authorization = "Bearer injected";
    assert.deepEqual(resolveProviderCredential(types, credential, "chat-model").sdkProvider.headers, HEADERS);
    assert.deepEqual(types.allProviders[0].headers, HEADERS);
});

test("a personal instance keeps the type's headers, whatever its row carries", () => {
    const personal = credentialFor("chat", {
        name: "my-chat", class: "personal", ownerUserId: "user-1", baseUrl: "https://elsewhere.invalid/v1",
        secretRef: { kind: "apiKey", value: "personal-key", headers: { "X-Route": "red" } },
        headers: { "X-Route": "red", "X-Extra": "1" },
    });
    for (const [name, provider] of Object.entries(resolveOnEveryPath(openai({ headers: HEADERS }), "chat-model", personal))) {
        assert.deepEqual(provider.headers, HEADERS, `${name} path`);
        assert.equal(provider.apiKey, "personal-key", `${name} path`);
        // The instance's own endpoint is honoured, and the headers go with it.
        // That is why a header value may never be a secret.
        assert.equal(provider.baseUrl, "https://elsewhere.invalid/v1", `${name} path`);
    }
});

test("headers ride on azure, anthropic and workload-identity providers too", () => {
    const azure = resolveOnEveryPath({
        id: "az", type: "azure", baseUrl: "https://example.invalid/openai", models: ["dep"], headers: HEADERS,
    }, "dep");
    for (const provider of Object.values(azure)) {
        assert.deepEqual(provider.headers, HEADERS);
        assert.match(provider.baseUrl, /\/deployments\/dep$/);
    }
    const anthropic = resolveOnEveryPath({
        id: "an", type: "anthropic", baseUrl: "https://example.invalid", models: ["anthropic-model"],
        headers: { "anthropic-beta": "example-feature" },
    }, "anthropic-model");
    for (const provider of Object.values(anthropic)) {
        assert.equal(provider.type, "anthropic");
        assert.deepEqual(provider.headers, { "anthropic-beta": "example-feature" });
    }
    const keyless = resolveOnEveryPath({
        id: "wif", type: "foundry-wif", baseUrl: "https://example.invalid/openai/v1", models: ["dep"], headers: HEADERS,
    }, "dep", credentialFor("wif", { secretRef: { kind: "workloadIdentity" } }));
    for (const provider of [keyless.credential, keyless.runtime]) {
        assert.deepEqual(provider.headers, HEADERS);
        assert.equal(Object.hasOwn(provider, "apiKey"), false);
    }
    assert.deepEqual(keyless.session.headers, HEADERS);
    assert.equal(typeof keyless.session.bearerTokenProvider, "function");
});

for (const [label, headers, pattern, type = "openai"] of [
    ["an array", ["X-Route: blue"], /expected an object/],
    ["a string", "X-Route: blue", /expected an object/],
    ["null", null, /expected an object/],
    ["a github provider", HEADERS, /native Copilot transport/, "github"],
    ["an empty name", { "": "x" }, /not a valid header name/],
    ["a name with a space", { "X Route": "blue" }, /not a valid header name/],
    ["a name with a colon", { "X-Route:": "blue" }, /not a valid header name/],
    ["Authorization", { Authorization: "Bearer x" }, /may not be set here/],
    ["authorization in lower case", { authorization: "Bearer x" }, /may not be set here/],
    ["api-key in mixed case", { "API-Key": "x" }, /may not be set here/],
    ["x-api-key", { "x-api-key": "x" }, /may not be set here/],
    ["Proxy-Authorization", { "Proxy-Authorization": "Basic x" }, /may not be set here/],
    ["Host", { Host: "elsewhere.invalid" }, /may not be set here/],
    ["Content-Type", { "Content-Type": "text/plain" }, /may not be set here/],
    ["one name twice in different case", { "X-Route": "blue", "x-route": "red" }, /appears twice/],
    ["a number value", { "X-Route": 5 }, /single-line string/],
    ["a value with a line break", { "X-Route": "blue\r\nX-Injected: 1" }, /single-line string/],
    ["an env: reference", { "X-Route": "env:ROUTE_SECRET" }, /env: reference/],
    ["an env: reference in another case", { "X-Route": " Env:ROUTE_SECRET" }, /env: reference/],
]) {
    test(`the catalog load refuses headers with ${label}`, () => {
        const config = { providers: [{ ...openai({ type, headers }), ...(type === "github" ? { baseUrl: undefined } : {}) }] };
        for (const load of [
            () => new ModelProviderRegistry(config),
            () => loadProviderTypes(config),
        ]) {
            assert.throws(load, error => {
                assert.match(error.message, /Invalid headers on provider "chat"/);
                assert.match(error.message, pattern);
                return true;
            });
        }
    });
}

test("a bad entry fails the load even when its provider has no key and would be dropped", () => {
    assert.throws(() => new ModelProviderRegistry({ providers: [
        openai({ headers: { Authorization: "Bearer x" } }),
        { id: "other", type: "openai", baseUrl: "https://example.invalid/v1", apiKey: "k", models: ["m"] },
    ] }), /Invalid headers on provider "chat"/);
});

test("the BYOK request shim keeps provider headers when it rewrites a request", async context => {
    const types = loadProviderTypes({ providers: [openai({ headers: HEADERS })] });
    const manager = new SessionManager(undefined, null, { modelProviders: types });
    const client = await manager.ensureClient(undefined, true);
    let forwarded;
    context.mock.method(globalThis, "fetch", async request => {
        forwarded = { headers: Object.fromEntries(request.headers), body: await request.json() };
        return new Response(JSON.stringify({ choices: [] }), { headers: { "content-type": "application/json" } });
    });
    // The runtime adds the provider's headers itself; the shim must not drop
    // them when it rebuilds the request to strip a field the provider rejects.
    await client.requestHandler.sendRequest(new Request("https://example.invalid/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "copilot-integration-id": "example-integration", "x-route": "blue" },
        body: JSON.stringify({ model: "chat-model", messages: [], snippy: { enabled: false } }),
    }), {});
    assert.equal(Object.hasOwn(forwarded.body, "snippy"), false);
    assert.equal(forwarded.headers["copilot-integration-id"], "example-integration");
    assert.equal(forwarded.headers["x-route"], "blue");
});
