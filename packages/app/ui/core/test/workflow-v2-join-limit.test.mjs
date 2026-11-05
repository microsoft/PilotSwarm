// Owner decision join-k-of-n (IR 9): a parallel step's join of the first k and its own time limit, as the portal and the
// TUI show them. The join bar says the rule ("all required", "first success", "first 2 of 4", "first 2") and the real
// time limit (its length; when the shown visit's ends; that it passed); timed_out leaves from the bar; the Branches
// table says how each branch ended (succeeded, failed, cancelled at time limit, cancelled after the join, cancelled,
// not started), a branch cut between two of its steps included; the details say the rule and the time limit in words.
// J1b: a branch whose step finished but whose next step never started reads "finished before the time limit" (or
// before the join, its block or the run's end), keeps its result, and counts as a success when its next step is a
// succeeded end saved by the time limit; a join blocked at its time limit says so; a join after the time limit says the
// successes saved before it still joined; a success saved after the time limit did not count. A branch's last step is
// the end of its chain of steps (review J1-R1), not the order a read lists them in.
//
// Run: node --test packages/app/ui/core/test/workflow-v2-join-limit.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { appReducer, buildHistoryModel, createInitialState, createStore, selectWorkflowViewModal } from "../src/index.js";
import {
    projectWorkflowV2, workflowEventText, workflowV2Definition, workflowV2JoinFirst, workflowV2JoinLimit, workflowV2JoinRule, workflowV2JoinWords,
    workflowV2VisitEnding,
} from "../src/workflow-v2-view.js";
import {
    layoutWorkflowGraphTB, WORKFLOW_GRAPH_JOIN_HEIGHT, WORKFLOW_GRAPH_JOIN_LIMIT_HEIGHT,
} from "../src/workflow-graph-layout.js";
import { WorkflowV2NodeContent } from "../../react/src/workflow-v2-panels.js";
import { WorkflowJoinBar } from "../../react/src/workflow-graph.js";
import { readModel, row, done } from "./workflow-v2-fixtures.mjs";

// Times are shown in the reader's own time zone (owner decision local-time-20261104): this file fixes it to UTC, so no
// result depends on the zone of the machine that runs it.
process.env.TZ = "UTC";

const literal = count => ({ count, sha256: "a".repeat(64) });
/** A parallel step over reviewers: prepare, an agent review, the branch's end; then pause, or end blocked, or (with a time limit) late. */
const fan = (extra = {}) => ({ id: "fan", type: "parallel", forEach: "${input.reviewers}", concurrency: 2, join: "all_required", failFast: false,
    body: { initial: "prepare", states: ["prepare", "review", "reviewed"] }, outcomes: ["joined", "blocked"],
    next: { joined: "pause", blocked: "review_blocked", ...(extra.timeoutSeconds !== undefined ? { timed_out: "late" } : {}) }, ...extra });
const statesOf = parallel => [
    parallel,
    { id: "prepare", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["ready"], next: { ready: "review" }, parallel: "fan" },
    { id: "review", type: "agent", invoke: { source: "prompt" }, timeoutSeconds: 600, outcomes: ["completed"], next: { completed: "reviewed" }, parallel: "fan" },
    { id: "reviewed", type: "terminal", outcome: "succeeded", parallel: "fan" },
    { id: "pause", type: "wait", seconds: 15, outcomes: ["elapsed"], next: { elapsed: "done" } },
    { id: "review_blocked", type: "terminal", outcome: "blocked" },
    { id: "late", type: "terminal", outcome: "blocked" },
    { id: "done", type: "terminal", outcome: "succeeded" },
];
const branch = index => ({ scopeId: `nx-fan-1#${index}`, branch: { parallelNodeExecutionId: "nx-fan-1", index } });
/** Branch `index` went through its states up to `last`; `end` replaces the last state's row (a cancellation). */
const through = (index, last, end = {}) => {
    const steps = ["prepare", "review", "reviewed"];
    const outcomes = { prepare: "ready", review: "completed", reviewed: "succeeded" };
    return steps.slice(0, steps.indexOf(last) + 1).map(stateId => (stateId === last && Object.keys(end).length
        ? row(stateId, 1, "completed", { nodeExecutionId: `nx-${stateId}-b${index}`, ...end, ...branch(index) })
        : done(stateId, 1, outcomes[stateId], { nodeExecutionId: `nx-${stateId}-b${index}`, ...branch(index) })));
};
const byId = (projection, id) => projection.nodes.find(node => node.id === id);
const details = (projection, id) => renderToStaticMarkup(React.createElement(WorkflowV2NodeContent, {
    tab: "details", selected: byId(projection, id), nodes: projection.nodes, select: () => {}, runOutput: null, runError: null }));
const DEADLINE = "2026-11-04T20:30:00.000Z";
const CANCELLED = { outcome: "cancelled", resultKind: "runtime_error", errorPreview: JSON.stringify({ code: "cancelled", message: "cancelled" }) };

/** A visit timed out at its 30-second limit: branch 1 succeeded, branch 2 was cancelled at its review, branch 3 never started. */
const timedOut = () => projectWorkflowV2({ readModel: readModel({ graph: { revision: 1, initial: "fan", states: statesOf(fan({ timeoutSeconds: 30, concurrency: 1 })) },
    nodeExecutions: [
        row("fan", 1, "completed", { branches: 3, outcome: "timed_out", resultKind: "runtime_error", winner: "controller", deadline: DEADLINE,
            errorPreview: JSON.stringify({ code: "timed_out", message: "The parallel state's time limit passed before its join." }) }),
        ...through(0, "reviewed"),
        ...through(1, "review", { ...CANCELLED, winner: "join_timeout" }),
    ] }) });

/** The first 2 of 4 joined: branches 1 and 4 succeeded; branch 2 was cancelled at its review, branch 3 between its two first steps. */
const firstTwo = () => projectWorkflowV2({ readModel: readModel({
    graph: { revision: 1, initial: "fan", states: statesOf(fan({ join: { first: 2 }, forEach: literal(4), concurrency: 4 })) },
    nodeExecutions: [
        row("fan", 1, "completed", { branches: 4, outcome: "joined", resultKind: "business", winner: "controller", outputPreview: "[]" }),
        ...through(0, "reviewed"),
        ...through(1, "review", { ...CANCELLED, winner: "join" }),
        ...through(2, "prepare"),
        ...through(3, "reviewed"),
    ] }) });

test("the join's rule and its words: all required, first success, first k of n when n is known, first k otherwise; failFast", () => {
    assert.equal(workflowV2JoinFirst(fan()), null);
    assert.equal(workflowV2JoinFirst(fan({ join: { first: 3 } })), 3);
    assert.equal(workflowV2JoinFirst(fan({ join: { first: 0 } })), null);
    assert.equal(workflowV2JoinRule(fan()), "all required");
    assert.equal(workflowV2JoinRule(fan({ join: { first: 1 } })), "first success");
    assert.equal(workflowV2JoinRule(fan({ join: { first: 2 }, forEach: literal(5) })), "first 2 of 5");
    assert.equal(workflowV2JoinRule(fan({ join: { first: 2 } })), "first 2");
    assert.equal(workflowV2JoinRule(fan({ join: { first: 2 } }), { branches: 4 }), "first 2 of 4", "the shown visit says how many");
    assert.equal(workflowV2JoinWords(fan()), "Every branch must succeed");
    assert.equal(workflowV2JoinWords(fan({ failFast: true })), "Every branch must succeed · the first failure cancels the others");
    assert.equal(workflowV2JoinWords(fan({ join: { first: 1 } })), "The first branch to succeed joins; the others are canceled");
    assert.equal(workflowV2JoinWords(fan({ join: { first: 2 }, failFast: true })),
        "The first 2 branches to succeed join; the others are canceled · once the join can no longer succeed, the others are canceled");
});

test("the time limit as people read it: none, its length, from the input, until when while it waits, and that it passed", () => {
    assert.equal(workflowV2JoinLimit(fan()), null);
    assert.deepEqual(workflowV2JoinLimit(fan({ timeoutSeconds: 30 })), { text: "time limit 30 s", title: "The time limit is 30 s from the step's start." });
    assert.deepEqual(workflowV2JoinLimit(fan({ timeoutSeconds: "${input.limit}" })),
        { text: "time limit from the input", title: "The time limit is set from the input (${input.limit}) when the step starts." });
    assert.deepEqual(workflowV2JoinLimit(fan({ timeoutSeconds: 120 }), { deadline: DEADLINE }, { running: true }),
        { text: "time limit until 2026-11-04 20:30:00 UTC", title: "The time limit is 2 min from the step's start: it passes at 2026-11-04 20:30:00 UTC." });
    assert.deepEqual(workflowV2JoinLimit(fan({ timeoutSeconds: 30 }), { deadline: DEADLINE }, { timedOut: true }),
        { text: "time limit 30 s", title: "The time limit is 30 s from the step's start. It passed before the join, at 2026-11-04 20:30:00 UTC." });
});

test("a visit that timed out: the bar says so with its time limit; the branches say succeeded, cancelled at time limit and not started", () => {
    const projection = timedOut();
    const parallel = byId(projection, "fan");
    assert.deepEqual([parallel.state, parallel.stateLabel], ["failed", "Time limit passed before the join"]);
    assert.deepEqual(parallel.joinBar, {
        id: "join:fan", state: "timed_out", rule: "all required", label: "Continues when all items succeed", stateText: "time limit passed",
        limit: { text: "time limit 30 s", title: "The time limit is 30 s from the step's start. It passed before the join, at 2026-11-04 20:30:00 UTC." },
        group: { label: "For each item", counts: null, text: null },
    });
    assert.deepEqual(parallel.evidence.rows.map(row => [row.index, row.status, row.why]), [
        [0, "succeeded", null],
        [1, "cancelled at time limit", "The parallel step's time limit passed, so this branch was canceled"],
        [2, "not started", null],
    ]);
    assert.deepEqual([parallel.evidence.timedOut, parallel.evidence.blocked, parallel.evidence.needed, parallel.evidence.succeeded], [true, false, 3, 1]);
    // The cancelled branch state's own ending says why.
    const cancelled = byId(projection, "review").executions.find(execution => execution.id === "nx-review-b1");
    assert.equal(workflowV2VisitEnding(cancelled).why, "The parallel step's time limit passed, so this branch was canceled");

    const bar = renderToStaticMarkup(WorkflowJoinBar({ join: { id: "join:fan", parallel: "fan" }, node: parallel, selected: false, onSelect() {} }));
    assert.match(bar, /class="ps-workflow-join is-timed_out" data-join="fan"/);
    assert.match(bar, /<span class="ps-workflow-join-rule">Continues when all items succeed · time limit passed<\/span><span class="ps-workflow-join-limit">time limit 30 s<\/span>/);
    assert.match(bar, /aria-label="fan: Continues when all items succeed · time limit passed · time limit 30 s\. Inspect fan"/);

    const html = details(projection, "fan");
    for (const [label, value] of [["Join", "Every branch must succeed"], ["Time limit", "30 s from the step&#x27;s start"],
        ["Time limit ends", "2026-11-04 20:30:00 UTC"]]) {
        assert.ok(html.includes(`<span>${label}</span><strong>${value}</strong>`), `${label}: ${html}`);
    }
    assert.match(html, /data-timed-out="true"[^>]*>The time limit passed before the join: the running branches were canceled, and the queued ones did not start\.<\/p>/);
    assert.match(html, /<tr data-branch="1" data-status="cancelled at time limit"><td>2<\/td><td>review<\/td><td>cancelled at time limit<\/td>/);
    assert.match(html, /<tr data-branch="2" data-status="not started"><td>3<\/td>/);
});

test("the first 2 of 4 joined: the bar says the rule; the losers are cancelled after the join, one between two of its steps", () => {
    const projection = firstTwo();
    const parallel = byId(projection, "fan");
    assert.equal(parallel.stateLabel, "Joined · the first 2 branches succeeded");
    assert.deepEqual([parallel.joinBar.state, parallel.joinBar.label, parallel.joinBar.limit], ["joined", "Continues when the first 2 of 4 items succeed", null]);
    assert.deepEqual(parallel.evidence.rows.map(row => [row.index, row.status, row.step]), [
        [0, "succeeded", "reviewed"], [1, "cancelled after the join", "review"], [2, "finished before the join", "prepare"], [3, "succeeded", "reviewed"],
    ]);
    // J1b (d): its step finished and its result is kept; its next step never started.
    assert.equal(parallel.evidence.rows[2].why,
        "Its step 'prepare' finished ('ready'), but the join already had the successes it needs, so its next step did not start");
    assert.equal(parallel.evidence.rows[1].why, "The join already had the successes it needs, so this branch was canceled");
    assert.equal(parallel.evidence.joinedAfterLimit, false);
    assert.deepEqual([parallel.evidence.needed, parallel.evidence.succeeded, parallel.evidence.timedOut], [2, 2, false]);
    const html = details(projection, "fan");
    assert.ok(html.includes("<span>Join</span><strong>The first 2 branches to succeed join; the others are canceled</strong>"), html);
    assert.ok(!html.includes("<span>Time limit</span>"), "no time limit without one");
    assert.match(html, /2 of 4 branches succeeded; the join needs 2\./);

    // A blocked first success: no branch could succeed.
    const blocked = projectWorkflowV2({ readModel: readModel({
        graph: { revision: 1, initial: "fan", states: statesOf(fan({ join: { first: 1 } })) },
        nodeExecutions: [row("fan", 1, "completed", { branches: 2, outcome: "blocked", resultKind: "business", winner: "controller" })] }) });
    assert.deepEqual([byId(blocked, "fan").stateLabel, byId(blocked, "fan").joinBar.label], ["Blocked · no branch could succeed", "Continues when the first item succeeds"]);
    assert.ok(byId(blocked, "fan").description.includes("Join blocked: 0 of 2 branches succeeded; it needed 1."), byId(blocked, "fan").description.join("\n"));
    // While the visit runs, a branch between two of its steps is running, not ended.
    const busy = projectWorkflowV2({ readModel: readModel({
        graph: { revision: 1, initial: "fan", states: statesOf(fan({ join: { first: 2 } })) },
        nodeExecutions: [row("fan", 1, "pending", { branches: 2, deadline: DEADLINE }), ...through(0, "prepare")] }) });
    assert.deepEqual(byId(busy, "fan").evidence.rows.map(row => row.status), ["running", "queued"]);
});

/** An ISO time `seconds` after DEADLINE (negative: before it). */
const at = seconds => new Date(Date.parse(DEADLINE) + seconds * 1000).toISOString();
/** Branch `index` finished `steps` (each [stateId, outcome, seconds from the deadline]), as the read model lists them. */
const steps = (index, list) => list.map(([stateId, outcome, seconds]) => done(stateId, 1, outcome,
    { nodeExecutionId: `nx-${stateId}-b${index}`, completedAt: at(seconds), ...branch(index) }));

test("J1b (Q3): a join blocked at its time limit says so: the bar, the step's status, its branches and the details", () => {
    const projection = projectWorkflowV2({ readModel: readModel({
        graph: { revision: 1, initial: "fan", states: statesOf(fan({ join: { first: 2 }, timeoutSeconds: 30, forEach: literal(3), concurrency: 3 })) },
        nodeExecutions: [
            row("fan", 1, "completed", { branches: 3, outcome: "blocked", resultKind: "business", winner: "controller", deadline: DEADLINE, completedAt: at(0.2) }),
            ...steps(0, [["prepare", "rejected", -20]]),
            ...steps(1, [["prepare", "rejected", -10]]),
            ...through(2, "review", { ...CANCELLED, winner: "join_timeout" }),
        ] }) });
    const parallel = byId(projection, "fan");
    assert.equal(parallel.stateLabel, "Blocked · fewer than 2 branches could succeed · the time limit passed");
    assert.deepEqual([parallel.joinBar.state, parallel.joinBar.stateText], ["blocked", "blocked · time limit passed"]);
    assert.match(parallel.joinBar.limit.title, /It passed before the join, at 2026-11-04 20:30:00 UTC\./);
    assert.deepEqual(parallel.evidence.rows.map(row => [row.index, row.status]), [[0, "failed"], [1, "failed"], [2, "cancelled at time limit"]]);
    assert.deepEqual([parallel.evidence.blocked, parallel.evidence.timedOut, parallel.evidence.joinedAfterLimit, parallel.evidence.succeeded], [true, true, false, 0]);
    assert.ok(parallel.description.includes("Join blocked: 0 of 3 branches succeeded; it needed 2; the time limit passed."), parallel.description.join("\n"));
    const html = details(projection, "fan");
    assert.match(html, /data-timed-out="true"[^>]*>The time limit passed before the join/);
    // Without a time limit passed, a blocked join says nothing of one.
    const plain = projectWorkflowV2({ readModel: readModel({
        graph: { revision: 1, initial: "fan", states: statesOf(fan({ join: { first: 2 }, timeoutSeconds: 30, forEach: literal(3), concurrency: 3 })) },
        nodeExecutions: [
            row("fan", 1, "completed", { branches: 3, outcome: "blocked", resultKind: "business", winner: "controller", deadline: DEADLINE, completedAt: at(-5) }),
            ...steps(0, [["prepare", "rejected", -20]]), ...steps(1, [["prepare", "rejected", -10]]), ...steps(2, [["prepare", "rejected", -6]]),
        ] }) });
    assert.equal(byId(plain, "fan").stateLabel, "Blocked · fewer than 2 branches could succeed");
    assert.deepEqual([byId(plain, "fan").joinBar.stateText, byId(plain, "fan").evidence.timedOut], ["blocked", false]);
});

test("J1b (Q1, d): a join after its time limit used the successes saved before it; a branch finished before the time limit keeps its result", () => {
    const projection = projectWorkflowV2({ readModel: readModel({
        graph: { revision: 1, initial: "fan", states: statesOf(fan({ join: { first: 1 }, timeoutSeconds: 30, forEach: literal(3), concurrency: 3 })) },
        nodeExecutions: [
            row("fan", 1, "completed", { branches: 3, outcome: "joined", resultKind: "business", winner: "controller", deadline: DEADLINE, completedAt: at(1),
                outputPreview: "[]" }),
            // Branch 1 succeeded before the time limit; its end was recorded after it.
            ...steps(0, [["prepare", "ready", -20], ["review", "completed", -1], ["reviewed", "succeeded", 0.5]]),
            ...through(1, "review", { ...CANCELLED, winner: "join_timeout" }),
            // Branch 3 finished its first step; the time limit came before its next one.
            ...steps(2, [["prepare", "ready", -2]]).map(item => ({ ...item, outputPreview: "{\"ready\":true}" })),
        ] }) });
    const parallel = byId(projection, "fan");
    assert.equal(parallel.stateLabel, "Joined · the first branch succeeded");
    assert.deepEqual(parallel.evidence.rows.map(row => [row.index, row.status, row.step, row.result]), [
        [0, "succeeded", "reviewed", null], [1, "cancelled at time limit", "review", null], [2, "finished before the time limit", "prepare", "{\"ready\":true}"]]);
    assert.equal(parallel.evidence.rows[2].why, "Its step 'prepare' finished ('ready'), but the time limit passed before its next step started");
    assert.deepEqual([parallel.evidence.joinedAfterLimit, parallel.evidence.timedOut, parallel.evidence.succeeded], [true, false, 1]);
    const html = details(projection, "fan");
    assert.match(html, /data-joined-after-limit="true"[^>]*>The time limit passed after enough branches succeeded: the join still used them, and the running branches were canceled\.<\/p>/);
    assert.match(html, /<tr data-branch="2" data-status="finished before the time limit"><td>3<\/td><td>prepare<\/td><td>finished before the time limit<\/td>/);
});

test("J1b (b): a success saved after the time limit did not count toward a join that did not happen", () => {
    const projection = projectWorkflowV2({ readModel: readModel({
        graph: { revision: 1, initial: "fan", states: statesOf(fan({ timeoutSeconds: 30, forEach: literal(2), concurrency: 2 })) },
        nodeExecutions: [
            row("fan", 1, "completed", { branches: 2, outcome: "timed_out", resultKind: "runtime_error", winner: "controller", deadline: DEADLINE,
                completedAt: at(3), errorPreview: JSON.stringify({ code: "timed_out", message: "The parallel state's time limit passed before its join." }) }),
            ...steps(0, [["prepare", "ready", -20], ["review", "completed", -3], ["reviewed", "succeeded", -2]]),
            ...steps(1, [["prepare", "ready", -20], ["review", "completed", 2], ["reviewed", "succeeded", 2.5]]),
        ] }) });
    const evidence = byId(projection, "fan").evidence;
    assert.deepEqual(evidence.rows.map(row => [row.index, row.status, row.why]), [
        [0, "succeeded", null], [1, "succeeded after the time limit", "It succeeded after the time limit, so it did not count"]]);
    assert.deepEqual([evidence.succeeded, evidence.timedOut], [1, true]);
});

test("J1b (d, f): a branch finished before the time limit whose next step is a succeeded end counts as a success", () => {
    const projection = projectWorkflowV2({ readModel: readModel({
        graph: { revision: 1, initial: "fan", states: statesOf(fan({ timeoutSeconds: 30, forEach: literal(2), concurrency: 2 })) },
        nodeExecutions: [
            row("fan", 1, "completed", { branches: 2, outcome: "timed_out", resultKind: "runtime_error", winner: "controller", deadline: DEADLINE,
                completedAt: at(0.1), errorPreview: JSON.stringify({ code: "timed_out", message: "The parallel state's time limit passed before its join." }) }),
            // Branch 1's review finished before the time limit; its end was never admitted.
            ...steps(0, [["prepare", "ready", -20], ["review", "completed", -3]]),
            ...through(1, "review", { ...CANCELLED, winner: "join_timeout" }),
        ] }) });
    const evidence = byId(projection, "fan").evidence;
    assert.deepEqual(evidence.rows.map(row => [row.index, row.status, row.step]), [[0, "finished before the time limit", "review"],
        [1, "cancelled at time limit", "review"]]);
    assert.equal(evidence.rows[0].why, "Its step 'review' finished ('completed'), but the time limit passed before its next step started; its success counts");
    assert.deepEqual([evidence.succeeded, evidence.timedOut], [1, true]);
});

test("J1-R1: a branch's last step is the end of its chain of steps, whatever order the read lists them in", () => {
    // The read lists branch 1's end first; each step names the one before it.
    const chained = (stateId, outcome, predecessorId) => done(stateId, 1, outcome, { nodeExecutionId: `nx-${stateId}-b0`, predecessorId, ...branch(0) });
    const projection = projectWorkflowV2({ readModel: readModel({
        graph: { revision: 1, initial: "fan", states: statesOf(fan({ join: { first: 1 }, forEach: literal(1), concurrency: 1 })) },
        nodeExecutions: [
            row("fan", 1, "completed", { branches: 1, outcome: "joined", resultKind: "business", winner: "controller", outputPreview: "[]" }),
            chained("reviewed", "succeeded", "nx-review-b0"), chained("prepare", "ready", "nx-fan-1"), chained("review", "completed", "nx-prepare-b0"),
        ] }) });
    assert.deepEqual(byId(projection, "fan").evidence.rows.map(row => [row.index, row.status, row.step]), [[0, "succeeded", "reviewed"]]);
});

test("the graph: timed_out leaves from the join bar as a runtime-error route; a bar with a time limit has a line for it", () => {
    const timed = workflowV2Definition({ revision: 1, initial: "fan", states: statesOf(fan({ timeoutSeconds: 30 })) });
    const layout = layoutWorkflowGraphTB(timed);
    const late = layout.edges.find(edge => edge.from === "join:fan" && edge.to === "late");
    assert.deepEqual([late.kind, late.owner, late.outcome], ["error", "fan", "timed_out"]);
    assert.equal(layout.edges.some(edge => edge.from === "fan" && edge.to === "late"), false);
    assert.equal(layout.joins.get("fan").height, WORKFLOW_GRAPH_JOIN_LIMIT_HEIGHT);
    const plain = layoutWorkflowGraphTB(workflowV2Definition({ revision: 1, initial: "fan",
        states: statesOf(fan()).filter(state => state.id !== "late") }));
    assert.equal(plain.joins.get("fan").height, WORKFLOW_GRAPH_JOIN_HEIGHT);
});

test("the activity list says why branches were cancelled", () => {
    assert.equal(workflowEventText("workflow.branches_cancelled", { reason: "timeout" }).text,
        "The running items were canceled: the For each node's time limit passed");
    assert.equal(workflowEventText("workflow.branches_cancelled", { reason: "join" }).text,
        "The other items were canceled: the For each node had the successes it needs");
    assert.equal(workflowEventText("workflow.branches_cancelled", {}).text, "The other items were canceled");
});

test("the TUI's join line says the rule, its state and the time limit; its details say the rule in words", () => {
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: watch-v2", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    const model = readModel({ graph: { revision: 1, initial: "fan", states: statesOf(fan({ timeoutSeconds: 30, concurrency: 1 })) },
        nodeExecutions: [row("fan", 1, "pending", { branches: 2, deadline: DEADLINE }), ...through(0, "prepare")] });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: model, readModelRunId: null } });
    store.dispatch({ type: "ui/modal", modal: { type: "workflowView", sessionId: "wf", selectedNodeId: "fan", detailsScroll: 0 } });
    const view = selectWorkflowViewModal(store.getState(), 160, 80);
    const rows = view.rows.map(cells => cells.map(cell => cell.text).join("").trim());
    assert.ok(rows.includes("⋯ Continues when all items succeed · waiting for its items · time limit until 2026-11-04 20:30:00 UTC"), rows.join("\n"));
    const lines = view.detailsLines.map(line => line.text.trim());
    assert.ok(lines.includes("Continues when all items succeed · waiting for its items"), lines.join("\n"));
    assert.ok(lines.includes("Every branch must succeed"), lines.join("\n"));
    assert.ok(lines.some(line => line.startsWith("The time limit is 30 s from the step's start: it passes at")), lines.join("\n"));
});
