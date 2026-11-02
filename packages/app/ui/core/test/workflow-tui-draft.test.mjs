// The draft's YAML in the TUI's workflow view (design 04 replace_definition; mocks M01, M02; R03, R17, R26; INACTIVE:
// only a deployment that takes a person's workflow commands, and only a draft whose YAML the read model gives a person
// who may change it): e opens an editor on the YAML the portal's editor edits (workflowV2DraftEditor,
// workflowV2DraftEdit), and ctrl-o saves the edit as one replace_definition at the revision it started from (the shared
// controller's sendWorkflowRunCommand), so a draft someone else saved meanwhile is refused, never overwritten. What was
// typed is kept across a revision with compile errors, a refusal, an answer that never came, a newer revision and
// closing the editor; ctrl-r discards it (asking first) and ctrl-k keeps it on a newer revision. A just-saved revision
// the view has not read yet never brings the older YAML back. Nothing is offered for a published definition, in an agent
// state's subtree, without the YAML or without person commands, and the server decides every save anyway.
//
// Run: node --test packages/app/ui/core/test/workflow-tui-draft.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController, UI_COMMANDS, appReducer, buildHistoryModel, createInitialState, createStore, selectWorkflowDraftModal,
    selectWorkflowViewModal, workflowDraftBuffer,
} from "../src/index.js";
import { readModel, states } from "./workflow-v2-fixtures.mjs";

/** Every command a 1.9.0 host takes from people (human-commands.ts), in its order. */
const ALL = ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel", "stop",
    "test", "test_respond", "test_advance"];
const SUBTREE = "This workflow runs in a workflow agent state's subtree: people can pause, stop or cancel it; only its controlling "
    + "agent changes, resumes or tests it.";
const YAML = "apiVersion: pilotswarm.dev/v2-draft\nkind: Workflow\nmetadata: { name: watch-v2, version: 1.0.0 }\ninitial: poll\nstates: {}\n";
const THEIRS = `${YAML}# someone else's line\n`;

/**
 * A workflow whose definition is `state` at `revision`, with that revision's `yaml` given to this caller (null: left
 * out) and what its workflow takes from people (`commands` false: nothing, the deployment takes no person's commands).
 */
function draft({ revision = 1, yaml = YAML, valid = true, diagnostics = [], state = "draft", operations = ALL, restriction = null,
    viewer = null, commands = true } = {}) {
    const published = state === "published";
    const base = readModel({ noRun: true, graph: valid ? { revision, initial: "poll", states } : null,
        definition: { state, semver: "1.0.0", currentRevision: revision, publishedRevision: published ? revision : null,
            publishedDefinitionHash: published ? `hash-${revision}` : null },
        revision: { revision, definitionHash: `hash-${revision}`, valid, diagnostics } });
    if (!commands) return base;
    const offered = state === "draft" && yaml !== null && operations.includes("replace_definition");
    return { ...base, personCommands: { operations, restriction, run: null,
        ...(offered ? { draft: { revision, definitionHash: `hash-${revision}`, yaml } } : {}), ...(viewer ? { viewer } : {}) } };
}

/** The server's receipt for a save that made `revision`; it now serves that revision with the saved YAML. */
const saved = (revision, { valid = true, diagnostics = [] } = {}) => (command, serve) => {
    serve(draft({ revision, yaml: command.yaml, valid, diagnostics }));
    return { workflowId: "wf-1", operation: "replace_definition", replayed: false, state: "draft", revision,
        definitionHash: `hash-${revision}`, valid, diagnostics };
};
const refused = (status, code, message) => async () => { throw Object.assign(new Error(message), { status, code }); };

/** The workflow session wf with `initial` loaded; updateWorkflow answers with the next of `answers`. */
function harness(initial, answers = []) {
    let current = initial;
    let hold = null;
    const calls = [];
    const serve = next => { current = next; };
    const transport = {
        getSessionEventsBefore: async () => [],
        readWorkflow: async (...args) => {
            calls.push(["readWorkflow", ...args]);
            if (hold) await hold.promise;
            return current;
        },
        updateWorkflow: async (sessionId, command) => {
            calls.push(["updateWorkflow", sessionId, command]);
            const answer = answers.shift();
            assert.ok(answer, `an answer for ${JSON.stringify(command)}`);
            return answer(command, serve);
        },
    };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: watch-v2", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: initial, readModelRunId: null } });
    return {
        controller, store, calls, answers, serve,
        sent: () => calls.filter(call => call[0] === "updateWorkflow").map(call => call[2]),
        reads: () => calls.filter(call => call[0] === "readWorkflow").length,
        /** Hold every read until the returned function releases them. */
        holdReads: () => {
            let release;
            hold = { promise: new Promise(resolve => { release = resolve; }) };
            return () => { hold = null; release(); };
        },
    };
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const details = store => selectWorkflowViewModal(store.getState(), 110).detailsLines.map(line => line.text);
const editor = store => selectWorkflowDraftModal(store.getState(), 110, 40);
/** An editor row as its text: the line number, the line and the cursor cell. */
const rowText = runs => runs.map(run => run.text).join("");
/** Lines as one text: a wrapped sentence reads whole. */
const joined = lines => lines.map(line => (typeof line === "string" ? line : line.text).trim()).join(" ");
const statusOf = store => store.getState().ui.statusText;
const modalOf = store => store.getState().ui.modal;
const editOf = store => store.getState().ui.workflowViews.wf.draftEdit;
const type = (h, text) => h.controller.editWorkflowDraft({ type: "insert", text });
const toEnd = h => h.controller.editWorkflowDraft({ type: "move", chars: 1_000_000 });

async function opened(initial, answers = []) {
    const h = harness(initial, answers);
    await h.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await settle();
    return h;
}

async function editing(initial, answers = []) {
    const h = await opened(initial, answers);
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_DRAFT);
    assert.equal(modalOf(h.store).type, "workflowDraft");
    return h;
}

test("the view names the draft's revision; e opens the editor on its YAML, and ctrl-o saves the edit as one replace_definition at the revision it started from", async () => {
    const h = await opened(draft(), [saved(2)]);
    assert.ok(details(h.store).includes("Draft · revision 1 · version 1.0.0 — e edits its YAML"), details(h.store).join("\n"));
    const view = modalOf(h.store);

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_DRAFT);
    const opener = modalOf(h.store);
    assert.equal(opener.type, "workflowDraft");
    assert.deepEqual(opener.returnModal, view);
    let shown = editor(h.store);
    assert.equal(shown.title, "Draft · editing revision 1 · version 1.0.0 (it cannot change) · line 1, column 1");
    assert.equal(shown.lines.length, 6);
    assert.equal(rowText(shown.lines[0]), "1 apiVersion: pilotswarm.dev/v2-draft");
    assert.deepEqual(shown.lines[0][1], { text: "", color: "white" });
    assert.deepEqual(shown.lines[0][2], { text: "a", color: "promptCursorForeground", backgroundColor: "promptCursorBackground" });
    assert.equal(rowText(shown.lines[2]), "3 metadata: { name: watch-v2, version: 1.0.0 }");
    assert.deepEqual(shown.statusLines.map(line => line.text), ["No unsaved edits."]);
    assert.equal(shown.hint, "ctrl-o save · ctrl-r discard edits (asks first) · Enter new line · Tab two spaces · Esc close (edits kept)");
    assert.deepEqual(shown.hintLines, [{ text: shown.hint, color: "gray" }]);
    assert.equal(shown.hintHeight, 3);

    // The YAML edits as text: lines, characters, the line's edges, a pasted CRLF (a new line), Tab, backspace.
    h.controller.editWorkflowDraft({ type: "move", lines: 5 });
    type(h, "# a note");
    type(h, "\r\n");
    h.controller.editWorkflowDraft({ type: "insert", text: "  " });
    type(h, "x");
    h.controller.editWorkflowDraft({ type: "backspace" });
    h.controller.editWorkflowDraft({ type: "backspace" });
    h.controller.editWorkflowDraft({ type: "backspace" });
    h.controller.editWorkflowDraft({ type: "move", lines: -1 });
    h.controller.editWorkflowDraft({ type: "edge", edge: "start" });
    h.controller.editWorkflowDraft({ type: "move", chars: 2 });
    type(h, "!");
    h.controller.editWorkflowDraft({ type: "edge", edge: "end" });
    h.controller.editWorkflowDraft({ type: "move", chars: 1 });
    const edited = `${YAML}# !a note\n`;
    assert.deepEqual(editOf(h.store), { base: { revision: 1, yaml: YAML }, text: edited, cursor: edited.length });
    shown = editor(h.store);
    assert.equal(shown.title, "Draft · editing revision 1 · version 1.0.0 (it cannot change) · line 7, column 1");
    assert.equal(rowText(shown.lines[5]), "6 # !a note");
    assert.equal(rowText(shown.lines[6]), "7  ", "the cursor after the last line is a blank cell");
    assert.ok(joined(shown.statusLines).includes("Unsaved edits. ctrl-o saves them as a new revision after revision 1."));
    assert.equal(shown.changed, true);

    // Saved while the view has not read revision 2 yet: the edit starts from it, and revision 1's YAML never comes back.
    const release = h.holdReads();
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_SAVE);
    const [first] = h.sent();
    const { operation_id: operationId, ...wire } = first;
    assert.match(operationId, /^ui-replace_definition-./);
    assert.deepEqual(wire, { operation: "replace_definition", expected_revision: 1, yaml: edited });
    assert.equal(statusOf(h.store), "Saved the draft as revision 2.");
    assert.equal(modalOf(h.store).type, "workflowDraft", "the editor stays open");
    shown = editor(h.store);
    assert.match(shown.title, /^Draft · editing revision 2 · /);
    assert.ok(joined(shown.statusLines).includes("No unsaved edits."));
    assert.ok(joined(shown.statusLines).includes("Saved as revision 2; the view has not read it yet."));
    assert.equal(rowText(shown.lines[5]), "6 # !a note");
    // What is typed meanwhile is an edit of revision 2.
    type(h, "y");
    assert.equal(editor(h.store).changed, true);
    assert.ok(joined(editor(h.store).statusLines).includes("Unsaved edits. ctrl-o saves them as a new revision after revision 2."));
    release();
    await settle();
    shown = editor(h.store);
    assert.match(shown.title, /^Draft · editing revision 2 · version 1\.0\.0 \(it cannot change\) · line 7, column 2$/);
    assert.ok(!joined(shown.statusLines).includes("has not read it yet"));
    assert.deepEqual(editOf(h.store).base, { revision: 2, yaml: edited });
    h.controller.editWorkflowDraft({ type: "backspace" });
    assert.deepEqual(editor(h.store).statusLines.map(line => line.text), ["No unsaved edits."]);

    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.deepEqual(modalOf(h.store), view, "back to the workflow view");
    assert.equal(statusOf(h.store), "Closed the draft editor");
    assert.ok(details(h.store).includes("Draft · revision 2 · version 1.0.0 — e edits its YAML"));
    assert.equal(h.sent().length, 1);
});

test("an edit that cannot be saved is not sent, and the editor says why: nothing changed, empty YAML, over 256 KiB", async () => {
    const h = await editing(draft());
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_SAVE);
    assert.equal(statusOf(h.store), "Nothing changed.");

    toEnd(h);
    for (let i = 0; i < YAML.length; i++) h.controller.editWorkflowDraft({ type: "backspace" });
    assert.equal(editOf(h.store).text, "");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_SAVE);
    assert.equal(statusOf(h.store), "The YAML is empty.");
    let shown = editor(h.store);
    assert.deepEqual(shown.statusLines[0], { text: "The YAML is empty.", color: "red" });
    assert.equal(rowText(shown.lines[0]), "1  ");

    type(h, "x".repeat(256 * 1024 + 1));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_SAVE);
    assert.match(statusOf(h.store), /^The YAML is 262145 bytes; a workflow is at most 262144\./);
    // A line longer than the editor is shown around the cursor, never wrapped: one row, the cursor in it.
    shown = editor(h.store);
    const row = shown.lines[0];
    assert.equal(shown.lines.length, 1);
    assert.ok(rowText(row).length <= 106, `${rowText(row).length} characters`);
    assert.ok(rowText(row).startsWith("1 …x"));
    assert.deepEqual(row.at(-2), { text: " ", color: "promptCursorForeground", backgroundColor: "promptCursorBackground" });
    h.controller.editWorkflowDraft({ type: "edge", edge: "start" });
    const start = editor(h.store).lines[0];
    assert.ok(rowText(start).length <= 106);
    assert.deepEqual(start.at(-1), { text: "…", color: "gray" }, "a line that goes on ends in …");
    assert.deepEqual(h.sent(), []);
});

test("a saved revision with compile errors keeps what was typed and lists its diagnostics", async () => {
    const diagnostics = [
        { severity: "error", code: "STATE_UNKNOWN", path: "states.poll.next.changed", message: "No state 'nowhere'.", line: 7 },
        { severity: "warning", code: "STATE_UNREACHABLE", path: "states.spare", message: "State 'spare' is never reached." },
    ];
    const h = await editing(draft(), [saved(2, { valid: false, diagnostics })]);
    toEnd(h);
    type(h, "# broken on purpose\n");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_SAVE);
    assert.equal(statusOf(h.store), "Saved the draft as revision 2. It has 1 error, so it cannot be published until they are fixed.");
    await settle();
    const shown = editor(h.store);
    assert.match(shown.title, /^Draft · editing revision 2 · /);
    assert.equal(editOf(h.store).text, `${YAML}# broken on purpose\n`);
    const status = shown.statusLines.map(line => line.text);
    assert.deepEqual(status, [
        "No unsaved edits.",
        "Revision 2: 1 error, 1 warning.",
        "  error STATE_UNKNOWN · states.poll.next.changed · line 7: No state 'nowhere'.",
        "  warning STATE_UNREACHABLE · states.spare: State 'spare' is never reached.",
    ]);
    assert.deepEqual(shown.statusLines.slice(1).map(line => line.color), ["red", "red", "yellow"]);
});

/** An edit of revision 1 that the server refused: someone else saved revision 2 meanwhile. */
async function conflicted(answers = []) {
    const h = await editing(draft(), [refused(409, "REVISION_CONFLICT", "The draft is at revision 2, not 1."), ...answers]);
    toEnd(h);
    type(h, "# mine\n");
    h.serve(draft({ revision: 2, yaml: THEIRS }));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_SAVE);
    await settle();
    return h;
}

test("a draft someone else saved meanwhile is refused, never overwritten: the edit stays, and ctrl-k keeps it on the newer revision", async () => {
    const mine = `${YAML}# mine\n`;
    const h = await conflicted([saved(3)]);
    const editorModal = modalOf(h.store);
    assert.equal(editorModal.type, "workflowDraft");
    assert.equal(h.sent()[0].expected_revision, 1);
    assert.equal(statusOf(h.store), "Saving the draft was refused: The draft is at revision 2, not 1.");
    let shown = editor(h.store);
    assert.match(shown.title, /^Draft · editing revision 1 · /, "the edit still starts from revision 1");
    const conflict = "The draft is now at revision 2; this edit started from revision 1. Load revision 2, or keep your edits on it, before saving.";
    assert.ok(joined(shown.statusLines).includes(conflict));
    assert.ok(joined(shown.statusLines).includes("! Saving the draft was refused: The draft is at revision 2, not 1."));
    assert.equal(shown.hint, "ctrl-r load revision 2 (asks first) · ctrl-k keep my edits on revision 2 · Esc close (edits kept)");
    assert.equal(editOf(h.store).text, mine);

    // Saving is not sent again until the person decides.
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_SAVE);
    assert.equal(statusOf(h.store), conflict);
    assert.equal(h.sent().length, 1);

    // ctrl-r asks first; Esc keeps the edit.
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_DISCARD);
    const confirm = modalOf(h.store);
    assert.equal(confirm.type, "confirm");
    assert.equal(confirm.title, "Load Revision 2");
    assert.equal(confirm.confirmLabel, "Load");
    assert.equal(confirm.message, "Discard your edits and show revision 2 as it is saved? Nothing is sent, and no saved revision changes.");
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.deepEqual(modalOf(h.store), editorModal, "back to the editor");
    assert.equal(statusOf(h.store), "Your edits are kept");
    assert.equal(editOf(h.store).text, mine);

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_KEEP);
    assert.equal(statusOf(h.store), "Your edits now apply to revision 2; ctrl-o saves them as a new revision after it");
    shown = editor(h.store);
    assert.match(shown.title, /^Draft · editing revision 2 · /);
    assert.ok(joined(shown.statusLines).includes("Unsaved edits. ctrl-o saves them as a new revision after revision 2."));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_KEEP);
    assert.equal(statusOf(h.store), "There is no newer revision to move your edits onto");

    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_SAVE);
    const [first, second] = h.sent();
    assert.equal(second.expected_revision, 2);
    assert.equal(second.yaml, mine);
    assert.notEqual(second.operation_id, first.operation_id);
    assert.equal(statusOf(h.store), "Saved the draft as revision 3.");
    await settle();
    assert.match(editor(h.store).title, /^Draft · editing revision 3 · /);
    assert.deepEqual(editor(h.store).statusLines.map(line => line.text), ["No unsaved edits."]);
});

test("in a conflict, ctrl-r loads the newer revision after asking; without edits the newer revision is taken as it is", async () => {
    const h = await conflicted();
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_DISCARD);
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.equal(modalOf(h.store).type, "workflowDraft", "the confirm returns to the editor");
    assert.equal(statusOf(h.store), "Showing revision 2 as it is saved");
    assert.deepEqual(editOf(h.store).base, { revision: 2, yaml: THEIRS });
    assert.equal(editOf(h.store).text, THEIRS);
    const shown = editor(h.store);
    assert.match(shown.title, /^Draft · editing revision 2 · /);
    assert.equal(shown.changed, false);
    assert.equal(h.sent().length, 1);

    // Nothing edited: a revision saved elsewhere is shown as it is when the workflow is read again.
    const quiet = await editing(draft());
    quiet.serve(draft({ revision: 2, yaml: THEIRS }));
    await quiet.controller.ensureWorkflowReadModel("wf", { force: true });
    const fresh = editor(quiet.store);
    assert.match(fresh.title, /^Draft · editing revision 2 · /);
    assert.equal(rowText(fresh.lines[5]), "6 # someone else's line");
    assert.deepEqual(fresh.statusLines.map(line => line.text), ["No unsaved edits."]);
});

test("ctrl-r discards an edit after asking, back to the revision it started from; Esc in the confirm keeps it", async () => {
    const h = await editing(draft());
    const editorModal = modalOf(h.store);
    toEnd(h);
    type(h, "# scratch\n");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_DISCARD);
    let confirm = modalOf(h.store);
    assert.deepEqual([confirm.type, confirm.title, confirm.confirmLabel, confirm.action], ["confirm", "Discard Draft Edits", "Discard", "discardWorkflowDraftEdits"]);
    assert.deepEqual(confirm.returnModal, editorModal);
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.equal(statusOf(h.store), "Your edits are kept");
    assert.equal(editOf(h.store).text, `${YAML}# scratch\n`);
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_DISCARD);
    confirm = modalOf(h.store);
    assert.equal(confirm.type, "confirm");
    await h.controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    assert.deepEqual(modalOf(h.store), editorModal);
    assert.equal(statusOf(h.store), "Showing revision 1 as it is saved");
    assert.deepEqual(editOf(h.store), { base: { revision: 1, yaml: YAML }, text: YAML, cursor: YAML.length });
    assert.deepEqual(h.sent(), []);
});

test("a new version is refused and the edit stays; while a save is sent nothing else is; an answer that never came sends the same save again", async () => {
    let lose;
    const h = await editing(draft(), [
        refused(409, "SEMVER_IMMUTABLE", "This workflow child is version 1.0.0; a new version needs a new workflow child."),
        () => new Promise((_, reject) => { lose = () => reject(Object.assign(new Error("upstream unavailable"), { status: 503 })); }),
        saved(2),
    ]);
    toEnd(h);
    type(h, "# version 2.0.0 next\n");
    const edited = `${YAML}# version 2.0.0 next\n`;
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_SAVE);
    const semver = "Saving the draft was refused: This workflow child is version 1.0.0; a new version needs a new workflow child.";
    assert.equal(statusOf(h.store), semver);
    await settle();
    let shown = editor(h.store);
    assert.ok(joined(shown.statusLines).includes(`! ${semver}`));
    assert.ok(joined(shown.statusLines).includes("Unsaved edits. ctrl-o saves them as a new revision after revision 1."), "read again, still revision 1");
    assert.equal(editOf(h.store).text, edited);

    const sending = h.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_SAVE);
    await settle();
    shown = editor(h.store);
    assert.ok(shown.statusLines.some(line => line.text === "Saving…"));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_SAVE);
    assert.equal(statusOf(h.store), "The draft is being saved; wait for its answer");
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_DISCARD);
    assert.equal(modalOf(h.store).type, "workflowDraft", "no confirm while a save is sent");
    assert.equal(statusOf(h.store), "The draft is being saved; wait for its answer");
    assert.equal(h.sent().length, 2);

    lose();
    await sending;
    const lost = "Saving the draft may not have reached the workflow: upstream unavailable. Retry sends the same command again.";
    assert.equal(statusOf(h.store), lost);
    shown = editor(h.store);
    assert.ok(joined(shown.statusLines).includes(`! ${lost}`));
    assert.ok(joined(shown.statusLines).includes("ctrl-o sends the same save again; the server applies it once."));
    assert.equal(editOf(h.store).text, edited);
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_SAVE);
    const [first, second, third] = h.sent();
    assert.notEqual(second.operation_id, first.operation_id);
    assert.deepEqual(third, second, "the same command, with the same operation id");
    assert.equal(statusOf(h.store), "Saved the draft as revision 2.");
    await settle();
    assert.deepEqual(editor(h.store).statusLines.map(line => line.text), ["No unsaved edits."], "the notice went with the accepted save");
});

test("the editor is not offered for a published definition, in an agent state's subtree, without the YAML or without person commands; the server decides anyway", async () => {
    const all = [];
    const refusedWith = async (initial, reason) => {
        const h = await opened(initial);
        all.push(h);
        await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_DRAFT);
        assert.equal(modalOf(h.store).type, "workflowView");
        assert.equal(statusOf(h.store), `The draft cannot be edited here. ${reason}`);
        assert.ok(!details(h.store).some(line => line.startsWith("Draft ·")), reason);
        return h;
    };
    await refusedWith(draft({ state: "published" }), "The definition is published; it no longer changes. A new version needs a new workflow.");
    await refusedWith(draft({ operations: ["pause", "stop", "cancel"],
        restriction: { reason: SUBTREE, workflowSessionId: "outer", controllingSessionId: "parent-1" } }), `${SUBTREE} Its controlling agent is session parent-1.`);
    await refusedWith(draft({ yaml: null, viewer: { allowed: false, reason: "You may read this workflow but not command it." } }),
        "You may read this workflow but not command it.");
    await refusedWith(draft({ yaml: null }), "Its YAML is not given to you.");
    await refusedWith(draft({ commands: false }), "This deployment takes no workflow commands from people.");
    for (const h of all) assert.deepEqual(h.sent(), []);

    // An open editor whose draft was published meanwhile edits and sends nothing.
    const gone = await editing(draft());
    gone.serve(draft({ state: "published" }));
    await gone.controller.ensureWorkflowReadModel("wf", { force: true });
    const shown = editor(gone.store);
    assert.equal(shown.title, "Draft");
    assert.equal(joined(shown.statusLines),
        "The draft cannot be edited here. The definition is published; it no longer changes. A new version needs a new workflow.");
    type(gone, "x");
    await gone.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_SAVE);
    assert.deepEqual(gone.sent(), []);

    // Offered, and still refused by the server: its reason stays in the editor, and on the status line.
    const denied = await editing(draft(), [refused(403, "WORKFLOW_HUMAN_INPUT_DENIED", "People cannot change this workflow.")]);
    toEnd(denied);
    type(denied, "# x\n");
    await denied.controller.handleCommand(UI_COMMANDS.WORKFLOW_DRAFT_SAVE);
    const refusal = "Saving the draft was refused: People cannot change this workflow.";
    assert.equal(modalOf(denied.store).type, "workflowDraft");
    assert.equal(statusOf(denied.store), refusal);
    assert.ok(joined(editor(denied.store).statusLines).includes(`! ${refusal}`));
    assert.equal(editOf(denied.store).text, `${YAML}# x\n`);
});

test("an edit is kept when the editor closes, and the view says so; e opens it again where it was", async () => {
    const h = await editing(draft());
    const view = modalOf(h.store).returnModal;
    toEnd(h);
    type(h, "# later\n");
    await h.controller.handleCommand(UI_COMMANDS.CLOSE_MODAL);
    assert.deepEqual(modalOf(h.store), view);
    assert.equal(statusOf(h.store), "Closed the draft editor; your unsaved edits are kept (e shows them)");
    assert.ok(details(h.store).includes("  Unsaved edits, started from revision 1: e shows them"), details(h.store).join("\n"));
    await h.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_DRAFT);
    assert.equal(editOf(h.store).text, `${YAML}# later\n`);
    assert.match(editor(h.store).title, / · line 7, column 1$/);
    assert.deepEqual(h.sent(), []);
});

test("the kept edit: the current revision untouched, a newer revision taken while nothing was edited, an edit of a revision not read yet kept", () => {
    const editorAt = (revision, yaml) => ({ revision, definitionHash: `hash-${revision}`, yaml, semver: "1.0.0", current: true, busy: false, pending: false });
    const one = editorAt(1, YAML);
    const two = editorAt(2, THEIRS);
    assert.equal(workflowDraftBuffer({ base: { revision: 1, yaml: YAML }, text: "x", cursor: 1 }, null), null);
    assert.deepEqual(workflowDraftBuffer(undefined, one), { base: { revision: 1, yaml: YAML }, text: YAML, cursor: 0 });
    assert.deepEqual(workflowDraftBuffer({ base: { revision: "1", yaml: YAML }, text: "x" }, one), { base: { revision: 1, yaml: YAML }, text: YAML, cursor: 0 });
    // Unchanged, or exactly the newer revision: taken as it is, the cursor kept where it can be.
    assert.deepEqual(workflowDraftBuffer({ base: { revision: 1, yaml: YAML }, text: YAML, cursor: 5 }, two), { base: { revision: 2, yaml: THEIRS }, text: THEIRS, cursor: 5 });
    assert.deepEqual(workflowDraftBuffer({ base: { revision: 1, yaml: YAML }, text: THEIRS, cursor: 999 }, two), { base: { revision: 2, yaml: THEIRS }, text: THEIRS, cursor: THEIRS.length });
    // Changed: kept on the revision it started from (a conflict).
    assert.deepEqual(workflowDraftBuffer({ base: { revision: 1, yaml: YAML }, text: "mine", cursor: 2 }, two), { base: { revision: 1, yaml: YAML }, text: "mine", cursor: 2 });
    // Started from a revision the read model does not show yet: kept as it is, unchanged or not.
    assert.deepEqual(workflowDraftBuffer({ base: { revision: 2, yaml: THEIRS }, text: THEIRS, cursor: 3 }, one), { base: { revision: 2, yaml: THEIRS }, text: THEIRS, cursor: 3 });
});
