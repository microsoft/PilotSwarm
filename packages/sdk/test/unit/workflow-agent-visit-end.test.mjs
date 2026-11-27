import test from "node:test";
import assert from "node:assert/strict";
import { endWorkflowAgentChild, workflowAgentSessionId } from "../../dist/workflow/runtime.js";

// Issue I1: the end of a visit of a state that continues its session (session: continue) stops the visit's running turn
// for a time limit, a cancel, and a run that is stopping or ended, but not for its agent's own result while the run is
// active: that turn goes on to write its reply and ends by itself, so its snapshot (the session's memory) is committed.

const CHILD = workflowAgentSessionId("run-1", "talk");

function fixture({ winner, run, endSentAt = null }) {
    const stops = [];
    const events = [];
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
    };
    const client = { getStatus: async () => ({ status: "Running" }), enqueueEvent: async () => {} };
    const stopTurn = async (sessionId, _reason, requestId) => { stops.push([sessionId, requestId]); };
    return { store, client, stopTurn, stops, events };
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

for (const [label, winner, run, requestId] of [
    ["a time limit or a cancel of the visit", "controller", { status: "running", stop: null }, "workflow-cycle-stop:nx-1"],
    ["the agent's own result while the run is stopping", "agent", { status: "running", stop: { deadlineAt: new Date() } }, "workflow-cycle-stop:nx-1"],
    ["the agent's own result after the run ended", "agent", { status: "completed", stop: null }, "workflow-cycle-stop:nx-1"],
]) {
    test(`${label}: the visit's turn is stopped`, async () => {
        const f = fixture({ winner, run });
        await endWorkflowAgentChild(f.store, f.client, "nx-1", { stopTurn: f.stopTurn });
        assert.deepEqual(f.stops, [[CHILD, requestId]]);
    });
}

test("a stale send after a cancelled visit still asks for its own Stop", async () => {
    const f = fixture({ winner: "controller", run: { status: "running", stop: null }, endSentAt: "2026-11-27T00:00:00Z" });
    await endWorkflowAgentChild(f.store, f.client, "nx-1", { stopTurn: f.stopTurn, afterSpawn: true });
    assert.deepEqual(f.stops, [[CHILD, "workflow-cycle-stop:nx-1:sent"]]);
});
