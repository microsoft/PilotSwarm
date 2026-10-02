#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    campaignEvidenceComplete,
    campaignIdentityHash,
    isNativeVitestReport,
    resolveOutputPath,
    STATE_SCHEMA_VERSION,
    trustedAttempts,
} from "./run-local-test-baseline.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const COMPARISON_SCHEMA_VERSION = 1;
const NONPASSING = new Set(["failed", "timed_out"]);

function usage() {
    return `Usage:
  npm run test:validation:compare -- --baseline <campaign.json> --candidate <campaign.json> [options]

Options:
  --baseline <path>   Complete baseline campaign beneath test-results
  --candidate <path>  Complete candidate campaign beneath test-results
  --output <path>     Optional comparison JSON beneath test-results
  --help              Show this help
`;
}

function takeValue(args, index, name) {
    const arg = args[index];
    if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), consumed: 0 };
    if (arg === name) {
        if (index + 1 >= args.length) throw new Error(`${name} requires a value`);
        return { value: args[index + 1], consumed: 1 };
    }
    return null;
}

export function parseComparisonArgs(args) {
    const options = { baseline: null, candidate: null, output: null, help: false };
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        let parsed;
        if ((parsed = takeValue(args, index, "--baseline"))) {
            options.baseline = parsed.value;
            index += parsed.consumed;
        } else if ((parsed = takeValue(args, index, "--candidate"))) {
            options.candidate = parsed.value;
            index += parsed.consumed;
        } else if ((parsed = takeValue(args, index, "--output"))) {
            options.output = parsed.value;
            index += parsed.consumed;
        } else if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }
    if (!options.help && (!options.baseline || !options.candidate)) {
        throw new Error("--baseline and --candidate are required");
    }
    return options;
}

function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
        );
    }
    return value;
}

function stableJson(value) {
    return JSON.stringify(stableValue(value));
}

function evidenceProducingControls(campaign) {
    const grouped = new Map();
    for (const file of campaign.identity.selection ?? []) {
        for (const attempt of trustedAttempts(campaign.tests?.[file])) {
            if (!attempt.runId) {
                throw new Error(`Trusted attempt for ${file} has no runId provenance`);
            }
            const group = grouped.get(attempt.runId) ?? {
                runId: attempt.runId,
                files: new Set(),
                attemptCount: 0,
                processDeadlines: new Set(),
            };
            group.files.add(file);
            group.attemptCount++;
            if (Number.isFinite(attempt.processDeadlineMs)) {
                group.processDeadlines.add(attempt.processDeadlineMs);
            }
            grouped.set(attempt.runId, group);
        }
    }
    return [...grouped.values()]
        .sort((left, right) => left.runId.localeCompare(right.runId))
        .map((group) => {
            const run = campaign.runs?.[group.runId]
                ?? (campaign.currentRun?.runId === group.runId ? campaign.currentRun : null);
            const observedProcessDeadlines = [...group.processDeadlines].sort((a, b) => a - b);
            const controls = {
                workers: run?.controls?.workers ?? null,
                retryWorkers: run?.controls?.retryWorkers ?? null,
                retries: run?.controls?.retries ?? null,
                timeoutMs: run?.controls?.timeoutMs
                    ?? (observedProcessDeadlines.length === 1
                        ? observedProcessDeadlines[0]
                        : null),
                all: run?.controls?.all ?? null,
            };
            return {
                runId: group.runId,
                controls,
                observedProcessDeadlines,
                timeoutControlMismatch: controls.timeoutMs != null
                    && observedProcessDeadlines.some(
                        (deadline) => deadline !== controls.timeoutMs,
                    ),
                files: [...group.files].sort(),
                attemptCount: group.attemptCount,
            };
        });
}

function campaignDescriptor(campaign, evidenceControls) {
    return {
        campaignId: campaign.campaignId,
        repository: campaign.identity.repository,
        commitId: campaign.identity.commitId,
        status: campaign.status,
        summary: campaign.summary,
        evidenceControls,
    };
}

function normalizedPath(value) {
    const normalized = path.resolve(value).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathIsInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return Boolean(relative)
        && relative !== ".."
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

export function verifyReportArtifact(attempt, {
    manifestDirectory,
    label,
    file,
}) {
    if (!manifestDirectory) throw new Error(`${label} manifest directory is required`);
    if (!attempt.reportPath || path.isAbsolute(attempt.reportPath)) {
        throw new Error(`${label} report path for ${file} must be relative to its manifest`);
    }
    if (!/^sha256:[a-f0-9]{64}$/i.test(attempt.reportDigest ?? "")) {
        throw new Error(`${label} report digest for ${file} is missing or invalid`);
    }
    const canonicalDirectory = fs.realpathSync(manifestDirectory);
    const requestedPath = path.resolve(canonicalDirectory, attempt.reportPath);
    if (!pathIsInside(canonicalDirectory, requestedPath)) {
        throw new Error(`${label} report path for ${file} escapes its campaign directory`);
    }
    if (!fs.existsSync(requestedPath)) {
        throw new Error(`${label} report artifact for ${file} is missing`);
    }
    const canonicalReportPath = fs.realpathSync(requestedPath);
    if (!pathIsInside(canonicalDirectory, canonicalReportPath)) {
        throw new Error(`${label} report artifact for ${file} resolves outside its campaign directory`);
    }
    if (!fs.statSync(canonicalReportPath).isFile()) {
        throw new Error(`${label} report artifact for ${file} is not a file`);
    }
    const actualDigest = `sha256:${crypto.createHash("sha256")
        .update(fs.readFileSync(canonicalReportPath))
        .digest("hex")}`;
    if (actualDigest.toLowerCase() !== attempt.reportDigest.toLowerCase()) {
        throw new Error(`${label} report artifact digest mismatch for ${file}`);
    }
    return canonicalReportPath;
}

function validateAttemptOutcome(attempt, report, label, file) {
    if (!isNativeVitestReport(report)
        || typeof report.success !== "boolean"
        || !Number.isFinite(report.numFailedTestSuites)) {
        throw new Error(`${label} native report outcome is invalid for ${file}`);
    }
    const reportFailed = report.success === false
        || report.numFailedTests > 0
        || report.numFailedTestSuites > 0
        || report.testResults.some((suite) => suite.status === "failed");
    if (attempt.status === "passed") {
        if (attempt.exitCode !== 0 || reportFailed) {
            throw new Error(`${label} attempt outcome does not match its native report for ${file}`);
        }
    } else if (attempt.status === "failed") {
        if (!Number.isInteger(attempt.exitCode)
            || attempt.exitCode === 0
            || !reportFailed) {
            throw new Error(`${label} attempt outcome does not match its native report for ${file}`);
        }
    }
    const expectedCounts = {
        total: report.numTotalTests,
        passed: report.numPassedTests,
        failed: report.numFailedTests,
        skipped: report.numPendingTests,
        todo: report.numTodoTests ?? 0,
    };
    for (const [key, value] of Object.entries(expectedCounts)) {
        if (attempt.testCounts?.[key] !== value) {
            throw new Error(`${label} attempt test counts do not match its native report for ${file}`);
        }
    }
}

function validateTimeoutEvidence(attempt, label, file) {
    const started = Date.parse(attempt.startedAt);
    const deadline = Date.parse(attempt.deadlineAt);
    const finished = Date.parse(attempt.finishedAt);
    if (!Number.isFinite(started)
        || !Number.isFinite(deadline)
        || !Number.isFinite(finished)
        || deadline <= started
        || finished < deadline) {
        throw new Error(`${label} timeout evidence has invalid timestamps for ${file}`);
    }
    if (!Number.isFinite(attempt.durationMs)
        || attempt.durationMs < 0
        || !Number.isFinite(attempt.processDeadlineMs)
        || attempt.processDeadlineMs <= 0
        || deadline - started !== attempt.processDeadlineMs
        || attempt.durationMs < attempt.processDeadlineMs
        || Math.abs((finished - started) - attempt.durationMs) > 1_000) {
        throw new Error(`${label} timeout evidence has inconsistent durations for ${file}`);
    }
    if (attempt.timedOut !== true
        || attempt.processIdentityVerified !== true
        || attempt.timeoutProcessDisposition !== "terminated-and-verified") {
        throw new Error(`${label} timeout evidence lacks verified cleanup for ${file}`);
    }
    const identity = attempt.processIdentity;
    const vitestIdentity = attempt.vitestProcessIdentity;
    if (!identity
        || !Number.isInteger(identity.pid)
        || identity.pid < 1
        || !identity.startedAt
        || attempt.vitestProcessIdentityVerified !== true
        || !vitestIdentity
        || !Number.isInteger(vitestIdentity.pid)
        || vitestIdentity.pid < 1
        || !vitestIdentity.startedAt) {
        throw new Error(`${label} timeout evidence lacks a verified process identity for ${file}`);
    }
}

function validateCampaign(campaign, label, {
    manifestDirectory = null,
    evidenceResolver = null,
    requireArtifacts = false,
    verifiedArtifacts = null,
} = {}) {
    if (!campaign || typeof campaign !== "object") throw new Error(`${label} campaign is invalid`);
    if (campaign.schemaVersion !== STATE_SCHEMA_VERSION) {
        throw new Error(`${label} campaign schema ${campaign.schemaVersion} is not comparable`);
    }
    if (campaign.status !== "complete") {
        throw new Error(`${label} campaign collection is not complete`);
    }
    const selection = campaign.identity?.selection;
    if (!Array.isArray(selection) || selection.length === 0) {
        throw new Error(`${label} campaign has no resolved selection`);
    }
    if (!campaign.campaignId || !campaign.identity.repository || !campaign.identity.commitId) {
        throw new Error(`${label} campaign identity is incomplete`);
    }
    if (campaign.campaignId !== campaignIdentityHash(campaign.identity)) {
        throw new Error(`${label} campaign ID does not match its campaign identity`);
    }
    if (!campaignEvidenceComplete(campaign, selection)) {
        throw new Error(`${label} campaign contains incomplete evidence`);
    }
    for (const file of selection) {
        const attempts = trustedAttempts(campaign.tests?.[file]);
        if (attempts.length === 0) throw new Error(`${label} has insufficient evidence for ${file}`);
        for (const attempt of attempts) {
            if (attempt.status === "timed_out") {
                validateTimeoutEvidence(attempt, label, file);
            } else if (!attempt.reportEvidenceValid
                || !attempt.reportPath
                || !attempt.reportDigest) {
                throw new Error(`${label} has unsafe native report evidence for ${file}`);
            }
            if (attempt.reportEvidenceValid) {
                const resolver = evidenceResolver ?? (manifestDirectory
                    ? (candidate) => verifyReportArtifact(candidate, {
                        manifestDirectory,
                        label,
                        file,
                    })
                    : null);
                if (resolver) {
                    const verifiedPath = resolver(attempt, {
                        campaign,
                        manifestDirectory,
                        label,
                        file,
                    });
                    if (verifiedPath && verifiedArtifacts) {
                        verifiedArtifacts.add(fs.realpathSync(verifiedPath));
                    }
                    if (verifiedPath) {
                        let report;
                        try {
                            report = JSON.parse(fs.readFileSync(verifiedPath, "utf8"));
                        } catch {
                            throw new Error(`${label} native report cannot be parsed for ${file}`);
                        }
                        validateAttemptOutcome(attempt, report, label, file);
                    }
                } else if (requireArtifacts) {
                    throw new Error(`${label} report artifacts cannot be verified`);
                }
            }
        }
    }
}

function entryEvidence(entry) {
    const attempts = trustedAttempts(entry);
    const outcomes = [...new Set(attempts.map((attempt) => attempt.status))].sort();
    const latest = attempts.at(-1) ?? null;
    const passed = attempts.filter((attempt) => attempt.status === "passed").length;
    return {
        latestStatus: latest?.status ?? null,
        latestDurationMs: latest?.durationMs ?? null,
        attempts: attempts.length,
        passRate: attempts.length > 0 ? passed / attempts.length : null,
        mixed: outcomes.length > 1,
        outcomes,
    };
}

function classify(baseline, candidate) {
    if (!baseline.latestStatus || !candidate.latestStatus || baseline.mixed || candidate.mixed) {
        return "inconclusive";
    }
    if (baseline.latestStatus === "passed" && NONPASSING.has(candidate.latestStatus)) {
        return "likely-regression";
    }
    if (NONPASSING.has(baseline.latestStatus) && candidate.latestStatus === "passed") {
        return "likely-fix";
    }
    if (NONPASSING.has(baseline.latestStatus) && NONPASSING.has(candidate.latestStatus)) {
        return "shared-failure";
    }
    if (baseline.latestStatus === "passed" && candidate.latestStatus === "passed") {
        return "no-observed-functional-regression";
    }
    return "inconclusive";
}

function comparabilityWarnings(baselineControls, candidateControls) {
    const warnings = [];
    const controlProfiles = (records) => [...new Set(
        records.map((record) => stableJson(record.controls)),
    )].sort();
    const leftProfiles = controlProfiles(baselineControls);
    const rightProfiles = controlProfiles(candidateControls);
    if (stableJson(leftProfiles) !== stableJson(rightProfiles)) {
        warnings.push(
            "Evidence-producing run controls differ between baseline and candidate: "
            + `${leftProfiles.join(" | ")} vs ${rightProfiles.join(" | ")}`,
        );
    }
    if (leftProfiles.length > 1) {
        warnings.push("Baseline evidence was produced with heterogeneous run controls");
    }
    if (rightProfiles.length > 1) {
        warnings.push("Candidate evidence was produced with heterogeneous run controls");
    }
    for (const record of [...baselineControls, ...candidateControls]) {
        if (record.timeoutControlMismatch) {
            warnings.push(
                `Run ${record.runId} timeout control differs from attempt process deadlines`,
            );
        }
    }
    return warnings;
}

export function compareCampaigns(
    baseline,
    candidate,
    now = new Date().toISOString(),
    evidenceOptions = {},
) {
    validateCampaign(baseline, "Baseline", {
        manifestDirectory: evidenceOptions.baselineManifestDirectory,
        evidenceResolver: evidenceOptions.evidenceResolver,
        requireArtifacts: evidenceOptions.requireArtifacts,
        verifiedArtifacts: evidenceOptions.verifiedArtifacts,
    });
    validateCampaign(candidate, "Candidate", {
        manifestDirectory: evidenceOptions.candidateManifestDirectory,
        evidenceResolver: evidenceOptions.evidenceResolver,
        requireArtifacts: evidenceOptions.requireArtifacts,
        verifiedArtifacts: evidenceOptions.verifiedArtifacts,
    });
    if (baseline.campaignId === candidate.campaignId) {
        throw new Error("Baseline and candidate must be distinct campaigns");
    }
    if (baseline.identity.commitId === candidate.identity.commitId) {
        throw new Error("Baseline and candidate must reference distinct commits");
    }
    const semanticKeys = ["repository", "selection", "profile", "tagsFilter", "providerModelFingerprint"];
    for (const key of semanticKeys) {
        if (stableJson(baseline.identity[key]) !== stableJson(candidate.identity[key])) {
            throw new Error(`Campaigns are incompatible: ${key} differs`);
        }
    }
    const baselineControls = evidenceProducingControls(baseline);
    const candidateControls = evidenceProducingControls(candidate);

    const files = {};
    const classificationCounts = {};
    for (const file of [...baseline.identity.selection].sort()) {
        const baselineEvidence = entryEvidence(baseline.tests[file]);
        const candidateEvidence = entryEvidence(candidate.tests[file]);
        const classification = classify(baselineEvidence, candidateEvidence);
        classificationCounts[classification] = (classificationCounts[classification] ?? 0) + 1;
        files[file] = {
            classification,
            baseline: baselineEvidence,
            candidate: candidateEvidence,
            durationDeltaMs: baselineEvidence.latestDurationMs == null
                || candidateEvidence.latestDurationMs == null
                ? null
                : candidateEvidence.latestDurationMs - baselineEvidence.latestDurationMs,
            reliabilityDelta: baselineEvidence.passRate == null
                || candidateEvidence.passRate == null
                ? null
                : candidateEvidence.passRate - baselineEvidence.passRate,
        };
    }
    const identity = {
        baselineCampaignId: baseline.campaignId,
        baselineCommitId: baseline.identity.commitId,
        candidateCampaignId: candidate.campaignId,
        candidateCommitId: candidate.identity.commitId,
    };
    return {
        schemaVersion: COMPARISON_SCHEMA_VERSION,
        type: "local-test-validation-comparison",
        comparisonId: `sha256:${crypto.createHash("sha256").update(stableJson(identity)).digest("hex")}`,
        createdAt: now,
        baseline: campaignDescriptor(baseline, baselineControls),
        candidate: campaignDescriptor(candidate, candidateControls),
        comparabilityWarnings: comparabilityWarnings(baselineControls, candidateControls),
        summary: {
            totalFiles: baseline.identity.selection.length,
            classifications: classificationCounts,
        },
        files,
    };
}

function atomicWrite(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    try {
        fs.chmodSync(filePath, 0o600);
    } catch {}
}

async function main() {
    const options = parseComparisonArgs(process.argv.slice(2));
    if (options.help) {
        console.log(usage());
        return;
    }
    const baselinePath = resolveOutputPath(options.baseline, undefined, "--baseline");
    const candidatePath = resolveOutputPath(options.candidate, undefined, "--candidate");
    if (!fs.existsSync(baselinePath)) throw new Error(`Baseline campaign not found: ${options.baseline}`);
    if (!fs.existsSync(candidatePath)) throw new Error(`Candidate campaign not found: ${options.candidate}`);
    const canonicalBaselinePath = fs.realpathSync(baselinePath);
    const canonicalCandidatePath = fs.realpathSync(candidatePath);
    if (normalizedPath(canonicalBaselinePath) === normalizedPath(canonicalCandidatePath)) {
        throw new Error("Baseline and candidate manifest paths must be distinct");
    }
    const baseline = JSON.parse(fs.readFileSync(canonicalBaselinePath, "utf8"));
    const candidate = JSON.parse(fs.readFileSync(canonicalCandidatePath, "utf8"));
    const verifiedArtifacts = new Set();
    const comparison = compareCampaigns(
        baseline,
        candidate,
        new Date().toISOString(),
        {
            baselineManifestDirectory: path.dirname(canonicalBaselinePath),
            candidateManifestDirectory: path.dirname(canonicalCandidatePath),
            requireArtifacts: true,
            verifiedArtifacts,
        },
    );
    if (options.output) {
        const outputPath = resolveOutputPath(options.output);
        if ([canonicalBaselinePath, canonicalCandidatePath]
            .some((manifestPath) => normalizedPath(manifestPath) === normalizedPath(outputPath))
            || [...verifiedArtifacts].some(
                (artifactPath) => normalizedPath(artifactPath) === normalizedPath(outputPath),
            )) {
            throw new Error(
                "Comparison output must not overwrite a campaign manifest or verified report artifact",
            );
        }
        atomicWrite(outputPath, comparison);
        console.log(`Comparison written: ${path.relative(REPO_ROOT, outputPath)}`);
    } else {
        process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
    }
}

const invokedDirectly = process.argv[1]
    && fs.realpathSync(path.resolve(process.argv[1])).toLowerCase()
        === fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase();
if (invokedDirectly) {
    main().catch((error) => {
        console.error(`ERROR: ${error.stack || error.message || error}`);
        process.exitCode = 1;
    });
}
