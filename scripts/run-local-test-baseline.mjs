#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const SDK_DIR = path.join(REPO_ROOT, "packages", "sdk");
const LOCAL_TEST_DIR = path.join(SDK_DIR, "test", "local");
const DEFAULT_OUTPUT = "pilotswarm-local-test-baseline.json";
const STATE_SCHEMA_VERSION = 1;
const MAX_CAPTURED_OUTPUT = 256 * 1024;
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
const SECRET_ENV_KEY_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|CONNECTION_STRING|DATABASE_URL)/i;

function usage() {
    return `Usage:
  npm run test:local:baseline -- [options]

Options:
  --parallelism <n>       Concurrent test files (default: 8)
  --retry-count <n>       Retries after the first attempt per file (default: 0)
  --timeout-per-file <d>  Per-file timeout, e.g. 120s, 5m, 600000ms (default: 5m)
  --output <path>         Structured JSON state (default: ${DEFAULT_OUTPUT})
  --file <path>           Run one exact path relative to test/local (repeatable)
  --all                   Run every file, including current passes
  --skip-build            Do not build SDK and MCP before testing
  --skip-cleanup          Do not run the one-time stale test cleanup
  --report-only           Refresh summary and metadata without running tests
  --help                  Show this help

Behavior:
  - JSON is the persistent source of truth; a missing JSON file starts fresh.
  - Later runs select only Pending, Failed, or Interrupted files by default.
  - A file stops retrying as soon as it passes.
  - JSON is checkpointed after every attempt.
  - Exit code is nonzero while any current test result is non-passing.

Examples:
  npm run test:local:baseline -- --parallelism 12 --retry-count 2 --timeout-per-file 5m
  npm run test:local:baseline -- --all --parallelism 8 --retry-count 1 --timeout-per-file 2m
  npm run test:local:baseline -- --report-only
`;
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
        parallelism: 8,
        retryCount: 0,
        timeoutMs: 300_000,
        output: DEFAULT_OUTPUT,
        files: [],
        all: false,
        skipBuild: false,
        skipCleanup: false,
        reportOnly: false,
        help: false,
    };

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        let parsed;
        if ((parsed = takeOptionValue(args, index, "--parallelism"))) {
            options.parallelism = Number(parsed.value);
            index += parsed.consumed;
        } else if ((parsed = takeOptionValue(args, index, "--retry-count"))
            || (parsed = takeOptionValue(args, index, "--retries"))) {
            options.retryCount = Number(parsed.value);
            index += parsed.consumed;
        } else if ((parsed = takeOptionValue(args, index, "--timeout-per-file"))
            || (parsed = takeOptionValue(args, index, "--timeout"))) {
            options.timeoutMs = parseDuration(parsed.value);
            index += parsed.consumed;
        } else if ((parsed = takeOptionValue(args, index, "--output"))) {
            options.output = parsed.value;
            index += parsed.consumed;
        } else if ((parsed = takeOptionValue(args, index, "--file"))) {
            options.files.push(parsed.value.replaceAll("\\", "/").replace(/^test\/local\//, ""));
            index += parsed.consumed;
        } else if (arg === "--all") {
            options.all = true;
        } else if (arg === "--skip-build") {
            options.skipBuild = true;
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

    if (!Number.isInteger(options.parallelism) || options.parallelism < 1) {
        throw new Error("--parallelism must be a positive integer");
    }
    if (!Number.isInteger(options.retryCount) || options.retryCount < 0) {
        throw new Error("--retry-count must be a non-negative integer");
    }
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
        throw new Error("--timeout-per-file must be positive");
    }
    return options;
}

export function collectTestFiles(dir = LOCAL_TEST_DIR, baseDir = dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectTestFiles(fullPath, baseDir));
        } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
            files.push(path.relative(baseDir, fullPath).replaceAll(path.sep, "/"));
        }
    }
    return files.sort();
}

function statusToDisplay(value) {
    return {
        passed: "Passed",
        failed: "Failed",
        interrupted: "Interrupted",
        pending: "Pending",
        running: "Running",
    }[value] ?? "Pending";
}

function emptyTestState() {
    return {
        status: "pending",
        latestDurationMs: null,
        lastRunAt: null,
        notes: "",
        attempts: [],
    };
}

export function syncInventory(state, files) {
    const current = new Set(files);
    state.removedTests ??= {};
    for (const [file, entry] of Object.entries(state.tests ?? {})) {
        if (!current.has(file)) {
            state.removedTests[file] = entry;
            delete state.tests[file];
        }
    }
    for (const file of files) {
        if (!state.tests[file] && state.removedTests[file]) {
            state.tests[file] = state.removedTests[file];
            delete state.removedTests[file];
        }
        state.tests[file] ??= emptyTestState();
    }
    state.tests = Object.fromEntries(files.map((file) => [file, state.tests[file]]));
}

function createState(files, repository) {
    return {
        schemaVersion: STATE_SCHEMA_VERSION,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        repository,
        lastRunConfig: null,
        summary: null,
        tests: Object.fromEntries(files.map((file) => [file, emptyTestState()])),
        removedTests: {},
    };
}

function normalizeRevision(value) {
    if (!value) return null;
    return {
        repository: value.repository ?? "unknown",
        branch: value.branch ?? "unknown",
        commitId: value.commitId ?? value.commit ?? "unknown",
    };
}

function sameCommittedRevision(left, right) {
    if (!left || !right) return false;
    const sameCommit = left.commitId === right.commitId
        || left.commitId.startsWith(right.commitId)
        || right.commitId.startsWith(left.commitId);
    return left.repository === right.repository
        && left.branch === right.branch
        && sameCommit;
}

function backfillRevisionMetadata(state, currentRevision) {
    const storedRevision = normalizeRevision(state.repository);
    if (!sameCommittedRevision(storedRevision, currentRevision)) return;

    const testedRevision = { ...currentRevision };
    if (state.lastRunConfig && !state.lastRunConfig.testedRevision) {
        state.lastRunConfig.testedRevision = testedRevision;
    }
    for (const entry of Object.values(state.tests ?? {})) {
        for (const attempt of entry.attempts ?? []) {
            attempt.testedRevision ??= testedRevision;
        }
    }
}

function loadState(outputPath, files, repository) {
    if (fs.existsSync(outputPath)) {
        const parsed = JSON.parse(fs.readFileSync(outputPath, "utf8"));
        if (parsed.schemaVersion !== STATE_SCHEMA_VERSION) {
            throw new Error(`Unsupported state schema version: ${parsed.schemaVersion}`);
        }
        backfillRevisionMetadata(parsed, repository);
        parsed.repository = repository;
        syncInventory(parsed, files);
        return parsed;
    }
    return createState(files, repository);
}

function historyCounts(entry) {
    const counts = { passed: 0, failed: 0, interrupted: 0 };
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
        interrupted: 0,
        pending: 0,
        flaky: 0,
        attempts: 0,
    };
    for (const entry of Object.values(state.tests ?? {})) {
        summary.total++;
        summary[entry.status in summary ? entry.status : "pending"]++;
        const history = historyCounts(entry);
        summary.attempts += history.passed + history.failed + history.interrupted;
        if (history.passed > 0 && history.failed + history.interrupted > 0) summary.flaky++;
    }
    return summary;
}

export function selectTests(state, { all = false, files = [] } = {}) {
    const explicit = new Set(files);
    return Object.entries(state.tests)
        .filter(([file, entry]) => explicit.size > 0 ? explicit.has(file) : all || entry.status !== "passed")
        .sort(([leftFile, left], [rightFile, right]) => {
            const leftDuration = left.latestDurationMs ?? 0;
            const rightDuration = right.latestDurationMs ?? 0;
            return leftDuration - rightDuration || leftFile.localeCompare(rightFile);
        })
        .map(([file]) => file);
}

export function selectedTestsPassed(state, files) {
    return files.every((file) => state.tests[file]?.status === "passed");
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

function redactSecrets(value, env) {
    let redacted = String(value ?? "");
    for (const [key, secret] of Object.entries(env)) {
        if (!SECRET_ENV_KEY_PATTERN.test(key)) continue;
        if (typeof secret === "string" && secret.length >= 8) {
            redacted = redacted.split(secret).join("***");
        }
    }
    return redacted;
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
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, content);
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            fs.renameSync(tempPath, filePath);
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

function gitValue(args, fallback = "unknown") {
    const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() || fallback : fallback;
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

function repositoryInfo() {
    const branch = gitValue(["branch", "--show-current"]);
    const remote = remoteUrlForBranch(branch);
    return {
        repository: repositoryNameFromRemote(remote),
        branch,
        commitId: gitValue(["rev-parse", "HEAD"]),
    };
}

function persist(state, outputPath) {
    state.updatedAt = new Date().toISOString();
    state.summary = summarizeState(state);
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

function runCommand(command, args, { cwd = REPO_ROOT, env, stdio = "inherit" } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd, env, stdio, shell: false });
        child.on("error", reject);
        child.on("close", (code, signal) => resolve({ code: code ?? 1, signal }));
    });
}

async function buildOnce(env) {
    const runNpm = (args) => process.platform === "win32"
        ? runCommand(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm", ...args], { env })
        : runCommand("npm", args, { env });
    const sdk = await runNpm(["run", "build", "--workspace=packages/sdk"]);
    if (sdk.code !== 0) throw new Error("SDK build failed");
    const mcp = await runNpm(["run", "build:mcp", "--workspace=packages/app"]);
    if (mcp.code !== 0) throw new Error("MCP build failed");
}

async function cleanupOnce(env) {
    const result = await runCommand(process.execPath, [path.join(REPO_ROOT, "scripts", "cleanup-test-schemas.js")], { env });
    if (result.code !== 0) throw new Error("Stale test cleanup failed");
}

function appendBounded(current, chunk) {
    const combined = current + chunk;
    return combined.length > MAX_CAPTURED_OUTPUT
        ? combined.slice(combined.length - MAX_CAPTURED_OUTPUT)
        : combined;
}

function tempReportPath(file) {
    const safe = file.replace(/[^A-Za-z0-9_.-]+/g, "-");
    return path.join(os.tmpdir(), `pilotswarm-baseline-${process.pid}-${Date.now()}-${safe}.json`);
}

function parseVitestReport(reportPath, env) {
    if (!fs.existsSync(reportPath)) return { counts: null, failures: [], summary: "" };
    try {
        const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
        const failures = [];
        for (const suite of report.testResults ?? []) {
            for (const assertion of suite.assertionResults ?? []) {
                if (assertion.status !== "failed") continue;
                const message = redactSecrets((assertion.failureMessages ?? []).join("\n"), env);
                failures.push({
                    name: compactMessage(assertion.fullName || assertion.title || "Unknown test", 200),
                    message: compactMessage(message),
                });
            }
        }
        const counts = {
            total: report.numTotalTests ?? 0,
            passed: report.numPassedTests ?? 0,
            failed: report.numFailedTests ?? 0,
            skipped: report.numPendingTests ?? 0,
            todo: report.numTodoTests ?? 0,
        };
        const summary = failures[0]?.message
            || `${counts.passed} tests passed${counts.failed ? `, ${counts.failed} failed` : ""}`;
        return { counts, failures, summary };
    } catch (error) {
        return { counts: null, failures: [], summary: `Could not parse Vitest JSON: ${error.message}` };
    } finally {
        fs.rmSync(reportPath, { force: true });
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
        await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
            stdio: "ignore",
        }).catch(() => {});
        return;
    }
    try {
        process.kill(-pid, "SIGTERM");
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
        process.kill(-pid, "SIGKILL");
    } catch {}
}

function fallbackFailureSummary(output, env) {
    const lines = stripAnsi(redactSecrets(output, env))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    return compactMessage(lines.at(-1) || "Vitest exited without a structured failure");
}

const activeChildren = new Map();
let abortReason = null;

async function runTestFile(file, timeoutMs, env) {
    const startedAt = new Date();
    const startTime = Date.now();
    const reportPath = tempReportPath(file);
    const vitestPath = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
    const testPath = `test/local/${file}`;
    const args = [
        vitestPath,
        "run",
        testPath,
        "--no-file-parallelism",
        "--maxConcurrency=1",
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${reportPath}`,
    ];

    return new Promise((resolve) => {
        let output = "";
        let timedOut = false;
        let spawnError = null;
        const child = spawn(process.execPath, args, {
            cwd: SDK_DIR,
            env,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
        });
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

        const timer = setTimeout(() => {
            timedOut = true;
            void terminateProcessTree(child.pid);
        }, timeoutMs);

        if (abortReason) void terminateProcessTree(child.pid);

        child.on("close", (code, signal) => {
            clearTimeout(timer);
            activeChildren.delete(child.pid);
            const finishedAt = new Date();
            const durationMs = Date.now() - startTime;
            const parsed = parseVitestReport(reportPath, env);
            let status;
            let summary;
            if (abortReason) {
                status = "interrupted";
                summary = abortReason;
            } else if (timedOut) {
                status = "interrupted";
                summary = `Timed out after ${formatDuration(timeoutMs)}`;
            } else if (spawnError) {
                status = "failed";
                summary = compactMessage(spawnError.message);
            } else if (code === 0) {
                status = "passed";
                summary = parsed.counts
                    ? `${parsed.counts.passed} tests passed`
                    : "Isolated run passed";
            } else {
                status = "failed";
                summary = parsed.summary || fallbackFailureSummary(output, env);
            }
            resolve({
                startedAt: startedAt.toISOString(),
                finishedAt: finishedAt.toISOString(),
                durationMs,
                status,
                exitCode: code,
                signal,
                timedOut,
                summary,
                counts: parsed.counts,
                failures: parsed.failures.slice(0, 10),
            });
        });
    });
}

export function recordAttempt(state, file, result, runId, testedRevision) {
    const entry = state.tests[file] ?? emptyTestState();
    const attempt = {
        number: entry.attempts.length + 1,
        runId,
        source: "baseline-runner",
        testedRevision,
        ...result,
    };
    entry.attempts.push(attempt);
    entry.status = result.status;
    entry.latestDurationMs = result.durationMs;
    entry.lastRunAt = result.finishedAt;
    entry.notes = result.summary;
    state.tests[file] = entry;
    return attempt;
}

function resolvePath(value) {
    return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

function installSignalHandlers() {
    const stop = (signal) => {
        if (abortReason) return;
        abortReason = `Runner interrupted by ${signal}`;
        console.error(`\n${abortReason}; stopping ${activeChildren.size} active file(s)...`);
        for (const pid of activeChildren.keys()) void terminateProcessTree(pid);
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(usage());
        return;
    }

    const outputPath = resolvePath(options.output);
    const files = collectTestFiles();
    const testedRevision = repositoryInfo();
    const state = loadState(outputPath, files, testedRevision);

    if (options.reportOnly) {
        state.lastReportAt = new Date().toISOString();
        persist(state, outputPath);
        console.log(`Results updated: ${path.relative(REPO_ROOT, outputPath)}`);
        return;
    }

    const unknownFiles = options.files.filter((file) => !state.tests[file]);
    if (unknownFiles.length > 0) {
        throw new Error(`Unknown test file(s): ${unknownFiles.join(", ")}`);
    }
    const selected = selectTests(state, options);
    if (selected.length === 0) {
        console.log("No matching test files need execution.");
        return;
    }

    const envFile = path.join(REPO_ROOT, ".env");
    if (!fs.existsSync(envFile)) {
        throw new Error(`Missing ${envFile}`);
    }
    const env = parseEnvFile(envFile);
    const runId = new Date().toISOString();
    state.lastRunConfig = {
        runId,
        startedAt: new Date().toISOString(),
        testedRevision,
        parallelism: options.parallelism,
        retryCount: options.retryCount,
        timeoutMs: options.timeoutMs,
        all: options.all,
        files: options.files,
    };
    persist(state, outputPath);

    if (!options.skipBuild) await buildOnce(env);
    if (!options.skipCleanup) await cleanupOnce(env);

    const queue = [...selected];
    let completedAttempts = 0;
    let completedFiles = 0;
    installSignalHandlers();
    console.log(
        `Running ${selected.length} file(s): parallelism=${options.parallelism}, `
        + `retryCount=${options.retryCount}, timeout=${formatDuration(options.timeoutMs)}`,
    );

    async function worker(slot) {
        while (!abortReason) {
            const file = queue.shift();
            if (!file) return;
            for (let retry = 0; retry <= options.retryCount && !abortReason; retry++) {
                console.log(`[slot ${slot}] ${file} (attempt ${retry + 1}/${options.retryCount + 1})`);
                const result = await runTestFile(file, options.timeoutMs, env);
                recordAttempt(state, file, result, runId, testedRevision);
                completedAttempts++;
                persist(state, outputPath);
                console.log(
                    `[attempt ${completedAttempts}] ${statusToDisplay(result.status)} `
                    + `${file} (${formatDuration(result.durationMs)}): ${result.summary}`,
                );
                if (result.status === "passed") break;
            }
            completedFiles++;
            console.log(`[files ${completedFiles}/${selected.length}] finished ${file}`);
        }
    }

    const workerCount = Math.min(options.parallelism, selected.length);
    await Promise.all(Array.from({ length: workerCount }, (_, index) => worker(index + 1)));
    state.lastRunConfig.finishedAt = new Date().toISOString();
    persist(state, outputPath);

    const summary = summarizeState(state);
    console.log(
        `Final: ${summary.passed} passed, ${summary.failed} failed, `
        + `${summary.interrupted} interrupted, ${summary.pending} pending; ${summary.flaky} flaky-history file(s).`,
    );
    if (!selectedTestsPassed(state, selected)) process.exitCode = 1;
}

const invokedDirectly = process.argv[1]
    && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
    main().catch((error) => {
        console.error(`ERROR: ${error.stack || error.message || error}`);
        process.exitCode = 1;
    });
}
