import test from "node:test";
import assert from "node:assert/strict";
import { endWorkflowRunAgentSessions, workflowAgentSessionId } from "../../dist/workflow/runtime.js";

// Review G3 (formal finding.g3-other-chat): a run's end looks at each continued session (session: continue) on its own. A
// session whose session status cannot be read does not keep the others from being ended, and the call fails after them, so
// its activity (or the next recover) looks again. The visits' own children are ended first; their failure does not keep
// the sessions from being looked at either.

const RUN = "run-g3";
const A = workflowAgentSessionId(RUN, "first");
const B = workflowAgentSessionId(RUN, "second");

function fixture({ ownChildrenFail = false } = {}) {
    const invocations = new Map([
        [A, { nodeExecutionId: "nx-a", runId: RUN, workflowSessionId: "wf-1", childSessionId: A, endSentAt: "2026-11-09T09:00:00Z", endRequested: "done",
            endChildStatus: "AgentSessionContinues", spawnAttempts: 1 }],
        [B, { nodeExecutionId: "nx-b", runId: RUN, workflowSessionId: "wf-1", childSessionId: B, endSentAt: "2026-11-09T09:00:00Z", endRequested: "done",
            endChildStatus: "AgentSessionContinues", spawnAttempts: 1 }],
    ]);
    const enqueued = [];
    const store = {
        readRun: async () => ({ runId: RUN, workflowSessionId: "wf-1", status: "cancelled", stop: null }),
        listOwedAgentInvocations: async () => {
            if (ownChildrenFail) throw new Error("the owed children could not be read");
            return [];
        },
        // A first: its look fails, B's must still run.
        listAgentInvocations: async () => [invocations.get(A), invocations.get(B)],
        readAgentInvocationByChild: async (child) => ({ ...invocations.get(child) }),
        readNodeExecution: async (nx) => ({ nodeExecutionId: nx, nodeType: "agent", state: "completed", winner: "agent", outcome: "said", nodeId: nx }),
        sessionHasSpawnAttempt: async () => true,
        recordAgentEnd: async () => ({}),
        markContinuedSessionEnded: async (nx, status) => {
            for (const invocation of invocations.values()) if (invocation.nodeExecutionId === nx) invocation.endChildStatus = status;
            return { marked: true };
        },
        recordSessionEvents: async () => {},
    };
    const client = {
        getStatus: async (instance) => {
            if (instance === `session-${A}`) throw new Error("the status of session A could not be read");
            return { status: "Running" };
        },
        enqueueEvent: async (instance, _queue, data) => { enqueued.push([instance, JSON.parse(data).cmd]); },
    };
    return { store, client, invocations, enqueued };
}

test("a session whose status cannot be read does not keep the next session from being ended; the call fails after it", async () => {
    const { store, client, invocations, enqueued } = fixture();
    await assert.rejects(endWorkflowRunAgentSessions(store, client, RUN), (error) => error.message.includes(A) && /were not ended yet/.test(error.message));
    assert.deepEqual(enqueued, [[`session-${B}`, "done"]]);
    assert.equal(invocations.get(B).endChildStatus, "AgentSessionEnded");
    assert.equal(invocations.get(A).endChildStatus, "AgentSessionContinues");
});

test("the sessions are looked at even when a visit's own child could not be ended; both failures are reported", async () => {
    const { store, client, invocations, enqueued } = fixture({ ownChildrenFail: true });
    await assert.rejects(endWorkflowRunAgentSessions(store, client, RUN),
        (error) => /the owed children could not be read/.test(error.message) && error.message.includes(A));
    assert.deepEqual(enqueued, [[`session-${B}`, "done"]]);
    assert.equal(invocations.get(B).endChildStatus, "AgentSessionEnded");
});
