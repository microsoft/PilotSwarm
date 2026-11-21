import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requireHorizonConfig, requireLiveHorizonResult, runAllProviders, runBaseline, runHorizonDiagnostics } from "../run-all-providers.mjs";
import { testStorageEnvironment } from "../../../scripts/test-provider-plan.mjs";
import { executionIdentity } from "../../../scripts/vitest-run-health-reporter.mjs";

const config = "HORIZON_DATABASE_URL=postgresql://test@horizon.invalid/db\nDATABASE_URL=postgresql://test@localhost/base\nGITHUB_TOKEN=fixture-token\n";
const report = (status = "passed") => ({
    success: true, numFailedTests: 0,
    testResults: [{ assertionResults: [{ fullName: "preconditions P5 (real HorizonDB → initializes, migrations applied, ready) ready = the provider surface works end to end on the fresh schema", status }] }],
});

test("missing or incomplete configuration cannot qualify as all-providers coverage", () => {
    for (const text of [undefined, "", "DATABASE_URL=postgresql://localhost/base", config.replace(/^HORIZON_DATABASE_URL=.*\n/, "")]) {
        assert.throws(() => requireHorizonConfig(text), /HORIZONDB_TEST_ENV/);
    }
    assert.throws(() => requireHorizonConfig(config.replace("postgresql://test@horizon.invalid/db", "https://example.invalid")), /must use PostgreSQL/);
    assert.throws(() => requireHorizonConfig(config.replace("postgresql://test@horizon.invalid/db", "postgresql://other@localhost/base?sslmode=require")), /separate/);
});

test("suite skipping is rejected from both configuration and inherited environment", () => {
    assert.throws(() => requireHorizonConfig(config + "SKIP_HORIZON_STORE_TESTS=1\n"), /skip flags/);
    assert.throws(() => requireHorizonConfig(config, { SKIP_HORIZON_STORE_TESTS: "1" }), /skip flags/);
    assert.equal(requireHorizonConfig(config).GITHUB_TOKEN, "fixture-token");
});

test("a green but skipped or empty live-test report fails the gate", () => {
    for (const input of [report("pending"), report("skipped"), report("failed"), { success: true, numFailedTests: 0, testResults: [] }, { ...report(), success: false }, { ...report(), numFailedTests: 1 }]) {
        assert.throws(() => requireLiveHorizonResult(input), /real HorizonDB/);
    }
    requireLiveHorizonResult(report());
});

function fixture(t) {
    const cwd = mkdtempSync(join(tmpdir(), "ps-ci-horizon-test-"));
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    writeFileSync(join(cwd, ".env"), "DATABASE_URL=postgresql://test@localhost/base\n");
    return { cwd, log() {}, env: { GITHUB_ACTIONS: "true", RUNNER_TEMP: cwd, HORIZONDB_TEST_ENV: config, TEST_MODE: "sequential" } };
}

test("an unreachable database stops the run before baseline-only tests can succeed", t => {
    const input = fixture(t);
    let calls = 0;
    assert.throws(() => runAllProviders({ ...input, run() { calls++; return { status: 1 }; } }), /required live test phase/);
    assert.equal(calls, 1);
    assert.equal(existsSync(join(input.cwd, "pilotswarm-horizondb.env")), false);
});

test("a stale live report cannot hide a preflight that produced no report", t => {
    const input = fixture(t);
    writeFileSync(join(input.cwd, "pilotswarm-horizondb-preflight.json"), JSON.stringify(report()));
    let calls = 0;
    assert.throws(() => runAllProviders({ ...input, run() { calls++; return { status: 0 }; } }), /ENOENT/);
    assert.equal(calls, 1);
});

test("successful live coverage runs the full public runner with the validated config", t => {
    const input = fixture(t);
    const calls = [];
    runAllProviders({ ...input, run(command, args, options) {
        calls.push({ command, args, options });
        assert.equal(options.env.PS_TEST_MAX_WORKERS, "8");
        if (calls.length === 1) {
            assert.ok(args.includes("preconditions P5"));
            assert.equal(options.env.HORIZON_DATABASE_URL, "postgresql://test@horizon.invalid/db");
            const path = options.env.HORIZONDB_ENV_FILE;
            assert.equal(readFileSync(path, "utf8"), config);
            assert.equal(statSync(path).mode & 0o777, 0o600);
            writeFileSync(join(input.cwd, "pilotswarm-horizondb-preflight.json"), JSON.stringify(report()));
        } else {
            assert.equal(command, "bash");
            assert.deepEqual(args, ["./scripts/run-tests.sh", "--all-providers", "--sequential"]);
        }
        return { status: 0 };
    } });
    assert.equal(calls.length, 2);
    assert.equal(existsSync(join(input.cwd, "pilotswarm-horizondb.env")), false);
});

test("failure during the full pass remains a failure", t => {
    const input = fixture(t);
    let calls = 0;
    assert.throws(() => runAllProviders({ ...input, run() {
        calls++;
        if (calls === 1) writeFileSync(join(input.cwd, "pilotswarm-horizondb-preflight.json"), JSON.stringify(report()));
        return { status: calls === 1 ? 0 : 1 };
    } }), /required live test phase/);
    assert.equal(calls, 2);
});

test("filtered runs cannot be reported as full all-providers coverage", t => {
    const input = fixture(t);
    input.env.TEST_SUITE = "smoke";
    assert.throws(() => runAllProviders(input), /full suite/);
});

test("targeted diagnostics run exact files on HDB without repeating the baseline", t => {
    const input = fixture(t);
    input.env.TEST_PROVIDERS = "horizondb";
    input.env.TEST_MODE = "parallel";
    input.env.TEST_SUITE = "test/local/cms-seq-nodemap.test.js test/local/contracts.test.js,test/local/management.test.js";
    input.env.PILOTSWARM_DUROXIDE_URL = "postgresql://stale.invalid/db";
    const calls = [];
    const logs = [];
    runHorizonDiagnostics({ ...input, log: message => logs.push(message), run(command, args, options) {
        calls.push({ command, args, options });
        if (calls.length === 1) writeFileSync(join(input.cwd, "pilotswarm-horizondb-preflight.json"), JSON.stringify(report()));
        else {
            assert.equal(command, process.execPath);
            assert.deepEqual(args, ["../../node_modules/vitest/vitest.mjs", "run",
                "test/local/cms-seq-nodemap.test.js", "test/local/contracts.test.js", "test/local/management.test.js"]);
            assert.equal(options.env.DATABASE_URL, "postgresql://test@horizon.invalid/db");
            assert.equal(options.env.PS_TEST_DATABASE_URL, options.env.DATABASE_URL);
            assert.equal(options.env.TEST_DATABASE_URL, options.env.DATABASE_URL);
            assert.equal(options.env.HORIZON_GRAPH_DATABASE_URL, options.env.DATABASE_URL);
            assert.equal(options.env.PILOTSWARM_RUNTIME_PROVIDER, "horizondb");
            assert.equal(options.env.PILOTSWARM_DUROXIDE_URL, undefined);
            assert.equal(options.env.PLAIN_DATABASE_URL, "postgresql://test@localhost/base");
            assert.equal(options.env.PS_TEST_MAX_WORKERS, "8");
        }
        return { status: 0 };
    } });
    assert.equal(calls.length, 2);
    assert(logs.some(message => message.includes("NOT A RELEASE GATE")));
    assert.equal(existsSync(join(input.cwd, "pilotswarm-horizondb.env")), false);
});

test("diagnostics reject empty, option-like, outside-tree and wrong-provider selectors", t => {
    const input = fixture(t);
    input.env.TEST_PROVIDERS = "horizondb";
    for (const suite of ["", "--passWithNoTests", "../outside.test.js", "test/local/../outside.test.js", "contracts"]) {
        assert.throws(() => runHorizonDiagnostics({ ...input, env: { ...input.env, TEST_SUITE: suite } }), /exact test\/local/);
    }
    assert.throws(() => runHorizonDiagnostics({ ...input, env: {
        ...input.env, TEST_PROVIDERS: "all", TEST_SUITE: "test/local/contracts.test.js",
    } }), /providers=horizondb/);
});

test("targeted diagnostic failures remain failures and clean private configuration", t => {
    const input = fixture(t);
    input.env.TEST_PROVIDERS = "horizondb";
    input.env.TEST_SUITE = "test/local/contracts.test.js";
    let calls = 0;
    assert.throws(() => runHorizonDiagnostics({ ...input, run() {
        if (++calls === 1) {
            writeFileSync(join(input.cwd, "pilotswarm-horizondb-preflight.json"), JSON.stringify(report()));
            return { status: 0 };
        }
        return { status: 1 };
    } }), /Targeted HDB diagnostics failed/);
    assert.equal(calls, 2);
    assert.equal(existsSync(join(input.cwd, "pilotswarm-horizondb.env")), false);
});

test("explicit sequential diagnostics serialize both files and concurrent cases", t => {
    const input = fixture(t);
    input.env.TEST_PROVIDERS = "horizondb";
    input.env.TEST_SUITE = "test/local/contracts.test.js";
    let calls = 0;
    runHorizonDiagnostics({ ...input, run(_command, args) {
        if (++calls === 1) writeFileSync(join(input.cwd, "pilotswarm-horizondb-preflight.json"), JSON.stringify(report()));
        else for (const flag of ["--no-file-parallelism", "--maxWorkers=1", "--maxConcurrency=1"]) assert(args.includes(flag));
        return { status: 0 };
    } });
    assert.equal(calls, 2);
});

// Full-HDB mode uses the same mandatory live preflight, but runs every SDK suite.
test("full HDB mode dispatches the complete HDB runner and preserves concurrency override", t => {
    const input = fixture(t);
    input.env.TEST_PROVIDERS = "horizondb";
    input.env.PS_TEST_MAX_WORKERS = "3";
    let calls = 0;
    runAllProviders({ ...input, run(command, args, options) {
        assert.equal(options.env.PS_TEST_MAX_WORKERS, "3");
        if (++calls === 1) writeFileSync(join(input.cwd, "pilotswarm-horizondb-preflight.json"), JSON.stringify(report()));
        else assert.deepEqual(args, ["./scripts/run-tests.sh", "--with-horizondb", "--sequential"]);
        return { status: 0 };
    } });
    assert.equal(calls, 2);
});

/** `mode`: false = all providers, true = the full suite on HorizonDB, "baseline" = the baseline gate (runBaseline). */
function qualificationFixture(t, failures, mode = false) {
    const fullHdb = mode === true;
    const baselineGate = mode === "baseline";
    const input = fixture(t);
    Object.assign(input.env, { GITHUB_SHA: "a".repeat(40), TEST_MODE: "parallel",
        TEST_PROVIDERS: baselineGate ? "baseline" : fullHdb ? "horizondb" : "all", TEST_QUALIFY_FAILURES: "true" });
    // The baseline gate has no HorizonDB configuration at all.
    if (baselineGate) delete input.env.HORIZONDB_TEST_ENV;
    const specs = baselineGate
        ? [["base", "horizon-unit", "horizon-store"], ["base", "sdk", "sdk"]]
        : fullHdb
        ? [["horizondb", "horizon-unit", "horizon-store"], ["horizondb", "horizon-integration", "horizon-store"], ["horizondb", "sdk", "sdk"]]
        : [["base", "horizon-unit", "horizon-store"], ["base", "sdk", "sdk"],
            ["horizondb", "horizon-integration", "horizon-store"], ["horizondb", "sdk", "sdk"]];
    // The complete run is the first command of the baseline gate, and the second (after the live check) of the others.
    const completeRun = baselineGate ? 1 : 2;
    const state = { calls: 0, verifications: 0, rows: [], resultsDir: "" };
    function writeResult(row, file, cases) {
        const failed = cases.filter(c => c.status === "failed").length;
        writeFileSync(file, JSON.stringify({ success: failed === 0, numTotalTests: cases.length,
            numPassedTests: cases.filter(c => c.status === "passed").length, numFailedTests: failed,
            testResults: [{ name: join(row.cwd, row.file), status: failed ? "failed" : "passed",
                message: "", assertionResults: cases }] }));
        writeFileSync(`${file}.health.json`, JSON.stringify({ ...executionIdentity(row.env),
            reason: failed ? "failed" : "passed", unhandledErrors: 0 }));
        writeFileSync(`${file}.exit.json`, JSON.stringify({ exitCode: failed ? 1 : 0 }));
    }
    const run = (command, args, options) => {
        state.calls++;
        if (!baselineGate && state.calls === 1) {
            writeFileSync(join(input.cwd, "pilotswarm-horizondb-preflight.json"), JSON.stringify(report()));
            return { status: 0 };
        }
        if (state.calls === completeRun) {
            assert.equal(command, "bash");
            assert.deepEqual(args, baselineGate ? ["./scripts/run-tests.sh"]
                : ["./scripts/run-tests.sh", fullHdb ? "--with-horizondb" : "--all-providers"]);
            assert.equal("HORIZONDB_TEST_ENV" in options.env, false);
            assert.equal(options.env.PS_TEST_MAX_WORKERS, "8");
            state.resultsDir = options.env.PILOTSWARM_TEST_RESULTS_DIR;
            for (const [index, [phase, kind, project]] of specs.entries()) {
                const values = phase === "base"
                    ? { DATABASE_URL: "postgresql://test@localhost/base" }
                    : { DATABASE_URL: "postgresql://test@localhost/base", HORIZON_DATABASE_URL: "postgresql://test@horizon.invalid/db", GITHUB_TOKEN: "fixture-token" };
                const row = { phase, cwd: join(input.cwd, "packages", project), file: `test/${kind}.test.js`,
                    env: testStorageEnvironment(phase === "base" ? "baseline" : "horizondb", { ...options.env, ...values }),
                    cases: [{ fullName: "initial pass", status: "passed" }, ...Array.from({ length: failures[index] }, (_, i) => ({
                        fullName: `failure ${i}`, status: "failed",
                    }))] };
                mkdirSync(join(row.cwd, "test"), { recursive: true });
                writeFileSync(join(row.cwd, row.file), "");
                writeResult(row, join(state.resultsDir, `${phase}.${kind}.json`), row.cases);
                state.rows.push(row);
            }
            for (const phase of new Set(state.rows.map(r => r.phase))) {
                writeFileSync(join(state.resultsDir, `${phase}.complete.json`), JSON.stringify({
                    exitCode: state.rows.some(r => r.phase === phase && r.cases.some(c => c.status === "failed")) ? 1 : 0,
                }));
            }
            return { status: failures.some(Boolean) ? 1 : 0 };
        }
        state.verifications++;
        const row = state.rows.find(r => r.cwd === options.cwd && args.includes(r.file) && r.env.DATABASE_URL === options.env.DATABASE_URL);
        assert(row);
        assert.equal(options.env.PILOTSWARM_RUNTIME_PROVIDER, row.env.PILOTSWARM_RUNTIME_PROVIDER);
        assert.equal(options.env.DATABASE_URL, row.env.DATABASE_URL);
        const pattern = new RegExp(args[args.indexOf("--testNamePattern") + 1]);
        assert(!pattern.test("initial pass"));
        assert(args.includes("--maxWorkers=1") && args.includes("--maxConcurrency=1") && args.includes("--no-file-parallelism"));
        const cases = row.cases.filter(c => pattern.test(c.fullName)).map(c => ({ ...c, status: "passed" }));
        writeResult(row, args.find(a => a.startsWith("--outputFile=")).slice("--outputFile=".length), cases);
        return { status: 0 };
    };
    return { input, run, state };
}

test("complete all-provider coverage qualifies five failures total, including HDB provider cases", t => {
    const f = qualificationFixture(t, [1, 1, 1, 2]);
    runAllProviders({ ...f.input, run: f.run });
    const result = JSON.parse(readFileSync(join(f.state.resultsDir, "qualification.json"), "utf8"));
    assert.equal(result.status, "qualified");
    assert.equal(result.verified, 5);
    assert.equal(f.state.verifications, 4);
});

test("qualification attributes every phase to the PR source rather than trusted workflow source", t => {
    const f = qualificationFixture(t, [1, 0, 0, 0]);
    f.input.env.GITHUB_WORKFLOW_SHA = "a".repeat(40);
    f.input.env.GITHUB_SHA = "b".repeat(40);
    runAllProviders({ ...f.input, run: f.run });
    const result = JSON.parse(readFileSync(join(f.state.resultsDir, "qualification.json"), "utf8"));
    assert.equal(result.status, "qualified");
    assert.equal(result.sourceSha, "b".repeat(40));
    for (const row of f.state.rows) {
        assert.equal(row.env.GITHUB_SHA, "b".repeat(40));
        assert.equal(row.env.GITHUB_WORKFLOW_SHA, "a".repeat(40));
    }
    for (const initial of result.initial) {
        const report = JSON.parse(readFileSync(join(f.state.resultsDir, `${initial.report}.health.json`), "utf8"));
        assert.equal(report.sourceSha, "b".repeat(40));
    }
});

test("six failures across provider phases never launch sequential verification", t => {
    const f = qualificationFixture(t, [0, 3, 0, 3]);
    assert.throws(() => runAllProviders({ ...f.input, run: f.run }), /exceed the limit of 5/);
    assert.equal(f.state.calls, 2);
    assert.equal(f.state.verifications, 0);
});

test("full-HDB qualification uses the HDB environment for every verification", t => {
    const f = qualificationFixture(t, [1, 1, 1], true);
    runAllProviders({ ...f.input, run: f.run });
    assert.equal(f.state.verifications, 3);
    assert(f.state.rows.every(r => r.env.DATABASE_URL === "postgresql://test@horizon.invalid/db"));
});

test("qualification never accepts incomplete coverage or standalone diagnostics", t => {
    const f = qualificationFixture(t, [0, 1, 0, 0]);
    assert.throws(() => runAllProviders({ ...f.input, run(command, args, options) {
        const result = f.run(command, args, options);
        if (f.state.calls === 2) rmSync(join(f.state.resultsDir, "horizondb.horizon-integration.json"));
        return result;
    } }), /Missing or invalid/);
    assert.equal(f.state.verifications, 0);
    assert.throws(() => runHorizonDiagnostics(f.input), /Standalone diagnostics/);
});

// ─── The baseline gate ───────────────────────────────────────
// The complete stock PostgreSQL suite with the same one-time sequential verification. It reads no HorizonDB
// configuration and runs no live HorizonDB check. A complete baseline records two result files: the horizon-store
// unit tests (base.horizon-unit.json) and the SDK suite (base.sdk.json).

function baselineOutcome(f) {
    return JSON.parse(readFileSync(join(f.state.resultsDir, "qualification.json"), "utf8"));
}

test("baseline gate: a complete run with no failed case passes with one command and no sequential run", t => {
    const f = qualificationFixture(t, [0, 0], "baseline");
    const summary = join(f.input.cwd, "summary.md");
    f.input.env.GITHUB_STEP_SUMMARY = summary;
    const logs = [];
    runBaseline({ ...f.input, log: line => logs.push(line), run: f.run });
    assert.equal(f.state.calls, 1, "the complete baseline only: no live HorizonDB check before it");
    assert.equal(f.state.verifications, 0);
    const result = baselineOutcome(f);
    assert.deepEqual([result.status, result.initialFailed, result.verified], ["passed", 0, 0]);
    assert.deepEqual(result.initial.map(item => item.source), ["base/horizon-unit", "base/sdk"]);
    assert.match(readFileSync(summary, "utf8"), /Outcome: \*\*PASSED\*\*\n- Initial failed cases: 0; limit: 5\n- Sequentially verified cases: 0\n/);
    assert(logs.some(line => line.includes("Live HorizonDB coverage is not part of this gate")));
    assert.equal(existsSync(join(f.input.cwd, "pilotswarm-horizondb.env")), false);
});

test("baseline gate: five failed cases across the horizon-store unit tests and the SDK suite are verified sequentially once", t => {
    const f = qualificationFixture(t, [2, 3], "baseline");
    const summary = join(f.input.cwd, "summary.md");
    f.input.env.GITHUB_STEP_SUMMARY = summary;
    runBaseline({ ...f.input, run: f.run });
    assert.equal(f.state.calls, 3, "the complete baseline, then one verification per file with a failed case");
    assert.equal(f.state.verifications, 2);
    const result = baselineOutcome(f);
    assert.deepEqual([result.status, result.initialFailed, result.verified], ["qualified", 5, 5]);
    assert.deepEqual(result.sequential.map(item => [item.source, item.status, item.verified]),
        [["base/horizon-unit", "passed", 2], ["base/sdk", "passed", 3]]);
    // The summary has the counts and the outcome, and no case name.
    const text = readFileSync(summary, "utf8");
    assert.match(text, /Outcome: \*\*QUALIFIED\*\*\n- Initial failed cases: 5; limit: 5\n- Sequentially verified cases: 5\n/);
    assert.doesNotMatch(text, /failure \d|initial pass/);
});

test("baseline gate: one failed case in the horizon-store unit tests alone is verified, in the baseline environment", t => {
    const f = qualificationFixture(t, [1, 0], "baseline");
    runBaseline({ ...f.input, run: f.run });
    assert.equal(f.state.verifications, 1);
    assert.equal(baselineOutcome(f).status, "qualified");
    for (const row of f.state.rows) {
        assert.equal(row.env.PILOTSWARM_RUNTIME_PROVIDER, "postgres");
        assert.equal(row.env.HORIZON_DATABASE_URL, undefined);
    }
});

test("baseline gate: six failed cases fail at once and never launch a sequential run", t => {
    for (const failures of [[0, 6], [6, 0], [3, 3]]) {
        const f = qualificationFixture(t, failures, "baseline");
        assert.throws(() => runBaseline({ ...f.input, run: f.run }), /6 failed test cases exceed the limit of 5/);
        assert.equal(f.state.calls, 1);
        assert.equal(f.state.verifications, 0);
        assert.equal(baselineOutcome(f).status, "failed");
    }
});

test("baseline gate: a case that fails again sequentially fails the gate, and is not tried again", t => {
    const f = qualificationFixture(t, [0, 2], "baseline");
    let verifications = 0;
    assert.throws(() => runBaseline({ ...f.input, run(command, args, options) {
        if (f.state.calls >= 1) { verifications++; return { status: 1 }; }
        return f.run(command, args, options);
    } }), /sequential verification failed; the release does not qualify/);
    assert.equal(verifications, 1);
    assert.equal(baselineOutcome(f).status, "failed");
});

test("baseline gate: missing, truncated or incomplete results cannot qualify", t => {
    const damage = {
        // The runner stopped before the horizon-store unit tests wrote their report (a failed prerequisite).
        "no horizon-store unit report": dir => rmSync(join(dir, "base.horizon-unit.json")),
        "no SDK report": dir => rmSync(join(dir, "base.sdk.json")),
        // A report cut off while it was written.
        "a truncated SDK report": dir => writeFileSync(join(dir, "base.sdk.json"), readFileSync(join(dir, "base.sdk.json"), "utf8").slice(0, 40)),
        "no run-health report": dir => rmSync(join(dir, "base.horizon-unit.json.health.json")),
        "no process result": dir => rmSync(join(dir, "base.sdk.json.exit.json")),
        // The runner never reached its end: no completion record for the phase.
        "no completion record": dir => rmSync(join(dir, "base.complete.json")),
    };
    for (const [label, apply] of Object.entries(damage)) {
        const f = qualificationFixture(t, [0, 1], "baseline");
        assert.throws(() => runBaseline({ ...f.input, run(command, args, options) {
            const result = f.run(command, args, options);
            if (f.state.calls === 1) apply(f.state.resultsDir);
            return result;
        } }), /Missing or invalid/, label);
        assert.equal(f.state.verifications, 0, label);
        assert.equal(baselineOutcome(f).status, "failed", label);
    }
    // An interrupted runner (a signal, or an exit status that is neither 0 nor 1) is not a set of failed cases.
    for (const ended of [{ status: null, signal: "SIGTERM" }, { status: 2 }, { status: 0 }]) {
        const f = qualificationFixture(t, [0, 1], "baseline");
        assert.throws(() => runBaseline({ ...f.input, run(command, args, options) {
            const result = f.run(command, args, options);
            return f.state.calls === 1 ? ended : result;
        } }), /did not finish normally|unexplained failure/);
        assert.equal(f.state.verifications, 0);
    }
});

test("baseline gate: it runs only as the complete, qualified baseline of a captured source", t => {
    const refused = (change, pattern) => {
        const f = qualificationFixture(t, [0, 0], "baseline");
        change(f.input);
        assert.throws(() => runBaseline({ ...f.input, run: f.run }), pattern);
        assert.equal(f.state.calls, 0, "refused before any test runs");
    };
    refused(input => { input.env.TEST_SUITE = "smoke"; }, /full suite; clear the suite filter/);
    refused(input => { input.env.TEST_PROVIDERS = "all"; }, /requires providers=baseline/);
    refused(input => { input.env.TEST_QUALIFY_FAILURES = "false"; }, /without qualification run scripts\/run-tests\.sh/);
    refused(input => { delete input.env.TEST_QUALIFY_FAILURES; }, /without qualification run scripts\/run-tests\.sh/);
    refused(input => { input.env.TEST_QUALIFY_FAILURES = "yes"; }, /must be true or false/);
    refused(input => { input.env.GITHUB_SHA = "main"; }, /captured source SHA/);
    refused(input => { delete input.env.GITHUB_ACTIONS; }, /runs in GitHub Actions/);
    refused(input => { input.env.SKIP_APP_TESTS = "1"; }, /skip flags are not allowed in the baseline gate/);
    refused(input => { writeFileSync(join(input.cwd, ".env"), "DATABASE_URL=postgresql://test@localhost/base\nSKIP_SDK_UNIT_TESTS=1\n"); },
        /skip flags are not allowed in the baseline gate/);
});

test("baseline gate: sequential mode and a tuned file count reach the public runner", t => {
    const f = qualificationFixture(t, [0, 0], "baseline");
    Object.assign(f.input.env, { TEST_MODE: "sequential", PS_TEST_MAX_WORKERS: "3" });
    let seen = null;
    runBaseline({ ...f.input, run(command, args, options) {
        seen = { command, args, workers: options.env.PS_TEST_MAX_WORKERS, results: options.env.PILOTSWARM_TEST_RESULTS_DIR };
        // The fixture asserts the default arguments; this case checks its own.
        return f.run(command, ["./scripts/run-tests.sh"], { ...options, env: { ...options.env, PS_TEST_MAX_WORKERS: "8" } });
    } });
    assert.deepEqual([seen.command, seen.args, seen.workers], ["bash", ["./scripts/run-tests.sh", "--sequential"], "3"]);
    assert.ok(seen.results.startsWith(f.input.cwd));
});

test("the gate script's baseline command is the baseline gate; an unknown command is refused", () => {
    const script = fileURLToPath(new URL("../run-all-providers.mjs", import.meta.url));
    const { GITHUB_ACTIONS: _actions, ...env } = process.env;
    const outside = spawnSync(process.execPath, [script, "baseline"], { encoding: "utf8", env: { ...env, TEST_PROVIDERS: "baseline", TEST_QUALIFY_FAILURES: "true" } });
    assert.equal(outside.status, 1);
    assert.match(outside.stderr, /This gate runs in GitHub Actions\. Use scripts\/run-tests\.sh locally\./);
    const unknown = spawnSync(process.execPath, [script, "postgres"], { encoding: "utf8", env });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Expected no command \(full gate\), diagnose-hdb or baseline\./);
});
