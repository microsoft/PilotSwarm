import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CopilotClient } from "@github/copilot-sdk";
import { createNativeCopilotProvider } from "../helpers/native-copilot-provider.mjs";
import { createWorkflowToolExecutor } from "../../src/workflow/tool-executor.ts";
import { captureWorkflowTools } from "../../src/workflow/tool-policy.ts";

describe("workflow native tool executor", () => {
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
