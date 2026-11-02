// The TUI's workflow view (design 02 "Portal/TUI: graph, observed state, read-only child chats"; T115): `w` opens it
// outside the prompt (the prompt keeps typing w), the shared Ink app draws it from the shared view model, `?` lists it,
// and inside it p r s c send a person's run controls for the shown run, d dismisses their notice, v opens the shown
// run's variables form and e the draft editor (INACTIVE: only a deployment that takes a person's workflow commands
// offers any).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
    PilotSwarmUiController,
    UI_COMMANDS,
    appReducer,
    buildHistoryModel,
    createInitialState,
    createStore,
    selectHelpModal,
} from "pilotswarm/ui-core";
import { WorkflowDraftModal, WorkflowVariableModal, WorkflowViewModal } from "../../ui/react/src/components.js";
import { UiPlatformProvider } from "../../ui/react/src/platform.js";
import { readModel, row } from "../../ui/core/test/workflow-v2-fixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = fs.readFileSync(path.join(here, "..", "src", "app.js"), "utf8");

const states = [
    { id: "review", type: "agent", invoke: { source: "agent", name: "code-reviewer" }, timeoutSeconds: 600,
        outcomes: ["accepted"], next: { accepted: "done", timed_out: "failed" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const MODEL = readModel({ graph: { revision: 1, initial: "review", states }, revision: { name: "review-once" }, nodeExecutions: [
    row("review", 1, "pending", { agent: { childSessionId: "child-1", spawned: true, spawnAttempts: 1, end: null, endSent: false } }),
] });

function harness() {
    const calls = [];
    const transport = { readWorkflow: async (...args) => { calls.push(["readWorkflow", ...args]); return MODEL; } };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: review-once", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([{ sessionId: "wf", seq: 1, eventType: "workflow.started",
        data: { runId: "run-1", mode: "live", revision: 1, definitionHash: "hash-1", irSha256: "ir-1", name: "review-once", initial: "review", states },
        createdAt: new Date(Date.UTC(2026, 10, 2)) }]) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: MODEL, readModelRunId: null } });
    return { controller, store, calls };
}

const platform = {
    getViewport: () => ({ width: 120, height: 40 }),
    Overlay: ({ children }) => React.createElement("div", { "data-kind": "overlay" }, children),
    Column: ({ children }) => React.createElement("div", null, children),
    Panel: ({ title, lines }) => React.createElement("section", { "data-title": title },
        lines.map((line, i) => React.createElement("p", { key: i }, Array.isArray(line) ? line.map(run => run.text).join("") : line.text))),
};
const render = state => renderToStaticMarkup(React.createElement(UiPlatformProvider, { platform },
    React.createElement(WorkflowViewModal, { state })));

test("w opens the workflow view outside the prompt; the prompt and the admin console keep their own keys", () => {
    const binding = APP.indexOf('if (plainShortcut && input === "w") {');
    assert.ok(binding > 0, "the binding exists");
    assert.match(APP.slice(binding, binding + 200), /controller\.handleCommand\(UI_COMMANDS\.OPEN_WORKFLOW_VIEW\)/);
    // The prompt inserts what is typed and returns before it; the admin console swallows its keys before it.
    const promptInsert = APP.indexOf("controller.insertPromptText(input);");
    assert.ok(promptInsert > 0 && promptInsert < binding);
    assert.ok(APP.indexOf('input === "w" && adminSection !== "workers"') < binding);
    // An open modal takes its own keys first (Esc, Tab, Enter, ↑↓): the view does not reopen itself.
    assert.ok(APP.indexOf("if (modal) {") < binding);
});

test("the shared Ink app draws the view: the states, the selected one's details and its agent chat", async () => {
    const { controller, store, calls } = harness();
    assert.equal(render(store.getState()), "", "nothing is drawn while the view is closed");
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    const html = render(store.getState());
    assert.match(html, /data-title="Workflow: review-once · Running"/);
    assert.match(html, /▶ ● review\s+agent · code-reviewer\s+Agent working · waiting for its typed result/);
    assert.match(html, /○ done\s+ends · succeeded/);
    assert.match(html, /data-title="State review — ↑↓ state · ←→ run · Tab agent chat · Enter open · Esc close"/);
    assert.match(html, /  accepted → done/);
    assert.match(html, /▸ visit 1 · working · child-1/);
    assert.match(html, /People can read these chats; the server refuses their prompts, answers and steers\./);
    assert.deepEqual(calls.map(call => call[0]), ["readWorkflow"], "it reads the workflow and nothing else");
});

test("the help lists the workflow view", async () => {
    const { controller, store } = harness();
    // selectHelpModal answers only while the help is open (the r2 run at 02ae7510 read it closed, so it was null).
    await controller.handleCommand(UI_COMMANDS.OPEN_HELP);
    const help = selectHelpModal(store.getState(), 120);
    assert.ok(help, "the help is open");
    const text = JSON.stringify(help);
    assert.match(text, /workflow session: workflow view/);
    assert.match(text, /←→ run/);
    assert.match(text, /PgUp\/PgDn details/);
    assert.match(text, /p r s c  d/);
    assert.match(text, /workflow view: pause \/ resume \/ stop \/ cancel the shown run/);
    assert.match(text, /stop and cancel ask first/);
    assert.match(text, /workflow view: the shown run's variables/);
    assert.match(text, /ctrl-r remove/);
    assert.match(text, /workflow view: edit the draft's YAML/);
    assert.match(text, /ctrl-o save as a new revision/);
    assert.match(text, /ctrl-k keep edits on a newer revision/);
});

test("the variables form takes typed text, q included; Tab, ↑↓, Enter, ctrl-r and Esc are its own keys", () => {
    // The quit key does not fire while the form is open (q is part of a name or a value there).
    assert.match(APP, /const typingInForm = modal\?\.type === "workflowVariable" \|\| modal\?\.type === "workflowDraft";/);
    assert.match(APP, /if \(focus !== "prompt" && !typingInForm && input === "q" && quitStateRef\.current\.armedUntil > Date\.now\(\)\) \{/);
    assert.match(APP, /if \(focus !== "prompt" && !typingInForm && input === "q"\) \{/);
    const modalBranch = APP.indexOf("if (modal) {");
    const form = APP.indexOf('if (modal.type === "workflowVariable") {');
    assert.ok(modalBranch > 0 && modalBranch < form, "inside the modal branch");
    assert.ok(APP.indexOf('if (modal.type === "confirm") {', modalBranch) < form, "after the confirm dialog's keys");
    assert.ok(form < APP.indexOf('modal.type === "renameSession" || modal.type === "artifactUpload"'), "before the other text modals");
    assert.ok(form < APP.indexOf('if (key.escape || input === "q" ||'), "before q closes a modal");
    const branch = APP.slice(form, APP.indexOf('if (modal.type === "renameSession" || modal.type === "artifactUpload"'));
    for (const binding of [/key\.escape[\s\S]*?UI_COMMANDS\.CLOSE_MODAL/, /key\.return[\s\S]*?UI_COMMANDS\.MODAL_CONFIRM/,
        /matchesCtrlKey\("r", "\\u0012"\)[\s\S]*?UI_COMMANDS\.WORKFLOW_VARIABLE_REMOVE/, /key\.tab[\s\S]*?controller\.switchWorkflowVariableField\(\)/,
        /UI_COMMANDS\.MODAL_PREV : UI_COMMANDS\.MODAL_NEXT/, /controller\.moveWorkflowVariableCursor\(key\.leftArrow \? -1 : 1\)/,
        /controller\.moveWorkflowVariableCursorToBoundary/, /controller\.deleteWorkflowVariableChar\(\)/,
        /if \(!key\.ctrl && !key\.meta && input\) controller\.insertWorkflowVariableText\(input\);/]) {
        assert.match(branch, binding);
    }
});

test("the shared Ink app draws the variables form: the variables, the revision and its two fields", async () => {
    const withVars = { ...MODEL, run: { ...MODEL.run, kvRevision: 3, kv: JSON.stringify({ a: 1, "b c": "x" }) },
        personCommands: { operations: ["set_vars", "pause", "resume", "stop", "cancel"], restriction: null, run: { runId: "run-1", stop: true } } };
    const calls = [];
    const transport = { readWorkflow: async (...args) => { calls.push(["readWorkflow", ...args]); return withVars; } };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: review-once", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: withVars, readModelRunId: null } });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_VARIABLES);
    controller.insertWorkflowVariableText("limit");
    const inputs = [];
    const formPlatform = { ...platform, Input: ({ label, value, focused }) => { inputs.push({ label, value, focused });
        return React.createElement("label", { "data-focused": String(focused) }, `${label}: ${value}`); } };
    const html = renderToStaticMarkup(React.createElement(UiPlatformProvider, { platform: formPlatform },
        React.createElement(WorkflowVariableModal, { state: store.getState() })));
    assert.match(html, /data-title="Variables · run run-1 · revision 3"/);
    assert.match(html, /  a = 1/);
    assert.match(html, /  b c = &quot;x&quot;/);
    assert.deepEqual(inputs.map(input => [input.label, input.value, input.focused]), [["name", "limit", true], ["value (JSON)", "", false]]);
    assert.match(html, /Enter set · ctrl-r remove \(asks first\) · Esc back to the view/);
    assert.deepEqual(calls.map(call => call[0]).filter(name => name !== "readWorkflow"), [], "it reads and sends nothing");
});

test("the draft editor takes typed text, q included; ctrl-o, ctrl-r, ctrl-k, Enter, Tab, the cursor keys and Esc are its own keys", () => {
    // The quit key does not fire while the editor is open (q is YAML there).
    assert.match(APP, /const typingInForm = modal\?\.type === "workflowVariable" \|\| modal\?\.type === "workflowDraft";/);
    const modalBranch = APP.indexOf("if (modal) {");
    const editor = APP.indexOf('if (modal.type === "workflowDraft") {');
    assert.ok(modalBranch > 0 && modalBranch < editor, "inside the modal branch");
    assert.ok(APP.indexOf('if (modal.type === "confirm") {', modalBranch) < editor, "after the confirm dialog's keys");
    assert.ok(editor < APP.indexOf('modal.type === "renameSession" || modal.type === "artifactUpload"'), "before the other text modals");
    assert.ok(editor < APP.indexOf('if (key.escape || input === "q" ||'), "before q closes a modal");
    const branch = APP.slice(editor, APP.indexOf('if (modal.type === "workflowVariable") {'));
    for (const binding of [/key\.escape[\s\S]*?UI_COMMANDS\.CLOSE_MODAL/,
        /matchesCtrlKey\("o", "\\u000f"\)[\s\S]*?UI_COMMANDS\.WORKFLOW_DRAFT_SAVE/,
        /matchesCtrlKey\("r", "\\u0012"\)[\s\S]*?UI_COMMANDS\.WORKFLOW_DRAFT_DISCARD/,
        /matchesCtrlKey\("k", "\\u000b"\)[\s\S]*?UI_COMMANDS\.WORKFLOW_DRAFT_KEEP/,
        /key\.return[\s\S]*?controller\.editWorkflowDraft\(\{ type: "insert", text: "\\n" \}\)/,
        /key\.tab[\s\S]*?controller\.editWorkflowDraft\(\{ type: "insert", text: "  " \}\)/,
        /lines: key\.upArrow \? -1 : key\.downArrow \? 1 : key\.pageUp \? -10 : 10/,
        /controller\.editWorkflowDraft\(\{ type: "move", chars: key\.leftArrow \? -1 : 1 \}\)/,
        /controller\.editWorkflowDraft\(\{ type: "edge", edge: key\.home \? "start" : "end" \}\)/,
        /key\.backspace \|\| key\.delete[\s\S]*?controller\.editWorkflowDraft\(\{ type: "backspace" \}\)/,
        /if \(!key\.ctrl && !key\.meta && input\) controller\.editWorkflowDraft\(\{ type: "insert", text: input \}\);/]) {
        assert.match(branch, binding);
    }
    for (const command of ["WORKFLOW_VIEW_EDIT_DRAFT", "WORKFLOW_DRAFT_SAVE", "WORKFLOW_DRAFT_DISCARD", "WORKFLOW_DRAFT_KEEP"]) {
        assert.equal(typeof UI_COMMANDS[command], "string", command);
    }
});

test("the shared Ink app draws the draft editor: the revision, the YAML with line numbers and the cursor, what the edit is and its keys", async () => {
    const yaml = "apiVersion: pilotswarm.dev/v2-draft\nkind: Workflow\n";
    const withDraft = { ...readModel({ noRun: true, graph: { revision: 2, initial: "review", states },
        definition: { state: "draft", currentRevision: 2, publishedRevision: null, publishedDefinitionHash: null },
        revision: { revision: 2, definitionHash: "hash-2", name: "review-once" } }),
    personCommands: { operations: ["replace_definition", "publish", "set_vars", "pause", "resume", "stop", "cancel"], restriction: null, run: null,
        draft: { revision: 2, definitionHash: "hash-2", yaml } } };
    const calls = [];
    const transport = { readWorkflow: async (...args) => { calls.push(["readWorkflow", ...args]); return withDraft; } };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: review-once", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([]) });
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: withDraft, readModelRunId: null } });
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_EDIT_DRAFT);
    controller.editWorkflowDraft({ type: "move", lines: 1 });
    controller.editWorkflowDraft({ type: "insert", text: "# " });
    const html = renderToStaticMarkup(React.createElement(UiPlatformProvider, { platform },
        React.createElement(WorkflowDraftModal, { state: store.getState() })));
    assert.match(html, /data-title="Draft · editing revision 2 · version 1\.0\.0 \(it cannot change\) · line 2, column 3"/);
    assert.match(html, /<p>1 apiVersion: pilotswarm\.dev\/v2-draft<\/p>/);
    assert.match(html, /<p>2 # kind: Workflow<\/p>/);
    assert.match(html, /<p>3 <\/p>/, "the empty line after the last newline");
    assert.match(html, /data-title="Draft"><p>Unsaved edits\. ctrl-o saves them as a new revision after revision 2\.<\/p>/);
    assert.match(html, /data-title="Keys"><p>ctrl-o save · ctrl-r discard edits \(asks first\) · Enter new line · Tab two spaces · Esc close \(edits kept\)<\/p>/);
    assert.deepEqual(calls.map(call => call[0]).filter(name => name !== "readWorkflow"), [], "it reads and sends nothing");
});

test("p r s c in the open workflow view send its run controls and d dismisses their notice; elsewhere the keys keep their meaning", () => {
    const binding = APP.indexOf('if (modal.type === "workflowView" && plainShortcut && Object.hasOwn(WORKFLOW_VIEW_RUN_KEYS, input)) {');
    assert.ok(binding > 0, "the binding exists");
    assert.match(APP.slice(binding, binding + 200), /controller\.handleCommand\(WORKFLOW_VIEW_RUN_KEYS\[input\]\)/);
    // Inside the modal branch, after the confirm dialog's own keys (y, n, Enter, Esc) and before every global shortcut.
    const modalBranch = APP.indexOf("if (modal) {");
    assert.ok(modalBranch > 0 && modalBranch < binding);
    assert.ok(APP.indexOf('if (modal.type === "confirm") {', modalBranch) < binding);
    assert.ok(binding < APP.indexOf('if (plainShortcut && input === "w") {'));
    assert.ok(binding < APP.indexOf('if (plainShortcut && input === "c") {'), "c cancels the session only outside the view");
    const keys = APP.slice(APP.indexOf("const WORKFLOW_VIEW_RUN_KEYS"), APP.indexOf("});", APP.indexOf("const WORKFLOW_VIEW_RUN_KEYS")));
    for (const [key, command] of [["p", "WORKFLOW_VIEW_PAUSE_RUN"], ["r", "WORKFLOW_VIEW_RESUME_RUN"], ["s", "WORKFLOW_VIEW_STOP_RUN"],
        ["c", "WORKFLOW_VIEW_CANCEL_RUN"], ["d", "WORKFLOW_VIEW_DISMISS_NOTICE"], ["v", "WORKFLOW_VIEW_EDIT_VARIABLES"],
        ["e", "WORKFLOW_VIEW_EDIT_DRAFT"]]) {
        assert.match(keys, new RegExp(`${key}: UI_COMMANDS\\.${command},`), key);
        assert.equal(typeof UI_COMMANDS[command], "string", command);
    }
});

test("← → in the open workflow view choose its run; elsewhere they keep their meaning", () => {
    const binding = APP.indexOf('if (modal.type === "workflowView" && (key.leftArrow || key.rightArrow)) {');
    assert.ok(binding > 0, "the binding exists");
    assert.match(APP.slice(binding, binding + 260),
        /key\.leftArrow \? UI_COMMANDS\.WORKFLOW_VIEW_PREV_RUN : UI_COMMANDS\.WORKFLOW_VIEW_NEXT_RUN/);
    // Inside the modal branch, after the text-input modals (whose arrows move a cursor) and before the pane keys.
    const modalBranch = APP.indexOf("if (modal) {");
    assert.ok(modalBranch > 0 && modalBranch < binding);
    assert.ok(APP.indexOf('modal.type === "renameSession" || modal.type === "artifactUpload"') < binding);
    assert.ok(binding < APP.indexOf('if (plainShortcut && input === "w") {'));
});

test("PgUp/PgDn (ctrl-u/ctrl-d) in the open workflow view scroll its details", () => {
    const binding = APP.indexOf('if (modal.type === "workflowView" && (key.pageUp || key.pageDown || isCtrlU || isCtrlD)) {');
    assert.ok(binding > 0, "the binding exists");
    assert.match(APP.slice(binding, binding + 260),
        /key\.pageUp \|\| isCtrlU \? UI_COMMANDS\.WORKFLOW_VIEW_DETAILS_UP : UI_COMMANDS\.WORKFLOW_VIEW_DETAILS_DOWN/);
    assert.ok(APP.indexOf("if (modal) {") < binding && binding < APP.indexOf('if (plainShortcut && input === "w") {'));
});
