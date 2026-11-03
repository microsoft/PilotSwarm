/**
 * Direct-parity shims: the direct client's positional signatures, verified
 * against the exact wire calls they must produce (pure, no network).
 *
 * `new PilotSwarmManagementClient({ apiUrl })` returns the web client under
 * the direct client's TYPE. The compile-time proof
 * (_WebSatisfiesManagementSurface) guarantees every direct method EXISTS on
 * the web client; these tests guarantee each shim also maps its positional
 * arguments onto the right operation and wire params — the mapping mirrors
 * the web fact/graph stores, which exercised these shapes in production.
 *
 * A wrong mapping here is the exact bug class this layer exists to kill:
 * `placeSessionsInGroup(viewer, ids, gid)` used to send the viewer object as
 * the sessionIds array, silently.
 *
 * Run: node --test test/unit/web-client-shims.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { WebPilotSwarmManagementClient } from "../../dist/web/web-management-client.js";
import { createManagementOps } from "../../dist/web/generated-op-methods.js";
import { buildOperationRequest, WEB_MODE_UNSUPPORTED } from "../../api/src/protocol.js";

function clientWithFakeApi() {
    const client = Object.create(WebPilotSwarmManagementClient.prototype);
    const calls = [];
    client._api = { call: async (name, params) => { calls.push({ name, params }); return "ok"; } };
    Object.defineProperty(client, "ops", {
        value: createManagementOps((name, params) => client._api.call(name, params)),
    });
    return { client, calls };
}

const USER = { provider: "entra", subject: "u1" };

/**
 * One row per shim: positional invocation → expected (op, wire params).
 * `undefined` values are asserted verbatim — buildOperationRequest drops
 * them at request time, so the shape here is what the shim itself emits.
 */
const SHIM_CASES = [
    // — workflow v2: a person's command (the server stamps the actor; options are not sent) —
    { call: (c) => c.updateWorkflow("wf-1", { operation: "pause", operation_id: "p-1" }, { principal: USER }), op: "updateWorkflow",
        params: { sessionId: "wf-1", command: { operation: "pause", operation_id: "p-1" } } },
    // — facts —
    { call: (c) => c.readFacts({ keyPattern: "k*", scope: "shared" }), op: "readFacts", params: { keyPattern: "k*", scope: "shared" } },
    { call: (c) => c.storeFact({ key: "k", value: 1 }), op: "storeFact", params: { input: { key: "k", value: 1 } } },
    { call: (c) => c.deleteFact({ key: "k" }), op: "deleteFact", params: { input: { key: "k" } } },
    { call: (c) => c.searchFacts("q", { limit: 5 }), op: "searchFacts", params: { query: "q", opts: { limit: 5 } } },
    { call: (c) => c.similarFacts("scope-1", { limit: 3 }), op: "similarFacts", params: { scopeKey: "scope-1", opts: { limit: 3 } } },
    { call: (c) => c.forcePurgeFacts({ olderThanDays: 7 }), op: "forcePurgeFacts", params: { input: { olderThanDays: 7 } } },
    // — embedder —
    { call: (c) => c.getEmbedderStatus(), op: "getEmbedderStatus", params: {} },
    { call: (c) => c.startEmbedder({ intervalSeconds: 60, batch: 10 }), op: "startFactsEmbedder", params: { intervalSeconds: 60, batch: 10 } },
    { call: (c) => c.stopEmbedder("done"), op: "stopFactsEmbedder", params: { reason: "done" } },
    // — graph —
    { call: (c) => c.searchGraphNodes({ text: "x" }), op: "searchGraphNodes", params: { query: { text: "x" } } },
    { call: (c) => c.searchGraphEdges({ text: "y" }), op: "searchGraphEdges", params: { query: { text: "y" } } },
    { call: (c) => c.graphNeighbourhood("n1", 2, { namespace: "ns" }), op: "graphNeighbourhood", params: { nodeKey: "n1", depth: 2, namespace: "ns" } },
    { call: (c) => c.upsertGraphNode({ key: "n1" }), op: "upsertGraphNode", params: { input: { key: "n1" } } },
    { call: (c) => c.upsertGraphEdge({ from: "a", to: "b" }), op: "upsertGraphEdge", params: { input: { from: "a", to: "b" } } },
    { call: (c) => c.deleteGraphNode("n1", { namespace: "ns" }), op: "deleteGraphNode", params: { nodeKey: "n1", namespace: "ns" } },
    { call: (c) => c.deleteGraphEdge("a", "b", "p", { namespace: "ns" }), op: "deleteGraphEdge", params: { fromKey: "a", toKey: "b", predicateKey: "p", namespace: "ns" } },
    { call: (c) => c.graphStats({ namespace: "ns" }), op: "graphStats", params: { namespace: "ns" } },
    { call: (c) => c.listGraphNamespaces({ prefix: "p", includeArchived: true, includeDetails: false }), op: "listGraphNamespaces", params: { prefix: "p", includeArchived: true, includeDetails: false } },
    { call: (c) => c.getGraphNamespace("ns"), op: "getGraphNamespace", params: { namespace: "ns" } },
    { call: (c) => c.upsertGraphNamespace({ namespace: "ns" }), op: "upsertGraphNamespace", params: { input: { namespace: "ns" } } },
    { call: (c) => c.deleteGraphNamespace("ns"), op: "deleteGraphNamespace", params: { namespace: "ns" } },
    // — session sharing / authz —
    { call: (c) => c.getSessionAccess("s1", USER), op: "getSessionAccess", params: { sessionId: "s1" } },
    { call: (c) => c.setSessionVisibility("s1", "shared_read"), op: "setSessionVisibility", params: { sessionId: "s1", visibility: "shared_read" } },
    { call: (c) => c.grantSessionShare("s1", USER, "read", { provider: "entra", subject: "granter" }), op: "grantSessionShare", params: { sessionId: "s1", user: USER, access: "read" } },
    { call: (c) => c.revokeSessionShare("s1", USER), op: "revokeSessionShare", params: { sessionId: "s1", user: USER } },
    { call: (c) => c.listSessionShares("s1"), op: "listSessionShares", params: { sessionId: "s1" } },
    { call: (c) => c.listKnownUsers({ limit: 10 }), op: "listKnownUsers", params: { limit: 10 } },
    { call: (c) => c.listAuthzAudit({ limit: 5, sessionId: "s1" }), op: "listAuthzAudit", params: { limit: 5, sessionId: "s1" } },
    // — workflow v2 read: its options are the operation's declared parameters, passed to the request builder, which leaves
    //   out an absent or null one (review api-01); so these rows check the HTTP request it builds (WIRE_CHECKED). Only an
    //   absent run is left out; an empty one is sent for the server to refuse —
    { call: (c) => c.readWorkflow("s1"), op: "readWorkflow", params: { sessionId: "s1" } },
    { call: (c) => c.readWorkflow("s1", { runId: null }), op: "readWorkflow", params: { sessionId: "s1" } },
    { call: (c) => c.readWorkflow("s1", { runId: "run-1" }), op: "readWorkflow", params: { sessionId: "s1", runId: "run-1" } },
    { call: (c) => c.readWorkflow("s1", { runId: "" }), op: "readWorkflow", params: { sessionId: "s1", runId: "" } },
    // The session id is the argument's, whatever the options say.
    { call: (c) => c.readWorkflow("s1", { sessionId: "other", runId: "run-1" }), op: "readWorkflow", params: { sessionId: "s1", runId: "run-1" } },
    // A section's next page and one execution's whole value: only the options given are sent.
    { call: (c) => c.readWorkflow("s1", { runId: "run-1", cursor: { v: 1, section: "inbox" }, limit: 5 }), op: "readWorkflow",
        params: { sessionId: "s1", runId: "run-1", cursor: { v: 1, section: "inbox" }, limit: 5 } },
    { call: (c) => c.readWorkflow("s1", { executionId: "nx-1", cursor: null, limit: undefined }), op: "readWorkflow", params: { sessionId: "s1", executionId: "nx-1" } },
    // The agent versions publishing would lock (owner decision q1).
    { call: (c) => c.readWorkflow("s1", { agentVersions: true }), op: "readWorkflow", params: { sessionId: "s1", agentVersions: true } },
    // One definition revision's YAML (owner decision q4).
    { call: (c) => c.readWorkflow("s1", { definitionRevision: 3 }), op: "readWorkflow", params: { sessionId: "s1", definitionRevision: 3 } },
    { call: (c) => c.readWorkflow("s1", { stepInput: { state: "review" } }), op: "readWorkflow", params: { sessionId: "s1", stepInput: { state: "review" } } },
];

/** Operations whose shim passes its options to the request builder as they are: checked by the request it builds. */
const WIRE_CHECKED = new Set(["readWorkflow"]);

/** An operation's HTTP request as ApiClient.call builds it from rpc-shaped params (buildOperationRequest): the wire itself. */
function wireRequest(op, params) {
    const { method, path, query, body } = buildOperationRequest(op, params);
    return { method, path, query: Object.fromEntries(query), body };
}

test("every shim maps its positional arguments onto the right wire call", async () => {
    for (const { call, op, params } of SHIM_CASES) {
        const { client, calls } = clientWithFakeApi();
        await call(client);
        assert.equal(calls.length, 1, `${op}: expected exactly one wire call`);
        assert.equal(calls[0].name, op, `expected op ${op}, got ${calls[0].name}`);
        if (WIRE_CHECKED.has(op)) assert.deepEqual(wireRequest(op, calls[0].params), wireRequest(op, params), `${op}: wrong wire request`);
        else assert.deepEqual(calls[0].params, params, `${op}: wrong wire params`);
    }
    // The built request itself: path, and only the options given, null and undefined left out.
    assert.deepEqual(wireRequest("readWorkflow", { sessionId: "s1", executionId: "nx-1", cursor: null, limit: undefined, runId: null }),
        { method: "GET", path: "/api/v1/sessions/s1/workflow", query: { executionId: "nx-1" }, body: null });
});

test("getWorkflowCapabilities reads the server's bootstrap advertisement, null from a server that has none, and rejects one that is not an object", async () => {
    const workflows = { schema: 1, v2: { read: true, commands: { available: false } } };
    for (const [bootstrap, expected] of [
        [{ ok: true, workflows }, workflows],
        [{ ok: true }, null],
        [{ ok: true, workflows: null }, null],
    ]) {
        const { client, calls } = clientWithFakeApi();
        client._api.getBootstrap = async () => bootstrap;
        assert.deepEqual(await client.getWorkflowCapabilities(), expected);
        assert.deepEqual(calls, [], "no operation call: the bootstrap is the source");
    }
    // A malformed advertisement, or a bootstrap that cannot be read, is not an older server.
    for (const [bootstrap, kind] of [[{ ok: true, workflows: ["v2"] }, "a list"], [{ ok: true, workflows: "v2" }, "a string"], [{ ok: true, workflows: 2 }, "a number"]]) {
        const { client } = clientWithFakeApi();
        client._api.getBootstrap = async () => bootstrap;
        await assert.rejects(client.getWorkflowCapabilities(),
            (error) => error.code === "WORKFLOW_CAPABILITIES_MALFORMED" && error.message.includes(`advertises workflows as ${kind}`), kind);
    }
    const { client } = clientWithFakeApi();
    client._api.getBootstrap = async () => { throw Object.assign(new Error("HTTP 503"), { status: 503 }); };
    await assert.rejects(client.getWorkflowCapabilities(), (error) => error.status === 503);
});

test("placeSessionsInGroup accepts both calling conventions", async () => {
    const { client, calls } = clientWithFakeApi();

    // web/transport shape: (sessionIds, groupId)
    await client.placeSessionsInGroup(["s1", "s2"], "g1");
    // direct shape: (viewer, sessionIds, groupId) — viewer dropped, server derives it
    await client.placeSessionsInGroup(USER, ["s3"], null);

    assert.deepEqual(calls, [
        { name: "placeSessionsInGroup", params: { groupId: "g1", sessionIds: ["s1", "s2"] } },
        { name: "placeSessionsInGroup", params: { groupId: null, sessionIds: ["s3"] } },
    ]);
});

test("direct-only plumbing refuses loudly with WEB_MODE_UNSUPPORTED", () => {
    const { client } = clientWithFakeApi();
    for (const method of [
        "factsCapabilities",
        "listSessionsVisible",
        "recordAuthzAudit",
        // A remote caller able to write its own role would hold a
        // privilege-escalation primitive; reading other users' roles is not a
        // client concern either. Both are portal-internal, direct mode only.
        "recordUserRole",
        "getUserRole",
        "dumpSession",
        "sendCommand",
        "getCommandResponse",
        "listGroupSessions",
        "normalizeModel",
        "getModelCredentialStatus",
    ]) {
        assert.throws(
            () => client[method](),
            (error) => error?.code === WEB_MODE_UNSUPPORTED,
            `${method} should throw a typed WEB_MODE_UNSUPPORTED error`,
        );
    }
});
