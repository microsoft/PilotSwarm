// Workflow sessions in the UI:
//   - the session list marks them apart from agent sessions
//   - their transcript is an execution log built from workflow.* events
//   - they are created from the same chooser as agent sessions
//   - they never take chat input or a regeneration
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    appendEventToHistory,
    buildAgentPickerItems,
    buildHistoryModel,
    describeWorkflowEvent,
    CHAT_HISTORY_EVENT_TYPES,
    createInitialState,
    createStore,
    formatWorkflowEventText,
    selectSessionAgentPickerModal,
    selectSessionRows,
    selectTurnControlView,
    selectWorkflowCreateModal,
    UI_COMMANDS,
    WORKFLOW_EVENT_TYPES,
    WORKFLOW_SESSION_GLYPH,
    WORKFLOW_YAML_TEMPLATE,
} from "../src/index.js";

let seq = 0;
function event(eventType, data) {
    seq += 1;
    return { sessionId: "wf", seq, eventType, data, createdAt: new Date(Date.UTC(2026, 9, 29, 12, 0, seq)) };
}

const STARTED = event("workflow.started", {
    name: "nightly-report",
    version: "1.0.0",
    initial: "collect",
    states: [
        { id: "collect", type: "script", runtime: "python", next: { success: "report", failure: "failed" } },
        { id: "report", type: "script", runtime: "node", next: { done: "published" } },
        { id: "published", type: "terminal", outcome: "succeeded" },
        { id: "failed", type: "terminal", outcome: "failed" },
    ],
});
const NODE_STARTED = event("workflow.state_started", { stateId: "collect", runtime: "python", step: 1 });
const NODE_COMPLETED = event("workflow.state_completed", {
    stateId: "collect", step: 1, outcome: "success", durationMs: 1250, exitCode: 0,
    toolCalls: [{ name: "read_facts", ok: true }, { name: "store_fact", ok: false }],
    outputPreview: "{\"count\":3}",
});
const COMPLETED = event("workflow.completed", { name: "nightly-report", steps: 2, stateId: "published", outcome: "succeeded", summary: "Report published.", outputPreview: "{\"rows\":3}" });
const FAILED = event("workflow.failed", { name: "nightly-report", steps: 1, stateId: "collect", error: "Script state 'collect' returned undeclared outcome 'odd'" });

test("each workflow event reads as one line of an execution log", () => {
    const started = formatWorkflowEventText(STARTED);
    assert.match(started, /Workflow \*\*nightly-report\*\* 1\.0\.0 started: 4 states, initial `collect`/);
    assert.match(started, /\| collect \| script \(python\) \| success → report, failure → failed \|/);
    assert.match(started, /\| report \| script \(node\) \| done → published \|/);
    assert.match(started, /\| published \| terminal \| ends: succeeded \|/);

    assert.equal(formatWorkflowEventText(NODE_STARTED), "▶ Step 1: `collect` started (python).");
    const completed = formatWorkflowEventText(NODE_COMPLETED);
    assert.match(completed, /✓ Step 1: `collect` → \*\*success\*\* in 1\.3 s · 2 tool calls \(read_facts, store_fact\), 1 failed\./);
    assert.match(completed, /Output: `\{"count":3\}`/);

    assert.match(formatWorkflowEventText(COMPLETED), /reached `published` after 2 steps: outcome \*\*succeeded\*\*\. Report published\./);
    assert.match(formatWorkflowEventText(FAILED), /failed after 1 step at `collect`: Script state 'collect' returned undeclared outcome 'odd'/);
    const authoredFailure = event("workflow.failed", { name: "nightly-report", steps: 1, stateId: "failed", outcome: "failed", summary: "Could not read facts." });
    assert.match(formatWorkflowEventText(authoredFailure), /reached `failed` after 1 step: outcome \*\*failed\*\*\. Could not read facts\./);
    assert.equal(formatWorkflowEventText({ eventType: "assistant.message", data: {} }), null);
});

test("the graph and the result are cards; each step is a one-line notice", () => {
    assert.deepEqual(
        [STARTED, COMPLETED, FAILED].map((e) => [describeWorkflowEvent(e).kind, describeWorkflowEvent(e).title]),
        [["card", "Workflow"], ["card", "Workflow result"], ["card", "Workflow failed"]],
    );
    const step = describeWorkflowEvent(NODE_COMPLETED);
    assert.equal(step.kind, "notice");
    assert.equal(step.title, `${WORKFLOW_SESSION_GLYPH} Step 1`);
    assert.equal(step.summary, "collect → success in 1.3 s · 2 tool calls (read_facts, store_fact), 1 failed");
    assert.doesNotMatch(step.summary, /[*`]/, "a one-line summary is plain text");
    assert.match(step.text, /Output:/);
    const history = buildHistoryModel([STARTED, NODE_COMPLETED]);
    assert.equal(history.chat[0].cardTitle, "Workflow");
    assert.equal(history.chat[1].workflowNotice.summary, step.summary);
});

test("the transcript of a workflow session is its execution log, in order, and survives history paging", () => {
    for (const type of WORKFLOW_EVENT_TYPES) assert.ok(CHAT_HISTORY_EVENT_TYPES.includes(type), type);

    const history = buildHistoryModel([STARTED, NODE_STARTED, NODE_COMPLETED, COMPLETED]);
    const lines = history.chat.filter((item) => item.workflowEvent);
    assert.deepEqual(lines.map((item) => item.workflowEvent), [
        "workflow.started", "workflow.state_started", "workflow.state_completed", "workflow.completed",
    ]);
    assert.ok(lines.every((item) => item.role === "system"));

    const appended = appendEventToHistory(buildHistoryModel([STARTED]), FAILED);
    assert.equal(appended.chat.at(-1).workflowEvent, "workflow.failed");
    assert.match(appended.chat.at(-1).text, /failed after 1 step/);
});

function makeController(transportOverrides = {}) {
    const sessions = [];
    const calls = { createWorkflowSession: [] };
    const transport = {
        listSessions: async () => sessions,
        getSession: async (sessionId) => sessions.find((session) => session.sessionId === sessionId) || null,
        subscribeSession: () => () => {},
        createSession: async () => ({ sessionId: "generic-1", status: "idle" }),
        listCreatableAgents: async () => [{ name: "alpha", title: "Alpha" }],
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
        createWorkflowSession: async (options) => {
            calls.createWorkflowSession.push(options);
            const session = { sessionId: "wf-1", sessionKind: "workflow", title: "Workflow: example-workflow", status: "running" };
            sessions.push(session);
            return { sessionId: "wf-1", sessionKind: "workflow", workflowName: "example-workflow" };
        },
        ...transportOverrides,
    };
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, store, calls, transport };
}

test("the session list marks workflow sessions apart from agent sessions", () => {
    const { store } = makeController();
    store.dispatch({
        type: "sessions/loaded",
        sessions: [
            { sessionId: "agent-1", title: "Agent", status: "idle" },
            { sessionId: "wf-1", title: "Workflow: nightly-report", status: "running", sessionKind: "workflow" },
        ],
    });
    const rows = selectSessionRows(store.getState());
    const workflow = rows.find((row) => row.sessionId === "wf-1");
    const agent = rows.find((row) => row.sessionId === "agent-1");
    const kindRun = (row) => (row.titleRuns || row.runs || []).find((run) => run?.role === "sessionKind");
    assert.equal(kindRun(workflow)?.text, `${WORKFLOW_SESSION_GLYPH} `);
    assert.equal(workflow.chrome?.kind, "workflow");
    assert.equal(kindRun(agent), undefined);
    assert.equal(agent.chrome?.kind, "session");
});

test("the agent chooser offers a script workflow beside the generic session", async () => {
    const { controller, store } = makeController();
    await controller.openSessionAgentPicker();
    const modal = store.getState().ui.modal;
    assert.equal(modal.type, "sessionAgentPicker");
    assert.deepEqual(modal.items.slice(0, 2).map((item) => item.kind), ["generic", "workflow"]);
    const view = selectSessionAgentPickerModal(store.getState());
    const workflowRow = view.rows[1];
    const text = (Array.isArray(workflowRow) ? workflowRow : [workflowRow]).map((run) => run.text).join("");
    assert.match(text, new RegExp(`${WORKFLOW_SESSION_GLYPH} Workflow`));

    // Choosing it opens the editor, prefilled with a working example.
    store.dispatch({ type: "ui/modal", modal: { ...modal, selectedIndex: 1 } });
    await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const editor = selectWorkflowCreateModal(store.getState());
    assert.ok(editor);
    assert.equal(editor.yaml, WORKFLOW_YAML_TEMPLATE);
    assert.equal(editor.inputs, "{}");
});

test("a connection that cannot create workflows does not offer them", async () => {
    const { controller, store } = makeController({ createWorkflowSession: undefined });
    await controller.openSessionAgentPicker();
    assert.ok(!store.getState().ui.modal.items.some((item) => item.kind === "workflow"));
    assert.equal(buildAgentPickerItems([], { query: "zzz", workflowItem: { id: "w", kind: "workflow", title: "Workflow" } }).length, 0);
});

test("creating a workflow sends the YAML and parsed inputs, then opens the new session", async () => {
    const { controller, store, calls } = makeController();
    controller.openWorkflowCreateModal();
    const created = await controller.createWorkflowSession({ yaml: WORKFLOW_YAML_TEMPLATE, inputs: "{\"keyPattern\":\"metrics/%\"}" });
    assert.equal(created.sessionId, "wf-1");
    assert.deepEqual(calls.createWorkflowSession, [{ yaml: WORKFLOW_YAML_TEMPLATE, inputs: { keyPattern: "metrics/%" } }]);
    const state = store.getState();
    assert.equal(state.ui.modal, null);
    assert.equal(state.sessions.activeSessionId, "wf-1");
    assert.equal(state.sessions.byId["wf-1"].sessionKind, "workflow");
});

test("a refused workflow keeps the editor open with the reason and the text", async () => {
    const { controller, store, calls } = makeController({
        createWorkflowSession: async () => { throw new Error("Invalid workflow: states.a.type 'agent' is not supported yet; this version runs script and terminal states."); },
    });
    controller.openWorkflowCreateModal();

    await controller.createWorkflowSession({ yaml: "kind: Workflow", inputs: "[1]" });
    assert.match(selectWorkflowCreateModal(store.getState()).error, /Inputs must be a JSON object/);
    assert.equal(calls.createWorkflowSession.length, 0);

    await controller.createWorkflowSession({ yaml: "kind: Workflow", inputs: "{" });
    assert.match(selectWorkflowCreateModal(store.getState()).error, /Inputs are not valid JSON/);

    await controller.createWorkflowSession({ yaml: "my: yaml", inputs: "{}" });
    const editor = selectWorkflowCreateModal(store.getState());
    assert.match(editor.error, /type 'agent' is not supported yet/);
    assert.equal(editor.yaml, "my: yaml");
    assert.equal(editor.busy, false);
});

test("a workflow session takes no steering and no regeneration", async () => {
    const { controller, store } = makeController({ regenerateSession: async () => { throw new Error("must not be called"); } });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf-1", title: "Workflow: x", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf-1" });
    assert.equal(selectTurnControlView(store.getState()).canSteer, false);
    await controller.regenerateActiveSession({ confirmed: true });
    assert.match(store.getState().ui.statusText || "", /Workflow sessions run a workflow graph/);
});

test("a stopped run reads as stopped, in the log and as cards", () => {
    const stoppedNode = event("workflow.state_cancelled", { stateId: "collect", step: 1, durationMs: 2500 });
    const stopped = event("workflow.cancelled", { name: "nightly-report", steps: 1, stateId: "collect", reason: "no longer needed" });
    assert.equal(formatWorkflowEventText(stoppedNode), "⏹ Step 1: `collect` stopped after 2.5 s.");
    assert.equal(describeWorkflowEvent(stoppedNode).summary, "collect stopped after 2.5 s");
    assert.match(formatWorkflowEventText(stopped), /stopped after 1 step at `collect`: no longer needed/);
    assert.deepEqual([describeWorkflowEvent(stopped).kind, describeWorkflowEvent(stopped).title], ["card", "Workflow stopped"]);
    assert.ok(CHAT_HISTORY_EVENT_TYPES.includes("workflow.cancelled"));
});

test("opening a workflow session shows its canvas; an agent session's canvas stays where the person left it", async () => {
    const canvasEvent = { seq: 1, eventType: "session.canvas_updated", data: { rev: 1, slot: 1, name: "Workflow" } };
    const { controller, store } = makeController({
        getSessionEventsBefore: async (_id, _before, _limit, types) => (types.includes("session.canvas_updated") ? [canvasEvent] : []),
    });
    store.dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: "wf-1", title: "Workflow: x", status: "running", sessionKind: "workflow" },
        { sessionId: "agent-1", title: "Agent", status: "idle" },
    ] });
    store.dispatch({ type: "sessions/selected", sessionId: "agent-1" });
    await controller.ensureCanvasSnapshot("agent-1");
    assert.notEqual(store.getState().ui.rightPaneMode, "canvas");

    store.dispatch({ type: "sessions/selected", sessionId: "wf-1" });
    await controller.ensureCanvasSnapshot("wf-1");
    assert.equal(store.getState().ui.rightPaneMode, "canvas");
    assert.equal(store.getState().ui.canvasOpen, true);
});

