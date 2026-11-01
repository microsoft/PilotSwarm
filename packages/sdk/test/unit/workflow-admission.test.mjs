/**
 * PilotSwarmClient.createWorkflowSession: the agent-parent check and the
 * saved start request, against an in-memory catalog and duroxide client.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmClient } from "../../dist/client.js";
import { SYSTEM_USER_PRINCIPAL } from "../../dist/cms.js";

const YAML = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: admission, version: 1.0.0 }
initial: only
states:
  only:
    type: script
    runtime: node
    source: x
    completion: { outcomes: [success] }
    transition: { next: { success: done } }
  done: { type: terminal, outcome: succeeded }
`;
const ALICE = { provider: "test", subject: "alice" };
const BOB = { provider: "test", subject: "bob" };

function harness({ parent = { state: "running", owner: ALICE }, createSession } = {}) {
    const rows = new Map();
    const configs = new Map();
    const calls = [];
    const starts = [];
    if (parent) rows.set("parent", { sessionId: "parent", sessionKind: "agent", deletedAt: null, parentSessionId: null, ...parent });
    const catalog = {
        getSession: async (id) => rows.get(id) ?? null,
        getSessionCreationConfig: async (id) => configs.get(id) ?? null,
        createSession: createSession
            ? async (id, opts) => { calls.push(["createSession", id, opts]); await createSession(id, opts, { rows, configs }); }
            : async (id, opts) => {
                calls.push(["createSession", id, opts]);
                rows.set(id, { sessionId: id, sessionKind: opts.sessionKind, parentSessionId: opts.parentSessionId, owner: opts.owner ?? null, state: "pending", orchestrationId: null, deletedAt: null });
                configs.set(id, JSON.parse(JSON.stringify(opts.creationConfig)));
            },
        updateSession: async (id, updates) => {
            calls.push(["updateSession", id, updates]);
            Object.assign(rows.get(id), updates);
        },
    };
    const duroxide = {
        getStatus: async () => ({ status: "NotFound" }),
        deleteInstance: async (id) => { calls.push(["deleteInstance", id]); },
        startOrchestrationVersioned: async (id, name, input, version) => {
            starts.push({ id, name, input, version });
        },
    };
    const client = new PilotSwarmClient({ store: "postgres://unused" });
    client._catalog = catalog;
    client.duroxideClient = duroxide;
    return { client, rows, configs, calls, starts };
}

const request = (extra = {}) => ({ sessionId: "wf", yaml: YAML, inputs: { day: "mon" }, parentSessionId: "parent", ...extra });

test("a workflow without a parent is refused before anything is written", async () => {
    for (const parentSessionId of [undefined, null, "", "  "]) {
        const h = harness();
        await assert.rejects(h.client.createWorkflowSession(request({ parentSessionId })), (error) => {
            assert.equal(error.code, "WORKFLOW_PARENT_REQUIRED");
            assert.equal(error.status, 400);
            assert.match(error.message, /^A workflow session must be started by an agent session: parentSessionId is required\. Agents start workflows with spawn_workflow\.$/);
            return true;
        });
        assert.deepEqual(h.calls, []);
        assert.deepEqual(h.starts, []);
    }
});

test("a parent that cannot own a run is refused with the reason", async () => {
    const cases = [
        [null, {}, /^Session parent cannot be the parent of a workflow session: it does not exist or was deleted\.$/],
        [{ state: "running", owner: ALICE, deletedAt: new Date() }, {}, /it does not exist or was deleted\.$/],
        [{ state: "completed", owner: ALICE }, {}, /it has ended \(state completed\)\.$/],
        [{ state: "failed", owner: ALICE }, {}, /it has ended \(state failed\)\.$/],
        [{ state: "cancelled", owner: ALICE }, {}, /it has ended \(state cancelled\)\.$/],
        [{ state: "running", owner: ALICE, sessionKind: "workflow" }, {}, /it is a workflow session, and only an agent session can start a workflow\.$/],
        [{ state: "running", owner: ALICE }, { owner: BOB }, /it belongs to a different owner\.$/],
        [{ state: "running", owner: null }, { owner: BOB }, /it belongs to a different owner\.$/],
        [{ state: "running", owner: null, isSystem: true }, { owner: BOB }, /it belongs to a different owner\.$/],
    ];
    for (const [parent, extra, message] of cases) {
        const h = harness({ parent });
        await assert.rejects(h.client.createWorkflowSession(request(extra)), (error) => {
            assert.equal(error.code, "WORKFLOW_PARENT_INVALID");
            assert.equal(error.status, 400);
            assert.match(error.message, message);
            return true;
        });
        assert.deepEqual(h.calls, [], JSON.stringify(parent));
        assert.deepEqual(h.starts, []);
    }
});

test("the workflow gets its parent's effective owner unless the caller names the same one", async () => {
    const inherited = harness();
    await inherited.client.createWorkflowSession(request());
    assert.deepEqual(inherited.calls[0][2].owner, { ...ALICE, email: null, displayName: null });

    const explicit = harness();
    await explicit.client.createWorkflowSession(request({ owner: { ...ALICE, email: "a@example.com" } }));
    assert.deepEqual(explicit.calls[0][2].owner, { ...ALICE, email: "a@example.com" });

    const system = harness({ parent: { state: "running", owner: null, isSystem: true } });
    await system.client.createWorkflowSession(request());
    assert.deepEqual(system.calls[0][2].owner, SYSTEM_USER_PRINCIPAL);

    const local = harness({ parent: { state: "pending", owner: null } });
    await local.client.createWorkflowSession(request());
    assert.equal(local.calls[0][2].owner, undefined);
});

test("the first create saves the start request and starts the run from the saved copy", async () => {
    const h = harness();
    const result = await h.client.createWorkflowSession(request());
    assert.deepEqual(result, { sessionId: "wf", workflowName: "admission" });
    const create = h.calls.find(([kind]) => kind === "createSession");
    assert.equal(create[2].sessionKind, "workflow");
    assert.equal(create[2].parentSessionId, "parent");
    assert.deepEqual(create[2].creationConfig, {
        workflowStart: { sessionId: "wf", yaml: YAML, inputs: { day: "mon" }, parentSessionId: "parent", notifyParent: true },
    });
    assert.equal(h.starts.length, 1);
    assert.equal(h.starts[0].id, "session-wf");
    assert.equal(h.starts[0].input, h.configs.get("wf").workflowStart, "the run starts from the stored object");
    assert.equal(h.rows.get("wf").orchestrationId, "session-wf");
    assert.equal(h.rows.get("wf").title, "Workflow: admission");
});

test("the same request again returns the session without side effects; a different one is refused", async () => {
    const h = harness();
    await h.client.createWorkflowSession(request({ inputs: { day: "mon", nested: { b: 1, a: 2 } } }));
    const before = { calls: h.calls.length, starts: h.starts.length };
    // Key order and an explicit default do not make a request different.
    const again = await h.client.createWorkflowSession(request({ inputs: { nested: { a: 2, b: 1 }, day: "mon" }, notifyParent: true }));
    assert.deepEqual(again, { sessionId: "wf", workflowName: "admission" });
    assert.equal(h.calls.length, before.calls);
    assert.equal(h.starts.length, before.starts);

    // Even after the parent ended: the run already exists.
    h.rows.get("parent").state = "completed";
    await h.client.createWorkflowSession(request({ inputs: { day: "mon", nested: { a: 2, b: 1 } } }));
    h.rows.get("parent").state = "running";

    for (const change of [
        { inputs: { day: "tue", nested: { a: 2, b: 1 } } },
        { notifyParent: false },
        { yaml: YAML.replace("name: admission", "name: other") },
    ]) {
        await assert.rejects(h.client.createWorkflowSession(request({ inputs: { day: "mon", nested: { a: 2, b: 1 } }, ...change })), (error) => {
            assert.equal(error.code, "WORKFLOW_ADMISSION_CONFLICT");
            assert.equal(error.status, 409);
            assert.match(error.message, /^Workflow session wf was already started with a different request \(YAML, inputs, parent or notification setting\)\. Use a different id for a new run\.$/);
            return true;
        });
    }
    h.rows.set("parent-2", { sessionId: "parent-2", sessionKind: "agent", state: "running", owner: ALICE });
    await assert.rejects(
        h.client.createWorkflowSession(request({ inputs: { day: "mon", nested: { a: 2, b: 1 } }, parentSessionId: "parent-2" })),
        { code: "WORKFLOW_ADMISSION_CONFLICT" },
    );
    assert.equal(h.calls.length, before.calls);
    assert.equal(h.starts.length, before.starts);
});

test("a create that stopped before the start is finished from the saved copy, after the parent is checked again", async () => {
    const h = harness();
    const stored = { sessionId: "wf", yaml: YAML, inputs: { day: "mon" }, parentSessionId: "parent", notifyParent: true };
    h.rows.set("wf", { sessionId: "wf", sessionKind: "workflow", state: "pending", orchestrationId: null, parentSessionId: "parent" });
    h.configs.set("wf", { workflowStart: stored });
    await h.client.createWorkflowSession(request());
    assert.equal(h.starts.length, 1);
    assert.equal(h.starts[0].input, stored);
    assert.equal(h.calls.some(([kind]) => kind === "createSession"), false);
    assert.equal(h.rows.get("wf").orchestrationId, "session-wf");

    const ended = harness({ parent: { state: "failed", owner: ALICE } });
    ended.rows.set("wf", { sessionId: "wf", sessionKind: "workflow", state: "pending", orchestrationId: null });
    ended.configs.set("wf", { workflowStart: stored });
    await assert.rejects(ended.client.createWorkflowSession(request()), { code: "WORKFLOW_PARENT_INVALID" });
    assert.deepEqual(ended.starts, []);
});

test("when a concurrent create saved its request first, that request decides", async () => {
    const theirs = { sessionId: "wf", yaml: YAML, inputs: { day: "sun" }, parentSessionId: "parent", notifyParent: true };
    const lost = harness({
        createSession: async (id, _opts, { rows, configs }) => {
            rows.set(id, { sessionId: id, sessionKind: "workflow", state: "pending", orchestrationId: null });
            configs.set(id, { workflowStart: theirs });
        },
    });
    await assert.rejects(lost.client.createWorkflowSession(request()), { code: "WORKFLOW_ADMISSION_CONFLICT" });
    assert.deepEqual(lost.starts, []);

    const same = { ...theirs, inputs: { day: "mon" } };
    const tied = harness({
        createSession: async (id, _opts, { rows, configs }) => {
            rows.set(id, { sessionId: id, sessionKind: "workflow", state: "pending", orchestrationId: null });
            configs.set(id, { workflowStart: same });
        },
    });
    await tied.client.createWorkflowSession(request());
    assert.equal(tied.starts.length, 1);
    assert.equal(tied.starts[0].input, same);
});

test("an id held by another kind of session, or a workflow row without a saved request, is not started", async () => {
    const agent = harness();
    agent.rows.set("wf", { sessionId: "wf", sessionKind: "agent", state: "running" });
    await assert.rejects(agent.client.createWorkflowSession(request()), { code: "SESSION_EXISTS", status: 409 });

    const legacyRunning = harness();
    legacyRunning.rows.set("wf", { sessionId: "wf", sessionKind: "workflow", state: "running", orchestrationId: "session-wf" });
    assert.deepEqual(await legacyRunning.client.createWorkflowSession(request()), { sessionId: "wf", workflowName: "admission" });
    assert.deepEqual(legacyRunning.starts, []);

    const legacyPending = harness();
    legacyPending.rows.set("wf", { sessionId: "wf", sessionKind: "workflow", state: "pending", orchestrationId: null });
    await assert.rejects(legacyPending.client.createWorkflowSession(request()), { code: "WORKFLOW_ADMISSION_CONFLICT", message: /has no saved start request/ });
    assert.deepEqual(legacyPending.starts, []);
});

test("a deleted id whose run is still going is refused; a finished one is cleared and started anew", async () => {
    const running = harness();
    running.client.duroxideClient.getStatus = async () => ({ status: "Running" });
    await assert.rejects(running.client.createWorkflowSession(request()), { code: "WORKFLOW_SESSION_ENDING", status: 409 });
    assert.deepEqual(running.calls, []);

    const finished = harness();
    finished.client.duroxideClient.getStatus = async () => ({ status: "Completed" });
    await finished.client.createWorkflowSession(request());
    assert.deepEqual(finished.calls[0], ["deleteInstance", "session-wf"]);
    assert.equal(finished.starts.length, 1);
});
