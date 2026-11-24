/**
 * An in-memory process table for process-tree.ts (its ProcessHost), so the
 * kill rules run the same on every platform. Starts are epoch milliseconds,
 * as `ps` gives them. A SIGKILL removes the process; `-pgid` removes its
 * whole group, as the kernel does.
 */
export function fakeProcessHost({ platform = "linux", selfPid = 1000, freshReads = true, processes = [], now } = {}) {
    const table = new Map();
    const kills = [];
    let clock = 0;
    const add = (entry) => {
        const pgid = entry.pgid ?? entry.pid;
        table.set(entry.pid, {
            ppid: 1, pgid, zombie: false, start: 0, ...entry,
            sid: platform === "linux" ? (entry.sid ?? pgid) : undefined,
        });
    };
    for (const entry of processes) add(entry);
    const copy = (info) => (info ? { ...info } : undefined);
    const host = {
        platform,
        selfPid,
        freshReads,
        snapshots: 0,
        snapshot() {
            host.snapshots++;
            return new Map([...table].map(([pid, info]) => [pid, { ...info }]));
        },
        read: (pid) => copy(table.get(pid)),
        exists: (pid) => table.has(pid),
        startEpochMs: (info) => (Number.isFinite(info.start) ? info.start : undefined),
        kill(target, signal) {
            const victims = target < 0
                ? [...table.values()].filter((info) => info.pgid === -target)
                : [table.get(target)].filter(Boolean);
            if (victims.length === 0) throw Object.assign(new Error(`kill ESRCH ${target}`), { code: "ESRCH" });
            if (signal === 0) return;
            kills.push(target);
            for (const victim of victims) table.delete(victim.pid);
        },
        now: now ?? (() => clock),
        // Test controls.
        table,
        kills,
        add,
        remove: (pid) => table.delete(pid),
        setClock: (ms) => { clock = ms; },
    };
    return host;
}

/**
 * A session's background tasks as ManagedSession.cancelBackgroundTasks reads
 * them, on a fake process host. `cancel(task)` answers one cancel (default:
 * end the shell's process and confirm). A shell task is listed while its
 * process lives, as the CLI lists it while its pid runs.
 */
export function fakeTaskSession(host, tasks, cancel) {
    const calls = [];
    const listed = () => tasks.filter((task) => task.type !== "shell" || host.table.has(task.pid));
    return {
        calls,
        processHost: host,
        copilotSession: {
            rpc: {
                tasks: {
                    list: async () => {
                        calls.push("list");
                        return { tasks: listed().map((task) => ({ status: "running", ...task })) };
                    },
                    cancel: async ({ id }) => {
                        calls.push(`cancel:${id}`);
                        const task = tasks.find((candidate) => candidate.id === id);
                        if (cancel) return cancel(task);
                        host.remove(task.pid);
                        return { cancelled: true };
                    },
                },
            },
        },
    };
}
