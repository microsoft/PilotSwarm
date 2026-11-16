import { describe, it, expect } from "vitest";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createCopilotClient } from "../../src/copilot-client.ts";
import { pinToolsNeverDefer } from "../../src/tool-pinning.ts";
import { ModelProviderRegistry, applyReasoningEffortToProviderConfig } from "../../src/model-providers.ts";
import { attachWorkloadIdentity } from "../../src/wif-credentials.ts";
import { SessionManager } from "../../src/session-manager.ts";
import { buildRuntimeRegistry, loadProviderTypes } from "../../src/provider-catalog.ts";
import { createCopilotProviderServer } from "../helpers/copilot-provider-server.mjs";

const MODEL = "gpt-5.6-terra";
const TOOL_CATALOG = { maxDeclarations: 128, overflowStrategy: "typed-dispatch" };
const WIF_ENV = {
    ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test", ANTHROPIC_ORGANIZATION_ID: "org-test",
    ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_test", AZURE_FEDERATED_TOKEN_FILE: "/synthetic/token",
    AZURE_TENANT_ID: "test-tenant", AZURE_CLIENT_ID: "test-client",
};

function largeCatalogTools(handler) {
    return pinToolsNeverDefer([
        ...Array.from({ length: 139 }, (_, index) => ({
            name: `catalog_probe_${index}`,
            description: `Read-only catalog probe ${index}`,
            parameters: { type: "object", properties: {} },
            handler: async () => { throw new Error("Unexpected probe execution"); },
        })),
        {
            name: "compat_echo",
            description: "Echo the supplied value.",
            parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
            handler,
        },
    ]);
}

async function harness(run, serverOptions) {
    const home = mkdtempSync(join(tmpdir(), "ps-provider-compat-"));
    const server = await createCopilotProviderServer(serverOptions);
    const clients = [];
    try {
        await run({ home, server, clients, options: { useLoggedInUser: false, env: { ...process.env, COPILOT_HOME: home }, logLevel: "error" } });
    } finally {
        await Promise.all(clients.map(client => client.stop()));
        await server.close();
        rmSync(home, { recursive: true, force: true });
    }
}

describe.concurrent("Copilot provider wire compatibility (real SDK/CLI, synthetic HTTP)", () => {
    it("a shared BYOK client applies catalog opt-in to a primitive model across model switches", { timeout: 60_000 }, async () => {
        await harness(async ({ server, clients, options }) => {
            const provider = { type: "openai", wireApi: "completions", baseUrl: server.baseUrl + "/v1", apiKey: "synthetic-key" };
            const registry = new ModelProviderRegistry({ providers: [{ ...provider, id: "synthetic", models: [
                { name: MODEL, toolCatalog: TOOL_CATALOG },
                { name: "model-router" },
            ] }] });
            const client = createCopilotClient(options, provider, (request, context, model) =>
                registry.getDescriptor(`synthetic:${model}`)?.toolCatalog);
            clients.push(client);
            const calls = [];
            const tools = largeCatalogTools(async args => { calls.push(args); return args.value; });
            const config = { provider, tools, streaming: true, onPermissionRequest: () => ({ kind: "approved" }) };
            let session;
            for (const model of [MODEL, "model-router", MODEL]) {
                if (session) {
                    const id = session.sessionId;
                    await session.disconnect();
                    session = await client.resumeSession(id, { ...config, model });
                } else {
                    session = await client.createSession({ ...config, model });
                }
                const requestStart = server.requests.length;
                expect((await session.sendAndWait({ prompt: "call compat_echo with value violet-739" }, 20_000)).data.content).toContain("violet-739");
                const requests = server.requests.slice(requestStart);
                expect(requests.length).toBeGreaterThan(0);
                for (const request of requests) {
                    expect(request.body.model).toBe(model);
                    expect(request.path).toMatch(/\/chat\/completions(?:\?|$)/);
                    const names = request.body.tools.map(tool => tool.function?.name ?? tool.custom?.name ?? tool.name);
                    if (model === MODEL) {
                        expect(names.length).toBe(128);
                        expect(names).toContain("pilotswarm_tool_dispatch");
                    } else {
                        expect(names.length).toBeGreaterThan(128);
                        expect(names).toEqual(expect.arrayContaining(tools.map(tool => tool.name)));
                        expect(names).not.toContain("pilotswarm_tool_dispatch");
                    }
                }
            }
            expect(calls).toEqual([{ value: "violet-739" }, { value: "violet-739" }, { value: "violet-739" }]);
            await session.disconnect();
        });
    });

    it.each([false, true])("an opted-in primitive model keeps every overflow tool callable, streaming=%s, warm and cold", { timeout: 60_000 }, async streaming => {
        await harness(async ({ server, clients, options }) => {
            const provider = { type: "openai", wireApi: "completions", baseUrl: server.baseUrl + "/v1", apiKey: "synthetic-key" };
            const client = createCopilotClient(options, provider, TOOL_CATALOG);
            clients.push(client);
            const calls = [];
            const guarded = [];
            let deny = false;
            const tools = largeCatalogTools(async args => { calls.push(args); return args.value; });
            const config = {
                model: "gpt-5.4",
                provider,
                streaming,
                onPermissionRequest: () => ({ kind: "approved" }),
                hooks: { onPreToolUse: async input => {
                    guarded.push({ name: input.toolName, args: input.toolArgs });
                    return deny ? { permissionDecision: "deny", permissionDecisionReason: "Synthetic denial" } : {};
                } },
                tools,
            };
            let session = await client.createSession(config);
            expect((await client.getStatus()).version).toBe("1.0.83");
            const events = [];
            session.on(event => events.push(event));
            expect((await session.sendAndWait({ prompt: "call compat_echo with value violet-739" }, 20_000)).data.content).toContain("violet-739");
            expect(calls).toEqual([{ value: "violet-739" }]);
            expect(guarded).toEqual([{ name: "compat_echo", args: { value: "violet-739" } }]);
            expect(events.some(event => event.type === "assistant.usage")).toBe(true);
            const firstTools = server.requests[0].body.tools;
            const advertised = firstTools.flatMap(tool => tool.function?.parameters?.properties?.call?.anyOf
                ? tool.function.parameters.properties.call.anyOf.map(alternative => alternative.properties.tool_name.enum[0])
                : [tool.function?.name ?? tool.custom?.name ?? tool.name]);
            expect(advertised).toEqual(expect.arrayContaining(tools.map(tool => tool.name)));
            const dispatcher = firstTools.find(tool => tool.function?.parameters?.properties?.call?.anyOf?.some(alternative => alternative.properties.tool_name.enum[0] === "compat_echo"));
            expect(dispatcher).toBeDefined();
            await session.sendAndWait({ prompt: "Say hello again" }, 20_000);
            const id = session.sessionId;
            await session.disconnect();
            await client.stop();
            const resumed = createCopilotClient(options, provider, TOOL_CATALOG);
            clients.push(resumed);
            session = await resumed.resumeSession(id, config);
            await session.sendAndWait({ prompt: "Recurring wake: call compat_echo with value violet-739" }, 20_000);
            expect(calls).toEqual([{ value: "violet-739" }, { value: "violet-739" }]);
            deny = true;
            await session.sendAndWait({ prompt: "call compat_echo with value violet-739" }, 20_000);
            expect(calls).toHaveLength(2);
            expect(guarded.at(-1)).toEqual({ name: "compat_echo", args: { value: "violet-739" } });
            expect(server.requests.every(request => request.body.tools.length <= 128)).toBe(true);
            expect(server.requests.some(request => request.body.messages.some(message => message.tool_calls?.some(call =>
                call.function.name === dispatcher.function.name && JSON.parse(call.function.arguments).call.tool_name === "compat_echo",
            )))).toBe(true);
        }, { maxTools: 128 });
    });

    it("a large catalog follows the same session from Anthropic to model-router and across worker restart", { timeout: 60_000 }, async () => {
        await harness(async ({ home, server }) => {
            const registry = new ModelProviderRegistry({ providers: [
                { id: "router", type: "openai", baseUrl: server.baseUrl + "/v1", apiKey: "synthetic-key", models: [{ name: "model-router", wireApi: "completions", toolCatalog: TOOL_CATALOG }] },
                { id: "anthropic", type: "anthropic", baseUrl: server.baseUrl, apiKey: "synthetic-key", models: ["claude-sonnet-5"] },
            ] });
            const sessionId = randomUUID();
            const calls = [];
            const tools = largeCatalogTools(async args => { calls.push(args); return args.value; });
            const facts = { readFacts: async () => ({ count: 0, facts: [] }), storeFact: async () => ({ stored: true }), deleteFact: async () => ({ deleted: true }) };
            let manager = new SessionManager(undefined, null, { modelProviders: registry }, join(home, "session-state"));
            manager.setFactStore(facts);
            manager.setConfig(sessionId, { tools });
            try {
                let session = await manager.getOrCreate(sessionId, { model: "anthropic:claude-sonnet-5" }, { turnIndex: 0 });
                expect((await session.runTurn("call compat_echo with value violet-739")).content).toContain("violet-739");
                session = await manager.getOrCreate(sessionId, { model: "router:model-router" }, { turnIndex: 1 });
                expect((await session.runTurn("Recurring wake: call compat_echo with value violet-739")).content).toContain("violet-739");
                await manager.shutdown();
                manager = new SessionManager(undefined, null, { modelProviders: registry }, join(home, "session-state"));
                manager.setFactStore(facts);
                manager.setConfig(sessionId, { tools });
                session = await manager.getOrCreate(sessionId, { model: "router:model-router" }, { turnIndex: 2 });
                expect((await session.runTurn("Recurring wake after restart: call compat_echo with value violet-739")).content).toContain("violet-739");
                expect(calls).toEqual([{ value: "violet-739" }, { value: "violet-739" }, { value: "violet-739" }]);
                const anthropicRequests = server.requests.filter(request => request.path.endsWith("/messages"));
                const routerRequests = server.requests.filter(request => request.path.endsWith("/chat/completions"));
                expect(anthropicRequests.some(request => request.body.tools.length > 128)).toBe(true);
                expect(routerRequests.length).toBeGreaterThan(0);
                expect(routerRequests.every(request => request.body.tools.length <= 128)).toBe(true);
            } finally { await manager.shutdown(); }
        }, { maxTools: 128 });
    });

    it("SessionManager isolates opt-in by qualified model even on the same endpoint and bare deployment name", { timeout: 60_000 }, async () => {
        await harness(async ({ home, server }) => {
            const registry = new ModelProviderRegistry({ providers: [
                { id: "limited", type: "openai", baseUrl: server.baseUrl + "/v1", apiKey: "synthetic-key", models: [{ name: MODEL, toolCatalog: TOOL_CATALOG }] },
                { id: "unchanged", type: "openai", baseUrl: server.baseUrl + "/v1", apiKey: "synthetic-key", models: [MODEL] },
            ] });
            const sessionId = randomUUID();
            const otherSessionId = randomUUID();
            const calls = [];
            const tools = largeCatalogTools(async args => { calls.push(args); return args.value; });
            const facts = { readFacts: async () => ({ count: 0, facts: [] }), storeFact: async () => ({ stored: true }), deleteFact: async () => ({ deleted: true }) };
            const manager = new SessionManager(undefined, null, { modelProviders: registry }, join(home, "session-state"));
            manager.setFactStore(facts);
            manager.setConfig(sessionId, { tools });
            manager.setConfig(otherSessionId, { tools });
            try {
                const cases = [
                    [sessionId, `limited:${MODEL}`, 0, true],
                    [otherSessionId, `unchanged:${MODEL}`, 0, false],
                    [sessionId, `unchanged:${MODEL}`, 1, false],
                    [sessionId, `limited:${MODEL}`, 2, true],
                ];
                for (const [id, model, turnIndex, optedIn] of cases) {
                    const session = await manager.getOrCreate(id, { model }, { turnIndex });
                    const start = server.requests.length;
                    expect((await session.runTurn("call compat_echo with value violet-739")).content).toContain("violet-739");
                    const requests = server.requests.slice(start);
                    expect(requests.length).toBeGreaterThan(0);
                    for (const request of requests) {
                        expect(request.body.model).toBe(MODEL);
                        if (optedIn) {
                            expect(request.body.tools.length).toBe(128);
                            expect(request.body.tools.some(tool => tool.function?.name === "pilotswarm_tool_dispatch")).toBe(true);
                        } else {
                            expect(request.body.tools.length).toBeGreaterThan(128);
                            expect(request.body.tools.some(tool => tool.function?.name === "pilotswarm_tool_dispatch")).toBe(false);
                        }
                    }
                }
                expect(calls).toHaveLength(4);
            } finally { await manager.shutdown(); }
        });
    });

    it("reproduces the unmodified CLI's rejected snippy field", { timeout: 30_000 }, async () => {
        await harness(async ({ server, clients, options }) => {
            const client = new CopilotClient({ ...options, connection: RuntimeConnection.forStdio() });
            clients.push(client);
            const session = await client.createSession({ model: MODEL, provider: { type: "openai", baseUrl: server.baseUrl + "/v1", apiKey: "synthetic-key" }, onPermissionRequest: () => ({ kind: "approved" }) });
            await expect(session.sendAndWait({ prompt: "Say hello" }, 20_000)).rejects.toThrow(/snippy/);
            expect(server.requests.length).toBeGreaterThan(0);
            expect(server.requests[0].body.snippy).toEqual({ enabled: false });
        });
    });

    for (const type of ["openai", "azure", "openai-proxy", "anthropic", "anthropic-wif"]) {
        for (const streaming of [false, true]) {
            it(`${type}: tool call, usage, streaming=${streaming}, warm turn and cold resume`, { timeout: 60_000 }, async () => {
                await harness(async ({ server, clients, options }) => {
                    const model = type.startsWith("anthropic") ? "claude-sonnet-5" : MODEL;
                    const registry = new ModelProviderRegistry({ providers: [{
                        id: type, type, baseUrl: server.baseUrl + (type.startsWith("anthropic") ? "" : "/v1"),
                        ...(type === "anthropic-wif" ? {} : { apiKey: "synthetic-key" }),
                        models: [{ name: model, supportedReasoningEfforts: ["medium"], defaultReasoningEffort: "medium" }],
                    }] });
                    const resolved = registry.resolve(`${type}:${model}`);
                    let credentials = 0;
                    const provider = applyReasoningEffortToProviderConfig(attachWorkloadIdentity(resolved, {
                        env: WIF_ENV, credentials: () => ({ getToken: async () => `synthetic-bearer-${++credentials}` }),
                    }), registry.getDescriptor(`${type}:${model}`), "medium");
                    const client = createCopilotClient(options, provider);
                    clients.push(client);
                    const toolCalls = [];
                    const config = { model, provider, streaming, reasoningEffort: "medium", onPermissionRequest: () => ({ kind: "approved" }), tools: [{
                        name: "compat_echo", description: "Echo the supplied value.",
                        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
                        handler: async args => { toolCalls.push(args); return args.value; },
                    }] };
                    let session = await client.createSession(config);
                    expect((await client.getStatus()).version).toBe("1.0.83");
                    const events = [];
                    session.on(event => events.push(event));
                    const first = await session.sendAndWait({ prompt: "call compat_echo with value violet-739" }, 20_000);
                    expect(first.data.content).toContain("violet-739");
                    expect(toolCalls).toEqual([{ value: "violet-739" }]);
                    expect(events.some(e => e.type === "assistant.usage")).toBe(true);
                    expect(events.filter(e => e.type === "assistant.usage").every(e => e.data.inputTokens > 0 && e.data.outputTokens > 0)).toBe(true);
                    if (streaming) expect(events.some(e => e.type === "assistant.message_delta")).toBe(true);
                    await session.sendAndWait({ prompt: "Say hello again" }, 20_000);
                    const id = session.sessionId;
                    await session.disconnect();
                    await client.stop();
                    // New process, not just an in-memory handle reconnect.
                    const resumedClient = createCopilotClient(options, provider);
                    clients.push(resumedClient);
                    session = await resumedClient.resumeSession(id, config);
                    const result = await session.sendAndWait({ prompt: "Say hello after resume" }, 20_000);
                    expect(result.data.content).toContain("violet-739");
                    expect(toolCalls).toEqual([{ value: "violet-739" }]);
                    expect(server.requests.every(r => !Object.hasOwn(r.body, "snippy"))).toBe(true);
                    expect(server.requests.at(-1).body.messages.some(m => JSON.stringify(m).includes("violet-739"))).toBe(true);
                    if (type === "openai-proxy") expect(server.requests.every(r => r.path.includes("/x-reasoning-effort/medium/"))).toBe(true);
                    if (type === "azure") {
                        expect(server.requests[0].path).toContain(`/deployments/${model}/chat/completions`);
                        expect(server.requests[0].path).toContain("api-version=");
                    }
                    if (type === "anthropic-wif") {
                        expect(credentials).toBe(server.requests.length);
                        expect(server.requests.map(r => r.headers.authorization)).toEqual(server.requests.map((_, i) => `Bearer synthetic-bearer-${i + 1}`));
                        expect(server.requests.every(r => !r.headers["x-api-key"])).toBe(true);
                    }
                });
            });
        }
    }

    it("SessionManager applies the fix after a cold restart and isolates native-provider clients", { timeout: 60_000 }, async () => {
        await harness(async ({ home, server }) => {
            const registry = new ModelProviderRegistry({ providers: [
                { id: "azure-v1", type: "openai", baseUrl: server.baseUrl + "/v1", apiKey: "synthetic-key", models: [MODEL] },
                { id: "anthropic", type: "anthropic", baseUrl: server.baseUrl, apiKey: "synthetic-key", models: ["claude-sonnet-5"] },
            ] });
            const sessionId = randomUUID();
            const config = { model: `azure-v1:${MODEL}` };
            let manager = new SessionManager(undefined, null, { modelProviders: registry }, join(home, "session-state"));
            // No facts are invoked by this transport-only fixture.
            const facts = { readFacts: async () => ({ count: 0, facts: [] }), storeFact: async () => ({ stored: true }), deleteFact: async () => ({ deleted: true }) };
            manager.setFactStore(facts);
            try {
                let session = await manager.getOrCreate(sessionId, config, { turnIndex: 0 });
                expect((await session.runTurn("Say hello")).content).toContain("violet-739");
                await manager.shutdown();
                manager = new SessionManager(undefined, null, { modelProviders: registry }, join(home, "session-state"));
                manager.setFactStore(facts);
                session = await manager.getOrCreate(sessionId, config, { turnIndex: 1 });
                expect((await session.runTurn("Recurring wake: say hello")).content).toContain("violet-739");
                const openAiClient = [...manager.clients.values()][0];
                // Never pretty-print a CopilotClient on failure: it contains
                // the child's environment, including inherited credentials.
                expect(manager.client === openAiClient).toBe(true);
                // Catalog-only seam: the real client above still owns turns.
                // A pool namespace must never be mistaken for a GitHub token
                // by vision lookups (NUL in an env token used to fail closed).
                openAiClient.listModels = async () => [{ id: MODEL, capabilities: { supports: { vision: true } } }];
                expect(await manager.getModelVisionInfo(`azure-v1:${MODEL}`, { sessionId })).toMatchObject({ known: true, vision: true });
                expect(manager.clients.size).toBe(1);
                session = await manager.getOrCreate(sessionId, { model: "anthropic:claude-sonnet-5" }, { turnIndex: 2 });
                expect((await session.runTurn("Say hello from the new provider")).content).toContain("violet-739");
                expect(manager.clients.size).toBe(2);
                expect([...manager.clients.values()].at(-1) === openAiClient).toBe(false);
                expect(server.requests.every(r => !Object.hasOwn(r.body, "snippy"))).toBe(true);
            } finally { await manager.shutdown(); }
        });
    });

    it.each(["openai", "anthropic"])("%s: a type's headers reach every model request of a personal instance, warm and after restart", { timeout: 60_000 }, async type => {
        await harness(async ({ home, server }) => {
            const model = type === "anthropic" ? "claude-sonnet-5" : MODEL;
            const types = loadProviderTypes({ providers: [{
                id: "with-headers", type,
                baseUrl: server.baseUrl + (type === "anthropic" ? "" : "/v1"),
                ...(type === "openai" ? { wireApi: "completions" } : {}),
                headers: { "Copilot-Integration-Id": "synthetic-integration", "X-Route": "blue" },
                models: [model],
            }] });
            const ref = `my-provider:${model}`;
            const registry = buildRuntimeRegistry(types, [{
                name: "my-provider", typeId: "with-headers", class: "personal", ownerUserId: "user-1",
                baseUrl: null, secretRef: { kind: "apiKey", value: "personal-key" },
            }], ref);
            const sessionId = randomUUID();
            const calls = [];
            const tools = [{
                name: "compat_echo", description: "Echo the supplied value.",
                parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
                handler: async args => { calls.push(args); return args.value; },
            }];
            const facts = { readFacts: async () => ({ count: 0, facts: [] }), storeFact: async () => ({ stored: true }), deleteFact: async () => ({ deleted: true }) };
            let manager = new SessionManager(undefined, null, { modelProviders: registry }, join(home, "session-state"));
            manager.setFactStore(facts);
            manager.setConfig(sessionId, { tools });
            try {
                let session = await manager.getOrCreate(sessionId, { model: ref }, { turnIndex: 0 });
                expect((await session.runTurn("call compat_echo with value violet-739")).content).toContain("violet-739");
                await manager.shutdown();
                manager = new SessionManager(undefined, null, { modelProviders: registry }, join(home, "session-state"));
                manager.setFactStore(facts);
                manager.setConfig(sessionId, { tools });
                session = await manager.getOrCreate(sessionId, { model: ref }, { turnIndex: 1 });
                expect((await session.runTurn("Say hello after restart")).content).toContain("violet-739");
                expect(calls).toEqual([{ value: "violet-739" }]);
                // Tool call, its follow-up, and the turn after the restart.
                expect(server.requests.length).toBeGreaterThanOrEqual(3);
                for (const request of server.requests) {
                    expect(request.headers["copilot-integration-id"]).toBe("synthetic-integration");
                    expect(request.headers["x-route"]).toBe("blue");
                    // The credential is the instance's, on its own header.
                    expect([request.headers.authorization, request.headers["x-api-key"]].join(" ")).toContain("personal-key");
                }
            } finally { await manager.shutdown(); }
        });
    });
});
