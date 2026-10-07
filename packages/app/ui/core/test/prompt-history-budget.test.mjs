import test from "node:test";
import assert from "node:assert/strict";
import { createStore, createInitialState, appReducer, PilotSwarmUiController, selectPromptHistory } from "../src/index.js";

function harness(read) {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "auth/context", principal: { provider: "test", subject: "alice" } });
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s" });
    return { store, controller: new PilotSwarmUiController({ store, transport: { getSessionEventsBefore: read } }) };
}
test("mostly-other-writer history stops after three pages, reuses progress and discloses partial state", async () => {
    const cursors = [];
    const { controller, store } = harness(async (_sid, before) => {
        cursors.push(before);
        const max = before === Number.MAX_SAFE_INTEGER ? 1000 : before - 1;
        return Array.from({ length: 100 }, (_, i) => ({ sessionId: "s", seq: max - i, eventType: "user.message",
            data: { content: `Other ${max - i}`, sender: { kind: "user", provider: "test", subject: "bob" } } }));
    });
    await controller.loadPromptHistory("s");
    assert.equal(cursors.length, 3);
    assert.equal(store.getState().promptHistory.bySessionId.s.scan.partial, true);
    const cursor = store.getState().promptHistory.bySessionId.s.scan.beforeSeq;
    await controller.loadPromptHistory("s");
    assert.equal(cursors.length, 3, "selection must not repeat a partial scan");
    await controller.loadPromptHistory("s", { more: true });
    assert.equal(cursors[3], cursor);
    assert.equal(cursors.length, 6);
    assert.deepEqual(selectPromptHistory(store.getState()), []);
});
test("time budget stops a blocked read and ignores its late contents", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    let release;
    const { controller, store } = harness(() => new Promise(resolve => { release = resolve; }));
    const load = controller.loadPromptHistory("s");
    t.mock.timers.tick(5000);
    await load;
    assert.equal(store.getState().promptHistory.bySessionId.s.scan.partial, true);
    assert.equal(store.getState().promptHistory.bySessionId.s.scan.loading, false);
    release([{ sessionId: "s", seq: 1, eventType: "user.message", data: { content: "Late",
        sender: { kind: "user", provider: "test", subject: "alice" } } }]);
    await Promise.resolve();
    assert.deepEqual(selectPromptHistory(store.getState()), []);
});
