/**
 * Adversarial review R2-UI-4: a step's visit numbers count within its scope (the root, or one branch of one parallel
 * visit), never across branches. The graph says a branch step's state from its branches in the parallel step's shown
 * visit (running while any of them runs it), and never takes another branch's later visit number as a reason to call a
 * running visit stale. The step log keys a poll summary by run, scope and step, so two branches' visits of one loop are
 * never merged or dropped; while both run, one branch's start or end never ends the other's summary (re-check RC-4).
 *
 * Run: node --test test/workflow-v2-branch-scopes.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appendEventToHistory, buildHistoryModel } from "../src/history.js";
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

// Re-check RC-3: a visit known only from live events (the next read is late or failed) keeps the branch its start names,
// as a read row would, and its completion (which names none) is the same visit; so a branch that started after the read
// is not taken for the root, and the step runs while it runs.
test("RC-3: a branch visit known only from its live start keeps its branch: the step runs while it runs; its end is the same visit", () => {
    const rows = [row("fan", 1, "pending", { nodeExecutionId: "nx-fan-1", branches: 2 })];
    for (let visit = 1; visit <= 5; visit++) {
        rows.push(done("poll", visit, visit === 5 ? "changed" : "unchanged", { nodeExecutionId: `nx-poll-b0-${visit}`, ...branch("nx-fan-1", 0) }));
    }
    const run = "run-1";
    const begin = { eventType: "workflow.state_started", data: { runId: run, nodeExecutionId: "nx-poll-b1-1", stateId: "poll", scopeId: "nx-fan-1#1",
        ordinal: 1, type: "script", step: 1, kvRevision: 1 } };
    const model = readModel({ graph, nodeExecutions: rows });
    let poll = byId(projectWorkflowV2({ readModel: model, events: [begin] }), "poll");
    assert.equal(poll.state, "running", JSON.stringify([poll.state, poll.stateLabel]));
    assert.equal(poll.pending?.id, "nx-poll-b1-1");
    assert.deepEqual(poll.pending?.branch, { parallelNodeExecutionId: "nx-fan-1", index: 1 });
    assert.deepEqual(poll.branches.choices.map(choice => [choice.index, choice.status.stateLabel]), [[0, "Done · changed"], [1, "Running"]]);
    // Its completion names no scope: it is the same visit, still branch 2's.
    const end = { eventType: "workflow.state_completed", data: { runId: run, nodeExecutionId: "nx-poll-b1-1", stateId: "poll", step: 1, outcome: "unchanged",
        resultKind: "business", outputPreview: "{}" } };
    poll = byId(projectWorkflowV2({ readModel: model, events: [begin, end] }), "poll");
    const visit = poll.executions.find(execution => execution.id === "nx-poll-b1-1");
    assert.equal(visit.status, "completed");
    assert.equal(workflowV2VisitScope(visit), "nx-fan-1#1");
    assert.equal(poll.runs, 6);
    // The root keeps its own scope; an odd scope is not taken for a branch.
    const root = { eventType: "workflow.state_started", data: { runId: run, nodeExecutionId: "nx-x", stateId: "poll", scopeId: "root", step: 1 } };
    const oddScope = { eventType: "workflow.state_started", data: { runId: run, nodeExecutionId: "nx-y", stateId: "poll", scopeId: "nx-fan-1#one", step: 1 } };
    const odd = byId(projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: [] }), events: [root, oddScope] }), "poll");
    assert.equal(workflowV2VisitScope(odd.executions.find(execution => execution.id === "nx-x")), "root");
    assert.equal(odd.executions.find(execution => execution.id === "nx-y").branch, undefined);
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

// Re-check RC-4: while both branches run, a start or an end in one branch never finishes or splits the other's summary;
// a completion that names no scope finds its branch by its visit's start; the run's end finishes every branch's summary.
test("RC-4: each branch keeps its own summary while both are pending; the run's end finishes all of them", () => {
    const groups = history => history.chat.filter(item => item.workflowProgress);
    const byBranch = (history, scope) => groups(history).find(item => item.workflowProgress.scopeId === `nx-fan-1#${scope}`);
    // Branch 0 checked once and checks again; then branch 1 starts its first check.
    const events = [started(), begin(0, 1), complete(0, 1), begin(0, 2), begin(1, 1)];
    let history = buildHistoryModel(events);
    assert.equal(groups(history).length, 2, JSON.stringify(groups(history).map(item => item.workflowProgress)));
    let zero = byBranch(history, 0);
    assert.equal(zero.workflowProgress.pending, true, "branch 1's start does not end branch 0's summary");
    assert.equal(zero.workflowProgress.count, 1);
    assert.match(zero.text, /^\*\*poll\*\*: Checking · 1 check/);
    assert.equal(byBranch(history, 1).workflowProgress.pending, true);
    // Branch 0's second check ends (no scope named): it joins branch 0's summary, not branch 1's.
    events.push(complete(0, 2));
    history = buildHistoryModel(events);
    zero = byBranch(history, 0);
    assert.deepEqual(zero.workflowProgress.entries.map(entry => entry.outputPreview), ['{"b":0,"v":1}', '{"b":0,"v":2}']);
    assert.equal(byBranch(history, 1).workflowProgress.pending, true, "and branch 1 still checks");
    // Branch 1 leaves the loop: its own summary ends; branch 0's is untouched.
    events.push(begin(0, 3), complete(1, 1, "changed"));
    history = buildHistoryModel(events);
    assert.equal(byBranch(history, 0).workflowProgress.pending, true);
    assert.equal(byBranch(history, 1), undefined, "branch 1's start-only summary is replaced by its own line");
    // The run is stopped: every summary of it still checking ends.
    events.push(event("workflow.stopped", { runId: "run-a", reason: "enough" }));
    history = buildHistoryModel(events);
    zero = byBranch(history, 0);
    assert.equal(zero.workflowProgress.pending, false);
    assert.equal(zero.workflowProgress.waiting, false);
    assert.match(zero.text, /Polling ended/);
    assert.ok(groups(history).every(item => !item.workflowProgress.pending && !item.workflowProgress.waiting));
    // Live appends give the same transcript as a whole build.
    const live = events.reduce(appendEventToHistory, buildHistoryModel());
    assert.deepEqual(groups(live).map(item => item.text), groups(history).map(item => item.text));
});

// Adversarial review R2-UI-7: with more executions than one read returns, the branch box does not call branches it has
// not seen queued: done is at least what is loaded, and the rest is unknown (queued, or ended in the older history).
test("R2-UI-7: a long run's branch counts are marked partial: at least N done, the unseen ones unknown, never queued", () => {
    const rows = [row("fan", 1, "pending", { nodeExecutionId: "nx-fan-1", branches: 64 })];
    // The newest 200 rows: branches 41 to 62 looped nine times each and are between steps; branches 63 and 64 run.
    for (let index = 40; index < 62; index++) {
        for (let visit = 1; visit <= 9; visit++) {
            rows.push(done("poll", visit, "unchanged", { nodeExecutionId: `nx-poll-${index}-${visit}`, ...branch("nx-fan-1", index) }));
        }
    }
    rows.push(row("poll", 10, "pending", { nodeExecutionId: "nx-poll-62-10", ...branch("nx-fan-1", 62) }));
    rows.push(row("poll", 4, "pending", { nodeExecutionId: "nx-poll-63-4", ...branch("nx-fan-1", 63) }));
    assert.ok(rows.length > 200);
    const cursor = { v: 1, workflowId: "wf-1", runId: "run-1", section: "executions", order: "newest_first", after: { seq: "1" } };
    const partial = byId(projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: rows,
        run: { pages: { executions: { nextCursor: cursor, openComplete: true } } } }) }), "fan");
    assert.deepEqual(partial.joinBar.group.counts, { running: 2, done: 22, unknown: 40, partial: true, runningExact: true });
    assert.equal(partial.joinBar.group.text, "2 running · at least 22 done · 40 unknown");
    assert.ok(partial.description.includes(
        "Branches now (in the loaded history): 2 active, at least 22 ended, 40 not in the loaded history (queued, or ended earlier)."), partial.description.join("\n"));
    // Open rows not all listed: the running count is a lower bound too.
    const unlisted = byId(projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: rows,
        run: { pages: { executions: { nextCursor: cursor, openComplete: false } } } }) }), "fan");
    assert.equal(unlisted.joinBar.group.text, "at least 2 running · at least 22 done · 40 unknown");
    // Every execution loaded (no older page): the counts are exact, and the branches not seen are queued.
    const whole = byId(projectWorkflowV2({ readModel: readModel({ graph, nodeExecutions: rows,
        run: { pages: { executions: { openComplete: true } } } }) }), "fan");
    assert.deepEqual(whole.joinBar.group.counts, { running: 2, queued: 40, done: 22 });
    assert.equal(whole.joinBar.group.text, "2 running · 40 queued · 22 done");
});
