import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../src/session-manager.ts";
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

async function withParent(run, { lineage = null, limit = null } = {}) {
    const home = mkdtempSync(join(tmpdir(), "ps-composition-rebuild-"));
    const server = await createNativeCopilotProvider(() => ({ content: "NO_MODEL_TURN_EXPECTED" }));
    const config = { model: "fixture:gpt-5.6-terra", workingDirectory: home,
        toolNames: ["allowed_tool", "blocked_tool"], toolCeiling: ["allowed_tool"] };
    const handlers = new Map();
    const catalog = {
        getSession: async id => ({ sessionId: id, owner: OWNER, parentSessionId: null, isSystem: false }),
        getSessionCreationConfig: async () => config,
        getSessionCapabilities: async () => ({ revision: 0, selections: [] }),
        recordEvents: async () => {}, getUserRole: async () => ({ role: "user", seenAt: new Date() }),
        ...(lineage ? { workflowStore: () => ({
            readWorkflowLineage: async () => lineage, readAgentToolLimit: async () => limit,
        }) } : {}),
    };
    const manager = new SessionManager(undefined, null, {
        nativeSubagents: "off", turnTimeoutMs: 10_000,
        modelProviders: new ModelProviderRegistry({ providers: [{
            id: "fixture", type: "openai", baseUrl: server.baseUrl, apiKey: "synthetic", models: ["gpt-5.6-terra"],
        }] }),
    }, join(home, "sessions"));
    const tools = ["allowed_tool", "blocked_tool"].map(name => [name, {
        name, description: "Harmless fixture tool.", parameters: { type: "object", properties: {} },
        handler: async () => name,
    }]);
    manager.setToolRegistry(new Map(tools), { staticNames: new Set(tools.map(([name]) => name)) });
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
    manager.setSessionCatalog(catalog);
    registerActivities({ registerActivity: (name, handler) => handlers.set(name, handler) }, manager, null,
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
    try { await run({ manager, config, handlers, server, ctx, scheduled }); }
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

describe("1.0.84 composition after rebuilding a session", () => {
    it("captures an owned cold parent's bounded tools before its first managed turn", { timeout: 120_000 }, async () => {
        await withParent(async ({ manager, config, handlers, server, ctx }) => {
            expect(manager.sessions.has("parent")).toBe(false);
            const proxy = createSessionProxy(ctx, "parent", "parent-affinity", config, "tool-composition-v1");
            const effect = proxy.captureSpawnTools(config, "all", ["allowed_tool", "blocked_tool"], null);
            const capture = await handlers.get(effect.name)(context, effect.input);
            expect(capture.toolCeiling).toEqual(["allowed_tool"]);
            expect(capture.toolGrant.tools.map(tool => tool.name)).toEqual(["allowed_tool"]);
            expect(manager.sessions.has("parent")).toBe(true);
            expect(server.requests).toEqual([]);
        });
    });

    it("keeps grant and the inherited ceiling after continue-as-new followed by hydration", { timeout: 120_000 }, async () => {
        await withParent(async ({ manager, config, handlers, server, ctx, scheduled }) => {
            const first = create(ctx, { sessionId: "parent", config, iteration: 1, blobEnabled: true });
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
                else if (effect.name === "hydrateSession" || effect.name === "updateCmsState") next = prompt.next(undefined);
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
            expect(server.requests).toEqual([]);
            prompt.return();
        });
    });
});
