import test from "node:test";
import assert from "node:assert/strict";
import { endWorkflowV2AgentChild, endWorkflowV2RunAgents, registerWorkflowV2, WORKFLOW_V2_ACTIVITIES } from "../../dist/workflow/v2/runtime.js";

// Adversarial review WFO-2 (TLC agent.exhausted-orphan): an agent state's child created after its state was decided,
// when every attempt to record the spawn failed, is ended: by the spawn's failure and by the run's cleanup.

/** One agent invocation whose end was marked sent while its child did not exist (NotFound) after a spawn attempt began. */
function world({ childStatus = "Running", spawnAttempts = 2, endChildStatus = "NotFound" } = {}) {
    const invocation = { nodeExecutionId: "nx-1", runId: "run-1", workflowSessionId: "wf-1", childSessionId: "child-1", spawnAttempts,
        endRequested: "cancel", endSentAt: new Date("2026-11-04T07:00:00Z"), endChildStatus };
    const log = { enqueued: [], events: [], remarked: [] };
    const store = {
        listOwedAgentInvocations: async (_runId, after) => (after === null && invocation.endChildStatus === "NotFound" ? [{ ...invocation }] : []),
        readNodeExecution: async () => ({ nodeExecutionId: "nx-1", runId: "run-1", nodeType: "agent", state: "completed", winner: "deadline", outcome: "timed_out", nodeId: "review", ordinal: 1 }),
        recordAgentEnd: async () => ({ invocation: { ...invocation } }),
        readAgentInvocation: async () => ({ ...invocation }),
        markAgentEndSent: async () => ({ marked: false, invocation: { ...invocation } }),
        remarkAgentEndSent: async (id, status) => {
            if (status === "NotFound" || invocation.endChildStatus !== "NotFound") return { remarked: false };
            invocation.endChildStatus = status;
            log.remarked.push([id, status]);
            return { remarked: true };
        },
        recordSessionEvents: async (_id, events) => { log.events.push(...events.map(event => event.eventType)); },
        readRun: async () => ({ runId: "run-1", workflowSessionId: "wf-1", mode: "live", status: "running" }),
        completeNode: async () => ({ won: false }),
    };
    const client = {
        getStatus: async () => ({ status: childStatus }),
        enqueueEvent: async (instance, queue, data) => { log.enqueued.push([instance, JSON.parse(data).cmd]); },
    };
    return { store, client, log, invocation };
}

test("the run's cleanup sends the end again to a child created after its end found no session, then owes it no more", async () => {
    const w = world();
    await endWorkflowV2RunAgents(w.store, w.client, "run-1");
    assert.deepEqual(w.log.enqueued, [["session-child-1", "cancel"]]);
    assert.deepEqual(w.log.remarked, [["nx-1", "Running"]]);
    assert.ok(w.log.events.includes("workflow.agent_ended"));
    // Owed no more: the next cleanup sends nothing.
    await endWorkflowV2RunAgents(w.store, w.client, "run-1");
    assert.equal(w.log.enqueued.length, 1);
});

test("a child still not created stays owed; nothing is sent", async () => {
    const w = world({ childStatus: "NotFound" });
    await endWorkflowV2RunAgents(w.store, w.client, "run-1");
    assert.deepEqual(w.log.enqueued, []);
    assert.deepEqual(w.log.remarked, []);
    assert.equal(w.invocation.endChildStatus, "NotFound");
});

/** The agent state activities over a world's fake store. */
function activitiesOf(w) {
    const activities = new Map();
    registerWorkflowV2({ registerActivity: (name, fn) => activities.set(name, fn), registerOrchestrationVersioned: () => {} }, {
        store: w.store, catalog: {}, enabled: () => true,
        resolveToolBinding: async () => null, openToolExecutor: async () => { throw new Error("no tools"); },
        authorizeParentNotification: async () => true, notifyParent: async () => {}, deleteSession: async () => {},
    });
    return activities;
}
const failSpawn = w => activitiesOf(w).get(WORKFLOW_V2_ACTIVITIES.agentSpawnFailed)(
    { getClient: () => w.client }, { runId: "run-1", nodeExecutionId: "nx-1", controllerInstanceId: "ctl-1", cause: "store down" });

test("when every spawn attempt failed, the spawn's failure ends a child an attempt created", async () => {
    const w = world();
    await failSpawn(w);
    assert.deepEqual(w.log.enqueued, [["session-child-1", "cancel"]]);
});

// Verification of WFO-2 (D-T5): the end is sent again after a spawn only when it was first marked sent while the child
// did not exist (NotFound); a child that already got its end (it existed then) is not sent another.
test("D-T5: a running child that already got its end is not sent another, by the spawn's failure or by an end after a spawn", async () => {
    for (const endChildStatus of ["Running", "Completed"]) {
        const w = world({ endChildStatus });
        await failSpawn(w);
        assert.deepEqual(w.log.enqueued, [], endChildStatus);
        assert.deepEqual(await endWorkflowV2AgentChild(w.store, w.client, "nx-1", { afterSpawn: true }), { end: "cancel", sent: false });
        assert.deepEqual(w.log.enqueued, [], endChildStatus);
        assert.deepEqual(w.log.remarked, []);
    }
    // A child whose end found no session still gets it after a spawn.
    const w = world();
    assert.deepEqual(await endWorkflowV2AgentChild(w.store, w.client, "nx-1", { afterSpawn: true }), { end: "cancel", sent: true });
    assert.deepEqual(w.log.enqueued, [["session-child-1", "cancel"]]);
});
