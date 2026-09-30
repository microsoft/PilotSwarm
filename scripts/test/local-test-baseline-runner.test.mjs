import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    parseArgs,
    parseDuration,
    parseEnvFile,
    recordAttempt,
    repositoryNameFromRemote,
    selectTests,
    selectedTestsPassed,
    summarizeState,
    syncInventory,
} from "../run-local-test-baseline.mjs";

test("parses runner durations and arguments", () => {
    assert.equal(parseDuration("300"), 300_000);
    assert.equal(parseDuration("2m"), 120_000);
    assert.equal(parseDuration("1.5s"), 1500);
    assert.deepEqual(
        parseArgs([
            "--parallelism=12",
            "--retry-count", "2",
            "--timeout-per-file", "5m",
            "--all",
        ]),
        {
            parallelism: 12,
            retryCount: 2,
            timeoutMs: 300_000,
            output: "pilotswarm-local-test-baseline.json",
            files: [],
            all: true,
            skipBuild: false,
            skipCleanup: false,
            reportOnly: false,
            help: false,
        },
    );
});

test("normalizes repository names from common remote URL formats", () => {
    assert.equal(
        repositoryNameFromRemote("git@github.com:example-org/example-repository.git"),
        "example-org/example-repository",
    );
    assert.equal(
        repositoryNameFromRemote("https://dev.azure.com/contoso/project/_git/repository"),
        "contoso/project/repository",
    );
    assert.equal(
        repositoryNameFromRemote("git@ssh.dev.azure.com:v3/contoso/project/repository"),
        "contoso/project/repository",
    );
    assert.equal(repositoryNameFromRemote(""), "unknown");
});

test("selects non-passing files by default and orders shorter history first", () => {
    const state = {
        tests: {
            "passed.test.js": { status: "passed", latestDurationMs: 1, attempts: [] },
            "slow.test.js": { status: "failed", latestDurationMs: 5000, attempts: [] },
            "new.test.js": { status: "pending", latestDurationMs: null, attempts: [] },
            "fast.test.js": { status: "failed", latestDurationMs: 1000, attempts: [] },
        },
    };
    assert.deepEqual(selectTests(state), ["new.test.js", "fast.test.js", "slow.test.js"]);
    assert.deepEqual(
        selectTests(state, { all: true }),
        ["new.test.js", "passed.test.js", "fast.test.js", "slow.test.js"],
    );
    assert.deepEqual(
        selectTests(state, { files: ["passed.test.js"] }),
        ["passed.test.js"],
    );
    assert.equal(selectedTestsPassed(state, ["passed.test.js"]), true);
    assert.equal(selectedTestsPassed(state, ["passed.test.js", "fast.test.js"]), false);
});

test("preserves history when a removed test returns to the inventory", () => {
    const returning = {
        status: "failed",
        latestDurationMs: 2000,
        attempts: [{ number: 1, status: "failed", durationMs: 2000 }],
    };
    const state = {
        tests: {
            "removed.test.js": { status: "passed", attempts: [] },
        },
        removedTests: {
            "returning.test.js": returning,
        },
    };

    syncInventory(state, ["new.test.js", "returning.test.js"]);

    assert.deepEqual(Object.keys(state.tests), ["new.test.js", "returning.test.js"]);
    assert.equal(state.tests["returning.test.js"], returning);
    assert.equal(state.removedTests["removed.test.js"].status, "passed");
    assert.equal("returning.test.js" in state.removedTests, false);
});

test("records retry history and exposes mixed outcomes as flaky", () => {
    const testedRevision = {
        repository: "example-org/example-repository",
        branch: "main",
        commitId: "abcdef0123456789",
    };
    const state = {
        repository: testedRevision,
        updatedAt: "2026-09-19T00:00:00.000Z",
        tests: {
            "flaky.test.js": {
                status: "failed",
                latestDurationMs: 2000,
                lastRunAt: "2026-09-19",
                notes: "failed",
                attempts: [{
                    number: 1,
                    status: "failed",
                    durationMs: 2000,
                }],
            },
        },
    };
    recordAttempt(state, "flaky.test.js", {
        startedAt: "2026-09-19T00:01:00.000Z",
        finishedAt: "2026-09-19T00:01:01.000Z",
        durationMs: 1000,
        status: "passed",
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "failed </td><script>alert(1)</script>",
        counts: { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0 },
        failures: [],
    }, "run-1", testedRevision);
    const summary = summarizeState(state);
    assert.equal(summary.passed, 1);
    assert.equal(summary.flaky, 1);
    assert.equal(summary.attempts, 2);
    assert.deepEqual(state.tests["flaky.test.js"].attempts[1].testedRevision, testedRevision);
});

test("rejects invalid runner controls", () => {
    assert.throws(() => parseArgs(["--parallelism", "0"]), /positive integer/);
    assert.throws(() => parseArgs(["--retry-count", "-1"]), /non-negative integer/);
    assert.throws(() => parseArgs(["--timeout-per-file", "soon"]), /Invalid duration/);
    assert.throws(() => parseArgs(["--stage"]), /Unknown option/);
    assert.throws(() => parseArgs(["--unknown"]), /Unknown option/);
});

test("loads .env defaults without replacing explicit ambient overrides", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-env-"));
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, "DATABASE_URL=from-file\r\nGITHUB_TOKEN=file-token\r\nFILE_ONLY=yes\r\nHORIZON_DATABASE_URL=clear-me\r\n");
    try {
        const env = parseEnvFile(envPath, {
            DATABASE_URL: "from-ambient",
            GITHUB_TOKEN: "ambient-token",
        });
        assert.equal(env.DATABASE_URL, "from-ambient");
        assert.equal(env.GITHUB_TOKEN, "ambient-token");
        assert.equal(env.FILE_ONLY, "yes");
        assert.equal(env.HORIZON_DATABASE_URL, undefined);
        assert.equal(env.PS_TEST_SKIP_STALE_CLEANUP, "1");
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
