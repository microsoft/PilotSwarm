import test from "node:test";
import assert from "node:assert/strict";
import {
    API_PREFIX,
    OPERATIONS,
    buildOperationRequest,
    coerceQueryValue,
    getOperation,
    artifactDownloadPath,
} from "../src/protocol.js";

test("operation names and method+path pairs are unique", () => {
    const names = new Set();
    const routes = new Set();
    for (const op of OPERATIONS) {
        assert.ok(!names.has(op.name), `duplicate operation name: ${op.name}`);
        names.add(op.name);
        const route = `${op.method} ${op.path}`;
        assert.ok(!routes.has(route), `duplicate route: ${route}`);
        routes.add(route);
    }
});

test("every path param has a matching :segment and vice versa", () => {
    for (const op of OPERATIONS) {
        const templateParams = [...op.path.matchAll(/:([\w]+)/g)].map((m) => m[1]);
        const declaredPathParams = Object.entries(op.params || {})
            .filter(([, spec]) => spec.in === "path")
            .map(([key, spec]) => spec.name || key);
        assert.deepEqual(
            [...templateParams].sort(),
            [...declaredPathParams].sort(),
            `path params mismatch for ${op.name} (${op.path})`,
        );
    }
});

test("GET/DELETE operations carry no body params", () => {
    for (const op of OPERATIONS) {
        if (op.method !== "GET" && op.method !== "DELETE") continue;
        const bodyParams = Object.entries(op.params || {}).filter(([, spec]) => spec.in === "body");
        assert.equal(bodyParams.length, 0, `${op.name} is ${op.method} but declares body params`);
    }
});

test("buildOperationRequest resolves path, query, and body placement", () => {
    const { method, path, query, body } = buildOperationRequest("getSessionEvents", {
        sessionId: "abc/123",
        afterSeq: 5,
        limit: 50,
    });
    assert.equal(method, "GET");
    assert.equal(path, `${API_PREFIX}/management/sessions/abc%2F123/events`);
    assert.equal(query.get("afterSeq"), "5");
    assert.equal(query.get("limit"), "50");
    assert.equal(body, null);

    const send = buildOperationRequest("sendMessage", {
        sessionId: "s1",
        prompt: "hello",
        options: { clientMessageIds: ["m1"] },
    });
    assert.equal(send.method, "POST");
    assert.equal(send.path, `${API_PREFIX}/sessions/s1/messages`);
    assert.deepEqual(send.body, { prompt: "hello", options: { clientMessageIds: ["m1"] } });
});

test("session page query params round-trip through encode + coerce", () => {
    const cursor = { updatedAt: 1751500000000, sessionId: "abc" };
    const { query } = buildOperationRequest("listSessionsPage", { limit: 10, cursor, includeDeleted: true, systemFilter: "only", viewerOnly: true });
    assert.deepEqual(coerceQueryValue(query.get("cursor"), "json"), cursor);
    assert.equal(coerceQueryValue(query.get("limit"), "number"), 10);
    assert.equal(coerceQueryValue(query.get("includeDeleted"), "boolean"), true);
    assert.equal(query.get("systemFilter"), "only");
    assert.equal(coerceQueryValue(query.get("viewerOnly"), "boolean"), true);
});

test("missing required path params throw", () => {
    assert.throws(() => buildOperationRequest("getSession", {}), /requires param 'sessionId'/);
    assert.throws(() => buildOperationRequest("nonexistentOp", {}), /Unknown API operation/);
});

test("null body values are preserved (github copilot key clear)", () => {
    const { body } = buildOperationRequest("setCurrentUserGitHubCopilotKey", { key: null });
    assert.deepEqual(body, { key: null });
});

test("moveSessionsToGroup carries nullable groupId in body", () => {
    const { body } = buildOperationRequest("moveSessionsToGroup", { groupId: null, sessionIds: ["a"] });
    assert.deepEqual(body, { groupId: null, sessionIds: ["a"] });
});

test("placeSessionsInGroup posts nullable groupId + sessionIds to the place route", () => {
    const { method, path, body } = buildOperationRequest("placeSessionsInGroup", { groupId: null, sessionIds: ["a", "b"] });
    assert.equal(method, "POST");
    assert.equal(path, `${API_PREFIX}/management/session-groups/place`);
    assert.deepEqual(body, { groupId: null, sessionIds: ["a", "b"] });

    const grouped = buildOperationRequest("placeSessionsInGroup", { groupId: "g1", sessionIds: ["a"] });
    assert.deepEqual(grouped.body, { groupId: "g1", sessionIds: ["a"] });
});

test("coerceQueryValue rejects malformed json", () => {
    assert.throws(() => coerceQueryValue("{nope", "json"), /Malformed JSON/);
});

test("a strict string query param (readWorkflow's runId) is carried only as one string; anything else stays invalid (READ-WIRE-04)", () => {
    assert.equal(getOperation("readWorkflow").params.runId.strict, true);
    const sent = (runId) => buildOperationRequest("readWorkflow", { sessionId: "s1", runId }).query;
    assert.equal(sent("R").get("runId"), "R");
    assert.equal(sent("").get("runId"), "");
    // A list holding a run, a number, a repeated run or an object is sent as the empty string, which is never a run id.
    for (const runId of [["R"], 5, ["R", "R"], { runId: "R" }, true]) assert.equal(sent(runId).get("runId"), "", JSON.stringify(runId));
    assert.equal(sent(undefined).has("runId"), false);
    assert.equal(sent(null).has("runId"), false);
    // The server reads it the same way: a repeated or structured value is never joined into an id.
    const strict = { strict: true };
    assert.equal(coerceQueryValue("R", "string", strict), "R");
    assert.equal(coerceQueryValue("", "string", strict), "");
    for (const raw of [["R"], ["R", "R"], { runId: "R" }]) assert.equal(coerceQueryValue(raw, "string", strict), "", JSON.stringify(raw));
    assert.equal(coerceQueryValue(undefined, "string", strict), undefined);
    // Every other string param keeps its coercion.
    assert.equal(coerceQueryValue(["a", "b"], "string"), "a,b");
    assert.equal(buildOperationRequest("getProviderUsageSummary", { providers: ["a", "b"] }).query.get("providers"), "a,b");
    assert.equal(getOperation("getProviderUsageSummary").params.providers.strict, undefined);
});

test("readWorkflow's cursor and limit travel as JSON and its execution id as one string, each only when given", () => {
    const op = getOperation("readWorkflow");
    assert.deepEqual([op.params.cursor, op.params.limit, op.params.executionId],
        [{ in: "query", type: "json" }, { in: "query", type: "json" }, { in: "query", type: "string", strict: true }]);
    const cursor = { v: 1, workflowId: "wf", runId: "R", section: "inbox", order: "newest_first", after: { seq: "3" } };
    const sent = buildOperationRequest("readWorkflow", { sessionId: "s1", cursor, limit: 5, executionId: "nx-1" }).query;
    assert.deepEqual(JSON.parse(sent.get("cursor")), cursor);
    assert.equal(sent.get("limit"), "5");
    assert.equal(sent.get("executionId"), "nx-1");
    assert.equal(buildOperationRequest("readWorkflow", { sessionId: "s1", executionId: ["nx-1"] }).query.get("executionId"), "", "a list is never an id");
    const none = buildOperationRequest("readWorkflow", { sessionId: "s1" }).query;
    assert.deepEqual([none.has("cursor"), none.has("limit"), none.has("executionId")], [false, false, false]);
    // The server reads them back as they were sent; a cursor that is not JSON is refused before anything is read.
    assert.deepEqual(coerceQueryValue(sent.get("cursor"), "json"), cursor);
    assert.equal(coerceQueryValue("5", "json"), 5);
    assert.throws(() => coerceQueryValue("{next", "json"), (error) => error.code === "INVALID_REQUEST");
});

test("artifactDownloadPath encodes segments", () => {
    assert.equal(
        artifactDownloadPath("s 1", "a/b.txt"),
        `${API_PREFIX}/sessions/s%201/artifacts/a%2Fb.txt/download`,
    );
});

test("getOperation returns the table entry", () => {
    assert.equal(getOperation("listSessions").method, "GET");
    assert.equal(getOperation("missing"), null);
});

test("Stop and Steer share session:write and carry their options in the body", () => {
    const steer = getOperation("steerSessionTurn");
    assert.equal(steer.access, "session:write", "Steer needs the same write access as sending a message");
    assert.equal(steer.method, "POST");
    assert.equal(steer.path, "/management/sessions/:sessionId/steer");
    assert.equal(getOperation("stopSessionTurn").access, "session:write");
    assert.equal(getOperation("sendMessage").access, steer.access);

    const built = buildOperationRequest("steerSessionTurn", { sessionId: "s/1", options: { text: "use metric", requestId: "r-1" } });
    assert.equal(built.method, "POST");
    assert.equal(built.path, `${API_PREFIX}/management/sessions/s%2F1/steer`);
    assert.deepEqual(built.body, { options: { text: "use metric", requestId: "r-1" } });

    const stop = buildOperationRequest("stopSessionTurn", { sessionId: "s1", options: { requestId: "r-2", reason: "enough" } });
    assert.equal(stop.path, `${API_PREFIX}/management/sessions/s1/stop-turn`);
    assert.deepEqual(stop.body, { options: { requestId: "r-2", reason: "enough" } }, "the request id reaches the server unchanged");
});
