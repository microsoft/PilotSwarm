/**
 * Session workspaces: process-tree.ts, the helpers that stop background
 * shells the Copilot CLI will not cancel (docs/proposals/session-workspaces.md
 * 4.5). The kill itself is tested in session-workspace-release.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { killProcessTree, processAlive, processStartTimeMs, taskProcessAlive } from "../../dist/process-tree.js";

async function startChild(t, script = "process.send('ready'); setInterval(() => {}, 1_000);") {
    const child = spawn(process.execPath, ["-e", script], {
        stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
    });
    const exited = once(child, "exit");
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
    });
    const [message] = await once(child, "message");
    return { child, exited, message };
}

test("a process's start time is read from the host, to within a couple of seconds", async (t) => {
    const before = Date.now();
    const { child } = await startChild(t);
    const started = processStartTimeMs(child.pid);
    assert.equal(typeof started, "number");
    assert.ok(Math.abs(started - before) < 2_500, `${started - before} ms off`);
});

test("a task's pid counts only while it runs the process the task started (review R4)", async (t) => {
    const { child, exited } = await startChild(t);
    const iso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString();
    assert.equal(taskProcessAlive(child.pid, iso(0)), true, "started with the task");
    assert.equal(taskProcessAlive(child.pid, iso(-60_000)), false, "the task is a minute older than the process: the pid was reused");
    assert.equal(taskProcessAlive(child.pid), true, "without a start time, a live pid counts");
    assert.equal(taskProcessAlive(child.pid, "not a date"), true);
    assert.equal(taskProcessAlive(process.pid, iso(0)), false, "never this process");
    assert.equal(taskProcessAlive(1, iso(0)), false, "never pid 1");
    assert.equal(taskProcessAlive("123", iso(0)), false);
    child.kill("SIGKILL");
    await exited;
    assert.equal(taskProcessAlive(child.pid, iso(0)), false, "a dead pid does not count");
});

test("Windows tree cleanup stops a test child and its grandchild", {
    skip: process.platform !== "win32",
}, async (t) => {
    const { child, exited, message } = await startChild(t, `
        const { spawn } = require("node:child_process");
        const grandchild = spawn(process.execPath, ["-e",
            "process.send({ pid: process.pid, startedAt: new Date().toISOString() }); setInterval(() => {}, 1_000);"
        ], { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
        grandchild.once("message", message => process.send(message));
        setInterval(() => {}, 1_000);
    `);
    const grandchildPid = message.pid;
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 1);
    t.after(() => {
        if (taskProcessAlive(grandchildPid, message.startedAt)) {
            try { process.kill(grandchildPid, "SIGKILL"); } catch {}
        }
    });
    assert.equal(processAlive(grandchildPid), true);
    assert.equal(killProcessTree(child.pid), true);
    await exited;
    const deadline = Date.now() + 5_000;
    while (processAlive(grandchildPid) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(processAlive(grandchildPid), false, "the descendant must not survive its root");
});
