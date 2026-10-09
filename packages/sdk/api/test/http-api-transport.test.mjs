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

test("Workflow transport publishes Definitions and registers Generators", async () => {
    const created = {
        generator: { workflowGeneratorId: "g1", name: "HelloWorld" },
    };
    const { transport, calls } = createTransport({
        responses: [
            jsonResponse({ ok: true, result: { workflowDefinitionId: "d1", version: 1 } }),
            jsonResponse({ ok: true, result: created }),
            jsonResponse({ ok: true, result: [created.generator] }),
        ],
    });

    const definition = {
        workflowType: "hello-world",
        name: "Hello World",
        definition: { workflowDefinition: { lifecycle: { initialState: "Initial" } } },
    };
    assert.equal((await transport.createWorkflowDefinition(definition)).workflowDefinitionId, "d1");
    assert.deepEqual(JSON.parse(calls[0].options.body), definition);
    assert.equal(new URL(calls[0].url).pathname, `${API_PREFIX}/workflow-definitions`);

    const generator = {
        name: "HelloWorld",
        cadenceSeconds: 300,
        workflowDefinitionId: "d1",
        source: {
            type: "ado_wiql",
            config: { wiql: "SELECT [System.Id] FROM WorkItems" },
        },
    };
    assert.deepEqual(await transport.createWorkflowGenerator(generator), created);
    assert.deepEqual(JSON.parse(calls[1].options.body), generator);
    assert.equal(new URL(calls[1].url).pathname, `${API_PREFIX}/workflow-generators`);

    assert.deepEqual(await transport.listWorkflowGenerators({ scope: "fleet" }), [created.generator]);
    assert.equal(new URL(calls[2].url).pathname, `${API_PREFIX}/workflow-generators`);
    assert.equal(new URL(calls[2].url).searchParams.get("scope"), "fleet");
    assert.equal(calls[2].options.method, "GET");
});

test("catalog page transport flattens cursors and forwards filters", async () => {
    const { transport, calls } = createTransport({
        responses: [
            jsonResponse({ ok: true, result: { items: [], hasMore: false, nextCursor: null } }),
            jsonResponse({ ok: true, result: { sessions: [], hasMore: false, nextCursor: null } }),
        ],
    });

    await transport.listWorkflowGeneratorsPage({
        scope: "fleet",
        cursor: { updatedAt: 10, id: "g1" },
        owner: "alice",
        repository: "repo",
    });
    await transport.listSessionsPage({
        scope: "fleet",
        cursor: { updatedAt: 30, sessionId: "s1" },
        owner: "alice",
        status: "running",
        updatedAfter: "2026-01-01T00:00:00.000Z",
    });

    const generatorUrl = new URL(calls[0].url);
    assert.equal(generatorUrl.searchParams.get("cursorUpdatedAt"), "10");
    assert.equal(generatorUrl.searchParams.get("cursorId"), "g1");
    assert.equal(generatorUrl.searchParams.get("owner"), "alice");
    assert.equal(generatorUrl.searchParams.has("cursor"), false);

    const sessionUrl = new URL(calls[1].url);
    assert.equal(sessionUrl.searchParams.get("cursorUpdatedAt"), "30");
    assert.equal(sessionUrl.searchParams.get("cursorSessionId"), "s1");
    assert.equal(sessionUrl.searchParams.get("status"), "running");
    assert.equal(sessionUrl.searchParams.get("updatedAfter"), "2026-01-01T00:00:00.000Z");
});

test("Workflow transport deletes generators through resource routes", async () => {
    const result = {
        aggregateType: "generator",
        aggregateId: "g1",
        alreadyDeleted: false,
        deletedSessionCount: 2,
    };
    const { transport, calls } = createTransport({
        responses: [jsonResponse({ ok: true, result })],
    });

    assert.deepEqual(await transport.deleteWorkflowGenerator("g1"), result);
    assert.equal(new URL(calls[0].url).pathname, `${API_PREFIX}/workflow-generators/g1`);
    assert.equal(calls[0].options.method, "DELETE");
});

test("fleet detail transport forwards scope on retained resource reads", async () => {
    const { transport, calls } = createTransport({
        responses: Array.from({ length: 3 }, () => jsonResponse({ ok: true, result: [] })),
    });

    await transport.getWorkflowGenerator("g1", { scope: "fleet" });
    await transport.getWorkflowDefinition("d1", { scope: "fleet" });
    await transport.getSession("s1", { scope: "fleet" });

    for (const call of calls) {
        assert.equal(new URL(call.url).searchParams.get("scope"), "fleet");
        assert.equal(call.options.method, "GET");
    }
});
