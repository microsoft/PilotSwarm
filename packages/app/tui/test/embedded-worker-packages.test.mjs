import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const probe = fileURLToPath(new URL("./fixtures/embedded-worker-packages-probe.mjs", import.meta.url));

function runTransport(t, { mode = "local", count = 2, agentPackages, failStart = false } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pilotswarm-tui-packages-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const pluginDirs = [path.join(root, "primary"), path.join(root, "extra")];
    for (const dir of pluginDirs) fs.mkdirSync(dir);
    const env = Object.fromEntries(
        ["PATH", "Path", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "TEMP", "TMP"]
            .filter((name) => process.env[name] !== undefined)
            .map((name) => [name, process.env[name]]),
    );
    const result = spawnSync(process.execPath, [
        "--experimental-test-module-mocks",
        "--no-warnings=ExperimentalWarning",
        probe,
        JSON.stringify({ mode, agentPackages, failStart }),
    ], {
        cwd: root,
        env: {
            ...env,
            HOME: root,
            USERPROFILE: root,
            XDG_CONFIG_HOME: path.join(root, "config"),
            SESSION_STATE_DIR: path.join(root, "session-state"),
            ARTIFACT_DIR: path.join(root, "artifacts"),
            PILOTSWARM_EXPORT_DIR: path.join(root, "exports"),
            PLUGIN_DIRS: pluginDirs.join(","),
            WORKERS: String(count),
        },
        encoding: "utf8",
        timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return { ...JSON.parse(result.stdout), pluginDirs };
}

test("the public transport passes exact package options to every embedded worker", (t) => {
    const agentPackages = { cacheDir: path.join("application state", "packages"), refreshIntervalMs: 0 };
    const result = runTransport(t, { agentPackages });

    assert.equal(result.error, null);
    assert.equal(result.workers.length, 2);
    for (const [index, worker] of result.workers.entries()) {
        assert.equal(worker.workerNodeId, `local-${index}`);
        assert.equal(worker.store, "sqlite::memory:");
        assert.deepEqual(worker.pluginDirs, result.pluginDirs);
        assert.equal(worker.hasAgentPackages, true);
        assert.equal(worker.samePackageOptions, true);
        assert.deepEqual(worker.agentPackages, agentPackages);
    }
    assert.deepEqual(result.started, ["local-0", "local-1", "client", "management"]);
    assert.deepEqual(result.stopped.sort(), ["client", "local-0", "local-1", "management"]);
});

test("an empty agentPackages object opts in without replacing SDK defaults", (t) => {
    const result = runTransport(t, { agentPackages: {} });

    assert.equal(result.error, null);
    assert.equal(result.workers.length, 2);
    for (const worker of result.workers) {
        assert.equal(worker.hasAgentPackages, true);
        assert.equal(worker.samePackageOptions, true);
        assert.deepEqual(worker.agentPackages, {});
    }
});

test("omitting agentPackages leaves embedded worker package loading off", (t) => {
    const result = runTransport(t);

    assert.equal(result.error, null);
    assert.equal(result.workers.length, 2);
    assert.ok(result.workers.every((worker) => !worker.hasAgentPackages));
});

for (const options of [{ mode: "remote", count: 2 }, { mode: "local", count: 0 }]) {
    test(`${options.mode} mode with WORKERS=${options.count} does not start package workers`, (t) => {
        const result = runTransport(t, { ...options, agentPackages: {} });

        assert.equal(result.error, null);
        assert.deepEqual(result.workers, []);
        assert.deepEqual(result.started, ["client", "management"]);
        assert.deepEqual(result.stopped.sort(), ["client", "management"]);
    });
}

test("embedded worker startup failures still reject transport startup unchanged", (t) => {
    const result = runTransport(t, { agentPackages: {}, failStart: true });

    assert.equal(result.sameError, true);
    assert.equal(result.error, "fixture worker start failure");
    assert.equal(result.workers.length, 1);
    assert.deepEqual(result.started, []);
});
