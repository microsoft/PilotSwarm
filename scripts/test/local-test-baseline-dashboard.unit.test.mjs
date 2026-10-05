import test from "node:test";
import assert from "node:assert/strict";
import {
    campaignProgress,
    isLoopbackAuthority,
    isLoopbackHost,
    parseDashboardArgs,
} from "../serve-local-test-baseline.mjs";

function campaign() {
    return {
        campaignId: "sha256:campaign",
        status: "running",
        summary: { passed: 1, failed: 1, timed_out: 1, mixed: 1, unfinished: 2 },
        tests: {},
        currentRun: {
            status: "running",
            phase: "retry",
            round: 1,
            heartbeatAt: "2026-09-30T16:34:20.000Z",
            lastProgressAt: "2026-09-30T16:34:10.000Z",
            lastTransitionAt: "2026-09-30T16:34:15.000Z",
            rounds: [{
                number: 1,
                kind: "retry",
                status: "running",
                total: 3,
                queued: 1,
                active: 1,
                completed: 1,
                remaining: 2,
            }],
            activeFiles: {
                "slow.test.js": {
                    slot: 2,
                    round: 1,
                    startedAt: "2026-09-30T16:34:00.000Z",
                    deadlineAt: "2026-09-30T16:39:00.000Z",
                },
            },
        },
    };
}

test("parses loopback-only dashboard options and default campaign path", () => {
    assert.deepEqual(
        parseDashboardArgs(["--host=localhost", "--port", "0"]),
        {
            results: "test-results/local-test-validation/campaign.json",
            host: "localhost",
            port: 0,
            help: false,
        },
    );
    assert.equal(isLoopbackHost("127.0.0.2"), true);
    assert.equal(isLoopbackHost("::1"), true);
    assert.equal(isLoopbackHost("0.0.0.0"), false);
    assert.equal(isLoopbackAuthority("127.0.0.1:4310"), true);
    assert.equal(isLoopbackAuthority("[::1]:4310"), true);
    assert.equal(isLoopbackAuthority("localhost.attacker.example"), false);
    assert.throws(() => parseDashboardArgs(["--host", "0.0.0.0"]), /loopback/);
    assert.throws(() => parseDashboardArgs(["--port", "-1"]), /between 0 and 65535/);
});

test("derives live round, active file, and liveness progress", () => {
    const progress = campaignProgress(campaign(), Date.parse("2026-09-30T16:34:22.000Z"));
    assert.equal(progress.phase, "retry");
    assert.equal(progress.roundProgress.remaining, 2);
    assert.equal(progress.unfinished, 2);
    assert.deepEqual(progress.outcomes, {
        passed: 1,
        failed: 1,
        timed_out: 1,
        mixed: 1,
    });
    assert.equal(progress.heartbeatAgeMs, 2000);
    assert.equal(progress.lastProgressAgeMs, 12_000);
    assert.equal(progress.lastTransitionAgeMs, 7000);
    assert.equal(progress.activeFiles[0].elapsedMs, 22_000);
    assert.equal(progress.activeFiles[0].deadlineRemainingMs, 278_000);
});
