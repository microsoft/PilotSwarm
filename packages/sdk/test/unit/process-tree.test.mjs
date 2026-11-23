/**
 * Session workspaces: process-tree.ts, the helpers that stop background
 * shells the Copilot CLI will not cancel (docs/proposals/session-workspaces.md
 * 4.5). The kill itself is tested in session-workspace-release.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { killShellProcessScope, processIds, processStartTimeMs, shellProcessScope, taskProcessAlive } from "../../dist/process-tree.js";
import { ManagedSession } from "../../dist/managed-session.js";

test("a process's start time is read from the host, to within a couple of seconds", { skip: process.platform === "win32" && "process start times use Linux /proc" }, async (t) => {
    const before = Date.now();
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    t.after(() => { try { process.kill(child.pid, "SIGKILL"); } catch {} });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = processStartTimeMs(child.pid);
    assert.equal(typeof started, "number");
    assert.ok(Math.abs(started - before) < 2_500, `${started - before} ms off`);
});

test("a task's pid counts only while it runs the process the task started (review R4)", { skip: process.platform === "win32" && "process start times use Linux /proc" }, async (t) => {
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

const linuxOnly = process.platform !== "linux" && "shell sessions are read from Linux /proc";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Live (not zombie) processes of a Linux session. */
function sessionMembers(sid) {
    const members = [];
    for (const entry of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
            const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
            const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            if (fields[0] !== "Z" && Number(fields[3]) === sid) members.push(Number(entry));
        } catch { /* gone */ }
    }
    return members;
}

/**
 * The layout the CLI makes (probed on SDK 1.0.34): this process, then a CLI
 * process, then a wrapper that leads a new session, then the shell the task
 * reports. The shell starts a daemon that leaves its tree, as `cmd &` in a
 * subshell does.
 */
async function startShellLayout(t) {
    const startedAt = new Date().toISOString();
    const cli = spawn(process.execPath, ["-e", [
        "const { spawn } = require('node:child_process');",
        "const wrapper = spawn('sh', ['-c', process.env.PS_WRAP], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });",
        "wrapper.stdout.pipe(process.stdout);",
        "setInterval(() => {}, 1000);",
    ].join("\n")], {
        env: { ...process.env, PS_WRAP: "sh -c '(sleep 1000 &); exec sleep 1001' & echo $!; wait" },
        stdio: ["ignore", "pipe", "ignore"],
    });
    let sid;
    t.after(() => {
        for (const pid of sid ? sessionMembers(sid) : []) { try { process.kill(pid, "SIGKILL"); } catch {} }
        try { process.kill(cli.pid, "SIGKILL"); } catch {}
    });
    const shellPid = await new Promise((resolve, reject) => {
        let out = "";
        cli.stdout.on("data", (chunk) => {
            out += chunk;
            const match = /^(\d+)\n/.exec(out);
            if (match) resolve(Number(match[1]));
        });
        cli.once("exit", () => reject(new Error("the CLI stand-in exited")));
    });
    sid = processIds(shellPid)?.sid;
    // The daemon is the member re-parented away from the shell and the wrapper, not the subshell that starts it.
    let daemon;
    for (let i = 0; i < 100 && daemon === undefined; i++) {
        daemon = sid === undefined ? undefined : sessionMembers(sid).find((pid) => {
            const parent = processIds(pid)?.ppid;
            return pid !== shellPid && pid !== sid && parent !== undefined && parent !== shellPid && parent !== sid;
        });
        if (daemon === undefined) await pause(20);
    }
    assert.ok(sid !== undefined && daemon !== undefined, "the layout started");
    return { cli, shellPid, sid, daemon, startedAt };
}

test("a shell's own session is found below the CLI, and its kill reaches a daemon that left the shell's tree", { skip: linuxOnly }, async (t) => {
    const { cli, shellPid, sid, daemon, startedAt } = await startShellLayout(t);
    assert.equal(processIds(shellPid).ppid, sid, "the wrapper leads the session");
    assert.notEqual(processIds(daemon).ppid, shellPid, "the daemon left the shell's tree");
    assert.notEqual(processIds(daemon).ppid, sid);

    const scope = shellProcessScope(shellPid, startedAt);
    assert.deepEqual({ kind: scope?.kind, id: scope?.id }, { kind: "session", id: sid });
    assert.equal(shellProcessScope(cli.pid), undefined, "the CLI shares this process's session");

    assert.equal(killShellProcessScope(scope), true);
    await pause(100);
    assert.deepEqual(sessionMembers(sid), [], "nothing of the shell's session is left");
    assert.doesNotThrow(() => process.kill(cli.pid, 0), "the CLI is not touched");
    assert.equal(killShellProcessScope(scope), false, "an empty scope is not signalled");
});

test("a session or group that this process, or a child of it, leads is never a shell's scope", { skip: linuxOnly }, async (t) => {
    const ownSession = spawn("sleep", ["30"], { stdio: "ignore" });
    const leader = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
    t.after(() => {
        for (const child of [ownSession, leader]) { try { process.kill(child.pid, "SIGKILL"); } catch {} }
    });
    await pause(100);
    assert.equal(processIds(leader.pid).sid, leader.pid);
    assert.equal(shellProcessScope(ownSession.pid), undefined, "this process's own session");
    assert.equal(shellProcessScope(leader.pid), undefined, "a session led by a direct child, as the CLI could be");
    assert.equal(shellProcessScope(process.pid), undefined);
    assert.equal(shellProcessScope(1), undefined);
    assert.equal(killShellProcessScope({ kind: "session", id: process.pid }), false);
    assert.equal(killShellProcessScope({ kind: "group", id: 1 }), false);
});

test("a scope whose id went to a new leader is not killed", { skip: linuxOnly }, async (t) => {
    const leader = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
    t.after(() => { try { process.kill(leader.pid, "SIGKILL"); } catch {} });
    await pause(100);
    const startedMs = processStartTimeMs(leader.pid);
    assert.equal(killShellProcessScope({ kind: "session", id: leader.pid, leaderStartMs: startedMs - 60_000 }), false);
    assert.doesNotThrow(() => process.kill(leader.pid, 0), "the new leader lives");
});

test("cancelling a session's shells also stops the daemons they started", { skip: linuxOnly }, async (t) => {
    const { shellPid, sid, daemon, startedAt } = await startShellLayout(t);
    const calls = [];
    const fake = {
        copilotSession: {
            rpc: {
                tasks: {
                    // The CLI lists a detached shell while its pid lives, and its cancel ends only that pid.
                    list: async () => {
                        calls.push("list");
                        return { tasks: [{ type: "shell", id: "0", status: "running", pid: shellPid, startedAt }] };
                    },
                    cancel: async ({ id }) => {
                        calls.push(`cancel:${id}`);
                        process.kill(shellPid, "SIGKILL");
                        return { cancelled: true };
                    },
                },
            },
        },
    };
    assert.equal(await ManagedSession.prototype.cancelBackgroundTasks.call(fake, { pauseMs: 100 }), 1);
    assert.equal(calls.filter((call) => call === "cancel:0").length, 1);
    await pause(100);
    assert.throws(() => process.kill(daemon, 0), "the daemon is gone");
    assert.deepEqual(sessionMembers(sid), []);
});