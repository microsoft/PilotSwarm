import test from "node:test";
import assert from "node:assert/strict";
import { workflowDefinition, workflowNodeViews, layoutWorkflowGraph } from "../src/workflow-view.js";
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
    assert.throws(() => workflowDefinition(null), /no states/);
    assert.throws(() => workflowDefinition({ states: [null, 3] }), /no supported states/);
});

test("graph layout includes self loops and wraps phone branches without scaling labels down", () => {
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
    assert.notEqual(phone.positions.get("end").y, phone.positions.get("limit").y);
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
        event("workflow.state_completed", { stateId: "poll", step: 29, outcome: "unchanged", outputPreview: "<script>unsafe()</script>", toolCalls: [{ name: "read", ok: true }] }),
    ];
    const live = { nodes: { poll: { state: "done", runs: 29, lastOutcome: "unchanged" } } };
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

test("a phone keeps the workflow graph in Main until explicit node selection", () => {
    const { controller, store } = harness();
    store.dispatch({ type: "ui/sessionViewDevice", device: "mobile" });
    controller.revealWorkflowCanvas("wf", true);
    assert.equal(store.getState().ui.canvasOpen, false);
    controller.applyCanvasUpdate("wf", { data: { rev: 1, slot: 1 } });
    assert.equal(store.getState().ui.canvasOpen, false);
    store.dispatch({ type: "canvas/flip", sessionId: "wf", slot: 1 });
    assert.equal(store.getState().ui.canvasOpen, true);
});
