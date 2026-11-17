/**
 * The canvas tick limiter: one worker-wide state per `${target}:${slot}`,
 * holding the last ACTUAL admission time and the number of script ticks
 * still waiting. An agent tick is decided at call time: it is refused while
 * a script tick waits or within 100 ms of the last admission, as it always
 * was. A Workflow script cannot pace itself, so its tick holds a place at
 * call time and waits for its turn inside the target's write chain.
 *
 * Run: node --test test/unit/canvas-tick-gate.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
    CANVAS_TICK_MIN_INTERVAL_MS,
    canvasTickGate,
    canvasTickKeyCount,
    enqueueCanvasWrite,
    reserveScriptTick,
    waitForScriptTickTurn,
} from "../../dist/canvas-operations.js";

// A controllable monotonic clock. Each sleep moves the clock by the requested
// time plus the next drift: a negative drift is an early wake-up, a positive
// one a late resume.
function fakeClock(start, drift = []) {
    const clock = {
        t: start,
        sleeps: [],
        now: () => clock.t,
        sleep: async (ms) => {
            clock.sleeps.push(ms);
            clock.t += ms + (drift.length ? drift.shift() : 0);
        },
    };
    return clock;
}

const REFUSAL = (slot) => `ticking slot ${slot} faster than 100 ms apart — aggregate your changes into fewer, larger ticks`;

test("the floor between ticks is 100 ms", () => {
    assert.equal(CANVAS_TICK_MIN_INTERVAL_MS, 100);
});

test("agent: a tick 10 ms after the last is refused in today's words, and a refusal never stamps", () => {
    const clock = fakeClock(1_000_000);
    assert.deepEqual(canvasTickGate("agent-same:3", clock.now), { admitted: true });
    clock.t += 10;
    assert.deepEqual(canvasTickGate("agent-same:3", clock.now), { refused: REFUSAL(3) });
    clock.t += 89;
    assert.deepEqual(canvasTickGate("agent-same:3", clock.now), { refused: REFUSAL(3) }, "99 ms after the admitted tick");
    clock.t += 1;
    assert.deepEqual(canvasTickGate("agent-same:3", clock.now), { admitted: true },
        "100 ms after the ADMITTED tick: the refusals in between stamped nothing");
});

test("agent: a different key is a separate budget", () => {
    const clock = fakeClock(1_100_000);
    assert.deepEqual(canvasTickGate("agent-a:1", clock.now), { admitted: true });
    clock.t += 10;
    assert.deepEqual(canvasTickGate("agent-a:2", clock.now), { admitted: true }, "another slot of the same target");
    assert.deepEqual(canvasTickGate("agent-b:1", clock.now), { admitted: true }, "the same slot of another target");
});

test("script: ticks admit in order at ACTUAL times at least 100 ms apart, after an early and a late wake-up", async () => {
    // Sleep 1 wakes 30 ms early (the gate must sleep again); sleep 2 wakes 70 ms late.
    const clock = fakeClock(2_000_000, [-30, 70]);
    const t0 = clock.t;
    const admitted = [];
    for (let n = 1; n <= 3; n += 1) reserveScriptTick("spacing:7", clock.now);
    reserveScriptTick("spacing:8", clock.now);
    const runs = [1, 2, 3].map((n) => enqueueCanvasWrite("spacing", async () => {
        await waitForScriptTickTurn("spacing:7", clock);
        admitted.push({ n, at: clock.now() });
    }));
    // Same target, another slot: it queues behind slot 7's writes but has its own budget.
    const other = enqueueCanvasWrite("spacing", async () => {
        await waitForScriptTickTurn("spacing:8", clock);
        return clock.now();
    });
    await Promise.all(runs);
    const otherAt = await other;
    assert.deepEqual(admitted.map((a) => a.n), [1, 2, 3], "first in, first admitted");
    assert.deepEqual(admitted.map((a) => a.at - t0), [0, 170, 270],
        "tick 2 admits when the late wake-up lands (170); tick 3 is spaced from that ACTUAL time, not from a reserved 100");
    for (let i = 1; i < admitted.length; i += 1) {
        assert.ok(admitted[i].at - admitted[i - 1].at >= 100, `ticks ${i} and ${i + 1} are at least 100 ms apart`);
    }
    assert.deepEqual(clock.sleeps, [100, 30, 100], "the early wake-up re-read the clock and slept the rest");
    assert.equal(otherAt, admitted[2].at, "slot 8 waited for nothing of its own");
});

test("agent vs script: an agent tick is refused while a script tick waits; refused agent ticks never stamp", async () => {
    const clock = fakeClock(3_000_000);
    const t0 = clock.t;
    assert.deepEqual(canvasTickGate("mixed:2", clock.now), { admitted: true });
    reserveScriptTick("mixed:2", clock.now);
    clock.t += 200;
    assert.deepEqual(canvasTickGate("mixed:2", clock.now), { refused: REFUSAL(2) },
        "200 ms after the last admission, but a script tick is still waiting for its turn");
    await waitForScriptTickTurn("mixed:2", clock);
    assert.deepEqual(clock.sleeps, [], "the refused agent tick did not stamp, so the script tick had nothing to wait for");
    clock.t += 99;
    assert.deepEqual(canvasTickGate("mixed:2", clock.now), { refused: REFUSAL(2) }, "the script tick stamped its admission");
    clock.t += 1;
    assert.deepEqual(canvasTickGate("mixed:2", clock.now), { admitted: true });
    assert.equal(clock.t - t0, 300);
});

test("a script tick whose wait fails gives its place back", async () => {
    const clock = { t: 4_000_000, now: () => clock.t, sleep: async () => { throw new Error("the timer broke"); } };
    assert.deepEqual(canvasTickGate("broken:1", clock.now), { admitted: true });
    reserveScriptTick("broken:1", clock.now);
    await assert.rejects(waitForScriptTickTurn("broken:1", clock), /the timer broke/);
    clock.t += 100;
    assert.deepEqual(canvasTickGate("broken:1", clock.now), { admitted: true }, "no reservation is left behind");
});

test("pruning drops stale keys and never a key with a waiting script tick", async () => {
    const clock = fakeClock(5_000_000);
    reserveScriptTick("prune-waiting:1", clock.now);
    for (let i = 0; i < 1100; i += 1) canvasTickGate(`prune-${i}:1`, clock.now);
    const before = canvasTickKeyCount();
    assert.ok(before >= 1101, `the clock holds ${before} keys`);
    clock.t += 1000;
    canvasTickGate("prune-trigger:1", clock.now);
    // The 1,100 stale keys go; the trigger key is added after the sweep.
    assert.ok(canvasTickKeyCount() <= before - 1100 + 1, `the stale keys were dropped (${before} -> ${canvasTickKeyCount()})`);
    assert.deepEqual(canvasTickGate("prune-waiting:1", clock.now), { refused: REFUSAL(1) }, "the waiting reservation survived the sweep");
    await waitForScriptTickTurn("prune-waiting:1", clock);
    assert.deepEqual(clock.sleeps, [], "and its tick is admitted at once");
});
