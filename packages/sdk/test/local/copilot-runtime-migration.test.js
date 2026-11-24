import { describe, it, expect } from "vitest";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createCopilotClient, textOnlyCopilotSessionOptions } from "../../src/copilot-client.ts";
import { NATIVE_EXCLUDED_TOOLS } from "../../src/native-subagents.ts";
import { createCopilotProviderServer } from "../helpers/copilot-provider-server.mjs";

const MODEL = "fixture-model";
const RUNTIME_1_0_83_TOOLS = [
    "bash", "read_bash", "stop_bash", "list_bash", "view", "create", "edit",
    "web_fetch", "skill", "sql", "read_agent", "list_agents", "write_agent",
    "grep", "glob", "task",
];
const RUNTIME_1_0_112_TOOLS = [
    ...RUNTIME_1_0_83_TOOLS.slice(0, 8),
    "semantic_code_search", "skill", "run_dynamic_workflow", "dynamic_workflows_manage",
    ...RUNTIME_1_0_83_TOOLS.slice(9),
];
const WORKSPACE = fileURLToPath(new URL("../..", import.meta.url));
const UNCLEAN_OWNER = fileURLToPath(new URL("../helpers/copilot-runtime-unclean-owner.mjs", import.meta.url));
const LEGACY_FIXTURE = fileURLToPath(new URL("../fixtures/copilot-runtime-1.0.83-session/", import.meta.url));
const LEGACY_TOOL_FIXTURE = fileURLToPath(new URL("../fixtures/copilot-runtime-1.0.83-tool-session/", import.meta.url));

async function withRuntime(run) {
    const home = mkdtempSync(join(tmpdir(), "ps-runtime-migration-"));
    const server = await createCopilotProviderServer();
    const clients = [];
    const provider = { type: "openai", wireApi: "completions", baseUrl: server.baseUrl + "/v1", apiKey: "synthetic-key" };
    const options = { useLoggedInUser: false, env: { ...process.env, COPILOT_HOME: home }, logLevel: "error" };
    try {
        await run({ home, server, clients, provider, options });
    } finally {
        await Promise.all(clients.map(client => client.stop().catch(() => undefined)));
        await server.close();
        rmSync(home, { recursive: true, force: true });
    }
}

function installLegacyFixture(home, sessionId, fixture = LEGACY_FIXTURE) {
    const sessionDirectory = join(home, "session-state", sessionId);
    for (const relative of ["checkpoints", "files", "research"]) mkdirSync(join(sessionDirectory, relative), { recursive: true });
    for (const relative of ["workspace.yaml", "events.jsonl", "checkpoints/index.md"]) {
        const content = readFileSync(join(fixture, relative), "utf8").replaceAll("__WORKING_DIRECTORY__", home);
        writeFileSync(join(sessionDirectory, relative), content);
    }
}

describe("Copilot runtime 1.0.112 migration", () => {
    it("reports the bundled runtime and protocol versions", { timeout: 30_000 }, async () => {
        await withRuntime(async ({ clients, provider, options }) => {
            const client = new CopilotClient({ ...options, connection: RuntimeConnection.forStdio() });
            clients.push(client);
            await client.start();
            const status = await client.getStatus();
            expect(status).toMatchObject({ version: "1.0.112", protocolVersion: 3 });
            const session = await client.createSession({ model: MODEL, provider, onPermissionRequest: () => ({ kind: "approved" }) });
            expect(session.sessionId).toBeTruthy();
        });
    });

    it("resumes a session written by runtime 1.0.83", { timeout: 30_000 }, async () => {
        await withRuntime(async ({ home, server, clients, provider, options }) => {
            const sessionId = "runtime-1-0-83-fixture";
            expect(JSON.parse(readFileSync(join(LEGACY_FIXTURE, "fixture.json"), "utf8"))).toMatchObject({
                sessionId,
                generatedBy: { sdk: "1.0.13", runtime: "1.0.83", protocolVersion: 3 },
            });
            installLegacyFixture(home, sessionId);
            const client = createCopilotClient(options, provider);
            clients.push(client);
            const session = await client.resumeSession(sessionId, {
                model: MODEL,
                provider,
                workingDirectory: home,
                onPermissionRequest: () => ({ kind: "approved" }),
            });
            expect((await session.getEvents()).some(event => event.type === "assistant.message"
                && event.data.content === "Legacy fixture recorded.")).toBe(true);
            expect((await session.sendAndWait({ prompt: "Continue after migration." }, 20_000)).data.content)
                .toContain("violet-739");
            expect(server.requests.length).toBeGreaterThan(0);
        });
    });

    it("resumes a 1.0.83 session whose completed turn called a host tool", { timeout: 30_000 }, async () => {
        await withRuntime(async ({ home, server, clients, provider, options }) => {
            const sessionId = "runtime-1-0-83-tool-fixture";
            expect(JSON.parse(readFileSync(join(LEGACY_TOOL_FIXTURE, "fixture.json"), "utf8"))).toMatchObject({
                sessionId, generatedBy: { sdk: "1.0.13", runtime: "1.0.83", protocolVersion: 3 },
            });
            installLegacyFixture(home, sessionId, LEGACY_TOOL_FIXTURE);
            const client = createCopilotClient(options, provider);
            clients.push(client);
            const session = await client.resumeSession(sessionId, {
                model: MODEL, provider, workingDirectory: home,
                onPermissionRequest: () => ({ kind: "approved" }),
            });
            const events = await session.getEvents();
            expect(events.some(event => event.type === "tool.execution_complete"
                && event.data.toolCallId === "legacy-tool-1" && event.data.success === true)).toBe(true);
            expect((await session.sendAndWait({ prompt: "Repeat the tool token without calling another tool." }, 20_000)).data.content)
                .toContain("violet-739");
            expect(server.requests.length).toBeGreaterThan(0);
            const resumedRequest = JSON.stringify(server.requests.at(-1).body.messages);
            expect(resumedRequest).toContain("legacy-tool-1");
            expect(resumedRequest).toContain("legacy_value");
            expect(resumedRequest).toContain("violet-739");
        });
    });

    it("rejects duplicate tool names on create and resume", { timeout: 45_000 }, async () => {
        await withRuntime(async ({ clients, provider, options }) => {
            const client = createCopilotClient(options, provider);
            clients.push(client);
            const tool = {
                name: "duplicate_probe",
                description: "A duplicate declaration.",
                parameters: { type: "object", properties: {} },
                handler: async () => "unused",
            };
            await expect(client.createSession({
                model: MODEL, provider, tools: [tool, { ...tool }], onPermissionRequest: () => ({ kind: "approved" }),
            })).rejects.toThrow(/defined more than once/i);

            const sessionId = randomUUID();
            const session = await client.createSession({
                sessionId, model: MODEL, provider, tools: [tool], onPermissionRequest: () => ({ kind: "approved" }),
            });
            await session.sendAndWait({ prompt: "Say hello." }, 20_000);
            await session.disconnect();
            await expect(client.resumeSession(sessionId, {
                model: MODEL, provider, tools: [tool, { ...tool }], onPermissionRequest: () => ({ kind: "approved" }),
            })).rejects.toThrow(/defined more than once/i);
        });
    });

    it("keeps the same 15 PilotSwarm tool names after the 1.0.112 additions", () => {
        const exposedOld = RUNTIME_1_0_83_TOOLS.filter(name => !NATIVE_EXCLUDED_TOOLS.includes(name));
        const exposedNew = RUNTIME_1_0_112_TOOLS.filter(name => !NATIVE_EXCLUDED_TOOLS.includes(name));
        expect(exposedOld).toHaveLength(15);
        expect(exposedNew).toEqual(exposedOld);
    });

    it("keeps auxiliary model sessions tool-free on the real runtime", { timeout: 30_000 }, async () => {
        await withRuntime(async ({ clients, provider, options }) => {
            const client = createCopilotClient(options, provider);
            clients.push(client);
            const session = await client.createSession({
                model: MODEL,
                provider,
                ...textOnlyCopilotSessionOptions(),
                onPermissionRequest: () => ({ kind: "approved" }),
            });
            await session.rpc.tools.initializeAndValidate();
            expect((await session.rpc.tools.getCurrentMetadata()).tools).toEqual([]);
        });
    });

    it("composes available and excluded tools, and hides new unrequested built-ins", { timeout: 30_000 }, async () => {
        await withRuntime(async ({ clients, provider, options }) => {
            const client = createCopilotClient(options, provider);
            clients.push(client);
            const filtered = await client.createSession({
                model: MODEL,
                provider,
                availableTools: ["builtin:view", "builtin:bash", "custom:blocked_probe"],
                excludedTools: ["builtin:bash", "custom:blocked_probe"],
                tools: [{
                    name: "blocked_probe",
                    description: "Must be removed by the combined deny list.",
                    parameters: { type: "object", properties: {} },
                    handler: async () => "must not run",
                }],
                onPermissionRequest: () => ({ kind: "approved" }),
            });
            await filtered.rpc.tools.initializeAndValidate();
            expect((await filtered.rpc.tools.getCurrentMetadata()).tools.map(tool => tool.name)).toEqual(["view"]);

            const current = await client.createSession({
                model: MODEL,
                provider,
                onPermissionRequest: () => ({ kind: "approved" }),
            });
            await current.rpc.tools.initializeAndValidate();
            expect((await current.rpc.tools.getCurrentMetadata()).tools.map(tool => tool.name))
                .toEqual(RUNTIME_1_0_112_TOOLS);

            const hidden = await client.createSession({
                model: MODEL,
                provider,
                excludedTools: NATIVE_EXCLUDED_TOOLS,
                onPermissionRequest: () => ({ kind: "approved" }),
            });
            await hidden.rpc.tools.initializeAndValidate();
            const names = new Set((await hidden.rpc.tools.getCurrentMetadata()).tools.map(tool => tool.name));
            for (const tool of ["semantic_code_search", "run_dynamic_workflow", "dynamic_workflows_manage"]) {
                expect(names.has(tool)).toBe(false);
            }
            expect(names.has("skill")).toBe(true);
            expect([...names]).toEqual([
                "bash", "read_bash", "stop_bash", "list_bash", "view", "create", "edit",
                "web_fetch", "skill", "sql", "read_agent", "list_agents", "grep", "glob", "task",
            ]);
        });
    });

    it("accepts explicit BYOK effort and context tier options", { timeout: 30_000 }, async () => {
        await withRuntime(async ({ clients, provider, options }) => {
            const client = createCopilotClient(options, provider);
            clients.push(client);
            const session = await client.createSession({
                model: MODEL, provider, reasoningEffort: "high", contextTier: "long_context",
                onPermissionRequest: () => ({ kind: "approved" }),
            });
            expect((await session.sendAndWait({ prompt: "Report the configured options." }, 20_000)).data.content)
                .toContain("violet-739");
        });
    });

    it("refuses relative working directories and unknown send modes", { timeout: 30_000 }, async () => {
        await withRuntime(async ({ home, clients, provider, options }) => {
            const client = createCopilotClient(options, provider);
            clients.push(client);
            await expect(client.createSession({
                model: MODEL, provider, workingDirectory: "relative/path", onPermissionRequest: () => ({ kind: "approved" }),
            })).rejects.toThrow(/must be absolute/i);
            const session = await client.createSession({
                model: MODEL, provider, workingDirectory: home, onPermissionRequest: () => ({ kind: "approved" }),
            });
            await expect(session.send({ prompt: "Invalid mode.", mode: "impossible" }))
                .rejects.toThrow(/expected "enqueue" or "immediate"/i);
        });
    });

    it("refuses a resume while another process owns an active turn", { timeout: 45_000 }, async () => {
        const home = mkdtempSync(join(tmpdir(), "ps-runtime-active-"));
        let release;
        let requestStarted;
        const blockedRequest = new Promise(resolve => { requestStarted = resolve; });
        const releaseRequest = new Promise(resolve => { release = resolve; });
        const server = createServer(async (request, response) => {
            for await (const _chunk of request) { /* consume */ }
            requestStarted();
            await releaseRequest;
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({
                id: "active-resume", object: "chat.completion", model: MODEL,
                choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }));
        });
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        const provider = { type: "openai", wireApi: "completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "synthetic-key" };
        const options = { useLoggedInUser: false, env: { ...process.env, COPILOT_HOME: home }, logLevel: "error" };
        const first = createCopilotClient(options, provider);
        const second = createCopilotClient(options, provider);
        try {
            const sessionId = randomUUID();
            const session = await first.createSession({ sessionId, model: MODEL, provider, onPermissionRequest: () => ({ kind: "approved" }) });
            const turn = session.sendAndWait({ prompt: "Hold this turn." }, 20_000);
            await blockedRequest;
            await expect(second.resumeSession(sessionId, { model: MODEL, provider, onPermissionRequest: () => ({ kind: "approved" }) }))
                .rejects.toThrow();
            release();
            await turn;
        } finally {
            release();
            await first.stop().catch(() => undefined);
            await second.stop().catch(() => undefined);
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
            rmSync(home, { recursive: true, force: true });
        }
    });

    it("recovers a persisted session after an unclean worker process stop", { timeout: 45_000 }, async () => {
        await withRuntime(async ({ home, server, clients, provider, options }) => {
            const sessionId = randomUUID();
            const owner = spawn(process.execPath, [UNCLEAN_OWNER, home, sessionId, WORKSPACE], {
                stdio: ["ignore", "pipe", "inherit"],
                env: process.env,
            });
            try {
                await new Promise((resolve, reject) => {
                    owner.stdout.on("data", chunk => { if (chunk.toString().includes("READY")) resolve(); });
                    owner.on("exit", code => reject(new Error(`Unclean fixture exited before READY: ${code}`)));
                });
                const exited = once(owner, "exit");
                owner.kill("SIGKILL");
                const [exitCode, signal] = await exited;
                expect(exitCode).toBe(null);
                expect(signal).toBe("SIGKILL");

                const client = createCopilotClient(options, provider);
                clients.push(client);
                const session = await client.resumeSession(sessionId, {
                    model: MODEL, provider, workingDirectory: WORKSPACE, onPermissionRequest: () => ({ kind: "approved" }),
                });
                expect(session.sessionId).toBe(sessionId);
                expect((await session.sendAndWait({ prompt: "Continue after the unclean stop." }, 20_000)).data.content)
                    .toContain("violet-739");
                expect(server.requests.length).toBeGreaterThan(0);
            } finally {
                if (owner.exitCode === null && owner.signalCode === null) {
                    const exited = once(owner, "exit");
                    owner.kill("SIGKILL");
                    await exited.catch(() => undefined);
                }
            }
        });
    });
});
