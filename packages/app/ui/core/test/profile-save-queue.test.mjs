/**
 * The portal's profile writes are ordered and bound to the account that made
 * them (issue 181 PR 2 review r1, P1): after a same-tab sign-out and sign-in
 * as Bob, a write Alice queued must never be sent, because the transport
 * would send it with Bob's token into Bob's profile.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appReducer, createInitialState, createProfileSaveQueue, createStore, isSkippedProfileSave, profileOwnerKey, saveControllerProfileDocument } from "../src/index.js";

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

test("the portal wires the queue: account-bound saves, waiting for the account, invalidation on unmount", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../react/src/web-app.js", import.meta.url), "utf8");
    assert.match(src, /return saveControllerProfileDocument\(profileSaveQueue, controller, normalizeProfileSettings\(settings\)\);/);
    assert.match(src, /profileSaveQueue\.invalidate\(controller\);/);
    assert.doesNotMatch(src, /profileSaveQueues\b/, "the unbound queue is gone");
    // A dropped write is never reported as saved.
    assert.match(src, /if \(isSkippedProfileSave\(result\)\) \{\s*controller\.dispatch\(\{ type: "ui\/moaSaveStatus", status: "skipped" \}\);\s*return;/);
});

// ── Review r2 Q1: a write queued before the principal is published is saved for that same account ──

function controllerHarness({ firstGate = null } = {}) {
    const store = createStore(appReducer, createInitialState());
    const sent = [];
    let calls = 0;
    const controller = {
        getState: () => store.getState(),
        dispatch: (action) => store.dispatch(action),
        subscribe: (listener) => store.subscribe(listener),
        transport: {
            async setCurrentUserProfileSettings({ settings }) {
                calls += 1;
                // The profile a write lands in is the account signed in when it is SENT.
                sent.push({ who: store.getState().auth.principal?.subject ?? "anonymous", settings });
                if (calls === 1 && firstGate) await firstGate.promise;
                return { ok: true };
            },
        },
    };
    return { store, controller, sent };
}

// What the portal shows for a save result (web-app.js: "skipped" for a dropped write, else "saved").
const reported = (result) => (isSkippedProfileSave(result) ? "skipped" : "saved");

test("auth starts unresolved; the auth context resolves it, signed in or not", () => {
    const store = createStore(appReducer, createInitialState());
    assert.equal(store.getState().auth.resolved, false);
    store.dispatch({ type: "auth/context", principal: null, authorization: null });
    assert.equal(store.getState().auth.resolved, true, "an auth-disabled portal resolves to anonymous");
});

test("edits queued BEFORE the principal is published wait, then are saved for that same account and reported saved (delayed bootstrap, delayed first save)", async () => {
    const gate = deferred();
    const { store, controller, sent } = controllerHarness({ firstGate: gate });
    const q = createProfileSaveQueue();
    // Hydrated and editable, but bootstrap has not published the principal yet: A and B are queued now.
    const a = saveControllerProfileDocument(q, controller, { n: "A" });
    const b = saveControllerProfileDocument(q, controller, { n: "B" });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, [], "nothing is sent while the account is unknown");
    // Bootstrap completes: Alice. Her first save is slow.
    store.dispatch({ type: "auth/context", principal: ALICE, authorization: null });
    await new Promise((r) => setImmediate(r));
    gate.resolve();
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepEqual(sent, [{ who: "alice", settings: { n: "A" } }, { who: "alice", settings: { n: "B" } }], "both edits were sent, in order, for Alice");
    assert.deepEqual([reported(ra), reported(rb)], ["saved", "saved"]);
});

test("a write queued before the principal is published, then dropped, is reported skipped and never saved", async () => {
    const { store, controller, sent } = controllerHarness();
    const q = createProfileSaveQueue();
    const pending = saveControllerProfileDocument(q, controller, { n: "A" });
    await new Promise((r) => setImmediate(r));
    q.invalidate(controller); // the workspace unmounted (e.g. a sign-out) before bootstrap finished
    store.dispatch({ type: "auth/context", principal: ALICE, authorization: null });
    const result = await pending;
    assert.deepEqual(result, { skipped: "invalidated" });
    assert.equal(reported(result), "skipped", "never reported as saved");
    assert.deepEqual(sent, []);
});

test("an auth-disabled portal saves too: the queued write is sent once the context says nobody is signed in", async () => {
    const { store, controller, sent } = controllerHarness();
    const q = createProfileSaveQueue();
    const pending = saveControllerProfileDocument(q, controller, { n: "A" });
    store.dispatch({ type: "auth/context", principal: null, authorization: null });
    assert.equal(reported(await pending), "saved");
    assert.deepEqual(sent, [{ who: "anonymous", settings: { n: "A" } }]);
});

test("an account switch after queueing still drops the old account's queued write, reported skipped (P1 kept)", async () => {
    const gate = deferred();
    const { store, controller, sent } = controllerHarness({ firstGate: gate });
    const q = createProfileSaveQueue();
    store.dispatch({ type: "auth/context", principal: ALICE, authorization: null });
    const a = saveControllerProfileDocument(q, controller, { n: "A" });
    const b = saveControllerProfileDocument(q, controller, { n: "B" });
    await new Promise((r) => setImmediate(r));
    store.dispatch({ type: "auth/context", principal: BOB, authorization: null });
    gate.resolve();
    assert.equal(reported(await a), "saved");
    const rb = await b;
    assert.deepEqual(rb, { skipped: "account-changed" });
    assert.equal(reported(rb), "skipped");
    assert.deepEqual(sent.map((x) => x.settings.n), ["A"], "only A, sent while Alice was signed in");
});
