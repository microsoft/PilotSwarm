/**
 * Review UI2-F1 (short UI re-review of fd0fcda8..3b04798c, high): the Workflow button's dot could stay off after a
 * Workflow failed, or reached an input wait, while no Workflow panel showed it. The dot read a cached model that said
 * Running, and nothing read that model again while the panel was closed: the catalog read refreshed the row only.
 * - A row that ended after its model was read wins over a model whose run has not ended.
 * - Each catalog refresh reads again the models of the active chat's Workflows that are still running, or whose row
 *   changed after their model was read (an input wait shows only in the model).
 *
 * Run: node --test ui/core/test/workflow-simplified-attention-fresh.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmUiController, appReducer, createInitialState, createStore } from "../src/index.js";
import { workflowAttentionChildIds, workflowNeedsAttention, workflowStateOf } from "../src/workflow-owner.js";

const OWNER = "owner-1";
const WF = "wf-1";
const T1 = Date.parse("2026-11-06T17:00:00.000Z");
const T2 = T1 + 60_000;
const row = (status, updatedAt) => ({ sessionId: WF, sessionKind: "workflow", title: "Workflow: watch-flow", status, parentSessionId: OWNER,
    createdAt: T1 - 1_000, updatedAt });
const STATES = [{ id: "poll", type: "script" }, { id: "ask", type: "request" }, { id: "done", type: "terminal" }];
const model = (status, open = []) => ({
    workflowId: WF, graph: { revision: 1, initial: "poll", states: STATES },
    runs: [{ runId: "run-1", mode: "live", status, revision: 1, outcome: null }],
    run: { runId: "run-1", mode: "live", status, nodeExecutions: [], openExecutions: open },
});
const RUNNING = model("running", [{ nodeExecutionId: "nx-1", stateId: "poll", state: "pending" }]);
const ASKING = model("running", [{ nodeExecutionId: "nx-2", stateId: "ask", state: "pending" }]);

function harness() {
    const reads = [];
    let answer = RUNNING;
    const transport = { async readWorkflow(sessionId, options) { reads.push({ sessionId, options }); return answer; } };
    const store = createStore(appReducer, createInitialState({ mode: "api" }));
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: OWNER, title: "Release triage agent", updatedAt: 1 }, row("running", T1)] });
    store.dispatch({ type: "sessions/selected", sessionId: OWNER });
    // A panel once showed the Workflow: its model was read with the row as it was then (Running, T1).
    store.dispatch({ type: "ui/workflowView", sessionId: WF, view: { readModel: RUNNING, readModelRunId: null, readModelAfterSeq: null,
        readModelAttempt: { runId: null, afterSeq: null, sessionUpdatedAt: T1 }, readModelError: null } });
    return { store, controller, reads, answer: value => { answer = value; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test("a row that failed after the model was read wins: the Workflow reads Failed and the dot shows, the panel closed", () => {
    const { store } = harness();
    const state = () => store.getState();
    assert.equal(workflowStateOf(state().sessions.byId[WF], state().ui.workflowViews[WF]).key, "running");
    assert.equal(workflowNeedsAttention(state(), OWNER), false);
    // In the background, the Workflow fails: the catalog read brings the row, the cached model still says Running.
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: OWNER, title: "Release triage agent", updatedAt: 1 }, row("failed", T2)] });
    assert.equal(workflowStateOf(state().sessions.byId[WF], state().ui.workflowViews[WF]).key, "failed");
    assert.equal(workflowNeedsAttention(state(), OWNER), true);
    // A row no newer than the read does not override the model.
    assert.equal(workflowStateOf(row("failed", T1), state().ui.workflowViews[WF]).key, "running");
    // A model that has ended keeps its own words.
    const failedView = { ...state().ui.workflowViews[WF], readModel: model("failed") };
    assert.equal(workflowStateOf(row("completed", T2), failedView).key, "failed");
});

test("the Workflows whose models the dot needs: running ones, and ended ones whose row changed after their model was read", () => {
    const byId = {
        [OWNER]: { sessionId: OWNER, title: "x" },
        a: { ...row("running", T1), sessionId: "a", createdAt: 1 },
        b: { ...row("failed", T2), sessionId: "b", createdAt: 2 },
        c: { ...row("failed", T2), sessionId: "c", createdAt: 3 },
        d: { ...row("completed", T2), sessionId: "d", createdAt: 4 },
    };
    const views = { b: { readModelAttempt: { sessionUpdatedAt: T1 } }, c: { readModelAttempt: { sessionUpdatedAt: T2 } } };
    assert.deepEqual(workflowAttentionChildIds(byId, OWNER, views), ["b", "a"]);
});

test("each catalog refresh reads a changed Workflow's model again, panel closed: an input wait puts the dot on", async () => {
    const { store, controller, reads, answer } = harness();
    const state = () => store.getState();
    controller.refreshWorkflowAttention();
    await settle();
    assert.equal(reads.length, 0, "nothing changed: no read");
    // The Workflow reaches an input request: its row changes (still running), only its model says it waits.
    answer(ASKING);
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: OWNER, title: "Release triage agent", updatedAt: 1 }, row("running", T2)] });
    assert.equal(workflowNeedsAttention(state(), OWNER), false, "the cached model does not know yet");
    controller.refreshWorkflowAttention();
    await settle(); await settle();
    assert.deepEqual(reads.map(read => read.sessionId), [WF]);
    assert.equal(workflowStateOf(state().sessions.byId[WF], state().ui.workflowViews[WF]).key, "waiting");
    assert.equal(workflowNeedsAttention(state(), OWNER), true);
});
