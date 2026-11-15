/**
 * Adversarial review R2-UI-4: a step's visit numbers count within its scope (the root, or one branch of one parallel
 * visit), never across branches. The graph says a branch step's state from its branches in the parallel step's shown
 * visit (running while any of them runs it), and never takes another branch's later visit number as a reason to call a
 * running visit stale. The step log keys a poll summary by run, scope and step, so two branches' visits of one loop are
 * never merged or dropped; while both run, one branch's start or end never ends the other's summary (re-check RC-4).
 * Ended visits are ordered by completedAt, the store's completion clock, from their rows or their end events, never by an
 * event's own time (R3-UI-1 and its verification, S6-UI2).
 *
 * Run: node --test test/workflow-branch-scopes.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appendEventToHistory, buildHistoryModel } from "../src/history.js";
import { PilotSwarmUiController, UI_COMMANDS, appReducer, createInitialState, createStore } from "../src/index.js";
import { workflowSessionProjection } from "../src/workflow-tui.js";
import { projectWorkflow, workflowBranchChoice, workflowVisitScope } from "../src/workflow-view.js";
import { done, readModel, row } from "./workflow-fixtures.mjs";

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
    const poll = byId(projectWorkflow({ readModel: readModel({ graph, nodeExecutions: rows }) }), "poll");
    assert.equal(poll.state, "running", JSON.stringify([poll.state, poll.stateLabel]));
    assert.equal(poll.stateLabel, "1 ok · 1 running", "its items, counted with nouns (Workflow Simplified W5)");
    assert.equal(poll.pending?.id, "nx-poll-b1-1");
    assert.equal(poll.partial, false, "nothing is missing: no visit lost its end");
    assert.equal(poll.runs, 6, "each branch's visits count on their own");
    assert.equal(poll.outcome, "changed", "the latest ended visit is branch 1's fifth");
    assert.deepEqual(poll.branches.choices.map(choice => [choice.index, choice.status.stateLabel]), [[0, "Done · changed"], [1, "Running"]]);
    // Within one branch, a pending visit older than an ended one of that branch did lose its end.
    const lost = [...rows, row("poll", 2, "pending", { nodeExecutionId: "nx-poll-b0-2x", ...branch("nx-fan-1", 0) })];
    assert.equal(byId(projectWorkflow({ readModel: readModel({ graph, nodeExecutions: lost }) }), "poll").partial, true);
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
    const poll = byId(projectWorkflow({ readModel: readModel({ graph, nodeExecutions: rows }) }), "poll");
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
    let poll = byId(projectWorkflow({ readModel: model, events: [begin] }), "poll");
    assert.equal(poll.state, "running", JSON.stringify([poll.state, poll.stateLabel]));
    assert.equal(poll.pending?.id, "nx-poll-b1-1");
    assert.deepEqual(poll.pending?.branch, { parallelNodeExecutionId: "nx-fan-1", index: 1 });
    assert.deepEqual(poll.branches.choices.map(choice => [choice.index, choice.status.stateLabel]), [[0, "Done · changed"], [1, "Running"]]);
    // Its completion names no scope: it is the same visit, still branch 2's.
    const end = { eventType: "workflow.state_completed", data: { runId: run, nodeExecutionId: "nx-poll-b1-1", stateId: "poll", step: 1, outcome: "unchanged",
        resultKind: "business", outputPreview: "{}" } };
    poll = byId(projectWorkflow({ readModel: model, events: [begin, end] }), "poll");
    const visit = poll.executions.find(execution => execution.id === "nx-poll-b1-1");
    assert.equal(visit.status, "completed");
    assert.equal(workflowVisitScope(visit), "nx-fan-1#1");
    assert.equal(poll.runs, 6);
    // The root keeps its own scope; an odd scope is not taken for a branch.
    const root = { eventType: "workflow.state_started", data: { runId: run, nodeExecutionId: "nx-x", stateId: "poll", scopeId: "root", step: 1 } };
    const oddScope = { eventType: "workflow.state_started", data: { runId: run, nodeExecutionId: "nx-y", stateId: "poll", scopeId: "nx-fan-1#one", step: 1 } };
    const odd = byId(projectWorkflow({ readModel: readModel({ graph, nodeExecutions: [] }), events: [root, oddScope] }), "poll");
    assert.equal(workflowVisitScope(odd.executions.find(execution => execution.id === "nx-x")), "root");
    assert.equal(odd.executions.find(execution => execution.id === "nx-y").branch, undefined);
});

test("a visit's scope: its branch, else the scope it names, else the root", () => {
    assert.equal(workflowVisitScope({ branch: { parallelNodeExecutionId: "nx-f", index: 2 }, scopeId: "nx-f#2" }), "nx-f#2");
    assert.equal(workflowVisitScope({ branch: { parallelNodeExecutionId: "nx-f", index: 0 } }), "nx-f#0");
    assert.equal(workflowVisitScope({ scopeId: "nx-g#1" }), "nx-g#1");
    assert.equal(workflowVisitScope({}), "root");
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
// not seen queued: done is at least what is loaded, and the rest is unknown (queued, or ended in the older history). Its
// re-check RC-8 corrects this case: branches between two checks are running, not done (with every row loaded; with a part
// loaded they are unknown: UI-RC2-5).
test("R2-UI-7: a long run's branch counts are marked partial: at least N done, the unseen ones unknown, never queued", () => {
    const rows = [row("fan", 1, "pending", { nodeExecutionId: "nx-fan-1", branches: 64 })];
    // The newest 200 rows: branches 41 to 62 looped nine times each and are between steps (re-check RC-8: still at work, not
    // ended, while their next check is not admitted); branches 63 and 64 run a check.
    for (let index = 40; index < 62; index++) {
        for (let visit = 1; visit <= 9; visit++) {
            rows.push(done("poll", visit, "unchanged", { nodeExecutionId: `nx-poll-${index}-${visit}`, ...branch("nx-fan-1", index) }));
        }
    }
    rows.push(row("poll", 10, "pending", { nodeExecutionId: "nx-poll-62-10", ...branch("nx-fan-1", 62) }));
    rows.push(row("poll", 4, "pending", { nodeExecutionId: "nx-poll-63-4", ...branch("nx-fan-1", 63) }));
    assert.ok(rows.length > 200);
    const cursor = { v: 1, workflowId: "wf-1", runId: "run-1", section: "executions", order: "newest_first", after: { seq: "1" } };
    const partial = byId(projectWorkflow({ readModel: readModel({ graph, nodeExecutions: rows,
        run: { pages: { executions: { nextCursor: cursor, openComplete: true } } } }) }), "fan");
    // Re-check UI-RC2-5: with history not all loaded, only branches with a step at work now count as running; the 22 between
    // two checks may have gone on in rows not loaded, so they are unknown with the 40 not seen.
    assert.deepEqual(partial.joinBar.group.counts, { running: 2, done: 0, unknown: 62, partial: true, runningExact: true });
    // Words (Workflow Simplified W5; review 18:45Z): the For each box counts its items, running first; a partial count says what is not loaded.
    assert.equal(partial.joinBar.group.text, "2 running · 0+ ended · 62 not loaded");
    // Review 19:27Z (row 24, C): the node's description says it in the same words as the box.
    assert.ok(partial.description.includes("Items now: 2 running · 0+ ended · 62 not loaded"), partial.description.join("\n"));
    // Open rows not all listed: the running count is a lower bound too.
    const unlisted = byId(projectWorkflow({ readModel: readModel({ graph, nodeExecutions: rows,
        run: { pages: { executions: { nextCursor: cursor, openComplete: false } } } }) }), "fan");
    assert.equal(unlisted.joinBar.group.text, "2+ running · 0+ ended · 62 not loaded");
    // Every execution loaded (no older page): the counts are exact, and the branches not seen are queued.
    const whole = byId(projectWorkflow({ readModel: readModel({ graph, nodeExecutions: rows,
        run: { pages: { executions: { openComplete: true } } } }) }), "fan");
    assert.deepEqual(whole.joinBar.group.counts, { running: 24, queued: 40, done: 0 });
    assert.equal(whole.joinBar.group.text, "24 running · 40 waiting · 0 ended");
});

// Re-check RC-8: a branch is ended only by a recorded end (a terminal, a cancellation, a result no route takes), as its
// evidence row says; a branch between two of its steps (a loop's next check, an error with a recovery route) still runs.
test("RC-8: done counts only branches with a recorded end; a branch between steps, or recovering from an error, is running", () => {
    const states8 = [
        { id: "fan", type: "parallel", forEach: "${input.items}", concurrency: 6, join: "all_required", failFast: false,
            body: { initial: "poll", states: ["poll", "fix", "branch_done"] }, outcomes: ["joined", "blocked"], next: { joined: "done", blocked: "failed" } },
        { id: "poll", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["unchanged", "changed"],
            next: { unchanged: "poll", changed: "branch_done", failure: "fix" }, parallel: "fan" },
        { id: "fix", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["ok"], next: { ok: "poll" }, parallel: "fan" },
        { id: "branch_done", type: "terminal", outcome: "succeeded", parallel: "fan" },
        { id: "done", type: "terminal", outcome: "succeeded" },
        { id: "failed", type: "terminal", outcome: "failed" },
    ];
    const at = (index, id, visit, outcome, extra = {}) => done(id, visit, outcome, { nodeExecutionId: `nx-${id}-${index}-${visit}`, ...branch("nx-fan-1", index), ...extra });
    const rows = [
        row("fan", 1, "pending", { nodeExecutionId: "nx-fan-1", branches: 7 }),
        // 0: between two checks of its loop.
        at(0, "poll", 1, "unchanged"),
        // 1: reached its succeeded end.
        at(1, "poll", 1, "changed"), at(1, "branch_done", 1, "succeeded", { predecessorId: "nx-poll-1-1" }),
        // 2: an error with a recovery route, its next step not admitted yet.
        at(2, "poll", 1, "timed_out", { resultKind: "runtime_error" }),
        // 3: an error no route takes: ended.
        at(3, "fix", 1, "execution_failed", { resultKind: "runtime_error" }),
        // 4: cancelled at the time limit: ended.
        at(4, "poll", 1, "cancelled", { resultKind: "runtime_error", winner: "join_timeout" }),
        // 5: a check running now.
        row("poll", 1, "pending", { nodeExecutionId: "nx-poll-5-1", ...branch("nx-fan-1", 5) }),
        // 6: queued.
    ];
    const fan = byId(projectWorkflow({ readModel: readModel({ graph: { revision: 1, initial: "fan", states: states8 }, nodeExecutions: rows,
        run: { pages: { executions: { openComplete: true } } } }) }), "fan");
    assert.deepEqual(fan.joinBar.group.counts, { running: 3, queued: 1, done: 3 });
    assert.ok(fan.description.includes("Items now: 3 running · 1 waiting · 3 ended"), fan.description.join("\n"));
    // The same branches as its evidence rows say them.
    assert.deepEqual(fan.evidence.rows.map(item => item.status), ["running", "ok", "running", "failed", "canceled · limit", "running", "waiting"]);
});

// Re-check RC-9: older history read through its oldest page, then a branch's open check ended outside the newest page. That
// row is left out as changed since it was read, so the run's executions are not all loaded: the counts are partial, and the
// branch is never called queued.
test("RC-9: an older row left out as changed makes the history incomplete: partial counts, not a false queued branch", () => {
    const cursor = { v: 1, workflowId: "wf-1", runId: "run-1", section: "executions", order: "newest_first", after: { seq: "2" } };
    const fanRow = row("fan", 1, "pending", { nodeExecutionId: "nx-fan-1", branches: 3 });
    const b1poll = done("poll", 1, "changed", { nodeExecutionId: "nx-poll-1-1", ...branch("nx-fan-1", 1) });
    const page = [b1poll, done("branch_done", 1, "succeeded", { nodeExecutionId: "nx-done-1-1", predecessorId: "nx-poll-1-1", ...branch("nx-fan-1", 1) }),
        row("poll", 1, "pending", { nodeExecutionId: "nx-poll-2-1", ...branch("nx-fan-1", 2) })];
    // Read through its oldest page while branch 1's (index 0) check was open; it has ended since, outside the newest page.
    const older = { runId: "run-1", sections: { executions: { items: [fanRow, row("poll", 1, "pending", { nodeExecutionId: "nx-poll-0-1", ...branch("nx-fan-1", 0) }), b1poll],
        nextCursor: null } } };
    const model = readModel({ graph, nodeExecutions: page, run: { openExecutions: [fanRow, page[2]],
        pages: { executions: { nextCursor: cursor, openComplete: true } } } });
    const projected = projectWorkflow({ readModel: model, olderHistory: older });
    assert.equal(projected.readModel.run.history.staleOlder, 1);
    assert.equal(projected.readModel.run.history.complete, false, "a left-out row: not every execution is loaded");
    const fan = byId(projected, "fan");
    assert.deepEqual(fan.joinBar.group.counts, { running: 1, done: 1, unknown: 1, partial: true, runningExact: true });
    assert.ok(!fan.joinBar.group.text.includes("queued"), fan.joinBar.group.text);
    // Read again, the ended row comes back: the counts are whole again.
    const whole = { runId: "run-1", sections: { executions: { items: [fanRow, done("poll", 1, "changed", { nodeExecutionId: "nx-poll-0-1", ...branch("nx-fan-1", 0) }),
        done("branch_done", 1, "succeeded", { nodeExecutionId: "nx-done-0-1", predecessorId: "nx-poll-0-1", ...branch("nx-fan-1", 0) }), b1poll], nextCursor: null } } };
    const again = projectWorkflow({ readModel: model, olderHistory: whole });
    assert.equal(again.readModel.run.history.complete, true);
    assert.deepEqual(byId(again, "fan").joinBar.group.counts, { running: 1, queued: 0, done: 2 });
});

// Re-check UI-RC2-5: with history not all loaded, a branch between two steps (its routed result loaded, its next step not)
// may have gone on in rows not loaded, or its terminal may have been left out: it is unknown, never counted running. Only a
// branch with a step at work now is running; with every row loaded the same branch counts running.
test("UI-RC2-5: in partial history a branch between steps is unknown, not running; running is the branches at work now", () => {
    const rows = [
        row("fan", 1, "pending", { nodeExecutionId: "nx-fan-1", branches: 3 }),
        done("poll", 1, "unchanged", { nodeExecutionId: "nx-poll-0-1", ...branch("nx-fan-1", 0) }),
        row("poll", 1, "pending", { nodeExecutionId: "nx-poll-1-1", ...branch("nx-fan-1", 1) }),
        done("poll", 1, "changed", { nodeExecutionId: "nx-poll-2-1", ...branch("nx-fan-1", 2) }),
        done("branch_done", 1, "succeeded", { nodeExecutionId: "nx-done-2-1", predecessorId: "nx-poll-2-1", ...branch("nx-fan-1", 2) }),
    ];
    const cursor = { v: 1, workflowId: "wf-1", runId: "run-1", section: "executions", order: "newest_first", after: { seq: "1" } };
    const partial = byId(projectWorkflow({ readModel: readModel({ graph, nodeExecutions: rows,
        run: { pages: { executions: { nextCursor: cursor, openComplete: true } } } }) }), "fan");
    assert.deepEqual(partial.joinBar.group.counts, { running: 1, done: 1, unknown: 1, partial: true, runningExact: true });
    assert.equal(partial.joinBar.group.text, "1 running · 1+ ended · 1 not loaded");
    const whole = byId(projectWorkflow({ readModel: readModel({ graph, nodeExecutions: rows,
        run: { pages: { executions: { openComplete: true } } } }) }), "fan");
    assert.deepEqual(whole.joinBar.group.counts, { running: 2, queued: 0, done: 1 });
});

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };

/** The execution the TUI's f (its actual handler) reads for poll, with `model` read and `events` loaded; null when none. */
async function tuiWholeValue(model, events) {
    const reads = [];
    const transport = {
        getSessionEventsBefore: async () => [],
        readWorkflow: async (sessionId, options) => {
            if (!options?.executionId) return model;
            reads.push(options.executionId);
            return { workflowId: "wf-1", runId: options.runId, execution: { nodeExecutionId: options.executionId,
                result: { kind: "output", bytes: 2, whole: true, value: {} } } };
        },
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: fan-loop", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel(events) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: model, readModelRunId: null } });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await settle();
    store.dispatch({ type: "ui/modal", modal: { ...store.getState().ui.modal, selectedNodeId: "poll" } });
    await controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_WHOLE_VALUE);
    await settle();
    return reads.at(-1) ?? null;
}

// Adversarial review R3-UI-1 and its verification (S6-UI2): a visit's end is ordered by its completedAt, the store's
// completion clock read after the session lock, whether its read row or its end event gives it (every end event carries
// its row's completed_at). An event's own time is its transaction's start, which is not the completion order, and is never
// used: an end event from before that field is ordered by the old rules. The step's result (graph and Output), the TUI's
// whole value (f, its actual handler) and the branch picker's default agree, with or without the events.
test("R3-UI-1: ends are ordered by completedAt from rows or end events, never by an event's own time; result, TUI f and default branch agree", async () => {
    const T0 = Date.UTC(2026, 10, 5, 0, 0, 0);
    const iso = seconds => new Date(T0 + seconds * 1000).toISOString();
    const fan = row("fan", 1, "pending", { nodeExecutionId: "nx-fan-1", branches: 2 });
    const error = JSON.stringify({ code: "crashed", message: "exit code 1" });
    /** Branch `index`'s visit `id` of poll as a read row, ended at `seconds` (a runtime error when `failed`). */
    const ended = (id, index, seconds, failed = false) => (failed
        ? row("poll", 1, "completed", { nodeExecutionId: id, outcome: "crashed", resultKind: "runtime_error", winner: "controller",
            completedAt: typeof seconds === "string" ? seconds : iso(seconds), errorPreview: error, ...branch("nx-fan-1", index) })
        : done("poll", 1, "changed", { nodeExecutionId: id, completedAt: typeof seconds === "string" ? seconds : iso(seconds), outputPreview: '{"v":1}',
            ...branch("nx-fan-1", index) }));
    /** Its start and end events: `begun`, the end's transaction start (the events' own time); `completedAt`, its row's (null: an event from before). */
    const eventsOf = (id, index, begun, completedAt, failed = false) => [
        { sessionId: "wf", seq: 100 + 2 * index, eventType: "workflow.state_started", createdAt: iso(begun - 1),
            data: { runId: "run-1", nodeExecutionId: id, stateId: "poll", scopeId: `nx-fan-1#${index}`, type: "script", step: 1 } },
        { sessionId: "wf", seq: 101 + 2 * index, eventType: failed ? "workflow.state_failed" : "workflow.state_completed", createdAt: iso(begun),
            data: { runId: "run-1", nodeExecutionId: id, stateId: "poll", step: 1, outcome: failed ? "crashed" : "changed",
                ...(failed ? { error } : { resultKind: "business", outputPreview: '{"v":1}' }),
                ...(completedAt === null ? {} : { completedAt: typeof completedAt === "string" ? completedAt : iso(completedAt) }) } },
    ];
    const agree = async (rows, events, expected, label) => {
        const model = readModel({ graph, nodeExecutions: [fan, ...rows] });
        const poll = byId(projectWorkflow({ readModel: model, events }), "poll");
        assert.equal(poll.result?.id, expected, `${label}: the step's result`);
        assert.equal(workflowBranchChoice(poll.branches).ended?.id, expected, `${label}: the default branch's Output`);
        assert.equal(await tuiWholeValue(model, events), expected, `${label}: the TUI's f`);
        return poll;
    };

    // The reviewer's stale mixed-source sequence: the read lists branch 1's end (00:00:03); branch 2 failed later
    // (00:00:04) in a transaction that began earlier (its event's own time, 00:00:01). The later end is the result.
    const staleEvents = eventsOf("new", 1, 1, 4, true);
    let poll = await agree([ended("old", 0, 3)], staleEvents, "new", "stale read with the newer end's event");
    assert.deepEqual([poll.state, poll.outcome], ["failed", "crashed"]);
    assert.equal(workflowSessionProjection({ events: staleEvents, view: { readModel: readModel({ graph, nodeExecutions: [fan, ended("old", 0, 3)] }),
        readModelRunId: null } }).nodes.find(node => node.id === "poll").result?.id, "new", "the TUI's projection");
    await agree([ended("old", 0, 3), ended("new", 1, 4, true)], staleEvents, "new", "its row arrives, events kept");
    await agree([ended("old", 0, 3), ended("new", 1, 4, true)], [], "new", "its row arrives, no events");

    // The reviewer's identical final rows: the earlier commit's transaction began later (00:00:02) than the later
    // commit's (00:00:01). With or without the events, the rows' completion times decide: the later commit.
    const finalRows = [ended("earlier-commit", 0, 3), ended("later-commit", 1, 4)];
    const finalEvents = [...eventsOf("later-commit", 1, 1, 4), ...eventsOf("earlier-commit", 0, 2, 3)];
    await agree(finalRows, finalEvents, "later-commit", "identical final rows with events");
    await agree(finalRows, [], "later-commit", "identical final rows without events");
    await agree([finalRows[0]], eventsOf("later-commit", 1, 1, 4), "later-commit", "the later commit known only from its event");

    // An end the events tell is not the latest for that alone: a read end recorded after it stays the latest.
    await agree([ended("old", 0, 10)], eventsOf("new", 1, 5, 6, true), "old", "an older event");
    // Times with another offset compare as instants: 16:00:03-08:00 is 00:00:03Z, after the read's 00:00:01Z.
    await agree([ended("old", 0, 1)], eventsOf("new", 1, 0.5, "2026-11-04T16:00:03-08:00", true), "new", "an offset time");
    // Equal end times: the old tie rules, whatever the events' own times (here both pick branch 2: the later listed, the
    // higher branch).
    await agree([ended("first", 0, 5), ended("second", 1, 5)], [...eventsOf("second", 1, 1, 5), ...eventsOf("first", 0, 4, 5)], "second", "equal times");
    await agree([ended("first", 0, 5), ended("second", 1, 5)], [], "second", "equal times, no events");
    // An end event from before completedAt was carried: its own time is never taken for the end, however late; the end the
    // read gives a time stays the latest, as before.
    await agree([ended("old", 0, 3)], eventsOf("new", 1, 100, null, true), "old", "an event without completedAt");
});
