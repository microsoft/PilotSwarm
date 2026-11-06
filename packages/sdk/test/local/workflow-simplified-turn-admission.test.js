/**
 * Workflow Simplified, delta review of 5d687726 (RT-D1, RT-D3; formal t4b, design note + C1-C5): a continued workflow
 * chat's live turn control admits its controls (the turn-to-visit fence) on its own chain.
 *
 * - RT-D1: a Stop is admitted and applied while an earlier steer's send has not returned: an own-visit Stop and a
 *   person's Stop abort at once; a stale Stop of another visit is dropped by admission and never queued or applied.
 *   Steers still go out in queue order. A Stop can wait for an earlier batch's admission, never for a send (C4).
 * - RT-D3: an admission that fails is kept whatever the port (heldFailure), fails an attached run, takes nothing from
 *   the failed batch on (`sent` goes back before it), takes no later control and sends nothing more. ManagedSession
 *   checks it before the initial send and before every corrective or reminder send (C5): no model send.
 *
 * A fake Copilot session stands in for the CLI. No live model, database, or duroxide runtime.
 */
import { describe, it, expect } from "vitest";
import { ManagedSession } from "../../src/managed-session.js";
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
function fence(visit, ids, { gate = null, fail = null } = {}) {
    const calls = [];
    const dropped = [];
    const admit = async (controls) => {
        calls.push(controls.map((c) => c.seq));
        if (gate) await gate.promise;
        if (fail) throw fail;
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
            expect(live.heldFailure()).toBeNull();
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

describe("RT-D3: an admission that fails is kept, fails the turn and takes nothing from its batch on", () => {
    it("before attach: kept (heldFailure), sent goes back before the batch, later controls are not taken", async () => {
        const failure = new Error("could not read the Stop's request id");
        let fail = null;
        const admit = async (controls) => { if (fail) throw fail; return controls; };
        const live = newLive(admit);
        await live.enqueue([control(1, "steer", "folded later")]);
        expect(live.sent).toBe(1);
        fail = failure;
        await live.enqueue([control(4, "stop", "halt"), control(5, "steer", "five")]);
        expect(live.heldFailure()).toBe(failure);
        expect(live.sent).toBe(3);                                // before the failed batch (seq 4)
        await live.enqueue([control(6, "steer", "six")]);
        expect(live.sent).toBe(3);                                // later controls are not taken
        expect(live.lookArgs()).toEqual({ sessionId: "chat", turn: 3, after: 3 });
        // Attached later: nothing is sent; the queued steer of the admitted batch is not sent to a failing turn.
        const port = manualPort();
        live.attach(port);
        live.gateOpened();
        await flush();
        expect(port.sends).toEqual([]);
    });

    it("after attach: the run fails with it, and nothing more is sent", async () => {
        const failure = new Error("id read failed");
        let fail = null;
        const admit = async (controls) => { if (fail) throw fail; return controls; };
        const live = newLive(admit);
        const port = manualPort();
        port.state = "pending";
        live.attach(port);
        await live.enqueue([control(1, "steer", "one")]);
        fail = failure;
        await live.enqueue([control(2, "stop", "halt")]);
        expect(port.failures).toEqual([failure]);
        port.state = "open";
        live.gateOpened();
        await flush();
        expect(port.sends).toEqual([]);
        expect(live.sent).toBe(1);
    });
});

/** A fake Copilot session (as in turn-control-live.test.js): the test drives every event. */
function createFakeCopilotSession() {
    const handlers = [];
    const emit = (type, data = {}) => { for (const h of [...handlers]) if (h.type === null || h.type === type) h.fn({ type, data }); };
    let n = 0;
    const fake = {
        sent: [],
        abortCalls: 0,
        registerTools() {},
        on(a, b) {
            const h = typeof a === "function" ? { type: null, fn: a } : { type: a, fn: b };
            handlers.push(h);
            return () => { const i = handlers.indexOf(h); if (i >= 0) handlers.splice(i, 1); };
        },
        async send(msg) { const id = `msg-${++n}`; fake.sent.push({ ...msg, id }); return id; },
        abort() { fake.abortCalls++; queueMicrotask(() => emit("session.idle")); },
        async disconnect() {},
        getMessages() { return []; },
        _emit: emit,
    };
    return fake;
}

function binding(live, { portFails = true } = {}) {
    const opened = deferred();
    const b = {
        port: null,
        // portFails false: the run's port cannot fail it (a failure that lands while no run can take it).
        attach: (port) => { b.port = port; live.attach(portFails ? port : { ...port, failTurn: () => {} }); },
        heldStop: () => live.heldStop(),
        heldFailure: () => live.heldFailure(),
        gateOpened: () => { live.gateOpened(); opened.resolve(); },
        detach: () => live.detach(),
    };
    return { b, opened: opened.promise };
}

describe("RT-D3 (C5): ManagedSession sends no prompt while an admission failure is held", () => {
    it("before the initial send: the turn fails with it and the model is sent nothing", async () => {
        const fake = createFakeCopilotSession();
        const managed = new ManagedSession("chat", fake, { waitThreshold: 30 });
        const failure = new Error("the turn-to-visit fence could not read a Stop");
        const live = newLive(async () => { throw failure; });
        await live.enqueue([control(1, "stop", "halt")]);
        const { b } = binding(live);
        const result = await managed.runTurn("work", { turnIndex: 3, turnControl: b });
        expect(fake.sent).toEqual([]);
        expect(result).toMatchObject({ type: "error" });
        expect(String(result.message)).toContain("could not read a Stop");
    });

    it("before a corrective send: no corrective prompt is sent after the failure", async () => {
        const fake = createFakeCopilotSession();
        const managed = new ManagedSession("chat", fake, { waitThreshold: 30 });
        const failure = new Error("id read failed during the run");
        let fail = null;
        const live = newLive(async (controls) => { if (fail) throw fail; return controls; });
        const { b, opened } = binding(live, { portFails: false });
        const turn = managed.runTurn("work", { turnIndex: 3, turnControl: b, requiredTool: "wait" });
        await opened;
        expect(fake.sent).toHaveLength(1);
        fail = failure;
        await live.enqueue([control(9, "stop", "halt")]);
        expect(live.heldFailure()).toBe(failure);
        fake._emit("session.idle");                               // the first run ends without the required tool
        const result = await turn;
        expect(fake.sent).toHaveLength(1);                        // no required-tool correction
        expect(result).toMatchObject({ type: "error" });
        expect(String(result.message)).toContain("id read failed");
    });
});
