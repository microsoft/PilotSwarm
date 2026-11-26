// The portal's top-to-bottom workflow graph layout (owner batch 5, g-01): dagre ranks, orders and routes the graph;
// edges are smooth curves through dagre's points. The terminal keeps its own layout (workflow-view.test.mjs).
//
// Run: node --test packages/app/ui/core/test/workflow-graph-layout.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    layoutWorkflowGraphTB, workflowEdgeCurve, workflowEdgeLabelText, workflowGraphBodies, workflowGraphPlaces, workflowHandlerArrows, workflowPlaceKey,
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

test("version 2: error routes into the failed end are error handlers (a quiet mark, no line, no chip), labels only where a line does not carry every outcome", () => {
    const layout = layoutWorkflowGraphTB(definitionOf(startedData));
    assert.deepEqual([...layout.positions.keys()].sort(), ["await_ack", "done", "notify", "pause", "poll"]);
    assert.equal(layout.edges.length, 5);
    // R1: poll's failure and timed_out and notify's delivery_failed are error handlers into the failed end, one per step
    // and target: no line, no badge, no chip; the failed end has no box (its handlers' arrows end at a ghost of it).
    assert.equal(edgeOf(layout, "poll", "failed"), undefined);
    assert.ok(layout.edges.every(edge => edge.kind === "outcome"), "every line carries business routes only");
    assert.deepEqual(layout.handlers.get("poll"), [{ key: "handler:poll:failed", step: "poll", from: "poll", target: "failed", to: null, end: "failed",
        outcome: "failed", routes: ["failure", "timed_out"], kinds: ["error"], words: "on error", catchAll: false }]);
    assert.deepEqual(layout.handlers.get("notify").map(handler => [handler.key, handler.routes, handler.kinds, handler.words, handler.to, handler.end]),
        [["handler:notify:failed", ["delivery_failed"], ["error"], "on error", null, "failed"]]);
    assert.deepEqual([...layout.marks.values()], [
        { step: "poll", key: "mark:poll", title: "Has an error handler: on error → failed. Select the step to see where errors go." },
        { step: "notify", key: "mark:notify", title: "Has an error handler: on error → failed. Select the step to see where errors go." }]);
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

test("issue-to-pr: 10 boxes, 13 lines of business routes, 9 labels in plain words, every error and limit route a handler; the happy path is one straight column", () => {
    const layout = layoutWorkflowGraphTB(issueToPr);
    assert.equal(layout.positions.size, 10);
    assert.equal(layout.edges.length, 13);
    // R3: a line's label is its business outcomes in plain words, never a ✕ or ⟳ glyph.
    assert.deepEqual(layout.edges.filter(edge => edge.labelText).map(edge => edge.labelText).sort(),
        ["acquired", "busy", "create", "created", "not created", "ok", "published · declined", "ready for review", "verified"].sort());
    assert.deepEqual([edgeOf(layout, "create_env", "wait_for_env").outcomes, edgeOf(layout, "implement", "finish").outcomes],
        [["not_created"], ["published", "declined"]]);
    assert.ok(layout.edges.every(edge => edge.kind === "outcome" && !/[✕⟳]/.test(edge.labelText)), "lines carry business routes only");
    assert.equal(layout.edges.filter(edge => edge.to === "failed").length, 0);
    // R1: every error and limit route is an error handler, one per step and target, whatever the target (a step or an end).
    assert.deepEqual([...layout.handlers].map(([step, list]) => [step, list.map(handler => [handler.key, handler.to, handler.end, handler.routes, handler.words])]), [
        ["fetch_issue", [["handler:fetch_issue:failed", null, "failed", ["failure"], "on error"]]],
        ["acquire_env", [["handler:acquire_env:no_env", null, "no_env", ["exhausted"], "on limit"],
            ["handler:acquire_env:failed", null, "failed", ["failure"], "on error"]]],
        ["create_env", [["handler:create_env:wait_for_env", "wait_for_env", null, ["exhausted", "failure"], "on error or limit"]]],
        ["wait_for_env", [["handler:wait_for_env:failed", null, "failed", ["failure"], "on error"]]],
        ["implement", [["handler:implement:finish", "finish", null, ["exhausted", "failure"], "on error or limit"]]],
        ["review", [["handler:review:gate", "gate", null, ["failure"], "on error"]]],
        ["gate", [["handler:gate:failed", null, "failed", ["failure"], "on error"]]],
        ["renew", [["handler:renew:implement", "implement", null, ["failure"], "on error"]]],
        ["finish", [["handler:finish:failed", null, "failed", ["failure"], "on error"]]]]);
    assert.deepEqual(layout.handlers.get("implement")[0].kinds, ["error", "limit"]);
    assert.deepEqual([layout.handlers.get("acquire_env")[0].kinds, layout.handlers.get("acquire_env")[0].outcome], [["limit"], "blocked"]);
    assert.equal(layout.marks.get("acquire_env").title,
        "Has an error handler: on limit → no_env; on error → failed. Select the step to see where errors go.");
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

test("error handlers' dashed arrows: the selected step's, every one, those into the hovered end or a replay's; into a target's box or a ghost end", () => {
    const layout = layoutWorkflowGraphTB(issueToPr);
    const boxes = new Map(layout.positions);
    const r = value => Math.round(value * 10) / 10;
    assert.deepEqual(workflowHandlerArrows(layout, boxes), [], "none until a step is selected");
    // A handler into an end with no box: from the step's right side to a ghost of the end beside it, one under the other.
    const acquire = workflowHandlerArrows(layout, boxes, { selectedId: "acquire_env" });
    assert.deepEqual(acquire.map(arrow => [arrow.key, arrow.step, arrow.target, arrow.words, arrow.ghost?.end, arrow.ghost?.outcome]), [
        ["handler:acquire_env:no_env", "acquire_env", "no_env", "on limit", "no_env", "blocked"],
        ["handler:acquire_env:failed", "acquire_env", "failed", "on error", "failed", "failed"]]);
    const step = layout.positions.get("acquire_env");
    for (const arrow of acquire) {
        assert.ok(arrow.path.startsWith(`M${r(step.x + step.width)},${r(step.y + step.height / 2)} C`), arrow.path);
        assert.ok(arrow.ghost.x > step.x + step.width, "the ghost end is beside the step, to its right");
        assert.deepEqual([arrow.litCount, arrow.litAge, arrow.current, arrow.tag], [0, null, false, null]);
    }
    assert.ok(acquire[0].ghost.x === acquire[1].ghost.x && acquire[1].ghost.y > acquire[0].ghost.y, "two ghosts stand one under the other");
    // A handler into a step: no ghost; the arrow swings out to the right and into the target's right side.
    const [implement] = workflowHandlerArrows(layout, boxes, { selectedId: "implement" });
    const finish = layout.positions.get("finish");
    assert.deepEqual([implement.key, implement.target, implement.words, implement.ghost], ["handler:implement:finish", "finish", "on error or limit", null]);
    assert.ok(implement.path.endsWith(` ${r(finish.x + finish.width + 2)},${r(finish.y + finish.height / 2)}`), implement.path);
    // Show all handlers: every one; an end hovered in the Ends row: those into it.
    assert.equal(workflowHandlerArrows(layout, boxes, { all: true }).length, 10);
    assert.deepEqual(workflowHandlerArrows(layout, boxes, { hoverEnd: "failed" }).map(arrow => arrow.key),
        ["handler:fetch_issue:failed", "handler:acquire_env:failed", "handler:wait_for_env:failed", "handler:gate:failed", "handler:finish:failed"]);
    // A replay lights the handler a transition took; the one shown now carries the transition's words.
    const lit = { edges: new Map([["handler:gate:failed", { count: 1, age: 0 }]]), transition: { edgeKey: "handler:gate:failed", words: "✕ script failed" } };
    assert.deepEqual(workflowHandlerArrows(layout, boxes, { lit }).map(arrow => [arrow.key, arrow.litCount, arrow.litAge, arrow.current, arrow.tag]),
        [["handler:gate:failed", 1, 0, true, "✕ script failed"]]);
});

test("the root catchAll: every root step without a failure route has an error handler to it (its mark says catchAll), and the catch-all's end counts its ways in", () => {
    const layout = layoutWorkflowGraphTB(workflowDefinition({ revision: 1, initial: "a", catchAll: "failed", states: [
        { id: "a", type: "script", outcomes: ["ok"], next: { ok: "b" } },
        { id: "b", type: "script", outcomes: ["ok"], next: { ok: "done", failure: "cleanup" } },
        { id: "cleanup", type: "script", outcomes: ["ok"], next: { ok: "failed" } },
        { id: "done", type: "terminal", outcome: "succeeded" },
        { id: "failed", type: "terminal", outcome: "failed" },
    ] }));
    assert.equal(layout.catchAll, "failed");
    assert.deepEqual([...layout.handlers.values()].flat().map(handler => [handler.key, handler.to, handler.end, handler.routes, handler.words, handler.catchAll]), [
        ["handler:b:cleanup", "cleanup", null, ["failure"], "on error", false],
        ["handler:a:failed", null, "failed", [], "on error", true],
        ["handler:cleanup:failed", null, "failed", [], "on error", true]]);
    // A step with a failure route is not covered: its own handler (b's failure, into cleanup) takes its errors.
    assert.equal(layout.handlers.get("b").some(handler => handler.catchAll || handler.target === "failed"), false);
    assert.deepEqual([...layout.marks].map(([id, mark]) => [id, mark.key, mark.title]), [
        ["b", "mark:b", "Has an error handler: on error → cleanup. Select the step to see where errors go."],
        ["a", "mark:a", "Has an error handler: on error → failed (catchAll). Select the step to see where errors go."],
        ["cleanup", "mark:cleanup", "Has an error handler: on error → failed (catchAll). Select the step to see where errors go."]]);
    assert.deepEqual(layout.chips.get("cleanup").map(chip => chip.text), ["ok → ⏹ failed"]);
    assert.deepEqual(layout.ends.find(end => end.id === "failed").keys.sort(), ["chip:cleanup:failed", "handler:a:failed", "handler:cleanup:failed"]);
    // A catch-all that is a step: it does not cover itself, and a covered step's own handler to it takes the catchAll too.
    const covered = layoutWorkflowGraphTB(workflowDefinition({ revision: 1, initial: "a", catchAll: "cleanup", states: [
        { id: "a", type: "script", outcomes: ["ok"], next: { ok: "b", timed_out: "cleanup" } },
        { id: "b", type: "script", outcomes: ["ok"], next: { ok: "done", failure: "cleanup" } },
        { id: "cleanup", type: "script", outcomes: ["ok"], next: { ok: "failed" } },
        { id: "done", type: "terminal", outcome: "succeeded" },
        { id: "failed", type: "terminal", outcome: "failed" },
    ] }));
    assert.deepEqual([...covered.handlers].map(([id, list]) => [id, list.map(handler => [handler.key, handler.to, handler.routes, handler.catchAll])]), [
        ["a", [["handler:a:cleanup", "cleanup", ["timed_out"], true]]], ["b", [["handler:b:cleanup", "cleanup", ["failure"], false]]]]);
    assert.equal(covered.handlers.has("cleanup"), false, "the catch-all state is not covered by itself");
    assert.equal(covered.marks.get("a").title, "Has an error handler: on error → cleanup (catchAll). Select the step to see where errors go.");
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
    assert.deepEqual(layout.handlers.get("review"), [{ key: "handler:review:failed", step: "review", from: "review", target: "failed", to: null,
        end: "failed", outcome: "failed", routes: ["timed_out"], kinds: ["error"], words: "on error", catchAll: false }]);
    assert.deepEqual([...layout.marks.keys()], ["review"]);
    assert.deepEqual(layout.ends.find(end => end.id === "failed").keys, ["chip:fan:failed", "handler:review:failed"]);
    assert.equal(layout.edges.length, 3);
    assertCurvesClearOfSteps(layout);
    assertInside(layout);
    for (const box of [group, join]) assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= layout.width && box.y + box.height <= layout.height);
    assert.ok(group.x + group.width + group.stack <= layout.width && group.y + group.height + group.stack <= layout.height, "the stack is drawn too");
});

test("a parallel step's error handler leaves its join bar; a handler into a branch's success end goes into the join bar", () => {
    const base = fanned();
    const layout = layoutWorkflowGraphTB({ ...base, states: base.states.map(node => (node.id === "fan" ? { ...node, next: { ...node.next, failure: "failed" } }
        : node.id === "work" ? { ...node, next: { ok: "branch_done", failure: "branch_done" } } : node)) });
    assert.deepEqual(layout.handlers.get("fan").map(handler => [handler.key, handler.from, handler.to, handler.end, handler.outcome, handler.routes]),
        [["handler:fan:failed", "join:fan", null, "failed", "failed", ["failure"]]]);
    assert.deepEqual(layout.handlers.get("work").map(handler => [handler.key, handler.from, handler.to, handler.end, handler.outcome, handler.words]),
        [["handler:work:branch_done", "work", "join:fan", null, "succeeded", "on error"]]);
    // Its business routes are unchanged: work's line into the bar, blocked a chip beside the bar.
    assert.deepEqual(edgeOf(layout, "work", "join:fan").outcomes, ["ok"]);
    assert.deepEqual(layout.chips.get("fan").map(chip => chip.text), ["blocked → ⏹ failed"]);
    const join = layout.joins.get("fan");
    const boxes = new Map([...layout.positions, [join.id, join]]);
    const r = value => Math.round(value * 10) / 10;
    const [fan] = workflowHandlerArrows(layout, boxes, { selectedId: "fan" });
    assert.ok(fan.path.startsWith(`M${r(join.x + join.width)},${r(join.y + join.height / 2)} C`), fan.path);
    assert.deepEqual([fan.ghost.end, fan.ghost.outcome], ["failed", "failed"]);
    assert.ok(fan.ghost.y > join.y + join.height / 2, "the ghost stands under the bar's chips");
    const [work] = workflowHandlerArrows(layout, boxes, { selectedId: "work" });
    assert.deepEqual([work.target, work.ghost], ["branch_done", null]);
    assert.ok(work.path.endsWith(` ${r(join.x + join.width + 2)},${r(join.y + join.height / 2)}`), work.path);
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
