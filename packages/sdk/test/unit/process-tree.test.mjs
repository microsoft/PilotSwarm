/**
 * Session workspaces: process-tree.ts, the helpers that stop background
 * shells the Copilot CLI will not cancel (docs/proposals/session-workspaces.md
 * 4.5). The kill itself is tested in session-workspace-release.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { processStartTimeMs, taskProcessAlive } from "../../dist/process-tree.js";

test("a process's start time is read from the host, to within a couple of seconds", async (t) => {
    const before = Date.now();
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    t.after(() => { try { process.kill(child.pid, "SIGKILL"); } catch {} });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = processStartTimeMs(child.pid);
    assert.equal(typeof started, "number");
    assert.ok(Math.abs(started - before) < 2_500, `${started - before} ms off`);
});

test("a task's pid counts only while it runs the process the task started (review R4)", async (t) => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    t.after(() => { try { process.kill(child.pid, "SIGKILL"); } catch {} });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
    assert.equal(taskProcessAlive(child.pid, iso(0)), true, "started with the task");
    assert.equal(taskProcessAlive(child.pid, iso(-60_000)), false, "the task is a minute older than the process: the pid was reused");
    assert.equal(taskProcessAlive(child.pid), true, "without a start time, a live pid counts");
    assert.equal(taskProcessAlive(child.pid, "not a date"), true);
    assert.equal(taskProcessAlive(process.pid, iso(0)), false, "never this process");
    assert.equal(taskProcessAlive(1, iso(0)), false, "never pid 1");
    assert.equal(taskProcessAlive("123", iso(0)), false);
    process.kill(child.pid, "SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(taskProcessAlive(child.pid, iso(0)), false, "a dead pid does not count");
});
