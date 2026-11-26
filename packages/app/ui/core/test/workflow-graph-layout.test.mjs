// The portal's top-to-bottom workflow graph layout (owner batch 5, g-01): dagre ranks, orders and routes the graph;
// edges are smooth curves through dagre's points. The terminal keeps its own layout (workflow-view.test.mjs).
//
// Run: node --test packages/app/ui/core/test/workflow-graph-layout.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    layoutWorkflowGraphTB, workflowEdgeCurve, workflowEdgeLabelText, workflowGraphBodies, workflowGraphPlaces, workflowPlaceKey,
    WORKFLOW_GRAPH_GROUP_HEADER, WORKFLOW_GRAPH_NODE_WIDTH, WORKFLOW_GRAPH_NODE_HEIGHT,
} from "../src/workflow-graph-layout.js";
import {
    workflowDefinition as checkedDefinition, workflowDefinition,
} from "../src/workflow-view.js";
import { startedData } from "./workflow-fixtures.mjs";

/** A graph's states as the runtime describes them: a script state lists its outcomes (the keys of its next). */
const described = list => list.map(node => (node && typeof node === "object" && node.type !== "terminal"
    ? { type: "script", runtime: "node", timeoutSeconds: 300, outcomes: Object.keys(node.next ?? {}), ...node } : node));
const definitionOf = data => checkedDefinition(data && Array.isArray(data.states) ? { ...data, states: described(data.states) } : data);

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
const jokes = definitionOf({ name: "jokes", initial: "tell_joke", states: [
    { id: "tell_joke", type: "script", next: { told: "ask_more", flagged: "review" } },
    { id: "review", type: "script", next: { approved: "ask_more", rejected: "failed" } },
    { id: "ask_more", type: "script", next: { yes: "tell_joke", no: "done" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
] });

// A four-step retry loop: the old layout put all four on one row.
const retry = definitionOf({ name: "retry", initial: "fetch", states: [
    { id: "fetch", type: "script", next: { ok: "validate" } },
    { id: "validate", type: "script", next: { valid: "done", invalid: "backoff" } },
    { id: "backoff", type: "script", next: { elapsed: "count" } },
    { id: "count", type: "script", next: { again: "fetch", exhausted: "failed" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
] });

const quality = definitionOf({ name: "branching-workflow-test", initial: "collect_metrics", states: [
    { id: "collect_metrics", type: "script", next: { success: "evaluate_quality", failure: "failed" } },
    { id: "evaluate_quality", type: "script", next: { approved: "approved", blocked: "blocked", failure: "failed" } },
    { id: "approved", type: "terminal", outcome: "succeeded" },
    { id: "blocked", type: "terminal", outcome: "blocked" },
    { id: "failed", type: "terminal", outcome: "failed" },
] });

test("the owner's loop comes out top to bottom: each step below the one before it, and only 'yes' goes back up", () => {
    const layout = layoutWorkflowGraphTB(jokes);
    // R2: the failed end is a chip on review, not a box.
    assert.deepEqual([...layout.positions.keys()].sort(), ["ask_more", "done", "review", "tell_joke"]);
    assert.equal(layout.edges.length, 5);
    assert.deepEqual(layout.chips.get("review").map(chip => [chip.text, chip.tone]), [["rejected → ⏹ failed", "red"]]);
    assert.ok(top(layout, "review") > top(layout, "tell_joke"));
    assert.ok(top(layout, "ask_more") > top(layout, "review"));
    assert.ok(top(layout, "done") > top(layout, "ask_more"));
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

test("forward edges go downward, nothing is drawn out of a terminal, and blocked and failed ends are chips on the step that leads there", () => {
    const layout = layoutWorkflowGraphTB(quality);
    for (const edge of layout.edges) assert.ok(top(layout, edge.to) > top(layout, edge.from), `${name(edge)} goes down`);
    assert.deepEqual(upward(layout), []);
    // R2: the success end is a box; the blocked and failed ends are chips, and the Ends row lists each end once.
    assert.deepEqual([...layout.positions.keys()].sort(), ["approved", "collect_metrics", "evaluate_quality"]);
    assert.deepEqual(layout.edges.map(name), ["collect_metrics->evaluate_quality", "evaluate_quality->approved"]);
    assert.deepEqual(layout.chips.get("evaluate_quality").map(chip => [chip.key, chip.text, chip.tone]),
        [["chip:evaluate_quality:blocked", "⏹ blocked", "amber"], ["chip:evaluate_quality:failed", "failure → ⏹ failed", "red"]]);
    assert.deepEqual(layout.ends.map(end => [end.id, end.box, end.keys.length]), [["approved", true, 1], ["blocked", false, 1], ["failed", false, 2]]);
    assert.deepEqual([...layout.hidden].sort(), ["blocked", "failed"]);
    assertCurvesClearOfSteps(layout);
    assertInside(layout);
});

test("version 2: error routes into the failed end are ✕ badges, labels only where a line does not carry every outcome", () => {
    const layout = layoutWorkflowGraphTB(definitionOf(startedData));
    assert.deepEqual([...layout.positions.keys()].sort(), ["await_ack", "done", "notify", "pause", "poll"]);
    assert.equal(layout.edges.length, 5);
    // R1: poll's failure and timed_out and notify's delivery_failed end the run as failed: a badge each, no line.
    assert.equal(edgeOf(layout, "poll", "failed"), undefined);
    assert.deepEqual([layout.badges.get("poll").routes, layout.badges.get("poll").key, layout.badges.get("poll").title],
        [["failure", "timed_out"], "badge:poll", "Any error here ends the run: failed"]);
    assert.deepEqual(layout.badges.get("notify").routes, ["delivery_failed"]);
    // R3: a line that carries every business outcome of its step has no label; the others name theirs.
    assert.deepEqual(layout.edges.map(edge => [name(edge), edge.labelText]), [
        ["poll->notify", "changed"], ["poll->pause", "unchanged"], ["pause->poll", ""], ["notify->await_ack", ""], ["await_ack->done", ""]]);
    assert.equal(edgeOf(layout, "await_ack", "done").outcome, "received / elapsed");
    assert.equal(edgeOf(layout, "await_ack", "done").labelWidth, 0);
    assert.ok(top(layout, "pause") > top(layout, "poll"), "the wait is below the poll that leads to it");
    assert.deepEqual(upward(layout), ["pause->poll"]);
    assertCurvesClearOfSteps(layout);
    assertInside(layout);
});

// The owner's issue-to-pr Workflow, in its shape: 9 steps, 6 ends, a review loop, error routes into failed everywhere.
const issueToPr = workflowDefinition({ revision: 3, initial: "fetch_issue", states: [
    { id: "fetch_issue", type: "script", outcomes: ["ok", "not_open"], next: { ok: "acquire_env", not_open: "rejected", failure: "failed" } },
    { id: "acquire_env", type: "script", maxVisits: 37, outcomes: ["acquired", "busy", "create", "exhausted"],
        next: { acquired: "implement", busy: "wait_for_env", create: "create_env", exhausted: "no_env", failure: "failed" } },
    { id: "create_env", type: "script", maxVisits: 1, outcomes: ["created", "not_created", "exhausted"],
        next: { created: "acquire_env", not_created: "wait_for_env", exhausted: "wait_for_env", failure: "wait_for_env" } },
    { id: "wait_for_env", type: "wait", seconds: 600, outcomes: ["elapsed"], next: { elapsed: "acquire_env", failure: "failed" } },
    { id: "implement", type: "script", maxVisits: 6, outcomes: ["ready_for_review", "published", "declined", "exhausted"],
        next: { ready_for_review: "review", published: "finish", declined: "finish", exhausted: "finish", failure: "finish" } },
    { id: "review", type: "script", outcomes: ["approved", "changes_required"], next: { approved: "gate", changes_required: "gate", failure: "gate" } },
    { id: "gate", type: "script", outcomes: ["next"], next: { next: "renew", failure: "failed" } },
    { id: "renew", type: "script", outcomes: ["renewed"], next: { renewed: "implement", failure: "implement" } },
    { id: "finish", type: "script", outcomes: ["verified", "unverified", "declined", "error"],
        next: { verified: "done", unverified: "unverified", declined: "declined", error: "failed", failure: "failed" } },
    ...["done:succeeded", "unverified:blocked", "declined:blocked", "rejected:blocked", "no_env:blocked", "failed:failed"].map(item => {
        const [id, outcome] = item.split(":");
        return { id, type: "terminal", outcome };
    }),
] });

test("issue-to-pr: 10 boxes, 13 lines, 9 labels and no line into failed; the happy path is one straight column", () => {
    const layout = layoutWorkflowGraphTB(issueToPr);
    assert.equal(layout.positions.size, 10);
    assert.equal(layout.edges.length, 13);
    assert.deepEqual(layout.edges.filter(edge => edge.labelText).map(edge => edge.labelText).sort(),
        ["acquired", "busy", "create", "created", "not created · ⟳ · ✕", "ok", "published · declined · ⟳ · ✕", "ready for review", "verified"].sort());
    assert.equal(layout.edges.filter(edge => edge.to === "failed").length, 0);
    assert.deepEqual([...layout.badges.keys()].sort(), ["acquire_env", "fetch_issue", "finish", "gate", "wait_for_env"]);
    assert.deepEqual([...layout.chips].map(([step, list]) => [step, list.map(chip => chip.text)]), [
        ["fetch_issue", ["not open → ⏹ rejected"]], ["acquire_env", ["⟳ limit → ⏹ no_env"]],
        ["finish", ["⏹ unverified", "⏹ declined", "error → ⏹ failed"]]]);
    assert.deepEqual(layout.ends.map(end => [end.id, end.keys.length]),
        [["done", 1], ["unverified", 1], ["declined", 1], ["rejected", 1], ["no_env", 1], ["failed", 6]]);
    // R4: the happy path's lines are weighted, and its downward lines stand straight under each other.
    const spine = layout.edges.filter(edge => edge.spine).map(name);
    assert.deepEqual(spine.sort(), ["acquire_env->implement", "fetch_issue->acquire_env", "finish->done", "gate->renew", "implement->finish",
        "implement->review", "renew->implement", "review->gate"].sort());
    assert.ok(layout.edges.filter(edge => edge.spine).every(edge => edge.weight === 8));
    const centre = id => layout.positions.get(id).x + layout.positions.get(id).width / 2;
    for (const [from, to] of [["fetch_issue", "acquire_env"], ["acquire_env", "implement"], ["implement", "review"], ["review", "gate"], ["gate", "renew"]]) {
        assert.equal(centre(from), centre(to), `${from} stands over ${to}`);
    }
    // Every chip has room beside its step: nothing else is drawn there.
    for (const [step] of layout.chips) {
        const box = layout.positions.get(step);
        for (const [id, other] of layout.positions) {
            if (id === step || other.y + other.height <= box.y || other.y >= box.y + box.height) continue;
            assert.ok(other.x >= box.x + box.width + 100 || other.x + other.width <= box.x, `${id} leaves room for ${step}'s chips`);
        }
    }
    assertCurvesClearOfSteps(layout);
    assertInside(layout);
});

test("the root catchAll: every root step without a failure route carries the ✕ badge, and the catch-all's end counts its ways in", () => {
    const layout = layoutWorkflowGraphTB(workflowDefinition({ revision: 1, initial: "a", catchAll: "failed", states: [
        { id: "a", type: "script", outcomes: ["ok"], next: { ok: "b" } },
        { id: "b", type: "script", outcomes: ["ok"], next: { ok: "done", failure: "cleanup" } },
        { id: "cleanup", type: "script", outcomes: ["ok"], next: { ok: "failed" } },
        { id: "done", type: "terminal", outcome: "succeeded" },
        { id: "failed", type: "terminal", outcome: "failed" },
    ] }));
    assert.equal(layout.catchAll, "failed");
    assert.deepEqual([...layout.badges.values()].map(badge => [badge.step, badge.catchAll, badge.routes, badge.title]), [
        ["a", true, [], "Any error here ends the run: failed (catchAll)"],
        ["cleanup", true, [], "Any error here ends the run: failed (catchAll)"]]);
    assert.equal(layout.badges.has("b"), false, "a step with a failure route is not covered");
    assert.deepEqual(layout.chips.get("cleanup").map(chip => chip.text), ["ok → ⏹ failed"]);
    assert.deepEqual(layout.ends.find(end => end.id === "failed").keys.sort(), ["badge:a", "badge:cleanup", "chip:cleanup:failed"]);
    // Without a catchAll, nothing is covered.
    const plain = layoutWorkflowGraphTB(workflowDefinition({ revision: 1, initial: "a", states: [
        { id: "a", type: "script", outcomes: ["ok"], next: { ok: "done" } }, { id: "done", type: "terminal", outcome: "succeeded" }] }));
    assert.equal(plain.badges.size, 0);
});

// Owner batch 7 (H2): fork, branch box, join bar. An agent review leads to a parallel step whose body is a script and a
// branch end; the parallel step joins to done, and a blocked join or the review's timeout goes to failed.
const fanned = () => workflowDefinition({ revision: 1, initial: "review", states: [
    { id: "review", type: "agent", invoke: { source: "agent", name: "code-reviewer", package: "review-kit", version: "1.2.0" }, timeoutSeconds: 600,
        outcomes: ["accepted"], next: { accepted: "fan", timed_out: "failed" } },
    { id: "fan", type: "parallel", forEach: "${input.items}", concurrency: 2, join: "all_required", failFast: false,
        body: { initial: "work", states: ["work", "branch_done"] }, outcomes: ["joined", "blocked"], next: { joined: "done", blocked: "failed" } },
    { id: "work", type: "script", runtime: "node", timeoutSeconds: 300, outcomes: ["ok"], next: { ok: "branch_done" }, parallel: "fan" },
    { id: "branch_done", type: "terminal", outcome: "succeeded", parallel: "fan" },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
] });

/** `inner` lies inside `outer` (boxes { x, y, width, height }). */
const within = (inner, outer) => inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

test("a parallel step is its branch box's title, its branch's success end is its line into the join bar, and its routes leave from the bar", () => {
    const layout = layoutWorkflowGraphTB(fanned());
    assert.deepEqual([...layout.groups.keys()], ["fan"]);
    const group = layout.groups.get("fan");
    assert.deepEqual([group.id, group.parallel, group.members], ["group:fan", "fan", ["work", "branch_done"]]);
    // B1: the parallel step has no box of its own; B2: the branch end has none either.
    assert.deepEqual([...layout.positions.keys()].sort(), ["done", "review", "work"]);
    // Its steps are inside it, under its label; nothing else is.
    const steps = { x: group.x, y: group.y + WORKFLOW_GRAPH_GROUP_HEADER, width: group.width, height: group.height - WORKFLOW_GRAPH_GROUP_HEADER };
    assert.ok(within(layout.positions.get("work"), steps), "work is inside the branch box");
    for (const id of ["review", "done"]) {
        const box = layout.positions.get(id);
        const overlaps = box.x < group.x + group.width + group.stack && box.x + box.width > group.x
            && box.y < group.y + group.height + group.stack && box.y + box.height > group.y;
        assert.equal(overlaps, false, `${id} is outside the branch box and its stack`);
    }
    // The line into the parallel step enters its box at the top; no line fans out of it.
    const into = edgeOf(layout, "review", "group:fan");
    assert.deepEqual([into.kind, into.labelText, into.spine], ["outcome", "", true]);
    assert.ok(group.y > top(layout, "review") && Math.abs(into.points.at(-1)[1] - group.y) <= 1, "it ends at the top of the box");
    assert.ok(layout.edges.every(edge => !edge.branch && edge.from !== "fan" && edge.to !== "fan"));
    // The join bar is under the box; done is under the bar.
    const join = layout.joins.get("fan");
    assert.deepEqual([join.id, join.parallel], ["join:fan", "fan"]);
    assert.ok(join.y >= group.y + group.height, "the join bar is under the box");
    assert.ok(top(layout, "done") > join.y);
    // B2: work's line into the join bar is its branch's success end; it carries all of work's outcomes, so it has no label.
    const end = edgeOf(layout, "work", "join:fan");
    assert.deepEqual([end.kind, end.join, end.step, end.parallel, end.outcomes, end.labelText, end.labelWidth],
        ["join", true, "work", "fan", ["ok"], "", 0]);
    assert.deepEqual(end.points.at(-1), [end.points.at(-1)[0], join.y], "it ends on the bar");
    assert.ok(end.points.at(-1)[0] >= join.x && end.points.at(-1)[0] <= join.x + join.width);
    assert.ok(end.points[0][1] >= layout.positions.get("work").y, "it leaves from the step");
    // Joined leaves from the bar; blocked ends the run as failed: a chip on the parallel step (beside its bar).
    const joined = edgeOf(layout, "join:fan", "done");
    assert.deepEqual([joined.kind, joined.owner, joined.outcome, joined.labelText], ["outcome", "fan", "joined", "joined"]);
    assert.deepEqual(layout.chips.get("fan").map(chip => [chip.text, chip.tone]), [["blocked → ⏹ failed", "red"]]);
    assert.ok(join.x >= 0 && layout.width - (join.x + join.width) >= 100, "the bar's chips have room beside it");
    // review's time limit ends the run as failed: a badge.
    assert.deepEqual(layout.badges.get("review").routes, ["timed_out"]);
    assert.equal(layout.edges.length, 3);
    assertCurvesClearOfSteps(layout);
    assertInside(layout);
    for (const box of [group, join]) assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= layout.width && box.y + box.height <= layout.height);
    assert.ok(group.x + group.width + group.stack <= layout.width && group.y + group.height + group.stack <= layout.height, "the stack is drawn too");
});

test("bodies: a parallel step's body steps in body order, each step in one body; a graph without one has no box or bar", () => {
    const { bodies, memberOf } = workflowGraphBodies(fanned().states);
    assert.deepEqual([...bodies], [["fan", ["work", "branch_done"]]]);
    assert.deepEqual([...memberOf], [["work", "fan"], ["branch_done", "fan"]]);
    // A parallel step whose body names no step of the graph keeps the old 'each branch' edge and no box.
    const empty = workflowGraphBodies([{ id: "p", type: "parallel", body: { initial: "x", states: ["x"] } }]);
    assert.equal(empty.bodies.size, 0);
    for (const definition of [jokes, retry, quality, definitionOf(startedData)]) {
        const layout = layoutWorkflowGraphTB(definition);
        assert.deepEqual([layout.groups.size, layout.joins.size], [0, 0]);
        assert.ok(layout.edges.every(edge => !edge.join && !edge.owner));
    }
});

test("a moved branch box carries its steps and join bar; a step inside it is placed relative to it, under its own key", () => {
    const layout = layoutWorkflowGraphTB(fanned());
    const group = layout.groups.get("fan"), join = layout.joins.get("fan"), work = layout.positions.get("work");
    assert.equal(workflowPlaceKey(layout, "work"), "fan/work");
    assert.equal(workflowPlaceKey(layout, "group:fan"), "group:fan");
    assert.equal(workflowPlaceKey(layout, "review"), "review");
    assert.equal(workflowPlaceKey(layout, "join:fan"), null, "the join bar moves only with its box");
    assert.equal(workflowPlaceKey(layout, "nope"), null);
    // As laid out: every box where the layout put it, a step inside the box placed relative to it.
    const still = workflowGraphPlaces(layout);
    assert.deepEqual([still.get("work").x, still.get("work").y, still.get("work").parent], [work.x, work.y, "group:fan"]);
    assert.deepEqual(still.get("work").at, { x: work.x - group.x, y: work.y - group.y });
    assert.equal(still.get("review").parent, null);
    assert.ok([...still.values()].every(box => !box.moved));
    // The box moved: its steps and its bar move with it; nothing else does.
    const moved = workflowGraphPlaces(layout, new Map([["group:fan", { x: group.x + 100, y: group.y + 40 }]]));
    assert.deepEqual([moved.get("group:fan").dx, moved.get("group:fan").dy, moved.get("group:fan").self], [100, 40, true]);
    assert.deepEqual([moved.get("work").x, moved.get("work").y, moved.get("work").moved, moved.get("work").self], [work.x + 100, work.y + 40, true, false]);
    assert.deepEqual([moved.get("join:fan").x, moved.get("join:fan").y, moved.get("join:fan").moved], [join.x + 100, join.y + 40, true]);
    assert.equal(moved.get("review").moved, false);
    // A step moved inside the box keeps its place in it when the box moves too.
    const both = workflowGraphPlaces(layout, new Map([["group:fan", { x: group.x + 100, y: group.y }], ["fan/work", { x: 5, y: 60 }]]));
    assert.deepEqual([both.get("work").x, both.get("work").y, both.get("work").self], [group.x + 105, group.y + 60, true]);
    // A place saved under the bare step id (before the box existed) is not one inside it.
    const old = workflowGraphPlaces(layout, new Map([["work", { x: 0, y: 0 }]]));
    assert.deepEqual([old.get("work").x, old.get("work").y], [work.x, work.y]);
});

test("a step that loops on itself keeps one edge with its outcomes joined, beside the step", () => {
    const layout = layoutWorkflowGraphTB(definitionOf({ initial: "poll", states: [
        { id: "poll", type: "script", next: { unchanged: "poll", retry: "poll", changed: "end" } },
        { id: "end", type: "terminal", outcome: "succeeded" },
    ] }));
    assert.equal(layout.edges.length, 2);
    const loop = edgeOf(layout, "poll", "poll");
    assert.deepEqual([loop.outcome, loop.labelText, loop.back], ["unchanged / retry", "unchanged · retry", true]);
    const box = layout.positions.get("poll");
    assert.ok(loop.labelX > box.x + box.width, "the loop's label sits beside the step");
    // The loop leaves and enters the step's right side and never crosses the step.
    assert.ok(loop.points.every(([x]) => x >= box.x + box.width - 0.05));
    for (const [x, y] of samples(loop)) assert.ok(x >= box.x + box.width - 0.5, `the loop stays right of the step at ${x},${y}`);
    assertInside(layout);
});

test("an outcome is drawn in plain words, cut after 32 characters, and its box is sized to what is drawn", () => {
    assert.equal(workflowEdgeLabelText("short"), "short");
    assert.equal(workflowEdgeLabelText("exactly_twenty_chars"), "exactly_twenty_chars");
    assert.equal(workflowEdgeLabelText("a_very_long_outcome_name_indeed"), "a_very_long_outcome…");
    const layout = layoutWorkflowGraphTB(definitionOf({ initial: "a", states: [
        { id: "a", type: "script", next: { a_very_long_outcome_name_that_goes_on: "b", other: "c" } },
        { id: "b", type: "terminal", outcome: "succeeded" },
        { id: "c", type: "terminal", outcome: "succeeded" },
    ] }));
    const edge = edgeOf(layout, "a", "b");
    assert.equal(edge.outcome, "a_very_long_outcome_name_that_goes_on");
    assert.equal(edge.labelText, "a very long outcome name that g…");
    assert.equal(edgeOf(layout, "a", "c").labelText, "other");
    assert.ok(edge.labelWidth > edgeOf(layout, "a", "c").labelWidth);
    // A line that carries every outcome of its step has no label and takes no room.
    const one = edgeOf(layoutWorkflowGraphTB(definitionOf({ initial: "a", states: [
        { id: "a", type: "script", next: { ok: "b" } }, { id: "b", type: "terminal", outcome: "succeeded" },
    ] })), "a", "b");
    assert.deepEqual([one.labelText, one.labelWidth], ["", 0]);
    assertInside(layout);
});

test("the same definition always gives the same layout", () => {
    const snapshot = layout => JSON.stringify({ width: layout.width, height: layout.height, positions: [...layout.positions], edges: layout.edges });
    for (const definition of [jokes, retry, quality, definitionOf(startedData), fanned()]) {
        assert.equal(snapshot(layoutWorkflowGraphTB(definition)), snapshot(layoutWorkflowGraphTB(definition)));
    }
});

test("an empty graph, a single step, disconnected steps and object-key ids lay out", () => {
    const empty = layoutWorkflowGraphTB({ states: [] });
    assert.deepEqual([empty.positions.size, empty.edges.length, empty.width, empty.height], [0, 0, 300, 150]);
    assert.equal(layoutWorkflowGraphTB(null).positions.size, 0);
    const single = layoutWorkflowGraphTB(definitionOf({ initial: "only", states: [{ id: "only", type: "terminal", outcome: "succeeded" }] }));
    assert.equal(single.positions.size, 1);
    assert.deepEqual(single.edges, []);
    assertInside(single);
    const special = layoutWorkflowGraphTB(definitionOf({ initial: "__proto__", states: [
        { id: "__proto__", type: "script", next: { next: "constructor" } },
        { id: "constructor", type: "script", next: { again: "__proto__" } },
        { id: "isolated", type: "terminal", outcome: "succeeded" },
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
