import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { waitForStoppedTurn } from "../helpers/stop-turn-readiness.mjs";

const BUDGET = 30_000;
const stopped = { eventType: "session.turn_stopped", data: { turnIndex: 0 } };

function fixture(t, { idleAt = 0, eventAt = Infinity, event = stopped } = {}) {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    const reads = [];
    const mgmt = {
        _catalog: {
            async getSession(id) {
                assert.equal(id, "fixture-session");
                reads.push(Date.now());
                return { state: Date.now() >= idleAt ? "idle" : "running" };
            },
        },
        async getSessionEvents(id) {
            assert.equal(id, "fixture-session");
            return Date.now() >= eventAt ? [event] : [];
        },
    };
    let settled = false;
    const result = waitForStoppedTurn(mgmt, "fixture-session", 0, BUDGET)
        .then((value) => { settled = true; return value; });
    return { result, reads, settled: () => settled };
}

async function advance(t, milliseconds) {
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 250) {
        t.mock.timers.tick(250);
        await setImmediate();
    }
}

test("idle alone is not readiness; the delayed persisted stopped event is awaited", async (t) => {
    const f = fixture(t, { eventAt: 750 });
    await setImmediate();
    assert.equal(f.settled(), false);
    await advance(t, 500);
    assert.equal(f.settled(), false);
    await advance(t, 250);
    assert.equal(await f.result, true);
    assert.equal(Date.now(), 750);
});

test("idle and stopped-event readiness share the original single bounded wait", async (t) => {
    const f = fixture(t, { idleAt: BUDGET - 250, eventAt: BUDGET });
    await setImmediate();
    await advance(t, BUDGET - 250);
    assert.equal(f.settled(), false);
    await advance(t, 250);
    assert.equal(await f.result, true);
    assert.equal(Date.now(), BUDGET);
});

for (const [name, options] of [
    ["missing event", {}],
    ["wrong event type", { eventAt: 0, event: { eventType: "user.stop", data: { turnIndex: 0 } } }],
    ["stopped event for another turn", { eventAt: 0, event: { ...stopped, data: { turnIndex: 1 } } }],
    ["event arriving after the budget", { idleAt: BUDGET - 250, eventAt: BUDGET + 250 }],
    ["event before CMS becomes idle", { idleAt: Infinity, eventAt: 0 }],
]) {
    test(`${name} cannot satisfy readiness or extend its budget`, async (t) => {
        const f = fixture(t, options);
        await setImmediate();
        await advance(t, BUDGET);
        assert.equal(await f.result, false);
        assert.equal(Date.now(), BUDGET);
        assert.equal(f.reads.at(-1), BUDGET);
    });
}
