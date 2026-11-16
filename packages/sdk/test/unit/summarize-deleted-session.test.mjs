/**
 * Review D3-001: a turn refused because its session was deleted returns `stopped` and queues its own delete; the
 * orchestration then runs its due title activity before it drains that delete. The activity read the session's row
 * (a deleted row is hidden, so the read is null), went on to read the retained conversation and sent it to the
 * default title model. It now stops at a missing row: no conversation read, no title client, no title written. A live
 * session's title is unchanged, and a failed row read still fails the activity.
 *
 * Run: node --test test/unit/summarize-deleted-session.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { registerActivities } from "../../dist/session-proxy.js";

function harness(rowFor) {
    const calls = { getSession: [], getSessionEvents: [], updateSession: [], resolveDefaultProvider: 0 };
    const catalog = {
        getSession: async id => { calls.getSession.push(id); return rowFor(id); },
        getSessionEvents: async id => {
            calls.getSessionEvents.push(id);
            return [{ eventType: "user.message", data: { content: "Plan the retained-marker migration" } }];
        },
        updateSession: async (id, patch) => { calls.updateSession.push([id, patch]); },
    };
    // The title client is made right after the default provider is resolved; reaching it is the failure.
    const sessionManager = {
        resolveDefaultProvider() {
            calls.resolveDefaultProvider += 1;
            throw new Error("the title model was reached");
        },
    };
    const handlers = new Map();
    registerActivities({ registerActivity: (name, fn) => handlers.set(name, fn) }, sessionManager, null, undefined, catalog);
    const summarize = handlers.get("summarizeSession");
    assert.equal(typeof summarize, "function");
    return { calls, summarize: id => summarize({ traceInfo() {}, traceWarn() {} }, { sessionId: id }) };
}

test("a deleted session (its row read is null) gets no title and its conversation goes to no model", async () => {
    const { calls, summarize } = harness(() => null);
    assert.equal(await summarize("deleted-1"), "");
    assert.deepEqual(calls.getSession, ["deleted-1"]);
    assert.deepEqual(calls.getSessionEvents, []);
    assert.equal(calls.resolveDefaultProvider, 0);
    assert.deepEqual(calls.updateSession, []);
});

test("a live session still reads its conversation and asks the title model", async () => {
    const { calls, summarize } = harness(id => ({ sessionId: id, title: "", isSystem: false, titleLocked: false }));
    await assert.rejects(summarize("live-1"), /the title model was reached/);
    assert.deepEqual(calls.getSessionEvents, ["live-1"]);
    assert.equal(calls.resolveDefaultProvider, 1);
});

test("a failed row read still fails the activity; it is not taken as a deleted row", async () => {
    const { calls, summarize } = harness(() => { throw new Error("catalog unavailable"); });
    await assert.rejects(summarize("unknown-1"), /catalog unavailable/);
    assert.deepEqual(calls.getSessionEvents, []);
    assert.equal(calls.resolveDefaultProvider, 0);
});
