import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmClient } from "../../dist/client.js";
import { WORKFLOW_TOOL_POLICY } from "../../dist/workflow/tool-policy.js";

const yaml = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata: { name: admission, version: 1.0.0 }
initial: run
states:
  run:
    type: script
    runtime: node
    source: 'console.log("ok")'
    completion: { outcomes: [success] }
    transition: { next: { success: end } }
  end: { type: terminal, outcome: succeeded }
`;
const owner = { provider: "dev", subject: "alice" };
const binding = { policy: WORKFLOW_TOOL_POLICY, parentSessionId: "parent", owner, config: {},
    capabilities: { revision: 0, selections: [] }, tools: [], sourceRevisions: {}, excludedTools: [],
    boundAgentFingerprint: "fixture" };
const config = { sessionId: "child", parentSessionId: "parent", owner, yaml, inputs: {} };

function fixture() {
    const rows = new Map([["parent", { sessionId: "parent", state: "running", owner }]]);
    const configs = new Map([["parent", { model: "fixture" }]]);
    const starts = [], attempts = [];
    let failStart = false;
    const client = new PilotSwarmClient({ waitThreshold: 30 });
    client._catalog = {
        getSession: async id => rows.get(id) ?? null,
        getSessionCreationConfig: async id => configs.get(id) ?? null,
        createSession: async (id, options) => {
            if (rows.has(id)) return;
            rows.set(id, { sessionId: id, state: "pending", ...options });
            configs.set(id, structuredClone(options.creationConfig));
        },
        updateSession: async (id, changes) => Object.assign(rows.get(id), changes),
    };
    client.duroxideClient = {
        startOrchestrationVersioned: async (id, name, input, version) => {
            attempts.push(id);
            if (failStart) { failStart = false; throw new Error("start interrupted"); }
            if (!starts.some(start => start.id === id)) starts.push({ id, name, input, version });
        },
    };
    return { client, rows, configs, starts, attempts, failNextStart: () => { failStart = true; } };
}

test("new child admission persists its original start and uses controller 1.1", async () => {
    const f = fixture();
    await f.client.createWorkflowSession(config, binding);
    assert.equal(f.starts[0].version, "1.1.0");
    assert.equal(f.starts[0].input.executionPolicy, WORKFLOW_TOOL_POLICY);
    assert.deepEqual(f.starts[0].input, f.configs.get("child").workflowAdmission.input);
    assert.equal(f.rows.get("child").state, "running");
});

test("retry after catalog creation recovers the pending workflow, not a new input", async () => {
    const f = fixture();
    f.failNextStart();
    await assert.rejects(f.client.createWorkflowSession(config, binding), /start interrupted/);
    assert.equal(f.rows.get("child").state, "pending");
    const original = structuredClone(f.configs.get("child"));
    await f.client.createWorkflowSession(config, binding);
    assert.equal(f.starts.length, 1);
    assert.deepEqual(f.configs.get("child"), original);
    assert.equal(f.rows.get("child").state, "running");
});

test("conflicting concurrent admissions never replace the first definition", async () => {
    const f = fixture();
    const results = await Promise.allSettled([
        f.client.createWorkflowSession(config, binding),
        f.client.createWorkflowSession({ ...config, inputs: { different: true } }, binding),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(results.find(result => result.status === "rejected").reason.code, "WORKFLOW_ADMISSION_CONFLICT");
    assert.deepEqual(f.configs.get("child").workflowAdmission.input.inputs, {});
    assert.equal(f.starts.length, 1);
});

test("completed admission is returned without starting again and mismatched owner is rejected", async () => {
    const f = fixture();
    await f.client.createWorkflowSession(config, binding);
    f.rows.get("child").state = "completed";
    await f.client.createWorkflowSession(config, binding);
    assert.equal(f.attempts.length, 1);
    await assert.rejects(f.client.createWorkflowSession({ ...config, owner: { provider: "dev", subject: "mallory" } }, binding),
        { code: "WORKFLOW_PARENT_INVALID" });
});

test("previous admissions retain their behavior while new top-level starts are deferred", async () => {
    const f = fixture();
    f.rows.set("old", { sessionId: "old", sessionKind: "workflow", title: "Workflow: old", state: "running" });
    assert.equal((await f.client.createWorkflowSession({ sessionId: "old", yaml })).workflowName, "old");
    await assert.rejects(f.client.createWorkflowSession({ yaml }), { code: "WORKFLOW_PARENT_REQUIRED" });
    assert.equal(f.starts.length, 0);
});
