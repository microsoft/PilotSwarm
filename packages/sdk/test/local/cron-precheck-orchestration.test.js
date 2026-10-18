/**
 * Cron prechecks in orchestration 1.0.82: an interval cron schedule that names
 * a worker-registered precheck asks it first, and a `skip` re-arms the
 * schedule without running a model turn. A schedule without a precheck is
 * unchanged. Driven against the generator with a scripted context; no worker,
 * database or model.
 */
import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "../../src/orchestration/runtime.ts";
import { processTimer } from "../../src/orchestration/turn.ts";
import { applyCronAction, buildContinueInput } from "../../src/orchestration/lifecycle.ts";

vi.mock("../../src/session-proxy.js", () => ({
    createSessionProxy: (ctx) => ctx.proxy("session"),
    createSessionManagerProxy: (ctx) => ctx.proxy("manager"),
}));

const SCHEDULE = { intervalSeconds: 300, reason: "check the work queue", precheck: "queue" };

function harness(overrides = {}, resolvedAgent = null) {
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
                return answer ?? { skip: false, outcome: "unregistered", precheck: effect.args[0].precheck };
            }
            case "session.runTurn":
                turns.push(effect.args);
                return { type: "completed", content: "cycle done" };
            case "manager.listChildSessions": return "[]";
            case "manager.getWorkerSessionPolicy": return { policy: null, allowedAgentNames: [] };
            case "manager.resolveAgentConfig": return resolvedAgent;
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
    it("a schedule without a precheck runs exactly as before, with no precheck activity", () => {
        const h = harness({ cronSchedule: { intervalSeconds: 300, reason: SCHEDULE.reason } });
        h.fire({ skip: true, outcome: "skip" });
        expect(h.prechecks).toHaveLength(0);
        expect(h.turns).toHaveLength(1);
        expect(h.turns[0][0]).toContain(`Scheduled cron wake-up for: "${SCHEDULE.reason}"`);
        expect(h.runtime.state.cronSchedule).toEqual({ intervalSeconds: 300, reason: SCHEDULE.reason });
    });

    it("a skip re-arms the schedule without a model turn", () => {
        const h = harness();
        h.fire({ skip: true, outcome: "skip", precheck: "queue", shadow: false });

        expect(h.turns).toHaveLength(0);
        expect(h.prechecks).toEqual([{
            sessionId: "cron-precheck-fixture",
            precheck: "queue",
            reason: SCHEDULE.reason,
            intervalSeconds: SCHEDULE.intervalSeconds,
            consecutiveSkips: 0,
            agent: {},
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

    it("a shadow decision still runs the model turn", () => {
        const h = harness();
        h.fire({ skip: false, outcome: "skip", precheck: "queue", shadow: true });
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

    it("an unregistered name runs the model turn", () => {
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

    it("a cron call sets the schedule's precheck, and a later call without one clears it", () => {
        const h = harness({ cronSchedule: undefined });
        applyCronAction(h.runtime, { type: "cron", action: "set", intervalSeconds: 60, reason: "poll", precheck: "queue" });
        expect(h.runtime.state.cronSchedule).toEqual({ intervalSeconds: 60, reason: "poll", precheck: "queue" });
        applyCronAction(h.runtime, { type: "cron", action: "set", intervalSeconds: 60, reason: "poll" });
        expect(h.runtime.state.cronSchedule).toEqual({ intervalSeconds: 60, reason: "poll" });
        applyCronAction(h.runtime, { type: "cron", action: "set", intervalSeconds: 60, reason: "poll", precheckPackageId: "pkg-1" });
        expect(h.runtime.state.cronSchedule).toEqual({ intervalSeconds: 60, reason: "poll" }, "a package without a precheck name is dropped");
    });

    it("a package precheck sends its package to the activity", () => {
        const h = harness({ cronSchedule: { ...SCHEDULE, precheckPackageId: "pkg-1" } });
        h.fire({ skip: true, outcome: "skip", precheck: "queue" });
        expect(h.prechecks[0]).toMatchObject({ precheck: "queue", packageId: "pkg-1" });
        expect(h.turns).toHaveLength(0);
        expect(buildContinueInput(h.runtime).cronSchedule).toEqual({ ...SCHEDULE, precheckPackageId: "pkg-1", precheckSkips: 1 });
    });

    it("agentId-only startup dispatches resolved provenance and tools and retains them across continue-as-new", () => {
        const identity = { packageId: "pkg-shared", versionId: "v1", sha256: "a".repeat(64) };
        const h = harness({
            agentId: "poller",
            iteration: 0,
            isSystem: false,
            config: { toolNames: ["caller_tool"] },
            cronSchedule: { ...SCHEDULE, precheckPackageId: "pkg-shared", precheckIdentity: identity, precheckBindingRevision: 7 },
        }, { name: "poller", packageId: "pkg-shared", tools: ["queue_tool"] });
        h.fire({ skip: true, outcome: "skip" });
        const expectedAgent = {
            boundAgentName: "poller",
            boundAgentPackageId: "pkg-shared",
            toolNames: ["queue_tool", "caller_tool"],
        };
        expect(h.prechecks[0].agent).toMatchObject(expectedAgent);
        expect(h.prechecks[0]).toMatchObject({ packageIdentity: identity, packageBindingRevision: 7 });
        expect(h.runtime.input.config.boundAgentPackageId).toBeUndefined();
        const next = buildContinueInput(h.runtime);
        expect(next.config).toMatchObject(expectedAgent);
        const resumed = harness({ ...next, iteration: 1 });
        resumed.fire({ skip: true, outcome: "skip" });
        expect(resumed.prechecks[0].agent).toEqual(h.prechecks[0].agent);
        expect(resumed.prechecks[0].packageId).toBe("pkg-shared");
        expect(resumed.prechecks[0]).toMatchObject({ packageIdentity: identity, packageBindingRevision: 7 });
    });

    it("schedule arming clones the full immutable identity and preserves it through continue-as-new", () => {
        const h = harness({ cronSchedule: undefined });
        const identity = { packageId: "pkg", versionId: "v1", sha256: "a".repeat(64) };
        applyCronAction(h.runtime, { type: "cron", action: "set", intervalSeconds: 60, reason: "poll",
            precheck: "queue", precheckPackageId: "pkg", precheckIdentity: identity, precheckBindingRevision: 3 });
        identity.versionId = "substituted";
        h.fire({ skip: true, outcome: "skip" });
        expect(h.prechecks[0].packageIdentity.versionId).toBe("v1");
        const next = buildContinueInput(h.runtime);
        expect(next.cronSchedule.precheckIdentity).toEqual({ ...identity, versionId: "v1" });
        expect(next.cronSchedule.precheckBindingRevision).toBe(3);
    });
});
