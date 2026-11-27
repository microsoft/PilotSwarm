import test from "node:test";
import assert from "node:assert/strict";
import { endWorkflowAgentChild, endWorkflowRunAgentSessions, workflowAgentSessionId } from "../../dist/workflow/runtime.js";

// Issue I1: the end of a visit of a state that continues its session (session: continue) stops the visit's running turn
// for a time limit, a cancel, and a run that is stopping or ended, but not for its agent's own result while the run is
// active: that turn goes on to write its reply and ends by itself, so its snapshot (the session's memory) is committed.

const CHILD = workflowAgentSessionId("run-1", "talk");

function fixture({ winner, run, endSentAt = null }) {
    const stops = [];
    const events = [];
    const order = [];
    const invocation = { nodeExecutionId: "nx-1", runId: "run-1", workflowSessionId: "wf-1", childSessionId: CHILD, endSentAt,
        endRequested: null, endChildStatus: endSentAt ? "AgentSessionContinues" : null, spawnAttempts: 1 };
    const node = { nodeExecutionId: "nx-1", nodeType: "agent", state: "completed", winner, outcome: winner === "agent" ? "again" : "timed_out", nodeId: "talk" };
    const store = {
        readNodeExecution: async () => node,
        recordAgentEnd: async (_nx, end) => { invocation.endRequested ??= end; return { invocation: { ...invocation } }; },
        readRun: async () => ({ runId: "run-1", workflowSessionId: "wf-1", ...run }),
        markAgentEndSent: async (_nx, status) => { invocation.endSentAt ??= "2026-11-27T00:00:00Z"; invocation.endChildStatus = status; return { marked: true }; },
        markContinuedSessionEnded: async (_nx, status) => { invocation.endChildStatus = status; return { marked: true }; },
        readAgentInvocationByChild: async () => ({ ...invocation }),
        sessionHasSpawnAttempt: async () => true,
        recordSessionEvents: async (_id, list) => { events.push(...list); },
        // The run's cleanup: no visit's own end is owed; the session continued across its visits.
        listOwedAgentInvocations: async () => (invocation.endSentAt === null ? [{ ...invocation }] : []),
        listAgentInvocations: async () => [{ ...invocation }],
        readSessionLink: async () => null,
        listChildWorkflows: async () => [],
        listBareChildWorkflowClaims: async () => [],
    };
    const client = { getStatus: async () => ({ status: "Running" }),
        enqueueEvent: async (instance, _queue, data) => { order.push(["cmd", instance, JSON.parse(data).cmd]); } };
    const stopTurn = async (sessionId, _reason, requestId) => { stops.push([sessionId, requestId]); order.push(["stop", sessionId, requestId]); };
    return { store, client, stopTurn, stops, events, order };
}

const cycleEnded = events => events.filter(event => event.eventType === "workflow.agent_cycle_ended").map(event => event.data.turnStopped);

test("the agent's own result while the run is active: no Stop; the turn ends by itself", async () => {
    const f = fixture({ winner: "agent", run: { status: "running", stop: null } });
    assert.deepEqual(await endWorkflowAgentChild(f.store, f.client, "nx-1", { stopTurn: f.stopTurn }), { end: "done", sent: false });
    assert.deepEqual(f.stops, []);
    assert.deepEqual(cycleEnded(f.events), [false]);
});

test("the agent's own result, checked again after a spawn's send: still no Stop", async () => {
    const f = fixture({ winner: "agent", run: { status: "running", stop: null }, endSentAt: "2026-11-27T00:00:00Z" });
    await endWorkflowAgentChild(f.store, f.client, "nx-1", { stopTurn: f.stopTurn, afterSpawn: true });
    assert.deepEqual(f.stops, []);
});

for (const [label, winner, run, sessionEnds] of [
    ["a time limit or a cancel of the visit", "controller", { status: "running", stop: null }, false],
    ["the agent's own result while the run is stopping", "agent", { status: "running", stop: { deadlineAt: new Date() } }, true],
    ["the agent's own result after the run ended", "agent", { status: "completed", stop: null }, true],
]) {
    test(`${label}: the visit's turn is stopped${sessionEnds ? ", and the session's end stops its running turn first" : ""}`, async () => {
        const f = fixture({ winner, run });
        await endWorkflowAgentChild(f.store, f.client, "nx-1", { stopTurn: f.stopTurn });
        assert.deepEqual(f.order, [["stop", CHILD, "workflow-cycle-stop:nx-1"],
            ...(sessionEnds ? [["stop", CHILD, `workflow-session-stop:${CHILD}`], ["cmd", `session-${CHILD}`, winner === "agent" ? "done" : "cancel"]] : [])]);
    });
}

// Review R1-1: a visit its agent completed while the run was active is settled with no Stop, and its turn may still write
// its reply when the run ends (or a later visit's Stop, which names that visit, is not this turn's). The run's cleanup and a
// recover stop whichever turn of the session runs before they send the session's end.
test("a completed visit already settled without a Stop: the run's end stops the session's running turn before its end", async () => {
    const f = fixture({ winner: "agent", run: { status: "running", stop: null } });
    await endWorkflowAgentChild(f.store, f.client, "nx-1", { stopTurn: f.stopTurn });
    assert.deepEqual(f.order, []);
    f.store.readRun = async () => ({ runId: "run-1", workflowSessionId: "wf-1", status: "cancelled", stop: null });
    await endWorkflowRunAgentSessions(f.store, f.client, "run-1", { stopTurn: f.stopTurn });
    assert.deepEqual(f.order, [["stop", CHILD, `workflow-session-stop:${CHILD}`], ["cmd", `session-${CHILD}`, "done"]]);
    // Once: a later look sends neither again.
    await endWorkflowRunAgentSessions(f.store, f.client, "run-1", { stopTurn: f.stopTurn });
    assert.equal(f.order.length, 2);
});

test("a stale send after a cancelled visit still asks for its own Stop", async () => {
    const f = fixture({ winner: "controller", run: { status: "running", stop: null }, endSentAt: "2026-11-27T00:00:00Z" });
    await endWorkflowAgentChild(f.store, f.client, "nx-1", { stopTurn: f.stopTurn, afterSpawn: true });
    assert.deepEqual(f.stops, [[CHILD, "workflow-cycle-stop:nx-1:sent"]]);
});
