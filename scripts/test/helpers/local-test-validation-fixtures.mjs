import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
    campaignIdentityHash,
    STATE_SCHEMA_VERSION,
} from "../../run-local-test-baseline.mjs";

function attempt(status, durationMs, number = 1) {
    const startedAt = "2026-09-30T16:00:00.000Z";
    const processDeadlineMs = 300_000;
    const effectiveDurationMs = status === "timed_out"
        ? Math.max(durationMs, processDeadlineMs)
        : durationMs;
    return {
        number,
        status,
        collectionStatus: "complete",
        durationMs: effectiveDurationMs,
        reportEvidenceValid: status !== "timed_out",
        reportPath: status === "timed_out" ? null : `reports/${number}.json`,
        reportDigest: status === "timed_out" ? null : `sha256:${"0".repeat(64)}`,
        startedAt,
        deadlineAt: "2026-09-30T16:05:00.000Z",
        finishedAt: new Date(Date.parse(startedAt) + effectiveDurationMs).toISOString(),
        processDeadlineMs,
        timedOut: status === "timed_out",
        exitCode: status === "passed" ? 0 : status === "failed" ? 1 : null,
        testCounts: status === "timed_out"
            ? null
            : {
                total: 1,
                passed: status === "passed" ? 1 : 0,
                failed: status === "failed" ? 1 : 0,
                skipped: 0,
                todo: 0,
            },
        processIdentityVerified: true,
        processIdentity: {
            pid: 1234 + number,
            startedAt: "process-start-identity",
            executable: "node",
        },
        vitestProcessIdentityVerified: true,
        vitestPid: 2234 + number,
        vitestProcessIdentity: {
            pid: 2234 + number,
            startedAt: "vitest-process-start-identity",
            executable: "node",
        },
        timeoutProcessDisposition: status === "timed_out"
            ? "terminated-and-verified"
            : null,
    };
}

export function campaign(commitId, outcomes, controls = {}) {
    const selection = Object.keys(outcomes).sort();
    const runId = `run-${commitId}`;
    const tests = Object.fromEntries(selection.map((file) => {
        const attempts = outcomes[file].map((value, index) => attempt(
            typeof value === "string" ? value : value.status,
            typeof value === "string" ? 100 + index : value.durationMs,
            index + 1,
        )).map((item) => ({ ...item, runId }));
        return [file, {
            status: attempts.at(-1).status,
            collectionStatus: "complete",
            latestDurationMs: attempts.at(-1).durationMs,
            attempts,
        }];
    }));
    const identity = {
        repository: "microsoft/PilotSwarm",
        commitId,
        selection,
        profile: "sdk-local",
        tagsFilter: null,
        providerModelFingerprint: "sha256:provider",
    };
    return {
        schemaVersion: STATE_SCHEMA_VERSION,
        campaignId: campaignIdentityHash(identity),
        status: "complete",
        identity,
        summary: {},
        tests,
        runs: {
            [runId]: {
                runId,
                status: "complete",
                controls: {
                    workers: 8,
                    retryWorkers: 2,
                    retries: 0,
                    timeoutMs: 300_000,
                    all: false,
                    ...controls,
                },
            },
        },
        currentRun: {
            runId,
            status: "complete",
            controls: {
                workers: 8,
                retryWorkers: 2,
                retries: 0,
                timeoutMs: 300_000,
                all: false,
                ...controls,
            },
        },
    };
}

export function materializeReports(directory, value) {
    for (const entry of Object.values(value.tests)) {
        for (const item of entry.attempts) {
            if (!item.reportEvidenceValid) continue;
            const reportPath = path.join(directory, item.reportPath);
            const report = `${JSON.stringify({
                success: item.status === "passed",
                numTotalTestSuites: 1,
                numPassedTestSuites: item.status === "passed" ? 1 : 0,
                numFailedTestSuites: item.status === "failed" ? 1 : 0,
                numPendingTestSuites: 0,
                numTotalTests: 1,
                numPassedTests: item.status === "passed" ? 1 : 0,
                numFailedTests: item.status === "failed" ? 1 : 0,
                numPendingTests: 0,
                numTodoTests: 0,
                testResults: [{
                    status: item.status,
                    assertionResults: [],
                }],
            }, null, 2)}\n`;
            fs.mkdirSync(path.dirname(reportPath), { recursive: true });
            fs.writeFileSync(reportPath, report);
            item.reportDigest = `sha256:${crypto.createHash("sha256")
                .update(report)
                .digest("hex")}`;
        }
    }
}
