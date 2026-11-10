/**
 * The client-side canvas mirror — the browser half of the data plane's
 * patch protocol. Its merge must agree with the database's jsonb_merge_patch
 * (RFC 7386; the SQL side is proven in test/local/canvas-plane.test.js), and
 * its seq discipline decides when a patch applies vs when to resync.
 *
 * Run: node --test test/unit/canvas-live-mirror.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createCanvasLiveMirror, jsonMergePatch } from "../../api/src/canvas-live-mirror.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

test("jsonMergePatch is RFC 7386 — the same law the database applies", () => {
    // Mirror of the live-PG semantics test, byte for byte.
    assert.deepEqual(
        jsonMergePatch({ a: { b: 1, c: 2 }, list: [1, 2, 3], s: "x" }, { a: { b: 9, d: 3 }, list: [7], s: null }),
        { a: { b: 9, c: 2, d: 3 }, list: [7] },
    );
    assert.deepEqual(jsonMergePatch(undefined, { x: { y: 1 }, gone: null }), { x: { y: 1 } });
    assert.deepEqual(jsonMergePatch({ keep: 1 }, {}), { keep: 1 });
    // Non-object patch replaces wholesale; scalar targets are treated as {}.
    assert.deepEqual(jsonMergePatch({ a: 1 }, [1, 2]), [1, 2]);
    assert.deepEqual(jsonMergePatch("scalar", { a: 1 }), { a: 1 });
    // Merging into a non-object subtree rebuilds it as an object.
    assert.deepEqual(jsonMergePatch({ a: 5 }, { a: { b: 1 } }), { a: { b: 1 } });
});

function harness(snapshotRows = []) {
    const emitted = [];
    let fetches = 0;
    let resolveFetch = null;
    const mirror = createCanvasLiveMirror({
        fetchSnapshot: () => {
            fetches += 1;
            return new Promise((resolve) => {
                resolveFetch = () => resolve(snapshotRows);
            });
        },
        emit: (sessionId, update) => emitted.push({ sessionId, ...update }),
    });
    return { mirror, emitted, getFetches: () => fetches, flushFetch: async () => { await tick(); resolveFetch?.(); await tick(); } };
}

test("contiguous patches apply locally and emit merged whole state with the patch alongside", async () => {
    const h = harness([{ slot: 1, seq: 1, payload: { a: 1 } }]);
    h.mirror.onPing("s1", { slot: 1, seq: 1, kind: "data" });    // unknown slot → resync
    await h.flushFetch();
    assert.equal(h.emitted.length, 1);
    assert.deepEqual(h.emitted[0], { sessionId: "s1", slot: 1, seq: 1, payload: { a: 1 } });

    h.mirror.onPing("s1", { slot: 1, seq: 2, kind: "data", patch: { b: 2 } });
    assert.equal(h.emitted.length, 2);
    assert.deepEqual(h.emitted[1].payload, { a: 1, b: 2 });
    assert.deepEqual(h.emitted[1].patch, { b: 2 });
    assert.equal(h.getFetches(), 1, "no fetch for a contiguous patch");
});

test("a seq gap triggers ONE coalesced resync, never a blind patch apply", async () => {
    const h = harness([{ slot: 1, seq: 9, payload: { caught: "up" } }]);
    h.mirror.onPing("s1", { slot: 1, seq: 5, kind: "data", patch: { x: 1 } }); // unknown slot: gap
    h.mirror.onPing("s1", { slot: 1, seq: 6, kind: "data", patch: { y: 2 } }); // still in-flight
    h.mirror.onPing("s1", { slot: 1, seq: 7, kind: "data", patch: { z: 3 } });
    await h.flushFetch();
    assert.equal(h.getFetches(), 1, "gap storm coalesces into one snapshot fetch");
    assert.equal(h.emitted.length, 1);
    assert.deepEqual(h.emitted[0].payload, { caught: "up" });
    assert.equal(h.emitted[0].seq, 9);
});

test("duplicate pings do not re-emit or refetch", async () => {
    const h = harness([{ slot: 1, seq: 5, payload: { v: 5 } }]);
    h.mirror.onPing("s1", { slot: 1, seq: 5, kind: "data" });
    await h.flushFetch();
    h.mirror.onPing("s1", { slot: 1, seq: 5, kind: "data", patch: { dup: true } });
    assert.equal(h.emitted.length, 1, "nothing re-emitted for stale seq");
    assert.equal(h.getFetches(), 1, "and nothing refetched");
});

test("a doc ping resets the slot mirror and applied coverage without emitting data", async () => {
    const h = harness([{ slot: 1, seq: 1, payload: { old: 1 } }]);
    h.mirror.onPing("s1", { slot: 1, seq: 1, kind: "data" });
    await h.flushFetch();
    h.mirror.onPing("s1", { slot: 1, seq: 2, kind: "doc" });
    assert.equal(h.emitted.length, 1, "doc pings never emit data — canvas_updated carries redraws");
    assert.equal(h.mirror.covers("s1", 1, 2), false, "a doc ping is not an applied data tick");
    // The next contiguous patch merges into the RESET (empty) state.
    h.mirror.onPing("s1", { slot: 1, seq: 3, kind: "data", patch: { fresh: 1 } });
    assert.deepEqual(h.emitted[1].payload, { fresh: 1 }, "no ghost of the old page's state");
});

test("a snapshot never moves a slot backwards past a ping that already advanced it", async () => {
    const h = harness([{ slot: 1, seq: 3, payload: { from: "snapshot" } }, { slot: 2, seq: 1, payload: {} }]);
    // Trigger the fetch, then advance past the snapshot's seq before it lands.
    h.mirror.onPing("s1", { slot: 1, seq: 3, kind: "data" });
    // While the fetch is in flight the mirror has no slot state, so this
    // second ping cannot apply as a patch — but once the snapshot (seq 3)
    // lands, pings 4..5 will have been missed. Simulate the post-snapshot
    // advance and a LATE second snapshot.
    await h.flushFetch();
    h.mirror.onPing("s1", { slot: 1, seq: 4, kind: "data", patch: { newer: true } });
    assert.deepEqual(h.emitted.at(-1).payload, { from: "snapshot", newer: true });
    // A late/racing snapshot with an older seq must not re-emit or regress.
    const before = h.emitted.length;
    h.mirror.onPing("s1", { slot: 3, seq: 1, kind: "doc" });
    const resync = h.mirror.prime("s1");
    await h.flushFetch();
    await resync;
    const slot1Emits = h.emitted.slice(before).filter((e) => e.slot === 1);
    assert.equal(slot1Emits.length, 0, "slot 1 (seq 4) not regressed by the seq-3 snapshot row");
});

test("covers() reports only applied data sequences per slot; forget() releases them", async () => {
    const h = harness([{ slot: 2, seq: 1, payload: {} }]);
    assert.equal(h.mirror.covers("s1", 2, 1), false);
    h.mirror.onPing("s1", { slot: 2, seq: 1, kind: "data" });
    await h.flushFetch();
    assert.equal(h.mirror.covers("s1", 2, 1), true);
    assert.equal(h.mirror.covers("s1", 2, 2), false, "an unapplied newer tick must use its durable fallback");
    assert.equal(h.mirror.covers("s1", 1, 1), false, "coverage is per slot, not per session");
    assert.equal(h.mirror.covers("s1", 2), false, "an old event without a shared sequence is never guessed covered");
    h.mirror.forget("s1");
    assert.equal(h.mirror.covers("s1", 2, 1), false);
});

test("a failed pointer fetch retries with back-off without needing another ping", async () => {
    let calls = 0;
    const emitted = [];
    const delays = [];
    const mirror = createCanvasLiveMirror({
        fetchSnapshot: () => {
            calls += 1;
            return calls === 1 ? Promise.reject(new Error("db away")) : Promise.resolve([{ slot: 1, seq: 2, payload: { ok: 1 } }]);
        },
        emit: (_sid, u) => emitted.push(u),
        delay: async ms => { delays.push(ms); },
    });
    mirror.onPing("s1", { slot: 1, seq: 1, kind: "doc" });
    assert.equal(mirror.covers("s1", 1, 1), false);
    mirror.onPing("s1", { slot: 1, seq: 2, kind: "data" });
    assert.equal(await mirror.prime("s1"), true);
    assert.equal(calls, 2);
    assert.deepEqual(delays, [100]);
    assert.deepEqual(emitted[0].payload, { ok: 1 });
    assert.equal(mirror.covers("s1", 1, 2), true);
});

test("exhausted fetch retries report failure and leave the durable tick uncovered", async () => {
    let calls = 0;
    const delays = [];
    const errors = [];
    const mirror = createCanvasLiveMirror({
        fetchSnapshot: async () => { calls++; throw new Error("offline"); },
        emit: () => assert.fail("a failed fetch must not emit"),
        delay: async ms => { delays.push(ms); },
        onError: (sessionId, error) => errors.push([sessionId, error.message]),
    });
    mirror.onPing("s1", { slot: 1, seq: 1, kind: "doc" });
    mirror.onPing("s1", { slot: 1, seq: 2, kind: "data" });
    assert.equal(await mirror.prime("s1"), false);
    assert.equal(calls, 3);
    assert.deepEqual(delays, [100, 400]);
    assert.deepEqual(errors, [["s1", "offline"]]);
    assert.equal(mirror.covers("s1", 1, 2), false);
});

test("a forgotten subscription cannot be resurrected by an in-flight snapshot", async () => {
    let resolve;
    const emitted = [];
    const mirror = createCanvasLiveMirror({
        fetchSnapshot: () => new Promise(done => { resolve = done; }),
        emit: (_sid, update) => emitted.push(update),
    });
    const pending = mirror.prime("s1");
    await Promise.resolve();
    mirror.forget("s1");
    resolve([{ slot: 1, seq: 2, payload: { old: true } }]);
    assert.equal(await pending, false);
    assert.deepEqual(emitted, []);
    assert.equal(mirror.covers("s1", 1, 2), false);
});

test("a plane-unavailable signal releases the takeover so legacy events resume", async () => {
    const h = harness([{ slot: 1, seq: 1, payload: { a: 1 } }]);
    h.mirror.onPing("s1", { slot: 1, seq: 1, kind: "data" });
    await h.flushFetch();
    assert.equal(h.mirror.covers("s1", 1, 1), true);
    h.mirror.onPing("s1", { kind: "unavailable" });
    assert.equal(h.mirror.covers("s1", 1, 1), false, "frozen-canvas hazard: suppression must lift when the plane dies");
});

test("a backwards seq is a PLANE RESET (failover truncation), not staleness — the canvas must not freeze", async () => {
    let snapshot = [{ slot: 1, seq: 5000, payload: { old: true } }];
    const emitted = [];
    const resets = [];
    const mirror = createCanvasLiveMirror({
        fetchSnapshot: () => Promise.resolve(snapshot),
        emit: (_s, u) => emitted.push(u),
        reset: (_s, update) => resets.push(update),
    });
    mirror.onPing("s1", { slot: 1, seq: 5000, kind: "data" });
    await tick(); await tick();
    assert.equal(emitted.at(-1).seq, 5000, "high-water mark established");
    // The failover: UNLOGGED row truncated, rebuilt from 1.
    snapshot = [{ slot: 1, seq: 1, payload: { rebuilt: true } }];
    mirror.onPing("s1", { slot: 1, seq: 1, kind: "data" });
    await tick(); await tick();
    assert.equal(emitted.at(-1).seq, 1, "the row's truth applied despite the lower seq");
    assert.deepEqual(resets, [{ slot: 1, seq: 0 }], "the reducer must release the old sequence too");
    assert.deepEqual(emitted.at(-1).payload, { rebuilt: true });
    // And the chain continues contiguously in the NEW lineage.
    mirror.onPing("s1", { slot: 1, seq: 2, kind: "data", patch: { post: 1 } });
    assert.deepEqual(emitted.at(-1).payload, { rebuilt: true, post: 1 });
});
