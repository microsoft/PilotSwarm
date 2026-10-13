/**
 * Session turn control, phase A3: ManagedSession's send gate and settlement
 * with LiveTurnControl (design 4.5, 4.6, 7.2; Spec FR-006..FR-008; plan P13,
 * P21). A fake Copilot session stands in for the CLI.
 *
 * No live model, database, or duroxide runtime required.
 */
import { describe, it, expect } from "vitest";
import { ManagedSession } from "../../src/managed-session.js";
import { LiveTurnControl } from "../../src/turn-control.js";

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
            if (sendImpl) return sendImpl(msg, id, fake);
            return id;
        },
        abort() {
            fake.abortCalls++;
            if (abortFiresIdle) setTimeout(() => emit("session.idle"), 5);
        },
        async disconnect() {},
        getMessages() { return []; },
        _emit: emit,
    };
    return fake;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 2_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(5);
    }
    return predicate();
}
const pending = async (promise, ms = 60) => Promise.race([promise.then(() => "settled", () => "rejected"), sleep(ms).then(() => "pending")]);
const control = (seq, kind, text = `${kind}-${seq}`) => ({ seq, kind, text, createdAt: new Date().toISOString() });

function setup({ config = {}, fake = createFakeCopilotSession(), start = 0 } = {}) {
    const managed = new ManagedSession("turn-control-live", fake, { waitThreshold: 30, ...config });
    const recorded = [];
    const traces = [];
    const live = new LiveTurnControl({
        sessionId: "turn-control-live",
        turn: 4,
        start,
        port: managed,
        abort: async (reason) => {
            managed.requestStop(reason);
            managed.abort();
        },
        record: async (eventType, data) => { recorded.push({ eventType, data }); },
        trace: (message) => traces.push(message),
    });
    return { managed, fake, live, recorded, traces };
}

const steersSent = (fake) => fake.sent.filter((m) => m.mode === "immediate");

describe("turn control: ManagedSession send gate", () => {
    it("opens the gate after the initial prompt and closes it at idle before anything else", async () => {
        const { managed, fake, live } = setup();
        expect(managed.steerGateState()).toBe("none");
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: live });
        await waitFor(() => managed.steerGateState() === "open");
        expect(fake.sent[0].prompt).toBe("work");
        fake._emit("session.idle");
        expect(managed.steerGateState()).toBe("closed");
        expect((await turn).type).toBe("completed");
        await live.enqueue([control(10, "steer")]);
        expect(steersSent(fake)).toEqual([]);
        expect(managed.steerGateState()).toBe("none");
    });

    it("an unconfirmed steer delays settlement until its user.message and the following idle", async () => {
        const { managed, fake, live, recorded } = setup();
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: live });
        await waitFor(() => managed.steerGateState() === "open");
        await live.enqueue([control(31, "steer", "use the v2 API")]);
        const [steer] = steersSent(fake);
        expect(steer).toMatchObject({ prompt: "use the v2 API", mode: "immediate" });
        expect(live.cursor).toBe(0);

        fake._emit("session.idle");
        expect(await pending(turn)).toBe("pending");
        fake._emit("user.message", { messageId: steer.id, delivery: "queued" });
        expect(live.cursor).toBe(31);
        expect(await pending(turn)).toBe("pending");
        fake._emit("session.idle");
        expect((await turn).type).toBe("completed");
        expect(recorded).toEqual([{ eventType: "session.steer_confirmed", data: { seq: 31, turn: 4, messageId: steer.id } }]);
    });

    it("recognises a confirmation that arrives before send() resolves", async () => {
        let release;
        const fake = createFakeCopilotSession({
            sendImpl: (msg, id, f) => {
                if (msg.mode !== "immediate") return id;
                f._emit("user.message", { messageId: id, delivery: "steering" });
                return new Promise((resolve) => { release = () => resolve(id); });
            },
        });
        const { managed, live, recorded } = setup({ fake });
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: live });
        await waitFor(() => managed.steerGateState() === "open");
        const applied = live.enqueue([control(32, "steer")]);
        await waitFor(() => typeof release === "function");
        fake._emit("session.idle");
        expect(await pending(turn)).toBe("pending");
        release();
        await applied;
        expect(live.cursor).toBe(32);
        expect((await turn).type).toBe("completed");
        expect(recorded.length).toBe(1);
    });

    it("a confirmed steer before the final idle settles at that idle", async () => {
        const { managed, fake, live } = setup();
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: live });
        await waitFor(() => managed.steerGateState() === "open");
        await live.enqueue([control(33, "steer")]);
        fake._emit("user.message", { messageId: steersSent(fake)[0].id, delivery: "steering" });
        fake._emit("session.idle");
        expect((await turn).type).toBe("completed");
        expect(live.cursor).toBe(33);
    });

    it("Stop closes the gate before the abort, and no later steer is sent", async () => {
        const { managed, fake, live } = setup();
        const order = [];
        const realAbort = fake.abort.bind(fake);
        fake.abort = () => { order.push(`abort with gate ${managed.steerGateState()}`); realAbort(); };
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: live });
        await waitFor(() => managed.steerGateState() === "open");
        await live.enqueue([control(40, "stop", "wrong way"), control(41, "steer")]);
        const result = await turn;
        expect(result).toMatchObject({ type: "stopped", reason: "wrong way" });
        expect(order).toEqual(["abort with gate closed"]);
        expect(steersSent(fake)).toEqual([]);
        expect(live.sent).toBe(40);
    });

    it("a steer whose send throws fails the turn", async () => {
        const fake = createFakeCopilotSession({
            sendImpl: (msg, id) => {
                if (msg.mode === "immediate") throw new Error("send failed");
                return id;
            },
        });
        const { managed, live } = setup({ fake });
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: live });
        await waitFor(() => managed.steerGateState() === "open");
        await live.enqueue([control(50, "steer")]);
        await expect(turn).rejects.toThrow(/send failed/);
        expect(live.cursor).toBe(0);
    });

    it("skips duplicate controls and keeps position order", async () => {
        const { managed, fake, live } = setup({ start: 59 });
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: live });
        await waitFor(() => managed.steerGateState() === "open");
        await live.enqueue([control(62, "steer", "b"), control(61, "steer", "a"), control(59, "steer", "already folded")]);
        await live.enqueue([control(61, "steer", "a"), control(62, "steer", "b")]);
        expect(steersSent(fake).map((m) => m.prompt)).toEqual(["a", "b"]);
        expect(live.lookArgs()).toEqual({ sessionId: "turn-control-live", turn: 4, after: 62 });
        for (const m of steersSent(fake)) fake._emit("user.message", { messageId: m.id });
        fake._emit("session.idle");
        await turn;
    });

    it("holds controls that arrive before the initial send: a held Stop skips the send", async () => {
        const { managed, fake, live } = setup();
        await live.enqueue([control(70, "steer", "early"), control(71, "stop", "never mind")]);
        const result = await managed.runTurn("work", { turnIndex: 4, turnControl: live });
        expect(result).toMatchObject({ type: "stopped", reason: "never mind" });
        expect(fake.sent).toEqual([]);
        expect(live.sent).toBe(71);
    });

    it("holds a steer that arrives before the initial send and sends it right after", async () => {
        let releaseFirst;
        const fake = createFakeCopilotSession({
            sendImpl: (msg, id) => (msg.mode === "immediate" ? id : new Promise((resolve) => { releaseFirst = () => resolve(id); })),
        });
        const { managed, live } = setup({ fake });
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: live });
        await waitFor(() => typeof releaseFirst === "function");
        expect(managed.steerGateState()).toBe("pending");
        await live.enqueue([control(80, "steer", "early")]);
        expect(steersSent(fake)).toEqual([]);
        releaseFirst();
        await waitFor(() => steersSent(fake).length === 1);
        await live.idle();
        expect(steersSent(fake)[0].prompt).toBe("early");
        fake._emit("user.message", { messageId: steersSent(fake)[0].id });
        fake._emit("session.idle");
        expect((await turn).type).toBe("completed");
        expect(live.cursor).toBe(80);
    });

    it("settlement stays bounded by the turn timeout", async () => {
        const { managed, fake, live } = setup({ config: { turnTimeoutMs: 300, turnInactivityTimeoutMs: 0 } });
        const turn = managed.runTurn("work", { turnIndex: 4, turnControl: live });
        await waitFor(() => managed.steerGateState() === "open");
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
        await waitFor(() => fake.sent.length === 1);
        expect(managed.steerGateState()).toBe("none");
        fake._emit("session.idle");
        expect((await turn).type).toBe("completed");
    });
});
