import test from "node:test";
import assert from "node:assert/strict";
import { appReducer, createInitialState, createStore, PilotSwarmUiController } from "../src/index.js";

function harness(transport) {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s1", status: "idle" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s1" });
    return { store, controller: new PilotSwarmUiController({ store, transport }) };
}

test("ordinary session attachment does not await optional steering discovery", async () => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    const { controller } = harness({});
    let attached = null;
    controller.refreshSteering = () => pending;
    controller.ensureSessionHistory = async () => null;
    controller.syncSessionDetail = async () => {};
    controller.attachActiveSession = id => { attached = id; };
    controller.ensureInspectorData = async () => {};
    controller.ensureCanvasSnapshot = async () => {};
    try {
        await controller.loadSession("s1");
        assert.equal(attached, "s1");
    } finally {
        release();
    }
});

test("a server without a steering-state DTO does not trigger speculative receipt requests", async () => {
    let lists = 0;
    const { controller, store } = harness({
        getSessionSteeringState: async () => ({}),
        listSteeringRequests: async () => { lists++; return { items: [] }; },
    });
    await controller.refreshSteering("s1");
    assert.equal(lists, 0);
    assert.equal(store.getState().steering.bySessionId.s1.state.steerable, false);
    assert.equal(store.getState().steering.bySessionId.s1.state.reason, "unsupported");
    assert.equal(store.getState().sessions.byId.s1.status, "idle");
});

test("audit-only steering discovery does not attempt its prohibited receipt-read path", async () => {
    let lists = 0;
    const { controller } = harness({
        getSessionSteeringState: async () => ({
            supported: false, steerable: false, reason: "unsupported", unsupportedReason: "authz_not_enforced",
        }),
        listSteeringRequests: async () => { lists++; return { items: [] }; },
    });
    await controller.refreshSteering("s1");
    assert.equal(lists, 0);
});
