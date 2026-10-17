// The legacy canvas app catalog `apps/` (issue 181): canvas apps live in
// their own registry now. The fact tools still READ `apps/<name>` (the
// one-time migration and old sessions use it), but no agent — the Facts
// Manager included — writes or deletes there.
//
// Run: node --test test/unit/facts-tools-canvas-apps.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createFactTools } from "../../dist/facts-tools.js";

function fakeStore(rows = []) {
    const calls = { store: [], delete: [] };
    return {
        calls,
        async storeFact(input) {
            const inputs = Array.isArray(input) ? input : [input];
            calls.store.push(...inputs);
            const result = { stored: inputs.length, facts: inputs.map((i) => ({ key: i.key, shared: i.shared === true, stored: true })) };
            return Array.isArray(input) ? result : result.facts[0];
        },
        async readFacts() { return { count: rows.length, facts: rows }; },
        async deleteFact(input) { calls.delete.push(input); return { key: input.key, shared: false, deleted: true }; },
    };
}

const CTX = { sessionId: "s1" };
const toolsFor = (store, agentIdentity) => Object.fromEntries(createFactTools({ factStore: store, agentIdentity }).map((t) => [t.name, t]));

for (const identity of ["task-agent", "facts-manager"]) {
    test(`${identity}: apps/ is not written or deleted through the fact tools`, async () => {
        const store = fakeStore();
        const { store_fact, delete_fact } = toolsFor(store, identity);
        const write = await store_fact.handler({ key: "apps/board", value: { source: "app-board.html" }, shared: true }, CTX);
        assert.match(String(write.error ?? write), /legacy canvas app catalog/);
        const batch = await store_fact.handler({ facts: [{ key: "ok/a", value: 1 }, { key: "apps/board", value: 2 }] }, CTX);
        assert.match(String(batch.error ?? batch), /legacy canvas app catalog/);
        assert.equal(store.calls.store.length, 0, "nothing reached the store");
        const del = await delete_fact.handler({ key: "apps/board", shared: true }, CTX);
        assert.match(String(del.error ?? del), /legacy canvas app catalog/);
        const pattern = await delete_fact.handler({ key: "apps/*", pattern: true, scope: "shared" }, CTX);
        assert.match(String(pattern.error ?? pattern), /legacy canvas app catalog/);
        assert.equal(store.calls.delete.length, 0);
    });
}

test("apps/ stays readable", async () => {
    const rows = [{ key: "apps/board", value: { name: "board" }, shared: true, sessionId: "s0" }];
    const { read_facts } = toolsFor(fakeStore(rows), "task-agent");
    const out = await read_facts.handler({ key_pattern: "apps/board", scope: "shared" }, CTX);
    assert.equal(out.error, undefined);
    assert.deepEqual(out.facts.map((f) => f.key), ["apps/board"]);
});

test("management fact writes cannot reach the legacy apps/ catalog either (Web API, MCP)", async () => {
    const { PilotSwarmManagementClient } = await import("../../dist/management-client.js");
    const mgmt = new PilotSwarmManagementClient({ store: "postgres://unused" });
    mgmt._started = true;
    const store = fakeStore();
    mgmt._factStore = store;
    await assert.rejects(mgmt.storeFact({ key: "apps/board", value: {}, shared: true }), (e) => e.code === "FORBIDDEN");
    await assert.rejects(mgmt.storeFact([{ key: "ok/a", value: 1, shared: true }, { key: "apps/board", value: 2, shared: true }]), (e) => e.code === "FORBIDDEN");
    await assert.rejects(mgmt.deleteFact({ key: "apps/board", shared: true }), (e) => e.code === "FORBIDDEN");
    await assert.rejects(mgmt.deleteFact({ key: "app*", pattern: true, scope: "shared" }), (e) => e.code === "FORBIDDEN");
    assert.equal(store.calls.store.length, 0);
    assert.equal(store.calls.delete.length, 0);
    await mgmt.storeFact({ key: "apps/mine", value: 1 });
    await mgmt.deleteFact({ key: "*", pattern: true, scope: "session" });
    await mgmt.storeFact({ key: "notes/a", value: 1, shared: true });
    assert.equal(store.calls.store.length, 2, "session-scoped apps/ and other shared keys are unaffected");
    assert.equal(store.calls.delete.length, 1);
});

test("management pattern deletes: the store's own scope and LIKE rules decide what is reserved", async () => {
    const { PilotSwarmManagementClient, likePatternCanMatchPrefix } = await import("../../dist/management-client.js");
    const mgmt = new PilotSwarmManagementClient({ store: "postgres://unused" });
    mgmt._started = true;
    const store = fakeStore();
    mgmt._factStore = store;
    // shared:true with no scope is a SHARED pattern delete in the store.
    await assert.rejects(mgmt.deleteFact({ key: "apps/*", pattern: true, shared: true }), (e) => e.code === "FORBIDDEN");
    // SQL LIKE wildcards: `_` matches one character, `%` any run.
    for (const key of ["app_/board", "a__s/%", "_pps/x", "%", "a%", "apps/%", "app\\s/x"]) {
        await assert.rejects(mgmt.deleteFact({ key, pattern: true, scope: "shared" }), (e) => e.code === "FORBIDDEN", key);
    }
    assert.equal(store.calls.delete.length, 0, "nothing reached the store");
    // Controls: patterns that cannot reach apps/, and session scope.
    for (const key of ["notes/*", "app_", "apps", "appz/%", "app\\_/x", "b%"]) {
        await mgmt.deleteFact({ key, pattern: true, scope: "shared" });
    }
    await mgmt.deleteFact({ key: "apps/*", pattern: true, shared: false, sessionId: "s1" });
    assert.equal(store.calls.delete.length, 7);
    // The matcher itself, against the store's normalization.
    assert.equal(likePatternCanMatchPrefix("apps*", "apps/"), true, "* becomes % when there is no %");
    assert.equal(likePatternCanMatchPrefix("apps*%", "apps/"), false, "with a % present, * is a literal character");
    assert.equal(likePatternCanMatchPrefix("ap*s/x%", "apps/"), false, "with a % present, * is a literal");
    assert.equal(likePatternCanMatchPrefix("ap\\ps/x", "apps/"), true, "an escaped ordinary character is itself");
    assert.equal(likePatternCanMatchPrefix("ap\\_s/x", "apps/"), false, "an escaped _ is a literal underscore");
});
