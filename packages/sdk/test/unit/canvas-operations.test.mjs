/**
 * Canvas operations against in-memory fakes of the catalog, the live plane
 * and the artifact store: per-target write chains, the order of a tick and a
 * draw sent together, and slot refusals that write nothing.
 *
 * Run: node --test test/unit/canvas-operations.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createCanvasOperations } from "../../dist/canvas-operations.js";

let seq = 0;
const sessionId = (label) => `co-${label}-${process.pid}-${(seq += 1)}`;

/** One fake world: events, the per-slot rev cache, the live plane (a draw resets the payload to {}), artifacts. */
function canvasWorld() {
    const calls = [];
    const events = [];
    const revs = new Map();
    const live = new Map();
    const files = new Map();
    const holds = new Map();
    const at = (sid, slot) => `${sid}:${slot}`;
    const catalog = {
        async getSession(id) { return { sessionId: id, parentSessionId: null, sessionKind: "agent" }; },
        async getSessionEventsBefore(sid, _before, limit, types) {
            return events.filter((e) => e.sessionId === sid && types.includes(e.eventType)).slice(-limit).reverse().map((e) => ({ data: e.data }));
        },
        async recordEvents(sid, evs) {
            calls.push(["recordEvents", sid]);
            for (const e of evs) events.push({ sessionId: sid, eventType: e.eventType, data: e.data });
        },
        async getSessionCanvases(sid) {
            return [...revs].filter(([k]) => k.startsWith(`${sid}:`)).map(([k, latestRev]) => ({ slot: Number(k.slice(k.lastIndexOf(":") + 1)), latestRev }));
        },
        async mintCanvasRev(sid, slot, seed) {
            calls.push(["mintCanvasRev", sid]);
            const next = Math.max(revs.get(at(sid, slot)) ?? 0, seed) + 1;
            revs.set(at(sid, slot), next);
            return next;
        },
        async upsertSessionCanvas(sid, slot, _name, rev) { revs.set(at(sid, slot), rev); },
        async setCanvasKvManifest() {},
        async canvasLiveAvailable() { return true; },
        async upsertCanvasLiveDoc(sid, slot) {
            calls.push(["upsertCanvasLiveDoc", sid]);
            const next = { seq: (live.get(at(sid, slot))?.seq ?? 0) + 1, payload: {} };
            live.set(at(sid, slot), next);
            return { seq: next.seq };
        },
        async upsertCanvasLiveTick(sid, slot, body) {
            calls.push(["upsertCanvasLiveTick", sid]);
            const cur = live.get(at(sid, slot)) ?? { seq: 0, payload: {} };
            const next = { seq: cur.seq + 1, payload: body.patch !== undefined ? { ...cur.payload, ...body.patch } : body.data };
            live.set(at(sid, slot), next);
            return next;
        },
    };
    const artifactStore = {
        async uploadArtifact(sid, filename, text) {
            calls.push(["uploadArtifact", sid]);
            const hold = holds.get(sid);
            if (hold) await hold;
            files.set(`${sid}/${filename}`, text);
        },
        async downloadArtifactText(sid, filename) {
            if (!files.has(`${sid}/${filename}`)) throw new Error(`no artifact ${filename}`);
            return files.get(`${sid}/${filename}`);
        },
    };
    return {
        catalog,
        artifactStore,
        calls,
        livePayload: (sid, slot = 1) => live.get(at(sid, slot))?.payload,
        /** Holds every upload to `sid` open until the returned release is called. */
        holdUploads(sid) {
            let release;
            holds.set(sid, new Promise((resolve) => { release = resolve; }));
            return () => { holds.delete(sid); release(); };
        },
        ops: (writer, mode = "agent") => createCanvasOperations({
            catalog, artifactStore, factStore: null, writerSessionId: writer, workerNodeId: "unit", agentIdentity: null, mode,
        }),
    };
}

/** Resolves `{ done, value }`: done is false when `promise` has not settled within `ms`. */
const within = (promise, ms) => Promise.race([
    promise.then((value) => ({ done: true, value })),
    new Promise((resolve) => setTimeout(() => resolve({ done: false }), ms)),
]);

test("a held write on one target does not hold a draw on another; a second write to the held target waits", async () => {
    const world = canvasWorld();
    const A = sessionId("a");
    const B = sessionId("b");
    const release = world.holdUploads(A);
    try {
        const first = world.ops(A).drawCanvas({ html: "<!doctype html><p>a1</p>" });
        const onB = await within(world.ops(B).drawCanvas({ html: "<!doctype html><p>b</p>" }), 500);
        assert.equal(onB.done, true, "a draw on B must not wait for A's upload");
        assert.deepEqual(onB.value, { rev: 1, slot: 1, sizeBytes: 23 });

        const second = world.ops(A).drawCanvas({ html: "<!doctype html><p>a2</p>" });
        assert.equal((await within(second, 50)).done, false, "the second write to A waits for the first");
        assert.equal(world.calls.filter(([name, sid]) => name === "uploadArtifact" && sid === A).length, 1,
            "and has not started its upload");

        release();
        assert.deepEqual(await first, { rev: 1, slot: 1, sizeBytes: 24 });
        assert.deepEqual(await second, { rev: 2, slot: 1, sizeBytes: 24 }, "same-target writes keep their order");
    } finally {
        release();
    }
});

test("a tick and a draw sent together apply in the order they were called", async () => {
    // [tick, draw]: the tick lands, then the draw resets the live data.
    {
        const world = canvasWorld();
        const S = sessionId("tick-first");
        const ops = world.ops(S);
        assert.equal((await ops.drawCanvas({ html: "<!doctype html><p>v1</p>" })).rev, 1);
        const [tick, draw] = await Promise.all([
            ops.updateCanvas({ data: { n: 1 } }),
            ops.drawCanvas({ html: "<!doctype html><p>v2</p>" }),
        ]);
        assert.equal(tick.mode, "data", JSON.stringify(tick));
        assert.equal(draw.rev, 2, JSON.stringify(draw));
        assert.deepEqual(world.livePayload(S), {}, "the draw came second and reset the tick's data");
        const order = world.calls.filter(([name]) => name === "upsertCanvasLiveTick" || name === "upsertCanvasLiveDoc").map(([name]) => name);
        assert.deepEqual(order, ["upsertCanvasLiveDoc", "upsertCanvasLiveTick", "upsertCanvasLiveDoc"]);
    }
    // [draw, tick]: the draw resets, then the tick lands on the new page.
    {
        const world = canvasWorld();
        const S = sessionId("draw-first");
        const ops = world.ops(S);
        assert.equal((await ops.drawCanvas({ html: "<!doctype html><p>v1</p>" })).rev, 1);
        const [draw, tick] = await Promise.all([
            ops.drawCanvas({ html: "<!doctype html><p>v2</p>" }),
            ops.updateCanvas({ data: { n: 2 } }),
        ]);
        assert.equal(draw.rev, 2, JSON.stringify(draw));
        assert.equal(tick.mode, "data", JSON.stringify(tick));
        assert.deepEqual(world.livePayload(S), { n: 2 }, "the tick came second and survives");
    }
});

test("script mode: a tick sent with a draw also keeps its call order", async () => {
    const world = canvasWorld();
    const S = sessionId("script-order");
    const ops = world.ops(S, "script");
    assert.equal((await ops.drawCanvas({ html: "<!doctype html><p>v1</p>" })).rev, 1);
    const [tick, draw] = await Promise.all([
        ops.updateCanvas({ data: { n: 1 } }),
        ops.drawCanvas({ html: "<!doctype html><p>v2</p>" }),
    ]);
    assert.equal(tick.mode, "data", JSON.stringify(tick));
    assert.equal(draw.rev, 2, JSON.stringify(draw));
    assert.deepEqual(world.livePayload(S), {}, "the draw came second");
});

test("slot 11 is refused for a draw and a tick, and nothing is uploaded, minted or recorded", async () => {
    const world = canvasWorld();
    const S = sessionId("slot11");
    for (const mode of ["agent", "script"]) {
        const ops = world.ops(S, mode);
        assert.deepEqual(await ops.drawCanvas({ html: "<!doctype html><p>x</p>", slot: 11 }), { error: "slot must be an integer 1-10" });
        assert.deepEqual(await ops.updateCanvas({ data: { n: 1 }, slot: 11 }), { error: "slot must be an integer 1-10" });
    }
    assert.deepEqual(world.calls, [], "no artifact upload, rev mint, event, doc pointer or tick");
});
