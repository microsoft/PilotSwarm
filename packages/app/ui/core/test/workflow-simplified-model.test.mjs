/**
 * Workflow Simplified, stage 1 (spec draft 3): the model the portal and the terminal share. A session owns its
 * workflow children; a started child is a Workflow, numbered within its definition (`check-items #3`) and grouped by
 * definition name (O5, display only); a child that has not started has no session-list row; each Workflow has its own
 * state in words (05, O8 "Canceled"); selecting a Workflow row selects its session's chat and shows the Workflow in that
 * session's Workflow tab (S4, S5, S8); an agent node's session shows its Workflow with that node selected (S6); the
 * Workflow button counts the Workflows that need the person (O6).
 *
 * Run: node --test test/workflow-simplified-model.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

import { appReducer, createInitialState, selectSessionRows } from "../src/index.js";
import {
    selectWorkflowTabContext, workflowBadgeCount, workflowDefinitionsOf, workflowFailure, workflowFailureText, workflowHighlightedSessionId, workflowNodeSessionTitle,
    workflowRowTitle, workflowSelectionTarget, workflowStarted, workflowStateOf, WORKFLOW_SIDE_TAB,
} from "../src/workflow-owner.js";
import { buildSessionTree } from "../src/session-tree.js";

const OWNER = "owner-1";
const at = n => 1_800_000_000_000 + n * 60_000;
const ownerSession = (sessionId, extra = {}) => ({ sessionId, title: "Stock check", status: "idle", createdAt: at(0), updatedAt: at(0), ...extra });
const workflow = (sessionId, name, n, status = "completed", extra = {}) => ({
    sessionId, sessionKind: "workflow", title: `Workflow: ${name}`, status, parentSessionId: OWNER, createdAt: at(n), updatedAt: at(n), ...extra,
});

const SESSIONS = [
    ownerSession(OWNER),
    workflow("wf-1", "check-items", 1, "completed"),
    workflow("wf-2", "check-items", 2, "failed"),
    workflow("wf-3", "check-items", 3, "running"),
    workflow("wf-draft", "nightly-report", 4, "pending"),
    { sessionId: "agent-1", title: "Workflow step: summarize", status: "running", parentSessionId: "wf-3", createdAt: at(5), updatedAt: at(5) },
    { sessionId: "other", title: "Price lookup", status: "idle", parentSessionId: OWNER, createdAt: at(6), updatedAt: at(6) },
];

const byIdOf = sessions => Object.fromEntries(sessions.map(session => [session.sessionId, session]));

function loaded(sessions = SESSIONS) {
    let state = appReducer(createInitialState({ mode: "local" }), { type: "ui/sessionViewDevice", device: "desktop" });
    state = appReducer(state, { type: "sessions/loaded", sessions });
    return state;
}

const liveModel = ({ status = "running", outcome = null, run = {}, graph = null, runs = null } = {}) => ({
    workflowId: "wf", definition: { state: "published", currentRevision: 4, publishedRevision: 4 }, revision: { revision: 4, valid: true, name: "check-items" },
    graph: graph ?? { revision: 4, initial: "check", states: [{ id: "check", type: "script" }, { id: "ask", type: "messaging", mode: "request" }] },
    runs: runs ?? [{ runId: "r1", mode: "live", status, revision: 4, outcome }],
    run: { runId: "r1", mode: "live", status, outcome, nodeExecutions: [], openExecutions: [], ...run },
});

test("a Workflow's state reads in words, from its read model when loaded, else from its row (05, O8)", () => {
    const row = status => workflow("wf", "check-items", 1, status);
    assert.equal(workflowStateOf(row("running")).label, "Running");
    assert.equal(workflowStateOf(row("pending")).label, "Running", "accepted but not begun is Running");
    assert.equal(workflowStateOf(row("waiting")).label, "Paused", "the engine shows a paused run's row as waiting");
    assert.equal(workflowStateOf(row("completed")).label, "Completed");
    assert.equal(workflowStateOf(row("failed")).label, "Failed");
    assert.equal(workflowStateOf(row("cancelled")).label, "Canceled", "one l on screens; stored value stays cancelled");
    const view = model => ({ readModel: model });
    assert.equal(workflowStateOf(row("running"), view(liveModel({ status: "admitted" }))).label, "Running");
    const waiting = liveModel({ run: { openExecutions: [{ nodeExecutionId: "n1", stateId: "ask", state: "pending" }] } });
    assert.deepEqual(workflowStateOf(row("running"), view(waiting)), { key: "waiting", label: "Waiting", tone: "waiting", outcome: null, reason: null, title: "Waiting for an answer" });
    const stopping = liveModel({ run: { stop: { requestedAt: "x", deadline: "y", graceSeconds: 60 } } });
    assert.equal(workflowStateOf(row("running"), view(stopping)).label, "Canceling");
    // Review 18:45Z (D-W1 overruled): a stop either way reads Canceled; the tooltip says how it was stopped.
    const stopped = workflowStateOf(row("cancelled"), view(liveModel({ status: "stopped" })));
    assert.deepEqual([stopped.key, stopped.label, stopped.tone, stopped.reason, stopped.title], ["canceled", "Canceled", "canceled", null, "Canceled after started nodes finished"]);
    const canceled = workflowStateOf(row("cancelled"), view(liveModel({ status: "cancelled" })));
    assert.deepEqual([canceled.key, canceled.label, canceled.reason, canceled.title], ["canceled", "Canceled", null, "Canceled at once"]);
    // Paused is authoritative even while started work remains pending.
    const pausing = workflowStateOf(row("waiting"), view(liveModel({ status: "paused", run: { pauseSettled: false } })));
    assert.deepEqual([pausing.key, pausing.label, pausing.tone, pausing.title], ["paused", "Paused", "paused", "Started work and timers continue"]);
    assert.equal(workflowStateOf(row("waiting"), view(liveModel({ status: "paused", run: { pauseSettled: true } }))).label, "Paused");
    const blocked = workflowStateOf(row("completed"), view(liveModel({ status: "completed", outcome: "blocked" })));
    assert.equal(blocked.label, "Completed · blocked");
    assert.equal(blocked.tone, "waiting");
    assert.equal(workflowStateOf(row("completed"), view(liveModel({ status: "completed", outcome: "succeeded" }))).label, "Completed");
    // A test run is never read as the Workflow's state (test mode is hidden, E1).
    const tested = { readModel: { ...liveModel({ status: "completed" }), runs: [{ runId: "t1", mode: "test", status: "failed" }], run: null } };
    assert.equal(workflowStarted(row("failed"), tested), false);
    assert.equal(workflowStateOf({ sessionId: "x", title: "chat" }), null);
});

test("a failed Workflow says where and why first (W4), from the run's own end, never a guess (UI-15)", () => {
    const ended = (nodeExecutionId, message = "State 'check' ended with runtime error 'execution_failed' and has no route for it.") =>
        JSON.stringify({ code: "execution_failed", message, details: { nodeExecutionId } });
    const run = { status: "failed", terminalState: "check", error: ended("nx-check-3"),
        nodeExecutions: [
            // An early timeout that a route recovered from: an older error that did not end the run.
            { nodeExecutionId: "nx-fetch-1", stateId: "fetch", state: "completed", resultKind: "runtime_error", errorPreview: "{\"message\":\"the API timed out\"}" },
            { nodeExecutionId: "nx-check-3", stateId: "check", state: "completed", resultKind: "runtime_error", errorPreview: "{\"message\":\"cherry is out of stock\"}",
                branch: { parallelNodeExecutionId: "nx-fan-1", index: 2 } },
        ] };
    assert.equal(workflowFailureText(run), "check failed · item 3: cherry is out of stock");
    assert.equal(workflowFailureText(run, { itemOf: () => "cherry" }), "check failed · item cherry: cherry is out of stock");
    assert.equal(workflowFailure(run).reason, "at check · item 3: cherry is out of stock");
    // Newest first or oldest first: the same cause.
    assert.equal(workflowFailureText({ ...run, nodeExecutions: [...run.nodeExecutions].reverse() }), "check failed · item 3: cherry is out of stock");
    // The causing execution not loaded: the run's own error, never the older recovered one.
    const unloaded = workflowFailureText({ ...run, nodeExecutions: [run.nodeExecutions[0]] });
    assert.equal(unloaded, "check failed: State 'check' ended with runtime error 'execution_failed' and has no route for it.");
    // A run whose error names no execution (its deadline, the controller): its own error, no guess among historical errors.
    assert.equal(workflowFailureText({ status: "failed", terminalState: null, error: JSON.stringify({ code: "timed_out", message: "The run reached its deadline." }),
        nodeExecutions: run.nodeExecutions }), "Failed: The run reached its deadline.");
    assert.equal(workflowFailureText({ status: "failed", terminalState: "stuck", error: "\"no stock\"" }), "stuck failed: no stock");
    assert.equal(workflowFailureText({ status: "failed", terminalState: null, error: null, nodeExecutions: run.nodeExecutions }), null);
    assert.equal(workflowFailureText({ status: "completed" }), null);
});

test("a session's definitions: its workflow children grouped by name, numbered oldest first (D1, S2, O5)", () => {
    const byId = byIdOf(SESSIONS);
    const definitions = workflowDefinitionsOf(byId, OWNER);
    assert.deepEqual(definitions.map(item => item.name), ["nightly-report", "check-items"], "newest first");
    const checkItems = definitions.find(item => item.name === "check-items");
    assert.deepEqual(checkItems.workflows, [{ sessionId: "wf-1", number: 1 }, { sessionId: "wf-2", number: 2 }, { sessionId: "wf-3", number: 3 }]);
    assert.equal(checkItems.newestId, "wf-3");
    assert.equal(checkItems.startable, false, "its newest child has started");
    const nightly = definitions.find(item => item.name === "nightly-report");
    assert.deepEqual(nightly.workflows, [], "a draft never run is a definition with 0 Workflows");
    assert.equal(nightly.startable, true);
    assert.equal(workflowRowTitle(byId, byId["wf-2"]), "check-items #2");
    assert.equal(workflowRowTitle(byId, byId["wf-draft"]), "nightly-report");
    assert.equal(workflowNodeSessionTitle(byId, byId["agent-1"]), "summarize · agent");
    assert.equal(workflowNodeSessionTitle(byId, byId.other), null);
    // The read model's revision name wins over the row title.
    const renamed = workflowDefinitionsOf(byId, OWNER, { "wf-1": { readModel: { ...liveModel(), revision: { revision: 1, valid: true, name: "old-name" } } } });
    assert.ok(renamed.some(item => item.name === "old-name" && item.workflows.length === 1));
});

test("a workflow child that has not started has no row; the Workflows read `check-items #3` with a state chip (S2, 20)", () => {
    const state = loaded();
    const rows = selectSessionRows(state);
    const ids = rows.map(row => row.sessionId);
    assert.ok(!ids.includes("wf-draft"), "the draft has no row");
    assert.ok(buildSessionTree(SESSIONS, new Set()).every(entry => entry.sessionId !== "wf-draft"));
    const owner = rows.find(row => row.sessionId === OWNER);
    assert.ok(owner, "the session row is there");
    // Expand the session to see its children.
    const expanded = appReducer(state, { type: "sessions/expand", sessionId: OWNER });
    const shown = selectSessionRows(expanded);
    const third = shown.find(row => row.sessionId === "wf-3");
    assert.ok(third, "a running Workflow has its row");
    assert.equal(third.chrome.title, "check-items #3");
    assert.deepEqual(third.chrome.workflowState, { key: "running", label: "Running", tone: "running" });
    assert.ok(third.titleRuns.some(run => run.role === "workflowState" && run.text.trim() === "Running"), "the terminal prints the state in words");
    assert.equal(shown.find(row => row.sessionId === "wf-2").chrome.workflowState.label, "Failed");
});

test("selecting a Workflow row selects its session's chat and opens the Workflow tab on that Workflow (S4, S5)", () => {
    let state = loaded();
    assert.deepEqual(workflowSelectionTarget(state.sessions.byId, "wf-3"), { ownerId: OWNER, workflowId: "wf-3" });
    assert.equal(workflowSelectionTarget(state.sessions.byId, OWNER), null);
    const seq = state.ui.workflowOpenSeq;
    state = appReducer(state, { type: "sessions/selected", sessionId: "wf-3" });
    assert.equal(state.sessions.activeSessionId, OWNER, "the middle shows the session's chat");
    assert.equal(state.sessions.workflowRowId, "wf-3");
    assert.equal(workflowHighlightedSessionId(state.sessions), "wf-3", "the list highlights the Workflow row");
    assert.equal(state.ui.sidePaneTab, WORKFLOW_SIDE_TAB);
    assert.equal(state.ui.canvasOpen, true, "the right block opens on the Workflow tab");
    assert.equal(state.ui.workflowOpenSeq, seq + 1, "the phone brings its Workflow pane up");
    assert.deepEqual(state.ui.workflowTabs[OWNER], { view: "workflows", workflowId: "wf-3", definition: "check-items" });
    assert.deepEqual(selectWorkflowTabContext(state), { ownerId: OWNER, workflowId: "wf-3", nodeSessionId: null, nodeStateId: null });
    const rows = selectSessionRows(appReducer(state, { type: "sessions/expand", sessionId: OWNER }));
    assert.equal(rows.find(row => row.sessionId === "wf-3").active, true);
    assert.equal(rows.find(row => row.sessionId === OWNER).active, false);
    assert.equal(rows.find(row => row.sessionId === OWNER).chatOwner, true, "the session row is marked as the chat on screen");
    // Selecting the session row keeps the tab on what it showed (S5) and gives the highlight back.
    state = appReducer(state, { type: "sessions/selected", sessionId: OWNER });
    assert.equal(state.sessions.activeSessionId, OWNER);
    assert.equal(state.sessions.workflowRowId, null);
    assert.equal(workflowHighlightedSessionId(state.sessions), OWNER);
    assert.equal(selectWorkflowTabContext(state).workflowId, "wf-3");
    // Another session: its own Workflow tab.
    state = appReducer(state, { type: "sessions/loaded", sessions: [...SESSIONS, ownerSession("lonely", { title: "Release notes" })] });
    state = appReducer(state, { type: "sessions/selected", sessionId: "lonely" });
    assert.deepEqual(selectWorkflowTabContext(state), { ownerId: "lonely", workflowId: null, nodeSessionId: null, nodeStateId: null });
});

test("a link to a Workflow opens its session's chat with the Workflow shown (S8)", () => {
    let state = appReducer(createInitialState({ mode: "local" }), { type: "sessions/navigationIntent", sessionId: "wf-2" });
    state = appReducer(state, { type: "sessions/loaded", sessions: SESSIONS });
    assert.equal(state.sessions.activeSessionId, OWNER);
    assert.equal(state.sessions.workflowRowId, "wf-2");
    assert.equal(selectWorkflowTabContext(state).workflowId, "wf-2");
    assert.ok(!state.sessions.collapsedIds.has(OWNER), "the Workflow's session is opened so its row shows");
    // The right block opens on the Workflow tab once, when the link resolves; a later session-list refresh leaves it alone.
    assert.equal(state.ui.canvasOpen, true);
    assert.equal(state.ui.sidePaneTab, WORKFLOW_SIDE_TAB);
    const seq = state.ui.workflowOpenSeq;
    assert.ok(seq >= 1);
    // The tab remembers the Workflow as a row selection does, so a later reload of the session keeps showing it.
    assert.deepEqual(state.ui.workflowTabs[OWNER], { view: "workflows", workflowId: "wf-2", definition: "check-items" });
    state = appReducer(state, { type: "sessions/loaded", sessions: SESSIONS });
    assert.equal(state.ui.workflowOpenSeq, seq, "a refresh does not open it again");
    assert.equal(state.sessions.workflowRowId, "wf-2", "a refresh keeps the Workflow row");
    // Choosing the session itself clears the row; its tab keeps the Workflow it showed last (S5).
    const chosen = appReducer(state, { type: "sessions/selected", sessionId: OWNER });
    assert.equal(chosen.sessions.workflowRowId, null);
    assert.equal(selectWorkflowTabContext(chosen).workflowId, "wf-2");
    // A link to an ordinary session does not open the Workflow tab.
    let plain = appReducer(createInitialState({ mode: "local" }), { type: "sessions/navigationIntent", sessionId: "other" });
    plain = appReducer(plain, { type: "sessions/loaded", sessions: SESSIONS });
    assert.equal(plain.sessions.activeSessionId, "other");
    assert.notEqual(plain.ui.sidePaneTab, WORKFLOW_SIDE_TAB);
});

test("an agent node's session shows in the middle; the tab shows its Workflow with that node selected (S6)", () => {
    const state = appReducer(loaded(), { type: "sessions/selected", sessionId: "agent-1" });
    assert.equal(state.sessions.activeSessionId, "agent-1");
    assert.deepEqual(selectWorkflowTabContext(state), { ownerId: OWNER, workflowId: "wf-3", nodeSessionId: "agent-1", nodeStateId: "summarize" });
});

// Review UI-9: selecting an agent node's session chooses its Workflow and node now, whatever node was selected before, and
// opens the Workflow tab when the right block was closed; a later click on the graph chooses again.
test("selecting an agent node's session selects that node in its Workflow and opens the Workflow tab", () => {
    let state = appReducer(loaded(), { type: "ui/workflowView", sessionId: "wf-3", view: { selectedNodeId: "fetch" } });
    state = appReducer(state, { type: "ui/canvasOpen", open: false });
    assert.equal(state.ui.canvasOpen, false);
    state = appReducer(state, { type: "sessions/selected", sessionId: "agent-1" });
    assert.equal(state.sessions.activeSessionId, "agent-1", "its session is in the middle");
    assert.equal(state.ui.workflowViews["wf-3"].selectedNodeId, "summarize", "the node, not the one chosen before");
    assert.equal(state.ui.canvasOpen, true);
    assert.equal(state.ui.sidePaneTab, "workflow");
    assert.equal(Number(state.ui.workflowOpenSeq) || 0, 0, "the phone keeps showing the session that was tapped");
    // A click on the graph chooses again.
    state = appReducer(state, { type: "ui/workflowView", sessionId: "wf-3", view: { selectedNodeId: "fetch" } });
    assert.equal(state.ui.workflowViews["wf-3"].selectedNodeId, "fetch");
    // An ordinary session's selection changes nothing of it.
    const other = appReducer(state, { type: "sessions/selected", sessionId: "other" });
    assert.equal(other.ui.workflowViews["wf-3"].selectedNodeId, "fetch");
});

// Review UI-D2: an agent session's navigation shows its own Workflow's definition and the Workflows view, whatever definition
// or view was left chosen in the owner's Workflow tab; a later choice in the tab chooses again.
test("UI-D2: selecting an agent node's session shows its Workflow's definition, the Workflows view, that Workflow and node", () => {
    let state = loaded();
    // Left on the other definition's Definition view.
    state = appReducer(state, { type: "ui/workflowTab", ownerId: OWNER, patch: { view: "definition", definition: "nightly-report", workflowId: null } });
    state = appReducer(state, { type: "sessions/selected", sessionId: "agent-1" });
    assert.deepEqual(state.ui.workflowTabs[OWNER], { view: "workflows", definition: "check-items", workflowId: "wf-3" });
    assert.equal(state.ui.workflowViews["wf-3"].selectedNodeId, "summarize");
    assert.deepEqual(selectWorkflowTabContext(state), { ownerId: OWNER, workflowId: "wf-3", nodeSessionId: "agent-1", nodeStateId: "summarize" });
    assert.equal(Number(state.ui.workflowOpenSeq) || 0, 0, "the phone keeps showing the session that was tapped");
    // A later deliberate choice in the tab stands.
    state = appReducer(state, { type: "ui/workflowTab", ownerId: OWNER, patch: { view: "definition" } });
    assert.equal(state.ui.workflowTabs[OWNER].view, "definition");
    // Selecting the session again chooses again.
    state = appReducer(state, { type: "sessions/selected", sessionId: OWNER });
    state = appReducer(state, { type: "sessions/selected", sessionId: "agent-1" });
    assert.equal(state.ui.workflowTabs[OWNER].view, "workflows");
    // An ordinary session's selection leaves the tab as it is.
    const other = appReducer(state, { type: "ui/workflowTab", ownerId: OWNER, patch: { view: "definition", definition: "nightly-report" } });
    const plain = appReducer(other, { type: "sessions/selected", sessionId: "other" });
    assert.deepEqual(plain.ui.workflowTabs[OWNER], other.ui.workflowTabs[OWNER]);
});

test("a Workflow whose session is not loaded stays the active session and is the tab's Workflow", () => {
    const alone = [workflow("wf-x", "check-items", 1, "running", { parentSessionId: "missing" })];
    const state = appReducer(loaded(alone), { type: "sessions/selected", sessionId: "wf-x" });
    assert.equal(state.sessions.activeSessionId, "wf-x");
    assert.equal(selectWorkflowTabContext(state).workflowId, "wf-x");
});

test("the Workflow button counts Workflows waiting for input and failed ones not yet opened (O6)", () => {
    let state = loaded();
    const waiting = { readModel: liveModel({ run: { openExecutions: [{ nodeExecutionId: "n1", stateId: "ask", state: "pending" }] } }) };
    const views = { "wf-3": waiting };
    assert.equal(workflowBadgeCount(state.sessions.byId, OWNER, views, {}), 2, "#3 waits for input, #2 failed");
    assert.equal(workflowBadgeCount(state.sessions.byId, OWNER, views, { "wf-2": true }), 1, "an opened failure no longer counts");
    state = appReducer(state, { type: "ui/workflowSeen", sessionId: "wf-2" });
    assert.equal(state.ui.workflowSeen["wf-2"], true);
    assert.equal(workflowBadgeCount(state.sessions.byId, OWNER, {}, state.ui.workflowSeen), 0, "#3 only runs");
});

test("the Workflow tab's state is kept per session; the side pane accepts its Workflow tab", () => {
    let state = loaded();
    state = appReducer(state, { type: "ui/workflowTab", ownerId: OWNER, patch: { view: "definition", definition: "nightly-report" } });
    assert.deepEqual(state.ui.workflowTabs[OWNER], { view: "definition", definition: "nightly-report" });
    const same = appReducer(state, { type: "ui/workflowTab", ownerId: OWNER, patch: { view: "definition" } });
    assert.equal(same, state, "an unchanged patch changes nothing");
    state = appReducer(state, { type: "ui/sidePaneTab", tab: "workflow" });
    assert.equal(state.ui.sidePaneTab, "workflow");
    state = appReducer(state, { type: "ui/sidePaneTab", tab: "bogus" });
    assert.equal(state.ui.sidePaneTab, "canvas");
});
