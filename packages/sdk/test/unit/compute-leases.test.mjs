/**
 * Host leases and the end-of-session notice
 * (docs/proposals/compute-providers.md, "Host lifecycle").
 *
 * PilotSwarm reports usage and nothing more: a lease it renews while it is
 * using a host, and one notice when a session tree is finished with it.
 * What happens to a host nobody needs is the provider's decision.
 *
 * What these hold the schedule to: a lease always outlasts more than one
 * renewal, so a single late renewal never reads as a worker that has gone;
 * and absurd numbers are clamped rather than trusted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    computeLeaseSchedule,
    DEFAULT_COMPUTE_LEASE_MS,
    DEFAULT_COMPUTE_LEASE_RENEW_MS,
    MIN_COMPUTE_LEASE_MS,
    MIN_COMPUTE_LEASE_RENEW_MS,
} from "../../dist/compute.js";

test("the defaults renew several times inside one lease", () => {
    const schedule = computeLeaseSchedule();
    assert.deepEqual(schedule, { leaseMs: DEFAULT_COMPUTE_LEASE_MS, renewMs: DEFAULT_COMPUTE_LEASE_RENEW_MS });
    assert.ok(schedule.leaseMs / schedule.renewMs >= 2,
        "a lease must survive at least one missed renewal");
});

test("a renewal slower than half the lease is brought back inside it", () => {
    // Asking to renew every four minutes on a three-minute lease would let
    // a perfectly healthy worker's lease lapse between renewals.
    const schedule = computeLeaseSchedule({ leaseMs: 180_000, renewMs: 240_000 });
    assert.equal(schedule.leaseMs, 180_000);
    assert.equal(schedule.renewMs, 90_000);
    assert.ok(schedule.leaseMs / schedule.renewMs >= 2);
});

test("absurd numbers are clamped rather than trusted", () => {
    // A lease too short to be useful is raised to the shortest one worth
    // having; a nonsensical one falls back to the default instead.
    assert.equal(computeLeaseSchedule({ leaseMs: 1 }).leaseMs, MIN_COMPUTE_LEASE_MS);
    assert.equal(computeLeaseSchedule({ leaseMs: -5 }).leaseMs, DEFAULT_COMPUTE_LEASE_MS);
    assert.equal(computeLeaseSchedule({ renewMs: 0 }).renewMs, DEFAULT_COMPUTE_LEASE_RENEW_MS);
    assert.equal(computeLeaseSchedule({ renewMs: -1 }).renewMs, DEFAULT_COMPUTE_LEASE_RENEW_MS);
    assert.ok(computeLeaseSchedule({ leaseMs: NaN, renewMs: NaN }).leaseMs === DEFAULT_COMPUTE_LEASE_MS);
    assert.ok(computeLeaseSchedule({ leaseMs: MIN_COMPUTE_LEASE_MS }).renewMs >= MIN_COMPUTE_LEASE_RENEW_MS);
});

test("a short lease still renews at least twice inside itself", () => {
    for (const leaseMs of [MIN_COMPUTE_LEASE_MS, 10_000, 30_000, 600_000]) {
        const schedule = computeLeaseSchedule({ leaseMs });
        assert.ok(schedule.leaseMs / schedule.renewMs >= 2, `lease ${leaseMs} renews too slowly`);
        assert.ok(schedule.renewMs >= MIN_COMPUTE_LEASE_RENEW_MS);
    }
});
