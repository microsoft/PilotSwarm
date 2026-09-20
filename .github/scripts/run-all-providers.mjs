// Microsoft CI policy. The public test runner keeps its optional providers.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { testStorageEnvironment } from "../../scripts/test-provider-plan.mjs";
import { qualifySequentially, SEQUENTIAL_VITEST_ARGS } from "./sequential-qualification.mjs";

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

function runProviderTests({ cwd = process.cwd(), env = process.env, run = spawnSync, log = console.log } = {}, diagnostic = false) {
    if (env.GITHUB_ACTIONS !== "true" || !env.RUNNER_TEMP) throw new Error("This gate runs in GitHub Actions. Use scripts/run-tests.sh locally.");
    if (env.TEST_QUALIFY_FAILURES && !["true", "false"].includes(env.TEST_QUALIFY_FAILURES)) {
        throw new Error("TEST_QUALIFY_FAILURES must be true or false.");
    }
    const qualification = env.TEST_QUALIFY_FAILURES === "true";
    if (diagnostic && qualification) throw new Error("Standalone diagnostics cannot qualify a release without a complete initial run.");
    if (qualification && !/^[a-f0-9]{40}$/i.test(env.GITHUB_SHA || "")) {
        throw new Error("Release qualification requires the captured source SHA.");
    }
    let files = [];
    if (diagnostic) {
        files = [...new Set((env.TEST_SUITE || "").trim().split(/[\s,]+/).filter(Boolean))];
        if (env.TEST_PROVIDERS !== "horizondb" || files.length === 0 ||
            files.some(file => !/^test\/local\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.test\.js$/.test(file))) {
            throw new Error("HDB diagnostics require providers=horizondb and exact test/local/*.test.js paths.");
        }
        log(`TARGETED HDB DIAGNOSTICS ONLY, NOT A RELEASE GATE: ${files.join(", ")}`);
    } else if (env.TEST_SUITE?.trim()) throw new Error("All-providers CI requires the full suite; clear the suite filter.");
    const baseline = parseEnv(readFileSync(join(cwd, ".env"), "utf8"));
    const config = requireHorizonConfig(env.HORIZONDB_TEST_ENV, baseline);
    requireHorizonConfig(env.HORIZONDB_TEST_ENV, env);
    maskConfig(config, log);
    const configPath = join(env.RUNNER_TEMP, "pilotswarm-horizondb.env");
    const reportPath = join(env.RUNNER_TEMP, "pilotswarm-horizondb-preflight.json");
    // Eight concurrent files by default; callers may explicitly tune capacity.
    const workers = env.PS_TEST_MAX_WORKERS || "8";
    const childEnv = { ...env, PS_TEST_MAX_WORKERS: workers, HORIZONDB_ENV_FILE: configPath };
    log(`${diagnostic ? "Targeted HDB diagnostics" : "All-providers CI"} uses ${workers} parallel test files.`);
    delete childEnv.HORIZONDB_TEST_ENV;
    const execute = (command, args, options) => {
        const result = run(command, args, { stdio: "inherit", ...options });
        if (result.error || result.signal || result.status !== 0) {
            throw new Error(`${diagnostic ? "Targeted HDB diagnostics" : "All-providers CI"} failed: a required live test phase did not complete successfully.`);
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
        if (diagnostic) {
            log("Live HorizonDB preflight passed. Running only the requested SDK files.");
            execute(process.execPath, ["../../node_modules/vitest/vitest.mjs", "run", ...files,
                ...(env.TEST_MODE === "sequential" ? SEQUENTIAL_VITEST_ARGS : [])], {
                cwd: join(cwd, "packages/sdk"),
                env: testStorageEnvironment("horizondb", { ...childEnv, ...config }),
            });
        } else {
            log("Live HorizonDB initialize/store/read check passed. Running all provider phases.");
            const fullHdb = env.TEST_PROVIDERS === "horizondb";
            const args = ["./scripts/run-tests.sh", fullHdb ? "--with-horizondb" : "--all-providers",
                ...(env.TEST_MODE === "sequential" ? ["--sequential"] : [])];
            if (!qualification) {
                execute("bash", args, { cwd, env: childEnv });
            } else {
                const resultsDir = mkdtempSync(join(env.RUNNER_TEMP, "pilotswarm-release-results-"));
                childEnv.PILOTSWARM_TEST_RESULTS_DIR = resultsDir;
                log("Release qualification enabled: at most five failed cases total may be verified sequentially once.");
                const initialResult = run("bash", args, { cwd, env: childEnv, stdio: "inherit" });
                const first = fullHdb ? "horizondb" : "base";
                const plan = [
                    [first, "horizon-unit", "horizon-store"],
                    ...(!fullHdb ? [["base", "sdk", "sdk"]] : []),
                    ["horizondb", "horizon-integration", "horizon-store"],
                    ["horizondb", "sdk", "sdk"],
                ];
                const sources = plan.map(([phase, kind, project]) => ({
                    id: `${phase}/${kind}`, phase,
                    cwd: join(cwd, "packages", project),
                    reportFile: join(resultsDir, `${phase}.${kind}.json`),
                    env: testStorageEnvironment(phase === "base" ? "baseline" : "horizondb", {
                        ...childEnv, ...(phase === "base" ? baseline : config), PS_TEST_MAX_WORKERS: workers,
                    }),
                }));
                qualifySequentially({
                    sources, initialResult, resultsDir, repoRoot: cwd, sourceSha: env.GITHUB_SHA || null,
                    run, log, summaryFile: env.GITHUB_STEP_SUMMARY,
                });
            }
        }
    } finally {
        rmSync(configPath, { force: true });
        rmSync(reportPath, { force: true });
    }
}

export function runAllProviders(options) {
    return runProviderTests(options);
}

export function runHorizonDiagnostics(options) {
    return runProviderTests(options, true);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        if (process.argv[2] === "diagnose-hdb") runHorizonDiagnostics();
        else if (process.argv[2] === undefined) runAllProviders();
        else throw new Error("Expected no command (full gate) or diagnose-hdb.");
    }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
