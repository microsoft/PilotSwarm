import test from "node:test";
import assert from "node:assert/strict";
import { workflowDefinition, workflowNodeViews, layoutWorkflowGraph, workflowLogBounds } from "../src/workflow-view.js";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";

const start = { eventType: "workflow.started", data: { name: "watch", initial: "poll", states: [
    { id: "poll", type: "script", runtime: "node", next: { unchanged: "poll", changed: "end", limit: "limit" } },
    { id: "end", type: "terminal", outcome: "succeeded" },
    { id: "limit", type: "terminal", outcome: "blocked" },
] } };
const definition = workflowDefinition(start.data);
const event = (eventType, data) => ({ eventType, data });

test("definition projection preserves transitions without executing source or accepting empty definitions", () => {
    assert.deepEqual(definition.states, start.data.states);
    assert.throws(() => workflowDefinition(null), /no steps/);
    assert.throws(() => workflowDefinition({ states: [null, 3] }), /invalid or unsupported step/);
    assert.throws(() => workflowDefinition({ states: [start.data.states[0], start.data.states[0]] }), /repeats step/);
    assert.throws(() => workflowDefinition({ states: [start.data.states[0]] }), /step that is not defined/);
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

test("the log's rendered size and accessibility value use the same viewport clamp", () => {
    assert.deepEqual(workflowLogBounds(335, 210), { min: 100, max: 173, height: 173 });
    assert.equal(workflowLogBounds(335, 150).height, 150);
    assert.equal(workflowLogBounds(335, 500).height, 173);
    assert.equal(workflowLogBounds(600, 210).height, 210);
});

test("layout terminates for cycles, disconnected states and special object-key IDs", () => {
    const graph = workflowDefinition({ initial: "__proto__", states: [
        { id: "__proto__", type: "script", next: { next: "constructor" } },
        { id: "constructor", type: "script", next: { again: "__proto__" } },
        { id: "isolated", type: "terminal" },
    ] });
    const layout = layoutWorkflowGraph(graph);
    assert.equal(layout.positions.size, 3);
    assert.equal(layout.edges.length, 2);
});

test("node details use full-run counters when available and label loaded-only counts", () => {
    const events = [
        event("workflow.state_started", { stateId: "poll", step: 29 }),
        event("workflow.state_completed", { stateId: "poll", step: 29, outcome: "unchanged", resultSource: "reported", outputPreview: "<script>unsafe()</script>", toolCalls: [{ name: "read", ok: true }] }),
    ];
    const live = { step: 29, nodes: { poll: { state: "done", runs: 29, lastOutcome: "unchanged" } } };
    const node = workflowNodeViews(definition, events, live)[0];
    assert.equal(node.runs, 29);
    assert.equal(node.partial, false);
    assert.equal(node.result.outputPreview, "<script>unsafe()</script>");
    assert.equal(node.history.length, 1);
    const loaded = workflowNodeViews(definition, events)[0];
    assert.equal(loaded.runs, 1);
    assert.equal(loaded.partial, true);
    assert.equal(loaded.state, "done");
});

test("node details keep failures and terminal summaries separate and bound recent history", () => {
    const events = Array.from({ length: 60 }, (_, i) =>
        event("workflow.state_completed", { stateId: "poll", step: i + 1, outcome: "unchanged" }));
    events.push(event("workflow.state_failed", { stateId: "poll", step: 61, error: "Tool failed" }));
    const node = workflowNodeViews(definition, events)[0];
    assert.equal(node.state, "failed");
    assert.equal(node.result.error, "Tool failed");
    assert.equal(node.history.length, 40);
    const terminal = workflowNodeViews(definition, [event("workflow.completed", { stateId: "end", outcome: "succeeded", summary: "Changed" })])[1];
    assert.equal(terminal.result.summary, "Changed");
});

test("new durable events override a delayed canvas tick without double-counting attempts", () => {
    const live = { step: 28, nodes: { poll: { state: "done", runs: 28, lastOutcome: "unchanged" } } };
    const events = [
        event("workflow.state_started", { stateId: "poll", step: 29 }),
        event("workflow.state_completed", { stateId: "poll", step: 29, outcome: "changed", resultSource: "reported" }),
    ];
    const node = workflowNodeViews(definition, events, live)[0];
    assert.equal(node.runs, 29);
    assert.equal(node.outcome, "changed");
    const running = { step: 29, nodes: { poll: { state: "running", runs: 29 } } };
    const completed = workflowNodeViews(definition, events, running)[0];
    assert.equal(completed.runs, 29);
    assert.equal(completed.state, "done");
});

test("timeouts and failed process exits stay failed with or without a canvas snapshot", () => {
    for (const data of [
        { outcome: "timeout", resultSource: "timeout", exitCode: null },
        { outcome: "failure", resultSource: "exit", exitCode: 1 },
    ]) {
        const events = [event("workflow.state_completed", { stateId: "poll", step: 1, ...data })];
        for (const live of [null, { step: 1, nodes: { poll: { state: "failed", runs: 1 } } }]) {
            assert.equal(workflowNodeViews(definition, events, live)[0].state, "failed");
        }
    }
    for (const data of [{ exitCode: 0 }, { resultSource: "reported" }, { resultSource: "stdout" }]) {
        assert.equal(workflowNodeViews(definition, [event("workflow.state_completed", { stateId: "poll", step: 1, ...data })])[0].state, "done");
    }
});

test("a terminal event stops a running node even without a node-specific cancellation", () => {
    const events = [event("workflow.state_started", { stateId: "poll", step: 1 }), event("workflow.cancelled", { steps: 1 })];
    assert.equal(workflowNodeViews(definition, events)[0].state, "cancelled");
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
    const store = createStore(appReducer, createInitialState({ workflowsEnabled: true, mode: "api" }));
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

test("phone and cold-start unknown devices keep the graph in Main until explicit selection", () => {
    for (const device of [null, "mobile"]) {
        const { controller, store } = harness();
        if (device) store.dispatch({ type: "ui/sessionViewDevice", device });
        controller.revealWorkflowCanvas("wf", true);
        assert.equal(store.getState().ui.canvasOpen, false);
        controller.applyCanvasUpdate("wf", { data: { rev: 1, slot: 1 } });
        assert.equal(store.getState().ui.canvasOpen, false);
        store.dispatch({ type: "canvas/flip", sessionId: "wf", slot: 1 });
        assert.equal(store.getState().ui.canvasOpen, true);
    }
});
