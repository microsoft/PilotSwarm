import test from "node:test";
import assert from "node:assert/strict";
import * as api from "../index.js";
import {
    CANVAS_SLOT_MAX,
    CANVAS_SLOT_RANGE,
    CANVAS_SLOT_ERROR,
    CANVAS_EVENT_WINDOW,
    CANVAS_KEY_SUFFIX,
    isCanvasSlot,
    normalizeCanvasSlot,
    canvasArtifactFilename,
} from "../src/canvas-slots.js";

test("the limit is ten slots, and its words and window follow from it", () => {
    assert.equal(CANVAS_SLOT_MAX, 10);
    assert.equal(CANVAS_SLOT_RANGE, "1-10");
    assert.equal(CANVAS_SLOT_ERROR, "slot must be an integer 1-10");
    assert.equal(CANVAS_EVENT_WINDOW, 60);
});

test("isCanvasSlot accepts integer numbers 1-10 only", () => {
    for (const slot of [1, 2, 9, 10]) assert.equal(isCanvasSlot(slot), true, String(slot));
    for (const slot of [0, 11, -1, 1.5, "7", NaN, null, undefined]) assert.equal(isCanvasSlot(slot), false, String(slot));
});

test("normalizeCanvasSlot: missing is slot 1, numeric text is accepted, anything else is null", () => {
    assert.equal(normalizeCanvasSlot(undefined), 1);
    assert.equal(normalizeCanvasSlot(null), 1);
    assert.equal(normalizeCanvasSlot(""), 1);
    assert.equal(normalizeCanvasSlot("7"), 7);
    assert.equal(normalizeCanvasSlot(10), 10);
    for (const bad of [11, 0, "x", 1.5, -3]) assert.equal(normalizeCanvasSlot(bad), null, String(bad));
});

test("artifact names: slot 1 keeps canvas.html; 2-10 are canvasN.html", () => {
    assert.equal(canvasArtifactFilename(1), "canvas.html");
    assert.equal(canvasArtifactFilename(2), "canvas2.html");
    assert.equal(canvasArtifactFilename(10), "canvas10.html");
});

test("the canvas key suffix names slots 2-10 and nothing else", () => {
    assert.deepEqual([...CANVAS_KEY_SUFFIX.exec("abc#10")].slice(1), ["abc", "10"]);
    assert.deepEqual([...CANVAS_KEY_SUFFIX.exec("abc#2")].slice(1), ["abc", "2"]);
    for (const key of ["abc#1", "abc#11", "abc#0", "abc#01", "abc"]) assert.equal(CANVAS_KEY_SUFFIX.exec(key), null, key);
});

test("the barrel exports every slot helper", () => {
    for (const name of ["CANVAS_SLOT_MAX", "CANVAS_SLOT_RANGE", "CANVAS_SLOT_ERROR", "CANVAS_EVENT_WINDOW",
        "CANVAS_KEY_SUFFIX", "isCanvasSlot", "normalizeCanvasSlot", "canvasArtifactFilename"]) {
        assert.ok(name in api, name);
    }
});
