import { describe, expect, it } from "vitest";
import { CopilotClient } from "@github/copilot-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "../../src/session-manager.ts";
import { ModelProviderRegistry } from "../../src/model-providers.ts";
import { createArtifactTools } from "../../src/artifact-tools.ts";
import { FilesystemArtifactStore } from "../../src/session-store.ts";
import { captureWorkflowTools } from "../../src/workflow/tool-policy.ts";
import { runScriptNode } from "../../src/workflow/runner.ts";
import { createNativeCopilotProvider } from "../helpers/native-copilot-provider.mjs";

describe("FB-079 real CLI Workflow script output", () => {
    it("delivers a 100 KB PilotSwarm artifact through rpc.tools.execute without CLI replacement", { timeout: 60_000 }, async () => {
        const directory = await mkdtemp(join(tmpdir(), "workflow-large-output-"));
        const provider = await createNativeCopilotProvider(() => { throw new Error("Unexpected inference"); });
        const client = new CopilotClient({ env: { ...process.env, COPILOT_HOME: join(directory, "home") }, logLevel: "error" });
        const owner = { provider: "test", subject: "large-output-owner" };
        const parentId = randomUUID(), workflowId = randomUUID();
        const config = { model: "fixture:gpt-test", workingDirectory: directory, toolNames: ["read_artifact"] };
        const tools = createArtifactTools({ blobStore: new FilesystemArtifactStore(join(directory, "artifacts")) });
        const read = tools.find(tool => tool.name === "read_artifact");
        const write = tools.find(tool => tool.name === "write_artifact");
        const content = "0123456789".repeat(10_240);
        const manager = new SessionManager(undefined, null, {
            frameworkBasePrompt: "", nativeSubagents: "off",
            modelProviders: new ModelProviderRegistry({ providers: [{
                id: "fixture", type: "openai", baseUrl: provider.baseUrl, apiKey: "fixture", models: ["gpt-test"],
            }] }),
        }, join(directory, "sessions"));
        manager.ensureClient = async () => client;
        manager.setFactStore({
            readFacts: async () => ({ count: 0, facts: [] }),
            storeFact: async () => ({ stored: true }), deleteFact: async () => ({ deleted: true }),
        });
        manager.setToolRegistry(new Map([[read.name, read]]));
        let binding, discovery, executor;
        manager.setSessionCatalog({
            getSession: async id => ({ sessionId: id, owner, parentSessionId: id === workflowId ? parentId : null,
                sessionKind: id === workflowId ? "workflow" : "agent", state: "idle", deletedAt: null }),
            getSessionCreationConfig: async () => ({ workflowToolBinding: binding }),
            getSessionCapabilities: async () => ({ revision: 0, selections: [] }),
        });
        try {
            const written = JSON.parse(await write.handler({ filename: "large.txt", content }, { durableSessionId: workflowId }));
            expect(written.success).toBe(true);
            discovery = await client.createSession({
                model: "gpt-test", provider: { type: "openai", baseUrl: provider.baseUrl, apiKey: "fixture" }, tools: [read],
            });
            await discovery.rpc.tools.initializeAndValidate();
            binding = { policy: "node-parent-tools-v1", parentSessionId: parentId, owner, config,
                capabilities: { revision: 0, selections: [] },
                tools: captureWorkflowTools((await discovery.rpc.tools.getCurrentMetadata()).tools).filter(tool => tool.name === read.name),
                sourceRevisions: {}, excludedTools: [], boundAgentFingerprint: "" };
            expect(binding.tools).toHaveLength(1);
            executor = await manager.openWorkflowToolExecutor(workflowId, binding, 1);
            const result = await runScriptNode({
                sessionId: workflowId, node: { id: "read", timeoutSeconds: 30, source: `
                    const value = await callTool("read_artifact", { sessionId: context.inputs.sessionId,
                        filename: "large.txt", maxBytes: 150000 });
                    const replaced = typeof value === "string" && value.includes("Output too large to read at once");
                    const page = replaced ? null : JSON.parse(value);
                    await setResult("done", { replaced, type: typeof value, bytes: page?.content.length,
                        content: page?.content, prefix: replaced ? value.slice(0, 80) : null });
                ` },
                context: { input: null, inputs: { sessionId: workflowId } },
                callTool: call => executor.call(call.name, call.arguments),
            });
            console.log("FB079_REAL_CLI_RESULT", JSON.stringify({ outcome: result.outcome, replaced: result.output?.replaced,
                type: result.output?.type, bytes: result.output?.bytes, prefix: result.output?.prefix, modelRequests: provider.requests.length }));
            expect(result.outcome).toBe("done");
            expect(result.output?.replaced).toBe(false);
            expect(result.output).toEqual({ replaced: false, type: "string", bytes: content.length, content, prefix: null });
            expect(provider.requests).toHaveLength(0);
        } finally {
            try { if (executor) await executor.close(); }
            finally {
                try { await manager.shutdown(); if (discovery) await discovery.disconnect(); await client.stop(); }
                finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
            }
        }
    });
});
