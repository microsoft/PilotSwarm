// Microsoft CI policy. The public test runner keeps its optional providers.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";

export function requireHorizonConfig(text, inherited = {}) {
    if (!text?.trim()) throw new Error("Set the HORIZONDB_TEST_ENV environment secret for all-providers CI.");
    const config = parseEnv(text);
    for (const key of ["HORIZON_DATABASE_URL", "DATABASE_URL", "GITHUB_TOKEN"]) {
        if (!config[key]?.trim()) throw new Error(`HORIZONDB_TEST_ENV requires ${key}.`);
    }
    let horizon, baseline;
    try {
        horizon = new URL(config.HORIZON_DATABASE_URL);
        baseline = new URL(config.DATABASE_URL);
    } catch { throw new Error("The CI database URLs must be valid PostgreSQL connection URLs."); }
    for (const url of [horizon, baseline]) {
        if (!["postgres:", "postgresql:"].includes(url.protocol)) {
            throw new Error("The CI database URLs must use PostgreSQL.");
        }
    }
    if (horizon.hostname === baseline.hostname && horizon.port === baseline.port && horizon.pathname === baseline.pathname) {
        throw new Error("CI HorizonDB must be separate from the baseline PostgreSQL database.");
    }
    for (const source of [config, inherited]) {
        if (Object.entries(source).some(([key, value]) => /^SKIP_.*TESTS$/.test(key) && value === "1")) {
            throw new Error("Test-suite skip flags are not allowed in all-providers CI.");
        }
    }
    return config;
}

export function requireLiveHorizonResult(report) {
    const assertions = (report.testResults ?? []).flatMap(suite => suite.assertionResults ?? []);
    const live = assertions.filter(test => test.fullName?.includes("preconditions P5 (real HorizonDB"));
    if (report.success !== true || report.numFailedTests !== 0 || live.length === 0 || live.some(test => test.status !== "passed")) {
        throw new Error("CI requires the real HorizonDB initialize/store/read test to pass; missing or skipped coverage is a failure.");
    }
}

function maskConfig(config, log) {
    const values = new Set(Object.values(config));
    for (const value of Object.values(config)) {
        try {
            const url = new URL(value);
            for (const part of [url.hostname, url.username, url.password]) {
                if (part) values.add(decodeURIComponent(part));
            }
        } catch { /* Not a URL. */ }
    }
    for (const value of values) {
        if (value.length >= 4) log(`::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
    }
}

export function runAllProviders({ cwd = process.cwd(), env = process.env, run = spawnSync, log = console.log } = {}) {
    if (env.GITHUB_ACTIONS !== "true" || !env.RUNNER_TEMP) throw new Error("This gate runs in GitHub Actions. Use scripts/run-tests.sh locally.");
    if (env.TEST_SUITE?.trim()) throw new Error("All-providers CI requires the full suite; clear the suite filter.");
    const baseline = parseEnv(readFileSync(join(cwd, ".env"), "utf8"));
    const config = requireHorizonConfig(env.HORIZONDB_TEST_ENV, baseline);
    requireHorizonConfig(env.HORIZONDB_TEST_ENV, env);
    maskConfig(config, log);
    const configPath = join(env.RUNNER_TEMP, "pilotswarm-horizondb.env");
    const reportPath = join(env.RUNNER_TEMP, "pilotswarm-horizondb-preflight.json");
    const childEnv = { ...env, HORIZONDB_ENV_FILE: configPath };
    delete childEnv.HORIZONDB_TEST_ENV;
    const execute = (command, args, options) => {
        const result = run(command, args, { stdio: "inherit", ...options });
        if (result.error || result.signal || result.status !== 0) {
            throw new Error("All-providers CI failed: a required live test phase did not complete successfully.");
        }
    };
    try {
        rmSync(reportPath, { force: true });
        writeFileSync(configPath, env.HORIZONDB_TEST_ENV, { mode: 0o600 });
        execute(process.execPath, [
            "../../node_modules/vitest/vitest.mjs", "run", "test/integration/preconditions.test.mjs",
            "--testNamePattern", "preconditions P5", "--reporter=default", "--reporter=json", `--outputFile=${reportPath}`,
        ], { cwd: join(cwd, "packages/horizon-store"), env: { ...childEnv, ...config }, timeout: 360_000 });
        requireLiveHorizonResult(JSON.parse(readFileSync(reportPath, "utf8")));
        log("Live HorizonDB initialize/store/read check passed. Running all provider phases.");
        execute("bash", ["./scripts/run-tests.sh", "--all-providers", ...(env.TEST_MODE === "sequential" ? ["--sequential"] : [])], { cwd, env: childEnv });
    } finally {
        rmSync(configPath, { force: true });
        rmSync(reportPath, { force: true });
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { runAllProviders(); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
