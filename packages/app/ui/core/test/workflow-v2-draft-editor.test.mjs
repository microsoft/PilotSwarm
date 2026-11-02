/**
 * Workflow v2: a person edits a draft's YAML in the workflow view (design 04
 * replace_definition; mocks M01 and M02; R03, R17, R26; INACTIVE):
 *   - the editor exists only where the read model carries the draft's YAML
 *     for this caller (personCommands.draft: a draft a person may change; the
 *     portal leaves the YAML out for anyone who may not command it), never
 *     for a published definition or in a workflow agent state's subtree
 *   - an edit starts from the revision shown and is saved at that revision;
 *     an edit is unchanged, changed, or in conflict when the draft moved on
 *     meanwhile (saving would be refused); empty or over-size YAML is not sent
 *   - the command names no run and carries the whole YAML; a refused save (a
 *     changed draft, 409 REVISION_CONFLICT; a new version, 409
 *     SEMVER_IMMUTABLE) is reported and the workflow read again
 *   - the editor opens from the header (server render)
 *
 * Run: node --test test/workflow-v2-draft-editor.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import {
    workflowV2CommandNamesRun, workflowV2DraftEdit, workflowV2DraftEditor, workflowV2RunCommandAccepted, workflowV2RunCommandArgs,
    workflowV2RunCommandNotice, workflowV2RunCommandWire,
} from "../src/workflow-v2-commands.js";
import { WorkflowMainPane } from "../../react/src/workflow-workspace.js";
import { readModel } from "./workflow-v2-fixtures.mjs";

const SID = "wf-draft-editor";
const EVERY = ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel"];
const YAML = "apiVersion: pilotswarm.dev/v2-draft\nkind: Workflow\nmetadata: { name: watch-v2, version: 1.0.0 }\n";
const DRAFT = { state: "draft", currentRevision: 2, publishedRevision: null, publishedDefinitionHash: null };
const draftOf = (extra = {}) => ({ revision: 2, definitionHash: "hash-2", yaml: YAML, ...extra });
const modelOf = ({ definition = DRAFT, draft = draftOf(), operations = EVERY, restriction = null } = {}) => ({
    ...readModel({ definition, revision: { revision: definition.currentRevision ?? 1, definitionHash: "hash-2" }, noRun: true }),
    personCommands: { operations, restriction, run: null, ...(draft ? { draft } : {}) } });

test("the editor exists only for a draft whose YAML the read model gives this caller", () => {
    assert.equal(workflowV2DraftEditor(readModel({ definition: DRAFT, noRun: true })), null, "no personCommands");
    assert.equal(workflowV2DraftEditor(modelOf({ draft: null })), null, "no YAML for this caller");
    assert.equal(workflowV2DraftEditor(modelOf({ definition: { state: "published", currentRevision: 1 } })), null, "a published definition");
    assert.equal(workflowV2DraftEditor(modelOf({ operations: ["pause", "stop", "cancel"] })), null, "an agent state's subtree");
    assert.equal(workflowV2DraftEditor(modelOf({ draft: draftOf({ yaml: 5 }) })), null);
    assert.deepEqual(workflowV2DraftEditor(modelOf()), { revision: 2, definitionHash: "hash-2", yaml: YAML, semver: "1.0.0", current: true,
        busy: false, pending: false });
    const pending = workflowV2DraftEditor(modelOf(), { operation: "replace_definition", runId: null, phase: "pending" });
    assert.deepEqual([pending.busy, pending.pending], [true, true]);
    const other = workflowV2DraftEditor(modelOf(), { operation: "publish", runId: null, phase: "pending" });
    assert.deepEqual([other.busy, other.pending], [true, false]);
});

test("an edit is unchanged, changed or in conflict with the draft shown; empty or over-size YAML is not saved", () => {
    const model = workflowV2DraftEditor(modelOf());
    const base = { revision: 2, yaml: YAML };
    assert.deepEqual(workflowV2DraftEdit(base, YAML, model), { changed: false, conflict: false, canSave: false, reason: "Nothing changed." });
    assert.deepEqual(workflowV2DraftEdit(base, `${YAML}# note\n`, model), { changed: true, conflict: false, canSave: true, reason: null });
    assert.equal(workflowV2DraftEdit(base, "   ", model).reason, "The YAML is empty.");
    assert.match(workflowV2DraftEdit(base, "x".repeat(256 * 1024 + 1), model).reason, /^The YAML is 262145 bytes; a workflow is at most 262144\./);
    // The draft moved on to revision 3 while revision 2 was edited: saving would be refused.
    const moved = workflowV2DraftEditor(modelOf({ definition: { ...DRAFT, currentRevision: 3 }, draft: draftOf({ revision: 3 }) }));
    const conflict = workflowV2DraftEdit(base, `${YAML}# note\n`, moved);
    assert.deepEqual([conflict.changed, conflict.conflict, conflict.canSave], [true, true, false]);
    assert.match(conflict.reason, /^The draft is now at revision 3; this edit started from revision 2\./);
    assert.equal(workflowV2DraftEdit(base, `${YAML}# note\n`, { ...model, busy: true }).canSave, false, "nothing is sent while a command is");
});

test("the save names no run, carries the whole YAML at the revision the edit started from, and says what was saved", () => {
    assert.equal(workflowV2CommandNamesRun("replace_definition"), false);
    assert.deepEqual(workflowV2RunCommandArgs("replace_definition", { expectedRevision: 2, yaml: YAML }), { ok: true, args: { expectedRevision: 2, yaml: YAML } });
    for (const input of [{ yaml: YAML }, { expectedRevision: 0, yaml: YAML }, { expectedRevision: 2, yaml: "  " }, { expectedRevision: 2, yaml: 5 }, null]) {
        assert.deepEqual(workflowV2RunCommandArgs("replace_definition", input), { ok: false }, JSON.stringify(input));
    }
    assert.deepEqual(workflowV2RunCommandWire("replace_definition", null, "op-1", { expectedRevision: 2, yaml: YAML }),
        { operation: "replace_definition", operation_id: "op-1", expected_revision: 2, yaml: YAML });
    assert.equal(workflowV2RunCommandAccepted("replace_definition", null, { revision: 3, valid: true, diagnostics: [] }), "Saved the draft as revision 3.");
    assert.equal(workflowV2RunCommandAccepted("replace_definition", null, { revision: 3, valid: false, diagnostics: [
        { severity: "error", code: "E1" }, { severity: "error", code: "E2" }, { severity: "warning", code: "W1" }] }),
    "Saved the draft as revision 3. It has 2 errors, so it cannot be published until they are fixed.");
    assert.equal(workflowV2RunCommandNotice({ operation: "replace_definition", runId: null, phase: "failed", message: "The draft is at revision 3, not 2." }).text,
        "Saving the draft was refused: The draft is at revision 3, not 2.");
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
    const transport = {
        listSessions: async () => [],
        subscribeSession: () => () => {},
        getSessionEventsBefore: async () => [],
        readWorkflow: async (sessionId, options) => { reads.push([sessionId, options]); return modelOf(); },
        updateWorkflow: async (sessionId, command) => { updates.push([sessionId, command]); return answer(command); },
    };
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SID, title: "Workflow: w", status: "pending", sessionKind: "workflow", updatedAt: 1 }] });
    store.dispatch({ type: "sessions/selected", sessionId: SID });
    const view = () => store.getState().ui.workflowViews?.[SID] || {};
    return { controller, store, updates, reads, view };
}

const without = (command, key) => Object.fromEntries(Object.entries(command).filter(([name]) => name !== key));
const EDITED = `${YAML}# a note\n`;

test("a save sends replace_definition at the revision the edit started from; a changed draft or a new version is refused and read again", async () => {
    let fail = null;
    const h = seeded(command => {
        if (fail) throw fail;
        return { workflowId: SID, operation: command.operation, replayed: false, state: "draft", revision: 3, definitionHash: "hash-3", valid: true, diagnostics: [] };
    });
    assert.equal((await h.controller.sendWorkflowRunCommand(SID, { operation: "replace_definition", expectedRevision: 2, yaml: EDITED })).ok, true);
    const [sessionId, command] = h.updates[0];
    assert.equal(sessionId, SID);
    assert.match(command.operation_id, /^ui-replace_definition-./);
    assert.deepEqual(without(command, "operation_id"), { operation: "replace_definition", expected_revision: 2, yaml: EDITED });
    assert.equal(h.store.getState().ui.statusText, "Saved the draft as revision 3.");
    await until(() => h.reads.length === 1, "the read model read again");

    fail = Object.assign(new Error("The draft is at revision 3, not 2."), { status: 409, code: "REVISION_CONFLICT", details: { currentRevision: 3 } });
    assert.equal((await h.controller.sendWorkflowRunCommand(SID, { operation: "replace_definition", expectedRevision: 2, yaml: EDITED })).reason, "failed");
    assert.deepEqual(without(h.view().runCommand, "operationId"), { operation: "replace_definition", runId: null,
        args: { expectedRevision: 2, yaml: EDITED }, phase: "failed", message: "The draft is at revision 3, not 2.", code: "REVISION_CONFLICT" });
    await until(() => h.reads.length === 2, "the read model read again after the refusal");
    h.controller.dismissWorkflowRunCommand(SID);

    fail = Object.assign(new Error("This workflow child is version 1.0.0; a new version needs a new workflow child."),
        { status: 409, code: "SEMVER_IMMUTABLE", details: { semver: "1.0.0" } });
    await h.controller.sendWorkflowRunCommand(SID, { operation: "replace_definition", expectedRevision: 3, yaml: EDITED.replace("1.0.0", "2.0.0") });
    assert.equal(workflowV2RunCommandNotice(h.view().runCommand).text,
        "Saving the draft was refused: This workflow child is version 1.0.0; a new version needs a new workflow child.");
    // Nothing is sent for a save that is not one.
    assert.deepEqual(await h.controller.sendWorkflowRunCommand(SID, { operation: "replace_definition", yaml: EDITED }), { ok: false, reason: "invalid" });
    assert.equal(h.updates.length, 3);
});

function mount(view) {
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", sessionKind: "workflow", title: "Watch" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view });
    return new PilotSwarmUiController({ store, transport: {} });
}
const main = controller => renderToStaticMarkup(React.createElement(WorkflowMainPane, { controller, log: null, icon: null }));

test("the editor opens from the header with the draft's YAML; nothing is offered without the YAML, for a published definition or in a subtree", () => {
    const closed = main(mount({ readModel: modelOf(), readModelRunId: null }));
    assert.ok(closed.includes(">Edit draft</button>"));
    assert.ok(!closed.includes("Draft editor"));

    const open = main(mount({ readModel: modelOf(), readModelRunId: null, draftOpen: true }));
    assert.ok(open.includes("aria-label=\"Draft editor\""));
    assert.ok(open.includes("Draft · editing revision 2"));
    assert.ok(open.includes(`>${YAML}</textarea>`), "the YAML is in the editor");
    assert.ok(open.includes("The version stays 1.0.0: a new version needs a new workflow."));
    assert.match(open, /data-operation="replace_definition" disabled="" title="Nothing changed\."/);

    for (const [label, model] of [["no YAML", modelOf({ draft: null })], ["published", modelOf({ definition: { state: "published", currentRevision: 1 } })],
        ["subtree", modelOf({ operations: ["pause", "stop", "cancel"] })]]) {
        const html = main(mount({ readModel: model, readModelRunId: null, draftOpen: true }));
        assert.ok(!html.includes("Edit draft") && !html.includes("Draft editor"), label);
    }
});
