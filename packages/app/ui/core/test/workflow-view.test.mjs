import test from "node:test";
import assert from "node:assert/strict";
import { workflowDefinition as checkedDefinition, layoutWorkflowGraph } from "../src/workflow-view.js";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";

/** A graph's states as the runtime describes them: a script state lists its outcomes (the keys of its next). */
const described = list => list.map(node => (node && typeof node === "object" && node.type !== "terminal"
    ? { type: "script", runtime: "node", timeoutSeconds: 300, outcomes: Object.keys(node.next ?? {}), ...node } : node));
const workflowDefinition = data => checkedDefinition(data && Array.isArray(data.states) ? { ...data, states: described(data.states) } : data);

const start = { eventType: "workflow.started", data: { name: "watch", initial: "poll", definitionHash: "h1", states: described([
    { id: "poll", type: "script", next: { unchanged: "poll", changed: "end", limit: "limit" } },
    { id: "end", type: "terminal", outcome: "succeeded" },
    { id: "limit", type: "terminal", outcome: "blocked" },
]) } };
const definition = workflowDefinition(start.data);

test("definition projection preserves transitions without executing source or accepting empty definitions", () => {
    assert.deepEqual(definition.states, start.data.states);
    assert.throws(() => checkedDefinition(null), /no nodes/);
    assert.throws(() => checkedDefinition({ states: [null, 3] }), /invalid or unsupported node/);
    assert.throws(() => checkedDefinition({ states: [start.data.states[0], start.data.states[0]] }), /repeats node/);
    assert.throws(() => checkedDefinition({ states: [start.data.states[0]] }), /node that is not defined/);
});

test("phone graphs retain sibling branches instead of folding them into a false sequence", () => {
    for (const width of [300, 390, 1440]) {
        const layout = layoutWorkflowGraph(definition, width);
        assert.equal(layout.positions.size, 3);
        assert.equal(layout.edges.length, 3);
        for (const box of layout.positions.values()) {
            assert.ok(box.x >= 0);
            assert.ok(box.x + box.width <= layout.width);
            assert.ok(box.y + box.height <= layout.height);
        }
        assert.ok(layout.edges.every(edge => !edge.path.includes("NaN")));
    }
    const phone = layoutWorkflowGraph(definition, 390);
    assert.equal(phone.positions.get("end").y, phone.positions.get("limit").y);
    assert.notEqual(phone.positions.get("end").x, phone.positions.get("limit").x);
    assert.ok(phone.width > 390, "wide topology uses pan/zoom instead of wrapping");
});

const branching = workflowDefinition({ name: "branching-workflow-test", initial: "collect_metrics", states: [
    { id: "collect_metrics", type: "script", next: { success: "evaluate_quality", failure: "failed" } },
    { id: "evaluate_quality", type: "script", next: { approved: "approved", blocked: "blocked", failure: "failed" } },
    { id: "approved", type: "terminal", outcome: "succeeded" },
    { id: "blocked", type: "terminal", outcome: "blocked" },
    { id: "failed", type: "terminal", outcome: "failed" },
] });

function assertNoNodeCrossings(layout) {
    for (const edge of layout.edges) {
        for (const [id, box] of layout.positions) {
            if (id === edge.from || id === edge.to) continue;
            for (let i = 1; i < edge.points.length; i++) {
                const [x1, y1] = edge.points[i - 1], [x2, y2] = edge.points[i];
                const crosses = x1 === x2
                    ? x1 > box.x && x1 < box.x + box.width && Math.max(y1, y2) > box.y && Math.min(y1, y2) < box.y + box.height
                    : y1 > box.y && y1 < box.y + box.height && Math.max(x1, x2) > box.x && Math.min(x1, x2) < box.x + box.width;
                assert.equal(crosses, false, `${edge.from} -> ${edge.to} must not pass through ${id}`);
            }
        }
    }
}

test("the reported five-node quality gate preserves every edge and all three terminal siblings", () => {
    for (const viewport of [300, 390, 1440]) {
        const layout = layoutWorkflowGraph(branching, viewport);
        const terminals = ["approved", "blocked", "failed"].map(id => layout.positions.get(id));
        assert.equal(new Set(terminals.map(box => box.y)).size, 1);
        assert.equal(new Set(terminals.map(box => box.x)).size, 3);
        assert.ok(layout.positions.get("evaluate_quality").y > layout.positions.get("collect_metrics").y);
        assert.ok(terminals[0].y > layout.positions.get("evaluate_quality").y);
        assert.equal(layout.edges.length, 5);
        assert.deepEqual(layout.edges.filter(edge => edge.from === "failed"), []);
        assertNoNodeCrossings(layout);
    }
});

test("skip edges and cycles use routes outside unrelated node rectangles", () => {
    const graph = workflowDefinition({ initial: "a", states: [
        { id: "a", type: "script", next: { next: "b", skip: "end", loop: "a" } },
        { id: "b", type: "script", next: { next: "c" } },
        { id: "c", type: "script", next: { back: "b", finish: "end" } },
        { id: "end", type: "terminal", outcome: "succeeded" },
    ] });
    const layout = layoutWorkflowGraph(graph, 390);
    assertNoNodeCrossings(layout);
    for (const edge of layout.edges) for (const [x, y] of edge.points) {
        assert.ok(x >= 0 && x <= layout.width);
        assert.ok(y >= 0 && y <= layout.height);
    }
});

test("return edges have separate arrival tracks rather than merging into misleading branches", () => {
    const graph = workflowDefinition({ initial: "a", states: [
        { id: "a", type: "script", next: { cycle: "b", finish: "done" } },
        { id: "b", type: "script", next: { cycle: "a" } },
        { id: "done", type: "terminal", outcome: "succeeded" },
    ] });
    const layout = layoutWorkflowGraph(graph, 390);
    const cycles = layout.edges.filter(edge => edge.to !== "done");
    const returnTrack = edge => edge.points[3][1];
    assert.notEqual(returnTrack(cycles[0]), returnTrack(cycles[1]));
    assertNoNodeCrossings(layout);
    for (const edge of layout.edges) for (const [x, y] of edge.points) {
        assert.ok(x >= 0 && x <= layout.width);
        assert.ok(y >= 0 && y <= layout.height);
    }
});

test("layout terminates for cycles, disconnected states and special object-key IDs", () => {
    const graph = workflowDefinition({ initial: "__proto__", states: [
        { id: "__proto__", type: "script", next: { next: "constructor" } },
        { id: "constructor", type: "script", next: { again: "__proto__" } },
        { id: "isolated", type: "terminal", outcome: "succeeded" },
    ] });
    const layout = layoutWorkflowGraph(graph);
    assert.equal(layout.positions.size, 3);
    assert.equal(layout.edges.length, 2);
});

test("parallel transitions share a labelled edge rather than drawing overlapping labels", () => {
    const graph = workflowDefinition({ states: [
        { id: "poll", type: "script", next: { unchanged: "poll", retry: "poll" } },
    ] });
    const layout = layoutWorkflowGraph(graph);
    assert.equal(layout.edges.length, 1);
    assert.equal(layout.edges[0].outcome, "unchanged / retry");
});

function harness(getSessionEventsBefore) {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    store.dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: "wf", sessionKind: "workflow" }, { sessionId: "other", sessionKind: "workflow" },
        { sessionId: "agent", sessionKind: "agent" },
    ] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    const controller = new PilotSwarmUiController({ store, transport: { getSessionEventsBefore } });
    return { store, controller };
}

test("paged history loads the immutable definition with one bounded, filtered request", async () => {
    const calls = [];
    let resolve;
    const { store, controller } = harness((...args) => { calls.push(args); return new Promise(done => { resolve = done; }); });
    const a = controller.ensureWorkflowDefinition("wf");
    const b = controller.ensureWorkflowDefinition("wf");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ["wf", Number.MAX_SAFE_INTEGER, 1, ["workflow.started"]]);
    store.dispatch({ type: "sessions/selected", sessionId: "other" });
    resolve([start]);
    await Promise.all([a, b]);
    assert.equal(store.getState().ui.workflowViews.wf.definition.initial, "poll");
    assert.equal(store.getState().ui.workflowViews.other, undefined);
    await controller.ensureWorkflowDefinition("wf");
    await controller.ensureWorkflowDefinition("agent");
    assert.equal(calls.length, 1);
});

test("definition errors are visible and explicitly retryable", async () => {
    let requests = 0;
    const { store, controller } = harness(async () => {
        if (++requests === 1) throw new Error("Network unavailable");
        return [start];
    });
    await controller.ensureWorkflowDefinition("wf");
    assert.equal(store.getState().ui.workflowViews.wf.error, "Network unavailable");
    await controller.ensureWorkflowDefinition("wf");
    assert.equal(requests, 1);
    await controller.ensureWorkflowDefinition("wf", { retry: true });
    assert.equal(requests, 2);
    assert.equal(store.getState().ui.workflowViews.wf.error, null);
});

test("node selection and log height belong only to their workflow session", () => {
    const { store } = harness();
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { selectedNodeId: "poll", logHeight: 160 } });
    store.dispatch({ type: "ui/workflowView", sessionId: "other", view: { selectedNodeId: "end" } });
    store.dispatch({ type: "ui/workflowView", sessionId: "agent", view: { selectedNodeId: "poll" } });
    assert.deepEqual(store.getState().ui.workflowViews.wf, { selectedNodeId: "poll", logHeight: 160 });
    assert.deepEqual(store.getState().ui.workflowViews.other, { selectedNodeId: "end" });
    assert.equal(store.getState().ui.workflowViews.agent, undefined);
});
