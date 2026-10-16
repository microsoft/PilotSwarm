/**
 * Worker-side cron precheck evaluation: lookup by name, shadow vs skip, and
 * fail-open handling. No database or model.
 */
import { describe, expect, it } from "vitest";
import {
    evaluateCronPrecheck,
    normalizeCronPrecheckName,
    validateCronPrecheckRegistration,
} from "../../src/cron-precheck.ts";

const input = { sessionId: "s1", precheck: "queue", reason: "check the work queue", intervalSeconds: 300, consecutiveSkips: 0 };
const registration = (check, extra = {}) => validateCronPrecheckRegistration({ name: "queue", check, ...extra });

describe("cron precheck evaluation", () => {
    it("skips when the named precheck answers skip", async () => {
        const { result, event } = await evaluateCronPrecheck({
            registrations: [registration(() => ({ action: "skip", detail: "queue empty" }))],
            input,
        });
        expect(result).toEqual({ skip: true, outcome: "skip", precheck: "queue", shadow: false });
        expect(event).toMatchObject({ precheck: "queue", outcome: "skip", skipped: true, shadow: false, detail: "queue empty" });
    });

    it("records a skip without skipping for a shadow registration", async () => {
        const { result, event } = await evaluateCronPrecheck({
            registrations: [registration(() => ({ action: "skip" }), { shadow: true })],
            input,
        });
        expect(result).toEqual({ skip: false, outcome: "skip", precheck: "queue", shadow: true });
        expect(event).toMatchObject({ outcome: "skip", skipped: false, shadow: true });
    });

    it("runs the model for an unregistered name and records why", async () => {
        const { result, event } = await evaluateCronPrecheck({
            registrations: [registration(() => ({ action: "skip" }))],
            input: { ...input, precheck: "other" },
        });
        expect(result).toEqual({ skip: false, outcome: "unregistered", precheck: "other" });
        expect(event).toMatchObject({ precheck: "other", outcome: "unregistered", skipped: false });
        expect((await evaluateCronPrecheck({ registrations: [], input })).result.outcome).toBe("unregistered");
    });

    it("passes the wake-up facts to the handler", async () => {
        let seen;
        await evaluateCronPrecheck({
            registrations: [registration((context) => { seen = context; return { action: "run" }; })],
            input: { ...input, consecutiveSkips: 3 },
        });
        expect(seen).toMatchObject({ sessionId: "s1", reason: input.reason, intervalSeconds: 300, consecutiveSkips: 3 });
        expect(seen.signal).toBeInstanceOf(AbortSignal);
    });

    it("runs the model on a thrown, invalid or timed-out handler", async () => {
        const thrown = await evaluateCronPrecheck({
            registrations: [registration(() => { throw new Error("backend down"); })],
            input,
        });
        expect(thrown.result).toMatchObject({ skip: false, outcome: "error" });
        expect(thrown.event.detail).toBe("backend down");

        const invalid = await evaluateCronPrecheck({
            registrations: [registration(() => ({ action: "maybe" }))],
            input,
        });
        expect(invalid.result).toMatchObject({ skip: false, outcome: "invalid" });

        let aborted = false;
        const timeout = await evaluateCronPrecheck({
            registrations: [registration(({ signal }) => new Promise(() => { signal.addEventListener("abort", () => { aborted = true; }); }), { timeoutMs: 20 })],
            input,
        });
        expect(timeout.result).toMatchObject({ skip: false, outcome: "timeout" });
        expect(aborted).toBe(true);
    });

    it("forces a model turn after maxConsecutiveSkips without calling the handler", async () => {
        let called = false;
        const { result } = await evaluateCronPrecheck({
            registrations: [registration(() => { called = true; return { action: "skip" }; }, { maxConsecutiveSkips: 2 })],
            input: { ...input, consecutiveSkips: 2 },
        });
        expect(result).toMatchObject({ skip: false, outcome: "max_skips" });
        expect(called).toBe(false);
    });

    it("normalizes names and rejects malformed ones", () => {
        expect(normalizeCronPrecheckName("  job-queue.v2 ")).toBe("job-queue.v2");
        expect(normalizeCronPrecheckName("app:queue_1")).toBe("app:queue_1");
        for (const bad of ["", "  ", "has space", "-leading", "x".repeat(101), 7, null, undefined]) {
            expect(normalizeCronPrecheckName(bad)).toBeNull();
        }
    });

    it("rejects malformed registrations", () => {
        const check = () => ({ action: "run" });
        expect(() => validateCronPrecheckRegistration({ name: "", check })).toThrow(/name/);
        expect(() => validateCronPrecheckRegistration({ name: "bad name", check })).toThrow(/name/);
        expect(() => validateCronPrecheckRegistration({ name: "x" })).toThrow(/check/);
        expect(() => validateCronPrecheckRegistration({ name: "x", check, timeoutMs: 0 })).toThrow(/timeoutMs/);
        expect(() => validateCronPrecheckRegistration({ name: "x", check, timeoutMs: 60_001 })).toThrow(/timeoutMs/);
        expect(() => validateCronPrecheckRegistration({ name: "x", check, maxConsecutiveSkips: 0 })).toThrow(/maxConsecutiveSkips/);
        expect(() => validateCronPrecheckRegistration({ name: "x", check, shadow: "yes" })).toThrow(/shadow/);
        expect(validateCronPrecheckRegistration({ name: " x ", check }).name).toBe("x");
    });
});
