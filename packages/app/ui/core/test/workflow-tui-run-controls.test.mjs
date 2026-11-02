// A person's run controls in the TUI's workflow view (design 04, 07, mocks M04, M16; R17, R26; INACTIVE: only a
// deployment that takes a person's workflow commands offers any): p pause, r resume, s stop and c cancel for the run
// the view shows, the portal's controls (workflowV2RunControls) sent as the portal sends them (the shared controller's
// sendWorkflowRunCommand, an updateWorkflow command through the transport). Stop and cancel ask first, and the dialog
// returns to the view. One command at a time, and what is being sent is shown. A refusal and an answer that never
// came are shown with what to press; the same control then sends the same command (the same operation id) again, and
// d dismisses the notice. A control the run does not take is not sent, and the status line says why: the subtree rule
// (a workflow in an agent state's subtree takes only pause, stop and cancel from people), a run that ended or is
// stopping, a controller that cannot stop gracefully, a deployment that takes no person's commands.
//
// Run: node --test packages/app/ui/core/test/workflow-tui-run-controls.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController, UI_COMMANDS, appReducer, buildHistoryModel, createInitialState, createStore, selectWorkflowViewModal,
} from "../src/index.js";
import { RUN, readModel } from "./workflow-v2-fixtures.mjs";

const states = [
    { id: "review", type: "agent", invoke: { source: "agent", name: "code-reviewer" }, timeoutSeconds: 600, outcomes: ["accepted"],
        next: { accepted: "done", timed_out: "failed" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const graph = { revision: 1, initial: "review", states };
/** Every command a 1.9.0 host takes from people (human-commands.ts), in its order. */
const ALL = ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel", "stop",
    "test", "test_respond", "test_advance"];
const SUBTREE = "This workflow runs in a workflow agent state's subtree: people can pause, stop or cancel it; only its controlling "
    + "agent changes, resumes or tests it.";

/** The live run in `status` (with `run`'s other fields), and the commands its workflow takes from people (`commands`; null: none). */
function model({ status = "running", run = {}, commands = { operations: ALL, restriction: null, run: { runId: RUN, stop: true } } } = {}) {
    const base = readModel({ graph, run: { status, ...run } });
    return commands ? { ...base, personCommands: commands } : base;
}

/** The workflow session wf with `initial` loaded; updateWorkflow answers with `answer` (or { ok: true }). */
function harness(initial, { answer = null } = {}) {
    let current = initial;
    const calls = [];
    const transport = {
        getSessionEventsBefore: async () => [],
        readWorkflow: async (...args) => { calls.push(["readWorkflow", ...args]); return current; },
        updateWorkflow: async (...args) => { calls.push(["updateWorkflow", ...args]); return answer ? answer(...args) : { ok: true }; },
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: review-flow", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: initial, readModelRunId: null } });
    return {
        controller, store, calls,
        sent: () => calls.filter(call => call[0] === "updateWorkflow"),
        reads: () => calls.filter(call => call[0] === "readWorkflow").length,
        serve: next => { current = next; },
    };
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const details = store => selectWorkflowViewModal(store.getState(), 110).detailsLines.map(line => line.text);
/** The details as one text: wrapped lines joined, so a wrapped sentence reads whole. */
const detailText = store => details(store).map(line => line.trim()).join(" ");
const statusOf = store => store.getState().ui.statusText;

test("the view lists the shown run's controls with their keys; p pauses it as the portal would, and the view stays open", async () => {
    const h = harness(model());
    await h.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await settle();
    assert.ok(details(h.store).includes("Run controls: p pause · s stop · c cancel — stop and cancel ask first"), details(h.store).join("\n"));
    const reads = h.reads();
    h.serve(model({ status: "paused" }));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_PAUSE_RUN);
    const [sent] = h.sent();
    assert.equal(sent[1], "wf");
    const { operation_id: operationId, ...wire } = sent[2];
    assert.deepEqual(wire, { operation: "pause", run_id: RUN });
    assert.match(operationId, /^ui-pause-/);
    assert.equal(statusOf(h.store), `Paused run ${RUN}: no new state starts; work already started finishes.`);
    assert.equal(h.store.getState().ui.modal.type, "workflowView");
    // The workflow is read again at once, so the view shows what the server now says.
    await settle();
    await settle();
    assert.ok(h.reads() > reads);
    assert.ok(details(h.store).includes("Run controls: r resume · s stop · c cancel — stop and cancel ask first"), details(h.store).join("\n"));
});

test("stop and cancel ask first; the dialog returns to the view as it was, and a dialog closed without confirming sends nothing", async () => {
    const h = harness(model());
    await h.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    const view = h.store.getState().ui.modal;
    assert.notEqual(view.selectedNodeId, "review", "another state is selected, so the view's own state is seen to come back");

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_STOP_RUN);
    let modal = h.store.getState().ui.modal;
    assert.equal(modal.type, "confirm");
    assert.equal(modal.title, "Stop Workflow Run");
    assert.equal(modal.confirmLabel, "Stop Run");
    assert.match(modal.message, new RegExp(`^Stop run ${RUN}\\? No new state starts`));
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.deepEqual(h.store.getState().ui.modal, view);
    assert.equal(statusOf(h.store), "Stop was not sent");
    assert.deepEqual(h.sent(), []);

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_CANCEL_RUN);
    modal = h.store.getState().ui.modal;
    assert.equal(modal.title, "Cancel Workflow Run");
    assert.equal(modal.confirmLabel, "Cancel Run");
    assert.match(modal.message, /A cancel does not undo effects that already happened\.$/);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.deepEqual(h.store.getState().ui.modal, view);
    const sent = h.sent();
    assert.equal(sent.length, 1);
    assert.equal(sent[0][2].operation, "cancel");
    assert.equal(sent[0][2].run_id, RUN);
    assert.equal(statusOf(h.store), `Cancel accepted for run ${RUN}: the run ends when its controller applies it.`);
});

test("a control the run does not take is not sent, and the status line says why", async () => {
    const opened = async (readModelValue) => {
        const h = harness(readModelValue);
        await h.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
        await settle();
        return h;
    };
    const all = [];
    // A running run is not paused.
    const running = await opened(model());
    all.push(running);
    await running.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_RESUME_RUN);
    assert.equal(statusOf(running.store), "Resume is not available for this run. The run is not paused.");

    // In an agent state's subtree, people pause, stop or cancel the workflow; only its controlling agent resumes it.
    const subtree = await opened(model({ status: "paused", commands: { operations: ["pause", "stop", "cancel"],
        restriction: { reason: SUBTREE, workflowSessionId: "outer", controllingSessionId: "parent-1" }, run: { runId: RUN, stop: true } } }));
    all.push(subtree);
    const restriction = `${SUBTREE} Its controlling agent is session parent-1.`;
    assert.ok(details(subtree.store).includes("Run controls: s stop · c cancel — stop and cancel ask first"), details(subtree.store).join("\n"));
    assert.ok(detailText(subtree.store).includes(restriction), details(subtree.store).join("\n"));
    assert.ok(details(subtree.store).every(line => line.length <= 106), "wrapped, not cut");
    await subtree.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_RESUME_RUN);
    assert.equal(statusOf(subtree.store), `Resume is not available for this run. ${restriction}`);
    await subtree.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_PAUSE_RUN);
    assert.equal(statusOf(subtree.store), "Pause is not available for this run. The run is already paused.");

    // A controller that cannot stop the run gracefully: stop is listed, not available now; no dialog opens.
    const noStop = await opened(model({ commands: { operations: ALL, restriction: null, run: { runId: RUN, stop: false } } }));
    all.push(noStop);
    assert.ok(details(noStop.store).includes("Run controls: p pause · s stop (not now) · c cancel — stop and cancel ask first"));
    assert.ok(details(noStop.store).includes("  This run's controller cannot stop it gracefully; cancel it instead."));
    await noStop.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_STOP_RUN);
    assert.equal(noStop.store.getState().ui.modal.type, "workflowView");
    assert.equal(statusOf(noStop.store), "Stop is not available now. This run's controller cannot stop it gracefully; cancel it instead.");

    // An ended run takes none; a stopping run takes only cancel.
    const ended = await opened(model({ status: "completed" }));
    all.push(ended);
    assert.ok(details(ended.store).includes("Run controls: none for this run (completed)."), details(ended.store).join("\n"));
    await ended.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_CANCEL_RUN);
    assert.equal(statusOf(ended.store), "Cancel is not available for this run. The run has ended (completed).");
    const stopping = await opened(model({ run: { stop: { requestedAt: "2026-11-02T10:00:00.000Z", deadline: "2026-11-02T10:05:00.000Z",
        graceSeconds: 300, reason: null, settled: false } } }));
    all.push(stopping);
    assert.ok(details(stopping.store).includes("Run controls: c cancel — stop and cancel ask first"), details(stopping.store).join("\n"));
    await stopping.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_PAUSE_RUN);
    assert.equal(statusOf(stopping.store), "Pause is not available for this run. The run is stopping; only cancel applies.");

    // A deployment that takes no person's workflow commands: the view stays read-only.
    const none = await opened(model({ commands: null }));
    all.push(none);
    assert.ok(!details(none.store).some(line => line.startsWith("Run controls")));
    await none.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_PAUSE_RUN);
    assert.equal(statusOf(none.store), "Pause is not available for this run. This deployment takes no workflow commands from people.");

    for (const h of all) assert.deepEqual(h.sent(), []);
});

test("one command at a time, shown while it is sent; a refusal and an answer that never came say what to press; d dismisses", async () => {
    const answers = [];
    const h = harness(model(), { answer: () => answers.shift()() });
    await h.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await settle();

    // While the pause is being sent, it says so and nothing else is sent.
    let lose;
    answers.push(() => new Promise((_, reject) => { lose = () => reject(Object.assign(new Error("upstream unavailable"), { status: 503 })); }));
    const sending = h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_PAUSE_RUN);
    await settle();
    let lines = details(h.store);
    assert.ok(lines.includes("Run controls: p pausing… · s stop (not now) · c cancel (not now) — stop and cancel ask first"), lines.join("\n"));
    assert.ok(lines.includes("  This command is being sent."));
    assert.ok(lines.includes("  Another command for this workflow is being sent."));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_STOP_RUN);
    assert.equal(statusOf(h.store), "Stop is not available now. Another command for this workflow is being sent.");
    assert.equal(h.store.getState().ui.modal.type, "workflowView");

    // Its answer never came: the notice says so and what to press; the status line says it too.
    lose();
    await sending;
    const unconfirmed = `Pause for run ${RUN} may not have reached the workflow: upstream unavailable. Retry sends the same command again.`;
    assert.equal(statusOf(h.store), unconfirmed);
    assert.ok(detailText(h.store).includes(`! ${unconfirmed}`), details(h.store).join("\n"));
    assert.ok(detailText(h.store).includes("p sends the same command again (the server applies it once) · d dismisses this notice"));

    // p sends the same command again, with the same operation id; the server applies it once.
    answers.push(async () => ({ operation: "pause", status: "paused" }));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_PAUSE_RUN);
    const [first, again] = h.sent();
    assert.equal(again[2].operation, "pause");
    assert.equal(again[2].operation_id, first[2].operation_id);
    assert.equal(statusOf(h.store), `Paused run ${RUN}: no new state starts; work already started finishes.`);
    assert.ok(!detailText(h.store).includes("may not have reached the workflow"));

    // A refusal: the server decided and nothing changed. d dismisses its notice; it sends and undoes nothing.
    answers.push(async () => { throw Object.assign(new Error(`Run ${RUN} is not active.`), { status: 409, code: "RUN_NOT_ACTIVE" }); });
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_PAUSE_RUN);
    const refused = `Pause was refused for run ${RUN}: Run ${RUN} is not active.`;
    assert.equal(statusOf(h.store), refused);
    lines = details(h.store);
    assert.ok(detailText(h.store).includes(`! ${refused}`), lines.join("\n"));
    assert.ok(lines.includes("  d dismisses this notice"), lines.join("\n"));
    const sentBefore = h.sent().length;
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_DISMISS_NOTICE);
    assert.equal(statusOf(h.store), "Notice dismissed");
    assert.ok(!detailText(h.store).includes("was refused"));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_DISMISS_NOTICE);
    assert.equal(statusOf(h.store), "No notice to dismiss");
    assert.equal(h.sent().length, sentBefore);
});
