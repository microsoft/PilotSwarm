/**
 * FB-034, review N1: the delete activity's RETRY behaviour, which no test covered.
 *
 * The registered `deleteSession` activity (session-proxy.ts) wraps its one real call in
 * `cmsRetryCritical(..., CMS_RETRY_SETTLE_DELAYS_MS)`. The orchestration generator calls that activity once and
 * sees only its final outcome, so the generator tests in session-delete-honesty.test.js cannot say anything about
 * retries. These tests exercise the retry wrapper and the schedule the activity passes it, which together decide:
 *
 *   - whether a transient failure is retried at all (the classifier),
 *   - how long the delays are (the schedule, deliberately shorter than the default here),
 *   - and whether exhaustion RETHROWS - which is the part FB-034 depends on, because a swallowed error is exactly
 *     how a failed delete used to be reported as done.
 *
 * The real sleeps are not awaited: fake timers advance them, so the 33-second schedule runs instantly.
 *
 * Run: npx vitest run test/local/delete-activity-retry.test.js
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cmsRetryCritical, CMS_RETRY_SETTLE_DELAYS_MS } from "../../src/cms-retry.ts";

/** A deadlock, the transient error FB-034 is actually about: three ordinary transactions can cycle (FB-028). */
const deadlock = () => Object.assign(new Error("deadlock detected"), { code: "40P01" });
/** Not transient: a programming error must fail on the first attempt, not burn the budget. */
const permanent = () => Object.assign(new Error("column does not exist"), { code: "42703" });

/** Run `fn` under the activity's own retry wrapper and schedule, with the sleeps faked away. */
async function underActivityRetry(fn) {
    vi.useFakeTimers();
    const logs = [];
    try {
        const promise = cmsRetryCritical("deleteSession session=s1", fn, m => logs.push(String(m)), CMS_RETRY_SETTLE_DELAYS_MS);
        const settled = promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));
        // Let every scheduled delay elapse. runAllTimersAsync drains timers created while draining.
        await vi.runAllTimersAsync();
        return { ...(await settled), logs };
    } finally {
        vi.useRealTimers();
    }
}

afterEach(() => { vi.useRealTimers(); });

describe("FB-034: the delete activity's retry schedule and its exhaustion", () => {
    it("transient errors then success: the delete is retried and the caller sees success", async () => {
        let attempts = 0;
        const result = await underActivityRetry(async () => {
            attempts += 1;
            if (attempts <= 2) throw deadlock();
            return "deleted";
        });
        expect(result.ok, "a rescued delete reports success").toBe(true);
        expect(attempts, "after exactly the failed attempts plus the one that worked").toBe(3);
    });

    it("exhaustion RETHROWS, which is what lets the orchestration stop claiming success", async () => {
        let attempts = 0;
        const result = await underActivityRetry(async () => { attempts += 1; throw deadlock(); });
        expect(result.ok, "an exhausted delete must not resolve").toBe(false);
        expect(result.error?.code, "and the original error reaches the caller").toBe("40P01");
        // One initial attempt plus one per delay. Pinned as a relationship, not a bare number, so that changing
        // the schedule updates this automatically rather than silently contradicting it.
        expect(attempts, "every attempt in the schedule was used").toBe(CMS_RETRY_SETTLE_DELAYS_MS.length + 1);
    });

    it("a non-transient error fails immediately instead of spending the budget", async () => {
        let attempts = 0;
        const result = await underActivityRetry(async () => { attempts += 1; throw permanent(); });
        expect(result.ok).toBe(false);
        expect(attempts, "a permanent failure is not worth four delays").toBe(1);
    });

    it("the schedule is the SHORTER one, and its total is what the comment claims", () => {
        // The activity passes CMS_RETRY_SETTLE_DELAYS_MS rather than the default precisely because somebody is
        // waiting: the portal's delete settles for 65 s. If this total ever grows past that, the reason for
        // choosing this schedule has gone, and this test should fail rather than let the comment rot.
        const total = CMS_RETRY_SETTLE_DELAYS_MS.reduce((a, b) => a + b, 0);
        expect(total, "33 seconds of delays").toBe(33_000);
        expect(total, "comfortably inside the portal's 65 s settle wait").toBeLessThan(65_000);
    });

    it("a delete that succeeds first time is not delayed at all", async () => {
        let attempts = 0;
        const result = await underActivityRetry(async () => { attempts += 1; return "deleted"; });
        expect(result.ok).toBe(true);
        expect(attempts).toBe(1);
    });
});
