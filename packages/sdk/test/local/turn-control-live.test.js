/**
 * Session turn control, phase A3: ManagedSession's send gate and settlement
 * with LiveTurnControl (design 4.5, 4.6, 7.2; Spec FR-006..FR-008; plan P13,
 * P21). A fake Copilot session stands in for the CLI; the test drives every
 * event, so ordering is deterministic. The only elapsed-time case is the turn
 * timeout bound, which is the requirement under test.
 *
 * No live model, database, or duroxide runtime required.
 */
import { describe, it, expect } from "vitest";
import { ManagedSession } from "../../src/managed-session.js";
import { LiveTurnControl } from "../../src/turn-control.js";

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/** Let pending promise continuations run (event-loop turns, not a timed wait). */
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

function createFakeCopilotSession({ abortFiresIdle = true, sendImpl } = {}) {
    const handlers = [];
    const emit = (type, data = {}) => {
        for (const h of [...handlers]) {
            if (h.type === null || h.type === type) h.fn({ type, data });
        }
    };
    let n = 0;
    const fake = {
        sent: [],
        sendCalls: [],
        abortCalls: 0,
        registerTools() {},
        on(a, b) {
            const h = typeof a === "function" ? { type: null, fn: a } : { type: a, fn: b };
            handlers.push(h);
            return () => {
                const i = handlers.indexOf(h);
                if (i >= 0) handlers.splice(i, 1);
            };
        },
        async send(msg) {
            const id = `msg-${++n}`;
            fake.sent.push({ ...msg, id });
            const call = deferred();
            fake.sendCalls.push(call);
            call.resolve();
            if (sendImpl) return sendImpl(msg, id, fake);
            return id;
        },
        abort() {
            fake.abortCalls++;
            if (abortFiresIdle) queueMicrotask(() => emit("session.idle"));
        },
        async disconnect() {},
        getMessages() { return []; },
        _emit: emit,
    };
    return fake;
}

const control = (seq, kind, text = `${kind}-${seq}`) => ({ seq, kind, text, createdAt: new Date().toISOString() });
const steersSent = (fake) => fake.sent.filter((m) => m.mode === "immediate");

/**
 * A LiveTurnControl wrapped as the binding ManagedSession sees, with signals
 * for attach and gate opening, and the port it was given.
 */
function setup({ config = {}, fake = createFakeCopilotSession(), start = 0, live: liveOverride } = {}) {
    const managed = new ManagedSession("turn-control-live", fake, { waitThreshold: 30, ...config });
    const recorded = [];
    const live = liveOverride ?? new LiveTurnControl({
        sessionId: "turn-control-live",
        turn: 4,
        start,
        abort: async (reason) => {
            managed.requestStop(reason);
            managed.abort();
        },
        record: async (eventType, data) => { recorded.push({ eventType, data }); },
    });
    const opened = deferred();
    const attached = deferred();
    const binding = {
        port: null,
        attach: (port) => { binding.port = port; live.attach(port); attached.resolve(port); },
        heldStop: () => live.heldStop(),
        gateOpened: () => { live.gateOpened(); opened.resolve(); },
        detach: () => live.detach(),
    };
    return { managed, fake, live, recorded, binding, opened: opened.promise, attached: attached.promise };
}

/** Tracks whether a turn promise settled, without waiting on time. */
function track(promise) {
    const state = { settled: false, value: undefined, error: undefined };
    promise.then((v) => { state.settled = true; state.value = v; }, (e) => { state.settled = true; state.error = e; });
    return state;
}

describe("turn control: ManagedSession send gate", () => {
    it("opens the gate after the initial prompt and closes it at idle before anything else", async () => {
        const { managed, fake, live, binding, opened } = setup();
        expect(managed.steerGateState()).toBe("none");
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: binding });
        await opened;
        expect(fake.sent[0].prompt).toBe("work");
        expect(binding.port.gate()).toBe("open");
        fake._emit("session.idle");
        expect(binding.port.gate()).toBe("closed");
        expect((await turn).type).toBe("completed");
        await live.enqueue([control(10, "steer")]);
        expect(steersSent(fake)).toEqual([]);
        expect(managed.steerGateState()).toBe("none");
    });

    it("an observer of session.idle already sees the gate closed and cannot send", async () => {
        const fake = createFakeCopilotSession();
        const { managed, binding, opened } = setup({ fake });
        const seen = [];
        const turn = managed.runTurn("work", {
            turnIndex: 4,
            turnControl: binding,
            onEvent: (event) => {
                if (event.eventType !== "session.idle") return;
                seen.push(binding.port.gate());
                seen.push(binding.port.sendSteer("late", () => {}).then(() => "sent", () => "refused"));
            },
        });
        await opened;
        fake._emit("session.idle");
        await turn;
        expect(seen[0]).toBe("closed");
        expect(await seen[1]).toBe("refused");
        expect(steersSent(fake)).toEqual([]);
    });

    describe("settlement for every order of send result (S), confirmation (U) and idle (I)", () => {
        // Each case: the steer's send is held until the test resolves it.
        const cases = [
            ["S U I", ["S", "U", "I"], false],
            ["S I U", ["S", "I", "U"], true],
            ["U S I", ["U", "S", "I"], false],
            ["U I S", ["U", "I", "S"], false],
            ["I S U", ["I", "S", "U"], true],
            ["I U S", ["I", "U", "S"], true],
        ];
        for (const [name, order, needsSecondIdle] of cases) {
            it(`${name}${needsSecondIdle ? " then a second idle" : ""}`, async () => {
                let releaseSend;
                const fake = createFakeCopilotSession({
                    sendImpl: (msg, id) => (msg.mode === "immediate" ? new Promise((resolve) => { releaseSend = () => resolve(id); }) : id),
                });
                const { managed, live, binding, opened } = setup({ fake });
                const turn = track(managed.runTurn("work", { turnIndex: 4, turnControl: binding }));
                await opened;
                const applied = live.enqueue([control(31, "steer")]);
                await flush();
                const steerId = steersSent(fake)[0].id;
                const steps = { S: () => releaseSend(), U: () => fake._emit("user.message", { messageId: steerId }), I: () => fake._emit("session.idle") };
                for (const [i, step] of order.entries()) {
                    expect(turn.settled, `settled before step ${i} (${step})`).toBe(false);
                    steps[step]();
                    await flush();
                }
                if (needsSecondIdle) {
                    expect(turn.settled).toBe(false);
                    fake._emit("session.idle");
                    await flush();
                }
                expect(turn.settled).toBe(true);
                expect(turn.value.type).toBe("completed");
                await applied;
                expect(live.cursor).toBe(31);
            });
        }
    });

    it("records each confirmed steer once", async () => {
        const { managed, fake, live, recorded, binding, opened } = setup();
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: binding });
        await opened;
        await live.enqueue([control(33, "steer")]);
        const steerId = steersSent(fake)[0].id;
        fake._emit("user.message", { messageId: steerId });
        fake._emit("user.message", { messageId: steerId });
        fake._emit("session.idle");
        await turn;
        expect(recorded).toEqual([{ eventType: "session.steer_confirmed", data: { seq: 33, turn: 4, messageId: steerId } }]);
    });

    it("Stop closes the gate before the abort, and no later steer is sent", async () => {
        const { managed, fake, live, binding, opened } = setup();
        const order = [];
        const realAbort = fake.abort.bind(fake);
        fake.abort = () => { order.push(`abort with gate ${binding.port.gate()}`); realAbort(); };
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: binding });
        await opened;
        await live.enqueue([control(40, "stop", "wrong way"), control(41, "steer")]);
        const result = await turn;
        expect(result).toMatchObject({ type: "stopped", reason: "wrong way" });
        expect(order).toEqual(["abort with gate closed"]);
        expect(steersSent(fake)).toEqual([]);
        expect(live.sent).toBe(41);
    });

    it("an abort without an idle closes the gate at once: a same-tick steer is refused", async () => {
        const fake = createFakeCopilotSession({ abortFiresIdle: false });
        const { managed, binding, opened } = setup({ fake });
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: binding });
        await opened;
        managed.abort();
        expect(binding.port.gate()).toBe("closed");
        await expect(binding.port.sendSteer("same tick", () => {})).rejects.toThrow(/not open/);
        managed.forceSettleTurn("test cleanup");
        await turn;
        expect(steersSent(fake)).toEqual([]);
    });

    it("a steer whose send throws ends the turn as an error", async () => {
        const fake = createFakeCopilotSession({
            sendImpl: (msg, id) => { if (msg.mode === "immediate") throw new Error("send failed"); return id; },
        });
        const { managed, live, binding, opened } = setup({ fake });
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: binding });
        await opened;
        await live.enqueue([control(50, "steer")]);
        // The failure ends the turn through its existing error path; the
        // activity retries it from the saved conversation with the steer still open.
        const result = await turn;
        expect(result.type).toBe("error");
        expect(result.message).toMatch(/send failed/);
        expect(live.cursor).toBe(0);
    });

    it("skips duplicate controls from overlapping looks and keeps position order", async () => {
        const { managed, fake, live, binding, opened } = setup({ start: 59 });
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: binding });
        await opened;
        const a = live.enqueue([control(62, "steer", "b"), control(61, "steer", "a"), control(59, "steer", "already folded")]);
        const b = live.enqueue([control(61, "steer", "a"), control(62, "steer", "b")]);
        await Promise.all([a, b]);
        expect(steersSent(fake).map((m) => m.prompt)).toEqual(["a", "b"]);
        expect(live.lookArgs()).toEqual({ sessionId: "turn-control-live", turn: 4, after: 62 });
        for (const m of steersSent(fake)) fake._emit("user.message", { messageId: m.id });
        fake._emit("session.idle");
        await turn;
    });

    it("holds controls that arrive before the initial send: a held Stop skips the send", async () => {
        const { managed, fake, live, binding } = setup();
        await live.enqueue([control(70, "steer", "early"), control(71, "stop", "never mind")]);
        const result = await managed.runTurn("work", { turnIndex: 4, turnControl: binding });
        expect(result).toMatchObject({ type: "stopped", reason: "never mind" });
        expect(fake.sent).toEqual([]);
        expect(live.sent).toBe(71);
    });

    it("holds a steer that arrives before the initial send and sends it right after", async () => {
        let releaseFirst;
        const fake = createFakeCopilotSession({
            sendImpl: (msg, id) => (msg.mode === "immediate" ? id : new Promise((resolve) => { releaseFirst = () => resolve(id); })),
        });
        const { managed, live, binding, attached, opened } = setup({ fake });
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: binding });
        await attached;
        await flush();
        expect(binding.port.gate()).toBe("pending");
        await live.enqueue([control(80, "steer", "early")]);
        expect(steersSent(fake)).toEqual([]);
        releaseFirst();
        await opened;
        await live.idle();
        expect(steersSent(fake).map((m) => m.prompt)).toEqual(["early"]);
        fake._emit("user.message", { messageId: steersSent(fake)[0].id });
        fake._emit("session.idle");
        expect((await turn).type).toBe("completed");
        expect(live.cursor).toBe(80);
    });

    it("settlement stays bounded by the turn timeout", async () => {
        const { managed, fake, live, binding, opened } = setup({ config: { turnTimeoutMs: 300, turnInactivityTimeoutMs: 0 } });
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: binding });
        await opened;
        await live.enqueue([control(90, "steer")]);
        fake._emit("session.idle");
        const started = Date.now();
        const outcome = await turn.then((r) => r.type, (e) => `threw: ${e.message}`);
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(String(outcome)).toMatch(/error|timed out/i);
    });

    it("a turn without turn control settles at the first idle as before", async () => {
        const fake = createFakeCopilotSession();
        const managed = new ManagedSession("no-turn-control", fake, { waitThreshold: 30 });
        const turn = managed.runTurn("work", { turnIndex: 1 });
        await flush();
        expect(fake.sent.length).toBe(1);
        expect(managed.steerGateState()).toBe("none");
        fake._emit("session.idle");
        expect((await turn).type).toBe("completed");
    });
});

describe("turn control: the live loop keeps position order (no gate races)", () => {
    function manualPort() {
        const port = {
            state: "pending",
            sends: [],
            closes: 0,
            gate: () => port.state,
            close: () => { port.closes += 1; port.state = "closed"; },
            sendSteer: async (text, onConfirmed) => { port.sends.push(text); onConfirmed(`m-${port.sends.length}`); },
            failTurn: () => {},
        };
        return port;
    }
    const newLive = (aborts = []) => new LiveTurnControl({ sessionId: "s", turn: 1, start: 0, abort: async (reason) => { aborts.push(reason); } });

    it("a held steer goes before a newer steer queued while the gate opens", async () => {
        const live = newLive();
        const port = manualPort();
        live.attach(port);
        await live.enqueue([control(1, "steer", "one")]);
        const queued = live.enqueue([control(2, "steer", "two")]);
        port.state = "open";
        live.gateOpened();
        await queued;
        await live.idle();
        expect(port.sends).toEqual(["one", "two"]);
    });

    it("a held steer goes before a newer Stop, and nothing is sent after the Stop", async () => {
        const aborts = [];
        const live = newLive(aborts);
        const port = manualPort();
        live.attach(port);
        await live.enqueue([control(1, "steer", "one")]);
        const queued = live.enqueue([control(2, "stop", "halt"), control(3, "steer", "three")]);
        port.state = "open";
        live.gateOpened();
        await queued;
        await live.idle();
        expect(port.sends).toEqual(["one"]);
        expect(aborts).toEqual(["halt"]);
        expect(port.state).toBe("closed");
    });
});

describe("turn control: an ended turn's loop cannot touch the next turn", () => {
    it("a forced unwind with a pending send: the late result and the old chain reach neither the next turn nor the old cursor", async () => {
        const pendingSends = [];
        const fake = createFakeCopilotSession({
            sendImpl: (msg, id) => (msg.mode === "immediate" ? new Promise((resolve, reject) => pendingSends.push({ id, resolve, reject })) : id),
        });
        const first = setup({ fake });
        const turnA = first.managed.runTurn("work A", { turnIndex: 4, turnControl: first.binding });
        await first.opened;
        void first.live.enqueue([control(31, "steer", "a1"), control(32, "steer", "a2")]);
        await flush();
        expect(pendingSends.length).toBe(1);
        first.managed.forceSettleTurn("stopped by test");
        expect((await turnA).type).toBe("stopped");
        first.live.retire();

        // Turn B on the same warm ManagedSession.
        const liveB = new LiveTurnControl({ sessionId: "turn-control-live", turn: 5, start: 0, abort: async () => {} });
        const opensB = deferred();
        const bindingB = {
            attach: (port) => { bindingB.port = port; liveB.attach(port); },
            heldStop: () => liveB.heldStop(),
            gateOpened: () => { liveB.gateOpened(); opensB.resolve(); },
            detach: () => liveB.detach(),
        };
        const turnB = track(first.managed.runTurn("work B", { turnIndex: 5, turnControl: bindingB }));
        await opensB.promise;

        // A's send resolves late, then A's old chain would continue.
        pendingSends[0].resolve(pendingSends[0].id);
        await flush();
        fake._emit("user.message", { messageId: pendingSends[0].id });
        await flush();
        expect(steersSent(fake).map((m) => m.prompt)).toEqual(["a1"]);
        expect(first.live.cursor).toBe(0);
        expect(turnB.settled).toBe(false);

        fake._emit("session.idle");
        await flush();
        expect(turnB.settled).toBe(true);
        expect(turnB.value.type).toBe("completed");
    });

    it("a late send failure from an ended turn does not fail the next turn", async () => {
        const pendingSends = [];
        const fake = createFakeCopilotSession({
            sendImpl: (msg, id) => (msg.mode === "immediate" ? new Promise((resolve, reject) => pendingSends.push({ id, resolve, reject })) : id),
        });
        const first = setup({ fake });
        const turnA = first.managed.runTurn("work A", { turnIndex: 4, turnControl: first.binding });
        await first.opened;
        void first.live.enqueue([control(31, "steer", "a1")]);
        await flush();
        first.managed.forceSettleTurn("stopped by test");
        await turnA;
        first.live.retire();

        const second = setup({ fake, live: new LiveTurnControl({ sessionId: "turn-control-live", turn: 5, start: 0, abort: async () => {} }) });
        // setup() made a new ManagedSession; reuse the first one for B.
        const turnB = track(first.managed.runTurn("work B", { turnIndex: 5, turnControl: second.binding }));
        await second.opened;
        pendingSends[0].reject(new Error("late failure"));
        await flush();
        expect(turnB.settled).toBe(false);
        fake._emit("session.idle");
        await flush();
        expect(turnB.value.type).toBe("completed");
    });
});
