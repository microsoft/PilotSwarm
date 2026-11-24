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
 * stays in it, so shellProcessScope and killShellProcessScopes stop it by its
 * session.
 *
 * The CLI runs on this host, so its pids are ours. These helpers read the
 * process table once per pass (/proc on Linux, one `ps -A` elsewhere) and
 * signal a numeric pid only while it still runs the process that was bound:
 * the same pid and the same start time, exactly as recorded, checked
 * synchronously right before the signal together with the caller's deadline.
 * When the start time cannot be read, nothing is signalled. A killed process
 * is reaped by its parent, or by the init process once it is re-parented; in
 * a container whose PID 1 does not reap, it stays a zombie that holds only
 * its pid. On Windows these helpers signal nothing.
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

/** One process as the host lists it. */
export interface ProcessInfo {
    pid: number;
    ppid: number;
    pgid: number;
    /** Linux only: `ps` elsewhere gives no session id. */
    sid?: number;
    /** Ended and not yet reaped: it holds its pid but runs nothing. */
    zombie: boolean;
    /**
     * When it started, in the host's own unit: clock ticks after boot on Linux (exact), epoch milliseconds to the
     * second elsewhere. NaN when unreadable. Compare it only with a start read on the same host.
     */
    start: number;
}

/** A process bound by its pid and start time; a pid whose start differs now runs another process. */
export interface ProcessIdentity {
    pid: number;
    start: number;
}

export type ProcessSnapshot = ReadonlyMap<number, ProcessInfo>;

/** The host's process table and signals. Injectable for tests; defaultProcessHost() is the real one. */
export interface ProcessHost {
    platform: NodeJS.Platform;
    selfPid: number;
    /** True when read() is cheap and current (/proc): each signal re-reads its target first. Otherwise the pass's snapshot stands for it. */
    freshReads: boolean;
    /** Every process, or undefined when the host cannot list them (always on Windows). */
    snapshot(): Map<number, ProcessInfo> | undefined;
    read(pid: number): ProcessInfo | undefined;
    exists(pid: number): boolean;
    /** A start (ProcessInfo.start) in epoch milliseconds, or undefined when the host cannot tell. */
    startEpochMs(info: ProcessInfo): number | undefined;
    kill(target: number, signal: NodeJS.Signals | 0): void;
    now(): number;
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

let linuxBootSeconds: number | undefined;
function linuxBootTime(): number | undefined {
    if (linuxBootSeconds === undefined) {
        try {
            const seconds = Number(/^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"))?.[1]);
            if (Number.isFinite(seconds) && seconds > 0) linuxBootSeconds = seconds;
        } catch { /* unknown */ }
    }
    return linuxBootSeconds;
}

/** /proc/<pid>/stat: "pid (comm) state ppid pgrp session ... starttime"; comm may hold spaces and parens. */
function parseLinuxStat(pid: number, stat: string): ProcessInfo | undefined {
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const [ppid, pgid, sid, start] = [Number(fields[1]), Number(fields[2]), Number(fields[3]), Number(fields[19])];
    if (!Number.isInteger(ppid) || !Number.isInteger(pgid) || !Number.isInteger(sid)) return undefined;
    return { pid, ppid, pgid, sid, zombie: fields[0] === "Z" || fields[0] === "X", start: Number.isFinite(start) ? start : Number.NaN };
}

function readLinuxProcess(pid: number): ProcessInfo | undefined {
    try {
        return parseLinuxStat(pid, fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
        return undefined;
    }
}

const PS_FIELDS = "pid=,ppid=,pgid=,stat=,lstart=";

/** One `ps -o pid=,ppid=,pgid=,stat=,lstart=` line; lstart ("Tue Nov 24 21:41:58 2026") holds spaces. */
function parsePsLine(line: string): ProcessInfo | undefined {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) return undefined;
    const [pid, ppid, pgid] = parts.slice(0, 3).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) return undefined;
    const start = Date.parse(parts.slice(4).join(" "));
    return { pid, ppid, pgid, zombie: parts[3].startsWith("Z"), start: Number.isFinite(start) ? start : Number.NaN };
}

function runPs(args: string[]): string | undefined {
    try {
        return execFileSync("ps", args, { encoding: "utf8", timeout: 5_000, env: { ...process.env, LC_ALL: "C" } });
    } catch {
        return undefined;
    }
}

const signalOf = (target: number, signal: NodeJS.Signals | 0) => { process.kill(target, signal); };

const linuxHost: ProcessHost = {
    platform: "linux",
    get selfPid() { return process.pid; },
    freshReads: true,
    snapshot() {
        let entries: string[];
        try {
            entries = fs.readdirSync("/proc");
        } catch {
            return undefined;
        }
        const table = new Map<number, ProcessInfo>();
        for (const entry of entries) {
            if (!/^\d+$/.test(entry)) continue;
            const info = readLinuxProcess(Number(entry));
            if (info) table.set(info.pid, info);
        }
        return table;
    },
    read: readLinuxProcess,
    exists: processAlive,
    startEpochMs(info) {
        const boot = linuxBootTime();
        if (boot === undefined || !Number.isFinite(info.start)) return undefined;
        return boot * 1000 + Math.round((info.start / linuxClockTicks()) * 1000);
    },
    kill: signalOf,
    now: () => Date.now(),
};

const psHost: ProcessHost = {
    platform: process.platform,
    get selfPid() { return process.pid; },
    freshReads: false,
    snapshot() {
        const out = runPs(["-A", "-o", PS_FIELDS]);
        if (out === undefined) return undefined;
        const table = new Map<number, ProcessInfo>();
        for (const line of out.split("\n")) {
            const info = parsePsLine(line);
            if (info) table.set(info.pid, info);
        }
        return table;
    },
    read(pid) {
        const out = runPs(["-o", PS_FIELDS, "-p", String(pid)]);
        return out === undefined ? undefined : parsePsLine(out);
    },
    exists: processAlive,
    startEpochMs: (info) => (Number.isFinite(info.start) ? info.start : undefined),
    kill: signalOf,
    now: () => Date.now(),
};

const windowsHost: ProcessHost = {
    platform: "win32",
    get selfPid() { return process.pid; },
    freshReads: false,
    snapshot: () => undefined,
    read: () => undefined,
    exists: processAlive,
    startEpochMs: () => undefined,
    kill: signalOf,
    now: () => Date.now(),
};

/** The real process table of this host: /proc on Linux, `ps` on other POSIX hosts, none on Windows. */
export function defaultProcessHost(): ProcessHost {
    if (process.platform === "win32") return windowsHost;
    return fs.existsSync("/proc/self/stat") ? linuxHost : psHost;
}

/** One process as the host lists it now, or undefined when it is gone or the host cannot tell (always on Windows). */
export function readProcess(pid: number, host: ProcessHost = defaultProcessHost()): ProcessInfo | undefined {
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    return host.read(pid);
}

/**
 * When a process started, in epoch milliseconds, or undefined when this host
 * cannot tell. Linux: field 22 of /proc/<pid>/stat (clock ticks after boot)
 * plus the boot time from /proc/stat. Elsewhere: `ps -o lstart=`, to the
 * second.
 */
export function processStartTimeMs(pid: number): number | undefined {
    const host = defaultProcessHost();
    const info = readProcess(pid, host);
    return info ? host.startEpochMs(info) : undefined;
}

/**
 * A process's parent, process group and, on Linux, session. Undefined when it is gone or this host cannot tell
 * (always on Windows). Elsewhere `ps` gives no session id, so only the group is known.
 */
export function processIds(pid: number): { ppid: number; pgid: number; sid?: number } | undefined {
    const info = readProcess(pid);
    if (!info) return undefined;
    return info.sid === undefined ? { ppid: info.ppid, pgid: info.pgid } : { ppid: info.ppid, pgid: info.pgid, sid: info.sid };
}

/** How much later than its task a process may seem to start: the boot time and `ps` are in whole seconds. */
const START_TIME_SLACK_MS = 2_000;

function taskStartMs(startedAt: unknown): number {
    return typeof startedAt === "string" ? Date.parse(startedAt)
        : typeof startedAt === "number" ? startedAt : Number.NaN;
}

const signallable = (host: ProcessHost, pid: unknown): pid is number => host.platform !== "win32"
    && typeof pid === "number" && Number.isInteger(pid) && pid > 1 && pid !== host.selfPid;

/**
 * True while `pid` still runs the process a task started at `startedAt`.
 * CLI 1.0.83 keeps a detached shell's pid after the shell ends, and the host
 * may give that pid to another process later. A process that started after
 * the task is that other process. When either start time is unknown, a live
 * pid counts: this answers whether a task still runs (the busy check), and
 * never decides a signal; the kills bind the process by its exact start.
 * A zombie (ended, not yet reaped) does not run.
 */
export function taskProcessAlive(pid: unknown, startedAt?: unknown, host: ProcessHost = defaultProcessHost()): boolean {
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || pid === host.selfPid) return false;
    if (!host.exists(pid)) return false;
    const taskStart = taskStartMs(startedAt);
    // /proc reads are cheap; `ps` runs only when a start time is to be compared.
    const info = host.freshReads || Number.isFinite(taskStart) ? host.read(pid) : undefined;
    if (info?.zombie) return false;
    if (!Number.isFinite(taskStart) || !info) return true;
    const processStart = host.startEpochMs(info);
    if (processStart === undefined) return true;
    return processStart <= taskStart + START_TIME_SLACK_MS;
}

/** True when `info` is the process its task started: it started no later than the task. False when either start is unknown. */
function startedByTask(host: ProcessHost, info: ProcessInfo, startedAt: unknown): boolean {
    const taskStart = taskStartMs(startedAt);
    if (!Number.isFinite(taskStart)) return false;
    const processStart = host.startEpochMs(info);
    return processStart !== undefined && processStart <= taskStart + START_TIME_SLACK_MS;
}

/**
 * SIGKILL `pid` only if it still runs the process recorded as `start` (and `belongs` to the caller's scope), and only
 * before `deadline`. Everything between the check and the signal is synchronous, so a caller that gave up (its deadline
 * passed) never signals, and a pid cannot change hands between the check and the kill except by an exit in that instant.
 */
function signalProcess(
    host: ProcessHost, pid: number, start: number, deadline: number, snapshot: ProcessSnapshot | undefined,
    belongs?: (info: ProcessInfo) => boolean,
): boolean {
    if (!signallable(host, pid) || !Number.isFinite(start)) return false;
    const info = host.freshReads ? host.read(pid) : snapshot?.get(pid);
    if (!info || info.zombie || info.start !== start || (belongs && !belongs(info))) return false;
    if (!(host.now() < deadline)) return false;
    try {
        host.kill(pid, "SIGKILL");
        return true;
    } catch {
        return false;
    }
}

export interface KillOptions {
    /** Absolute time (ms, host.now()) after which nothing is signalled. */
    deadline?: number;
    host?: ProcessHost;
}

/**
 * SIGKILL a process and every process below it. Returns true if any process
 * was killed. Never kills this process or pid 1. The root dies first, so a
 * loop cannot start new children; the listed children are then killed by
 * pid even after they are re-parented, each only while it still runs the
 * process listed. With `identity`, the root must still be that process
 * (same pid and start); without one, the process now holding the pid is
 * taken (a caller's own child, whose pid cannot be reused before it is
 * reaped). Signals nothing on Windows.
 */
export function killProcessTree(pid: unknown, opts: KillOptions & { identity?: ProcessIdentity; snapshot?: ProcessSnapshot } = {}): boolean {
    const host = opts.host ?? defaultProcessHost();
    if (!signallable(host, pid)) return false;
    const snapshot = opts.snapshot ?? host.snapshot();
    const root = snapshot?.get(pid);
    if (!snapshot || !root || root.zombie) return false;
    if (opts.identity && (opts.identity.pid !== pid || opts.identity.start !== root.start)) return false;
    const children = new Map<number, ProcessInfo[]>();
    for (const info of snapshot.values()) {
        const list = children.get(info.ppid);
        if (list) list.push(info);
        else children.set(info.ppid, [info]);
    }
    const tree: ProcessInfo[] = [];
    const seen = new Set<number>();
    const walk = (current: ProcessInfo) => {
        if (seen.has(current.pid) || current.pid === host.selfPid || current.pid <= 1) return;
        seen.add(current.pid);
        tree.push(current);
        for (const child of children.get(current.pid) ?? []) walk(child);
    };
    walk(root);
    const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
    let killed = false;
    for (const target of tree) {
        if (signalProcess(host, target.pid, target.start, deadline, snapshot)) killed = true;
    }
    return killed;
}

/** The session (Linux) or process group (elsewhere) a background shell runs in; see shellProcessScope. */
export interface ShellProcessScope {
    kind: "session" | "group";
    id: number;
    /** The leader when the scope was taken, so a later kill can tell that its id was not reused. Without it, nothing is killed. */
    leader?: ProcessIdentity;
}

/**
 * The session (Linux) or process group (elsewhere) of a running background shell, when that scope is the shell's
 * own: its leader is the shell or one of its ancestors, with at least one process (the CLI) between the leader and
 * this process. That keeps out this process's own session and group, the CLI's, anything above them, and a shell
 * whose CLI this process did not start. This process may be PID 1 (a container's only process). Undefined otherwise,
 * when either start time is unknown, and on Windows.
 */
export function shellProcessScope(pid: unknown, startedAt?: unknown, opts: { host?: ProcessHost; snapshot?: ProcessSnapshot } = {}): ShellProcessScope | undefined {
    const host = opts.host ?? defaultProcessHost();
    if (!signallable(host, pid)) return undefined;
    const snapshot = opts.snapshot ?? host.snapshot();
    const shell = snapshot?.get(pid);
    if (!snapshot || !shell || shell.zombie || !startedByTask(host, shell, startedAt)) return undefined;
    const kind = shell.sid !== undefined ? "session" : "group";
    const id = shell.sid ?? shell.pgid;
    const own = snapshot.get(host.selfPid);
    if (!own || id <= 1 || id === host.selfPid || id === own.pgid || id === own.sid) return undefined;
    const chain: number[] = [];
    let current = pid;
    for (let depth = 0; depth < 64; depth++) {
        chain.push(current);
        if (current === host.selfPid || current <= 1) break;
        const info = snapshot.get(current);
        if (!info) return undefined;
        current = info.ppid;
    }
    const leaderAt = chain.indexOf(id);
    const selfAt = chain.indexOf(host.selfPid);
    if (leaderAt < 0 || selfAt < leaderAt + 2) return undefined;
    const leader = snapshot.get(id);
    if (!leader || leader.zombie || !Number.isFinite(leader.start)) return undefined;
    return { kind, id, leader: { pid: id, start: leader.start } };
}

/**
 * Bind a running background shell: its identity (pid and exact start), for a later kill of its tree, and its own
 * scope (shellProcessScope). Empty when the pid does not run a process its task started, when that cannot be told,
 * and on Windows.
 */
export function bindShellProcess(pid: unknown, startedAt: unknown, opts: { host?: ProcessHost; snapshot?: ProcessSnapshot } = {}): { identity?: ProcessIdentity; scope?: ShellProcessScope } {
    const host = opts.host ?? defaultProcessHost();
    if (!signallable(host, pid)) return {};
    const snapshot = opts.snapshot ?? host.snapshot();
    const info = snapshot?.get(pid);
    if (!info || info.zombie || !Number.isFinite(info.start) || !startedByTask(host, info, startedAt)) return {};
    return { identity: { pid, start: info.start }, scope: shellProcessScope(pid, startedAt, { host, snapshot }) };
}

/**
 * SIGKILL what is left of each shell's scope (shellProcessScope): its process group, then on Linux every other
 * process of its session, which reaches descendants that moved to a group of their own. An id stays taken while any
 * process of its group or session lives, so a remaining member belongs to the scope that was taken. The one reuse to
 * rule out is a scope that emptied and a new leader that took its id; then nothing is killed, as for a scope without
 * a recorded leader. One process-table read per pass serves every scope. Returns, per scope, whether any process
 * was signalled.
 */
export function killShellProcessScopes(scopes: ReadonlyArray<ShellProcessScope | undefined>, opts: KillOptions = {}): boolean[] {
    const host = opts.host ?? defaultProcessHost();
    const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
    const results = scopes.map(() => false);
    if (host.platform === "win32") return results;
    const valid = (scope: ShellProcessScope | undefined): scope is ShellProcessScope & { leader: ProcessIdentity } => !!scope
        && signallable(host, scope.id) && !!scope.leader && scope.leader.pid === scope.id && Number.isFinite(scope.leader.start);
    // The leader now: the recorded one (same start), or gone. A pid that is listed under another start, or that
    // exists but cannot be read, is another process: skip.
    const leaderHolds = (scope: ShellProcessScope & { leader: ProcessIdentity }, table: ProcessSnapshot | undefined) => {
        const leader = host.freshReads ? host.read(scope.id) : table?.get(scope.id);
        if (leader) return leader.start === scope.leader.start;
        return !host.exists(scope.id);
    };
    // One read serves the group kills and the first session pass. A group is signalled only while it has a live
    // member, so a scope whose processes all ended (or wait as zombies) counts as not signalled.
    let table = host.snapshot();
    if (!table) return results;
    const liveGroups = new Set<number>();
    for (const info of table.values()) if (!info.zombie) liveGroups.add(info.pgid);
    for (let i = 0; i < scopes.length; i++) {
        const scope = scopes[i];
        if (!valid(scope) || !liveGroups.has(scope.id) || !leaderHolds(scope, table)) continue;
        if (!(host.now() < deadline)) break;
        try {
            host.kill(-scope.id, "SIGKILL");
            results[i] = true;
        } catch { /* no such group */ }
    }
    const sessions = scopes.flatMap((scope, i) => (valid(scope) && scope.kind === "session" ? [{ scope, i }] : []));
    // A member may fork while it is listed; its child joins the session, so list again.
    for (let pass = 0; pass < 3 && sessions.length > 0; pass++) {
        // Without fresh reads, a member a group kill just ended would still be listed as running.
        if (pass > 0 || (!host.freshReads && results.some(Boolean))) table = host.snapshot();
        if (!table) break;
        const bySession = new Map<number, ProcessInfo[]>();
        for (const info of table.values()) {
            if (info.sid === undefined || info.zombie || !signallable(host, info.pid)) continue;
            const list = bySession.get(info.sid);
            if (list) list.push(info);
            else bySession.set(info.sid, [info]);
        }
        let signalled = false;
        for (const { scope, i } of sessions) {
            const members = bySession.get(scope.id);
            if (!members || !leaderHolds(scope, table)) continue;
            for (const member of members) {
                if (signalProcess(host, member.pid, member.start, deadline, table, (info) => info.sid === scope.id)) {
                    results[i] = true;
                    signalled = true;
                }
            }
        }
        if (!signalled) break;
    }
    return results;
}

/** killShellProcessScopes for one scope. */
export function killShellProcessScope(scope: ShellProcessScope | undefined, opts: KillOptions = {}): boolean {
    return killShellProcessScopes([scope], opts)[0];
}

/** A running background shell read from the CLI's task list without stopping it, bound at the same time (bindShellProcess). */
export interface ListedShell {
    pid: number;
    startedAt?: unknown;
    identity?: ProcessIdentity;
    scope?: ShellProcessScope;
}

/**
 * SIGKILL shells listed before their runtime stopped: each shell and the processes below it while its pid still runs
 * the bound process, then what is left of its scope. The scope must be read before the stop, while the CLI still sits
 * between this process and the shell (shellProcessScope). Returns how many shells had a process left to kill.
 */
export function killListedShells(shells: ReadonlyArray<ListedShell>, opts: KillOptions = {}): number {
    const host = opts.host ?? defaultProcessHost();
    if (host.platform === "win32" || shells.length === 0) return 0;
    const snapshot = shells.some((shell) => shell.identity) ? host.snapshot() : undefined;
    const trees = shells.map((shell) => !!shell.identity
        && killProcessTree(shell.pid, { identity: shell.identity, deadline: opts.deadline, host, snapshot }));
    const scopes = killShellProcessScopes(shells.map((shell) => shell.scope), { deadline: opts.deadline, host });
    return shells.filter((_, i) => trees[i] || scopes[i]).length;
}
