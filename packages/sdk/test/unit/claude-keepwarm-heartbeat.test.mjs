/**
 * The Claude keep-warm heartbeat (R2): one ping 240000 ms after the start of the latest request or ping, at most 7 per idle
 * gap by default, replaying the session's latest Claude model call with `max_tokens` 0 and `stream` false, and each ping's
 * usage reported. The transport is a mocked fetch and the clock a mocked setTimeout and Date; no model is called.
 *
 * Run: node --test test/unit/claude-keepwarm-heartbeat.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    ByokRequestCompatibility,
    CLAUDE_KEEPWARM_INTERVAL_MS,
    CLAUDE_KEEPWARM_MAX_PINGS,
    CLAUDE_KEEPWARM_PING_TIMEOUT_MS,
    ClaudeKeepWarmHeartbeat,
    createCopilotClient,
    isClaudeKeepWarmEnabled,
    isClaudeModelName,
} from "../../dist/copilot-client.js";
import { SessionManager } from "../../dist/session-manager.js";
import { ModelProviderRegistry } from "../../dist/model-providers.js";

const MODEL_URL = "https://example.invalid/v1/messages";
const MODEL_REPLY = "data: model reply\n\n";

const modelBody = (extra = {}) => ({
    model: "claude-opus-4.5",
    max_tokens: 4096,
    stream: true,
    messages: [{ role: "user", content: "keep this prompt warm" }],
    ...extra,
});
const modelRequest = (body = modelBody(), url = MODEL_URL) => new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer test-token-not-a-secret" },
    body: JSON.stringify(body),
});
const context = (sessionId = "s1") => ({ sessionId, transport: "http", signal: new AbortController().signal });
const warmReply = (usage = {}, nano = 7) => new Response(JSON.stringify({
    usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0, ...usage },
    copilot_usage: { total_nano_aiu: nano },
}), { status: 200, headers: { "content-type": "application/json" } });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

function harness(t, options = {}) {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const h = { calls: [], pings: [], stops: [], respond: { ping: () => warmReply() } };
    t.mock.method(globalThis, "fetch", async (request, options) => {
        const body = await request.clone().text();
        h.calls.push({ request, options, url: request.url, headers: request.headers, body });
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = null; }
        if (parsed?.max_tokens === 0) return h.respond.ping(h.calls.filter(call => call.body.includes('"max_tokens":0')).length);
        return h.respond.model?.() ?? new Response(MODEL_REPLY, { headers: { "content-type": "text/event-stream" } });
    });
    h.handler = new ClaudeKeepWarmHeartbeat({
        ...options,
        onPingUsage: ping => { h.pings.push(ping); },
        onStop: event => { h.stops.push(event); },
    });
    // Send a request and read its reply to the end, as the CLI does; the timer arms when the body ends.
    h.send = async (body = modelBody(), ctx = context()) => {
        const request = modelRequest(body);
        const response = await h.handler.sendRequest(request, ctx);
        return { request, response, text: await response.text() };
    };
    h.tick = async ms => { t.mock.timers.tick(ms); await settle(); };
    return h;
}

test("a ping fires at 240000 ms and not before, then arms again", async t => {
    const h = harness(t);
    const { text, response } = await h.send();
    assert.equal(text, MODEL_REPLY, "the CLI's reply passes through unchanged");
    assert.equal(response.status, 200);
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS - 1);
    assert.equal(h.calls.length, 1);
    await h.tick(1);
    assert.equal(h.calls.length, 2);
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.pings.map(ping => ping.ping), [1, 2]);
    assert.deepEqual(h.stops, []);
});

// A model reply whose body the test ends when it chooses: the timer arms when the body ends.
function streamingReply() {
    let end;
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(MODEL_REPLY));
            end = () => controller.close();
        },
    });
    return { response: new Response(body, { headers: { "content-type": "text/event-stream" } }), end: () => end() };
}

test("the interval is counted from the request's start: a reply that streams 100 s gets its first ping 140 s after it ends", async t => {
    const h = harness(t);
    const reply = streamingReply();
    h.respond.model = () => reply.response;
    const response = await h.handler.sendRequest(modelRequest(), context());
    const text = response.text();
    await h.tick(100_000);
    reply.end();
    assert.equal(await text, MODEL_REPLY);
    await settle();
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS - 100_000 - 1);
    assert.equal(h.calls.length, 1, "no ping before 240 s from the request's start");
    await h.tick(1);
    assert.equal(h.calls.length, 2, "the first ping comes 140 s after the reply ended");
    assert.deepEqual(h.stops, []);
});

// Each case streams a reply for streamMs and then ends it; the cache lifetime's cutoff is 290 s after the request started.
for (const { title, streamMs, pinged } of [
    { title: "a reply that ends 290 s or more after its request started gets no ping: replay stops as cache-expired", streamMs: 290_000, pinged: false },
    { title: "a reply that ends after the interval but before the cutoff gets its ping as soon as it ends, not before", streamMs: 250_000, pinged: true },
    { title: "a reply that ends 295 s after its request started gets no ping: 10 s before the cache expires is too late", streamMs: 295_000, pinged: false },
]) {
    test(title, async t => {
        const h = harness(t);
        const reply = streamingReply();
        h.respond.model = () => reply.response;
        const response = await h.handler.sendRequest(modelRequest(), context());
        const text = response.text();
        await h.tick(streamMs);
        if (pinged) assert.equal(h.calls.length, 1, "no ping while the reply is still streaming");
        reply.end();
        assert.equal(await text, MODEL_REPLY);
        await settle();
        if (pinged) {
            await h.tick(1);
            assert.equal(h.calls.length, 2, "the ping goes out as soon as the reply ends");
            assert.deepEqual(h.stops, []);
        } else {
            assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "cache-expired", pings: 0 }]);
            await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
            assert.equal(h.calls.length, 1, "no ping");
        }
    });
}

test("a slow ping reply does not move the next ping: it comes the interval after the ping started, not after its reply", async t => {
    const h = harness(t);
    let release;
    h.respond.ping = n => (n === 1 ? new Promise(resolve => { release = resolve; }) : warmReply());
    await h.send();
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.equal(h.calls.length, 2, "ping 1 is sent");
    await h.tick(30_000);
    release(warmReply());
    await settle();
    assert.deepEqual(h.pings.map(ping => ping.ping), [1]);
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS - 30_000 - 1);
    assert.equal(h.calls.length, 2, "no second ping before the interval from ping 1's start");
    await h.tick(1);
    assert.equal(h.calls.length, 3, "the second ping comes the interval less 30 s after ping 1's reply");
    assert.deepEqual(h.stops, []);
});

test("the ping is the captured request with only max_tokens 0 and stream false, and its usage is reported", async t => {
    const h = harness(t);
    await h.send();
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    const [first, ping] = h.calls;
    assert.deepEqual(JSON.parse(ping.body), { ...JSON.parse(first.body), max_tokens: 0, stream: false });
    assert.equal(ping.url, MODEL_URL);
    assert.equal(ping.request.method, "POST");
    assert.equal(ping.headers.get("authorization"), "Bearer test-token-not-a-secret");
    assert.ok(ping.options.signal instanceof AbortSignal);
    assert.notEqual(ping.options.signal, first.options?.signal, "a ping has its own timeout");
    assert.deepEqual(h.pings, [{
        sessionId: "s1",
        model: "claude-opus-4.5",
        ping: 1,
        status: 200,
        usage: { input: 10005, output: 0, cacheRead: 10000, cacheWrite: 0 },
        totalNanoAiu: 7,
    }]);
});

test("a ping's input tokens include its cache read and cache write", async t => {
    const h = harness(t);
    h.respond.ping = () => warmReply({ input_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 7 });
    await h.send();
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.deepEqual(h.pings.map(ping => ping.usage), [{ input: 1010, output: 0, cacheRead: 1000, cacheWrite: 7 }]);
});

test("replay stops after 7 pings in one gap", async t => {
    const h = harness(t);
    await h.send();
    for (let i = 0; i < CLAUDE_KEEPWARM_MAX_PINGS + 3; i++) await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.equal(h.calls.length, 1 + CLAUDE_KEEPWARM_MAX_PINGS);
    assert.deepEqual(h.pings.map(ping => ping.ping), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "max-pings", pings: 7 }]);
});

test("a new request ends the gap: the count starts again and only one timer runs", async t => {
    const h = harness(t);
    await h.send();
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    await h.send(modelBody({ messages: [{ role: "user", content: "a later turn" }] }));
    const before = h.calls.length;
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.equal(h.calls.length, before + 1, "the earlier gap's timer was replaced, not kept");
    assert.deepEqual(h.pings.map(ping => ping.ping), [1, 2, 1]);
    assert.match(h.calls.at(-1).body, /a later turn/, "the newest request is the one replayed");
});

test("a ping in flight when a new request arrives is reported once and neither stops nor re-arms the new request", async t => {
    const h = harness(t);
    // The reply to ping 1 is held until the new request has been sent; later pings get theirs at once.
    let release;
    const held = new Promise(resolve => { release = resolve; });
    h.respond.ping = n => (n === 1 ? held : warmReply());
    await h.send();
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    await h.send(modelBody({ messages: [{ role: "user", content: "a turn during the ping" }] }));
    release(warmReply());
    await settle();
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.pings.map(ping => ping.ping), [1]);
    assert.deepEqual(h.stops, []);
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS - 1);
    assert.equal(h.calls.length, 3, "the late reply did not arm a second timer");
    await h.tick(1);
    assert.equal(h.calls.length, 4);
    const last = h.calls.at(-1).body;
    assert.equal(JSON.parse(last).max_tokens, 0);
    assert.match(last, /a turn during the ping/);
    assert.deepEqual(h.pings.map(ping => ping.ping), [1, 1]);
    assert.deepEqual(h.stops, []);
});

for (const reason of ["compaction_start", "compaction_complete", "model-change", "client-change", "abort", "close", "eviction"]) {
    test(`dropping a session for ${reason} stops its replay; the next request starts it again`, async t => {
        const h = harness(t);
        await h.send();
        assert.equal(h.handler.dropSession("s1", reason), true);
        assert.equal(h.handler.dropSession("s1", reason), false, "nothing left to drop");
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS * 3);
        assert.equal(h.calls.length, 1);
        assert.deepEqual(h.stops, [{ sessionId: "s1", reason, pings: 0 }]);
        await h.send(modelBody({ model: "claude-sonnet-4.5" }));
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
        assert.equal(JSON.parse(h.calls.at(-1).body).model, "claude-sonnet-4.5", "replay follows the model now in use");
        assert.deepEqual(h.pings.map(ping => ping.ping), [1]);
    });
}

test("releasing a warm session stops its replay for the reason released: its timer is gone and no usage row is written", async t => {
    const h = harness(t);
    const manager = new SessionManager(undefined, null, {});
    manager.heartbeats.set("heartbeat-client", h.handler);
    await h.send(modelBody(), context("s1"));
    await h.send(modelBody(), context("s2"));
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.deepEqual(h.pings.map(ping => `${ping.sessionId}:${ping.ping}`).sort(), ["s1:1", "s2:1"]);
    manager._forgetWarmSession("s1");
    assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "released", pings: 1 }]);
    assert.equal(h.pings.length, 2, "the release itself writes no usage row");
    for (let i = 0; i < 3; i++) await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.deepEqual(
        h.pings.map(ping => `${ping.sessionId}:${ping.ping}`).sort(),
        ["s1:1", "s2:1", "s2:2", "s2:3", "s2:4"],
        "s1's timer was cleared, so it pings no more; s2 goes on",
    );
});

test("dropping one session leaves another's replay running", async t => {
    const h = harness(t);
    await h.send(modelBody(), context("s1"));
    await h.send(modelBody(), context("s2"));
    h.handler.dropSession("s1", "close");
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.deepEqual(h.pings.map(ping => ping.sessionId), ["s2"]);
});

test("stopAll clears every timer and later requests are not kept warm", async t => {
    const h = harness(t);
    await h.send(modelBody(), context("s1"));
    await h.send(modelBody(), context("s2"));
    h.handler.stopAll();
    assert.deepEqual(h.stops.map(stop => [stop.sessionId, stop.reason]).sort(), [["s1", "shutdown"], ["s2", "shutdown"]]);
    await h.send(modelBody(), context("s1"));
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS * 3);
    assert.equal(h.calls.length, 3, "only the three model calls, no ping");
    assert.deepEqual(h.pings, []);
});

for (const [name, run] of [
    ["a gpt model", h => h.send(modelBody({ model: "gpt-5.4" }))],
    ["a model call with no session id", h => h.send(modelBody(), { transport: "http", signal: new AbortController().signal })],
    ["a call that is not over http", h => h.send(modelBody(), { sessionId: "s1", transport: "other", signal: new AbortController().signal })],
    ["a call that is not a model call", h => h.handler.sendRequest(modelRequest(modelBody(), "https://example.invalid/v1/models"), context()).then(response => response.text())],
]) {
    test(`${name} is passed through and never replayed`, async t => {
        const h = harness(t);
        await run(h);
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS * 3);
        assert.equal(h.calls.length, 1);
        assert.deepEqual(h.pings, []);
        assert.deepEqual(h.stops, []);
    });
}

test("a request that is not captured reaches the transport as the same request object", async t => {
    const h = harness(t);
    const request = modelRequest(modelBody({ model: "gpt-5.4" }));
    await h.handler.sendRequest(request, context());
    assert.equal(h.calls[0].request, request);
});

test("a model call that fails, or throws, leaves nothing to replay", async t => {
    const h = harness(t);
    h.respond.model = () => new Response("upstream error", { status: 500 });
    const failed = await h.send();
    assert.equal(failed.response.status, 500);
    assert.equal(failed.text, "upstream error");
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS * 2);
    assert.equal(h.calls.length, 1);
    h.respond.model = () => { throw new Error("socket closed"); };
    await assert.rejects(h.send(), /socket closed/);
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS * 2);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.pings, []);
});

for (const [status, reason] of [[401, "unauthorized"], [403, "forbidden"], [429, "rate-limited"], [400, "http-error"], [500, "http-error"]]) {
    test(`a ${status} reply stops replay with no retry`, async t => {
        const h = harness(t);
        h.respond.ping = () => new Response("{}", { status });
        await h.send();
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS * 3);
        assert.equal(h.calls.length, 2);
        assert.deepEqual(h.stops, [{ sessionId: "s1", reason, pings: 1 }]);
        assert.deepEqual(h.pings.map(ping => [ping.status, ping.usage]), [[status, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]]);
    });
}

test("a ping that cannot be sent stops replay with no retry", async t => {
    const h = harness(t);
    h.respond.ping = () => { throw new Error("socket closed"); };
    await h.send();
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS * 3);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "error", pings: 1 }]);
});

test("a ping that times out stops replay with the reason error, counts as the ping made, and writes no usage row", async t => {
    const h = harness(t);
    await h.send();
    // AbortSignal.timeout is replaced so the test can read the timeout the ping asks for and raise the TimeoutError itself.
    const timeouts = [];
    const timeout = new AbortController();
    t.mock.method(AbortSignal, "timeout", ms => { timeouts.push(ms); return timeout.signal; });
    h.respond.ping = () => {
        timeout.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        throw timeout.signal.reason;
    };
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.deepEqual(timeouts, [CLAUDE_KEEPWARM_PING_TIMEOUT_MS]);
    assert.equal(h.calls.at(-1).options.signal, timeout.signal, "the ping carries the timeout signal");
    assert.equal(timeout.signal.reason.name, "TimeoutError");
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS * 3);
    assert.equal(h.calls.length, 2, "no retry");
    assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "error", pings: 1 }]);
    assert.deepEqual(h.pings, [], "a ping with no reply is not reported as usage");
});

for (const [name, usage, reason] of [
    ["a cache write above 1% of the cache read", { cache_read_input_tokens: 1000, cache_creation_input_tokens: 11 }, "cache-miss"],
    ["a reply whose usage cannot be read", { input_tokens: "5" }, "usage-unreadable"],
]) {
    test(`${name} stops replay: the cache was not hit`, async t => {
        const h = harness(t);
        h.respond.ping = () => warmReply(usage);
        await h.send();
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
        assert.equal(h.calls.length, 2);
        assert.deepEqual(h.stops, [{ sessionId: "s1", reason, pings: 1 }]);
        assert.equal(h.pings.length, 1, "the ping that was made is still recorded");
    });
}

test("a cache write of exactly 1% of the cache read keeps replaying", async t => {
    const h = harness(t);
    h.respond.ping = () => warmReply({ cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 });
    await h.send();
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.equal(h.calls.length, 3);
    assert.deepEqual(h.stops, []);
});

test("the heartbeat is on only for exactly PILOTSWARM_CLAUDE_KEEPWARM=1; a client without one is main's client", () => {
    assert.equal(isClaudeKeepWarmEnabled({}), false);
    for (const value of ["", "0", "true", "yes", " 1", "1 "]) assert.equal(isClaudeKeepWarmEnabled({ PILOTSWARM_CLAUDE_KEEPWARM: value }), false);
    assert.equal(isClaudeKeepWarmEnabled({ PILOTSWARM_CLAUDE_KEEPWARM: "1" }), true);
    for (const name of ["claude-opus-4.5", "anthropic:claude-sonnet-4.5"]) assert.equal(isClaudeModelName(name), true);
    for (const name of ["gpt-5.4", "github:gpt-5.4", "claudette", "", undefined, null]) assert.equal(isClaudeModelName(name), false);
    assert.equal(createCopilotClient({ useLoggedInUser: false }, undefined).requestHandler, null);
    const handler = new ClaudeKeepWarmHeartbeat();
    assert.equal(createCopilotClient({ useLoggedInUser: false }, undefined, undefined, handler).requestHandler, handler);
    assert.ok(
        createCopilotClient({ useLoggedInUser: false }, { type: "openai" }, undefined, handler).requestHandler instanceof ByokRequestCompatibility,
        "an OpenAI-compatible client keeps its shim",
    );
});

for (const [name, beforePing] of [
    ["false", () => false],
    ["a promise of false", async () => false],
    ["a throw", () => { throw new Error("store down"); }],
    ["a value that is not true", () => "yes"],
]) {
    test(`no ping is sent when beforePing answers ${name}, and replay stops as provider-paused`, async t => {
        const h = harness(t, { beforePing });
        await h.send();
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
        assert.equal(h.calls.length, 1, "only the model call reached the transport");
        assert.deepEqual(h.pings, []);
        assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "provider-paused", pings: 0 }]);
    });
}

test("a ping is sent when beforePing answers true, and beforePing names the session and the model", async t => {
    const asked = [];
    const h = harness(t, { beforePing: async event => { asked.push(event); return true; } });
    await h.send();
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.pings.map(ping => ping.ping), [1]);
    assert.deepEqual(asked, [{ sessionId: "s1", model: "claude-opus-4.5" }]);
});

const keepWarmRegistry = () => new ModelProviderRegistry({
    providers: [{
        id: "github-copilot",
        type: "github",
        models: [
            { name: "claude-sonnet-5", keepWarm: { intervalSeconds: 120, maxPings: 3 } },
            { name: "claude-opus-5" },
        ],
    }],
}, { keepUncredentialed: true });

const withKeepWarmFlag = async (value, run) => {
    const previous = process.env.PILOTSWARM_CLAUDE_KEEPWARM;
    if (value === undefined) delete process.env.PILOTSWARM_CLAUDE_KEEPWARM;
    else process.env.PILOTSWARM_CLAUDE_KEEPWARM = value;
    try {
        await run();
    } finally {
        if (previous === undefined) delete process.env.PILOTSWARM_CLAUDE_KEEPWARM;
        else process.env.PILOTSWARM_CLAUDE_KEEPWARM = previous;
    }
};

test("a policy sets the ping interval and the cap for its session", async t => {
    const h = harness(t, { policy: () => ({ intervalMs: 60_000, maxPings: 2 }) });
    await h.send();
    await h.tick(60_000 - 1);
    assert.equal(h.calls.length, 1);
    await h.tick(1);
    assert.equal(h.calls.length, 2);
    await h.tick(60_000);
    assert.equal(h.calls.length, 3);
    await h.tick(60_000);
    assert.equal(h.calls.length, 3, "the cap of 2 pings holds");
    assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "max-pings", pings: 2 }]);
});

for (const [name, policy] of [
    ["gives nothing", () => undefined],
    ["throws", () => { throw new Error("catalog gone"); }],
    ["gives an interval of 0", () => ({ intervalMs: 0, maxPings: 2 })],
    ["gives a cap that is not an integer", () => ({ intervalMs: 60_000, maxPings: 1.5 })],
]) {
    test(`a policy that ${name} keeps the default interval and cap`, async t => {
        const h = harness(t, { policy });
        await h.send();
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS - 1);
        assert.equal(h.calls.length, 1);
        await h.tick(1);
        assert.equal(h.calls.length, 2);
        for (let i = 0; i < CLAUDE_KEEPWARM_MAX_PINGS + 2; i++) await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
        assert.equal(h.calls.length, 1 + CLAUDE_KEEPWARM_MAX_PINGS);
    });
}

test("keepWarm is read from the model catalog and checked at load", () => {
    const registry = keepWarmRegistry();
    assert.deepEqual(registry.getDescriptor("github-copilot:claude-sonnet-5").keepWarm, { intervalSeconds: 120, maxPings: 3 });
    assert.equal(registry.getDescriptor("github-copilot:claude-opus-5").keepWarm, undefined);
    for (const [model, keepWarm] of [
        ["claude-sonnet-5", { intervalSeconds: 59, maxPings: 3 }],
        ["claude-sonnet-5", { intervalSeconds: 291, maxPings: 3 }],
        ["claude-sonnet-5", { intervalSeconds: 120.5, maxPings: 3 }],
        ["claude-sonnet-5", { intervalSeconds: "120", maxPings: 3 }],
        ["claude-sonnet-5", { intervalSeconds: 120, maxPings: 0 }],
        ["claude-sonnet-5", { intervalSeconds: 120, maxPings: 1.5 }],
        ["claude-sonnet-5", { intervalSeconds: 120 }],
        ["claude-sonnet-5", { intervalSeconds: 120, maxPings: 3, extra: 1 }],
        ["claude-sonnet-5", 7],
        ["claude-sonnet-5", null],
        ["gpt-5.4", { intervalSeconds: 120, maxPings: 3 }],
    ]) {
        assert.throws(
            () => new ModelProviderRegistry({ providers: [{ id: "github-copilot", type: "github", models: [{ name: model, keepWarm }] }] },
                { keepUncredentialed: true }),
            /Invalid keepWarm/,
            `${model} ${JSON.stringify(keepWarm)}`,
        );
    }
});

const loadKeepWarm = (name, maxPings) => new ModelProviderRegistry({
    providers: [{ id: "github-copilot", type: "github", models: [{ name, keepWarm: { intervalSeconds: 60, maxPings } }] }],
}, { keepUncredentialed: true });

// The cap is the number of pings that cost one missed cache at the model's prices.
for (const [name, cap] of [
    ["claude-sonnet-5", 11], ["claude-opus-4.8", 11], ["claude-opus-4-6", 11], ["claude-haiku-5.5", 11],
    ["claude-sonnet-5.5", 24], ["claude-opus-5-5", 24],
    ["claude-fable-5.2", 49], ["claude-mythos-5-1", 49],
    ["claude-fable-5", 11], ["claude-mythos-5", 11], ["claude-opus-5-20260601", 11], ["claude-sonnet-5-5-20261001", 24],
]) {
    test(`keepWarm maxPings on ${name} may be 1 to ${cap}, the pings that cost one missed cache at its prices`, () => {
        assert.deepEqual(loadKeepWarm(name, cap).getDescriptor(`github-copilot:${name}`).keepWarm, { intervalSeconds: 60, maxPings: cap }, name);
        assert.deepEqual(loadKeepWarm(name, 1).getDescriptor(`github-copilot:${name}`).keepWarm, { intervalSeconds: 60, maxPings: 1 }, name);
        assert.throws(() => loadKeepWarm(name, cap + 1),
            new RegExp(`Invalid keepWarm on github-copilot:${name.replaceAll(".", "\\.")}: .*an integer maxPings from 1 to ${cap}\\.`), name);
    });
}

test("keepWarm on a model that is not Claude fails as Claude-only, before the ping cap is checked", () => {
    assert.throws(
        () => new ModelProviderRegistry({
            providers: [{ id: "github-copilot", type: "github", models: [{ name: "gpt-5.4", keepWarm: { intervalSeconds: 60, maxPings: 20 } }] }],
        }, { keepUncredentialed: true }),
        /Invalid keepWarm on github-copilot:gpt-5\.4: keepWarm applies only to Claude models\./,
    );
});

test("SessionManager reads keepWarm for the session's model only", () => {
    const manager = new SessionManager(undefined, null, { modelProviders: keepWarmRegistry() });
    manager.sessionConfigs.set("s1", { model: "github-copilot:claude-sonnet-5" });
    assert.deepEqual(manager.keepWarmPolicy("s1", "claude-sonnet-5"), { intervalMs: 120_000, maxPings: 3 });
    assert.equal(manager.keepWarmPolicy("s1", "claude-opus-5"), undefined);
    assert.equal(manager.keepWarmPolicy("s2", "claude-sonnet-5"), undefined);
});

test("with PILOTSWARM_CLAUDE_KEEPWARM unset no client gets a keep-warm handler, even when a caller asks for one", async () => {
    await withKeepWarmFlag(undefined, async () => {
        const manager = new SessionManager(undefined, null, {});
        assert.equal(manager.claudeKeepWarmFor("claude-sonnet-5", false), false);
        const client = await manager.ensureClient(undefined, false, undefined, true);
        assert.equal(client.requestHandler, null, "main's client, with no handler");
        assert.equal(manager.heartbeats.size, 0, "no keep-warm handler exists");
    });
    await withKeepWarmFlag("1", async () => {
        const manager = new SessionManager(undefined, null, {});
        assert.equal(manager.claudeKeepWarmFor("claude-sonnet-5", false), true);
        assert.equal(manager.claudeKeepWarmFor("gpt-5.4", false), false);
        assert.equal(manager.claudeKeepWarmFor("claude-sonnet-5", true), false);
        const client = await manager.ensureClient(undefined, false, undefined, true);
        assert.ok(client.requestHandler instanceof ClaudeKeepWarmHeartbeat, "with the flag the same call gets the handler");
        assert.equal(manager.heartbeats.size, 1);
        manager.stopKeepWarmHeartbeats();
    });
});

for (const clear of [false, true]) {
    test(`SessionManager's heartbeat asks the catalog before a ping (answer ${clear}) and uses the model's keepWarm`, async t => {
        await withKeepWarmFlag("1", async () => {
            const h = harness(t);
            const recorded = [];
            const manager = new SessionManager(undefined, null, { modelProviders: keepWarmRegistry() });
            const asked = [];
            manager.sessionCatalog = {
                heartbeatProviderClear: async (...args) => { asked.push(args); return clear; },
                recordHeartbeatUsage: async ping => { recorded.push(ping); return recorded.length; },
            };
            manager.sessionConfigs.set("s1", { model: "github-copilot:claude-sonnet-5" });
            await manager.ensureClient(undefined, false, undefined, manager.claudeKeepWarmFor("claude-sonnet-5", false));
            assert.equal(manager.heartbeats.size, 1);
            h.handler = [...manager.heartbeats.values()][0];
            await h.send(modelBody({ model: "claude-sonnet-5" }));
            await h.tick(120_000 - 1);
            assert.equal(h.calls.length, 1, "no ping before the catalog's 120 s");
            await h.tick(1);
            assert.deepEqual(asked, [["s1", "github-copilot:claude-sonnet-5"]], "the check names the session and its model reference");
            if (clear) {
                assert.equal(h.calls.length, 2, "the ping went at 120000 ms");
                assert.equal(JSON.parse(h.calls[1].body).max_tokens, 0);
                assert.equal(h.handler.states.size, 1, "replay goes on");
                assert.deepEqual(recorded, [{
                    sessionId: "s1", model: "claude-sonnet-5", modelQualified: "github-copilot:claude-sonnet-5", ping: 1, status: 200,
                    tokensInput: 10005, tokensOutput: 0, tokensCacheRead: 10000, tokensCacheWrite: 0, totalNanoAiu: 7,
                }], "the ping is recorded with its model reference and its inclusive input tokens");
            } else {
                assert.equal(h.calls.length, 1, "no ping while the provider is not clear");
                assert.equal(h.handler.states.size, 0, "replay stopped");
            }
            h.handler.stopAll();
        });
    });
}
