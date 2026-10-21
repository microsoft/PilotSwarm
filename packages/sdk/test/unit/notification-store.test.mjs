/**
 * Per-user notification store and management methods: procedure-only SQL,
 * principal required, bounded/validated ids, and UNAVAILABLE without a CMS.
 *
 * Run: node --test test/unit/notification-store.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { PgNotificationStore } from "../../dist/notification-store.js";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";

const alice = { provider: "entra", subject: "alice" };

function fakePool(rows = [{ count: 3 }]) {
    const queries = [];
    return { queries, query: async (text, values) => { queries.push({ text, values }); return { rows }; } };
}

test("writers call only the notify/resolve procedures with the exact package identity", async () => {
    const pool = fakePool();
    const store = new PgNotificationStore(pool, 'odd"schema');
    const identity = { packageId: "pkg", versionId: "v1", sha256: "a".repeat(64) };
    assert.equal(await store.notifyCronPrecheckBroken({ sessionId: "s1", precheck: "queue", outcome: "error", packageIdentity: identity }), 3);
    await store.notifyCronPrecheckBroken({ sessionId: "s1", precheck: "trusted", outcome: "timeout" });
    assert.equal(await store.resolveCronPrecheckBroken("s1"), 3);
    assert.deepEqual(pool.queries.map((q) => q.text), [
        'SELECT "odd""schema".cms_notify_cron_precheck_broken($1,$2,$3,$4,$5,$6) AS count',
        'SELECT "odd""schema".cms_notify_cron_precheck_broken($1,$2,$3,$4,$5,$6) AS count',
        'SELECT "odd""schema".cms_resolve_cron_precheck_broken($1) AS count',
    ]);
    assert.deepEqual(pool.queries[0].values, ["s1", "queue", "error", "pkg", "v1", "a".repeat(64)]);
    assert.deepEqual(pool.queries[1].values, ["s1", "trusted", "timeout", null, null, null]);
});

test("readers require a principal and pass only the caller's identity", async () => {
    const pool = fakePool([{ notification_id: "9", kind: "package_review", payload: { decision: "approved" }, occurrences: 1,
        created_at: "2025-01-01T00:00:00Z", notified_at: "2025-01-01T00:00:00Z", last_seen_at: "2025-01-01T00:00:00Z",
        read_at: null, resolved_at: null }]);
    const store = new PgNotificationStore(pool, "s");
    for (const principal of [null, { provider: "entra", subject: " " }, { provider: "", subject: "x" }]) {
        await assert.rejects(store.list(principal), { code: "FORBIDDEN" });
        await assert.rejects(store.markRead(principal, null), { code: "FORBIDDEN" });
    }
    assert.equal(pool.queries.length, 0);
    const [item] = await store.list(alice, { unreadOnly: true, limit: 5 });
    assert.equal(item.id, "9");
    assert.equal(item.readAt, null);
    assert.ok(item.createdAt instanceof Date);
    await store.list(alice, { limit: 1.5 });
    assert.deepEqual(pool.queries.map((q) => q.values), [["entra", "alice", true, 5], ["entra", "alice", false, null]]);
});

test("mark-read validates ids as bounded decimal identifiers", async () => {
    const pool = fakePool([{ count: 2 }]);
    const store = new PgNotificationStore(pool, "s");
    assert.equal(await store.markRead(alice, ["1", "42"]), 2);
    assert.equal(await store.markRead(alice, null), 2);
    for (const ids of [["0"], ["-1"], ["1e3"], [1], ["1; DROP"], ["9".repeat(20)], Array.from({ length: 501 }, (_, i) => String(i + 1)), "1"]) {
        await assert.rejects(store.markRead(alice, ids), { code: "INVALID_REQUEST" }, JSON.stringify(ids).slice(0, 40));
    }
    assert.equal(pool.queries[0].text, 'SELECT "s".cms_mark_user_notifications_read($1,$2,$3::BIGINT[]) AS count');
    assert.deepEqual(pool.queries.map((q) => q.values), [["entra", "alice", ["1", "42"]], ["entra", "alice", null]]);
});

test("management methods delegate with the caller's principal and are UNAVAILABLE without a CMS", async () => {
    const calls = [];
    const client = Object.create(PilotSwarmManagementClient.prototype);
    Object.assign(client, { _started: true, _catalog: { notifications: {
        list: async (owner, options) => { calls.push(["list", owner, options]); return []; },
        markRead: async (owner, ids) => { calls.push(["read", owner, ids]); return 4; },
    } } });
    assert.deepEqual(await client.listMyNotifications(undefined, alice), []);
    assert.deepEqual(await client.markNotificationsRead(undefined, alice), { updated: 4 });
    assert.deepEqual(calls, [["list", alice, {}], ["read", alice, null]]);
    const bare = Object.create(PilotSwarmManagementClient.prototype);
    Object.assign(bare, { _started: true, _catalog: {} });
    await assert.rejects(bare.listMyNotifications({}, alice), { code: "UNAVAILABLE" });
    await assert.rejects(bare.markNotificationsRead(null, alice), { code: "UNAVAILABLE" });
});
