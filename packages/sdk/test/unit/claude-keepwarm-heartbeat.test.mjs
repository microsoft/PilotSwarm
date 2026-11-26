/**
 * The Claude keep-warm heartbeat: one ping 240000 ms after the start of the latest request or ping, at most 7 per idle
 * gap by default, replaying the session's latest Claude model call with `max_tokens` 0 and `stream` false, and each ping's
 * usage reported. The transport is a mocked fetch and the clock a mocked setTimeout and Date; no model is called.
 *
 * Run: node --test test/unit/claude-keepwarm-heartbeat.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    ByokRequestCompatibility,
    CLAUDE_KEEPWARM_INTERVAL_MS,
    CLAUDE_KEEPWARM_MAX_PINGS,
    ClaudeKeepWarmHeartbeat,
    createCopilotClient,
    isClaudeKeepWarmEnabled,
    isClaudeModelName,
    supportsClaudeKeepWarm,
} from "../../dist/copilot-client.js";
import { SessionManager } from "../../dist/session-manager.js";
import { KeepWarmLedger } from "../../dist/keepwarm-ledger.js";
import { ModelProviderRegistry } from "../../dist/model-providers.js";
import { AnthropicWifCredentials, anthropicWifCredentials, attachWorkloadIdentity, readAnthropicWifSettings, resetAnthropicWifCredentials } from "../../dist/wif-credentials.js";

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
// A null `nano` leaves copilot_usage out of the reply.
const warmReply = (usage = {}, nano = 7) => new Response(JSON.stringify({
    usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0, ...usage },
    ...(nano === null ? {} : { copilot_usage: { total_nano_aiu: nano } }),
}), { status: 200, headers: { "content-type": "application/json" } });
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

function harness(t, options = {}) {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const h = { calls: [], pings: [], aborted: [], stops: [], respond: { ping: () => warmReply() } };
    t.mock.method(globalThis, "fetch", async (request, options) => {
        const body = await request.clone().text();
        h.calls.push({ request, options, url: request.url, headers: request.headers, body });
        // A test that sets h.authorize makes this stub answer 401 to a request it does not accept, as the model side does.
        if (h.authorize && !h.authorize(request.headers)) {
            return new Response(JSON.stringify({ error: { type: "authentication_error" } }), { status: 401 });
        }
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = null; }
        if (parsed?.max_tokens === 0) return h.respond.ping(h.calls.filter(call => call.body.includes('"max_tokens":0')).length);
        return h.respond.model?.() ?? new Response(MODEL_REPLY, { headers: { "content-type": "text/event-stream" } });
    });
    h.handler = new ClaudeKeepWarmHeartbeat({
        ...options,
        onPingUsage: ping => { h.pings.push(ping); },
        onPingAborted: ping => {
            h.aborted.push(ping);
            return options.onPingAborted?.(ping);
        },
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

// Each case streams a reply for streamMs and then ends it; the cache lifetime's cutoff is 290 s after the request started.
for (const { title, streamMs, pinged } of [
    { title: "a reply that ends 290 s or more after its request started gets no ping: replay stops as cache-expired", streamMs: 290_000, pinged: false },
    { title: "a reply that ends after the interval but before the cutoff gets its ping as soon as it ends, not before", streamMs: 250_000, pinged: true },
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
        capturedAt: 0,
        status: 200,
        latencyMs: 0,
        usage: { input: 10005, output: 0, cacheRead: 10000, cacheWrite: 0 },
        totalNanoAiu: 7,
    }]);
});

// The stats pane tells a ping with no reported cost from a free one, so the two must not both read as 0.
for (const [name, nano, expected] of [["carries none", null, undefined], ["reports 0", 0, 0], ["reports a rounded value", 7.4, 7]]) {
    test(`a ping reply that ${name} reports totalNanoAiu as ${expected === undefined ? "absent" : expected}`, async t => {
        const h = harness(t);
        h.respond.ping = () => warmReply({}, nano);
        await h.send();
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
        assert.equal(h.pings.length, 1);
        assert.equal("totalNanoAiu" in h.pings[0], expected !== undefined);
        assert.equal(h.pings[0].totalNanoAiu, expected);
    });
}

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

test("dropping a session stops its replay with the given reason; the next request starts it again", async t => {
    const h = harness(t);
    await h.send();
    assert.equal(h.handler.dropSession("s1", "close"), true);
    assert.equal(h.handler.dropSession("s1", "close"), false, "nothing left to drop");
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS * 3);
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "close", pings: 0 }]);
    await h.send(modelBody({ model: "claude-sonnet-4.5" }));
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.equal(JSON.parse(h.calls.at(-1).body).model, "claude-sonnet-4.5", "replay follows the model now in use");
    assert.deepEqual(h.pings.map(ping => ping.ping), [1]);
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

test("a request that is not captured reaches the transport as the same request object", async t => {
    const h = harness(t);
    const request = modelRequest(modelBody({ model: "gpt-5.4" }));
    await h.handler.sendRequest(request, context());
    assert.equal(h.calls[0].request, request);
});

for (const [status, reason] of [[401, "unauthorized"], [403, "forbidden"], [429, "rate-limited"], [400, "http-error"]]) {
    test(`a ${status} reply stops replay with no retry`, async t => {
        const h = harness(t);
        h.respond.ping = () => new Response("{}", { status });
        await h.send();
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS * 3);
        assert.equal(h.calls.length, 2);
        assert.deepEqual(h.stops, [{ sessionId: "s1", reason, pings: 1 }]);
        assert.deepEqual(h.pings.map(ping => [ping.status, "usage" in ping]), [[status, false]], "a reply that was not a success has no usage to count");
    });
}

// A ping that read nothing from the cache and wrote nothing passed the old test (0 > 0 * 1% is false).
test("a ping that read nothing from the cache and wrote nothing stops replay as cache-miss", async t => {
    const h = harness(t);
    h.respond.ping = () => warmReply({ cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
    await h.send();
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "cache-miss", pings: 1 }]);
});

// Only the main conversation's Claude model call is kept, so a background, sampling or sub-agent call (or
// one with a parent agent) never takes the place of the request the next ping replays.
for (const [name, ctx, url] of [
    ["a /chat/completions call", context(), "https://example.invalid/v1/chat/completions"],
    ["a background call", { ...context(), interactionType: "conversation-background" }, MODEL_URL],
    ["a call with a parent agent", { ...context(), parentAgentId: "agent-1" }, MODEL_URL],
]) {
    test(`${name} is passed through and not kept`, async t => {
        const h = harness(t);
        const response = await h.handler.sendRequest(modelRequest(modelBody(), url), ctx);
        await response.text();
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS * 3);
        assert.equal(h.calls.length, 1);
        assert.deepEqual(h.pings, []);
        assert.deepEqual(h.stops, []);
    });
}

test("a conversation-user call is kept and replayed", async t => {
    const h = harness(t);
    await h.send(modelBody(), { ...context(), interactionType: "conversation-user" });
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.pings.map(ping => ping.ping), [1]);
});

test("a compaction call drops the session's replay with the reason compaction, and the call itself passes through", async t => {
    const h = harness(t);
    await h.send();
    const response = await h.handler.sendRequest(modelRequest(), { ...context(), interactionType: "conversation-compaction" });
    assert.equal(await response.text(), MODEL_REPLY);
    assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "compaction", pings: 0 }]);
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS * 3);
    assert.equal(h.calls.length, 2, "the model call and the compaction call, no ping");
});

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
        createCopilotClient({ useLoggedInUser: false }, { type: "openai" }, { maxDeclarations: 128, overflowStrategy: "typed-dispatch" }, handler).requestHandler instanceof ByokRequestCompatibility,
        "an OpenAI-compatible client with a tool catalog keeps its shim",
    );
});

test("only native GitHub Copilot and an Anthropic provider can carry the heartbeat", () => {
    assert.equal(supportsClaudeKeepWarm(undefined), true, "native GitHub Copilot");
    assert.equal(supportsClaudeKeepWarm({ type: "anthropic" }), true);
    for (const provider of [{ type: "openai" }, { type: "azure" }, { type: "openai", wireApi: "responses" }]) {
        assert.equal(supportsClaudeKeepWarm(provider), false, JSON.stringify(provider));
    }
    // foundry-wif is OpenAI-shaped on the wire, so its resolved SDK provider cannot carry the heartbeat: no token code for it.
    const foundry = new ModelProviderRegistry({
        providers: [{ id: "foundry", type: "foundry-wif", baseUrl: "https://example-foundry.invalid/openai/v1", models: [{ name: "test-model" }] }],
    }).resolve("foundry:test-model");
    assert.equal(supportsClaudeKeepWarm(foundry.sdkProvider), false);
});

// A max_tokens 0 ping cannot replay these: the API rejects thinking with no budget left, and a forced tool call or a
// structured output needs a reply. They pass through, and an earlier replay of the session ends as uncapturable.
for (const [name, extra] of [
    ["extended thinking", { thinking: { type: "enabled", budget_tokens: 1024 } }],
    ["a structured output format", { output_config: { format: { type: "json_schema", schema: { type: "object" } } } }],
    ["a forced tool choice", { tool_choice: { type: "any" } }],
]) {
    test(`a request with ${name} is not kept, and it ends the session's earlier replay as uncapturable`, async t => {
        const h = harness(t);
        await h.send();
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
        assert.equal(h.calls.length, 2, "the earlier request is being replayed");
        await h.send(modelBody(extra));
        assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "uncapturable", pings: 1 }]);
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS * 3);
        assert.equal(h.calls.length, 3, "the two model calls and one ping, and no ping for the request that was not kept");
    });
}

for (const [name, extra] of [
    ["adaptive thinking", { thinking: { type: "adaptive" } }],
    ["a tool choice of auto", { tool_choice: { type: "auto" } }],
    ["an output config with only an effort", { output_config: { effort: "high" } }],
    ["an output config with a null format", { output_config: { format: null } }],
]) {
    test(`a request with ${name} is kept and replayed`, async t => {
        const h = harness(t);
        await h.send(modelBody(extra));
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
        assert.equal(h.calls.length, 2);
        assert.deepEqual(JSON.parse(h.calls[1].body), { ...JSON.parse(h.calls[0].body), max_tokens: 0, stream: false });
        assert.deepEqual(h.stops, []);
    });
}

// clone() can throw before the body is read, which a catch on text() does not see; the request must still go out.
test("a request whose clone throws is forwarded unchanged and leaves nothing pending", async t => {
    const h = harness(t);
    const request = modelRequest();
    const clone = request.clone.bind(request);
    let threw = false;
    // Throws on the handler's own clone only; the harness's fetch mock clones the request again.
    request.clone = () => {
        if (threw) return clone();
        threw = true;
        throw new Error("clone failed");
    };
    const response = await h.handler.sendRequest(request, context());
    assert.equal(await response.text(), MODEL_REPLY);
    assert.equal(h.calls[0].request, request, "the same request object reaches the transport");
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS * 3);
    assert.equal(h.calls.length, 1, "nothing was kept, so no ping");
    await h.send();
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.equal(h.calls.length, 3, "a later request of the session is captured and replayed");
    assert.deepEqual(h.stops, []);
});

// The turn's reply ended in a tool use and no new request comes while the tool runs: the handler has nothing to tell
// that apart from an idle session, so it pings at each interval until the cap.
test("a session whose reply ended in a tool use is pinged at each interval while the tool runs, up to the cap", async t => {
    const h = harness(t);
    h.respond.model = () => new Response(
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
    );
    await h.send(modelBody({ tools: [{ name: "lookup", input_schema: { type: "object" } }], tool_choice: { type: "auto" } }));
    for (let ping = 1; ping <= CLAUDE_KEEPWARM_MAX_PINGS; ping++) {
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS - 1);
        assert.equal(h.calls.length, ping, `no ping ${ping} before its interval`);
        await h.tick(1);
        assert.equal(h.calls.length, ping + 1, `ping ${ping} at its interval`);
        assert.equal(JSON.parse(h.calls.at(-1).body).max_tokens, 0);
    }
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.equal(h.calls.length, 1 + CLAUDE_KEEPWARM_MAX_PINGS, "no ping past the cap");
    assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "max-pings", pings: CLAUDE_KEEPWARM_MAX_PINGS }]);
});

// ── a fresh workload-identity token on each ping ─────────────────

const WIF_ENV = {
    ANTHROPIC_FEDERATION_RULE_ID: "fdrl_test",
    ANTHROPIC_ORGANIZATION_ID: "org-uuid",
    ANTHROPIC_SERVICE_ACCOUNT_ID: "svac_test",
    ANTHROPIC_WORKSPACE_ID: "wrkspc_test",
    AZURE_FEDERATED_TOKEN_FILE: "/var/run/secrets/token",
    AZURE_TENANT_ID: "tenant-guid",
    AZURE_CLIENT_ID: "client-guid",
};
const WIF_CONFIG = {
    providers: [{ id: "wif", type: "anthropic-wif", baseUrl: "https://api.anthropic.com", models: [{ name: "claude-opus-5" }] }],
};
const TOKEN_LIFETIME_S = 300;

// The worker's shared token cache (the SDK's own callback of an anthropic-wif provider) with fakes for both hops, and
// the model side's rule: a token is accepted only until its lifetime ends. The cache replaces a token at half its life.
function workloadIdentity() {
    const issuedAt = [];
    const fetchImpl = async url => {
        const entra = String(url).includes("login.microsoftonline.com");
        if (!entra) issuedAt.push(Date.now());
        const body = entra
            ? { access_token: "entra-jwt", expires_in: 86_400 }
            : { access_token: `tok-${issuedAt.length}`, expires_in: TOKEN_LIFETIME_S };
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
    };
    const credentials = new AnthropicWifCredentials(readAnthropicWifSettings(WIF_ENV).settings, {
        fetch: fetchImpl, readFile: async () => "projected", now: () => Date.now(),
    });
    const resolved = new ModelProviderRegistry(WIF_CONFIG).resolve("wif:claude-opus-5");
    const read = attachWorkloadIdentity(resolved, { env: WIF_ENV, credentials: () => credentials }).bearerTokenProvider;
    const authorize = headers => {
        const issued = issuedAt[Number(/^Bearer tok-(\d+)$/.exec(headers.get("authorization") ?? "")?.[1]) - 1];
        return issued !== undefined && Date.now() < issued + TOKEN_LIFETIME_S * 1000;
    };
    return { read, authorize, issuedAt };
}

test("each ping carries a fresh workload-identity token, so the replay outlives the captured one", async t => {
    const wi = workloadIdentity();
    let asked = 0;
    let reads = 0;
    const h = harness(t, {
        policy: () => ({ intervalMs: CLAUDE_KEEPWARM_INTERVAL_MS, maxPings: 3 }),
        bearerToken: () => { asked++; return async () => { reads++; return wi.read(); }; },
    });
    h.authorize = wi.authorize;
    // The token the SDK would have put on the captured request; it is good for 300 s.
    const captured = await wi.read();
    assert.equal(captured, "tok-1");
    const request = new Request(MODEL_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${captured}` },
        body: JSON.stringify(modelBody()),
    });
    await (await h.handler.sendRequest(request, context())).text();
    assert.equal(asked, 1, "the reader is asked for once per captured request");
    assert.equal(reads, 0, "no token is read at capture time");
    for (let i = 0; i < 3; i++) await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.deepEqual(h.calls.slice(1).map(call => call.headers.get("authorization")), ["Bearer tok-2", "Bearer tok-3", "Bearer tok-4"]);
    assert.deepEqual(h.pings.map(ping => ping.status), [200, 200, 200], "the server accepted every ping");
    assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "max-pings", pings: 3 }]);
    assert.equal(reads, 3, "the reader is called once for each ping");
    assert.equal(wi.issuedAt.length, 4, "one exchange for the first token and one for each replacement, not one for each request");
});

for (const [name, bearerToken] of [
    ["gives no reader", () => undefined],
    ["throws", () => { throw new Error("catalog gone"); }],
]) {
    test(`a session whose bearerToken lookup ${name} sends the captured authorization header on every ping`, async t => {
        const h = harness(t, { bearerToken });
        await h.send();
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
        assert.deepEqual(
            h.calls.slice(1).map(call => call.headers.get("authorization")),
            ["Bearer test-token-not-a-secret", "Bearer test-token-not-a-secret"],
        );
        assert.deepEqual(h.stops, []);
    });
}

for (const [name, read] of [
    ["rejects", async () => { throw new Error("exchange failed"); }],
    ["gives an empty token", async () => ""],
]) {
    test(`a token reader that ${name} stops replay as error and the ping is not sent`, async t => {
        const h = harness(t, { bearerToken: () => read });
        await h.send();
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS * 3);
        assert.equal(h.calls.length, 1, "no ping reached the transport");
        assert.deepEqual(h.pings.map(ping => [ping.ping, "status" in ping, "usage" in ping]), [[1, false, false]], "reported once, with no reply");
        assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "error", pings: 1 }]);
    });
}

test("a token reader that never answers stops replay as error when the ping's 60 s timeout ends", async t => {
    // The timeout is a real-time signal, which the mocked clock does not move, so the test ends it.
    const timeout = new AbortController();
    t.mock.method(AbortSignal, "timeout", () => timeout.signal);
    const h = harness(t, { bearerToken: () => () => new Promise(() => {}) });
    await h.send();
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.deepEqual(h.stops, [], "still waiting for the token");
    timeout.abort(new DOMException("timed out", "TimeoutError"));
    await settle();
    assert.equal(h.calls.length, 1, "no ping reached the transport");
    assert.deepEqual(h.pings.map(ping => ping.ping), [1], "reported once");
    assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "error", pings: 1 }]);
});

test("the identity read at capture time goes unchanged to beforePing and to the usage report", async t => {
    const seen = [];
    const identity = { modelRef: "anthropic:claude-opus-4.5", providerInstanceId: "11111111-1111-4111-8111-111111111111" };
    const h = harness(t, { identity: () => identity, beforePing: event => { seen.push(event); return true; } });
    await h.send();
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.deepEqual(seen, [{ sessionId: "s1", model: "claude-opus-4.5", capturedAt: 0, ping: 1, ...identity }]);
    assert.equal(h.pings[0].modelRef, identity.modelRef);
    assert.equal(h.pings[0].providerInstanceId, identity.providerInstanceId);
    assert.equal(h.pings[0].capturedAt, 0);
});

for (const [name, verdict, reason] of [
    ["a reason string", async () => "provider-changed", "provider-changed"],
    ["false", () => false, "provider-paused"],
    ["a throw", () => { throw new Error("db down"); }, "provider-paused"],
]) {
    test(`a beforePing that gives ${name} sends no ping and stops replay as ${reason}`, async t => {
        const h = harness(t, { beforePing: verdict });
        await h.send();
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
        await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS * 3);
        assert.equal(h.calls.length, 1, "no ping reached the transport");
        assert.deepEqual(h.pings, []);
        assert.deepEqual(h.stops, [{ sessionId: "s1", reason, pings: 0 }]);
    });
}

test("an admitted ping that is dropped before send settles without sending, reporting, or counting it", async t => {
    const claims = [];
    const settlements = [];
    const ledger = new KeepWarmLedger({
        sessionChargeFacts: async () => ({ ownerUserId: 7, isSystem: false }),
        claimInferenceOperation: async input => { claims.push(input); return true; },
        settleInferenceOperation: async input => { settlements.push(input); return true; },
    });
    let h;
    h = harness(t, { beforePing: async () => {
        assert.equal(await ledger.claim({
            sessionId: "s1", capturedAt: 0, ping: 1,
            providerName: "github-copilot", modelQualified: "github-copilot:claude-opus-4.5",
        }), true);
        h.handler.dropSession("s1", "released");
        return true;
    }, onPingAborted: ping => ledger.settle(ping) });
    await h.send();
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.equal(h.calls.length, 1, "no ping reached the transport");
    assert.deepEqual(h.pings, [], "no ping event was reported");
    assert.deepEqual(h.aborted, [{
        sessionId: "s1",
        model: "claude-opus-4.5",
        ping: 1,
        capturedAt: 0,
    }], "the admitted claim was settled without usage");
    assert.equal(claims.length, 1);
    assert.deepEqual(settlements.map(row => [
        row.operationId, row.tokensInput, row.tokensOutput, row.tokensCacheRead, row.tokensCacheWrite, row.latencyMs,
    ]), [["keepwarm:s1:0:1", null, null, null, null, null]]);
    assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "released", pings: 0 }]);
});

test("a ping that the transport throws on is reported once with no reply", async t => {
    const h = harness(t);
    h.respond.ping = () => { throw new Error("socket closed"); };
    await h.send();
    await h.tick(CLAUDE_KEEPWARM_INTERVAL_MS);
    assert.deepEqual(h.pings, [{ sessionId: "s1", model: "claude-opus-4.5", ping: 1, capturedAt: 0 }]);
    assert.deepEqual(h.stops, [{ sessionId: "s1", reason: "error", pings: 1 }]);
});

// A ping that is not a readable 2xx cost an unknown number of tokens: the ledger must hold unknown, never zero.
test("the keep-warm ledger settles the reply's counts for a readable 2xx and no counts for anything else", async () => {
    const settled = [];
    const claims = [];
    const ledger = new KeepWarmLedger({
        sessionChargeFacts: async () => ({ ownerUserId: 7, isSystem: true }),
        claimInferenceOperation: async input => { claims.push(input); return true; },
        settleInferenceOperation: async input => { settled.push(input); return true; },
    });
    const base = { sessionId: "s1", model: "claude-opus-4.5", ping: 2, capturedAt: 1000 };
    const usage = { input: 10005, output: 3, cacheRead: 10000, cacheWrite: 4 };
    await ledger.settle({ ...base, status: 200, latencyMs: 41, usage });
    await ledger.settle({ ...base, status: 429, latencyMs: 9 });
    await ledger.settle({ ...base, status: 200, latencyMs: 9 });
    await ledger.settle(base);
    const counts = entry => [entry.tokensInput, entry.tokensOutput, entry.tokensCacheRead, entry.tokensCacheWrite, entry.latencyMs];
    assert.deepEqual(settled.map(counts), [[10005, 3, 10000, 4, 41], [null, null, null, null, 9], [null, null, null, null, 9], [null, null, null, null, null]]);
    assert.ok(settled.every(entry => entry.operationId === "keepwarm:s1:1000:2" && entry.attempt === 1));
    await ledger.claim({ sessionId: "s1", capturedAt: 1000, ping: 2, providerName: "anthropic", modelQualified: "anthropic:claude-opus-4.5" });
    assert.deepEqual(claims.map(claim => [claim.operationId, claim.capability, claim.chargeClass, claim.ownerUserId, claim.providerInstanceId, claim.providerUpdatedAt]),
        [["keepwarm:s1:1000:2", "keep_warm", "system", 7, null, null]]);
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

const loadKeepWarm = (name, maxPings) => new ModelProviderRegistry({
    providers: [{ id: "github-copilot", type: "github", models: [{ name, keepWarm: { intervalSeconds: 60, maxPings } }] }],
}, { keepUncredentialed: true });

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
        ["claude-sonnet-5", { intervalSeconds: 120, maxPings: 50 }],
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

// The catalog file checks maxPings only for type and the range 1 to 49; no price is read.
test("keepWarm maxPings may be 1 to 49 at load", () => {
    const name = "claude-sonnet-5";
    assert.deepEqual(loadKeepWarm(name, 49).getDescriptor(`github-copilot:${name}`).keepWarm, { intervalSeconds: 60, maxPings: 49 }, name);
    assert.deepEqual(loadKeepWarm(name, 1).getDescriptor(`github-copilot:${name}`).keepWarm, { intervalSeconds: 60, maxPings: 1 }, name);
    assert.throws(() => loadKeepWarm(name, 50), /Invalid keepWarm on github-copilot:claude-sonnet-5: .*an integer maxPings from 1 to 49\./, name);
});

test("keepWarm on a model that is not Claude fails as Claude-only, before the ping cap is checked", () => {
    assert.throws(
        () => new ModelProviderRegistry({
            providers: [{ id: "github-copilot", type: "github", models: [{ name: "gpt-5.4", keepWarm: { intervalSeconds: 60, maxPings: 60 } }] }],
        }, { keepUncredentialed: true }),
        /Invalid keepWarm on github-copilot:gpt-5\.4: keepWarm applies only to Claude models\./,
    );
});

// The registry warns once per process for a model and a setting, so each case below uses a model name of its own.
const captureWarnings = t => {
    const warnings = [];
    t.mock.method(console, "warn", message => { warnings.push(String(message)); });
    return warnings;
};
const loadSetting = (name, intervalSeconds, maxPings) => new ModelProviderRegistry({
    providers: [{ id: "github-copilot", type: "github", models: [{ name, keepWarm: { intervalSeconds, maxPings } }] }],
}, { keepUncredentialed: true }).getDescriptor(`github-copilot:${name}`).keepWarm;
const capWarnings = warnings => warnings.filter(message => message.includes("break-even"));
const affinityWarnings = warnings => warnings.filter(message => message.includes("affinity"));

for (const [maxPings, expected] of [[11, 0], [12, 1]]) {
    test(`keepWarm maxPings ${maxPings} gives ${expected} cap warnings against the break-even of 11`, t => {
        const warnings = captureWarnings(t);
        const keepWarm = loadSetting(`claude-cap-${maxPings}`, 60, maxPings);
        assert.equal(capWarnings(warnings).length, expected, warnings.join("\n"));
        assert.deepEqual(keepWarm, { intervalSeconds: 60, maxPings }, "the setting is used as written");
        if (expected) assert.match(capWarnings(warnings)[0], /^\[model-providers\] keepWarm on github-copilot:claude-cap-12: maxPings 12 is above 11,/);
    });
}

for (const [intervalSeconds, maxPings, expected] of [[200, 9, 1], [257, 7, 0]]) {
    test(`keepWarm ${intervalSeconds} s x ${maxPings} pings (${intervalSeconds * maxPings} s) gives ${expected} affinity warnings`, t => {
        const warnings = captureWarnings(t);
        const keepWarm = loadSetting(`claude-hold-${intervalSeconds}-${maxPings}`, intervalSeconds, maxPings);
        assert.equal(affinityWarnings(warnings).length, expected, warnings.join("\n"));
        assert.deepEqual(keepWarm, { intervalSeconds, maxPings }, "the setting is used as written");
    });
}

test("keepWarm 240 s x 14 pings gives both warnings, keeps its values, and warns once however often it is loaded", t => {
    const warnings = captureWarnings(t);
    assert.deepEqual(loadSetting("claude-both", 240, 14), { intervalSeconds: 240, maxPings: 14 });
    assert.equal(capWarnings(warnings).length, 1, warnings.join("\n"));
    assert.equal(affinityWarnings(warnings).length, 1, warnings.join("\n"));
    assert.deepEqual(loadSetting("claude-both", 240, 14), { intervalSeconds: 240, maxPings: 14 });
    assert.equal(warnings.length, 2, "the same setting loaded again does not warn again");
    assert.deepEqual(loadSetting("claude-both", 240, 13), { intervalSeconds: 240, maxPings: 13 });
    assert.equal(warnings.length, 4, "a changed setting warns again");
});

// ── the session manager's keep-warm client, and every place it ends a session's replay ──

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

test("with PILOTSWARM_CLAUDE_KEEPWARM unset no client gets a keep-warm handler, even when a caller asks for one", async () => {
    await withKeepWarmFlag(undefined, async () => {
        const manager = new SessionManager(undefined, null, {});
        assert.equal(manager.claudeKeepWarmFor("claude-sonnet-5", undefined), false);
        const client = await manager.ensureClient(undefined, false, undefined, true);
        assert.equal(client.requestHandler, null, "main's client, with no handler");
        assert.equal(manager.heartbeats.size, 0, "no keep-warm handler exists");
    });
    await withKeepWarmFlag("1", async () => {
        const manager = new SessionManager(undefined, null, {});
        assert.equal(manager.claudeKeepWarmFor("claude-sonnet-5", undefined), true);
        assert.equal(manager.claudeKeepWarmFor("gpt-5.4", undefined), false);
        assert.equal(manager.claudeKeepWarmFor("claude-sonnet-5", { type: "openai" }), false);
        const client = await manager.ensureClient(undefined, false, undefined, true);
        assert.ok(client.requestHandler instanceof ClaudeKeepWarmHeartbeat, "with the flag the same call gets the handler");
        assert.equal(manager.heartbeats.size, 1);
        manager.stopKeepWarmHeartbeats();
    });
});

test("a client that fails to start leaves the pool with its keep-warm handler, and the next call builds a fresh pair", async () => {
    await withKeepWarmFlag("1", async () => {
        const manager = new SessionManager(undefined, null, {});
        const client = await manager.ensureClient(undefined, false, undefined, true);
        assert.equal(manager.clients.size, 1);
        assert.equal(manager.heartbeats.size, 1);
        const failure = new Error("cli did not start");
        client.start = async () => { throw failure; };
        await assert.rejects(manager._startClient(client), error => error === failure);
        assert.equal(manager.clients.size, 0);
        assert.equal(manager.heartbeats.size, 0);
        const next = await manager.ensureClient(undefined, false, undefined, true);
        assert.notEqual(next, client);
        assert.equal(manager.heartbeats.size, 1);
        manager.stopKeepWarmHeartbeats();
    });
});

// Assigning a stub to manager.client reached every pool slot but the keep-warm one.
test("assigning manager.client covers the keep-warm slot: the stub serves a Claude session with the flag on", async () => {
    await withKeepWarmFlag("1", async () => {
        const manager = new SessionManager(undefined, null, {});
        const stub = { stub: true };
        manager.client = stub;
        assert.equal(await manager.ensureClient(undefined, false, undefined, true), stub);
        assert.equal(manager.heartbeats.size, 0, "no handler was made for the stub");
        manager.client = undefined;
        assert.equal(manager.clients.size, 0, "unassigning clears the keep-warm slot too");
    });
});

// A stop closes every handler, but it never moves a session to another client.
test("after stopKeepWarmHeartbeats every handler is stopped, the client key stays the same, and a client made later has a closed handler", async () => {
    await withKeepWarmFlag("1", async () => {
        const manager = new SessionManager(undefined, null, {});
        const warm = await manager.ensureClient(undefined, false, undefined, true);
        assert.ok(warm.requestHandler instanceof ClaudeKeepWarmHeartbeat);
        assert.equal(warm.requestHandler.isStopped, false);
        manager.stopKeepWarmHeartbeats();
        assert.equal(warm.requestHandler.isStopped, true, "the existing handler is stopped");
        assert.equal(manager.claudeKeepWarmFor("claude-sonnet-5", undefined), true, "the session still belongs on the keep-warm client");
        assert.equal(await manager.ensureClient(undefined, false, undefined, true), warm, "the same client: a draining session is not recycled");
        const other = await manager.ensureClient("other-token", false, undefined, true);
        assert.ok(other.requestHandler instanceof ClaudeKeepWarmHeartbeat, "a new keep-warm client is made, not main's client");
        assert.equal(other.requestHandler.isStopped, true, "its handler captures and pings nothing");
        assert.equal(manager.heartbeats.size, 2);
        manager.startWorkflowTools();
        assert.equal(manager.keepWarmStopped, false);
    });
});

test("SessionManager reads keepWarm for the session's model only", () => {
    const manager = new SessionManager(undefined, null, { modelProviders: keepWarmRegistry() });
    manager.sessionConfigs.set("s1", { model: "github-copilot:claude-sonnet-5" });
    assert.deepEqual(manager.keepWarmPolicy("s1", "claude-sonnet-5"), { intervalMs: 120_000, maxPings: 3 });
    assert.equal(manager.keepWarmPolicy("s1", "claude-opus-5"), undefined);
    assert.equal(manager.keepWarmPolicy("s2", "claude-sonnet-5"), undefined);
});

test("the keep-warm handler gets the session's normalized model reference, also when the session holds an unqualified name", () => {
    const manager = new SessionManager(undefined, null, { modelProviders: keepWarmRegistry() });
    manager.sessionConfigs.set("s1", { model: "claude-sonnet-5" });
    manager.sessionConfigs.set("s2", { model: "github-copilot:claude-sonnet-5" });
    assert.deepEqual(manager.keepWarmIdentity("s1", "claude-sonnet-5"), { modelRef: "github-copilot:claude-sonnet-5" });
    assert.deepEqual(manager.keepWarmIdentity("s2", "claude-sonnet-5"), { modelRef: "github-copilot:claude-sonnet-5" });
    assert.equal(manager.keepWarmIdentity("s1", "claude-opus-5"), undefined);
    assert.equal(manager.keepWarmIdentity("s3", "claude-sonnet-5"), undefined);
});

test("the keep-warm handler also gets the provider row's immutable id when the registry carries one", () => {
    const registry = keepWarmRegistry();
    const resolve = registry.resolve.bind(registry);
    registry.resolve = ref => ({ ...resolve(ref), providerInstanceId: "22222222-2222-4222-8222-222222222222" });
    const manager = new SessionManager(undefined, null, { modelProviders: registry });
    manager.sessionConfigs.set("s1", { model: "claude-sonnet-5" });
    assert.deepEqual(manager.keepWarmIdentity("s1", "claude-sonnet-5"), {
        modelRef: "github-copilot:claude-sonnet-5",
        providerInstanceId: "22222222-2222-4222-8222-222222222222",
    });
});

// The gate before each ping: any refusal sends nothing and names its reason (false stops as provider-paused, a refused claim as provider-changed).
test("the admission gate sends a ping only for a live session on the captured model with a clear provider and a granted claim", async t => {
    t.mock.method(console, "warn", () => {});
    const event = { sessionId: "s1", model: "claude-sonnet-5", modelRef: "github-copilot:claude-sonnet-5", providerInstanceId: "p1", capturedAt: 500, ping: 2 };
    const clear = { verdict: "clear", providerName: "github-copilot" };
    const build = (over = {}) => {
        const calls = [];
        const manager = new SessionManager(undefined, null, { modelProviders: keepWarmRegistry() });
        manager.setSessionCatalog({
            getSession: async id => { calls.push(["getSession", id]); return "row" in over ? over.row : { state: "idle", model: "claude-sonnet-5" }; },
            providers: {
                previewTurn: async (id, model) => { calls.push(["previewTurn", id, model]); if (over.preview instanceof Error) throw over.preview; return over.preview ?? clear; },
                sessionChargeFacts: async () => ({ ownerUserId: 7, isSystem: false }),
                claimInferenceOperation: async input => { calls.push(["claim", input.operationId, input.providerName, input.providerInstanceId, input.modelQualified]); return over.claimed ?? true; },
                settleInferenceOperation: async () => true,
            },
        });
        return { manager, calls };
    };
    const verdict = async over => { const { manager, calls } = build(over); return { result: await manager.keepWarmAdmit(event), calls: calls.map(call => call[0]) }; };

    const granted = build();
    assert.equal(await granted.manager.keepWarmAdmit(event), true);
    assert.deepEqual(granted.calls, [["getSession", "s1"], ["previewTurn", "s1", "github-copilot:claude-sonnet-5"], ["claim", "keepwarm:s1:500:2", "github-copilot", "p1", "github-copilot:claude-sonnet-5"]]);
    assert.equal((await verdict({ row: { state: "running", model: "github-copilot:claude-sonnet-5" } })).result, true);

    for (const row of [null, { state: "completed", model: "claude-sonnet-5" }, { state: "failed", model: "claude-sonnet-5" }, { state: "error", model: "claude-sonnet-5" },
        { state: "cancelled", model: "claude-sonnet-5" }, { state: "idle", model: null }, { state: "idle", model: "claude-opus-5" }]) {
        assert.deepEqual(await verdict({ row }), { result: false, calls: ["getSession"] }, JSON.stringify(row));
    }
    for (const preview of [{ verdict: "paused", providerName: "github-copilot" }, { verdict: "no_provider", providerName: null }, { verdict: "clear", providerName: "" }, new Error("lock timeout")]) {
        assert.deepEqual(await verdict({ preview }), { result: false, calls: ["getSession", "previewTurn"] });
    }
    assert.deepEqual(await verdict({ claimed: false }), { result: "provider-changed", calls: ["getSession", "previewTurn", "claim"] });

    const none = new SessionManager(undefined, null, { modelProviders: keepWarmRegistry() });
    assert.equal(await none.keepWarmAdmit(event), false);
    const failing = new SessionManager(undefined, null, { modelProviders: keepWarmRegistry() });
    failing.setSessionCatalog({ getSession: async () => { throw new Error("database down"); }, providers: {} });
    assert.equal(await failing.keepWarmAdmit(event), false);
    assert.equal(await granted.manager.keepWarmAdmit({ ...event, modelRef: undefined }), false);
});

// The two event types the manager writes for a replay; a write never delays or breaks the handler.
test("the manager writes a keep-warm event for each settled ping and for each stop, and a failing write is only logged", async t => {
    const warnings = [];
    t.mock.method(console, "warn", (...args) => { warnings.push(args.join(" ")); });
    await withKeepWarmFlag("1", async () => {
        const manager = new SessionManager(undefined, null, {});
        const written = [];
        let failWith;
        manager.setSessionCatalog({
            recordEvents: (sessionId, events, node) => {
                written.push({ sessionId, events, node });
                if (failWith === "throw") throw new Error("closed");
                return failWith === "reject" ? Promise.reject(new Error("pool closed")) : Promise.resolve();
            },
            providers: {
                sessionChargeFacts: async () => ({ ownerUserId: 7, isSystem: false }),
                claimInferenceOperation: async () => true,
                settleInferenceOperation: async () => true,
            },
        });
        const client = await manager.ensureClient(undefined, false, undefined, true);
        const { onPingUsage, onStop } = client.requestHandler.options;
        const usage = { input: 1200, output: 1, cacheRead: 1000, cacheWrite: 10 };
        await onPingUsage({ sessionId: "s1", model: "claude-sonnet-5", ping: 1, capturedAt: 5, status: 200, usage, totalNanoAiu: 0, latencyMs: 42 });
        await onPingUsage({ sessionId: "s1", model: "claude-sonnet-5", ping: 2, capturedAt: 5 });
        onStop({ sessionId: "s1", reason: "cache-miss", pings: 2 });
        const rows = written.map(call => ({ type: call.events[0].eventType, data: call.events[0].data }));
        assert.deepEqual(rows, [
            { type: "session.keepwarm_ping", data: { ping: 1, status: 200, ok: true, model: "claude-sonnet-5", tokensInput: 1200, tokensOutput: 1, tokensCacheRead: 1000, tokensCacheWrite: 10, totalNanoAiu: 0, latencyMs: 42 } },
            { type: "session.keepwarm_ping", data: { ping: 2, status: null, ok: false, model: "claude-sonnet-5", tokensInput: null, tokensOutput: null, tokensCacheRead: null, tokensCacheWrite: null, totalNanoAiu: null, latencyMs: null } },
            { type: "session.keepwarm_stopped", data: { reason: "cache-miss", pings: 2 } },
        ]);
        assert.ok(written.every(call => call.sessionId === "s1" && typeof call.node === "string" && call.node), "each write names the worker node");
        for (failWith of ["reject", "throw"]) {
            assert.doesNotThrow(() => onStop({ sessionId: "s1", reason: "shutdown", pings: 0 }));
            await new Promise(resolve => setImmediate(resolve));
        }
        assert.equal(warnings.filter(line => line.includes("keep-warm event write failed session=s1")).length, 2);
        manager.stopKeepWarmHeartbeats();
    });
});

// A runtime that exited must not leave a replay pinging through its dead client (note 200, the runtime-loss path).
test("a lost Copilot runtime drops the replay of the sessions warm on its client with the reason runtime-lost, and the client leaves the pool with its handler", async t => {
    t.mock.method(console, "warn", () => {});
    await withKeepWarmFlag("1", async () => {
        const manager = new SessionManager(undefined, null, {});
        const client = await manager.ensureClient(undefined, false, undefined, true);
        client.forceStop = async () => {};
        const handler = client.requestHandler;
        const drops = [];
        const realDrop = handler.dropSession.bind(handler);
        handler.dropSession = (sessionId, reason) => { drops.push([sessionId, reason]); return realDrop(sessionId, reason); };
        const managed = { getActiveTurn: () => null };
        manager.sessions.set("s1", managed);
        manager.runtimeClients.set(managed, client);
        const other = { getActiveTurn: () => null };
        manager.sessions.set("s2", other);
        manager.runtimeClients.set(other, { another: "client" });
        manager._onRuntimeLost(client, { pid: 1, code: 137, signal: null, requested: false, duringStartup: false });
        assert.deepEqual(drops, [["s1", "runtime-lost"]], "only the session warm on the lost client");
        assert.equal(handler.isStopped, true, "the lost client's handler is closed");
        assert.equal(manager.heartbeats.size, 0);
        assert.equal(manager.clients.size, 0);
        const fresh = await manager.ensureClient(undefined, false, undefined, true);
        assert.notEqual(fresh, client);
        assert.equal(fresh.requestHandler.isStopped, false, "a client made after the loss has a live handler");
        manager.stopKeepWarmHeartbeats();
    });
});

// The reader of a fresh token is the shared workload-identity cache's, for a session on an anthropic-wif model only.
test("the manager gives a workload-identity session a reader of fresh tokens from the shared cache, and any other session none", async () => {
    const saved = Object.fromEntries(Object.keys(WIF_ENV).map(key => [key, process.env[key]]));
    Object.assign(process.env, WIF_ENV);
    const registry = new ModelProviderRegistry({
        providers: [
            ...WIF_CONFIG.providers,
            { id: "github-copilot", type: "github", models: [{ name: "claude-sonnet-5" }] },
        ],
    }, { keepUncredentialed: true });
    try {
        let issued = 0;
        const fetchImpl = async url => {
            const entra = String(url).includes("login.microsoftonline.com");
            if (!entra) issued++;
            const body = entra ? { access_token: "entra-jwt", expires_in: 86_400 } : { access_token: `tok-${issued}`, expires_in: 300 };
            return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
        };
        anthropicWifCredentials(readAnthropicWifSettings(WIF_ENV).settings, { fetch: fetchImpl, readFile: async () => "projected", now: () => Date.now() });
        const manager = new SessionManager(undefined, null, { modelProviders: registry });
        manager.sessionConfigs.set("wif", { model: "wif:claude-opus-5" });
        manager.sessionConfigs.set("ghcp", { model: "github-copilot:claude-sonnet-5" });
        const read = manager.keepWarmBearerToken("wif", "claude-opus-5");
        assert.equal(typeof read, "function");
        assert.equal(await read(), "tok-1");
        assert.equal(manager.keepWarmBearerToken("wif", "claude-sonnet-5"), undefined, "a request for another model");
        assert.equal(manager.keepWarmBearerToken("ghcp", "claude-sonnet-5"), undefined, "GitHub Copilot holds its own token");
        assert.equal(manager.keepWarmBearerToken("nobody", "claude-opus-5"), undefined, "an unknown session");
    } finally {
        resetAnthropicWifCredentials();
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
});

// Each place the session manager ends a session's replay, with the reason it gives.
function dropFixture(t) {
    const home = mkdtempSync(join(tmpdir(), "ps-hb-drop-"));
    const manager = new SessionManager(undefined, null, {}, home);
    manager.setFactStore({
        readFacts: async () => ({ count: 0, facts: [] }),
        storeFact: async () => ({ stored: true }),
        deleteFact: async () => ({ deleted: true }),
    });
    const drops = [];
    manager.heartbeats.set("fake", { dropSession: (sessionId, reason) => { drops.push([sessionId, reason]); return true; }, stopAll() {} });
    const open = config => {
        mkdirSync(join(home, config.sessionId), { recursive: true });
        return { disconnect: async () => {}, rpc: { tasks: { list: async () => ({ tasks: [] }), cancel: async () => ({ cancelled: true }) } } };
    };
    manager.ensureClient = async () => ({
        createSession: async config => open(config),
        resumeSession: async (_id, config) => open(config),
        deleteSession: async () => {},
    });
    t.after(async () => {
        for (const id of [...manager.sessions.keys()]) await manager.dropWarmSession(id);
        rmSync(home, { recursive: true, force: true });
    });
    return { manager, drops };
}

const openSession = (h, config = { workingDirectory: "/home/app" }, turnIndex = 0) => h.manager.getOrCreate("s1", config, { turnIndex });

test("destroying a session drops its replay with the reason close", async t => {
    const h = dropFixture(t);
    await openSession(h);
    await h.manager.destroySession("s1");
    assert.deepEqual(h.drops[0], ["s1", "close"]);
});

test("the eviction sweep drops a session's replay with the reason eviction", async t => {
    const h = dropFixture(t);
    await openSession(h);
    h.manager.sessionLastTouchedAt.set("s1", Date.now() - 60_000);
    await h.manager.sweepIdleSessions(1_000);
    assert.deepEqual(h.drops[0], ["s1", "eviction"]);
});

test("stopping a turn drops the session's replay with the reason abort, before the stop marker", async t => {
    const h = dropFixture(t);
    const managed = await openSession(h);
    let active = { turnIndex: 0, startedAt: Date.now() };
    managed.getActiveTurn = () => active;
    managed.requestStop = () => { assert.deepEqual(h.drops, [["s1", "abort"]], "dropped first"); };
    managed.abort = () => { active = undefined; };
    const result = await h.manager.abortWarmSessionTurn("s1", { reason: "stop", unwindGraceMs: 0 });
    assert.equal(result.outcome, "stopped");
    assert.deepEqual(h.drops, [["s1", "abort"]]);
});

test("a changed model configuration drops the session's replay with the reason model-change", async t => {
    const h = dropFixture(t);
    await openSession(h, { workingDirectory: "/home/app", model: "claude-sonnet-5" });
    await openSession(h, { workingDirectory: "/home/app", model: "claude-opus-5.5" }, 1);
    assert.ok(h.drops.some(([id, reason]) => id === "s1" && reason === "model-change"), JSON.stringify(h.drops));
});

test("a session that moves to another client drops its replay with the reason client-change", async t => {
    const h = dropFixture(t);
    await openSession(h);
    h.manager.sessionClientKeys.set("s1", "another-client-key");
    await openSession(h, { workingDirectory: "/home/app" }, 1);
    assert.ok(h.drops.some(([id, reason]) => id === "s1" && reason === "client-change"), JSON.stringify(h.drops));
});
