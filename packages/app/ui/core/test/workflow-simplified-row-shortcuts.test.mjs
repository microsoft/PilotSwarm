/**
 * Workflow Simplified, review UI-1: the session list's lifecycle actions target what it shows selected. A Workflow row
 * selected under its chat keeps the chat in the middle and is the highlighted row; the shortcuts c (cancel), d (done)
 * and D (delete), in the portal and in the terminal UI, then act on that Workflow, as its Terminate button does, and
 * never on the chat that owns it (whose cancel or delete would reach its other Workflows too). With the chat's own row
 * selected, they act on the chat as before.
 *
 * Run: node --test ui/core/test/workflow-simplified-row-shortcuts.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { PilotSwarmUiController, UI_COMMANDS, appReducer, createInitialState, createStore } from "../src/index.js";

const OWNER = "owner-1";
const workflow = (sessionId, n, status = "running") => ({
    sessionId, sessionKind: "workflow", title: "Workflow: check-items", status, parentSessionId: OWNER, createdAt: n, updatedAt: n,
});
const SESSIONS = [
    { sessionId: OWNER, title: "Stock check", status: "idle", createdAt: 0, updatedAt: 0 },
    workflow("wf-1", 1), workflow("wf-2", 2),
];

function harness() {
    const calls = [];
    const record = name => async (...args) => { calls.push([name, ...args]); };
    const transport = {
        cancelSession: record("cancelSession"), completeSession: record("completeSession"), deleteSession: record("deleteSession"),
        readWorkflow: async () => null, getSessionEvents: async () => [], getSessionEventsBefore: async () => [],
    };
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: SESSIONS });
    store.dispatch({ type: "sessions/expand", sessionId: OWNER });
    return { controller, store, calls };
}

for (const [key, command] of [["c", UI_COMMANDS.CANCEL_SESSION], ["d", UI_COMMANDS.DONE_SESSION]]) {
    test(`${key} on a highlighted Workflow row opens that Workflow's Terminate choices; nothing is sent to its chat`, async () => {
        const { controller, store, calls } = harness();
        store.dispatch({ type: "sessions/selected", sessionId: "wf-2" });
        assert.equal(store.getState().sessions.activeSessionId, OWNER, "the chat stays in the middle");
        assert.equal(controller.highlightedWorkflowRow(), "wf-2");
        await controller.handleCommand(command);
        const modal = store.getState().ui.modal;
        assert.equal(modal?.type, "terminatePicker");
        assert.equal(modal.sessionId, "wf-2", "bound to the highlighted Workflow");
        assert.equal(modal.title, "check-items #2");
        assert.ok(modal.workflow, "the Workflow's own choices");
        assert.deepEqual(calls, []);
    });
}

test("D on a highlighted Workflow row asks to delete that Workflow, not its chat", async () => {
    const { controller, store, calls } = harness();
    store.dispatch({ type: "sessions/selected", sessionId: "wf-1" });
    await controller.handleCommand(UI_COMMANDS.DELETE_SESSION);
    const modal = store.getState().ui.modal;
    assert.equal(modal?.type, "confirm");
    assert.equal(modal.action, "deleteWorkflow");
    assert.equal(modal.sessionId, "wf-1");
    assert.match(modal.message, /^Delete check-items #1\?/);
    assert.deepEqual(calls, []);
});

test("with the chat's own row selected, c, d and D act on the chat as before", async () => {
    for (const command of [UI_COMMANDS.CANCEL_SESSION, UI_COMMANDS.DONE_SESSION, UI_COMMANDS.DELETE_SESSION]) {
        const { controller, store } = harness();
        store.dispatch({ type: "sessions/selected", sessionId: "wf-2" });
        store.dispatch({ type: "sessions/selected", sessionId: OWNER });
        assert.equal(controller.highlightedWorkflowRow(), null);
        await controller.handleCommand(command);
        const modal = store.getState().ui.modal;
        assert.ok(modal && modal.type !== "terminatePicker" && modal.action !== "deleteWorkflow", `${command}: ${JSON.stringify(modal)}`);
        assert.ok(!modal.sessionId || modal.sessionId === OWNER, command);
    }
});

test("the portal and the terminal UI send c, d and D to the same controller commands", () => {
    const webApp = fs.readFileSync(new URL("../../react/src/web-app.js", import.meta.url), "utf8");
    const tui = fs.readFileSync(new URL("../../../tui/src/app.js", import.meta.url), "utf8");
    for (const command of ["CANCEL_SESSION", "DONE_SESSION", "DELETE_SESSION"]) {
        assert.ok(webApp.includes(`controller.handleCommand(UI_COMMANDS.${command})`), `portal ${command}`);
        assert.ok(tui.includes(`controller.handleCommand(UI_COMMANDS.${command})`), `terminal UI ${command}`);
    }
});

// Review UI-D1: the terminal UI draws no Terminate picker, so its c and d on a highlighted Workflow open the confirm dialog
// it draws and handles (Enter or y sends, Esc or n closes): d stops the Workflow (started nodes finish), c cancels it now,
// each bound to that Workflow's id and its live run only.
function terminalHarness({ status = "running" } = {}) {
    const calls = [];
    const record = name => async (...args) => { calls.push([name, ...args]); return { receipt: { status: "running" } }; };
    const transport = {
        cancelSession: record("cancelSession"), completeSession: record("completeSession"), deleteSession: record("deleteSession"),
        updateWorkflow: record("updateWorkflow"),
        readWorkflow: async () => null, getSessionEvents: async () => [], getSessionEventsBefore: async () => [],
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport, terminal: true });
    store.dispatch({ type: "sessions/loaded", sessions: [SESSIONS[0], workflow("wf-1", 1), workflow("wf-2", 2, status)] });
    store.dispatch({ type: "sessions/expand", sessionId: OWNER });
    for (const [id, runId] of [["wf-1", "run-a"], ["wf-2", "run-b"]]) {
        store.dispatch({ type: "ui/workflowView", sessionId: id, view: { readModel: {
            workflowId: id, runs: [{ runId, mode: "live", status }], run: { runId, mode: "live", status } } } });
    }
    store.dispatch({ type: "sessions/selected", sessionId: "wf-2" });
    return { controller, store, calls };
}

for (const [key, command, operation, label] of [
    ["d", UI_COMMANDS.DONE_SESSION, "stop", "Let started nodes finish"],
    ["c", UI_COMMANDS.CANCEL_SESSION, "cancel", "Cancel now"],
]) {
    test(`terminal UI: ${key} on a highlighted Workflow confirms in the terminal, then sends ${operation} for its live run only`, async () => {
        const { controller, store, calls } = terminalHarness();
        await controller.handleCommand(command);
        const modal = store.getState().ui.modal;
        assert.equal(modal?.type, "confirm", "a dialog the terminal draws and handles");
        assert.equal(modal.confirmLabel, label);
        assert.match(modal.message, /check-items #2/);
        assert.deepEqual(modal.workflowRunCommand, { sessionId: "wf-2", operation, runId: "run-b" });
        assert.deepEqual(calls, [], "nothing before the confirm");
        await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
        assert.deepEqual(calls.map(([name, id, body]) => [name, id, body?.operation, body?.run_id]), [["updateWorkflow", "wf-2", operation, "run-b"]]);
        assert.ok(!calls.some(([name]) => name !== "updateWorkflow"), "nothing to the owner chat");
    });
}

test("terminal UI: Esc closes the dialog without a command; an ended Workflow says so and opens nothing", async () => {
    const open = terminalHarness();
    await open.controller.handleCommand(UI_COMMANDS.CANCEL_SESSION);
    await open.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.equal(open.store.getState().ui.modal, null);
    assert.deepEqual(open.calls, []);
    const ended = terminalHarness({ status: "completed" });
    await ended.controller.handleCommand(UI_COMMANDS.DONE_SESSION);
    assert.equal(ended.store.getState().ui.modal, null);
    assert.match(ended.store.getState().ui.statusText ?? "", /check-items #2 has already ended/);
    assert.deepEqual(ended.calls, []);
});

test("terminal UI: the host makes a terminal controller, draws the confirm dialog and takes Enter, y, Esc and n in it", () => {
    const index = fs.readFileSync(new URL("../../../tui/src/index.js", import.meta.url), "utf8");
    const app = fs.readFileSync(new URL("../../../tui/src/app.js", import.meta.url), "utf8");
    const components = fs.readFileSync(new URL("../../react/src/components.js", import.meta.url), "utf8");
    assert.match(index, /new PilotSwarmUiController\(\{ store, transport, terminal: true \}\)/);
    assert.match(app, /if \(modal\.type === "confirm"\) \{\s*if \(key\.escape \|\| input === "n" \|\| input === "q"\) \{\s*controller\.handleCommand\(UI_COMMANDS\.CLOSE_MODAL\)/);
    assert.match(app, /if \(key\.return \|\| input === "y"\) \{\s*controller\.handleCommand\(UI_COMMANDS\.MODAL_CONFIRM\)/);
    assert.match(components, /React\.createElement\(ConfirmModalContainer, \{ controller \}\)/);
    assert.doesNotMatch(components, /terminatePicker/, "the terminal has no Terminate picker, so it must never open one");
});
