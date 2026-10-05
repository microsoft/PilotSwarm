#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { testStorageEnvironment } from "./test-provider-plan.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const SDK_DIR = path.join(REPO_ROOT, "packages", "sdk");
const LOCAL_TEST_DIR = path.join(SDK_DIR, "test", "local");
const DEFAULT_OUTPUT = path.join("test-results", "local-test-validation", "campaign.json");
const DEFAULT_PROFILE = "sdk-local";
const DEFAULT_PROVIDER_CONFIG = path.join(SDK_DIR, "test", "fixtures", "model-providers.test.json");
export const STATE_SCHEMA_VERSION = 6;
const MAX_CAPTURED_OUTPUT = 256 * 1024;
const HEARTBEAT_INTERVAL_MS = 5_000;
const TIMEOUT_CLEANUP_GRACE_MS = 30_000;
const ATTEMPT_GATE_READY_TIMEOUT_MS = 60_000;
const SEMANTIC_ENV_KEYS = [
    "PS_TEST_FORCE_MODEL",
    "TEST_FORCE_MODEL",
    "PS_INTERRUPT_TEST_MODEL",
    "PILOTSWARM_LIVE_MODEL_TESTS",
    "PS_ENABLE_LIVE_DEHYDRATE_TESTS",
    "PS_CAPTURE_MODES",
    "LLM_PROVIDER_TYPE",
    "LLM_MODELS",
    "LLM_ENDPOINT",
    "LLM_API_VERSION",
    "COPILOT_MODEL",
    "MODEL_PROVIDER",
];
const SEMANTIC_CREDENTIAL_AVAILABILITY_KEYS = [
    "GITHUB_TOKEN",
    "LLM_API_KEY",
];
const HORIZON_ENV_KEYS = [
    "HORIZON_DATABASE_URL",
    "HORIZON_GRAPH_DATABASE_URL",
    "HORIZON_FACTS_SCHEMA",
    "HORIZON_GRAPH_SCHEMA",
    "HORIZON_POOL_MAX",
    "HORIZON_EMBED_URL",
    "HORIZON_EMBED_MODEL",
    "HORIZON_EMBED_DIM",
    "HORIZON_EMBED_API_KEY",
    "HORIZON_EMBED_API_KEY_HEADER",
    "HORIZON_EMBED_BEARER",
];
const SECRET_ENV_KEY_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|CONNECTION_STRING|DATABASE_URL|BEARER)/i;
const SECRET_FIELD_PATTERN = /(token|secret|password|passwd|api.?key|connection.?string|credential|authorization|bearer)/i;
const URL_SECRET_PARAM_PATTERN = /([?&](?:access_?token|api_?key|client_?secret|credential|auth|code|key|token|secret|password|passwd|sig|signature)=)[^&#\s]*/gi;
const URL_SECRET_PARAM_NAME_PATTERN = /^(?:access_?token|api_?key|client_?secret|credential|auth|code|key|token|secret|password|passwd|sig|signature)$/i;
const TERMINAL_TEST_STATUSES = new Set(["passed", "failed", "timed_out"]);

function usage() {
    return `Usage:
  npm run test:campaign -- [options]

Options:
  --workers <n>          Concurrent files in the initial round (default: 8)
  --retry-workers <n>    Concurrent files in retry rounds (default: 2)
  --retries <n>          Retry rounds after the initial round (default: 0)
  --timeout <duration>   Per-file process deadline, e.g. 120s or 5m (default: 5m)
  --output <path>        Campaign manifest beneath test-results
                         (default: ${DEFAULT_OUTPUT.replaceAll("\\", "/")})
  --file <path>          Select one exact path relative to test/local (repeatable)
  --profile <name>       Named validation profile (default: ${DEFAULT_PROFILE})
  --tags <expression>    Native Vitest tagsFilter expression
  --all                  Rerun current passes as well as non-passes
  --fresh                Create new state instead of continuing the manifest
  --skip-cleanup         Do not run the one-time stale test cleanup
  --report-only          Read and print campaign summary without executing tests
  --help                 Show this help

Legacy aliases remain accepted: --parallelism, --retry-count, and --timeout-per-file.
`;
}

export function incompleteRetryTarget(state) {
    const run = state.currentRun;
    if (!run || !["interrupted", "failed"].includes(run.status)) return 0;
    const value = Number(run.controls?.retries ?? 0);
    return Number.isInteger(value) && value >= 0 ? value : 0;
}

export function planRecoveryRounds(state) {
    const run = state.currentRun;
    if (!run || !["interrupted", "failed"].includes(run.status)) return [];
    const plans = [];
    for (const round of run.rounds ?? []) {
        const files = (round.files ?? []).filter((file) => {
            const attempt = state.tests[file]?.attempts?.find(
                (candidate) => candidate.runId === run.runId
                    && candidate.round === round.number,
            );
            return !attempt || attempt.collectionStatus !== "complete";
        });
        if (files.length === 0) continue;
        const attemptKind = round.recoveryOf?.kind ?? round.kind;
        plans.push({
            sourceRunId: run.runId,
            sourceRoundNumber: round.number,
            kind: attemptKind,
            retryTarget: round.retryTarget ?? null,
            files,
        });
    }
    return plans;
}

export function planAllRecoverySequence(state, files) {
    return [
        ...planRecoveryRounds(state).map((plan) => ({
            type: "recovery",
            ...plan,
        })),
        {
            type: "observation",
            kind: "observation",
            retryTarget: null,
            files: [...files],
        },
    ];
}

export function parseDuration(value) {
    const raw = String(value ?? "").trim().toLowerCase();
    if (!raw) throw new Error("Duration must not be empty");
    if (/^\d+$/.test(raw)) return Number(raw) * 1000;
    const match = raw.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/);
    if (!match) throw new Error(`Invalid duration: ${value}`);
    const amount = Number(match[1]);
    const multiplier = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]];
    return Math.round(amount * multiplier);
}

function takeOptionValue(args, index, name) {
    const arg = args[index];
    const prefix = `${name}=`;
    if (arg.startsWith(prefix)) return { value: arg.slice(prefix.length), consumed: 0 };
    if (arg === name) {
        if (index + 1 >= args.length) throw new Error(`${name} requires a value`);
        return { value: args[index + 1], consumed: 1 };
    }
    return null;
}

export function parseArgs(args) {
    const options = {
        workers: 8,
        retryWorkers: 2,
        retries: 0,
        timeoutMs: 300_000,
        output: DEFAULT_OUTPUT.replaceAll("\\", "/"),
        files: [],
        profile: DEFAULT_PROFILE,
        tagsFilter: null,
        all: false,
        fresh: false,
        skipCleanup: false,
        reportOnly: false,
        help: false,
    };

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        let parsed;
        if ((parsed = takeOptionValue(args, index, "--workers"))
            || (parsed = takeOptionValue(args, index, "--parallelism"))) {
            options.workers = Number(parsed.value);
            index += parsed.consumed;
        } else if ((parsed = takeOptionValue(args, index, "--retry-workers"))) {
            options.retryWorkers = Number(parsed.value);
            index += parsed.consumed;
        } else if ((parsed = takeOptionValue(args, index, "--retries"))
            || (parsed = takeOptionValue(args, index, "--retry-count"))) {
            options.retries = Number(parsed.value);
            index += parsed.consumed;
        } else if ((parsed = takeOptionValue(args, index, "--timeout"))
            || (parsed = takeOptionValue(args, index, "--timeout-per-file"))) {
            options.timeoutMs = parseDuration(parsed.value);
            index += parsed.consumed;
        } else if ((parsed = takeOptionValue(args, index, "--output"))) {
            options.output = parsed.value;
            index += parsed.consumed;
        } else if ((parsed = takeOptionValue(args, index, "--file"))) {
            options.files.push(normalizeExplicitFile(parsed.value));
            index += parsed.consumed;
        } else if ((parsed = takeOptionValue(args, index, "--profile"))) {
            options.profile = parsed.value;
            index += parsed.consumed;
        } else if ((parsed = takeOptionValue(args, index, "--tags"))
            || (parsed = takeOptionValue(args, index, "--tags-filter"))) {
            options.tagsFilter = parsed.value;
            index += parsed.consumed;
        } else if (arg === "--all") {
            options.all = true;
        } else if (arg === "--fresh") {
            options.fresh = true;
        } else if (arg === "--skip-build") {
            throw new Error(
                "--skip-build is not supported because campaign evidence must be built from the tested commit",
            );
        } else if (arg === "--skip-cleanup") {
            options.skipCleanup = true;
        } else if (arg === "--report-only") {
            options.reportOnly = true;
        } else if (arg === "--help" || arg === "-h") {
            options.help = true;
        } else {
            throw new Error(`Unknown option: ${arg}`);
        }
    }

    if (!Number.isInteger(options.workers) || options.workers < 1) {
        throw new Error("--workers must be a positive integer");
    }
    if (!Number.isInteger(options.retryWorkers) || options.retryWorkers < 1) {
        throw new Error("--retry-workers must be a positive integer");
    }
    if (!Number.isInteger(options.retries) || options.retries < 0) {
        throw new Error("--retries must be a non-negative integer");
    }
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
        throw new Error("--timeout must be positive");
    }
    if (!options.output.trim()) throw new Error("--output must not be empty");
    if (!options.profile.trim()) throw new Error("--profile must not be empty");
    if (options.tagsFilter !== null && !options.tagsFilter.trim()) {
        throw new Error("--tags must not be empty");
    }
    options.files = [...new Set(options.files)].sort();
    return options;
}

function normalizeExplicitFile(value) {
    return String(value ?? "")
        .trim()
        .replaceAll("\\", "/")
        .replace(/^packages\/sdk\//, "")
        .replace(/^test\/local\//, "")
        .replace(/^\.\/+/, "");
}

export function parseVitestListJson(value, localTestDir = LOCAL_TEST_DIR) {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    const entries = Array.isArray(parsed) ? parsed : parsed?.files;
    if (!Array.isArray(entries)) throw new Error("Vitest list JSON did not contain a file array");
    const files = entries.map((entry) => typeof entry === "string" ? entry : entry?.file);
    if (files.some((file) => typeof file !== "string" || !file.trim())) {
        throw new Error("Vitest list JSON contained an invalid file entry");
    }
    const canonicalLocalDir = fs.existsSync(localTestDir)
        ? fs.realpathSync(localTestDir)
        : path.resolve(localTestDir);
    return [...new Set(files.map((file) => {
        const absolute = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
        const relative = path.relative(canonicalLocalDir, absolute);
        if (!relative
            || relative === ".."
            || relative.startsWith(`..${path.sep}`)
            || path.isAbsolute(relative)) {
            throw new Error(`Vitest listed a file outside test/local: ${file}`);
        }
        return relative.replaceAll(path.sep, "/");
    }))].sort();
}

export function validateExplicitFiles(requested, listed) {
    if (requested.length === 0) return;
    const expected = [...new Set(requested)].sort();
    const actual = [...new Set(listed)].sort();
    const missing = expected.filter((file) => !actual.includes(file));
    const unexpected = actual.filter((file) => !expected.includes(file));
    if (missing.length || unexpected.length) {
        const details = [
            missing.length ? `missing: ${missing.join(", ")}` : "",
            unexpected.length ? `unexpected: ${unexpected.join(", ")}` : "",
        ].filter(Boolean).join("; ");
        throw new Error(`Explicit --file selection did not resolve exactly (${details})`);
    }
}

export function createVitestListArgs(jsonPath, options) {
    const jsonArgumentPath = path.relative(SDK_DIR, jsonPath).replaceAll(path.sep, "/");
    const args = [
        path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs"),
        "list",
        "--filesOnly",
        `--json=${jsonArgumentPath}`,
    ];
    if (options.tagsFilter) args.push(`--tagsFilter=${options.tagsFilter}`);
    args.push(...options.files.map((file) => `test/local/${file}`));
    return args;
}

export function discoverVitestFiles(options, outputPath, env = process.env) {
    outputPath = resolveOutputPath(outputPath);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
    const inventoryPath = path.join(
        path.dirname(outputPath),
        `.vitest-list-${process.pid}-${Date.now()}.json`,
    );
    try {
        const result = spawnSync(process.execPath, createVitestListArgs(inventoryPath, options), {
            cwd: SDK_DIR,
            env,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        if (result.status !== 0) {
            throw new Error(compactMessage(result.stderr || result.stdout || "Vitest list failed", 1000));
        }
        const files = parseVitestListJson(fs.readFileSync(inventoryPath, "utf8"));
        validateExplicitFiles(options.files, files);
        if (files.length === 0) throw new Error("Vitest resolved no SDK local test files");
        return files;
    } finally {
        fs.rmSync(inventoryPath, { force: true });
    }
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

function sanitizeUrl(value) {
    return String(value)
        .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1***@")
        .replace(URL_SECRET_PARAM_PATTERN, "$1***");
}

function sanitizeProviderConfig(value, key = "") {
    if (Array.isArray(value)) return value.map((item) => sanitizeProviderConfig(item));
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
            childKey,
            sanitizeProviderConfig(childValue, childKey),
        ]));
    }
    if (SECRET_FIELD_PATTERN.test(key)) {
        if (typeof value === "string" && value.startsWith("env:")) return value;
        return value == null ? value : "<configured>";
    }
    return typeof value === "string" ? sanitizeUrl(value) : value;
}

function referencedCredentialEnvKeys(value, key = "", found = new Set()) {
    if (Array.isArray(value)) {
        for (const item of value) referencedCredentialEnvKeys(item, "", found);
    } else if (value && typeof value === "object") {
        for (const [childKey, childValue] of Object.entries(value)) {
            referencedCredentialEnvKeys(childValue, childKey, found);
        }
    } else if (SECRET_FIELD_PATTERN.test(key)
        && typeof value === "string"
        && /^env:[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
        found.add(value.slice("env:".length));
    }
    return found;
}

function loadProviderConfiguration(env = process.env) {
    const configuredPath = env.PS_MODEL_PROVIDERS_PATH
        || env.MODEL_PROVIDERS_PATH
        || DEFAULT_PROVIDER_CONFIG;
    const resolvedPath = path.isAbsolute(configuredPath)
        ? configuredPath
        : path.resolve(SDK_DIR, configuredPath);
    let config;
    try {
        config = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
    } catch (error) {
        throw new Error(`Could not read semantic provider/model profile: ${error.message}`);
    }
    return { config, resolvedPath };
}

function collectProviderCredentialSecrets(value, env, key = "", found = new Set()) {
    if (Array.isArray(value)) {
        for (const item of value) collectProviderCredentialSecrets(item, env, "", found);
    } else if (value && typeof value === "object") {
        for (const [childKey, childValue] of Object.entries(value)) {
            collectProviderCredentialSecrets(childValue, env, childKey, found);
        }
    } else if (SECRET_FIELD_PATTERN.test(key) && typeof value === "string" && value) {
        const reference = value.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/);
        if (reference) {
            const resolved = env[reference[1]];
            if (typeof resolved === "string" && resolved) found.add(resolved);
        } else {
            found.add(value);
        }
    } else if (typeof value === "string" && /^https?:\/\//i.test(value)) {
        try {
            const parsed = new URL(value);
            if (parsed.username) found.add(decodeURIComponent(parsed.username));
            if (parsed.password) found.add(decodeURIComponent(parsed.password));
            for (const [name, parameterValue] of parsed.searchParams) {
                if (parameterValue && URL_SECRET_PARAM_NAME_PATTERN.test(name)) {
                    found.add(parameterValue);
                }
            }
        } catch {}
    }
    return found;
}

export function providerRedactionSecrets(env = process.env) {
    const { config } = loadProviderConfiguration(env);
    return collectProviderCredentialSecrets(config, env);
}

export function refreshProviderRedactionSecrets(target, env = process.env) {
    for (const secret of providerRedactionSecrets(env)) target.add(secret);
    return target;
}

export function providerModelFingerprint(env = process.env) {
    const { config } = loadProviderConfiguration(env);
    const credentialKeys = new Set([
        ...SEMANTIC_CREDENTIAL_AVAILABILITY_KEYS,
        ...referencedCredentialEnvKeys(config),
    ]);
    const semantic = {
        config: sanitizeProviderConfig(config),
        environment: Object.fromEntries(
            SEMANTIC_ENV_KEYS.map((key) => [
                key,
                key === "LLM_ENDPOINT" && env[key] ? sanitizeUrl(env[key]) : env[key] ?? null,
            ]),
        ),
        credentialAvailability: Object.fromEntries(
            [...credentialKeys].sort().map((key) => [key, Boolean(env[key])]),
        ),
    };
    return `sha256:${crypto.createHash("sha256").update(stableJson(semantic)).digest("hex")}`;
}

export function createCampaignIdentity({
    repository,
    commitId,
    selection,
    profile = DEFAULT_PROFILE,
    tagsFilter = null,
    providerFingerprint,
}) {
    return {
        repository,
        commitId,
        selection: [...selection].sort(),
        profile,
        tagsFilter,
        providerModelFingerprint: providerFingerprint,
    };
}

export function campaignIdentityHash(identity) {
    return `sha256:${crypto.createHash("sha256").update(stableJson(identity)).digest("hex")}`;
}

export function campaignIdentitiesMatch(left, right) {
    return Boolean(left && right && stableJson(left) === stableJson(right));
}

export function assertCompatibleCampaign(state, identity, outputPath = DEFAULT_OUTPUT) {
    if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
        throw new Error(
            `Existing campaign uses schema ${state.schemaVersion}; use --fresh or an alternate --output path.`,
        );
    }
    if (!campaignIdentitiesMatch(state.identity, identity)) {
        throw new Error(
            `Existing campaign identity differs from the requested campaign at ${outputPath}. `
            + "Use --fresh to create new state or choose an alternate --output path.",
        );
    }
}

function statusToDisplay(value) {
    return {
        passed: "Passed",
        failed: "Failed",
        timed_out: "Timed out",
        interrupted: "Interrupted",
        pending: "Pending",
    }[value] ?? "Pending";
}

function emptyTestState() {
    return {
        status: "pending",
        collectionStatus: "pending",
        latestDurationMs: null,
        lastRunAt: null,
        notes: "",
        attempts: [],
    };
}

function createState(identity, repository) {
    const now = new Date().toISOString();
    return {
        schemaVersion: STATE_SCHEMA_VERSION,
        campaignId: campaignIdentityHash(identity),
        createdAt: now,
        updatedAt: now,
        status: "pending",
        terminalReason: null,
        identity,
        repository,
        currentRun: null,
        runs: {},
        summary: null,
        tests: Object.fromEntries(identity.selection.map((file) => [file, emptyTestState()])),
    };
}

function loadState(outputPath, identity, repository, fresh) {
    if (fs.existsSync(outputPath) && !fresh) {
        const parsed = JSON.parse(fs.readFileSync(outputPath, "utf8"));
        assertCompatibleCampaign(parsed, identity, outputPath);
        verifyRetainedCampaignReports(parsed, outputPath);
        parsed.repository = repository;
        parsed.runs ??= {};
        return parsed;
    }

    return createState(identity, repository);
}

function archiveCurrentRun(state) {
    if (!state.currentRun?.runId) return;
    state.runs ??= {};
    state.runs[state.currentRun.runId] = structuredClone(state.currentRun);
}

function historyCounts(entry) {
    const counts = { passed: 0, failed: 0, timed_out: 0, interrupted: 0 };
    for (const attempt of entry.attempts ?? []) {
        if (attempt.status in counts) counts[attempt.status]++;
    }
    return counts;
}

export function summarizeState(state) {
    const summary = {
        total: 0,
        passed: 0,
        failed: 0,
        timed_out: 0,
        interrupted: 0,
        pending: 0,
        unfinished: 0,
        mixed: 0,
        flaky: 0,
        attempts: 0,
    };
    for (const entry of Object.values(state.tests ?? {})) {
        summary.total++;
        summary[entry.status in summary ? entry.status : "pending"]++;
        const history = historyCounts(entry);
        summary.attempts += history.passed + history.failed + history.timed_out + history.interrupted;
        if (entry.collectionStatus !== "complete") summary.unfinished++;
        const observed = [history.passed, history.failed, history.timed_out]
            .filter((count) => count > 0).length;
        if (observed > 1) {
            summary.mixed++;
            summary.flaky++;
        }
    }
    return summary;
}

export function campaignEvidenceComplete(state, files = Object.keys(state.tests ?? {})) {
    return files.every((file) => state.tests[file]?.collectionStatus === "complete");
}

export function trustedAttempts(entry) {
    return (entry?.attempts ?? []).filter(
        (attempt) => attempt.collectionStatus === "complete"
            && TERMINAL_TEST_STATUSES.has(attempt.status),
    );
}

export function verifyRetainedCampaignReports(state, outputPath) {
    for (const [file, entry] of Object.entries(state.tests ?? {})) {
        for (const attempt of trustedAttempts(entry)) {
            const requiresReport = attempt.status !== "timed_out";
            if (!attempt.reportEvidenceValid) {
                if (requiresReport) {
                    throw new Error(`Retained report evidence is invalid for ${file}`);
                }
                continue;
            }
            if (!attempt.reportPath || !/^sha256:[a-f0-9]{64}$/i.test(attempt.reportDigest ?? "")) {
                throw new Error(`Retained report metadata is invalid for ${file}`);
            }
            let retainedPath;
            try {
                retainedPath = resolveRetainedReportPath(outputPath, attempt.reportPath);
            } catch {
                throw new Error(`Retained report artifact is missing or unsafe for ${file}`);
            }
            if (!fs.existsSync(retainedPath) || !fs.statSync(retainedPath).isFile()) {
                throw new Error(`Retained report artifact is missing or unsafe for ${file}`);
            }
            const actualDigest = `sha256:${crypto.createHash("sha256")
                .update(fs.readFileSync(retainedPath))
                .digest("hex")}`;
            if (actualDigest.toLowerCase() !== attempt.reportDigest.toLowerCase()) {
                throw new Error(`Retained report artifact digest mismatch for ${file}`);
            }
        }
    }
}

function latestAttempt(entry) {
    return entry?.attempts?.at(-1) ?? null;
}

function latestTrustedAttempt(entry) {
    return trustedAttempts(entry).at(-1) ?? null;
}

export function planDefaultObservationFiles(state, files) {
    return files.filter((file) => {
        const entry = state.tests[file];
        const latest = latestAttempt(entry);
        return trustedAttempts(entry).length === 0
            || (latest?.collectionStatus !== "complete" && latest?.attemptKind !== "retry");
    });
}

export function planRetryTargetFiles(state, files, retryTarget) {
    return files.filter((file) => {
        const entry = state.tests[file];
        const trusted = trustedAttempts(entry);
        const latest = trusted.at(-1);
        const completedRetries = trusted.filter(
            (attempt) => attempt.attemptKind === "retry",
        ).length;
        return latest
            && latest.status !== "passed"
            && completedRetries < retryTarget;
    });
}

export function createRoundState(
    number,
    kind,
    files,
    concurrency,
    now = new Date().toISOString(),
    retryTarget = null,
    recoveryOf = null,
) {
    return {
        number,
        kind,
        retryTarget,
        recoveryOf,
        status: "queued",
        concurrency,
        files: [...files],
        total: files.length,
        queued: files.length,
        active: 0,
        completed: 0,
        remaining: files.length,
        startedAt: now,
        finishedAt: null,
    };
}

export function markRoundStarted(round) {
    round.status = "running";
}

export function markRoundFileStarted(round) {
    if (round.queued < 1) throw new Error("Round queue is empty");
    round.queued--;
    round.active++;
}

export function markRoundFileCompleted(round) {
    if (round.active < 1) throw new Error("Round has no active file");
    round.active--;
    round.completed++;
    round.remaining--;
}

export function planRetryFiles(state, priorRoundFiles) {
    return priorRoundFiles.filter((file) => state.tests[file]?.status !== "passed");
}

export function schedulingDurationMs(entry) {
    const durations = trustedAttempts(entry)
        .map((attempt) => attempt.durationMs)
        .filter((durationMs) => Number.isFinite(durationMs) && durationMs >= 0)
        .sort((left, right) => left - right);
    if (durations.length === 0) return null;
    const middle = Math.floor(durations.length / 2);
    return durations.length % 2 === 1
        ? durations[middle]
        : (durations[middle - 1] + durations[middle]) / 2;
}

export function orderFilesForScheduling(state, files) {
    return [...files].sort((left, right) => {
        const leftDuration = schedulingDurationMs(state.tests?.[left]);
        const rightDuration = schedulingDurationMs(state.tests?.[right]);
        if (leftDuration === null && rightDuration !== null) return -1;
        if (leftDuration !== null && rightDuration === null) return 1;
        if (leftDuration !== null && rightDuration !== null && leftDuration !== rightDuration) {
            return leftDuration - rightDuration;
        }
        return left < right ? -1 : left > right ? 1 : 0;
    });
}

function compactMessage(value, limit = 500) {
    const clean = stripAnsi(String(value ?? ""))
        .replace(/\s+/g, " ")
        .trim();
    return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function stripAnsi(value) {
    return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function redactSensitiveText(value, env = process.env, additionalSecrets = []) {
    let redacted = String(value ?? "");
    for (const secret of additionalSecrets) {
        if (typeof secret === "string" && secret.length >= 1) {
            redacted = redacted.split(secret).join("***");
        }
    }
    for (const [key, secret] of Object.entries(env)) {
        if (!SECRET_ENV_KEY_PATTERN.test(key)) continue;
        if (typeof secret === "string" && secret.length >= 4) {
            redacted = redacted.split(secret).join("***");
        }
    }
    return redacted
        .replace(/(https?:\/\/)[^/@\s]+@/gi, "$1***@")
        .replace(URL_SECRET_PARAM_PATTERN, "$1***")
        .replace(/\b(authorization|proxy-authorization)\s*:\s*(?:bearer|basic)\s+\S+/gi, "$1: ***")
        .replace(/\b(cookie|set-cookie|x-api-key|api-key|x-auth-token|token|password|secret)\s*[:=]\s*["']?[^,\s"']+/gi, "$1=***");
}

function formatDuration(durationMs) {
    if (durationMs == null) return "—";
    if (durationMs < 1000) return `${durationMs}ms`;
    const seconds = Math.round(durationMs / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function atomicWrite(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, content, { mode: 0o600 });
    try {
        fs.chmodSync(tempPath, 0o600);
    } catch {}
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            fs.renameSync(tempPath, filePath);
            try {
                fs.chmodSync(filePath, 0o600);
            } catch {}
            return;
        } catch (error) {
            const retryable = ["EACCES", "EBUSY", "EEXIST", "EPERM"].includes(error.code);
            if (!retryable || attempt === 5) {
                fs.rmSync(tempPath, { force: true });
                throw error;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
        }
    }
}

export function processIdentitiesMatch(recorded, actual) {
    if (!recorded || !actual || recorded.pid !== actual.pid) return false;
    if (!recorded.startedAt || !actual.startedAt || recorded.startedAt !== actual.startedAt) {
        return false;
    }
    if (recorded.executable && actual.executable
        && normalizedPathForComparison(recorded.executable)
            !== normalizedPathForComparison(actual.executable)) {
        return false;
    }
    if (recorded.command && actual.command && recorded.command !== actual.command) return false;
    return true;
}

export function getProcessIdentity(pid) {
    if (!Number.isInteger(pid) || pid < 1) return null;
    if (process.platform === "win32") {
        const script = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" `
            + "-ErrorAction SilentlyContinue; if($p){[pscustomobject]@{"
            + "pid=[int]$p.ProcessId;startedAt=$p.CreationDate.ToUniversalTime().ToString('o');"
            + "executable=$p.ExecutablePath}|ConvertTo-Json -Compress}";
        const result = spawnSync(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", script],
            { encoding: "utf8", windowsHide: true },
        );
        if (result.status !== 0 || !result.stdout.trim()) return null;
        try {
            return JSON.parse(result.stdout);
        } catch {
            return null;
        }
    }
    try {
        process.kill(pid, 0);
        if (fs.existsSync(`/proc/${pid}/stat`)) {
            const executable = fs.existsSync(`/proc/${pid}/exe`)
                ? fs.realpathSync(`/proc/${pid}/exe`)
                : null;
            const startedAt = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(" ")[21];
            if (!startedAt) return null;
            return { pid, startedAt, executable };
        }
        const result = spawnSync(
            "ps",
            ["-p", String(pid), "-o", "lstart=", "-o", "command="],
            { encoding: "utf8" },
        );
        if (result.status !== 0 || !result.stdout.trim()) return null;
        const line = result.stdout.trim();
        const startedText = line.slice(0, 24).trim();
        const command = line.slice(24).trim();
        const parsed = Date.parse(startedText);
        if (!Number.isFinite(parsed) || !command) return null;
        return {
            pid,
            startedAt: new Date(parsed).toISOString(),
            executable: command.split(/\s+/)[0],
            command,
        };
    } catch {
        return null;
    }
}

function listPosixProcessRelations() {
    if (process.platform === "win32") return [];
    if (process.platform === "linux" && fs.existsSync("/proc")) {
        const processes = [];
        for (const entry of fs.readdirSync("/proc", { withFileTypes: true })) {
            if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
            const pid = Number(entry.name);
            try {
                const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
                const commandEnd = stat.lastIndexOf(")");
                if (commandEnd < 0) continue;
                const fields = stat.slice(commandEnd + 2).split(" ");
                const parentPid = Number(fields[1]);
                const processGroupId = Number(fields[2]);
                if (!Number.isInteger(parentPid) || !Number.isInteger(processGroupId)) continue;
                let executable = null;
                try {
                    executable = fs.realpathSync(`/proc/${pid}/exe`);
                } catch {}
                processes.push({
                    pid,
                    parentPid,
                    processGroupId,
                    processIdentity: {
                        pid,
                        startedAt: fields[19],
                        executable,
                    },
                });
            } catch {}
        }
        return processes;
    }
    const result = spawnSync(
        "ps",
        ["-axo", "pid=", "-o", "ppid=", "-o", "pgid="],
        { encoding: "utf8" },
    );
    if (result.status !== 0) {
        throw new Error("Could not enumerate POSIX processes for attempt cleanup");
    }
    return result.stdout.split(/\r?\n/).flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
        if (!match) return [];
        return [{
            pid: Number(match[1]),
            parentPid: Number(match[2]),
            processGroupId: Number(match[3]),
        }];
    });
}

export function discoverRecordedDescendants(records, {
    listProcesses = listPosixProcessRelations,
    inspectProcess = getProcessIdentity,
    isProcessAlive = processAppearsAlive,
} = {}) {
    if (process.platform === "win32") return [];
    const processTable = listProcesses();
    const childrenByParent = new Map();
    for (const processRecord of processTable) {
        const children = childrenByParent.get(processRecord.parentPid) ?? [];
        children.push(processRecord);
        childrenByParent.set(processRecord.parentPid, children);
    }
    const roots = records.flatMap((record) => {
        if (!Number.isInteger(record?.pid) || record.pid < 1 || !record.processIdentity) {
            return [];
        }
        const actual = inspectProcess(record.pid);
        return processIdentitiesMatch(record.processIdentity, actual) ? [record.pid] : [];
    });
    const queue = roots.map((pid) => ({ pid, depth: 0 }));
    const visited = new Set(roots);
    const descendants = [];
    while (queue.length > 0) {
        const parent = queue.shift();
        for (const child of childrenByParent.get(parent.pid) ?? []) {
            if (visited.has(child.pid)) continue;
            visited.add(child.pid);
            const processIdentity = child.processIdentity ?? inspectProcess(child.pid);
            const actual = inspectProcess(child.pid);
            if (!processIdentity || !processIdentitiesMatch(processIdentity, actual)) {
                if (isProcessAlive(child.pid)) {
                    throw new Error(
                        `Descendant PID ${child.pid} changed or lacks a verifiable process identity`,
                    );
                }
                continue;
            }
            const record = {
                role: "descendant",
                pid: child.pid,
                parentPid: child.parentPid,
                processGroupId: child.processGroupId,
                processIdentity,
                depth: parent.depth + 1,
            };
            descendants.push(record);
            queue.push({ pid: child.pid, depth: record.depth });
        }
    }
    return descendants;
}

export async function waitForProcessIdentity(pid, {
    inspectProcess = getProcessIdentity,
    attempts = 10,
    delayMs = 50,
} = {}) {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const identity = inspectProcess(pid);
        if (identity?.startedAt) return identity;
        if (attempt + 1 < attempts) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    return null;
}

export function processAppearsAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function lockPathForOutput(outputPath) {
    return path.join(path.dirname(outputPath), ".campaign.lock");
}

export function acquireExecutionLock(outputPath, owner, {
    inspectProcess = getProcessIdentity,
    isProcessAlive = processAppearsAlive,
} = {}) {
    const lockPath = lockPathForOutput(outputPath);
    const recoveryClaimPath = `${lockPath}.recovery`;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    let recoveredLock = null;
    let quarantinePath = null;
    for (let attempt = 0; attempt < 80; attempt++) {
        if (fs.existsSync(recoveryClaimPath)) {
            let recoveryOwner = null;
            try {
                recoveryOwner = JSON.parse(fs.readFileSync(recoveryClaimPath, "utf8"));
            } catch {}
            const recoveryProcess = recoveryOwner?.processIdentity
                ? inspectProcess(recoveryOwner.processIdentity.pid)
                : null;
            if (recoveryOwner?.processIdentity
                && processIdentitiesMatch(recoveryOwner.processIdentity, recoveryProcess)) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
            } else if (recoveryOwner?.processIdentity
                && isProcessAlive(recoveryOwner.processIdentity.pid)) {
                throw new Error("A live lock-recovery owner has an unverifiable process identity");
            } else {
                fs.rmSync(recoveryClaimPath, { force: true });
            }
            continue;
        }
        try {
            const descriptor = fs.openSync(lockPath, "wx", 0o600);
            fs.writeFileSync(descriptor, `${JSON.stringify(owner, null, 2)}\n`);
            fs.closeSync(descriptor);
            return { lockPath, owner, recoveredLock, quarantinePath };
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
            let claimDescriptor;
            try {
                claimDescriptor = fs.openSync(recoveryClaimPath, "wx", 0o600);
            } catch (claimError) {
                if (claimError.code === "EEXIST") {
                    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
                    continue;
                }
                throw claimError;
            }
            try {
                try {
                    fs.writeFileSync(claimDescriptor, `${JSON.stringify(owner, null, 2)}\n`);
                } finally {
                    fs.closeSync(claimDescriptor);
                }
                let existing = null;
                try {
                    existing = JSON.parse(fs.readFileSync(lockPath, "utf8"));
                } catch {}
                const actual = existing?.processIdentity
                    ? inspectProcess(existing.processIdentity.pid)
                    : null;
                if (existing?.processIdentity
                    && processIdentitiesMatch(existing.processIdentity, actual)) {
                    throw new Error(
                        `Another validation coordinator is live (run ${existing.runId}, PID ${existing.processIdentity.pid})`,
                    );
                }
                if (existing?.processIdentity
                    && isProcessAlive(existing.processIdentity.pid)
                    && (!existing.processIdentity.startedAt || !actual?.startedAt)) {
                    throw new Error(
                        `Validation lock owner PID ${existing.processIdentity.pid} is live but its creation identity cannot be verified`,
                    );
                }
                quarantinePath = `${lockPath}.stale-${Date.now()}-${crypto.randomUUID()}.json`;
                try {
                    fs.renameSync(lockPath, quarantinePath);
                } catch (renameError) {
                    if (renameError.code === "ENOENT") {
                        quarantinePath = null;
                        continue;
                    }
                    throw renameError;
                }
                recoveredLock = existing;
            } finally {
                fs.rmSync(recoveryClaimPath, { force: true });
            }
        }
    }
    throw new Error("Could not acquire validation campaign lock while recovery was in progress");
}

export function releaseExecutionLock(lockHandle) {
    if (!lockHandle?.lockPath || !lockHandle.owner?.token) return false;
    let existing;
    try {
        existing = JSON.parse(fs.readFileSync(lockHandle.lockPath, "utf8"));
    } catch {
        return false;
    }
    if (existing.token !== lockHandle.owner.token) return false;
    fs.rmSync(lockHandle.lockPath, { force: true });
    return true;
}

function gitResult(args) {
    return spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
}

function gitValue(args, fallback = "unknown") {
    const result = gitResult(args);
    return result.status === 0 ? result.stdout.trim() || fallback : fallback;
}

export function dirtyWorktreeEntries(porcelain) {
    return String(porcelain ?? "").split(/\r?\n/).filter(Boolean);
}

export function repositoryNameFromRemote(remote) {
    const normalized = String(remote ?? "").trim().replaceAll("\\", "/").replace(/\.git$/, "");
    const azureHttps = normalized.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)$/i);
    if (azureHttps) return `${azureHttps[1]}/${azureHttps[2]}/${azureHttps[3]}`;
    const azureSsh = normalized.match(/ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)$/i);
    if (azureSsh) return `${azureSsh[1]}/${azureSsh[2]}/${azureSsh[3]}`;
    const generic = normalized.match(/[:/]([^/:]+\/[^/]+)$/);
    return generic?.[1] ?? "unknown";
}

function remoteUrlForBranch(branch) {
    const branchRemote = branch === "unknown"
        ? ""
        : gitValue(["config", "--get", `branch.${branch}.remote`], "");
    const pushDefault = gitValue(["config", "--get", "remote.pushDefault"], "");
    for (const remoteName of [branchRemote, pushDefault, "origin"]) {
        if (!remoteName || remoteName === ".") continue;
        const remoteUrl = gitValue(["remote", "get-url", remoteName], "");
        if (remoteUrl) return remoteUrl;
    }
    return "";
}

export function captureSourceSnapshot() {
    const branch = gitValue(["branch", "--show-current"]);
    const remote = remoteUrlForBranch(branch);
    const commitId = gitValue(["rev-parse", "HEAD"]);
    const repository = repositoryNameFromRemote(remote);
    if (repository === "unknown" || commitId === "unknown") {
        throw new Error("Could not resolve exact repository identity and committed SHA");
    }
    const status = gitResult(["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status.status !== 0) throw new Error("Could not determine worktree status");
    return {
        repository,
        branch,
        commitId,
        dirtyEntries: dirtyWorktreeEntries(status.stdout),
    };
}

export function validateSourceSnapshot(expected, actual) {
    if (actual.repository !== expected.repository) {
        throw new Error(
            `Repository identity changed during validation (${expected.repository} -> ${actual.repository})`,
        );
    }
    if (actual.commitId !== expected.commitId) {
        throw new Error(
            `Committed SHA changed during validation (${expected.commitId} -> ${actual.commitId})`,
        );
    }
    if ((actual.dirtyEntries ?? []).length > 0) {
        throw new Error(
            `Worktree changed during validation (${actual.dirtyEntries.length} change(s) found)`,
        );
    }
    return true;
}

function validateCurrentSource(expected) {
    const actual = captureSourceSnapshot();
    validateSourceSnapshot(expected, actual);
    return actual;
}

export function validateSemanticFingerprint(expected, actual) {
    if (actual !== expected) {
        throw new Error("Semantic provider/model fingerprint changed during validation");
    }
    return true;
}

function validateCurrentExecutionContext(
    expectedSource,
    expectedFingerprint,
    env,
    redactionSecrets,
) {
    const source = validateCurrentSource(expectedSource);
    const fingerprint = providerModelFingerprint(env);
    validateSemanticFingerprint(expectedFingerprint, fingerprint);
    if (redactionSecrets) refreshProviderRedactionSecrets(redactionSecrets, env);
    return { source, fingerprint };
}

function persist(state, outputPath, { progress = false, transition = false } = {}) {
    if (manifestFinalized) {
        throw new Error("Refusing campaign state write after terminal finalization");
    }
    const now = new Date().toISOString();
    state.updatedAt = now;
    state.summary = summarizeState(state);
    if (state.currentRun) {
        if (progress) state.currentRun.lastProgressAt = now;
        if (transition) state.currentRun.lastTransitionAt = now;
        if (state.runs && Object.hasOwn(state.runs, state.currentRun.runId)) {
            state.runs[state.currentRun.runId] = structuredClone(state.currentRun);
        }
    }
    atomicWrite(outputPath, `${JSON.stringify(state, null, 2)}\n`);
}

export function parseEnvFile(filePath, baseEnv = process.env) {
    const env = { ...baseEnv };
    const raw = fs.readFileSync(filePath, "utf8");
    for (let line of raw.split(/\r?\n/)) {
        line = line.replace(/\r$/, "");
        if (!line || line.startsWith("#")) continue;
        if (line.startsWith("export ")) line = line.slice("export ".length);
        const separator = line.indexOf("=");
        if (separator <= 0) continue;
        const key = line.slice(0, separator);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        let value = line.slice(separator + 1);
        if ((value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(key in baseEnv)) env[key] = value;
    }
    for (const key of HORIZON_ENV_KEYS) delete env[key];
    env.PS_TEST_SKIP_STALE_CLEANUP = "1";
    env.RUST_LOG ||= "error";
    return env;
}

export function prepareCampaignEnvironment(env, { reportOnly = false } = {}) {
    const prepared = reportOnly
        ? { ...env }
        : testStorageEnvironment("baseline", env);
    if (!prepared.PS_MODEL_PROVIDERS_PATH && prepared.MODEL_PROVIDERS_PATH) {
        prepared.PS_MODEL_PROVIDERS_PATH = prepared.MODEL_PROVIDERS_PATH;
    }
    return prepared;
}

const activeChildren = new Map();
let abortReason = null;
let abortKind = null;
let manifestFinalized = false;
let heartbeatValidationInProgress = false;
const terminationPromises = new Set();
const processCleanupErrors = [];

function runCommand(command, args, {
    cwd = REPO_ROOT,
    env,
    stdio = "inherit",
    track = false,
} = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            env,
            stdio,
            shell: false,
            detached: track && process.platform !== "win32",
        });
        if (track) activeChildren.set(child.pid, child);
        child.on("error", reject);
        child.on("close", (code, signal) => {
            if (track) activeChildren.delete(child.pid);
            resolve({ code: code ?? 1, signal });
        });
        if (track && abortReason) scheduleProcessTermination(child.pid);
    });
}

export function cleanGeneratedBuildOutputs(repoRoot = REPO_ROOT) {
    for (const relativePath of [
        path.join("packages", "sdk", "dist"),
        path.join("packages", "app", "mcp", "dist"),
    ]) {
        fs.rmSync(path.join(repoRoot, relativePath), { recursive: true, force: true });
    }
}

async function buildOnce(env) {
    cleanGeneratedBuildOutputs();
    const runNpm = (args) => process.platform === "win32"
        ? runCommand(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm", ...args], {
            env,
            track: true,
        })
        : runCommand("npm", args, { env, track: true });
    const sdk = await runNpm(["run", "build", "--workspace=packages/sdk"]);
    if (sdk.code !== 0) throw new Error("SDK build failed");
    const mcp = await runNpm(["run", "build:mcp", "--workspace=packages/app"]);
    if (mcp.code !== 0) throw new Error("MCP build failed");
}

async function cleanupOnce(env) {
    const result = await runCommand(
        process.execPath,
        [path.join(REPO_ROOT, "scripts", "cleanup-test-schemas.js")],
        { env, track: true },
    );
    if (result.code !== 0) throw new Error("Stale test cleanup failed");
}

function appendBounded(current, chunk) {
    const combined = current + chunk;
    return combined.length > MAX_CAPTURED_OUTPUT
        ? combined.slice(combined.length - MAX_CAPTURED_OUTPUT)
        : combined;
}

function redactJsonValue(value, env, additionalSecrets, key = "") {
    if (Array.isArray(value)) {
        return value.map((item) => redactJsonValue(item, env, additionalSecrets));
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
            childKey,
            redactJsonValue(childValue, env, additionalSecrets, childKey),
        ]));
    }
    if (typeof value !== "string") return value;
    if (SECRET_FIELD_PATTERN.test(key) && !value.startsWith("env:")) return "***";
    return redactSensitiveText(value, env, additionalSecrets);
}

export function redactNativeReport(
    reportPath,
    env = process.env,
    additionalSecrets = [],
    campaignOutputDirectory = path.dirname(reportPath),
) {
    const canonicalReportPath = resolveReportArtifactPath(
        campaignOutputDirectory,
        reportPath,
    );
    const report = JSON.parse(fs.readFileSync(canonicalReportPath, "utf8"));
    const redacted = redactJsonValue(report, env, additionalSecrets);
    const retainedPath = resolveReportArtifactPath(
        campaignOutputDirectory,
        canonicalReportPath,
    );
    atomicWrite(retainedPath, `${JSON.stringify(redacted, null, 2)}\n`);
    return redacted;
}

export function isNativeVitestReport(report) {
    return Boolean(report
        && typeof report === "object"
        && Array.isArray(report.testResults)
        && Number.isFinite(report.numTotalTests)
        && Number.isFinite(report.numPassedTests)
        && Number.isFinite(report.numFailedTests)
        && Number.isFinite(report.numPendingTests));
}

export function retainVitestReport(
    reportPath,
    env,
    additionalSecrets,
    campaignOutputDirectory,
) {
    if (!fs.existsSync(reportPath)) {
        return {
            valid: false,
            testCounts: null,
            summary: "",
            reportDigest: null,
            evidenceError: "Vitest JSON report was not produced",
        };
    }
    try {
        const report = redactNativeReport(
            reportPath,
            env,
            additionalSecrets,
            campaignOutputDirectory,
        );
        if (!isNativeVitestReport(report)) {
            throw new Error("Vitest JSON report did not match the native report shape");
        }
        let firstFailure = "";
        for (const suite of report.testResults ?? []) {
            for (const assertion of suite.assertionResults ?? []) {
                if (assertion.status !== "failed") continue;
                firstFailure = redactSensitiveText(
                    (assertion.failureMessages ?? []).join("\n"),
                    env,
                    additionalSecrets,
                );
                break;
            }
            if (firstFailure) break;
        }
        const testCounts = {
            total: report.numTotalTests ?? 0,
            passed: report.numPassedTests ?? 0,
            failed: report.numFailedTests ?? 0,
            skipped: report.numPendingTests ?? 0,
            todo: report.numTodoTests ?? 0,
        };
        const suiteFailed = (report.numFailedTestSuites ?? 0) > 0
            || (report.testResults ?? []).some((suite) => suite.status === "failed");
        const summary = firstFailure
            ? compactMessage(firstFailure)
            : suiteFailed
                ? ""
                : `${testCounts.passed} tests passed${testCounts.failed ? `, ${testCounts.failed} failed` : ""}`;
        const retainedPath = resolveReportArtifactPath(
            campaignOutputDirectory,
            reportPath,
        );
        const reportDigest = `sha256:${crypto.createHash("sha256")
            .update(fs.readFileSync(retainedPath))
            .digest("hex")}`;
        return {
            valid: true,
            testCounts,
            summary,
            reportDigest,
            evidenceError: null,
        };
    } catch (error) {
        const safeError = compactMessage(redactSensitiveText(
            error.message,
            env,
            additionalSecrets,
        ));
        try {
            const unsafePath = resolveReportArtifactPath(
                campaignOutputDirectory,
                reportPath,
            );
            fs.rmSync(unsafePath, { force: true });
        } catch {}
        return {
            valid: false,
            testCounts: null,
            summary: "",
            reportDigest: null,
            evidenceError: `Vitest report evidence could not be retained safely: ${safeError}`,
        };
    }
}

async function terminateProcessTree(pid) {
    if (!pid) return;
    if (process.platform === "win32") {
        const script = `
$rootProcessId = ${Number(pid)}
$ids = [System.Collections.Generic.List[int]]::new()
function Add-Descendants([int]$parentId) {
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$parentId" -ErrorAction SilentlyContinue | ForEach-Object {
        Add-Descendants ([int]$_.ProcessId)
        $ids.Add([int]$_.ProcessId)
    }
}
Add-Descendants $rootProcessId
$ids.Add($rootProcessId)
$ids | Sort-Object -Descending -Unique | ForEach-Object {
    Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
}
`;
        const result = await runCommand(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", script],
            {
                stdio: "ignore",
            },
        );
        if (result.code !== 0) {
            throw new Error(`Process-tree termination failed for PID ${pid}`);
        }
        return;
    }
    try {
        process.kill(-pid, "SIGTERM");
    } catch (error) {
        if (error.code !== "ESRCH") throw error;
    }
    try {
        process.kill(pid, "SIGTERM");
    } catch (error) {
        if (error.code !== "ESRCH") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
        process.kill(-pid, "SIGKILL");
    } catch (error) {
        if (error.code !== "ESRCH") throw error;
    }
    try {
        process.kill(pid, "SIGKILL");
    } catch (error) {
        if (error.code !== "ESRCH") throw error;
    }
}

export async function superviseProcessDeadline({
    closed,
    deadlineMs,
    terminate,
    identityStillLive,
    cleanupGraceMs = TIMEOUT_CLEANUP_GRACE_MS,
}) {
    let deadlineTimer;
    const deadline = new Promise((resolve) => {
        deadlineTimer = setTimeout(() => resolve({ type: "deadline" }), deadlineMs);
    });
    const first = await Promise.race([
        closed.then((result) => ({ type: "closed", result })),
        deadline,
    ]);
    clearTimeout(deadlineTimer);
    if (first.type === "closed") {
        return {
            ...first.result,
            timedOut: false,
            timeoutProcessDisposition: null,
        };
    }

    let cleanupTimer;
    const cleanupTimeout = new Promise((resolve, reject) => {
        cleanupTimer = setTimeout(
            () => reject(new Error(
                `Timed-out process did not terminate within ${cleanupGraceMs}ms`,
            )),
            cleanupGraceMs,
        );
    });
    let closeResult;
    try {
        closeResult = await Promise.race([
            Promise.all([
                Promise.resolve().then(terminate),
                closed,
            ]).then(([, result]) => result),
            cleanupTimeout,
        ]);
    } finally {
        clearTimeout(cleanupTimer);
    }
    if (await identityStillLive()) {
        throw new Error("Timed-out process identity remained live after process-tree termination");
    }
    return {
        ...closeResult,
        timedOut: true,
        timeoutProcessDisposition: "terminated-and-verified",
    };
}

export async function terminateRecordedProcessTrees(records, {
    terminate = terminateProcessTree,
    inspectProcess = getProcessIdentity,
    isProcessAlive = processAppearsAlive,
    discoverDescendants = discoverRecordedDescendants,
    freezeProcess = (pid, signal) => process.kill(pid, signal),
    cleanupGraceMs = TIMEOUT_CLEANUP_GRACE_MS,
    pollIntervalMs = 25,
} = {}) {
    const roots = [...new Map(
        records
            .filter((record) => Number.isInteger(record?.pid) && record.pid > 0)
            .map((record) => [record.pid, record]),
    ).values()];
    const processRecords = new Map(roots.map((record) => [record.pid, record]));
    if (process.platform !== "win32") {
        let stable = false;
        let priorSize = -1;
        for (let attempt = 0; attempt < 5; attempt++) {
            const descendants = discoverDescendants([...processRecords.values()], {
                inspectProcess,
                isProcessAlive,
            });
            for (const descendant of descendants) {
                processRecords.set(descendant.pid, descendant);
            }
            for (const record of processRecords.values()) {
                const actual = inspectProcess(record.pid);
                if (!record.processIdentity
                    || !processIdentitiesMatch(record.processIdentity, actual)) {
                    continue;
                }
                try {
                    if (record.treeRoot) freezeProcess(-record.pid, "SIGSTOP");
                    freezeProcess(record.pid, "SIGSTOP");
                } catch (error) {
                    if (error.code !== "ESRCH") throw error;
                }
            }
            if (processRecords.size === priorSize) {
                stable = true;
                break;
            }
            priorSize = processRecords.size;
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
        if (!stable) {
            throw new Error("Attempt process inventory did not stabilize before cleanup");
        }
    }
    const unique = [...processRecords.values()]
        .sort((left, right) => (right.depth ?? 0) - (left.depth ?? 0));
    const terminatePromises = [];
    for (const record of unique) {
        const actual = inspectProcess(record.pid);
        if (!record.processIdentity && actual) {
            throw new Error(
                `PID ${record.pid} remains live without a safely recorded process identity`,
            );
        }
        if (record.processIdentity
            && processIdentitiesMatch(record.processIdentity, actual)) {
            terminatePromises.push(Promise.resolve().then(() => terminate(record.pid)));
            continue;
        }
        if (record.treeRoot && !actual && !isProcessAlive(record.pid)) {
            terminatePromises.push(Promise.resolve().then(() => terminate(record.pid)));
        }
    }

    let cleanupTimer;
    try {
        await Promise.race([
            Promise.all(terminatePromises),
            new Promise((resolve, reject) => {
                cleanupTimer = setTimeout(
                    () => reject(new Error(
                        `Process-tree cleanup did not finish within ${cleanupGraceMs}ms`,
                    )),
                    cleanupGraceMs,
                );
            }),
        ]);
    } finally {
        clearTimeout(cleanupTimer);
    }

    const expiresAt = Date.now() + cleanupGraceMs;
    while (true) {
        let recordedIdentityStillLive = false;
        for (const record of unique) {
            const actual = inspectProcess(record.pid);
            if (record.processIdentity
                && processIdentitiesMatch(record.processIdentity, actual)) {
                recordedIdentityStillLive = true;
                continue;
            }
            if (!actual && isProcessAlive(record.pid)) {
                throw new Error(
                    `PID ${record.pid} remains live but its process identity cannot be resolved safely`,
                );
            }
        }
        if (!recordedIdentityStillLive) return {
            disposition: "terminated-and-verified",
            processes: unique.map((record) => ({
                pid: record.pid,
                role: record.role ?? null,
            })),
        };
        if (Date.now() >= expiresAt) {
            throw new Error("Recorded process identity remained live after process-tree cleanup");
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
}

export function fallbackFailureSummary(output, env, additionalSecrets = []) {
    const lines = stripAnsi(redactSensitiveText(output, env, additionalSecrets))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const explicitError = lines.find((line) =>
        /^(?:AggregateError|AssertionError|Error|RangeError|ReferenceError|SyntaxError|TypeError):\s/.test(line),
    );
    const failedSuite = lines.find((line) => /^FAIL\s+\S/.test(line));
    return compactMessage(
        explicitError
        || failedSuite
        || lines.at(-1)
        || "Vitest exited without a structured failure",
    );
}

export function classifyAttemptEvidence({
    abort = null,
    timedOut,
    timeoutMs,
    abnormalGateExit,
    abnormalMessage = null,
    code,
    parsed,
    output = "",
    env = {},
    redactionSecrets = [],
}) {
    if (abort) {
        return {
            status: "interrupted",
            collectionStatus: "interrupted",
            summary: abort,
        };
    }
    if (timedOut) {
        return {
            status: "timed_out",
            collectionStatus: "complete",
            summary: `Timed out after ${formatDuration(timeoutMs)}`,
        };
    }
    if (abnormalGateExit) {
        return {
            status: "interrupted",
            collectionStatus: "failed",
            summary: compactMessage(redactSensitiveText(
                abnormalMessage ?? "Attempt gate terminated abnormally",
                env,
                redactionSecrets,
            )),
        };
    }
    if (code === 0 && parsed.valid && parsed.testCounts.failed === 0) {
        return {
            status: "passed",
            collectionStatus: "complete",
            summary: `${parsed.testCounts.passed} tests passed`,
        };
    }
    if (code === 0) {
        return {
            status: "interrupted",
            collectionStatus: "failed",
            summary: `Evidence failure: ${parsed.evidenceError
                || "Vitest reported success with failed native report counts"}`,
        };
    }
    if (parsed.valid) {
        return {
            status: "failed",
            collectionStatus: "complete",
            summary: parsed.summary || fallbackFailureSummary(output, env, redactionSecrets),
        };
    }
    return {
        status: "interrupted",
        collectionStatus: "failed",
        summary: parsed.summary || fallbackFailureSummary(output, env, redactionSecrets),
    };
}

function reportPathForAttempt(outputPath, state, runId, roundNumber, file, attemptNumber) {
    const safeFile = file.replace(/[^A-Za-z0-9_.-]+/g, "-");
    const safeRun = runId.replace(/[^A-Za-z0-9_.-]+/g, "-");
    return path.join(
        path.dirname(outputPath),
        "reports",
        state.campaignId.slice("sha256:".length, "sha256:".length + 16),
        safeRun,
        `round-${roundNumber}-attempt-${attemptNumber}-${safeFile}.json`,
    );
}

export function resolveReportArtifactPath(
    campaignOutputDirectory,
    reportPath,
    { createParent = false } = {},
) {
    const canonicalOutputDirectory = fs.realpathSync(campaignOutputDirectory);
    const requestedPath = path.resolve(reportPath);
    if (!pathIsInside(canonicalOutputDirectory, requestedPath)) {
        throw new Error("Report artifact path is outside the campaign output directory");
    }
    const requestedParent = path.dirname(requestedPath);
    const relativeParent = path.relative(canonicalOutputDirectory, requestedParent);
    if (relativeParent === ".."
        || relativeParent.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativeParent)) {
        throw new Error("Report artifact parent is outside the campaign output directory");
    }
    let canonicalParent = canonicalOutputDirectory;
    for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
        const next = path.join(canonicalParent, segment);
        if (!fs.existsSync(next)) {
            if (!createParent) throw new Error("Report artifact parent does not exist");
            fs.mkdirSync(next, { mode: 0o700 });
        }
        canonicalParent = fs.realpathSync(next);
        if (normalizedPathForComparison(canonicalParent)
            !== normalizedPathForComparison(canonicalOutputDirectory)
            && !pathIsInside(canonicalOutputDirectory, canonicalParent)) {
            throw new Error("Report artifact parent resolves outside the campaign output directory");
        }
    }
    const canonicalCandidate = path.join(canonicalParent, path.basename(requestedPath));
    if (fs.existsSync(canonicalCandidate)) {
        const stats = fs.lstatSync(canonicalCandidate);
        if (stats.isSymbolicLink()) {
            throw new Error("Report artifact must not be a symbolic link or junction");
        }
        const canonicalExisting = fs.realpathSync(canonicalCandidate);
        if (!pathIsInside(canonicalOutputDirectory, canonicalExisting)) {
            throw new Error("Report artifact resolves outside the campaign output directory");
        }
    }
    return canonicalCandidate;
}

function resolveRetainedReportPath(outputPath, relativeReportPath) {
    const outputDirectory = path.dirname(outputPath);
    const reportPath = path.resolve(outputDirectory, relativeReportPath);
    return resolveReportArtifactPath(outputDirectory, reportPath);
}

const VITEST_CHILD_GATE_SOURCE = `
import { pathToFileURL } from "node:url";
const payload = JSON.parse(process.argv[1]);
let started = false;
process.send?.({ type: "ready" });
process.on("message", async (message) => {
    if (message?.type !== "start" || started) return;
    started = true;
    process.disconnect?.();
    process.chdir(payload.cwd);
    process.argv = [payload.command, ...payload.args];
    try {
        await import(pathToFileURL(payload.args[0]).href);
    } catch (error) {
        console.error(error.stack || error.message || error);
        process.exitCode = 1;
    }
});
setInterval(() => {}, 60000).unref();
`;

const ATTEMPT_GATE_SOURCE = `
import { spawn } from "node:child_process";
const payload = JSON.parse(process.argv[1]);
let started = false;
let child = null;
process.send?.({ type: "ready" });
process.on("message", (message) => {
    if (message?.type === "vitest-start" && child) {
        child.send?.({ type: "start" });
        return;
    }
    if (message?.type !== "start" || started) return;
    started = true;
    child = spawn(process.execPath, [
        "--input-type=module",
        "-e",
        ${JSON.stringify(VITEST_CHILD_GATE_SOURCE)},
        JSON.stringify(payload),
    ], {
        cwd: payload.cwd,
        env: process.env,
        shell: false,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    child.on("message", (childMessage) => {
        if (childMessage?.type === "ready") {
            process.send?.({ type: "vitest-spawned", pid: child.pid });
        }
    });
    child.on("error", (error) => {
        process.send?.({ type: "vitest-spawn-error", message: error.message });
        console.error(error.stack || error.message || error);
        process.exit(1);
    });
    child.on("close", (code, signal) => {
        if (signal) process.kill(process.pid, signal);
        else process.exit(code ?? 1);
    });
});
setInterval(() => {}, 60000).unref();
`;

export async function runTestFile(
    file,
    timeoutMs,
    env,
    reportPath,
    tagsFilter,
    {
        startedAt,
        deadlineAt,
        onReady,
        onVitestReady = async () => {},
        campaignOutputDirectory = path.dirname(reportPath),
        redactionSecrets = [],
        refreshSecrets = null,
        inspectProcess = getProcessIdentity,
        isProcessAlive = processAppearsAlive,
        terminate = terminateProcessTree,
        freezeProcess = (pid, signal) => process.kill(pid, signal),
        identityAttempts = 10,
        cleanupGraceMs = TIMEOUT_CLEANUP_GRACE_MS,
    },
) {
    const startTime = Date.parse(startedAt);
    const safeReportPath = resolveReportArtifactPath(
        campaignOutputDirectory,
        reportPath,
        { createParent: true },
    );
    fs.writeFileSync(safeReportPath, "", { mode: 0o600 });
    const vitestPath = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
    const reportArgumentPath = path.relative(SDK_DIR, safeReportPath).replaceAll(path.sep, "/");
    const vitestArgs = [
        vitestPath,
        "run",
        `test/local/${file}`,
        "--reporter=default",
        "--reporter=json",
        `--outputFile.json=${reportArgumentPath}`,
    ];
    if (tagsFilter) vitestArgs.push(`--tagsFilter=${tagsFilter}`);
    const payload = JSON.stringify({
        command: process.execPath,
        args: vitestArgs,
        cwd: SDK_DIR,
    });
    let output = "";
    let spawnError = null;
    let vitestPid = null;
    let vitestProcessIdentity = null;
    let vitestProcessSettled = false;
    let resolveVitestProcess;
    let rejectVitestProcess;
    const vitestProcessReady = new Promise((resolve, reject) => {
        resolveVitestProcess = resolve;
        rejectVitestProcess = reject;
    });
    const vitestProcessFailure = vitestProcessReady.then(
        () => new Promise(() => {}),
        (error) => ({ type: "vitest-process-error", error }),
    );
    const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", ATTEMPT_GATE_SOURCE, payload],
        {
            cwd: SDK_DIR,
            env,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe", "ipc"],
            shell: false,
        },
    );
    activeChildren.set(child.pid, child);
    child.stdout.on("data", (chunk) => {
        output = appendBounded(output, chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
        output = appendBounded(output, chunk.toString());
    });
    child.on("error", (error) => {
        spawnError = error;
    });
    child.on("message", (message) => {
        if (message?.type === "vitest-spawn-error" && !vitestProcessSettled) {
            vitestProcessSettled = true;
            rejectVitestProcess(new Error(
                `Vitest child could not be spawned for ${file}: ${message.message}`,
            ));
            return;
        }
        if (message?.type !== "vitest-spawned" || vitestProcessSettled || vitestPid) return;
        vitestPid = message.pid;
        void waitForProcessIdentity(vitestPid, {
            inspectProcess,
            attempts: identityAttempts,
            delayMs: 10,
        }).then(async (identity) => {
            if (!identity) {
                throw new Error(
                    `Could not verify spawned Vitest process identity for ${file}`,
                );
            }
            vitestProcessIdentity = identity;
            await onVitestReady({
                pid: vitestPid,
                processIdentity: vitestProcessIdentity,
            });
            child.send({ type: "vitest-start" });
            vitestProcessSettled = true;
            resolveVitestProcess({
                pid: vitestPid,
                processIdentity: vitestProcessIdentity,
            });
        }).catch((error) => {
            vitestProcessSettled = true;
            rejectVitestProcess(error);
        });
    });
    const closed = new Promise((resolve) => {
        child.once("close", (code, signal) => {
            activeChildren.delete(child.pid);
            if (!vitestPid && !vitestProcessSettled) {
                vitestProcessSettled = true;
                rejectVitestProcess(new Error(
                    `Attempt gate exited before reporting the Vitest child for ${file}`,
                ));
            }
            resolve({ code, signal });
        });
    });
    await new Promise((resolve, reject) => {
        const readyTimer = setTimeout(
            () => reject(new Error(`Attempt process gate did not become ready for ${file}`)),
            ATTEMPT_GATE_READY_TIMEOUT_MS,
        );
        child.once("message", (message) => {
            if (message?.type !== "ready") return;
            clearTimeout(readyTimer);
            resolve();
        });
        child.once("error", (error) => {
            clearTimeout(readyTimer);
            reject(error);
        });
        child.once("close", (code, signal) => {
            clearTimeout(readyTimer);
            reject(new Error(`Attempt process gate exited before start (${code ?? signal})`));
        });
    });
    const processIdentity = await waitForProcessIdentity(child.pid, {
        inspectProcess,
        attempts: identityAttempts,
    });
    if (!processIdentity) {
        let cleanupTimer;
        try {
            await Promise.race([
                Promise.all([
                    Promise.resolve().then(() => terminate(child.pid)),
                    closed,
                ]),
                new Promise((resolve, reject) => {
                    cleanupTimer = setTimeout(
                        () => reject(new Error(
                            `Unverified attempt gate did not terminate within ${cleanupGraceMs}ms`,
                        )),
                        cleanupGraceMs,
                    );
                }),
            ]);
        } finally {
            clearTimeout(cleanupTimer);
        }
        if (isProcessAlive(child.pid)) {
            throw new Error(
                `Unverified attempt gate PID ${child.pid} remained live after cleanup`,
            );
        }
        fs.rmSync(safeReportPath, { force: true });
        throw new Error(`Could not verify attempt process identity for ${file}; test was not started`);
    }
    await onReady({ pid: child.pid, processIdentity });
    if (abortReason) {
        scheduleProcessTermination(child.pid);
        throw new Error(abortReason);
    }
    child.send({ type: "start" });
    const recordedProcesses = () => [
        {
            role: "attempt-gate",
            pid: child.pid,
            processIdentity,
            treeRoot: true,
        },
        ...(vitestPid ? [{
            role: "vitest-child",
            pid: vitestPid,
            processIdentity: vitestProcessIdentity,
        }] : []),
    ];
    const cleanupRecordedProcesses = () => terminateRecordedProcessTrees(
        recordedProcesses(),
        {
            terminate,
            inspectProcess,
            isProcessAlive,
            freezeProcess,
            cleanupGraceMs,
        },
    );
    let supervised;
    const supervision = superviseProcessDeadline({
        closed,
        deadlineMs: Math.max(1, Date.parse(deadlineAt) - Date.now()),
        terminate: cleanupRecordedProcesses,
        identityStillLive: () => recordedProcesses().some((record) => {
            const actual = inspectProcess(record.pid);
            return record.processIdentity
                ? processIdentitiesMatch(record.processIdentity, actual)
                    || (!actual && isProcessAlive(record.pid))
                : Boolean(actual || isProcessAlive(record.pid));
        }),
        cleanupGraceMs,
    }).then((result) => ({ type: "supervised", result }));
    const first = await Promise.race([supervision, vitestProcessFailure]);
    if (first.type === "vitest-process-error") {
        await cleanupRecordedProcesses();
        fs.rmSync(safeReportPath, { force: true });
        throw first.error;
    }
    supervised = first.result;
    try {
        await vitestProcessReady;
    } catch (error) {
        await cleanupRecordedProcesses();
        fs.rmSync(safeReportPath, { force: true });
        throw error;
    }
    const {
        code,
        signal,
        timedOut,
        timeoutProcessDisposition,
    } = supervised;
    const abnormalGateExit = Boolean(spawnError || signal || !Number.isInteger(code));
    let abnormalProcessDisposition = null;
    if (!timedOut && abnormalGateExit) {
        const cleanup = await cleanupRecordedProcesses();
        abnormalProcessDisposition = cleanup.disposition;
    }
    const finishedAt = new Date();
    const durationMs = Date.now() - startTime;
    await refreshSecrets?.();
    const parsed = retainVitestReport(
        safeReportPath,
        env,
        redactionSecrets,
        campaignOutputDirectory,
    );
    const {
        status,
        collectionStatus,
        summary,
    } = classifyAttemptEvidence({
        abort: abortReason,
        timedOut,
        timeoutMs,
        abnormalGateExit,
        abnormalMessage: spawnError?.message
            ?? `Attempt gate terminated abnormally (${signal ?? "missing exit code"})`,
        code,
        parsed,
        output,
        env,
        redactionSecrets,
    });
    return {
        startedAt,
        deadlineAt,
        finishedAt: finishedAt.toISOString(),
        durationMs,
        status,
        collectionStatus,
        exitCode: code,
        signal,
        timedOut,
        processDeadlineMs: timeoutMs,
        pid: child.pid,
        processIdentity,
        processIdentityVerified: true,
        vitestPid,
        vitestProcessIdentity,
        vitestProcessIdentityVerified: Boolean(vitestProcessIdentity),
        timeoutProcessDisposition,
        abnormalProcessDisposition,
        reportEvidenceValid: parsed.valid,
        reportDigest: parsed.reportDigest,
        evidenceError: timedOut ? null : parsed.evidenceError,
        optionalReportError: timedOut ? parsed.evidenceError : null,
        summary: compactMessage(redactSensitiveText(summary, env, redactionSecrets)),
        testCounts: parsed.testCounts,
    };
}

export function beginAttempt(state, file, {
    runId,
    testedRevision,
    roundNumber,
    attemptKind = "initial",
    retryTarget = null,
    reportPath,
    startedAt,
    deadlineAt,
}) {
    const entry = state.tests[file] ?? emptyTestState();
    const attempt = {
        number: entry.attempts.length + 1,
        runId,
        round: roundNumber,
        attemptKind,
        retryTarget,
        source: "validation-campaign-runner",
        testedRevision,
        reportPath,
        status: "running",
        collectionStatus: "running",
        startedAt,
        deadlineAt,
        pid: null,
        processIdentity: null,
        vitestPid: null,
        vitestProcessIdentity: null,
        finishedAt: null,
    };
    entry.attempts.push(attempt);
    state.tests[file] = entry;
    return attempt;
}

export function completeAttempt(state, file, attemptNumber, result) {
    const entry = state.tests[file];
    const attempt = entry?.attempts?.find((candidate) => candidate.number === attemptNumber);
    if (!attempt) throw new Error(`Attempt ${attemptNumber} for ${file} was not persisted`);
    Object.assign(attempt, result);
    entry.status = result.status ?? "interrupted";
    entry.collectionStatus = result.collectionStatus;
    entry.latestDurationMs = result.durationMs;
    entry.lastRunAt = result.finishedAt;
    entry.notes = result.summary;
    return attempt;
}

export function reconcileActiveEntries(
    state,
    run,
    reason,
    now = new Date().toISOString(),
) {
    let reconciled = 0;
    for (const [file, active] of Object.entries(run?.activeFiles ?? {})) {
        const entry = state.tests[file];
        const attempt = entry?.attempts?.find(
            (candidate) => candidate.number === active.attemptNumber
                && candidate.runId === run.runId,
        );
        if (attempt?.status === "running") {
            attempt.status = "interrupted";
            attempt.collectionStatus = "interrupted";
            attempt.finishedAt = now;
            attempt.durationMs = Math.max(0, Date.parse(now) - Date.parse(attempt.startedAt));
            attempt.exitCode = null;
            attempt.signal = null;
            attempt.timedOut = false;
            attempt.summary = reason;
            attempt.processDisposition ??= "reconciled";
            entry.status = "interrupted";
            entry.collectionStatus = "interrupted";
            entry.latestDurationMs = attempt.durationMs;
            entry.lastRunAt = now;
            entry.notes = reason;
            reconciled++;
        }
        const round = run.rounds?.find((candidate) => candidate.number === active.round);
        if (round && round.active > 0) {
            round.active--;
            round.completed = Math.min(round.total, round.completed + 1);
            round.remaining = Math.max(0, round.remaining - 1);
            round.status = "interrupted";
            round.finishedAt ??= now;
        }
        delete run.activeFiles[file];
    }
    if (reconciled > 0) run.lastProgressAt = now;
    run.lastTransitionAt = now;
    return reconciled;
}

export function redactActiveReports(state, run, outputPath, env, redactionSecrets) {
    for (const [file, active] of Object.entries(run?.activeFiles ?? {})) {
        const attempt = state.tests[file]?.attempts?.find(
            (candidate) => candidate.number === active.attemptNumber
                && candidate.runId === run.runId,
        );
        if (!attempt?.reportPath) continue;
        try {
            const reportPath = resolveRetainedReportPath(outputPath, attempt.reportPath);
            if (!fs.existsSync(reportPath)) continue;
            const retained = retainVitestReport(
                reportPath,
                env,
                redactionSecrets,
                path.dirname(outputPath),
            );
            if (!retained.valid) attempt.evidenceError = retained.evidenceError;
        } catch (error) {
            attempt.evidenceError = `Report containment failure: ${error.message}`;
        }
    }
}

export async function reconcileStaleRun(state, reason, {
    inspectProcess = getProcessIdentity,
    isProcessAlive = processAppearsAlive,
    terminate = terminateProcessTree,
    freezeProcess = (pid, signal) => process.kill(pid, signal),
    redactReport = null,
    now = new Date().toISOString(),
    cleanupGraceMs = TIMEOUT_CLEANUP_GRACE_MS,
} = {}) {
    const run = state.currentRun;
    if (!run || !["running", "stopping"].includes(run.status)) return { reconciled: 0, processes: [] };
    if (run.coordinatorProcessIdentity) {
        const coordinator = inspectProcess(run.coordinatorProcessIdentity.pid);
        if (processIdentitiesMatch(run.coordinatorProcessIdentity, coordinator)) {
            throw new Error(
                `Prior validation coordinator is still live (PID ${run.coordinatorProcessIdentity.pid})`,
            );
        }
        if (!coordinator && isProcessAlive(run.coordinatorProcessIdentity.pid)) {
            throw new Error(
                `Prior coordinator PID ${run.coordinatorProcessIdentity.pid} is live but its creation identity cannot be verified`,
            );
        }
    }
    const processes = [];
    for (const [file, active] of Object.entries(run.activeFiles ?? {})) {
        const recordedProcesses = [
            {
                role: "attempt-gate",
                pid: active.pid,
                processIdentity: active.processIdentity,
                treeRoot: true,
            },
            {
                role: "vitest-child",
                pid: active.vitestPid,
                processIdentity: active.vitestProcessIdentity,
            },
        ].filter((record) => Number.isInteger(record.pid) && record.pid > 0);
        const cleanup = await terminateRecordedProcessTrees(recordedProcesses, {
            terminate,
            inspectProcess,
            isProcessAlive,
            freezeProcess,
            cleanupGraceMs,
        });
        const disposition = recordedProcesses.length > 0
            ? cleanup.disposition
            : "not-running";
        const attempt = state.tests[file]?.attempts?.find(
            (candidate) => candidate.number === active.attemptNumber
                && candidate.runId === run.runId,
        );
        if (attempt) {
            attempt.processDisposition = disposition;
            await redactReport?.(attempt);
        }
        processes.push({
            file,
            pid: active.pid ?? null,
            vitestPid: active.vitestPid ?? null,
            disposition,
        });
    }
    const reconciled = reconcileActiveEntries(state, run, reason, now);
    for (const round of run.rounds ?? []) {
        if (!["complete", "interrupted"].includes(round.status)) {
            round.status = "interrupted";
            round.finishedAt ??= now;
        }
    }
    run.status = "interrupted";
    run.terminalReason = reason;
    run.finishedAt = now;
    state.status = "interrupted";
    state.terminalReason = reason;
    archiveCurrentRun(state);
    return { reconciled, processes };
}

function normalizedPathForComparison(value) {
    const normalized = path.resolve(value).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function pathIsInside(root, candidate) {
    const normalizedRoot = normalizedPathForComparison(root);
    const normalizedCandidate = normalizedPathForComparison(candidate);
    return normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
        && normalizedCandidate !== normalizedRoot;
}

function canonicalizePotentialPath(value) {
    const resolved = path.resolve(value);
    let existing = resolved;
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) return resolved;
        existing = parent;
    }
    return path.resolve(fs.realpathSync(existing), path.relative(existing, resolved));
}

export function resolveOutputPath(value, repoRoot = REPO_ROOT, optionName = "--output") {
    const canonicalRepoRoot = fs.realpathSync(repoRoot);
    const resultsRoot = path.join(canonicalRepoRoot, "test-results");
    const requested = path.isAbsolute(value)
        ? path.resolve(value)
        : path.resolve(canonicalRepoRoot, value);
    const candidate = canonicalizePotentialPath(requested);
    if (!pathIsInside(resultsRoot, candidate)) {
        throw new Error(
            `${optionName} must be a file beneath the repository test-results directory`,
        );
    }
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        throw new Error(`${optionName} must name a JSON file, not a directory`);
    }
    if (fs.existsSync(resultsRoot)) {
        const canonicalResultsRoot = fs.realpathSync(resultsRoot);
        let existingParent = path.dirname(candidate);
        while (!fs.existsSync(existingParent)) {
            const parent = path.dirname(existingParent);
            if (parent === existingParent) break;
            existingParent = parent;
        }
        const canonicalParent = fs.realpathSync(existingParent);
        if (normalizedPathForComparison(canonicalParent)
            !== normalizedPathForComparison(canonicalResultsRoot)
            && !pathIsInside(canonicalResultsRoot, canonicalParent)) {
            throw new Error(
                `${optionName} resolves outside test-results through a linked directory`,
            );
        }
    }
    return candidate;
}

function scheduleProcessTermination(pid) {
    const promise = terminateProcessTree(pid)
        .catch((error) => {
            processCleanupErrors.push(error);
        })
        .finally(() => terminationPromises.delete(promise));
    terminationPromises.add(promise);
    return promise;
}

function terminateActiveProcesses() {
    for (const pid of activeChildren.keys()) scheduleProcessTermination(pid);
}

async function waitForActiveProcesses() {
    await Promise.allSettled([...terminationPromises]);
    while (activeChildren.size > 0) {
        terminateActiveProcesses();
        await Promise.allSettled([...terminationPromises]);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (processCleanupErrors.length > 0) {
        const errors = processCleanupErrors.splice(0);
        throw new AggregateError(
            errors,
            "One or more validation process trees could not be terminated safely",
        );
    }
}

function requestCoordinatorStop(kind, reason, state, outputPath) {
    if (abortReason) return;
    abortKind = kind;
    abortReason = compactMessage(reason, 1000);
    state.status = kind === "signal" ? "interrupted" : "failed";
    state.terminalReason = abortReason;
    if (state.currentRun) {
        state.currentRun.status = "stopping";
        state.currentRun.terminalReason = abortReason;
    }
    if (!manifestFinalized) persist(state, outputPath, { transition: true });
    terminateActiveProcesses();
}

function installSignalHandlers(state, outputPath) {
    const stop = (signal) => {
        requestCoordinatorStop("signal", `Runner interrupted by ${signal}`, state, outputPath);
        console.error(`\n${abortReason}; stopping ${activeChildren.size} active process(es)...`);
    };
    const onSigint = () => stop("SIGINT");
    const onSigterm = () => stop("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    return () => {
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGTERM", onSigterm);
    };
}

function startHeartbeat(
    state,
    outputPath,
    expectedSource,
    expectedFingerprint,
    env,
    redactionSecrets,
) {
    const timer = setInterval(() => {
        if (manifestFinalized
            || heartbeatValidationInProgress
            || !state.currentRun
            || !["running", "stopping"].includes(state.currentRun.status)) return;
        heartbeatValidationInProgress = true;
        try {
            state.currentRun.heartbeatAt = new Date().toISOString();
            validateCurrentExecutionContext(
                expectedSource,
                expectedFingerprint,
                env,
                redactionSecrets,
            );
            persist(state, outputPath);
        } catch (error) {
            requestCoordinatorStop(
                "source-validation",
                `Execution context validation failed during heartbeat: ${error.message}`,
                state,
                outputPath,
            );
        } finally {
            heartbeatValidationInProgress = false;
        }
    }, HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
}

async function executeRound({
    state,
    outputPath,
    files,
    roundNumber,
    kind,
    attemptKind = kind,
    retryTarget = null,
    recoveryOf = null,
    concurrency,
    timeoutMs,
    env,
    runId,
    testedRevision,
    tagsFilter,
    expectedSource,
    expectedFingerprint,
    redactionSecrets,
}) {
    const scheduledFiles = orderFilesForScheduling(state, files);
    const round = createRoundState(
        roundNumber,
        kind,
        scheduledFiles,
        concurrency,
        new Date().toISOString(),
        retryTarget,
        recoveryOf,
    );
    state.currentRun.rounds.push(round);
    state.currentRun.phase = kind;
    state.currentRun.round = roundNumber;
    markRoundStarted(round);
    persist(state, outputPath, { transition: true });

    const queue = [...scheduledFiles];
    let completedAttempts = 0;
    let firstError = null;
    async function worker(slot) {
        try {
            while (!abortReason) {
                try {
                    validateCurrentExecutionContext(
                        expectedSource,
                        expectedFingerprint,
                        env,
                        redactionSecrets,
                    );
                } catch (error) {
                    requestCoordinatorStop(
                        "source-validation",
                        `Execution context validation failed before attempt assignment: ${error.message}`,
                        state,
                        outputPath,
                    );
                    throw error;
                }
                if (abortReason) return;
                const file = queue.shift();
                if (!file) return;
                const attemptNumber = (state.tests[file]?.attempts.length ?? 0) + 1;
                const absoluteReportPath = reportPathForAttempt(
                    outputPath,
                    state,
                    runId,
                    roundNumber,
                    file,
                    attemptNumber,
                );
                const relativeReportPath = path.relative(
                    path.dirname(outputPath),
                    absoluteReportPath,
                ).replaceAll(path.sep, "/");
                const started = new Date();
                const startedAt = started.toISOString();
                const deadlineAt = new Date(started.getTime() + timeoutMs).toISOString();
                markRoundFileStarted(round);
                const attempt = beginAttempt(state, file, {
                    runId,
                    testedRevision,
                    roundNumber,
                    attemptKind,
                    retryTarget,
                    reportPath: relativeReportPath,
                    startedAt,
                    deadlineAt,
                });
                state.currentRun.activeFiles[file] = {
                    slot,
                    round: roundNumber,
                    attemptNumber: attempt.number,
                    reportPath: relativeReportPath,
                    pid: null,
                    processIdentity: null,
                    startedAt,
                    deadlineAt,
                };
                persist(state, outputPath, { transition: true });
                console.log(`[${kind} ${roundNumber}, slot ${slot}] ${file}`);

                let result = await runTestFile(
                    file,
                    timeoutMs,
                    env,
                    absoluteReportPath,
                    tagsFilter,
                    {
                        startedAt,
                        deadlineAt,
                        onReady: async ({ pid, processIdentity }) => {
                            if (abortReason) throw new Error(abortReason);
                            attempt.pid = pid;
                            attempt.processIdentity = processIdentity;
                            state.currentRun.activeFiles[file].pid = pid;
                            state.currentRun.activeFiles[file].processIdentity = processIdentity;
                            persist(state, outputPath, { transition: true });
                        },
                        onVitestReady: async ({ pid, processIdentity }) => {
                            if (abortReason) throw new Error(abortReason);
                            attempt.vitestPid = pid;
                            attempt.vitestProcessIdentity = processIdentity;
                            state.currentRun.activeFiles[file].vitestPid = pid;
                            state.currentRun.activeFiles[file].vitestProcessIdentity = processIdentity;
                            persist(state, outputPath, { transition: true });
                        },
                        campaignOutputDirectory: path.dirname(outputPath),
                        redactionSecrets,
                        refreshSecrets: async () => {
                            refreshProviderRedactionSecrets(redactionSecrets, env);
                        },
                    },
                );
                let sourceError = null;
                try {
                    validateCurrentExecutionContext(
                        expectedSource,
                        expectedFingerprint,
                        env,
                        redactionSecrets,
                    );
                } catch (error) {
                    sourceError = error;
                    const reason = `Execution context validation failed after ${file}: ${error.message}`;
                    result = {
                        ...result,
                        status: "interrupted",
                        collectionStatus: "interrupted",
                        summary: reason,
                    };
                    requestCoordinatorStop("source-validation", reason, state, outputPath);
                }
                if (result.timedOut && !result.reportEvidenceValid) {
                    result.reportPath = null;
                }
                completeAttempt(state, file, attempt.number, result);
                delete state.currentRun.activeFiles[file];
                markRoundFileCompleted(round);
                completedAttempts++;
                persist(state, outputPath, { progress: true, transition: true });
                console.log(
                    `[${kind} ${roundNumber}: ${round.completed}/${round.total}] `
                    + `${statusToDisplay(result.status)} ${file} (${formatDuration(result.durationMs)}): `
                    + result.summary,
                );
                if (result.collectionStatus !== "complete") {
                    const error = new Error(
                        `Attempt evidence was not completed safely for ${file}: ${result.summary}`,
                    );
                    requestCoordinatorStop(
                        result.collectionStatus === "interrupted" && abortKind === "signal"
                            ? "signal"
                            : "evidence-failure",
                        error.message,
                        state,
                        outputPath,
                    );
                    throw error;
                }
                if (sourceError) throw sourceError;
            }
        } catch (error) {
            let failure = error;
            try {
                validateCurrentExecutionContext(
                    expectedSource,
                    expectedFingerprint,
                    env,
                    redactionSecrets,
                );
            } catch (sourceError) {
                failure = sourceError;
                requestCoordinatorStop(
                    "source-validation",
                    `Execution context validation failed after worker error: ${sourceError.message}`,
                    state,
                    outputPath,
                );
            }
            firstError ??= failure;
            requestCoordinatorStop(
                abortKind ?? "worker-error",
                abortReason
                    ?? `Validation worker failed: ${redactSensitiveText(
                        failure.message,
                        env,
                        redactionSecrets,
                    )}`,
                state,
                outputPath,
            );
        }
    }

    await Promise.allSettled(Array.from(
        { length: Math.min(concurrency, files.length) },
        (_, index) => worker(index + 1),
    ));
    await waitForActiveProcesses();
    if (Object.keys(state.currentRun.activeFiles).length > 0) {
        redactActiveReports(
            state,
            state.currentRun,
            outputPath,
            env,
            redactionSecrets,
        );
        const reconciled = reconcileActiveEntries(
            state,
            state.currentRun,
            abortReason ?? "Validation worker stopped before completing the attempt",
        );
        persist(state, outputPath, { progress: reconciled > 0, transition: true });
    }
    round.finishedAt = new Date().toISOString();
    round.status = abortReason ? "interrupted" : "complete";
    persist(state, outputPath, { transition: true });
    if (firstError) throw firstError;
    return { files: scheduledFiles, completedAttempts };
}

async function main() {
    abortReason = null;
    abortKind = null;
    manifestFinalized = false;
    heartbeatValidationInProgress = false;
    terminationPromises.clear();
    processCleanupErrors.length = 0;
    activeChildren.clear();
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(usage());
        return;
    }
    if (options.profile !== DEFAULT_PROFILE) {
        throw new Error(`Unsupported validation profile: ${options.profile}`);
    }

    const outputPath = resolveOutputPath(options.output);
    const envFile = path.join(REPO_ROOT, ".env");
    const loadedEnv = fs.existsSync(envFile) ? parseEnvFile(envFile) : { ...process.env };
    const env = prepareCampaignEnvironment(loadedEnv, { reportOnly: options.reportOnly });
    const sourceSnapshot = captureSourceSnapshot();
    const testedRevision = {
        repository: sourceSnapshot.repository,
        branch: sourceSnapshot.branch,
        commitId: sourceSnapshot.commitId,
    };

    if (!options.reportOnly) validateSourceSnapshot(testedRevision, sourceSnapshot);
    const files = discoverVitestFiles(options, outputPath, env);
    const semanticFingerprint = providerModelFingerprint(env);
    const redactionSecrets = providerRedactionSecrets(env);
    const identity = createCampaignIdentity({
        repository: testedRevision.repository,
        commitId: testedRevision.commitId,
        selection: files,
        profile: options.profile,
        tagsFilter: options.tagsFilter,
        providerFingerprint: semanticFingerprint,
    });
    if (options.reportOnly) {
        if (options.fresh) throw new Error("--fresh cannot be combined with --report-only");
        if (!fs.existsSync(outputPath)) {
            throw new Error(`Campaign manifest not found: ${path.relative(REPO_ROOT, outputPath)}`);
        }
        const state = loadState(outputPath, identity, testedRevision, false);
        const summary = summarizeState(state);
        console.log(
            `Campaign: ${state.status}; ${summary.passed}/${summary.total} passed; `
            + `${summary.unfinished} unfinished.`,
        );
        return;
    }

    if (!fs.existsSync(envFile)) throw new Error(`Missing ${envFile}`);
    const now = new Date().toISOString();
    const runId = `${now}-${crypto.randomUUID()}`;
    const coordinatorProcessIdentity = await waitForProcessIdentity(process.pid);
    if (!coordinatorProcessIdentity) {
        throw new Error("Could not verify coordinator process identity; validation did not start");
    }
    const owner = {
        token: crypto.randomUUID(),
        runId,
        acquiredAt: now,
        processIdentity: coordinatorProcessIdentity,
    };
    const lockHandle = acquireExecutionLock(outputPath, owner);
    let state = null;
    let runError = null;
    try {
        validateCurrentExecutionContext(
            testedRevision,
            semanticFingerprint,
            env,
            redactionSecrets,
        );
        if (options.fresh && fs.existsSync(outputPath)) {
            const previousState = JSON.parse(fs.readFileSync(outputPath, "utf8"));
            if (previousState.schemaVersion === STATE_SCHEMA_VERSION) {
                await reconcileStaleRun(
                    previousState,
                    "Prior run reconciled before --fresh created new campaign state",
                    {
                        redactReport: async (attempt) => {
                            try {
                                const reportPath = resolveRetainedReportPath(
                                    outputPath,
                                    attempt.reportPath,
                                );
                                if (fs.existsSync(reportPath)) {
                                    fs.rmSync(reportPath, { force: true });
                                    attempt.evidenceError = "Interrupted stale report removed because sanitization provenance was incomplete";
                                }
                            } catch (error) {
                                attempt.evidenceError = `Report containment failure: ${error.message}`;
                            }
                        },
                    },
                );
            }
            const previousPath = `${outputPath}.previous-${Date.now()}.json`;
            atomicWrite(previousPath, `${JSON.stringify(previousState, null, 2)}\n`);
            state = createState(identity, testedRevision);
        } else {
            state = loadState(outputPath, identity, testedRevision, false);
            if (state.currentRun && ["running", "stopping"].includes(state.currentRun.status)) {
                const recovery = await reconcileStaleRun(
                    state,
                    "Stale prior run reconciled before coordinator restart",
                    {
                        redactReport: async (attempt) => {
                            try {
                                const reportPath = resolveRetainedReportPath(
                                    outputPath,
                                    attempt.reportPath,
                                );
                                if (fs.existsSync(reportPath)) {
                                    fs.rmSync(reportPath, { force: true });
                                    attempt.evidenceError = "Interrupted stale report removed because sanitization provenance was incomplete";
                                }
                            } catch (error) {
                                attempt.evidenceError = `Report containment failure: ${error.message}`;
                            }
                        },
                    },
                );
                persist(state, outputPath, {
                    progress: recovery.reconciled > 0,
                    transition: true,
                });
            }
        }
        const allRecoverySequence = options.all
            ? planAllRecoverySequence(state, Object.keys(state.tests))
            : null;
        const recoveryPlans = allRecoverySequence
            ? allRecoverySequence.filter((plan) => plan.type === "recovery")
            : planRecoveryRounds(state);
        const carryoverRetryTarget = incompleteRetryTarget(state);
        archiveCurrentRun(state);
        const campaignFiles = Object.keys(state.tests);
        state.status = "running";
        state.terminalReason = null;
        state.currentRun = {
            runId,
            coordinatorProcessIdentity: owner.processIdentity,
            status: "running",
            terminalReason: null,
            startedAt: now,
            finishedAt: null,
            phase: "preparing",
            round: null,
            heartbeatAt: now,
            lastProgressAt: now,
            lastTransitionAt: now,
            controls: {
                workers: options.workers,
                retryWorkers: options.retryWorkers,
                retries: options.retries,
                timeoutMs: options.timeoutMs,
                all: options.all,
            },
            recovery: lockHandle.recoveredLock ? {
                staleLockRunId: lockHandle.recoveredLock.runId ?? null,
                staleLockPid: lockHandle.recoveredLock.processIdentity?.pid ?? null,
            } : null,
            rounds: [],
            activeFiles: {},
        };
        persist(state, outputPath, { transition: true });

        const removeSignalHandlers = installSignalHandlers(state, outputPath);
        const stopHeartbeat = startHeartbeat(
            state,
            outputPath,
            testedRevision,
            semanticFingerprint,
            env,
            redactionSecrets,
        );
        try {
            const hasPlannedWork = recoveryPlans.length > 0
                || (options.all && campaignFiles.length > 0)
                || planDefaultObservationFiles(state, campaignFiles).length > 0
                || (carryoverRetryTarget > 0
                    && planRetryTargetFiles(
                        state,
                        campaignFiles,
                        carryoverRetryTarget,
                    ).length > 0)
                || (!options.all && options.retries > 0
                    && planRetryTargetFiles(state, campaignFiles, options.retries).length > 0);
            if (!hasPlannedWork) {
                console.log("No campaign files need execution.");
            } else {
                await buildOnce(env);
                if (!abortReason && !options.skipCleanup) await cleanupOnce(env);
                if (!abortReason) {
                    console.log(
                        `Collecting campaign evidence: workers=${options.workers}, `
                        + `retryWorkers=${options.retryWorkers}, retries=${options.retries}, `
                        + `timeout=${formatDuration(options.timeoutMs)}`,
                    );
                    let roundNumber = 0;
                    for (const recovery of recoveryPlans) {
                        if (abortReason) break;
                        await executeRound({
                            state,
                            outputPath,
                            files: recovery.files,
                            roundNumber,
                            kind: "recovery",
                            attemptKind: recovery.kind,
                            retryTarget: recovery.retryTarget,
                            recoveryOf: {
                                runId: recovery.sourceRunId,
                                round: recovery.sourceRoundNumber,
                                kind: recovery.kind,
                            },
                            concurrency: recovery.kind === "retry"
                                ? options.retryWorkers
                                : options.workers,
                            timeoutMs: options.timeoutMs,
                            env,
                            runId,
                            testedRevision,
                            tagsFilter: options.tagsFilter,
                            expectedSource: testedRevision,
                            expectedFingerprint: semanticFingerprint,
                            redactionSecrets,
                        });
                        roundNumber++;
                    }
                    for (
                        let retry = 1;
                        retry <= carryoverRetryTarget && !abortReason;
                        retry++
                    ) {
                        const retryFiles = planRetryTargetFiles(state, campaignFiles, retry);
                        if (retryFiles.length === 0) continue;
                        await executeRound({
                            state,
                            outputPath,
                            files: retryFiles,
                            roundNumber,
                            kind: "retry",
                            retryTarget: retry,
                            concurrency: options.retryWorkers,
                            timeoutMs: options.timeoutMs,
                            env,
                            runId,
                            testedRevision,
                            tagsFilter: options.tagsFilter,
                            expectedSource: testedRevision,
                            expectedFingerprint: semanticFingerprint,
                            redactionSecrets,
                        });
                        roundNumber++;
                    }
                    const observationFiles = options.all
                        ? allRecoverySequence.at(-1).files
                        : planDefaultObservationFiles(state, campaignFiles);
                    let priorRoundFiles = observationFiles;
                    if (observationFiles.length > 0 && !abortReason) {
                        await executeRound({
                            state,
                            outputPath,
                            files: observationFiles,
                            roundNumber,
                            kind: options.all ? "observation" : "initial",
                            concurrency: options.workers,
                            timeoutMs: options.timeoutMs,
                            env,
                            runId,
                            testedRevision,
                            tagsFilter: options.tagsFilter,
                            expectedSource: testedRevision,
                            expectedFingerprint: semanticFingerprint,
                            redactionSecrets,
                        });
                        roundNumber++;
                    }
                    for (
                        let retry = 1;
                        retry <= options.retries && !abortReason;
                        retry++
                    ) {
                        const retryFiles = options.all
                            ? planRetryFiles(state, priorRoundFiles)
                            : planRetryTargetFiles(state, campaignFiles, retry);
                        if (retryFiles.length === 0) {
                            if (options.all) break;
                            continue;
                        }
                        priorRoundFiles = retryFiles;
                        await executeRound({
                            state,
                            outputPath,
                            files: retryFiles,
                            roundNumber,
                            kind: "retry",
                            retryTarget: retry,
                            concurrency: options.retryWorkers,
                            timeoutMs: options.timeoutMs,
                            env,
                            runId,
                            testedRevision,
                            tagsFilter: options.tagsFilter,
                            expectedSource: testedRevision,
                            expectedFingerprint: semanticFingerprint,
                            redactionSecrets,
                        });
                        roundNumber++;
                    }
                }
            }
            if (!abortReason) {
                validateCurrentExecutionContext(
                    testedRevision,
                    semanticFingerprint,
                    env,
                    redactionSecrets,
                );
            }
        } catch (error) {
            runError = error;
            requestCoordinatorStop(
                abortKind ?? "worker-error",
                abortReason
                    ?? `Validation run failed: ${redactSensitiveText(
                        error.message,
                        env,
                        redactionSecrets,
                    )}`,
                state,
                outputPath,
            );
        } finally {
            stopHeartbeat();
            terminateActiveProcesses();
            try {
                await waitForActiveProcesses();
            } catch (error) {
                requestCoordinatorStop(
                    "process-cleanup",
                    `Validation process cleanup failed: ${error.message}`,
                    state,
                    outputPath,
                );
            }
            for (const active of Object.values(state.currentRun.activeFiles)) {
                try {
                    await terminateRecordedProcessTrees([
                        {
                            role: "attempt-gate",
                            pid: active.pid,
                            processIdentity: active.processIdentity,
                            treeRoot: true,
                        },
                        {
                            role: "vitest-child",
                            pid: active.vitestPid,
                            processIdentity: active.vitestProcessIdentity,
                        },
                    ]);
                } catch (error) {
                    requestCoordinatorStop(
                        "process-cleanup",
                        `Recorded validation process cleanup failed: ${error.message}`,
                        state,
                        outputPath,
                    );
                }
            }
            let reconciled = 0;
            if (Object.keys(state.currentRun.activeFiles).length > 0) {
                redactActiveReports(
                    state,
                    state.currentRun,
                    outputPath,
                    env,
                    redactionSecrets,
                );
                reconciled = reconcileActiveEntries(
                    state,
                    state.currentRun,
                    abortReason ?? "Run finalized with an unfinished attempt",
                );
            }
            if (!abortReason) {
                try {
                    validateCurrentExecutionContext(
                        testedRevision,
                        semanticFingerprint,
                        env,
                        redactionSecrets,
                    );
                } catch (error) {
                    requestCoordinatorStop(
                        "source-validation",
                        `Execution context validation failed before terminal success: ${error.message}`,
                        state,
                        outputPath,
                    );
                }
            }
            if (!abortReason) {
                try {
                    verifyRetainedCampaignReports(state, outputPath);
                } catch (error) {
                    requestCoordinatorStop(
                        "collection-failure",
                        error.message,
                        state,
                        outputPath,
                    );
                }
            }
            if (!abortReason) {
                const roundsComplete = (state.currentRun.rounds ?? []).every(
                    (round) => round.status === "complete"
                        && round.completed === round.total
                        && round.queued === 0
                        && round.active === 0
                        && round.remaining === 0,
                );
                if (!roundsComplete || !campaignEvidenceComplete(state, identity.selection)) {
                    requestCoordinatorStop(
                        "collection-failure",
                        "Evidence collection ended with unfinished or untrusted planned jobs",
                        state,
                        outputPath,
                    );
                }
            }
            state.currentRun.finishedAt = new Date().toISOString();
            if (abortReason) {
                const interrupted = abortKind === "signal";
                state.status = interrupted ? "interrupted" : "failed";
                state.terminalReason = abortReason;
                state.currentRun.status = interrupted ? "interrupted" : "failed";
                state.currentRun.terminalReason = abortReason;
            } else {
                state.status = "complete";
                state.terminalReason = "evidence collection completed";
                state.currentRun.status = "complete";
                state.currentRun.terminalReason = state.terminalReason;
            }
            state.currentRun.phase = "complete";
            archiveCurrentRun(state);
            persist(state, outputPath, { transition: true, progress: reconciled > 0 });
            manifestFinalized = true;
            removeSignalHandlers();
        }
    } finally {
        releaseExecutionLock(lockHandle);
    }

    if (runError) throw runError;
    const summary = summarizeState(state);
    console.log(
        `Collection ${state.status}: ${summary.passed} passed, ${summary.failed} failed, `
        + `${summary.timed_out} timed out, ${summary.interrupted} interrupted; `
        + `${summary.mixed} mixed-history file(s).`,
    );
    if (state.status !== "complete") process.exitCode = 1;
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
