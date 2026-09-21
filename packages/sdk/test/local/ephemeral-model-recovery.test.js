// The reset-window contract of the rate-limit recovery helper, pinned at the
// unit level.
//
// The end-to-end suite proves a leaf session recovers from a transient limit
// and that a limit at a reset boundary fails closed, but it cannot show *why*
// the boundary holds. The orderings below are the reason, and they were
// measured from real runs on CLI 1.0.85 rather than assumed: a failed call's
// event reaches the helper while the window is still closed, but the error
// hook's decision arrives after the host has already reopened it. So the
// boundary cannot rest on the decision happening to land inside the window,
// and it does not rest on the host winning a race against the hook either.
import { describe, it, expect } from "vitest";

import { EphemeralModelRecovery, isRecoverableRateLimit } from "../../dist/ephemeral-model-recovery.js";

const SESSION = "session-under-test";

/** A transient limit the helper is allowed to retry. */
const limit = () => ({ type: "model.call_failure", id: `event-${Math.random()}`,
    data: { statusCode: 429, failureKind: "api" } });

/** The hook input the runtime hands to `decide` for that failed call. */
const hookInput = () => ({ sessionId: SESSION, recoverable: true, errorContext: "model_call", error: "limited" });

const retried = decision => decision.errorHandling === "retry";

describe("rate-limit recovery refuses to retry a call made inside a reset window", () => {
    it("retries a limited call outside the window", () => {
        const recovery = new EphemeralModelRecovery(SESSION);
        recovery.observe(limit());
        expect(retried(recovery.decide(hookInput()))).toBe(true);
    });

    it("refuses a call limited inside the window, even though the decision lands after it reopens", () => {
        // Exactly the order a real run produces, measured on CLI 1.0.85:
        // close, the failure event, reopen, and only then the hook.
        const recovery = new EphemeralModelRecovery(SESSION);
        recovery.setGate(true);
        recovery.observe(limit());
        recovery.setGate(false);
        expect(retried(recovery.decide(hookInput()))).toBe(false);
    });

    it("refuses a decision that arrives while the window is still closed", () => {
        // Credit is earned and spent entirely inside the window, so neither
        // edge of the gate is involved: the guards on `observe` and `decide`
        // are what refuse this, and they are deliberately redundant.
        const recovery = new EphemeralModelRecovery(SESSION);
        recovery.setGate(true);
        recovery.observe(limit());
        expect(retried(recovery.decide(hookInput()))).toBe(false);
    });

    it("recovers normally again once the window has passed", () => {
        // The boundary suppresses retries inside itself and nothing else; the
        // next batch turn is entitled to the same recovery as the first.
        const recovery = new EphemeralModelRecovery(SESSION);
        recovery.setGate(true);
        recovery.observe(limit());
        recovery.setGate(false);
        recovery.decide(hookInput());

        recovery.observe(limit());
        expect(retried(recovery.decide(hookInput()))).toBe(true);
    });

    it("spends a bounded number of retries and then gives up", () => {
        const recovery = new EphemeralModelRecovery(SESSION);
        const attempt = () => { recovery.observe(limit()); return retried(recovery.decide(hookInput())); };
        expect([attempt(), attempt(), attempt()]).toEqual([true, true, false]);
    });

    it("only treats an api rate limit as recoverable", () => {
        expect(isRecoverableRateLimit(limit())).toBe(true);
        expect(isRecoverableRateLimit({ type: "model.call_failure", id: "e",
            data: { statusCode: 500, failureKind: "api" } })).toBe(false);
        expect(isRecoverableRateLimit({ type: "model.call_failure", id: "e",
            data: { statusCode: 429, failureKind: "network" } })).toBe(false);
    });
});
