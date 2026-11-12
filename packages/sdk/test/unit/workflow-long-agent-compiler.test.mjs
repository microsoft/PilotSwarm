import test from "node:test";
import assert from "node:assert/strict";
import { compileWorkflow, parseWorkflowIr } from "../../dist/workflow/compiler.js";
import { workflowAgentPrompt, workflowAgentCyclePrompt } from "../../dist/workflow/runtime.js";

const yaml = (state, limits = "") => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: long-agent, version: "1.0.0" }
initial: work
${limits}
contracts:
  Ping@1:
    schema: { type: object }
    response: { schema: { type: object } }
states:
  work:
${state}
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  failed: { type: terminal, outcome: failed, output: "\${runtime.error}" }
`;
const wait = seconds => `    type: wait
    seconds: ${seconds}
    transition: { next: { elapsed: done, failure: failed } }`;
const agent = (seconds, timedOut = "failed") => `    type: agent
    session: continue
    invoke: { prompt: "Look once, then finish this visit." }
    timeoutSeconds: ${seconds}
    outcomes: [done]
    transition: { next: { done: done, timed_out: ${timedOut}, failure: failed } }`;
const request = seconds => `    type: messaging
    mode: request
    contract: Ping@1
    recipient: { parent: true }
    timeoutSeconds: ${seconds}
    transition: { next: { responded: done, declined: failed, failure: failed } }`;
const receive = seconds => `    type: messaging
    mode: receive
    contract: Ping@1
    wait: { seconds: ${seconds} }
    transition: { next: { received: done, elapsed: done, failure: failed } }`;
const parallel = seconds => `    type: parallel
    forEach: []
    timeoutSeconds: ${seconds}
    body:
      initial: short
      states:
        short: { type: wait, seconds: 1, transition: { next: { elapsed: end, failure: end } } }
        end: { type: terminal, outcome: succeeded }
    transition: { next: { joined: done, blocked: failed, timed_out: failed, failure: failed } }`;

test("FB-018: wait seconds accepts multi-day literals and bindings without changing the stored IR shape", () => {
    for (const seconds of [1, 86400, 86401, 2592000, '"${input.seconds}"']) {
        const result = compileWorkflow(yaml(wait(seconds)));
        assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
        assert.deepEqual(parseWorkflowIr(JSON.parse(JSON.stringify(result.ir))), result.ir);
        assert.deepEqual(Object.keys(result.ir.nodes.work).sort(),
            ["description", "hasInput", "id", "input", "next", "seconds", "type"]);
    }
    for (const seconds of [0, 1.5, 2592001]) {
        const result = compileWorkflow(yaml(wait(seconds)));
        assert.equal(result.valid, false);
        assert.ok(result.diagnostics.some(d => d.code === "WORKFLOW_FIELD_INVALID" && d.path === "states.work.seconds"));
    }
});

test("FB-018: agent, request, receive and parallel keep their 24-hour bound", () => {
    for (const state of [agent, request, receive, parallel]) {
        assert.equal(compileWorkflow(yaml(state(86400))).valid, true, state.name);
        assert.equal(compileWorkflow(yaml(state('"${kv.timeout}"'))).valid, true, state.name);
        for (const seconds of [86401, 2592000]) {
            const result = compileWorkflow(yaml(state(seconds)));
            assert.equal(result.valid, false, `${state.name} ${seconds}`);
            assert.ok(result.diagnostics.some(d => d.code === "WORKFLOW_FIELD_INVALID"));
        }
    }
});

test("FB-018: an oversized agent visit points to the continued-session sleep pattern", () => {
    const result = compileWorkflow(yaml(agent(86401)));
    const error = result.diagnostics.find(d => d.path === "states.work.timeoutSeconds");
    assert.equal(error.code, "WORKFLOW_FIELD_INVALID");
    assert.match(error.message, /session: continue/);
    assert.match(error.message, /sleep outcome/);
    assert.match(error.message, /workflow-patterns/);
});

test("FB-018: agent timeout self-loops warn, but sleep loops and other timeout routes do not", () => {
    const looping = compileWorkflow(yaml(agent(600, "work")));
    assert.equal(looping.valid, true);
    assert.ok(looping.diagnostics.some(d => d.code === "WORKFLOW_AGENT_TIMEOUT_LOOP"
        && d.severity === "warning" && d.path === "states.work.transition.next.timed_out"));
    assert.ok(!compileWorkflow(yaml(agent(600))).diagnostics.some(d => d.code === "WORKFLOW_AGENT_TIMEOUT_LOOP"));
});

test("FB-018: only literal wait durations longer than the run deadline warn", () => {
    for (const seconds of [86401, 2592000]) {
        const result = compileWorkflow(yaml(wait(seconds), "limits: { timeoutSeconds: 86400 }"));
        assert.equal(result.valid, true, JSON.stringify(result.diagnostics));
        assert.ok(result.diagnostics.some(d => d.code === "WORKFLOW_WAIT_EXCEEDS_RUN_TIMEOUT"
            && d.severity === "warning" && d.path === "states.work.seconds"));
    }
    for (const seconds of [86399, 86400, '"${kv.seconds}"']) {
        assert.ok(!compileWorkflow(yaml(wait(seconds), "limits: { timeoutSeconds: 86400 }"))
            .diagnostics.some(d => d.code === "WORKFLOW_WAIT_EXCEEDS_RUN_TIMEOUT"));
    }
});

test("FB-018: first and subsequent cycle prompts name the visit deadline and sleep outcome", () => {
    const invocation = {
        workflowSessionId: "wf", runId: "run", nodeExecutionId: "node", stateId: "look",
        controllingSessionId: "parent", task: { source: "prompt", prompt: "Look once." },
        input: {}, inputSchema: null, outcomes: ["done", "sleep"], outputSchema: null, schemas: {},
        deadlineAt: "2026-11-12T12:00:00.000Z", continues: true,
        cycle: 2, previous: null, variables: {}, changedVariables: [],
    };
    for (const prompt of [workflowAgentPrompt(invocation), workflowAgentCyclePrompt(invocation)]) {
        assert.match(prompt, /wait, wait_on_worker, cron and cron_at/);
        assert.match(prompt, /sleep outcome/);
        assert.match(prompt, /deadline/);
    }
});
