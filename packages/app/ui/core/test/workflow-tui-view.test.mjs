// The TUI's read-only workflow view (design 02 "Portal/TUI: graph, observed state, read-only child chats"; T115):
// states in graph order with the observed state, the selected state's details and transitions (a loop marked as
// one, a parallel state's branch start, a runtime-error route), an agent state's child session for each of its
// occurrences, opened as its actual chat. It reads what the portal's pane reads and sends nothing.
//
// Run: node --test packages/app/ui/core/test/workflow-tui-view.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    UI_COMMANDS,
    appReducer,
    buildHistoryModel,
    createInitialState,
    createStore,
    selectWorkflowViewModal,
    selectWorkflowViewSelection,
    workflowGraphOrder,
} from "../src/index.js";
import { workflowV2Definition } from "../src/workflow-v2-view.js";
import { legacyStartedData, readModel, row, done } from "./workflow-v2-fixtures.mjs";

/** A review that loops through a fix until accepted, a parallel fan-out, and the terminals. */
const states = [
    { id: "review", type: "agent", invoke: { source: "agent", name: "code-reviewer", package: "review-kit", version: "1.2.0" }, timeoutSeconds: 600,
        outcomes: ["accepted", "rework"], next: { accepted: "fan", rework: "fix", timed_out: "failed" } },
    { id: "fix", type: "script", runtime: "node", timeoutSeconds: 60, outcomes: ["fixed"], next: { fixed: "review" } },
    { id: "fan", type: "parallel", forEach: "${input.items}", concurrency: 2, join: "all_required", failFast: false,
        body: { initial: "work", states: ["work", "branch_done"] }, outcomes: ["joined", "blocked"], next: { joined: "done", blocked: "failed" } },
    { id: "work", type: "script", runtime: "node", timeoutSeconds: 300, outcomes: ["ok"], next: { ok: "branch_done" }, parallel: "fan" },
    { id: "branch_done", type: "terminal", outcome: "succeeded", parallel: "fan" },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const graph = { revision: 1, initial: "review", states };
const agent = (childSessionId, end = null) => ({ childSessionId, spawned: true, spawnAttempts: 1, end, endSent: end !== null });
/** Two visits of the review (the first sent back for rework), with the fix between them. */
const MODEL = readModel({
    graph, revision: { name: "review-flow" },
    nodeExecutions: [
        done("review", 1, "rework", { agent: agent("child-r1", "done"), winner: "agent" }),
        done("fix", 2, "fixed"),
        row("review", 3, "pending", { agent: agent("child-r2"), deadline: "2026-11-02T10:10:00.000Z" }),
    ],
});

let seq = 0;
const event = (eventType, data) => ({ sessionId: "wf", seq: ++seq, eventType, data, createdAt: new Date(Date.UTC(2026, 10, 2, 9, 0, seq)) });
const STARTED = event("workflow.started", { runId: "run-1", mode: "live", revision: 1, definitionHash: "hash-1", irSha256: "ir-1",
    name: "review-flow", version: "1.0.0", initial: "review", states });

/** A controller whose transport records every call; the workflow session wf, an agent session a1. */
function harness({ events = [STARTED], model = MODEL, transport: extra = {} } = {}) {
    const calls = [];
    const record = name => async (...args) => { calls.push([name, ...args]); return null; };
    const transport = new Proxy({
        readWorkflow: async (...args) => { calls.push(["readWorkflow", ...args]); return model; },
        getSessionEventsBefore: async (...args) => { calls.push(["getSessionEventsBefore", ...args]); return []; },
        ...extra,
    }, { get: (target, name) => (name in target ? target[name] : typeof name === "string" ? record(name) : undefined) });
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: "wf", title: "Workflow: review-flow", status: "running", sessionKind: "workflow" },
        { sessionId: "a1", title: "Agent", status: "idle" },
    ] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel(events) });
    if (model) store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: model, readModelRunId: null } });
    const opened = [];
    controller.loadSession = async (sessionId) => { opened.push(sessionId); };
    return { controller, store, calls, opened };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const rowText = row => row.map(run => run.text).join("");
const lineTexts = presentation => presentation.detailsLines.map(line => line.text);
const WRITES = /^(updateWorkflow|sendMessage|sendWorkflowInput|steer|answer|createSession|cancel|delete|done|complete|setSession)/i;

test("the states come in graph order: a loop is one layer, a parallel state's branch start and the later terminals below it", () => {
    const order = workflowGraphOrder(workflowV2Definition(graph));
    assert.deepEqual(order.map(item => item.id), ["review", "fix", "fan", "work", "done", "failed", "branch_done"]);
    assert.deepEqual(Object.fromEntries(order.map(item => [item.id, item.layer])),
        { review: 0, fix: 0, fan: 1, work: 2, done: 2, failed: 2, branch_done: 3 });
    assert.deepEqual(workflowGraphOrder(null), []);
});

test("w opens the view on the pending agent state: its state, transitions with the loop marked, and the chat of each occurrence", async () => {
    const { controller, store, calls } = harness();
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await settle();
    const state = store.getState();
    assert.equal(state.ui.modal.type, "workflowView");
    assert.equal(state.ui.modal.sessionId, "wf");
    const view = selectWorkflowViewModal(state, 110);
    assert.equal(view.title, "Workflow: review-flow · Running");
    assert.deepEqual(view.rows.map(rowText).map(text => text.trim().split(/\s+/).slice(0, 3).join(" ")), [
        "▶ ● review", "✓ fix script", "○ fan parallel", "○ work script", "○ done ends", "○ failed ends", "○ branch_done ends",
    ]);
    assert.equal(view.selectedRowIndex, 0);
    assert.match(rowText(view.rows[0]), /agent · code-reviewer\s+Agent working · waiting for its typed result ×3/);
    const details = lineTexts(view);
    // The run it shows comes first (the live run here), then the selected state.
    assert.match(details[0], /^Run: Live run · running · run-1 \(1 of 2 · ←→ choose\)$/);
    assert.ok(details.includes("review · agent · code-reviewer · initial state"));
    assert.ok(details.includes("State: Agent working · waiting for its typed result"));
    assert.ok(details.includes("Transitions:"));
    assert.ok(details.includes("  accepted → fan"));
    assert.ok(details.includes("  rework → fix · ↺ in a loop"));
    assert.ok(details.includes("  timed_out → failed · runtime error route"));
    assert.ok(details.includes("Agent chats (Tab: choose · Enter: open):"));
    assert.ok(details.includes("▸ visit 3 · working · child-r2"), details.join("\n"));
    assert.ok(details.includes("  visit 1 · completed · rework · child-r1"), details.join("\n"));
    assert.ok(details.includes("People can read these chats; the server refuses their prompts, answers and steers."));
    // It read the workflow as the portal's pane does, and called nothing that changes anything.
    assert.ok(calls.some(call => call[0] === "readWorkflow" && call[1] === "wf"));
    assert.deepEqual(calls.filter(call => WRITES.test(call[0])), []);
});

test("↑↓ select states in graph order; the loop's other state, a parallel state's branch start and an end are described", async () => {
    const { controller, store } = harness();
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    let view = selectWorkflowViewModal(store.getState(), 110);
    assert.equal(view.selectedRowIndex, 1);
    assert.ok(lineTexts(view).includes("  fixed → review · ↺ in a loop"));
    assert.ok(lineTexts(view).includes("Last outcome: fixed · business outcome"));
    await controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    view = selectWorkflowViewModal(store.getState(), 110);
    assert.ok(lineTexts(view).includes("  each branch → work · where each branch starts"));
    assert.ok(lineTexts(view).includes("  joined → done"));
    for (let i = 0; i < 10; i++) await controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    view = selectWorkflowViewModal(store.getState(), 110);
    assert.equal(view.selectedRowIndex, 6, "the selection stops at the last state");
    assert.ok(lineTexts(view).includes("The workflow ends at this state."));
    for (let i = 0; i < 10; i++) await controller.handleCommand(UI_COMMANDS.MODAL_PREV);
    assert.equal(selectWorkflowViewModal(store.getState(), 110).selectedRowIndex, 0, "and at the first");
});

test("Tab chooses an occurrence and Enter opens that occurrence's actual chat; nothing is sent", async () => {
    const { controller, store, calls, opened } = harness();
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await controller.handleCommand(UI_COMMANDS.MODAL_PANE_NEXT);
    assert.equal(selectWorkflowViewSelection(store.getState()).occurrence.childSessionId, "child-r1");
    assert.ok(lineTexts(selectWorkflowViewModal(store.getState(), 110)).includes("▸ visit 1 · completed · rework · child-r1"));
    await controller.handleCommand(UI_COMMANDS.MODAL_PANE_NEXT);
    assert.equal(selectWorkflowViewSelection(store.getState()).occurrence.childSessionId, "child-r2", "Tab cycles");
    await controller.handleCommand(UI_COMMANDS.MODAL_PANE_PREV);
    await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.deepEqual(opened, ["child-r1"], "the first visit's own child, not the latest one");
    assert.equal(store.getState().ui.modal, null);
    assert.match(store.getState().ui.statusText, /Opened the agent chat of review \(visit 1\): people can read it; the server refuses their input to it/);
    // The latest visit, by default.
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.deepEqual(opened, ["child-r1", "child-r2"]);
    assert.deepEqual(calls.filter(call => WRITES.test(call[0])), []);
});

test("a state without an agent chat keeps the view open; another kind of session gets a status line, not the view", async () => {
    const { controller, store, opened } = harness();
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    await controller.handleCommand(UI_COMMANDS.MODAL_PANE_NEXT);
    await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.equal(store.getState().ui.modal?.type, "workflowView");
    assert.equal(store.getState().ui.statusText, "State fix has no agent chat to open");
    assert.deepEqual(opened, []);
    await controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.equal(store.getState().ui.modal, null);

    store.dispatch({ type: "sessions/selected", sessionId: "a1" });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    assert.equal(store.getState().ui.modal, null);
    assert.equal(store.getState().ui.statusText, "The workflow view is for workflow sessions");
});

test("an agent state whose child is not listed yet says so; a read failure and an empty view are reported, not hidden", async () => {
    const early = readModel({ graph, revision: { name: "review-flow" }, nodeExecutions: [row("review", 1, "pending")] });
    const { controller, store } = harness({ model: early });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await settle();
    let details = lineTexts(selectWorkflowViewModal(store.getState(), 110));
    assert.ok(details.includes("No child session is listed for it yet."));
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModelAttempt: { runId: null, afterSeq: 0, sessionUpdatedAt: null },
        readModelError: "Gateway timeout" } });
    details = lineTexts(selectWorkflowViewModal(store.getState(), 110));
    assert.ok(details.includes("The workflow's current state could not be read: Gateway timeout"));

    const empty = harness({ events: [], model: null, transport: { readWorkflow: undefined } });
    await empty.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await settle();
    const view = selectWorkflowViewModal(empty.store.getState(), 110);
    assert.equal(view.rows.map(rowText).join(""), "No states to show.");
    assert.ok(view.detailsLines.length >= 1);
});

test("a legacy workflow lists its states too, with its self-loop marked", async () => {
    const legacy = event("workflow.started", legacyStartedData);
    const { controller, store } = harness({ events: [legacy, event("workflow.state_started", { stateId: "poll", runtime: "node", step: 1 })],
        model: null, transport: { readWorkflow: undefined } });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await settle();
    const view = selectWorkflowViewModal(store.getState(), 110);
    assert.match(view.title, /^Workflow: watch · /);
    assert.deepEqual(view.rows.map(rowText).map(text => text.trim().split(/\s+/).slice(0, 3).join(" ")), ["▶ ● poll", "○ end ends"]);
    assert.ok(lineTexts(view).includes("  unchanged → poll · ↺ in a loop"));
    assert.ok(lineTexts(view).includes("  changed → end"));
});
