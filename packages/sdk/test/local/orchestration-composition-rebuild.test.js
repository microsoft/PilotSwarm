import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../src/session-manager.ts";
import { FilesystemSessionStore } from "../../src/session-store.ts";
import { runTurnPreamble } from "../../src/session-lifecycle.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { createSessionProxy, registerActivities } from "../../src/session-proxy.ts";
import { createRuntime } from "../../src/orchestration/runtime.ts";
import { continueInput, versionedContinueAsNew } from "../../src/orchestration/lifecycle.ts";
import { processPrompt } from "../../src/orchestration/turn.ts";
import { handleSubAgentAction } from "../../src/orchestration/agents.ts";
import { TOOL_COMPOSITION_CAPABILITY } from "../../src/activity-routing.ts";
import { createNativeCopilotProvider } from "../helpers/native-copilot-provider.mjs";

const OWNER = { provider: "test", subject: "composition-rebuild" };
const context = { traceInfo() {}, isCancelled: () => false, orchestrationVersion: "1.0.84" };
const versions = { currentVersion: "1.0.84", latestVersion: "1.0.84" };

async function withParent(run, { lineage = null, limit = null, row = {}, storeFactory } = {}) {
    const home = mkdtempSync(join(tmpdir(), "ps-composition-rebuild-"));
    const server = await createNativeCopilotProvider(() => ({ content: "NO_MODEL_TURN_EXPECTED" }));
    const config = { model: "fixture:gpt-5.6-terra", workingDirectory: home,
        toolNames: ["allowed_tool", "blocked_tool"], toolCeiling: ["allowed_tool"] };
    const handlers = new Map();
    const catalog = {
        getSession: async id => ({ sessionId: id, owner: OWNER, parentSessionId: null, isSystem: false,
            currentIteration: 0, transcriptEpoch: 0, ...row }),
        getSessionCreationConfig: async () => config,
        getSessionCapabilities: async () => ({ revision: 0, selections: [] }),
        recordEvents: async () => {}, getUserRole: async () => ({ role: "user", seenAt: new Date() }),
        ...(lineage ? { workflowStore: () => ({
            readWorkflowLineage: async () => lineage, readAgentToolLimit: async () => limit,
        }) } : {}),
    };
    const tools = ["allowed_tool", "blocked_tool"].map(name => [name, {
        name, description: "Harmless fixture tool.", parameters: { type: "object", properties: {} },
        handler: async () => name,
    }]);
    const source = { id: "static:fixture", name: "fixture", revision: "fixture-v1",
        source: "static", scope: "shared", owner: null, tools: new Map(tools), mcpServers: {}, artifacts: [] };
    const sessionStore = await storeFactory?.(home) ?? null;
    const manager = new SessionManager(undefined, sessionStore, {
        nativeSubagents: "off", turnTimeoutMs: 10_000,
        getCapabilitySources: () => [source],
        getWorkflowCapabilitySnapshot: async binding => ({
            sources: [source], pins: [], labels: { packagePins: {},
                toolSources: Object.fromEntries(binding.tools.filter(tool => source.tools.has(tool.name))
                    .map(tool => [tool.name, source.id])) },
        }),
        modelProviders: new ModelProviderRegistry({ providers: [{
            id: "fixture", type: "openai", baseUrl: server.baseUrl, apiKey: "synthetic", models: ["gpt-5.6-terra"],
        }] }),
    }, join(home, "sessions"));
    manager.setToolRegistry(new Map(tools), { staticNames: new Set(tools.map(([name]) => name)) });
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
    manager.setSessionCatalog(catalog);
    registerActivities({ registerActivity: (name, handler) => handlers.set(name, handler) }, manager, sessionStore,
        undefined, catalog, undefined, "in-memory://composition-rebuild", undefined, undefined, [], null, [], []);
    const scheduled = [];
    const values = new Map();
    const schedule = (name, input, affinity) => {
        const effect = { name, input, affinity, tag: null, withTag(tag) { this.tag = tag; return this; } };
        scheduled.push(effect);
        return effect;
    };
    const ctx = {
        traceInfo() {}, setCustomStatus() {}, getValue: key => values.get(key) ?? null,
        setValue: (key, value) => values.set(key, value), clearValue: key => values.delete(key),
        scheduleActivity: (name, input) => schedule(name, input),
        scheduleActivityOnSession: (name, input, affinity) => schedule(name, input, affinity),
        newGuid: () => ({ name: "newGuid" }), utcNow: () => ({ name: "utcNow" }),
        continueAsNewVersioned: (input, version) => ({ name: "continueAsNew", input, version }),
    };
    try { await run({ manager, config, handlers, server, ctx, scheduled, catalog, home, sessionStore }); }
    finally { await manager.shutdown(); await server.close(); rmSync(home, { recursive: true, force: true }); }
}

function create(ctx, input) {
    const generator = createRuntime(ctx, input, versions);
    let next = generator.next();
    while (!next.done) {
        if (next.value.name === "getWorkerSessionPolicy") next = generator.next({ policy: null, allowedAgentNames: [] });
        else throw new Error(`Unexpected runtime creation effect: ${next.value.name}`);
    }
    return next.value;
}

function captureOnlyClient() {
    const session = () => ({
        disconnect: async () => {}, on() {},
        rpc: { tools: { initializeAndValidate: async () => {},
            getCurrentMetadata: async () => ({ tools: [{
                name: "allowed_tool", input_schema: { type: "object", properties: {} },
            }] }) } },
    });
    return { resumeSession: vi.fn(async () => session()), createSession: vi.fn(async () => session()) };
}

async function savedParentStore(home, epoch = 0) {
    const state = join(home, "sessions");
    const directory = join(state, "parent");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "workspace.yaml"), "fixture: harmless\n");
    const store = new FilesystemSessionStore(join(home, "snapshots"), state);
    await store.commitSnapshot("parent", { baseVersion: 0, turnKey: "prior-turn" }, epoch);
    rmSync(directory, { recursive: true, force: true });
    return store;
}

describe("1.0.84 composition after rebuilding a session", () => {
    it.each([{ isSystem: true }, { owner: null }])("does not open a cold ownerless/system parent: %j", async row => {
        await withParent(async ({ manager, config, handlers, server, ctx }) => {
            const opening = vi.spyOn(manager, "getOrCreate");
            const proxy = createSessionProxy(ctx, "parent", "parent-affinity", config, "tool-composition-v1");
            const effect = proxy.captureSpawnTools(config, "all", undefined, null);
            expect(await handlers.get(effect.name)(context, effect.input)).toEqual({ toolCeiling: ["allowed_tool"] });
            expect(opening).not.toHaveBeenCalled();
            expect(manager.sessions.has("parent")).toBe(false);
            expect(server.requests).toEqual([]);
        }, { row });
    });

    it("refuses a deleted cold parent before opening it", async () => {
        await withParent(async ({ manager, config, handlers, server, ctx }) => {
            const opening = vi.spyOn(manager, "getOrCreate");
            const proxy = createSessionProxy(ctx, "parent", "parent-affinity", config, "tool-composition-v1");
            const effect = proxy.captureSpawnTools(config, "all", undefined, null);
            await expect(handlers.get(effect.name)(context, effect.input)).rejects.toThrow("The parent session is unavailable.");
            expect(opening).not.toHaveBeenCalled();
            expect(server.requests).toEqual([]);
        }, { row: { deletedAt: new Date() } });
    });

    it("refuses deleted Workflow lineage before opening a cold parent", async () => {
        await withParent(async ({ manager, config, handlers, server, ctx }) => {
            const opening = vi.spyOn(manager, "getOrCreate");
            const proxy = createSessionProxy(ctx, "parent", "parent-affinity", config, "tool-composition-v1");
            const effect = proxy.captureSpawnTools(config, "all", undefined, null);
            await expect(handlers.get(effect.name)(context, effect.input)).rejects.toThrow("The parent session was deleted.");
            expect(opening).not.toHaveBeenCalled();
            expect(server.requests).toEqual([]);
        }, { lineage: { deleted: true } });
    });

    it("adopts authoritative model settings and does not inherit a stale crawler flag on cold open", { timeout: 120_000 }, async () => {
        await withParent(async ({ manager, config, handlers, ctx }) => {
            config.isCrawler = true;
            const proxy = createSessionProxy(ctx, "parent", "parent-affinity", config, "tool-composition-v1");
            const effect = proxy.captureSpawnTools(config, "all", undefined, null);
            await handlers.get(effect.name)(context, effect.input);
            expect(manager.sessionConfigs.get("parent")).toMatchObject({
                model: "fixture:gpt-5.6-terra", reasoningEffort: "low", isCrawler: false, isHarvester: false,
            });
        }, { row: { model: "fixture:gpt-5.6-terra", reasoningEffort: "low" } });
    });

    it("keeps explicit cwd and file hooks off when cold capture follows a workspace clear", { timeout: 120_000 }, async () => {
        await withParent(async ({ manager, config, handlers, server, ctx }) => {
            delete config.workingDirectory;
            const opening = vi.spyOn(manager, "_createCopilotSession");
            const proxy = createSessionProxy(ctx, "parent", "parent-affinity", config, "tool-composition-v1");
            const effect = proxy.captureSpawnTools(config, "all", undefined, null, false,
                { transcriptEpoch: 0, workspaceRevision: 2 });
            await handlers.get(effect.name)(context, effect.input);
            expect(manager.sessionConfigs.get("parent").workspaceCleared).toBe(true);
            expect(opening.mock.calls[0][1]).toMatchObject({ workingDirectory: process.cwd(), enableFileHooks: false });
            expect(server.requests).toEqual([]);
        });
    });

    it("does not create an empty parent conversation when a resumed capture lost its snapshot", { timeout: 120_000 }, async () => {
        await withParent(async ({ manager, config, handlers, server, ctx }) => {
            const opening = vi.spyOn(manager, "_createCopilotSession");
            const proxy = createSessionProxy(ctx, "parent", "parent-affinity", config, "tool-composition-v1");
            const effect = proxy.captureSpawnTools(config, "all", undefined, null, false,
                { transcriptEpoch: 2, workspaceRevision: 0, turnIndex: 4 });
            await expect(handlers.get(effect.name)(context, effect.input)).rejects.toThrow(/SESSION_STATE_MISSING/);
            expect(opening).not.toHaveBeenCalled();
            expect(manager.sessions.has("parent")).toBe(false);
            expect(server.requests).toEqual([]);
        }, { row: { currentIteration: 4, transcriptEpoch: 2 } });
    });

    it("resumes the current epoch through the strict stored-snapshot path and keeps its grant", { timeout: 120_000 }, async () => {
        await withParent(async ({ manager, config, handlers, ctx, sessionStore }) => {
            const hydration = vi.spyOn(sessionStore, "hydrateSnapshot");
            const legacyHydration = vi.spyOn(sessionStore, "hydrate");
            const client = captureOnlyClient();
            manager.ensureClient = async () => client;
            const proxy = createSessionProxy(ctx, "parent", "parent-affinity", config, "tool-composition-v1");
            const effect = proxy.captureSpawnTools(config, "all", undefined, null, false,
                { transcriptEpoch: 2, workspaceRevision: 3, turnIndex: 4 });
            const capture = await handlers.get(effect.name)(context, effect.input);
            expect(hydration).toHaveBeenCalledWith("parent", 2);
            expect(legacyHydration).not.toHaveBeenCalled();
            expect(client.resumeSession).toHaveBeenCalledTimes(1);
            expect(client.createSession).not.toHaveBeenCalled();
            expect(capture.toolGrant.tools.map(tool => tool.name)).toEqual(["allowed_tool"]);
            expect(capture.toolCeiling).toEqual(["allowed_tool"]);
            const parent = manager.sessions.get("parent");
            const preamble = await runTurnPreamble({
                store: sessionStore, sessionStateDir: manager.getSessionStateDir(), sessionId: "parent",
                transcriptEpoch: 2, expectedVersion: 1, turnKey: "next-real-turn",
                dropWarmSession: () => manager.dropWarmSession("parent"), trace() {},
            });
            expect(preamble).toEqual({ kind: "warm", baseVersion: 1 });
            expect(await manager.getOrCreate("parent", manager.sessionConfigs.get("parent"),
                { turnIndex: 5, transcriptEpoch: 2 })).toBe(parent);
            expect(client.createSession).not.toHaveBeenCalled();
        }, { row: { currentIteration: 4, transcriptEpoch: 2 }, storeFactory: home => savedParentStore(home, 2) });
    });

    it("refuses a stale turn-zero capture without deleting the parent's saved conversation", { timeout: 120_000 }, async () => {
        await withParent(async ({ manager, config, handlers, ctx, sessionStore }) => {
            const deleting = vi.spyOn(sessionStore, "delete");
            const opening = vi.spyOn(manager, "getOrCreate");
            const proxy = createSessionProxy(ctx, "parent", "parent-affinity", config, "tool-composition-v1");
            const effect = proxy.captureSpawnTools(config, "all", undefined, null);
            await expect(handlers.get(effect.name)(context, effect.input)).rejects.toThrow("The parent's turn index is unavailable.");
            expect(deleting).not.toHaveBeenCalled();
            expect(opening).not.toHaveBeenCalled();
            expect((await sessionStore.probeSnapshot("parent", 0)).exists).toBe(true);
        }, { storeFactory: savedParentStore });
    });

    it.each([0, 2])("keeps legacy tool_names spawning for a saved parent at epoch %i", { timeout: 120_000 }, async epoch => {
        await withParent(async ({ manager, config, handlers, ctx, sessionStore }) => {
            const client = captureOnlyClient();
            manager.ensureClient = async () => client;
            const hydration = vi.spyOn(sessionStore, "hydrateSnapshot");
            const proxy = createSessionProxy(ctx, "parent", "parent-affinity", config, "tool-composition-v1");
            const effect = proxy.captureSpawnTools(config, undefined, undefined, null, true,
                { transcriptEpoch: epoch, workspaceRevision: 0, turnIndex: 4 });
            const capture = await handlers.get(effect.name)(context, effect.input);
            expect(capture).toEqual({ toolCeiling: ["allowed_tool"] });
            expect(hydration).toHaveBeenCalledWith("parent", epoch);
            expect((await sessionStore.probeSnapshot("parent", epoch)).version).toBe(1);
            expect(client.createSession).not.toHaveBeenCalled();
            expect(manager.sessions.has("parent")).toBe(true);
        }, { row: { currentIteration: 4, transcriptEpoch: epoch }, storeFactory: home => savedParentStore(home, epoch) });
    });

    it("reads the Workflow subtree ceiling before a cold legacy tool_names capture", { timeout: 120_000 }, async () => {
        await withParent(async ({ manager, config, handlers, server, ctx }) => {
            const proxy = createSessionProxy(ctx, "parent", "parent-affinity", config, "tool-composition-v1");
            const effect = proxy.captureSpawnTools(config, undefined, undefined, null, true);
            const capture = await handlers.get(effect.name)(context, effect.input);
            expect(capture).toEqual({ toolCeiling: [] });
            expect(manager.sessionConfigs.get("parent").workflowToolLimit).toEqual([]);
            expect(server.requests).toEqual([]);
        }, { lineage: { agentRoot: { distance: 1, nodeExecutionId: "visit", workflowSessionId: "workflow" } }, limit: [] });
    });

    it("opens one parent for concurrent captures without losing the ceiling", { timeout: 120_000 }, async () => {
        await withParent(async ({ manager, config, handlers, server, ctx }) => {
            const opening = vi.spyOn(manager, "getOrCreate");
            const proxy = createSessionProxy(ctx, "parent", "parent-affinity", config, "tool-composition-v1");
            const effect = proxy.captureSpawnTools(config, "all", undefined, null);
            const captures = await Promise.all([handlers.get(effect.name)(context, effect.input),
                handlers.get(effect.name)(context, effect.input)]);
            expect(opening).toHaveBeenCalledTimes(1);
            for (const capture of captures) {
                expect(capture.toolCeiling).toEqual(["allowed_tool"]);
                expect(capture.toolGrant.tools.map(tool => tool.name)).toEqual(["allowed_tool"]);
            }
            expect(server.requests).toEqual([]);
        });
    });

    it("refuses a cold capture with no parent configuration instead of using child defaults", { timeout: 120_000 }, async () => {
        await withParent(async ({ manager, config, handlers, server, catalog }) => {
            catalog.getSessionCreationConfig = async () => null;
            const opening = vi.spyOn(manager, "getOrCreate");
            await expect(handlers.get("captureSpawnToolsV1")(context, {
                parentSessionId: "parent", childConfig: config, grant: "all", agent: null,
            })).rejects.toThrow("The parent's configuration is unavailable. No child was created.");
            expect(opening).not.toHaveBeenCalled();
            expect(server.requests).toEqual([]);
        });
    });

    it("captures an owned cold parent's bounded tools before its first managed turn", { timeout: 120_000 }, async () => {
        await withParent(async ({ manager, config, handlers, server, ctx }) => {
            expect(manager.sessions.has("parent")).toBe(false);
            const proxy = createSessionProxy(ctx, "parent", "parent-affinity", config, "tool-composition-v1");
            const effect = proxy.captureSpawnTools(config, "all", ["allowed_tool", "blocked_tool"], null);
            const capture = await handlers.get(effect.name)(context, effect.input);
            expect(manager.sessionConfigs.get("parent").toolNames).toContain("allowed_tool");
            expect(manager.sessionConfigs.get("parent").tools.map(tool => tool.name)).toContain("allowed_tool");
            const metadata = await manager.sessions.get("parent").getWorkflowToolSession().rpc.tools.getCurrentMetadata();
            expect(metadata.tools.map(tool => tool.name)).toContain("allowed_tool");
            expect(capture.toolCeiling).toEqual(["allowed_tool"]);
            expect(capture.toolGrant.tools.map(tool => tool.name)).toEqual(["allowed_tool"]);
            expect(manager.sessions.has("parent")).toBe(true);
            expect(server.requests).toEqual([]);
        });
    });

    it("keeps grant and the inherited ceiling after continue-as-new followed by hydration", { timeout: 120_000 }, async () => {
        await withParent(async ({ manager, config, handlers, server, ctx, scheduled, sessionStore }) => {
            const client = captureOnlyClient();
            manager.ensureClient = async () => client;
            await manager.getOrCreate("parent", config, { turnIndex: 1, transcriptEpoch: 0 });
            await manager.dropWarmSession("parent");
            const first = create(ctx, { sessionId: "parent", config, iteration: 1, transcriptEpoch: 0,
                workspaceRevision: 3, blobEnabled: true });
            const boundary = versionedContinueAsNew(first, continueInput(first, { needsHydration: true }));
            const continued = boundary.next().value;
            expect(continued).toMatchObject({ name: "continueAsNew", version: "1.0.84" });
            expect(continued.input.config.toolCeiling).toEqual(["allowed_tool"]);
            const resumed = create(ctx, continued.input);
            const prompt = processPrompt(resumed, "Continue with a bounded child.", false);
            let next = prompt.next();
            for (let steps = 0; steps < 40 && !next.done; steps++) {
                const effect = next.value;
                if (/^runTurn/.test(effect.name)) {
                    expect(effect.name).toBe("runTurnV6");
                    expect(effect.tag).toBe(TOOL_COMPOSITION_CAPABILITY);
                    break;
                }
                if (effect.name === "newGuid") next = prompt.next("resumed-affinity");
                else if (effect.name === "utcNow") next = prompt.next(Date.now());
                else if (effect.name === "hydrateSession") next = prompt.next(await handlers.get(effect.name)(context, effect.input));
                else if (["updateCmsState", "loadKnowledgeIndex"].includes(effect.name)) next = prompt.next(undefined);
                else throw new Error(`Unexpected resumed prompt effect: ${effect.name}`);
            }
            expect(scheduled.some(effect => effect.name === "hydrateSession")).toBe(true);
            expect(next.done).toBe(false);
            const child = vi.fn((_parent, childConfig) => ({ name: "spawn", childConfig }));
            resumed.manager.spawnChildSession = child;
            const spawn = handleSubAgentAction(resumed, {
                type: "spawn_agent", task: "Harmless fixture.", grant: "all", tools: ["allowed_tool", "blocked_tool"],
            });
            const captureEffect = spawn.next().value;
            expect(captureEffect.input.parentContext).toEqual({ transcriptEpoch: 0, workspaceRevision: 3, turnIndex: 1 });
            const capture = await handlers.get(captureEffect.name)(context, captureEffect.input);
            const spawned = spawn.next(capture).value;
            expect(spawned.childConfig.toolCeiling).toEqual(["allowed_tool"]);
            expect(spawned.childConfig.toolGrant.tools.map(tool => tool.name)).toEqual(["allowed_tool"]);
            spawn.return();
            const noneEffect = resumed.session.captureSpawnTools(config, "none", undefined, null);
            const none = await handlers.get(noneEffect.name)(context, noneEffect.input);
            expect(none.toolGrant.tools).toEqual([]);
            expect(none.toolCeiling).toEqual(["allowed_tool"]);
            expect(manager.sessions.has("parent")).toBe(true);
            expect((await sessionStore.probeSnapshot("parent", 0)).exists).toBe(true);
            expect(client.createSession).not.toHaveBeenCalled();
            expect(server.requests).toEqual([]);
            prompt.return();
        }, { row: { currentIteration: 1, transcriptEpoch: 0 }, storeFactory: savedParentStore });
    });
});
