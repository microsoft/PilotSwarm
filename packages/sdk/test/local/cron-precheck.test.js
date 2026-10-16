/**
 * Worker-side cron precheck evaluation: matching, shadow vs enforced
 * decisions, and fail-open handling. No database or model.
 */
import { describe, expect, it } from "vitest";
import {
    CRON_PRECHECK_SKIP_FEATURE,
    cronPrecheckSkipEnforced,
    evaluateCronPrecheck,
    findCronPrecheck,
    validateCronPrecheckRegistration,
} from "../../src/cron-precheck.ts";
import { FEATURE_FLAGS } from "../../src/feature-flags.ts";

const owner = { provider: "test", subject: "alice" };
const flags = (enabled) => ({
    resolve: (key, featureOwner, options) => {
        expect(key).toBe(CRON_PRECHECK_SKIP_FEATURE);
        expect(options).toEqual({ fallback: false });
        return { enabled: enabled && featureOwner?.subject === "alice", source: "cluster", revision: "1", stale: false };
    },
});
const input = { sessionId: "s1", reason: "check the work queue", intervalSeconds: 300, consecutiveSkips: 0 };
const session = { agentId: "work-poller", owner };
const registration = (check, extra = {}) => validateCronPrecheckRegistration({ name: "queue", agents: ["work-poller"], check, ...extra });

describe("cron precheck evaluation", () => {
    it("defines an operator-controlled flag that is off by default", () => {
        expect(FEATURE_FLAGS[CRON_PRECHECK_SKIP_FEATURE]).toMatchObject({
            defaultEnabled: false,
            defaultAllowUserOverride: false,
            requiredCapability: null,
        });
    });

    it("records a skip without enforcing it while the flag is off (shadow)", async () => {
        const { result, event } = await evaluateCronPrecheck({
            registrations: [registration(() => ({ action: "skip", detail: "queue empty" }))],
            input, session, featureFlags: flags(false),
        });
        expect(result).toEqual({ skip: false, outcome: "skip", precheck: "queue", enforced: false });
        expect(event).toMatchObject({ precheck: "queue", outcome: "skip", skipped: false, enforced: false, detail: "queue empty" });
    });

    it("enforces a skip while the flag is on for the owner", async () => {
        const { result, event } = await evaluateCronPrecheck({
            registrations: [registration(() => ({ action: "skip" }))],
            input, session, featureFlags: flags(true),
        });
        expect(result).toEqual({ skip: true, outcome: "skip", precheck: "queue", enforced: true });
        expect(event).toMatchObject({ skipped: true });
    });

    it("passes the wake-up facts to the handler", async () => {
        let seen;
        await evaluateCronPrecheck({
            registrations: [registration((context) => { seen = context; return { action: "run" }; })],
            input: { ...input, consecutiveSkips: 3 }, session, featureFlags: flags(true),
        });
        expect(seen).toMatchObject({ sessionId: "s1", agentId: "work-poller", reason: input.reason, intervalSeconds: 300, consecutiveSkips: 3 });
        expect(seen.signal).toBeInstanceOf(AbortSignal);
    });

    it("runs the model on a thrown, invalid or timed-out handler", async () => {
        const thrown = await evaluateCronPrecheck({
            registrations: [registration(() => { throw new Error("backend down"); })],
            input, session, featureFlags: flags(true),
        });
        expect(thrown.result).toMatchObject({ skip: false, outcome: "error" });
        expect(thrown.event.detail).toBe("backend down");

        const invalid = await evaluateCronPrecheck({
            registrations: [registration(() => ({ action: "maybe" }))],
            input, session, featureFlags: flags(true),
        });
        expect(invalid.result).toMatchObject({ skip: false, outcome: "invalid" });

        let aborted = false;
        const timeout = await evaluateCronPrecheck({
            registrations: [registration(({ signal }) => new Promise(() => { signal.addEventListener("abort", () => { aborted = true; }); }), { timeoutMs: 20 })],
            input, session, featureFlags: flags(true),
        });
        expect(timeout.result).toMatchObject({ skip: false, outcome: "timeout" });
        expect(aborted).toBe(true);
    });

    it("forces a model turn after maxConsecutiveSkips without calling the handler", async () => {
        let called = false;
        const { result } = await evaluateCronPrecheck({
            registrations: [registration(() => { called = true; return { action: "skip" }; }, { maxConsecutiveSkips: 2 })],
            input: { ...input, consecutiveSkips: 2 }, session, featureFlags: flags(true),
        });
        expect(result).toMatchObject({ skip: false, outcome: "max_skips" });
        expect(called).toBe(false);
    });

    it("is unbound for other agents, other reasons, or a missing session", async () => {
        const regs = [registration(() => ({ action: "skip" }), { reasons: ["check the work queue"] })];
        for (const [sess, inp] of [
            [{ agentId: "other", owner }, input],
            [session, { ...input, reason: "different" }],
            [null, input],
            [{ agentId: null, owner }, input],
        ]) {
            const { result, event } = await evaluateCronPrecheck({ registrations: regs, input: inp, session: sess, featureFlags: flags(true) });
            expect(result).toEqual({ skip: false, outcome: "unbound" });
            expect(event).toBeNull();
        }
    });

    it("matches a namespaced agent id by its unqualified name", () => {
        const regs = [registration(() => ({ action: "run" }))];
        expect(findCronPrecheck(regs, "my-plugin:work-poller", input.reason)?.name).toBe("queue");
        expect(findCronPrecheck(regs, "owner:pkg:1.0.0", input.reason)).toBeNull();
    });

    it("is not enforced without a feature cache", () => {
        expect(cronPrecheckSkipEnforced(null, owner)).toBe(false);
    });

    it("rejects malformed registrations", () => {
        const check = () => ({ action: "run" });
        expect(() => validateCronPrecheckRegistration({ name: "", agents: ["a"], check })).toThrow(/name/);
        expect(() => validateCronPrecheckRegistration({ name: "x", agents: [], check })).toThrow(/agent/);
        expect(() => validateCronPrecheckRegistration({ name: "x", agents: ["a"] })).toThrow(/check/);
        expect(() => validateCronPrecheckRegistration({ name: "x", agents: ["a"], check, timeoutMs: 0 })).toThrow(/timeoutMs/);
        expect(() => validateCronPrecheckRegistration({ name: "x", agents: ["a"], check, timeoutMs: 60_001 })).toThrow(/timeoutMs/);
        expect(() => validateCronPrecheckRegistration({ name: "x", agents: ["a"], check, maxConsecutiveSkips: 0 })).toThrow(/maxConsecutiveSkips/);
        expect(() => validateCronPrecheckRegistration({ name: "x", agents: ["a"], check, reasons: [""] })).toThrow(/reasons/);
    });
});
