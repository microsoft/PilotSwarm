/**
 * Scripted-model harness: proves a full worker (PostgreSQL, Duroxide, the
 * real Copilot CLI) runs deterministic turns against scripted-model.mjs, that
 * native tools really execute, and that every model request is captured.
 *
 * Also checks the pinned-version start helper against a frozen handler.
 *
 * Run: npx vitest run test/local/scripted-harness.test.js
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { PilotSwarmWorker } from "../helpers/local-workers.js";
import { scriptTurns } from "../helpers/scripted-model.mjs";
import { withScriptedModel } from "../helpers/scripted-workers.js";
import { pinSessionStartVersion, sessionOrchestrationVersion } from "../helpers/pinned-start.mjs";
import { DURABLE_SESSION_LATEST_VERSION, DURABLE_SESSION_ORCHESTRATION_REGISTRY } from "../../src/orchestration-registry.ts";

const TIMEOUT = 180_000;
const getEnv = useSuiteEnv(import.meta.url);

describe("scripted-model harness", () => {
    it("activates restricted MCP on a namespaced root and preserves its exact selection through worker restart", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const pluginDir = join(env.baseDir, "identity-plugin");
        const callsPath = join(env.baseDir, "mcp-calls.txt");
        mkdirSync(join(pluginDir, "agents"), { recursive: true });
        writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify({ name: "identity-fixture", version: "1.0.0" }));
        writeFileSync(join(pluginDir, "agents", "analyst.agent.md"),
            "---\nschemaVersion: 2\nversion: 1.0.0\nname: analyst\nmcpServers: []\ninheritDefaultMcpServers: false\n---\nSynthetic capability agent.\n");
        writeFileSync(join(pluginDir, ".mcp.json"), JSON.stringify({
            notes: {
                type: "stdio", command: process.execPath,
                args: [fileURLToPath(new URL("../helpers/native-task-mcp.mjs", import.meta.url)), callsPath],
                tools: ["read_note"], default: false, allowedAgents: ["identity-fixture:analyst"],
            },
        }));
        const owner = { provider: "test", subject: "restricted-mcp-owner", email: null, displayName: null };
        let phase = "discover";
        let discovered;
        const respond = (body, position) => {
            if (phase === "discover") {
                if (position.step === 0) return { tools: [{ name: "search_capabilities", args: { query: "notes", kinds: ["mcp"] } }] };
                discovered = JSON.parse(position.toolResults.at(-1)).capabilities.find(hit => hit.name === "notes");
                return { content: "MCP_DISCOVERED" };
            }
            const readTool = body.tools.find(tool => tool.function?.name?.endsWith("read_note"));
            if (readTool) {
                if (position.toolResults.some(result => result.includes("NOTE_READ_RESULT"))) return { content: "MCP_READ_COMPLETE" };
                return { tools: [{ name: readTool.function.name, args: {} }] };
            }
            if (phase === "activate" && position.step === 0) return { tools: [{
                name: "use_package", args: { source_ref: discovered.source_ref, mcp_servers: ["notes"],
                    expected_revision: 0, request_id: "restricted-mcp-activation" },
            }] };
            return { content: "MCP_NOT_AVAILABLE" };
        };
        const workerOptions = { pluginDirs: [pluginDir], nativeSubagents: "off" };
        await withScriptedModel(env, { respond, worker: workerOptions }, async ({ client, worker, model, modelProvidersPath, qualifiedModel }) => {
            const session = await client.createSessionForAgent("analyst", { model: qualifiedModel, owner });
            expect(await session.sendAndWait("Discover the optional notes MCP.", TIMEOUT)).toBe("MCP_DISCOVERED");
            expect(discovered).toMatchObject({ kind: "mcp", name: "notes", source: "static" });
            expect(model.sessionRequests()[0].body.tools.some(tool => tool.function?.name?.endsWith("read_note"))).toBe(false);
            const originalRef = discovered.source_ref;
            const catalog = await createCatalog(env);
            let replacement;
            try {
                expect(await catalog.getSessionCapabilities(session.sessionId)).toMatchObject({ revision: 0, selections: [] });
                phase = "activate";
                expect(await session.sendAndWait("Activate the discovered notes MCP and read a note.", TIMEOUT)).toBe("MCP_READ_COMPLETE");
                const selected = await catalog.getSessionCapabilities(session.sessionId);
                expect(selected).toMatchObject({ revision: 1, selections: [{
                    sourceRef: originalRef, tools: [], mcpServers: ["notes"],
                }] });
                expect(readFileSync(callsPath, "utf8").trim().split(/\r?\n/)).toEqual(["read_note"]);

                await worker.stop();
                replacement = new PilotSwarmWorker({
                    store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema,
                    factsSchema: env.factsSchema, sessionStateDir: env.sessionStateDir,
                    workerNodeId: "restricted-mcp-replacement", disableManagementAgents: true,
                    logLevel: "error", modelProvidersPath, ...workerOptions,
                });
                await replacement.start();
                phase = "read";
                expect(await session.sendAndWait("Read another note after the worker restart.", TIMEOUT)).toBe("MCP_READ_COMPLETE");
                expect(await catalog.getSessionCapabilities(session.sessionId)).toEqual(selected);
                expect(await catalog.getSession(session.sessionId)).toMatchObject({ sessionId: session.sessionId, owner, parentSessionId: null });
                expect(readFileSync(callsPath, "utf8").trim().split(/\r?\n/)).toEqual(["read_note", "read_note"]);
                expect(model.sessionRequests().some(request => request.body.tools.some(tool => tool.function?.name?.endsWith("write_note")))).toBe(false);
            } finally {
                await replacement?.stop();
                await catalog.close();
            }
        });
    });

    it("runs scripted turns with real native tools and captures requests", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const marker = `scripted-${env.runId}`;
        const respond = scriptTurns([
            // Turn 1: run a real shell command, then answer with its output.
            [
                { tools: [{ name: "bash", args: { command: `echo ${marker}`, description: "echo marker" } }] },
                (_body, position) => ({ content: `turn1:${position.toolResults.join("").includes(marker) ? "saw-marker" : "no-marker"}` }),
            ],
            // Turn 2: plain answer.
            [{ content: "turn2:ok" }],
        ]);

        await withScriptedModel(env, { respond }, async ({ client, model, qualifiedModel }) => {
            const sessionId = `00000000-0000-4000-8000-${env.runId.padStart(12, "0")}`;
            const session = await client.createSession({ sessionId, model: qualifiedModel });
            assertEqual(session.sessionId, sessionId, "fixed session id is honored");

            const first = await session.sendAndWait("first prompt", TIMEOUT);
            assertEqual(first, "turn1:saw-marker", "turn 1 ran bash and saw its output");

            const second = await session.sendAndWait("second prompt", TIMEOUT);
            assertEqual(second, "turn2:ok", "turn 2 answered from the second script entry");

            const requests = model.sessionRequests("first prompt");
            assert(requests.length >= 3, `expected at least 3 session requests, got ${requests.length}`);
            const firstRequest = requests[0];
            assertEqual(firstRequest.position.turn, 1);
            assertEqual(firstRequest.position.step, 0);
            assert(Array.isArray(firstRequest.body.tools) && firstRequest.body.tools.length > 0, "request carries the tool list");
            assert(firstRequest.body.messages.some((m) => m.role === "system"), "request carries a system message");
            const turn2 = requests.find((r) => r.position.turn === 2);
            assert(turn2, "a request for turn 2 was captured");
        });
    });

    it("starts a session at a pinned frozen orchestration version", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        const frozen = DURABLE_SESSION_ORCHESTRATION_REGISTRY.at(-2).version;
        assert(frozen !== DURABLE_SESSION_LATEST_VERSION, "the registry has a frozen version before the latest");

        await withScriptedModel(env, { respond: scriptTurns([[{ content: "pinned:ok" }]]) }, async ({ client, qualifiedModel }) => {
            const sessionId = `00000000-0000-4000-8001-${env.runId.padStart(12, "0")}`;
            const pin = pinSessionStartVersion(client, frozen, { sessionId });
            try {
                const session = await client.createSession({ sessionId, model: qualifiedModel });
                assertEqual(await session.sendAndWait("pinned prompt", TIMEOUT), "pinned:ok", "the frozen handler ran the turn");
            } finally {
                pin.restore();
            }
            assert(pin.starts.some((s) => s.used === frozen && s.requested === DURABLE_SESSION_LATEST_VERSION),
                `the start was pinned: ${JSON.stringify(pin.starts)}`);
            assertEqual(await sessionOrchestrationVersion(client, sessionId), frozen, "Duroxide records the pinned version");
        });
    });
});
