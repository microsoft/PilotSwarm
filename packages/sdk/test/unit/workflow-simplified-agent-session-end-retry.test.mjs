// A continued session's owed end (formal t3) and the two observations of its code check (pse/wfv2/formal/agent-visible):
// O1, the detached end retry is started again once the previous one ended and the end is still owed, one live at a time;
// O2, a last look that could not take the session's end lock reports that another look holds the end, not that the session was
// never seen.
import test from "node:test";
import assert from "node:assert/strict";
import {
    endOwedContinuedSession, endWorkflowContinuedSessions, registerWorkflow, WORKFLOW_AGENT_SESSION_END_NAME, WORKFLOW_ACTIVITIES,
    workflowAgentSessionId, workflowAgentSessionEndInstanceId,
} from "../../dist/workflow/runtime.js";

const AGENT_SESSION = workflowAgentSessionId("run-1", "talk");

/** One continued session whose run was canceled: its newest visit's end found no session (NotFound) after a spawn attempt. */
function world({ locked = true } = {}) {
    const invocation = { nodeExecutionId: "nx-2", runId: "run-1", workflowSessionId: "wf-1", childSessionId: AGENT_SESSION, spawnAttempts: 0,
        endRequested: "cancel", endSentAt: new Date("2026-11-06T07:00:00Z"), endChildStatus: "NotFound" };
    const statuses = new Map();
    const log = { started: [], enqueued: [], events: [] };
    const store = {
        readRun: async () => ({ runId: "run-1", workflowSessionId: "wf-1", mode: "live", status: "cancelled", stop: null }),
        listAgentInvocations: async () => [{ ...invocation }],
        readAgentInvocationByChild: async () => ({ ...invocation }),
        sessionHasSpawnAttempt: async () => true,
        readNodeExecution: async () => ({ nodeExecutionId: "nx-2", runId: "run-1", nodeType: "agent", state: "completed", winner: "cancel",
            outcome: "cancelled", nodeId: "talk", ordinal: 2 }),
        recordAgentEnd: async () => ({ invocation: { ...invocation } }),
        markContinuedSessionEnded: async (_id, status) => {
            if (invocation.endChildStatus === status) return { marked: false };
            invocation.endChildStatus = status;
            return { marked: true };
        },
        withAgentSessionEndLock: async (_session, work) => (locked ? { locked: true, value: await work() } : { locked: false }),
        recordSessionEvents: async (_id, events) => { log.events.push(...events); },
        completeNode: async () => ({ won: false }),
        readAgentInvocation: async () => ({ ...invocation }),
    };
    const client = {
        getStatus: async (id) => ({ status: statuses.get(id) ?? "NotFound" }),
        enqueueEvent: async (instance, _queue, data) => { log.enqueued.push([instance, JSON.parse(data).cmd]); },
        startOrchestrationVersioned: async (id, name) => { log.started.push([id, name]); statuses.set(id, "Running"); },
    };
    return { store, client, statuses, log, invocation };
}

test("O1: one detached end retry runs at a time; once it ended with the end still owed, the next cleanup or recover starts another", async () => {
    const w = world();
    const first = workflowAgentSessionEndInstanceId(AGENT_SESSION);
    assert.equal(first, `wfc-${AGENT_SESSION}`);
    await endWorkflowContinuedSessions(w.store, w.client, "run-1");
    assert.deepEqual(w.log.started, [[first, WORKFLOW_AGENT_SESSION_END_NAME]]);
    // While it runs, a recover looks once and starts nothing.
    await endWorkflowContinuedSessions(w.store, w.client, "run-1");
    assert.equal(w.log.started.length, 1);
    // Its schedule ran out (it ended), the end still owed: the next one.
    w.statuses.set(first, "Completed");
    await endWorkflowContinuedSessions(w.store, w.client, "run-1");
    assert.deepEqual(w.log.started.map(([id]) => id), [first, `wfc-${AGENT_SESSION}-2`]);
    w.statuses.set(`wfc-${AGENT_SESSION}-2`, "Failed");
    await endWorkflowContinuedSessions(w.store, w.client, "run-1");
    assert.deepEqual(w.log.started.map(([id]) => id), [first, `wfc-${AGENT_SESSION}-2`, `wfc-${AGENT_SESSION}-3`]);
    assert.deepEqual(w.log.enqueued, []);
    // The session is visible now: the look ends it, once, and no retry is started.
    w.statuses.set(`wfc-${AGENT_SESSION}-3`, "Completed");
    w.statuses.set(`session-${AGENT_SESSION}`, "Running");
    await endWorkflowContinuedSessions(w.store, w.client, "run-1");
    assert.deepEqual(w.log.enqueued, [[`session-${AGENT_SESSION}`, "cancel"]]);
    assert.equal(w.invocation.endChildStatus, "AgentSessionEnded");
    assert.equal(w.log.started.length, 3);
});

test("O2: a look that cannot take the session's end lock leaves the end to the holder: a retry looks again, a last look says so", async () => {
    const w = world({ locked: false });
    await assert.rejects(endOwedContinuedSession(w.store, w.client, AGENT_SESSION, { retry: true }), /Another look holds the end of session/);
    assert.equal(await endOwedContinuedSession(w.store, w.client, AGENT_SESSION, { retry: false }), "held_elsewhere");
    // With the lock, a session still not visible is "still_owed"; a visible one is ended.
    const seen = world();
    await assert.rejects(endOwedContinuedSession(seen.store, seen.client, AGENT_SESSION, { retry: true }), /its session is not visible yet/);
    assert.equal(await endOwedContinuedSession(seen.store, seen.client, AGENT_SESSION, { retry: false }), "still_owed");
    seen.statuses.set(`session-${AGENT_SESSION}`, "Running");
    assert.equal(await endOwedContinuedSession(seen.store, seen.client, AGENT_SESSION, { retry: false }), "ended");
    assert.deepEqual(seen.log.enqueued, [[`session-${AGENT_SESSION}`, "cancel"]]);
    assert.equal(await endOwedContinuedSession(seen.store, seen.client, AGENT_SESSION, { retry: false }), "not_owed");
});

/** The detached retry's activities over a world's fake store. */
function activitiesOf(w) {
    const activities = new Map();
    registerWorkflow({ registerActivity: (name, fn) => activities.set(name, fn), registerOrchestrationVersioned: () => {} }, {
        store: w.store, catalog: {}, enabled: () => true,
        resolveToolBinding: async () => null, openToolExecutor: async () => { throw new Error("no tools"); },
        authorizeParentNotification: async () => true, notifyParent: async () => {}, deleteSession: async () => {},
    });
    return activities;
}

test("O2: the last look reports another look holding the end, or a session never seen, on the newest visit's node", async () => {
    const last = (w) => activitiesOf(w).get(WORKFLOW_ACTIVITIES.endOwedAgentSessionLast)({ getClient: () => w.client }, { runId: "run-1", childSessionId: AGENT_SESSION });
    const held = world({ locked: false });
    assert.deepEqual(await last(held), { result: "held_elsewhere" });
    assert.deepEqual(held.log.events.map((event) => [event.eventType, event.data.reason, event.data.stateId, event.data.error]), [
        ["workflow.agent_end_failed", "held_elsewhere", "talk", "Another look holds this session's end; it sends the end."]]);
    const unseen = world();
    assert.deepEqual(await last(unseen), { result: "still_owed" });
    assert.deepEqual(unseen.log.events.map((event) => [event.data.reason, event.data.nodeExecutionId]), [["not_visible", "nx-2"]]);
    // A session that is visible by then is ended, and nothing is reported.
    const visible = world();
    visible.statuses.set(`session-${AGENT_SESSION}`, "Running");
    assert.deepEqual(await last(visible), { result: "ended" });
    assert.deepEqual(visible.log.events.filter((event) => event.eventType === "workflow.agent_end_failed"), []);
});
