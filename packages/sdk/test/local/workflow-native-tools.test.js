import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CopilotClient } from "@github/copilot-sdk";
import { createNativeCopilotProvider } from "../helpers/native-copilot-provider.mjs";
import { createWorkflowToolExecutor } from "../../src/workflow/tool-executor.ts";
import { captureWorkflowTools, workflowToolPermission } from "../../src/workflow/tool-policy.ts";
import { ManagedSession } from "../../src/managed-session.ts";

describe("workflow native tool executor", () => {
    it("permits a real MCP tool but cancels sampling without inference", { timeout: 60_000 }, async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-sampling-"));
        const serverPath = path.join(directory, "sampling.mjs");
        await writeFile(serverPath, `
import readline from "node:readline";
const send = message => process.stdout.write(JSON.stringify(message) + "\\n");
let pending;
readline.createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ jsonrpc: "2.0", id: message.id, result: {
    protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "sampling-fixture", version: "1" }
  } });
  else if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools: [
    { name: "echo", description: "Return a fixture marker", inputSchema: { type: "object" } },
    { name: "sample", description: "Exercise the sampling permission", inputSchema: { type: "object" } }
  ] } });
  else if (message.method === "tools/call" && message.params.name === "echo")
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "mcp-positive-control" }] } });
  else if (message.method === "tools/call") {
    pending = message.id;
    send({ jsonrpc: "2.0", id: "sampling-request", method: "sampling/createMessage", params: {
      maxTokens: 10, messages: [{ role: "user", content: { type: "text", text: "Do not run inference" } }]
    } });
  } else if (message.id === "sampling-request") {
    send({ jsonrpc: "2.0", id: pending, result: { content: [{ type: "text",
      text: JSON.stringify({ samplingRejected: Boolean(message.error) || message.result?.stopReason === "cancelled",
        model: message.result?.model ?? null }) }] } });
  }
});
`);
        const provider = await createNativeCopilotProvider(() => { throw new Error("Unexpected inference"); });
        const client = new CopilotClient({ env: { ...process.env, COPILOT_HOME: path.join(directory, "home") }, logLevel: "error" });
        let session, executor;
        const permissions = [];
        try {
            await client.start();
            session = await client.createSession({
                model: "test-model", provider: { type: "openai", baseUrl: provider.baseUrl, apiKey: "test-only" },
                workingDirectory: directory, excludedTools: ["task", "wait"], enableFileHooks: false,
                mcpServers: { sampling: { command: process.execPath, args: [serverPath], tools: ["*"] } },
                onPermissionRequest: request => { permissions.push(request.kind); return workflowToolPermission(request); },
            });
            await session.rpc.tools.initializeAndValidate();
            const metadata = await session.rpc.tools.getCurrentMetadata();
            executor = await createWorkflowToolExecutor({
                session, grants: captureWorkflowTools(metadata.tools), invocationPrefix: "workflow/mcp",
                authorize: async () => {}, dispose: async () => session.disconnect(),
            });
            expect(JSON.stringify(await executor.call("sampling/echo", {}))).toContain("mcp-positive-control");
            const sampled = await executor.call("sampling/sample", {});
            expect(provider.requests.length, JSON.stringify({ permissions, sampled })).toBe(0);
            // CLI 1.0.83 returns a cancelled sampling result on the model-free
            // route without emitting a separate mcp-sampling permission event.
            expect(permissions).toContain("mcp");
            expect(JSON.stringify(sampled)).toMatch(/samplingRejected\\?":\s*true/);
        } finally {
            if (executor) await executor.close();
            else if (session) await session.disconnect();
            await client.stop();
            await provider.close();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("stops its actual native background shell before releasing the state", { timeout: 60_000 }, async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-shell-cleanup-"));
        const provider = await createNativeCopilotProvider(() => { throw new Error("Unexpected inference"); });
        const client = new CopilotClient({ env: { ...process.env, COPILOT_HOME: path.join(directory, "home") }, logLevel: "error" });
        let session, executor;
        try {
            await client.start();
            session = await client.createSession({
                model: "test-model", provider: { type: "openai", baseUrl: provider.baseUrl, apiKey: "test-only" },
                workingDirectory: directory, availableTools: ["bash"], excludedTools: ["task", "wait"],
                enableFileHooks: false, onPermissionRequest: workflowToolPermission,
            });
            await session.rpc.tools.initializeAndValidate();
            const metadata = await session.rpc.tools.getCurrentMetadata();
            const managed = new ManagedSession("cleanup-child", session, {});
            executor = await createWorkflowToolExecutor({
                session, grants: captureWorkflowTools(metadata.tools), invocationPrefix: "workflow/background",
                authorize: async () => {}, dispose: async () => {
                    await managed.cancelBackgroundTasks();
                    await managed.destroy();
                },
            });
            await executor.call("bash", { command: "tail -f /dev/null", description: "Owned background shell fixture", mode: "async" });
            const tasks = (await session.rpc.tasks.list()).tasks.filter(task => task.type === "shell" && ["running", "idle"].includes(task.status));
            expect(tasks.length).toBeGreaterThan(0);
            const pids = tasks.map(task => Number(task.pid));
            for (const pid of pids) {
                expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
                expect(() => process.kill(pid, 0)).not.toThrow();
            }
            await executor.close();
            for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
            expect(provider.requests).toHaveLength(0);
        } finally {
            if (executor) await executor.close();
            else if (session) await session.disconnect();
            await client.stop();
            await provider.close();
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("uses the actual CLI file/shell tools, permission pipeline and no inference", { timeout: 60_000 }, async () => {
        const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-native-"));
        const provider = await createNativeCopilotProvider(() => { throw new Error("Unexpected inference"); });
        const client = new CopilotClient({ env: { ...process.env, COPILOT_HOME: path.join(directory, "home") }, logLevel: "error" });
        let session, executor, deny = false;
        const permissions = [];
        try {
            await writeFile(path.join(directory, "input.txt"), "native-workflow-marker\n");
            await client.start();
            session = await client.createSession({
                model: "test-model",
                provider: { type: "openai", baseUrl: provider.baseUrl, apiKey: "test-only" },
                workingDirectory: directory,
                availableTools: ["view", "bash"],
                excludedTools: ["task", "wait"],
                enableFileHooks: false,
                onPermissionRequest: async request => {
                    permissions.push(request.kind);
                    return deny ? { kind: "reject", feedback: "workflow permission fixture denied" } : { kind: "approve-once" };
                },
            });
            await session.rpc.tools.initializeAndValidate();
            const metadata = await session.rpc.tools.getCurrentMetadata();
            expect(metadata.tools.map(tool => tool.name).sort()).toEqual(["bash", "view"]);
            executor = await createWorkflowToolExecutor({
                session, grants: captureWorkflowTools(metadata.tools), invocationPrefix: "workflow/1/native",
                authorize: async () => undefined,
                dispose: async () => {
                    const tasks = await session.rpc.tasks.list();
                    for (const task of tasks.tasks ?? []) {
                        if (task.status === "running" || task.status === "idle") {
                            await session.rpc.tasks.cancel({ id: task.id });
                        }
                    }
                    await session.disconnect();
                },
            });
            expect(JSON.stringify(await executor.call("view", { path: path.join(directory, "input.txt") }))).toContain("native-workflow-marker");
            expect(JSON.stringify(await executor.call("bash", { command: "printf workflow-shell-marker", description: "Print a fixture marker" }))).toContain("workflow-shell-marker");
            await expect(executor.call("spawn_agent", { task: "must not run" })).rejects.toThrow(/not permitted/);
            deny = true;
            await expect(executor.call("bash", { command: "printf permission-must-deny", description: "Permission denial fixture" })).rejects.toThrow(/denied|reject|permission/i);
            expect(permissions).toContain("read");
            expect(permissions).toContain("shell");
            expect(provider.requests).toHaveLength(0);
        } finally {
            if (executor) await executor.close();
            else if (session) await session.disconnect();
            await client.stop();
            await provider.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
});
