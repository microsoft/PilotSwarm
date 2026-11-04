// The portal's top-to-bottom workflow graph layout (owner batch 5, g-01): dagre ranks, orders and routes the graph;
// edges are smooth curves through dagre's points. The terminal keeps its own layout (workflow-view.test.mjs).
//
// Run: node --test packages/app/ui/core/test/workflow-graph-layout.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { layoutWorkflowGraphTB, workflowEdgeCurve, workflowEdgeLabelText, WORKFLOW_GRAPH_NODE_WIDTH, WORKFLOW_GRAPH_NODE_HEIGHT }
    from "../src/workflow-graph-layout.js";
import { workflowDefinition } from "../src/workflow-view.js";
import { workflowV2Definition } from "../src/workflow-v2-view.js";
import { startedData } from "./workflow-v2-fixtures.mjs";

const edgeOf = (layout, from, to) => layout.edges.find(edge => edge.from === from && edge.to === to);
const top = (layout, id) => layout.positions.get(id).y;
const name = edge => `${edge.from}->${edge.to}`;

/** Points along every drawn piece of an edge's curve. */
function samples(edge, steps = 16) {
    const out = [];
    for (const piece of workflowEdgeCurve(edge.points).segments) {
        for (let i = 0; i <= steps; i += 1) {
            const t = i / steps, u = 1 - t;
            if (piece.type === "line") {
                out.push([u * piece.from[0] + t * piece.to[0], u * piece.from[1] + t * piece.to[1]]);
            } else {
                const at = axis => u * u * u * piece.from[axis] + 3 * u * u * t * piece.c1[axis] + 3 * u * t * t * piece.c2[axis] + t * t * t * piece.to[axis];
                out.push([at(0), at(1)]);
            }
        }
    }
    return out;
}

/** No edge's curve passes through the box of a step other than the two it joins. */
function assertCurvesClearOfSteps(layout) {
    for (const edge of layout.edges) {
        for (const [x, y] of samples(edge)) {
            for (const [id, box] of layout.positions) {
                if (id === edge.from || id === edge.to) continue;
                const inside = x > box.x + 1 && x < box.x + box.width - 1 && y > box.y + 1 && y < box.y + box.height - 1;
                assert.equal(inside, false, `${name(edge)} passes through ${id} at ${Math.round(x)},${Math.round(y)}`);
            }
        }
    }
}

/** Every box, point and label lies inside the drawing, and every path is drawable. */
function assertInside(layout) {
    for (const box of layout.positions.values()) {
        assert.equal(box.width, WORKFLOW_GRAPH_NODE_WIDTH);
        assert.equal(box.height, WORKFLOW_GRAPH_NODE_HEIGHT);
        assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= layout.width && box.y + box.height <= layout.height);
    }
    for (const edge of layout.edges) {
        assert.ok(edge.points.length >= 2, name(edge));
        for (const [x, y] of edge.points) assert.ok(x >= 0 && x <= layout.width && y >= 0 && y <= layout.height, `${name(edge)} point ${x},${y}`);
        assert.ok(edge.labelX - edge.labelWidth / 2 >= 0 && edge.labelX + edge.labelWidth / 2 <= layout.width, name(edge));
        assert.ok(edge.labelY >= 0 && edge.labelY <= layout.height, name(edge));
        assert.match(edge.path, /^M[\d.]+,[\d.]+( [LC][\d., ]+)+$/, name(edge));
        assert.ok(!edge.path.includes("NaN"));
    }
}

/** The edges that go up (or loop on one step): the ones that close a cycle. */
const upward = layout => layout.edges.filter(edge => edge.back).map(name).sort();

// The owner's case (batch 5): tell a joke, ask for more (yes goes back to the joke, no ends), and a review branch.
const jokes = workflowDefinition({ name: "jokes", initial: "tell_joke", states: [
    { id: "tell_joke", type: "script", next: { told: "ask_more", flagged: "review" } },
    { id: "review", type: "script", next: { approved: "ask_more", rejected: "failed" } },
    { id: "ask_more", type: "script", next: { yes: "tell_joke", no: "done" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
] });

// A four-step retry loop: the old layout put all four on one row.
const retry = workflowDefinition({ name: "retry", initial: "fetch", states: [
    { id: "fetch", type: "script", next: { ok: "validate" } },
    { id: "validate", type: "script", next: { valid: "done", invalid: "backoff" } },
    { id: "backoff", type: "script", next: { elapsed: "count" } },
    { id: "count", type: "script", next: { again: "fetch", exhausted: "failed" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
] });

const quality = workflowDefinition({ name: "branching-workflow-test", initial: "collect_metrics", states: [
    { id: "collect_metrics", type: "script", next: { success: "evaluate_quality", failure: "failed" } },
    { id: "evaluate_quality", type: "script", next: { approved: "approved", blocked: "blocked", failure: "failed" } },
    { id: "approved", type: "terminal", outcome: "succeeded" },
    { id: "blocked", type: "terminal", outcome: "blocked" },
    { id: "failed", type: "terminal", outcome: "failed" },
] });

test("the owner's loop comes out top to bottom: each step below the one before it, and only 'yes' goes back up", () => {
    const layout = layoutWorkflowGraphTB(jokes);
    assert.equal(layout.positions.size, 5);
    assert.equal(layout.edges.length, 6);
    assert.ok(top(layout, "review") > top(layout, "tell_joke"));
    assert.ok(top(layout, "ask_more") > top(layout, "review"));
    assert.ok(top(layout, "done") > top(layout, "ask_more"));
    assert.ok(top(layout, "failed") > top(layout, "review"));
    // The steps of the loop are not forced onto one row.
    assert.equal(new Set(["tell_joke", "review", "ask_more"].map(id => top(layout, id))).size, 3);
    assert.deepEqual(upward(layout), ["ask_more->tell_joke"]);
    for (const edge of layout.edges.filter(item => !item.back)) {
        assert.ok(top(layout, edge.to) > top(layout, edge.from), `${name(edge)} goes down`);
    }
    assert.equal(edgeOf(layout, "ask_more", "tell_joke").outcome, "yes");
    assertCurvesClearOfSteps(layout);
    assertInside(layout);
});

test("a four-step retry loop is four rows, not one, and its closing edge curves back up beside them", () => {
    const layout = layoutWorkflowGraphTB(retry);
    const rows = ["fetch", "validate", "backoff", "count"].map(id => top(layout, id));
    assert.deepEqual(rows, [...rows].sort((a, b) => a - b));
    assert.equal(new Set(rows).size, 4);
    assert.deepEqual(upward(layout), ["count->fetch"]);
    const back = edgeOf(layout, "count", "fetch");
    assert.ok(back.points.length > 2, "the closing edge is routed through the rows between");
    // It starts at count and ends at fetch, curving back up past validate and backoff without touching them.
    assert.ok(back.points[0][1] > back.points.at(-1)[1]);
    assertCurvesClearOfSteps(layout);
    assertInside(layout);
});

test("forward edges go downward, siblings share a row, and nothing is drawn out of a terminal", () => {
    const layout = layoutWorkflowGraphTB(quality);
    for (const edge of layout.edges) assert.ok(top(layout, edge.to) > top(layout, edge.from), `${name(edge)} goes down`);
    assert.deepEqual(upward(layout), []);
    const terminals = ["approved", "blocked", "failed"].map(id => layout.positions.get(id));
    assert.equal(new Set(terminals.map(box => box.y)).size, 1);
    assert.equal(new Set(terminals.map(box => box.x)).size, 3);
    assert.equal(layout.edges.length, 5);
    assert.deepEqual(layout.edges.filter(edge => ["approved", "blocked", "failed"].includes(edge.from)), []);
    assertCurvesClearOfSteps(layout);
    assertInside(layout);
});

test("version 2: merged outcomes, runtime-error routes, the loop back to poll, and no edge out of a terminal", () => {
    const layout = layoutWorkflowGraphTB(workflowDefinition(startedData));
    assert.equal(layout.positions.size, 6);
    assert.equal(layout.edges.length, 7);
    assert.equal(edgeOf(layout, "poll", "failed").kind, "error");
    assert.equal(edgeOf(layout, "poll", "failed").outcome, "failure / timed_out");
    assert.deepEqual(edgeOf(layout, "poll", "failed").outcomes, ["failure", "timed_out"]);
    assert.equal(edgeOf(layout, "notify", "failed").kind, "error");
    assert.equal(edgeOf(layout, "poll", "notify").kind, "outcome");
    assert.equal(edgeOf(layout, "await_ack", "done").outcome, "received / elapsed");
    assert.ok(top(layout, "pause") > top(layout, "poll"), "the wait is below the poll that leads to it");
    assert.deepEqual(upward(layout), ["pause->poll"]);
    assert.deepEqual(layout.edges.filter(edge => edge.from === "done" || edge.from === "failed"), []);
    assertCurvesClearOfSteps(layout);
    assertInside(layout);
});

test("a parallel state leads to its body's first state by an 'each branch' edge", () => {
    const definition = workflowV2Definition({ revision: 1, initial: "review", states: [
        { id: "review", type: "agent", invoke: { source: "agent", name: "code-reviewer", package: "review-kit", version: "1.2.0" }, timeoutSeconds: 600,
            outcomes: ["accepted"], next: { accepted: "fan", timed_out: "failed" } },
        { id: "fan", type: "parallel", forEach: "${input.items}", concurrency: 2, join: "all_required", failFast: false,
            body: { initial: "work", states: ["work", "branch_done"] }, outcomes: ["joined", "blocked"], next: { joined: "done", blocked: "failed" } },
        { id: "work", type: "script", runtime: "node", timeoutSeconds: 300, outcomes: ["ok"], next: { ok: "branch_done" }, parallel: "fan" },
        { id: "branch_done", type: "terminal", outcome: "succeeded", parallel: "fan" },
        { id: "done", type: "terminal", outcome: "succeeded" },
        { id: "failed", type: "terminal", outcome: "failed" },
    ] });
    const layout = layoutWorkflowGraphTB(definition);
    const start = edgeOf(layout, "fan", "work");
    assert.ok(start, "the fan-out edge exists");
    assert.deepEqual([start.kind, start.outcome, start.branch, start.outcomes], ["branch", "each branch", true, []]);
    assert.equal(edgeOf(layout, "fan", "done").kind, "outcome");
    assert.equal(edgeOf(layout, "review", "failed").kind, "error");
    assert.ok(top(layout, "work") > top(layout, "fan"));
    assertInside(layout);
});

test("a step that loops on itself keeps one edge with its outcomes joined, beside the step", () => {
    const layout = layoutWorkflowGraphTB(workflowDefinition({ initial: "poll", states: [
        { id: "poll", type: "script", next: { unchanged: "poll", retry: "poll", changed: "end" } },
        { id: "end", type: "terminal", outcome: "succeeded" },
    ] }));
    assert.equal(layout.edges.length, 2);
    const loop = edgeOf(layout, "poll", "poll");
    assert.deepEqual([loop.outcome, loop.labelText, loop.back], ["unchanged / retry", "unchanged / retry", true]);
    const box = layout.positions.get("poll");
    assert.ok(loop.labelX > box.x + box.width, "the loop's label sits beside the step");
    // The loop leaves and enters the step's right side and never crosses the step.
    assert.ok(loop.points.every(([x]) => x >= box.x + box.width - 0.05));
    for (const [x, y] of samples(loop)) assert.ok(x >= box.x + box.width - 0.5, `the loop stays right of the step at ${x},${y}`);
    assertInside(layout);
});

test("a long outcome is drawn to 20 characters, and its box is sized to what is drawn", () => {
    assert.equal(workflowEdgeLabelText("short"), "short");
    assert.equal(workflowEdgeLabelText("exactly_twenty_chars"), "exactly_twenty_chars");
    assert.equal(workflowEdgeLabelText("a_very_long_outcome_name_indeed"), "a_very_long_outcome…");
    const layout = layoutWorkflowGraphTB(workflowDefinition({ initial: "a", states: [
        { id: "a", type: "script", next: { a_very_long_outcome_name_indeed: "b" } },
        { id: "b", type: "terminal", outcome: "succeeded" },
    ] }));
    const edge = edgeOf(layout, "a", "b");
    assert.equal(edge.outcome, "a_very_long_outcome_name_indeed");
    assert.equal(edge.labelText, "a_very_long_outcome…");
    assert.ok(edge.labelWidth > edgeOf(layoutWorkflowGraphTB(workflowDefinition({ initial: "a", states: [
        { id: "a", type: "script", next: { ok: "b" } }, { id: "b", type: "terminal", outcome: "succeeded" },
    ] })), "a", "b").labelWidth);
    assertInside(layout);
});

test("the same definition always gives the same layout", () => {
    const snapshot = layout => JSON.stringify({ width: layout.width, height: layout.height, positions: [...layout.positions], edges: layout.edges });
    for (const definition of [jokes, retry, quality, workflowDefinition(startedData)]) {
        assert.equal(snapshot(layoutWorkflowGraphTB(definition)), snapshot(layoutWorkflowGraphTB(definition)));
    }
});

test("an empty graph, a single step, disconnected steps and object-key ids lay out", () => {
    const empty = layoutWorkflowGraphTB({ states: [] });
    assert.deepEqual([empty.positions.size, empty.edges.length, empty.width, empty.height], [0, 0, 300, 150]);
    assert.equal(layoutWorkflowGraphTB(null).positions.size, 0);
    const single = layoutWorkflowGraphTB(workflowDefinition({ initial: "only", states: [{ id: "only", type: "terminal", outcome: "succeeded" }] }));
    assert.equal(single.positions.size, 1);
    assert.deepEqual(single.edges, []);
    assertInside(single);
    const special = layoutWorkflowGraphTB(workflowDefinition({ initial: "__proto__", states: [
        { id: "__proto__", type: "script", next: { next: "constructor" } },
        { id: "constructor", type: "script", next: { again: "__proto__" } },
        { id: "isolated", type: "terminal" },
    ] }));
    assert.equal(special.positions.size, 3);
    assert.equal(special.edges.length, 2);
    assert.ok(top(special, "constructor") > top(special, "__proto__"));
    assertInside(special);
});

test("an edge's curve starts and ends on its routed points, follows its last segment in, and two points are a line", () => {
    assert.deepEqual(workflowEdgeCurve([]), { path: "", segments: [] });
    assert.equal(workflowEdgeCurve([[0, 0], [10, 20]]).path, "M0,0 L10,20");
    const curve = workflowEdgeCurve([[0, 0], [30, 30], [0, 60]]);
    assert.ok(curve.path.startsWith("M0,0 L"));
    assert.ok(curve.path.endsWith(" L0,60"));
    assert.deepEqual(curve.segments.map(piece => piece.type), ["line", "cubic", "cubic", "line"]);
    const last = curve.segments.at(-1);
    // The last piece points the same way as the last routed segment (30,30 -> 0,60), so an arrowhead follows it in.
    assert.ok(last.to[0] - last.from[0] < 0 && last.to[1] - last.from[1] > 0);
});
