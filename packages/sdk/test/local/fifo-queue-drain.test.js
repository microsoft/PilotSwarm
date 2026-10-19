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
import { createRuntime } from "../../src/orchestration/runtime.ts";
import { appendToFifo, decide, drain } from "../../src/orchestration/queue.ts";
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
    const clock = { now: 1_750_000_000_000 };
    let guid = 0;
    const ctx = {
        traceInfo() {},
        traceWarn() {},
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
                return results.shift();
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
    return { runtime, kv, clock, calls, turns, results, messages, drive, races, events, fifo, arm };
}

const prompt = (text, extra = {}) => ({ kind: "prompt", prompt: text, bootstrap: false, ...extra });
const cronItem = () => ({ kind: "timer", timer: { type: "cron", deadlineMs: 1, originalDurationMs: HOUR_MS, reason: "hourly" }, firedAtMs: 1 });

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
    });
});
