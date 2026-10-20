// The phone's blue button while a turn accepts steering: a tap steers; with
// typed text, a hold opens Steer now / Queue above it.
import test from "node:test";
import assert from "node:assert/strict";
import { nextSteerHold, STEER_HOLD_MS } from "../src/index.js";

const run = (events) => events.reduce(({ state, actions }, event) => {
    const next = nextSteerHold(state, event);
    return { state: next.state, actions: next.action ? [...actions, next.action] : actions };
}, { state: { phase: "idle" }, actions: [] });

test("the hold opens after about 0.45 s", () => assert.equal(STEER_HOLD_MS, 450));

test("a tap steers; a tap without typed text (no hold) steers too", () => {
    assert.deepEqual(run([{ type: "down", canHold: true }, { type: "up", over: "button" }]), { state: { phase: "idle" }, actions: ["steer"] });
    assert.deepEqual(run([{ type: "down", canHold: false }, { type: "hold" }, { type: "up", over: "button" }]), { state: { phase: "idle" }, actions: ["steer"] });
});

test("hold opens the menu with Steer now lit; slide and release on an item does it", () => {
    assert.deepEqual(run([{ type: "down", canHold: true }, { type: "hold" }]).state, { phase: "open", highlight: "steer" });
    assert.deepEqual(run([{ type: "down", canHold: true }, { type: "hold" }, { type: "move", over: "queue" }, { type: "up", over: "queue" }]),
        { state: { phase: "idle" }, actions: ["queue"] });
    assert.deepEqual(run([{ type: "down", canHold: true }, { type: "hold" }, { type: "move", over: "queue" }, { type: "move", over: "steer" }, { type: "up", over: "steer" }]),
        { state: { phase: "idle" }, actions: ["steer"] });
});

test("release on the button keeps the menu open for a tap on an item; release or a tap elsewhere closes it and sends nothing", () => {
    const held = [{ type: "down", canHold: true }, { type: "hold" }];
    assert.deepEqual(run([...held, { type: "up", over: "button" }]).state, { phase: "open", highlight: "steer" });
    assert.deepEqual(run([...held, { type: "up", over: "button" }, { type: "pick", item: "queue" }]), { state: { phase: "idle" }, actions: ["queue"] });
    assert.deepEqual(run([...held, { type: "move", over: null }, { type: "up", over: null }]), { state: { phase: "idle" }, actions: [] });
    assert.deepEqual(run([...held, { type: "up", over: "button" }, { type: "dismiss" }]), { state: { phase: "idle" }, actions: [] });
    assert.deepEqual(run([...held, { type: "move", over: null }]).state, { phase: "open", highlight: null });
});

test("the keyboard opens the menu (Steer now lit); arrows move the light; a pick does it", () => {
    assert.deepEqual(run([{ type: "open" }]).state, { phase: "open", highlight: "steer" });
    assert.deepEqual(run([{ type: "open" }, { type: "move", over: "queue" }, { type: "pick", item: "queue" }]), { state: { phase: "idle" }, actions: ["queue"] });
});

test("a cancelled press (the browser took the gesture), or one that slides off before the hold, sends nothing", () => {
    assert.deepEqual(run([{ type: "down", canHold: true }, { type: "up", over: null }]), { state: { phase: "idle" }, actions: [] });
    assert.deepEqual(run([{ type: "down", canHold: true }, { type: "cancel" }]), { state: { phase: "idle" }, actions: [] });
    assert.deepEqual(run([{ type: "down", canHold: true }, { type: "hold" }, { type: "cancel" }]), { state: { phase: "idle" }, actions: [] });
});
