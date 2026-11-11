/**
 * Workflow: a person changes a run's variables (its open KV) in the
 * workflow view (design 02 open KV, 04 set_vars, 07 mock M15; R04, R05,
 * R26; INACTIVE):
 *   - no variables panel without `personCommands` (the view stays as it was)
 *     or without a run
 *   - the list is read from the read model's preview of the map (canonical
 *     JSON, cut at 4,000 characters): names and JSON values; a cut preview is
 *     shown as its start, an unreadable one as unreadable
 *   - a person may change them only when the workflow takes set_vars from
 *     people (never in a workflow agent state's subtree, where the reason
 *     names its controlling agent), the run has not ended, the viewer may
 *     command it and the revision is known
 *   - what a person types is checked: a name of 1 to 128 characters kept
 *     exactly as typed, and a JSON value (null is a value)
 *   - the controller sends one update for the shown run at the revision
 *     shown: a set at once, a removal after the confirm dialog; the read
 *     model is read again; a changed map (409 KV_REVISION_CONFLICT) is
 *     reported and read again; an unanswered update is sent again with the
 *     same operation id and the same keys
 *   - the panel opens from the header's Variables button (server render)
 *
 * Run: node --test test/workflow-variables.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, UI_COMMANDS, appReducer, createInitialState, createStore } from "../src/index.js";
import {
    workflowRunCommandAccepted, workflowRunCommandArgs, workflowRunCommandConfirm, workflowRunCommandNotice, workflowRunCommandWire,
    workflowRunVariables, workflowVariableDraft, workflowVariableRemoval,
} from "../src/workflow-commands.js";
import { WorkflowMainPane, WorkflowNodePane } from "../../react/src/workflow-workspace.js";
import { RUN, readModel, subtreeCommands } from "./workflow-fixtures.mjs";

const SID = "wf-variables";
const EVERY = ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel",
    "stop", "test", "test_respond", "test_advance"];
const commands = (extra = {}) => ({ operations: EVERY, restriction: null, run: { runId: RUN, stop: true }, ...extra });
const SUBTREE = subtreeCommands();
const KV = "{\"note\":\"review backup\",\"pollSeconds\":120,\"reviewer\":null}";
const variablesOf = (run, personCommands = commands(), command = null) =>
    workflowRunVariables({ ...readModel({ run }), personCommands }, command);

test("no variables panel without personCommands (the deployment takes no person's commands) or without a run", () => {
    assert.equal(workflowRunVariables(readModel()), null);
    assert.equal(workflowRunVariables({ ...readModel({ noRun: true }), personCommands: commands() }), null);
    assert.equal(workflowRunVariables({ ...readModel({ run: { status: "lost" } }), personCommands: commands() }), null);
    assert.equal(workflowRunVariables(null), null);
});

test("the list is read from the preview of the map: names and JSON values, a cut preview as its start", () => {
    const shown = variablesOf({ kv: KV, kvRevision: 9 });
    assert.deepEqual(shown.entries.map(entry => [entry.key, entry.valueText]),
        [["note", "\"review backup\""], ["pollSeconds", "120"], ["reviewer", "null"]]);
    assert.deepEqual({ runId: shown.runId, revision: shown.revision, complete: shown.complete, note: shown.note, editable: shown.editable, reason: shown.reason },
        { runId: RUN, revision: 9, complete: true, note: null, editable: true, reason: null });
    assert.equal(variablesOf({}).note, "No variables yet.");

    // A preview cut at 4,000 characters ends with "…": only its start is shown, and a named variable can still be changed.
    const cut = variablesOf({ kv: `{"a":"${"x".repeat(20)}…`, kvRevision: 2 });
    assert.deepEqual([cut.complete, cut.entries, cut.editable], [false, [], true]);
    assert.match(cut.note, /longer than this view/);
    assert.ok(cut.preview.endsWith("…"));
    for (const kv of ["[1,2]", "not json", 5]) assert.equal(variablesOf({ kv }).note, "The variables could not be read.", String(kv));

    // A long value is shown cut and edited whole; a "__proto__" name is plain data.
    const long = "y".repeat(400);
    const big = variablesOf({ kv: JSON.stringify({ big: long }) }).entries[0];
    assert.equal(big.valueText, JSON.stringify(long));
    assert.equal(big.displayText.length, 300);
    assert.ok(big.displayText.endsWith("…"));
    assert.deepEqual(variablesOf({ kv: "{\"__proto__\":{\"x\":1}}" }).entries.map(entry => [entry.key, entry.valueText]), [["__proto__", "{\"x\":1}"]]);
});

test("a person may change them only where the workflow takes set_vars, the run is active, the viewer may command it and the revision is known", () => {
    const subtree = variablesOf({ kv: KV, kvRevision: 3 }, SUBTREE);
    assert.equal(subtree.editable, false);
    assert.equal(subtree.reason, SUBTREE.restriction.reason);
    assert.equal(subtree.entries.length, 3, "people can still read them");
    assert.match(variablesOf({ status: "completed", kv: KV, kvRevision: 3 }).reason, /^This Workflow has ended; its variables no longer change\./);
    assert.equal(variablesOf({ kv: KV, kvRevision: 3 }, commands({ viewer: { allowed: false, reason: "Only the session owner (Alice) or an admin can do this." } })).reason,
        "Only the session owner (Alice) or an admin can do this.");
    assert.match(variablesOf({ kv: KV, kvRevision: null }).reason, /revision is not known/);
    assert.equal(variablesOf({ status: "paused", pausedFrom: "running", kv: KV, kvRevision: 3 }).editable, true, "a paused run still takes variables");
    // A command in flight: nothing else is sent; an update of this run is marked pending.
    const pending = variablesOf({ kv: KV, kvRevision: 3 }, commands(), { operation: "set_vars", runId: RUN, phase: "pending" });
    assert.deepEqual([pending.editable, pending.busy, pending.pending], [true, true, true]);
    const other = variablesOf({ kv: KV, kvRevision: 3 }, commands(), { operation: "pause", runId: RUN, phase: "pending" });
    assert.deepEqual([other.busy, other.pending], [true, false]);
});

test("what a person types is checked: a name kept exactly, a JSON value; the command carries the revision shown", () => {
    assert.deepEqual(workflowVariableDraft("note", "\"review backup\""), { ok: true, set: { note: "review backup" } });
    assert.deepEqual(workflowVariableDraft(" spaced ", "null"), { ok: true, set: { " spaced ": null } });
    assert.equal(workflowVariableDraft("k".repeat(128), "1").ok, true);
    for (const name of ["", "k".repeat(129)]) assert.match(workflowVariableDraft(name, "1").error, /^Name the variable \(1 to 128 characters\)/);
    assert.match(workflowVariableDraft("note", "review backup").error, /^The value must be JSON \(a string needs quotes\): /);
    assert.match(workflowVariableDraft("note", "  ").error, /^Give the value as JSON/);
    const proto = workflowVariableDraft("__proto__", "{\"polluted\":true}");
    assert.equal(Object.hasOwn(proto.set, "__proto__"), true);
    assert.equal({}.polluted, undefined);
    assert.deepEqual(workflowVariableRemoval("note"), { ok: true, delete: ["note"] });
    assert.match(workflowVariableRemoval("").error, /^Name the variable to remove/);

    assert.deepEqual(workflowRunCommandArgs("pause", { set: { a: 1 } }), { ok: true, args: null });
    assert.deepEqual(workflowRunCommandArgs("set_vars", { set: { a: 1 }, expectedKvRevision: 3 }),
        { ok: true, args: { set: { a: 1 }, delete: [], expectedKvRevision: 3 } });
    for (const input of [{ expectedKvRevision: 3 }, { set: { a: 1 } }, { set: { a: 1 }, expectedKvRevision: 0 },
        { set: { a: 1 }, delete: ["a"], expectedKvRevision: 3 }, { delete: ["a", "a"], expectedKvRevision: 3 }, { set: [1], expectedKvRevision: 3 },
        { delete: [1], expectedKvRevision: 3 }, { delete: ["k".repeat(129)], expectedKvRevision: 3 }, null]) {
        assert.deepEqual(workflowRunCommandArgs("set_vars", input), { ok: false }, JSON.stringify(input));
    }
    assert.deepEqual(workflowRunCommandArgs("recover", {}), { ok: false });
    assert.deepEqual(workflowRunCommandWire("set_vars", RUN, "op-1", { set: { a: 1 }, delete: [], expectedKvRevision: 3 }),
        { operation: "set_vars", operation_id: "op-1", run_id: RUN, set: { a: 1 }, expected_kv_revision: 3 });
    assert.deepEqual(workflowRunCommandWire("set_vars", RUN, "op-2", { set: {}, delete: ["a"], expectedKvRevision: 3 }),
        { operation: "set_vars", operation_id: "op-2", run_id: RUN, delete: ["a"], expected_kv_revision: 3 });
    assert.deepEqual(workflowRunCommandWire("pause", RUN, "op-3"), { operation: "pause", operation_id: "op-3", run_id: RUN });

    assert.equal(workflowRunCommandConfirm("set_vars", RUN, { set: { a: 1 }, delete: [], expectedKvRevision: 3 }), null);
    const removal = workflowRunCommandConfirm("set_vars", RUN, { set: {}, delete: ["note"], expectedKvRevision: 3 });
    assert.deepEqual([removal.title, removal.confirmLabel], ["Remove Workflow Variable", "Remove"]);
    assert.match(removal.message, /^Remove 'note' from the variables\? Nodes that start from now on do not see it; started nodes keep/);
    assert.equal(workflowRunCommandConfirm("set_vars", RUN, { set: {}, delete: ["a", "b"], expectedKvRevision: 3 }).title, "Remove Workflow Variables");
    assert.match(workflowRunCommandAccepted("set_vars", RUN, { kvRevision: 4, replayed: false }, { set: { note: "x" }, delete: [], expectedKvRevision: 3 }),
        /^Variables updated · set 'note' · revision 4\. Nodes that start from now on see them\.$/);
    assert.equal(workflowRunCommandNotice({ operation: "set_vars", runId: RUN, phase: "failed", message: "The run's KV is at revision 4, not 3." }).text,
        "Variables not saved: The run's KV is at revision 4, not 3.");
});

/** Let pending promise callbacks run, a bounded number of turns. */
async function until(check, label) {
    for (let turn = 0; turn < 200; turn += 1) {
        if (check()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail(`never reached: ${label}`);
}

function seeded(answer) {
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    const updates = [];
    const reads = [];
    const model = { ...readModel({ run: { status: "running", kv: KV, kvRevision: 3 } }), personCommands: commands() };
    const transport = {
        listSessions: async () => [],
        subscribeSession: () => () => {},
        getSessionEventsBefore: async () => [],
        readWorkflow: async (sessionId, options) => { reads.push([sessionId, options]); return model; },
        updateWorkflow: async (sessionId, command) => { updates.push([sessionId, command]); return answer(command); },
    };
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SID, title: "Workflow: w", status: "running", sessionKind: "workflow", updatedAt: 1 }] });
    store.dispatch({ type: "sessions/selected", sessionId: SID });
    const view = () => store.getState().ui.workflowViews?.[SID] || {};
    return { controller, store, updates, reads, view };
}

const accepted = () => ({ workflowId: SID, operation: "set_vars", replayed: false, runId: RUN, status: "running", kvRevision: 4 });
const without = (command, key) => Object.fromEntries(Object.entries(command).filter(([name]) => name !== key));

test("a set is sent at once as the shown run's update at the revision shown, and the workflow is read again", async () => {
    const h = seeded(accepted);
    const sent = await h.controller.sendWorkflowRunCommand(SID, { operation: "set_vars", runId: RUN, set: { note: "new" }, expectedKvRevision: 3 });
    assert.equal(sent.ok, true);
    const [sessionId, command] = h.updates[0];
    assert.equal(sessionId, SID);
    assert.match(command.operation_id, /^ui-set_vars-./);
    assert.deepEqual(without(command, "operation_id"), { operation: "set_vars", run_id: RUN, set: { note: "new" }, expected_kv_revision: 3 });
    assert.equal(h.view().runCommand, null);
    assert.match(h.store.getState().ui.statusText, /^Variables updated · set 'note' · revision 4/);
    await until(() => h.reads.length === 1, "the read model read again");
    // Nothing is sent for a variables update that is not one.
    for (const input of [{ set: {}, expectedKvRevision: 3 }, { set: { note: 1 } }, { set: { note: 1 }, delete: ["note"], expectedKvRevision: 3 }]) {
        assert.deepEqual(await h.controller.sendWorkflowRunCommand(SID, { operation: "set_vars", runId: RUN, ...input }), { ok: false, reason: "invalid" });
    }
    assert.equal(h.updates.length, 1);
});

test("a removal is sent only after the confirm dialog, with the keys and revision it named", async () => {
    const h = seeded(accepted);
    const asked = await h.controller.sendWorkflowRunCommand(SID, { operation: "set_vars", runId: RUN, delete: ["note"], expectedKvRevision: 3 });
    assert.deepEqual(asked, { ok: false, reason: "confirming" });
    assert.equal(h.updates.length, 0);
    const modal = h.store.getState().ui.modal;
    assert.deepEqual([modal.type, modal.action, modal.title], ["confirm", "workflowRunCommand", "Remove Workflow Variable"]);
    assert.deepEqual(modal.workflowRunCommand, { sessionId: SID, operation: "set_vars", runId: RUN, set: {}, delete: ["note"], expectedKvRevision: 3 });
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.equal(h.updates.length, 1);
    assert.deepEqual(without(h.updates[0][1], "operation_id"), { operation: "set_vars", run_id: RUN, delete: ["note"], expected_kv_revision: 3 });
    assert.match(h.store.getState().ui.statusText, /^Variables updated · removed 'note' · revision 4/);
});

test("a changed map is refused and read again; an unanswered update is sent again with the same operation id and keys", async () => {
    let fail = Object.assign(new Error("The run's KV is at revision 4, not 3."), { status: 409, code: "KV_REVISION_CONFLICT", details: { kvRevision: 4 } });
    const h = seeded(command => { if (fail) throw fail; return accepted(command); });
    const refused = await h.controller.sendWorkflowRunCommand(SID, { operation: "set_vars", runId: RUN, set: { note: "new" }, expectedKvRevision: 3 });
    assert.equal(refused.reason, "failed");
    assert.deepEqual(without(h.view().runCommand, "operationId"), { operation: "set_vars", runId: RUN,
        args: { set: { note: "new" }, delete: [], expectedKvRevision: 3 }, phase: "failed", message: "The run's KV is at revision 4, not 3.", code: "KV_REVISION_CONFLICT" });
    assert.equal(workflowRunCommandNotice(h.view().runCommand).text, "Variables not saved: The run's KV is at revision 4, not 3.");
    await until(() => h.reads.length === 1, "the read model read again after the conflict");
    h.controller.dismissWorkflowRunCommand(SID);

    fail = new TypeError("Failed to fetch");
    await h.controller.sendWorkflowRunCommand(SID, { operation: "set_vars", runId: RUN, set: { note: "newer" }, expectedKvRevision: 4 });
    assert.equal(h.view().runCommand.phase, "unconfirmed");
    const first = h.updates.at(-1)[1];
    fail = null;
    assert.equal((await h.controller.retryWorkflowRunCommand(SID)).ok, true);
    assert.deepEqual(h.updates.at(-1)[1], first, "the same command, with the same operation id");
    // A different value is a new command.
    fail = new TypeError("Failed to fetch");
    await h.controller.sendWorkflowRunCommand(SID, { operation: "set_vars", runId: RUN, set: { note: "a" }, expectedKvRevision: 5 });
    const unanswered = h.updates.at(-1)[1].operation_id;
    fail = null;
    await h.controller.sendWorkflowRunCommand(SID, { operation: "set_vars", runId: RUN, set: { note: "b" }, expectedKvRevision: 5 });
    assert.notEqual(h.updates.at(-1)[1].operation_id, unanswered);
});

function mount(view) {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", sessionKind: "workflow", title: "Watch" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view });
    // The side pane on screen, so the header's button says whether it shows the variables (batch 6, r-3).
    store.dispatch({ type: "canvas/flip", sessionId: "wf", slot: 1 });
    return new PilotSwarmUiController({ store, transport: {} });
}
// Batch 6 (r-3): the header's buttons are in the main pane, and the panel they choose shows in the side pane.
const main = controller => renderToStaticMarkup(React.createElement(React.Fragment, null,
    React.createElement(WorkflowMainPane, { controller, icon: null }), React.createElement(WorkflowNodePane, { controller })));
const withCommands = (run, personCommands = commands()) => ({ ...readModel({ run }), personCommands });

test("the panel opens from the header's Variables button: a form where a person may change them, the reason where not", () => {
    const plain = main(mount({ readModel: readModel({ run: { kv: KV, kvRevision: 3 } }), readModelRunId: null, sidePanel: "variables" }));
    assert.ok(!plain.includes("aria-label=\"Variables\"") && !plain.includes("Workflow variables"), "no button and no panel without personCommands");

    const closed = main(mount({ readModel: withCommands({ kv: KV, kvRevision: 3 }), readModelRunId: null }));
    assert.ok(closed.includes("aria-label=\"Variables\""), "an icon button named by its old text (of-04)");
    assert.ok(closed.includes("aria-expanded=\"false\""));
    assert.ok(!closed.includes("Workflow variables"));

    const open = main(mount({ readModel: withCommands({ kv: KV, kvRevision: 3 }), readModelRunId: null, sidePanel: "variables" }));
    assert.ok(open.includes("aria-expanded=\"true\""));
    assert.ok(open.includes("aria-label=\"Workflow variables\""));
    assert.ok(open.includes("Variables · revision 3"));
    assert.deepEqual([...open.matchAll(/data-key="([^"]+)"/g)].map(match => match[1]), ["note", "pollSeconds", "reviewer"]);
    assert.ok(open.includes("aria-label=\"Set or remove a variable\""));
    assert.ok(open.includes("data-operation=\"set\"") && open.includes("data-operation=\"remove\""));
    assert.ok(open.includes("aria-label=\"Edit note\""));

    const subtree = main(mount({ readModel: withCommands({ kv: KV, kvRevision: 3 }, SUBTREE), readModelRunId: null, sidePanel: "variables" }));
    assert.ok(subtree.includes("aria-label=\"Workflow variables\""));
    assert.ok(!subtree.includes("Set or remove a variable"), "no form where people cannot change them");
    assert.ok(!subtree.includes("aria-label=\"Edit note\""));
    assert.ok(subtree.includes(SUBTREE.restriction.reason.slice(0, 40)) && !subtree.includes("parent-a"), "the reason, no session id");

    const ended = main(mount({ readModel: withCommands({ status: "completed", kv: KV, kvRevision: 3 }), readModelRunId: null, sidePanel: "variables" }));
    assert.ok(ended.includes("This Workflow has ended; its variables no longer change."));
    assert.ok(!ended.includes("Set or remove a variable"));
});
