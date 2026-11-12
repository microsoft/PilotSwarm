import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../src/session-manager.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { bindCapabilities } from "../../src/capability-runtime.ts";
import { capabilityRef } from "../../src/capability-catalog.ts";
import { createNativeCopilotProvider } from "../helpers/native-copilot-provider.mjs";
import { useSuiteEnv } from "../helpers/local-env.js";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";

const getEnv = useSuiteEnv(import.meta.url);
const OWNER = { provider: "test", subject: "fb020-contract-fixture" };
const fixtureTool = name => ({
    name, description: `Return harmless data for ${name}.`,
    parameters: { type: "object", properties: {} },
    handler: vi.fn(async () => ({ marker: name })),
});

describe("FB-020: source-contract assumptions, not an implementation", () => {
    it("one collision or denied MCP server drops the whole source selection, not just the bad export", () => {
        const good = fixtureTool("fb020_good");
        const collision = fixtureTool("fb020_collision");
        const src = {
            id: "fb020-contract-source", name: "fixture-contracts", source: "published",
            revision: "fixture-v1", scope: "user", owner: OWNER, packageId: "fb020-contract-source", artifacts: [],
            tools: new Map([[good.name, good], [collision.name, collision]]),
            mcpServers: {
                open: { type: "http", url: "http://127.0.0.1:1/open", tools: ["read"] },
                restricted: {
                    type: "http", url: "http://127.0.0.1:1/restricted", tools: ["read"], allowedAgents: ["ops:reader"],
                },
            },
        };
        const ref = capabilityRef(src.id, src.revision, "source");
        const select = (tools, mcpServers) => [{ sourceId: src.id, sourceRef: ref, tools, mcpServers }];
        const collisionSelection = select([good.name, collision.name], ["open"]);
        expect(bindCapabilities([src], OWNER, collisionSelection, [collision], {}, null))
            .toMatchObject({ tools: [], mcpServers: {}, unavailable: [src.id] });
        expect(() => bindCapabilities([src], OWNER, collisionSelection, [collision], {}, null, true))
            .toThrow("Tool name collision or reserved name: fb020_collision");
        const filteredCollision = bindCapabilities([src], OWNER, select([good.name], ["open"]), [collision], {}, null, true);
        expect(filteredCollision.tools).toEqual([good]);
        expect(Object.keys(filteredCollision.mcpServers)).toEqual(["open"]);

        const denied = { name: "reader", namespace: "other", packageId: "other-pkg", packageScope: "shared" };
        const serverSelection = select([good.name], ["open", "restricted"]);
        expect(bindCapabilities([src], OWNER, serverSelection, [], {}, denied))
            .toMatchObject({ tools: [], mcpServers: {}, unavailable: [src.id] });
        expect(() => bindCapabilities([src], OWNER, serverSelection, [], {}, denied, true))
            .toThrow("MCP server is restricted to an authorized bound agent");
        const filteredServer = bindCapabilities([src], OWNER, select([good.name], ["open"]), [], {}, denied, true);
        expect(filteredServer.tools).toEqual([good]);
        expect(Object.keys(filteredServer.mcpServers)).toEqual(["open"]);
    });

    it("captures named starts for package, deployment, CLI-native and MCP calls in the child's real turn",
        { timeout: 60_000 }, async () => {
            const h = await openWorkflowStore(getEnv());
            const home = mkdtempSync(join(tmpdir(), "ps-fb020-events-"));
            const proof = join(home, "mcp-proof.txt");
            const model = "gpt-5.6-terra";
            const packageTool = fixtureTool("fb020_event_package");
            const deploymentTool = fixtureTool("fb020_event_deployment");
            const script = [packageTool.name, deploymentTool.name, "view", "mcp"];
            let phase = 0;
            let offeredMcpName;
            const server = await createNativeCopilotProvider(body => {
                const next = script[phase++];
                if (!next) return { content: "FB020_EVENTS_COMPLETE" };
                const names = (body.tools ?? []).flatMap(tool => {
                    const name = tool.function?.name ?? tool.name;
                    return typeof name === "string" ? [name] : [];
                });
                const name = next === "mcp" ? names.find(value => value.includes("read_note")) : next;
                expect(name).toBeTruthy();
                expect(names).toContain(name);
                if (next === "mcp") offeredMcpName = name;
                return { tools: [{ name, args: next === "view"
                    ? { path: new URL("../helpers/native-task-mcp.mjs", import.meta.url).pathname } : {} }] };
            });
            const registry = new ModelProviderRegistry({ providers: [{
                id: "fixture", type: "openai", baseUrl: server.baseUrl, apiKey: "synthetic", models: [model],
            }] });
            const manager = new SessionManager(undefined, null, {
                modelProviders: registry, nativeSubagents: "off", turnTimeoutMs: 20_000,
                agentPromptLookup: { fixture_events: {
                    prompt: "Call only the harmless fixture tools.", kind: "app-agent",
                    packageId: "fb020-events-package", packageScope: "shared",
                    toolNames: [packageTool.name, deploymentTool.name],
                } },
                baseMcpServers: { notes: {
                    command: process.execPath,
                    args: [new URL("../helpers/native-task-mcp.mjs", import.meta.url).pathname, proof],
                    tools: ["read_note"],
                } },
            }, join(home, "sessions"));
            manager.setSessionCatalog(h.catalog);
            manager.setFactStore({
                readFacts: async () => ({ count: 0, facts: [] }),
                storeFact: async () => ({ stored: true }), deleteFact: async () => ({ deleted: true }),
            });
            manager.setToolRegistry(new Map([[packageTool.name, packageTool], [deploymentTool.name, deploymentTool]]), {
                byPackage: new Map([["fb020-events-package", new Map([[packageTool.name, packageTool]])]]),
                staticNames: new Set([deploymentTool.name]),
            });
            try {
                const parent = randomUUID();
                const child = randomUUID();
                await h.catalog.createSession(parent, { owner: OWNER });
                await h.catalog.createSession(child, { parentSessionId: parent, owner: OWNER });
                const managed = await manager.getOrCreate(child, {
                    model: `fixture:${model}`, workingDirectory: home, boundAgentName: "fixture_events",
                    boundAgentPackageId: "fb020-events-package", toolNames: [packageTool.name, deploymentTool.name],
                }, { turnIndex: 0 });
                const events = [];
                const result = await managed.runTurn("Call each of the four fixture operations.", {
                    onEvent: event => events.push(event),
                });
                expect(result).toMatchObject({ type: "completed", content: "FB020_EVENTS_COMPLETE" });
                expect(packageTool.handler).toHaveBeenCalledOnce();
                expect(deploymentTool.handler).toHaveBeenCalledOnce();
                expect(readFileSync(proof, "utf8")).toBe("read_note\n");
                const starts = events.filter(event => event.eventType === "tool.execution_start")
                    .map(event => ({ name: event.data.toolName ?? event.data.name, server: event.data.mcpServerName ?? null }));
                expect(starts.map(event => event.name)).toContain(packageTool.name);
                expect(starts.map(event => event.name)).toContain(deploymentTool.name);
                expect(starts.map(event => event.name)).toContain("view");
                expect(starts.some(event => event.name?.includes("read_note"))).toBe(true);
                console.log("FB020_TOOL_START_NAMES", JSON.stringify({ offeredMcpName, starts }));
            } finally {
                try { await manager.shutdown(); }
                finally {
                    try { await server.close(); }
                    finally {
                        await h.stop();
                        rmSync(home, { recursive: true, force: true });
                    }
                }
            }
        });
});
