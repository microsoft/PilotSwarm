// The portal's top-to-bottom workflow graph layout (owner batch 5, g-01): dagre ranks, orders and routes the graph;
// edges are smooth curves through dagre's points. The terminal keeps its own layout (workflow-view.test.mjs).
//
// Run: node --test packages/app/ui/core/test/workflow-graph-layout.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    layoutWorkflowGraphTB, workflowBoundaryEventAt, workflowEdgeCurve, workflowEdgeLabelText, workflowGraphBodies, workflowGraphEdgeKey, workflowGraphErrorEdgeKey,
    workflowGraphPlaces, workflowHandlerArrows, workflowPlaceKey, WORKFLOW_BOUNDARY_EVENT_INSET, WORKFLOW_GRAPH_GROUP_HEADER, WORKFLOW_GRAPH_NODE_WIDTH,
    WORKFLOW_GRAPH_NODE_HEIGHT,
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
/** The business line and the dashed line of error routes between two boxes, by their keys. */
const lineOf = (layout, from, to) => layout.edges.find(edge => edge.key === workflowGraphEdgeKey(from, to));
const errorLineOf = (layout, from, to) => layout.edges.find(edge => edge.key === workflowGraphErrorEdgeKey(from, to));
const top = (layout, id) => layout.positions.get(id).y;
const name = edge => `${edge.from}->${edge.to}`;
const r = value => Math.round(value * 10) / 10;

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

test("version 2: error routes into the failed end are error handlers (a boundary event on the step, no line, no chip), labels only where a line does not carry every outcome", () => {
    const layout = layoutWorkflowGraphTB(definitionOf(startedData));
    assert.deepEqual([...layout.positions.keys()].sort(), ["await_ack", "done", "notify", "pause", "poll"]);
    assert.equal(layout.edges.length, 5);
    // R1: poll's failure and timed_out and notify's delivery_failed are error handlers into the failed end, one per step
    // and end: no line, no badge, no chip; the failed end has no box (its handlers' arrows end at a ghost of it).
    assert.equal(edgeOf(layout, "poll", "failed"), undefined);
    assert.ok(layout.edges.every(edge => edge.kind === "outcome" && !edge.error), "every line carries business routes only");
    assert.ok(layout.edges.every(edge => edge.key === workflowGraphEdgeKey(edge.from, edge.to)), "every line has its key");
    assert.deepEqual(layout.handlers.get("poll"), [{ key: "handler:poll:failed", step: "poll", from: "poll", end: "failed", outcome: "failed",
        routes: ["failure", "timed_out"], kinds: ["error"], words: "on error", catchAll: false, index: 0 }]);
    assert.deepEqual(layout.handlers.get("notify").map(handler => [handler.key, handler.routes, handler.kinds, handler.words, handler.end, handler.index]),
        [["handler:notify:failed", ["delivery_failed"], ["error"], "on error", "failed", 0]]);
    // Each handler is a boundary event on its step, keyed as its handler: what it catches and the end it leads to.
    const title = "Error handler: on error → end failed. Select the step to see where its errors go.";
    assert.deepEqual([...layout.marks], [
        ["poll", [{ step: "poll", key: "handler:poll:failed", end: "failed", words: "on error", index: 0, title }]],
        ["notify", [{ step: "notify", key: "handler:notify:failed", end: "failed", words: "on error", index: 0, title }]]]);
    assert.equal(layout.badges, undefined, "no ✕ badge any more");
    assert.equal(layout.chips.size, 0, "an error route is never a chip");
    assert.deepEqual(layout.ends.map(end => [end.id, end.box, end.keys]), [
        ["done", true, [JSON.stringify(["await_ack", "done"])]], ["failed", false, ["handler:poll:failed", "handler:notify:failed"]]]);
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

test("issue-to-pr: 10 boxes, 13 business lines and 4 dashed error lines (9 business labels, 4 error labels); error routes into ends are handlers, error routes between steps are dashed lines; the happy path is one straight column", () => {
    const layout = layoutWorkflowGraphTB(issueToPr);
    assert.equal(layout.positions.size, 10);
    assert.equal(layout.edges.length, 17);
    const business = layout.edges.filter(edge => !edge.error);
    const errors = layout.edges.filter(edge => edge.error);
    assert.deepEqual([business.length, errors.length], [13, 4]);
    // Every line has its key: a business line its pair's (workflowGraphEdgeKey), a line of error routes its own.
    assert.ok(business.every(edge => edge.key === workflowGraphEdgeKey(edge.from, edge.to)));
    assert.ok(errors.every(edge => edge.key === workflowGraphErrorEdgeKey(edge.from, edge.to)));
    // R3: a business line's label is its business outcomes in plain words, never a ✕ or ⟳ glyph.
    assert.deepEqual(business.filter(edge => edge.labelText).map(edge => edge.labelText).sort(),
        ["acquired", "busy", "create", "created", "not created", "ok", "published · declined", "ready for review", "verified"].sort());
    assert.deepEqual([lineOf(layout, "create_env", "wait_for_env").outcomes, lineOf(layout, "implement", "finish").outcomes],
        [["not_created"], ["published", "declined"]]);
    assert.ok(business.every(edge => edge.kind === "outcome" && !/[✕⟳]/.test(edge.labelText)), "business lines carry business routes only");
    // R1 (12:05 PST): the error and limit routes between two steps are a grey dashed line of their own, labelled with what they catch.
    assert.deepEqual(errors.map(edge => [name(edge), edge.kind, edge.outcomes, edge.kinds, edge.words, edge.labelText]), [
        ["create_env->wait_for_env", "error", ["exhausted", "failure"], ["error", "limit"], "on error · limit", "on error · limit"],
        ["implement->finish", "error", ["exhausted", "failure"], ["error", "limit"], "on error · limit", "on error · limit"],
        ["review->gate", "error", ["failure"], ["error"], "on error", "on error"],
        ["renew->implement", "error", ["failure"], ["error"], "on error", "on error"]]);
    assert.ok(errors.every(edge => !edge.catchAll && !/[✕⟳]/.test(edge.labelText)), "no glyph on an error line either");
    assert.equal(layout.edges.filter(edge => edge.to === "failed").length, 0);
    // R1: the error and limit routes into an end are an error handler, one per step and end, numbered on its step: errors
    // before the visit limit, whatever order the routes are listed in.
    assert.deepEqual([...layout.handlers].map(([step, list]) => [step, list.map(handler => [handler.key, handler.from, handler.end, handler.outcome,
        handler.routes, handler.kinds, handler.words, handler.index])]), [
        ["fetch_issue", [["handler:fetch_issue:failed", "fetch_issue", "failed", "failed", ["failure"], ["error"], "on error", 0]]],
        ["acquire_env", [["handler:acquire_env:failed", "acquire_env", "failed", "failed", ["failure"], ["error"], "on error", 0],
            ["handler:acquire_env:no_env", "acquire_env", "no_env", "blocked", ["exhausted"], ["limit"], "on limit", 1]]],
        ["wait_for_env", [["handler:wait_for_env:failed", "wait_for_env", "failed", "failed", ["failure"], ["error"], "on error", 0]]],
        ["gate", [["handler:gate:failed", "gate", "failed", "failed", ["failure"], ["error"], "on error", 0]]],
        ["finish", [["handler:finish:failed", "finish", "failed", "failed", ["failure"], ["error"], "on error", 0]]]]);
    assert.ok([...layout.handlers.values()].flat().every(handler => !handler.catchAll && !("to" in handler) && !("target" in handler)));
    for (const step of ["create_env", "implement", "review", "renew"]) assert.equal(layout.handlers.has(step), false, `${step}'s errors are a line, not a handler`);
    // Each handler is one boundary event on its step.
    assert.deepEqual(layout.marks.get("acquire_env").map(mark => [mark.key, mark.end, mark.words, mark.index, mark.title]), [
        ["handler:acquire_env:failed", "failed", "on error", 0, "Error handler: on error → end failed. Select the step to see where its errors go."],
        ["handler:acquire_env:no_env", "no_env", "on limit", 1, "Error handler: on limit → end no_env. Select the step to see where its errors go."]]);
    assert.deepEqual([...layout.marks.keys()], [...layout.handlers.keys()]);
    // R2: chips come from business routes only: acquire_env's visit limit into no_env is its handler, not a chip.
    assert.deepEqual([...layout.chips].map(([step, list]) => [step, list.map(chip => [chip.text, chip.tone])]), [
        ["fetch_issue", [["not open → ⏹ rejected", "amber"]]],
        ["finish", [["⏹ unverified", "amber"], ["⏹ declined", "amber"], ["error → ⏹ failed", "red"]]]]);
    assert.deepEqual(layout.ends.map(end => [end.id, end.keys]), [
        ["done", [JSON.stringify(["finish", "done"])]], ["unverified", ["chip:finish:unverified"]], ["declined", ["chip:finish:declined"]],
        ["rejected", ["chip:fetch_issue:rejected"]], ["no_env", ["handler:acquire_env:no_env"]],
        ["failed", ["chip:finish:failed", "handler:fetch_issue:failed", "handler:acquire_env:failed", "handler:wait_for_env:failed",
            "handler:gate:failed", "handler:finish:failed"]]]);
    // R4: the happy path's lines are weighted, and its downward lines stand straight under each other. It never takes a
    // line of error routes: those are drawn beside their business line, or laid out lightly after the business lines.
    const spine = layout.edges.filter(edge => edge.spine).map(name);
    assert.deepEqual(spine.sort(), ["acquire_env->implement", "fetch_issue->acquire_env", "finish->done", "gate->renew", "implement->finish",
        "implement->review", "renew->implement", "review->gate"].sort());
    assert.ok(layout.edges.filter(edge => edge.spine).every(edge => edge.weight === 8 && !edge.error));
    assert.ok(errors.every(edge => !edge.spine && edge.weight === undefined));
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

test("the happy path follows each step's declared outcomes, also from a stored graph that lists states and routes by name", () => {
    const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const stored = workflowDefinition({ ...issueToPr, states: [...issueToPr.states].sort((a, b) => byName(a.id, b.id)).map(state => (state.next
        ? { ...state, next: Object.fromEntries(Object.entries(state.next).sort(([a], [b]) => byName(a, b))) } : state)) });
    const spineOf = layout => layout.edges.filter(edge => edge.spine).map(name).sort();
    assert.deepEqual(spineOf(layoutWorkflowGraphTB(stored)), spineOf(layoutWorkflowGraphTB(issueToPr)));
    const layout = layoutWorkflowGraphTB(stored);
    const centre = id => layout.positions.get(id).x + layout.positions.get(id).width / 2;
    for (const [from, to] of [["fetch_issue", "acquire_env"], ["acquire_env", "implement"], ["implement", "review"], ["review", "gate"], ["gate", "renew"]]) {
        assert.equal(centre(from), centre(to), `${from} stands over ${to}`);
    }
});

test("an error route to another step is a dashed line of its own beside the business line between the same two steps, drawn as that line moved 14 px aside", () => {
    const layout = layoutWorkflowGraphTB(issueToPr);
    assert.equal(workflowGraphErrorEdgeKey("review", "gate"), JSON.stringify(["review", "gate", "error"]));
    // review -> gate: approved and changes_required share the business line (no label: every business outcome of review);
    // its failure is the dashed line beside it, a line of its own with its own key.
    const review = lineOf(layout, "review", "gate"), reviewError = errorLineOf(layout, "review", "gate");
    assert.notEqual(review.key, reviewError.key);
    assert.deepEqual([review.error, review.kind, review.outcomes, review.labelText, review.spine], [undefined, "outcome", ["approved", "changes_required"], "", true]);
    assert.deepEqual([reviewError.from, reviewError.to, reviewError.error, reviewError.kind, reviewError.outcome, reviewError.outcomes, reviewError.kinds,
        reviewError.words, reviewError.labelText], ["review", "gate", true, "error", "failure", ["failure"], ["error"], "on error", "on error"]);
    // A line straight down: its twin moved 14 px to the right; its label right of both lines, level with the twin's.
    assert.deepEqual(reviewError.points, review.points.map(([x, y]) => [r(x + 14), y]));
    assert.equal(reviewError.labelY, review.labelY);
    assert.ok(reviewError.labelX - reviewError.labelWidth / 2 > review.labelX + 14, "its label stands right of both lines");
    assert.equal(reviewError.back, review.back);
    // Any twin: it starts and ends on the edges of its two boxes (never inside them), its inner points 14 px from the
    // twin's, and it goes the same way.
    const onEdge = ([x, y], box) => x >= box.x - 0.1 && x <= box.x + box.width + 0.1 && y >= box.y - 0.1 && y <= box.y + box.height + 0.1
        && [x - box.x, box.x + box.width - x, y - box.y, box.y + box.height - y].some(gap => Math.abs(gap) < 0.1);
    for (const [from, to] of [["review", "gate"], ["implement", "finish"], ["renew", "implement"], ["create_env", "wait_for_env"]]) {
        const twin = lineOf(layout, from, to), line = errorLineOf(layout, from, to);
        assert.equal(line.points.length, twin.points.length, `${from}->${to}`);
        assert.ok(onEdge(line.points[0], layout.positions.get(from)) && onEdge(line.points.at(-1), layout.positions.get(to)), `${from}->${to} ${JSON.stringify(line.points)}`);
        line.points.slice(1, -1).forEach(([x, y], index) => {
            const [tx, ty] = twin.points[index + 1];
            assert.ok(Math.abs(Math.hypot(x - tx, y - ty) - 14) < 0.2, `${from}->${to} inner point ${index}`);
        });
        assert.equal(line.back, twin.back);
        assert.match(line.path, /^M[\d.]+,[\d.]+( [LC][\d., ]+)+$/, `${from}->${to}`);
    }
    // A line that runs mostly across: its label just past the twin's label.
    const implement = lineOf(layout, "implement", "finish"), implementError = errorLineOf(layout, "implement", "finish");
    assert.ok(Math.abs(implementError.labelX - (implement.labelX + implement.labelWidth / 2 + 6 + implementError.labelWidth / 2)) < 0.06);
    assert.equal(implementError.labelY, implement.labelY);
    // The line that closes the loop (renew -> implement goes back up) is moved aside too, still going back.
    assert.deepEqual([lineOf(layout, "renew", "implement").back, errorLineOf(layout, "renew", "implement").back], [true, true]);
    assertInside(layout);
});

test("every line starts and ends on its steps' cards, also beside a step's end chips (dagre lays it out with their room)", () => {
    // issue-batch's collect step: its chip (nothing -> no_prs) widens its laid box; dry run leaves it for a second success end.
    const T = (id, outcome) => ({ id, type: "terminal", outcome });
    const layout = layoutWorkflowGraphTB(workflowDefinition({ revision: 1, initial: "fetch", states: [
        { id: "fetch", type: "script", outcomes: ["ok"], next: { ok: "collect" } },
        { id: "collect", type: "script", outcomes: ["merge", "nothing", "dry_run"], next: { merge: "merge", nothing: "no_prs", dry_run: "trial_done", failure: "failed" } },
        { id: "merge", type: "script", outcomes: ["merged", "blocked"], next: { merged: "report", blocked: "report" } },
        { id: "report", type: "script", outcomes: ["done", "incomplete"], next: { done: "done", incomplete: "incomplete" } },
        T("done", "succeeded"), T("trial_done", "succeeded"), T("no_prs", "blocked"), T("incomplete", "blocked"), T("failed", "failed")] }));
    assert.deepEqual(layout.chips.get("collect").map(chip => chip.text), ["nothing → ⏹ no_prs"]);
    const onEdge = ([x, y], box) => x >= box.x - 0.6 && x <= box.x + box.width + 0.6 && y >= box.y - 0.6 && y <= box.y + box.height + 0.6
        && [x - box.x, box.x + box.width - x, y - box.y, box.y + box.height - y].some(gap => Math.abs(gap) < 0.6);
    for (const check of [layout, layoutWorkflowGraphTB(issueToPr)]) {
        for (const edge of check.edges.filter(item => item.from !== item.to)) {
            assert.ok(onEdge(edge.points[0], check.positions.get(edge.from)), `${name(edge)} starts on ${edge.from}: ${JSON.stringify(edge.points[0])}`);
            assert.ok(onEdge(edge.points.at(-1), check.positions.get(edge.to)), `${name(edge)} ends on ${edge.to}: ${JSON.stringify(edge.points.at(-1))}`);
        }
    }
    assertInside(layout);
});

test("a step's boundary events: one per error handler, on its bottom edge 22 px apart from its right corner; each handler's arrow leaves its own", () => {
    const box = { x: 100, y: 40, width: 202, height: 66 };
    assert.equal(WORKFLOW_BOUNDARY_EVENT_INSET, 22);
    assert.deepEqual([0, 1, 2].map(index => workflowBoundaryEventAt(box, index)), [[280, 106], [258, 106], [236, 106]]);
    const layout = layoutWorkflowGraphTB(issueToPr);
    // acquire_env has two handlers: its errors first (#0, nearest the corner), then its visit limit (#1).
    assert.deepEqual(layout.handlers.get("acquire_env").map(handler => [handler.end, handler.index]), [["failed", 0], ["no_env", 1]]);
    assert.deepEqual(layout.marks.get("acquire_env").map(mark => [mark.key, mark.index]), [["handler:acquire_env:failed", 0], ["handler:acquire_env:no_env", 1]]);
    const step = layout.positions.get("acquire_env");
    const starts = [0, 1].map(index => workflowBoundaryEventAt(step, index));
    assert.deepEqual(starts, [[step.x + step.width - 22, step.y + step.height], [step.x + step.width - 44, step.y + step.height]]);
    const arrows = workflowHandlerArrows(layout, new Map(layout.positions), { selectedId: "acquire_env" });
    assert.deepEqual(arrows.map(arrow => arrow.path.split(" ")[0]), starts.map(([x, y]) => `M${r(x)},${r(y)}`));
    // The order is the same from a stored graph, which lists its routes by name.
    const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const stored = layoutWorkflowGraphTB(workflowDefinition({ ...issueToPr, states: issueToPr.states.map(state => (state.next
        ? { ...state, next: Object.fromEntries(Object.entries(state.next).sort(([a], [b]) => byName(a, b))) } : state)) }));
    assert.deepEqual(stored.handlers.get("acquire_env").map(handler => [handler.end, handler.index]), [["failed", 0], ["no_env", 1]]);
});

test("error handlers' dashed arrows: the selected step's, every one, those into the hovered end or a replay's; each from its boundary event to a ghost of its end", () => {
    const layout = layoutWorkflowGraphTB(issueToPr);
    const boxes = new Map(layout.positions);
    assert.deepEqual(workflowHandlerArrows(layout, boxes), [], "none until a step is selected");
    // From the step's boundary events to ghosts of the ends beside it, one under the other, the words above each ghost.
    const acquire = workflowHandlerArrows(layout, boxes, { selectedId: "acquire_env" });
    assert.deepEqual(acquire.map(arrow => [arrow.key, arrow.step, arrow.end, arrow.words, arrow.ghost.end, arrow.ghost.outcome]), [
        ["handler:acquire_env:failed", "acquire_env", "failed", "on error", "failed", "failed"],
        ["handler:acquire_env:no_env", "acquire_env", "no_env", "on limit", "no_env", "blocked"]]);
    assert.ok(acquire.every(arrow => !("target" in arrow)), "an arrow always ends at a ghost of its end");
    const step = layout.positions.get("acquire_env");
    acquire.forEach((arrow, index) => {
        const [x, y] = workflowBoundaryEventAt(step, index);
        assert.ok(arrow.path.startsWith(`M${r(x)},${r(y)} C`), arrow.path);
        assert.deepEqual([arrow.ghost.x, arrow.ghost.y], [r(step.x + step.width + 60 + 11), r(step.y + step.height + 20 + index * 44)]);
        // The second ghost's words stand clear of the first ghost (radius 11, words 18 high, 20 above their ghost).
        if (index > 0) assert.ok(arrow.labelY - 9 > acquire[index - 1].ghost.y + 11, "the words clear the ghost above");
        assert.ok(arrow.path.endsWith(` ${r(arrow.ghost.x - 13)},${r(arrow.ghost.y)}`), arrow.path);
        assert.deepEqual([arrow.labelX, arrow.labelY], [r(arrow.ghost.x - 34), r(arrow.ghost.y - 20)]);
        assert.deepEqual([arrow.litCount, arrow.litAge, arrow.current, arrow.tag], [0, null, false, null]);
    });
    // A step with end chips: its ghost stands past the chips' room.
    const [finish] = workflowHandlerArrows(layout, boxes, { selectedId: "finish" });
    const finishBox = layout.positions.get("finish");
    assert.equal(finish.ghost.x, r(finishBox.x + finishBox.width + layout.chipRoom.get("finish") + 71));
    // A step whose errors go to another step has no handler: its dashed line is always drawn, and selecting it adds no arrow.
    assert.deepEqual(workflowHandlerArrows(layout, boxes, { selectedId: "implement" }), []);
    // Show all handlers: every one; an end hovered in the Ends row: those into it.
    assert.equal(workflowHandlerArrows(layout, boxes, { all: true }).length, 6);
    // Every ghost end and its words fit inside the drawing, so a fitted view shows them all.
    for (const arrow of workflowHandlerArrows(layout, boxes, { all: true })) {
        assert.ok(arrow.ghost.x + 11 + 16 + arrow.ghost.end.length * 7 <= layout.width && arrow.ghost.y + 11 <= layout.height, arrow.key);
    }
    assert.deepEqual(workflowHandlerArrows(layout, boxes, { hoverEnd: "failed" }).map(arrow => arrow.key),
        ["handler:fetch_issue:failed", "handler:acquire_env:failed", "handler:wait_for_env:failed", "handler:gate:failed", "handler:finish:failed"]);
    // A replay lights the handler a transition took; the one shown now carries the transition's words.
    const lit = { edges: new Map([["handler:gate:failed", { count: 1, age: 0 }]]), transition: { edgeKey: "handler:gate:failed", words: "✕ script failed" } };
    assert.deepEqual(workflowHandlerArrows(layout, boxes, { lit }).map(arrow => [arrow.key, arrow.litCount, arrow.litAge, arrow.current, arrow.tag]),
        [["handler:gate:failed", 1, 0, true, "✕ script failed"]]);
});

test("the root catchAll: a root step without a failure route has an error handler to it when it is an end (its boundary event says catchAll) and a dashed error line to it when it is a step; the catch-all's end counts its ways in", () => {
    const layout = layoutWorkflowGraphTB(workflowDefinition({ revision: 1, initial: "a", catchAll: "failed", states: [
        { id: "a", type: "script", outcomes: ["ok"], next: { ok: "b" } },
        { id: "b", type: "script", outcomes: ["ok"], next: { ok: "done", failure: "cleanup" } },
        { id: "cleanup", type: "script", outcomes: ["ok"], next: { ok: "failed" } },
        { id: "done", type: "terminal", outcome: "succeeded" },
        { id: "failed", type: "terminal", outcome: "failed" },
    ] }));
    assert.equal(layout.catchAll, "failed");
    assert.deepEqual([...layout.handlers.values()].flat().map(handler => [handler.key, handler.end, handler.routes, handler.words, handler.catchAll, handler.index]), [
        ["handler:a:failed", "failed", [], "on error", true, 0],
        ["handler:cleanup:failed", "failed", [], "on error", true, 0]]);
    // A step with a failure route is not covered: its own route takes its errors, here into the step cleanup, a dashed
    // line, not a handler. With no business line beside it, dagre lays it out, lightly: the happy path stays one column.
    assert.equal(layout.handlers.has("b"), false);
    const caught = errorLineOf(layout, "b", "cleanup");
    assert.deepEqual([caught.kind, caught.outcomes, caught.kinds, caught.words, caught.labelText, caught.catchAll],
        ["error", ["failure"], ["error"], "on error", "on error", undefined]);
    assert.equal(lineOf(layout, "b", "cleanup"), undefined, "no business line between b and cleanup");
    assert.ok(caught.points.length >= 2 && caught.labelWidth > 0 && !caught.spine);
    const centre = id => layout.positions.get(id).x + layout.positions.get(id).width / 2;
    assert.deepEqual([centre("b"), centre("done")], [centre("a"), centre("a")]);
    assert.deepEqual([...layout.marks].map(([id, list]) => [id, list.map(mark => [mark.key, mark.title])]), [
        ["a", [["handler:a:failed", "Error handler: on error → end failed (catchAll). Select the step to see where its errors go."]]],
        ["cleanup", [["handler:cleanup:failed", "Error handler: on error → end failed (catchAll). Select the step to see where its errors go."]]]]);
    assert.deepEqual(layout.chips.get("cleanup").map(chip => chip.text), ["ok → ⏹ failed"]);
    assert.deepEqual(layout.ends.find(end => end.id === "failed").keys.sort(), ["chip:cleanup:failed", "handler:a:failed", "handler:cleanup:failed"]);
    // A catch-all that is a step: no handler; a covered step's errors are a dashed line to it (route "@catchAll", catchAll),
    // shared with the step's own error routes to it; it covers neither itself nor a step with a failure route.
    const covered = layoutWorkflowGraphTB(workflowDefinition({ revision: 1, initial: "a", catchAll: "cleanup", states: [
        { id: "a", type: "script", outcomes: ["ok"], next: { ok: "b", timed_out: "cleanup" } },
        { id: "b", type: "script", outcomes: ["ok"], next: { ok: "done", failure: "cleanup" } },
        { id: "cleanup", type: "script", outcomes: ["ok"], next: { ok: "failed" } },
        { id: "done", type: "terminal", outcome: "succeeded" },
        { id: "failed", type: "terminal", outcome: "failed" },
    ] }));
    assert.deepEqual([covered.handlers.size, covered.marks.size], [0, 0]);
    assert.deepEqual(covered.edges.filter(edge => edge.error).map(edge => [edge.key, edge.outcomes, edge.words, edge.catchAll ?? false]), [
        [workflowGraphErrorEdgeKey("a", "cleanup"), ["timed_out", "@catchAll"], "on error", true],
        [workflowGraphErrorEdgeKey("b", "cleanup"), ["failure"], "on error", false]]);
    assert.equal(covered.edges.some(edge => edge.from === "cleanup" && edge.error), false, "the catch-all state is not covered by itself");
    // A covered step with no error route of its own: its dashed line is the catchAll's alone.
    const only = layoutWorkflowGraphTB(workflowDefinition({ revision: 1, initial: "a", catchAll: "cleanup", states: [
        { id: "a", type: "script", outcomes: ["ok"], next: { ok: "done" } },
        { id: "cleanup", type: "script", outcomes: ["ok"], next: { ok: "failed" } },
        { id: "done", type: "terminal", outcome: "succeeded" },
        { id: "failed", type: "terminal", outcome: "failed" },
    ] }));
    const line = errorLineOf(only, "a", "cleanup");
    assert.deepEqual([line.from, line.to, line.kind, line.outcome, line.outcomes, line.kinds, line.words, line.labelText, line.catchAll],
        ["a", "cleanup", "error", "@catchAll", ["@catchAll"], ["error"], "on error", "on error", true]);
    assert.deepEqual([only.handlers.size, only.marks.size, only.edges.filter(edge => edge.error).length], [0, 0, 1]);
    // Without a catchAll, nothing is covered.
    const plain = layoutWorkflowGraphTB(workflowDefinition({ revision: 1, initial: "a", states: [
        { id: "a", type: "script", outcomes: ["ok"], next: { ok: "done" } }, { id: "done", type: "terminal", outcome: "succeeded" }] }));
    assert.deepEqual([plain.handlers.size, plain.marks.size], [0, 0]);
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
    // R1: review's time limit (timed_out, a runtime-error route) is an error handler to a ghost of the failed end: no line, no chip.
    assert.deepEqual(layout.handlers.get("review"), [{ key: "handler:review:failed", step: "review", from: "review", end: "failed", outcome: "failed",
        routes: ["timed_out"], kinds: ["error"], words: "on error", catchAll: false, index: 0 }]);
    assert.deepEqual([...layout.marks.keys()], ["review"]);
    assert.deepEqual(layout.ends.find(end => end.id === "failed").keys, ["chip:fan:failed", "handler:review:failed"]);
    assert.equal(layout.edges.length, 3);
    assertCurvesClearOfSteps(layout);
    assertInside(layout);
    for (const box of [group, join]) assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= layout.width && box.y + box.height <= layout.height);
    assert.ok(group.x + group.width + group.stack <= layout.width && group.y + group.height + group.stack <= layout.height, "the stack is drawn too");
});

test("a parallel step's error handler leaves its join bar; a handler into a branch's success end goes to a ghost of that end", () => {
    const base = fanned();
    const layout = layoutWorkflowGraphTB({ ...base, states: base.states.map(node => (node.id === "fan" ? { ...node, next: { ...node.next, failure: "failed" } }
        : node.id === "work" ? { ...node, next: { ok: "branch_done", failure: "branch_done" } } : node)) });
    assert.deepEqual(layout.handlers.get("fan").map(handler => [handler.key, handler.from, handler.end, handler.outcome, handler.routes, handler.index]),
        [["handler:fan:failed", "join:fan", "failed", "failed", ["failure"], 0]]);
    assert.deepEqual(layout.handlers.get("work").map(handler => [handler.key, handler.from, handler.end, handler.outcome, handler.words, handler.index]),
        [["handler:work:branch_done", "work", "branch_done", "succeeded", "on error", 0]]);
    assert.deepEqual([...layout.marks].map(([step, list]) => [step, list.map(mark => mark.key)]),
        [["review", ["handler:review:failed"]], ["fan", ["handler:fan:failed"]], ["work", ["handler:work:branch_done"]]]);
    // Its business routes are unchanged: work's line into the bar, blocked a chip beside the bar.
    assert.deepEqual(edgeOf(layout, "work", "join:fan").outcomes, ["ok"]);
    assert.deepEqual(layout.chips.get("fan").map(chip => chip.text), ["blocked → ⏹ failed"]);
    const join = layout.joins.get("fan");
    const boxes = new Map([...layout.positions, [join.id, join]]);
    // The parallel step's boundary event is on its join bar's bottom edge; its ghost stands past the bar's chips, under the bar.
    const [fan] = workflowHandlerArrows(layout, boxes, { selectedId: "fan" });
    const [eventX, eventY] = workflowBoundaryEventAt(join, 0);
    assert.deepEqual([eventX, eventY], [join.x + join.width - 22, join.y + join.height]);
    assert.ok(fan.path.startsWith(`M${r(eventX)},${r(eventY)} C`), fan.path);
    assert.deepEqual([fan.end, fan.ghost.end, fan.ghost.outcome], ["failed", "failed", "failed"]);
    assert.equal(fan.ghost.x, r(join.x + join.width + layout.chipRoom.get("fan") + 71), "the ghost stands past the bar's chips");
    assert.ok(fan.ghost.y >= join.y + join.height + 20, "the ghost stands under the bar");
    const [work] = workflowHandlerArrows(layout, boxes, { selectedId: "work" });
    assert.deepEqual([work.end, work.ghost.end, work.ghost.outcome], ["branch_done", "branch_done", "succeeded"]);
    const workBox = layout.positions.get("work");
    assert.ok(work.path.startsWith(`M${r(workBox.x + workBox.width - 22)},${r(workBox.y + workBox.height)} C`), work.path);
    // An end with a box of its own (the root's success end) is a ghost too: a handler's arrow always ends at a ghost of its end.
    const intoDone = layoutWorkflowGraphTB({ ...base, states: base.states.map(node => (node.id === "review" ? { ...node, next: { ...node.next, timed_out: "done" } } : node)) });
    assert.deepEqual(intoDone.handlers.get("review").map(handler => [handler.end, handler.outcome, handler.words]), [["done", "succeeded", "on error"]]);
    assert.deepEqual(intoDone.ends.find(end => end.id === "done").keys, [JSON.stringify(["join:fan", "done"]), "handler:review:done"]);
    assert.equal(intoDone.edges.some(edge => edge.from === "review" && edge.to === "done"), false, "no line into the end");
});

test("a step that handles its own errors has a dashed error loop beside it (a line, not a handler); a body of ends only is an empty box", () => {
    const layout = layoutWorkflowGraphTB(workflowDefinition({ revision: 1, initial: "retry", states: [
        { id: "retry", type: "script", outcomes: ["ok"], next: { ok: "fan", failure: "retry" } },
        { id: "fan", type: "parallel", forEach: "${input.items}", concurrency: 2, join: "all_required", failFast: false,
            body: { initial: "item_done", states: ["item_done"] }, outcomes: ["joined"], next: { joined: "done" } },
        { id: "item_done", type: "terminal", outcome: "succeeded", parallel: "fan" },
        { id: "done", type: "terminal", outcome: "succeeded" },
    ] }));
    // R1: an error route back to its own step is a line of error routes, not a handler: a dashed loop out of the step's right side.
    assert.deepEqual([layout.handlers.has("retry"), layout.marks.has("retry")], [false, false]);
    const loop = errorLineOf(layout, "retry", "retry");
    assert.deepEqual([loop.key, loop.kind, loop.outcomes, loop.words, loop.labelText, loop.back],
        [JSON.stringify(["retry", "retry", "error"]), "error", ["failure"], "on error", "on error", true]);
    assert.equal(lineOf(layout, "retry", "retry"), undefined, "no business loop");
    const box = layout.positions.get("retry");
    assert.ok(loop.labelX > box.x + box.width, "the loop and its words are beside the step");
    assert.ok(loop.points.every(([x]) => x >= box.x + box.width - 0.05), "the loop leaves and enters the step's right side");
    assert.deepEqual(workflowHandlerArrows(layout, new Map(layout.positions), { selectedId: "retry" }), [], "no handler arrow");
    const group = layout.groups.get("fan");
    assert.deepEqual([...layout.positions.keys()].sort(), ["done", "retry"]);
    assert.ok(group.width > 0 && group.height > 0 && layout.joins.get("fan").y >= group.y + group.height);
    assertInside(layout);
});

test("a visit limit is a handler only on a step with maxVisits; a branch's success end is the one its business outcomes reach", () => {
    const limited = layoutWorkflowGraphTB(workflowDefinition({ revision: 1, initial: "ask", states: [
        { id: "ask", type: "decision", maxVisits: 3, question: { type: "choice", criteria: { yes: "y", no: "n" } },
            outcomes: ["yes", "no"], next: { yes: "done", no: "ask", exhausted: "stop" } },
        { id: "count", type: "script", outcomes: ["more", "exhausted"], next: { more: "count", exhausted: "done" } },
        { id: "done", type: "terminal", outcome: "succeeded" },
        { id: "stop", type: "terminal", outcome: "blocked" },
    ] }));
    assert.deepEqual(limited.handlers.get("ask").map(handler => [handler.key, handler.words]), [["handler:ask:stop", "on limit"]]);
    assert.equal(limited.chips.has("ask"), false);
    assert.equal(limited.handlers.has("count"), false, "a declared outcome named exhausted, without maxVisits, is business");
    assert.deepEqual(edgeOf(limited, "count", "done").outcomes, ["exhausted"]);
    const base = fanned();
    const recovering = layoutWorkflowGraphTB({ ...base, states: [...base.states.map(node => (node.id === "fan" ? { ...node, body: { initial: "work", states: ["work", "recover", "recovered", "branch_done"] } }
        : node.id === "work" ? { ...node, next: { ok: "branch_done", failure: "recover" } } : node)),
    { id: "recover", type: "script", runtime: "node", outcomes: ["ok"], next: { ok: "recovered" }, parallel: "fan" },
    { id: "recovered", type: "terminal", outcome: "succeeded", parallel: "fan" }] });
    assert.deepEqual(recovering.edges.filter(edge => edge.join).map(name), ["work->join:fan"]);
    assert.deepEqual(recovering.chips.get("recover").map(chip => chip.end), ["recovered"]);
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
