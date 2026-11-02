// The TUI's workflow view (design 02 "Portal/TUI: graph, observed state, read-only child chats"; T115): `w` opens it
// outside the prompt (the prompt keeps typing w), the shared Ink app draws it from the shared view model, `?` lists it,
// and inside it p r s c send a person's run controls for the shown run and d dismisses their notice (INACTIVE: only a
// deployment that takes a person's workflow commands offers any).
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
import { WorkflowViewModal } from "../../ui/react/src/components.js";
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
        ["c", "WORKFLOW_VIEW_CANCEL_RUN"], ["d", "WORKFLOW_VIEW_DISMISS_NOTICE"]]) {
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
