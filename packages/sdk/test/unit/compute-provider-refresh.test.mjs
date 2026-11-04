import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { SessionManager } from "../../dist/session-manager.js";
import { ModelProviderRegistry } from "../../dist/model-providers.js";
import { containsWorkerPlaceholder } from "../../dist/compute-runtime.js";

async function fixture(t) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ps-provider-refresh-"));
    const forwarded = [];
    const server = http.createServer(async (req, res) => {
        for await (const _ of req) { /* consume the synthetic model request */ }
        forwarded.push(req.headers);
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"choices":[]}');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    const defaults = {};
    const manager = new SessionManager(undefined, null, defaults, home);
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
    // Admission/compute transport are outside this fixture. Everything from
    // effective model resolution through SDK config and HTTP brokerage is real.
    manager._prepareCompute = async () => ({
        endpoint: { transport: "uri", address: "127.0.0.1:1", connectionToken: "fixture" },
        endpointKey: "retained-fixture-endpoint", workspace: {},
        target: { name: "shared/fixture" }, provider: { capabilities: { files: "none" } },
    });
    const sdkCalls = [];
    const clients = new Set();
    const ensureClient = manager.ensureClient.bind(manager);
    manager.ensureClient = async (...args) => {
        const client = await ensureClient(...args);
        if (!clients.has(client)) {
            clients.add(client);
            client.start = undefined;
            const open = async (kind, config) => {
                sdkCalls.push({ kind, config, client });
                fs.mkdirSync(path.join(home, config.sessionId), { recursive: true });
                return { disconnect: async () => {} };
            };
            client.createSession = config => open("create", config);
            client.resumeSession = (id, config) => open("resume", config);
        }
        return client;
    };
    t.after(async () => {
        await manager.dropWarmSession("session");
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        fs.rmSync(home, { recursive: true, force: true });
    });
    const request = async provider => {
        const token = provider.bearerTokenProvider ? await provider.bearerTokenProvider({ providerName: "default" }) : provider.bearerToken;
        const response = await sdkCalls.at(-1).client.requestHandler.sendRequest(new Request(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                ...(provider.apiKey ? { "api-key": provider.apiKey } : {}),
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...provider.headers,
            },
            body: '{"model":"fixture","messages":[]}',
        }), { sessionId: "session", transport: "http" });
        await response.text();
        assert.equal(response.status, 200);
        return forwarded.at(-1);
    };
    return { manager, defaults, baseUrl, sdkCalls, request };
}

test("A -> B on a retained endpoint forwards the selected key/project/options on warm rebind and cold resume", async t => {
    const h = await fixture(t);
    const catalog = (key, project = "fixture-project-b") => new ModelProviderRegistry({ providers: [
        { id: "a", type: "openai", wireApi: "completions", baseUrl: h.baseUrl, apiKey: "fixture-key-a",
            headers: { "X-Project": "fixture-project-a" }, models: ["fixture"] },
        { id: "b", type: "openai", wireApi: "completions", baseUrl: h.baseUrl, apiKey: key,
            headers: { "X-Project": project }, models: ["fixture"] },
    ] });
    h.defaults.modelProviders = catalog("fixture-key-b");
    const first = await h.manager.getOrCreate("session", { model: "a:fixture", admittedModel: "a:fixture" }, { turnIndex: 0 });
    const original = h.sdkCalls.at(-1).config.provider;
    assert.equal((await h.request(original))["api-key"], "fixture-key-a");
    const warm = await h.manager.getOrCreate("session", { model: "a:fixture", admittedModel: "a:fixture" }, { turnIndex: 1 });
    assert.equal(warm, first, "unchanged effective config retains the SDK handle");
    const selected = await h.manager.getOrCreate("session", { model: "b:fixture", admittedModel: "b:fixture" }, { turnIndex: 2 });
    assert.equal(selected.config.model, "b:fixture");
    assert.equal(selected.config.admittedModel, "b:fixture", "the effective model keeps the admitted provider identity");
    const b = h.sdkCalls.at(-1).config.provider;
    const seenB = await h.request(b);
    assert.equal(seenB["api-key"], "fixture-key-b");
    assert.equal(seenB["x-project"], "fixture-project-b");
    assert.equal(b.apiKey, original.apiKey, "stable host stand-ins survive a same-endpoint rebind");
    assert.ok(containsWorkerPlaceholder(b.apiKey));
    assert.equal(JSON.stringify(b).includes("fixture-key"), false);
    assert.equal(JSON.stringify(b).includes("fixture-project"), false);

    h.defaults.modelProviders = catalog("fixture-key-warm-rotation", "fixture-project-rotated");
    const rotated = await h.manager.getOrCreate("session", { model: "b:fixture", admittedModel: "b:fixture" }, { turnIndex: 3 });
    assert.notEqual(rotated, selected);
    const seenRotated = await h.request(h.sdkCalls.at(-1).config.provider);
    assert.equal(seenRotated["api-key"], "fixture-key-warm-rotation");
    assert.equal(seenRotated["x-project"], "fixture-project-rotated");
    assert.equal((await h.request(original))["api-key"], "fixture-key-warm-rotation",
        "same-endpoint stand-ins never retain the previous provider's authority");
    await h.manager.dropWarmSession("session");
    h.defaults.modelProviders = catalog("fixture-key-rotated");
    const resumed = await h.manager.getOrCreate("session", { model: "b:fixture", admittedModel: "b:fixture" }, { turnIndex: 4 });
    assert.equal(resumed.config.model, "b:fixture");
    assert.equal(h.sdkCalls.at(-1).kind, "resume");
    assert.equal((await h.request(h.sdkCalls.at(-1).config.provider))["api-key"], "fixture-key-rotated");
});

test("current token callbacks replace old authority without recycling a warm SDK handle", async t => {
    const h = await fixture(t);
    const contexts = [];
    const provider = (token, version) => ({
        type: "openai", wireApi: "completions", baseUrl: h.baseUrl,
        bearerTokenProvider: async context => { contexts.push(context); return token; },
        apiVersion: version,
    });
    h.defaults.provider = provider("fixture-token-a", "one");
    const first = await h.manager.getOrCreate("session", { model: "fixture" }, { turnIndex: 0 });
    const original = h.sdkCalls.at(-1).config.provider;
    assert.equal((await h.request(original)).authorization, "Bearer fixture-token-a");
    h.defaults.provider = provider("fixture-token-b", "one");
    const warm = await h.manager.getOrCreate("session", { model: "fixture" }, { turnIndex: 1 });
    assert.equal(warm, first);
    assert.equal(h.sdkCalls.length, 1);
    assert.equal((await h.request(original)).authorization, "Bearer fixture-token-b",
        "the already-held host callback must resolve to the current worker token callback");
    assert.deepEqual(contexts, [{ providerName: "default" }, { providerName: "default" }]);
    h.defaults.provider = provider("fixture-token-c", "two");
    const changed = await h.manager.getOrCreate("session", { model: "fixture" }, { turnIndex: 2 });
    assert.notEqual(changed, warm, "provider request options trigger a rebind");
    assert.equal(h.sdkCalls.at(-1).config.provider.apiVersion, "two");
    assert.equal((await h.request(h.sdkCalls.at(-1).config.provider)).authorization, "Bearer fixture-token-c");
    await h.manager.dropWarmSession("session");
    h.defaults.provider = provider("fixture-token-d", "three");
    await h.manager.getOrCreate("session", { model: "fixture" }, { turnIndex: 3 });
    assert.equal(h.sdkCalls.at(-1).config.provider.apiVersion, "three");
    assert.equal((await h.request(h.sdkCalls.at(-1).config.provider)).authorization, "Bearer fixture-token-d");
});

test("adding/removing token callbacks rebinds SDK config and revokes removed stand-ins", async t => {
    const h = await fixture(t);
    const plain = { type: "openai", wireApi: "completions", baseUrl: h.baseUrl };
    h.defaults.provider = plain;
    const first = await h.manager.getOrCreate("session", { model: "fixture" }, { turnIndex: 0 });
    h.defaults.provider = { ...plain, bearerTokenProvider: async () => "fixture-token" };
    const token = await h.manager.getOrCreate("session", { model: "fixture" }, { turnIndex: 1 });
    assert.notEqual(token, first);
    const hostProvider = h.sdkCalls.at(-1).config.provider;
    assert.equal((await h.request(hostProvider)).authorization, "Bearer fixture-token");
    h.defaults.provider = plain;
    const removed = await h.manager.getOrCreate("session", { model: "fixture" }, { turnIndex: 2 });
    assert.notEqual(removed, token);
    assert.equal(h.sdkCalls.at(-1).config.provider.bearerTokenProvider, undefined);
    await assert.rejects(h.request(hostProvider), /cannot resolve/);
    assert.equal((await h.request(h.sdkCalls.at(-1).config.provider)).authorization, undefined);
});

test("provider option changes rebind even when a legacy session leaves the model implicit", async t => {
    const h = await fixture(t);
    h.defaults.provider = { type: "openai", wireApi: "completions", baseUrl: h.baseUrl, apiKey: "fixture-key", apiVersion: "one" };
    const first = await h.manager.getOrCreate("session", {}, { turnIndex: 0 });
    h.defaults.provider = { ...h.defaults.provider, apiVersion: "two" };
    const next = await h.manager.getOrCreate("session", {}, { turnIndex: 1 });
    assert.notEqual(next, first, "provider options are SDK creation options, even without an explicit model");
    assert.equal(h.sdkCalls.at(-1).config.provider.apiVersion, "two");
    assert.equal((await h.request(h.sdkCalls.at(-1).config.provider))["api-key"], "fixture-key");
});
