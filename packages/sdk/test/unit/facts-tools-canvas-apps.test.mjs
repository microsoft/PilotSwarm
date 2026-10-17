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
