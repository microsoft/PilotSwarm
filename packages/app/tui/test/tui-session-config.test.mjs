// Plan 3 (R6): the terminal UI keeps which Terminated rows are open in its config file, next to the collapsed rows.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const probe = fileURLToPath(new URL("./fixtures/tui-session-config-probe.mjs", import.meta.url));

function testDirectory(t) {
    const root = path.join(repoRoot, ".scratch", `tui-config-${randomUUID()}`);
    fs.mkdirSync(path.join(root, "config", "pilotswarm"), { recursive: true });
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

function runHost(root, actions = []) {
    const configFile = path.join(root, "config", "pilotswarm", "config.json");
    const result = spawnSync(process.execPath, [
        "--experimental-test-module-mocks",
        "--no-warnings=ExperimentalWarning",
        probe,
        JSON.stringify({ config: { mode: "remote", logFile: path.join(root, "host.log") }, actions, configFile }),
    ], {
        cwd: root,
        env: { ...process.env, XDG_CONFIG_HOME: path.join(root, "config") },
        encoding: "utf8",
        timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    return JSON.parse(result.stdout);
}

test("open Terminated rows round-trip through the terminal UI's config file", (t) => {
    const root = testDirectory(t);
    fs.writeFileSync(path.join(root, "config", "pilotswarm", "config.json"), JSON.stringify({
        openTerminatedSessionIds: ["P", " ", "group:g", "terminated:P", "Q", "P"],
        collapsedSessionIds: ["X"],
        themeId: "dark",
    }));

    // A Terminated row can be opened once its parent is listed: P, Q and R, each with one finished child.
    const listing = ["P", "Q", "R"].flatMap((id, n) => [
        { sessionId: id, title: id, status: "idle", createdAt: 2 * n + 1, updatedAt: 2 * n + 1 },
        { sessionId: `${id}1`, parentSessionId: id, title: `${id}1`, status: "completed", createdAt: 2 * n + 2, updatedAt: 2 * n + 2 },
    ]);
    const first = runHost(root, [
        { type: "sessions/loaded", sessions: listing },
        { type: "sessions/terminatedOpen", parentSessionId: "R" },
        { type: "sessions/terminatedClose", parentSessionId: "Q" },
    ]);
    assert.deepEqual(first.restored, { openTerminatedIds: ["P", "Q"], collapsedIds: ["X"] });
    assert.deepEqual(first.written.openTerminatedSessionIds, ["P", "R"], "saved as a sorted array of parent session ids");
    assert.deepEqual(first.written.collapsedSessionIds, ["X"]);
    assert.equal(first.written.themeId, "dark", "other settings are kept");

    const second = runHost(root);
    assert.deepEqual(second.restored.openTerminatedIds, ["P", "R"], "the next start reads back what was saved");
    assert.deepEqual(second.written.openTerminatedSessionIds, ["P", "R"]);
});
