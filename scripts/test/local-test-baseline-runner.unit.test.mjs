import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    acquireExecutionLock,
    assertCompatibleCampaign,
    beginAttempt,
    campaignEvidenceComplete,
    campaignIdentitiesMatch,
    campaignIdentityHash,
    classifyAttemptEvidence,
    cleanGeneratedBuildOutputs,
    completeAttempt,
    createCampaignIdentity,
    createRoundState,
    createVitestListArgs,
    dirtyWorktreeEntries,
    fallbackFailureSummary,
    incompleteRetryTarget,
    markRoundFileCompleted,
    markRoundFileStarted,
    markRoundStarted,
    orderFilesForScheduling,
    parseArgs,
    parseDuration,
    parseEnvFile,
    parseVitestListJson,
    planAllRecoverySequence,
    planDefaultObservationFiles,
    planRecoveryRounds,
    planRetryFiles,
    planRetryTargetFiles,
    prepareCampaignEnvironment,
    processIdentitiesMatch,
    providerModelFingerprint,
    providerRedactionSecrets,
    reconcileActiveEntries,
    reconcileStaleRun,
    redactActiveReports,
    redactNativeReport,
    redactSensitiveText,
    refreshProviderRedactionSecrets,
    releaseExecutionLock,
    resolveReportArtifactPath,
    repositoryNameFromRemote,
    resolveOutputPath,
    retainVitestReport,
    schedulingDurationMs,
    summarizeState,
    superviseProcessDeadline,
    trustedAttempts,
    validateSemanticFingerprint,
    validateSourceSnapshot,
    validateExplicitFiles,
    verifyRetainedCampaignReports,
    waitForProcessIdentity,
} from "../run-local-test-baseline.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TEST_ROOT = path.resolve(
    REPO_ROOT,
    "test-results",
    "validation-harness-unit",
);

function scratch(t) {
    const dir = path.join(TEST_ROOT, crypto.randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

test("parses user-facing runner controls, aliases, and default path", () => {
    assert.equal(parseDuration("300"), 300_000);
    assert.equal(parseDuration("2m"), 120_000);
    assert.equal(parseDuration("1.5s"), 1500);
    assert.deepEqual(
        parseArgs([
            "--workers=12",
            "--retry-workers", "3",
            "--retries", "2",
            "--timeout", "5m",
            "--file", "test/local/smoke-basic.test.js",
            "--tags", "live && !slow",
            "--all",
            "--fresh",
        ]),
        {
            workers: 12,
            retryWorkers: 3,
            retries: 2,
            timeoutMs: 300_000,
            output: "test-results/local-test-validation/campaign.json",
            files: ["smoke-basic.test.js"],
            profile: "sdk-local",
            tagsFilter: "live && !slow",
            all: true,
            fresh: true,
            skipCleanup: false,
            reportOnly: false,
            help: false,
        },
    );
    const aliases = parseArgs([
        "--parallelism", "4",
        "--retry-count=1",
        "--timeout-per-file", "30s",
    ]);
    assert.equal(aliases.workers, 4);
    assert.equal(aliases.retries, 1);
    assert.equal(aliases.timeoutMs, 30_000);
    assert.throws(
        () => parseArgs(["--skip-build"]),
        /campaign evidence must be built from the tested commit/,
    );
});

test("normalizes Vitest file-list JSON to test/local-relative IDs", (t) => {
    const localDir = path.join(scratch(t), "packages", "sdk", "test", "local");
    const first = path.join(localDir, "nested", "alpha.test.js");
    const second = path.join(localDir, "beta.test.js");
    assert.deepEqual(
        parseVitestListJson(JSON.stringify([{ file: first }, { file: second }, { file: first }]), localDir),
        ["beta.test.js", "nested/alpha.test.js"],
    );
    assert.throws(
        () => parseVitestListJson([{ file: path.join(localDir, "..", "unit.test.js") }], localDir),
        /outside test\/local/,
    );
});

test("uses a relative Vitest JSON output argument on Windows-safe discovery", (t) => {
    const output = path.join(scratch(t), "inventory.json");
    const args = createVitestListArgs(output, { files: ["smoke-basic.test.js"], tagsFilter: null });
    const jsonArg = args.find((arg) => arg.startsWith("--json="));
    assert.match(jsonArg, /^--json=\.\.\/\.\.\/test-results\//);
    assert.doesNotMatch(jsonArg, /^[^=]*=[A-Za-z]:/);
    assert.equal(args.at(-1), "test/local/smoke-basic.test.js");
});

test("removes ignored generated output before campaign builds", (t) => {
    const repoRoot = scratch(t);
    const sdkDist = path.join(repoRoot, "packages", "sdk", "dist");
    const mcpDist = path.join(repoRoot, "packages", "app", "mcp", "dist");
    const unrelated = path.join(repoRoot, "packages", "app", "web", "dist");
    for (const output of [sdkDist, mcpDist, unrelated]) {
        fs.mkdirSync(output, { recursive: true });
        fs.writeFileSync(path.join(output, "stale.js"), "stale");
    }

    cleanGeneratedBuildOutputs(repoRoot);

    assert.equal(fs.existsSync(sdkDist), false);
    assert.equal(fs.existsSync(mcpDist), false);
    assert.equal(fs.existsSync(unrelated), true);
});

test("preserves exact explicit-file validation", () => {
    assert.doesNotThrow(() => validateExplicitFiles(
        ["a.test.js", "nested/b.test.js"],
        ["nested/b.test.js", "a.test.js"],
    ));
    assert.throws(
        () => validateExplicitFiles(["a.test.js"], ["a.test.js", "also-a.test.js"]),
        /unexpected: also-a\.test\.js/,
    );
    assert.throws(
        () => validateExplicitFiles(["missing.test.js"], []),
        /missing: missing\.test\.js/,
    );
});

test("campaign identity includes semantic inputs but excludes operational controls and branch", () => {
    const base = {
        repository: "microsoft/PilotSwarm",
        commitId: "0123456789abcdef",
        selection: ["b.test.js", "a.test.js"],
        profile: "sdk-local",
        tagsFilter: "live",
        providerFingerprint: "sha256:provider",
    };
    const identity = createCampaignIdentity(base);
    const same = createCampaignIdentity({ ...base, selection: ["a.test.js", "b.test.js"] });
    assert.deepEqual(identity.selection, ["a.test.js", "b.test.js"]);
    assert.equal(campaignIdentitiesMatch(identity, same), true);
    assert.equal(campaignIdentityHash(identity), campaignIdentityHash(same));
    assert.equal("branch" in identity, false);
    assert.equal("workers" in identity, false);

    const different = createCampaignIdentity({ ...base, commitId: "fedcba9876543210" });
    assert.equal(campaignIdentitiesMatch(identity, different), false);
    assert.throws(
        () => assertCompatibleCampaign(
            { schemaVersion: 6, identity },
            different,
            "test-results/local-test-validation/campaign.json",
        ),
        /--fresh.*alternate --output/s,
    );
});

test("semantic fingerprint covers model and skip environment inputs without credential rotation", (t) => {
    const dir = scratch(t);
    const configPath = path.join(dir, "providers.json");
    const write = (apiKey, model) => fs.writeFileSync(configPath, JSON.stringify({
        providers: [{ id: "fixture", type: "openai", apiKey, baseUrl: "https://example.test", models: [model] }],
        defaultModel: `fixture:${model}`,
    }));
    write("first-secret", "model-a");
    const baseEnv = {
        PS_MODEL_PROVIDERS_PATH: configPath,
        PS_TEST_FORCE_MODEL: "model-a",
        PILOTSWARM_LIVE_MODEL_TESTS: "0",
        GITHUB_TOKEN: "credential-one",
        LLM_ENDPOINT: "https://models.example.test/v1?api_key=endpoint-one",
    };
    const first = providerModelFingerprint(baseEnv);
    write("rotated-secret", "model-a");
    const rotated = providerModelFingerprint(baseEnv);
    assert.equal(first, rotated);
    assert.equal(first, providerModelFingerprint({
        ...baseEnv,
        GITHUB_TOKEN: "credential-two",
        LLM_ENDPOINT: "https://models.example.test/v1?api_key=endpoint-two",
    }));
    assert.notEqual(first, providerModelFingerprint({
        ...baseEnv,
        GITHUB_TOKEN: "",
    }));
    write("rotated-secret", "model-b");
    const changed = providerModelFingerprint(baseEnv);
    assert.notEqual(first, changed);
    write("third-secret", "model-a");
    assert.notEqual(first, providerModelFingerprint({
        ...baseEnv,
        PS_TEST_FORCE_MODEL: "model-b",
    }));
    assert.notEqual(first, providerModelFingerprint({
        ...baseEnv,
        PILOTSWARM_LIVE_MODEL_TESTS: "1",
    }));
    assert.notEqual(first, providerModelFingerprint({
        ...baseEnv,
        PS_ENABLE_LIVE_DEHYDRATE_TESTS: "1",
    }));
    assert.equal(
        providerModelFingerprint({ MODEL_PROVIDERS_PATH: configPath }),
        providerModelFingerprint({ PS_MODEL_PROVIDERS_PATH: configPath }),
    );
    assert.match(first, /^sha256:[a-f0-9]{64}$/);
});

test("each documented SDK selection and model environment input changes the fingerprint", (t) => {
    const configPath = path.join(scratch(t), "providers.json");
    fs.writeFileSync(configPath, JSON.stringify({
        providers: [{ id: "fixture", type: "openai", models: ["model-a"] }],
        defaultModel: "fixture:model-a",
    }));
    const base = { PS_MODEL_PROVIDERS_PATH: configPath };
    const baseline = providerModelFingerprint(base);
    const semanticInputs = {
        PS_TEST_FORCE_MODEL: "model-a",
        TEST_FORCE_MODEL: "model-a",
        PS_INTERRUPT_TEST_MODEL: "model-a",
        PILOTSWARM_LIVE_MODEL_TESTS: "1",
        LLM_PROVIDER_TYPE: "azure",
        LLM_MODELS: "model-a,model-b",
        COPILOT_MODEL: "model-a",
        MODEL_PROVIDER: "fixture",
    };
    for (const [key, value] of Object.entries(semanticInputs)) {
        assert.notEqual(
            baseline,
            providerModelFingerprint({ ...base, [key]: value }),
            key,
        );
    }
});

test("provider redaction secrets resolve custom env references and direct literals", (t) => {
    const dir = scratch(t);
    const configPath = path.join(dir, "providers.json");
    const write = (directSecret) => fs.writeFileSync(configPath, JSON.stringify({
        providers: [{
            id: "custom",
            type: "openai",
            apiKey: "env:CUSTOM_PROVIDER_CREDENTIAL",
            bearerToken: directSecret,
            baseUrl: "https://provider.example.test/v1?api_key=url-provider-secret",
            models: ["model-a"],
        }],
        defaultModel: "custom:model-a",
    }));
    write("direct-provider-secret");
    const env = {
        PS_MODEL_PROVIDERS_PATH: configPath,
        CUSTOM_PROVIDER_CREDENTIAL: "custom-env-secret",
    };
    const secrets = providerRedactionSecrets(env);
    assert.deepEqual(
        [...secrets].sort(),
        ["custom-env-secret", "direct-provider-secret", "url-provider-secret"],
    );
    const redacted = redactSensitiveText(
        "custom-env-secret direct-provider-secret",
        env,
        secrets,
    );
    assert.equal(redacted, "*** ***");
    const reportPath = path.join(dir, "provider-report.json");
    fs.writeFileSync(reportPath, JSON.stringify({
        message: "custom-env-secret direct-provider-secret",
    }));
    redactNativeReport(reportPath, env, secrets, dir);
    assert.doesNotMatch(
        fs.readFileSync(reportPath, "utf8"),
        /custom-env-secret|direct-provider-secret/,
    );
    const before = providerModelFingerprint(env);
    assert.equal(before, providerModelFingerprint({
        ...env,
        CUSTOM_PROVIDER_CREDENTIAL: "rotated-custom-secret",
    }));
    write("rotated-direct-secret");
    refreshProviderRedactionSecrets(secrets, env);
    assert.equal(secrets.has("rotated-direct-secret"), true);
    assert.equal(secrets.has("direct-provider-secret"), true);
    assert.equal(before, providerModelFingerprint(env));
    assert.notEqual(before, providerModelFingerprint({
        PS_MODEL_PROVIDERS_PATH: configPath,
    }));
});

test("restricts campaign output and reports to repository test-results", (t) => {
    const dir = scratch(t);
    const repoRoot = path.resolve(dir, "repo");
    fs.mkdirSync(path.join(repoRoot, "test-results"), { recursive: true });
    const relative = resolveOutputPath("test-results/campaign-a/campaign.json", repoRoot);
    assert.equal(relative, path.join(fs.realpathSync(repoRoot), "test-results", "campaign-a", "campaign.json"));
    const absolute = resolveOutputPath(path.join(repoRoot, "test-results", "campaign-b.json"), repoRoot);
    assert.equal(absolute, path.join(fs.realpathSync(repoRoot), "test-results", "campaign-b.json"));
    if (process.platform === "win32") {
        assert.equal(
            resolveOutputPath(
                path.join(repoRoot, "test-results", "Campaign-C.json").toUpperCase(),
                repoRoot,
            ).toLowerCase(),
            path.join(fs.realpathSync(repoRoot), "test-results", "campaign-c.json").toLowerCase(),
        );
    }
    assert.throws(() => resolveOutputPath("../campaign.json", repoRoot), /beneath.*test-results/);
    assert.throws(() => resolveOutputPath("test-results", repoRoot), /beneath.*test-results/);
    assert.throws(() => resolveOutputPath(repoRoot, repoRoot), /beneath.*test-results/);
    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    try {
        fs.symlinkSync(
            outside,
            path.join(repoRoot, "test-results", "linked-outside"),
            process.platform === "win32" ? "junction" : "dir",
        );
        assert.throws(
            () => resolveOutputPath(
                "test-results/linked-outside/campaign.json",
                repoRoot,
            ),
            /beneath.*test-results|outside test-results through a linked directory/,
        );
    } catch (error) {
        if (!["EPERM", "EACCES"].includes(error.code)) throw error;
        t.diagnostic(`Symlink containment check skipped: ${error.code}`);
    }
});

test("report artifact containment rejects a symlink or junction escape before writing", (t) => {
    const dir = scratch(t);
    const campaignDir = path.join(dir, "campaign");
    const outside = path.join(dir, "outside");
    fs.mkdirSync(campaignDir);
    fs.mkdirSync(outside);
    const linkedReports = path.join(campaignDir, "reports");
    try {
        fs.symlinkSync(
            outside,
            linkedReports,
            process.platform === "win32" ? "junction" : "dir",
        );
    } catch (error) {
        if (["EPERM", "EACCES"].includes(error.code)) {
            t.skip(`Symlink creation unavailable: ${error.code}`);
            return;
        }
        throw error;
    }
    const requested = path.join(linkedReports, "attempt.json");
    assert.throws(
        () => resolveReportArtifactPath(campaignDir, requested, { createParent: true }),
        /resolves outside the campaign output directory/,
    );
    assert.equal(fs.existsSync(path.join(outside, "attempt.json")), false);
});

test("campaign lock refuses live owners, recovers stale locks, and releases only its owner", (t) => {
    const output = path.join(scratch(t), "campaign.json");
    const firstOwner = {
        token: "owner-1",
        runId: "run-1",
        processIdentity: { pid: 101, startedAt: "one", executable: "node" },
    };
    const first = acquireExecutionLock(output, firstOwner, {
        inspectProcess: () => ({ pid: 101, startedAt: "one", executable: "node" }),
    });
    assert.throws(
        () => acquireExecutionLock(output, {
            token: "owner-2",
            runId: "run-2",
            processIdentity: { pid: 202, startedAt: "two", executable: "node" },
        }, {
            inspectProcess: () => ({ pid: 101, startedAt: "one", executable: "node" }),
        }),
        /Another validation coordinator is live/,
    );
    assert.equal(releaseExecutionLock({ ...first, owner: { token: "wrong" } }), false);
    assert.equal(releaseExecutionLock(first), true);

    fs.writeFileSync(first.lockPath, JSON.stringify(firstOwner));
    assert.throws(
        () => acquireExecutionLock(output, {
            token: "unverified-contender",
            runId: "unverified-run",
            processIdentity: { pid: 303, startedAt: "three", executable: "node" },
        }, {
            inspectProcess: () => null,
            isProcessAlive: () => true,
        }),
        /creation identity cannot be verified/,
    );
    fs.rmSync(first.lockPath, { force: true });
    fs.writeFileSync(first.lockPath, JSON.stringify(firstOwner));
    const recovered = acquireExecutionLock(output, {
        token: "owner-3",
        runId: "run-3",
        processIdentity: { pid: 303, startedAt: "three", executable: "node" },
    }, {
        inspectProcess: () => null,
        isProcessAlive: () => false,
    });
    assert.equal(recovered.recoveredLock.runId, "run-1");
    assert.equal(fs.existsSync(recovered.quarantinePath), true);
    assert.equal(releaseExecutionLock(recovered), true);
});

test("reconciles stale active attempts while preserving fixed round counts and run history", async () => {
    const state = {
        status: "running",
        terminalReason: null,
        runs: {},
        tests: {
            "active.test.js": {
                status: "pending",
                latestDurationMs: null,
                lastRunAt: null,
                notes: "",
                attempts: [{
                    number: 1,
                    runId: "old-run",
                    status: "running",
                    startedAt: "2026-09-30T16:00:00.000Z",
                    pid: 42,
                    processIdentity: { pid: 42, startedAt: "process-start", executable: "node" },
                    vitestPid: 43,
                    vitestProcessIdentity: { pid: 43, startedAt: "vitest-start", executable: "node" },
                }],
            },
        },
        currentRun: {
            runId: "old-run",
            status: "running",
            activeFiles: {
                "active.test.js": {
                    attemptNumber: 1,
                    round: 0,
                    pid: 42,
                    processIdentity: { pid: 42, startedAt: "process-start", executable: "node" },
                    vitestPid: 43,
                    vitestProcessIdentity: { pid: 43, startedAt: "vitest-start", executable: "node" },
                },
            },
            rounds: [{
                number: 0,
                total: 2,
                queued: 1,
                active: 1,
                completed: 0,
                remaining: 2,
                status: "running",
            }],
        },
    };
    const terminated = [];
    const live = new Map([
        [42, { pid: 42, startedAt: "process-start", executable: "node" }],
        [43, { pid: 43, startedAt: "vitest-start", executable: "node" }],
    ]);
    const outcome = await reconcileStaleRun(state, "stale coordinator", {
        inspectProcess: (pid) => live.get(pid) ?? null,
        isProcessAlive: (pid) => live.has(pid),
        terminate: async (pid) => {
            terminated.push(pid);
            live.delete(pid);
        },
        freezeProcess: () => {},
        now: "2026-09-30T16:01:00.000Z",
    });
    assert.deepEqual(terminated, [42, 43]);
    assert.equal(outcome.reconciled, 1);
    assert.equal(state.tests["active.test.js"].attempts[0].status, "interrupted");
    assert.deepEqual(
        {
            total: state.currentRun.rounds[0].total,
            queued: state.currentRun.rounds[0].queued,
            active: state.currentRun.rounds[0].active,
            completed: state.currentRun.rounds[0].completed,
            remaining: state.currentRun.rounds[0].remaining,
        },
        { total: 2, queued: 1, active: 0, completed: 1, remaining: 1 },
    );
    assert.equal(state.runs["old-run"].terminalReason, "stale coordinator");
});

test("stale-run recovery fails when recorded child cleanup cannot be verified", async () => {
    const identity = { pid: 42, startedAt: "process-start", executable: "node" };
    const state = {
        currentRun: {
            runId: "old-run",
            status: "running",
            activeFiles: {
                "active.test.js": {
                    attemptNumber: 1,
                    round: 0,
                    pid: 42,
                    processIdentity: identity,
                },
            },
            rounds: [],
        },
        tests: {
            "active.test.js": {
                attempts: [{
                    number: 1,
                    runId: "old-run",
                    status: "running",
                }],
            },
        },
    };
    await assert.rejects(
        reconcileStaleRun(state, "stale coordinator", {
            inspectProcess: () => identity,
            isProcessAlive: () => true,
            terminate: async () => {},
            freezeProcess: () => {},
            cleanupGraceMs: 10,
        }),
        /remained live/,
    );
    await assert.rejects(
        reconcileStaleRun(structuredClone(state), "stale coordinator", {
            inspectProcess: () => null,
            isProcessAlive: () => true,
            terminate: async () => {},
            freezeProcess: () => {},
            cleanupGraceMs: 10,
        }),
        /cannot be resolved safely/,
    );
});

test("stale-run recovery refuses a still-live recorded coordinator", async () => {
    const identity = { pid: 99, startedAt: "coordinator-start", executable: "node" };
    const state = {
        currentRun: {
            runId: "live-run",
            status: "running",
            coordinatorProcessIdentity: identity,
            activeFiles: {},
            rounds: [],
        },
    };
    await assert.rejects(
        reconcileStaleRun(state, "should not reconcile", {
            inspectProcess: () => ({ ...identity }),
        }),
        /Prior validation coordinator is still live/,
    );
});

test("stale-run recovery finalizes nonterminal rounds without active attempts", async () => {
    const state = {
        status: "running",
        runs: {},
        tests: {},
        currentRun: {
            runId: "unassigned-run",
            status: "running",
            activeFiles: {},
            rounds: [{
                number: 0,
                status: "running",
                total: 3,
                queued: 3,
                active: 0,
                completed: 0,
                remaining: 3,
                startedAt: "2026-09-30T16:00:00.000Z",
                finishedAt: null,
            }],
        },
    };
    const outcome = await reconcileStaleRun(state, "coordinator disappeared", {
        now: "2026-09-30T16:01:00.000Z",
    });
    assert.equal(outcome.reconciled, 0);
    assert.deepEqual(
        {
            status: state.currentRun.rounds[0].status,
            total: state.currentRun.rounds[0].total,
            queued: state.currentRun.rounds[0].queued,
            active: state.currentRun.rounds[0].active,
            completed: state.currentRun.rounds[0].completed,
            remaining: state.currentRun.rounds[0].remaining,
            finishedAt: state.currentRun.rounds[0].finishedAt,
        },
        {
            status: "interrupted",
            total: 3,
            queued: 3,
            active: 0,
            completed: 0,
            remaining: 3,
            finishedAt: "2026-09-30T16:01:00.000Z",
        },
    );
});

test("plans breadth-first initial and retry rounds with monotonic counts", () => {
    const state = {
        tests: {
            "pass.test.js": { status: "passed" },
            "fail.test.js": { status: "failed" },
            "interrupted.test.js": { status: "interrupted" },
        },
    };
    assert.deepEqual(
        planRetryFiles(state, ["pass.test.js", "fail.test.js", "interrupted.test.js"]),
        ["fail.test.js", "interrupted.test.js"],
    );
    const round = createRoundState(1, "retry", ["fail.test.js", "interrupted.test.js"], 2, "now");
    markRoundStarted(round);
    markRoundFileStarted(round);
    assert.deepEqual(
        { total: round.total, queued: round.queued, active: round.active, completed: round.completed, remaining: round.remaining },
        { total: 2, queued: 1, active: 1, completed: 0, remaining: 2 },
    );
    markRoundFileCompleted(round);
    assert.deepEqual(
        { total: round.total, queued: round.queued, active: round.active, completed: round.completed, remaining: round.remaining },
        { total: 2, queued: 1, active: 0, completed: 1, remaining: 1 },
    );
});

test("schedules unknown files before known files, then shortest median duration first", () => {
    const completed = (status, durationMs) => ({
        status,
        collectionStatus: "complete",
        durationMs,
    });
    const state = {
        tests: {
            "unknown-b.test.js": { attempts: [] },
            "unknown-a.test.js": {
                attempts: [{
                    status: "interrupted",
                    collectionStatus: "interrupted",
                    durationMs: 1,
                }],
            },
            "short.test.js": {
                attempts: [
                    completed("passed", 1000),
                    completed("passed", 3000),
                    completed("failed", 2000),
                ],
            },
            "long.test.js": {
                attempts: [completed("timed_out", 120_000)],
            },
        },
    };

    assert.equal(schedulingDurationMs(state.tests["unknown-a.test.js"]), null);
    assert.equal(schedulingDurationMs(state.tests["short.test.js"]), 2000);
    assert.deepEqual(
        orderFilesForScheduling(state, [
            "long.test.js",
            "unknown-b.test.js",
            "short.test.js",
            "unknown-a.test.js",
        ]),
        [
            "unknown-a.test.js",
            "unknown-b.test.js",
            "short.test.js",
            "long.test.js",
        ],
    );
});

test("plans additive retry targets across invocations without repeating the initial observation", () => {
    const failure = (number) => ({
        number,
        status: "failed",
        collectionStatus: "complete",
        attemptKind: number === 1 ? "initial" : "retry",
    });
    const state = {
        tests: {
            "failed.test.js": {
                status: "failed",
                collectionStatus: "complete",
                attempts: [failure(1)],
            },
            "passed.test.js": {
                status: "passed",
                collectionStatus: "complete",
                attemptKind: "initial",
                attempts: [{
                    number: 1,
                    status: "passed",
                    collectionStatus: "complete",
                }],
            },
            "interrupted.test.js": {
                status: "interrupted",
                collectionStatus: "interrupted",
                attemptKind: "initial",
                attempts: [{
                    number: 1,
                    status: "interrupted",
                    collectionStatus: "interrupted",
                }],
            },
        },
    };
    const files = Object.keys(state.tests);
    assert.deepEqual(
        planDefaultObservationFiles(state, files),
        ["interrupted.test.js"],
    );
    assert.deepEqual(planRetryTargetFiles(state, files, 1), ["failed.test.js"]);
    state.tests["failed.test.js"].attempts.push(failure(2));
    assert.deepEqual(planRetryTargetFiles(state, files, 1), []);
    assert.deepEqual(planRetryTargetFiles(state, files, 2), ["failed.test.js"]);
    state.tests["failed.test.js"].attempts.push({
        number: 3,
        status: "passed",
        collectionStatus: "complete",
        attemptKind: "retry",
    });
    assert.deepEqual(planRetryTargetFiles(state, files, 3), []);
    assert.equal(trustedAttempts(state.tests["failed.test.js"]).length, 3);
});

test("forced observations do not consume retry targets and interrupted retries retain their target", () => {
    const state = {
        currentRun: {
            runId: "run-old",
            status: "interrupted",
            controls: { retries: 3 },
            rounds: [{
                number: 4,
                kind: "retry",
                retryTarget: 2,
                files: ["failed.test.js"],
            }],
        },
        tests: {
            "failed.test.js": {
                status: "interrupted",
                collectionStatus: "interrupted",
                attempts: [
                    {
                        number: 1,
                        status: "failed",
                        collectionStatus: "complete",
                        attemptKind: "observation",
                    },
                    {
                        number: 2,
                        status: "interrupted",
                        collectionStatus: "interrupted",
                        attemptKind: "retry",
                        retryTarget: 2,
                        runId: "run-old",
                        round: 4,
                    },
                ],
            },
        },
    };
    assert.deepEqual(planDefaultObservationFiles(state, ["failed.test.js"]), []);
    assert.deepEqual(planRetryTargetFiles(state, ["failed.test.js"], 1), ["failed.test.js"]);

    assert.equal(incompleteRetryTarget(state), 3);
});

test("--all plans unfinished rounds as distinct recovery work before the new observation", () => {
    const state = {
        currentRun: {
            runId: "run-interrupted",
            status: "interrupted",
            rounds: [
                {
                    number: 0,
                    kind: "initial",
                    retryTarget: null,
                    files: ["initial.test.js"],
                },
                {
                    number: 1,
                    kind: "retry",
                    retryTarget: 1,
                    files: ["retry.test.js"],
                },
            ],
        },
        tests: {
            "initial.test.js": {
                attempts: [{
                    runId: "run-interrupted",
                    round: 0,
                    collectionStatus: "interrupted",
                }],
            },
            "retry.test.js": {
                attempts: [{
                    runId: "run-interrupted",
                    round: 1,
                    collectionStatus: "interrupted",
                }],
            },
            "passed.test.js": {
                attempts: [{
                    runId: "older",
                    round: 0,
                    status: "passed",
                    collectionStatus: "complete",
                }],
            },
        },
    };
    assert.deepEqual(planRecoveryRounds(state), [
        {
            sourceRunId: "run-interrupted",
            sourceRoundNumber: 0,
            kind: "initial",
            retryTarget: null,
            files: ["initial.test.js"],
        },
        {
            sourceRunId: "run-interrupted",
            sourceRoundNumber: 1,
            kind: "retry",
            retryTarget: 1,
            files: ["retry.test.js"],
        },
    ]);
    assert.deepEqual(
        planAllRecoverySequence(
            state,
            ["initial.test.js", "retry.test.js", "passed.test.js"],
        ),
        [
            {
                type: "recovery",
                sourceRunId: "run-interrupted",
                sourceRoundNumber: 0,
                kind: "initial",
                retryTarget: null,
                files: ["initial.test.js"],
            },
            {
                type: "recovery",
                sourceRunId: "run-interrupted",
                sourceRoundNumber: 1,
                kind: "retry",
                retryTarget: 1,
                files: ["retry.test.js"],
            },
            {
                type: "observation",
                kind: "observation",
                retryTarget: null,
                files: ["initial.test.js", "retry.test.js", "passed.test.js"],
            },
        ],
    );
});

test("repeated recovery preserves the original retry kind and retry accounting", () => {
    const state = {
        currentRun: {
            runId: "run-recovery",
            status: "interrupted",
            rounds: [{
                number: 0,
                kind: "recovery",
                retryTarget: 1,
                recoveryOf: {
                    runId: "run-retry",
                    round: 1,
                    kind: "retry",
                },
                files: ["failed.test.js"],
            }],
        },
        tests: {
            "failed.test.js": {
                status: "interrupted",
                collectionStatus: "interrupted",
                attempts: [{
                    number: 1,
                    runId: "run-recovery",
                    round: 0,
                    status: "interrupted",
                    collectionStatus: "interrupted",
                    attemptKind: "retry",
                    retryTarget: 1,
                }],
            },
        },
    };

    const [recovery] = planRecoveryRounds(state);
    assert.equal(recovery.kind, "retry");
    assert.equal(recovery.retryTarget, 1);

    state.tests["failed.test.js"].attempts.push({
        number: 2,
        status: "failed",
        collectionStatus: "complete",
        attemptKind: recovery.kind,
        retryTarget: recovery.retryTarget,
    });
    assert.deepEqual(planRetryTargetFiles(state, ["failed.test.js"], 1), []);
});

test("failed and timed-out outcomes can still form complete campaign evidence", () => {
    const state = {
        tests: {
            "failed.test.js": {
                status: "failed",
                collectionStatus: "complete",
                attempts: [{
                    status: "failed",
                    collectionStatus: "complete",
                }],
            },
            "timeout.test.js": {
                status: "timed_out",
                collectionStatus: "complete",
                attempts: [{
                    status: "timed_out",
                    collectionStatus: "complete",
                }],
            },
        },
    };
    const summary = summarizeState(state);
    assert.equal(campaignEvidenceComplete(state), true);
    assert.equal(summary.failed, 1);
    assert.equal(summary.timed_out, 1);
    assert.equal(summary.unfinished, 0);
});

test("retained reports must exist and match their recorded digest before reuse", (t) => {
    const directory = scratch(t);
    const outputPath = path.join(directory, "campaign.json");
    const reportPath = path.join(directory, "reports", "passed.json");
    const state = {
        tests: {
            "passed.test.js": {
                attempts: [{
                    status: "passed",
                    collectionStatus: "complete",
                    reportEvidenceValid: true,
                    reportPath: "reports/passed.json",
                    reportDigest: `sha256:${"0".repeat(64)}`,
                }],
            },
            "timeout.test.js": {
                attempts: [{
                    status: "timed_out",
                    collectionStatus: "complete",
                    reportEvidenceValid: false,
                    reportPath: "reports/timeout.json",
                    reportDigest: null,
                }],
            },
        },
    };

    assert.throws(
        () => verifyRetainedCampaignReports(state, outputPath),
        /missing or unsafe for passed\.test\.js/,
    );

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({ success: true }));
    state.tests["passed.test.js"].attempts[0].reportDigest = `sha256:${crypto
        .createHash("sha256")
        .update(fs.readFileSync(reportPath))
        .digest("hex")}`;
    assert.doesNotThrow(() => verifyRetainedCampaignReports(state, outputPath));

    fs.appendFileSync(reportPath, "\ntampered");
    assert.throws(
        () => verifyRetainedCampaignReports(state, outputPath),
        /digest mismatch for passed\.test\.js/,
    );
});

test("parses dirty worktree entries for executable-run enforcement", () => {
    assert.deepEqual(
        dirtyWorktreeEntries(" M source.js\n?? new-file.js\n"),
        [" M source.js", "?? new-file.js"],
    );
});

test("source validation pins repository and exact SHA but treats branch as metadata", () => {
    const expected = {
        repository: "microsoft/PilotSwarm",
        branch: "feature-a",
        commitId: "abc123",
    };
    assert.doesNotThrow(() => validateSourceSnapshot(expected, {
        ...expected,
        branch: "feature-b",
        dirtyEntries: [],
    }));
    assert.throws(
        () => validateSourceSnapshot(expected, { ...expected, commitId: "def456", dirtyEntries: [] }),
        /Committed SHA changed/,
    );
    assert.throws(
        () => validateSourceSnapshot(expected, { ...expected, dirtyEntries: [" M source.js"] }),
        /Worktree changed/,
    );
});

test("semantic fingerprint validation detects external provider configuration changes", () => {
    assert.doesNotThrow(() => validateSemanticFingerprint("sha256:same", "sha256:same"));
    assert.throws(
        () => validateSemanticFingerprint("sha256:before", "sha256:after"),
        /fingerprint changed during validation/,
    );
});

test("records report provenance and exposes mixed outcomes", () => {
    const testedRevision = {
        repository: "microsoft/PilotSwarm",
        branch: "feature",
        commitId: "abcdef0123456789",
    };
    const state = {
        tests: {
            "flaky.test.js": {
                status: "failed",
                collectionStatus: "complete",
                latestDurationMs: 2000,
                attempts: [{
                    number: 1,
                    status: "failed",
                    collectionStatus: "complete",
                    durationMs: 2000,
                }],
            },
        },
    };
    const attempt = beginAttempt(state, "flaky.test.js", {
        runId: "run-1",
        testedRevision,
        roundNumber: 1,
        reportPath: "reports/campaign/run/attempt.json",
        startedAt: "2026-09-19T00:01:00.000Z",
        deadlineAt: null,
    });
    completeAttempt(state, "flaky.test.js", attempt.number, {
        startedAt: "2026-09-19T00:01:00.000Z",
        finishedAt: "2026-09-19T00:01:01.000Z",
        durationMs: 1000,
        status: "passed",
        collectionStatus: "complete",
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "1 test passed",
        testCounts: { total: 1, passed: 1, failed: 0, skipped: 0, todo: 0 },
    });

    const summary = summarizeState(state);
    assert.equal(summary.passed, 1);
    assert.equal(summary.unfinished, 0);
    assert.equal(summary.mixed, 1);
    assert.equal(summary.attempts, 2);
    assert.equal(
        state.tests["flaky.test.js"].attempts[1].reportPath,
        "reports/campaign/run/attempt.json",
    );
});

test("reconciles worker errors without rewriting fixed totals", () => {
    const state = {
        tests: {
            "broken.test.js": {
                status: "pending",
                attempts: [],
            },
        },
    };
    const run = {
        runId: "run-error",
        activeFiles: {},
        rounds: [createRoundState(0, "initial", ["broken.test.js", "queued.test.js"], 1, "now")],
    };
    markRoundStarted(run.rounds[0]);
    markRoundFileStarted(run.rounds[0]);
    const attempt = beginAttempt(state, "broken.test.js", {
        runId: run.runId,
        testedRevision: { repository: "repo", branch: "branch", commitId: "sha" },
        roundNumber: 0,
        reportPath: "reports/broken.json",
        startedAt: "2026-09-30T16:00:00.000Z",
        deadlineAt: "2026-09-30T16:05:00.000Z",
    });
    run.activeFiles["broken.test.js"] = { round: 0, attemptNumber: attempt.number };
    const reconciled = reconcileActiveEntries(
        state,
        run,
        "worker failed",
        "2026-09-30T16:01:00.000Z",
    );
    assert.equal(reconciled, 1);
    assert.deepEqual(
        {
            total: run.rounds[0].total,
            queued: run.rounds[0].queued,
            active: run.rounds[0].active,
            completed: run.rounds[0].completed,
            remaining: run.rounds[0].remaining,
        },
        { total: 2, queued: 1, active: 0, completed: 1, remaining: 1 },
    );
    assert.equal(state.tests["broken.test.js"].attempts[0].status, "interrupted");
});

test("redacts known secrets and credential-bearing text", () => {
    const value = [
        "token-value",
        "https://user:pass@example.test/path?api_key=query-secret&safe=yes",
        "Authorization: Bearer header-secret",
        "x-api-key: another-secret",
    ].join("\n");
    const redacted = redactSensitiveText(value, { GITHUB_TOKEN: "token-value" });
    assert.doesNotMatch(redacted, /token-value|query-secret|header-secret|another-secret|user:pass/);
    assert.match(redacted, /\*\*\*/);
});

test("redacts retained native Vitest reports recursively without changing their shape", (t) => {
    const reportPath = path.join(scratch(t), "native-report.json");
    fs.writeFileSync(reportPath, JSON.stringify({
        numTotalTests: 1,
        testResults: [{
            name: "suite",
            assertionResults: [{
                status: "failed",
                title: "kept",
                failureMessages: [
                    "token-value Authorization: ****** https://user:pass@example.test/?api_key=query-secret",
                ],
                metadata: { authorization: "Bearer structured-secret" },
            }],
        }],
    }));
    const redacted = redactNativeReport(reportPath, { GITHUB_TOKEN: "token-value" });
    assert.equal(redacted.testResults[0].assertionResults[0].title, "kept");
    assert.equal(redacted.testResults[0].assertionResults[0].metadata.authorization, "***");
    const retained = fs.readFileSync(reportPath, "utf8");
    assert.doesNotMatch(retained, /token-value|query-secret|structured-secret|user:pass/);
    assert.equal(JSON.parse(retained).numTotalTests, 1);
});

test("redacts provider secrets before retaining interrupted active reports", (t) => {
    const dir = scratch(t);
    const outputPath = path.join(dir, "campaign.json");
    const reportPath = path.join(dir, "reports", "interrupted.json");
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify({
        numTotalTests: 1,
        numPassedTests: 0,
        numFailedTests: 1,
        numPendingTests: 0,
        testResults: [{
            name: "suite",
            assertionResults: [{
                status: "failed",
                title: "interrupted",
                failureMessages: ["provider-literal-secret"],
            }],
        }],
    }));
    const run = {
        runId: "run-1",
        activeFiles: {
            "interrupted.test.js": {
                attemptNumber: 1,
            },
        },
    };
    const state = {
        tests: {
            "interrupted.test.js": {
                attempts: [{
                    number: 1,
                    runId: "run-1",
                    reportPath: "reports/interrupted.json",
                }],
            },
        },
    };

    redactActiveReports(
        state,
        run,
        outputPath,
        {},
        new Set(["provider-literal-secret"]),
    );

    assert.doesNotMatch(fs.readFileSync(reportPath, "utf8"), /provider-literal-secret/);
    assert.equal(state.tests["interrupted.test.js"].attempts[0].evidenceError, undefined);
});

test("missing or malformed native reports fail evidence retention and are not kept", (t) => {
    const dir = scratch(t);
    const missing = path.join(dir, "missing.json");
    const missingResult = retainVitestReport(missing, {}, [], dir);
    assert.equal(missingResult.valid, false);
    assert.match(missingResult.evidenceError, /not produced/);

    const malformed = path.join(dir, "malformed.json");
    fs.writeFileSync(malformed, '{"testResults":[provider-literal-secret');
    const malformedResult = retainVitestReport(
        malformed,
        {},
        new Set(["provider-literal-secret"]),
        dir,
    );
    assert.equal(malformedResult.valid, false);
    assert.match(malformedResult.evidenceError, /could not be retained safely/);
    assert.doesNotMatch(malformedResult.evidenceError, /provider-literal-secret/);
    assert.equal(fs.existsSync(malformed), false);

    const wrongShape = path.join(dir, "wrong-shape.json");
    fs.writeFileSync(wrongShape, JSON.stringify({ testResults: [] }));
    const wrongShapeResult = retainVitestReport(wrongShape, {}, [], dir);
    assert.equal(wrongShapeResult.valid, false);
    assert.equal(fs.existsSync(wrongShape), false);
});

test("suite-level failures defer to captured reporter output for triage", (t) => {
    const dir = scratch(t);
    const reportPath = path.join(dir, "suite-failure.json");
    fs.writeFileSync(reportPath, JSON.stringify({
        numTotalTests: 7,
        numPassedTests: 0,
        numFailedTests: 0,
        numPendingTests: 7,
        numTodoTests: 0,
        numFailedTestSuites: 1,
        testResults: [{
            status: "failed",
            assertionResults: Array.from({ length: 7 }, () => ({
                status: "skipped",
                failureMessages: [],
            })),
        }],
    }));
    const result = retainVitestReport(reportPath, {}, [], dir);
    assert.equal(result.valid, true);
    assert.equal(result.summary, "");
    assert.equal(result.testCounts.skipped, 7);
});

test("fallback failure summaries prefer the actionable exception over reporter footers", () => {
    const output = [
        "FAIL  test/local/smoke-basic.test.js > smoke",
        "Error: Cannot find package 'example-package'",
        "Tests  7 skipped (7)",
        "Duration  15.00s",
    ].join("\n");
    assert.equal(
        fallbackFailureSummary(output, {}),
        "Error: Cannot find package 'example-package'",
    );
});

test("valid suite-level failure evidence uses the captured actionable exception", () => {
    const result = classifyAttemptEvidence({
        timedOut: false,
        timeoutMs: 300_000,
        abnormalGateExit: false,
        code: 1,
        parsed: {
            valid: true,
            summary: "",
            testCounts: { total: 7, passed: 0, failed: 0, skipped: 7, todo: 0 },
            evidenceError: null,
        },
        output: [
            "FAIL  test/local/smoke-basic.test.js > smoke",
            "Error: Cannot find package 'example-package'",
            "Tests  7 skipped (7)",
        ].join("\n"),
    });
    assert.equal(result.status, "failed");
    assert.equal(result.collectionStatus, "complete");
    assert.equal(result.summary, "Error: Cannot find package 'example-package'");
});

test("a signaled gate remains incomplete despite a valid-looking partial report", () => {
    const result = classifyAttemptEvidence({
        timedOut: false,
        timeoutMs: 20_000,
        abnormalGateExit: true,
        abnormalMessage: "Attempt gate terminated abnormally (SIGTERM)",
        code: null,
        parsed: {
            valid: true,
            testCounts: { passed: 1, failed: 0 },
            summary: "1 test passed",
            evidenceError: null,
        },
    });
    assert.equal(result.collectionStatus, "failed");
    assert.equal(result.status, "interrupted");
    assert.match(result.summary, /SIGTERM/);
});

test("timeout supervision bounds cleanup, waits for close, and verifies identity exit", async () => {
    let terminated = 0;
    let close;
    const closed = new Promise((resolve) => {
        close = resolve;
    });
    const completed = await superviseProcessDeadline({
        closed,
        deadlineMs: 1,
        terminate: async () => {
            terminated++;
            close({ code: null, signal: "SIGTERM" });
        },
        identityStillLive: () => false,
        cleanupGraceMs: 100,
    });
    assert.equal(terminated, 1);
    assert.equal(completed.timedOut, true);
    assert.equal(completed.timeoutProcessDisposition, "terminated-and-verified");

    await assert.rejects(
        superviseProcessDeadline({
            closed: new Promise(() => {}),
            deadlineMs: 1,
            terminate: async () => {},
            identityStillLive: () => false,
            cleanupGraceMs: 10,
        }),
        /did not terminate/,
    );
    await assert.rejects(
        superviseProcessDeadline({
            closed: new Promise(() => {}),
            deadlineMs: 1,
            terminate: async () => {
                throw new Error("termination failed");
            },
            identityStillLive: () => false,
            cleanupGraceMs: 100,
        }),
        /termination failed/,
    );
    await assert.rejects(
        superviseProcessDeadline({
            closed: new Promise((resolve) => {
                setTimeout(() => resolve({ code: null, signal: "SIGTERM" }), 5);
            }),
            deadlineMs: 1,
            terminate: async () => {},
            identityStillLive: () => true,
            cleanupGraceMs: 100,
        }),
        /remained live/,
    );
});

test("process identity waits fail closed and never match PID-only records", async () => {
    assert.equal(
        await waitForProcessIdentity(123, {
            inspectProcess: () => null,
            attempts: 2,
            delayMs: 0,
        }),
        null,
    );
    assert.equal(
        processIdentitiesMatch(
            { pid: 10, startedAt: null, executable: "node" },
            { pid: 10, startedAt: null, executable: "node" },
        ),
        false,
    );
});

test("matches process identities by PID and creation identity", () => {
    const identity = { pid: 10, startedAt: "start", executable: "node" };
    assert.equal(processIdentitiesMatch(identity, { ...identity }), true);
    assert.equal(processIdentitiesMatch(identity, { ...identity, startedAt: "other" }), false);
    assert.equal(processIdentitiesMatch(identity, { ...identity, pid: 11 }), false);
});

test("normalizes repository names from common remote URL formats", () => {
    assert.equal(
        repositoryNameFromRemote("git@github.com:microsoft/PilotSwarm.git"),
        "microsoft/PilotSwarm",
    );
    assert.equal(
        repositoryNameFromRemote("https://dev.azure.com/contoso/project/_git/repository"),
        "contoso/project/repository",
    );
    assert.equal(
        repositoryNameFromRemote("git@ssh.dev.azure.com:v3/contoso/project/repository"),
        "contoso/project/repository",
    );
});

test("rejects invalid runner controls", () => {
    assert.throws(() => parseArgs(["--workers", "0"]), /positive integer/);
    assert.throws(() => parseArgs(["--retry-workers", "0"]), /positive integer/);
    assert.throws(() => parseArgs(["--retries", "-1"]), /non-negative integer/);
    assert.throws(() => parseArgs(["--timeout", "soon"]), /Invalid duration/);
    assert.throws(() => parseArgs(["--unknown"]), /Unknown option/);
});

test("loads .env defaults without replacing ambient overrides", (t) => {
    const dir = scratch(t);
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, "DATABASE_URL=from-file\r\nGITHUB_TOKEN=file-token\r\nFILE_ONLY=yes\r\nHORIZON_DATABASE_URL=clear-me\r\n");
    const env = parseEnvFile(envPath, {
        DATABASE_URL: "from-ambient",
        GITHUB_TOKEN: "ambient-token",
    });
    assert.equal(env.DATABASE_URL, "from-ambient");
    assert.equal(env.GITHUB_TOKEN, "ambient-token");
    assert.equal(env.FILE_ONLY, "yes");
    assert.equal(env.HORIZON_DATABASE_URL, undefined);
    assert.equal(env.PS_TEST_SKIP_STALE_CLEANUP, "1");
});

test("routes the configured baseline database through canonical test aliases", () => {
    const databaseUrl = "postgresql://test:test@127.0.0.1:54329/pilotswarm_test";
    const env = prepareCampaignEnvironment({
        DATABASE_URL: databaseUrl,
        HORIZON_DATABASE_URL: "postgresql://unused.invalid/horizon",
        PILOTSWARM_RUNTIME_URL: "https://unused.invalid",
    });

    assert.equal(env.DATABASE_URL, databaseUrl);
    assert.equal(env.PS_TEST_DATABASE_URL, databaseUrl);
    assert.equal(env.TEST_DATABASE_URL, databaseUrl);
    assert.equal(env.PILOTSWARM_RUNTIME_PROVIDER, "postgres");
    assert.equal(env.HORIZON_DATABASE_URL, undefined);
    assert.equal(env.PILOTSWARM_RUNTIME_URL, undefined);
});

test("report-only environment preparation does not require a database", () => {
    assert.deepEqual(
        prepareCampaignEnvironment({ FILE_ONLY: "yes" }, { reportOnly: true }),
        { FILE_ONLY: "yes" },
    );
});
