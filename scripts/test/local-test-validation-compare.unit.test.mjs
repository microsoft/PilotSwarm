import test from "node:test";
import assert from "node:assert/strict";
import { compareCampaigns, parseComparisonArgs } from "../compare-local-test-validation.mjs";
import { campaignIdentityHash } from "../run-local-test-baseline.mjs";
import { campaign } from "./helpers/local-test-validation-fixtures.mjs";

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
