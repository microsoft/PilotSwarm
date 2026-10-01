import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compareCampaigns, parseComparisonArgs } from "../compare-local-test-validation.mjs";
import {
    campaignIdentityHash,
    STATE_SCHEMA_VERSION,
} from "../run-local-test-baseline.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_ROOT = path.join(REPO_ROOT, "test-results", "validation-comparison-unit");

function scratch(t) {
    const directory = path.join(TEST_ROOT, crypto.randomUUID());
    fs.mkdirSync(directory, { recursive: true });
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

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
        reportDigest: status === "timed_out"
            ? null
            : `sha256:${"0".repeat(64)}`,
        startedAt,
        deadlineAt: "2026-09-30T16:05:00.000Z",
        finishedAt: new Date(Date.parse(startedAt) + effectiveDurationMs).toISOString(),
        processDeadlineMs,
        timedOut: status === "timed_out",
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

function campaign(commitId, outcomes, controls = {}) {
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

function materializeReports(directory, value) {
    for (const entry of Object.values(value.tests)) {
        for (const item of entry.attempts) {
            if (!item.reportEvidenceValid) continue;
            const reportPath = path.join(directory, item.reportPath);
            const report = `${JSON.stringify({
                numTotalTests: 1,
                numPassedTests: item.status === "passed" ? 1 : 0,
                numFailedTests: item.status === "failed" ? 1 : 0,
                numPendingTests: 0,
                testResults: [],
            }, null, 2)}\n`;
            fs.mkdirSync(path.dirname(reportPath), { recursive: true });
            fs.writeFileSync(reportPath, report);
            item.reportDigest = `sha256:${crypto.createHash("sha256")
                .update(report)
                .digest("hex")}`;
        }
    }
}

test("parses comparison CLI arguments", () => {
    assert.deepEqual(
        parseComparisonArgs([
            "--baseline", "test-results/base/campaign.json",
            "--candidate=test-results/candidate/campaign.json",
            "--output", "test-results/comparison.json",
        ]),
        {
            baseline: "test-results/base/campaign.json",
            candidate: "test-results/candidate/campaign.json",
            output: "test-results/comparison.json",
            help: false,
        },
    );
    assert.throws(() => parseComparisonArgs([]), /required/);
});

test("classifies regressions, fixes, shared failures, stable passes, and mixed evidence", () => {
    const baseline = campaign("base", {
        "regression.test.js": ["passed"],
        "fix.test.js": ["failed"],
        "shared.test.js": ["timed_out"],
        "stable.test.js": ["passed"],
        "mixed.test.js": ["failed", "passed"],
    });
    const candidate = campaign("candidate", {
        "regression.test.js": ["timed_out"],
        "fix.test.js": ["passed"],
        "shared.test.js": ["failed"],
        "stable.test.js": ["passed"],
        "mixed.test.js": ["passed"],
    }, { timeoutMs: 600_000 });
    const comparison = compareCampaigns(
        baseline,
        candidate,
        "2026-09-30T17:00:00.000Z",
    );
    assert.equal(comparison.files["regression.test.js"].classification, "likely-regression");
    assert.equal(comparison.files["fix.test.js"].classification, "likely-fix");
    assert.equal(comparison.files["shared.test.js"].classification, "shared-failure");
    assert.equal(
        comparison.files["stable.test.js"].classification,
        "no-observed-functional-regression",
    );
    assert.equal(comparison.files["mixed.test.js"].classification, "inconclusive");
    assert.match(comparison.comparabilityWarnings.join("\n"), /timeoutMs/);
    assert.equal(comparison.summary.classifications["likely-regression"], 1);
    assert.match(comparison.comparisonId, /^sha256:[a-f0-9]{64}$/);
});

test("comparison controls come from evidence-producing runs, not a later no-op run", () => {
    const baseline = campaign("base", { "file.test.js": ["passed"] });
    const candidate = campaign("candidate", { "file.test.js": ["passed"] });
    const before = compareCampaigns(baseline, candidate);
    candidate.currentRun = {
        runId: "later-no-op",
        status: "complete",
        controls: {
            workers: 99,
            retryWorkers: 99,
            retries: 99,
            timeoutMs: 1,
            all: true,
        },
    };
    const after = compareCampaigns(baseline, candidate);
    assert.deepEqual(after.comparabilityWarnings, before.comparabilityWarnings);
    assert.deepEqual(after.candidate.evidenceControls, before.candidate.evidenceControls);

    const fallbackCandidate = structuredClone(candidate);
    fallbackCandidate.runs = {};
    const fallback = compareCampaigns(baseline, fallbackCandidate);
    assert.equal(fallback.candidate.evidenceControls[0].controls.timeoutMs, 300_000);
    assert.equal(fallback.candidate.evidenceControls[0].controls.workers, null);

    candidate.tests["file.test.js"].attempts.push({
        ...candidate.tests["file.test.js"].attempts[0],
        number: 2,
        runId: "candidate-second-run",
    });
    candidate.runs["candidate-second-run"] = {
        runId: "candidate-second-run",
        status: "complete",
        controls: {
            workers: 1,
            retryWorkers: 1,
            retries: 1,
            timeoutMs: 300_000,
            all: true,
        },
    };
    const heterogeneous = compareCampaigns(baseline, candidate);
    assert.equal(heterogeneous.candidate.evidenceControls.length, 2);
    assert.match(
        heterogeneous.comparabilityWarnings.join("\n"),
        /heterogeneous run controls/,
    );
});

test("includes duration and reliability deltas", () => {
    const baseline = campaign("base", {
        "file.test.js": [{ status: "failed", durationMs: 200 }, { status: "passed", durationMs: 100 }],
    });
    const candidate = campaign("candidate", {
        "file.test.js": [{ status: "passed", durationMs: 180 }],
    });
    const result = compareCampaigns(baseline, candidate);
    assert.equal(result.files["file.test.js"].durationDeltaMs, 80);
    assert.equal(result.files["file.test.js"].reliabilityDelta, 0.5);
    assert.equal(result.files["file.test.js"].classification, "inconclusive");
});

test("rejects incomplete or incompatible campaign evidence", () => {
    const baseline = campaign("base", { "file.test.js": ["passed"] });
    const candidate = campaign("candidate", { "file.test.js": ["failed"] });
    const incomplete = structuredClone(candidate);
    incomplete.status = "failed";
    assert.throws(() => compareCampaigns(baseline, incomplete), /not complete/);

    const incompatible = structuredClone(candidate);
    incompatible.identity.providerModelFingerprint = "sha256:other";
    incompatible.campaignId = campaignIdentityHash(incompatible.identity);
    assert.throws(() => compareCampaigns(baseline, incompatible), /providerModelFingerprint differs/);

    const unsafe = structuredClone(candidate);
    unsafe.tests["file.test.js"].attempts[0].reportEvidenceValid = false;
    assert.throws(() => compareCampaigns(baseline, unsafe), /unsafe native report evidence/);

    const fabricatedTimeout = campaign("timeout", { "file.test.js": ["timed_out"] });
    delete fabricatedTimeout.tests["file.test.js"].attempts[0].timeoutProcessDisposition;
    assert.throws(
        () => compareCampaigns(baseline, fabricatedTimeout),
        /lacks verified cleanup/,
    );

    const forgedIdentity = structuredClone(candidate);
    forgedIdentity.campaignId = `sha256:${"f".repeat(64)}`;
    assert.throws(
        () => compareCampaigns(baseline, forgedIdentity),
        /campaign ID does not match/,
    );
});

test("rejects identical campaign IDs and same-commit evidence", () => {
    const baseline = campaign("same", { "file.test.js": ["passed"] });
    const candidate = campaign("same", { "file.test.js": ["passed"] });
    assert.throws(
        () => compareCampaigns(baseline, candidate),
        /distinct campaigns|distinct commits/,
    );
});

test("comparison CLI exits zero for a valid likely regression and writes the record", (t) => {
    const directory = scratch(t);
    const baselineDirectory = path.join(directory, "baseline");
    const candidateDirectory = path.join(directory, "candidate");
    fs.mkdirSync(baselineDirectory, { recursive: true });
    fs.mkdirSync(candidateDirectory, { recursive: true });
    const baselinePath = path.join(baselineDirectory, "campaign.json");
    const candidatePath = path.join(candidateDirectory, "campaign.json");
    const outputPath = path.join(directory, "comparison.json");
    const baseline = campaign("base", {
        "file.test.js": ["passed"],
    });
    const candidate = campaign("candidate", {
        "file.test.js": ["timed_out"],
    });
    materializeReports(baselineDirectory, baseline);
    materializeReports(candidateDirectory, candidate);
    fs.writeFileSync(baselinePath, JSON.stringify(baseline));
    fs.writeFileSync(candidatePath, JSON.stringify(candidate));
    const result = spawnSync(process.execPath, [
        path.join(REPO_ROOT, "scripts", "compare-local-test-validation.mjs"),
        "--baseline", baselinePath,
        "--candidate", candidatePath,
        "--output", outputPath,
    ], {
        cwd: REPO_ROOT,
        encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const comparison = JSON.parse(fs.readFileSync(outputPath, "utf8"));
    assert.equal(comparison.files["file.test.js"].classification, "likely-regression");

    const reportPath = path.join(baselineDirectory, "reports", "1.json");
    const reportDigestBefore = crypto.createHash("sha256")
        .update(fs.readFileSync(reportPath))
        .digest("hex");
    const collision = spawnSync(process.execPath, [
        path.join(REPO_ROOT, "scripts", "compare-local-test-validation.mjs"),
        "--baseline", baselinePath,
        "--candidate", candidatePath,
        "--output", reportPath,
    ], {
        cwd: REPO_ROOT,
        encoding: "utf8",
    });
    assert.notEqual(collision.status, 0);
    assert.match(collision.stderr, /verified report artifact/);
    assert.equal(
        crypto.createHash("sha256").update(fs.readFileSync(reportPath)).digest("hex"),
        reportDigestBefore,
    );
});

test("comparison CLI rejects missing, tampered, and identical manifest evidence", (t) => {
    const directory = scratch(t);
    const baselineDirectory = path.join(directory, "baseline");
    const candidateDirectory = path.join(directory, "candidate");
    fs.mkdirSync(baselineDirectory, { recursive: true });
    fs.mkdirSync(candidateDirectory, { recursive: true });
    const baselinePath = path.join(baselineDirectory, "campaign.json");
    const candidatePath = path.join(candidateDirectory, "campaign.json");
    const baseline = campaign("base", { "file.test.js": ["passed"] });
    const candidate = campaign("candidate", { "file.test.js": ["failed"] });
    materializeReports(baselineDirectory, baseline);
    materializeReports(candidateDirectory, candidate);
    fs.writeFileSync(baselinePath, JSON.stringify(baseline));
    fs.writeFileSync(candidatePath, JSON.stringify(candidate));

    fs.appendFileSync(path.join(candidateDirectory, "reports", "1.json"), "tampered");
    const tampered = spawnSync(process.execPath, [
        path.join(REPO_ROOT, "scripts", "compare-local-test-validation.mjs"),
        "--baseline", baselinePath,
        "--candidate", candidatePath,
    ], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /digest mismatch/);

    fs.rmSync(path.join(baselineDirectory, "reports", "1.json"));
    const missing = spawnSync(process.execPath, [
        path.join(REPO_ROOT, "scripts", "compare-local-test-validation.mjs"),
        "--baseline", baselinePath,
        "--candidate", candidatePath,
    ], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /artifact.*missing/);

    const identical = spawnSync(process.execPath, [
        path.join(REPO_ROOT, "scripts", "compare-local-test-validation.mjs"),
        "--baseline", baselinePath,
        "--candidate", baselinePath,
    ], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.notEqual(identical.status, 0);
    assert.match(identical.stderr, /manifest paths must be distinct/);
});
