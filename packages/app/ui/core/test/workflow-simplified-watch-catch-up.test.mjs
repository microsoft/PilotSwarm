// r4 C04 (usability re-test on live data): an agent node's Log showed visit 1 with only its first two Workflow lines and
// visit 2 with none, while the graph (the read model) was current. The Workflow's events stopped at its first load: the
// tab's watch of a Workflow ends while its list or another view is shown and starts again when the Workflow is shown,
// and a watch that started again only kept a history already loaded (ensureSessionHistory without force), so the events
// of the time between were never read. A Workflow that then stays still (ux-facts waits 15 minutes) pushes nothing more.
// Now a watch that starts subscribes and then reads the events after the last one loaded, as the active session does.
//
// Run: node --test packages/app/ui/core/test/workflow-simplified-watch-catch-up.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { PilotSwarmUiController, appReducer, buildHistoryModel, createInitialState, createStore } from "../src/index.js";

const OWNER = "08c4524a-0000-4000-8000-000000000001";
const WF = "6d32a9b0-45fc-b762-4352-957eb75db1a5";
const event = (seq, eventType, data) => ({ sessionId: WF, seq, eventType, createdAt: new Date(Date.parse("2026-11-06T16:39:47.000Z") + seq * 1000).toISOString(),
    data: { runId: "run-r4", stateId: "fact", ...data } });
const SERVER = [
    event(1, "workflow.state_started", { nodeExecutionId: "nx-1", step: 2 }),
    event(2, "workflow.agent_spawned", { nodeExecutionId: "nx-1", childSessionId: "owner-1", session: "continue", cycle: 1 }),
    event(3, "workflow.state_completed", { nodeExecutionId: "nx-1", step: 2, outcome: "success" }),
    event(4, "workflow.state_started", { nodeExecutionId: "nx-2", step: 4 }),
    event(5, "workflow.agent_spawned", { nodeExecutionId: "nx-2", childSessionId: "owner-1", session: "continue", cycle: 2 }),
];
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness() {
    const reads = [];
    const subscriptions = [];
    const transport = {
        async getSessionEvents(sessionId, afterSeq, limit) {
            reads.push({ sessionId, afterSeq, limit });
            return SERVER.filter(item => item.sessionId === sessionId && item.seq > Number(afterSeq || 0)).slice(0, limit);
        },
        subscribeSession(sessionId, handler) {
            const subscription = { sessionId, handler, open: true };
            subscriptions.push(subscription);
            return () => { subscription.open = false; };
        },
    };
    const store = createStore(appReducer, createInitialState());
    const controller = new PilotSwarmUiController({ store, transport });
    store.dispatch({ type: "sessions/loaded", sessions: [
        { sessionId: OWNER, title: "Chat", status: "idle" },
        { sessionId: WF, title: "Workflow: ux-facts", status: "running", sessionKind: "workflow", parentSessionId: OWNER },
    ] });
    store.dispatch({ type: "sessions/selected", sessionId: OWNER });
    // The Workflow's history as its first load left it: visit 1 started and its session spawned.
    store.dispatch({ type: "history/set", sessionId: WF, history: { ...buildHistoryModel(SERVER.slice(0, 2), { requestedLimit: 300 }), lastSeq: 2 } });
    return { controller, store, reads, subscriptions };
}
const seqs = store => store.getState().history.bySessionId.get(WF).events.map(item => item.seq);

test("a watch that starts again reads the events of the time it was not watched", async () => {
    const { controller, store, reads, subscriptions } = harness();
    const first = controller.watchWorkflow(WF);
    await settle();
    first(); // the tab shows the Workflows list: the watch ends, and the run goes on (events 3 to 5 are stored, not pushed)
    assert.equal(subscriptions[0].open, false);
    const again = controller.watchWorkflow(WF);
    await settle();
    assert.deepEqual(seqs(store), [1, 2, 3, 4, 5]);
    assert.ok(reads.some(read => read.sessionId === WF && read.afterSeq === 2), "it read after the last event loaded");
    assert.equal(subscriptions.at(-1).open, true, "and it is subscribed again");
    again();
});

test("a pushed event and the read of the same event are merged once", async () => {
    const { controller, store, subscriptions } = harness();
    const stop = controller.watchWorkflow(WF);
    subscriptions.at(-1).handler(SERVER[2]);
    await settle();
    assert.deepEqual(seqs(store), [1, 2, 3, 4, 5]);
    stop();
});
