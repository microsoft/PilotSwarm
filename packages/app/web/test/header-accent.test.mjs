import test from "node:test";
import assert from "node:assert/strict";
import { createHeaderAccent, HEADER_ACCENT_PASS_MS } from "../src/header-accent.js";

function fixture(random = () => 0) {
    let now = 0, id = 0;
    const timers = new Map(), events = [];
    const accent = createHeaderAccent({
        random,
        start: () => events.push(["start", now]),
        stop: () => events.push(["stop", now]),
        setTimer: (callback, delay) => {
            const key = ++id;
            timers.set(key, { callback, at: now + delay });
            return key;
        },
        clearTimer: key => timers.delete(key),
    });
    const advance = duration => {
        const end = now + duration;
        for (;;) {
            const due = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
            if (!due || due[1].at > end) break;
            now = due[1].at;
            timers.delete(due[0]);
            due[1].callback();
        }
        now = end;
    };
    return { accent, advance, timers, events };
}

test("first pass waits 30 seconds; later passes wait 30 seconds after the previous pass ends", () => {
    const f = fixture();
    f.accent.setEnabled(true);
    f.advance(29_999);
    assert.deepEqual(f.events, []);
    f.advance(1);
    assert.deepEqual(f.events, [["start", 30_000]]);
    f.advance(HEADER_ACCENT_PASS_MS);
    assert.deepEqual(f.events[1], ["stop", 35_500]);
    f.advance(29_999);
    assert.equal(f.events.length, 2);
    f.advance(1);
    assert.deepEqual(f.events[2], ["start", 65_500]);
});

test("random idle spans 30 to 60 seconds and is chosen again for each pass", () => {
    const values = [0.5, 1, 0];
    const f = fixture(() => values.shift());
    f.accent.setEnabled(true);
    f.advance(45_000 + HEADER_ACCENT_PASS_MS);
    assert.deepEqual(f.events, [["start", 45_000], ["stop", 50_500]]);
    f.advance(59_999);
    assert.equal(f.events.length, 2);
    f.advance(1);
    assert.deepEqual(f.events[2], ["start", 110_500]);
});

test("ordinary controller updates do not restart the timer", () => {
    const f = fixture();
    f.accent.setEnabled(true);
    f.advance(15_000);
    f.accent.setEnabled(true);
    f.advance(15_000);
    assert.deepEqual(f.events, [["start", 30_000]]);
});

test("disabling during a pass stops it and returning starts a fresh cooldown", () => {
    const f = fixture();
    f.accent.setEnabled(true);
    f.advance(31_000);
    f.accent.setEnabled(false);
    assert.deepEqual(f.events, [["start", 30_000], ["stop", 31_000]]);
    assert.equal(f.timers.size, 0);
    f.accent.setEnabled(true);
    f.advance(29_999);
    assert.equal(f.events.length, 2);
    f.advance(1);
    assert.deepEqual(f.events[2], ["start", 61_000]);
});

test("disabling during cooldown cancels the pending pass", () => {
    const f = fixture();
    f.accent.setEnabled(true);
    f.advance(20_000);
    f.accent.setEnabled(false);
    f.advance(180_000);
    assert.deepEqual(f.events, []);
    assert.equal(f.timers.size, 0);
});

test("disposal stops an active pass, clears timers and prevents reactivation", () => {
    const f = fixture();
    f.accent.setEnabled(true);
    f.advance(30_000);
    f.accent.dispose();
    f.accent.setEnabled(true);
    f.advance(180_000);
    assert.deepEqual(f.events, [["start", 30_000], ["stop", 30_000]]);
    assert.equal(f.timers.size, 0);
});
