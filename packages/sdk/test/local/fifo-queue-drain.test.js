/**
 * Issue 192: queued work never waits behind an armed timer, a backlog runs as
 * one turn, schedules keep their time, and the FIFO never drops work silently.
 *
 * Drives the real drain/decide generators against a fake durable context: a
 * Map for KV, a message list for the durable queue, and a clock that moves
 * only when a timer wins a race. A race whose timer side is long (the armed
 * timer's remaining time) is a wait; the 10 ms sweep is not.
 */
import { describe, expect, it, vi } from "vitest";
import { createRuntime, runLoop } from "../../src/orchestration/runtime.ts";
import { appendToFifo, decide, drain, settleQueuedWorkAfterDecide } from "../../src/orchestration/queue.ts";
import { FIFO_BUCKET_COUNT, MAX_BUCKET_BYTES, NON_BLOCKING_TIMER_MS } from "../../src/orchestration/state.ts";

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: (ctx, sessionId, affinity, config, contract) => ctx.proxy("session", contract),
    createSessionManagerProxy: (ctx, contract) => ctx.proxy("manager", contract),
}));

const HOUR_MS = 3_600_000;

function harness(overrides = {}) {
    const calls = [];
    const turns = [];
    const results = [];
    const messages = [];
    const kv = new Map();
    const errors = [];
    const clock = { now: 1_750_000_000_000 };
    let guid = 0;
    const ctx = {
        traceInfo() {},
        traceWarn() {},
        traceError: message => errors.push(message),
        setCustomStatus() {},
        getValue: key => kv.get(key) ?? null,
        setValue: (key, value) => kv.set(key, value),
        clearValue: key => kv.delete(key),
        utcNow: () => ({ effect: "now" }),
        newGuid: () => ({ effect: "guid" }),
        scheduleTimer: ms => ({ effect: "timer", ms }),
        dequeueEvent: name => ({ effect: "dequeue", name }),
        race: (left, right) => ({ effect: "race", left, right }),
        continueAsNewVersioned: (input, version) => ({ effect: "can", input, version }),
        proxy(prefix) {
            return new Proxy({}, {
                get: (_, name) => (...args) => ({ effect: `${prefix}.${String(name)}`, args }),
            });
        },
    };
    function resolve(effect) {
        if (effect == null) return undefined;
        calls.push(effect);
        switch (effect.effect) {
            case "now": return clock.now;
            case "guid": return `guid-${++guid}`;
            case "timer": clock.now += effect.ms; return undefined;
            case "dequeue":
                if (!messages.length) throw new Error("unexpected blocking dequeue");
                return JSON.stringify(messages.shift());
            case "race":
                if (effect.left?.effect === "session.runTurn") return { index: 0, value: resolve(effect.left) };
                if (effect.left?.effect === "dequeue") {
                    if (messages.length) return { index: 0, value: JSON.stringify(messages.shift()) };
                    clock.now += effect.right.ms;
                    return { index: 1 };
                }
                throw new Error(`unexpected race: ${JSON.stringify(effect)}`);
            case "session.runTurn": {
                turns.push(effect.args);
                if (!results.length) throw new Error("unexpected turn");
                const result = results.shift();
                if (result instanceof Error) throw result;
                return result;
            }
            case "manager.listChildSessions": return "[]";
            case "manager.getWorkerSessionPolicy": return { policy: null, allowedAgentNames: [] };
            case "manager.resolveAgentConfig": return null;
            case "manager.getOrchestrationStats": return { historySizeBytes: 0 };
            default: return undefined;
        }
    }
    function drive(gen) {
        let value;
        let failure;
        for (let step = 0; step < 2000; step++) {
            const next = failure ? gen.throw(failure) : gen.next(value);
            failure = undefined;
            if (next.done) return next.value;
            try { value = resolve(next.value); } catch (error) { failure = error; }
        }
        throw new Error("generator exceeded bound");
    }
    const runtime = drive(createRuntime(ctx, {
        sessionId: "fifo-queue-fixture",
        config: {},
        iteration: 4,
        isSystem: true,
        blobEnabled: false,
        ...overrides,
    }, { currentVersion: "1.0.82", latestVersion: "1.0.82" }));
    const races = () => calls.filter(c => c.effect === "race" && c.left?.effect === "dequeue").map(c => c.right.ms);
    const events = () => calls.flatMap(c => (c.effect === "manager.recordSessionEvent" ? c.args[1] : []));
    const fifo = () => {
        const out = [];
        for (let i = 0; i < FIFO_BUCKET_COUNT; i++) {
            const raw = kv.get(`fifo.${i}`);
            if (raw) out.push(...JSON.parse(raw));
        }
        return out;
    };
    const arm = (type, remainingMs, extra = {}) => {
        runtime.state.activeTimer = {
            deadlineMs: clock.now + remainingMs,
            originalDurationMs: Math.max(remainingMs, 1000),
            reason: `${type} reason`,
            type,
            ...extra,
        };
    };
    // One pass of the run loop: drain, decide, then settle what drain released.
    const step = () => {
        drive(drain(runtime));
        const iterationBefore = runtime.state.iteration;
        const didWork = drive(decide(runtime));
        settleQueuedWorkAfterDecide(runtime, iterationBefore);
        return didWork;
    };
    // The real run loop, until the session parks: on a race whose only exit
    // is a timer of a second or more (an armed timer), on a blocking dequeue,
    // or on a continue-as-new.
    const runUntilParked = () => {
        const gen = runLoop(runtime);
        let value;
        let failure;
        for (let n = 0; n < 4000; n++) {
            const next = failure ? gen.throw(failure) : gen.next(value);
            failure = undefined;
            if (next.done) return { parked: "done", value: next.value };
            const effect = next.value;
            if (effect?.effect === "race" && effect.left?.effect === "dequeue" && !messages.length && effect.right?.ms >= 1000) {
                return { parked: "timer", ms: effect.right.ms };
            }
            if (effect?.effect === "dequeue" && !messages.length) return { parked: "blocking" };
            if (effect?.effect === "can") return { parked: "can", input: effect.input };
            try { value = resolve(effect); } catch (error) { failure = error; }
        }
        throw new Error("run loop did not park");
    };
    const h = { runtime, kv, clock, calls, turns, results, messages, errors, drive, races, events, fifo, arm, step, runUntilParked };
    return h;
}

const prompt = (text, extra = {}) => ({ kind: "prompt", prompt: text, bootstrap: false, ...extra });
const cronItem = () => ({ kind: "timer", timer: { type: "cron", deadlineMs: 1, originalDurationMs: HOUR_MS, reason: "hourly" }, firedAtMs: 1 });
const idleItem = () => ({ kind: "timer", timer: { type: "idle", deadlineMs: 1, originalDurationMs: 1_800_000, reason: "idle timeout" }, firedAtMs: 1 });
const steer = (seq, text = `guidance ${seq}`) => ({ seq, text });

describe("issue 192: queued work does not wait behind an armed timer", () => {
    it("R3, R4: a cron armed for an hour does not hold a queued prompt, and keeps its remaining time", () => {
        const h = harness({ cronSchedule: { intervalSeconds: 3600, reason: "hourly" } });
        h.arm("cron", HOUR_MS);
        appendToFifo(h.runtime, [prompt("queued")]);
        h.drive(drain(h.runtime));
        expect(h.races()).not.toContain(HOUR_MS);
        expect(h.races()).toContain(NON_BLOCKING_TIMER_MS);
        expect(h.runtime.state.activeTimer).toBeNull();
        expect(h.runtime.state.interruptedCronTimer?.remainingMs).toBe(HOUR_MS);
        expect(h.fifo().map(x => x.prompt)).toEqual(["queued"]);
    });

    for (const [type, extra] of [
        ["idle", {}],
        ["cron_at", {}],
        ["wait", {}],
        ["agent-poll", {}],
        ["input-grace", {}],
        ["workspace_retry", { gate: "workspace" }],
        ["wait", { gate: "budget", budget: true }],
    ]) {
        it(`R3: a ${type}${extra.gate ? ` (${extra.gate} gate)` : ""} timer does not hold a queued prompt`, () => {
            const h = harness({
                pendingInputQuestion: type === "input-grace" ? { question: "which?", iteration: 3 } : undefined,
                waitingForAgentIds: type === "agent-poll" ? ["child-1"] : undefined,
            });
            h.arm(type, HOUR_MS, extra);
            appendToFifo(h.runtime, [prompt("queued")]);
            h.drive(drain(h.runtime));
            expect(h.races()).not.toContain(HOUR_MS);
            expect(h.runtime.state.activeTimer).toBeNull();
            if (type === "agent-poll") expect(h.runtime.state.waitingForAgentIds).toBeNull();
            if (type === "input-grace") expect(h.runtime.state.pendingInputQuestion?.question).toBe("which?");
            if (type === "wait" && !extra.gate) expect(h.runtime.state.interruptedWaitTimer?.remainingSec).toBe(3600);
        });
    }

    it("R3: a queued answer does not wait for an armed cron", () => {
        const h = harness({ cronSchedule: { intervalSeconds: 3600, reason: "hourly" } });
        h.arm("cron", HOUR_MS);
        appendToFifo(h.runtime, [{ kind: "answer", answer: "yes", expectedQuestion: null }]);
        h.drive(drain(h.runtime));
        expect(h.races()).not.toContain(HOUR_MS);
    });

    it("R3: a queued timer item runs at once under an armed cron", () => {
        const h = harness({ cronSchedule: { intervalSeconds: 3600, reason: "hourly" } });
        h.arm("cron", HOUR_MS);
        appendToFifo(h.runtime, [cronItem()]);
        h.drive(drain(h.runtime));
        expect(h.races()).not.toContain(HOUR_MS);
    });

    it("R3: a queued timer item still waits behind a workspace gate", () => {
        const h = harness();
        h.arm("workspace_retry", HOUR_MS, { gate: "workspace" });
        appendToFifo(h.runtime, [cronItem()]);
        h.drive(drain(h.runtime));
        expect(h.races()).toContain(HOUR_MS);
    });

    it("R4: a timer that is already due becomes a timer item; it is not lost", () => {
        const h = harness({ cronSchedule: { intervalSeconds: 3600, reason: "hourly" } });
        h.arm("cron", 0);
        appendToFifo(h.runtime, [prompt("queued")]);
        h.drive(drain(h.runtime));
        expect(h.runtime.state.activeTimer).toBeNull();
        expect(h.fifo().map(x => x.kind)).toEqual(["prompt", "timer"]);
    });
});

describe("issue 192: one turn takes the backlog", () => {
    it("R10: three prompts without client message ids that arrived during a turn are all collected", () => {
        const h = harness();
        h.messages.push({ prompt: "P1" }, { prompt: "P2" }, { prompt: "P3" });
        h.drive(drain(h.runtime));
        expect(h.fifo().map(x => x.prompt)).toEqual(["P1", "P2", "P3"]);
    });

    it("R1, R3, R4: with a cron armed, a backlog behind a stuck timer item runs as one turn, then the timer item once", () => {
        const h = harness({ cronSchedule: { intervalSeconds: 3600, reason: "hourly" } });
        h.arm("cron", HOUR_MS);
        appendToFifo(h.runtime, [cronItem(), prompt("P1"), prompt("P2", { clientMessageIds: ["p2"] }), prompt("U", { clientMessageIds: ["u"] })]);
        h.drive(drain(h.runtime));
        h.results.push({ type: "completed", content: "RECEIVED: P1,P2,U" });
        h.drive(decide(h.runtime));
        expect(h.turns).toHaveLength(1);
        expect(h.turns[0][0]).toMatch(/P1[\s\S]*P2[\s\S]*U/);
        expect(h.fifo().map(x => x.kind)).toEqual(["timer"]);
        // After the turn the cron is armed again with the time it had left.
        expect(h.runtime.state.activeTimer?.type).toBe("cron");
        expect(h.runtime.state.activeTimer.deadlineMs - h.clock.now).toBeLessThanOrEqual(HOUR_MS);
        h.drive(drain(h.runtime));
        h.results.push({ type: "completed", content: "cron turn" });
        h.drive(decide(h.runtime));
        expect(h.turns).toHaveLength(2);
        expect(h.turns[1][0]).toMatch(/Scheduled cron wake-up/);
        expect(h.fifo()).toEqual([]);
    });

    it("R5: two queued cron items give one cron turn", () => {
        const h = harness({ cronSchedule: { intervalSeconds: 3600, reason: "hourly" } });
        appendToFifo(h.runtime, [cronItem(), cronItem()]);
        h.results.push({ type: "completed", content: "cron turn" });
        h.drive(decide(h.runtime));
        expect(h.turns).toHaveLength(1);
        expect(h.fifo()).toEqual([]);
    });

    it("R5: a cron fire is not queued while a cron item already waits", () => {
        const h = harness({ cronSchedule: { intervalSeconds: 3600, reason: "hourly" } });
        appendToFifo(h.runtime, [cronItem()]);
        h.arm("cron", 0);
        h.drive(drain(h.runtime));
        expect(h.fifo().filter(x => x.kind === "timer")).toHaveLength(1);
    });
});

describe("issue 192: nothing is dropped silently", () => {
    function fillFifo(h) {
        // Every bucket holds as many equal items as fit, so compaction gains nothing.
        for (let b = 0; b < FIFO_BUCKET_COUNT; b++) {
            const bucket = [];
            for (let i = 0; ; i++) {
                const item = prompt(`b${String(b).padStart(2, "0")}-${String(i).padStart(3, "0")} ${"q".repeat(200)}`);
                if (JSON.stringify([...bucket, item]).length > MAX_BUCKET_BYTES) break;
                bucket.push(item);
            }
            h.kv.set(`fifo.${b}`, JSON.stringify(bucket));
        }
    }

    it("R8: a prompt that does not fit is reported with its id, and its id is not marked as seen", () => {
        const h = harness();
        fillFifo(h);
        h.messages.push({ prompt: `late ${"w".repeat(800)}`, clientMessageIds: ["late-1"] });
        h.drive(drain(h.runtime));
        const overflow = h.events().filter(e => e.eventType === "session.fifo_overflow");
        expect(overflow).toHaveLength(1);
        expect(overflow[0].data.clientMessageIds).toEqual(["late-1"]);
        expect(h.runtime.state.recentClientMessageIds).not.toContain("late-1");
        expect(h.errors.some(m => m.includes("late-1"))).toBe(true);

        // Room frees up; the same message sent again is accepted, not suppressed.
        h.kv.delete("fifo.0");
        h.messages.push({ prompt: `late ${"w".repeat(800)}`, clientMessageIds: ["late-1"] });
        h.drive(drain(h.runtime));
        expect(h.events().filter(e => e.eventType === "session.message_duplicate_suppressed")).toEqual([]);
        expect(h.fifo().filter(x => x.clientMessageIds?.includes("late-1"))).toHaveLength(1);
        expect(h.runtime.state.recentClientMessageIds).toContain("late-1");
    });
});

describe("issue 192 review: a released timer is never stranded", () => {
    it("a queued prompt cancelled before its turn leaves the cron armed as it was", () => {
        const h = harness({ cronSchedule: { intervalSeconds: 3600, reason: "hourly" } });
        h.arm("cron", 600_000);
        const deadline = h.runtime.state.activeTimer.deadlineMs;
        appendToFifo(h.runtime, [prompt("P", { clientMessageIds: ["p"] })]);
        h.messages.push({ cancelPending: ["p"] });
        h.step();
        expect(h.turns).toHaveLength(0);
        expect(h.runtime.state.activeTimer).toMatchObject({ type: "cron", deadlineMs: deadline });
        expect(h.runtime.state.interruptedCronTimer).toBeNull();
        expect(h.fifo()).toEqual([]);
    });

    it("a new prompt cancelled in the same pass leaves the wait armed as it was", () => {
        const h = harness();
        h.arm("wait", 600_000);
        const deadline = h.runtime.state.activeTimer.deadlineMs;
        h.messages.push({ prompt: "P", clientMessageIds: ["p"] }, { cancelPending: ["p"] });
        h.step();
        expect(h.turns).toHaveLength(0);
        expect(h.runtime.state.activeTimer).toMatchObject({ type: "wait", deadlineMs: deadline });
        expect(h.runtime.state.interruptedWaitTimer).toBeNull();
    });

    it("a workspace retry released for a cancelled prompt is armed again", () => {
        const h = harness();
        h.arm("workspace_retry", 600_000, { gate: "workspace" });
        appendToFifo(h.runtime, [prompt("P", { clientMessageIds: ["p"] })]);
        h.messages.push({ cancelPending: ["p"] });
        h.step();
        expect(h.turns).toHaveLength(0);
        expect(h.runtime.state.activeTimer?.type).toBe("workspace_retry");
    });

    it("a queued timer item that runs no turn leaves the wait armed as it was", () => {
        // The cron was cancelled after its fire was queued: the stale fire runs no turn.
        const h = harness();
        h.arm("wait", 600_000);
        const deadline = h.runtime.state.activeTimer.deadlineMs;
        appendToFifo(h.runtime, [cronItem()]);
        h.step();
        expect(h.turns).toHaveLength(0);
        expect(h.runtime.state.activeTimer).toMatchObject({ type: "wait", deadlineMs: deadline });
        expect(h.runtime.state.interruptedWaitTimer).toBeNull();
        expect(h.fifo()).toEqual([]);
    });

    it("a turn removes a stale idle item, so it cannot release the worker or replace the next timer", () => {
        const h = harness();
        appendToFifo(h.runtime, [idleItem(), prompt("P")]);
        h.results.push({ type: "completed", content: "RECEIVED: P" });
        h.step();
        expect(h.turns).toHaveLength(1);
        expect(h.fifo()).toEqual([]);
        expect(h.events().filter(e => e.eventType === "session.affinity_released")).toEqual([]);
    });

    it("an idle timer that is already due is not queued behind a prompt", () => {
        const h = harness();
        h.arm("idle", 0);
        appendToFifo(h.runtime, [prompt("P")]);
        h.drive(drain(h.runtime));
        expect(h.fifo().map(x => x.kind)).toEqual(["prompt"]);
    });

    it("an agent poll that is already due still ends the agent wait, and is not queued", () => {
        const h = harness({ waitingForAgentIds: ["child-1"] });
        h.arm("agent-poll", 0, { agentIds: ["child-1"] });
        appendToFifo(h.runtime, [prompt("P")]);
        h.drive(drain(h.runtime));
        expect(h.runtime.state.waitingForAgentIds).toBeNull();
        expect(h.fifo().map(x => x.kind)).toEqual(["prompt"]);
    });

    it("an agent wait released for a cancelled prompt comes back", () => {
        const h = harness({ waitingForAgentIds: ["child-1"] });
        h.arm("agent-poll", 20_000, { agentIds: ["child-1"] });
        appendToFifo(h.runtime, [prompt("P", { clientMessageIds: ["p"] })]);
        h.messages.push({ cancelPending: ["p"] });
        h.step();
        expect(h.turns).toHaveLength(0);
        expect(h.runtime.state.waitingForAgentIds).toEqual(["child-1"]);
        expect(h.runtime.state.activeTimer?.type).toBe("agent-poll");
    });
});

describe("issue 192 review: carried steers take the same path", () => {
    it("queued work that carries steers keeps the cron's remaining time", () => {
        const h = harness({ cronSchedule: { intervalSeconds: 3600, reason: "hourly" }, carriedSteers: [steer(1)] });
        h.arm("cron", 600_000);
        appendToFifo(h.runtime, [prompt("P")]);
        h.drive(drain(h.runtime));
        expect(h.runtime.state.activeTimer).toBeNull();
        expect(h.runtime.state.interruptedCronTimer?.remainingMs).toBe(600_000);
    });

    it("R10: with carried steers, three id-less prompts that arrived during a turn are all collected", () => {
        const h = harness({ carriedSteers: [steer(1)] });
        h.messages.push({ prompt: "P1" }, { prompt: "P2" }, { prompt: "P3" });
        h.drive(drain(h.runtime));
        expect(h.fifo().map(x => x.prompt)).toEqual(["P1", "P2", "P3"]);
    });

    it("with carried steers and nothing else queued, the wake marker still runs", () => {
        const h = harness({ carriedSteers: [steer(1)] });
        h.drive(drain(h.runtime));
        expect(h.fifo()).toHaveLength(1);
        expect(h.fifo()[0].carriedSteersWake).toBe(true);
    });
});

describe("issue 192 review: backlog size and lost items", () => {
    it("R7: 100 K characters of queued prompts run as one turn, in order, with nothing cut", () => {
        const h = harness();
        const texts = Array.from({ length: 20 }, (_, i) => `M${String(i).padStart(2, "0")} ${"x".repeat(5_100)}`);
        appendToFifo(h.runtime, texts.map(t => prompt(t)));
        h.results.push({ type: "completed", content: "done" });
        h.drive(decide(h.runtime));
        expect(h.turns).toHaveLength(1);
        const sent = h.turns[0][0];
        expect(sent.length).toBeGreaterThanOrEqual(100_000);
        let at = -1;
        for (const t of texts) {
            const found = sent.indexOf(t);
            expect(found).toBeGreaterThan(at);
            at = found;
        }
        expect(h.fifo()).toEqual([]);
    });
});

describe("issue 192 review B: remaining time and timer items behind holds", () => {
    it("carried steers with a queued timer item and waiting messages: the messages are collected and the cron keeps its time", () => {
        const h = harness({ cronSchedule: { intervalSeconds: 3600, reason: "hourly" }, carriedSteers: [steer(1)] });
        h.arm("cron", 600_000);
        appendToFifo(h.runtime, [cronItem()]);
        h.messages.push({ prompt: "U" }, { prompt: "S1" }, { prompt: "S2" });
        h.drive(drain(h.runtime));
        expect(h.fifo().filter(x => x.kind === "prompt").map(x => x.prompt)).toEqual(["U", "S1", "S2"]);
        expect(h.runtime.state.interruptedCronTimer?.remainingMs).toBe(600_000);
        h.results.push({ type: "completed", content: "RECEIVED: U,S1,S2" });
        const iterationBefore = h.runtime.state.iteration;
        h.drive(decide(h.runtime));
        settleQueuedWorkAfterDecide(h.runtime, iterationBefore);
        expect(h.turns).toHaveLength(1);
        expect(h.turns[0][0]).toMatch(/U[\s\S]*S1[\s\S]*S2/);
    });

    it("R4: a cron with 90 s left is armed again with 90 s after the queued prompt's turn, not a full hour", () => {
        const h = harness({ cronSchedule: { intervalSeconds: 3600, reason: "hourly" } });
        h.arm("cron", 90_000);
        appendToFifo(h.runtime, [prompt("P")]);
        h.results.push({ type: "completed", content: "RECEIVED: P" });
        h.step();
        expect(h.turns).toHaveLength(1);
        expect(h.runtime.state.activeTimer?.type).toBe("cron");
        const left = h.runtime.state.activeTimer.deadlineMs - h.clock.now;
        expect(left).toBeGreaterThan(0);
        expect(left).toBeLessThanOrEqual(90_000);
    });

    for (const [type, extra, state] of [
        ["agent-poll", { agentIds: ["child-1"] }, { waitingForAgentIds: ["child-1"] }],
        ["input-grace", {}, { pendingInputQuestion: { question: "which?", iteration: 3 } }],
        ["wait", { gate: "budget", budget: true }, {}],
    ]) {
        it(`R3: a queued timer item still waits behind ${type}${extra.gate ? ` (${extra.gate} gate)` : ""}`, () => {
            const h = harness(state);
            h.arm(type, HOUR_MS, extra);
            appendToFifo(h.runtime, [cronItem()]);
            h.drive(drain(h.runtime));
            expect(h.races()).toContain(HOUR_MS);
        });
    }

    it("R4: a queued prompt ends an agent wait, and after its turn no agent poll is armed again", () => {
        const h = harness({ waitingForAgentIds: ["child-1"] });
        h.arm("agent-poll", 20_000, { agentIds: ["child-1"] });
        appendToFifo(h.runtime, [prompt("P")]);
        h.results.push({ type: "completed", content: "RECEIVED: P" });
        h.step();
        expect(h.turns).toHaveLength(1);
        expect(h.runtime.state.waitingForAgentIds).toBeNull();
        expect(h.runtime.state.activeTimer?.type).not.toBe("agent-poll");
    });
});

describe("issue 192 re-review: the real run loop never strands a released timer", () => {
    const graceItem = () => ({ kind: "timer", timer: { type: "input-grace", deadlineMs: 1, originalDurationMs: 60_000, reason: "input grace" }, firedAtMs: 1 });

    it("a queued prompt cancelled before its turn: the loop parks on the cron, with its time", () => {
        const h = harness({ cronSchedule: { intervalSeconds: 3600, reason: "hourly" } });
        h.arm("cron", 600_000);
        appendToFifo(h.runtime, [prompt("P", { clientMessageIds: ["p"] })]);
        h.messages.push({ cancelPending: ["p"] });
        const r = h.runUntilParked();
        expect(h.turns).toHaveLength(0);
        expect(r.parked).toBe("timer");
        expect(r.ms).toBeGreaterThan(590_000);
        expect(r.ms).toBeLessThanOrEqual(600_000);
    });

    for (const [type, extra] of [["wait", {}], ["cron", { cronSchedule: { intervalSeconds: 3600, reason: "hourly" } }]]) {
        it(`a stale input-grace item under a live ${type}: no idle timer replaces it, and the loop parks on the ${type}`, () => {
            const h = harness(extra);
            h.arm(type, 600_000);
            appendToFifo(h.runtime, [graceItem()]);
            const r = h.runUntilParked();
            expect(h.turns).toHaveLength(0);
            expect(r.parked).toBe("timer");
            expect(r.ms).toBeGreaterThan(590_000);
            expect(r.ms).toBeLessThanOrEqual(600_000);
            expect(h.runtime.state.activeTimer?.type).toBe(type);
            expect(h.fifo()).toEqual([]);
        });
    }

    it("a stale idle item under a live wait does not release the worker", () => {
        const h = harness();
        h.arm("wait", 600_000);
        appendToFifo(h.runtime, [idleItem()]);
        const r = h.runUntilParked();
        expect(r.parked).toBe("timer");
        expect(h.events().filter(e => e.eventType === "session.affinity_released")).toEqual([]);
    });

    it("an agents-done follow-up runs before the cron's deadline, and the cron keeps its time", () => {
        const h = harness({ cronSchedule: { intervalSeconds: 3600, reason: "hourly" } });
        h.arm("cron", 600_000);
        const start = h.clock.now;
        appendToFifo(h.runtime, [{ kind: "agents-done", summary: "all agents finished" }]);
        h.results.push({ type: "completed", content: "noted" });
        const r = h.runUntilParked();
        expect(h.turns).toHaveLength(1);
        expect(h.turns[0][0]).toMatch(/all agents finished/);
        expect(h.clock.now - start).toBeLessThan(1_000);
        expect(r.parked).toBe("timer");
        expect(r.ms).toBeGreaterThan(590_000);
        expect(r.ms).toBeLessThanOrEqual(600_000);
    });

    it("a thrown authentication failure parks for outside input: the released wait is not re-armed", () => {
        const h = harness();
        h.arm("wait", 600_000);
        appendToFifo(h.runtime, [prompt("P")]);
        h.results.push(new Error("401 Unauthorized: bad credentials"));
        const r = h.runUntilParked();
        expect(h.turns).toHaveLength(1);
        expect(r.parked).toBe("blocking");
    });
});
