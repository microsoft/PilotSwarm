#!/usr/bin/env node
// Unit test — conditional tool registration (proposal mcp-web-api-parity G1/G2).
//
// The parity work's core invariant: tools for absent capabilities are ABSENT
// from tools/list (not present-but-erroring). This suite builds the real
// McpServer against mock ServerContext permutations and asserts exact
// membership over the capability-gated subsets:
//
//   {enhancedFacts: ±, graph: ±, admin: ±, api/webMode: ±}
//
// Pure mock — no DB, no network. Uses the MCP SDK's InMemoryTransport with a
// real Client so membership is asserted through the actual protocol.
//
// Usage:  node packages/app/mcp/test/unit/registration.unit.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../dist/src/server.js";

const results = [];
function record(name, ok, detail = "") {
    results.push({ name, ok });
    console.log(`${ok ? "✅" : "❌"} ${name.padEnd(64)} ${ok ? "PASS" : "FAIL"}${detail ? ` (${detail})` : ""}`);
}

// ── Mock context builders ───────────────────────────────────────────────────

function baseMgmt() {
    return {
        async listSessions() { return []; },
        async getSession() { return null; },
        async getDefaultModel() { return "mock:model"; },
    };
}

function mockEnhancedFacts() {
    return {
        capabilities: { search: true, embedder: true },
        async searchFacts() { return { count: 0, mode: "hybrid", facts: [] }; },
        async similarFacts() { return { count: 0, mode: "semantic", facts: [] }; },
        async embedderStatus() { return { running: false }; },
        async startEmbedder() { return { running: true }; },
        async stopEmbedder() { return { running: false }; },
    };
}

function mockGraph({ namespaces = true, stats = true } = {}) {
    const g = {
        async searchGraphNodes() { return []; },
        async searchGraphEdges() { return []; },
        async graphNeighbourhood() { return { nodes: [], edges: [] }; },
        async upsertGraphNode() { return { nodeKey: "k", kind: "t", name: "n", aliases: [], created: true }; },
        async upsertGraphEdge() { return {}; },
        async deleteGraphNode() { return true; },
        async deleteGraphEdge() { return true; },
        async removeGraphEvidence() { return {}; },
    };
    if (stats) g.graphStats = async () => ({ nodeCount: 0, edgeCount: 0 });
    if (namespaces) {
        g.listGraphNamespaces = async () => [];
        g.getGraphNamespace = async () => null;
        g.upsertGraphNamespace = async (i) => ({ namespace: i.namespace, archived: false, frontmatter: i.frontmatter });
        g.deleteGraphNamespace = async () => ({ deleted: true, nodesDeleted: 0, edgesDeleted: 0 });
    }
    return g;
}

function mockApi() {
    return {
        async call() { return {}; },
        async getAuthContext() { return { authorization: { role: "admin" } }; },
    };
}

// Mirrors the real invariant: ctx.web is non-null exactly when ctx.api is —
// same deployment connection, honestly-typed handle. ops mirrors the
// generated surface: every method resolves an empty result.
function mockWeb() {
    const ops = new Proxy({}, { get: () => async () => ({}) });
    return { ops };
}

function makeCtx({ enhanced = false, graph = false, admin = false, web = false } = {}) {
    return {
        client: {},
        mgmt: baseMgmt(),
        facts: { async readFacts() { return { count: 0, facts: [] }; } },
        enhancedFacts: enhanced ? mockEnhancedFacts() : null,
        graph: graph ? mockGraph() : null,
        api: web ? mockApi() : null,
        web: web ? mockWeb() : null,
        admin,
        webMode: web,
        models: null,
        skills: [],
        registeredAgents: [],
        systemAgentIds: new Set(),
        async refreshSystemAgentIds() {},
    };
}

async function withClient(ctx, run) {
    const server = createMcpServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "reg-test", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try { return await run(client); }
    finally { await client.close(); }
}

async function listToolNames(ctx) {
    return withClient(ctx, async (client) => new Set((await client.listTools()).tools.map((t) => t.name)));
}

async function callTool(ctx, name, args) {
    return withClient(ctx, (client) => client.callTool({ name, arguments: args }));
}

// ── Assertions ──────────────────────────────────────────────────────────────

const ENHANCED_TOOLS = ["search_facts", "similar_facts", "embedder_status"];
const EMBEDDER_ADMIN = ["start_embedder", "stop_embedder"];
const GRAPH_TOOLS = [
    "graph_search_nodes", "graph_search_edges", "graph_neighbourhood", "graph_stats",
    "graph_upsert_node", "graph_upsert_edge", "graph_delete_node", "graph_delete_edge",
    "list_graph_namespaces", "get_graph_namespace",
];
const GRAPH_ADMIN = ["upsert_graph_namespace", "delete_graph_namespace"];
const WEB_TOOLS = ["list_artifacts", "get_artifact", "upload_artifact", "copy_artifact", "pin_artifact", "delete_artifact", "send_session_event", "get_system_status", "export_execution_history"];
const ADMIN_TOOLS = ["restart_system_session", "facts_admin"];
const ALWAYS_TOOLS = [
    "create_session", "send_message", "send_and_wait", "list_sessions", "get_session_detail",
    "get_capabilities", "stop_turn", "steer_session_turn", "complete_session", "cancel_pending_messages",
    "list_session_groups", "manage_session_group", "get_session_metrics", "get_fleet_overview",
    "list_child_outcomes", "get_execution_history", "list_agents", "get_agent_tree",
    "debug_session",
    // Security model: sharing management + the grantee-lookup helper.
    "set_session_visibility", "grant_session_share", "revoke_session_share",
    "list_session_shares", "list_known_users",
];
// Workflow: discovery/read/skills/session creation are always registered; update_workflow, workflow_definition, and send_workflow_input require workflowCommands: true.
const WORKFLOW_TOOLS = ["read_workflow", "list_creatable_workflows", "create_session_for_workflow", "read_workflow_skill"];
const WORKFLOW_COMMAND_TOOLS = ["update_workflow", "workflow_definition", "send_workflow_input"];

function expectAll(names, tools, present, label) {
    const misses = tools.filter((t) => names.has(t) !== present);
    record(label, misses.length === 0, misses.length ? `${present ? "missing" : "leaked"}: ${misses.join(",")}` : "");
}

async function main() {
    // 1. Bare direct-mode ctx: no enhanced/graph/web/admin extras.
    {
        const names = await listToolNames(makeCtx());
        expectAll(names, ALWAYS_TOOLS, true, "bare ctx: unconditional tools present");
        expectAll(names, WORKFLOW_TOOLS, true, "bare ctx: read_workflow present with no setting");
        expectAll(names, [...ENHANCED_TOOLS, ...EMBEDDER_ADMIN], false, "bare ctx: no enhanced-facts tools");
        expectAll(names, [...GRAPH_TOOLS, ...GRAPH_ADMIN], false, "bare ctx: no graph tools");
        expectAll(names, WEB_TOOLS, false, "bare ctx: no web-only tools");
        expectAll(names, ADMIN_TOOLS, false, "bare ctx: no admin tools");
        expectAll(names, WORKFLOW_COMMAND_TOOLS, false, "bare ctx: no workflow command/definition tools");
    }

    // 2. Fully-loaded admin web ctx: everything present.
    {
        const names = await listToolNames(makeCtx({ enhanced: true, graph: true, admin: true, web: true }));
        expectAll(names, ALWAYS_TOOLS, true, "full ctx: unconditional tools present");
        expectAll(names, WORKFLOW_TOOLS, true, "full ctx: workflow discovery/read/skill tools present");
        expectAll(names, [...ENHANCED_TOOLS, ...EMBEDDER_ADMIN], true, "full ctx: enhanced-facts tools present");
        expectAll(names, [...GRAPH_TOOLS, ...GRAPH_ADMIN], true, "full ctx: graph tools present");
        expectAll(names, WEB_TOOLS, true, "full ctx: web-only tools present");
        expectAll(names, ADMIN_TOOLS, true, "full ctx: admin tools present");
    }

    // 2b. Workflows are always on: discovery/read/skill tools are always registered, and workflowCommands adds update_workflow + workflow_definition.
    {
        const names = await listToolNames(makeCtx({ enhanced: true, graph: true, admin: true, web: true }));
        expectAll(names, ALWAYS_TOOLS, true, "unconditional tools present");
        expectAll(names, WORKFLOW_TOOLS, true, "workflow discovery/read/skill tools present");
        const commands = await listToolNames({ ...makeCtx(), workflowCommands: true });
        expectAll(commands, [...WORKFLOW_TOOLS, ...WORKFLOW_COMMAND_TOOLS], true, "workflowCommands adds update_workflow and workflow_definition");
    }

    // 3. Non-admin with providers: read tools present, [admin] subset absent.
    {
        const names = await listToolNames(makeCtx({ enhanced: true, graph: true, admin: false, web: true }));
        expectAll(names, ENHANCED_TOOLS, true, "non-admin: enhanced read tools present");
        expectAll(names, EMBEDDER_ADMIN, false, "non-admin: embedder start/stop absent");
        expectAll(names, GRAPH_TOOLS, true, "non-admin: graph read/write tools present");
        expectAll(names, GRAPH_ADMIN, false, "non-admin: namespace admin tools absent");
        expectAll(names, ADMIN_TOOLS, false, "non-admin: restart/facts_admin absent");
    }

    // 4. Graph provider WITHOUT optional namespace/stats methods.
    {
        const ctx = makeCtx({ graph: true, admin: true });
        ctx.graph = mockGraph({ namespaces: false, stats: false });
        const names = await listToolNames(ctx);
        expectAll(names, ["graph_search_nodes", "graph_upsert_node"], true, "minimal graph: core tools present");
        expectAll(names, ["graph_stats", "list_graph_namespaces", "get_graph_namespace", ...GRAPH_ADMIN], false, "minimal graph: optional-method tools absent");
    }

    // 5. get_capabilities descriptor mirrors ctx truth.
    {
        const ctx = makeCtx({ enhanced: true, graph: true, admin: true, web: true });
        const server = createMcpServer(ctx);
        const [ct, st] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: "cap-test", version: "1.0.0" }, { capabilities: {} });
        await Promise.all([server.connect(st), client.connect(ct)]);
        const res = await client.callTool({ name: "get_capabilities", arguments: {} });
        const caps = JSON.parse(res.content[0].text);
        record("capabilities: mode=web", caps.mode === "web");
        record("capabilities: admin=true", caps.admin === true);
        record("capabilities: facts.search=true", caps.facts?.search === true);
        record("capabilities: graph=true", caps.graph === true);
        await client.close();

        const bare = makeCtx();
        const server2 = createMcpServer(bare);
        const [ct2, st2] = InMemoryTransport.createLinkedPair();
        const client2 = new Client({ name: "cap-test-2", version: "1.0.0" }, { capabilities: {} });
        await Promise.all([server2.connect(st2), client2.connect(ct2)]);
        const res2 = await client2.callTool({ name: "get_capabilities", arguments: {} });
        const caps2 = JSON.parse(res2.content[0].text);
        record("capabilities: bare mode=direct", caps2.mode === "direct");
        record("capabilities: bare graph=false", caps2.graph === false);
        record("capabilities: bare facts.search=false", caps2.facts?.search === false);
        await client2.close();
    }

    // 6. Sharing refusals keep their machine-readable code/status in direct and Web MCP mode.
    // A deterministic system-session id: UUID-shaped, not RFC 4122 (see session-id.ts).
    const SYSTEM_ID = "22013ffb-08cb-a1a4-de5b-3039b4fb7826";
    for (const web of [false, true]) {
        const mode = web ? "web" : "direct";
        const ctx = makeCtx({ web });
        const refusal = () => Object.assign(
            new Error("System session sharing is controlled by deployment policy and cannot be changed."),
            { code: "SYSTEM_SESSION_PROTECTED", status: 409 },
        );
        if (web) ctx.api.call = async () => { throw refusal(); };
        else {
            ctx.mgmt.setSessionVisibility = async () => { throw refusal(); };
            ctx.mgmt.grantSessionShare = async () => { throw refusal(); };
        }
        for (const [tool, args] of [
            ["set_session_visibility", { session_id: SYSTEM_ID, visibility: "shared_read" }],
            ["grant_session_share", { session_id: SYSTEM_ID, provider: "dev", subject: "bob", access: "read" }],
        ]) {
            const result = await callTool(ctx, tool, args);
            const payload = JSON.parse(result.content[0].text);
            record(`${mode}: ${tool} preserves refusal`, result.isError === true
                && payload.code === "SYSTEM_SESSION_PROTECTED"
                && payload.status === 409
                && payload.session_id === SYSTEM_ID);
        }
    }

    // 7. Task 4: Direct-mode createDirectArtifactStore falls back to filesystem and fails fast on broken blob config.
    {
        const { createDirectArtifactStore } = await import("../../dist/src/context.js");
        const fsStore = createDirectArtifactStore({});
        record("direct artifactStore: filesystem fallback non-null", Boolean(fsStore && typeof fsStore.uploadArtifact === "function"));
        let threwBroken = false;
        try {
            createDirectArtifactStore({ AZURE_STORAGE_CONNECTION_STRING: "DefaultEndpointsProtocol=https" });
        } catch (err) {
            threwBroken = /Azure Blob Storage is configured but cannot be initialized/.test(String(err?.message || err));
        }
        record("direct artifactStore: broken blob config fails fast", threwBroken);
    }

    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
});
