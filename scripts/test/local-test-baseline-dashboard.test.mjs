import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    campaignProgress,
    createDashboardServer,
    isLoopbackHost,
    parseDashboardArgs,
} from "../serve-local-test-baseline.mjs";

const TEST_ROOT = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "test-results",
    "validation-dashboard-unit",
);

function scratch(t) {
    const dir = path.join(TEST_ROOT, crypto.randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

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
    assert.equal(progress.activeFiles[0].elapsedMs, 22_000);
    assert.equal(progress.activeFiles[0].deadlineRemainingMs, 278_000);
});

test("serves live results, private health, progress API, and assets", async (t) => {
    const dir = scratch(t);
    const resultsPath = path.join(dir, "campaign.json");
    fs.writeFileSync(resultsPath, JSON.stringify(campaign()));
    const server = createDashboardServer({ resultsPath });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${address.port}`;
    try {
        const health = await fetch(`${base}/api/health`).then((response) => response.json());
        assert.equal(health.ok, true);
        assert.equal(health.resultsAvailable, true);
        assert.equal(health.progress.roundProgress.remaining, 2);
        assert.equal("resultsPath" in health, false);
        assert.doesNotMatch(JSON.stringify(health), new RegExp(
            resultsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        ));

        const status = await fetch(`${base}/api/status`).then((response) => response.json());
        assert.equal(status.progress.activeFiles[0].file, "slow.test.js");

        const first = await fetch(`${base}/api/results`).then((response) => response.json());
        assert.equal(first.summary.passed, 1);
        const updated = campaign();
        updated.summary.passed = 2;
        fs.writeFileSync(resultsPath, JSON.stringify(updated));
        const second = await fetch(`${base}/api/results`).then((response) => response.json());
        assert.equal(second.summary.passed, 2);

        const html = await fetch(base).then((response) => response.text());
        assert.match(html, /id="live-cards"/);
        assert.match(html, /id="result-filter" multiple/);
        assert.match(html, /value="timed_out"/);

        const app = await fetch(`${base}/app.js`).then((response) => response.text());
        assert.match(app, /renderLive/);
        assert.match(app, /heartbeatAt/);
        assert.match(app, /deadlineAt/);
        assert.match(app, /Timed out/);
        assert.match(app, /row\.timedOut/);

        const missing = await fetch(`${base}/missing`);
        assert.equal(missing.status, 404);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
