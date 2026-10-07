import test from "node:test";
import assert from "node:assert/strict";
import { createStore, createInitialState, appReducer, PilotSwarmUiController } from "../src/index.js";

function harness() {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "a" }, { sessionId: "b" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "a" });
    const controller = new PilotSwarmUiController({ store, transport: {} });
    return { store, controller };
}
test("a retired view silently consumes network TypeErrors while a live view still reports them", async () => {
    const { store, controller } = harness();
    let reject;
    const pending = new Promise((_resolve, no) => { reject = no; });
    controller.backgroundRead(pending, "a", "History failed");
    store.dispatch({ type: "sessions/selected", sessionId: "b" });
    reject(new TypeError("Fetch API cannot load due to access control checks"));
    await Promise.resolve();
    assert.equal(store.getState().ui.statusText, "");
    controller.backgroundRead(Promise.reject(new TypeError("Network offline")), "b", "History failed");
    await Promise.resolve();
    assert.match(store.getState().ui.statusText, /Network offline/);
});
test("stopped controllers consume retired catalog errors without starting a new poll", async () => {
    const { controller, store } = harness();
    controller.viewStopped = true;
    controller.backgroundRead(Promise.reject(new TypeError("Navigation aborted catalog")), null, "Catalog failed");
    await Promise.resolve();
    assert.doesNotMatch(store.getState().ui.statusText, /aborted catalog/);
    await controller.refreshSessions();
    assert.equal(controller.catalogTimer, null);
});
