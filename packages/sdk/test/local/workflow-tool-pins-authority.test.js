import { describe, expect, it } from "vitest";
import { CopilotClient } from "@github/copilot-sdk";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "../../src/session-manager.ts";
import { resolveWorkflowCapabilitySnapshot, retryWorkflowPackageCheck } from "../../src/workflow/package-pins.ts";
import { captureWorkflowTools, WorkflowToolAuthorityError, workflowToolGrant } from "../../src/workflow/tool-policy.ts";
import { createNativeCopilotProvider } from "../helpers/native-copilot-provider.mjs";

const OWNER = { provider: "test", subject: "workflow-pins-owner" };

describe("FB-032 deployment compatibility", () => {
    it("a fresh pooled CLI does not retain an expired package-call budget", { timeout: 60_000 }, async () => {
        const directory = await mkdtemp(join(tmpdir(), "workflow-cold-pins-"));
        const provider = await createNativeCopilotProvider(() => { throw new Error("Unexpected inference"); });
        const client = new CopilotClient({ env: { ...process.env, COPILOT_HOME: join(directory, "home") }, logLevel: "error" });
        const revision = "a".repeat(64);
        let session;
        const source = { id: "fixture-id", packageId: "fixture-id", name: "fixture-tools", source: "published",
            revision, scope: "user", owner: OWNER, tools: new Map(), mcpServers: {}, artifacts: [] };
        const binding = { policy: "node-parent-tools-v1", parentSessionId: "parent", owner: OWNER, config: {},
            capabilities: { revision: 1, selections: [{ sourceId: source.id, tools: ["warm_lookup"], mcpServers: [] }] },
            tools: [workflowToolGrant({ name: "warm_lookup", input_schema: { type: "object", properties: {} } })],
            sourceRevisions: { [source.id]: revision }, excludedTools: [], boundAgentFingerprint: "" };
        const version = { semver: "1.0.0", sha256: revision };
        const pkg = { packageId: source.id, name: source.name, scope: source.scope, owner: OWNER,
            enabled: true, active: version };
        const catalog = {
            getSession: async id => ({ sessionId: id, owner: OWNER, sessionKind: "agent", state: "idle", deletedAt: null }),
            getSessionCapabilities: async () => binding.capabilities,
            listAgentPackages: async () => [pkg],
            getAgentPackage: async () => ({ ...pkg, versions: [version] }),
        };
        const manager = new SessionManager(undefined, null, { frameworkBasePrompt: "",
            getCapabilitySources: () => [source],
            getWorkflowCapabilitySnapshot: (grant, retained) => resolveWorkflowCapabilitySnapshot(grant, retained, catalog, [source]),
        });
        manager.setSessionCatalog(catalog);
        const tool = { name: "warm_lookup", description: "Fixture", skipPermission: true, parameters: { type: "object", properties: {} },
            handler: async () => {
                const snapshot = await resolveWorkflowCapabilitySnapshot(binding, undefined, catalog, [source]);
                const captured = await manager.captureWorkflowToolBinding("parent");
                return JSON.stringify({ revision: snapshot.pins[0].revision, captured: captured.sourceRevisions[source.id] });
            } };
        source.tools.set(tool.name, tool);
        try {
            session = await retryWorkflowPackageCheck(tool.name, () => manager._createCopilotSession(client, {
                model: "gpt-test", provider: { type: "openai", baseUrl: provider.baseUrl, apiKey: "fixture" }, tools: [tool],
            }));
            await session.rpc.tools.initializeAndValidate();
            manager.sessions.set("parent", { getWorkflowToolSession: () => session });
            manager.workflowParentConfigs.set("parent", {});
            await new Promise(resolve => setTimeout(resolve, 3100));
            const result = await session.rpc.tools.execute({ name: tool.name, arguments: {}, toolCallId: "after-budget" });
            expect(result.resultType).toBe("success");
            expect(JSON.parse(result.textResultForLlm)).toEqual({ revision, captured: revision });
            expect(provider.requests).toHaveLength(0);
        } finally {
            if (session) await session.disconnect();
            await client.stop();
            await provider.close();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("removal receipts include at most 20 active Workflows of the calling session only", async () => {
        const ids = ["foreign", "nested", "deleted", "finished", ...Array.from({ length: 25 }, (_, n) => `own-${n}`)];
        const binding = { policy: "node-parent-tools-v1", parentSessionId: "caller", owner: OWNER, config: {},
            capabilities: { revision: 0, selections: [{ sourceId: "package-id", tools: ["fixture_tool"], mcpServers: [] }] },
            tools: [workflowToolGrant({ name: "fixture_tool" })], sourceRevisions: { "package-id": "a".repeat(64) },
            excludedTools: [], boundAgentFingerprint: "",
            packagePins: { "package-id": { package: "fixture-tools", version: "1.0.0", ownership: "owned" } } };
        const manager = new SessionManager(undefined, null, { frameworkBasePrompt: "" });
        manager.setSessionCatalog({
            getDescendantSessionIds: async () => ids,
            getSession: async id => ({ sessionId: id, sessionKind: "workflow", deletedAt: id === "deleted" ? "today" : null,
                parentSessionId: id === "foreign" ? "someone-else" : id === "nested" ? "other-workflow" : "caller" }),
            getSessionCreationConfig: async () => ({ workflowToolBinding: binding }),
            listAgentPackages: async () => [], getAgentPackage: async () => null,
            workflowStore: () => ({
                listRuns: async id => [{ status: id === "finished" ? "completed" : "running", revision: 1 }],
                readRevision: async id => ({ name: id }),
            }),
        });
        expect(await manager.workflowsPinningPackage("caller", "package-id")).toEqual(
            Array.from({ length: 20 }, (_, n) => ({ workflowId: `own-${n}`, name: `own-${n}`,
                package: "fixture-tools", version: "1.0.0" })));
    });

    for (const legacy of [false, true]) {
        it.each(["script", "agent-step", "spawned-child"])(`${legacy ? "legacy" : "new"} %s bindings keep built-ins and compare only the called contract`,
            async role => {
            const first = { name: "first", description: "Before", parameters: { type: "object", properties: {} } };
            const source = { id: "static:fixture", name: "fixture", source: "static", revision: "before",
                scope: "shared", tools: new Map([["first", first], ["unused", { name: "unused" }]]),
                mcpServers: {}, artifacts: [] };
            const agent = { prompt: "Before", toolNames: ["first", "store_fact"] };
            const lookup = { fixture: agent };
            const manager = new SessionManager(undefined, null, {
                frameworkBasePrompt: "", frameworkBaseToolNames: ["base_tool"],
                agentPromptLookup: lookup, getCapabilitySources: () => [source],
                getWorkflowCapabilitySnapshot: (binding, retained) => resolveWorkflowCapabilitySnapshot(
                    binding, retained, { listAgentPackages: async () => [], getAgentPackage: async () => null }, [source]),
            });
            const binding = {
                policy: "node-parent-tools-v1", parentSessionId: "parent", owner: OWNER,
                config: { boundAgentName: "fixture", boundAgentSource: "deployment",
                    toolNames: ["base_tool", "first", "store_fact", "extra_tool"], namedAgentToolAdditions: ["extra_tool"] },
                capabilities: { revision: 0, selections: [] },
                tools: [workflowToolGrant({ name: "first", input_schema: first.parameters }),
                    workflowToolGrant({ name: "store_fact", input_schema: {} })],
                sourceRevisions: { [source.id]: source.revision }, excludedTools: [],
                boundAgentFingerprint: "", ...(legacy ? {} : { packagePins: {}, toolSources: { first: source.id } }),
            };
            binding.boundAgentFingerprint = manager.workflowAgentFingerprint(binding.config, OWNER);
            const recorded = role === "agent-step" ? { ...binding, agentStepBindings: { step: {
                capabilities: binding.capabilities, tools: binding.tools, sourceRevisions: binding.sourceRevisions,
                ...(binding.packagePins ? { packagePins: binding.packagePins } : {}),
                ...(binding.toolSources ? { toolSources: binding.toolSources } : {}),
            } } } : binding;
            const scoped = role === "agent-step" ? { ...binding, agentStepStateId: "step" } : binding;
            const spawned = role === "spawned-child";
            const authorize = tool => manager.authorizeWorkflowTools("wf", scoped, tool, true, spawned);
            manager.setSessionCatalog({
                getSession: async id => ({ sessionId: id, owner: OWNER, parentSessionId: id === "wf" ? "parent" : null,
                    sessionKind: id === "wf" && !spawned ? "workflow" : "agent", state: "idle", deletedAt: null }),
                getSessionCreationConfig: async () => ({ [spawned ? "toolGrant" : "workflowToolBinding"]: JSON.parse(JSON.stringify(recorded)),
                    workflowToolLabels: { packagePins: {}, toolSources: { first: source.id } } }),
            });
            agent.prompt = "Changed prompt, unchanged tool names.";
            source.revision = "after";
            source.tools.set("unused", { name: "unused", parameters: { type: "string" } });
            first.description = "Changed description.";
            await expect(authorize("store_fact")).resolves.toBeDefined();
            await expect(authorize("first")).resolves.toBeDefined();
            first.parameters = { type: "object", properties: { changed: { type: "string" } } };
            await expect(authorize("first")).rejects.toThrow("Tool 'first' is unavailable or its contract changed");
            source.tools.delete("first");
            await expect(authorize("first")).rejects.toThrow("Tool 'first' is unavailable");
            if (!spawned) {
                agent.toolNames = ["different"];
                await expect(authorize("first")).rejects.toThrow("deployment agent tool names changed");
                delete lookup.fixture;
                await expect(authorize("first")).rejects.toBeInstanceOf(WorkflowToolAuthorityError);
            }
        });
    }

    it("matches real CLI contracts for Zod and parameterless registered tools", { timeout: 60_000 }, async () => {
        const directory = await mkdtemp(join(tmpdir(), "workflow-wire-pins-"));
        const provider = await createNativeCopilotProvider(() => { throw new Error("Unexpected inference"); });
        const client = new CopilotClient({ env: { ...process.env, COPILOT_HOME: join(directory, "home") }, logLevel: "error" });
        let session;
        try {
            const tools = [
                { name: "wire_zod", description: "Fixture", parameters: z.object({ value: z.string() }), handler: async () => "zod" },
                { name: "wire_empty", description: "Fixture", handler: async () => "empty" },
            ];
            session = await client.createSession({ model: "gpt-test", provider: {
                type: "openai", baseUrl: provider.baseUrl, apiKey: "fixture",
            }, tools });
            await session.rpc.tools.initializeAndValidate();
            const metadata = await session.rpc.tools.getCurrentMetadata();
            const source = { id: "static:wire", name: "wire", source: "static", revision: "wire",
                scope: "shared", tools: new Map(tools.map(tool => [tool.name, tool])), mcpServers: {}, artifacts: [] };
            const binding = { policy: "node-parent-tools-v1", parentSessionId: "parent", owner: OWNER, config: {},
                capabilities: { revision: 0, selections: [] },
                tools: captureWorkflowTools(metadata.tools).filter(tool => source.tools.has(tool.name)),
                sourceRevisions: { [source.id]: source.revision }, excludedTools: [], boundAgentFingerprint: "",
                toolSources: { wire_zod: source.id, wire_empty: source.id } };
            expect(binding.tools).toHaveLength(2);
            const manager = new SessionManager(undefined, null, { frameworkBasePrompt: "",
                getCapabilitySources: () => [source],
                getWorkflowCapabilitySnapshot: (grant, retained) => resolveWorkflowCapabilitySnapshot(
                    grant, retained, { listAgentPackages: async () => [], getAgentPackage: async () => null }, [source]) });
            manager.setSessionCatalog({
                getSession: async id => ({ sessionId: id, owner: OWNER, parentSessionId: id === "wf" ? "parent" : null,
                    sessionKind: id === "wf" ? "workflow" : "agent", state: "idle", deletedAt: null }),
                getSessionCreationConfig: async () => ({ workflowToolBinding: binding }),
            });
            for (const tool of tools) await expect(manager.authorizeWorkflowTools("wf", binding, tool.name)).resolves.toBeDefined();
            expect(provider.requests).toHaveLength(0);
        } finally {
            if (session) await session.disconnect();
            await client.stop();
            await provider.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
});
