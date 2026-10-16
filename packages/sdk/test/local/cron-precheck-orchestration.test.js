/**
 * Cron prechecks in orchestration 1.0.82: an interval cron wake-up asks the
 * worker's registered precheck first, and an enforced `skip` re-arms the
 * schedule without running a model turn. Driven against the generator with a
 * scripted context; no worker, database or model.
 */
import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../src/orchestration/runtime.ts";
import { processTimer } from "../../src/orchestration/turn.ts";
import { buildContinueInput } from "../../src/orchestration/lifecycle.ts";

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: (ctx) => ctx.proxy("session"),
    createSessionManagerProxy: (ctx) => ctx.proxy("manager"),
}));

const SCHEDULE = { intervalSeconds: 300, reason: "check the work queue" };

function harness(overrides = {}) {
    const calls = [];
    const turns = [];
    const prechecks = [];
    const precheckAnswers = [];
    let now = 1_750_000_000_000;
    let guid = 0;
    const kv = new Map();
    const ctx = {
        traceInfo() {},
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
            case "now": return now;
            case "guid": return `recorded-guid-${++guid}`;
            case "timer": now += effect.ms; return undefined;
            case "manager.runCronPrecheck": {
                prechecks.push(effect.args[0]);
                const answer = precheckAnswers.shift();
                if (answer instanceof Error) throw answer;
                return answer ?? { skip: false, outcome: "unbound" };
            }
            case "session.runTurn":
                turns.push(effect.args);
                return { type: "completed", content: "cycle done" };
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
        for (let step = 0; step < 800; step++) {
            const next = failure ? gen.throw(failure) : gen.next(value);
            failure = undefined;
            if (next.done) return next.value;
            try { value = resolve(next.value); } catch (error) { failure = error; }
        }
        throw new Error("generator exceeded bound");
    }
    const runtime = drive(createRuntime(ctx, {
        sessionId: "cron-precheck-fixture",
        config: {},
        iteration: 4,
        isSystem: true,
        blobEnabled: false,
        cronSchedule: { ...SCHEDULE },
        ...overrides,
    }, { currentVersion: "1.0.82", latestVersion: "1.0.82" }));
    calls.length = 0;
    const fire = (...answers) => {
        precheckAnswers.push(...answers);
        const timer = { type: "cron", reason: SCHEDULE.reason, deadlineMs: now, originalDurationMs: SCHEDULE.intervalSeconds * 1000 };
        runtime.state.activeTimer = null;
        drive(processTimer(runtime, { kind: "timer", timer, firedAtMs: now }));
    };
    const events = () => calls
        .filter(call => call.effect === "manager.recordSessionEvent")
        .flatMap(call => call.args[1].map(event => event.eventType));
    return { runtime, calls, turns, prechecks, fire, events, now: () => now };
}

describe("1.0.82 cron precheck", () => {
    it("an enforced skip re-arms the schedule without a model turn", () => {
        const h = harness();
        h.fire({ skip: true, outcome: "skip", precheck: "queue", enforced: true });

        expect(h.turns).toHaveLength(0);
        expect(h.prechecks).toEqual([{
            sessionId: "cron-precheck-fixture",
            reason: SCHEDULE.reason,
            intervalSeconds: SCHEDULE.intervalSeconds,
            consecutiveSkips: 0,
        }]);
        expect(h.runtime.state.cronSchedule).toEqual({ ...SCHEDULE, precheckSkips: 1 });
        expect(h.runtime.state.activeTimer).toMatchObject({
            type: "cron",
            reason: SCHEDULE.reason,
            originalDurationMs: SCHEDULE.intervalSeconds * 1000,
            deadlineMs: h.now() + SCHEDULE.intervalSeconds * 1000,
        });
        expect(h.events()).toEqual(["session.cron_fired", "session.cron_started"]);
    });

    it("counts consecutive skips and resets the count when the model runs", () => {
        const h = harness();
        h.fire({ skip: true, outcome: "skip" });
        h.fire({ skip: true, outcome: "skip" });
        expect(h.prechecks.map(p => p.consecutiveSkips)).toEqual([0, 1]);
        expect(h.runtime.state.cronSchedule.precheckSkips).toBe(2);

        h.fire({ skip: false, outcome: "run" });
        expect(h.prechecks.at(-1).consecutiveSkips).toBe(2);
        expect(h.turns).toHaveLength(1);
        expect(h.turns[0][0]).toContain(`Scheduled cron wake-up for: "${SCHEDULE.reason}"`);
        expect(h.runtime.state.cronSchedule).toEqual({ ...SCHEDULE, precheckSkips: 0 });
    });

    it("a shadow decision (not enforced) still runs the model turn", () => {
        const h = harness();
        h.fire({ skip: false, outcome: "skip", precheck: "queue", enforced: false });
        expect(h.prechecks).toHaveLength(1);
        expect(h.turns).toHaveLength(1);
        expect(h.runtime.state.cronSchedule.precheckSkips).toBeUndefined();
    });

    it("fails open when the precheck activity throws", () => {
        const h = harness();
        h.fire(new Error("activity not available"));
        expect(h.turns).toHaveLength(1);
        expect(h.runtime.state.cronSchedule.precheckSkips).toBeUndefined();
    });

    it("an unbound session runs exactly as before, after one precheck call", () => {
        const h = harness();
        h.fire();
        expect(h.prechecks).toHaveLength(1);
        expect(h.turns).toHaveLength(1);
    });

    it("does not consult the precheck when the wake-up carries a child digest", () => {
        const h = harness({
            pendingChildDigest: {
                startedAtMs: 1,
                updates: [{ sessionId: "child", updateType: "completed", content: "found a job", observedAtMs: 1 }],
            },
        });
        h.fire({ skip: true, outcome: "skip" });
        expect(h.prechecks).toHaveLength(0);
        expect(h.turns).toHaveLength(1);
        expect(h.turns[0][0]).toContain("found a job");
    });

    it("does not consult the precheck when a held note must reach the model", () => {
        const h = harness({ runtimeModelNotice: "The model changed." });
        h.fire({ skip: true, outcome: "skip" });
        expect(h.prechecks).toHaveLength(0);
        expect(h.turns).toHaveLength(1);
    });

    it("a stale cron fire after cancel neither prechecks nor runs", () => {
        const h = harness();
        h.runtime.state.cronSchedule = undefined;
        h.fire({ skip: true, outcome: "skip" });
        expect(h.prechecks).toHaveLength(0);
        expect(h.turns).toHaveLength(0);
    });

    it("the skip count survives continue-as-new with the schedule", () => {
        const h = harness();
        h.fire({ skip: true, outcome: "skip" });
        const input = buildContinueInput(h.runtime);
        expect(input.cronSchedule).toEqual({ ...SCHEDULE, precheckSkips: 1 });
    });
});
