/**
 * Process helpers for stopping background shells the Copilot CLI will not
 * cancel (session workspaces, docs/proposals/session-workspaces.md 4.5).
 *
 * Verified on CLI 1.0.83:
 *   - after session.abort(), rpc.tasks.cancel answers { cancelled: false }
 *     for a detached shell, and the shell keeps running
 *   - the pid the CLI reports for a detached shell is not a process-group
 *     leader, so a group kill misses its children
 *   - after the process dies, the CLI still lists the task as running
 *
 *   - after a detached shell ends by itself, the CLI still lists it as
 *     running with its pid, which the host may give to another process
 *
 * Verified on SDK 1.0.34 (Linux): the reported pid's parent is a wrapper
 * that leads a new session and process group, below the CLI process.
 * Neither CopilotClient.stop() nor the CLI's exit ends that session, and a
 * descendant that leaves the shell's tree (a daemon re-parented to init)
 * stays in it, so shellProcessScope and killShellProcessScope stop it by its
 * session.
 *
 * The CLI runs on this host, so its pids are ours. These helpers walk the
 * process tree below a pid: /proc on Linux, `ps` elsewhere.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * Kill every process of a process group (Workflow Simplified stage 2.4, PR 235 6e2a1fec: a script leads its own group, so
 * a process it started that left the tree, a daemon reparented to init, is still found). False when the group is gone or
 * cannot be signalled. POSIX only; false on Windows.
 */
export function killProcessGroup(pgid: unknown): boolean {
    if (process.platform === "win32" || typeof pgid !== "number" || !Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) return false;
    try {
        process.kill(-pgid, "SIGKILL");
        return true;
    } catch {
        return false;
    }
}

/** True while the process exists (EPERM: it exists, under another user). */
export function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: any) {
        return error?.code === "EPERM";
    }
}

let clockTicksPerSecond: number | undefined;
function linuxClockTicks(): number {
    if (clockTicksPerSecond === undefined) {
        try {
            clockTicksPerSecond = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8", timeout: 2_000 }).trim()) || 100;
        } catch {
            clockTicksPerSecond = 100;
        }
    }
    return clockTicksPerSecond;
}

/**
 * When a process started, in epoch milliseconds, or undefined when this host
 * cannot tell. Linux: field 22 of /proc/<pid>/stat (clock ticks after boot)
 * plus the boot time from /proc/stat. Elsewhere: `ps -o lstart=`, to the
 * second.
 */
export function processStartTimeMs(pid: number): number | undefined {
    if (fs.existsSync("/proc/self/stat")) {
        try {
            const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
            // Fields after "(comm) " start at field 3, so field 22 is [19].
            const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
            const bootSeconds = Number(/^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"))?.[1]);
            if (!Number.isFinite(ticks) || !Number.isFinite(bootSeconds) || bootSeconds <= 0) return undefined;
            return bootSeconds * 1000 + Math.round((ticks / linuxClockTicks()) * 1000);
        } catch {
            return undefined;
        }
    }
    try {
        const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
            encoding: "utf8", timeout: 5_000, env: { ...process.env, LC_ALL: "C" },
        }).trim();
        const ms = Date.parse(out);
        return Number.isFinite(ms) ? ms : undefined;
    } catch {
        return undefined;
    }
}

/** How much later than its task a process may seem to start: the boot time and `ps` are in whole seconds. */
const START_TIME_SLACK_MS = 2_000;

/**
 * True while `pid` still runs the process a task started at `startedAt`.
 * CLI 1.0.83 keeps a detached shell's pid after the shell ends, and the host
 * may give that pid to another process later. A process that started after
 * the task is that other process, and must never be killed. When either
 * start time is unknown, a live pid counts.
 */
export function taskProcessAlive(pid: unknown, startedAt?: unknown): boolean {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
    if (!processAlive(pid)) return false;
    const taskStart = typeof startedAt === "string" ? Date.parse(startedAt)
        : typeof startedAt === "number" ? startedAt : Number.NaN;
    if (!Number.isFinite(taskStart)) return true;
    const processStart = processStartTimeMs(pid);
    if (processStart === undefined) return true;
    return processStart <= taskStart + START_TIME_SLACK_MS;
}

/** Parent pid to child pids, for every process this host lists. */
function childrenByParent(): Map<number, number[]> {
    const children = new Map<number, number[]>();
    const add = (pid: number, ppid: number) => {
        if (!Number.isInteger(pid) || !Number.isInteger(ppid)) return;
        const list = children.get(ppid);
        if (list) list.push(pid);
        else children.set(ppid, [pid]);
    };
    if (fs.existsSync("/proc/self/stat")) {
        for (const entry of fs.readdirSync("/proc")) {
            if (!/^\d+$/.test(entry)) continue;
            try {
                // "pid (comm) state ppid ..."; comm may hold spaces and parens.
                const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8");
                const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
                add(Number(entry), Number(fields[1]));
            } catch { /* the process ended while we read */ }
        }
        return children;
    }
    try {
        const out = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8", timeout: 5_000 });
        for (const line of out.split("\n")) {
            const [pid, ppid] = line.trim().split(/\s+/).map(Number);
            add(pid, ppid);
        }
    } catch { /* no ps: only the pid itself is killed */ }
    return children;
}

const hasProc = () => fs.existsSync("/proc/self/stat");

/** "state ppid pgrp session ...", the /proc/<pid>/stat fields after "(comm) "; comm may hold spaces and parens. */
function linuxStatFields(pid: number | string): string[] | undefined {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    } catch {
        return undefined;
    }
}

/**
 * A process's parent, process group and, on Linux, session. Undefined when it is gone or this host cannot tell
 * (always on Windows). Elsewhere `ps` gives no session id, so only the group is known.
 */
export function processIds(pid: number): { ppid: number; pgid: number; sid?: number } | undefined {
    if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0) return undefined;
    if (hasProc()) {
        const fields = linuxStatFields(pid);
        if (!fields) return undefined;
        const [ppid, pgid, sid] = [Number(fields[1]), Number(fields[2]), Number(fields[3])];
        return Number.isInteger(ppid) && Number.isInteger(pgid) && Number.isInteger(sid) ? { ppid, pgid, sid } : undefined;
    }
    try {
        const out = execFileSync("ps", ["-o", "ppid=,pgid=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 }).trim();
        const [ppid, pgid] = out.split(/\s+/).map(Number);
        return Number.isInteger(ppid) && Number.isInteger(pgid) ? { ppid, pgid } : undefined;
    } catch {
        return undefined;
    }
}

/** The session (Linux) or process group (elsewhere) a background shell runs in; see shellProcessScope. */
export interface ShellProcessScope {
    kind: "session" | "group";
    id: number;
    /** The leader's start time when the scope was taken, so a later kill can tell that its id was not reused. */
    leaderStartMs?: number;
}

/**
 * The session (Linux) or process group (elsewhere) of a running background shell, when that scope is the shell's
 * own: its leader is the shell or one of its ancestors, with at least one process (the CLI) between the leader and
 * this process. That keeps out this process's own session and group, the CLI's, anything above them, and a shell
 * whose CLI this process did not start. Undefined otherwise, and on Windows.
 */
export function shellProcessScope(pid: unknown, startedAt?: unknown): ShellProcessScope | undefined {
    if (!taskProcessAlive(pid, startedAt)) return undefined;
    const shell = processIds(pid as number);
    if (!shell) return undefined;
    const kind = shell.sid !== undefined ? "session" : "group";
    const id = shell.sid ?? shell.pgid;
    const own = processIds(process.pid);
    if (!own || id <= 1 || id === process.pid || id === own.pgid || id === own.sid) return undefined;
    const chain: number[] = [];
    let current = pid as number;
    let parent: number | undefined = shell.ppid;
    for (let depth = 0; depth < 64 && current > 1; depth++) {
        chain.push(current);
        if (current === process.pid) break;
        if (parent === undefined) return undefined;
        current = parent;
        parent = processIds(current)?.ppid;
    }
    const leaderAt = chain.indexOf(id);
    const selfAt = chain.indexOf(process.pid);
    if (leaderAt < 0 || selfAt < leaderAt + 2) return undefined;
    return { kind, id, leaderStartMs: processStartTimeMs(id) };
}

/** Live (not zombie) processes of a Linux session, other than this process and pid 1. */
function linuxSessionMembers(sid: number): number[] {
    const members: number[] = [];
    for (const entry of fs.readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        const pid = Number(entry);
        if (pid <= 1 || pid === process.pid) continue;
        const fields = linuxStatFields(entry);
        if (fields && fields[0] !== "Z" && Number(fields[3]) === sid) members.push(pid);
    }
    return members;
}

/**
 * SIGKILL what is left of a shell's scope (shellProcessScope): its process group, then on Linux every other process
 * of its session, which reaches descendants that moved to a group of their own. An id stays taken while any process
 * of its group or session lives, so a remaining member always belongs to the scope that was taken. The one reuse to
 * rule out is a scope that emptied and a new leader that took its id; then nothing is killed. Returns true if any
 * process was signalled.
 */
export function killShellProcessScope(scope: ShellProcessScope | undefined): boolean {
    if (!scope || process.platform === "win32" || !Number.isInteger(scope.id) || scope.id <= 1 || scope.id === process.pid) return false;
    if (scope.leaderStartMs !== undefined && processAlive(scope.id)) {
        const leaderStartMs = processStartTimeMs(scope.id);
        if (leaderStartMs !== undefined && leaderStartMs !== scope.leaderStartMs) return false;
    }
    let killed = false;
    try {
        process.kill(-scope.id, "SIGKILL");
        killed = true;
    } catch { /* no such group */ }
    if (scope.kind !== "session" || !hasProc()) return killed;
    // A member may fork while it is listed; its child joins the session, so list again.
    for (let pass = 0; pass < 3; pass++) {
        const members = linuxSessionMembers(scope.id);
        if (members.length === 0) break;
        for (const member of members) {
            try {
                process.kill(member, "SIGKILL");
                killed = true;
            } catch { /* already gone */ }
        }
    }
    return killed;
}

/** A running background shell read from the CLI's task list without stopping it; its scope is read at the same time. */
export interface ListedShell {
    pid: number;
    startedAt?: unknown;
    scope?: ShellProcessScope;
}

/**
 * SIGKILL shells listed before their runtime stopped: each shell and the processes below it while its pid still runs
 * the listed process, then what is left of its scope. The scope must be read before the stop, while the CLI still sits
 * between this process and the shell (shellProcessScope). Returns how many shells had a process left to kill.
 */
export function killListedShells(shells: ReadonlyArray<ListedShell>): number {
    let killed = 0;
    for (const shell of shells) {
        const tree = taskProcessAlive(shell.pid, shell.startedAt) && killProcessTree(shell.pid);
        const scope = killShellProcessScope(shell.scope);
        if (tree || scope) killed++;
    }
    return killed;
}

/**
 * SIGKILL a process and every process below it. Returns true if any process
 * was killed. Never kills this process or pid 1. The root dies first, so a
 * loop cannot start new children; the listed children are then killed by
 * pid even after they are re-parented.
 */
export function killProcessTree(pid: unknown): boolean {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
    if (!processAlive(pid)) return false;
    const children = childrenByParent();
    const tree: number[] = [];
    const seen = new Set<number>();
    const walk = (current: number) => {
        if (seen.has(current) || current === process.pid || current <= 1) return;
        seen.add(current);
        tree.push(current);
        for (const child of children.get(current) ?? []) walk(child);
    };
    walk(pid);
    let killed = false;
    for (const target of tree) {
        try {
            process.kill(target, "SIGKILL");
            killed = true;
        } catch { /* already gone */ }
    }
    return killed;
}
