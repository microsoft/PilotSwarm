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

function recoveryHarness(transport, canWrite = true) {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s", status: "running" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s" });
    store.dispatch({ type: "ui/prompt", prompt: "Guidance" });
    store.dispatch({ type: "steering/stateLoaded", sessionId: "s", windowSeq: 1,
        state: { supported: true, recovering: true, steerable: false, canWrite, expectedTarget: null } });
    const controller = new PilotSwarmUiController({ store, transport });
    return { store, controller };
}

test("a recovering open event never grants a read-only viewer steering permission", async () => {
    let reads = 0;
    const h = recoveryHarness({
        getSessionSteeringState: async () => {
            reads++;
            return { supported: true, recovering: false, steerable: false, canWrite: false,
                expectedTarget: "target-open", windowSeq: 2 };
        },
        listSteeringRequests: async () => ({ items: [], nextCursor: null }),
    }, false);
    h.controller.reconcileSteeringEvent("s", { seq: 2, eventType: "session.steering_window_changed",
        data: { schemaVersion: 1, state: "open", expectedTarget: "target-open" } });
    await h.controller.refreshSteering("s");
    assert.equal(reads, 1);
    assert.equal(selectSteeringComposer(h.store.getState()).enabled, false);
    assert.equal(h.store.getState().steering.bySessionId.s.state.canWrite, false);
});

test("a delayed recovery state read cannot reopen the target closed by a newer event", async () => {
    const response = Promise.withResolvers();
    const h = recoveryHarness({
        getSessionSteeringState: () => response.promise,
        listSteeringRequests: async () => ({ items: [], nextCursor: null }),
    });
    h.controller.reconcileSteeringEvent("s", { seq: 2, eventType: "session.steering_window_changed",
        data: { schemaVersion: 1, state: "open", expectedTarget: "target-open" } });
    h.controller.reconcileSteeringEvent("s", { seq: 3, eventType: "session.steering_window_changed",
        data: { schemaVersion: 1, state: "closed", expectedTarget: null, reason: "stopped" } });
    response.resolve({ supported: true, recovering: false, steerable: true, canWrite: true,
        expectedTarget: "target-open", windowSeq: 2 });
    await h.controller.refreshSteering("s");
    const current = h.store.getState().steering.bySessionId.s;
    assert.equal(current.windowSeq, 3);
    assert.equal(current.state.expectedTarget, null);
    assert.equal(selectSteeringComposer(h.store.getState()).enabled, false);
});

test("late recovery discovery cannot reconstruct receipt grants after access is revoked", async () => {
    const response = Promise.withResolvers();
    const h = recoveryHarness({
        getSessionSteeringState: () => response.promise,
        listSteeringRequests: async () => ({ items: [{
            schemaVersion: 1, sessionId: "s", requestId: "late-request", revision: 1,
            text: "private retained guidance", actions: { canWithdraw: true, canSendAsNewMessage: true },
        }], nextCursor: null }),
    });
    h.controller.reconcileSteeringEvent("s", { seq: 2, eventType: "session.steering_window_changed",
        data: { schemaVersion: 1, state: "open", expectedTarget: "target-open" } });
    h.store.dispatch({ type: "steering/accessLost", sessionId: "s" });
    response.resolve({ supported: true, recovering: false, steerable: true, canWrite: true,
        expectedTarget: "target-open", windowSeq: 2 });
    await h.controller.refreshSteering("s");
    const current = h.store.getState().steering.bySessionId.s;
    assert.equal(current.accessLost, true);
    assert.deepEqual(current.receipts, {});
    assert.equal(selectSteeringComposer(h.store.getState()).enabled, false);
});
