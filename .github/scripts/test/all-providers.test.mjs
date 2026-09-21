import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireHorizonConfig, requireLiveHorizonResult, runAllProviders, runHorizonDiagnostics } from "../run-all-providers.mjs";
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

function qualificationFixture(t, failures, fullHdb = false) {
    const input = fixture(t);
    Object.assign(input.env, { GITHUB_SHA: "a".repeat(40), TEST_MODE: "parallel", TEST_PROVIDERS: fullHdb ? "horizondb" : "all", TEST_QUALIFY_FAILURES: "true" });
    const specs = fullHdb
        ? [["horizondb", "horizon-unit", "horizon-store"], ["horizondb", "horizon-integration", "horizon-store"], ["horizondb", "sdk", "sdk"]]
        : [["base", "horizon-unit", "horizon-store"], ["base", "sdk", "sdk"],
            ["horizondb", "horizon-integration", "horizon-store"], ["horizondb", "sdk", "sdk"]];
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
        if (state.calls === 1) {
            writeFileSync(join(input.cwd, "pilotswarm-horizondb-preflight.json"), JSON.stringify(report()));
            return { status: 0 };
        }
        if (state.calls === 2) {
            assert.equal(command, "bash");
            assert.deepEqual(args, ["./scripts/run-tests.sh", fullHdb ? "--with-horizondb" : "--all-providers"]);
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
