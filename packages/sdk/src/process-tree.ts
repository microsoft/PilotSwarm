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
 * The CLI runs on this host, so its pids are ours. These helpers walk the
 * process tree below a pid: /proc on Linux, `ps` elsewhere.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

/** True while the process exists (EPERM: it exists, under another user). */
export function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: any) {
        return error?.code === "EPERM";
    }
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
