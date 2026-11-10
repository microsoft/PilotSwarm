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
import { workflowDefinition } from "../src/workflow-view.js";
import { readModel, row, done } from "./workflow-fixtures.mjs";

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
    const order = workflowGraphOrder(workflowDefinition(graph));
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
    // A branch's end says so; the parallel step is followed by its branch steps, then its join line, then its continuations
    // (owner batch 7, H2; review UI7-4).
    assert.deepEqual(view.rows.map(rowText).map(text => text.trim().split(/\s+/).slice(0, 3).join(" ")), [
        "▶ ● review", "✓ fix Script", "○ fan For", "○ work Script", "○ branch_done Item", "⋯ Joins when", "○ done End", "○ failed End",
    ]);
    assert.equal(rowText(view.rows[5]).trim(), "⋯ Joins when all succeed");
    assert.equal(view.selectedRowIndex, 0);
    // The visit badge, as the node's card shows it (↻ 3+: older visits not loaded).
    assert.match(rowText(view.rows[0]), /Agent · code-reviewer\s+Running · until its result · ↻ 3\+?/);
    const details = lineTexts(view);
    // The run it shows comes first (the live run here), then the selected state.
    // Review 19:27Z (C): the Workflow's own option, no id.
    assert.match(details[0], /^Workflow · revision 1$/);
    assert.ok(details.includes("review · Agent · code-reviewer · start"));
    assert.ok(details.includes("Status: Running · until its result"));
    assert.ok(details.includes("Next:"));
    assert.ok(details.includes("  accepted → fan"));
    assert.ok(details.includes("  rework → fix · ↺ in a loop"));
    // Finding 7: an error route in words, as the portal's Node panel says it.
    assert.ok(details.includes("  ✕ limit → failed"), details.join("\n"));
    assert.ok(!details.some(line => line.includes("runtime error route")));
    assert.ok(details.includes("Agent sessions · Tab choose · Enter open:"));
    // Review 19:27Z (row 10): each chat by its visit, its state in marks and words, and its name (never its id).
    assert.ok(details.includes("▸ visit 3 · ● running · agent session not loaded"), details.join("\n"));
    assert.ok(details.includes("  visit 1 · ✓ rework · agent session not loaded"), details.join("\n"));
    assert.ok(!details.some(line => /child-r/.test(line)), "no session id");
    assert.ok(details.includes("People can read these agent sessions; the server refuses their prompts, answers and instructions."));
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
    assert.ok(lineTexts(view).includes("Outcome: fixed"));
    await controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    view = selectWorkflowViewModal(store.getState(), 110);
    assert.ok(lineTexts(view).includes("  each item → work · where each item starts"));
    assert.ok(lineTexts(view).includes("  joined → done"));
    // The parallel step's details say when it continues, in words (H2; Workflow Simplified W6); no time limit is shown for it.
    assert.ok(lineTexts(view).includes("Joins when all succeed"), lineTexts(view).join("\n"));
    assert.ok(!lineTexts(view).some(line => line.includes("⏱")), lineTexts(view).join("\n"));
    // Its branch steps come next; ↓ passes over the join line to the continuation.
    await controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    assert.equal(selectWorkflowViewModal(store.getState(), 110).selectedRowIndex, 3);
    await controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    view = selectWorkflowViewModal(store.getState(), 110);
    assert.equal(view.selectedRowIndex, 4);
    assert.ok(lineTexts(view).includes("The item ends here."), lineTexts(view).join("\n"));
    await controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    view = selectWorkflowViewModal(store.getState(), 110);
    assert.equal(view.selectedRowIndex, 6, "the join line is not a state: the selection goes from the branch's end to done");
    assert.equal(selectWorkflowViewSelection(store.getState()).selected.id, "done");
    for (let i = 0; i < 10; i++) await controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    view = selectWorkflowViewModal(store.getState(), 110);
    assert.equal(view.selectedRowIndex, 7, "the selection stops at the last state");
    assert.ok(lineTexts(view).includes("The Workflow ends here."));
    for (let i = 0; i < 10; i++) await controller.handleCommand(UI_COMMANDS.MODAL_PREV);
    assert.equal(selectWorkflowViewModal(store.getState(), 110).selectedRowIndex, 0, "and at the first");
});

test("two parallel steps: each is followed by its branch steps and its join line, before its continuations; ↑↓ pass over both join lines", async () => {
    const step = (id, parallel, next) => ({ id, type: "script", runtime: "node", timeoutSeconds: 30, outcomes: ["ok"], next: { ok: next }, parallel });
    const fan = (id, initial, members, next, extra = {}) => ({ id, type: "parallel", forEach: `\${input.${id}}`, concurrency: 1, join: "all_required",
        failFast: false, body: { initial, states: members }, outcomes: ["joined", "blocked"], next, ...extra });
    const two = [
        fan("a", "a_work", ["a_work", "a_end"], { joined: "b", blocked: "failed" }),
        step("a_work", "a", "a_end"),
        { id: "a_end", type: "terminal", outcome: "succeeded", parallel: "a" },
        fan("b", "b_work", ["b_work", "b_end"], { joined: "done", blocked: "failed" }, { concurrency: 2, failFast: true }),
        step("b_work", "b", "b_end"),
        { id: "b_end", type: "terminal", outcome: "succeeded", parallel: "b" },
        { id: "done", type: "terminal", outcome: "succeeded" },
        { id: "failed", type: "terminal", outcome: "failed" },
    ];
    const { controller, store } = harness({ events: [], model: readModel({ graph: { revision: 1, initial: "a", states: two }, revision: { name: "two-fans" } }) });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    let view = selectWorkflowViewModal(store.getState(), 110);
    const words = view.rows.map(rowText).map(text => text.trim().split(/\s+/).slice(0, 3).join(" "));
    assert.deepEqual(words.slice(0, 8), [
        "▶ ○ a", "○ a_work Script", "○ a_end Item", "⋯ Joins when", "○ b For", "○ b_work Script", "○ b_end Item", "⋯ Joins when",
    ], words.join("\n"));
    assert.deepEqual(words.slice(8).sort(), ["○ done End", "○ failed End"]);
    assert.equal(view.selectedRowIndex, 0);
    const rowOfNext = async () => {
        await controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
        view = selectWorkflowViewModal(store.getState(), 110);
        return [selectWorkflowViewSelection(store.getState()).selected.id, view.selectedRowIndex];
    };
    assert.deepEqual(await rowOfNext(), ["a_work", 1]);
    assert.deepEqual(await rowOfNext(), ["a_end", 2]);
    assert.deepEqual(await rowOfNext(), ["b", 4], "past the first join line");
    assert.deepEqual(await rowOfNext(), ["b_work", 5]);
    assert.deepEqual(await rowOfNext(), ["b_end", 6]);
    const [id, row] = await rowOfNext();
    assert.ok(["done", "failed"].includes(id) && row === 8, `past the second join line: ${id} at ${row}`);
});

test("Tab chooses an occurrence and Enter opens that occurrence's actual chat; nothing is sent", async () => {
    const { controller, store, calls, opened } = harness();
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await controller.handleCommand(UI_COMMANDS.MODAL_PANE_NEXT);
    assert.equal(selectWorkflowViewSelection(store.getState()).occurrence.childSessionId, "child-r1");
    assert.ok(lineTexts(selectWorkflowViewModal(store.getState(), 110)).includes("▸ visit 1 · ✓ rework · agent session not loaded"));
    await controller.handleCommand(UI_COMMANDS.MODAL_PANE_NEXT);
    assert.equal(selectWorkflowViewSelection(store.getState()).occurrence.childSessionId, "child-r2", "Tab cycles");
    await controller.handleCommand(UI_COMMANDS.MODAL_PANE_PREV);
    await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.deepEqual(opened, ["child-r1"], "the first visit's own child, not the latest one");
    assert.equal(store.getState().ui.modal, null);
    assert.match(store.getState().ui.statusText, /Opened the agent session of review \(visit 1\): people can read it; the server refuses their input to it/);
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
    assert.equal(store.getState().ui.statusText, "Node fix has no agent session to open");
    assert.deepEqual(opened, []);
    await controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.equal(store.getState().ui.modal, null);

    store.dispatch({ type: "sessions/selected", sessionId: "a1" });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    assert.equal(store.getState().ui.modal, null);
    // Workflow Simplified (18): w opens the chat's Workflow pane; a chat with no Workflows says so.
    assert.equal(store.getState().ui.statusText, "This chat has no Workflows yet");
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
    assert.ok(details.includes("The Workflow's status could not be read: Gateway timeout"));

    const empty = harness({ events: [], model: null, transport: { readWorkflow: undefined } });
    await empty.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await settle();
    const view = selectWorkflowViewModal(empty.store.getState(), 110);
    assert.equal(view.rows.map(rowText).join(""), "No nodes to show.");
    assert.ok(view.detailsLines.length >= 1);
});

