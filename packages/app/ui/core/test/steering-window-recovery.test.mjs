import test from "node:test";
import assert from "node:assert/strict";
import { createStore, createInitialState, appReducer, PilotSwarmUiController, selectSteeringComposer } from "../src/index.js";

for (const initial of [
    { supported: true, recovering: true },
    { supported: false, recovering: false },
]) test(`a newer open window repairs ${initial.recovering ? "recovering" : "unknown support"} without navigation`, async () => {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s", status: "running" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s" });
    store.dispatch({ type: "ui/prompt", prompt: "Guidance" });
    store.dispatch({ type: "steering/stateLoaded", sessionId: "s", windowSeq: 1,
        state: { ...initial, steerable: false, canWrite: true, expectedTarget: null } });
    let reads = 0;
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const controller = new PilotSwarmUiController({ store, transport: {
        getSessionSteeringState: async () => { reads++; return pending; },
        listSteeringRequests: async () => ({ items: [], nextCursor: null }),
    } });
    const event = { seq: 2, eventType: "session.steering_window_changed",
        data: { schemaVersion: 1, state: "open", expectedTarget: "new" } };
    controller.reconcileSteeringEvent("s", event);
    controller.reconcileSteeringEvent("s", event);
    assert.equal(reads, 1);
    assert.equal(selectSteeringComposer(store.getState()).enabled, false);
    release({ supported: true, recovering: false, steerable: true, canWrite: true, expectedTarget: "new", windowSeq: 2 });
    await controller.refreshSteering("s");
    assert.equal(selectSteeringComposer(store.getState()).enabled, true);
    assert.equal(reads, 1);
});
