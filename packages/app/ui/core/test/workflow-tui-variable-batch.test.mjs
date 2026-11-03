// Several of the shown run's variables in one update in the TUI's workflow view (design 02 open KV: set_vars is one
// atomic batch of set and delete; R04, R05; INACTIVE: only a deployment that takes a person's workflow commands offers
// it): V opens a form with two fields, Set (a JSON object of names and their JSON values) and Remove (a JSON list of
// names), checked by the shared workflowV2VariableBatchDraft. The form reviews what Enter sends: each name added, or
// replacing the value it has (whole), each removed, at the revision the view shows; every other variable stays as it
// is. Enter sends it as ONE set_vars command of that run through the shared controller (sendWorkflowRunCommand), never
// as several mutations; an update that removes any asks first (the shared confirm dialog, which returns to the form).
// What is typed is checked first (malformed, not an object or list, a name repeated or both set and removed, an empty
// name or update) and stays through refusals. The form is not offered where the workflow (an agent state's subtree),
// the run, the viewer or the deployment does not allow it, and the server decides anyway. A changed revision is refused
// and read again; an answer that never came is sent again as itself; one command at a time; a form whose run the view
// no longer shows sends nothing. The one-variable form (v) is unchanged; an ordinary session has neither.
//
// Run: node --test packages/app/ui/core/test/workflow-tui-variable-batch.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController, UI_COMMANDS, appReducer, buildHistoryModel, createInitialState, createStore, selectWorkflowVariableBatchModal,
    selectWorkflowViewModal,
} from "../src/index.js";
import { workflowV2VariableBatchDraft } from "../src/workflow-v2-commands.js";
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
const SUBTREE = "This workflow was started by an agent step of another workflow: people can pause, stop or cancel it; only its controlling "
    + "agent changes, resumes or tests it.";
const VIEWER = "You may read this workflow but not command it.";

/** The live run with its variables (`vars`, at `revision`; `kv` overrides the preview), and what its workflow takes from people. */
function model({ status = "running", vars = { a: 1, "b c": "x" }, kv = null, revision = 3, runId = RUN,
    commands = { operations: ALL, restriction: null, run: { runId: RUN, stop: true } } } = {}) {
    const base = readModel({ graph, run: { runId, status, kv: kv ?? JSON.stringify(vars), ...(revision === null ? { kvRevision: null } : { kvRevision: revision }) },
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
        controller, store, calls,
        sent: () => calls.filter(call => call[0] === "updateWorkflow").map(call => call[2]),
        serve: next => { current = next; },
    };
}

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const details = store => selectWorkflowViewModal(store.getState(), 110).detailsLines.map(line => line.text);
const batch = store => selectWorkflowVariableBatchModal(store.getState(), 110, 60);
const texts = store => batch(store).lines.map(line => line.text);
/** Lines as one text: a wrapped sentence reads whole. */
const joined = lines => lines.map(line => (typeof line === "string" ? line : line.text).trim()).join(" ");
const statusOf = store => store.getState().ui.statusText;
const modalOf = store => store.getState().ui.modal;
const type = (h, text) => h.controller.editWorkflowVariableBatchField({ type: "insert", text });
/** Put `set` and `remove` in the open form's fields, as if typed. */
const fill = (h, set, remove) => h.controller.updateWorkflowModal("workflowVariableBatch",
    { set, setCursor: set.length, remove, removeCursor: remove.length, error: null });
const open = h => h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_UPDATE_VARIABLES);
const send = h => h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VARIABLE_BATCH_SEND);
const withoutId = ({ operation_id: _id, ...wire }) => wire;

async function opened(initial, answers = []) {
    const h = harness(initial, answers);
    await h.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await settle();
    return h;
}

test("several variables are one batch: a JSON object to set and a JSON list to remove, each name once; malformed, other shapes and empty updates are refused", () => {
    assert.deepEqual(workflowV2VariableBatchDraft('{"limit": 5, "mode": "fast", "cfg": {"a": [1, null]}}', '["old", "stale key"]'),
        { ok: true, set: { limit: 5, mode: "fast", cfg: { a: [1, null] } }, delete: ["old", "stale key"] });
    assert.deepEqual(workflowV2VariableBatchDraft('{"a": null}', ""), { ok: true, set: { a: null }, delete: [] }, "null is a value; Remove may be empty");
    assert.deepEqual(workflowV2VariableBatchDraft("  ", '["a", "b"]'), { ok: true, set: {}, delete: ["a", "b"] }, "Set may be empty");
    // A name is kept exactly as typed and stays plain data, "__proto__" included.
    const proto = workflowV2VariableBatchDraft('{"__proto__": {"polluted": true}, " spaced ": 1}', "");
    assert.equal(proto.ok, true);
    assert.deepEqual(Object.keys(proto.set), ["__proto__", " spaced "]);
    assert.equal(Object.hasOwn(proto.set, "__proto__"), true);
    assert.equal(Object.getPrototypeOf(proto.set), Object.prototype);
    assert.equal({}.polluted, undefined);
    assert.equal(workflowV2VariableBatchDraft(JSON.stringify({ ["k".repeat(128)]: 1 }), "").ok, true);

    const refused = (set, remove) => workflowV2VariableBatchDraft(set, remove).error;
    for (const [set, remove] of [["", ""], ["{}", "[]"], [" ", "  "]]) {
        assert.equal(refused(set, remove), "Nothing to update: set at least one variable or remove one.", JSON.stringify([set, remove]));
    }
    assert.match(refused('{"a": 1', ""), /^Set must be a JSON object of names and values: /);
    for (const set of ["[1, 2]", '"text"', "5", "null"]) {
        assert.equal(refused(set, ""), 'Set must be a JSON object of names and values, for example {"limit": 5, "mode": "fast"}.', set);
    }
    assert.match(refused("", '["a"'), /^Remove must be a JSON list of names: /);
    for (const remove of ['"old"', '{"old": true}', "[1]", '["a", null]']) {
        assert.equal(refused("", remove), 'Remove must be a JSON list of names, for example ["old", "stale key"].', remove);
    }
    // JSON keeps only the last of a repeated name, so a repeated one is refused rather than lost, however it is spelled.
    assert.equal(refused('{"a": 1, "b": 2, "a": 3}', ""), "Set names 'a' more than once; give each name once.");
    assert.equal(refused('{"a\\u0062": 1, "ab": 2}', ""), "Set names 'ab' more than once; give each name once.");
    assert.equal(refused('{"x\\"y": 1, "z": "x\\"y", "x\\"y" : 2}', ""), "Set names 'x\"y' more than once; give each name once.");
    // Only the top level names variables: a value is any JSON, a string value that looks like a name included.
    assert.equal(workflowV2VariableBatchDraft('{"a": {"x": 1, "x": 2}, "b": "a", "c": ["a", {"a": 1}]}', "").ok, true);
    assert.equal(refused("", '["a", "b", "a"]'), "Remove lists 'a' more than once; give each name once.");
    assert.equal(refused('{"a": 1, "b": 2}', '["b"]'), "'b' is both set and removed; give each name once.");
    assert.equal(refused('{"": 1}', ""), "Each name is 1 to 128 characters; an empty name is not one.");
    assert.equal(refused("", JSON.stringify(["k".repeat(129)])), `Each name is 1 to 128 characters; '${"k".repeat(39)}…' has 129.`);
});

test("V opens the form; it reviews what Enter sends, and the update goes as one set_vars command, after the confirm dialog when it removes", async () => {
    const h = await opened(model());
    const view = modalOf(h.store);
    assert.ok(details(h.store).includes("Variables · revision 3 — v sets or removes one · V updates several at once"), details(h.store).join("\n"));
    await open(h);
    let modal = modalOf(h.store);
    assert.deepEqual([modal.type, modal.runId, modal.field, modal.set, modal.remove], ["workflowVariableBatch", RUN, "set", "", ""]);
    assert.deepEqual(modal.returnModal, view);
    let shown = batch(h.store);
    assert.equal(shown.title, `Several variables · run ${RUN} · revision 3`);
    assert.ok(joined(shown.lines).includes("each name under Remove is removed, and every other variable stays as it is."));
    assert.ok(joined(shown.lines).includes('Set: a JSON object of names and values, for example {"limit": 5, "mode": "fast"}.'));
    assert.ok(texts(h.store).includes("  a = 1"));
    assert.ok(texts(h.store).includes('  b c = "x"'));

    type(h, '{"a": 2, "new key": {"x": [1]}, "n": null}');
    h.controller.editWorkflowVariableBatchField({ type: "switch" });
    type(h, '["b c", "gone"]');
    shown = batch(h.store);
    assert.equal(shown.field, "remove");
    const lines = texts(h.store);
    const at = lines.indexOf("Enter sends one update at revision 3:");
    assert.ok(at > 0, lines.join("\n"));
    assert.deepEqual(lines.slice(at + 1, at + 7), ["  replace 'a' = 2", "  add 'new key' = {\"x\":[1]}", "  add 'n' = null", "  remove 'b c'",
        "  remove 'gone' (not set now)", "It removes variables, so it asks first."]);
    assert.deepEqual(h.sent(), [], "nothing is sent while typing");

    await send(h);
    modal = modalOf(h.store);
    assert.deepEqual([modal.type, modal.title, modal.confirmLabel], ["confirm", "Update Workflow Variables", "Update"]);
    assert.equal(modal.message, `In one update of the variables of run ${RUN}, set 'a', 'new key' and 'n' and remove 'b c' and 'gone'? `
        + "Every other variable stays as it is. Steps that start from now on see the update; work already running keeps the values it started with.");
    // Not confirmed: back to the form as it was, and none of the update was sent.
    const theForm = modal.returnModal;
    assert.equal(theForm.type, "workflowVariableBatch");
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.deepEqual(modalOf(h.store), theForm);
    assert.equal(statusOf(h.store), "The variables update was not sent");
    assert.deepEqual(h.sent(), []);

    await send(h);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.equal(h.sent().length, 1, "one command, not one per variable");
    assert.match(h.sent()[0].operation_id, /^ui-set_vars-/);
    assert.deepEqual(withoutId(h.sent()[0]), { operation: "set_vars", run_id: RUN, set: { a: 2, "new key": { x: [1] }, n: null },
        delete: ["b c", "gone"], expected_kv_revision: 3 });
    assert.equal(statusOf(h.store), `Variables of run ${RUN} updated: set 'a', 'new key' and 'n'; removed 'b c' and 'gone' (revision 4). `
        + "Steps that start from now on see them.");
    assert.deepEqual(modalOf(h.store), view, "accepted: back to the workflow view");
});

test("an update that only sets is sent at once; one that only removes asks first, as the shared confirm decides", async () => {
    const h = await opened(model());
    const view = modalOf(h.store);
    await open(h);
    type(h, '{"a": 3, "z": "last", "__proto__": 1}');
    await send(h);
    assert.equal(h.sent().length, 1);
    const set = h.sent()[0].set;
    assert.deepEqual(Object.keys(set), ["a", "z", "__proto__"]);
    assert.equal(Object.getOwnPropertyDescriptor(set, "__proto__").value, 1);
    assert.deepEqual(withoutId({ ...h.sent()[0], set: null }), { operation: "set_vars", run_id: RUN, set: null, expected_kv_revision: 3 });
    assert.deepEqual(modalOf(h.store), view);

    await open(h);
    h.controller.editWorkflowVariableBatchField({ type: "switch" });
    type(h, '["a", "b c"]');
    await send(h);
    const confirm = modalOf(h.store);
    assert.deepEqual([confirm.type, confirm.title, confirm.confirmLabel], ["confirm", "Remove Workflow Variables", "Remove"]);
    assert.match(confirm.message, new RegExp(`^Remove 'a' and 'b c' from the variables of run ${RUN}\\?`));
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.equal(statusOf(h.store), "The removal was not sent");
    assert.equal(modalOf(h.store).type, "workflowVariableBatch");
    await send(h);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.deepEqual(withoutId(h.sent()[1]), { operation: "set_vars", run_id: RUN, delete: ["a", "b c"], expected_kv_revision: 3 });
    assert.deepEqual(modalOf(h.store), view);
});

test("what is typed is checked first and the form says what is wrong; nothing is sent; the fields edit as text", async () => {
    const h = await opened(model());
    await open(h);
    const errorOf = () => modalOf(h.store).error;
    await send(h);
    assert.equal(errorOf(), "Nothing to update: set at least one variable or remove one.");
    assert.ok(joined(batch(h.store).lines).includes("Nothing to update: set at least one variable or remove one."));
    type(h, "[1, 2]");
    assert.equal(errorOf(), null, "typing clears the message");
    assert.ok(joined(batch(h.store).lines)
        .includes('Nothing to send yet: Set must be a JSON object of names and values, for example {"limit": 5, "mode": "fast"}.'));
    assert.ok(!texts(h.store).some(line => line.startsWith("Enter sends")));
    await send(h);
    assert.equal(errorOf(), 'Set must be a JSON object of names and values, for example {"limit": 5, "mode": "fast"}.');
    for (const [set, remove, error] of [
        ['{"a": 1', "", /^Set must be a JSON object of names and values: /],
        ['{"a": 1}', '"a"', /^Remove must be a JSON list of names, for example \["old", "stale key"\]\.$/],
        ['{"a": 1, "a": 2}', "", /^Set names 'a' more than once; give each name once\.$/],
        ['{"a": 1}', '["a"]', /^'a' is both set and removed; give each name once\.$/],
        ['{"a": 1}', '["b", "b"]', /^Remove lists 'b' more than once; give each name once\.$/],
        ["{}", "[]", /^Nothing to update: set at least one variable or remove one\.$/],
    ]) {
        fill(h, set, remove);
        await send(h);
        assert.match(errorOf(), error, JSON.stringify([set, remove]));
        assert.deepEqual([batch(h.store).set, batch(h.store).remove], [set, remove], "what was typed stays");
    }
    assert.deepEqual(h.sent(), []);

    // The focused field edits as text: type at the cursor, move, Home and End, backspace; Tab goes to the other field and back.
    const fresh = await opened(model());
    await open(fresh);
    type(fresh, '{"q": 1}');
    fresh.controller.editWorkflowVariableBatchField({ type: "move", chars: -1 });
    type(fresh, ', "r": 2');
    fresh.controller.editWorkflowVariableBatchField({ type: "edge", edge: "end" });
    fresh.controller.editWorkflowVariableBatchField({ type: "backspace" });
    fresh.controller.editWorkflowVariableBatchField({ type: "edge", edge: "start" });
    fresh.controller.editWorkflowVariableBatchField({ type: "backspace" });
    let modal = modalOf(fresh.store);
    assert.deepEqual([modal.set, modal.setCursor], ['{"q": 1, "r": 2', 0]);
    fresh.controller.editWorkflowVariableBatchField({ type: "edge", edge: "end" });
    type(fresh, "}");
    fresh.controller.editWorkflowVariableBatchField({ type: "switch" });
    type(fresh, '["x"]');
    modal = modalOf(fresh.store);
    assert.deepEqual([modal.field, modal.set, modal.remove], ["remove", '{"q": 1, "r": 2}', '["x"]']);
    fresh.controller.editWorkflowVariableBatchField({ type: "switch" });
    assert.equal(batch(fresh.store).field, "set");
    assert.deepEqual(fresh.sent(), []);
});

test("where the variables are longer than the view, the review says set, not add or replace; a long update lists its start", async () => {
    const h = await opened(model({ kv: `{"a":"${"x".repeat(20)}…` }));
    await open(h);
    fill(h, '{"a": 1}', '["zz"]');
    let lines = texts(h.store);
    let at = lines.indexOf("Enter sends one update at revision 3:");
    assert.deepEqual(lines.slice(at + 1, at + 3), ["  set 'a' = 1", "  remove 'zz'"], lines.join("\n"));
    assert.ok(joined(batch(h.store).lines).includes("only their start is shown"));

    const names = Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`k${index}`, index]));
    fill(h, JSON.stringify(names), "");
    lines = texts(h.store);
    at = lines.indexOf("Enter sends one update at revision 3:");
    assert.equal(lines[at + 1], "  set 'k0' = 0");
    assert.equal(lines[at + 12], "  set 'k11' = 11");
    assert.equal(lines[at + 13], "  … 2 more, sent with the rest");
});

test("the form is not offered where the workflow, the run, the viewer or the deployment does not allow it; the server decides anyway", async () => {
    const restricted = { operations: ["pause", "stop", "cancel"], restriction: { reason: SUBTREE, workflowSessionId: "outer", controllingSessionId: "parent-1" },
        run: { runId: RUN, stop: true } };
    const deniedViewer = { operations: ALL, restriction: null, run: { runId: RUN, stop: true }, viewer: { allowed: false, reason: VIEWER } };
    for (const [initial, reason] of [
        [model({ commands: restricted }), `${SUBTREE} Its controlling agent is session parent-1.`],
        [model({ status: "completed" }), "This run has ended (completed); its variables no longer change."],
        [model({ commands: deniedViewer }), VIEWER],
        [model({ revision: null }), "The variables' revision is not known, so they cannot be changed here. Read the workflow again."],
        [model({ commands: null }), "This deployment takes no workflow commands from people."],
    ]) {
        const h = await opened(initial);
        await open(h);
        assert.equal(modalOf(h.store).type, "workflowView", reason);
        assert.equal(statusOf(h.store), `The variables cannot be changed here. ${reason}`);
        assert.deepEqual(h.sent(), []);
    }

    // Offered, then the viewer may no longer command the workflow: the form says why, reviews nothing and sends nothing.
    const h = await opened(model());
    await open(h);
    fill(h, '{"a": 2}', "");
    h.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: model({ commands: deniedViewer }), readModelRunId: null } });
    assert.ok(joined(batch(h.store).lines).includes(VIEWER));
    assert.ok(!texts(h.store).some(line => line.startsWith("Enter sends")), "nothing to review where nothing is sent");
    await send(h);
    assert.equal(modalOf(h.store).error, VIEWER);
    assert.deepEqual(h.sent(), []);

    // Offered, and still refused by the server: its reason stays in the form and on the status line, with what was typed.
    const denied = await opened(model(), [async () => {
        throw Object.assign(new Error("People cannot change this workflow."), { status: 403, code: "WORKFLOW_HUMAN_INPUT_DENIED" });
    }]);
    await open(denied);
    fill(denied, '{"a": 2, "b": 3}', "");
    await send(denied);
    const refusal = `The variables update was refused for run ${RUN}: People cannot change this workflow.`;
    assert.equal(statusOf(denied.store), refusal);
    const shown = batch(denied.store);
    assert.ok(joined(shown.lines).includes(`! ${refusal}`));
    assert.deepEqual([modalOf(denied.store).type, shown.set, shown.remove], ["workflowVariableBatch", '{"a": 2, "b": 3}', ""]);
    assert.equal(denied.sent().length, 1);
});

test("a changed revision is refused and read again, so the next try uses it; one command at a time; an unanswered update is sent again as itself", async () => {
    let lose;
    const h = await opened(model(), [
        async () => { throw Object.assign(new Error("The variables changed; read them again."), { status: 409, code: "KV_REVISION_CONFLICT" }); },
        () => new Promise((_, reject) => { lose = () => reject(Object.assign(new Error("upstream unavailable"), { status: 503 })); }),
    ]);
    await open(h);
    fill(h, '{"a": 5, "c": [1]}', "");
    // Someone else changed the variables meanwhile: the server has revision 4.
    h.serve(model({ vars: { a: 2, "b c": "x" }, revision: 4 }));
    await send(h);
    await settle();
    assert.equal(h.sent()[0].expected_kv_revision, 3);
    const conflict = `The variables update was refused for run ${RUN}: The variables changed; read them again.`;
    assert.equal(statusOf(h.store), conflict);
    let shown = batch(h.store);
    assert.equal(shown.title, `Several variables · run ${RUN} · revision 4`, "the workflow was read again");
    assert.ok(texts(h.store).includes("  a = 2"));
    assert.ok(joined(shown.lines).includes(`! ${conflict}`));
    assert.ok(texts(h.store).includes("Enter sends one update at revision 4:"), "the review is of the new revision");
    assert.ok(texts(h.store).includes("  replace 'a' = 5"));
    assert.deepEqual([modalOf(h.store).type, shown.set, shown.remove], ["workflowVariableBatch", '{"a": 5, "c": [1]}', ""], "what was typed stays");

    // The next try uses the new revision; while it is sent, the form says so and nothing else is sent.
    const sending = send(h);
    await settle();
    assert.equal(h.sent()[1].expected_kv_revision, 4);
    assert.notEqual(h.sent()[1].operation_id, h.sent()[0].operation_id);
    shown = batch(h.store);
    assert.ok(texts(h.store).includes("Saving…"));
    assert.equal(shown.busy, true);
    await send(h);
    assert.equal(modalOf(h.store).error, "Another command for this workflow is being sent.");
    assert.equal(h.sent().length, 2);

    // Its answer never came: Enter sends the same update again, with the same operation id; the server applies it once.
    lose();
    await sending;
    const lost = `The variables update for run ${RUN} may not have reached the workflow: upstream unavailable. Retry sends the same command again.`;
    assert.equal(statusOf(h.store), lost);
    assert.ok(joined(batch(h.store).lines).includes("Enter sends the same update again; the server applies it once."));
    await send(h);
    const [, second, third] = h.sent();
    assert.deepEqual(third, second);
    assert.equal(modalOf(h.store).type, "workflowView", "accepted: back to the view");
});

test("a form whose run the view no longer shows sends nothing; Esc goes back; an ordinary session has no such form", async () => {
    const h = await opened(model());
    const view = modalOf(h.store);
    await open(h);
    fill(h, '{"a": 1}', '["b c"]');
    // A new live run replaced the one the form was opened for.
    h.store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: model({ runId: "run-2" }), readModelRunId: null } });
    assert.ok(joined(batch(h.store).lines).includes("The workflow view no longer shows the run this form was opened for, so it sends nothing."));
    assert.ok(!texts(h.store).some(line => line.startsWith("Enter sends")));
    await send(h);
    assert.match(modalOf(h.store).error, /^The workflow view no longer shows the run this form was opened for, so nothing was sent\./);
    assert.deepEqual(h.sent(), []);
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.deepEqual(modalOf(h.store), view);
    assert.equal(statusOf(h.store), "Back to the workflow view");

    // An ordinary session has no workflow view, so neither command opens or sends anything.
    const plain = harness(model());
    plain.store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "chat", title: "An ordinary chat", status: "idle" }] });
    plain.store.dispatch({ type: "sessions/selected", sessionId: "chat" });
    const before = statusOf(plain.store);
    await open(plain);
    await send(plain);
    assert.equal(modalOf(plain.store), null);
    assert.equal(statusOf(plain.store), before);
    assert.deepEqual(plain.sent(), []);
});
