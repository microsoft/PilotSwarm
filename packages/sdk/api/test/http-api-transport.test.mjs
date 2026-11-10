import test from "node:test";
import assert from "node:assert/strict";
import { HttpApiTransport } from "../src/http-api-transport.js";
import { API_PREFIX } from "../src/protocol.js";

function jsonResponse(payload, { status = 200 } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: String(status),
        json: async () => payload,
    };
}

function createTransport({ responses = [] } = {}) {
    const calls = [];
    const transport = new HttpApiTransport({
        apiUrl: "https://portal.example.com",
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            if (responses.length === 0) throw new Error("no scripted response left");
            return responses.shift();
        },
    });
    return { transport, calls };
}

test("session subscription hands the reconnect replay hook to the API client", () => {
    const { transport } = createTransport();
    let hook = null;
    transport.api.subscribeSession = (_sessionId, _handler, onResubscribe) => { hook = onResubscribe; return () => {}; };
    transport.api.subscribeCanvasLive = () => () => {};
    transport.api.subscribeLive = () => () => {};
    transport.getCanvasLive = async () => [];
    const replays = [];
    const off = transport.subscribeSession("s1", () => {}, () => replays.push("s1"));
    assert.equal(typeof hook, "function");
    hook();
    assert.deepEqual(replays, ["s1"]);
    off();
});

function canvasTransport(snapshot = async () => []) {
    const { transport } = createTransport();
    const handlers = {};
    transport.api.subscribeSession = (_sid, handler, onResubscribe) => {
        handlers.event = handler;
        handlers.reconnect = onResubscribe;
        return () => {};
    };
    transport.api.subscribeCanvasLive = (_sid, handler) => { handlers.ping = handler; return () => {}; };
    transport.api.subscribeLive = () => () => {};
    transport.getCanvasLive = snapshot;
    const events = [];
    const off = transport.subscribeSession("s1", event => events.push(event));
    const ticks = () => events.filter(event => event.eventType === "session.canvas_data");
    return { transport, handlers, events, ticks, off };
}
const durableTick = (planeSeq, dataRev = 1, payload = { x: 1 }) => ({
    eventType: "session.canvas_data", seq: 20 + dataRev, sessionId: "s1",
    data: { slot: 1, dataRev, payload, ...(planeSeq ? { planeSeq } : {}) },
});

test("a doc ping with no later data ping never suppresses the durable fallback", () => {
    const h = canvasTransport();
    h.handlers.ping({ slot: 1, seq: 1, kind: "doc" });
    const event = durableTick(2);
    h.handlers.event(event);
    assert.deepEqual(h.ticks(), [event]);
    h.off();
});

test("a failed data-pointer fetch retries, then its durable payload still reaches the consumer", async () => {
    let reads = 0;
    const h = canvasTransport(async () => { reads++; throw new Error("HTTP 500"); });
    h.handlers.ping({ slot: 1, seq: 1, kind: "doc" });
    h.handlers.ping({ slot: 1, seq: 2, kind: "data" });
    assert.equal(await h.transport._canvasMirror.prime("s1"), false);
    assert.equal(reads, 3);
    const event = durableTick(2);
    h.handlers.event(event);
    assert.deepEqual(h.ticks(), [event]);
    h.off();
});

test("applied plane sequences suppress duplicate and older durable ticks, not newer or legacy ones", () => {
    const h = canvasTransport();
    h.handlers.ping({ slot: 1, seq: 1, kind: "doc" });
    h.handlers.ping({ slot: 1, seq: 2, kind: "data", patch: { x: 1 } });
    h.handlers.event(durableTick(2));
    h.handlers.event(durableTick(1));
    assert.equal(h.ticks().length, 1, "the plane delivery is the only data event");
    const newer = durableTick(3, 2, { x: 2 });
    h.handlers.event(newer);
    assert.equal(h.ticks().at(-1), newer, "a missed later ping cannot freeze a plane-fed slot");
    const legacy = durableTick(undefined, 3, { x: 3 });
    h.handlers.event(legacy);
    assert.equal(h.ticks().at(-1), legacy, "different counters must never be compared");
    h.off();
});

test("reconnect re-primes subscribed canvas state even when no new ping follows", async () => {
    let reads = 0;
    const h = canvasTransport(async () => {
        reads++;
        return [{ slot: 1, seq: 3, payload: { x: 2 } }];
    });
    h.handlers.ping({ slot: 1, seq: 1, kind: "doc" });
    h.handlers.ping({ slot: 1, seq: 2, kind: "data", patch: { x: 1 } });
    h.handlers.reconnect();
    await h.transport._canvasMirror.prime("s1");
    assert.equal(reads, 1);
    assert.deepEqual(h.ticks().at(-1).data.payload, { x: 2 });
    assert.equal(h.ticks().at(-1).data.planeSeq, 3);
    h.off();
});

test("reconnect does not replay an unchanged applied tick into the canvas", async () => {
    const h = canvasTransport(async () => [{ slot: 1, seq: 2, payload: { x: 1 } }]);
    h.handlers.ping({ slot: 1, seq: 1, kind: "doc" });
    h.handlers.ping({ slot: 1, seq: 2, kind: "data", patch: { x: 1 } });
    h.handlers.reconnect();
    await h.transport._canvasMirror.prime("s1");
    h.handlers.event(durableTick(2));
    assert.equal(h.ticks().length, 1, "neither the resync nor the durable copy is a new application");
    h.off();
});

test("session subscription forwards native task snapshots transiently and releases both live topics", () => {
    const { transport } = createTransport();
    const callbacks = new Map();
    const released = [];
    transport.api.subscribeSession = () => () => released.push("events");
    transport.api.subscribeCanvasLive = () => () => released.push("canvas");
    transport.api.subscribeLive = (sessionId, topic, handler) => {
        assert.equal(sessionId, "s1");
        callbacks.set(topic, handler);
        return () => released.push(topic);
    };
    const events = [];
    const off = transport.subscribeSession("s1", event => events.push(event));
    assert.deepEqual([...callbacks.keys()], ["turn", "native-tasks"]);
    const payload = { ownerId: "owner", revision: 4, phase: "live", tasks: [{ id: "call", status: "running" }] };
    callbacks.get("native-tasks")({ kind: "snapshot", seq: 9, updatedAt: "2026-09-08T00:00:00Z", data: payload });
    callbacks.get("native-tasks")({ kind: "signal" });
    assert.deepEqual(events, [{ eventType: "session.native_tasks_tick", sessionId: "s1", transient: true,
        liveSeq: 9, liveUpdatedAt: "2026-09-08T00:00:00Z", data: payload }]);
    callbacks.get("native-tasks")({ kind: "unavailable" });
    assert.deepEqual(events.at(-1).data, { phase: "unavailable" });
    off();
    assert.deepEqual(released, ["events", "canvas", "turn", "native-tasks"]);
});

test("placeSessionsInGroup posts sessionIds + groupId to the place route", async () => {
    const results = [{ rootSessionId: "a", placed: true, reason: null }];
    const { transport, calls } = createTransport({
        responses: [jsonResponse({ ok: true, result: results })],
    });
    const returned = await transport.placeSessionsInGroup(["a", "b"], "g1");
    assert.deepEqual(returned, results);
    assert.equal(calls[0].url, `https://portal.example.com${API_PREFIX}/management/session-groups/place`);
    assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].options.body), { groupId: "g1", sessionIds: ["a", "b"] });
});

test("placeSessionsInGroup normalizes undefined groupId to null (ungroup)", async () => {
    const { transport, calls } = createTransport({
        responses: [jsonResponse({ ok: true, result: [] })],
    });
    await transport.placeSessionsInGroup(["a"]);
    assert.deepEqual(JSON.parse(calls[0].options.body), { groupId: null, sessionIds: ["a"] });
});

test("move/assign alias wrappers return the per-root result array", async () => {
    const results = [{ rootSessionId: "a", placed: false, reason: "not_found" }];
    const { transport } = createTransport({
        responses: [
            jsonResponse({ ok: true, result: results }),
            jsonResponse({ ok: true, result: results }),
        ],
    });
    assert.deepEqual(await transport.moveSessionsToGroup(null, ["a"]), results);
    assert.deepEqual(await transport.assignSessionsToGroup("g1", ["a"]), results);
});

test("Stop and Steer forward every option, including the request id, unchanged", async () => {
    const { transport, calls } = createTransport({ responses: [
        jsonResponse({ ok: true, result: { outcome: "accepted", steerId: 9, turn: 2 } }),
        jsonResponse({ ok: true, result: { outcome: "stopped", turnIndex: 2, controlSeq: 10 } }),
    ] });
    assert.deepEqual(await transport.steerSessionTurn("s1", { text: "go", requestId: "r-1" }), { outcome: "accepted", steerId: 9, turn: 2 });
    assert.deepEqual(await transport.stopSessionTurn("s1", { requestId: "r-2", reason: "enough", timeoutMs: 5000 }),
        { outcome: "stopped", turnIndex: 2, controlSeq: 10 });
    assert.equal(calls[0].url, `https://portal.example.com${API_PREFIX}/management/sessions/s1/steer`);
    assert.deepEqual(JSON.parse(calls[0].options.body), { options: { text: "go", requestId: "r-1" } });
    assert.equal(calls[1].url, `https://portal.example.com${API_PREFIX}/management/sessions/s1/stop-turn`);
    assert.deepEqual(JSON.parse(calls[1].options.body), { options: { requestId: "r-2", reason: "enough", timeoutMs: 5000 } });
});

test("readWorkflow reads GET /sessions/:sessionId/workflow; only an absent run is left out of the query", async () => {
    const view = { workflowId: "s1", run: null };
    const { transport, calls } = createTransport({ responses: [
        jsonResponse({ ok: true, result: view }),
        jsonResponse({ ok: true, result: view }),
        jsonResponse({ ok: true, result: view }),
        jsonResponse({ ok: false, error: { code: "INVALID_REQUEST", message: "runId must be a run id of 1 to 256 characters." } }, { status: 400 }),
        jsonResponse({ ok: false, error: { code: "WORKFLOW_NOT_FOUND", message: "This session is not a version 2 workflow." } }, { status: 404 }),
    ] });
    assert.deepEqual(await transport.readWorkflow("s1"), view);
    assert.deepEqual(await transport.readWorkflow("s1", { runId: null }), view);
    assert.deepEqual(await transport.readWorkflow("s1", { runId: "run-1" }), view);
    // An explicit empty run is sent, so the server validates it (400) instead of reading the live run.
    await assert.rejects(transport.readWorkflow("s1", { runId: "" }), (error) => error.code === "INVALID_REQUEST" && error.status === 400);
    await assert.rejects(transport.readWorkflow("agent-1"), (error) => error.code === "WORKFLOW_NOT_FOUND" && error.status === 404);
    assert.equal(calls[0].url, `https://portal.example.com${API_PREFIX}/sessions/s1/workflow`);
    assert.equal(calls[0].options.method, "GET");
    assert.equal(calls[0].options.body, undefined);
    assert.equal(calls[1].url, `https://portal.example.com${API_PREFIX}/sessions/s1/workflow`);
    assert.equal(calls[2].url, `https://portal.example.com${API_PREFIX}/sessions/s1/workflow?runId=run-1`);
    assert.equal(calls[3].url, `https://portal.example.com${API_PREFIX}/sessions/s1/workflow?runId=`);
    assert.equal(calls[4].url, `https://portal.example.com${API_PREFIX}/sessions/agent-1/workflow`);
});

test("readWorkflow sends a section's cursor, an execution id and a limit only when given; the read's refusals keep their codes", async () => {
    const page = { workflowId: "s1", runId: "R", section: "inbox", order: "newest_first", limit: 5, items: [], nextCursor: null };
    const { transport, calls } = createTransport({ responses: [
        jsonResponse({ ok: true, result: page }),
        jsonResponse({ ok: false, error: { code: "EXECUTION_NOT_FOUND", message: "Execution nx-9 is not a node execution of run R." } }, { status: 404 }),
        jsonResponse({ ok: false, error: { code: "WORKFLOW_CURSOR_INVALID", message: "This cursor is for another workflow." } }, { status: 400 }),
    ] });
    const cursor = { v: 1, workflowId: "s1", runId: "R", section: "inbox", order: "newest_first", after: { seq: "3" } };
    assert.deepEqual(await transport.readWorkflow("s1", { runId: "R", cursor, limit: 5, executionId: null }), page);
    await assert.rejects(transport.readWorkflow("s1", { executionId: "nx-9" }), (error) => error.code === "EXECUTION_NOT_FOUND" && error.status === 404);
    await assert.rejects(transport.readWorkflow("s1", { cursor: { ...cursor, workflowId: "other" } }),
        (error) => error.code === "WORKFLOW_CURSOR_INVALID" && error.status === 400);
    const first = new URL(calls[0].url);
    assert.equal(first.pathname, `${API_PREFIX}/sessions/s1/workflow`);
    assert.deepEqual([first.searchParams.get("runId"), JSON.parse(first.searchParams.get("cursor")), first.searchParams.get("limit"), first.searchParams.has("executionId")],
        ["R", cursor, "5", false]);
    assert.equal(new URL(calls[1].url).search, "?executionId=nx-9");
});
