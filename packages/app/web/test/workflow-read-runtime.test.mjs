/**
 * Workflow readWorkflow (GET /api/v1/sessions/:sessionId/workflow,
 * decision read-workflow-transport, option A): one protocol row, access
 * session:read. The portal runtime's session gate decides first, with the
 * standard not-found privacy, and only then does the transport read the
 * workflow (and look up its run); the transport's readWorkflow is the human
 * read adapter, never the agent tool's parent-only path. A content-bearing
 * read by an admin outside the owner's visibility is audited as break-glass.
 * Only an absent runId is omitted on the way: an empty or blank one reaches
 * the adapter's validation (400) unchanged, and one that is not a single
 * string (a list, a number, an object, a repeated query param) is carried by
 * both HTTP codecs (the clients' request builder and the route's query
 * decoder) as the empty string, never as an id coerced from it, so it too is
 * refused there (400), and only after the gate; the direct path refuses its
 * type as it is (READ-WIRE-04). Exercised through the actual HTTP route, with
 * HttpApiTransport and WebPilotSwarmManagementClient over real fetch.
 *
 * Run: node --test web/test/workflow-read-runtime.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { NodeSdkTransport } from "pilotswarm/host";
import { PilotSwarmManagementClient, WebPilotSwarmManagementClient } from "pilotswarm-sdk";
import { ApiClient, HttpApiTransport } from "pilotswarm-sdk/api";

import { createApiRouter } from "../api/router.js";
import { PortalRuntime } from "../runtime.js";


test("readWorkflow is one GET session:read operation: the session in the path, an optional run, cursor, execution and limit in the query", async () => {
    const { OPERATIONS } = await import("../../../sdk/api/src/protocol.js");
    const op = OPERATIONS.find((entry) => entry.name === "readWorkflow");
    assert.ok(op, "readWorkflow is a protocol operation");
    assert.deepEqual({ access: op.access, method: op.method, path: op.path, params: op.params }, {
        access: "session:read", method: "GET", path: "/sessions/:sessionId/workflow",
        params: { sessionId: { in: "path", name: "sessionId" }, runId: { in: "query", type: "string", strict: true },
            cursor: { in: "query", type: "json" }, executionId: { in: "query", type: "string", strict: true }, limit: { in: "query", type: "json" },
            kvRevision: { in: "query", type: "json" }, kvKey: { in: "query", type: "string", strict: true }, agentVersions: { in: "query", type: "json" },
            definitionRevision: { in: "query", type: "json" }, stepInput: { in: "query", type: "json" } },
    });
    // Stage 2.5 (PR 235 8055fcd8): the legacy creation route is gone (every call was refused: a Workflow needs a parent agent).
    assert.equal(OPERATIONS.find((entry) => entry.name === "createWorkflowSession"), undefined);
    assert.equal(OPERATIONS.find((entry) => entry.method === "POST" && entry.path === "/sessions/workflow"), undefined);
});

/** A runtime whose transport knows three sessions of alice's: s1 (private), shared (shared_read), and missing (none). */
function runtimeWith({ enforce }) {
    const calls = [];
    const audits = [];
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.authz = { ...runtime.authz, enforce };
    const owner = { provider: "dev", subject: "alice" };
    runtime.transport = {
        getSessionAccess: async (sessionId, viewer) => (sessionId === "missing" ? null : {
            rootSessionId: sessionId,
            isSystem: false,
            visibility: sessionId === "shared" ? "shared_read" : "private",
            owner: { ...owner, displayName: "Alice" },
            viewerIsOwner: viewer.provider === owner.provider && viewer.subject === owner.subject,
            viewerShareAccess: null,
        }),
        recordAuthzAudit: async (entry) => { audits.push(entry); },
        readWorkflow: async (sessionId, options) => {
            calls.push([sessionId, options]);
            if (options.runId === "not-a-run") {
                throw Object.assign(new Error("Run not-a-run is not a run of this workflow."), { code: "RUN_NOT_FOUND", status: 404 });
            }
            return { workflowId: sessionId, run: null };
        },
    };
    return { runtime, calls, audits };
}

const as = (subject, role = "user") => ({ principal: { provider: "dev", subject }, authorization: { role } });

test("the session:read gate decides before the workflow is read, with not-found privacy (ownership enforced)", async () => {
    const { runtime, calls, audits } = runtimeWith({ enforce: true });
    assert.equal(runtime.authz.enforce, true);

    // The owner reads it, with and without a run; the run is passed to the transport's lookup only after the gate.
    // An overview read also says whether the viewer may read the Workflow's owner-only files (review SF-D4).
    assert.deepEqual(await runtime.call("readWorkflow", { sessionId: "s1" }, as("alice")), { workflowId: "s1", run: null, ownerOnlyArtifacts: { readable: true } });
    await runtime.call("readWorkflow", { sessionId: "s1", runId: "run-1" }, as("alice"));
    await assert.rejects(runtime.call("readWorkflow", { sessionId: "s1", runId: "not-a-run" }, as("alice")),
        (error) => error.code === "RUN_NOT_FOUND" && error.status === 404);
    // Someone the session is shared with for reading reads it.
    await runtime.call("readWorkflow", { sessionId: "shared" }, as("bob"));
    // Someone who cannot see it, and a session that does not exist, learn nothing: the same not-found, no read.
    for (const [sessionId, subject] of [["s1", "bob"], ["missing", "alice"]]) {
        await assert.rejects(runtime.call("readWorkflow", { sessionId }, as(subject)),
            (error) => error.status === 404 && error.code === "NOT_FOUND" && error.message === "Session not found.");
    }
    assert.deepEqual(calls, [["s1", {}], ["s1", { runId: "run-1" }], ["s1", { runId: "not-a-run" }], ["shared", {}]]);
    assert.ok(audits.some((entry) => entry.action === "readWorkflow" && entry.sessionId === "s1" && entry.decision === "deny"));

    // An admin outside the owner's visibility reads it, and the read is audited as break-glass.
    await runtime.call("readWorkflow", { sessionId: "s1" }, as("ada", "admin"));
    assert.deepEqual(calls.at(-1), ["s1", {}]);
    assert.ok(audits.some((entry) => entry.action === "readWorkflow" && entry.sessionId === "s1" && entry.decision === "break_glass"));
});

test("with the ownership switch off, readWorkflow is still gated: every selector of a hidden workflow is not found, with no read (SF-1)", async () => {
    const { runtime, calls, audits } = runtimeWith({ enforce: false });
    assert.equal(runtime.authz.enforce, false);
    // Every selector the view takes: the overview, a run, a page, one execution, a KV revision and key, agent versions,
    // a definition revision and a step's inputs.
    const selectors = [{}, { runId: "run-1" }, { cursor: { section: "executions", before: 9 } }, { executionId: "nx-1" },
        { kvRevision: 1 }, { kvRevision: 1, kvKey: "secret" }, { agentVersions: true }, { definitionRevision: 1 }, { stepInput: { state: "review" } }];
    for (const params of selectors) {
        for (const [sessionId, subject] of [["s1", "bob"], ["missing", "alice"]]) {
            await assert.rejects(runtime.call("readWorkflow", { sessionId, ...params }, as(subject)),
                (error) => error.status === 404 && error.code === "NOT_FOUND" && error.message === "Session not found.",
                `${sessionId} ${JSON.stringify(params)}`);
        }
    }
    assert.deepEqual(calls, []);
    assert.ok(audits.some((entry) => entry.action === "readWorkflow" && entry.sessionId === "s1" && entry.decision === "deny"));
    assert.ok(!audits.some((entry) => entry.action === "readWorkflow" && entry.decision === "would_deny"));

    // The owner, a reader it is shared with and an admin keep their access.
    assert.deepEqual(await runtime.call("readWorkflow", { sessionId: "s1", kvRevision: 1, kvKey: "secret" }, as("alice")), { workflowId: "s1", run: null });
    await runtime.call("readWorkflow", { sessionId: "shared" }, as("bob"));
    await runtime.call("readWorkflow", { sessionId: "s1" }, as("ada", "admin"));
    assert.deepEqual(calls.map(([sessionId]) => sessionId), ["s1", "shared", "s1"]);
    assert.ok(audits.some((entry) => entry.action === "readWorkflow" && entry.sessionId === "s1" && entry.decision === "break_glass"));
});

test("with the ownership switch off, other session:read operations are still only audited (the switch is unchanged for them)", async () => {
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.authz = { ...runtime.authz, enforce: false };
    const audits = [];
    const decisions = [];
    runtime._recordAudit = (entry) => { audits.push(entry); };
    runtime._getAccessSnapshot = async () => ({ rootSessionId: "s1", isSystem: false, visibility: "private",
        owner: { provider: "dev", subject: "alice" }, viewerIsOwner: false, viewerShareAccess: null });
    runtime.transport = { getSessionAccess: async () => null };
    decisions.push(await runtime._gateSession("getSessionEvents", "session:read", "s1", as("bob"), { owner: { provider: "dev", subject: "bob" }, isAdmin: false }));
    assert.equal(decisions.length, 1);
    assert.ok(audits.some((entry) => entry.action === "getSessionEvents" && entry.decision === "would_deny"));
    await assert.rejects(runtime._gateSession("readWorkflow", "session:read", "s1", as("bob"), { owner: { provider: "dev", subject: "bob" }, isAdmin: false }),
        (error) => error.status === 404);
});

/**
 * The actual HTTP route, end to end in-process: the generated Express route, the real PortalRuntime gate, the real
 * NodeSdkTransport.readWorkflow and the real PilotSwarmManagementClient.readWorkflow adapter (its runId validation, its
 * session lookup and readWorkflowView), over a stand-in catalog and workflow store (no database): alice owns every
 * session; wf1 is a Workflow with a live run, an earlier run R and a test run T kept from while test mode was on
 * (which the read hides while it is off: review SF-5); any other session is an agent session. The adapter has
 * no options unless `config` is given (the test-only workflowCommands option, INACTIVE).
 */
async function routeHarness({ config, enforce = true, shared = [] } = {}) {
    const owner = { provider: "dev", subject: "alice" };
    const adapterCalls = [];
    // The stand-in rows have every field of the store's current rows: these runs have no stop, virtual clock or scenario,
    // and the definition pins no agent.
    const run = (runId, mode, status) => ({ runId, workflowSessionId: "wf1", mode, status, revision: 1, irSha256: "i", inputs: {}, terminalOutcome: null, pausedFrom: null, terminalNodeId: null,
        terminalOutput: null, terminalError: null, kvRevision: 0, kv: {}, controllerVersion: null, stop: null,
        testAgentMode: mode === "test" ? "mocked" : null, virtualNow: null, testScenario: null, deadlineAt: null });
    const runs = [run("run-live", "live", "running"), run("R", "live", "completed"), run("T", "test", "running")];
    const store = {
        readDefinition: async () => ({ state: "published", semver: "1.0.0", currentRevision: 1, publishedRevision: 1, publishedYamlSha256: "h",
            publishedAgentPins: null }),
        readRevision: async () => ({ revision: 1, yamlSha256: "h", valid: true, irSha256: null, name: "w", diagnostics: [], yaml: "" }),
        // Only a test run's coverage reads its revision's graph here (the definition's own revision has no stored graph).
        readRevisionIr: async () => ({ nodes: {} }),
        listRuns: async () => runs,
        // The read's pages: these runs have no executions, messages or held calls yet.
        pageNodeExecutions: async () => ({ rows: [], more: false }),
        listOpenNodeExecutions: async () => ({ rows: [], more: false }),
        pageInbox: async () => ({ rows: [], more: false }),
        listOpenInbox: async () => ({ rows: [], more: false }),
        pageOutbox: async () => ({ rows: [], more: false }),
        listOpenOutbox: async () => ({ rows: [], more: false }),
        pageInterceptions: async () => ({ rows: [], more: false }),
        listOpenInterceptions: async () => ({ rows: [], more: false }),
        testCoverage: async () => ({ entered: [], routes: [], outcomes: [] }),
        readNodeExecution: async () => null,
        // Read only for the commands a person may send (workflowCommands): wf1 is in no agent state's subtree.
        readWorkflowLineage: async () => null,
        readRun: async (runId) => runs.find((item) => item.runId === runId) ?? null,
        // Review PRA-F3: every read of the view asks who last controlled the run; these runs have no control action.
        readLastRunControl: async () => null,
        // Every read of the view also reads the tools a Start delegated to agent steps; wf1 delegated none.
        readWorkflowToolsDelegated: async () => null,
    };
    const mgmt = {
        _ensureStarted() {},
        _catalog: {
            getSession: async (sessionId) => (sessionId === "missing" ? null
                : { sessionId, sessionKind: sessionId === "wf1" ? "workflow" : "agent", deletedAt: null }),
            workflowStore: () => store,
        },
        async readWorkflow(sessionId, options) {
            adapterCalls.push([sessionId, options]);
            return PilotSwarmManagementClient.prototype.readWorkflow.call(this, sessionId, options);
        },
        // The real method's body (batch 7, n-3: readWorkflow wraps it to classify a store that cannot be reached).
        _readWorkflow(...args) { return PilotSwarmManagementClient.prototype._readWorkflow.apply(this, args); },
    };
    if (config) mgmt.config = config;
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.authz = { ...runtime.authz, enforce };
    runtime.transport = {
        getSessionAccess: async (sessionId, viewer) => (sessionId === "missing" ? null : {
            rootSessionId: sessionId, isSystem: false, visibility: shared.includes(sessionId) ? "shared_read" : "private", owner: { ...owner, displayName: "Alice" },
            viewerIsOwner: viewer.provider === owner.provider && viewer.subject === owner.subject, viewerShareAccess: null,
        }),
        recordAuthzAudit: async () => {},
        readWorkflow: (...args) => NodeSdkTransport.prototype.readWorkflow.apply({ mgmt }, args),
    };
    const requireAuth = (req, _res, next) => {
        const subject = String(req.headers["x-test-user"] || "alice");
        const role = String(req.headers["x-test-role"] || "user");
        req.auth = { principal: { provider: "dev", subject }, authorization: { allowed: true, role, reason: "test", matchedGroups: [] } };
        next();
    };
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createApiRouter({ runtime, requireAuth }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const base = `${origin}/api/v1`;
    const get = async (path, subject = "alice", role = "user") => {
        const response = await fetch(`${base}${path}`, { headers: { "x-test-user": subject, "x-test-role": role } });
        return { status: response.status, body: await response.json() };
    };
    return { runtime, adapterCalls, get, origin, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("the HTTP route keeps an explicit empty or blank runId for the adapter's validation, after the session gate", async () => {
    const h = await routeHarness();
    try {
        // An explicit empty or blank run reaches the adapter unchanged and is refused there (400), not read as the live run.
        for (const query of ["?runId=", "?runId=%20%20"]) {
            const refused = await h.get(`/sessions/s1/workflow${query}`);
            assert.equal(refused.status, 400, query);
            assert.equal(refused.body.ok, false);
            assert.equal(refused.body.error.code, "INVALID_REQUEST", query);
        }
        assert.deepEqual(h.adapterCalls, [["s1", { runId: "" }], ["s1", { runId: "  " }]]);
        // An absent run is omitted: the adapter reads the session, which here is no Workflow.
        const agent = await h.get("/sessions/s1/workflow");
        assert.equal(agent.status, 404);
        assert.equal(agent.body.error.code, "WORKFLOW_NOT_FOUND");
        assert.deepEqual(h.adapterCalls.at(-1), ["s1", {}]);
        // The session gate decides first: someone who cannot read the session, or a session that does not exist, gets the
        // same not-found, and the adapter is never asked, whatever the runId.
        const before = h.adapterCalls.length;
        for (const [path, subject] of [["/sessions/s1/workflow?runId=", "bob"], ["/sessions/s1/workflow", "bob"], ["/sessions/missing/workflow?runId=", "alice"]]) {
            const hidden = await h.get(path, subject);
            assert.equal(hidden.status, 404, path);
            assert.equal(hidden.body.error.code, "NOT_FOUND", path);
            assert.equal(hidden.body.error.message, "Session not found.", path);
        }
        assert.equal(h.adapterCalls.length, before);
        // The dispatcher passes a non-string run as it is: the adapter refuses its type rather than reading a coerced id.
        await assert.rejects(h.runtime.call("readWorkflow", { sessionId: "s1", runId: 5 }, { principal: { provider: "dev", subject: "alice" },
            authorization: { role: "user" } }), (error) => error.code === "INVALID_REQUEST" && error.status === 400);
        assert.deepEqual(h.adapterCalls.at(-1), ["s1", { runId: 5 }]);
    } finally {
        await h.close();
    }
});

test("READ-WIRE-04: both HTTP-backed clients and the route carry a run that is not one string as invalid, never as a coerced id, after the gate", async () => {
    const h = await routeHarness();
    try {
        const urls = [];
        // The clients' own codec (ApiClient.call, buildOperationRequest) over real fetch; only the test user is added.
        const api = (subject) => new ApiClient({ apiUrl: h.origin, fetchImpl: (url, init = {}) => {
            urls.push(String(url));
            return fetch(url, { ...init, headers: { ...init.headers, "x-test-user": subject } });
        } });
        const clients = [
            ["HttpApiTransport", (subject) => new HttpApiTransport({ api: api(subject) })],
            ["WebPilotSwarmManagementClient", (subject) => new WebPilotSwarmManagementClient({ api: api(subject) })],
        ];
        for (const [name, client] of clients) {
            const alice = client("alice");
            // A run that is one string is read as itself; an absent one is the live run.
            assert.equal((await alice.readWorkflow("wf1", { runId: "R" })).run.runId, "R", name);
            assert.ok(urls.at(-1).endsWith("/api/v1/sessions/wf1/workflow?runId=R"), name);
            const live = await alice.readWorkflow("wf1");
            assert.equal(live.run.runId, "run-live", name);
            // Inactive: an adapter without the workflowCommands option reads exactly the tool's view.
            assert.equal(Object.hasOwn(live, "personCommands"), false, name);
            // A list holding that run, a number, a repeated run and an object are sent as invalid and refused after the gate:
            // neither run R nor a run named "5" is read.
            for (const runId of [["R"], 5, ["R", "R"], { runId: "R" }]) {
                const label = `${name} ${JSON.stringify(runId)}`;
                const calls = h.adapterCalls.length;
                await assert.rejects(alice.readWorkflow("wf1", { runId }), (error) => error.code === "INVALID_REQUEST" && error.status === 400, label);
                assert.ok(urls.at(-1).endsWith("/api/v1/sessions/wf1/workflow?runId="), label);
                assert.deepEqual(h.adapterCalls.slice(calls), [["wf1", { runId: "" }]], label);
            }
            // Someone who cannot read the session gets the same not-found whatever the run, and nothing is read.
            const bob = client("bob");
            const calls = h.adapterCalls.length;
            for (const options of [{}, { runId: "R" }, { runId: ["R"] }, { runId: 5 }]) {
                await assert.rejects(bob.readWorkflow("wf1", options),
                    (error) => error.code === "NOT_FOUND" && error.status === 404 && error.message === "Session not found.", `${name} bob ${JSON.stringify(options)}`);
            }
            assert.equal(h.adapterCalls.length, calls, name);
        }
        // On the route itself, a repeated run is never joined into an id: it is refused after the gate, as an empty one is.
        const calls = h.adapterCalls.length;
        const repeated = await h.get("/sessions/wf1/workflow?runId=R&runId=R");
        assert.equal(repeated.status, 400);
        assert.equal(repeated.body.error.code, "INVALID_REQUEST");
        assert.deepEqual(h.adapterCalls.slice(calls), [["wf1", { runId: "" }]]);
        const hidden = await h.get("/sessions/wf1/workflow?runId=R&runId=R", "bob");
        assert.equal(hidden.status, 404);
        assert.equal(hidden.body.error.code, "NOT_FOUND");
        assert.equal(h.adapterCalls.length, calls + 1);
        const single = await h.get("/sessions/wf1/workflow?runId=R");
        assert.equal(single.status, 200);
        assert.equal(single.body.result.run.runId, "R");
    } finally {
        await h.close();
    }
});

test("with workflowCommands, the real adapter says which commands the workflow takes and the route adds the caller's own decision", async () => {
    const h = await routeHarness({ config: { workflowCommands: {} } });
    try {
        const read = await h.get("/sessions/wf1/workflow");
        assert.equal(read.status, 200);
        assert.equal(read.body.result.run.runId, "run-live");
        assert.deepEqual(read.body.result.personCommands, {
            operations: ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel", "stop"],
            restriction: null, run: { runId: "run-live", stop: true }, viewer: { allowed: true, reason: null },
        });
        // The run that was asked for is the one described.
        const test = await h.get("/sessions/wf1/workflow?runId=R");
        assert.deepEqual(test.body.result.personCommands.run, { runId: "R", stop: true });
        // With test mode off (the default), a test run kept from while it was on is not listed, and its id is refused as an
        // unknown run's is, over the route too (review SF-5).
        assert.deepEqual(read.body.result.runs.map(item => item.runId), ["run-live", "R"]);
        const hiddenTest = await h.get("/sessions/wf1/workflow?runId=T");
        const unknown = await h.get("/sessions/wf1/workflow?runId=nope");
        assert.deepEqual([hiddenTest.status, hiddenTest.body.error.code], [unknown.status, unknown.body.error.code]);
        assert.deepEqual([hiddenTest.status, hiddenTest.body.error.code], [404, "RUN_NOT_FOUND"]);
        // An invalid run is still refused after the gate (400), and a reader without access still gets not-found.
        const invalid = await h.get("/sessions/wf1/workflow?runId=");
        assert.deepEqual([invalid.status, invalid.body.error.code], [400, "INVALID_REQUEST"]);
        const hidden = await h.get("/sessions/wf1/workflow", "bob");
        assert.deepEqual([hidden.status, hidden.body.error.code], [404, "NOT_FOUND"]);
        assert.deepEqual(h.adapterCalls, [["wf1", {}], ["wf1", { runId: "R" }], ["wf1", { runId: "T" }], ["wf1", { runId: "nope" }], ["wf1", { runId: "" }]]);
    } finally {
        await h.close();
    }
});

test("a section's next page and one execution's value are read through the same session:read gate; the read's refusals keep their codes and statuses", async () => {
    const h = await routeHarness();
    try {
        const encoded = (cursor) => encodeURIComponent(JSON.stringify(cursor));
        const own = { v: 1, workflowId: "wf1", runId: "R", section: "inbox", order: "newest_first", after: { seq: "3" } };
        // A page of this workflow's run, as the read gives it.
        const page = await h.get(`/sessions/wf1/workflow?cursor=${encoded(own)}`);
        assert.equal(page.status, 200);
        assert.deepEqual(page.body.result, { workflowId: "wf1", runId: "R", section: "inbox", order: "newest_first", limit: 50, items: [], nextCursor: null });
        assert.deepEqual(h.adapterCalls.at(-1), ["wf1", { cursor: own }]);
        // The read's own refusals: an execution that is not the run's, a limit out of range, a cursor of another workflow,
        // and a cursor with an execution id.
        for (const [query, status, code, options] of [
            ["?executionId=nx-9", 404, "EXECUTION_NOT_FOUND", { executionId: "nx-9" }],
            ["?limit=0", 400, "WORKFLOW_READ_INVALID", { limit: 0 }],
            // A KV revision the run does not have (the stand-in run is at revision 0), and a key without a revision.
            ["?kvRevision=1", 404, "KV_REVISION_NOT_FOUND", { kvRevision: 1 }],
            ["?kvKey=a", 400, "WORKFLOW_READ_INVALID", { kvKey: "a" }],
            // The agent-versions read is a read of its own (owner decision q1).
            ["?agentVersions=true&limit=5", 400, "WORKFLOW_READ_INVALID", { limit: 5, agentVersions: true }],
            // A definition revision the workflow does not have (owner decision q4: comparing versions).
            ["?definitionRevision=2", 404, "DEFINITION_REVISION_NOT_FOUND", { definitionRevision: 2 }],
            // A step's inputs are edited only in a draft (owner decision q6); this workflow is published.
            [`?stepInput=${encoded({ state: "review" })}`, 400, "WORKFLOW_READ_INVALID", { stepInput: { state: "review" } }],
            [`?cursor=${encoded({ ...own, workflowId: "wf-other" })}`, 400, "WORKFLOW_CURSOR_INVALID", { cursor: { ...own, workflowId: "wf-other" } }],
            [`?cursor=${encoded(own)}&executionId=nx-9`, 400, "WORKFLOW_READ_INVALID", { cursor: own, executionId: "nx-9" }],
        ]) {
            const refused = await h.get(`/sessions/wf1/workflow${query}`);
            assert.deepEqual([refused.status, refused.body.error.code], [status, code], query);
            assert.deepEqual(h.adapterCalls.at(-1), ["wf1", options], query);
        }
        // The agent versions publishing would lock (owner decision q1): this published revision's, through the same gate.
        const versions = await h.get("/sessions/wf1/workflow?agentVersions=true");
        assert.equal(versions.status, 200);
        assert.deepEqual(versions.body.result, { workflowId: "wf1", revision: 1, definitionHash: "h", resolves: false, locked: true, agents: [], problem: null });
        assert.deepEqual(h.adapterCalls.at(-1), ["wf1", { agentVersions: true }]);
        // One revision's YAML, for its owner (who may change the workflow): read through the same gate.
        const revision = await h.get("/sessions/wf1/workflow?definitionRevision=1");
        assert.equal(revision.status, 200);
        assert.deepEqual([revision.body.result.workflowId, revision.body.result.definitionRevision.revision, revision.body.result.definitionRevision.yaml],
            ["wf1", 1, ""]);
        assert.deepEqual(h.adapterCalls.at(-1), ["wf1", { definitionRevision: 1 }]);
        // Someone who cannot read the session learns nothing, whatever the options: the same not-found, and nothing is read.
        const before = h.adapterCalls.length;
        for (const query of ["?executionId=nx-9", `?cursor=${encoded(own)}`, "?limit=0"]) {
            const hidden = await h.get(`/sessions/wf1/workflow${query}`, "bob");
            assert.deepEqual([hidden.status, hidden.body.error.code, hidden.body.error.message], [404, "NOT_FOUND", "Session not found."], query);
        }
        assert.equal(h.adapterCalls.length, before);
        // Both HTTP-backed clients send only the options given, and read the page.
        for (const client of [new HttpApiTransport({ api: new ApiClient({ apiUrl: h.origin }) }), new WebPilotSwarmManagementClient({ api: new ApiClient({ apiUrl: h.origin }) })]) {
            const read = await client.readWorkflow("wf1", { runId: "R", cursor: own, limit: 5, executionId: null });
            assert.deepEqual(read, { workflowId: "wf1", runId: "R", section: "inbox", order: "newest_first", limit: 5, items: [], nextCursor: null });
            assert.deepEqual(h.adapterCalls.at(-1), ["wf1", { runId: "R", cursor: own, limit: 5 }]);
        }
    } finally {
        await h.close();
    }
});

// Owed M-01 (verification of SF-1): with the ownership switch off, the authenticated HTTP route and the web-backed client
// (the one a web-mode MCP server's read_workflow uses) refuse every selector of a workflow the caller cannot read, with
// the same not-found and no read; its owner, an admin and a reader it is shared with keep their access.
test("M-01: with the ownership switch off, every read selector of a hidden workflow is not found over HTTP and the web client, with no read", async () => {
    const h = await routeHarness({ enforce: false });
    try {
        assert.equal(h.runtime.authz.enforce, false);
        const json = (value) => encodeURIComponent(JSON.stringify(value));
        const queries = ["", "?runId=R", `?cursor=${json({ v: 1, workflowId: "wf1", runId: "R", section: "inbox", order: "newest_first", after: { seq: "3" } })}`,
            "?executionId=nx-1", "?kvRevision=1", "?kvRevision=1&kvKey=secret", `?agentVersions=${json(true)}`, `?definitionRevision=${json(1)}`,
            `?stepInput=${json({ state: "review" })}`];
        for (const query of queries) {
            const hidden = await h.get(`/sessions/wf1/workflow${query}`, "bob");
            assert.deepEqual([hidden.status, hidden.body.error?.code, hidden.body.error?.message], [404, "NOT_FOUND", "Session not found."], query);
        }
        // The web-backed client a web-mode MCP server uses: the same refusal, whatever the selector.
        const bob = new WebPilotSwarmManagementClient({ api: new ApiClient({ apiUrl: h.origin,
            fetchImpl: (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, "x-test-user": "bob" } }) }) });
        for (const options of [{}, { runId: "R" }, { executionId: "nx-1" }, { kvRevision: 1, kvKey: "secret" }, { definitionRevision: 1 }]) {
            await assert.rejects(bob.readWorkflow("wf1", options), (error) => error.status === 404 && error.code === "NOT_FOUND", JSON.stringify(options));
        }
        assert.deepEqual(h.adapterCalls, [], "nothing was read for a caller who cannot see the workflow");

        // Positive controls: the owner and an admin read it.
        const own = await h.get("/sessions/wf1/workflow", "alice");
        assert.equal(own.status, 200);
        assert.equal(own.body.result.run.runId, "run-live");
        const admin = await h.get("/sessions/wf1/workflow", "ada", "admin");
        assert.equal(admin.status, 200);
        assert.deepEqual(h.adapterCalls.map(([sessionId]) => sessionId), ["wf1", "wf1"]);
    } finally {
        await h.close();
    }
    // A reader it is shared with reads it, the switch off as well.
    const sharedHarness = await routeHarness({ enforce: false, shared: ["wf1"] });
    try {
        const read = await sharedHarness.get("/sessions/wf1/workflow", "bob");
        assert.equal(read.status, 200);
        assert.equal(read.body.result.run.runId, "run-live");
    } finally {
        await sharedHarness.close();
    }
});

// Adversarial review R2-SF-2: a person the workflow session is shared with for reading cannot read the definition's YAML,
// so the view keeps from them what its author wrote as values in the input schema (default, const, enum, examples, notes)
// and what diagnostics quote of it (paths, $ref text, messages). The owner (who may change it) reads all of it. Synthetic
// sentinel values only.
const SENTINEL = "sentinel-r2sf2-7f3a";
function sentinelView(sessionId) {
    return {
        workflowId: sessionId,
        definition: { state: "draft", semver: "1.0.0", currentRevision: 2, publishedRevision: 1 },
        revision: { revision: 2, definitionHash: "h", valid: false, irSha256: null, name: "w", diagnostics: [
            { severity: "error", code: "WORKFLOW_SCHEMA_INVALID", path: `schemas.${SENTINEL}.$ref`, line: 7,
                message: `only local references '#/schemas/<Name>' are allowed (got 'https://user:${SENTINEL}@example.invalid/s')` },
            { severity: "warning", code: "WORKFLOW_FAILURE_UNHANDLED", path: "states.calc.transition.next", message: `no failure route ${SENTINEL}` },
        ] },
        graph: { revision: 1, initial: "calc", states: [], inputsSchema: {
            type: "object", title: SENTINEL, description: SENTINEL, $comment: SENTINEL, required: ["token", "mode"],
            // Re-check S-SF-F2: string annotations, and unknown and vendor keywords, are not shown either.
            "x-vendor": { note: SENTINEL }, readme: SENTINEL, deprecated: SENTINEL,
            properties: {
                token: { type: "string", default: SENTINEL, examples: [SENTINEL], minLength: 4, format: SENTINEL, contentMediaType: SENTINEL,
                    contentEncoding: SENTINEL, contentSchema: { const: SENTINEL }, "x-secret": SENTINEL },
                mode: { enum: ["a", SENTINEL], const: SENTINEL },
                list: { type: "array", items: { type: "string", default: SENTINEL }, maxItems: 3 },
                pick: { anyOf: [{ const: SENTINEL }, { type: "integer", description: SENTINEL }] },
            },
        } },
        runs: [],
        run: null,
    };
}

test("R2-SF-2 and S-SF-F2: a reader who cannot change the workflow gets only its input schema's shape and its diagnostics without their details; the owner gets all", async () => {
    const owner = { provider: "dev", subject: "alice" };
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.authz = { ...runtime.authz, enforce: true };
    runtime.transport = {
        getSessionAccess: async (sessionId, viewer) => ({
            rootSessionId: sessionId, isSystem: false, visibility: "shared_read", owner: { ...owner, displayName: "Alice" },
            viewerIsOwner: viewer.provider === owner.provider && viewer.subject === owner.subject, viewerShareAccess: null,
        }),
        recordAuthzAudit: async () => {},
        readWorkflow: async (sessionId) => sentinelView(sessionId),
    };
    const requireAuth = (req, _res, next) => {
        req.auth = { principal: { provider: "dev", subject: String(req.headers["x-test-user"] || "alice") },
            authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] } };
        next();
    };
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createApiRouter({ runtime, requireAuth }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const client = (subject) => new WebPilotSwarmManagementClient({ api: new ApiClient({ apiUrl: origin,
        fetchImpl: (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, "x-test-user": subject } }) }) });
    try {
        // The owner: the whole view, by the runtime and by the web-backed client (the MCP server's web mode).
        for (const view of [await runtime.call("readWorkflow", { sessionId: "wf1" }, as("alice")), await client("alice").readWorkflow("wf1")]) {
            assert.deepEqual(view, { ...sentinelView("wf1"), ownerOnlyArtifacts: { readable: true } });
        }
        // A reader: no sentinel anywhere, by the runtime, the GET route and the web-backed client.
        const reads = [
            await runtime.call("readWorkflow", { sessionId: "wf1" }, as("bob")),
            (await (await fetch(`${origin}/api/v1/sessions/wf1/workflow`, { headers: { "x-test-user": "bob" } })).json()).result,
            await client("bob").readWorkflow("wf1"),
        ];
        for (const view of reads) {
            assert.equal(JSON.stringify(view).includes(SENTINEL), false, JSON.stringify(view));
            assert.equal(JSON.stringify(view).includes("example.invalid"), false);
            // The schema's shape stays: types, properties, required names, lengths, items and alternatives.
            assert.deepEqual(view.graph.inputsSchema, {
                type: "object", required: ["token", "mode"],
                properties: {
                    token: { type: "string", minLength: 4 },
                    mode: {},
                    list: { type: "array", items: { type: "string" }, maxItems: 3 },
                    pick: { anyOf: [{}, { type: "integer" }] },
                },
            });
            // Each diagnostic: its severity and code, and a fixed sentence.
            assert.deepEqual(view.revision.diagnostics, [
                { severity: "error", code: "WORKFLOW_SCHEMA_INVALID", message: "This version has an error. People who can change this workflow see where and why." },
                { severity: "warning", code: "WORKFLOW_FAILURE_UNHANDLED", message: "This version has a warning. People who can change this workflow see where and why." },
            ]);
            // The rest is as read, with the reader's owner-only decision (review SF-D4: a reader it is shared with may not).
            assert.deepEqual({ ...view, graph: undefined, revision: undefined },
                { ...sentinelView("wf1"), graph: undefined, revision: undefined, ownerOnlyArtifacts: { readable: false } });
            assert.equal(view.revision.valid, false);
        }
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

// Stage 2 review S2SF-F1: an agent state's inline prompt is shown on the graph (about.prompt) only to whoever may change
// the workflow, as its YAML is; a reader it is shared with gets the state's description (the author wrote it to say what
// the state does) and no prompt. Synthetic marker only.
const PROMPT_MARKER = "prompt-marker-s2sf-f1-9d2c";
function promptView(sessionId) {
    return {
        workflowId: sessionId,
        definition: { state: "published", semver: "1.0.0", currentRevision: 1, publishedRevision: 1 },
        revision: { revision: 1, definitionHash: "h", valid: true, irSha256: "i", name: "w", diagnostics: [] },
        graph: { revision: 1, initial: "ask", inputsSchema: null, states: [
            { id: "ask", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 600, outcomes: ["done"], next: { done: "end" },
                about: { description: "Summarizes the build.", prompt: `Use the token ${PROMPT_MARKER} to read the build.` } },
            { id: "solo", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 600, outcomes: ["done"], next: { done: "end" },
                about: { prompt: `Only a prompt: ${PROMPT_MARKER}` } },
            { id: "end", type: "terminal", outcome: "succeeded", about: { description: "Done." } },
        ] },
        runs: [],
        run: null,
    };
}

test("S2SF-F1: a reader gets no agent state's inline prompt on the Workflow route (runtime, GET, web client); the owner gets it", async () => {
    const owner = { provider: "dev", subject: "alice" };
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.authz = { ...runtime.authz, enforce: true };
    runtime.transport = {
        getSessionAccess: async (sessionId, viewer) => ({
            rootSessionId: sessionId, isSystem: false, visibility: "shared_read", owner: { ...owner, displayName: "Alice" },
            viewerIsOwner: viewer.provider === owner.provider && viewer.subject === owner.subject, viewerShareAccess: null,
        }),
        recordAuthzAudit: async () => {},
        readWorkflow: async (sessionId) => promptView(sessionId),
    };
    const requireAuth = (req, _res, next) => {
        req.auth = { principal: { provider: "dev", subject: String(req.headers["x-test-user"] || "alice") },
            authorization: { allowed: true, role: "user", reason: "test", matchedGroups: [] } };
        next();
    };
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createApiRouter({ runtime, requireAuth }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const client = (subject) => new WebPilotSwarmManagementClient({ api: new ApiClient({ apiUrl: origin,
        fetchImpl: (url, init = {}) => fetch(url, { ...init, headers: { ...init.headers, "x-test-user": subject } }) }) });
    try {
        for (const view of [await runtime.call("readWorkflow", { sessionId: "wf1" }, as("alice")), await client("alice").readWorkflow("wf1")]) {
            assert.deepEqual(view.graph, promptView("wf1").graph);
            assert.ok(JSON.stringify(view).includes(PROMPT_MARKER));
        }
        const reads = [
            await runtime.call("readWorkflow", { sessionId: "wf1" }, as("bob")),
            (await (await fetch(`${origin}/api/v1/sessions/wf1/workflow`, { headers: { "x-test-user": "bob" } })).json()).result,
            await client("bob").readWorkflow("wf1"),
        ];
        for (const view of reads) {
            assert.equal(JSON.stringify(view).includes(PROMPT_MARKER), false, JSON.stringify(view));
            const byId = Object.fromEntries(view.graph.states.map((state) => [state.id, state]));
            assert.deepEqual(byId.ask.about, { description: "Summarizes the build." });
            assert.equal("about" in byId.solo, false);
            assert.deepEqual(byId.end.about, { description: "Done." });
            // Every other field of each state is as read.
            const { about: _a, ...askRest } = byId.ask;
            const { about: _b, ...askRead } = promptView("wf1").graph.states[0];
            assert.deepEqual(askRest, askRead);
        }
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
