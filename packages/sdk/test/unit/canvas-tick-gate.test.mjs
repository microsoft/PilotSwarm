/**
 * The canvas tick limiter: one worker-wide clock keyed `${target}:${slot}`.
 * An agent tick that comes too early is refused, as it always was. A Workflow
 * script cannot pace itself, so its tick waits out the rest of the interval.
 *
 * Run: node --test test/unit/canvas-tick-gate.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { CANVAS_TICK_MIN_INTERVAL_MS, canvasTickGate } from "../../dist/canvas-operations.js";

// The clock is worker-wide, so every test uses its own keys.
const clockAt = (start) => {
    const clock = { t: start, now: () => clock.t };
    return clock;
};

test("the floor between ticks is 100 ms", () => {
    assert.equal(CANVAS_TICK_MIN_INTERVAL_MS, 100);
});

test("agent mode: a second tick 10 ms later on the same target and slot is refused", async () => {
    const clock = clockAt(1_000_000);
    assert.equal(await canvasTickGate("agent-same:3", "agent", clock.now), null, "the first tick passes");
    clock.t += 10;
    const refused = await canvasTickGate("agent-same:3", "agent", clock.now);
    assert.equal(typeof refused, "string");
    assert.match(refused, /faster than 100 ms/);
    assert.equal(refused, "ticking slot 3 faster than 100 ms apart — aggregate your changes into fewer, larger ticks",
        "the refusal keeps today's words");
    clock.t += 90;
    assert.equal(await canvasTickGate("agent-same:3", "agent", clock.now), null, "100 ms after the first, a tick passes again");
});

test("agent mode: a different key is a separate budget", async () => {
    const clock = clockAt(2_000_000);
    assert.equal(await canvasTickGate("agent-a:1", "agent", clock.now), null);
    clock.t += 10;
    assert.equal(await canvasTickGate("agent-a:2", "agent", clock.now), null, "another slot of the same target");
    assert.equal(await canvasTickGate("agent-b:1", "agent", clock.now), null, "the same slot of another target");
});

test("script mode: a tick that comes too early waits out the rest of the interval", async () => {
    const clock = clockAt(3_000_000);
    assert.equal(await canvasTickGate("script-same:7", "script", clock.now), null);
    clock.t += 10;
    const started = performance.now();
    const second = await canvasTickGate("script-same:7", "script", clock.now);
    const waited = performance.now() - started;
    assert.equal(second, null, "a script tick is never refused");
    assert.ok(waited >= 90, `the second tick waited ${waited.toFixed(1)} ms; it must wait at least 90 ms`);
});

test("script mode: ticks that arrive together pass in order, one interval apart", async () => {
    const clock = clockAt(4_000_000);
    const passed = [];
    const started = performance.now();
    await Promise.all([1, 2, 3].map(async (n) => {
        assert.equal(await canvasTickGate("script-burst:5", "script", clock.now), null);
        passed.push({ n, at: performance.now() - started });
    }));
    assert.deepEqual(passed.map((p) => p.n), [1, 2, 3], "ticks pass in arrival order");
    assert.ok(passed[2].at >= 2 * 90, `the third tick passed after ${passed[2].at.toFixed(1)} ms; it must wait two intervals`);
});

test("an agent tick right after a waiting script tick is refused", async () => {
    const clock = clockAt(5_000_000);
    assert.equal(await canvasTickGate("mixed:2", "script", clock.now), null);
    clock.t += 10;
    const waiting = canvasTickGate("mixed:2", "script", clock.now);
    assert.match(await canvasTickGate("mixed:2", "agent", clock.now), /faster than 100 ms/,
        "the script's reserved tick counts against the agent's budget");
    assert.equal(await waiting, null);
});
