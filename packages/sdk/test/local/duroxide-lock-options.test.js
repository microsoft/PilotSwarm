/**
 * Lock settings the worker passes to the duroxide runtime.
 *
 * A running item renews its lock `renewal buffer` ms before the lock expires,
 * so the buffer is the longest stall the item survives. The worker defaults an
 * unset buffer to 75% of its timeout, so raising a timeout also raises the
 * stall the lock survives. Locks under 15 s renew at half their timeout and
 * ignore the buffer, so no buffer is sent for them.
 *
 * No database, duroxide runtime or LLM required.
 */
import { describe, it, expect } from "vitest";
import { resolveDuroxideLockOptions } from "../../src/worker.js";

describe("resolveDuroxideLockOptions", () => {
    it("uses the defaults: 10 s activity lock, 60 s orchestration lock with a 45 s buffer", () => {
        expect(resolveDuroxideLockOptions({}, {})).toEqual({
            workerLockTimeoutMs: 10_000,
            orchestratorLockTimeoutMs: 60_000,
            orchestratorLockRenewalBufferMs: 45_000,
        });
    });

    it("reads every setting from its PILOTSWARM_* env var", () => {
        expect(resolveDuroxideLockOptions({}, {
            PILOTSWARM_WORKER_LOCK_TIMEOUT_MS: "60000",
            PILOTSWARM_WORKER_LOCK_RENEWAL_BUFFER_MS: "50000",
            PILOTSWARM_ORCHESTRATOR_LOCK_TIMEOUT_MS: "30000",
            PILOTSWARM_ORCHESTRATOR_LOCK_RENEWAL_BUFFER_MS: "20000",
            PILOTSWARM_SESSION_LOCK_TIMEOUT_MS: "40000",
            PILOTSWARM_SESSION_LOCK_RENEWAL_BUFFER_MS: "35000",
        })).toEqual({
            workerLockTimeoutMs: 60_000,
            workerLockRenewalBufferMs: 50_000,
            orchestratorLockTimeoutMs: 30_000,
            orchestratorLockRenewalBufferMs: 20_000,
            sessionLockTimeoutMs: 40_000,
            sessionLockRenewalBufferMs: 35_000,
        });
    });

    it("derives a 75% buffer for any lock of 15 s or more whose buffer is unset", () => {
        expect(resolveDuroxideLockOptions({}, {
            PILOTSWARM_WORKER_LOCK_TIMEOUT_MS: "60000",
            PILOTSWARM_ORCHESTRATOR_LOCK_TIMEOUT_MS: "30000",
            PILOTSWARM_SESSION_LOCK_TIMEOUT_MS: "40000",
        })).toEqual({
            workerLockTimeoutMs: 60_000,
            workerLockRenewalBufferMs: 45_000,
            orchestratorLockTimeoutMs: 30_000,
            orchestratorLockRenewalBufferMs: 22_500,
            sessionLockTimeoutMs: 40_000,
            sessionLockRenewalBufferMs: 30_000,
        });
    });

    it("sends no buffer for locks under 15 s", () => {
        const options = resolveDuroxideLockOptions({ workerLockTimeoutMs: 2_000, orchestratorLockTimeoutMs: 5_000 }, {});
        expect(options).toEqual({ workerLockTimeoutMs: 2_000, orchestratorLockTimeoutMs: 5_000 });
    });

    it("prefers the worker option over the env var", () => {
        const options = resolveDuroxideLockOptions(
            { workerLockTimeoutMs: 20_000, orchestratorLockRenewalBufferMs: 40_000 },
            { PILOTSWARM_WORKER_LOCK_TIMEOUT_MS: "90000", PILOTSWARM_ORCHESTRATOR_LOCK_RENEWAL_BUFFER_MS: "1000" },
        );
        expect(options.workerLockTimeoutMs).toBe(20_000);
        expect(options.workerLockRenewalBufferMs).toBe(15_000);
        expect(options.orchestratorLockRenewalBufferMs).toBe(40_000);
    });

    it("ignores values that are not positive integers", () => {
        expect(resolveDuroxideLockOptions({}, {
            PILOTSWARM_WORKER_LOCK_TIMEOUT_MS: "abc",
            PILOTSWARM_ORCHESTRATOR_LOCK_TIMEOUT_MS: "0",
            PILOTSWARM_SESSION_LOCK_TIMEOUT_MS: "-5",
        })).toEqual({
            workerLockTimeoutMs: 10_000,
            orchestratorLockTimeoutMs: 60_000,
            orchestratorLockRenewalBufferMs: 45_000,
        });
    });

    it("never sends an undefined value to duroxide", () => {
        const options = resolveDuroxideLockOptions({ sessionLockTimeoutMs: undefined }, {});
        for (const value of Object.values(options)) expect(value).not.toBeUndefined();
        expect(Object.keys(options)).not.toContain("sessionLockTimeoutMs");
    });
});
