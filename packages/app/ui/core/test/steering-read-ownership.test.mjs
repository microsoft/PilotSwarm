import test from "node:test";
import assert from "node:assert/strict";
import { createInitialState, createStore, appReducer, PilotSwarmUiController, linkSessionSteering } from "../src/index.js";
import { ApiClient } from "../../../../sdk/api/src/api-client.js";
import { HttpApiTransport } from "../../../../sdk/api/src/http-api-transport.js";

function harness(transport) {
    const store = createStore(appReducer, createInitialState());
    store.dispatch({ type: "sessions/loaded", sessions: [{ sessionId: "s" }] });
    store.dispatch({ type: "sessions/selected", sessionId: "s" });
    store.dispatch({ type: "auth/context", principal: { provider: "test", subject: "alice" } });
    return new PilotSwarmUiController({ store, transport });
}
test("F13: disposed panel releases shared cursor loading and peer continues from the same cursor", async () => {
    const held = Promise.withResolvers();
    const parent = harness({});
    const panel = harness({ listSteeringRequests: () => held.promise });
    const calls = [];
    const peer = harness({ listSteeringRequests: async (_id, options) => {
        calls.push(options); return { items: [], nextCursor: "advanced" };
    } });
    const dispose = linkSessionSteering(parent, panel, "s");
    const off = linkSessionSteering(parent, peer, "s");
    parent.dispatch({ type: "steering/page", sessionId: "s", page: { nextCursor: "next" } });
    const read = panel.loadSteeringRequests("s");
    assert.equal(peer.loadSteeringRequests("s", { reset: true }), read);
    assert.equal(calls.length, 0, "peers coalesce list operations, including discovery resets");
    dispose();
    panel.viewStopped = true;
    held.reject(Object.assign(new Error("View disposed"), { name: "AbortError" }));
    await read;
    assert.equal(peer.getState().steering.bySessionId.s.page.loading, false);
    assert.equal(peer.getState().steering.bySessionId.s.page.nextCursor, "next");
    await peer.loadSteeringRequests("s");
    assert.equal(calls[0].cursor, "next");
    peer.transport.listSteeringRequests = async () => ({ items: [], nextCursor: "first-page" });
    await peer.loadSteeringRequests("s", { reset: true });
    assert.equal(parent.getState().steering.bySessionId.s.page.nextCursor, "advanced");
    off();
});

test("N04: each history deadline aborts its actual fetch without aborting other session reads or writes", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const requests = [];
    const entered = [];
    const api = new ApiClient({ apiUrl: "http://example.test", fetchImpl: (url, options) => new Promise((resolve, reject) => {
        requests.push({ url, options, resolve });
        options.signal?.addEventListener("abort", () => reject(new TypeError("Aborted fetch")), { once: true });
        entered.shift()?.();
    }) });
    const nextRequest = () => new Promise(resolve => entered.push(resolve));
    const controller = harness(new HttpApiTransport({ api }));
    let ready = nextRequest();
    const unrelated = api.call("getSteeringRequest", { sessionId: "s", requestId: "r" });
    await ready;
    ready = nextRequest();
    const write = api.call("sendMessage", { sessionId: "s", prompt: "Unrelated write" });
    await ready;
    for (let i = 0; i < 2; i++) {
        ready = nextRequest();
        const load = controller.loadPromptHistory("s", { more: i > 0 });
        await ready;
        t.mock.timers.tick(5000);
        await load;
        assert.equal(requests.at(-1).options.signal.aborted, true);
        assert.equal(controller.getState().promptHistory.bySessionId.s.scan.partial, true);
        assert.equal(requests[0].options.signal.aborted, false);
        assert.equal(requests[1].options.signal, undefined);
    }
    for (const request of requests.slice(0, 2)) request.resolve(new Response(JSON.stringify({ ok: true, result: {} })));
    await Promise.all([unrelated, write]);
    assert.equal(api.readRequests.size, 0);
});

test("session stats guidance action reads authorized receipts without navigating another session", async () => {
    const held = Promise.withResolvers();
    const controller = harness({ listSteeringRequests: () => held.promise });
    controller.getState().sessionStats = { bySessionId: { s: { steeringStats: { data: {} } } } };
    const read = controller.openSteeringHistory();
    controller.dispatch({ type: "sessions/selected", sessionId: "other" });
    held.resolve({ items: [{ sessionId: "s", requestId: "r", revision: 1, sequence: 1, text: "Retained" }], nextCursor: null });
    await read;
    assert.equal(controller.getState().ui.modal, null);
    controller.dispatch({ type: "sessions/selected", sessionId: "s" });
    await controller.openSteeringHistory();
    assert.equal(controller.getState().ui.modal.type, "steeringReceipts");
    assert.equal(controller.getState().ui.modal.sessionId, "s");
});
