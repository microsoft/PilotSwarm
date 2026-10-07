import test from "node:test";
import assert from "node:assert/strict";
import { ApiClient } from "../src/api-client.js";

test("session retirement cancels only that session's reads, not writes or another session", async () => {
    const requests = [];
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const api = new ApiClient({ apiUrl: "http://example.test", fetchImpl: (_url, options) => new Promise((resolve, reject) => {
        requests.push({ options, resolve, reject });
        if (requests.length === 3) entered();
        options.signal?.addEventListener("abort", () => reject(new TypeError("Fetch rejected by WebKit")), { once: true });
    }) });
    const first = api.call("getSessionEventsBefore", { sessionId: "a" });
    const other = api.call("getSessionEventsBefore", { sessionId: "b" });
    const write = api.call("sendMessage", { sessionId: "a", prompt: "Keep working" });
    const firstResult = assert.rejects(first, error => error.name === "AbortError");
    await ready;
    api.abortReadRequests("a");
    await firstResult;
    assert.equal(requests.filter(request => request.options.signal?.aborted).length, 1);
    assert.equal(requests.find(request => request.options.method === "POST").options.signal, undefined);
    for (const request of requests.filter(request => !request.options.signal?.aborted)) {
        request.resolve(new Response(JSON.stringify({ ok: true, result: [] }), { headers: { "content-type": "application/json" } }));
    }
    await Promise.all([other, write]);
});

test("stop aborts a pending system catalog read and start permits a fresh read", async () => {
    let entered;
    const ready = new Promise(resolve => { entered = resolve; });
    const api = new ApiClient({ apiUrl: "http://example.test", fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new TypeError("Navigation fetch failure")), { once: true });
        entered();
    }) });
    const read = api.call("listSessionsPage", { systemFilter: "only" });
    const rejected = assert.rejects(read, error => error.name === "AbortError");
    await ready;
    await api.stop();
    await rejected;
    await api.start();
    api.fetchImpl = async () => new Response(JSON.stringify({ ok: true, result: [] }));
    assert.deepEqual(await api.call("listSessionsPage", { systemFilter: "only" }), []);
});
