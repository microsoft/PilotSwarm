// The shown run's variables in the TUI's workflow view (design 02 open KV; R04, R05; mock M15; INACTIVE: only a
// deployment that takes a person's workflow commands offers them): the view lists them with their revision, and v opens
// a form that sets a name to a JSON value (Enter) or removes a name (ctrl-r, after the confirm dialog), each as one
// set_vars update of that run at the revision the view shows, as the portal's variables panel sends it (the shared
// controller's sendWorkflowRunCommand; workflowV2RunVariables, workflowV2VariableDraft, workflowV2VariableRemoval). A
// name is kept exactly as typed, and a value is typed JSON. What is typed is checked first. The form is not offered
// where the workflow (an agent state's subtree), the run (ended, revision unknown), the viewer or the deployment does
// not allow it, and the server decides every update anyway: its refusal stays in the form. A changed revision is
// refused and the workflow is read again, so the next try uses the new revision; an answer that never came sends the
// same update again. A form whose run the view no longer shows sends nothing.
//
// Run: node --test packages/app/ui/core/test/workflow-tui-variables.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController, UI_COMMANDS, appReducer, buildHistoryModel, createInitialState, createStore, selectWorkflowVariableModal,
    selectWorkflowViewModal,
} from "../src/index.js";
import { RUN, SUBTREE_REASON as SUBTREE, readModel } from "./workflow-v2-fixtures.mjs";

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

/** The live run with its variables (`vars`, at `revision`), and what its workflow takes from people (`commands`; null: none). */
function model({ status = "running", vars = { a: 1, "b c": "x" }, revision = 3, runId = RUN, kv = JSON.stringify(vars),
    commands = { operations: ALL, restriction: null, run: { runId: RUN, stop: true } } } = {}) {
    const base = readModel({ graph, run: { runId, status, kv, ...(revision === null ? { kvRevision: null } : { kvRevision: revision }) },
        runs: [{ runId, mode: "live", status, revision: 1, outcome: null }] });
    return commands ? { ...base, personCommands: commands } : base;
}

/** The workflow session wf with `initial` loaded; updateWorkflow answers with the next of `answers` (default: accepted). */
function harness(initial, answers = []) {
    let current = initial;
    const calls = [];
    const transport = {
        getSessionEventsBefore: async () => [],
        readWorkflow: async (...args) => { calls.push(["readWorkflow", ...args]); return current; },
        updateWorkflow: async (...args) => {
            calls.push(["updateWorkflow", ...args]);
            const answer = answers.shift();
            return answer ? answer(...args) : { kvRevision: 4 };
        },
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: review-flow", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: initial, readModelRunId: null } });
    return {
        controller, store, calls, answers,
        sent: () => calls.filter(call => call[0] === "updateWorkflow").map(call => call[2]),
        serve: next => { current = next; },
    };
}

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const details = store => selectWorkflowViewModal(store.getState(), 110).detailsLines.map(line => line.text);
const form = store => selectWorkflowVariableModal(store.getState(), 110);
/** Lines as one text: a wrapped sentence reads whole. */
const joined = lines => lines.map(line => (typeof line === "string" ? line : line.text).trim()).join(" ");
const statusOf = store => store.getState().ui.statusText;
const type = (h, text) => h.controller.insertWorkflowVariableText(text);

async function opened(initial, answers = []) {
    const h = harness(initial, answers);
    await h.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await settle();
    return h;
}

test("the view lists the shown run's variables; v opens the form, and Enter sets a name, kept as typed, to its typed JSON value", async () => {
    const h = await opened(model());
    const lines = details(h.store);
    assert.ok(lines.includes("Variables · revision 3 — v sets or removes one · V updates several at once"), lines.join("\n"));
    assert.ok(lines.includes("  a = 1"));
    assert.ok(lines.includes('  b c = "x"'));
    const view = h.store.getState().ui.modal;

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_VARIABLES);
    let modal = h.store.getState().ui.modal;
    assert.equal(modal.type, "workflowVariable");
    assert.equal(modal.runId, RUN);
    assert.deepEqual(modal.returnModal, view);
    assert.equal(form(h.store).title, `Variables · revision 3`);
    type(h, "my var");
    h.controller.switchWorkflowVariableField();
    type(h, '{"limit": 3, "tags": ["a"]}');
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const [first] = h.sent();
    const { operation_id: operationId, ...wire } = first;
    assert.deepEqual(wire, { operation: "set_vars", run_id: RUN, set: { "my var": { limit: 3, tags: ["a"] } }, expected_kv_revision: 3 });
    assert.match(operationId, /^ui-set_vars-/);
    assert.equal(statusOf(h.store), "Variables updated · set 'my var' · revision 4. Nodes that start from now on see them.");
    assert.deepEqual(h.store.getState().ui.modal, view, "back to the workflow view");

    // Any allowed name stays plain data, spaces and "__proto__" included; a value is any JSON, null too.
    for (const [name, value, expected] of [[" spaced  ", '"text"', "text"], ["__proto__", "null", null]]) {
        await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_VARIABLES);
        type(h, name);
        h.controller.switchWorkflowVariableField();
        type(h, value);
        await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
        const set = h.sent().at(-1).set;
        assert.deepEqual(Object.keys(set), [name]);
        assert.deepEqual(Object.getOwnPropertyDescriptor(set, name).value, expected);
        assert.equal(Object.getPrototypeOf(set), Object.prototype);
        modal = h.store.getState().ui.modal;
        assert.equal(modal.type, "workflowView");
    }
});

test("what is typed is checked first and the form says what is wrong; nothing is sent; the fields edit as text", async () => {
    const h = await opened(model());
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_VARIABLES);
    const errorOf = () => h.store.getState().ui.modal.error;
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.equal(errorOf(), "Name the variable (1 to 128 characters).");
    assert.ok(joined(form(h.store).lines).includes("Name the variable (1 to 128 characters)."));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VARIABLE_REMOVE);
    assert.equal(errorOf(), "Name the variable to remove (1 to 128 characters).");
    type(h, "a");
    assert.equal(errorOf(), null, "typing clears the message");
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.equal(errorOf(), 'Give the value as JSON, for example "text", 120, true or null.');
    h.controller.switchWorkflowVariableField();
    type(h, "abc");
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.match(errorOf(), /^The value must be JSON \(a string needs quotes\): /);
    h.controller.switchWorkflowVariableField();
    type(h, "x".repeat(128));
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.equal(errorOf(), "Name the variable (1 to 128 characters).");
    assert.deepEqual(h.sent(), []);

    // The focused field edits as text: the cursor moves, Home and End, and backspace.
    const fresh = await opened(model());
    await fresh.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_VARIABLES);
    type(fresh, "ab");
    fresh.controller.moveWorkflowVariableCursor(-1);
    type(fresh, "X");
    fresh.controller.moveWorkflowVariableCursorToBoundary("start");
    type(fresh, "0");
    fresh.controller.moveWorkflowVariableCursorToBoundary("start");
    fresh.controller.deleteWorkflowVariableChar();
    fresh.controller.moveWorkflowVariableCursorToBoundary("end");
    fresh.controller.deleteWorkflowVariableChar();
    let modal = fresh.store.getState().ui.modal;
    assert.equal(modal.name, "0aX");
    assert.equal(modal.nameCursor, 3);
    fresh.controller.switchWorkflowVariableField();
    type(fresh, "1");
    modal = fresh.store.getState().ui.modal;
    assert.deepEqual([modal.field, modal.name, modal.value], ["value", "0aX", "1"]);
    assert.equal(form(fresh.store).field, "value");
});

test("↑↓ copy a listed variable into the form; ctrl-r removes it after the confirm dialog, which returns to the form", async () => {
    const h = await opened(model());
    const view = h.store.getState().ui.modal;
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_VARIABLES);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    let modal = h.store.getState().ui.modal;
    assert.deepEqual([modal.pick, modal.name, modal.value], [0, "a", "1"]);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    modal = h.store.getState().ui.modal;
    assert.deepEqual([modal.pick, modal.name, modal.value], [1, "b c", '"x"']);
    assert.ok(form(h.store).lines.some(line => line.text === '▸ b c = "x"'));
    await h.controller.handleCommand(UI_COMMANDS.MODAL_PREV);
    assert.equal(h.store.getState().ui.modal.name, "a");
    const theForm = h.store.getState().ui.modal;

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VARIABLE_REMOVE);
    modal = h.store.getState().ui.modal;
    assert.equal(modal.type, "confirm");
    assert.equal(modal.title, "Remove Workflow Variable");
    assert.equal(modal.confirmLabel, "Remove");
    assert.match(modal.message, /^Remove 'a' from the variables\?/);
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.deepEqual(h.store.getState().ui.modal, theForm, "back to the form, as it was");
    assert.equal(statusOf(h.store), "The removal was not sent");
    assert.deepEqual(h.sent(), []);

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VARIABLE_REMOVE);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const [removal] = h.sent();
    const { operation_id: _id, ...wire } = removal;
    assert.deepEqual(wire, { operation: "set_vars", run_id: RUN, delete: ["a"], expected_kv_revision: 3 });
    assert.equal(statusOf(h.store), "Variables updated · removed 'a' · revision 4. Nodes that start from now on see them.");
    assert.deepEqual(h.store.getState().ui.modal, view, "accepted: back to the workflow view");
});

test("the form is not offered where the workflow, the run, the viewer or the deployment does not allow it; the server decides anyway", async () => {
    const all = [];
    const refusedWith = async (initial, reason) => {
        const h = await opened(initial);
        all.push(h);
        await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_VARIABLES);
        assert.equal(h.store.getState().ui.modal.type, "workflowView");
        assert.equal(statusOf(h.store), `Variables not saved: ${reason}`);
        return h;
    };
    const restriction = SUBTREE;
    const subtree = await refusedWith(model({ commands: { operations: ["pause", "stop", "cancel"],
        restriction: { reason: SUBTREE, workflowSessionId: "outer", controllingSessionId: "parent-1" }, run: { runId: RUN, stop: true } } }), restriction);
    assert.ok(details(subtree.store).includes("Variables · revision 3"), "listed, without the key");
    assert.ok(joined(details(subtree.store)).includes(restriction));
    await refusedWith(model({ status: "completed" }), "This Workflow has ended; its variables no longer change.");
    await refusedWith(model({ commands: { operations: ALL, restriction: null, run: { runId: RUN, stop: true },
        viewer: { allowed: false, reason: "You may read this workflow but not command it." } } }), "You may read this workflow but not command it.");
    await refusedWith(model({ revision: null }), "The variables' revision is not known, so they cannot be changed here. Read the Workflow again.");
    const none = await refusedWith(model({ commands: null }), "This deployment takes no Workflow commands from people.");
    assert.ok(!details(none.store).some(line => line.startsWith("Variables")));
    for (const h of all) assert.deepEqual(h.sent(), []);

    // Offered, and still refused by the server: its reason stays in the form, and on the status line.
    const denied = await opened(model(), [async () => {
        throw Object.assign(new Error("People cannot change this workflow."), { status: 403, code: "WORKFLOW_HUMAN_INPUT_DENIED" });
    }]);
    await denied.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_VARIABLES);
    type(denied, "a");
    denied.controller.switchWorkflowVariableField();
    type(denied, "2");
    await denied.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const refusal = `Variables not saved: People cannot change this workflow.`;
    assert.equal(denied.store.getState().ui.modal.type, "workflowVariable");
    assert.equal(statusOf(denied.store), refusal);
    assert.ok(joined(form(denied.store).lines).includes(`! ${refusal}`));
});

test("a changed revision is refused and read again; the edit stays at its own revision until ctrl-k keeps it; an unanswered update is sent again as itself", async () => {
    let lose;
    const h = await opened(model(), [
        async () => { throw Object.assign(new Error("The variables changed; read them again."), { status: 409, code: "KV_REVISION_CONFLICT" }); },
        () => new Promise((_, reject) => { lose = () => reject(Object.assign(new Error("upstream unavailable"), { status: 503 })); }),
    ]);
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_VARIABLES);
    type(h, "a");
    h.controller.switchWorkflowVariableField();
    type(h, "5");
    // Someone else changed the variables meanwhile: the server has revision 4.
    h.serve(model({ vars: { a: 2, "b c": "x" }, revision: 4 }));
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    await settle();
    assert.equal(h.sent()[0].expected_kv_revision, 3);
    assert.equal(h.store.getState().ui.modal.type, "workflowVariable", "the form stays, with what was typed");
    const conflict = `Variables not saved: The variables changed; read them again.`;
    assert.equal(statusOf(h.store), conflict);
    let shown = form(h.store);
    assert.equal(shown.title, `Variables · revision 4`, "the workflow was read again");
    assert.ok(shown.lines.some(line => line.text === "  a = 2"));
    assert.ok(joined(shown.lines).includes(`! ${conflict}`));
    assert.deepEqual([shown.name, shown.value], ["a", "5"]);
    // Review R2-UI-1: the edit is still of revision 3. Enter sends nothing until the person decides.
    const behind = "The variables changed since you started editing: revision 3, now 4.";
    assert.ok(joined(shown.lines).includes(`${behind} ctrl-l loads the new values; ctrl-k keeps your edit to save it over them.`), joined(shown.lines));
    assert.equal(shown.hint, "ctrl-l load the new values · ctrl-k keep your edit · Esc back to the view");
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.equal(h.sent().length, 1, "nothing was sent");
    assert.equal(h.store.getState().ui.modal.error, `${behind} Nothing was sent: ctrl-l loads the new values, or ctrl-k keeps your edit to save it over them.`);
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VARIABLE_KEEP);
    assert.equal(statusOf(h.store), "Your edit is kept; it is saved over revision 4.");
    assert.deepEqual([form(h.store).name, form(h.store).value], ["a", "5"]);

    // Kept: the next try is at the new revision; while it is sent, it says so and nothing else is sent.
    const sending = h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    await settle();
    assert.equal(h.sent()[1].expected_kv_revision, 4);
    assert.notEqual(h.sent()[1].operation_id, h.sent()[0].operation_id);
    shown = form(h.store);
    assert.ok(shown.lines.some(line => line.text === "Saving…"));
    assert.equal(shown.busy, true);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.equal(h.store.getState().ui.modal.error, "Another command for this Workflow is being sent.");
    assert.equal(h.sent().length, 2);

    // Its answer never came: Enter sends the same update again, with the same operation id.
    lose();
    await sending;
    const lost = `The variables update may not have reached the Workflow: upstream unavailable. Retry sends the same command again.`;
    assert.equal(statusOf(h.store), lost);
    assert.ok(joined(form(h.store).lines).includes("Enter sends the same update again; the server applies it once."));
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const [, second, third] = h.sent();
    assert.deepEqual(third, second);
    assert.equal(h.store.getState().ui.modal.type, "workflowView", "accepted: back to the view");
});

// Adversarial review R3-UI-2: only the exact update whose answer never came goes out again past a newer revision; any
// other edit is behind like every other (ctrl-k or ctrl-l first).
test("R3-UI-2: after an unanswered update and a refresh to a newer revision, a changed edit sends nothing; the unchanged update is sent again as itself", async () => {
    const lost = async () => { throw Object.assign(new Error("upstream unavailable"), { status: 503 }); };
    const h = await opened(model(), [lost, lost]);
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_VARIABLES);
    type(h, "a");
    h.controller.switchWorkflowVariableField();
    type(h, "5");
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    await settle();
    const [first] = h.sent();
    assert.equal(first.expected_kv_revision, 3);
    assert.equal(h.store.getState().ui.modal.type, "workflowVariable", "no answer: the form stays");
    // The same run is read again at revision 4 (the lost update may have been applied, or someone else changed a).
    h.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: model({ vars: { a: 5, "b c": "x" }, revision: 4 }), readModelRunId: null } });
    let shown = form(h.store);
    assert.equal(shown.title, `Variables · revision 4`);
    assert.ok(joined(shown.lines).includes("Enter sends the same update again; the server applies it once."), joined(shown.lines));
    assert.ok(!joined(shown.lines).includes("changed since you started editing"), "the same update is not behind");

    // Changed (a = 50): a new update over revision 3's values, so it is behind. Neither Enter nor ctrl-r sends anything.
    type(h, "0");
    shown = form(h.store);
    const behind = "The variables changed since you started editing: revision 3, now 4.";
    assert.ok(joined(shown.lines).includes(`${behind} ctrl-l loads the new values; ctrl-k keeps your edit to save it over them.`), joined(shown.lines));
    assert.ok(!joined(shown.lines).includes("sends the same update again"));
    assert.equal(shown.hint, "ctrl-l load the new values · ctrl-k keep your edit · Esc back to the view");
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.equal(h.store.getState().ui.modal.error, `${behind} Nothing was sent: ctrl-l loads the new values, or ctrl-k keeps your edit to save it over them.`);
    await h.controller.submitWorkflowVariable({ remove: true });
    assert.equal(h.store.getState().ui.modal.type, "workflowVariable", "a removal of a is a new update too: no confirm dialog");
    assert.equal(h.sent().length, 1, "nothing was sent");

    // Back to exactly the unanswered update (a = 5 at revision 3): Enter sends it again as itself, with its operation id.
    h.controller.deleteWorkflowVariableChar();
    assert.deepEqual([form(h.store).name, form(h.store).value], ["a", "5"]);
    assert.ok(joined(form(h.store).lines).includes("Enter sends the same update again; the server applies it once."));
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    await settle();
    assert.deepEqual(h.sent()[1], first, "the same operation id, at revision 3");

    // Its answer never came again. ctrl-k keeps a changed edit: a new update at revision 4, with a new operation id.
    type(h, "1");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VARIABLE_KEEP);
    shown = form(h.store);
    assert.ok(joined(shown.lines).includes("The form no longer holds that update, so Enter sends a new one."), joined(shown.lines));
    assert.ok(!joined(shown.lines).includes("sends the same update again"));
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const third = h.sent()[2];
    assert.notEqual(third.operation_id, first.operation_id);
    const { operation_id: _id, ...wire } = third;
    assert.deepEqual(wire, { operation: "set_vars", run_id: RUN, set: { a: 51 }, expected_kv_revision: 4 });
    assert.equal(h.store.getState().ui.modal.type, "workflowView", "accepted: back to the view");
});

// Adversarial review R2-UI-1: the form keeps the revision its edit started from across a refresh of the same run.
test("R2-UI-1: a refresh to a newer revision keeps the edit at its own revision; ctrl-l loads the new value, and only then is it sent", async () => {
    const h = await opened(model());
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_VARIABLES);
    // Copy listed variable a (1) and change it; the edit is of revision 3.
    await h.controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    assert.deepEqual([form(h.store).name, form(h.store).value], ["a", "1"]);
    h.controller.switchWorkflowVariableField();
    type(h, "0");
    assert.equal(h.store.getState().ui.modal.baseRevision, 3);
    // The same run is read again: someone else set a to 2 (revision 4). The edit stays, behind.
    h.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: model({ vars: { a: 2, "b c": "x" }, revision: 4 }), readModelRunId: null } });
    const shown = form(h.store);
    assert.equal(shown.title, `Variables · revision 4`);
    assert.deepEqual([shown.name, shown.value], ["a", "10"]);
    assert.ok(joined(shown.lines).includes("The variables changed since you started editing: revision 3, now 4."));
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    await h.controller.submitWorkflowVariable({ remove: true });
    assert.deepEqual(h.sent(), [], "neither a set nor a removal is sent over the newer values");
    // ctrl-l loads a's value now (2) at revision 4; the form says nothing is behind any more.
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VARIABLE_RELOAD);
    assert.equal(statusOf(h.store), "Loaded the variables of revision 4.");
    assert.deepEqual([form(h.store).name, form(h.store).value], ["a", "2"]);
    assert.ok(!joined(form(h.store).lines).includes("changed since you started editing"));
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const { operation_id: _id, ...wire } = h.sent()[0];
    assert.deepEqual(wire, { operation: "set_vars", run_id: RUN, set: { a: 2 }, expected_kv_revision: 4 });

    // An empty form takes the newer revision when typing starts: nothing is behind.
    h.serve(model({ vars: { a: 2, "b c": "x" }, revision: 5 }));
    await settle();
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_VARIABLES);
    h.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: model({ vars: { a: 2, "b c": "x" }, revision: 5 }), readModelRunId: null } });
    type(h, "n");
    assert.equal(h.store.getState().ui.modal.baseRevision, 5);
    assert.ok(!joined(form(h.store).lines).includes("changed since you started editing"));
});

// Re-check RC-1: ctrl-l never acts as ctrl-k. It loads only what it can read: a variable removed since the edit began has
// its old value cleared, and a list the view cannot show whole loads nothing and leaves the edit behind.
test("RC-1: ctrl-l clears a variable removed since the edit began, and loads nothing from a list too long to show", async () => {
    const h = await opened(model());
    const refresh = next => h.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: next, readModelRunId: null } });
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_VARIABLES);
    // Copy a (1) at revision 3 and change it.
    await h.controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    h.controller.switchWorkflowVariableField();
    type(h, "0");
    assert.deepEqual([form(h.store).name, form(h.store).value], ["a", "10"]);
    // Someone removed a (revision 4). ctrl-l clears its old value and says so; nothing is sent, and Enter sends nothing either.
    refresh(model({ vars: { "b c": "x" }, revision: 4 }));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VARIABLE_RELOAD);
    const removed = "'a' was removed at revision 4, after you started editing. Its old value is cleared; type a value to set it again.";
    assert.equal(statusOf(h.store), removed);
    assert.deepEqual([form(h.store).name, form(h.store).value], ["a", ""]);
    assert.equal(h.store.getState().ui.modal.baseRevision, 4);
    assert.ok(joined(form(h.store).lines).includes(removed), joined(form(h.store).lines));
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.deepEqual(h.sent(), [], "the old value is not set again");

    // Type a new value at revision 4; then the map grows past what the view can show (revision 5).
    type(h, "3");
    assert.ok(!joined(form(h.store).lines).includes(removed), "typing clears the notice");
    refresh(model({ kv: '{"a":5,"big":"xxxx…', revision: 5 }));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VARIABLE_RELOAD);
    const blocked = "The new values cannot be loaded here: the variables are longer than this view. Your edit stays at revision 4. "
        + "Keep it to save it over the new values, or clear the form.";
    assert.equal(statusOf(h.store), blocked);
    assert.deepEqual([form(h.store).name, form(h.store).value], ["a", "3"]);
    assert.equal(h.store.getState().ui.modal.baseRevision, 4, "the edit stays at its own revision");
    assert.ok(joined(form(h.store).lines).includes("The variables changed since you started editing: revision 4, now 5."), "still behind");
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.deepEqual(h.sent(), [], "never sent over values it did not load");
    // Only ctrl-k moves the edit over them, on purpose.
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VARIABLE_KEEP);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    await settle();
    const { operation_id: _id, ...wire } = h.sent()[0];
    assert.deepEqual(wire, { operation: "set_vars", run_id: RUN, set: { a: 3 }, expected_kv_revision: 5 });
});

// Re-check UI-RC2-6: an update's answer belongs to the form and the edit it was sent from. Typing on while it is in flight
// keeps the newer edit (not saved) and says the earlier change was saved; a form opened since is left as it is.
test("UI-RC2-6: a late accepted save keeps a newer edit and says so; after the form was closed it leaves the view alone", async () => {
    const pending = [];
    const later = () => new Promise(resolve => pending.push(() => resolve({ kvRevision: 4 })));
    const h = await opened(model(), [later, later]);
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_VARIABLES);
    type(h, "a");
    h.controller.switchWorkflowVariableField();
    type(h, "1");
    const sending = h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    await settle();
    assert.equal(pending.length, 1, "precondition: the update is in flight");
    // The person types on while it is in flight.
    type(h, "2");
    pending.shift()();
    await sending;
    await settle();
    let modal = h.store.getState().ui.modal;
    assert.equal(modal.type, "workflowVariable", "the form stays open with the newer edit");
    assert.deepEqual([modal.name, modal.value], ["a", "12"]);
    assert.equal(statusOf(h.store), "Your earlier change was saved. Your newer edit is kept; it is not saved yet.");
    assert.ok(joined(form(h.store).lines).includes("Your earlier change was saved. Your newer edit is kept; it is not saved yet."));
    // Typing again clears the notice.
    type(h, "3");
    assert.ok(!joined(form(h.store).lines).includes("Your earlier change was saved."));

    // Another update in flight; the form is closed meanwhile (a new one cannot open while it is sent): the answer leaves the
    // view as it is and says the earlier update was saved; a form opened afterwards is a new one, empty.
    const second = h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    await settle();
    assert.equal(pending.length, 1, "precondition: the second update is in flight");
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    const view = h.store.getState().ui.modal;
    assert.equal(view.type, "workflowView");
    pending.shift()();
    await second;
    await settle();
    assert.deepEqual(h.store.getState().ui.modal, view, "the view is left as it is");
    assert.equal(statusOf(h.store), "The earlier variables update was saved.");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_VARIABLES);
    const reopened = h.store.getState().ui.modal;
    assert.equal(reopened.type, "workflowVariable");
    assert.notEqual(reopened.formId, modal.formId);
    assert.deepEqual([reopened.name, reopened.value, reopened.saveNotice ?? null], ["", "", null]);
    assert.equal(h.sent().length, 2);
});

// Re-check UI-RC3-2: an answer belongs to the edit it was sent from (the form's generation), not to its text. A removal is
// confirmed and in flight; the person edits the value 1 -> 12 -> 1 meanwhile, the text it had when sent. The answer keeps
// that newer edit and says the removal was saved; copying, Keep and Load are newer edits too, moving the cursor is not.
test("UI-RC3-2: an edit that comes back to the same text while a removal is in flight is kept, and the form says the earlier change was saved", async () => {
    const pending = [];
    const later = () => new Promise(resolve => pending.push(() => resolve({ kvRevision: 4 })));
    const h = await opened(model(), [later]);
    const view = h.store.getState().ui.modal;
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_VARIABLES);
    assert.equal(h.store.getState().ui.modal.generation, 0);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    let modal = h.store.getState().ui.modal;
    assert.deepEqual([modal.name, modal.value, modal.generation], ["a", "1", 1], "copying a listed variable is an edit");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VARIABLE_REMOVE);
    assert.equal(h.store.getState().ui.modal.type, "confirm");
    const removing = h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    await settle();
    assert.equal(pending.length, 1, "precondition: the removal is in flight");
    assert.equal(h.store.getState().ui.modal.type, "workflowVariable", "precondition: the confirm went back to the form");
    // The value, edited meanwhile: 1 -> 12 -> 1. Moving the cursor and switching fields are not edits.
    h.controller.switchWorkflowVariableField();
    h.controller.moveWorkflowVariableCursorToBoundary("end");
    assert.equal(h.store.getState().ui.modal.generation, 1);
    type(h, "2");
    assert.deepEqual([h.store.getState().ui.modal.value, h.store.getState().ui.modal.generation], ["12", 2]);
    h.controller.deleteWorkflowVariableChar();
    modal = h.store.getState().ui.modal;
    assert.deepEqual([modal.name, modal.value, modal.generation], ["a", "1", 3], "the same text again, at a newer edit");
    pending.shift()();
    await removing;
    await settle();
    modal = h.store.getState().ui.modal;
    assert.equal(modal.type, "workflowVariable", "the form stays open with the newer edit");
    assert.deepEqual([modal.name, modal.value, modal.generation], ["a", "1", 3]);
    assert.equal(statusOf(h.store), "Your earlier change was saved. Your newer edit is kept; it is not saved yet.");
    assert.ok(joined(form(h.store).lines).includes("Your earlier change was saved. Your newer edit is kept; it is not saved yet."));
    assert.equal(h.sent().length, 1);
    // That kept edit, sent at its own edit, closes the form when accepted, as before.
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const { operation_id: _id, ...wire } = h.sent()[1];
    assert.deepEqual(wire, { operation: "set_vars", run_id: RUN, set: { a: 1 }, expected_kv_revision: 3 });
    assert.deepEqual(h.store.getState().ui.modal, view, "accepted: back to the workflow view");
    await settle();

    // Keep (ctrl-k) and Load (ctrl-l) each make a newer edit. The workflow is read at the newer revisions too, so a read
    // that lands late shows the same.
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_VARIABLES);
    type(h, "a");
    const typed = h.store.getState().ui.modal.generation;
    assert.equal(typed, 1);
    const refresh = revision => {
        const next = model({ vars: { a: revision, "b c": "x" }, revision });
        h.serve(next);
        h.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: next, readModelRunId: null } });
    };
    refresh(5);
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VARIABLE_KEEP);
    assert.deepEqual([h.store.getState().ui.modal.baseRevision, h.store.getState().ui.modal.generation], [5, typed + 1]);
    refresh(6);
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VARIABLE_RELOAD);
    assert.deepEqual([h.store.getState().ui.modal.baseRevision, h.store.getState().ui.modal.value, h.store.getState().ui.modal.generation], [6, "6", typed + 2]);
});

test("a form whose run the view no longer shows sends nothing; Esc goes back to the view", async () => {
    const h = await opened(model());
    const view = h.store.getState().ui.modal;
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_VARIABLES);
    type(h, "a");
    h.controller.switchWorkflowVariableField();
    type(h, "1");
    // A new live run replaced the one the form was opened for.
    h.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: model({ runId: "run-2" }), readModelRunId: null } });
    assert.ok(joined(form(h.store).lines).includes("The view no longer shows the Workflow this form was opened for, so it sends nothing."));
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.match(h.store.getState().ui.modal.error, /^The view no longer shows the Workflow this form was opened for, so nothing was sent\./);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_NEXT);
    assert.equal(statusOf(h.store), "No listed variable to copy");
    assert.deepEqual(h.sent(), []);
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.deepEqual(h.store.getState().ui.modal, view);
    assert.equal(statusOf(h.store), "Back to the workflow view");
});
