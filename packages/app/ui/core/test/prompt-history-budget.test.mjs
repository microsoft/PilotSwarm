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

test("a full non-progressing history page is a disclosed partial failure, not authoritative exhaustion", async () => {
    let reads = 0;
    const { controller, store } = harness(async () => {
        reads++;
        return Array.from({ length: 100 }, (_, index) => ({ sessionId: "s", seq: 100 - index, eventType: "user.message",
            data: { content: `Other ${index}`, sender: { kind: "user", provider: "test", subject: "bob" } } }));
    });
    await controller.loadPromptHistory("s");
    assert.equal(reads, 2, "the observed repeated cursor must stop the scan, without exhausting the read budget");
    const scan = store.getState().promptHistory.bySessionId.s.scan;
    assert.equal(scan.partial, true, "lack of cursor progress does not prove all earlier inputs were searched");
    assert.equal(scan.exhausted, false);
    assert.equal(scan.loading, false);
    assert.equal(typeof scan.error, "string");
    assert(scan.error.length > 0);
});

test("another ordinary history load awaits the already-issued read rather than returning prematurely", async () => {
    const response = Promise.withResolvers();
    let reads = 0;
    let secondFinished = false;
    const { controller, store } = harness(() => { reads++; return response.promise; });
    const first = controller.loadPromptHistory("s");
    const second = controller.loadPromptHistory("s").then(() => { secondFinished = true; });
    try {
        await Promise.resolve();
        assert.equal(reads, 1);
        assert.equal(secondFinished, false, "the cache loading marker must not bypass the in-flight promise");
    } finally {
        response.resolve([{ sessionId: "s", seq: 1, eventType: "user.message",
            data: { content: "Own input", sender: { kind: "user", provider: "test", subject: "alice" } } }]);
        await Promise.all([first, second]);
    }
    assert.deepEqual(selectPromptHistory(store.getState()), ["Own input"]);
});

test("changing canonical viewer identity clears completed scan state and searches only the new viewer's inputs", async () => {
    let reads = 0;
    const { controller, store } = harness(async () => {
        reads++;
        const subject = store.getState().auth.principal.subject;
        return [{ sessionId: "s", seq: reads, eventType: "user.message",
            data: { content: `${subject} input`, sender: { kind: "user", provider: "test", subject } } }];
    });
    await controller.loadPromptHistory("s");
    assert.deepEqual(selectPromptHistory(store.getState()), ["alice input"]);
    store.dispatch({ type: "auth/context", principal: { provider: "test", subject: "bob" } });
    assert.deepEqual(selectPromptHistory(store.getState()), []);
    await controller.loadPromptHistory("s");
    assert.equal(reads, 2);
    assert.deepEqual(selectPromptHistory(store.getState()), ["bob input"]);
});
