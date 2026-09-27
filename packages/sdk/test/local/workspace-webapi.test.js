/**
 * Session workspaces over the Web API (docs/proposals/session-workspaces.md,
 * section 4.8): the real portal server, with no embedded workers, and one
 * scripted worker in this process on the same database. Covers the Web API
 * create-with-a-workspace half, B11 (the direct client, the
 * Web API clients, HttpApiTransport and MCP give the same results) and B13.
 *
 * Run: npx vitest run test/local/workspace-webapi.test.js
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";
import { registerScriptedProvider, FIXTURE_QUALIFIED_MODEL } from "../helpers/scripted-workers.js";
import { PilotSwarmClient, PilotSwarmManagementClient, PilotSwarmWorker } from "../../src/index.ts";
import { ApiClient, HttpApiTransport } from "pilotswarm-sdk/api";
import { createMcpServer } from "../../../app/mcp/dist/src/server.js";

const TIMEOUT = 180_000;
const firstLine = (toolResults) => toolResults.join("").trim().split("\n")[0];

let env;
let model;
let worker;
let server;
let apiUrl;
let root;
const saved = {};

/** Every turn: run pwd, then answer "out:<pwd>". */
const pwdEveryTurn = (_body, position) => (position.step === 0
    ? { tools: [{ name: "bash", args: { command: "pwd", description: "where" } }] }
    : { content: `out:${firstLine(position.toolResults)}` });

/** Drop fields that differ only by how a client reports "unknown". */
const comparable = (view) => ({
    workspace: view.workspace, revision: view.revision, path: view.path, status: view.status,
    lastError: view.lastError ? { code: view.lastError.code } : null, heldPrompts: view.heldPrompts,
});

async function mcpClient(ctx) {
    const mcp = createMcpServer(ctx);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "workspace-webapi", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
    return client;
}

describe("session workspaces over the Web API", () => {
    beforeAll(async () => {
        env = createTestEnv("ws-webapi");
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-ws-webapi-")));
        for (const folder of ["repo-x", "repo-y"]) fs.mkdirSync(path.join(root, folder));
        model = await startScriptedModel({ respond: pwdEveryTurn });
        const modelProvidersPath = await registerScriptedProvider(env, model.baseUrl);

        worker = new PilotSwarmWorker({
            store: env.store,
            duroxideSchema: env.duroxideSchema,
            cmsSchema: env.cmsSchema,
            factsSchema: env.factsSchema,
            sessionStateDir: env.sessionStateDir,
            workerNodeId: "webapi-worker",
            disableManagementAgents: true,
            logLevel: "error",
            modelProvidersPath,
            workspaceRoots: [{ name: "a", path: root }],
        });
        await worker.start();

        const env_ = {
            DATABASE_URL: env.store,
            PILOTSWARM_DUROXIDE_SCHEMA: env.duroxideSchema,
            PILOTSWARM_CMS_SCHEMA: env.cmsSchema,
            PILOTSWARM_FACTS_SCHEMA: env.factsSchema,
            SESSION_STATE_DIR: env.sessionStateDir,
            WORKERS: "0",
            PORTAL_TUI_MODE: "local",
            PS_MODEL_PROVIDERS_PATH: modelProvidersPath,
        };
        for (const [key, value] of Object.entries(env_)) {
            saved[key] = process.env[key];
            process.env[key] = value;
        }
        const { startServer } = await import("pilotswarm/web");
        server = await startServer({ port: 0 });
        apiUrl = `http://localhost:${server.address().port}`;
    }, 120_000);

    afterAll(async () => {
        if (server?.stopPortal) await server.stopPortal();
        await worker?.stop();
        await model?.close();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        if (root) fs.rmSync(root, { recursive: true, force: true });
        if (env) await env.cleanup();
    }, 120_000);

    it("creates a session with a workspace, and every client reads and changes it the same way (B11, B13)", { timeout: TIMEOUT }, async () => {
        const webClient = new PilotSwarmClient({ apiUrl });
        const webMgmt = new PilotSwarmManagementClient({ apiUrl });
        const directMgmt = new PilotSwarmManagementClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema });
        const transport = new HttpApiTransport({ apiUrl });
        await Promise.all([webClient.start(), webMgmt.start(), directMgmt.start(), transport.start?.()]);
        const mcp = await mcpClient({
            client: webClient, mgmt: webMgmt, api: new ApiClient({ apiUrl }), web: webMgmt,
            facts: { async readFacts() { return { count: 0, facts: [] }; } }, enhancedFacts: null, graph: null,
            admin: true, agentMgmt: "off", role: "admin", authz: { ownershipEnforced: false, defaultVisibility: "private", systemVisibility: "private" },
            webMode: true, models: null, skills: [], registeredAgents: [], systemAgentIds: new Set(), async refreshSystemAgentIds() {},
        });
        const mcpJson = async (name, args) => {
            const res = await mcp.callTool({ name, arguments: args });
            const text = res.content?.[0]?.text ?? "";
            try { return { isError: Boolean(res.isError), value: JSON.parse(text) }; } catch { return { isError: Boolean(res.isError), value: text }; }
        };
        try {
            // The web client carries workspace on createSession.
            const session = await webClient.createSession({ model: FIXTURE_QUALIFIED_MODEL, workspace: { root: "a", folder: "repo-x" } });
            assertEqual(await session.sendAndWait("webapi turn one", TIMEOUT), `out:${path.join(root, "repo-x")}`);

            // B13 + B11: the same view through every client.
            const views = {
                direct: await directMgmt.getSessionWorkspace(session.sessionId),
                web: await webMgmt.getSessionWorkspace(session.sessionId),
                transport: await transport.getSessionWorkspace(session.sessionId),
                mcp: (await mcpJson("get_session_workspace", { session_id: session.sessionId })).value,
            };
            assertEqual(views.direct.revision, 1, "created with revision 1");
            assertEqual(views.direct.workspace.folder, "repo-x");
            for (const [name, view] of Object.entries(views)) {
                assertEqual(JSON.stringify(comparable(view)), JSON.stringify(comparable(views.direct)), `${name} matches the direct client`);
            }

            // A stale revision is the same error everywhere.
            const staleWeb = await webMgmt.setSessionWorkspace(session.sessionId, { expectedRevision: 0, workspace: { root: "a", folder: "repo-y" } }).then(() => null, (e) => e);
            const staleTransport = await transport.setSessionWorkspace(session.sessionId, { expectedRevision: 0, workspace: { root: "a", folder: "repo-y" } }).then(() => null, (e) => e);
            const staleMcp = await mcpJson("set_session_workspace", { session_id: session.sessionId, expected_revision: 0, root: "a", folder: "repo-y" });
            assertEqual(staleWeb?.code, "WORKSPACE_REVISION_CONFLICT", `web: ${staleWeb?.message}`);
            assertEqual(staleWeb?.status, 409);
            assertEqual(staleTransport?.code, "WORKSPACE_REVISION_CONFLICT", `transport: ${staleTransport?.message}`);
            assert(staleMcp.isError && JSON.stringify(staleMcp.value).includes("WORKSPACE_REVISION_CONFLICT"), `mcp: ${JSON.stringify(staleMcp.value)}`);

            // A bad folder text is refused before it reaches the session.
            const badWeb = await webMgmt.setSessionWorkspace(session.sessionId, { expectedRevision: 1, workspace: { root: "a", folder: "../escape" } }).then(() => null, (e) => e);
            assertEqual(badWeb?.code, "WORKSPACE_PATH_INVALID");
            assertEqual(badWeb?.status, 400);

            // Set through MCP, read back through the transport; the next turn moves.
            const set = await mcpJson("set_session_workspace", { session_id: session.sessionId, expected_revision: 1, root: "a", folder: "repo-y" });
            assert(!set.isError, JSON.stringify(set.value));
            assertEqual(set.value.revision, 2);
            assertEqual((await transport.getSessionWorkspace(session.sessionId)).workspace.folder, "repo-y");
            assertEqual(await session.sendAndWait("webapi turn two", TIMEOUT), `out:${path.join(root, "repo-y")}`);

            // Retry on a session that is not held answers the same way everywhere.
            const retries = {
                web: await webMgmt.retrySessionWorkspace(session.sessionId),
                transport: await transport.retrySessionWorkspace(session.sessionId),
                mcp: (await mcpJson("retry_session_workspace", { session_id: session.sessionId })).value,
            };
            for (const [name, answer] of Object.entries(retries)) {
                assertEqual(JSON.stringify(answer), JSON.stringify(retries.web), `${name} retry matches`);
            }

            // A clear through the transport, read back through the direct client.
            await transport.setSessionWorkspace(session.sessionId, { expectedRevision: 2, workspace: null });
            assertEqual((await directMgmt.getSessionWorkspace(session.sessionId)).status, "none");
        } finally {
            await mcp.close?.();
            await Promise.all([webClient.stop(), webMgmt.stop(), directMgmt.stop(), transport.stop?.()].map((p) => Promise.resolve(p).catch(() => {})));
        }
    });

    it("the Web API refuses a bad workspace at creation with a structured error; MCP creates with one (B3)", { timeout: TIMEOUT }, async () => {
        const api = new ApiClient({ apiUrl });
        const refused = await api.call("createSession", { model: FIXTURE_QUALIFIED_MODEL, workspace: { root: "a", folder: "/etc" } }).then(() => null, (e) => e);
        assert(refused, "refused");
        assertEqual(refused.status, 400, `status: ${refused.message}`);
        assertEqual(refused.code, "WORKSPACE_PATH_INVALID");

        const webClient = new PilotSwarmClient({ apiUrl });
        const webMgmt = new PilotSwarmManagementClient({ apiUrl });
        await Promise.all([webClient.start(), webMgmt.start()]);
        const mcp = await mcpClient({
            client: webClient, mgmt: webMgmt, api, web: webMgmt,
            facts: { async readFacts() { return { count: 0, facts: [] }; } }, enhancedFacts: null, graph: null,
            admin: true, agentMgmt: "off", role: "admin", authz: { ownershipEnforced: false, defaultVisibility: "private", systemVisibility: "private" },
            webMode: true, models: null, skills: [], registeredAgents: [], systemAgentIds: new Set(), async refreshSystemAgentIds() {},
        });
        try {
            const res = await mcp.callTool({ name: "create_session", arguments: { model: FIXTURE_QUALIFIED_MODEL, workspace_root: "a", workspace_folder: "repo-x", prompt: "webapi mcp created" } });
            assert(!res.isError, res.content?.[0]?.text);
            const created = JSON.parse(res.content[0].text);
            assertEqual(created.workspace.folder, "repo-x");
            const deadline = Date.now() + 90_000;
            let view;
            do {
                view = await webMgmt.getSessionWorkspace(created.session_id);
                if (view.revision >= 1) break;
                await new Promise((r) => setTimeout(r, 250));
            } while (Date.now() < deadline);
            assertEqual(view.workspace?.folder, "repo-x", "the session MCP created has the workspace");
            const noRoot = await mcp.callTool({ name: "create_session", arguments: { workspace_folder: "repo-x" } });
            assert(noRoot.isError, "a folder without a root is refused");
        } finally {
            await mcp.close?.();
            await Promise.all([webClient.stop(), webMgmt.stop()].map((p) => Promise.resolve(p).catch(() => {})));
        }
    });
});
