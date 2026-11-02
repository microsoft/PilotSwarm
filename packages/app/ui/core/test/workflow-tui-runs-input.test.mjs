// The TUI's workflow controls beyond the read-only view (design 02 "Portal/TUI"; design 03 human-input denial; T115,
// T116 in the TUI):
//   - the workflow view shows another run of the workflow (← →), with the portal's own run picker model, and reads that
//     run's model as the portal's picker does;
//   - the composer of a session in a workflow agent state's subtree is read-only: the server says so once per session
//     (getWorkflowInputPolicy, or the session access of the Web API), only sessions that may be in such a subtree by
//     their loaded ancestry are asked about, and a prompt, an answer or a steer to one is not sent, its draft kept.
//
// Run: node --test packages/app/ui/core/test/workflow-tui-runs-input.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
    PilotSwarmUiController,
    UI_COMMANDS,
    appReducer,
    buildHistoryModel,
    createInitialState,
    createStore,
    normalizeWorkflowInputPolicy,
    selectWorkflowInputNote,
    selectWorkflowViewModal,
    selectWorkflowViewSelection,
    workflowInputPolicyApplies,
} from "../src/index.js";
import { workflowV2RunPickerModel as coreRunPicker } from "../src/workflow-v2-run-picker.js";
import { workflowV2RunPickerModel as portalRunPicker } from "../../react/src/workflow-v2-panels.js";
import { legacyStartedData, readModel, row, done } from "./workflow-v2-fixtures.mjs";

const states = [
    { id: "review", type: "agent", invoke: { source: "agent", name: "code-reviewer" }, timeoutSeconds: 600,
        outcomes: ["accepted"], next: { accepted: "done", timed_out: "failed" } },
    { id: "done", type: "terminal", outcome: "succeeded" },
    { id: "failed", type: "terminal", outcome: "failed" },
];
const graph = { revision: 1, initial: "review", states };
const RUNS = [
    { runId: "run-1", mode: "live", status: "running", revision: 1, outcome: null },
    { runId: "run-t1", mode: "test", status: "completed", revision: 1, outcome: "passed" },
    { runId: "run-t2", mode: "test", status: "running", revision: 1, outcome: null },
];
const agent = childSessionId => ({ childSessionId, spawned: true, spawnAttempts: 1, end: null, endSent: false });
/** The read model of one run: the live run's agent state is still working; each test run's agent state has its own child. */
function modelFor(runId) {
    const run = RUNS.find(item => item.runId === (runId ?? "run-1"));
    const executions = run.status === "completed"
        ? [done("review", 1, "accepted", { agent: agent(`child-of-${run.runId}`), winner: "agent" })]
        : [row("review", 1, "pending", { agent: agent(`child-of-${run.runId}`) })];
    return readModel({ graph, revision: { name: "review-once" }, runs: RUNS, nodeExecutions: executions,
        run: { runId: run.runId, mode: run.mode, status: run.status, outcome: run.outcome, terminalState: run.status === "completed" ? "done" : null } });
}

const settle = () => new Promise(resolve => setImmediate(resolve));
const WRITES = /^(updateWorkflow|sendMessage|sendWorkflowInput|steer|answer|createSession|cancel|delete|done|complete|setSession)/i;

/** A workflow session wf with the live run's model loaded; a legacy one has no read model (its transport cannot read one). */
function viewHarness({ legacy = false } = {}) {
    const calls = [];
    const methods = legacy ? { getSessionEventsBefore: async () => [] } : {
        readWorkflow: async (sessionId, options = {}) => { calls.push(["readWorkflow", sessionId, options]); return modelFor(options.runId ?? null); },
        getSessionEventsBefore: async () => [],
    };
    // Every other call is recorded, so a test can say that nothing changed anything. A legacy transport has only its own.
    const transport = legacy ? methods : new Proxy(methods, { get: (target, name) => (name in target ? target[name] : typeof name === "string"
        ? async (...args) => { calls.push([name, ...args]); return null; } : undefined) });
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "wf", title: "Workflow: review-once", status: "running", sessionKind: "workflow" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "wf" });
    const started = legacy ? legacyStartedData
        : { runId: "run-1", mode: "live", revision: 1, definitionHash: "hash-1", irSha256: "ir-1", name: "review-once", initial: "review", states };
    store.dispatch({ type: "history/set", sessionId: "wf", history: buildHistoryModel([{ sessionId: "wf", seq: 1, eventType: "workflow.started",
        data: started, createdAt: new Date(Date.UTC(2026, 10, 2)) }]) });
    if (!legacy) store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { readModel: modelFor(null), readModelRunId: null } });
    return { controller, store, calls };
}

test("the TUI and the portal choose runs with one run picker model (ui-core), which the portal re-exports unchanged", () => {
    assert.equal(portalRunPicker, coreRunPicker);
});

test("← → show the workflow's other runs, as the portal's picker lists them, and read each run's own model", async () => {
    const { controller, store, calls } = viewHarness();
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await settle();
    let view = selectWorkflowViewModal(store.getState(), 110);
    assert.equal(view.detailsLines[0].text, "Run: Live run · running · run-1 (1 of 4 · ←→ choose)");
    // The live run, then every run in the list (the live run by its id too), as the portal's picker offers them.
    await controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_NEXT_RUN);
    await controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_NEXT_RUN);
    await settle();
    let state = store.getState();
    assert.equal(state.ui.workflowViews.wf.selectedRunId, "run-t1");
    assert.equal(state.ui.statusText, "Showing Test · completed (passed) · revision 1 · run-t1");
    assert.deepEqual(calls.filter(call => call[0] === "readWorkflow").at(-1), ["readWorkflow", "wf", { runId: "run-t1" }]);
    view = selectWorkflowViewModal(state, 110);
    assert.equal(view.detailsLines[0].text, "Run: Test · completed (passed) · revision 1 · run-t1 (3 of 4 · ←→ choose)");
    assert.match(view.title, /^Workflow: review-once · Test run · Completed · passed/);
    // That run's agent state shows that run's own child, never the live run's.
    assert.equal(selectWorkflowViewSelection(state).occurrence.childSessionId, "child-of-run-t1");
    // The last run stays the last; back to the live run, whose own model is read again.
    await controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_NEXT_RUN);
    await controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_NEXT_RUN);
    assert.equal(store.getState().ui.workflowViews.wf.selectedRunId, "run-t2");
    for (let i = 0; i < 5; i++) await controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_PREV_RUN);
    await settle();
    state = store.getState();
    assert.equal(state.ui.workflowViews.wf.selectedRunId, null);
    assert.equal(selectWorkflowViewSelection(state).occurrence.childSessionId, "child-of-run-1");
    assert.equal(state.ui.modal.type, "workflowView", "the view stays open");
    assert.deepEqual(calls.filter(call => WRITES.test(call[0])), []);
});

test("a run whose model is still loading or could not be read says so beside it; a legacy workflow has no runs to choose", async () => {
    const { controller, store } = viewHarness();
    await controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: { selectedRunId: "run-t2" } });
    let lines = selectWorkflowViewModal(store.getState(), 110).detailsLines.map(line => line.text);
    assert.ok(lines.includes("  Reading this run…"), lines.join("\n"));
    store.dispatch({ type: "ui/workflowView", sessionId: "wf", view: {
        readModelAttempt: { runId: "run-t2", afterSeq: 1, sessionUpdatedAt: null }, readModelError: "Gateway timeout" } });
    lines = selectWorkflowViewModal(store.getState(), 110).detailsLines.map(line => line.text);
    assert.ok(lines.includes("  This run could not be read. Your selection is kept."), lines.join("\n"));

    const legacy = viewHarness({ legacy: true });
    await legacy.controller.handleCommand(UI_COMMANDS.OPEN_WORKFLOW_VIEW);
    await legacy.controller.handleCommand(UI_COMMANDS.WORKFLOW_VIEW_NEXT_RUN);
    assert.equal(legacy.store.getState().ui.statusText, "This workflow has no runs to choose");
    assert.ok(!selectWorkflowViewModal(legacy.store.getState(), 110).detailsLines.some(line => line.text.startsWith("Run:")));
});

// ── The composer of a session in a workflow agent state's subtree ──────────────────────────────────────────────────

const REASON = "This session runs a workflow state. People cannot send it prompts, answers or steers; message the workflow's parent agent instead.";
const DENIED = { canSendPrompt: false, canAnswer: false, canSteer: false, reason: REASON, workflowSessionId: "wf", controllingSessionId: "r1" };
const ALLOWED = { canSendPrompt: true, canAnswer: true, canSteer: true, reason: null, workflowSessionId: null, controllingSessionId: null };
/** r1 (a root agent) → wf (its workflow) → c1 (an agent state's child) → g1 (c1's own sub-agent); r1 → s1 (an ordinary sub-agent); o1 (parent not loaded). */
const TREE = [
    { sessionId: "r1", title: "Root", status: "idle" },
    { sessionId: "wf", title: "Workflow: review-once", status: "running", sessionKind: "workflow", parentSessionId: "r1" },
    { sessionId: "c1", title: "Workflow node: review", status: "running", parentSessionId: "wf" },
    { sessionId: "g1", title: "Helper", status: "idle", parentSessionId: "c1" },
    { sessionId: "s1", title: "Sub-agent", status: "idle", parentSessionId: "r1" },
    { sessionId: "o1", title: "Orphan", status: "idle", parentSessionId: "not-loaded" },
];

function inputHarness({ policies = { c1: DENIED, g1: DENIED, o1: ALLOWED }, apiMode = false, fail = null } = {}) {
    const calls = [];
    const answer = async (sessionId) => {
        if (fail && fail.has(sessionId)) { fail.delete(sessionId); throw new Error("connection reset"); }
        return policies[sessionId] ?? ALLOWED;
    };
    const base = {
        sendMessage: async (...args) => { calls.push(["sendMessage", ...args]); },
        steerSessionTurn: async (...args) => { calls.push(["steerSessionTurn", ...args]); return { outcome: "accepted", steerId: 1, turn: 0 }; },
        getSessionEvents: async () => [],
        subscribeSession: () => () => {},
    };
    const transport = apiMode
        ? { ...base, getSessionAccess: async (sessionId) => {
            calls.push(["getSessionAccess", sessionId]);
            const policy = await answer(sessionId);
            return policy.canSendPrompt ? { sessionId, canWrite: true, canManage: true }
                : { sessionId, canWrite: true, canManage: true, canSendPrompt: false, canAnswer: false, canSteer: false,
                    workflowInput: { reason: policy.reason, workflowSessionId: policy.workflowSessionId, controllingSessionId: policy.controllingSessionId } };
        } }
        : { ...base, getWorkflowInputPolicy: async (sessionId) => { calls.push(["getWorkflowInputPolicy", sessionId]); return answer(sessionId); } };
    const store = createStore(appReducer, createInitialState({ mode: "local" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: TREE });
    return { controller, store, calls };
}

const NOTE = `${REASON} Its controlling agent is session r1.`;

test("only a session that may be in an agent state's subtree, by its loaded ancestry, is asked about, once", async () => {
    const { controller, store, calls } = inputHarness();
    const state = store.getState();
    assert.deepEqual(["r1", "wf", "c1", "g1", "s1", "o1", "nope"].map(id => workflowInputPolicyApplies(state, id)),
        [false, false, true, true, false, true, false]);
    for (const id of ["r1", "wf", "s1"]) assert.equal(await controller.ensureWorkflowInputPolicy(id), null, id);
    assert.deepEqual(calls, [], "a root, a workflow and an ordinary agent tree are never asked about");
    // Two reads at once make one request; a recorded answer is not asked for again.
    const [first, second] = await Promise.all([controller.ensureWorkflowInputPolicy("c1"), controller.ensureWorkflowInputPolicy("c1")]);
    assert.deepEqual(first, DENIED);
    assert.equal(second, first);
    await controller.ensureWorkflowInputPolicy("c1");
    assert.deepEqual(calls, [["getWorkflowInputPolicy", "c1"]]);
    assert.equal(selectWorkflowInputNote(store.getState(), "c1"), NOTE);
    // A descendant of the child is asked about too (the server says), and an unknown ancestry is asked about.
    await controller.ensureWorkflowInputPolicy("g1");
    await controller.ensureWorkflowInputPolicy("o1");
    assert.equal(selectWorkflowInputNote(store.getState(), "g1"), NOTE);
    assert.equal(selectWorkflowInputNote(store.getState(), "o1"), null, "the server allowed it");
    assert.equal(selectWorkflowInputNote(store.getState(), "s1"), null);
});

test("a prompt, an answer and a steer to such a session are not sent; the draft is kept; an ordinary session still sends", async () => {
    const { controller, store, calls } = inputHarness();
    store.dispatch({ type: "sessions/selected", sessionId: "c1" });
    await controller.ensureWorkflowInputPolicy("c1");
    controller.setPrompt("please also check the tests");
    await controller.sendPrompt();
    assert.equal(store.getState().ui.statusText, NOTE);
    assert.equal(store.getState().ui.prompt, "please also check the tests");
    assert.deepEqual(store.getState().outbox?.bySessionId?.c1 ?? [], []);
    // An answer to its question is refused the same way.
    store.dispatch({ type: "sessions/merged", session: { sessionId: "c1", pendingQuestion: { question: "Which branch?" } } });
    await controller.sendPrompt();
    assert.equal(store.getState().ui.statusText, NOTE);
    // And a steer.
    store.dispatch({ type: "sessions/merged", session: { sessionId: "c1", acceptsTurnControl: true } });
    store.dispatch({ type: "turnControl/steering", enabled: true });
    await controller.handleCommand(UI_COMMANDS.STEER_TURN);
    assert.equal(store.getState().ui.statusText, NOTE);
    assert.deepEqual(calls.filter(call => call[0] !== "getWorkflowInputPolicy"), []);

    // An ordinary sub-agent is never asked about, and the composer takes its prompt as before.
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    await controller.ensureWorkflowInputPolicy("s1");
    controller.setPrompt("hello");
    await controller.sendPrompt();
    assert.equal(store.getState().ui.prompt, "", "the ordinary session's prompt left the composer");
    assert.notEqual(store.getState().ui.statusText, NOTE);
    assert.equal(calls.filter(call => call[0] === "getWorkflowInputPolicy").length, 1);
});

test("over the Web API the session access says it; a failed read records nothing, so the composer stays and the server refuses", async () => {
    const api = inputHarness({ apiMode: true });
    await api.controller.ensureWorkflowInputPolicy("c1");
    await api.controller.ensureWorkflowInputPolicy("o1");
    assert.deepEqual(api.calls, [["getSessionAccess", "c1"], ["getSessionAccess", "o1"]]);
    assert.equal(selectWorkflowInputNote(api.store.getState(), "c1"), NOTE);
    assert.equal(selectWorkflowInputNote(api.store.getState(), "o1"), null);

    const flaky = inputHarness({ fail: new Set(["c1"]) });
    assert.equal(await flaky.controller.ensureWorkflowInputPolicy("c1"), null);
    assert.equal(flaky.store.getState().ui.workflowInputPolicies.c1, undefined);
    assert.equal(selectWorkflowInputNote(flaky.store.getState(), "c1"), null);
    // The next selection asks again.
    assert.deepEqual(await flaky.controller.ensureWorkflowInputPolicy("c1"), DENIED);

    // What the server says, whichever transport carried it; anything else is unknown.
    assert.deepEqual(normalizeWorkflowInputPolicy({ canWrite: true }), ALLOWED);
    assert.deepEqual(normalizeWorkflowInputPolicy(DENIED), DENIED);
    for (const value of [null, undefined, "denied", 3, []]) assert.equal(normalizeWorkflowInputPolicy(value), null);
});
