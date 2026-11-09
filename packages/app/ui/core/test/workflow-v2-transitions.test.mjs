/**
 * Owner 2026-11-09T03:37Z (the timeline as a viewing mode): "as a workflow is executing, the last four transitions need to be
 * visually lit up. if the transitions are already lit up then they need to be double lit". One model for both renderers:
 * workflowV2Transitions (how each visit was entered: the root's chain, each branch's own, a branch's first visit from its
 * parallel visit, a catch-all's arrival and the run's first visit as the step only, a boxed parallel's routes from its
 * join bar) and workflowV2LitTransitions (the last four up to the visit shown, counted across branches, with each part's
 * count and age); and how both renderers draw them (data-lit, data-lit-age, data-current).
 *
 * Run: node --test ui/core/test/workflow-v2-transitions.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { workflowV2Definition } from "../src/workflow-v2-view.js";
import { workflowGraphEdgeKey, workflowGraphEdgeKeys, workflowGroupId, workflowJoinId } from "../src/workflow-graph-layout.js";
import { WORKFLOW_LIT_TRANSITIONS, workflowLitLevel, workflowV2LitTransitions, workflowV2Transitions } from "../src/workflow-v2-transitions.js";
import { WorkflowGraph } from "../../react/src/workflow-graph.js";

const at = seconds => new Date(Date.UTC(2026, 10, 9, 3, 0, seconds)).toISOString();
const visit = (id, stateId, seconds, extra = {}) => ({ id, stateId, enteredAt: at(seconds), ordinal: extra.ordinal ?? 1, ...extra });
const key = workflowGraphEdgeKey;

// A watch loop: check, then wait and check again until it changed, then done.
const LOOP = workflowV2Definition({ revision: 1, initial: "check", states: [
    { id: "check", type: "script", outcomes: ["unchanged", "changed"], next: { unchanged: "wait", changed: "done" } },
    { id: "wait", type: "wait", seconds: 30, outcomes: ["elapsed"], next: { elapsed: "check" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
] });
const loopVisits = names => names.map((stateId, index) => visit(`nx-${index}`, stateId, index * 10, { ordinal: index + 1 }));

test("the root's chain: each visit came from the visit before it; the run's first visit is its step only", () => {
    const transitions = workflowV2Transitions(loopVisits(["check", "wait", "check", "done"]), LOOP);
    assert.deepEqual(transitions, [
        { nodeExecutionId: "nx-0", fromStateId: null, toStateId: "check", edgeKey: null },
        { nodeExecutionId: "nx-1", fromStateId: "check", toStateId: "wait", edgeKey: key("check", "wait") },
        { nodeExecutionId: "nx-2", fromStateId: "wait", toStateId: "check", edgeKey: key("wait", "check") },
        { nodeExecutionId: "nx-3", fromStateId: "check", toStateId: "done", edgeKey: key("check", "done") },
    ]);
    // In the timeline's order (entry time), whatever order they were listed in.
    assert.deepEqual(workflowV2Transitions(loopVisits(["check", "wait", "check", "done"]).reverse(), LOOP).map(item => item.nodeExecutionId),
        ["nx-0", "nx-1", "nx-2", "nx-3"]);
});

test("the last four transitions are lit, newest age 0; a part taken twice among them is double lit", () => {
    const transitions = workflowV2Transitions(loopVisits(["check", "wait", "check", "wait", "check", "wait", "check"]), LOOP);
    assert.equal(WORKFLOW_LIT_TRANSITIONS, 4);
    const lit = workflowV2LitTransitions(transitions);
    // Visits 4 to 7 (wait, check, wait, check): check→wait and wait→check twice each.
    assert.deepEqual([...lit.edges].sort(), [[key("check", "wait"), { count: 2, age: 1 }], [key("wait", "check"), { count: 2, age: 0 }]].sort());
    assert.deepEqual(Object.fromEntries(lit.nodes), { check: { count: 2, age: 0 }, wait: { count: 2, age: 1 } });
    assert.equal(lit.current, "check");
    assert.deepEqual([workflowLitLevel(lit.edges.get(key("check", "wait"))), workflowLitLevel({ count: 1, age: 0 }), workflowLitLevel({ count: 5, age: 2 }),
        workflowLitLevel(null)], ["2", "1", "2", null]);
    // Up to the visit shown (history): the four ending there; the newest visit is not counted.
    const shown = workflowV2LitTransitions(transitions, 2);
    assert.deepEqual(Object.fromEntries(shown.edges), { [key("check", "wait")]: { count: 1, age: 1 }, [key("wait", "check")]: { count: 1, age: 0 } });
    assert.deepEqual(Object.fromEntries(shown.nodes), { check: { count: 2, age: 0 }, wait: { count: 1, age: 1 } });
    assert.equal(shown.current, "check");
    // The window's edge: at the first visit, its step only; past the newest, the newest; none, nothing.
    assert.deepEqual([workflowV2LitTransitions(transitions, 0).edges.size, Object.fromEntries(workflowV2LitTransitions(transitions, 0).nodes)],
        [0, { check: { count: 1, age: 0 } }]);
    assert.equal(workflowV2LitTransitions(transitions, 99).current, "check");
    assert.deepEqual(workflowV2LitTransitions([], null), { edges: new Map(), nodes: new Map(), current: null });
    assert.deepEqual(workflowV2LitTransitions(null), { edges: new Map(), nodes: new Map(), current: null });
});

test("a catch-all's arrival lights its step only; a predecessor named by the read model is taken over the chain", () => {
    const transitions = workflowV2Transitions([
        visit("nx-0", "check", 0), visit("nx-1", "wait", 10), visit("nx-2", "done", 20, { catchAll: true }),
    ], LOOP);
    assert.deepEqual(transitions[2], { nodeExecutionId: "nx-2", fromStateId: null, toStateId: "done", edgeKey: null });
    const lit = workflowV2LitTransitions(transitions);
    assert.ok(lit.nodes.has("done") && !lit.edges.has(key("wait", "done")) && !lit.edges.has(key("check", "done")));
    // A visit whose predecessor the read model names comes from it, not from the visit before it.
    const named = workflowV2Transitions([visit("nx-0", "check", 0), visit("nx-1", "wait", 10), visit("nx-2", "done", 20, { predecessorId: "nx-0" })], LOOP);
    assert.deepEqual(named[2], { nodeExecutionId: "nx-2", fromStateId: "check", toStateId: "done", edgeKey: key("check", "done") });
    // A predecessor not loaded: the chain decides.
    const missing = workflowV2Transitions([visit("nx-1", "wait", 10), visit("nx-2", "check", 20, { predecessorId: "nx-gone" })], LOOP);
    assert.equal(missing[1].fromStateId, "wait");
});

// A For each in a box: fan's items run fetch then save; its routes leave from its join bar.
const FAN = workflowV2Definition({ revision: 1, initial: "fan", states: [
    { id: "fan", type: "parallel", concurrency: 2, join: "all_required", body: { initial: "fetch", states: ["fetch", "save"] },
        outcomes: ["joined", "blocked"], next: { joined: "report", blocked: "report" } },
    { id: "fetch", type: "script", outcomes: ["ok"], next: { ok: "save" }, parallel: "fan" },
    { id: "save", type: "terminal", outcome: "succeeded", parallel: "fan" },
    { id: "report", type: "terminal", outcome: "succeeded" },
] });
const item = index => ({ scopeId: `nx-fan#${index}`, branch: { parallelNodeExecutionId: "nx-fan", index } });

test("branches: each its own chain; a branch's first visit came from its parallel visit; the routes after a box leave its join bar", () => {
    const keys = workflowGraphEdgeKeys(FAN);
    assert.ok(keys.has(key("fan", workflowGroupId("fan"))) && keys.has(key(workflowJoinId("fan"), "report")) && keys.has(key("fetch", "save")));
    // No line into a join bar is ever one a visit takes.
    assert.ok(![...keys].some(edge => JSON.parse(edge)[1].startsWith("join:")));
    const transitions = workflowV2Transitions([
        visit("nx-fan", "fan", 0),
        visit("nx-a0", "fetch", 1, item(0)), visit("nx-a1", "fetch", 2, item(1)),
        visit("nx-b0", "save", 3, { ...item(0), ordinal: 2 }), visit("nx-b1", "save", 4, { ...item(1), ordinal: 2 }),
        visit("nx-report", "report", 5),
    ], FAN);
    assert.deepEqual(transitions.map(item => [item.nodeExecutionId, item.fromStateId, item.edgeKey]), [
        ["nx-fan", null, null],
        ["nx-a0", "fan", key("fan", workflowGroupId("fan"))],
        ["nx-a1", "fan", key("fan", workflowGroupId("fan"))],
        ["nx-b0", "fetch", key("fetch", "save")],
        ["nx-b1", "fetch", key("fetch", "save")],
        ["nx-report", "fan", key(workflowJoinId("fan"), "report")],
    ]);
    // Counted across every branch in the timeline's order: the last four are both saves, the second fetch and the report.
    const lit = workflowV2LitTransitions(transitions);
    assert.deepEqual(Object.fromEntries(lit.edges), {
        [key(workflowJoinId("fan"), "report")]: { count: 1, age: 0 }, [key("fetch", "save")]: { count: 2, age: 1 },
        [key("fan", workflowGroupId("fan"))]: { count: 1, age: 3 },
    });
});

test("named branches: a lane's first visit came by its lane's line from the parallel step", () => {
    const NAMED = workflowV2Definition({ revision: 1, initial: "views", states: [
        { id: "views", type: "parallel", concurrency: 2, join: "all_required",
            branches: [{ name: "quick", initial: "quick_work", states: ["quick_work"] }, { name: "careful", initial: "careful_work", states: ["careful_work"] }],
            body: { initial: "quick_work", states: ["quick_work", "careful_work"] }, outcomes: ["joined"], next: { joined: "done" } },
        { id: "quick_work", type: "terminal", outcome: "succeeded", parallel: "views", branchName: "quick" },
        { id: "careful_work", type: "terminal", outcome: "succeeded", parallel: "views", branchName: "careful" },
        { id: "done", type: "terminal", outcome: "succeeded" },
    ] });
    const transitions = workflowV2Transitions([visit("nx-views", "views", 0),
        visit("nx-q", "quick_work", 1, { scopeId: "nx-views#0", branch: { parallelNodeExecutionId: "nx-views", index: 0, name: "quick" } }),
        visit("nx-c", "careful_work", 2, { scopeId: "nx-views#1", branch: { parallelNodeExecutionId: "nx-views", index: 1, name: "careful" } })], NAMED);
    assert.deepEqual(transitions.slice(1).map(item => item.edgeKey), [key("views", "quick_work"), key("views", "careful_work")]);
});

test("both renderers draw the lit parts: data-lit, data-lit-age and the current step (the plain picture here)", () => {
    const transitions = workflowV2Transitions(loopVisits(["check", "wait", "check", "wait", "check"]), LOOP);
    const lit = workflowV2LitTransitions(transitions);
    const nodes = LOOP.states.map(state => ({ id: state.id, shape: "v2", type: state.type, kind: state.type === "terminal" ? "terminal" : state.type,
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
});

// ─── The timeline bar (workflow-tab.js ReplayBar, timelineVisitAt) ───

import {
    ReplayBar, TIMELINE_PLAY_LIVE_TITLE, timelineIndexAt, timelineScale, timelineVisitAt, workflowTimelineVisits,
} from "../../react/src/workflow-tab.js";
import { workflowV2ReplayFrames } from "../src/workflow-v2-view.js";

const FRAMES = workflowV2ReplayFrames(loopVisits(["check", "wait", "check", "done"]));

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
