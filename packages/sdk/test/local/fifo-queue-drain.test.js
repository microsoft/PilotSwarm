/**
 * Issue 192: queued work never waits behind an armed timer, a backlog runs as
 * one turn, schedules keep their time, and the FIFO never drops work silently.
 *
 * Drives the real drain/decide generators against a fake durable context: a
 * Map for KV, a message list for the durable queue, and a clock that moves
 * only when a timer wins a race. A race whose timer side is long (the armed
 * timer's remaining time) is a wait; the 10 ms sweep is not.
 */
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import { createRuntime, runLoop } from "../../src/orchestration/runtime.ts";
import { appendToFifo, decide, drain, settleQueuedWorkAfterDecide, turnsStarted } from "../../src/orchestration/queue.ts";
import * as lifecycle from "../../src/orchestration/lifecycle.ts";
import * as agents from "../../src/orchestration/agents.ts";
import { FIFO_BUCKET_COUNT, MAX_BUCKET_BYTES, MAX_FIFO_ITEM_BYTES, NON_BLOCKING_TIMER_MS } from "../../src/orchestration/state.ts";

// The real runtime fails the whole orchestration on a KV value above this many
// UTF-8 bytes; the fake context below enforces the same limit.
const { MAX_KV_VALUE_BYTES } = createRequire(import.meta.url)("duroxide");

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
    const child = { status: "running" };
    // What a listing of the children returns (manager.listChildSessions).
    const childList = [];
    // Set to make the listing of children fail, as an activity error would.
    const listing = { fails: false };
    let guid = 0;
    const ctx = {
        traceInfo() {},
        traceWarn() {},
        traceError: message => errors.push(message),
        setCustomStatus() {},
        getValue: key => kv.get(key) ?? null,
        setValue: (key, value) => {
            if (Buffer.byteLength(value, "utf8") > MAX_KV_VALUE_BYTES) {
                throw new Error(`KV value exceeds size limit (${Buffer.byteLength(value, "utf8")} > ${MAX_KV_VALUE_BYTES} bytes)`);
            }
            kv.set(key, value);
        },
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
            case "manager.listChildSessions":
                if (listing.fails) throw new Error("listing failed");
                return JSON.stringify(childList);
            case "manager.getSessionStatus": return JSON.stringify({ status: child.status });
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
        const before = turnsStarted(runtime);
        const didWork = drive(decide(runtime));
        settleQueuedWorkAfterDecide(runtime, before);
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
    const h = { runtime, kv, clock, calls, turns, results, messages, errors, drive, races, events, fifo, arm, step, runUntilParked, child, childList, listing };
    return h;
}

const prompt = (text, extra = {}) => ({ kind: "prompt", prompt: text, bootstrap: false, ...extra });
// Fill all FIFO buckets with tightly packed small prompts; the first may carry
// a client message id, so dispatching it runs the pre-dispatch sweep.
const fillFifo = (h, { headId } = {}) => {
    for (let b = 0; b < FIFO_BUCKET_COUNT; b++) {
        const bucket = [];
        for (let i = 0; ; i++) {
            const extra = headId && b === 0 && i === 0 ? { clientMessageIds: [headId] } : {};
            const item = prompt(`b${String(b).padStart(2, "0")}-${String(i).padStart(3, "0")} ${"q".repeat(200)}`, extra);
            if (JSON.stringify([...bucket, item]).length > MAX_BUCKET_BYTES) break;
            bucket.push(item);
        }
        h.kv.set(`fifo.${b}`, JSON.stringify(bucket));
    }
};
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
        expect(overflow[0].data.reasons).toEqual(["full"]);
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
        const turnsBefore = turnsStarted(h.runtime);
        h.drive(decide(h.runtime));
        expect(turnsStarted(h.runtime)).toBe(turnsBefore + 1);
        settleQueuedWorkAfterDecide(h.runtime, turnsBefore);
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

describe("issue 192 round 3: a live agent wait keeps its poll", () => {
    const pollItem = () => ({ kind: "timer", timer: { type: "agent-poll", deadlineMs: 1, originalDurationMs: 30_000, reason: "waiting for 1 agent(s)", agentIds: ["agent-1"] }, firedAtMs: 1 });
    const inherited = () => harness({
        subAgents: [{ orchId: "agent-1", sessionId: "child-session-1", task: "watch", status: "running" }],
        waitingForAgentIds: ["agent-1"],
        prompt: "confirmation held by the agent wait",
    });

    it("a queued poll under a released idle timer still polls a running child and arms the next poll", () => {
        const h = inherited();
        h.arm("idle", 600_000);
        appendToFifo(h.runtime, [pollItem()]);
        const r = h.runUntilParked();
        expect(h.turns).toHaveLength(0);
        expect(h.calls.some(c => c.effect === "manager.getSessionStatus")).toBe(true);
        expect(r.parked).toBe("timer");
        expect(r.ms).toBe(30_000);
        expect(h.runtime.state.activeTimer?.type).toBe("agent-poll");
        expect(h.runtime.state.waitingForAgentIds).toEqual(["agent-1"]);
    });

    it("a queued poll under a released idle timer resolves the wait for a finished child whose notice was missed, and the follow-up runs", () => {
        const h = inherited();
        h.child.status = "completed";
        h.arm("idle", 600_000);
        appendToFifo(h.runtime, [pollItem()]);
        h.results.push({ type: "completed", content: "done" });
        h.runUntilParked();
        expect(h.runtime.state.waitingForAgentIds).toBeNull();
        expect(h.turns).toHaveLength(1);
        expect(h.turns[0][0]).toMatch(/confirmation held by the agent wait/);
    });
});

describe("issue 192 defect E: one item larger than a KV value never fails the session", () => {
    const big = (mark, chars, fill = "x") => `@@mark ${mark}\n${fill.repeat(chars)}`;

    it("the queue's item cap is below the runtime's KV value limit", () => {
        expect(MAX_KV_VALUE_BYTES).toBeGreaterThan(0);
        expect(MAX_FIFO_ITEM_BYTES).toBeGreaterThan(MAX_BUCKET_BYTES);
        expect(MAX_FIFO_ITEM_BYTES).toBeLessThan(MAX_KV_VALUE_BYTES);
    });

    it("a 70 KB prompt is reported, not stored; the prompt after it is queued and its id is seen", () => {
        const h = harness();
        h.messages.push({ prompt: big("BIG", 70_000), clientMessageIds: ["big-1"] }, { prompt: "after", clientMessageIds: ["after-1"] });
        h.drive(drain(h.runtime));
        expect(h.fifo().map(x => x.prompt)).toEqual(["after"]);
        const overflow = h.events().filter(e => e.eventType === "session.fifo_overflow");
        expect(overflow).toHaveLength(1);
        expect(overflow[0].data.clientMessageIds).toEqual(["big-1"]);
        expect(overflow[0].data.reasons).toEqual(["too-large"]);
        expect(h.errors.some(m => m.includes("big-1"))).toBe(true);
        expect(h.runtime.state.recentClientMessageIds).not.toContain("big-1");
        expect(h.runtime.state.recentClientMessageIds).toContain("after-1");
    });

    it("the size is measured in UTF-8 bytes: 30,000 three-byte characters are too large", () => {
        const h = harness();
        h.messages.push({ prompt: big("EURO", 30_000, "\u20ac"), clientMessageIds: ["euro-1"] });
        h.drive(drain(h.runtime));
        expect(h.fifo()).toEqual([]);
        const overflow = h.events().filter(e => e.eventType === "session.fifo_overflow");
        expect(overflow[0]?.data.reasons).toEqual(["too-large"]);
    });

    it("an item just under the cap is stored and delivered whole", () => {
        const h = harness();
        const text = big("NEAR", MAX_FIFO_ITEM_BYTES - 500);
        h.messages.push({ prompt: text, clientMessageIds: ["near-1"] });
        h.drive(drain(h.runtime));
        expect(h.fifo().map(x => x.prompt)).toEqual([text]);
        expect(h.events().filter(e => e.eventType === "session.fifo_overflow")).toEqual([]);
        h.results.push({ type: "completed", content: "RECEIVED: NEAR" });
        h.drive(decide(h.runtime));
        expect(h.turns).toHaveLength(1);
        expect(h.turns[0][0]).toContain(text);
    });

    it("the real loop keeps the session running: the too-large prompt is reported and the next one runs", () => {
        const h = harness();
        h.messages.push({ prompt: big("BIG", 70_000), clientMessageIds: ["big-1"] }, { prompt: "after", clientMessageIds: ["after-1"] });
        h.results.push({ type: "completed", content: "RECEIVED: after" });
        const r = h.runUntilParked();
        expect(h.turns).toHaveLength(1);
        expect(h.turns[0][0]).toMatch(/after/);
        expect(h.turns[0][0]).not.toMatch(/BIG/);
        expect(r.parked).toBe("blocking");
    });

    it("a too-large answer is reported; drain keeps waiting on the hold timer with no time lost", () => {
        const h = harness({ pendingInputQuestion: { question: "which?", iteration: 3 } });
        h.arm("input-grace", 60_000);
        const deadline = h.runtime.state.activeTimer.deadlineMs;
        h.messages.push({ answer: big("ANS", 70_000), expectedQuestion: { question: "which?", iteration: 3 } });
        h.drive(drain(h.runtime));
        // Refused on arrival: the hold timer was never released. Drain waits
        // on it again for its whole remaining time, and the timer fires at
        // its own deadline (this fixture lets the time pass).
        expect(h.races()).toEqual([60_000, 60_000]);
        expect(h.fifo().map(x => [x.kind, x.timer?.type, x.timer?.deadlineMs])).toEqual([["timer", "input-grace", deadline]]);
        expect(h.events().filter(e => e.eventType === "session.fifo_overflow")[0]?.data.reasons).toEqual(["too-large"]);
        expect(h.runtime.state.pendingInputQuestion?.question).toBe("which?");
    });

    it("after a too-large answer, a fitting answer still answers the open question", () => {
        const h = harness({ pendingInputQuestion: { question: "which?", iteration: 3 } });
        h.arm("input-grace", 60_000);
        h.messages.push(
            { answer: big("ANS", 70_000), expectedQuestion: { question: "which?", iteration: 3 } },
            { answer: "this one", expectedQuestion: { question: "which?", iteration: 3 } },
        );
        h.results.push({ type: "completed", content: "answered" });
        h.step();
        expect(h.turns).toHaveLength(1);
        expect(h.turns[0][0]).toContain(`The user responded: "this one"`);
        expect(h.turns[0][0]).not.toContain("@@mark ANS");
        expect(h.events().filter(e => e.eventType === "session.fifo_overflow")).toHaveLength(1);
    });

    it("a too-large prompt that arrives during a wait leaves the wait armed: it fires at its own deadline", () => {
        const h = harness();
        h.arm("wait", 600_000);
        const deadline = h.runtime.state.activeTimer.deadlineMs;
        h.messages.push({ prompt: big("BIG", 70_000), clientMessageIds: ["big-1"] });
        h.drive(drain(h.runtime));
        // Refused on arrival: the wait was never interrupted. Drain waits on
        // it again for its whole remaining time; the fired wait runs at once,
        // with no extra sweep.
        expect(h.races()).toEqual([600_000, 600_000]);
        expect(h.runtime.state.interruptedWaitTimer).toBeNull();
        expect(h.fifo().map(x => [x.kind, x.timer?.type, x.timer?.deadlineMs])).toEqual([["timer", "wait", deadline]]);
        h.results.push({ type: "completed", content: "continued" });
        h.drive(decide(h.runtime));
        expect(h.turns).toHaveLength(1);
        expect(h.turns[0][0]).toMatch(/wait is now complete/);
        expect(h.turns[0][0]).not.toContain("@@mark BIG");
    });

    it("a refused prompt does not end the pass: the messages behind it are collected in the same pass", () => {
        const h = harness();
        h.messages.push(
            { prompt: big("BIG", 70_000), clientMessageIds: ["big-1"] },
            { prompt: "second", clientMessageIds: ["s-1"] },
            { prompt: "third", clientMessageIds: ["t-1"] },
        );
        h.drive(drain(h.runtime));
        expect(h.fifo().map(x => x.prompt)).toEqual(["second", "third"]);
        // One blocking dequeue, then the 10 ms sweep collects the rest.
        expect(h.calls.filter(c => c.effect === "dequeue")).toHaveLength(1);
    });
});

describe("issue 192 defect E review: refusing an item never loses other owed work", () => {
    const big = (mark, chars, fill = "x") => `@@mark ${mark}\n${fill.repeat(chars)}`;
    const digest = (n = 1, text = "child finished") => ({
        startedAtMs: 1_750_000_000_000 - 1_000,
        updates: Array.from({ length: n }, (_, i) => ({
            sessionId: `child-${i}`, updateType: "completed", content: `${text} ${i}`, observedAtMs: 1_750_000_000_000 - 1_000,
        })),
    });

    it("a refused prompt does not take the buffered child digest", () => {
        const h = harness({ pendingChildDigest: digest(2) });
        h.messages.push({ prompt: big("BIG", 70_000), clientMessageIds: ["big-1"] });
        h.drive(drain(h.runtime));
        expect(h.fifo()).toEqual([]);
        expect(h.runtime.state.pendingChildDigest?.updates).toHaveLength(2);
    });

    it("a prompt that fits only without the digest is queued without it, and the digest stays buffered", () => {
        const h = harness({ pendingChildDigest: digest(3, "x".repeat(200)) });
        // Fits alone, but not with the digest's text appended.
        const text = big("EDGE", MAX_FIFO_ITEM_BYTES - 300);
        h.messages.push({ prompt: text, clientMessageIds: ["edge-1"] });
        h.drive(drain(h.runtime));
        expect(h.fifo().map(x => x.prompt)).toEqual([text]);
        expect(h.runtime.state.pendingChildDigest?.updates).toHaveLength(3);
        expect(h.events().filter(e => e.eventType === "session.fifo_overflow")).toEqual([]);
    });

    it("a prompt that fits only without the timer note is queued without it; the wait keeps its time", () => {
        const h = harness();
        h.arm("wait", 600_000, { reason: "r".repeat(1_000) });
        const text = big("EDGE", MAX_FIFO_ITEM_BYTES - 300);
        h.messages.push({ prompt: text, clientMessageIds: ["edge-1"] });
        h.drive(drain(h.runtime));
        expect(h.fifo().map(x => x.prompt)).toEqual([text]);
        expect(h.runtime.state.interruptedWaitTimer?.remainingSec).toBe(600);
    });

    it("a resend that fits, in the same pass as a refused original, is queued (not taken for a duplicate)", () => {
        const h = harness();
        h.messages.push({ prompt: big("BIG", 70_000), clientMessageIds: ["p"] }, { prompt: "smaller resend", clientMessageIds: ["p"] });
        h.drive(drain(h.runtime));
        expect(h.fifo().map(x => x.prompt)).toEqual(["smaller resend"]);
        expect(h.events().filter(e => e.eventType === "session.message_duplicate_suppressed")).toEqual([]);
    });

    it("after a full-FIFO refusal at a command boundary, a resend in the same pass is not taken for a duplicate", () => {
        const h = harness();
        for (let b = 0; b < FIFO_BUCKET_COUNT; b++) {
            const bucket = [];
            for (let i = 0; ; i++) {
                const item = prompt(`b${String(b).padStart(2, "0")}-${String(i).padStart(3, "0")} ${"q".repeat(200)}`);
                if (JSON.stringify([...bucket, item]).length > MAX_BUCKET_BYTES) break;
                bucket.push(item);
            }
            h.kv.set(`fifo.${b}`, JSON.stringify(bucket));
        }
        h.messages.push(
            { prompt: `late ${"w".repeat(800)}`, clientMessageIds: ["p"] },
            { type: "cmd", cmd: "get_info", id: "info-1" },
            { prompt: `late ${"w".repeat(800)}`, clientMessageIds: ["p"] },
        );
        h.drive(drain(h.runtime));
        expect(h.events().filter(e => e.eventType === "session.message_duplicate_suppressed")).toEqual([]);
        expect(h.events().filter(e => e.eventType === "session.fifo_overflow").map(e => e.data.clientMessageIds)).toEqual([["p"], ["p"]]);
    });

    it("a fired wait whose timer carries a 62 KB response still runs its continuation", () => {
        const h = harness();
        h.arm("wait", 0, { content: "c".repeat(62_000), reason: "a long answer then a wait" });
        h.drive(drain(h.runtime));
        const items = h.fifo();
        expect(items.map(x => x.kind)).toEqual(["timer"]);
        expect(items[0].timer.content).toBeUndefined();
        expect(h.events().filter(e => e.eventType === "session.fifo_overflow")).toEqual([]);
        h.results.push({ type: "completed", content: "continued" });
        h.drive(decide(h.runtime));
        expect(h.events().filter(e => e.eventType === "session.wait_completed")).toHaveLength(1);
        expect(h.turns).toHaveLength(1);
        expect(h.turns[0][0]).toMatch(/wait is now complete/);
    });

    it("a fired input-grace timer with a large question still moves the session to its hold window", () => {
        const question = "q".repeat(62_000);
        const h = harness({ pendingInputQuestion: { question, iteration: 3 } });
        h.arm("input-grace", 0, { question, choices: ["a", "b"] });
        h.drive(drain(h.runtime));
        expect(h.fifo().map(x => x.kind)).toEqual(["timer"]);
        h.drive(decide(h.runtime));
        expect(h.runtime.state.activeTimer?.type).toBe("idle");
        expect(h.runtime.state.pendingInputQuestion?.question).toBe(question);
    });

    it("a full-FIFO refusal gives back the child digest the prompt carried; it is delivered exactly once", () => {
        const h = harness({ pendingChildDigest: { ...digest(1, "DIGESTMARK"), ready: true } });
        fillFifo(h);
        h.messages.push({ prompt: `late ${"w".repeat(800)}`, clientMessageIds: ["late-1"] });
        h.drive(drain(h.runtime));
        const overflow = h.events().filter(e => e.eventType === "session.fifo_overflow");
        expect(overflow.map(e => [e.data.clientMessageIds, e.data.reasons])).toEqual([[["late-1"], ["full"]]]);
        expect(h.runtime.state.pendingChildDigest?.updates.map(u => u.sessionId)).toEqual(["child-0"]);
        // Once the queued prompts have run, the digest runs, once.
        for (let i = 0; i < 6; i++) h.results.push({ type: "completed", content: "ok" });
        h.runUntilParked();
        expect(h.turns.filter(t => String(t[0]).includes("DIGESTMARK 0"))).toHaveLength(1);
    });

    it("a full-FIFO refusal at a command boundary gives back the child digest too", () => {
        const h = harness({ pendingChildDigest: digest(1, "DIGESTMARK") });
        fillFifo(h);
        h.messages.push(
            { prompt: `late ${"w".repeat(800)}`, clientMessageIds: ["late-1"] },
            { type: "cmd", cmd: "get_info", id: "info-1" },
        );
        h.drive(drain(h.runtime));
        expect(h.events().filter(e => e.eventType === "session.fifo_overflow").map(e => e.data.reasons)).toEqual([["full"]]);
        expect(h.runtime.state.pendingChildDigest?.updates.map(u => u.sessionId)).toEqual(["child-0"]);
    });

    it("a stashed prompt cancelled in the same pass gives back the child digest it carried", () => {
        const h = harness({ pendingChildDigest: digest(1, "DIGESTMARK") });
        h.messages.push({ prompt: "soon cancelled", clientMessageIds: ["c-1"] }, { cancelPending: ["c-1"] });
        h.drive(drain(h.runtime));
        expect(h.fifo()).toEqual([]);
        expect(h.runtime.state.pendingChildDigest?.updates.map(u => u.sessionId)).toEqual(["child-0"]);
    });

    it("a given-back digest keeps newer updates; a child's completion is not replaced by its later note", () => {
        const h = harness();
        h.runtime.state.pendingChildDigest = {
            startedAtMs: 2_000,
            updates: [
                { sessionId: "a", updateType: "progress", content: "a later note", observedAtMs: 2_000 },
                { sessionId: "b", updateType: "completed", content: "b done", observedAtMs: 2_100 },
            ],
        };
        lifecycle.restorePendingChildDigest(h.runtime, {
            startedAtMs: 1_000,
            updates: [
                { sessionId: "a", updateType: "completed", content: "a done", observedAtMs: 1_000 },
                { sessionId: "c", updateType: "progress", content: "c note", observedAtMs: 1_100 },
            ],
        });
        const restored = h.runtime.state.pendingChildDigest;
        expect(restored.startedAtMs).toBe(1_000);
        expect(restored.updates.map(u => [u.sessionId, u.updateType])).toEqual([["a", "completed"], ["c", "progress"], ["b", "completed"]]);
    });

    // A coordinator with one tracked child and an older pending update from it.
    const withChild = (oldEntry = {}) => harness({
        subAgents: [{ orchId: "agent-a", sessionId: "child-a", task: "watch", status: "running" }],
        pendingChildDigest: {
            startedAtMs: 1_750_000_000_000 - 1_000,
            ready: true,
            updates: [{ sessionId: "child-a", updateType: "completed", content: "OLDRESULT", observedAtMs: 1_750_000_000_000 - 1_000, ...oldEntry }],
        },
    });
    const childUpdate = (type, text) => ({ prompt: `[CHILD_UPDATE from=child-a type=${type}]\n${text}` });
    const late = (id) => ({ prompt: `${id} ${"w".repeat(800)}`, clientMessageIds: [id] });
    const pendingFor = (h) => h.runtime.state.pendingChildDigest?.updates.map(u => [u.sessionId, u.updateType, u.content]);

    it("two refused carriers of one child's updates give back the newer update, even with equal timestamps", () => {
        // Same millisecond as the update that arrives in the pass: only the
        // arrival order can tell them apart.
        const h = withChild({ observedAtMs: 1_750_000_000_000 });
        fillFifo(h);
        h.messages.push(late("p1"), childUpdate("completed", "NEWRESULT"), late("p2"));
        h.drive(drain(h.runtime));
        expect(h.events().filter(e => e.eventType === "session.fifo_overflow").map(e => e.data.reasons)).toEqual([["full", "full"]]);
        expect(pendingFor(h)).toEqual([["child-a", "completed", "NEWRESULT"]]);
        for (let i = 0; i < 6; i++) h.results.push({ type: "completed", content: "ok" });
        h.runUntilParked();
        expect(h.turns.filter(t => String(t[0]).includes("NEWRESULT"))).toHaveLength(1);
        expect(h.turns.filter(t => String(t[0]).includes("OLDRESULT"))).toHaveLength(0);
    });

    it("carriers cancelled one by one, older first, give back the newer update", () => {
        const h = withChild();
        h.messages.push(
            { prompt: "p1", clientMessageIds: ["p1"] },
            childUpdate("completed", "NEWRESULT"),
            { prompt: "p2", clientMessageIds: ["p2"] },
            { cancelPending: ["p1"] },
            { cancelPending: ["p2"] },
        );
        h.drive(drain(h.runtime));
        expect(h.fifo()).toEqual([]);
        expect(pendingFor(h)).toEqual([["child-a", "completed", "NEWRESULT"]]);
    });

    it("an update buffered after both carriers stays the newest when they are given back", () => {
        const h = withChild();
        fillFifo(h);
        h.messages.push(late("p1"), childUpdate("completed", "MIDRESULT"), late("p2"), childUpdate("completed", "NEWESTRESULT"));
        h.drive(drain(h.runtime));
        expect(pendingFor(h)).toEqual([["child-a", "completed", "NEWESTRESULT"]]);
    });

    it("a restored digest taken again keeps its age: the newer update still held elsewhere wins when both are refused", () => {
        const h = withChild({ observedAtMs: 1_750_000_000_000 });
        fillFifo(h);
        h.messages.push(late("p1"), childUpdate("completed", "NEWRESULT"), late("p2"), { cancelPending: ["p1"] }, late("p3"));
        h.drive(drain(h.runtime));
        expect(pendingFor(h)).toEqual([["child-a", "completed", "NEWRESULT"]]);
        for (let i = 0; i < 6; i++) h.results.push({ type: "completed", content: "ok" });
        h.runUntilParked();
        expect(h.turns.filter(t => String(t[0]).includes("NEWRESULT"))).toHaveLength(1);
        expect(h.turns.filter(t => String(t[0]).includes("OLDRESULT"))).toHaveLength(0);
    });

    it("a restored digest taken again keeps its age when the carriers are cancelled one by one", () => {
        const h = withChild();
        h.messages.push(
            { prompt: "p1", clientMessageIds: ["p1"] },
            childUpdate("completed", "NEWRESULT"),
            { prompt: "p2", clientMessageIds: ["p2"] },
            { cancelPending: ["p1"] },
            { prompt: "p3", clientMessageIds: ["p3"] },
            { cancelPending: ["p2"] },
            { cancelPending: ["p3"] },
        );
        h.drive(drain(h.runtime));
        expect(h.fifo()).toEqual([]);
        expect(pendingFor(h)).toEqual([["child-a", "completed", "NEWRESULT"]]);
    });

    it("taking a restored digest again and again never makes its update newer", () => {
        const h = withChild();
        h.messages.push(
            { prompt: "p1", clientMessageIds: ["p1"] },
            childUpdate("completed", "NEWRESULT"),
            { prompt: "p2", clientMessageIds: ["p2"] },
            { cancelPending: ["p1"] },
            { prompt: "p3", clientMessageIds: ["p3"] },
            { cancelPending: ["p3"] },
            { prompt: "p4", clientMessageIds: ["p4"] },
            { cancelPending: ["p4"] },
            { prompt: "p5", clientMessageIds: ["p5"] },
            { cancelPending: ["p2"] },
            { cancelPending: ["p5"] },
        );
        h.drive(drain(h.runtime));
        expect(pendingFor(h)).toEqual([["child-a", "completed", "NEWRESULT"]]);
    });

    it("across retakes, a completion is still not replaced by the child's later progress note", () => {
        const h = withChild();
        h.messages.push(
            { prompt: "p1", clientMessageIds: ["p1"] },
            childUpdate("progress", "NOTE"),
            { prompt: "p2", clientMessageIds: ["p2"] },
            { cancelPending: ["p1"] },
            { prompt: "p3", clientMessageIds: ["p3"] },
            { cancelPending: ["p2"] },
            { cancelPending: ["p3"] },
        );
        h.drive(drain(h.runtime));
        expect(pendingFor(h)).toEqual([["child-a", "completed", "OLDRESULT"]]);
    });

    it("carriers cancelled newer first give back the newer update", () => {
        const h = withChild();
        h.messages.push(
            { prompt: "p1", clientMessageIds: ["p1"] },
            childUpdate("completed", "NEWRESULT"),
            { prompt: "p2", clientMessageIds: ["p2"] },
            { cancelPending: ["p2"] },
            { cancelPending: ["p1"] },
        );
        h.drive(drain(h.runtime));
        expect(pendingFor(h)).toEqual([["child-a", "completed", "NEWRESULT"]]);
    });

    it("a prompt that took the rehydration note and is refused because the FIFO is full gives the note back", () => {
        const h = harness({ rehydrationMessage: "REHYDRATED-NOTE" });
        // Queued work that does not release a budget-gated wait: timer items.
        for (let b = 0; b < FIFO_BUCKET_COUNT; b++) {
            const bucket = [];
            for (let i = 0; ; i++) {
                const item = { kind: "timer", timer: { type: "cron", deadlineMs: 1, originalDurationMs: HOUR_MS, reason: `fill ${b}-${i} ${"r".repeat(150)}` }, firedAtMs: 1 };
                if (JSON.stringify([...bucket, item]).length > MAX_BUCKET_BYTES) break;
                bucket.push(item);
            }
            h.kv.set(`fifo.${b}`, JSON.stringify(bucket));
        }
        h.arm("wait", 600_000, { shouldRehydrate: true, budget: true });
        h.messages.push(late("p1"));
        h.drive(drain(h.runtime));
        expect(h.events().filter(e => e.eventType === "session.fifo_overflow").map(e => [e.data.clientMessageIds, e.data.reasons]))
            .toEqual([[["p1"], ["full"]]]);
        expect(h.runtime.state.pendingRehydrationMessage).toBe("REHYDRATED-NOTE");
    });

    it("a prompt that took the rehydration note and is cancelled in the same pass gives the note back", () => {
        const h = harness({ rehydrationMessage: "REHYDRATED-NOTE" });
        h.arm("wait", 600_000, { shouldRehydrate: true });
        h.messages.push({ prompt: "p1", clientMessageIds: ["p1"] }, { cancelPending: ["p1"] });
        h.drive(drain(h.runtime));
        expect(h.fifo()).toEqual([]);
        expect(h.runtime.state.pendingRehydrationMessage).toBe("REHYDRATED-NOTE");
    });

    it("the pre-dispatch sweep refuses a too-large answer on arrival", () => {
        const h = harness();
        appendToFifo(h.runtime, [prompt("first", { clientMessageIds: ["f-1"] })]);
        h.messages.push({ answer: big("ANS", 70_000) });
        h.results.push({ type: "completed", content: "ok" });
        h.drive(decide(h.runtime));
        expect(h.events().filter(e => e.eventType === "session.fifo_overflow").map(e => [e.data.kinds, e.data.reasons]))
            .toEqual([[["answer"], ["too-large"]]]);
        expect(h.fifo().some(x => x.kind === "answer")).toBe(false);
        expect(h.turns.map(t => String(t[0])).join("\n")).not.toContain("@@mark ANS");
    });

    it("a given-back completion is not replaced by the child's later progress note", () => {
        const h = withChild();
        fillFifo(h);
        h.messages.push(late("p1"), childUpdate("progress", "NOTE"), late("p2"));
        h.drive(drain(h.runtime));
        expect(pendingFor(h)).toEqual([["child-a", "completed", "OLDRESULT"]]);
    });

    it("a digest kept back from a prompt it would make too large is delivered exactly once, in a later turn", () => {
        const h = harness({ pendingChildDigest: { ...digest(3, `DIGESTMARK ${"x".repeat(200)}`), ready: true } });
        const text = big("EDGE", MAX_FIFO_ITEM_BYTES - 300);
        h.messages.push({ prompt: text, clientMessageIds: ["edge-1"] });
        for (let i = 0; i < 4; i++) h.results.push({ type: "completed", content: "ok" });
        h.runUntilParked();
        const withDigest = h.turns.filter(t => String(t[0]).includes("DIGESTMARK"));
        expect(withDigest).toHaveLength(1);
        expect(String(withDigest[0][0])).not.toContain("@@mark EDGE");
        expect(h.turns.filter(t => String(t[0]).includes("@@mark EDGE"))).toHaveLength(1);
    });

    it("a timer that fits only compacted, refused because the FIFO is full, is reported as full", () => {
        const h = harness();
        fillFifo(h);
        const infos = [];
        h.runtime.ctx.traceInfo = (message) => infos.push(message);
        // A due wait under queued work becomes a timer item (R4); it carries
        // the turn's 62 KB text. Its compact copy keeps 2,000 characters of
        // the reason, more than the room left in a full FIFO.
        const longReason = "r".repeat(2_000);
        h.arm("wait", 0, { content: "c".repeat(62_000), reason: longReason });
        h.drive(drain(h.runtime));
        const overflow = h.events().filter(e => e.eventType === "session.fifo_overflow");
        expect(overflow.map(e => [e.data.kinds, e.data.reasons])).toEqual([[["timer"], ["full"]]]);
        expect(infos.some(m => m.includes("queued its compact form"))).toBe(false);

        const timer = { kind: "timer", timer: { type: "wait", deadlineMs: 1, originalDurationMs: 60_000, reason: longReason, content: "c".repeat(62_000) }, firedAtMs: 1 };
        const reasons = [];
        expect(appendToFifo(h.runtime, [timer], reasons)).toEqual([timer]);
        expect(reasons).toEqual(["full"]);
    });

    it("the pre-dispatch sweep refuses a too-large prompt on arrival and queues a same-id resend", () => {
        const h = harness();
        appendToFifo(h.runtime, [prompt("first", { clientMessageIds: ["f-1"] })]);
        h.messages.push({ prompt: big("BIG", 70_000), clientMessageIds: ["p"] }, { prompt: "smaller resend", clientMessageIds: ["p"] });
        h.results.push({ type: "completed", content: "ok" });
        h.drive(decide(h.runtime));
        const overflow = h.events().filter(e => e.eventType === "session.fifo_overflow");
        expect(overflow.map(e => [e.data.clientMessageIds, e.data.reasons])).toEqual([[["p"], ["too-large"]]]);
        expect(h.events().filter(e => e.eventType === "session.message_duplicate_suppressed")).toEqual([]);
        const ran = h.turns.map(t => String(t[0])).join("\n");
        expect(ran.includes("smaller resend") || h.fifo().some(x => x.prompt === "smaller resend")).toBe(true);
        expect(ran).not.toContain("@@mark BIG");
    });

    it("the pre-dispatch sweep forgets a full-FIFO refusal at a command boundary, so a resend is not suppressed", () => {
        const h = harness();
        fillFifo(h, { headId: "head-1" });
        h.messages.push(
            { prompt: `late ${"w".repeat(800)}`, clientMessageIds: ["p"] },
            { type: "cmd", cmd: "get_info", id: "info-1" },
            { prompt: `late ${"w".repeat(800)}`, clientMessageIds: ["p"] },
        );
        h.results.push({ type: "completed", content: "ok" });
        h.drive(decide(h.runtime));
        expect(h.events().filter(e => e.eventType === "session.message_duplicate_suppressed")).toEqual([]);
        expect(h.events().filter(e => e.eventType === "session.fifo_overflow").map(e => [e.data.clientMessageIds, e.data.reasons]))
            .toEqual([[["p"], ["full"]], [["p"], ["full"]]]);
    });

    it("the item cap is exact, in UTF-8 bytes of the stored bucket", () => {
        const h = harness();
        const shape = (text) => ({ kind: "prompt", prompt: text, bootstrap: false, clientMessageIds: ["x"] });
        const overhead = Buffer.byteLength(JSON.stringify([shape("")]), "utf8");
        const exact = shape("y".repeat(MAX_FIFO_ITEM_BYTES - overhead));
        const over = shape("y".repeat(MAX_FIFO_ITEM_BYTES - overhead + 1));
        expect(Buffer.byteLength(JSON.stringify([exact]), "utf8")).toBe(MAX_FIFO_ITEM_BYTES);
        expect(appendToFifo(h.runtime, [exact])).toEqual([]);
        expect(appendToFifo(h.runtime, [over])).toEqual([over]);
        expect(h.fifo()).toHaveLength(1);
    });
});

describe("issue 192 stress finding: a child status lookup never delays collected user work", () => {
    const kids = (n, status = "running") => Array.from({ length: n }, (_, i) => ({
        orchId: `agent-${i}`, sessionId: `child-${i}`, task: "work", status,
    }));
    const update = (sessionId, type, text = "") => ({ prompt: `[CHILD_UPDATE from=${sessionId} type=${type} iter=1]\n${text}` });
    const lookups = (calls) => calls.filter(c => c.effect === "manager.getSessionStatus").length;
    const beforeFirstTurn = (h) => {
        const first = h.calls.findIndex(c => c.effect === "session.runTurn");
        return h.calls.slice(0, first < 0 ? h.calls.length : first);
    };

    it("child updates behind a collected prompt add no status lookup before its turn; the turn's listing settles them", () => {
        const h = harness({ subAgents: kids(5) });
        h.childList.push(...kids(5, "idle"));
        h.messages.push(
            { prompt: "user question", clientMessageIds: ["u-1"] },
            ...kids(5).map((k, i) => update(k.sessionId, "completed", `RESULT ${i}`)),
        );
        h.results.push({ type: "completed", content: "answered" });
        h.step();
        expect(h.turns).toHaveLength(1);
        expect(h.turns[0][0]).toContain("user question");
        expect(lookups(beforeFirstTurn(h))).toBe(0);
        expect(lookups(h.calls)).toBe(0);
        // Recorded at once: tracked, buffered for the parent, and the lookups
        // owed are settled from the listing taken after the turn.
        expect(h.runtime.state.subAgents.map(a => a.status)).toEqual(Array(5).fill("completed"));
        expect(h.runtime.state.pendingChildDigest?.updates.map(u => u.sessionId)).toEqual(kids(5).map(k => k.sessionId));
        expect(h.runtime.state.deferredChildProbes).toEqual([]);
    });

    it("a wait update behind a prompt: after the prompt's turn the child is waiting, not left completed", () => {
        const h = harness({ subAgents: kids(1, "completed") });
        h.child.status = "waiting";
        h.childList.push({ ...kids(1)[0], status: "waiting" });
        h.messages.push({ prompt: "user question", clientMessageIds: ["u-1"] }, update("child-0", "wait", "waiting for CI"));
        h.results.push({ type: "completed", content: "answered" });
        h.step();
        expect(lookups(beforeFirstTurn(h))).toBe(0);
        expect(h.runtime.state.subAgents[0].status).toBe("waiting");
        expect(h.runtime.state.deferredChildProbes).toEqual([]);
    });

    it("a queued prompt in the FIFO counts as user work: updates behind it add no lookup before its turn", () => {
        const h = harness({ subAgents: kids(3) });
        h.childList.push(...kids(3, "running"));
        appendToFifo(h.runtime, [prompt("queued question")]);
        h.messages.push(...kids(3).map((k, i) => update(k.sessionId, "completed", `R${i}`)));
        h.results.push({ type: "completed", content: "ok" });
        h.step();
        expect(h.turns).toHaveLength(1);
        expect(lookups(beforeFirstTurn(h))).toBe(0);
        expect(h.runtime.state.deferredChildProbes).toEqual([]);
    });

    it("the pre-dispatch sweep adds no lookup before the prompt it is dispatching", () => {
        const h = harness({ subAgents: kids(3) });
        h.childList.push(...kids(3, "running"));
        appendToFifo(h.runtime, [prompt("queued question", { clientMessageIds: ["q-1"] })]);
        h.messages.push(...kids(3).map((k, i) => update(k.sessionId, "completed", `R${i}`)));
        h.results.push({ type: "completed", content: "ok" });
        h.drive(decide(h.runtime));
        expect(h.turns).toHaveLength(1);
        expect(lookups(beforeFirstTurn(h))).toBe(0);
        expect(h.runtime.state.subAgents.map(a => a.status)).toEqual(Array(3).fill("completed"));
        expect(h.runtime.state.deferredChildProbes).toEqual([]);
    });

    it("an update with no user work queued is still looked up at once", () => {
        const h = harness({ subAgents: kids(2) });
        h.child.status = "idle";
        h.messages.push(update("child-0", "wait", "parked"));
        h.drive(drain(h.runtime));
        expect(lookups(h.calls)).toBe(1);
        expect(h.runtime.state.subAgents[0].status).toBe("idle");
        expect(h.runtime.state.deferredChildProbes).toEqual([]);
    });

    it("with a live agent wait, an update behind collected user work is looked up at once (the wait needs it)", () => {
        const h = harness({
            subAgents: kids(1),
            waitingForAgentIds: ["agent-0"],
            pendingInputQuestion: { question: "which?", iteration: 3 },
        });
        h.child.status = "completed";
        h.messages.push({ answer: "this one", expectedQuestion: { question: "which?", iteration: 3 } }, update("child-0", "completed", "done"));
        h.drive(drain(h.runtime));
        expect(lookups(h.calls)).toBe(1);
        expect(h.runtime.state.waitingForAgentIds).toBeNull();
        expect(h.runtime.state.deferredChildProbes).toEqual([]);
    });

    it("a prompt cancelled in the same pass: the lookups it deferred run at the end of the pass", () => {
        const h = harness({ subAgents: kids(1) });
        h.child.status = "idle";
        h.messages.push({ prompt: "soon cancelled", clientMessageIds: ["c-1"] }, update("child-0", "wait", "parked"), { cancelPending: ["c-1"] });
        h.drive(drain(h.runtime));
        expect(h.fifo()).toEqual([]);
        expect(lookups(h.calls)).toBe(1);
        expect(h.runtime.state.subAgents[0].status).toBe("idle");
        expect(h.runtime.state.deferredChildProbes).toEqual([]);
    });

    it("a first report behind a prompt still marks the digest ready once every child is settled", () => {
        const h = harness({ subAgents: kids(2).map(k => ({ ...k, expectsReport: true })) });
        h.childList.push(...kids(2, "idle"));
        h.messages.push(
            { prompt: "user question", clientMessageIds: ["u-1"] },
            update("child-0", "completed", "first"),
            update("child-1", "completed", "second"),
        );
        h.results.push({ type: "completed", content: "answered" });
        h.step();
        expect(lookups(beforeFirstTurn(h))).toBe(0);
        expect(h.runtime.state.pendingChildDigest?.ready).toBe(true);
    });

    it("lookups owed are carried across continue-as-new and settled by the next turn's listing", () => {
        const h = harness({
            subAgents: kids(1, "completed"),
            deferredChildProbes: [{ sessionId: "child-0", updateType: "wait" }],
        });
        expect(lifecycle.continueInput(h.runtime).deferredChildProbes).toEqual([{ sessionId: "child-0", updateType: "wait" }]);
        h.childList.push({ ...kids(1)[0], status: "waiting" });
        h.messages.push({ prompt: "next question", clientMessageIds: ["n-1"] });
        h.results.push({ type: "completed", content: "ok" });
        h.step();
        expect(h.turns).toHaveLength(1);
        expect(h.runtime.state.subAgents[0].status).toBe("waiting");
        expect(h.runtime.state.deferredChildProbes).toEqual([]);
        expect(lifecycle.continueInput(h.runtime).deferredChildProbes).toBeUndefined();
    });
});

describe("issue 192 stress finding review: deferred child lookups never leave a wrong status behind", () => {
    const kids = (n, status = "running") => Array.from({ length: n }, (_, i) => ({
        orchId: `agent-${i}`, sessionId: `child-${i}`, task: "work", status,
    }));
    const update = (sessionId, type, text = "") => ({ prompt: `[CHILD_UPDATE from=${sessionId} type=${type} iter=1]\n${text}` });
    const lookups = (calls) => calls.filter(c => c.effect === "manager.getSessionStatus").length;
    const firstTurnIndex = (h) => h.calls.findIndex(c => c.effect === "session.runTurn");

    it("F1: when the listing after the turn fails, the deferred lookups are done one by one after the turn", () => {
        const h = harness({ subAgents: kids(1) });
        h.child.status = "idle";
        h.listing.fails = true;
        h.messages.push({ prompt: "user question", clientMessageIds: ["u-1"] }, update("child-0", "wait", "parked"));
        h.results.push({ type: "completed", content: "answered" });
        h.step();
        const first = firstTurnIndex(h);
        expect(lookups(h.calls.slice(0, first))).toBe(0);
        expect(lookups(h.calls.slice(first))).toBe(1);
        expect(h.runtime.state.subAgents[0].status).toBe("idle");
        expect(h.runtime.state.deferredChildProbes).toEqual([]);
    });

    it("F1: a wait_for_agents in that turn does not take a waiting child for done when the listing fails", () => {
        const h = harness({ subAgents: kids(1, "completed") });
        h.child.status = "waiting";
        h.listing.fails = true;
        h.messages.push({ prompt: "wait for the child", clientMessageIds: ["u-1"] }, update("child-0", "wait", "waiting for CI"));
        h.results.push({ type: "wait_for_agents", agentIds: ["agent-0"] });
        h.step();
        expect(h.runtime.state.waitingForAgentIds).toEqual(["agent-0"]);
        expect(h.runtime.state.pendingPrompt ?? "").not.toMatch(/completed|finished/i);
    });

    it("F2: a queued wait_for_agents action reads the child's real status, not a stale one", () => {
        const h = harness({
            subAgents: kids(1, "completed"),
            pendingToolActions: [{ type: "wait_for_agents", agentIds: ["agent-0"] }],
        });
        h.child.status = "waiting";
        h.messages.push({ prompt: "user question", clientMessageIds: ["u-1"] }, update("child-0", "wait", "waiting for CI"));
        h.drive(drain(h.runtime));
        h.drive(decide(h.runtime));
        expect(h.runtime.state.waitingForAgentIds).toEqual(["agent-0"]);
        expect(h.runtime.state.pendingPrompt).toBeUndefined();
    });

    it("F2: with a wait_for_agents action queued, an update is looked up at once, as before (the action reads it first)", () => {
        const h = harness({
            subAgents: kids(1),
            pendingToolActions: [{ type: "wait_for_agents", agentIds: ["agent-0"] }],
        });
        h.child.status = "completed";
        h.messages.push({ prompt: "user question", clientMessageIds: ["u-1"] }, update("child-0", "wait", "nearly done"));
        h.drive(drain(h.runtime));
        expect(lookups(h.calls)).toBe(1);
        expect(h.runtime.state.deferredChildProbes).toEqual([]);
        h.drive(decide(h.runtime));
        // The child is done by the time it is looked up, so the queued wait
        // ends at once with the done summary, as at the base.
        expect(h.runtime.state.waitingForAgentIds).toBeNull();
        expect(h.runtime.state.pendingPrompt).toBeTruthy();
    });

    it("F3: a digest a later prompt carries shows the update's status, not a stale tracked one", () => {
        const h = harness({ subAgents: kids(1, "completed") });
        h.child.status = "waiting";
        h.childList.push({ ...kids(1)[0], status: "waiting" });
        h.messages.push(
            { prompt: "first", clientMessageIds: ["p-1"] },
            update("child-0", "wait", "waiting for CI"),
            { prompt: "second", clientMessageIds: ["p-2"] },
        );
        h.results.push({ type: "completed", content: "ok" });
        h.step();
        expect(h.turns).toHaveLength(1);
        expect(lookups(h.calls.slice(0, firstTurnIndex(h)))).toBe(0);
        const text = String(h.turns[0][0]);
        expect(text).toContain("waiting for CI");
        expect(text).toContain("Status: waiting");
        expect(text).not.toContain("Status: completed");
    });

    it("F4: a prompt cancelled in the pass: its deferred lookups run before any long wait, and an all-quiet first report is ready at once", () => {
        const h = harness({ subAgents: kids(1).map(k => ({ ...k, expectsReport: true })) });
        h.child.status = "idle";
        h.messages.push({ prompt: "soon cancelled", clientMessageIds: ["c-1"] }, update("child-0", "wait", "parked"), { cancelPending: ["c-1"] });
        h.drive(drain(h.runtime));
        const firstLookup = h.calls.findIndex(c => c.effect === "manager.getSessionStatus");
        const firstLongRace = h.calls.findIndex(c => c.effect === "race" && c.left?.effect === "dequeue" && c.right?.ms >= 1000);
        expect(firstLookup).toBeGreaterThanOrEqual(0);
        expect(firstLongRace === -1 || firstLookup < firstLongRace).toBe(true);
        expect(h.races().filter(ms => ms >= 1000)).toEqual([]);
        expect(h.runtime.state.pendingChildDigest?.ready).toBe(true);
    });

    it("F4: a prompt cancelled at dispatch: the next pass does its deferred lookups before any long wait", () => {
        const h = harness({ subAgents: kids(1).map(k => ({ ...k, expectsReport: true })) });
        h.child.status = "idle";
        appendToFifo(h.runtime, [prompt("queued question", { clientMessageIds: ["q-1"] })]);
        h.messages.push(update("child-0", "wait", "parked"), { cancelPending: ["q-1"] });
        h.drive(decide(h.runtime));
        expect(h.turns).toHaveLength(0);
        const before = h.calls.length;
        h.drive(drain(h.runtime));
        const after = h.calls.slice(before);
        const firstLookup = after.findIndex(c => c.effect === "manager.getSessionStatus");
        const firstLongRace = after.findIndex(c => c.effect === "race" && c.left?.effect === "dequeue" && c.right?.ms >= 1000);
        expect(firstLookup).toBeGreaterThanOrEqual(0);
        expect(firstLongRace === -1 || firstLookup < firstLongRace).toBe(true);
        expect(h.runtime.state.pendingChildDigest?.ready).toBe(true);
        expect(h.runtime.state.deferredChildProbes).toEqual([]);
    });

    it("deferred lookups coalesce per child: the latest update type wins, an expected first report stays marked, a lookup done at once replaces them", () => {
        const h = harness({ subAgents: kids(2) });
        agents.deferChildStatusLookup(h.runtime, "child-0", "completed", true);
        agents.deferChildStatusLookup(h.runtime, "child-1", "wait", false);
        agents.deferChildStatusLookup(h.runtime, "child-0", "wait", false);
        expect(h.runtime.state.deferredChildProbes).toEqual([
            { sessionId: "child-1", updateType: "wait" },
            { sessionId: "child-0", updateType: "wait", expectingReport: true },
        ]);
        agents.forgetDeferredChildStatusLookup(h.runtime, "child-1");
        expect(h.runtime.state.deferredChildProbes.map(e => e.sessionId)).toEqual(["child-0"]);
    });

    it("a child missing from a successful listing is dropped by the refresh; settling skips it", () => {
        const h = harness({ subAgents: kids(2) });
        h.childList.push({ ...kids(2)[0], status: "idle" });
        h.messages.push(
            { prompt: "user question", clientMessageIds: ["u-1"] },
            update("child-0", "wait", "parked"),
            update("child-1", "wait", "parked"),
        );
        h.results.push({ type: "completed", content: "ok" });
        h.step();
        expect(h.runtime.state.subAgents.map(a => [a.sessionId, a.status])).toEqual([["child-0", "idle"]]);
        expect(h.runtime.state.deferredChildProbes).toEqual([]);
    });
});
