// Owner decision join-k-of-n: a parallel step's join of the first k and its own time limit, as the portal and the
// TUI show them. The join bar says the rule ("all required", "first success", "first 2 of 4", "first 2") and the real
// time limit (its length; when the shown visit's ends; that it passed); timed_out leaves from the bar; the Branches
// table says how each branch ended (succeeded, failed, canceled · limit, canceled after the join, cancelled,
// not started), a branch cut between two of its steps included; the details say the rule and the time limit in words.
// J1b: a branch whose step finished but whose next step never started reads "ok · limit passed" (or
// before the join, its block or the run's end), keeps its result, and counts as a success when its next step is a
// succeeded end saved by the time limit; a join blocked at its time limit says so; a join after the time limit says the
// successes saved before it still joined; a success saved after the time limit did not count. A branch's last step is
// the end of its chain of steps (review J1-R1), not the order a read lists them in.
//
// Run: node --test packages/app/ui/core/test/workflow-join-limit.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { appReducer, buildHistoryModel, createInitialState, createStore, selectWorkflowViewModal } from "../src/index.js";
import {
    projectWorkflow, workflowEventText, workflowDefinition, workflowJoinFirst, workflowJoinLimit, workflowJoinRule, workflowJoinWords,
    workflowVisitEnding,
} from "../src/workflow-view.js";
import {
    layoutWorkflowGraphTB, WORKFLOW_GRAPH_JOIN_HEIGHT, WORKFLOW_GRAPH_JOIN_LIMIT_HEIGHT,
} from "../src/workflow-graph-layout.js";
import { WorkflowNodeContent } from "../../react/src/workflow-panels.js";
import { WorkflowJoinBar } from "../../react/src/workflow-graph.js";
import { readModel, row, done } from "./workflow-fixtures.mjs";

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
const details = (projection, id) => renderToStaticMarkup(React.createElement(WorkflowNodeContent, {
    tab: "details", selected: byId(projection, id), nodes: projection.nodes, select: () => {}, runOutput: null, runError: null }));
const DEADLINE = "2026-11-04T20:30:00.000Z";
const CANCELLED = { outcome: "cancelled", resultKind: "runtime_error", errorPreview: JSON.stringify({ code: "cancelled", message: "cancelled" }) };

/** A visit timed out at its 30-second limit: branch 1 succeeded, branch 2 was cancelled at its review, branch 3 never started. */
const timedOut = () => projectWorkflow({ readModel: readModel({ graph: { revision: 1, initial: "fan", states: statesOf(fan({ timeoutSeconds: 30, concurrency: 1 })) },
    nodeExecutions: [
        row("fan", 1, "completed", { branches: 3, outcome: "timed_out", resultKind: "runtime_error", winner: "controller", deadline: DEADLINE,
            errorPreview: JSON.stringify({ code: "timed_out", message: "The parallel state's time limit passed before its join." }) }),
        ...through(0, "reviewed"),
        ...through(1, "review", { ...CANCELLED, winner: "join_timeout" }),
    ] }) });

/** The first 2 of 4 joined: branches 1 and 4 succeeded; branch 2 was cancelled at its review, branch 3 between its two first steps. */
const firstTwo = () => projectWorkflow({ readModel: readModel({
    graph: { revision: 1, initial: "fan", states: statesOf(fan({ join: { first: 2 }, forEach: literal(4), concurrency: 4 })) },
    nodeExecutions: [
        row("fan", 1, "completed", { branches: 4, outcome: "joined", resultKind: "business", winner: "controller", outputPreview: "[]" }),
        ...through(0, "reviewed"),
        ...through(1, "review", { ...CANCELLED, winner: "join" }),
        ...through(2, "prepare"),
        ...through(3, "reviewed"),
    ] }) });

test("the join's rule and its words: all required, first success, first k of n when n is known, first k otherwise; failFast", () => {
    assert.equal(workflowJoinFirst(fan()), null);
    assert.equal(workflowJoinFirst(fan({ join: { first: 3 } })), 3);
    assert.equal(workflowJoinFirst(fan({ join: { first: 0 } })), null);
    assert.equal(workflowJoinRule(fan()), "all required");
    assert.equal(workflowJoinRule(fan({ join: { first: 1 } })), "first success");
    assert.equal(workflowJoinRule(fan({ join: { first: 2 }, forEach: literal(5) })), "first 2 of 5");
    assert.equal(workflowJoinRule(fan({ join: { first: 2 } })), "first 2");
    assert.equal(workflowJoinRule(fan({ join: { first: 2 } }), { branches: 4 }), "first 2 of 4", "the shown visit says how many");
    assert.equal(workflowJoinWords(fan()), "All must succeed");
    assert.equal(workflowJoinWords(fan({ failFast: true })), "All must succeed · the first failure cancels the rest");
    assert.equal(workflowJoinWords(fan({ join: { first: 1 } })), "First to succeed · the rest are canceled");
    assert.equal(workflowJoinWords(fan({ join: { first: 2 }, failFast: true })),
        "First 2 to succeed · the rest are canceled · also once the join cannot succeed");
});

test("the time limit as people read it: none, its length, from the input, until when while it waits, and that it passed", () => {
    assert.equal(workflowJoinLimit(fan()), null);
    assert.deepEqual(workflowJoinLimit(fan({ timeoutSeconds: 30 })), { text: "limit 30 s", title: "Time limit 30 s from the node's start." });
    assert.deepEqual(workflowJoinLimit(fan({ timeoutSeconds: "${input.limit}" })),
        { text: "limit from input", title: "Time limit from ${input.limit}, set when the node starts." });
    assert.deepEqual(workflowJoinLimit(fan({ timeoutSeconds: 120 }), { deadline: DEADLINE }, { running: true }),
        { text: "limit 2026-11-04 20:30:00", title: "Time limit 2 min from the node's start; it passes at 2026-11-04 20:30:00 UTC." });
    assert.deepEqual(workflowJoinLimit(fan({ timeoutSeconds: 30 }), { deadline: DEADLINE }, { timedOut: true }),
        { text: "limit 30 s", title: "Time limit 30 s from the node's start. It passed before the join, at 2026-11-04 20:30:00 UTC." });
});

test("a visit that timed out: the bar says so with its time limit; the branches say succeeded, canceled · limit and not started", () => {
    const projection = timedOut();
    const parallel = byId(projection, "fan");
    assert.deepEqual([parallel.state, parallel.stateLabel], ["failed", "Failed · limit, before the join"]);
    assert.deepEqual(parallel.joinBar, {
        id: "join:fan", state: "timed_out", rule: "all required", label: "Joins when all succeed", stateText: "✕ limit",
        limit: { text: "limit 30 s", title: "Time limit 30 s from the node's start. It passed before the join, at 2026-11-04 20:30:00 UTC." },
        // Workflow Simplified (W5, W6): the For each box says how many of its items succeeded once the visit ended.
        group: { label: "For each item", counts: null, text: "1/3 ok" },
    });
    assert.deepEqual(parallel.evidence.rows.map(row => [row.index, row.status, row.why]), [
        [0, "ok", null],
        [1, "canceled · limit", "The For each node's limit passed, so this item was canceled"],
        [2, "not started", null],
    ]);
    assert.deepEqual([parallel.evidence.timedOut, parallel.evidence.blocked, parallel.evidence.needed, parallel.evidence.succeeded], [true, false, 3, 1]);
    // The cancelled branch state's own ending says why.
    const cancelled = byId(projection, "review").executions.find(execution => execution.id === "nx-review-b1");
    assert.equal(workflowVisitEnding(cancelled).why, "The For each node's limit passed, so this item was canceled");

    const bar = renderToStaticMarkup(WorkflowJoinBar({ join: { id: "join:fan", parallel: "fan" }, node: parallel, selected: false, onSelect() {} }));
    assert.match(bar, /class="ps-workflow-join is-timed_out" data-join="fan"/);
    assert.match(bar, /<span class="ps-workflow-join-rule">Joins when all succeed · ✕ limit<\/span><span class="ps-workflow-join-limit">limit 30 s<\/span>/);
    assert.match(bar, /aria-label="fan: Joins when all succeed · ✕ limit · limit 30 s\. Inspect fan"/);

    const html = details(projection, "fan");
    // Review 21:15Z: a time limit reads "Limit" (its tooltip "Time limit"); when it ends, "Limit ends".
    for (const [label, value] of [["Join", "All must succeed"]]) {
        assert.ok(html.includes(`<span>${label}</span><strong>${value}</strong>`), `${label}: ${html}`);
    }
    assert.ok(html.includes('<span title="Time limit">Limit</span><strong>30 s</strong>'), html);
    assert.ok(html.includes('<span title="When the time limit ends">Limit ends</span><strong>2026-11-04 20:30:00</strong>'), html);
    assert.ok(!html.includes("<span>Time limit</span>"), "the label is Limit");
    assert.match(html, /data-timed-out="true"[^>]*>The limit passed before the join: running items canceled; waiting items not started\.<\/p>/);
    assert.match(html, /<tr data-branch="1" data-status="canceled · limit"><td>2<\/td><td>review<\/td><td>canceled · limit<\/td>/);
    assert.match(html, /<tr data-branch="2" data-status="not started"><td>3<\/td>/);
});

test("the first 2 of 4 joined: the bar says the rule; the losers are canceled after the join, one between two of its steps", () => {
    const projection = firstTwo();
    const parallel = byId(projection, "fan");
    assert.equal(parallel.stateLabel, "Done · joined, first 2 ok");
    assert.deepEqual([parallel.joinBar.state, parallel.joinBar.label, parallel.joinBar.limit], ["joined", "Joins at the first 2 of 4", null]);
    assert.deepEqual(parallel.evidence.rows.map(row => [row.index, row.status, row.step]), [
        [0, "ok", "reviewed"], [1, "canceled · join met", "review"], [2, "ok · join met", "prepare"], [3, "ok", "reviewed"],
    ]);
    // J1b (d): its step finished and its result is kept; its next step never started.
    assert.equal(parallel.evidence.rows[2].why,
        "Node prepare finished · ready, but the join already had the successes it needs, so its next node did not start");
    assert.equal(parallel.evidence.rows[1].why, "The join already had the successes it needs, so this item was canceled");
    assert.equal(parallel.evidence.joinedAfterLimit, false);
    assert.deepEqual([parallel.evidence.needed, parallel.evidence.succeeded, parallel.evidence.timedOut], [2, 2, false]);
    const html = details(projection, "fan");
    assert.ok(html.includes("<span>Join</span><strong>First 2 to succeed · the rest are canceled</strong>"), html);
    assert.ok(!html.includes('title="Time limit"'), "no time limit without one");
    assert.match(html, /2\/4 ok · needs 2/);

    // A blocked first success: no branch could succeed.
    const blocked = projectWorkflow({ readModel: readModel({
        graph: { revision: 1, initial: "fan", states: statesOf(fan({ join: { first: 1 } })) },
        nodeExecutions: [row("fan", 1, "completed", { branches: 2, outcome: "blocked", resultKind: "business", winner: "controller" })] }) });
    assert.deepEqual([byId(blocked, "fan").stateLabel, byId(blocked, "fan").joinBar.label], ["Done · blocked, none ok", "Joins at the first success"]);
    assert.ok(byId(blocked, "fan").description.includes("Join blocked: 0/2 ok · needs 1"), byId(blocked, "fan").description.join("\n"));
    // While the visit runs, a branch between two of its steps is running, not ended.
    const busy = projectWorkflow({ readModel: readModel({
        graph: { revision: 1, initial: "fan", states: statesOf(fan({ join: { first: 2 } })) },
        nodeExecutions: [row("fan", 1, "pending", { branches: 2, deadline: DEADLINE }), ...through(0, "prepare")] }) });
    assert.deepEqual(byId(busy, "fan").evidence.rows.map(row => row.status), ["running", "waiting"]);
});

/** An ISO time `seconds` after DEADLINE (negative: before it). */
const at = seconds => new Date(Date.parse(DEADLINE) + seconds * 1000).toISOString();
/** Branch `index` finished `steps` (each [stateId, outcome, seconds from the deadline]), as the read model lists them. */
const steps = (index, list) => list.map(([stateId, outcome, seconds]) => done(stateId, 1, outcome,
    { nodeExecutionId: `nx-${stateId}-b${index}`, completedAt: at(seconds), ...branch(index) }));

test("J1b (Q3): a join blocked at its time limit says so: the bar, the step's status, its branches and the details", () => {
    const projection = projectWorkflow({ readModel: readModel({
        graph: { revision: 1, initial: "fan", states: statesOf(fan({ join: { first: 2 }, timeoutSeconds: 30, forEach: literal(3), concurrency: 3 })) },
        nodeExecutions: [
            row("fan", 1, "completed", { branches: 3, outcome: "blocked", resultKind: "business", winner: "controller", deadline: DEADLINE, completedAt: at(0.2) }),
            ...steps(0, [["prepare", "rejected", -20]]),
            ...steps(1, [["prepare", "rejected", -10]]),
            ...through(2, "review", { ...CANCELLED, winner: "join_timeout" }),
        ] }) });
    const parallel = byId(projection, "fan");
    assert.equal(parallel.stateLabel, "Done · blocked, fewer than 2 ok, limit");
    assert.deepEqual([parallel.joinBar.state, parallel.joinBar.stateText], ["blocked", "blocked · limit"]);
    assert.match(parallel.joinBar.limit.title, /It passed before the join, at 2026-11-04 20:30:00 UTC\./);
    assert.deepEqual(parallel.evidence.rows.map(row => [row.index, row.status]), [[0, "failed"], [1, "failed"], [2, "canceled · limit"]]);
    assert.deepEqual([parallel.evidence.blocked, parallel.evidence.timedOut, parallel.evidence.joinedAfterLimit, parallel.evidence.succeeded], [true, true, false, 0]);
    assert.ok(parallel.description.includes("Join blocked: 0/3 ok · needs 2 · limit passed"), parallel.description.join("\n"));
    const html = details(projection, "fan");
    assert.match(html, /data-timed-out="true"[^>]*>The limit passed before the join/);
    // Without a time limit passed, a blocked join says nothing of one.
    const plain = projectWorkflow({ readModel: readModel({
        graph: { revision: 1, initial: "fan", states: statesOf(fan({ join: { first: 2 }, timeoutSeconds: 30, forEach: literal(3), concurrency: 3 })) },
        nodeExecutions: [
            row("fan", 1, "completed", { branches: 3, outcome: "blocked", resultKind: "business", winner: "controller", deadline: DEADLINE, completedAt: at(-5) }),
            ...steps(0, [["prepare", "rejected", -20]]), ...steps(1, [["prepare", "rejected", -10]]), ...steps(2, [["prepare", "rejected", -6]]),
        ] }) });
    assert.equal(byId(plain, "fan").stateLabel, "Done · blocked, fewer than 2 ok");
    assert.deepEqual([byId(plain, "fan").joinBar.stateText, byId(plain, "fan").evidence.timedOut], ["blocked", false]);
});

test("J1b (Q1, d): a join after its time limit used the successes saved before it; a branch ok · limit passed keeps its result", () => {
    const projection = projectWorkflow({ readModel: readModel({
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
    assert.equal(parallel.stateLabel, "Done · joined, first 1 ok");
    assert.deepEqual(parallel.evidence.rows.map(row => [row.index, row.status, row.step, row.result]), [
        [0, "ok", "reviewed", null], [1, "canceled · limit", "review", null], [2, "ok · limit passed", "prepare", "{\"ready\":true}"]]);
    assert.equal(parallel.evidence.rows[2].why, "Node prepare finished · ready, but the limit passed before its next node started");
    assert.deepEqual([parallel.evidence.joinedAfterLimit, parallel.evidence.timedOut, parallel.evidence.succeeded], [true, false, 1]);
    const html = details(projection, "fan");
    assert.match(html, /data-joined-after-limit="true"[^>]*>The limit passed after enough items succeeded: the join used them; running items canceled\.<\/p>/);
    assert.match(html, /<tr data-branch="2" data-status="ok · limit passed"><td>3<\/td><td>prepare<\/td><td>ok · limit passed<\/td>/);
});

test("J1b (b): a success saved after the time limit did not count toward a join that did not happen", () => {
    const projection = projectWorkflow({ readModel: readModel({
        graph: { revision: 1, initial: "fan", states: statesOf(fan({ timeoutSeconds: 30, forEach: literal(2), concurrency: 2 })) },
        nodeExecutions: [
            row("fan", 1, "completed", { branches: 2, outcome: "timed_out", resultKind: "runtime_error", winner: "controller", deadline: DEADLINE,
                completedAt: at(3), errorPreview: JSON.stringify({ code: "timed_out", message: "The parallel state's time limit passed before its join." }) }),
            ...steps(0, [["prepare", "ready", -20], ["review", "completed", -3], ["reviewed", "succeeded", -2]]),
            ...steps(1, [["prepare", "ready", -20], ["review", "completed", 2], ["reviewed", "succeeded", 2.5]]),
        ] }) });
    const evidence = byId(projection, "fan").evidence;
    assert.deepEqual(evidence.rows.map(row => [row.index, row.status, row.why]), [
        [0, "ok", null], [1, "ok · after the limit", "It succeeded after the limit, so it did not count"]]);
    assert.deepEqual([evidence.succeeded, evidence.timedOut], [1, true]);
});

test("J1b (d, f): a branch done before the limit whose next step is a succeeded end counts as a success", () => {
    const projection = projectWorkflow({ readModel: readModel({
        graph: { revision: 1, initial: "fan", states: statesOf(fan({ timeoutSeconds: 30, forEach: literal(2), concurrency: 2 })) },
        nodeExecutions: [
            row("fan", 1, "completed", { branches: 2, outcome: "timed_out", resultKind: "runtime_error", winner: "controller", deadline: DEADLINE,
                completedAt: at(0.1), errorPreview: JSON.stringify({ code: "timed_out", message: "The parallel state's time limit passed before its join." }) }),
            // Branch 1's review ok · limit passed; its end was never admitted.
            ...steps(0, [["prepare", "ready", -20], ["review", "completed", -3]]),
            ...through(1, "review", { ...CANCELLED, winner: "join_timeout" }),
        ] }) });
    const evidence = byId(projection, "fan").evidence;
    assert.deepEqual(evidence.rows.map(row => [row.index, row.status, row.step]), [[0, "ok · limit passed", "review"],
        [1, "canceled · limit", "review"]]);
    assert.equal(evidence.rows[0].why, "Node review finished · completed, but the limit passed before its next node started; its success counts");
    assert.deepEqual([evidence.succeeded, evidence.timedOut], [1, true]);
});

test("J1-R1: a branch's last step is the end of its chain of steps, whatever order the read lists them in", () => {
    // The read lists branch 1's end first; each step names the one before it.
    const chained = (stateId, outcome, predecessorId) => done(stateId, 1, outcome, { nodeExecutionId: `nx-${stateId}-b0`, predecessorId, ...branch(0) });
    const projection = projectWorkflow({ readModel: readModel({
        graph: { revision: 1, initial: "fan", states: statesOf(fan({ join: { first: 1 }, forEach: literal(1), concurrency: 1 })) },
        nodeExecutions: [
            row("fan", 1, "completed", { branches: 1, outcome: "joined", resultKind: "business", winner: "controller", outputPreview: "[]" }),
            chained("reviewed", "succeeded", "nx-review-b0"), chained("prepare", "ready", "nx-fan-1"), chained("review", "completed", "nx-prepare-b0"),
        ] }) });
    assert.deepEqual(byId(projection, "fan").evidence.rows.map(row => [row.index, row.status, row.step]), [[0, "ok", "reviewed"]]);
});

test("the graph: timed_out leaves from the join bar as a runtime-error route; a bar with a time limit has a line for it", () => {
    const timed = workflowDefinition({ revision: 1, initial: "fan", states: statesOf(fan({ timeoutSeconds: 30 })) });
    const layout = layoutWorkflowGraphTB(timed);
    const late = layout.edges.find(edge => edge.from === "join:fan" && edge.to === "late");
    assert.deepEqual([late.kind, late.owner, late.outcome], ["error", "fan", "timed_out"]);
    assert.equal(layout.edges.some(edge => edge.from === "fan" && edge.to === "late"), false);
    assert.equal(layout.joins.get("fan").height, WORKFLOW_GRAPH_JOIN_LIMIT_HEIGHT);
    const plain = layoutWorkflowGraphTB(workflowDefinition({ revision: 1, initial: "fan",
        states: statesOf(fan()).filter(state => state.id !== "late") }));
    assert.equal(plain.joins.get("fan").height, WORKFLOW_GRAPH_JOIN_HEIGHT);
});

test("the activity list says why branches were cancelled", () => {
    assert.equal(workflowEventText("workflow.branches_cancelled", { reason: "timeout" }).text,
        "⊘ Running items canceled · For each limit passed");
    assert.equal(workflowEventText("workflow.branches_cancelled", { reason: "join" }).text,
        "⊘ Other items canceled · the join had enough");
    assert.equal(workflowEventText("workflow.branches_cancelled", {}).text, "⊘ Other items canceled");
});

test("the TUI's join line says the rule, its state and the time limit; its details say the rule in words", () => {
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: watch-flow", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    const model = readModel({ graph: { revision: 1, initial: "fan", states: statesOf(fan({ timeoutSeconds: 30, concurrency: 1 })) },
        nodeExecutions: [row("fan", 1, "pending", { branches: 2, deadline: DEADLINE }), ...through(0, "prepare")] });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: model, readModelRunId: null } });
    store.dispatch({ type: "ui/modal", modal: { type: "workflowView", sessionId: "wf", selectedNodeId: "fan", detailsScroll: 0 } });
    const view = selectWorkflowViewModal(store.getState(), 160, 80);
    const rows = view.rows.map(cells => cells.map(cell => cell.text).join("").trim());
    assert.ok(rows.includes("⋯ Joins when all succeed · waiting · limit 2026-11-04 20:30:00"), rows.join("\n"));
    const lines = view.detailsLines.map(line => line.text.trim());
    assert.ok(lines.includes("Joins when all succeed · waiting"), lines.join("\n"));
    assert.ok(lines.includes("All must succeed"), lines.join("\n"));
    assert.ok(lines.some(line => line.startsWith("Time limit 30 s from the node's start; it passes at")), lines.join("\n"));
});
