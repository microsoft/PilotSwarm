import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ByokRequestCompatibility, createCopilotClient, needsByokRequestCompatibility } from "../../dist/copilot-client.js";
import { ModelProviderRegistry } from "../../dist/model-providers.js";
import { assertUniqueRuntimeTools, replaceRuntimeToolDeclarations, resolveCopilotContextTier, resolveCopilotReasoningEffort, SessionManager, validateCopilotRuntimeSessionInput } from "../../dist/session-manager.js";
import { createCopilotProviderServer } from "../helpers/copilot-provider-server.mjs";

const TOOL_CATALOG = { maxDeclarations: 128, overflowStrategy: "typed-dispatch" };

test("the checked-in catalog demonstrates an explicit opt-in without enabling native providers", () => {
    const catalog = JSON.parse(readFileSync(new URL("../../../../.model_providers.example.json", import.meta.url), "utf8"));
    const registry = new ModelProviderRegistry(catalog, { keepUncredentialed: true });
    assert.deepEqual(registry.getDescriptor("azure-openai:gpt-5.4").toolCatalog, TOOL_CATALOG);
    for (const descriptor of registry.allModels.filter(model => model.providerType === "github" || model.providerType.startsWith("anthropic"))) {
        assert.equal(descriptor.toolCatalog, undefined);
    }
});

test("explicit overflow opt-in is rejected on incompatible native provider paths", () => {
    for (const provider of [{ type: "github" }, { type: "anthropic" }, { type: "openai", wireApi: "responses" }]) {
        assert.throws(() => createCopilotClient({ useLoggedInUser: false }, provider, TOOL_CATALOG), /requires an OpenAI-compatible Chat Completions/);
    }
});

test("tool catalog opt-in is validated and stays outside native SDK provider configuration", () => {
    const toolCatalog = { maxDeclarations: 128, overflowStrategy: "typed-dispatch" };
    const provider = { id: "direct", type: "openai", apiKey: "synthetic-key", baseUrl: "https://example.invalid", models: [
        { name: "primitive", toolCatalog },
        { name: "model-router" },
    ] };
    const registry = new ModelProviderRegistry({ providers: [provider] });
    assert.deepEqual(registry.getDescriptor("direct:primitive").toolCatalog, toolCatalog);
    assert.deepEqual(registry.resolve("direct:primitive").toolCatalog, toolCatalog);
    assert.equal(registry.resolve("direct:primitive").sdkProvider.toolCatalog, undefined);
    assert.equal(registry.getDescriptor("direct:model-router").toolCatalog, undefined);
    for (const invalid of [null, true, [], {}, { ...toolCatalog, maxDeclarations: 0 }, { ...toolCatalog, maxDeclarations: 1.5 },
        { ...toolCatalog, overflowStrategy: "drop" }, { ...toolCatalog, enabled: true }]) {
        assert.throws(() => new ModelProviderRegistry({ providers: [{ ...provider, models: [{ name: "bad", toolCatalog: invalid }] }] }), /Invalid toolCatalog on direct:bad/);
    }
    for (const unsupported of [
        { ...provider, wireApi: "responses" },
        { ...provider, wireApi: "websockets" },
        { ...provider, type: "anthropic" },
        { ...provider, type: "github" },
    ]) {
        assert.throws(() => new ModelProviderRegistry({ providers: [{ ...unsupported, models: [{ name: "bad", toolCatalog }] }] }), /typed-dispatch requires/);
    }
});

test("published dependencies pin the tested SDK and CLI, not just the workspace lock", () => {
    const { dependencies } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    assert.equal(dependencies["@github/copilot-sdk"], "1.0.34");
    assert.equal(dependencies["@github/copilot"], "1.0.112");
});

test("runtime tool declarations fail on duplicate names instead of silently discarding one", () => {
    const first = { name: "shared" };
    assert.equal(assertUniqueRuntimeTools([first, { name: "other" }])[0], first);
    assert.throws(() => assertUniqueRuntimeTools([first, { name: "shared" }]), /duplicate names: shared/);
});

test("catalog-backed declarations replace provider stubs without dropping other system tools", () => {
    const providerStub = { name: "list_providers", handler: "stub" };
    const providerLive = { name: "list_providers", handler: "catalog" };
    const replaced = replaceRuntimeToolDeclarations([
        { name: "wait", handler: "stub" }, providerStub,
    ], [providerLive]);
    assert.deepEqual(replaced.map(tool => tool.name), ["wait", "list_providers"]);
    assert.equal(replaced.at(-1), providerLive);
    assert.equal(assertUniqueRuntimeTools([...replaced, { name: "read_facts" }]).length, 3);
});

test("tier-less catalog entries leave the context tier to runtime 1.0.112", () => {
    assert.equal(resolveCopilotContextTier({ modelName: "claude-haiku-5-5" }), undefined);
    assert.equal(resolveCopilotContextTier({
        modelName: "tiered",
        supportedContextTiers: ["default", "long_context"],
        defaultContextTier: "long_context",
    }), "long_context");
    assert.equal(resolveCopilotContextTier({
        modelName: "tiered",
        supportedContextTiers: ["default", "long_context"],
        defaultContextTier: "default",
    }, "long_context"), "long_context");
});

test("stale model settings are removed before runtime validation on tier-less catalog entries", () => {
    const plain = { modelName: "plain" };
    assert.equal(resolveCopilotReasoningEffort(plain, "high"), undefined);
    assert.equal(resolveCopilotContextTier(plain, "long_context"), undefined);
    assert.equal(resolveCopilotReasoningEffort({
        modelName: "tiered", supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium",
    }, "high"), "medium");
});

test("a model switch preserves compatible settings and clears only unsupported inherited settings", async () => {
    const registry = new ModelProviderRegistry({ providers: [{
        id: "direct", type: "openai", apiKey: "synthetic", baseUrl: "https://example.invalid/v1", models: [
            { name: "tiered", supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium",
                supportedContextTiers: ["default", "long_context"], defaultContextTier: "default" },
            { name: "plain", supportedReasoningEfforts: ["low"] },
        ],
    }] });
    const manager = new SessionManager(undefined, null, { modelProviders: registry });
    manager.sessionCatalog = { getSession: async () => ({ reasoningEffort: "medium", contextTier: "long_context" }) };
    assert.deepEqual(await manager.resolveModelSwitchConfigForSession("session", "direct:tiered"), {
        model: "direct:tiered",
    });
    manager.sessionCatalog = { getSession: async () => ({ reasoningEffort: "medium", contextTier: "long_context" }) };
    assert.deepEqual(await manager.resolveModelSwitchConfigForSession("session", "direct:plain"), {
        model: "direct:plain", reasoningEffort: null, contextTier: null,
    });
});

test("strict runtime inputs are rejected before session create", () => {
    const registry = new ModelProviderRegistry({ providers: [{
        id: "direct", type: "openai", apiKey: "synthetic", baseUrl: "https://example.invalid/v1", models: [
            { name: "plain" },
            { name: "tiered", supportedReasoningEfforts: ["high"], supportedContextTiers: ["default", "long_context"] },
        ],
    }] });
    const manager = new SessionManager(undefined, null, { modelProviders: registry });
    assert.throws(() => manager.normalizeModelRef("direct:missing"), /Unknown model "direct:missing"/);
    assert.throws(() => validateCopilotRuntimeSessionInput({ workingDirectory: "relative/path" }), /must be absolute/);
    assert.throws(() => validateCopilotRuntimeSessionInput({ reasoningEffort: "none" }, registry.getDescriptor("direct:plain")), /does not support reasoning effort 'none'/);
    assert.throws(() => validateCopilotRuntimeSessionInput({ contextTier: "long_context" }, registry.getDescriptor("direct:plain")), /does not support context tier 'long_context'/);
    assert.doesNotThrow(() => validateCopilotRuntimeSessionInput({}, registry.getDescriptor("direct:plain")), "a tier-less catalog entry leaves context tier to the runtime default");
    assert.doesNotThrow(() => validateCopilotRuntimeSessionInput({
        workingDirectory: "/absolute/path", reasoningEffort: "high", contextTier: "long_context",
    }, registry.getDescriptor("direct:tiered")));
});

test("only opted-in OpenAI/Azure completions clients get catalog adaptation; native transports are untouched", () => {
    for (const provider of [undefined, null, { type: "github" }, { type: "anthropic" }, { type: "openai", wireApi: "responses" }, { type: "azure", wireApi: "responses" }]) {
        assert.equal(needsByokRequestCompatibility(provider), false);
        const client = createCopilotClient({ useLoggedInUser: false }, provider);
        assert.equal(client.requestHandler, null);
        assert.equal(client.connectionConfig.kind, "stdio");
        assert.throws(() => createCopilotClient({ useLoggedInUser: false }, provider, TOOL_CATALOG), /requires an OpenAI-compatible Chat Completions/);
    }
    for (const provider of [{}, { type: "openai" }, { type: "azure" }, { type: "openai", wireApi: "completions" }]) {
        assert.equal(needsByokRequestCompatibility(provider), true);
        const client = createCopilotClient({ useLoggedInUser: false }, provider);
        assert.equal(client.requestHandler, null);
        const adapted = createCopilotClient({ useLoggedInUser: false }, provider, TOOL_CATALOG);
        assert.ok(adapted.requestHandler instanceof ByokRequestCompatibility);
        assert.equal(adapted.connectionConfig.kind, "stdio");
    }
});

test("catalog adaptation preserves an upstream snippy field when no overflow is configured", async t => {
    const body = '{"model":"gpt-5.6-terra","snippy":{"enabled":false},"tools":[]}';
    const request = new Request("https://example.invalid/chat/completions", {
        method: "POST", headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }, body,
    });
    t.mock.method(globalThis, "fetch", async forwarded => {
        assert.equal(forwarded, request);
        assert.equal(await forwarded.text(), body);
        return new Response("ok");
    });
    const result = await new ByokRequestCompatibility().sendRequest(request, { signal: new AbortController().signal });
    assert.equal(result.status, 200);
});

for (const [path, type, body] of [
    ["/responses", "application/json", '{"snippy":false}'],
    ["/messages", "application/json", '{"snippy":false}'],
    ["/chat/completions-other", "application/json", '{"snippy":false}'],
    ["/chat/completions", "text/plain", "snippy"],
    ["/chat/completions", "application/json", "not JSON"],
    ["/chat/completions", "application/json", '{"snippy":false}'],
    ["/chat/completions", "application/json", '[{"snippy":false}]'],
    ["/chat/completions", "application/json", '{"model":"x","future_field":1}'],
]) {
    test(`pass-through remains byte-identical: ${path} ${body}`, async t => {
        const request = new Request("https://example.invalid" + path, { method: "POST", headers: { "content-type": type }, body });
        t.mock.method(globalThis, "fetch", async forwarded => {
            assert.equal(forwarded, request);
            assert.equal(await forwarded.text(), body);
            return new Response("upstream validation error", { status: 400 });
        });
        const result = await new ByokRequestCompatibility().sendRequest(request, { signal: new AbortController().signal });
        assert.equal(result.status, 400);
    });
}

test("cancellation propagates instead of resending the model request", async t => {
    const controller = new AbortController();
    controller.abort(new Error("test cancellation"));
    const fetch = t.mock.method(globalThis, "fetch", async (_request, { signal }) => { throw signal.reason; });
    const request = new Request("https://example.invalid/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: '{"snippy":false}' });
    await assert.rejects(new ByokRequestCompatibility().sendRequest(request, { signal: controller.signal }), /test cancellation/);
    assert.equal(fetch.mock.callCount(), 1);
});

function catalogTools(count) {
    return Array.from({ length: count }, (_, index) => ({
        type: "function",
        function: {
            name: `catalog_tool_${index}`,
            description: `Read-only tool ${index}`,
            parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
        },
    }));
}

function catalogRequest(body) {
    return new Request("https://example.invalid/chat/completions", {
        method: "POST", headers: { "content-type": "application/json", "x-test": "keep" }, body: JSON.stringify({ model: "model-router", ...body }),
    });
}

function jsonResponse(body) {
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "x-request-id": "request-42" } });
}

for (const count of [82, 128, 129, 201, 256]) {
    test(`dispatcher root schema is accepted by a bounded local provider with ${count} logical tools`, async context => {
        const server = await createCopilotProviderServer({ maxTools: 128 });
        context.after(() => server.close());
        const request = new Request(`${server.baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                model: "schema-regression",
                messages: [{ role: "user", content: "Validate the tool schema without invoking a tool." }],
                tools: catalogTools(count),
            }),
        });
        const response = await new ByokRequestCompatibility(TOOL_CATALOG).sendRequest(request, {});
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal(server.requests.length, 1);
        const wire = server.requests[0].body.tools;
        assert.equal(wire.length, Math.min(count, 128));
        if (count > 128) {
            const schema = wire.at(-1).function.parameters;
            assert.equal(schema.type, "object");
            for (const keyword of ["oneOf", "anyOf", "allOf", "enum", "const", "not"]) {
                assert.equal(Object.hasOwn(schema, keyword), false, `${keyword} must not appear at the schema root`);
            }
        }
    });
}

for (const model of ["gpt-5.6-terra", "gpt-4o", "model-router", "model-router-128k-openai", "model-router-272k-openai", "model-router-922k-openai", "model-router-preview", "model-router-128k-claude", "model-router-128-openai", "custom-model-router", "MODEL-ROUTER", undefined, null]) {
    test(`models without opt-in keep oversized catalogs and responses unchanged: ${model}`, async context => {
        const request = catalogRequest({ model, tools: catalogTools(139) });
        const original = await request.clone().text();
        const response = jsonResponse({ choices: [] });
        context.mock.method(globalThis, "fetch", async forwarded => {
            assert.equal(forwarded, request);
            assert.equal(await forwarded.text(), original);
            return response;
        });
        assert.equal(await new ByokRequestCompatibility().sendRequest(request, {}), response);
    });
}

for (const model of ["gpt-5.4", "primitive-model", "custom-deployment", "model-router", "model-router-128k-openai", "model-router-272k-openai", "model-router-922k-openai"]) {
    test(`${model} groups an oversized catalog only with explicit opt-in`, async context => {
        const request = catalogRequest({ model, tools: catalogTools(129) });
        context.mock.method(globalThis, "fetch", async forwarded => {
            const wire = await forwarded.json();
            assert.equal(wire.model, model);
            assert.equal(wire.tools.length, 128);
            assert.equal(wire.tools.at(-1).function.name, "pilotswarm_tool_dispatch");
            return jsonResponse({ choices: [] });
        });
        await new ByokRequestCompatibility(TOOL_CATALOG).sendRequest(request, {});
    });
}

for (const maxDeclarations of [1, 8, 128]) {
    test(`dispatch honors the configured ${maxDeclarations}-declaration limit`, async context => {
        const policy = { ...TOOL_CATALOG, maxDeclarations };
        context.mock.method(globalThis, "fetch", async forwarded => {
            const wire = await forwarded.json();
            assert.equal(wire.tools.length, maxDeclarations);
            assert.equal(wire.tools.at(-1).function.parameters.properties.call.anyOf.length, 5);
            return jsonResponse({ choices: [] });
        });
        await new ByokRequestCompatibility(policy).sendRequest(catalogRequest({ model: "primitive", tools: catalogTools(maxDeclarations + 4) }), {});
    });
}

test("a shared handler resolves policy per request without leaking opt-in between sessions", async context => {
    const policies = new Map([["opted-in", TOOL_CATALOG]]);
    const handler = new ByokRequestCompatibility((request, requestContext, model) =>
        request.url.startsWith("https://example.invalid/") && model === "primitive"
            ? policies.get(requestContext.sessionId) : undefined);
    const cases = [
        ["opted-in", "primitive", 128],
        ["disabled", "primitive", 139],
        [undefined, "primitive", 139],
        ["opted-in", "different-model", 139],
    ];
    for (const [sessionId, model, expectedCount] of cases) {
        context.mock.method(globalThis, "fetch", async forwarded => {
            assert.equal((await forwarded.json()).tools.length, expectedCount);
            return jsonResponse({ choices: [] });
        });
        await handler.sendRequest(catalogRequest({ model, tools: catalogTools(139) }), { sessionId });
    }
    policies.delete("opted-in");
    context.mock.method(globalThis, "fetch", async forwarded => {
        assert.equal((await forwarded.json()).tools.length, 139);
        return jsonResponse({ choices: [] });
    });
    await handler.sendRequest(catalogRequest({ model: "primitive", tools: catalogTools(139) }), { sessionId: "opted-in" });
});

test("models without catalog opt-in keep oversized strict catalogs and upstream fields byte-identical", async context => {
    const body = {
        model: "gpt-5.6-terra",
        snippy: { enabled: false },
        tools: catalogTools(139).map(tool => ({ ...tool, function: { ...tool.function, strict: true } })),
        tool_choice: { type: "allowed_tools", allowed_tools: { mode: "auto", tools: [{ type: "function", function: { name: "catalog_tool_138" } }] } },
    };
    const request = catalogRequest(body);
    const response = jsonResponse({ choices: [] });
    context.mock.method(globalThis, "fetch", async forwarded => {
        assert.equal(forwarded, request);
        return response;
    });
    assert.equal(await new ByokRequestCompatibility().sendRequest(request, {}), response);
});

for (const count of [0, 127, 128]) {
    test(`a ${count}-tool catalog remains byte-identical without a dispatcher`, async context => {
        const request = catalogRequest({ model: "model-router", tools: catalogTools(count) });
        const response = jsonResponse({ choices: [] });
        context.mock.method(globalThis, "fetch", async forwarded => {
            assert.equal(forwarded, request);
            return response;
        });
        assert.equal(await new ByokRequestCompatibility(TOOL_CATALOG).sendRequest(request, {}), response);
    });
}

for (const count of [129, 139, 200, 201, 256]) {
    test(`${count} tools retain every schema and restore every overflow call`, async context => {
        const tools = catalogTools(count);
        const body = { model: "model-router", tools, messages: [{ role: "user", content: "Preserve this prompt" }], future_field: { keep: true } };
        const request = catalogRequest(body);
        let expected;
        context.mock.method(globalThis, "fetch", async forwarded => {
            const wire = await forwarded.json();
            assert.equal(wire.tools.length, 128);
            assert.deepEqual(wire.messages, body.messages);
            assert.deepEqual(wire.future_field, body.future_field);
            assert.equal(forwarded.headers.get("x-test"), "keep");
            const dispatcher = wire.tools.at(-1).function;
            assert.deepEqual(dispatcher.parameters.required, ["call"]);
            assert.equal(dispatcher.parameters.additionalProperties, false);
            const alternatives = dispatcher.parameters.properties.call.anyOf;
            const retained = wire.tools.slice(0, -1);
            for (const alternative of alternatives) {
                const original = tools.find(tool => tool.function.name === alternative.properties.tool_name.enum[0]);
                assert.deepEqual(alternative.properties.arguments, original.function.parameters);
                assert.equal(alternative.description, original.function.description);
                retained.push(original);
            }
            assert.deepEqual(retained, tools);
            expected = alternatives.map((alternative, index) => ({
                id: `call-${index}`, type: "function",
                function: { name: alternative.properties.tool_name.enum[0], arguments: JSON.stringify({ value: `value-${index}` }) },
            }));
            return jsonResponse({
                id: "response-42", model: "model-router", usage: { prompt_tokens: 100, completion_tokens: 10 },
                choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: expected.map(call => ({
                    ...call, function: { name: dispatcher.name, arguments: JSON.stringify({ call: { tool_name: call.function.name, arguments: JSON.parse(call.function.arguments) } }) },
                })) } }],
            });
        });
        const response = await new ByokRequestCompatibility(TOOL_CATALOG).sendRequest(request, {});
        const result = await response.json();
        assert.deepEqual(result.choices[0].message.tool_calls, expected);
        assert.deepEqual(result.usage, { prompt_tokens: 100, completion_tokens: 10 });
        assert.equal(response.headers.get("x-request-id"), "request-42");
        assert.deepEqual(await request.json(), body);
    });
}

test("forced and strict tools stay direct, names cannot collide, and history keeps call IDs", async context => {
    const tools = catalogTools(139);
    tools[0].function.name = "pilotswarm_tool_dispatch";
    tools[1].function.strict = true;
    const forced = tools.at(-1).function.name;
    const historic = tools.at(-2).function.name;
    const body = {
        tools, tool_choice: { type: "function", function: { name: forced } },
        messages: [
            { role: "assistant", tool_calls: [{ id: "history-id", type: "function", function: { name: historic, arguments: '{"value":"historic"}' } }] },
            { role: "tool", tool_call_id: "history-id", content: "original result" },
            { role: "assistant", tool_calls: [{ id: "failed-id", type: "function", function: { name: historic, arguments: "incomplete{" } }] },
        ],
    };
    context.mock.method(globalThis, "fetch", async request => {
        const wire = await request.json();
        assert.deepEqual(wire.tool_choice, body.tool_choice);
        assert.ok(wire.tools.some(tool => tool.function.name === forced));
        assert.deepEqual(wire.tools.find(tool => tool.function.strict), tools[1]);
        const dispatcher = wire.tools.at(-1).function;
        assert.equal(dispatcher.name, "pilotswarm_tool_dispatch_1");
        assert.equal(wire.messages[0].tool_calls[0].id, "history-id");
        assert.equal(wire.messages[0].tool_calls[0].function.name, dispatcher.name);
        assert.deepEqual(JSON.parse(wire.messages[0].tool_calls[0].function.arguments), { call: { tool_name: historic, arguments: { value: "historic" } } });
        assert.deepEqual(wire.messages[1], body.messages[1]);
        assert.deepEqual(wire.messages[2], body.messages[2]);
        return jsonResponse({ choices: [] });
    });
    await new ByokRequestCompatibility(TOOL_CATALOG).sendRequest(catalogRequest(body), {});
});

test("an oversized all-strict catalog is rejected before transport rather than weakened or truncated", async context => {
    const tools = catalogTools(139).map(tool => ({ ...tool, function: { ...tool.function, strict: true } }));
    const fetch = context.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected transport"); });
    await assert.rejects(new ByokRequestCompatibility(TOOL_CATALOG).sendRequest(catalogRequest({ tools }), {}), /strict or unsupported/);
    assert.equal(fetch.mock.callCount(), 0);
});

test("unrecognized tool options remain intact outside the dispatch schema", async context => {
    const tools = catalogTools(139);
    tools.at(-1).function.future_option = { keep: true };
    tools.at(-2).future_option = { keep: true };
    context.mock.method(globalThis, "fetch", async request => {
        const wire = await request.json();
        assert.equal(wire.tools.length, 128);
        for (const original of tools.slice(-2)) {
            assert.deepEqual(wire.tools.find(tool => tool.function.name === original.function.name), original);
        }
        return jsonResponse({ choices: [] });
    });
    await new ByokRequestCompatibility(TOOL_CATALOG).sendRequest(catalogRequest({ tools }), {});
});

test("schemas with document-relative references remain direct instead of changing resolution", async context => {
    const tools = catalogTools(139);
    tools.at(-1).function.parameters = {
        type: "object",
        properties: { value: { $ref: "#/$defs/value" } },
        $defs: { value: { type: "string" } },
        required: ["value"],
    };
    tools.at(-2).function.parameters.properties.value = { $dynamicRef: "#value" };
    tools.at(-3).function.parameters.$id = "https://example.invalid/tool-schema";
    context.mock.method(globalThis, "fetch", async request => {
        const wire = await request.json();
        assert.equal(wire.tools.length, 128);
        for (const original of tools.slice(-3)) {
            assert.deepEqual(wire.tools.find(tool => tool.function.name === original.function.name), original);
        }
        return jsonResponse({ choices: [] });
    });
    await new ByokRequestCompatibility(TOOL_CATALOG).sendRequest(catalogRequest({ tools }), {});
});

test("restricted tool-choice lists fail closed instead of being broadened by grouping", async context => {
    const fetch = context.mock.method(globalThis, "fetch", async () => jsonResponse({ choices: [] }));
    await assert.rejects(new ByokRequestCompatibility(TOOL_CATALOG).sendRequest(catalogRequest({
        tools: catalogTools(139),
        tool_choice: { type: "allowed_tools", allowed_tools: { mode: "auto", tools: [{ type: "function", function: { name: "catalog_tool_138" } }] } },
    }), {}), /restricted or unsupported tool choice/);
    assert.equal(fetch.mock.callCount(), 0);
});

for (const args of [
    "{", "{}",
    '{"tool_name":"catalog_tool_138","arguments":{}}',
    '{"call":[]}',
    '{"call":{"tool_name":"not_in_catalog","arguments":{}}}',
    '{"call":{"tool_name":"catalog_tool_138","arguments":[]}}',
    '{"call":{"tool_name":"catalog_tool_138"}}',
    '{"call":{"tool_name":"catalog_tool_138","arguments":{},"extra":true}}',
    '{"call":{"tool_name":"catalog_tool_138","arguments":{}},"extra":true}',
]) {
    test(`malformed or out-of-catalog dispatch arguments are rejected: ${args}`, async context => {
        context.mock.method(globalThis, "fetch", async request => {
            const wire = await request.json();
            return jsonResponse({ choices: [{ message: { tool_calls: [{ id: "invalid-call", type: "function", function: { name: wire.tools.at(-1).function.name, arguments: args } }] } }] });
        });
        await assert.rejects(new ByokRequestCompatibility(TOOL_CATALOG).sendRequest(catalogRequest({ tools: catalogTools(139) }), {}), /Tool dispatcher returned/);
    });
}

test("streamed text stays live while fragmented parallel calls restore names, arguments, IDs and usage", async context => {
    let finish;
    const tools = catalogTools(139);
    context.mock.method(globalThis, "fetch", async request => {
        const wire = await request.json();
        const name = wire.tools.at(-1).function.name;
        const args = JSON.stringify({ call: { tool_name: tools.at(-1).function.name, arguments: { value: "quoted \"text\" and \u2603" } } });
        const frame = (delta, finishReason = null, usage) => `data: ${JSON.stringify({
            id: "stream-42", model: "model-router", choices: [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}),
        })}\r\n\r\n`;
        const source = new ReadableStream({ start(controller) {
            controller.enqueue(new TextEncoder().encode(frame({ role: "assistant", content: "live text" })));
            finish = () => {
                const tail = [
                    frame({ tool_calls: [
                        { index: 0, id: "grouped-id", type: "function", function: { name: name.slice(0, 8), arguments: args.slice(0, 9) } },
                        { index: 1, id: "direct-id", type: "function", function: { name: tools[0].function.name, arguments: '{"value":' } },
                    ] }),
                    frame({ tool_calls: [
                        { index: 0, function: { name: name.slice(8), arguments: args.slice(9) } },
                        { index: 1, function: { arguments: '"direct"}' } },
                    ] }),
                    frame({}, "tool_calls", { prompt_tokens: 17, completion_tokens: 23 }),
                    "data: [DONE]\r\n\r\n",
                ].join("");
                const bytes = new TextEncoder().encode(tail);
                for (let offset = 0; offset < bytes.length; offset++) controller.enqueue(bytes.subarray(offset, offset + 1));
                controller.close();
            };
        } });
        return new Response(source, { headers: { "content-type": "text/event-stream", "x-request-id": "stream-request" } });
    });
    const response = await new ByokRequestCompatibility(TOOL_CATALOG).sendRequest(catalogRequest({ tools, stream: true }), {});
    const reader = response.body.getReader();
    const first = await reader.read();
    let text = new TextDecoder().decode(first.value);
    assert.match(text, /live text/);
    finish();
    for (;;) {
        const next = await reader.read();
        if (next.done) break;
        text += new TextDecoder().decode(next.value);
    }
    const chunks = text.split("\n\n").filter(part => part.startsWith("data: {")).map(part => JSON.parse(part.slice(6)));
    const calls = chunks.flatMap(chunk => chunk.choices.flatMap(choice => choice.delta.tool_calls ?? []));
    assert.deepEqual(calls, [
        { index: 0, id: "grouped-id", type: "function", function: { name: tools.at(-1).function.name, arguments: JSON.stringify({ value: "quoted \"text\" and \u2603" }) } },
        { index: 1, id: "direct-id", type: "function", function: { name: tools[0].function.name, arguments: '{"value":"direct"}' } },
    ]);
    assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 17, completion_tokens: 23 });
    assert.equal(response.headers.get("x-request-id"), "stream-request");
    assert.match(text, /\[DONE\]/);
});

test("an unfinished dispatcher stream fails without emitting an executable tool call", async context => {
    context.mock.method(globalThis, "fetch", async request => {
        const wire = await request.json();
        return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{
            index: 0, id: "unfinished", type: "function", function: { name: wire.tools.at(-1).function.name, arguments: "{" },
        }] }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const response = await new ByokRequestCompatibility(TOOL_CATALOG).sendRequest(catalogRequest({ tools: catalogTools(139), stream: true }), {});
    await assert.rejects(response.text(), /before completing its tool calls/);
});

test("a null terminal delta still flushes the completed dispatch call", async context => {
    context.mock.method(globalThis, "fetch", async request => {
        const wire = await request.json();
        const chunks = [
            { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "null-delta", type: "function", function: {
                name: wire.tools.at(-1).function.name,
                arguments: JSON.stringify({ call: { tool_name: "catalog_tool_138", arguments: { value: "retained" } } }),
            } }] }, finish_reason: null }] },
            { choices: [{ index: 0, delta: null, finish_reason: "tool_calls" }] },
        ];
        return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    });
    const response = await new ByokRequestCompatibility(TOOL_CATALOG).sendRequest(catalogRequest({ tools: catalogTools(139), stream: true }), {});
    const chunks = (await response.text()).split("\n\n").filter(chunk => chunk.startsWith("data: {")).map(chunk => JSON.parse(chunk.slice(6)));
    const calls = chunks.flatMap(chunk => chunk.choices.flatMap(choice => choice.delta?.tool_calls ?? []));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, "null-delta");
    assert.equal(calls[0].function.name, "catalog_tool_138");
    assert.deepEqual(JSON.parse(calls[0].function.arguments), { value: "retained" });
});
