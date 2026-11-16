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

async function withArtifactScript(artifact, check) {
    const directory = await mkdtemp(join(tmpdir(), "workflow-large-output-"));
    const provider = await createNativeCopilotProvider(() => { throw new Error("Unexpected inference"); });
    const client = new CopilotClient({ env: { ...process.env, COPILOT_HOME: join(directory, "home") }, logLevel: "error" });
    const owner = { provider: "test", subject: "large-output-owner" };
    const parentId = randomUUID(), workflowId = randomUUID();
    const config = { model: "fixture:gpt-test", workingDirectory: directory, toolNames: ["read_artifact"] };
    const tools = createArtifactTools({ blobStore: new FilesystemArtifactStore(join(directory, "artifacts")) });
    const read = tools.find(tool => tool.name === "read_artifact");
    const write = tools.find(tool => tool.name === "write_artifact");
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
        recordEvents: async () => {},
    });
    try {
        const written = JSON.parse(await write.handler(artifact, { durableSessionId: workflowId }));
        expect(written.success, JSON.stringify(written)).toBe(true);
        discovery = await client.createSession({
            model: "gpt-test", provider: { type: "openai", baseUrl: provider.baseUrl, apiKey: "fixture" }, tools: [read],
        });
        await discovery.rpc.tools.initializeAndValidate();
        binding = { policy: "node-parent-tools-v1", parentSessionId: parentId, owner, config,
            capabilities: { revision: 0, selections: [] },
            tools: captureWorkflowTools((await discovery.rpc.tools.getCurrentMetadata()).tools).filter(tool => tool.name === read.name),
            sourceRevisions: {}, excludedTools: [], boundAgentFingerprint: "" };
        expect(binding.tools).toHaveLength(1);
        executor = await manager.openWorkflowToolExecutor(workflowId, binding, 20);
        await check(async (source, inputs = {}) => {
            const result = await runScriptNode({
                sessionId: workflowId, node: { id: "read", timeoutSeconds: 30, source },
                context: { input: null, inputs: { sessionId: workflowId, filename: artifact.filename, ...inputs } },
                callTool: call => executor.call(call.name, call.arguments),
            });
            console.log("FB079_REAL_CLI_RESULT", JSON.stringify({ filename: artifact.filename, outcome: result.outcome,
                replaced: result.output?.replaced, type: result.output?.type, bytes: result.output?.bytes,
                prefix: result.output?.prefix, pages: result.output?.pages?.length,
                toolCalls: result.toolCalls.length, allCallsOk: result.toolCalls.every(call => call.ok),
                modelRequests: provider.requests.length }));
            return result;
        });
        expect(provider.requests).toHaveLength(0);
    } finally {
        try { if (executor) await executor.close(); }
        finally {
            try { await manager.shutdown(); if (discovery) await discovery.disconnect(); await client.stop(); }
            finally { await provider.close(); await rm(directory, { recursive: true, force: true }); }
        }
    }
}

const counterContent = bytes => Array.from({ length: Math.ceil(bytes / 10) },
    (_, n) => `${String(n).padStart(9, "0")}\n`).join("").slice(0, bytes);

const pagingScript = `
    const chunks = [], pages = [];
    let offset = 0, finished = false;
    for (let n = 0; n < 20; n++) {
        const page = JSON.parse(await callTool("read_artifact", {
            sessionId: context.inputs.sessionId, filename: context.inputs.filename,
            offset, maxBytes: context.inputs.maxBytes, encoding: context.inputs.encoding,
        }));
        chunks.push(Buffer.from(page.content, context.inputs.encoding));
        pages.push({ offset, eof: page.eof, nextOffset: page.nextOffset, truncated: page.truncated });
        offset = page.nextOffset;
        if (page.eof) { finished = true; break; }
    }
    await setResult(finished ? "done" : "page_cap", {
        content: Buffer.concat(chunks).toString(context.inputs.encoding), pages,
    });
`;

function expectPages(result, size, maxBytes) {
    const count = Math.ceil(size / maxBytes);
    expect(result.outcome).toBe("done");
    expect(result.output.pages).toEqual(Array.from({ length: count }, (_, n) => ({
        offset: n * maxBytes, eof: n === count - 1,
        nextOffset: n === count - 1 ? null : (n + 1) * maxBytes, truncated: true,
    })));
    expect(result.output.pages.length).toBeLessThan(20);
    expect(result.toolCalls).toHaveLength(count);
    expect(result.toolCalls.every(call => call.name === "read_artifact" && call.ok)).toBe(true);
}

describe("FB-079 real CLI Workflow script output", () => {
    it("delivers a 100 KB PilotSwarm artifact through rpc.tools.execute without CLI replacement", { timeout: 60_000 }, async () => {
        const content = "0123456789".repeat(10_240);
        await withArtifactScript({ filename: "large.txt", content }, async run => {
            const result = await run(`
                    const value = await callTool("read_artifact", { sessionId: context.inputs.sessionId,
                        filename: "large.txt", maxBytes: 150000 });
                    const replaced = typeof value === "string" && value.includes("Output too large to read at once");
                    const page = replaced ? null : JSON.parse(value);
                    await setResult("done", { replaced, type: typeof value, bytes: page?.content.length ?? null,
                        content: page?.content ?? null, prefix: replaced ? value.slice(0, 80) : null });
            `);
            expect(result.outcome).toBe("done");
            expect(result.output?.replaced).toBe(false);
            expect(result.output).toEqual({ replaced: false, type: "string", bytes: content.length, content, prefix: null });
        });
    });

    it("joins nine 12,000-byte pages to EOF without reaching the 20-page cap", { timeout: 60_000 }, async () => {
        const content = counterContent(100_000);
        expect(Buffer.byteLength(content)).toBe(100_000);
        await withArtifactScript({ filename: "counter.txt", content }, async run => {
            const result = await run(pagingScript, { maxBytes: 12_000, encoding: "utf-8" });
            expectPages(result, 100_000, 12_000);
            expect(result.output.pages).toHaveLength(9);
            expect(Buffer.from(result.output.content)).toEqual(Buffer.from(content));
        });
    });

    it("decodes each base64 page before joining all 256 byte values", { timeout: 60_000 }, async () => {
        const content = Buffer.from(Array.from({ length: 30_721 }, (_, n) => n % 256));
        expect(new Set(content).size).toBe(256);
        await withArtifactScript({ filename: "bytes.bin", content: content.toString("base64"),
            encoding: "base64", contentType: "application/octet-stream" }, async run => {
            // A page size not divisible by three requires decoding each base64 page separately.
            const result = await run(pagingScript, { maxBytes: 12_001, encoding: "base64" });
            expectPages(result, content.length, 12_001);
            expect(Buffer.from(result.output.content, "base64")).toEqual(content);
        });
    });

    it("hits the 12-page cap instead of completing when the old loop stops on truncated", { timeout: 60_000 }, async () => {
        const content = counterContent(100_000);
        await withArtifactScript({ filename: "legacy-counter.txt", content }, async run => {
            const result = await run(`
                const pages = [];
                let offset = 0, joined = "", finished = false;
                for (let n = 0; n < 12; n++) {
                    const page = JSON.parse(await callTool("read_artifact", {
                        sessionId: context.inputs.sessionId, filename: context.inputs.filename, offset, maxBytes: 12000,
                    }));
                    joined += page.content;
                    pages.push({ offset, eof: page.eof, nextOffset: page.nextOffset,
                        truncated: page.truncated, bytes: page.range.length });
                    if (page.truncated === false) { finished = true; break; }
                    offset += page.range.length;
                }
                await setResult(finished ? "done" : "page_cap", { content: joined, pages });
            `);
            expect(result.outcome).toBe("page_cap");
            expect(() => expectPages(result, 100_000, 12_000)).toThrow();
            expect(result.output.content).toBe(content);
            expect(result.output.pages).toHaveLength(12);
            expect(result.output.pages.every(page => page.truncated)).toBe(true);
            expect(result.output.pages[8]).toEqual({ offset: 96_000, eof: true, nextOffset: null, truncated: true, bytes: 4_000 });
            expect(result.output.pages.slice(9)).toEqual(Array.from({ length: 3 }, () => ({
                offset: 100_000, eof: true, nextOffset: null, truncated: true, bytes: 0,
            })));
            expect(result.toolCalls).toHaveLength(12);
            expect(result.toolCalls.every(call => call.name === "read_artifact" && call.ok)).toBe(true);
        });
    });

    it("finishes an exact 24,000-byte boundary after two pages without an empty third page", { timeout: 60_000 }, async () => {
        const content = counterContent(24_000);
        expect(Buffer.byteLength(content)).toBe(24_000);
        await withArtifactScript({ filename: "exact.txt", content }, async run => {
            const result = await run(pagingScript, { maxBytes: 12_000, encoding: "utf-8" });
            expectPages(result, 24_000, 12_000);
            expect(result.output.pages).toHaveLength(2);
            expect(result.output.content).toBe(content);
        });
    });
});
