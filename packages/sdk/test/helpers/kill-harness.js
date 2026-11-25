/**
 * Literal fault-injection harness (session lifecycle protocol §4.4).
 *
 * Forks REAL PilotSwarmWorker processes (test/helpers/worker-process.js,
 * running built dist/ code) with `PILOTSWARM_FAULT_INJECT` armed so the
 * process dies via process.exit(137) at an exact protocol boundary, then
 * lets the REAL duroxide retry machinery re-dispatch the in-flight turn to
 * a fresh worker process. Nothing is simulated: the crash is a process
 * death, the recovery is duroxide's, the store is the shared filesystem
 * snapshot store.
 *
 * Store sharing geometry: each worker gets its own
 * `<base>/kill-<id>/session-state` dir — the basename MUST be
 * `session-state` because the Copilot CLI writes to
 * `$COPILOT_HOME/session-state/<id>` with COPILOT_HOME set to the dir's
 * parent — while all workers share ONE explicit snapshot store dir
 * (`<base>/kill-shared-store`, wired through worker-process.js as an
 * explicit FilesystemSessionStore). Separate "disks", one store, exactly
 * like separate pods sharing blob storage.
 *
 * Timing: work-item lock reclaim is tuned to 2s via
 * PILOTSWARM_WORKER_LOCK_TIMEOUT_MS, but duroxide's SESSION lock (~30s,
 * not exposed to Node) is the floor for re-dispatching session-pinned
 * work after a kill — each kill/recovery cycle costs ~30-40s.
 */
import { execFileSync, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKER_SCRIPT = resolve(__dirname, "worker-process.js");
const WORKSPACE_ROOT = resolve(__dirname, "../../../../");

const FAST_LOCK_MS = "2000";

/**
 * Fork one worker process. Returns handles for readiness, exit, logs, kill.
 *
 * @param {object} env       createTestEnv() suite env
 * @param {string} id        worker id suffix (also the workerNodeId)
 * @param {object} [opts]
 * @param {string} [opts.faultInject]  PILOTSWARM_FAULT_INJECT value to arm
 * @param {string} [opts.modelProvidersPath]  model catalog (for example the scripted model)
 * @param {{rootName: string, rootPath: string, serviceUrl: string}} [opts.repoWorkspaces]
 *        load the reference repo workspace provider against that repo service
 * @param {Record<string, string>} [opts.env]  extra environment for the process
 */
/** Shared snapshot-store dir for every kill-harness worker in this suite. */
export function killStoreDir(env) {
    return resolve(dirname(env.sessionStateDir), "kill-shared-store");
}

export function forkKillWorker(env, id, opts = {}) {
    const base = dirname(env.sessionStateDir);
    const stateDir = resolve(base, `kill-${id}`, "session-state");
    const storeDir = killStoreDir(env);
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(storeDir, { recursive: true });

    const child = fork(WORKER_SCRIPT, [], {
        cwd: WORKSPACE_ROOT,
        env: {
            ...process.env,
            PILOTSWARM_WORKER_LOCK_TIMEOUT_MS: FAST_LOCK_MS,
            PILOTSWARM_COMMIT_RETRY_DELAY_MS: "100",
            ...(opts.faultInject ? { PILOTSWARM_FAULT_INJECT: opts.faultInject } : {}),
            ...(opts.env || {}),
        },
        stdio: ["pipe", "pipe", "pipe", "ipc"],
    });

    const logs = [];
    const capture = (stream, tag) => {
        stream.on("data", (data) => {
            for (const line of data.toString().split("\n")) {
                if (!line.trim() || line.includes("ExperimentalWarning")) continue;
                logs.push(line);
                if (process.env.PS_KILL_HARNESS_VERBOSE) {
                    console.log(`    [${id} ${tag}] ${line}`);
                }
            }
        });
    };
    capture(child.stdout, "out");
    capture(child.stderr, "err");

    const exited = new Promise((resolveExit) => {
        child.on("exit", (code, signal) => resolveExit({ code, signal }));
    });

    const ready = new Promise((resolveReady, reject) => {
        const timeout = setTimeout(() => reject(new Error(`worker ${id} did not start in 45s`)), 45_000);
        child.on("message", function handler(msg) {
            if (msg.type === "ready") {
                clearTimeout(timeout);
                child.removeListener("message", handler);
                resolveReady();
            } else if (msg.type === "error") {
                clearTimeout(timeout);
                child.removeListener("message", handler);
                reject(new Error(`worker ${id} failed: ${msg.error}`));
            }
        });
        child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    });

    child.send({
        type: "start",
        store: env.store,
        githubToken: process.env.GITHUB_TOKEN,
        duroxideSchema: env.duroxideSchema,
        cmsSchema: env.cmsSchema,
        factsSchema: env.factsSchema,
        sessionStateDir: stateDir,
        sessionStoreDir: storeDir,
        workerNodeId: `kill-${id}`,
        logLevel: process.env.DUROXIDE_LOG_LEVEL || "warn",
        ...(opts.modelProvidersPath ? { modelProvidersPath: opts.modelProvidersPath } : {}),
        ...(opts.repoWorkspaces ? { repoWorkspaces: opts.repoWorkspaces } : {}),
    });

    return {
        id,
        child,
        stateDir,
        logs,
        ready,
        exited,
        faultFired: () => logs.some((line) => line.includes("[fault-injection] hit point=")
            && !line.includes("action=hold ") && line.includes("fired=true")),
        async stop() {
            try { child.send({ type: "stop" }); } catch {}
            await Promise.race([exited, new Promise((r) => setTimeout(r, 3_000))]);
            try { child.kill("SIGKILL"); } catch {}
        },
        /** Graceful drain; resolves with the exit once the worker finished it. */
        drain() {
            try { child.send({ type: "drain" }); } catch {}
            return exited;
        },
        killHard() {
            child.kill("SIGKILL");
            return exited;
        },
    };
}

/** Attach every participating worker's tail to any scenario failure. */
export async function withKillDiagnostics(workers, run) {
    try {
        return await run();
    } catch (cause) {
        const tails = workers.map((worker) =>
            `worker ${worker.id} logs tail:\n${worker.logs.slice(-30).join("\n") || "(no output)"}`);
        throw new Error(`${cause instanceof Error ? cause.message : String(cause)}\n${tails.join("\n\n")}`, { cause });
    }
}

/** Wait for a forked worker to die AT the armed fault (exit code 137). */
export async function expectFaultDeath(worker, label) {
    const { code, signal } = await Promise.race([
        worker.exited,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${label}: worker ${worker.id} did not die at the fault within 240s`)), 240_000)),
    ]);
    if (code !== 137) {
        throw new Error(`${label}: worker ${worker.id} exited code=${code} signal=${signal}, expected fault exit 137. Logs tail:\n${worker.logs.slice(-15).join("\n")}`);
    }
    if (!worker.faultFired()) {
        throw new Error(`${label}: worker ${worker.id} exited 137 but no firing fault-injection hit line was logged`);
    }
}

/** The arguments the Copilot SDK starts its runtime with (copilot-runtime-monitor.ts matches the same pair). */
const COPILOT_RUNTIME_ARGS = ["--headless", "--stdio"];

/**
 * Issue 329 (review M2): the Copilot runtimes `parentPid` (default: this test
 * process, which runs its in-process workers) spawned, as the operating system
 * reports them: its direct children whose arguments include `--headless` and
 * `--stdio`. It reads the process table, never the SDK or PilotSwarm's runtime
 * monitor, so a kill test targets the same process on every revision. A child
 * that exited but is not yet reaped has no arguments and is not listed.
 *
 * @returns {number[]} the PIDs, ascending
 */
export function copilotRuntimeChildPids(parentPid = process.pid) {
    return listProcesses(parentPid)
        .filter((proc) => proc.ppid === parentPid && COPILOT_RUNTIME_ARGS.every((arg) => proc.args.includes(arg)))
        .map((proc) => proc.pid)
        .sort((a, b) => a - b);
}

function listProcesses(parentPid) {
    if (process.platform === "linux") {
        const procs = [];
        for (const entry of readdirSync("/proc")) {
            if (!/^\d+$/.test(entry)) continue;
            try {
                // "pid (comm) state ppid ...": comm may itself hold spaces and parentheses.
                const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
                const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
                const args = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0").filter(Boolean);
                procs.push({ pid: Number(entry), ppid, args });
            } catch {
                // The process exited while the table was read.
            }
        }
        return procs;
    }
    if (process.platform === "win32") {
        const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${Number(parentPid)}" | `
            + "ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)\" }";
        const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
            { encoding: "utf8", windowsHide: true });
        return text.split(/\r?\n/).filter(Boolean).map((line) => {
            const [pid, ppid, ...command] = line.split("\t");
            return { pid: Number(pid), ppid: Number(ppid), args: command.join("\t").split(/\s+/) };
        });
    }
    const text = execFileSync("ps", ["-A", "-o", "pid=,ppid=,args="], { encoding: "utf8" });
    return text.split("\n").flatMap((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
        return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), args: match[3].split(/\s+/) }] : [];
    });
}
