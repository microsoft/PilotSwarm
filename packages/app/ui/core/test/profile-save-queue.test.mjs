/**
 * The portal's profile writes are ordered and bound to the account that made
 * them (issue 181 PR 2 review r1, P1): after a same-tab sign-out and sign-in
 * as Bob, a write Alice queued must never be sent, because the transport
 * would send it with Bob's token into Bob's profile.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createProfileSaveQueue, profileOwnerKey } from "../src/index.js";

const ALICE = { provider: "dev", subject: "alice" };
const BOB = { provider: "dev", subject: "bob" };

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

/** A fake transport: the profile a write lands in is the account signed in when it is SENT. */
function harness() {
    const auth = { principal: ALICE };
    const profiles = new Map();
    const sent = [];
    const firstGate = deferred();
    let calls = 0;
    const send = (doc) => async () => {
        calls += 1;
        const who = auth.principal?.subject ?? "anonymous";
        sent.push({ who, doc });
        if (calls === 1) await firstGate.promise;
        profiles.set(who, doc);
        return { ok: true };
    };
    const ownerNow = () => profileOwnerKey(auth.principal);
    return { auth, profiles, sent, firstGate, send, ownerNow };
}

test("profileOwnerKey: provider and subject, null without a principal", () => {
    assert.equal(profileOwnerKey(null), null);
    assert.equal(profileOwnerKey({ provider: "dev" }), null);
    assert.notEqual(profileOwnerKey({ provider: "a", subject: "x" }), profileOwnerKey({ provider: "b", subject: "x" }));
});

test("Alice's queued write is dropped when Bob signs in before its turn (same tab, delayed first response)", async () => {
    const q = createProfileSaveQueue();
    const key = {};
    const h = harness();
    const first = q.save(key, { owner: h.ownerNow(), currentOwner: h.ownerNow, send: h.send({ adminCollapsed: ["capps:mine"] }) });
    const second = q.save(key, { owner: h.ownerNow(), currentOwner: h.ownerNow, send: h.send({ adminCollapsed: ["capps:mine", "agents"] }) });
    await new Promise((r) => setImmediate(r));
    // Sign out, then sign in as Bob, while Alice's first write is still in flight.
    h.auth.principal = null;
    h.auth.principal = BOB;
    h.firstGate.resolve();
    assert.deepEqual(await first, { ok: true });
    assert.deepEqual(await second, { skipped: "account-changed" });
    assert.deepEqual(h.sent.map((s) => s.who), ["alice"], "only the write Alice sent while signed in went out");
    assert.equal(h.profiles.has("bob"), false, "Bob's profile is untouched");
    assert.deepEqual(h.profiles.get("alice"), { adminCollapsed: ["capps:mine"] });
});

test("invalidate (the workspace unmounted) drops every write already queued, then new writes flow", async () => {
    const q = createProfileSaveQueue();
    const key = {};
    const h = harness();
    const first = q.save(key, { owner: h.ownerNow(), currentOwner: h.ownerNow, send: h.send({ n: 1 }) });
    const queued = q.save(key, { owner: h.ownerNow(), currentOwner: h.ownerNow, send: h.send({ n: 2 }) });
    await new Promise((r) => setImmediate(r));
    q.invalidate(key);
    h.firstGate.resolve();
    await first;
    assert.deepEqual(await queued, { skipped: "invalidated" });
    assert.deepEqual(await q.save(key, { owner: h.ownerNow(), currentOwner: h.ownerNow, send: h.send({ n: 3 }) }), { ok: true });
    assert.deepEqual(h.sent.map((s) => s.doc.n), [1, 3]);
});

test("writes for one account stay in edit order, and a failure does not block the next", async () => {
    const q = createProfileSaveQueue();
    const key = {};
    const order = [];
    const slow = deferred();
    const a = q.save(key, { owner: null, currentOwner: () => null, send: async () => { await slow.promise; order.push(1); throw new Error("boom"); } });
    const b = q.save(key, { owner: null, currentOwner: () => null, send: async () => { order.push(2); return 2; } });
    slow.resolve();
    await assert.rejects(a, /boom/);
    assert.equal(await b, 2);
    assert.deepEqual(order, [1, 2]);
});

test("the portal wires the queue: owner-bound saves and invalidation on unmount", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../react/src/web-app.js", import.meta.url), "utf8");
    assert.match(src, /profileSaveQueue\.save\(controller, \{\s*owner: ownerNow\(\),\s*currentOwner: ownerNow,/);
    assert.match(src, /profileSaveQueue\.invalidate\(controller\);/);
    assert.doesNotMatch(src, /profileSaveQueues\b/, "the unbound queue is gone");
});
