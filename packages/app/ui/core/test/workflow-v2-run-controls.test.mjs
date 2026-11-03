/**
 * Workflow v2: a person's run controls in the workflow view (design 04 and
 * 07, mocks M04 and M16; R17, R26; INACTIVE):
 *   - no controls without `personCommands` (a deployment that takes no
 *     person's commands: the view stays read-only), and none without a run
 *   - the run's status decides which are offered: pause while the run waits
 *     to start or runs, resume while it is paused, stop and cancel until it
 *     ends; a stopping run takes only cancel, and an ended run none
 *   - only commands the workflow takes from people: a workflow in a
 *     workflow agent state's subtree offers pause, stop and cancel (never
 *     resume), with a note that names its controlling agent; a host without
 *     a graceful stop offers no Stop
 *   - disabled, with the reason as the title: a viewer who may not command
 *     the workflow (the portal's decision), a run whose controller cannot
 *     stop gracefully (Stop), and a command already being sent
 *   - the controller sends the shown run's control as an updateWorkflow
 *     command with the run's id and a new operation id; stop and cancel only
 *     after the confirm dialog; the read model is read again; a refusal is
 *     reported (a 409 conflict also reads the workflow again); an unanswered
 *     send keeps its operation id for Retry; one command at a time per
 *     workflow
 *   - the controls and the notice render in the workflow pane (server render)
 *
 * Run: node --test test/workflow-v2-run-controls.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, UI_COMMANDS, appReducer, createInitialState, createStore } from "../src/index.js";
import {
    WORKFLOW_V2_RUN_CONTROL_OPERATIONS, workflowV2RunCommandAccepted, workflowV2RunCommandConfirm, workflowV2RunCommandFailure,
    workflowV2RunCommandNotice, workflowV2RunControls,
} from "../src/workflow-v2-commands.js";
import { WorkflowMainPane } from "../../react/src/workflow-workspace.js";
import { RUN, readModel, subtreeCommands } from "./workflow-v2-fixtures.mjs";

const SID = "wf-run-controls";
const EVERY = ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel",
    "stop", "test", "test_respond", "test_advance"];
const commands = (extra = {}) => ({ operations: EVERY, restriction: null, run: { runId: RUN, stop: true }, ...extra });
const SUBTREE = subtreeCommands();
const STOPPING = { requestedAt: "2026-11-02T10:00:00.000Z", deadline: "2026-11-02T10:01:00.000Z", graceSeconds: 60, reason: null, settled: false };
const controlsOf = (run, personCommands = commands()) => workflowV2RunControls({ ...readModel({ run }), personCommands });
const operations = model => model?.controls.map(control => control.operation);

test("the run controls are pause, resume, stop and cancel, in that order", () => {
    assert.deepEqual([...WORKFLOW_V2_RUN_CONTROL_OPERATIONS], ["pause", "resume", "stop", "cancel"]);
});

test("no controls without personCommands (the deployment takes no person's commands) or without a run", () => {
    assert.equal(workflowV2RunControls(readModel()), null);
    assert.equal(workflowV2RunControls({ ...readModel({ noRun: true }), personCommands: commands() }), null);
    assert.equal(workflowV2RunControls({ ...readModel(), personCommands: "every" }), null);
    assert.equal(workflowV2RunControls({ ...readModel({ run: { status: "lost" } }), personCommands: commands() }), null);
    assert.equal(workflowV2RunControls(null), null);
});

test("the run's status decides which controls are offered", () => {
    assert.deepEqual(operations(controlsOf({ status: "running" })), ["pause", "stop", "cancel"]);
    assert.deepEqual(operations(controlsOf({ status: "admitted" })), ["pause", "stop", "cancel"]);
    assert.deepEqual(operations(controlsOf({ status: "paused", pausedFrom: "running" })), ["resume", "stop", "cancel"]);
    // A stopping run takes only cancel (pause, resume and another stop are refused while it stops).
    assert.deepEqual(operations(controlsOf({ status: "running", stop: STOPPING })), ["cancel"]);
    assert.deepEqual(operations(controlsOf({ status: "paused", pausedFrom: "running", stop: STOPPING })), ["cancel"]);
    for (const status of ["completed", "failed", "cancelled", "stopped"]) assert.deepEqual(operations(controlsOf({ status })), [], status);
    const running = controlsOf({ status: "running" });
    assert.equal(running.runId, RUN);
    assert.equal(running.restriction, null);
    assert.ok(running.controls.every(control => control.enabled && !control.pending), "every offered control is enabled");
    assert.deepEqual(running.controls.map(control => [control.label, control.danger]), [["Pause", false], ["Stop", false], ["Cancel", true]]);
    assert.match(running.controls.find(control => control.operation === "stop").title, /gracefully/);
});

test("a workflow in an agent state's subtree offers only a person's brakes, never resume, and names its controlling agent", () => {
    assert.deepEqual(operations(controlsOf({ status: "running" }, SUBTREE)), ["pause", "stop", "cancel"]);
    const paused = controlsOf({ status: "paused", pausedFrom: "running" }, SUBTREE);
    assert.deepEqual(operations(paused), ["stop", "cancel"]);
    assert.equal(paused.restriction, `${SUBTREE.restriction.reason} Its controlling agent is session parent-a.`);
    // A host without a graceful stop (controller 1.8.0) offers no Stop, here or anywhere.
    const plain = commands({ operations: EVERY.filter(operation => !["stop", "test", "test_respond", "test_advance"].includes(operation)), run: { runId: RUN, stop: false } });
    assert.deepEqual(operations(controlsOf({ status: "running" }, plain)), ["pause", "cancel"]);
    assert.deepEqual(operations(controlsOf({ status: "paused", pausedFrom: "admitted" }, plain)), ["resume", "cancel"]);
    // A restriction without its fields still says what it means.
    // ui-07: with no reason from the server, one short line, the same in the portal and the terminal.
    assert.equal(controlsOf({ status: "running" }, { ...SUBTREE, restriction: {} }).restriction, "People can only pause, stop or cancel this workflow.");
});

test("a control is disabled with its reason: the viewer may not command, the run cannot stop gracefully, a command is in flight", () => {
    const viewer = controlsOf({ status: "running" }, commands({ viewer: { allowed: false, reason: "Only the session owner (Alice) or an admin can do this." } }));
    assert.deepEqual(operations(viewer), ["pause", "stop", "cancel"]);
    assert.ok(viewer.controls.every(control => !control.enabled && control.title === "Only the session owner (Alice) or an admin can do this."));
    assert.equal(viewer.viewerReason, "Only the session owner (Alice) or an admin can do this.");
    assert.ok(controlsOf({ status: "running" }, commands({ viewer: { allowed: true, reason: null } })).controls.every(control => control.enabled));

    // The run was admitted for a controller that cannot stop it gracefully: Stop says so; the others stay enabled.
    const legacy = controlsOf({ status: "running" }, commands({ run: { runId: RUN, stop: false } }));
    const stop = legacy.controls.find(control => control.operation === "stop");
    assert.equal(stop.enabled, false);
    assert.match(stop.title, /cannot stop it gracefully; cancel it instead/);
    assert.ok(legacy.controls.filter(control => control.operation !== "stop").every(control => control.enabled));
    // What another run takes is not this run's.
    assert.ok(controlsOf({ status: "running" }, commands({ run: { runId: "run-other", stop: false } })).controls.every(control => control.enabled));

    const pending = workflowV2RunControls({ ...readModel({ run: { status: "running" } }), personCommands: commands() },
        { operation: "pause", runId: RUN, operationId: "ui-pause-1", phase: "pending" });
    assert.equal(pending.busy, true);
    assert.deepEqual(pending.controls.map(control => [control.label, control.enabled, control.pending]),
        [["Pausing…", false, true], ["Stop", false, false], ["Cancel", false, false]]);
    // A failed command does not disable anything.
    assert.ok(workflowV2RunControls({ ...readModel({ run: { status: "running" } }), personCommands: commands() },
        { operation: "pause", runId: RUN, phase: "failed", message: "no" }).controls.every(control => control.enabled));
});

test("stop and cancel are confirmed with what they do not undo; failures are refusals or unconfirmed; the notice says which", () => {
    assert.equal(workflowV2RunCommandConfirm("pause", RUN), null);
    assert.equal(workflowV2RunCommandConfirm("resume", RUN), null);
    assert.match(workflowV2RunCommandConfirm("stop", RUN).message, /^Stop run run-1\? No new step starts.*does not undo effects/);
    assert.equal(workflowV2RunCommandConfirm("cancel", RUN).confirmLabel, "Cancel Run");
    assert.match(workflowV2RunCommandConfirm("cancel", "0123456789abcdef").message, /^Cancel run 012345…cdef\? It ends now.*does not undo effects/);

    assert.match(workflowV2RunCommandAccepted("pause", RUN, { status: "paused", replayed: false }), /^Paused run run-1/);
    assert.match(workflowV2RunCommandAccepted("cancel", RUN, { replayed: true }), /ends when its controller applies it\. It had already been accepted\.$/);

    const refusal = Object.assign(new Error("Run run-1 is already paused."), { status: 409, code: "RUN_ALREADY_PAUSED" });
    assert.deepEqual(workflowV2RunCommandFailure(refusal), { phase: "failed", message: "Run run-1 is already paused.", code: "RUN_ALREADY_PAUSED" });
    assert.equal(workflowV2RunCommandFailure({ status: 501, code: "WORKFLOW_COMMANDS_UNAVAILABLE", message: "off" }).phase, "failed");
    assert.equal(workflowV2RunCommandFailure(new TypeError("Failed to fetch")).phase, "unconfirmed");
    assert.equal(workflowV2RunCommandFailure({ status: 500, message: "Internal error" }).phase, "unconfirmed");
    assert.equal(workflowV2RunCommandFailure({ message: "x".repeat(400) }).message.length, 300);

    assert.equal(workflowV2RunCommandNotice(null), null);
    assert.equal(workflowV2RunCommandNotice({ operation: "pause", runId: RUN, phase: "pending" }), null);
    assert.deepEqual(workflowV2RunCommandNotice({ operation: "pause", runId: RUN, phase: "failed", message: "Run run-1 is already paused." }), {
        level: "error", operation: "pause", runId: RUN, retry: false, text: "Pause was refused for run run-1: Run run-1 is already paused." });
    assert.deepEqual(workflowV2RunCommandNotice({ operation: "stop", runId: RUN, phase: "unconfirmed", message: "Failed to fetch" }), {
        level: "warning", operation: "stop", runId: RUN, retry: true,
        text: "Stop for run run-1 may not have reached the workflow: Failed to fetch. Retry sends the same command again." });
});

/** Let pending promise callbacks run, a bounded number of turns. */
async function until(check, label) {
    for (let turn = 0; turn < 200; turn += 1) {
        if (check()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail(`never reached: ${label}`);
}

function seeded({ answer, model = { ...readModel({ run: { status: "running" } }), personCommands: commands() }, withUpdate = true } = {}) {
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    const updates = [];
    const reads = [];
    const transport = {
        listSessions: async () => [],
        subscribeSession: () => () => {},
        getSessionEventsBefore: async () => [],
        readWorkflow: async (sessionId, options) => { reads.push([sessionId, options]); return model; },
    };
    if (withUpdate) transport.updateWorkflow = async (sessionId, command) => { updates.push([sessionId, command]); return answer(command); };
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: SID, title: "Workflow: w", status: "running", sessionKind: "workflow", updatedAt: 1 },
        { sessionId: "chat", title: "Chat", status: "running", updatedAt: 1 },
    ] });
    store.dispatch({ type: "sessions/selected", sessionId: SID });
    const view = () => store.getState().ui.workflowViews?.[SID] || {};
    return { controller, store, updates, reads, view };
}

const receipt = (command, status) => ({ workflowId: SID, operation: command.operation, replayed: false, runId: RUN, status, kvRevision: 1 });

test("a control is sent as the shown run's updateWorkflow command with a new operation id, and the read model is read again", async () => {
    const h = seeded({ answer: command => receipt(command, "paused") });
    const sent = await h.controller.sendWorkflowRunCommand(SID, { operation: "pause", runId: RUN });
    assert.equal(sent.ok, true);
    assert.equal(h.updates.length, 1);
    const [sessionId, command] = h.updates[0];
    assert.equal(sessionId, SID);
    assert.match(command.operation_id, /^ui-pause-./);
    assert.deepEqual({ ...command, operation_id: "id" }, { operation: "pause", operation_id: "id", run_id: RUN });
    assert.equal(h.view().runCommand, null);
    assert.match(h.store.getState().ui.statusText, /^Paused run run-1: no new step starts/);
    await until(() => h.reads.length === 1, "the read model read again");
    assert.deepEqual(h.reads[0], [SID, {}]);
    // Each send is a new command with its own operation id.
    await h.controller.sendWorkflowRunCommand(SID, { operation: "resume", runId: RUN });
    assert.equal(h.updates.length, 2);
    assert.notEqual(h.updates[1][1].operation_id, command.operation_id);
    assert.equal(h.updates[1][1].operation, "resume");
});

test("stop and cancel are sent only after the confirm dialog, for the run it names", async () => {
    const h = seeded({ answer: command => receipt(command, "running") });
    const asked = await h.controller.sendWorkflowRunCommand(SID, { operation: "stop", runId: RUN });
    assert.deepEqual(asked, { ok: false, reason: "confirming" });
    assert.equal(h.updates.length, 0);
    const modal = h.store.getState().ui.modal;
    assert.equal(modal.type, "confirm");
    assert.equal(modal.action, "workflowRunCommand");
    assert.deepEqual(modal.workflowRunCommand, { sessionId: SID, operation: "stop", runId: RUN });
    assert.equal(modal.confirmLabel, "Stop Run");
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.equal(h.store.getState().ui.modal, null);
    assert.equal(h.updates.length, 1);
    assert.deepEqual({ ...h.updates[0][1], operation_id: "id" }, { operation: "stop", operation_id: "id", run_id: RUN });
    assert.match(h.store.getState().ui.statusText, /^Stop accepted for run run-1/);

    await h.controller.sendWorkflowRunCommand(SID, { operation: "cancel", runId: RUN });
    assert.equal(h.store.getState().ui.modal.title, "Cancel Workflow Run");
    h.store.dispatch({ type: "ui/modal", modal: null });
    assert.equal(h.updates.length, 1, "a closed dialog sends nothing");
});

test("a refusal is reported and sends nothing more; an unanswered send keeps its operation id for Retry", async () => {
    let fail = Object.assign(new Error("Run run-1 is already paused."), { status: 409, code: "RUN_ALREADY_PAUSED" });
    const h = seeded({ answer: command => { if (fail) throw fail; return receipt(command, "paused"); } });
    const refused = await h.controller.sendWorkflowRunCommand(SID, { operation: "pause", runId: RUN });
    assert.equal(refused.reason, "failed");
    assert.deepEqual({ ...h.view().runCommand, operationId: "id" }, { operation: "pause", runId: RUN, operationId: "id", args: null, phase: "failed",
        message: "Run run-1 is already paused.", code: "RUN_ALREADY_PAUSED" });
    // A conflict says the view is stale: the workflow is read again, so it shows what the server saw.
    await until(() => h.reads.length === 1, "the read model read again after a conflict");
    h.controller.dismissWorkflowRunCommand(SID);
    assert.equal(h.view().runCommand, null);
    // Another refusal (403: not the viewer's to command) changes nothing that a read would show.
    fail = Object.assign(new Error("Only the session owner can do this."), { status: 403, code: "FORBIDDEN" });
    assert.equal((await h.controller.sendWorkflowRunCommand(SID, { operation: "pause", runId: RUN })).reason, "failed");
    for (let turn = 0; turn < 20; turn += 1) await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.reads.length, 1);
    h.controller.dismissWorkflowRunCommand(SID);

    // No answer: the same control for the same run is sent again with the same operation id.
    fail = new TypeError("Failed to fetch");
    await h.controller.sendWorkflowRunCommand(SID, { operation: "pause", runId: RUN });
    assert.equal(h.view().runCommand.phase, "unconfirmed");
    const first = h.updates.at(-1)[1].operation_id;
    fail = null;
    const retried = await h.controller.retryWorkflowRunCommand(SID);
    assert.equal(retried.ok, true);
    assert.equal(h.updates.at(-1)[1].operation_id, first);
    assert.equal(h.view().runCommand, null);
    assert.deepEqual(await h.controller.retryWorkflowRunCommand(SID), { ok: false, reason: "nothing to retry" });
    // Another control, or the same one for another run, is a new command.
    fail = new TypeError("Failed to fetch");
    await h.controller.sendWorkflowRunCommand(SID, { operation: "pause", runId: RUN });
    const unanswered = h.updates.at(-1)[1].operation_id;
    fail = null;
    await h.controller.sendWorkflowRunCommand(SID, { operation: "resume", runId: RUN });
    assert.notEqual(h.updates.at(-1)[1].operation_id, unanswered);
});

test("one command at a time per workflow; nothing is sent for an unknown control, a missing run, a non-workflow or a transport without commands", async () => {
    let release;
    const h = seeded({ answer: command => new Promise(resolve => { release = () => resolve(receipt(command, "paused")); }) });
    const first = h.controller.sendWorkflowRunCommand(SID, { operation: "pause", runId: RUN });
    await until(() => h.view().runCommand?.phase === "pending", "the pending command");
    assert.deepEqual(await h.controller.sendWorkflowRunCommand(SID, { operation: "cancel", runId: RUN, confirmed: true }), { ok: false, reason: "pending" });
    h.controller.dismissWorkflowRunCommand(SID);
    assert.equal(h.view().runCommand.phase, "pending", "a pending command is not dismissed");
    release();
    assert.equal((await first).ok, true);
    assert.equal(h.updates.length, 1);

    assert.equal((await h.controller.sendWorkflowRunCommand(SID, { operation: "recover", runId: RUN })).reason, "invalid");
    assert.equal((await h.controller.sendWorkflowRunCommand(SID, { operation: "pause" })).reason, "invalid");
    assert.equal((await h.controller.sendWorkflowRunCommand("chat", { operation: "pause", runId: RUN })).reason, "not a workflow");
    assert.equal(h.updates.length, 1);

    const old = seeded({ withUpdate: false });
    assert.equal((await old.controller.sendWorkflowRunCommand(SID, { operation: "pause", runId: RUN })).reason, "unsupported");
    assert.equal(old.store.getState().ui.statusText, "This connection cannot send workflow commands.");
});

function mount(view) {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", sessionKind: "workflow", title: "Watch" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view });
    return new PilotSwarmUiController({ store, transport: {} });
}
const main = controller => renderToStaticMarkup(React.createElement(WorkflowMainPane, { controller, log: null, icon: null }));

test("the workflow pane shows the controls in its header only when the read model offers them, and the last failure beside the graph", () => {
    const plain = main(mount({ readModel: readModel({ run: { status: "running" } }), readModelRunId: null }));
    assert.ok(!plain.includes("Run controls"), "a read model without personCommands has no controls");
    assert.ok(!plain.includes("data-operation"));

    const html = main(mount({ readModel: { ...readModel({ run: { status: "running" } }), personCommands: commands() }, readModelRunId: null }));
    assert.ok(html.includes("aria-label=\"Run controls\""));
    assert.ok(html.includes(`data-run-id="${RUN}"`));
    assert.deepEqual([...html.matchAll(/data-operation="([a-z]+)"/g)].map(match => match[1]), ["pause", "stop", "cancel"]);
    assert.ok(html.includes("ps-mini-button is-danger"), "cancel is styled as a danger");

    const restricted = main(mount({ readModel: { ...readModel({ run: { status: "paused", pausedFrom: "running" } }), personCommands: SUBTREE },
        readModelRunId: null }));
    assert.deepEqual([...restricted.matchAll(/data-operation="([a-z]+)"/g)].map(match => match[1]), ["stop", "cancel"]);
    assert.ok(restricted.includes("Its controlling agent is session parent-a."));

    // A model read for another selection offers no controls for this one.
    const other = main(mount({ readModel: { ...readModel({ run: { status: "running" } }), personCommands: commands() }, readModelRunId: "run-other" }));
    assert.ok(!other.includes("Run controls"));

    const notice = main(mount({ readModel: { ...readModel({ run: { status: "running" } }), personCommands: commands() }, readModelRunId: null,
        runCommand: { operation: "stop", runId: RUN, operationId: "ui-stop-1", phase: "unconfirmed", message: "Failed to fetch", code: null } }));
    assert.ok(notice.includes("Stop for run run-1 may not have reached the workflow: Failed to fetch. Retry sends the same command again."));
    assert.ok(notice.includes(">Retry<") && notice.includes(">Dismiss<"));
});

// Mocks M18 and M19 "Cancel test" / "Cancel" (accounting rows 67, 71): a running test run offers the same run controls as a
// live run, Cancel included, for exactly that run; once it has ended, none is enabled.
test("a test run offers Cancel (and its other run controls) as a live run does; an ended test run offers none", () => {
    const running = controlsOf({ mode: "test", status: "running" });
    assert.equal(running.mode, "test");
    assert.equal(running.runId, RUN);
    const cancel = running.controls.find(control => control.operation === "cancel");
    assert.ok(cancel, JSON.stringify(running.controls));
    assert.equal(cancel.enabled, true);
    assert.equal(cancel.label, "Cancel");
    const ended = controlsOf({ mode: "test", status: "completed", outcome: "succeeded" });
    assert.ok(ended.controls.every(control => !control.enabled), JSON.stringify(ended.controls));
});
