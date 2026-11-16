// Ten canvas slots in the portal state: keys, reducer, selectors. An invalid slot changes nothing; it is never
// treated as slot 1.
import test from "node:test";
import assert from "node:assert/strict";
import { appReducer, createInitialState, canvasKey, parseCanvasKey, CANVAS_SLOT_MAX, isCanvasSlot } from "../src/index.js";
import { sessionCanvasMark, selectCanvasView } from "../src/selectors.js";
import { CANVAS_SLOT_MAX as SDK_CANVAS_SLOT_MAX } from "../../../../sdk/api/src/canvas-slots.js";

test("ui/core's slot limit equals the SDK's", () => {
    assert.equal(CANVAS_SLOT_MAX, SDK_CANVAS_SLOT_MAX);
    assert.equal(CANVAS_SLOT_MAX, 10);
    assert.equal(isCanvasSlot(10), true);
    assert.equal(isCanvasSlot(11), false);
    assert.equal(isCanvasSlot("3"), false);
});

test("canvas keys name slots 2-10; slot 1 is the bare id; anything else is part of an id", () => {
    assert.equal(canvasKey("s", 1), "s");
    assert.equal(canvasKey("s", 10), "s#10");
    assert.equal(canvasKey("s", 11), "s");
    assert.deepEqual(parseCanvasKey("s#10"), { sessionId: "s", slot: 10 });
    assert.deepEqual(parseCanvasKey("s#7"), { sessionId: "s", slot: 7 });
    assert.deepEqual(parseCanvasKey("s#11"), { sessionId: "s#11", slot: 1 });
    assert.deepEqual(parseCanvasKey("s#1"), { sessionId: "s#1", slot: 1 });
});

function activeState(sessionId = "s1") {
    const state = createInitialState();
    return { ...state, sessions: { ...state.sessions, activeSessionId: sessionId } };
}

test("a slot-10 draw lands on slot 10; a slot-11 draw changes nothing", () => {
    const base = activeState();
    const drawn = appReducer(base, { type: "canvas/updated", sessionId: "s1", slot: 10, rev: 3, sizeBytes: 100 });
    assert.equal(drawn.canvas.bySessionId["s1#10"]?.latestRev, 3);
    const refused = appReducer(base, { type: "canvas/updated", sessionId: "s1", slot: 11, rev: 3, sizeBytes: 100 });
    assert.equal(refused, base, "the state is returned unchanged");
    assert.equal(refused.canvas.bySessionId.s1, undefined, "nothing is written to slot 1");
    const missing = appReducer(base, { type: "canvas/updated", sessionId: "s1", rev: 2, sizeBytes: 100 });
    assert.equal(missing.canvas.bySessionId.s1?.latestRev, 2, "a missing slot is slot 1");
});

test("ticks, snapshots, plane documents, flips and the slot picker take slots 1-10 and drop 11", () => {
    const base = activeState();
    for (const action of [
        { type: "canvas/data", sessionId: "s1", slot: 11, dataRev: 1, payload: {} },
        { type: "canvas/snapshot", sessionId: "s1", slot: 11, rev: 1 },
        { type: "canvas/planeDocument", sessionId: "s1", slot: 11, planeSeq: 1 },
        { type: "canvas/flip", slot: 11 },
        { type: "ui/canvasSlot", slot: 11 },
    ]) {
        assert.equal(appReducer(base, action), base, action.type);
    }
    const ticked = appReducer(base, { type: "canvas/data", sessionId: "s1", slot: 10, dataRev: 1, payload: { a: 1 } });
    assert.equal(ticked.canvas.bySessionId["s1#10"]?.latestDataRev, 1);
    assert.equal(appReducer(base, { type: "ui/canvasSlot", slot: 10 }).ui.canvasSlot, 10);
    assert.equal(appReducer(base, { type: "canvas/flip", slot: 10 }).ui.canvasSlot, 10);
});

test("the session list seed and plane release cover slot 10", () => {
    const base = activeState();
    const seeded = appReducer(base, { type: "canvas/seed", entries: [
        { sessionId: "s1", slot: 10, latestRev: 4, name: "ten" },
        { sessionId: "s1", slot: 11, latestRev: 4, name: "eleven" },
    ] });
    assert.equal(seeded.canvas.bySessionId["s1#10"]?.latestRev, 4);
    assert.equal(Object.keys(seeded.canvas.bySessionId).some((k) => k.includes("#11")), false);
    const withPlane = appReducer(base, { type: "canvas/planeDocument", sessionId: "s1", slot: 10, planeSeq: 5 });
    assert.equal(withPlane.canvas.bySessionId["s1#10"]?.planeDocSeq, 5);
    const released = appReducer(withPlane, { type: "canvas/planeReleased", sessionId: "s1" });
    assert.equal(released.canvas.bySessionId["s1#10"]?.planeDocSeq, undefined, "slot 10's plane lineage is released");
});

test("selectors see slot 10: the row mark and the picker", () => {
    const base = activeState();
    const drawn = appReducer(base, { type: "canvas/updated", sessionId: "s1", slot: 10, rev: 3, sizeBytes: 100 });
    assert.ok(sessionCanvasMark(drawn, "s1"), "an unseen slot-10 draw marks the row");
    const view = selectCanvasView(drawn);
    assert.ok(view.slots.some((s) => s.slot === 10), "the picker lists slot 10");
});
