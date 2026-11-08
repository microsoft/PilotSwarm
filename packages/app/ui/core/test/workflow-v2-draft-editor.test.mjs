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
 *   - the editor is the YAML tab of a draft (batch 6, r-2); any other revision
 *     shows read-only there (server render)
 *
 * Run: node --test test/workflow-v2-draft-editor.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import {
    workflowV2CommandNamesRun, workflowV2DraftEdit, workflowV2DraftEditor, workflowV2DraftMarks, workflowV2LineDiff, workflowV2RevisionCompare,
    workflowV2RunCommandAccepted, workflowV2RunCommandArgs,
    workflowV2RunCommandNotice, workflowV2RunCommandWire,
} from "../src/workflow-v2-commands.js";
import { WorkflowMainPane } from "../../react/src/workflow-workspace.js";
import { WorkflowV2RevisionCompare } from "../../react/src/workflow-v2-panels.js";
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
        busy: false, pending: false, diagnostics: [] });
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
    assert.equal(workflowV2RunCommandAccepted("replace_definition", null, { revision: 3, valid: true, diagnostics: [] }), "Saved the definition as revision 3.");
    assert.equal(workflowV2RunCommandAccepted("replace_definition", null, { revision: 3, valid: false, diagnostics: [
        { severity: "error", code: "E1" }, { severity: "error", code: "E2" }, { severity: "warning", code: "W1" }] }),
    "Saved the definition as revision 3. It has 2 errors, so it cannot be started until they are fixed.");
    assert.equal(workflowV2RunCommandNotice({ operation: "replace_definition", runId: null, phase: "failed", message: "The draft is at revision 3, not 2." }).text,
        "Draft not saved: The draft is at revision 3, not 2.");
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
    const store = createStore(appReducer, createInitialState({ workflowsEnabled: true, mode: "web" }));
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
    assert.equal(h.store.getState().ui.statusText, "Saved the definition as revision 3.");
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
        "Draft not saved: This workflow child is version 1.0.0; a new version needs a new workflow child.");
    // Nothing is sent for a save that is not one.
    assert.deepEqual(await h.controller.sendWorkflowRunCommand(SID, { operation: "replace_definition", yaml: EDITED }), { ok: false, reason: "invalid" });
    assert.equal(h.updates.length, 3);
});

function mount(view) {
    const store = createStore(appReducer, createInitialState({ workflowsEnabled: true, mode: "api" }));
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", sessionKind: "workflow", title: "Watch" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view });
    return new PilotSwarmUiController({ store, transport: {} });
}
const main = controller => renderToStaticMarkup(React.createElement(WorkflowMainPane, { controller, icon: null }));

test("the YAML tab edits the draft's YAML; without it, for a published definition or in a subtree, it shows the YAML read-only", () => {
    const closed = main(mount({ readModel: modelOf(), readModelRunId: null }));
    assert.match(closed, /role="tab" aria-selected="false"[^>]*>YAML<\/button>/, "Graph | YAML (batch 6, r-1); the Edit draft button is gone");
    assert.ok(!closed.includes("Edit draft") && !closed.includes("YAML editor"));

    const open = main(mount({ readModel: modelOf(), readModelRunId: null, mainTab: "yaml" }));
    assert.match(open, /role="tab" aria-selected="true"[^>]*>YAML<\/button>/);
    assert.match(open, /<div id="[^"]+-yaml-panel" class="ps-workflow-yaml-tab" role="tabpanel"/);
    assert.match(open, /<div id="[^"]+-graph-panel" class="ps-workflow-graph-region" hidden=""/, "the graph stays, hidden");
    assert.ok(open.includes("aria-label=\"YAML editor\""));
    assert.ok(open.includes("aria-label=\"YAML tools\""), "the draft's tools open in the side pane");
    assert.ok(open.includes("Definition · editing revision 2"));
    assert.ok(open.includes(`>${YAML}</textarea>`), "the YAML is in the editor");
    assert.ok(open.includes("The version stays 1.0.0: a new version needs a new workflow."));
    // Owner, 2026-11-06T13:43Z (F1): Save is an icon named "Save"; the reason it cannot save is its tooltip.
    assert.match(open, /<button type="button" disabled=""[^>]*aria-label="Save" data-title="Nothing changed\."[^>]*data-operation="replace_definition"/);

    for (const [label, model] of [["no YAML", modelOf({ draft: null })], ["published", modelOf({ definition: { state: "published", currentRevision: 1 } })],
        ["subtree", modelOf({ operations: ["pause", "stop", "cancel"] })]]) {
        const html = main(mount({ readModel: model, readModelRunId: null, mainTab: "yaml" }));
        assert.ok(!html.includes("Edit draft") && !html.includes("YAML editor"), label);
        assert.ok(html.includes("aria-label=\"Workflow YAML\""), `${label}: the YAML read-only`);
    }
    // A published revision: its YAML from the revision read, in the same box, read-only, with one muted note.
    const published = { state: "published", currentRevision: 1, publishedRevision: 1 };
    const yamlRead = { 1: { phase: "loaded", error: null, value: { definitionRevision: { revision: 1, definitionHash: "hash-1", valid: true, yaml: YAML } } } };
    const fixed = main(mount({ readModel: modelOf({ definition: published }), readModelRunId: null, mainTab: "yaml", definitionRevisions: yamlRead }));
    // Words (Workflow Simplified 03, 17): the revision and what a person can do; no draft or published.
    assert.ok(fixed.includes("Revision 1 · read-only. To change it, ask the chat."));
    // React 19 writes the attribute as its prop name (readOnly=""); HTML reads it in any case.
    assert.match(fixed, /<textarea[^>]*readonly=""[^>]*>apiVersion: pilotswarm\.dev\/v2-draft/i);
    assert.ok(!fixed.includes("data-operation=\"replace_definition\""), "nothing to save");
    assert.ok(main(mount({ readModel: modelOf({ definition: published }), readModelRunId: null, mainTab: "yaml" })).includes("Reading revision 1…"));
    // Someone who may not change the workflow is not given its versions' YAML by the server: the tab says so.
    const denied = { ...modelOf({ definition: published, draft: null }), personCommands: { operations: EVERY, restriction: null, run: null,
        viewer: { allowed: false, reason: "Only its owner can change it." } } };
    const told = main(mount({ readModel: denied, readModelRunId: null, mainTab: "yaml" }));
    assert.ok(told.includes("The YAML is shown to people who can change this workflow."));
    assert.ok(!told.includes("<textarea"));
});

// Owner decision q5: the saved revision's errors are marked inside the editor, on their lines, with a button per marked
// line that moves the cursor there; a diagnostic without a line is counted, not marked; another revision's are not shown.
test("the editor marks the saved revision's errors on their lines, and lists a button per marked line", () => {
    const diagnostics = [
        { severity: "error", code: "STATE_UNKNOWN", path: "states.poll.next.changed", message: "No state 'nowhere'.", line: 2 },
        { severity: "warning", code: "STATE_UNREACHABLE", path: "states.spare", message: "State 'spare' is never reached.", line: 3 },
        { severity: "warning", code: "STYLE", path: "states.spare", message: "Name it plainly.", line: 3 },
        { severity: "error", code: "NO_LINE", path: "$", message: "Somewhere." },
        "not a diagnostic",
    ];
    assert.deepEqual(workflowV2DraftMarks(diagnostics), { unplaced: 1, lines: [
        { line: 2, severity: "error", texts: ["STATE_UNKNOWN: No state 'nowhere'."] },
        { line: 3, severity: "warning", texts: ["STATE_UNREACHABLE: State 'spare' is never reached.", "STYLE: Name it plainly."] },
    ] });
    assert.deepEqual(workflowV2DraftMarks(null), { lines: [], unplaced: 0 });
    const withErrors = { ...modelOf(), revision: { revision: 2, definitionHash: "hash-2", valid: false, diagnostics } };
    assert.deepEqual(workflowV2DraftEditor(withErrors).diagnostics, diagnostics.slice(0, 4), "the editor's own revision's diagnostics");
    const older = { ...modelOf(), revision: { revision: 1, definitionHash: "hash-1", valid: false, diagnostics } };
    assert.deepEqual(workflowV2DraftEditor(older).diagnostics, [], "another revision's diagnostics are not this text's");

    const open = main(mount({ readModel: withErrors, readModelRunId: null, mainTab: "yaml" }));
    assert.match(open, /<div data-mark="error" title="STATE_UNKNOWN: No state &#x27;nowhere&#x27;\."[^>]*>● 2<\/div>/);
    assert.match(open, /<div data-mark="warning" title="STATE_UNREACHABLE: State &#x27;spare&#x27; is never reached\.\nSTYLE: Name it plainly\."[^>]*>● 3<\/div>/);
    assert.match(open, /<div>1<\/div>/, "an unmarked line keeps its number");
    assert.match(open, /aria-describedby="wf-yaml-marks-[^"]+"/);
    assert.match(open, /<ul id="wf-yaml-marks-[^"]+" class="ps-workflow-yaml-marks" aria-label="Errors marked in the YAML"/);
    assert.match(open, /data-line="2">Line 2<\/button>/);
    assert.match(open, /data-line="3">Line 3<\/button>/);
    assert.ok(open.includes(`>${YAML}</textarea>`), "the YAML is still a plain text box");
    assert.match(open, /wrap="off"/);
    // Without diagnostics nothing is marked and no list is shown.
    const clean = main(mount({ readModel: modelOf(), readModelRunId: null, mainTab: "yaml" }));
    assert.ok(!clean.includes("data-mark=") && !clean.includes("Errors marked in the YAML") && !clean.includes("aria-describedby=\"wf-yaml-marks"));
});

// Owner decision q4: two saved versions compared line by line, as formatted YAML from the revision read; until the
// diff view loads (and in a server render) the same comparison shows as + and - lines.
test("two versions compare line by line: removals before additions, line numbers on each side, a summary", () => {
    const diff = workflowV2LineDiff("a: 1\nb: 2\nc: 3\n", "a: 1\nb: 20\nc: 3\nd: 4\n");
    assert.deepEqual(diff.rows, [
        { kind: "same", text: "a: 1", before: 1, after: 1 },
        { kind: "removed", text: "b: 2", before: 2, after: null },
        { kind: "added", text: "b: 20", before: null, after: 2 },
        { kind: "same", text: "c: 3", before: 3, after: 3 },
        { kind: "added", text: "d: 4", before: null, after: 4 },
        { kind: "same", text: "", before: 4, after: 5 },
    ]);
    assert.deepEqual([diff.added, diff.removed, diff.approximate], [2, 1, false]);
    assert.deepEqual(workflowV2LineDiff("x", "x"), { rows: [{ kind: "same", text: "x", before: 1, after: 1 }], added: 0, removed: 0, approximate: false });
    const big = workflowV2LineDiff(Array.from({ length: 1600 }, (_, i) => `a${i}`).join("\n"), Array.from({ length: 1600 }, (_, i) => `b${i}`).join("\n"));
    assert.deepEqual([big.approximate, big.removed, big.added, big.rows[0].kind, big.rows[1600].kind], [true, 1600, 1600, "removed", "added"]);

    const read = (revision, formatted, yaml = formatted ?? "x: [") => ({ phase: "loaded", error: null,
        value: { workflowId: SID, definitionRevision: { revision, definitionHash: `h${revision}`, valid: true, yaml, formatted } } });
    const reads = { 1: read(1, "a: 1\n"), 2: read(2, "a: 2\n") };
    const compared = workflowV2RevisionCompare(reads, 1, 2);
    assert.equal(compared.summary, "Revision 1 → 2: +1 −1 lines");
    assert.deepEqual([compared.ready, compared.before.formatted, compared.after.text], [true, true, "a: 2\n"]);
    assert.equal(workflowV2RevisionCompare({ 1: read(1, "a\n"), 2: read(2, "a\n") }, 1, 2).summary, "Revisions 1 and 2 are the same.");
    assert.equal(workflowV2RevisionCompare({ 1: read(1, "a\n") }, 1, 2).summary, "Reading revisions 1 and 2…");
    assert.equal(workflowV2RevisionCompare({ 1: read(1, "a\n"), 2: { phase: "failed", value: null, error: "Gateway timeout" } }, 1, 2).summary,
        "Revision 2 could not be read: Gateway timeout");
    // A revision that does not parse is compared as saved.
    const unparsed = workflowV2RevisionCompare({ 1: read(1, null, "x: [\n"), 2: read(2, "x: 1\n") }, 1, 2);
    assert.deepEqual([unparsed.before.text, unparsed.before.formatted], ["x: [\n", false]);

    const html = renderToStaticMarkup(React.createElement(WorkflowV2RevisionCompare, { controller: {}, sessionId: SID, latest: 2, reads }));
    assert.match(html, /<section class="ps-workflow-compare" aria-label="Compare versions" data-from="1" data-to="2"/);
    assert.match(html, /role="status"[^>]*>Revision 1 → 2: \+1 −1 lines<\/p>/);
    assert.match(html, /<div data-kind="removed"[^>]*>- a: 1<\/div><div data-kind="added"[^>]*>\+ a: 2<\/div>/);
    assert.match(html, /<option value="2" selected="">Revision 2 \(latest\)<\/option>/);
});

test("the controller reads each definition revision once, again after a failure, and keeps it by revision", async () => {
    const calls = [];
    let fail = true;
    const store = createStore(appReducer, createInitialState({ workflowsEnabled: true, mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport: { readWorkflow: async (sessionId, options) => {
        calls.push([sessionId, options]);
        if (fail) throw new Error("Gateway timeout");
        return { workflowId: sessionId, definitionRevision: { revision: options.definitionRevision, yaml: "a: 1\n", formatted: "a: 1\n", valid: true } };
    } } });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SID, title: "Workflow", status: "idle", sessionKind: "workflow" }] });
    const reads = () => store.getState().ui.workflowViews[SID].definitionRevisions;
    assert.equal((await controller.loadWorkflowDefinitionRevision(SID, 1)).phase, "failed");
    assert.equal(reads()[1].error, "Gateway timeout");
    fail = false;
    assert.equal((await controller.loadWorkflowDefinitionRevision(SID, 1)).phase, "loaded");
    await controller.loadWorkflowDefinitionRevision(SID, 1);
    await controller.loadWorkflowDefinitionRevision(SID, 2);
    assert.deepEqual(calls.map(call => call[1]), [{ definitionRevision: 1 }, { definitionRevision: 1 }, { definitionRevision: 2 }]);
    assert.deepEqual(Object.keys(reads()), ["1", "2"]);
    assert.equal(await controller.loadWorkflowDefinitionRevision(SID, 0), null);
    assert.equal(await controller.loadWorkflowDefinitionRevision("not-a-workflow", 1), null);
});
