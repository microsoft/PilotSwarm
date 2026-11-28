/**
 * Session workspaces: process-tree.ts, the helpers that stop background
 * shells the Copilot CLI will not cancel (docs/proposals/session-workspaces.md
 * 4.5). The kill itself is tested in session-workspace-release.test.mjs.
 *
 * The first tests run the kill rules on an injected process table, so they
 * run the same on every platform; the rest use real processes on Linux.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import {
    bindShellProcess, killListedShells, killProcessTree, killShellProcessScope, killShellProcessScopes,
    processIds, processStartTimeMs, readProcess, shellProcessScope, taskProcessAlive,
} from "../../dist/process-tree.js";
import { ManagedSession } from "../../dist/managed-session.js";
import { fakeProcessHost, fakeTaskSession } from "../helpers/fake-process-host.mjs";

/** A task's start, in epoch milliseconds. */
const T = 1_700_000_000_000;

/**
 * The layout the CLI makes (probed on SDK 1.0.34), as a process table: this
 * process, the CLI below it, a wrapper that leads a new session and group,
 * the shell the task reports with a child, and a daemon the shell started
 * that left its tree (re-parented to PID 1) and leads a group of its own.
 */
function cliLayout({ selfPid = 1000, platform = "linux", now } = {}) {
    return fakeProcessHost({
        platform, selfPid, now,
        processes: [
            { pid: selfPid, ppid: selfPid === 1 ? 0 : 1, pgid: selfPid, sid: selfPid, start: T - 60_000 },
            { pid: 100, ppid: selfPid, pgid: selfPid, sid: selfPid, start: T - 30_000 },
            { pid: 200, ppid: 100, pgid: 200, sid: 200, start: T - 5 },
            { pid: 201, ppid: 200, pgid: 200, sid: 200, start: T - 4 },
            { pid: 210, ppid: 201, pgid: 200, sid: 200, start: T + 100 },
            { pid: 202, ppid: 1, pgid: 202, sid: 200, start: T + 50 },
        ],
    });
}
const pids = (host) => [...host.table.keys()].sort((a, b) => a - b);
const cancelTasks = (session, options) => ManagedSession.prototype.cancelBackgroundTasks.call(session, options);

test("when this process is PID 1 (a container without an init), a shell's own session is still its scope (review 377 SF-1)", () => {
    const host = cliLayout({ selfPid: 1 });
    // A session led by a direct child of this process: nothing sits between them, so it could be the CLI's own.
    host.add({ pid: 300, ppid: 1, pgid: 300, sid: 300, start: T - 3 });
    host.add({ pid: 301, ppid: 300, pgid: 300, sid: 300, start: T - 2 });

    const scope = shellProcessScope(201, T, { host });
    assert.deepEqual(scope, { kind: "session", id: 200, leader: { pid: 200, start: T - 5 } });
    assert.equal(shellProcessScope(301, T, { host }), undefined, "a session a direct child leads");
    assert.equal(shellProcessScope(100, T, { host }), undefined, "the CLI shares this process's session");

    assert.equal(killShellProcessScope(scope, { host }), true);
    assert.deepEqual(host.kills, [-200, 202], "the shell's group, then the daemon that left it");
    assert.deepEqual(pids(host), [1, 100, 300, 301]);
});

test("a raw-pid kill signals only the process bound, by its exact start, and each child as listed (review 377 SF-2)", () => {
    const host = cliLayout();
    const { identity } = bindShellProcess(201, T, { host });
    assert.deepEqual(identity, { pid: 201, start: T - 4 });
    // The pid now runs another process that started one tick later.
    host.remove(201);
    host.add({ pid: 201, ppid: 200, pgid: 200, sid: 200, start: T - 3 });
    assert.equal(killProcessTree(201, { identity, host }), false);
    assert.equal(killListedShells([{ pid: 201, identity }], { host }), 0);
    assert.deepEqual(host.kills, []);

    // A child that changed between the listing and its signal is spared; the rest of the tree is not.
    const other = cliLayout();
    const bound = bindShellProcess(201, T, { host: other }).identity;
    const snapshot = other.snapshot();
    other.remove(210);
    other.add({ pid: 210, ppid: 1, pgid: 210, sid: 210, start: T + 900 });
    assert.equal(killProcessTree(201, { identity: bound, host: other, snapshot }), true);
    assert.deepEqual(other.kills, [201]);
    assert.equal(other.table.has(210), true, "the process that took the child's pid lives");
});

test("nothing is signalled once the caller's deadline has passed, even part way through a kill (review 377 SF-2)", () => {
    let clock = 0;
    // Each deadline check moves the clock on by 1 ms.
    const host = cliLayout({ now: () => clock++ });
    const { identity, scope } = bindShellProcess(201, T, { host });
    assert.equal(killProcessTree(201, { identity, host, deadline: 1 }), true);
    assert.deepEqual(host.kills, [201], "the child's check came after the deadline");
    assert.equal(host.table.has(210), true);

    clock = 10;
    assert.deepEqual(killShellProcessScopes([scope], { host, deadline: 5 }), [false]);
    assert.equal(killListedShells([{ pid: 210, identity: { pid: 210, start: T + 100 }, scope }], { host, deadline: 5 }), 0);
    assert.deepEqual(host.kills, [201]);
});

test("a cancel that answers only after the deadline leaves the loop without a signal (review 377 SF-2)", async () => {
    let clock = T;
    const host = cliLayout({ now: () => clock });
    // CLI 1.0.83 answers { cancelled: false } after an abort; here the answer also comes after the caller gave up.
    const session = fakeTaskSession(host, [{ id: "sh", type: "shell", pid: 201, startedAt: T }], async () => {
        clock = T + 10_000;
        return { cancelled: false };
    });
    await assert.rejects(cancelTasks(session, { deadline: T + 5_000 }), /deadline/);
    assert.deepEqual(host.kills, []);
    assert.equal(host.table.has(201), true);
});

test("a shell whose start cannot be read, or whose task has no start, is never signalled (review 377 SF-2)", async () => {
    const unreadable = cliLayout();
    unreadable.table.get(201).start = Number.NaN;
    assert.deepEqual(bindShellProcess(201, T, { host: unreadable }), {});
    assert.equal(shellProcessScope(201, T, { host: unreadable }), undefined);
    assert.equal(killProcessTree(201, { identity: { pid: 201, start: Number.NaN }, host: unreadable }), false);
    const undated = cliLayout();
    assert.deepEqual(bindShellProcess(201, undefined, { host: undated }), {}, "without the task's start the pid is not tied to it");

    for (const [host, startedAt] of [[unreadable, T], [undated, undefined]]) {
        const session = fakeTaskSession(host, [{ id: "sh", type: "shell", pid: 201, startedAt }], async () => ({ cancelled: false }));
        await assert.rejects(cancelTasks(session, { rounds: 1, pauseMs: 0 }), /still active/);
        assert.deepEqual(host.kills, []);
    }
});

test("on Windows nothing is signalled, whatever the process table says (review 377 SF-2)", async () => {
    const host = cliLayout({ platform: "win32" });
    const scope = shellProcessScope(201, T, { host: cliLayout() });
    assert.ok(scope, "the same layout has a scope on Linux");
    const identity = { pid: 201, start: T - 4 };
    assert.deepEqual(bindShellProcess(201, T, { host }), {});
    assert.equal(shellProcessScope(201, T, { host }), undefined);
    assert.equal(killProcessTree(201, { identity, host }), false);
    assert.deepEqual(killShellProcessScopes([scope], { host }), [false]);
    assert.equal(killListedShells([{ pid: 201, identity, scope }], { host }), 0);
    const session = fakeTaskSession(host, [{ id: "sh", type: "shell", pid: 201, startedAt: T }], async () => ({ cancelled: false }));
    await assert.rejects(cancelTasks(session, { rounds: 1, pauseMs: 0 }), /still active/);
    assert.deepEqual(host.kills, []);
});

test("one cancel that never answers holds back neither the other cancels nor the kills (review 377 SF-3)", { timeout: 10_000 }, async () => {
    const host = cliLayout();
    // A second shell, in a session of its own.
    host.add({ pid: 300, ppid: 100, pgid: 300, sid: 300, start: T - 5 });
    host.add({ pid: 301, ppid: 300, pgid: 300, sid: 300, start: T - 4 });
    const session = fakeTaskSession(host, [
        { id: "a1", type: "shell", pid: 201, startedAt: T },
        { id: "a2", type: "shell", pid: 301, startedAt: T },
    ], async (task) => {
        if (task.id === "a2") return new Promise(() => {});
        host.remove(task.pid);
        return { cancelled: true };
    });
    const cancelled = await cancelTasks(session, { cancelWaitMs: 20, pauseMs: 0 });
    assert.equal(cancelled, 2, "a1 by its cancel, a2 by the kill of the process bound to it");
    assert.deepEqual(session.calls, ["list", "cancel:a1", "cancel:a2", "list"]);
    assert.equal(host.table.has(202), false, "a1's daemon went with a1's session");
    assert.deepEqual(pids(host), [100, 1000]);
});

test("one process-table read per pass serves every shell, however many a session has (review 377 SF-5)", async () => {
    const reads = async (count) => {
        const host = cliLayout();
        const tasks = [];
        for (let i = 0; i < count; i++) {
            // A wrapper leading its own session, its shell, and a daemon that left the shell's tree.
            const leader = 300 + 10 * i;
            host.add({ pid: leader, ppid: 100, pgid: leader, sid: leader, start: T - 5 });
            host.add({ pid: leader + 1, ppid: leader, pgid: leader, sid: leader, start: T - 4 });
            host.add({ pid: leader + 2, ppid: 1, pgid: leader + 2, sid: leader, start: T + 50 });
            tasks.push({ id: `sh${i}`, type: "shell", pid: leader + 1, startedAt: T });
        }
        const session = fakeTaskSession(host, tasks, async () => ({ cancelled: false }));
        assert.equal(await cancelTasks(session, { pauseMs: 0 }), count);
        assert.deepEqual(pids(host), [100, 200, 201, 202, 210, 1000], "every shell and daemon ended; nothing else did");
        return host.snapshots;
    };
    assert.equal(await reads(12), await reads(1));
});

test("a task's pid counts only while it runs the process the task started; a zombie does not run", () => {
    const host = cliLayout();
    assert.equal(taskProcessAlive(201, T, host), true);
    assert.equal(taskProcessAlive(201, T - 60_000, host), false, "the task is a minute older than the process: the pid was reused");
    assert.equal(taskProcessAlive(201, undefined, host), true, "without a start time, a live pid counts");
    host.table.get(201).zombie = true;
    assert.equal(taskProcessAlive(201, T, host), false);
    assert.equal(taskProcessAlive(1000, T, host), false, "never this process");
});

const linuxOnly = process.platform !== "linux" && "shell sessions are read from Linux /proc";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True while the process runs: it exists and is not a zombie (a killed orphan waits as one until it is reaped). */
function running(pid) {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]);
    } catch {
        return false;
    }
}

async function until(predicate, what, ms = 5_000) {
    const deadline = Date.now() + ms;
    while (!predicate()) {
        if (Date.now() > deadline) assert.fail(`timed out waiting until ${what}`);
        await pause(20);
    }
}

test("a process's start time is read from the host, to within a couple of seconds", { skip: process.platform === "win32" && "process start times use Linux /proc" }, async (t) => {
    const before = Date.now();
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    t.after(() => { try { process.kill(child.pid, "SIGKILL"); } catch {} });
    await pause(100);
    const started = processStartTimeMs(child.pid);
    assert.equal(typeof started, "number");
    assert.ok(Math.abs(started - before) < 2_500, `${started - before} ms off`);
});

test("a task's pid counts only while it runs the process the task started (review R4)", { skip: process.platform === "win32" && "process start times use Linux /proc" }, async (t) => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    t.after(() => { try { process.kill(child.pid, "SIGKILL"); } catch {} });
    await pause(100);
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
    assert.equal(shellProcessScope(cli.pid, startedAt), undefined, "the CLI shares this process's session");

    assert.equal(killShellProcessScope(scope), true);
    await until(() => sessionMembers(sid).length === 0, "nothing of the shell's session runs");
    assert.equal(running(cli.pid), true, "the CLI is not touched");
    assert.equal(killShellProcessScope(scope), false, "a scope with nothing left running is not signalled");
});

test("a session or group that this process, or a child of it, leads is never a shell's scope", { skip: linuxOnly }, async (t) => {
    const ownSession = spawn("sleep", ["30"], { stdio: "ignore" });
    const leader = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
    t.after(() => {
        for (const child of [ownSession, leader]) { try { process.kill(child.pid, "SIGKILL"); } catch {} }
    });
    await pause(100);
    const startedAt = new Date().toISOString();
    assert.equal(processIds(leader.pid).sid, leader.pid);
    assert.ok(bindShellProcess(leader.pid, startedAt).identity, "the start check passes, so the guard decides");
    assert.equal(shellProcessScope(ownSession.pid, startedAt), undefined, "this process's own session");
    assert.equal(shellProcessScope(leader.pid, startedAt), undefined, "a session led by a direct child, as the CLI could be");
    assert.equal(shellProcessScope(process.pid, startedAt), undefined);
    assert.equal(shellProcessScope(1, startedAt), undefined);
    assert.equal(killShellProcessScope({ kind: "session", id: process.pid }), false);
    assert.equal(killShellProcessScope({ kind: "group", id: 1 }), false);
});

test("a scope whose id went to a new leader is not killed", { skip: linuxOnly }, async (t) => {
    const leader = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
    t.after(() => { try { process.kill(leader.pid, "SIGKILL"); } catch {} });
    await pause(100);
    const start = readProcess(leader.pid).start;
    assert.equal(killShellProcessScope({ kind: "session", id: leader.pid, leader: { pid: leader.pid, start: start - 1 } }), false);
    assert.equal(running(leader.pid), true, "the new leader lives");
    assert.equal(killShellProcessScope({ kind: "session", id: leader.pid, leader: { pid: leader.pid, start } }), true,
        "the leader as recorded is killed");
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
    assert.equal(await cancelTasks(fake, { pauseMs: 100 }), 1);
    assert.equal(calls.filter((call) => call === "cancel:0").length, 1);
    await until(() => !running(daemon) && sessionMembers(sid).length === 0, "the daemon and the rest of the shell's session are gone");
});
