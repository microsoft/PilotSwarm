// Script workflow sessions in the UI:
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
    entry: "collect",
    nodes: [
        { id: "collect", runtime: "python", next: { success: "report", failure: null } },
        { id: "report", runtime: "node", next: { done: null } },
    ],
});
const NODE_STARTED = event("workflow.node_started", { nodeId: "collect", runtime: "python", step: 1 });
const NODE_COMPLETED = event("workflow.node_completed", {
    nodeId: "collect", step: 1, outcome: "success", durationMs: 1250, exitCode: 0,
    toolCalls: [{ name: "read_facts", ok: true }, { name: "store_fact", ok: false }],
    outputPreview: "{\"count\":3}",
});
const COMPLETED = event("workflow.completed", { name: "nightly-report", steps: 2, outcome: "done", terminalNodeId: "report", outputPreview: "{\"rows\":3}" });
const FAILED = event("workflow.failed", { name: "nightly-report", steps: 1, terminalNodeId: "collect", error: "Script node 'collect' returned undeclared outcome 'odd'" });

test("each workflow event reads as one line of an execution log", () => {
    const started = formatWorkflowEventText(STARTED);
    assert.match(started, /Workflow \*\*nightly-report\*\* started: 2 nodes, entry `collect`/);
    assert.match(started, /\| collect \| python \| success → report, failure → end \|/);
    assert.match(started, /\| report \| node \| done → end \|/);

    assert.equal(formatWorkflowEventText(NODE_STARTED), "▶ Step 1: `collect` started (python).");
    const completed = formatWorkflowEventText(NODE_COMPLETED);
    assert.match(completed, /✓ Step 1: `collect` → \*\*success\*\* in 1\.3 s · 2 tool calls \(read_facts, store_fact\), 1 failed\./);
    assert.match(completed, /Output: `\{"count":3\}`/);

    assert.match(formatWorkflowEventText(COMPLETED), /completed after 2 steps with outcome \*\*done\*\* at `report`/);
    assert.match(formatWorkflowEventText(FAILED), /failed after 1 step at `collect`: Script node 'collect' returned undeclared outcome 'odd'/);
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
        "workflow.started", "workflow.node_started", "workflow.node_completed", "workflow.completed",
    ]);
    assert.ok(lines.every((item) => item.role === "system"));

    const appended = appendEventToHistory(buildHistoryModel([STARTED]), FAILED);
    assert.equal(appended.chat.at(-1).workflowEvent, "workflow.failed");
    assert.match(appended.chat.at(-1).text, /failed after 1 step/);
});

function makeController(transportOverrides = {}) {
    const sessions = [];
    const calls = { createScriptWorkflowSession: [] };
    const transport = {
        listSessions: async () => sessions,
        getSession: async (sessionId) => sessions.find((session) => session.sessionId === sessionId) || null,
        subscribeSession: () => () => {},
        createSession: async () => ({ sessionId: "generic-1", status: "idle" }),
        listCreatableAgents: async () => [{ name: "alpha", title: "Alpha" }],
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
        createScriptWorkflowSession: async (options) => {
            calls.createScriptWorkflowSession.push(options);
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
    assert.match(text, new RegExp(`${WORKFLOW_SESSION_GLYPH} Script workflow`));

    // Choosing it opens the editor, prefilled with a working example.
    store.dispatch({ type: "ui/modal", modal: { ...modal, selectedIndex: 1 } });
    await controller.handleCommand(UI_COMMANDS.MODAL_CONFIRM);
    const editor = selectWorkflowCreateModal(store.getState());
    assert.ok(editor);
    assert.equal(editor.yaml, WORKFLOW_YAML_TEMPLATE);
    assert.equal(editor.inputs, "{}");
});

test("a connection that cannot create workflows does not offer them", async () => {
    const { controller, store } = makeController({ createScriptWorkflowSession: undefined });
    await controller.openSessionAgentPicker();
    assert.ok(!store.getState().ui.modal.items.some((item) => item.kind === "workflow"));
    assert.equal(buildAgentPickerItems([], { query: "zzz", workflowItem: { id: "w", kind: "workflow", title: "Script workflow" } }).length, 0);
});

test("creating a workflow sends the YAML and parsed inputs, then opens the new session", async () => {
    const { controller, store, calls } = makeController();
    controller.openWorkflowCreateModal();
    const created = await controller.createScriptWorkflowSession({ yaml: WORKFLOW_YAML_TEMPLATE, inputs: "{\"keyPattern\":\"metrics/%\"}" });
    assert.equal(created.sessionId, "wf-1");
    assert.deepEqual(calls.createScriptWorkflowSession, [{ yaml: WORKFLOW_YAML_TEMPLATE, inputs: { keyPattern: "metrics/%" } }]);
    const state = store.getState();
    assert.equal(state.ui.modal, null);
    assert.equal(state.sessions.activeSessionId, "wf-1");
    assert.equal(state.sessions.byId["wf-1"].sessionKind, "workflow");
});

test("a refused workflow keeps the editor open with the reason and the text", async () => {
    const { controller, store, calls } = makeController({
        createScriptWorkflowSession: async () => { throw new Error("Invalid workflow: spec.nodes.a.type must be 'script'; agent nodes are not supported."); },
    });
    controller.openWorkflowCreateModal();

    await controller.createScriptWorkflowSession({ yaml: "kind: ScriptWorkflow", inputs: "[1]" });
    assert.match(selectWorkflowCreateModal(store.getState()).error, /Inputs must be a JSON object/);
    assert.equal(calls.createScriptWorkflowSession.length, 0);

    await controller.createScriptWorkflowSession({ yaml: "kind: ScriptWorkflow", inputs: "{" });
    assert.match(selectWorkflowCreateModal(store.getState()).error, /Inputs are not valid JSON/);

    await controller.createScriptWorkflowSession({ yaml: "my: yaml", inputs: "{}" });
    const editor = selectWorkflowCreateModal(store.getState());
    assert.match(editor.error, /agent nodes are not supported/);
    assert.equal(editor.yaml, "my: yaml");
    assert.equal(editor.busy, false);
});

test("a workflow session takes no steering and no regeneration", async () => {
    const { controller, store } = makeController({ regenerateSession: async () => { throw new Error("must not be called"); } });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf-1", title: "Workflow: x", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf-1" });
    assert.equal(selectTurnControlView(store.getState()).canSteer, false);
    await controller.regenerateActiveSession({ confirmed: true });
    assert.match(store.getState().ui.statusText || "", /Workflow sessions run a script graph/);
});
