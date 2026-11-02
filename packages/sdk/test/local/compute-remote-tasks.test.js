/**
 * A session whose agent runtime runs somewhere the worker did not start it
 * never has its background tasks looked up or signalled on the worker
 * (docs/proposals/compute-providers.md, "Processes on a host").
 *
 * The numbers a remote runtime reports as process ids belong to another
 * machine. Checking them here hides a shell that is still running, and
 * signalling them here kills whatever unrelated process happens to hold the
 * same number. So:
 *
 *   a. a remote shell whose reported id is a live worker process is left
 *      alone, and the stop that could not be proved is recorded
 *   b. an ordinary session keeps the worker-side kill it has always had
 *   c. a remote shell whose reported id exists nowhere on the worker still
 *      counts as running, so a busy guard stays busy
 *   d. a host that will not say what is running leaves the session busy
 *      rather than letting a folder be taken away
 *
 * Run: npx vitest run test/local/compute-remote-tasks.test.js
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { ManagedSession } from "../../src/managed-session.ts";

const REMOTE = {
    targetName: "shared/test",
    hostId: "host-1",
    hostIncarnation: "inc-1",
    files: "none",
    sharesWorkerFiles: false,
};

const started = [];

afterEach(() => {
    for (const child of started.splice(0)) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
});

/** A real process on this machine that outlives the test unless something kills it. */
function startWorkerProcess() {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
    started.push(child);
    return child;
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === "EPERM";
    }
}

/** Wait until the process is gone, or give up. Killing is not instant on any platform. */
async function waitForExit(pid, timeoutMs = 10_000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        if (!alive(pid)) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !alive(pid);
}

/**
 * The smallest session handle these paths use: a task list, a cancel, and
 * nothing else. `cancel` answers false throughout, which is what CLI 1.0.83
 * does for a detached shell after an abort.
 */
function sessionWithTasks(tasks, { cancelled = false, listFails = null } = {}) {
    const cancels = [];
    return {
        cancels,
        session: {
            on: () => () => {},
            registerTools: () => {},
            rpc: {
                tasks: {
                    async list() {
                        if (listFails) throw new Error(listFails);
                        return { tasks };
                    },
                    async cancel({ id }) {
                        cancels.push(id);
                        return { cancelled };
                    },
                },
            },
        },
    };
}

describe("background tasks of a remote runtime", () => {
    it("never signals a worker process for a remote session's shell, and records the unproved stop", async () => {
        const child = startWorkerProcess();
        expect(alive(child.pid)).toBe(true);
        const { session, cancels } = sessionWithTasks([
            { id: "task-1", type: "shell", status: "running", pid: child.pid, startedAt: new Date().toISOString() },
        ]);
        const managed = new ManagedSession("remote-shell", session, { computeRuntime: REMOTE });

        await expect(managed.cancelBackgroundTasks({ rounds: 2, pauseMs: 1 })).rejects.toThrow(/still active/);

        // The one way a remote shell is stopped was used, and the worker's
        // own process table was not.
        expect(cancels).toContain("task-1");
        expect(alive(child.pid)).toBe(true);
        const failure = managed.getComputeStopFailure();
        expect(failure).toBeTruthy();
        expect(failure.tasks).toEqual(["task-1"]);
    });

    it("still kills the shell of an ordinary session", async () => {
        const child = startWorkerProcess();
        const { session } = sessionWithTasks([
            { id: "task-1", type: "shell", status: "running", pid: child.pid, startedAt: new Date().toISOString() },
        ]);
        const managed = new ManagedSession("local-shell", session, {});

        // The fake reports the task for as long as it is asked; an ordinary
        // session stops seeing it once the process it named is gone.
        await managed.cancelBackgroundTasks({ rounds: 5, pauseMs: 50 }).catch(() => {});
        expect(await waitForExit(child.pid)).toBe(true);
        expect(managed.getComputeStopFailure()).toBeNull();
    });

    it("counts a remote shell whose reported id exists nowhere on the worker as running", async () => {
        // A free number on this machine: a process that has just exited.
        const child = startWorkerProcess();
        const pid = child.pid;
        child.kill("SIGKILL");
        await waitForExit(pid);

        const { session } = sessionWithTasks([
            { id: "task-1", type: "shell", status: "running", pid, startedAt: new Date().toISOString() },
        ]);
        const remote = new ManagedSession("remote-gone-pid", session, { computeRuntime: REMOTE });
        const local = new ManagedSession("local-gone-pid", session, {});

        expect(await remote.activeBackgroundTasks()).toEqual([{ id: "task-1", type: "shell" }]);
        // An ordinary session reads the same list the way it always has.
        expect(await local.activeBackgroundTasks()).toEqual([]);
    });

    it("leaves a remote session busy when the host will not say what is running", async () => {
        const { session } = sessionWithTasks([], { listFails: "connection closed" });
        const remote = new ManagedSession("remote-silent-host", session, { computeRuntime: REMOTE });
        const local = new ManagedSession("local-silent-handle", session, {});

        await expect(remote.activeBackgroundTasks()).rejects.toThrow(/connection closed/);
        // The guard itself: unreadable is busy for a remote session, and
        // nothing at all for a session whose processes died with its handle.
        expect(await remote.busyBackgroundTasks()).toMatchObject({
            tasks: [],
            unknown: expect.stringContaining("connection closed"),
        });
        expect(await local.busyBackgroundTasks()).toEqual({ tasks: [] });
    });
});
