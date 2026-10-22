import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const probe = fileURLToPath(new URL("./fixtures/tui-host-runtime-probe.mjs", import.meta.url));
const legacyLogFile = "/tmp/duroxide-tui.log";
const restoredCalls = ["log", "warn", "error", "stderr", "warning"];

function testDirectory(t) {
    const root = path.join(repoRoot, ".scratch", `tui-host-${randomUUID()}`);
    fs.mkdirSync(root, { recursive: true });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function runHost(root, config = {}, failure) {
    const result = spawnSync(process.execPath, [
        "--experimental-test-module-mocks",
        "--no-warnings=ExperimentalWarning",
        probe,
        JSON.stringify({ root, config: { mode: "remote", ...config }, failure }),
    ], {
        cwd: root,
        env: { ...process.env, XDG_CONFIG_HOME: path.join(root, "config"), LOG_LEVEL: "debug" },
        encoding: "utf8",
        timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
}

function assertRestored(result) {
    assert.deepEqual(result.restoredCalls, restoredCalls);
}

for (const agentPackages of [{}, { cacheDir: "app package cache", refreshIntervalMs: 0 }]) {
    test(`the public TUI host forwards agentPackages ${JSON.stringify(agentPackages)} unchanged`, (t) => {
        const root = testDirectory(t);
        const config = { mode: "local", store: "sqlite::memory:", agentPackages };
        const result = runHost(root, config);

        assert.equal(result.error, null);
        assert.deepEqual(result.transportOptions, [config]);
        assertRestored(result);
    });
}

test("omitting agentPackages preserves direct transport defaults", (t) => {
    const root = testDirectory(t);
    const config = { mode: "local", store: "sqlite::memory:" };
    const result = runHost(root, config);

    assert.equal(result.error, null);
    assert.deepEqual(result.transportOptions, [config]);
});

test("Web API hosts do not configure local package workers", (t) => {
    const root = testDirectory(t);
    const result = runHost(root, {
        apiUrl: "https://portal.example.invalid",
        agentPackages: { cacheDir: path.join(root, "unused-packages") },
    });

    assert.equal(result.error, null);
    assert.deepEqual(result.transportOptions, []);
    assert.equal(fs.existsSync(path.join(root, "unused-packages")), false);
});

test("the public TUI host sends every diagnostic sink to its custom path", (t) => {
    const root = testDirectory(t);
    const logFile = path.join(root, "app logs", "diagnostics-λ.log");
    fs.writeFileSync(path.join(root, "legacy.log"), "unrelated legacy log\n");

    const result = runHost(root, { logFile });

    assert.equal(result.error, null);
    assert.deepEqual(result.tracing, [{ logFile, logLevel: "debug", logFormat: "compact" }]);
    assert.ok(result.writes.every((file) => file === logFile));
    assert.equal(result.stderrCallback, true);
    const log = fs.readFileSync(logFile, "utf8");
    for (const message of [
        "[native] fixture trace", 'fixture console log {"fixture":true}',
        "fixture console warn", "Error: fixture console error", "fixture stderr",
        '[warning] fixture warning {"code":"FIXTURE_WARNING"}',
        "fixture controller stop", "fixture cleanup",
    ]) {
        assert.ok(log.includes(message), `Missing diagnostic: ${message}`);
    }
    assert.doesNotMatch(log, /after restore/);
    assert.equal(fs.readFileSync(path.join(root, "legacy.log"), "utf8"), "unrelated legacy log\n");
    assert.deepEqual(result.events, ["render", "stop", "clear", "unmount", "cleanup", "exit:0"]);
    assertRestored(result);
});

test("separate app processes truncate only their own destination on startup", (t) => {
    const root = testDirectory(t);
    const first = path.join(root, "first.log");
    const second = path.join(root, "second.log");
    fs.writeFileSync(first, "old first\n");
    fs.writeFileSync(second, "old second\n");

    assert.equal(runHost(root, { logFile: first }).error, null);
    const firstLog = fs.readFileSync(first, "utf8");
    assert.doesNotMatch(firstLog, /old first/);
    assert.equal(fs.readFileSync(second, "utf8"), "old second\n");

    assert.equal(runHost(root, { logFile: second }).error, null);
    const secondLog = fs.readFileSync(second, "utf8");
    assert.doesNotMatch(secondLog, /old second/);
    assert.equal(fs.readFileSync(first, "utf8"), firstLog);

    fs.appendFileSync(first, "before restart\n");
    assert.equal(runHost(root, { logFile: first }).error, null);
    assert.doesNotMatch(fs.readFileSync(first, "utf8"), /before restart/);
    assert.equal(fs.readFileSync(second, "utf8"), secondLog);
});

test("relative custom paths resolve against the host cwd in Web API mode too", (t) => {
    const root = testDirectory(t);
    const relativeLogFile = path.join("nested logs", "host.log");
    const result = runHost(root, { apiUrl: "https://portal.example.invalid", logFile: relativeLogFile });

    assert.equal(result.error, null);
    assert.equal(result.tracing[0].logFile, path.join(root, relativeLogFile));
    assert.match(fs.readFileSync(path.join(root, relativeLogFile), "utf8"), /fixture console log/);
    assertRestored(result);
});

test("omitting logFile preserves the legacy destination and startup truncation", (t) => {
    const root = testDirectory(t);
    fs.writeFileSync(path.join(root, "legacy.log"), "old legacy\n");

    const result = runHost(root);

    assert.equal(result.error, null);
    assert.equal(result.tracing[0].logFile, legacyLogFile);
    assert.ok(result.writes.every((file) => file === legacyLogFile));
    assert.doesNotMatch(fs.readFileSync(path.join(root, "legacy.log"), "utf8"), /old legacy/);
    assertRestored(result);
});

for (const logFile of ["", "   ", null, 42, {}, ["host.log"]]) {
    test(`an explicit invalid logFile (${JSON.stringify(logFile)}) rejects without redirecting`, (t) => {
        const root = testDirectory(t);
        const result = runHost(root, { logFile });

        assert.equal(result.error?.name, "TypeError");
        assert.match(result.error.message, /logFile.*non-empty.*string/i);
        assert.deepEqual(result.tracing, []);
        assert.deepEqual(result.writes, []);
        assert.deepEqual(result.events, []);
        assertRestored(result);
    });
}

test("an explicit directory destination rejects without falling back", (t) => {
    const root = testDirectory(t);
    const logFile = path.join(root, "directory.log");
    fs.mkdirSync(logFile);
    const result = runHost(root, { logFile });

    assert.ok(result.error, "Expected the filesystem's directory-write error");
    assert.match(result.error.code, /EISDIR|EPERM|EACCES/);
    assert.deepEqual(result.tracing, []);
    assert.deepEqual(result.events, []);
    assert.equal(fs.existsSync(path.join(root, "legacy.log")), false);
    assertRestored(result);
});

test("a non-directory parent rejects without changing its contents", (t) => {
    const root = testDirectory(t);
    const parent = path.join(root, "not-a-directory");
    fs.writeFileSync(parent, "keep this file\n");
    const result = runHost(root, { logFile: path.join(parent, "host.log") });

    assert.ok(result.error);
    assert.deepEqual(result.tracing, []);
    assert.deepEqual(result.writes, []);
    assert.equal(fs.readFileSync(parent, "utf8"), "keep this file\n");
    assert.equal(fs.existsSync(path.join(root, "legacy.log")), false);
    assertRestored(result);
});

test("a path containing a null byte rejects without falling back", (t) => {
    const root = testDirectory(t);
    const result = runHost(root, { logFile: path.join(root, "invalid\0.log") });

    assert.equal(result.error?.code, "ERR_INVALID_ARG_VALUE");
    assert.deepEqual(result.tracing, []);
    assert.equal(fs.existsSync(path.join(root, "legacy.log")), false);
    assertRestored(result);
});

for (const failure of ["write", "tracing"]) {
    test(`custom ${failure} initialization errors propagate unchanged`, (t) => {
        const root = testDirectory(t);
        const result = runHost(root, { logFile: path.join(root, "host.log") }, failure);

        assert.equal(result.sameError, true);
        assert.equal(result.error?.code, "EACCES");
        assert.deepEqual(result.events, []);
        assert.equal(fs.existsSync(path.join(root, "legacy.log")), false);
        assertRestored(result);
    });

    test(`omitting logFile retains best-effort ${failure} initialization`, (t) => {
        const root = testDirectory(t);
        const result = runHost(root, {}, failure);

        assert.equal(result.error, null);
        assert.ok(result.events.includes("cleanup"));
        assertRestored(result);
    });
}

for (const failure of ["platform", "render"]) {
    test(`host logging is restored when ${failure} startup fails`, (t) => {
        const root = testDirectory(t);
        const result = runHost(root, { logFile: path.join(root, "host.log") }, failure);

        assert.equal(result.sameError, true);
        assertRestored(result);
    });
}

test("shutdown still cleans up and restores logging when controller.stop rejects", (t) => {
    const root = testDirectory(t);
    const result = runHost(root, { logFile: path.join(root, "host.log") }, "stop");

    assert.equal(result.error, null);
    assert.deepEqual(result.events, ["render", "stop", "clear", "unmount", "cleanup", "exit:0"]);
    assertRestored(result);
});
