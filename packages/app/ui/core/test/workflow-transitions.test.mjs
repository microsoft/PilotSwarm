/**
 * Owner 2026-11-09T03:37Z (the timeline as a viewing mode): "as a workflow is executing, the last four transitions need to be
 * visually lit up. if the transitions are already lit up then they need to be double lit". One model for both renderers:
 * workflowTransitions (how each visit was entered: the root's chain, each branch's own, a branch's first visit from its
 * parallel visit, a catch-all's arrival and the run's first visit as the step only, a boxed parallel's routes from its
 * join bar) and workflowLitTransitions (the last four up to the visit shown, counted across branches, with each part's
 * count and age); and how both renderers draw them (data-lit, data-lit-age, data-current).
 *
 * Run: node --test ui/core/test/workflow-transitions.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    workflowDefinition, workflowExecutionOfRow, workflowReplayFrames,
} from "../src/workflow-view.js";
import {
    layoutWorkflowGraphTB, workflowGraphEdgeKey, workflowGraphEdgeKeys, workflowGraphErrorEdgeKey, workflowGroupId, workflowJoinId,
} from "../src/workflow-graph-layout.js";
import {
    WORKFLOW_LIT_TRANSITIONS, workflowEdgeShown, workflowEndReached, workflowErrorTransitions, workflowJoinShown, workflowLanePill, workflowLitLevel,
    workflowLitTransitions, workflowStepMarks, workflowTransitions,
} from "../src/workflow-transitions.js";
import { WorkflowGraph, WorkflowStepCard } from "../../react/src/workflow-graph.js";

const at = seconds => new Date(Date.UTC(2026, 10, 9, 3, 0, seconds)).toISOString();
const visit = (id, stateId, seconds, extra = {}) => ({ id, stateId, enteredAt: at(seconds), ordinal: extra.ordinal ?? 1, ...extra });
const key = workflowGraphEdgeKey;

// A watch loop: check, then wait and check again until it changed, then done.
const LOOP = workflowDefinition({ revision: 1, initial: "check", states: [
    { id: "check", type: "script", outcomes: ["unchanged", "changed"], next: { unchanged: "wait", changed: "done" } },
    { id: "wait", type: "wait", seconds: 30, outcomes: ["elapsed"], next: { elapsed: "check" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
] });
const loopVisits = names => names.map((stateId, index) => visit(`nx-${index}`, stateId, index * 10, { ordinal: index + 1 }));

const entries = list => list.map(({ nodeExecutionId, fromStateId, toStateId, edgeKey }) => ({ nodeExecutionId, fromStateId, toStateId, edgeKey }));

test("the root's chain: each visit came from the visit before it; the run's first visit is its step only", () => {
    const transitions = workflowTransitions(loopVisits(["check", "wait", "check", "done"]), LOOP);
    assert.deepEqual(entries(transitions), [
        { nodeExecutionId: "nx-0", fromStateId: null, toStateId: "check", edgeKey: null },
        { nodeExecutionId: "nx-1", fromStateId: "check", toStateId: "wait", edgeKey: key("check", "wait") },
        { nodeExecutionId: "nx-2", fromStateId: "wait", toStateId: "check", edgeKey: key("wait", "check") },
        { nodeExecutionId: "nx-3", fromStateId: "check", toStateId: "done", edgeKey: key("check", "done") },
    ]);
    // In the timeline's order (entry time), whatever order they were listed in.
    assert.deepEqual(workflowTransitions(loopVisits(["check", "wait", "check", "done"]).reverse(), LOOP).map(item => item.nodeExecutionId),
        ["nx-0", "nx-1", "nx-2", "nx-3"]);
});

test("the last four transitions are lit, newest age 0; a part taken twice among them is double lit", () => {
    const transitions = workflowTransitions(loopVisits(["check", "wait", "check", "wait", "check", "wait", "check"]), LOOP);
    assert.equal(WORKFLOW_LIT_TRANSITIONS, 4);
    const lit = workflowLitTransitions(transitions);
    // Visits 4 to 7 (wait, check, wait, check): check→wait and wait→check twice each.
    assert.deepEqual([...lit.edges].sort(), [[key("check", "wait"), { count: 2, age: 1 }], [key("wait", "check"), { count: 2, age: 0 }]].sort());
    assert.deepEqual(Object.fromEntries(lit.nodes), { check: { count: 2, age: 0 }, wait: { count: 2, age: 1 } });
    assert.equal(lit.current, "check");
    assert.deepEqual([workflowLitLevel(lit.edges.get(key("check", "wait"))), workflowLitLevel({ count: 1, age: 0 }), workflowLitLevel({ count: 5, age: 2 }),
        workflowLitLevel(null)], ["2", "1", "2", null]);
    // Up to the visit shown (history): the four ending there; the newest visit is not counted.
    const shown = workflowLitTransitions(transitions, 2);
    assert.deepEqual(Object.fromEntries(shown.edges), { [key("check", "wait")]: { count: 1, age: 1 }, [key("wait", "check")]: { count: 1, age: 0 } });
    assert.deepEqual(Object.fromEntries(shown.nodes), { check: { count: 2, age: 0 }, wait: { count: 1, age: 1 } });
    assert.equal(shown.current, "check");
    // The window's edge: at the first visit, its step only; past the newest, the newest; none, nothing.
    assert.deepEqual([workflowLitTransitions(transitions, 0).edges.size, Object.fromEntries(workflowLitTransitions(transitions, 0).nodes)],
        [0, { check: { count: 1, age: 0 } }]);
    assert.equal(workflowLitTransitions(transitions, 99).current, "check");
    assert.deepEqual(workflowLitTransitions([], null), { edges: new Map(), nodes: new Map(), current: null });
    assert.deepEqual(workflowLitTransitions(null), { edges: new Map(), nodes: new Map(), current: null });
});

test("a catch-all's arrival comes from the step whose error it took, and lights no line; a predecessor named by the read model is taken over the chain", () => {
    const transitions = workflowTransitions([
        visit("nx-0", "check", 0), visit("nx-1", "wait", 10), visit("nx-2", "done", 20, { catchAll: true }),
    ], LOOP);
    assert.deepEqual(transitions[2], { nodeExecutionId: "nx-2", fromStateId: "wait", toStateId: "done", edgeKey: null, route: "@catchAll",
        words: "✕ error", error: true });
    const lit = workflowLitTransitions(transitions);
    assert.ok(lit.nodes.has("done") && !lit.edges.has(key("wait", "done")) && !lit.edges.has(key("check", "done")));
    // A visit whose predecessor the read model names comes from it, not from the visit before it.
    const named = workflowTransitions([visit("nx-0", "check", 0), visit("nx-1", "wait", 10), visit("nx-2", "done", 20, { predecessorId: "nx-0" })], LOOP);
    assert.deepEqual(entries(named)[2], { nodeExecutionId: "nx-2", fromStateId: "check", toStateId: "done", edgeKey: key("check", "done") });
    // A predecessor not loaded: the chain decides.
    const missing = workflowTransitions([visit("nx-1", "wait", 10), visit("nx-2", "check", 20, { predecessorId: "nx-gone" })], LOOP);
    assert.equal(missing[1].fromStateId, "wait");
});

// A For each in a box: fan's items run fetch then save; its routes leave from its join bar.
const FAN = workflowDefinition({ revision: 1, initial: "fan", states: [
    { id: "fan", type: "parallel", concurrency: 2, join: "all_required", body: { initial: "fetch", states: ["fetch", "save"] },
        outcomes: ["joined", "blocked"], next: { joined: "report", blocked: "report" } },
    { id: "fetch", type: "script", outcomes: ["ok"], next: { ok: "save" }, parallel: "fan" },
    { id: "save", type: "terminal", outcome: "succeeded", parallel: "fan" },
    { id: "report", type: "terminal", outcome: "succeeded" },
] });
const item = index => ({ scopeId: `nx-fan#${index}`, branch: { parallelNodeExecutionId: "nx-fan", index } });

test("branches: each its own chain; a branch's success end is its line into the join bar; the routes after a box leave its join bar", () => {
    const keys = workflowGraphEdgeKeys(FAN);
    // B1: no line from the parallel step into its box; B2: the branch's success end is its line into the join bar.
    assert.deepEqual([...keys].sort(), [key("fetch", workflowJoinId("fan")), key(workflowJoinId("fan"), "report")].sort());
    assert.equal(keys.has(key("fan", workflowGroupId("fan"))), false);
    const transitions = workflowTransitions([
        visit("nx-fan", "fan", 0),
        visit("nx-a0", "fetch", 1, item(0)), visit("nx-a1", "fetch", 2, item(1)),
        visit("nx-b0", "save", 3, { ...item(0), ordinal: 2 }), visit("nx-b1", "save", 4, { ...item(1), ordinal: 2 }),
        visit("nx-report", "report", 5),
    ], FAN);
    assert.deepEqual(transitions.map(item => [item.nodeExecutionId, item.fromStateId, item.edgeKey]), [
        ["nx-fan", null, null],
        ["nx-a0", "fan", null],
        ["nx-a1", "fan", null],
        ["nx-b0", "fetch", key("fetch", workflowJoinId("fan"))],
        ["nx-b1", "fetch", key("fetch", workflowJoinId("fan"))],
        ["nx-report", "fan", key(workflowJoinId("fan"), "report")],
    ]);
    // Counted across every branch in the timeline's order: the last four are both saves, the second fetch and the report.
    const lit = workflowLitTransitions(transitions);
    assert.deepEqual(Object.fromEntries(lit.edges), {
        [key(workflowJoinId("fan"), "report")]: { count: 1, age: 0 }, [key("fetch", workflowJoinId("fan"))]: { count: 2, age: 1 },
    });
});

test("named branches: a lane's first visit lights its lane's pill (no line fans out to the lanes)", () => {
    const NAMED = workflowDefinition({ revision: 1, initial: "views", states: [
        { id: "views", type: "parallel", concurrency: 2, join: "all_required",
            branches: [{ name: "quick", initial: "quick_work", states: ["quick_work"] }, { name: "careful", initial: "careful_work", states: ["careful_work"] }],
            body: { initial: "quick_work", states: ["quick_work", "careful_work"] }, outcomes: ["joined"], next: { joined: "done" } },
        { id: "quick_work", type: "terminal", outcome: "succeeded", parallel: "views", branchName: "quick" },
        { id: "careful_work", type: "terminal", outcome: "succeeded", parallel: "views", branchName: "careful" },
        { id: "done", type: "terminal", outcome: "succeeded" },
    ] });
    const transitions = workflowTransitions([visit("nx-views", "views", 0),
        visit("nx-q", "quick_work", 1, { scopeId: "nx-views#0", branch: { parallelNodeExecutionId: "nx-views", index: 0, name: "quick" } }),
        visit("nx-c", "careful_work", 2, { scopeId: "nx-views#1", branch: { parallelNodeExecutionId: "nx-views", index: 1, name: "careful" } })], NAMED);
    assert.deepEqual(transitions.slice(1).map(item => item.edgeKey), ["lane:views:quick", "lane:views:careful"]);
    // As read_workflow gives them: a branch's first visit names its parallel visit as its predecessor; the parallel visit
    // has ended (joined), and its route is not the way into the lane.
    const read = workflowTransitions([visit("nx-views", "views", 0, { status: "completed", outcome: "joined", resultKind: "business" }),
        visit("nx-q", "quick_work", 1, { scopeId: "nx-views#0", branch: { parallelNodeExecutionId: "nx-views", index: 0 }, predecessorId: "nx-views" }),
        visit("nx-c", "careful_work", 2, { scopeId: "nx-views#1", branch: { parallelNodeExecutionId: "nx-views", index: 1 }, predecessorId: "nx-views" })], NAMED);
    assert.deepEqual(read.slice(1).map(item => [item.fromStateId, item.edgeKey, item.route]),
        [["views", "lane:views:quick", null], ["views", "lane:views:careful", null]]);
});

test("a catch-all arrival known only from its read row (catchAll) takes the catch-all handler, not a chip into the same end", () => {
    const SCRIPTED = workflowDefinition({ revision: 1, initial: "work", catchAll: "failed", states: [
        { id: "work", type: "script", outcomes: ["ok", "failed"], next: { ok: "done", failed: "failed" } },
        { id: "done", type: "terminal", outcome: "succeeded" },
        { id: "failed", type: "terminal", outcome: "failed" },
    ] });
    const row = workflowExecutionOfRow({ nodeExecutionId: "nx-1", stateId: "failed", ordinal: 1, state: "completed", outcome: "failed",
        resultKind: "business", enteredAt: at(10), catchAll: true });
    assert.equal(row.catchAll, true);
    const [, caught] = workflowTransitions([visit("nx-0", "work", 0, { status: "completed", outcome: "execution_failed", resultKind: "runtime_error" }), row], SCRIPTED);
    assert.deepEqual([caught.fromStateId, caught.edgeKey, caught.route, caught.error], ["work", "handler:work:failed", "@catchAll", true]);
});

test("a lane's pill: its end, running, failed with no route on (the branch ended there), or nothing yet; a join bar lights when the run leaves it", () => {
    const pill = { name: "c", initial: "start_c" };
    const views = states => new Map(Object.entries(states).map(([id, state]) => [id, { id, type: id.startsWith("c_") ? "terminal" : "script", state,
        outcome: id === "c_not_started" ? "blocked" : undefined }]));
    const members = ["start_c", "wait_c", "c_not_started"];
    const of = states => workflowLanePill("fan", pill, members, views(states));
    assert.deepEqual([of({ start_c: "failed", c_not_started: "done" }).text, of({ start_c: "failed", c_not_started: "done" }).tone], ["c · not started", "amber"]);
    assert.deepEqual([of({ start_c: "running" }).text, of({ start_c: "running" }).tone], ["c · running", "blue"]);
    const crashed = of({ start_c: "done", wait_c: "failed" });
    assert.deepEqual([crashed.text, crashed.tone, crashed.title], ["c · failed", "red", "Branch c ended unsuccessfully: wait_c failed and has no route on"]);
    assert.deepEqual([of({}).text, of({}).tone], ["c", null]);
    const layout = layoutWorkflowGraphTB(FAN);
    const out = key(workflowJoinId("fan"), "report");
    assert.deepEqual(workflowJoinShown(layout, "fan", null), { litCount: 0, litAge: null, current: false });
    const lit = { edges: new Map([[out, { count: 1, age: 0 }]]), transition: { fromStateId: "fan", edgeKey: out } };
    assert.deepEqual(workflowJoinShown(layout, "fan", lit), { litCount: 1, litAge: 0, current: true });
    const older = { edges: new Map([[out, { count: 1, age: 2 }]]), transition: { fromStateId: "report", edgeKey: null } };
    assert.deepEqual(workflowJoinShown(layout, "fan", older), { litCount: 1, litAge: 2, current: false });
});

// The owner's issue-to-pr shape, small: a gate whose error ends the run as failed (an error handler), a blocked end and a
// business route into the failed end (chips), a review loop, and a root catchAll covering a step with no failure route.
const GATED = workflowDefinition({ revision: 1, initial: "fetch", catchAll: "failed", states: [
    { id: "fetch", type: "script", outcomes: ["ok", "not_open"], next: { ok: "review", not_open: "rejected", failure: "failed" } },
    { id: "review", type: "script", outcomes: ["approved", "changes_required"], next: { approved: "gate", changes_required: "gate" } },
    { id: "gate", type: "script", outcomes: ["next", "done", "error"], next: { next: "review", done: "done", error: "failed", failure: "failed" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "rejected", type: "terminal", outcome: "blocked" },
    { id: "failed", type: "terminal", outcome: "failed" },
] });

test("a route drawn as an error handler or a chip is keyed by it; each transition says its route in words and whether it was an error", () => {
    const run = [
        visit("nx-0", "fetch", 0, { status: "completed", outcome: "ok", resultKind: "business" }),
        visit("nx-1", "review", 10, { status: "completed", outcome: "changes_required", resultKind: "business" }),
        visit("nx-2", "gate", 20, { status: "completed", outcome: "next", resultKind: "business" }),
        visit("nx-3", "review", 30, { ordinal: 2, status: "completed", outcome: "approved", resultKind: "business" }),
        visit("nx-4", "gate", 40, { ordinal: 2, status: "completed", outcome: "execution_failed", resultKind: "runtime_error",
            errorWords: "the script stopped with an error: boom" }),
        visit("nx-5", "failed", 50),
    ];
    const transitions = workflowTransitions(run, GATED);
    assert.deepEqual(transitions.map(item => [item.edgeKey, item.route, item.words, item.error]), [
        [null, null, null, false],
        [key("fetch", "review"), "ok", "ok", false],
        [key("review", "gate"), "changes_required", "changes required", false],
        [key("gate", "review"), "next", "next", false],
        [key("review", "gate"), "approved", "approved", false],
        // R1: the gate's error into the failed end has no line; its key is the gate's error handler into that end.
        ["handler:gate:failed", "failure", "✕ script failed", true],
    ]);
    // R2: a business route into an end drawn as a chip has the chip's key.
    const chipped = workflowTransitions([visit("nx-0", "fetch", 0, { status: "completed", outcome: "not_open", resultKind: "business" }),
        visit("nx-1", "rejected", 10)], GATED);
    assert.deepEqual([chipped[1].edgeKey, chipped[1].words, chipped[1].error], ["chip:fetch:rejected", "not open", false]);
    const business = workflowTransitions([visit("nx-0", "fetch", 0, { status: "completed", outcome: "ok", resultKind: "business" }),
        visit("nx-1", "review", 10, { status: "completed", outcome: "approved", resultKind: "business" }),
        visit("nx-2", "gate", 20, { status: "completed", outcome: "error", resultKind: "business" }), visit("nx-3", "failed", 30)], GATED);
    assert.equal(business[3].edgeKey, "chip:gate:failed");
    // R1: a catch-all's arrival from a step it covers (review has no failure route) is that step's catchAll handler.
    const caught = workflowTransitions([visit("nx-0", "review", 0, { status: "completed", outcome: "timed_out", resultKind: "runtime_error" }),
        visit("nx-1", "failed", 10, { catchAll: true })], GATED);
    assert.deepEqual([caught[1].fromStateId, caught[1].edgeKey, caught[1].route, caught[1].words, caught[1].error],
        ["review", "handler:review:failed", "@catchAll", "✕ limit", true]);
    // R1: a visit limit's route is its step's handler too, in words "visit limit reached".
    const LIMITED = workflowDefinition({ revision: 1, initial: "try", states: [
        { id: "try", type: "script", maxVisits: 2, outcomes: ["again", "done", "exhausted"], next: { again: "try", done: "done", exhausted: "stuck" } },
        { id: "done", type: "terminal", outcome: "succeeded" },
        { id: "stuck", type: "terminal", outcome: "blocked" },
    ] });
    const limited = workflowTransitions([visit("nx-0", "try", 0, { status: "completed", outcome: "again", resultKind: "business" }),
        visit("nx-1", "try", 10, { ordinal: 2, status: "completed", outcome: "exhausted", resultKind: "business" }), visit("nx-2", "stuck", 20)], LIMITED);
    assert.deepEqual(limited.slice(1).map(item => [item.edgeKey, item.route, item.words]),
        [[key("try", "try"), "again", "again"], ["handler:try:stuck", "exhausted", "visit limit reached"]]);
    // A route not known (the step's visit has no outcome): the pair decides.
    const unknown = workflowTransitions([visit("nx-0", "gate", 0), visit("nx-1", "failed", 10)], GATED);
    assert.equal(unknown[1].edgeKey, "chip:gate:failed");
});

test("the moment shown: what the run had taken by then, the transition shown, the end reached and the error marks", () => {
    const run = [
        visit("nx-0", "fetch", 0, { status: "completed", outcome: "ok", resultKind: "business" }),
        visit("nx-1", "review", 10, { status: "completed", outcome: "approved", resultKind: "business" }),
        visit("nx-2", "gate", 20, { status: "completed", outcome: "boom", resultKind: "runtime_error" }),
        visit("nx-3", "failed", 30),
    ];
    const transitions = workflowTransitions(run, GATED);
    const live = workflowLitTransitions(transitions);
    assert.deepEqual([...live.visited].sort(), [key("fetch", "review"), key("review", "gate"), "handler:gate:failed"].sort());
    assert.deepEqual([live.transition.edgeKey, live.transition.words], ["handler:gate:failed", "✕ boom"]);
    assert.deepEqual(live.edges.get("handler:gate:failed"), { count: 1, age: 0 });
    // At the second visit, only the first line had been taken.
    const back = workflowLitTransitions(transitions, 1);
    assert.deepEqual([...back.visited], [key("fetch", "review")]);
    assert.equal(back.edges.has("handler:gate:failed"), false);
    // R1: the gate's boundary event (keyed as its handler) is lit by the handler it took; its chip (a business route) was not taken.
    const layout = layoutWorkflowGraphTB(GATED);
    const gate = workflowStepMarks(layout, "gate", live);
    assert.equal(gate.mark, undefined, "a list of boundary events, one per handler");
    assert.deepEqual(gate.marks.map(mark => [mark.key, mark.end, mark.words, mark.index, mark.litCount, mark.litAge, mark.visited, mark.hover]),
        [["handler:gate:failed", "failed", "on error", 0, 1, 0, true, false]]);
    assert.deepEqual(gate.chips.map(chip => [chip.key, chip.litCount, chip.visited, chip.ghost]), [["chip:gate:failed", 0, false, null]]);
    // Before the gate's error: not lit, not taken yet; outside a run: not visited either way, lit by the Ends row's hovered end.
    assert.deepEqual(workflowStepMarks(layout, "gate", back).marks.map(mark => [mark.litCount, mark.litAge, mark.visited]), [[0, null, false]]);
    assert.deepEqual(workflowStepMarks(layout, "gate", null, "failed").marks.map(mark => [mark.litCount, mark.visited, mark.hover]), [[0, null, true]]);
    // Another step's boundary event, its handler not taken; a step without handlers or chips has none.
    assert.deepEqual(workflowStepMarks(layout, "fetch", live).marks.map(mark => [mark.key, mark.litCount, mark.visited]), [["handler:fetch:failed", 0, false]]);
    assert.deepEqual(workflowStepMarks(layout, "done", live), { marks: [], chips: [] });
    assert.equal(workflowEndReached(transitions, ["done", "rejected", "failed"]), "failed");
    assert.equal(workflowEndReached(transitions, ["done", "rejected", "failed"], 2), null);
    assert.deepEqual(workflowErrorTransitions(transitions), [3]);
    assert.deepEqual(workflowErrorTransitions(null), []);
});

test("an error route between two steps lights its own dashed line: by its key when the route is known, the error line first when it is not", () => {
    // R1 (12:05 PST): the review's failure goes on to the gate: a dashed line beside the business line to the gate.
    const REVIEWED = workflowDefinition({ revision: 1, initial: "review", states: [
        { id: "review", type: "script", outcomes: ["approved", "changes_required"], next: { approved: "gate", changes_required: "gate", failure: "gate" } },
        { id: "gate", type: "script", outcomes: ["next"], next: { next: "done", failure: "failed" } },
        { id: "done", type: "terminal", outcome: "succeeded" },
        { id: "failed", type: "terminal", outcome: "failed" },
    ] });
    const errorKey = workflowGraphErrorEdgeKey("review", "gate");
    assert.equal(errorKey, JSON.stringify(["review", "gate", "error"]));
    const keys = workflowGraphEdgeKeys(REVIEWED);
    assert.ok(keys.has(errorKey) && keys.has(key("review", "gate")), [...keys].join(" "));
    // The review crashed: the runtime took its failure route to the gate, the error line's transition.
    const crashed = workflowTransitions([visit("nx-0", "review", 0, { status: "failed", outcome: "execution_failed", resultKind: "runtime_error",
        errorWords: "the script stopped with an error: boom" }), visit("nx-1", "gate", 10)], REVIEWED);
    assert.deepEqual([crashed[1].edgeKey, crashed[1].route, crashed[1].words, crashed[1].error], [errorKey, "failure", "✕ script failed", true]);
    // Lit in a replay like any line: the error line, not its business twin.
    const layout = layoutWorkflowGraphTB(REVIEWED);
    const lit = workflowLitTransitions(crashed);
    const shown = edgeKey => workflowEdgeShown(layout.edges.find(edge => edge.key === edgeKey), lit);
    assert.deepEqual([shown(errorKey).litCount, shown(errorKey).litAge, shown(errorKey).visited, shown(errorKey).tag], [1, 0, true, null]);
    assert.deepEqual([shown(key("review", "gate")).litCount, shown(key("review", "gate")).visited], [0, false]);
    // An approval goes by the business line.
    const approved = workflowTransitions([visit("nx-0", "review", 0, { status: "completed", outcome: "approved", resultKind: "business" }),
        visit("nx-1", "gate", 10)], REVIEWED);
    assert.deepEqual([approved[1].edgeKey, approved[1].error], [key("review", "gate"), false]);
    // The route not known (no outcome recorded): an error takes the error line, anything else the business line.
    const unknown = extra => workflowTransitions([visit("nx-0", "review", 0, extra), visit("nx-1", "gate", 10)], REVIEWED)[1];
    assert.deepEqual([unknown({ resultKind: "runtime_error" }).edgeKey, unknown({ resultKind: "runtime_error" }).error], [errorKey, true]);
    assert.deepEqual([unknown({}).edgeKey, unknown({}).error], [key("review", "gate"), false]);
    // A root catchAll that is a step: a covered step's error arrives there by its dashed "@catchAll" line.
    const CAUGHT = workflowDefinition({ revision: 1, initial: "work", catchAll: "cleanup", states: [
        { id: "work", type: "script", outcomes: ["ok"], next: { ok: "done" } },
        { id: "cleanup", type: "script", outcomes: ["ok"], next: { ok: "failed" } },
        { id: "done", type: "terminal", outcome: "succeeded" },
        { id: "failed", type: "terminal", outcome: "failed" },
    ] });
    const [, caught] = workflowTransitions([visit("nx-0", "work", 0, { status: "failed", outcome: "timed_out", resultKind: "runtime_error" }),
        visit("nx-1", "cleanup", 10, { catchAll: true })], CAUGHT);
    assert.deepEqual([caught.fromStateId, caught.edgeKey, caught.route, caught.words, caught.error],
        ["work", workflowGraphErrorEdgeKey("work", "cleanup"), "@catchAll", "✕ limit", true]);
});

test("a step card draws one boundary event per error handler on its bottom edge, titled with what it catches and its end, lit by its handler", () => {
    const LIMITED = workflowDefinition({ revision: 1, initial: "acquire", states: [
        { id: "acquire", type: "script", maxVisits: 3, outcomes: ["acquired", "exhausted"], next: { acquired: "done", exhausted: "no_env", failure: "failed" } },
        { id: "done", type: "terminal", outcome: "succeeded" },
        { id: "no_env", type: "terminal", outcome: "blocked" },
        { id: "failed", type: "terminal", outcome: "failed" },
    ] });
    const layout = layoutWorkflowGraphTB(LIMITED);
    const lit = { edges: new Map([["handler:acquire:failed", { count: 1, age: 0 }]]), visited: new Set(["handler:acquire:failed"]), transition: null };
    const node = { id: "acquire", type: "script", kind: "script", state: "failed", phase: "error", label: "Script", stateLabel: "Failed" };
    const html = renderToStaticMarkup(React.createElement(WorkflowStepCard, { node, onSelect() {}, marks: workflowStepMarks(layout, "acquire", lit) }));
    assert.match(html, /^<div class="ps-workflow-step"><div class="ps-workflow-node [^"]*"[^>]*data-node-id="acquire"/);
    // Errors first, nearest the corner (13 px: 22 px in, less half the event's width), then the visit limit 22 px further left.
    const marks = html.match(/<span class="ps-workflow-mark"[^>]*>/g) ?? [];
    assert.deepEqual(marks, [
        '<span class="ps-workflow-mark" role="img" aria-label="Error handler: on error → end failed. Select the step to see where its errors go." '
            + 'title="Error handler: on error → end failed. Select the step to see where its errors go." data-end="failed" style="right:13px" data-lit="1" data-lit-age="0">',
        '<span class="ps-workflow-mark" role="img" aria-label="Error handler: on limit → end no_env. Select the step to see where its errors go." '
            + 'title="Error handler: on limit → end no_env. Select the step to see where its errors go." data-end="no_env" style="right:35px" data-visited="false">']);
    // Each a double circle with a lightning bolt.
    assert.deepEqual([(html.match(/class="ps-workflow-mark-ring"/g) ?? []).length, (html.match(/class="ps-workflow-mark-bolt"/g) ?? []).length], [4, 2]);
    // A step without handlers or chips is its card alone.
    const plain = renderToStaticMarkup(React.createElement(WorkflowStepCard, { node: { ...node, id: "done", type: "terminal", kind: "terminal" }, onSelect() {},
        marks: workflowStepMarks(layout, "done", lit) }));
    assert.ok(plain.startsWith('<div class="ps-workflow-node ') && !plain.includes("ps-workflow-mark"), plain);
});

test("both renderers draw the lit parts: data-lit, data-lit-age and the current step (the plain picture here)", () => {
    const transitions = workflowTransitions(loopVisits(["check", "wait", "check", "wait", "check"]), LOOP);
    const lit = workflowLitTransitions(transitions);
    const nodes = LOOP.states.map(state => ({ id: state.id, type: state.type, kind: state.type === "terminal" ? "terminal" : state.type,
        state: "done", phase: "done", label: state.id, stateLabel: "Done" }));
    const html = renderToStaticMarkup(React.createElement(WorkflowGraph, { definition: LOOP, nodes, selected: nodes[1], select() {}, lit }));
    const card = id => new RegExp(`<div[^>]*data-node-id="${id}"[^>]*>`).exec(html)?.[0] ?? "";
    assert.match(card("check"), /data-lit="2"/);
    assert.match(card("check"), /data-lit-age="0"/);
    assert.match(card("check"), /data-current="true"/);
    assert.match(card("wait"), /data-lit="2"[^>]*data-lit-age="1"|data-lit-age="1"[^>]*data-lit="2"/);
    assert.ok(!/data-current/.test(card("wait")) && !/data-lit/.test(card("done")), card("done"));
    // The selection keeps its own mark.
    assert.match(card("wait"), /is-selected/);
    const edge = (from, to) => new RegExp(`<g class="ps-workflow-edge"[^>]*data-from="${from}" data-to="${to}"[^>]*>`).exec(html)?.[0] ?? "";
    assert.match(edge("check", "wait"), /data-lit="2"/);
    assert.match(edge("wait", "check"), /data-lit-age="0"/);
    assert.ok(!/data-lit/.test(edge("check", "done")));
    // A lit edge has its own arrowhead in the lit colour; the others share the graph's.
    assert.equal((html.match(/class="ps-workflow-edge-lit-arrow"/g) || []).length, 2);
    // Owner 2026-11-09T06:40Z: an active run's lit edges carry the moving light (pathLength 1); an ended run's do not.
    assert.equal((html.match(/class="ps-workflow-edge-flow"/g) || []).length, 0, "no flow without lit.flow");
    const flowing = renderToStaticMarkup(React.createElement(WorkflowGraph, { definition: LOOP, nodes, selected: nodes[1], select() {},
        lit: { ...lit, flow: true } }));
    const lights = flowing.match(/<path class="ps-workflow-edge-flow"[^>]*>/g) || [];
    assert.equal(lights.length, 2);
    for (const light of lights) assert.match(light, /pathLength="1"/);
    assert.match(flowing, /data-from="check" data-to="done"(?:(?!<\/g>).)*<\/g>/s);
    assert.ok(!/data-from="check" data-to="done"[^>]*>(?:(?!<\/g>).)*ps-workflow-edge-flow/s.test(flowing), "an unlit edge has no light");
});

// ─── The timeline bar (workflow-tab.js ReplayBar, timelineVisitAt) ───

import {
    ReplayBar, TIMELINE_PLAY_LIVE_TITLE, timelineIndexAt, timelineScale, timelineVisitAt, workflowTimelineVisits,
} from "../../react/src/workflow-tab.js";

const FRAMES = workflowReplayFrames(loopVisits(["check", "wait", "check", "done"]));

test("the slider's positions are the visits; the right end is Live, so a position there or past it shows Live", () => {
    assert.deepEqual([0, 1, 2, 3, 4, -1, null, 1.5].map(index => timelineVisitAt(FRAMES, index)), ["nx-0", "nx-1", "nx-2", null, null, null, null, null]);
    assert.equal(timelineVisitAt([], 0), null);
    assert.equal(timelineVisitAt(FRAMES.slice(0, 1), 0), null);
});

test("the bar: Live by default (Latest once ended), Play off with its reason; history counts the newer visits; no visit, every control off", () => {
    const render = props => renderToStaticMarkup(React.createElement(ReplayBar, { frames: FRAMES, index: null, playing: false, onGo() {}, onPlay() {}, onPause() {}, ...props }));
    const button = (html, label) => new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(html)?.[0] ?? "";
    const live = render({});
    assert.match(live, /aria-label="Timeline"/);
    assert.match(live, /data-mode="live"/);
    // UXP-TL-04: the slider's scale is time: Live sits at its right end, the newest visit's start.
    const range = /<input[^>]*type="range"[^>]*>/.exec(live)[0];
    const attr = name => Number(new RegExp(` ${name}="([^"]+)"`).exec(range)[1]);
    assert.equal(attr("min"), FRAMES[0].atMs);
    assert.equal(attr("max"), FRAMES[3].atMs);
    assert.equal(attr("value"), FRAMES[3].atMs);
    assert.match(live, /class="ps-wf-replay-label"[^>]*>Live · [^<]*done visit 4</);
    assert.match(button(live, "Play"), /aria-disabled="true"/);
    assert.ok(live.includes(`data-title="${TIMELINE_PLAY_LIVE_TITLE}"`), "Play's reason in Live");
    assert.match(button(live, "Step on"), /aria-disabled="true"/);
    assert.ok(!/aria-disabled/.test(button(live, "Step back")), "Step back from Live is on");
    assert.match(live, /data-action="replay-live"[^>]*aria-disabled="true"[^>]*aria-pressed="true"[^>]*>Live</);
    // Ended: Latest.
    assert.match(render({ ended: true }), /data-action="replay-live"[^>]*>Latest</);
    // History, at the first visit: three newer; Step back off, Step on, Play and Live on.
    const history = render({ index: 0 });
    assert.match(history, /data-mode="history"/);
    assert.match(history, /class="ps-wf-replay-label"[^>]*>[^<]*check visit 1 · 3 newer</);
    assert.match(button(history, "Step back"), /aria-disabled="true"/);
    // UXP-TL-04: with older visits to load, Step back from the oldest loaded is on (it loads them first).
    assert.ok(!/aria-disabled/.test(button(render({ index: 0, onOlder() {} }), "Step back")));
    for (const label of ["Step on", "Play"]) assert.ok(!/aria-disabled/.test(button(history, label)), label);
    assert.ok(!/data-action="replay-live"[^>]*aria-disabled/.test(history));
    // At the visit before the newest, Step on goes back to Live.
    assert.ok(render({ index: 2 }).includes('data-title="Back to Live"'));
    // Playing: Pause.
    assert.match(render({ index: 1, playing: true }), /aria-label="Pause"/);
    // No visit yet: every control off.
    const empty = render({ frames: [] });
    assert.match(empty, /data-mode="empty"/);
    assert.match(empty, />No steps yet</);
    assert.match(empty, /<input[^>]*disabled=""/);
    for (const label of ["Step back", "Play", "Step on"]) assert.match(button(empty, label), /aria-disabled="true"/, label);
    // Load older visits: its name whole; "Older" on a phone.
    assert.match(render({ onOlder() {} }), /aria-label="Load older visits"[^>]*>.*Load older visits.*Older/);
});

// UXP-TL-04 (owner, TEST at 09d98247): the thumb jittered on a long running run, as the loaded visits changed at both ends.
test("UXP-TL-04: the slider's scale is time from the run's start to the newest visit; a value shows the last visit begun by then", () => {
    const start = FRAMES[0].atMs - 5_000;
    assert.deepEqual(timelineScale(FRAMES, start), { min: start, max: FRAMES[3].atMs });
    // A start later than the first visit seen, or none: the first visit.
    assert.deepEqual(timelineScale(FRAMES, FRAMES[1].atMs), { min: FRAMES[0].atMs, max: FRAMES[3].atMs });
    assert.deepEqual(timelineScale(FRAMES, null), { min: FRAMES[0].atMs, max: FRAMES[3].atMs });
    assert.deepEqual(timelineScale(FRAMES.slice(0, 1), null), { min: FRAMES[0].atMs, max: FRAMES[0].atMs + 1 });
    assert.deepEqual(timelineScale([], null), { min: 0, max: 1 });
    // A visit keeps its value whatever is loaded before or after it.
    const value = FRAMES[2].atMs;
    assert.equal(timelineIndexAt(FRAMES, value), 2);
    assert.equal(timelineIndexAt(FRAMES.slice(1), value), 1);
    assert.equal(timelineIndexAt(FRAMES, value + 9_000), 2, "between two visits: the one begun");
    assert.equal(timelineIndexAt(FRAMES, FRAMES[0].atMs - 1), 0, "before every visit: the first");
    assert.equal(timelineIndexAt(FRAMES, FRAMES[3].atMs), 3, "the right end: the newest (Live)");
});

test("UXP-TL-04: the timeline keeps every visit of the run it has seen; a new run starts afresh; an unchanged read keeps the list", () => {
    const visits = loopVisits(["check", "wait", "check", "done"]);
    let seen = workflowTimelineVisits(null, "run-1", visits.slice(2));
    assert.deepEqual(seen.list.map(item => item.id), ["nx-2", "nx-3"]);
    // Older visits loaded later join; visits that leave the loaded window stay.
    seen = workflowTimelineVisits(seen, "run-1", visits.slice(0, 2));
    assert.deepEqual(seen.list.map(item => item.id).sort(), ["nx-0", "nx-1", "nx-2", "nx-3"]);
    const same = workflowTimelineVisits(seen, "run-1", visits.slice(0, 2));
    assert.equal(same, seen, "nothing new: the same list");
    // A newer copy of a visit replaces it.
    const ended = { ...visits[3], status: "completed" };
    assert.equal(workflowTimelineVisits(seen, "run-1", [ended]).list.find(item => item.id === "nx-3").status, "completed");
    assert.deepEqual(workflowTimelineVisits(seen, "run-2", visits.slice(1, 2)).list.map(item => item.id), ["nx-1"]);
});
