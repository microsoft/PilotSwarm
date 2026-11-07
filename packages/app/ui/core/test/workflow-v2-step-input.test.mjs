/**
 * Workflow v2: a person changes an agent step's inputs without writing YAML (owner decision q6; INACTIVE: only a draft
 * this person may change):
 *   - each input field of the step says where its value comes from (a run input, the previous step's result, a workflow
 *     variable, a fixed value, or as written in the YAML), in plain words
 *   - the editor's choices become the read's request; a field that is not set is left out, and a required one is named
 *   - "Show the change" asks the server for the draft's YAML with only that step's input lines changed; "Save as a new
 *     draft revision" saves exactly that text with replace_definition at the revision it was prepared on
 *   - nothing is saved while the YAML box has unsaved edits, or after the draft moved on
 *
 * Run: node --test test/workflow-v2-step-input.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import {
    WORKFLOW_V2_STEP_INPUT_SOURCE_LABELS, workflowV2StepInputKey, workflowV2StepInputRequest, workflowV2StepInputRows, workflowV2StepInputSummary,
} from "../src/workflow-v2-commands.js";
import { WorkflowNodePane } from "../../react/src/workflow-workspace.js";
import { WorkflowV2StepInputEditor } from "../../react/src/workflow-v2-panels.js";
import { readModel } from "./workflow-v2-fixtures.mjs";

const SID = "wf-step-input";
const STEP_INPUT = {
    state: "review", revision: 2, definitionHash: "hash-2", schemaDeclared: true, runInputs: ["pr", "repo"], inputShape: "fields", inputText: null,
    fields: [
        { name: "pr", declared: true, required: true, type: "string", description: "The pull request", current: { source: "run_input", name: "pr" } },
        { name: "depth", declared: true, required: true, type: "integer", description: null, current: null },
        { name: "label", declared: true, required: false, type: "string", description: null, current: { source: "fixed", value: "release" } },
        { name: "count", declared: true, required: false, type: "integer", description: null, current: { source: "fixed", value: 3 } },
        { name: "summary", declared: true, required: false, type: null, description: null, current: { source: "previous_step", path: "review.summary" } },
        { name: "notes", declared: false, required: false, type: null, description: null, current: { source: "keep", text: "${input.notes ?? \"none\"}" } },
    ],
};
const YAML = "states:\n  review:\n    input:\n      pr: ${inputs.pr}\n";
const PROPOSED = "states:\n  review:\n    input:\n      pr: ${inputs.repo}\n";

test("each input field says where its value comes from, in plain words", () => {
    assert.deepEqual(WORKFLOW_V2_STEP_INPUT_SOURCE_LABELS, { none: "Not set", run_input: "A run input", previous_step: "The previous step's result",
        variable: "A workflow variable", fixed: "A fixed value", keep: "As written in the YAML" });
    const rows = workflowV2StepInputRows(STEP_INPUT);
    assert.deepEqual(rows.map(row => [row.name, row.source, row.detail, row.required, row.keepable]), [
        ["pr", "run_input", "pr", true, false],
        ["depth", "none", "", true, false],
        ["label", "fixed", "release", false, false],
        ["count", "fixed", "3", false, false],
        ["summary", "previous_step", "review.summary", false, false],
        ["notes", "keep", "${input.notes ?? \"none\"}", false, true],
    ]);
    assert.equal(rows[0].description, "The pull request");
    assert.equal(rows[5].keepText, "${input.notes ?? \"none\"}");
    assert.deepEqual(workflowV2StepInputRows(null), []);
});

test("the editor's choices become the read's request; a field not set is left out and a required one is named", () => {
    const rows = workflowV2StepInputRows(STEP_INPUT);
    const request = workflowV2StepInputRequest(rows);
    assert.deepEqual(request, { ok: true, missing: ["depth"], input: {
        pr: { source: "run_input", name: "pr" }, label: { source: "fixed", value: "release" }, count: { source: "fixed", value: 3 },
        summary: { source: "previous_step", path: "review.summary" }, notes: { source: "keep" },
    } });
    const edit = (name, patch) => rows.map(row => (row.name === name ? { ...row, ...patch } : row));
    // A text field takes what was typed; a typed field needs its kind of value; a field of no known type takes text too.
    assert.deepEqual(workflowV2StepInputRequest(edit("label", { detail: "\"quoted\"" })).input.label, { source: "fixed", value: "quoted" });
    assert.deepEqual(workflowV2StepInputRequest(edit("depth", { source: "fixed", detail: "2" })), { ok: true, missing: [], input: {
        ...request.input, depth: { source: "fixed", value: 2 } } });
    assert.match(workflowV2StepInputRequest(edit("count", { detail: "three" })).error, /^The fixed value for 'count' must be JSON/);
    assert.deepEqual(workflowV2StepInputRequest(edit("summary", { source: "fixed", detail: "plain words" })).input.summary, { source: "fixed", value: "plain words" });
    assert.deepEqual(workflowV2StepInputRequest(edit("pr", { source: "variable", detail: " release label " })).input.pr, { source: "variable", name: "release label" });
    assert.equal(workflowV2StepInputRequest(edit("pr", { detail: "" })).error, "Name the run input for 'pr'.");
    assert.deepEqual(workflowV2StepInputRequest(edit("summary", { detail: "" })).input.summary, { source: "previous_step", path: "" });
});

test("the change's summary says what saving does, and a draft that would have errors can still be saved", () => {
    assert.equal(workflowV2StepInputSummary("review", null), null);
    assert.deepEqual(workflowV2StepInputSummary("review", { phase: "loading" }), { level: "info", text: "Preparing the change…" });
    assert.deepEqual(workflowV2StepInputSummary("review", { phase: "failed", error: "Gateway timeout" }),
        { level: "error", text: "The change could not be prepared: Gateway timeout" });
    assert.equal(workflowV2StepInputSummary("review", { phase: "loaded", value: { changed: false } }).text,
        "The inputs of step 'review' are already written this way; there is nothing to save.");
    assert.deepEqual(workflowV2StepInputSummary("review", { phase: "loaded", value: { changed: true, valid: true, diagnostics: [] } }),
        { level: "info", text: "Only the input lines of step 'review' change. Saving makes a new draft revision." });
    assert.deepEqual(workflowV2StepInputSummary("review", { phase: "loaded", value: { changed: true, valid: false,
        diagnostics: [{ severity: "error" }, { severity: "warning" }] } }),
    { level: "warning", text: "Only the input lines of step 'review' change, but the draft would have 1 error; you can save it and fix them later." });
});

function seeded({ fail = null } = {}) {
    const store = createStore(appReducer, createInitialState({ mode: "web" }));
    const reads = [];
    const updates = [];
    const transport = {
        listSessions: async () => [],
        subscribeSession: () => () => {},
        getSessionEventsBefore: async () => [],
        readWorkflow: async (sessionId, options) => {
            reads.push([sessionId, options]);
            if (fail) throw fail;
            if (!options?.stepInput) return readModel({ noRun: true });
            const revision = updates.length ? 3 : 2;
            return { workflowId: sessionId, stepInput: { ...STEP_INPUT, revision,
                ...(options.stepInput.input ? { proposed: { yaml: PROPOSED, changed: true, valid: true, diagnostics: [] } } : {}) } };
        },
        updateWorkflow: async (sessionId, command) => {
            updates.push([sessionId, command]);
            return { workflowId: sessionId, operation: command.operation, replayed: false, state: "draft", revision: 3, definitionHash: "hash-3", valid: true, diagnostics: [] };
        },
    };
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: SID, title: "Workflow: w", status: "pending", sessionKind: "workflow", updatedAt: 1 }] });
    store.dispatch({ type: "sessions/selected", sessionId: SID });
    const view = () => store.getState().ui.workflowViews?.[SID] || {};
    return { controller, store, reads, updates, view };
}

test("the controller reads a step's inputs, prepares the change and saves it as a new draft revision at the revision it was prepared on", async () => {
    const h = seeded();
    await h.controller.loadWorkflowStepInput(SID, "review");
    assert.deepEqual(h.reads.at(-1), [SID, { stepInput: { state: "review" } }]);
    assert.deepEqual([h.view().stepInput.state, h.view().stepInput.phase, h.view().stepInput.value.revision], ["review", "loaded", 2]);
    // Nothing is saved before the change is prepared.
    assert.deepEqual(await h.controller.saveWorkflowStepInput(SID), { ok: false, reason: "invalid" });
    const input = { pr: { source: "run_input", name: "repo" } };
    await h.controller.previewWorkflowStepInput(SID, "review", input);
    assert.deepEqual(h.reads.at(-1), [SID, { stepInput: { state: "review", input } }]);
    assert.deepEqual(h.view().stepInputPreview, { state: "review", revision: 2, key: workflowV2StepInputKey(input), phase: "loaded", error: null,
        value: { yaml: PROPOSED, changed: true, valid: true, diagnostics: [] } });
    // A change is prepared only for the step the editor shows.
    assert.equal(await h.controller.previewWorkflowStepInput(SID, "other", input), null);

    const saved = await h.controller.saveWorkflowStepInput(SID, { state: "review", input });
    assert.equal(saved.ok, true);
    assert.equal(h.updates.length, 1);
    const [sessionId, command] = h.updates[0];
    assert.equal(sessionId, SID);
    assert.deepEqual([command.operation, command.expected_revision, command.yaml], ["replace_definition", 2, PROPOSED]);
    // The step is read again on the new revision, and the prepared change is gone.
    assert.deepEqual([h.view().stepInput.phase, h.view().stepInput.value.revision, h.view().stepInputPreview], ["loaded", 3, null]);
    assert.equal(h.store.getState().ui.statusText, "Saved the inputs of step 'review' as revision 3");

    h.controller.closeWorkflowStepInput(SID);
    assert.deepEqual([h.view().stepInput, h.view().stepInputPreview], [null, null]);
    assert.equal(await h.controller.loadWorkflowStepInput("not-a-workflow", "review"), null);
    assert.equal(await h.controller.loadWorkflowStepInput(SID, ""), null);
});

test("a read that fails is shown with its reason, and nothing can be prepared from it", async () => {
    const h = seeded({ fail: Object.assign(new Error("Only a draft's step inputs are edited; a published workflow does not change."), { status: 400 }) });
    const read = await h.controller.loadWorkflowStepInput(SID, "review");
    assert.deepEqual(read, { state: "review", phase: "failed", value: null, error: "Only a draft's step inputs are edited; a published workflow does not change." });
    assert.equal(await h.controller.previewWorkflowStepInput(SID, "review", {}), null);
});

test("changing the fields drops the prepared change, and an answer for fields since changed is dropped", async () => {
    const h = seeded();
    await h.controller.loadWorkflowStepInput(SID, "review");
    const before = { pr: { source: "run_input", name: "repo" } };
    const after = { pr: { source: "run_input", name: "pr" } };
    assert.equal(workflowV2StepInputKey(before), workflowV2StepInputKey({ pr: { source: "run_input", name: "repo" } }));
    assert.notEqual(workflowV2StepInputKey(before), workflowV2StepInputKey(after));
    assert.equal(workflowV2StepInputKey(undefined), null);

    // Edit after "Show the change": nothing prepared from other fields, or for another step, is saved, and the edit drops it.
    await h.controller.previewWorkflowStepInput(SID, "review", before);
    assert.equal(h.view().stepInputPreview.phase, "loaded");
    assert.deepEqual(await h.controller.saveWorkflowStepInput(SID, { state: "review", input: after }), { ok: false, reason: "invalid" });
    assert.deepEqual(await h.controller.saveWorkflowStepInput(SID, { state: "fix", input: before }), { ok: false, reason: "invalid" });
    h.controller.forgetWorkflowStepInputPreview(SID);
    assert.equal(h.view().stepInputPreview, null);
    assert.deepEqual(await h.controller.saveWorkflowStepInput(SID, { state: "review", input: before }), { ok: false, reason: "invalid" });

    // Edit while the change is being prepared: its answer, when it comes, is dropped.
    const read = h.controller.transport.readWorkflow;
    let release;
    const held = new Promise(resolve => { release = resolve; });
    h.controller.transport.readWorkflow = async (sessionId, options) => { if (options?.stepInput?.input) await held; return read(sessionId, options); };
    const pending = h.controller.previewWorkflowStepInput(SID, "review", before);
    assert.equal(h.view().stepInputPreview.phase, "loading");
    h.controller.forgetWorkflowStepInputPreview(SID);
    release();
    await pending;
    assert.equal(h.view().stepInputPreview, null);
    assert.deepEqual(await h.controller.saveWorkflowStepInput(SID, { state: "review", input: before }), { ok: false, reason: "invalid" });
    assert.equal(h.updates.length, 0);

    // Shown twice: only the later preparation's answer is kept, even when the earlier one arrives last.
    let releaseFirst;
    const first = new Promise(resolve => { releaseFirst = resolve; });
    h.controller.transport.readWorkflow = async (sessionId, options) => { if (options?.stepInput?.input === before) await first; return read(sessionId, options); };
    const slow = h.controller.previewWorkflowStepInput(SID, "review", before);
    await h.controller.previewWorkflowStepInput(SID, "review", after);
    releaseFirst();
    await slow;
    assert.equal(h.view().stepInputPreview.key, workflowV2StepInputKey(after));
    assert.equal((await h.controller.saveWorkflowStepInput(SID, { state: "review", input: after })).ok, true);
    assert.equal(h.updates.length, 1);
});

const render = props => renderToStaticMarkup(React.createElement(WorkflowV2StepInputEditor, { controller: {}, sessionId: SID, steps: ["review", "fix"],
    loaded: { state: "review", phase: "loaded", value: STEP_INPUT, error: null }, preview: null, draftRevision: 2, draftYaml: YAML, busy: false,
    unsaved: false, ...props }));

/** HTML-escaped attribute text as the value it stands for. */
const unescaped = value => value.replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/**
 * The first rendered `tag` element whose attributes include every `has` name and value, as { name: value } of all its
 * attributes (a boolean attribute is ""); null for none. Independent of the order React renders attributes in.
 */
function element(html, tag, has = {}) {
    for (const match of html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, "g"))) {
        const attributes = Object.fromEntries([...match[1].matchAll(/([a-zA-Z][\w:-]*)(?:="([^"]*)")?/g)].map(([, name, value]) => [name, unescaped(value ?? "")]));
        if (Object.entries(has).every(([name, value]) => attributes[name] === value)) return attributes;
    }
    return null;
}

/** The save button's disabled flag and title, wherever React puts them. */
const saveButton = html => {
    const button = element(html, "button", { "data-action": "save-step-input" });
    assert.ok(button, "the save button is rendered");
    return { disabled: Object.hasOwn(button, "disabled"), title: button.title };
};

test("the editor lists each field with where its value comes from; saving waits for the change, and never runs over unsaved YAML edits", () => {
    const html = render();
    assert.ok(element(html, "section", { class: "ps-workflow-step-input", "aria-label": "Step inputs", "data-state": "review" }), html);
    // The step picker: review chosen, then fix.
    assert.match(html, /<option[^>]*>review<\/option><option[^>]*>fix<\/option>/);
    assert.equal(element(html, "option", { value: "review" })?.selected, "");
    assert.equal(element(html, "option", { value: "fix" })?.selected, undefined);
    assert.match(html, /<tr data-input-field="pr"><td>pr \(required\) · string<div[^>]*>The pull request<\/div><\/td>/);
    // Where pr comes from: the choices in order, a run input chosen.
    const prSource = /<select\b[^>]*aria-label="Where pr comes from"[^>]*>(.*?)<\/select>/.exec(html)?.[1] ?? "";
    assert.match(prSource, /^<option[^>]*>Not set<\/option><option[^>]*>A run input<\/option>/);
    assert.equal(element(prSource, "option", { value: "run_input" })?.selected, "");
    // Which run input: one text box holding pr, with its placeholder.
    const prInput = element(html, "input", { "aria-label": "pr: run input name" });
    assert.ok(prInput, html);
    assert.deepEqual([prInput.type, prInput.value, prInput.placeholder], ["text", "pr", "run input name"]);
    // "As written in the YAML" is offered only for the field written that way, and shows what is written.
    assert.equal([...html.matchAll(/<option\b[^>]*\bvalue="keep"/g)].length, 1);
    assert.match(html, /<tr data-input-field="notes">.*<code>\$\{input\.notes \?\? &quot;none&quot;\}<\/code>/);
    assert.match(html, /Not set: depth \(required\)\. The step refuses to start without them\./);
    assert.deepEqual(saveButton(html), { disabled: true, title: "Show the change first." });
    assert.ok(!/contract|binding|candidate/i.test(html.replace(/data-[a-z-]+="[^"]*"/g, "")), "plain words only");

    // A change prepared from the fields as loaded (the key is what the editor's own request says).
    const preview = { state: "review", revision: 2, key: workflowV2StepInputKey(workflowV2StepInputRequest(workflowV2StepInputRows(STEP_INPUT)).input),
        phase: "loaded", error: null, value: { yaml: PROPOSED, changed: true, valid: true, diagnostics: [] } };
    const ready = render({ preview });
    assert.deepEqual(saveButton(ready), { disabled: false, title: "Save as a new revision after revision 2." });
    assert.match(ready, /Only the input lines of step &#x27;review&#x27; change\. Saving makes a new draft revision\./);
    assert.match(ready, /<div\b[^>]*data-kind="removed"[^>]*>- {7}pr: \$\{inputs\.pr\}<\/div><div\b[^>]*data-kind="added"[^>]*>\+ {7}pr: \$\{inputs\.repo\}<\/div>/);
    assert.deepEqual(saveButton(render({ preview, unsaved: true })), { disabled: true, title: "Save or discard your YAML edits first." });
    assert.deepEqual(saveButton(render({ preview, draftRevision: 3 })), { disabled: true, title: "The draft changed since this was prepared; show the change again." });
    assert.deepEqual(saveButton(render({ preview, busy: true })), { disabled: true, title: "Another command for this workflow is being sent." });
    // A change prepared from other fields (one has been changed since) is not shown, and cannot be saved.
    const otherFields = render({ preview: { ...preview, key: workflowV2StepInputKey({ pr: { source: "run_input", name: "repo" } }) } });
    assert.deepEqual(saveButton(otherFields), { disabled: true, title: "Show the change first." });
    assert.ok(!otherFields.includes("data-kind=\"added\"") && !otherFields.includes("Saving makes a new draft revision"), otherFields);

    // A step whose input is one value: choosing fields replaces it. A step that lists no fields: add each by name.
    const expression = render({ loaded: { state: "review", phase: "loaded", error: null,
        value: { ...STEP_INPUT, fields: [], schemaDeclared: false, inputShape: "expression", inputText: "\"${input}\"" } } });
    assert.match(expression, /This step&#x27;s input is written as one value \(&quot;\$\{input\}&quot;\)\. Choosing fields below replaces it\./);
    assert.match(expression, /This step does not list its input fields \(inputSchema\), so add each field by name\./);
    assert.ok(Object.hasOwn(element(expression, "button", { "data-action": "add-field" }) ?? {}, "disabled"), "nothing to add without a name");
    const failed = render({ loaded: { state: "review", phase: "failed", value: null, error: "Gateway timeout" } });
    assert.match(failed, /<p\b[^>]*role="alert"[^>]*>The step&#x27;s inputs could not be read: Gateway timeout<\/p>/);
});

// Batch 6 (r-3): the step-input editor is one of the draft's tools, in the side pane.
test("the draft tools offer step inputs only for a workflow with agent steps", () => {
    const states = [{ id: "review", type: "agent", invoke: { source: "prompt" }, outcomes: ["done"], next: { done: "end" } },
        { id: "end", type: "terminal", outcome: "succeeded" }];
    const draft = { state: "draft", currentRevision: 2, publishedRevision: null, publishedDefinitionHash: null };
    const modelOf = graph => ({ ...readModel({ definition: draft, revision: { revision: 2, definitionHash: "hash-2" }, noRun: true, graph }),
        personCommands: { operations: ["replace_definition"], restriction: null, run: null, draft: { revision: 2, definitionHash: "hash-2", yaml: YAML } } });
    const mount = model => {
        const store = createStore(appReducer, createInitialState({ mode: "api" }));
        store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", sessionKind: "workflow", title: "Watch" }] });
        store.dispatch({ type: "sessions/selected", sessionId: "wf" });
        store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: model, readModelRunId: null, sidePanel: "draft" } });
        return renderToStaticMarkup(React.createElement(WorkflowNodePane, { controller: new PilotSwarmUiController({ store, transport: {} }) }));
    };
    const withAgent = mount(modelOf({ revision: 2, initial: "review", states }));
    assert.ok(withAgent.includes("aria-label=\"Step inputs\""));
    assert.ok(element(withAgent, "option", { value: "review", selected: "" }), "the step picker shows review chosen");
    assert.ok(!mount(modelOf(undefined)).includes("aria-label=\"Step inputs\""), "no agent step, no step inputs");
});

// Adversarial review UI-4: out-of-order reads of the same step never replace a newer one.
test("UI-4: an earlier read of a step's inputs that answers last is dropped; closing drops a read on its way", async () => {
    const h = seeded();
    const pending = [];
    h.controller.transport.readWorkflow = (sessionId, options) => new Promise(resolve => {
        pending.push(value => resolve({ workflowId: sessionId, stepInput: { ...STEP_INPUT, state: options.stepInput.state, ...value } }));
    });
    const first = h.controller.loadWorkflowStepInput(SID, "review");
    const second = h.controller.loadWorkflowStepInput(SID, "review");
    pending[1]({ revision: 3 });
    await second;
    assert.equal(h.view().stepInput.value.revision, 3);
    pending[0]({ revision: 2 });
    await first;
    assert.equal(h.view().stepInput.value.revision, 3, "the earlier read answered last and was dropped");

    const third = h.controller.loadWorkflowStepInput(SID, "review");
    h.controller.closeWorkflowStepInput(SID);
    pending[2]({ revision: 4 });
    await third;
    assert.equal(h.view().stepInput, null, "closed: the read on its way was dropped");
});

// Verification of UI-4 (M-16): the editor's fields through reads of the same step, by the transitions the editor uses.
test("UI-4: changed fields survive a read of the same step (loading, then loaded or failed); the new reading waits", async () => {
    const { workflowV2StepInputEditorState: next, workflowV2StepInputEdited: edited, workflowV2StepInputLoadWaiting: loadWaiting } =
        await import("../src/workflow-v2-commands.js");
    const reading = revision => ({ ...STEP_INPUT, revision });
    const names = state => state.rows.map(row => row.name);
    let state = next(null, { step: "review", value: reading(2) });
    assert.equal(state.dirty, false);
    const firstNames = names(state);
    assert.ok(firstNames.length > 0);
    // The person changes a field.
    state = edited(state, rows => rows.map((row, index) => (index === 0 ? { ...row, source: "fixed", detail: "kept" } : row)));
    assert.equal(state.dirty, true);
    const changed = state.rows[0];
    // A newer draft revision is read: loading (no value), then the new reading.
    state = next(state, { step: "review", value: null });
    assert.deepEqual(state.rows[0], changed, "kept while loading");
    const newer = reading(3);
    state = next(state, { step: "review", value: newer });
    assert.deepEqual(state.rows[0], changed, "kept when the new reading arrives");
    assert.equal(state.waiting, newer);
    // A failed read (no value again) keeps them too.
    state = next(state, { step: "review", value: null });
    assert.deepEqual(state.rows[0], changed);
    // Loading the new reading replaces them, and the editor is clean again.
    state = loadWaiting(state);
    assert.equal(state.dirty, false);
    assert.equal(state.waiting, null);
    assert.notEqual(state.rows[0].detail, "kept");
});

test("UI-4: another step takes its own reading; back on the first step, its reading as it is (A-B-A)", async () => {
    const { workflowV2StepInputEditorState: next, workflowV2StepInputEdited: edited } = await import("../src/workflow-v2-commands.js");
    const a = { ...STEP_INPUT, state: "review", revision: 2 };
    const b = { ...STEP_INPUT, state: "draft_reply", revision: 2, fields: [] };
    let state = next(null, { step: "review", value: a });
    state = edited(state, rows => rows.map((row, index) => (index === 0 ? { ...row, detail: "changed on A" } : row)));
    state = next(state, { step: "draft_reply", value: null });
    assert.equal(state.step, "draft_reply");
    assert.equal(state.dirty, false);
    state = next(state, { step: "draft_reply", value: b });
    assert.equal(state.step, "draft_reply");
    state = next(state, { step: "review", value: a });
    assert.equal(state.step, "review");
    assert.notEqual(state.rows[0]?.detail, "changed on A");
});

test("UI-4: fields changed before the first reading arrives are kept, and that reading waits", async () => {
    const { workflowV2StepInputEditorState: next, workflowV2StepInputEdited: edited } = await import("../src/workflow-v2-commands.js");
    let state = next(null, { step: "review", value: null });
    state = edited(state, rows => [...rows, { name: "extra", required: false, declared: false, type: null, description: null, source: "fixed", detail: "1", keepable: false, keepText: null }]);
    const first = { ...STEP_INPUT, revision: 2 };
    state = next(state, { step: "review", value: first });
    assert.deepEqual(state.rows.map(row => row.name), ["extra"]);
    assert.equal(state.waiting, first);
    // The same reading again changes nothing.
    assert.equal(next(state, { step: "review", value: first }), state);
});
