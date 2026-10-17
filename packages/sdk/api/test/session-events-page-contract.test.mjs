/**
 * Protocol contract for getSessionEventsPage (issue 148).
 *
 * Two jobs. First, pin the new operation's shape and — importantly — its
 * ACCESS classification, so the paged read can never drift to a weaker gate
 * than the reads it sits beside. Second, pin the two legacy event operations
 * so this additive change is shown, by assertion rather than by diff shape,
 * not to have altered them.
 *
 * Pure: imports the protocol table from source, so it runs without a build
 * and without a database.
 *
 * STATUS: WRITTEN BUT NEVER EXECUTED. No test grant existed when this was
 * authored. Treat every assertion as unverified until a real run reports.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { OPERATIONS, getOperation, buildOperationRequest, API_PREFIX } from "../src/protocol.js";

const PAGE = "getSessionEventsPage";
const FORWARD = "getSessionEvents";
const BACKWARD = "getSessionEventsBefore";

test("getSessionEventsPage is present in the protocol table", () => {
    const op = getOperation(PAGE);
    assert.ok(op, `${PAGE} must be declared; the web path cannot work without it`);
    assert.equal(op.name, PAGE);
});

test("the paged read carries the SAME access gate as the legacy reads", () => {
    // The whole point of the feature is reaching history under the caller's
    // existing permission. A weaker gate here would widen access silently.
    const page = getOperation(PAGE);
    const forward = getOperation(FORWARD);
    const backward = getOperation(BACKWARD);

    assert.equal(page.access, "session:read");
    assert.equal(page.access, forward.access, "must not differ from the forward read");
    assert.equal(page.access, backward.access, "must not differ from the backward read");
});

test("the paged read is a GET on its own path", () => {
    const op = getOperation(PAGE);
    assert.equal(op.method, "GET", "a history read must not be a mutation");
    assert.equal(op.path, "/management/sessions/:sessionId/events-page");
});

test("the paged read accepts both cursors and the filter", () => {
    const params = getOperation(PAGE).params;
    assert.ok(params.sessionId, "sessionId");
    assert.ok(params.afterSeq, "afterSeq (forward continuation)");
    assert.ok(params.beforeSeq, "beforeSeq (backward drain)");
    assert.ok(params.limit, "limit");
    assert.ok(params.eventTypes, "eventTypes (server-side filter)");
    assert.equal(params.sessionId.in, "path");
    for (const key of ["afterSeq", "beforeSeq", "limit", "eventTypes"]) {
        assert.equal(params[key].in, "query", `${key} is a query param`);
    }
});

test("numeric cursors coerce as numbers and the filter as json", () => {
    const params = getOperation(PAGE).params;
    assert.equal(params.afterSeq.type, "number");
    assert.equal(params.beforeSeq.type, "number");
    assert.equal(params.limit.type, "number");
    assert.equal(params.eventTypes.type, "json", "eventTypes travels JSON-encoded, like the legacy reads");
});

test("a paged request builds the expected URL and query", () => {
    const { method, path, query } = buildOperationRequest(PAGE, {
        sessionId: "11111111-2222-3333-4444-555555555555",
        beforeSeq: 500,
        limit: 100,
        eventTypes: ["assistant.message"],
    });
    assert.equal(method, "GET");
    assert.equal(path, `${API_PREFIX}/management/sessions/11111111-2222-3333-4444-555555555555/events-page`);
    assert.equal(String(query.beforeSeq), "500");
    assert.equal(String(query.limit), "100");
    assert.equal(query.eventTypes, JSON.stringify(["assistant.message"]));
});

test("the operation name is unique and does not shadow the legacy reads", () => {
    const names = OPERATIONS.map((op) => op.name);
    assert.equal(names.filter((n) => n === PAGE).length, 1);
    assert.ok(names.includes(FORWARD), "the forward read must still exist");
    assert.ok(names.includes(BACKWARD), "the backward read must still exist");
});

// ── the legacy reads are pinned, by assertion not by diff shape ──

test("getSessionEvents is unchanged", () => {
    const op = getOperation(FORWARD);
    assert.equal(op.access, "session:read");
    assert.equal(op.method, "GET");
    assert.equal(op.path, "/management/sessions/:sessionId/events");
    assert.deepEqual(
        Object.keys(op.params).sort(),
        ["afterSeq", "eventTypes", "limit", "sessionId"],
        "no parameter added, removed or renamed",
    );
});

test("getSessionEventsBefore is unchanged", () => {
    const op = getOperation(BACKWARD);
    assert.equal(op.access, "session:read");
    assert.equal(op.method, "GET");
    assert.equal(op.path, "/management/sessions/:sessionId/events-before");
    assert.deepEqual(
        Object.keys(op.params).sort(),
        ["beforeSeq", "eventTypes", "limit", "sessionId"],
        "no parameter added, removed or renamed",
    );
});

test("a legacy request still builds exactly as before", () => {
    const { method, path, query } = buildOperationRequest(FORWARD, {
        sessionId: "11111111-2222-3333-4444-555555555555",
        afterSeq: 42,
        limit: 50,
    });
    assert.equal(method, "GET");
    assert.equal(path, `${API_PREFIX}/management/sessions/11111111-2222-3333-4444-555555555555/events`);
    assert.equal(String(query.afterSeq), "42");
    assert.equal(String(query.limit), "50");
});
