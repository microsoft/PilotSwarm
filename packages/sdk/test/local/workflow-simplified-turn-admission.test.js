/**
 * Workflow Simplified, delta review of 5d687726 (RT-D1; formal t4b, design note + C1-C5): a continued workflow
 * chat's live turn control admits its controls (the turn-to-visit fence) on its own chain.
 *
 * - RT-D1: a Stop is admitted and applied while an earlier steer's send has not returned: an own-visit Stop and a
 *   person's Stop abort at once; a stale Stop of another visit is dropped by admission and never queued or applied.
 *   Steers still go out in queue order. A Stop can wait for an earlier batch's admission, never for a send (C4).
 *
 * No live model, database, or duroxide runtime.
 */
import { describe, it, expect } from "vitest";
import { LiveTurnControl } from "../../src/turn-control.js";

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const control = (seq, kind, text = `${kind}-${seq}`) => ({ seq, kind, text, createdAt: new Date().toISOString() });

/** A port whose sends the test releases by hand. */
function manualPort() {
    const port = {
        state: "open",
        sends: [],
        pending: [],
        failures: [],
        gate: () => port.state,
        close: () => { port.state = "closed"; },
        sendSteer: (text, onConfirmed) => {
            port.sends.push(text);
            const send = deferred();
            port.pending.push(() => { onConfirmed(`m-${port.sends.length}`); send.resolve(); });
            return send.promise;
        },
        failTurn: (err) => { port.failures.push(err); },
    };
    return port;
}

/**
 * The fence's admission as session-proxy builds it: keeps a Stop with no visit (a person's) and the turn visit's own;
 * drops another visit's. `ids` maps seq -> visit; `gate` (optional) holds the read until released.
 */
function fence(visit, ids, { gate = null } = {}) {
    const calls = [];
    const dropped = [];
    const admit = async (controls) => {
        calls.push(controls.map((c) => c.seq));
        if (gate) await gate.promise;
        return controls.filter((c) => {
            if (c.kind !== "stop") return true;
            const target = ids[c.seq] ?? null;
            if (target === null || target === visit) return true;
            dropped.push(c.seq);
            return false;
        });
    };
    return { admit, calls, dropped };
}

const newLive = (admit, aborts = []) => new LiveTurnControl({ sessionId: "chat", turn: 3, start: 0, admit,
    abort: async (reason) => { aborts.push(reason); } });

describe("RT-D1: a Stop's admission never waits for a steer's send", () => {
    for (const [name, ids] of [["the visit's own Stop", { 2: "nx-1" }], ["a person's Stop (no visit)", {}]]) {
        it(`${name} is applied while an earlier steer's send has not returned`, async () => {
            const aborts = [];
            const { admit, calls } = fence("nx-1", ids);
            const live = newLive(admit, aborts);
            const port = manualPort();
            live.attach(port);
            void live.enqueue([control(1, "steer", "slow")]);
            await flush();
            expect(port.sends).toEqual(["slow"]);                 // in flight, not returned
            await live.enqueue([control(2, "stop", "halt"), control(3, "steer", "after")]);
            expect(calls).toEqual([[1], [2, 3]]);                   // the admission callback ran for the Stop's batch
            expect(aborts).toEqual(["halt"]);
            expect(port.state).toBe("closed");
            port.pending.shift()();
            await flush();
            expect(port.sends).toEqual(["slow"]);                   // nothing after the Stop
        });
    }

    it("a stale Stop of another visit is dropped by admission: never queued, never applied, and steers keep their order", async () => {
        const aborts = [];
        const { admit, dropped } = fence("nx-2", { 2: "nx-1" });
        const live = newLive(admit, aborts);
        const port = manualPort();
        live.attach(port);
        void live.enqueue([control(1, "steer", "one")]);
        await flush();
        void live.enqueue([control(2, "stop", "old visit"), control(3, "steer", "two")]);  // its drain waits for "one"
        await flush();
        expect(dropped).toEqual([2]);
        expect(live.heldStop()).toBeNull();
        expect(aborts).toEqual([]);
        expect(port.state).toBe("open");
        port.pending.shift()();
        await flush();
        expect(port.sends).toEqual(["one", "two"]);              // queue order
        port.pending.shift()();
        await flush();
        expect(live.cursor).toBe(3);
        expect(live.sent).toBe(3);
    });

    it("C4: a Stop waits for an earlier batch's admission (its id read), never for a send", async () => {
        const aborts = [];
        const gate = deferred();
        const { admit, calls } = fence("nx-1", { 2: "nx-1" }, { gate });
        const live = newLive(admit, aborts);
        const port = manualPort();
        live.attach(port);
        void live.enqueue([control(1, "steer", "one")]);
        const stop = live.enqueue([control(2, "stop", "halt")]);
        await flush();
        expect(calls).toEqual([[1]]);                             // the Stop's batch waits for batch 1's read
        expect(aborts).toEqual([]);
        gate.resolve();
        await stop;
        expect(aborts).toEqual(["halt"]);
    });
});
