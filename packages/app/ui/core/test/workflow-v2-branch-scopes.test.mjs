/**
 * Adversarial review R2-UI-4: a step's visit numbers count within its scope (the root, or one branch of one parallel
 * visit), never across branches. The graph says a branch step's state from its branches in the parallel step's shown
 * visit (running while any of them runs it), and never takes another branch's later visit number as a reason to call a
 * running visit stale. The step log keys a poll summary by run, scope and step, so two branches' visits of one loop are
 * never merged or dropped.
 *
 * Run: node --test test/workflow-v2-branch-scopes.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildHistoryModel } from "../src/history.js";
import { projectWorkflowV2, workflowV2VisitScope } from "../src/workflow-v2-view.js";
import { done, readModel, row } from "./workflow-v2-fixtures.mjs";

const states = [
    { id: "fan", type: "parallel", forEach: "${input.items}", concurrency: 3, join: "all_required", failFast: false,
        body: { initial: "poll", states: ["poll", "branch_done"] }, outcomes: ["joined", "blocked"], next: { joined: "done", blocked: "failed" } },
    { id: "poll", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["unchanged", "changed"], next: { unchanged: "poll", changed: "branch_done" },
        parallel: "fan" },
    { id: "branch_done", type: "terminal", outcome: "succeeded", parallel: "fan" },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const graph = { revision: 1, initial: "fan", states };
const branch = (fan, index) => ({ scopeId: `${fan}#${index}`, branch: { parallelNodeExecutionId: fan, index } });
const byId = (projection, id) => projection.nodes.find(node => node.id === id);

test("a branch's later visit number never makes another branch's running visit stale; the step runs while a branch runs it", () => {
    // Branch 1 looped five times and moved on; branch 2 is still in its first visit.
    const rows = [row("fan", 1, "pending", { nodeExecutionId: "nx-fan-1", branches: 2 })];
    for (let visit = 1; visit <= 5; visit++) {
        rows.push(done("poll", visit, visit === 5 ? "changed" : "unchanged", { nodeExecutionId: `nx-poll-b0-${visit}`, ...branch("nx-fan-1", 0) }));
    }
    rows.push(row("poll", 1, "pending", { nodeExecutionId: "nx-poll-b1-1", ...branch("nx-fan-1", 1) }));
    const poll = byId(projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: rows }) }), "poll");
    assert.equal(poll.state, "running", JSON.stringify([poll.state, poll.stateLabel]));
    assert.equal(poll.stateLabel, "Running · in 1 of 2 branches");
    assert.equal(poll.pending?.id, "nx-poll-b1-1");
    assert.equal(poll.partial, false, "nothing is missing: no visit lost its end");
    assert.equal(poll.runs, 6, "each branch's visits count on their own");
    assert.equal(poll.outcome, "changed", "the latest ended visit is branch 1's fifth");
    assert.deepEqual(poll.branches.choices.map(choice => [choice.index, choice.status.stateLabel]), [[0, "Done · changed"], [1, "Running"]]);
    // Within one branch, a pending visit older than an ended one of that branch did lose its end.
    const lost = [...rows, row("poll", 2, "pending", { nodeExecutionId: "nx-poll-b0-2x", ...branch("nx-fan-1", 0) })];
    assert.equal(byId(projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: lost }) }), "poll").partial, true);
});

test("a second visit of the parallel step: its branches decide the step, not the longer first visit's", () => {
    const rows = [
        done("fan", 1, "joined", { nodeExecutionId: "nx-fan-1", branches: 1 }),
        done("poll", 1, "unchanged", { nodeExecutionId: "nx-poll-a-1", ...branch("nx-fan-1", 0) }),
        done("poll", 2, "unchanged", { nodeExecutionId: "nx-poll-a-2", ...branch("nx-fan-1", 0) }),
        done("poll", 3, "changed", { nodeExecutionId: "nx-poll-a-3", ...branch("nx-fan-1", 0) }),
        row("fan", 2, "pending", { nodeExecutionId: "nx-fan-2", branches: 1 }),
        row("poll", 1, "pending", { nodeExecutionId: "nx-poll-b-1", ...branch("nx-fan-2", 0) }),
    ];
    const poll = byId(projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: rows }) }), "poll");
    assert.equal(poll.state, "running");
    assert.equal(poll.stateLabel, "Running", "one branch in the shown visit: no count");
    assert.equal(poll.pending?.id, "nx-poll-b-1");
    assert.equal(poll.partial, false);
    assert.equal(poll.runs, 4);
    assert.deepEqual(poll.branches.choices.map(choice => choice.execution.id), ["nx-poll-b-1"], "the picker is of the shown visit");
});

test("a visit's scope: its branch, else the scope it names, else the root", () => {
    assert.equal(workflowV2VisitScope({ branch: { parallelNodeExecutionId: "nx-f", index: 2 }, scopeId: "nx-f#2" }), "nx-f#2");
    assert.equal(workflowV2VisitScope({ branch: { parallelNodeExecutionId: "nx-f", index: 0 } }), "nx-f#0");
    assert.equal(workflowV2VisitScope({ scopeId: "nx-g#1" }), "nx-g#1");
    assert.equal(workflowV2VisitScope({}), "root");
});

let seq = 0;
const event = (eventType, data) => ({ sessionId: "wf", seq: ++seq, eventType, data, createdAt: new Date(Date.UTC(2026, 10, 4, 12, 0, seq)) });
const started = () => event("workflow.started", { runId: "run-a", mode: "live", revision: 1, name: "fan-loop", version: "1.0.0", initial: "fan",
    states: [{ id: "poll", type: "script", runtime: "node", next: { unchanged: "poll", changed: "branch_done" } },
        { id: "branch_done", type: "terminal", outcome: "succeeded" }] });
const begin = (scope, step) => event("workflow.state_started", {
    runId: "run-a", nodeExecutionId: `nx-poll-${scope}-${step}`, stateId: "poll", scopeId: `nx-fan-1#${scope}`, ordinal: step, type: "script", step, kvRevision: 1 });
const complete = (scope, step, outcome = "unchanged") => event("workflow.state_completed", {
    runId: "run-a", nodeExecutionId: `nx-poll-${scope}-${step}`, stateId: "poll", step, outcome, resultKind: "business", outputPreview: `{"b":${scope},"v":${step}}` });

test("the step log keys a poll summary by run, scope and step: two branches' visits of one loop are never merged or dropped", () => {
    // Interleaved: both branches start visit 1, then both complete it; then branch 0 loops once more.
    const history = buildHistoryModel([started(), begin(0, 1), begin(1, 1), complete(0, 1), complete(1, 1), begin(0, 2), complete(0, 2)]);
    const rows = history.chat.filter(item => item.workflowProgress);
    const outputs = rows.flatMap(item => item.workflowProgress.entries.map(entry => entry.outputPreview));
    assert.deepEqual(outputs.sort(), ['{"b":0,"v":1}', '{"b":0,"v":2}', '{"b":1,"v":1}'].sort(), "every completion is kept");
    // No summary holds two branches.
    for (const item of rows) {
        const ids = new Set(item.workflowProgress.entries.map(entry => JSON.parse(entry.outputPreview).b));
        assert.ok(ids.size <= 1, JSON.stringify(item.workflowProgress));
    }
    // One branch alone still compacts its loop: start and end of each visit are matched by its node execution.
    const single = buildHistoryModel([started(), begin(0, 1), complete(0, 1), begin(0, 2), complete(0, 2), begin(0, 3), complete(0, 3)]);
    assert.deepEqual(single.chat.filter(item => item.workflowProgress).map(item => item.workflowProgress.count), [3]);
});
