// Workflow sessions in the UI:
//   - the session list marks them apart from agent sessions
//   - their transcript is an execution log built from workflow.* events
//   - they are started only by agents (spawn_workflow), never from the chooser
//   - they never take chat input or a regeneration
import test from "node:test";
import assert from "node:assert/strict";
import * as uiCore from "../src/index.js";
import {
    PilotSwarmUiController,
    appReducer,
    appendEventToHistory,
    buildHistoryModel,
    canStopSessionTurn,
    describeWorkflowEvent,
    CHAT_HISTORY_EVENT_TYPES,
    createInitialState,
    createStore,
    formatWorkflowEventText,
    isWorkflowEvent,
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

test("a wait state reads as waiting, with its length, end time and loop count", () => {
    const until = Date.UTC(2026, 9, 29, 14, 30, 0);
    const graph = formatWorkflowEventText(event("workflow.started", {
        name: "poll", version: "1", initial: "check",
        states: [
            { id: "check", type: "script", runtime: "python", next: { found: "handle", idle: "sleep" } },
            { id: "sleep", type: "wait", seconds: 600, next: { elapsed: "check" } },
        ],
    }));
    assert.match(graph, /\| sleep \| wait \(10 min\) \| elapsed → check \|/);
    const waiting = event("workflow.state_waiting", { stateId: "sleep", step: 4, seconds: 600, until, visit: 2 });
    const text = formatWorkflowEventText(waiting);
    assert.match(text, /^⏸ Step 4: `sleep` waiting 10 min, until .+\. This is wait 2\.$/);
    assert.ok(text.includes(new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })));
    const notice = describeWorkflowEvent(waiting);
    assert.equal(notice.kind, "notice");
    assert.match(notice.summary, /^sleep waiting 10 min, until .+ \(wait 2\)$/);
    assert.equal(isWorkflowEvent(waiting), true);
    assert.equal(formatWorkflowEventText(event("workflow.state_waiting", { stateId: "nap", step: 1, seconds: 90, until, visit: 1 })).includes("This is wait"), false);

    // A clock wait names its schedule.
    const nightly = { stateId: "nightly", step: 2, at: { minute: 0, hour: 2, tz: "America/Los_Angeles" }, schedule: "daily at 02:00 America/Los_Angeles", until, visit: 1 };
    assert.match(formatWorkflowEventText(event("workflow.state_waiting", nightly)), /^⏸ Step 2: `nightly` waiting for daily at 02:00 America\/Los_Angeles, until .+\.$/);
    assert.match(describeWorkflowEvent(event("workflow.state_waiting", nightly)).summary, /^nightly waiting for daily at 02:00 America\/Los_Angeles, until /);
    const clockGraph = formatWorkflowEventText(event("workflow.started", {
        name: "nightly", version: "1", initial: "nightly",
        states: [{ id: "nightly", type: "wait", at: nightly.at, schedule: nightly.schedule, next: { elapsed: "report" } }],
    }));
    assert.match(clockGraph, /\| nightly \| wait \(daily at 02:00 America\/Los_Angeles\) \| elapsed → report \|/);
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
    const transport = {
        listSessions: async () => sessions,
        getSession: async (sessionId) => sessions.find((session) => session.sessionId === sessionId) || null,
        subscribeSession: () => () => {},
        createSession: async () => ({ sessionId: "generic-1", status: "idle" }),
        listCreatableAgents: async () => [{ name: "alpha", title: "Alpha" }],
        getSessionCreationPolicy: () => ({ creation: { allowGeneric: true } }),
        ...transportOverrides,
    };
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });
    return { controller, store, transport };
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

test("the new-session chooser offers no workflow: agents start workflows with spawn_workflow", async () => {
    // Even a connection that still has a create method gets no entry for it.
    const { controller, store } = makeController({ createWorkflowSession: async () => { throw new Error("must not be called"); } });
    await controller.openSessionAgentPicker();
    const modal = store.getState().ui.modal;
    assert.equal(modal.type, "sessionAgentPicker");
    assert.deepEqual(modal.items.map((item) => item.kind ?? "agent").filter((kind) => kind !== "agent"), ["generic"]);
    assert.equal("workflowItem" in modal, false);
    const view = selectSessionAgentPickerModal(store.getState());
    const text = view.rows.flat().map((run) => run?.text ?? "").join("");
    assert.doesNotMatch(text, /Workflow/);
    assert.doesNotMatch(text, new RegExp(WORKFLOW_SESSION_GLYPH));

    assert.equal(typeof controller.createWorkflowSession, "undefined");
    assert.equal(typeof controller.openWorkflowCreateModal, "undefined");
    assert.equal("WORKFLOW_YAML_TEMPLATE" in uiCore, false);
    assert.equal("selectWorkflowCreateModal" in uiCore, false);
});

test("a workflow session takes no steering, no Stop and no regeneration", async () => {
    const { controller, store } = makeController({ regenerateSession: async () => { throw new Error("must not be called"); } });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf-1", title: "Workflow: x", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf-1" });
    assert.equal(selectTurnControlView(store.getState()).canSteer, false);
    assert.equal(selectTurnControlView(store.getState()).canStop, false);
    assert.equal(canStopSessionTurn({ sessionId: "wf-1", status: "running", sessionKind: "workflow" }), false);
    assert.equal(canStopSessionTurn({ sessionId: "a-1", status: "running" }), true);
    await controller.stopActiveSessionTurn();
    assert.match(store.getState().ui.statusText || "", /Workflow sessions have no turns; cancel the session/);
    await controller.openSwitchModelPicker();
    assert.match(store.getState().ui.statusText || "", /Workflow sessions run no model; there is nothing to switch/);
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

