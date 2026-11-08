// Workflow sessions in the UI:
//   - the session list marks them apart from agent sessions
//   - their transcript is an execution log built from workflow.* events
//   - an agent starts them; the new-session chooser offers no workflow start
//   - they never take chat input or a regeneration
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    appReducer,
    appendEventToHistory,
    buildHistoryModel,
    describeWorkflowEvent,
    CHAT_HISTORY_EVENT_TYPES,
    createInitialState,
    createStore,
    formatWorkflowEventText,
    selectSessionAgentPickerModal,
    selectSessionRows,
    selectTurnControlView,
    WORKFLOW_EVENT_TYPES,
    WORKFLOW_SESSION_GLYPH,
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
    // Review 19:27Z (rows 28 to 30): nodes and visits, the graph's labels, the marks of the words module, no parentheses.
    assert.match(started, /Workflow \*\*nightly-report\*\* 1\.0\.0 started · 4 nodes · starts at `collect`/);
    assert.match(started, /\| Node \| Type \| Outcome → next \|/);
    assert.match(started, /\| collect \| Script \| success → report, failure → failed \|/);
    assert.match(started, /\| report \| Script \| done → published \|/);
    assert.match(started, /\| published \| End \| End · succeeded \|/);

    assert.equal(formatWorkflowEventText(NODE_STARTED), "● `collect` · #1 started.");
    const completed = formatWorkflowEventText(NODE_COMPLETED);
    assert.match(completed, /✓ `collect` · #1 → \*\*success\*\* in 1 s · 2 tool calls · read_facts, store_fact · 1 failed\./);
    assert.match(completed, /Output: `\{"count":3\}`/);

    assert.match(formatWorkflowEventText(COMPLETED), /^✓ Workflow \*\*nightly-report\*\* reached `published` after 2 visits: outcome \*\*succeeded\*\*\. Report published\./);
    assert.match(formatWorkflowEventText(FAILED), /^✕ Workflow \*\*nightly-report\*\* failed after 1 visit at `collect`: Script state 'collect' returned undeclared outcome 'odd'/);
    const authoredFailure = event("workflow.failed", { name: "nightly-report", steps: 1, stateId: "failed", outcome: "failed", summary: "Could not read facts." });
    assert.match(formatWorkflowEventText(authoredFailure), /^✕ Workflow \*\*nightly-report\*\* reached `failed` after 1 visit: outcome \*\*failed\*\*\. Could not read facts\./);
    assert.equal(formatWorkflowEventText({ eventType: "assistant.message", data: {} }), null);
});

test("the definition is expandable, the result a card, and step errors remain visible", () => {
    assert.deepEqual(
        [STARTED, COMPLETED, FAILED].map((e) => [describeWorkflowEvent(e).kind, describeWorkflowEvent(e).title]),
        [["notice", "Workflow"], ["card", "Workflow result"], ["card", "Workflow failed"]],
    );
    const step = describeWorkflowEvent(NODE_COMPLETED);
    assert.equal(step.kind, "notice");
    assert.equal(step.title, `${WORKFLOW_SESSION_GLYPH} Node · #1`);
    assert.equal(step.summary, "collect → success in 1 s · 2 tool calls · read_facts, store_fact · 1 failed");
    assert.doesNotMatch(step.summary, /[*`]/, "a one-line summary is plain text");
    assert.match(step.text, /Output:/);
    const history = buildHistoryModel([STARTED, NODE_COMPLETED]);
    assert.equal(history.chat[0].workflowNotice.title, "Workflow");
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
    assert.match(appended.chat.at(-1).text, /failed after 1 visit /);
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
    const store = createStore(appReducer, createInitialState({ workflowsEnabled: true }));
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

test("the new-session chooser offers no workflow start: an agent starts workflows (flow-05)", async () => {
    const { controller, store, calls } = makeController();
    await controller.openSessionAgentPicker();
    const modal = store.getState().ui.modal;
    assert.equal(modal.type, "sessionAgentPicker");
    assert.equal(modal.items[0].kind, "generic");
    assert.ok(!modal.items.some((item) => item.kind === "workflow"), JSON.stringify(modal.items.map((item) => item.kind)));
    const text = selectSessionAgentPickerModal(store.getState()).rows.flat().map((run) => run?.text ?? "").join("");
    assert.doesNotMatch(text, /Workflow|spawn_workflow/);
    // The dead-end editor and its refusal are gone.
    assert.equal(typeof controller.openWorkflowCreateModal, "undefined");
    assert.equal(typeof controller.createWorkflowSession, "undefined");
    assert.deepEqual(calls.createWorkflowSession, []);
});

test("a workflow session takes no steering and no regeneration", async () => {
    const { controller, store } = makeController({ regenerateSession: async () => { throw new Error("must not be called"); } });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf-1", title: "Workflow: x", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf-1" });
    assert.equal(selectTurnControlView(store.getState()).canSteer, false);
    await controller.regenerateActiveSession({ confirmed: true });
    assert.match(store.getState().ui.statusText || "", /Workflow sessions run a workflow graph/);
});

// Review 19:27Z (row 30): a stop reads Canceled, with ⊘; a node's executions are visits.
test("a stopped run reads as canceled, in the log and as cards", () => {
    const stoppedNode = event("workflow.state_cancelled", { stateId: "collect", step: 1, durationMs: 2500 });
    const stopped = event("workflow.cancelled", { name: "nightly-report", steps: 1, stateId: "collect", reason: "no longer needed" });
    assert.equal(formatWorkflowEventText(stoppedNode), "⊘ `collect` · #1 canceled after 3 s.");
    assert.equal(describeWorkflowEvent(stoppedNode).summary, "collect canceled after 3 s");
    assert.equal(formatWorkflowEventText(stopped), "⊘ Workflow **nightly-report** canceled after 1 visit at `collect`: no longer needed");
    assert.equal(formatWorkflowEventText(event("workflow.cancelled", { name: "x", steps: 2, reason: "cancelled" })), "⊘ Workflow **x** canceled after 2 visits.",
        "a reason that is only the state word is left out");
    assert.deepEqual([describeWorkflowEvent(stopped).kind, describeWorkflowEvent(stopped).title], ["card", "Workflow canceled"]);
    assert.ok(CHAT_HISTORY_EVENT_TYPES.includes("workflow.cancelled"));
});

test("opening a workflow session shows its canvas; an agent session's canvas stays where the person left it", async () => {
    const canvasEvent = { seq: 1, eventType: "session.canvas_updated", data: { rev: 1, slot: 1, name: "Workflow" } };
    const { controller, store } = makeController({
        getSessionEventsBefore: async (_id, _before, _limit, types) => (types.includes("session.canvas_updated") ? [canvasEvent] : []),
    });
    store.dispatch({ type: "ui/sessionViewDevice", device: "desktop" });
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
