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
import { ManagedSession, TURN_INACTIVITY_ERROR_MARKER } from "../../src/managed-session.js";
import { LiveTurnControl } from "../../src/turn-control.js";

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

/** Let pending promise continuations run (event-loop turns, not a timed wait). */
const waitForActive = async (managed) => { for (let i = 0; i < 50 && !managed.getActiveTurn(); i++) await new Promise((r) => setImmediate(r)); };
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
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: binding });
        await opened;
        expect(fake.sent[0].prompt).toBe("work");
        expect(binding.port.gate()).toBe("open");
        fake._emit("session.idle");
        expect(binding.port.gate()).toBe("closed");
        expect((await turn).type).toBe("completed");
        // After the run the port reads closed and the control sends nothing.
        await live.enqueue([control(10, "steer")]);
        expect(binding.port.gate()).toBe("closed");
        expect(steersSent(fake)).toEqual([]);
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

    // The guards are real timers: their firing is the behaviour under test.
    // Everything after it is driven by deferred signals.
    for (const guard of [
        { name: "wall-clock timeout", config: { turnTimeoutMs: 40, turnInactivityTimeoutMs: 0 }, message: /taking too long/ },
        { name: "inactivity watchdog", config: { turnTimeoutMs: 0, turnInactivityTimeoutMs: 40 }, message: new RegExp(TURN_INACTIVITY_ERROR_MARKER) },
    ]) {
        it(`the ${guard.name} closes the gate before its abort; nothing is sent while the abort is pending`, async () => {
            const fake = createFakeCopilotSession({ abortFiresIdle: false });
            const { managed, live, binding, opened } = setup({ fake, config: guard.config });
            const abortCalled = deferred();
            const abortDone = deferred();
            let gateAtAbort = null;
            fake.abort = () => {
                fake.abortCalls++;
                gateAtAbort = binding.port.gate();
                abortCalled.resolve();
                return abortDone.promise;
            };
            const turn = managed.runTurn("work", { turnIndex: 4, turnControl: binding });
            await opened;
            expect(binding.port.gate()).toBe("open");
            await abortCalled.promise;
            expect(gateAtAbort).toBe("closed");
            await expect(binding.port.sendSteer("during the abort", () => {})).rejects.toThrow(/not open/);
            await live.enqueue([control(7, "steer")]);
            await flush();
            expect(steersSent(fake)).toEqual([]);
            abortDone.resolve();
            const result = await turn;
            expect(result.type).toBe("error");
            expect(result.message).toMatch(guard.message);
            expect(fake.abortCalls).toBe(1);
            expect(steersSent(fake)).toEqual([]);
        });
    }

    // CLI 1.0.83: an abort while the turn waits on a backgrounded shell sends
    // assistant.idle { aborted: true } and no session.idle.
    const abortWithoutSessionIdle = (fake) => {
        fake.abort = () => {
            fake.abortCalls++;
            queueMicrotask(() => fake._emit("assistant.idle", { aborted: true }));
        };
        return fake;
    };

    it("a Stop of a turn-control run settles on assistant.idle { aborted } when the CLI sends no session.idle", async () => {
        const fake = abortWithoutSessionIdle(createFakeCopilotSession({ abortFiresIdle: false }));
        const { managed, live, binding, opened } = setup({ fake });
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: binding });
        await opened;
        await live.enqueue([control(9, "stop")]);
        const result = await turn;
        expect(result.type).toBe("stopped");
        expect(fake.abortCalls).toBe(1);
    });

    it("a Stop while an earlier steer's send is still open: abort and stopped settlement before the send returns", async () => {
        let releaseSend;
        const fake = createFakeCopilotSession({
            sendImpl: (msg, id) => (msg.mode === "immediate" ? new Promise((resolve) => { releaseSend = () => resolve(id); }) : id),
        });
        const { managed, live, binding, opened } = setup({ fake });
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: binding });
        await opened;
        void live.enqueue([control(50, "steer", "slow")]);
        await flush();
        expect(steersSent(fake).map((m) => m.prompt)).toEqual(["slow"]);
        await live.enqueue([control(51, "stop", "halt")]);
        expect(fake.abortCalls).toBe(1);
        const result = await turn;
        expect(result).toMatchObject({ type: "stopped", reason: "halt" });
        releaseSend();
        await flush();
        expect(steersSent(fake)).toHaveLength(1);
        expect(live.cursor).toBe(0);
    });

    describe("corrective model runs inside the turn take controls like the first run", () => {
        const invokeAsText = '<invoke name="bash"><parameter name="command">ls</parameter></invoke>';
        const correctionSent = async (fake, n) => { for (let i = 0; i < 20 && fake.sent.length < n; i++) await flush(); };

        for (const kind of ["tool-call-as-text", "required-tool"]) {
            it(`${kind}: a steer reaches the corrective run, and a Stop aborts it (no session.idle after the abort)`, async () => {
                const fake = abortWithoutSessionIdle(createFakeCopilotSession({ abortFiresIdle: false }));
                const { managed, live, binding, opened } = setup({ fake });
                const turn = managed.runTurn("work", {
                    turnIndex: 4, turnControl: binding, ...(kind === "required-tool" ? { requiredTool: "wait" } : {}),
                });
                await opened;
                if (kind === "tool-call-as-text") fake._emit("assistant.message", { content: invokeAsText });
                fake._emit("session.idle");                    // the first run ends; a correction follows
                await correctionSent(fake, 2);
                expect(fake.sent).toHaveLength(2);
                expect(binding.port.gate()).toBe("open");
                await live.enqueue([control(60, "steer", "during the correction")]);
                expect(steersSent(fake).map((m) => m.prompt)).toEqual(["during the correction"]);
                fake._emit("user.message", { messageId: steersSent(fake)[0].id });
                await live.enqueue([control(61, "stop", "halt")]);
                expect(fake.abortCalls).toBe(1);
                expect(await turn).toMatchObject({ type: "stopped", reason: "halt" });
                expect(live.cursor).toBe(60);
                expect(fake.sent).toHaveLength(3);
            });
        }

        it("no corrective prompt after a Stop applied during the first run", async () => {
            const fake = createFakeCopilotSession();
            const { managed, live, binding, opened } = setup({ fake });
            const turn = managed.runTurn("work", { turnIndex: 4, turnControl: binding, requiredTool: "wait" });
            await opened;
            await live.enqueue([control(70, "stop", "halt")]);
            expect(await turn).toMatchObject({ type: "stopped", reason: "halt" });
            expect(fake.sent).toHaveLength(1);
        });

        it("no corrective prompt after a Stop held while the first run settled", async () => {
            const fake = createFakeCopilotSession();
            const { managed, live, binding, opened } = setup({ fake });
            const turn = managed.runTurn("work", { turnIndex: 4, turnControl: binding, requiredTool: "wait" });
            await opened;
            await live.enqueue([control(80, "steer", "late guidance")]);
            fake._emit("session.idle");                        // closed: the steer is not confirmed yet
            await live.enqueue([control(81, "stop", "halt")]);  // held, not applied
            expect(fake.abortCalls).toBe(0);
            fake._emit("user.message", { messageId: steersSent(fake)[0].id });
            fake._emit("session.idle");
            expect(await turn).toMatchObject({ type: "stopped", reason: "halt" });
            expect(fake.sent).toHaveLength(2);                 // the prompt and the steer; no correction
        });
    });

    it("a late session.idle of the early-settled run does not settle the next run", async () => {
        const fake = abortWithoutSessionIdle(createFakeCopilotSession({ abortFiresIdle: false }));
        const first = setup({ fake });
        const managed = first.managed;
        const turn1 = managed.runTurn("work", { turnIndex: 4, turnControl: first.binding });
        await first.opened;
        await first.live.enqueue([control(9, "stop")]);
        expect((await turn1).type).toBe("stopped");

        const live2 = new LiveTurnControl({ sessionId: "turn-control-live", turn: 5, start: 0, abort: async () => {} });
        const opened2 = deferred();
        const binding2 = {
            attach: (port) => live2.attach(port),
            heldStop: () => live2.heldStop(),
            gateOpened: () => { live2.gateOpened(); opened2.resolve(); },
            detach: () => live2.detach(),
        };
        const turn2 = managed.runTurn("next", { turnIndex: 5, turnControl: binding2 });
        await opened2.promise;
        fake._emit("session.idle");                       // the first run's late idle
        await flush();
        expect(managed.getActiveTurn()?.turnIndex).toBe(5);
        // The stale idle did not close the new run's gate: a steer still goes out.
        await live2.enqueue([control(20, "steer", "after the stale idle")]);
        expect(steersSent(fake).map((m) => m.prompt)).toEqual(["after the stale idle"]);
        fake._emit("user.message", { messageId: "msg-next" });
        fake._emit("user.message", { messageId: steersSent(fake)[0].id });
        fake._emit("session.idle");
        expect((await turn2).type).toBe("completed");
        expect(live2.cursor).toBe(20);
    });

    it("assistant.idle { aborted } without a Stop does not settle: the turn still waits for session.idle", async () => {
        const fake = createFakeCopilotSession();
        const { managed, binding, opened } = setup({ fake });
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: binding });
        await opened;
        fake._emit("assistant.idle", { aborted: true });
        await flush();
        expect(managed.getActiveTurn()).not.toBeNull();
        fake._emit("session.idle");
        expect((await turn).type).toBe("completed");
    });

    it("a run without turn control (legacy Stop) keeps settling only on session.idle", async () => {
        const fake = abortWithoutSessionIdle(createFakeCopilotSession({ abortFiresIdle: false }));
        const managed = new ManagedSession("turn-control-live", fake, { waitThreshold: 30 });
        const turn = managed.runTurn("work", { turnIndex: 4 });
        await waitForActive(managed);
        managed.requestStop("Stopped by user");
        managed.abort();
        await flush();
        expect(managed.getActiveTurn()).not.toBeNull();
        managed.forceSettleTurn("test cleanup");
        expect((await turn).type).toBe("stopped");
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
        await flush();
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
        await flush();
        expect(port.sends).toEqual(["one", "two"]);
    });

    it("a Stop held behind held steers applies first when the gate opens: nothing is sent (the stopped turn would not deliver them)", async () => {
        const aborts = [];
        const live = newLive(aborts);
        const port = manualPort();
        live.attach(port);
        await live.enqueue([control(1, "steer", "one")]);
        const queued = live.enqueue([control(2, "stop", "halt"), control(3, "steer", "three")]);
        port.state = "open";
        live.gateOpened();
        await queued;
        await flush();
        expect(port.sends).toEqual([]);
        expect(aborts).toEqual(["halt"]);
        expect(port.state).toBe("closed");
    });

    it("a Stop does not wait for an earlier steer's send: it closes the gate and aborts while the send is still open", async () => {
        const aborts = [];
        const live = newLive(aborts);
        let releaseSend;
        const port = manualPort();
        port.state = "open";
        port.sendSteer = (text) => { port.sends.push(text); return new Promise((resolve) => { releaseSend = resolve; }); };
        live.attach(port);
        void live.enqueue([control(1, "steer", "slow")]);
        await flush();
        expect(port.sends).toEqual(["slow"]);
        await live.enqueue([control(2, "stop", "halt"), control(3, "steer", "after")]);
        expect(aborts).toEqual(["halt"]);
        expect(port.state).toBe("closed");
        releaseSend();
        await flush();
        expect(port.sends).toEqual(["slow"]);
        expect(aborts).toEqual(["halt"]);
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
