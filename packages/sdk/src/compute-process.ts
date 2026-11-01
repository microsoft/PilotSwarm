/**
 * The `process` compute provider: each session tree gets its own GHCP
 * runtime, a separate `copilot --headless` process on this machine that
 * the worker reaches over TCP like any remote runtime.
 *
 * It is not an isolation boundary. It exists so the remote-runtime path
 * (connection token, SessionFs, credential placeholders, release) can be
 * exercised and developed without a cluster, and as the smallest example
 * of a provider. A real provider replaces `spawn` with its platform's call
 * and returns the address its platform gives.
 *
 * The runtime gets a scrubbed environment: no worker variables, so no
 * database URLs, tokens or keys reach the commands the model runs.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { COMPUTE_ERROR_CODES, type ComputeHostRef, type ComputeProvider } from "./compute.js";

export const PROCESS_COMPUTE_KIND = "process";

export interface ProcessComputeProviderOptions {
    /** The Copilot CLI entry point. Default: COPILOT_CLI_PATH, else the pinned `@github/copilot` package. */
    cliPath?: string;
    /** Where each host gets its home and work folders. Default: a folder under the OS temp dir. */
    rootDir?: string;
    /** How long to wait for the runtime to listen. Default 30 s. */
    startTimeoutMs?: number;
    /** Extra variables for the runtime. The worker's own environment is never passed. */
    env?: Record<string, string>;
}

interface ProcessHost {
    ref: ComputeHostRef;
    child: ChildProcess;
    port: number;
    token: string;
    homeDir: string;
    workDir: string;
    sessions: Set<string>;
    exited: boolean;
}

/**
 * The native runtime binary, found the way `@github/copilot`'s own loader
 * finds it. Spawning the loader instead would leave the native child behind
 * when the loader is stopped.
 */
function defaultCliPath(): string {
    if (process.env.COPILOT_CLI_PATH) return process.env.COPILOT_CLI_PATH;
    const require = createRequire(import.meta.url);
    const platforms = process.platform === "linux" ? ["linuxmusl", "linux"] : [process.platform];
    for (const platform of platforms) {
        try {
            return require.resolve(`@github/copilot-${platform}-${process.arch}`);
        } catch { /* try the next */ }
    }
    return require.resolve("@github/copilot/npm-loader.js");
}

/** Variables the runtime needs to start; everything else from the worker stays out. */
function baseRuntimeEnv(homeDir: string): Record<string, string> {
    const env: Record<string, string> = {
        HOME: homeDir,
        COPILOT_HOME: homeDir,
        COPILOT_DISABLE_KEYTAR: "1",
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    };
    for (const name of ["LANG", "TZ", "SystemRoot", "TEMP", "TMP"]) {
        const value = process.env[name];
        if (value) env[name] = value;
    }
    return env;
}

export function createProcessComputeProvider(options: ProcessComputeProviderOptions = {}): ComputeProvider & {
    /** Test and diagnostic view: the live hosts by tree. */
    hosts(): Array<{ rootSessionId: string; pid: number | undefined; port: number; homeDir: string; workDir: string; sessions: string[] }>;
    /** Stop every host. */
    stopAll(): Promise<void>;
} {
    const rootDir = options.rootDir ?? path.join(os.tmpdir(), `pilotswarm-process-compute-${process.pid}`);
    const startTimeoutMs = options.startTimeoutMs ?? 30_000;
    const hosts = new Map<string, ProcessHost>();
    const starting = new Map<string, Promise<ProcessHost>>();

    async function start(rootSessionId: string): Promise<ProcessHost> {
        const cliPath = options.cliPath ?? defaultCliPath();
        const hostDir = path.join(rootDir, rootSessionId);
        const homeDir = path.join(hostDir, "home");
        const workDir = path.join(hostDir, "work");
        fs.mkdirSync(homeDir, { recursive: true });
        fs.mkdirSync(workDir, { recursive: true });
        const token = randomBytes(24).toString("hex");
        const env = { ...baseRuntimeEnv(homeDir), ...(options.env ?? {}), COPILOT_CONNECTION_TOKEN: token };
        const args = ["--headless", "--no-auto-update", "--no-auto-login"];
        const child = /\.[cm]?js$/.test(cliPath)
            ? spawn(process.execPath, [cliPath, ...args], { cwd: workDir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" })
            : spawn(cliPath, args, { cwd: workDir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
        const port = await new Promise<number>((resolve, reject) => {
            let stdout = "";
            let stderr = "";
            const timer = setTimeout(() => {
                try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* gone */ }
                reject(new Error(`the runtime did not listen within ${startTimeoutMs} ms${stderr ? `: ${stderr.trim().slice(-500)}` : ""}`));
            }, startTimeoutMs);
            child.stdout!.on("data", (data) => {
                stdout += data.toString();
                const match = stdout.match(/listening on port (\d+)/i);
                if (match) {
                    clearTimeout(timer);
                    resolve(Number(match[1]));
                }
            });
            child.stderr!.on("data", (data) => { stderr += data.toString(); });
            child.once("error", (error) => { clearTimeout(timer); reject(error); });
            child.once("exit", (code, signal) => {
                clearTimeout(timer);
                reject(new Error(`the runtime exited before listening (code ${code}, signal ${signal})${stderr ? `: ${stderr.trim().slice(-500)}` : ""}`));
            });
        });
        const host: ProcessHost = {
            ref: { kind: PROCESS_COMPUTE_KIND, id: rootSessionId, incarnation: randomUUID(), data: { port } },
            child, port, token, homeDir, workDir, sessions: new Set(), exited: false,
        };
        child.once("exit", () => {
            host.exited = true;
            if (hosts.get(rootSessionId) === host) hosts.delete(rootSessionId);
        });
        return host;
    }

    async function stop(host: ProcessHost): Promise<void> {
        if (hosts.get(host.ref.id) === host) hosts.delete(host.ref.id);
        if (host.exited) return;
        // The runtime leads its own process group: stop the commands it started too.
        const signal = (name: NodeJS.Signals) => {
            try {
                if (process.platform !== "win32" && host.child.pid) process.kill(-host.child.pid, name);
                else host.child.kill(name);
            } catch { /* already gone */ }
        };
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => { signal("SIGKILL"); resolve(); }, 5_000);
            host.child.once("exit", () => { clearTimeout(timer); resolve(); });
            signal("SIGTERM");
        });
    }

    function live(ref: ComputeHostRef): ProcessHost | undefined {
        const host = hosts.get(ref.id);
        return host && !host.exited && host.ref.incarnation === ref.incarnation ? host : undefined;
    }

    return {
        kind: PROCESS_COMPUTE_KIND,
        capabilities: { os: [process.platform === "win32" ? "windows" : "linux"], sandboxed: false, files: "worker-local" },

        async bind(req) {
            let host = hosts.get(req.rootSessionId);
            if (!host || host.exited) {
                let pending = starting.get(req.rootSessionId);
                if (!pending) {
                    pending = start(req.rootSessionId).finally(() => starting.delete(req.rootSessionId));
                    starting.set(req.rootSessionId, pending);
                }
                try {
                    host = await pending;
                } catch (error) {
                    return { ok: false, code: COMPUTE_ERROR_CODES.UNAVAILABLE, message: String((error as Error)?.message ?? error), retryAfterMs: 5_000 };
                }
                hosts.set(req.rootSessionId, host);
            }
            host.sessions.add(req.sessionId);
            return { ok: true, host: host.ref };
        },

        async connect(req) {
            const host = live(req.host);
            if (!host) {
                return { ok: false, code: COMPUTE_ERROR_CODES.UNAVAILABLE, message: `the runtime for tree ${req.host.id} is not running`, retryAfterMs: 1_000 };
            }
            // Same machine: the worker's folders are valid paths for the host.
            return {
                ok: true,
                endpoint: { transport: "uri", address: `127.0.0.1:${host.port}`, connectionToken: host.token },
                workspace: { cwd: req.workspace.cwd ?? host.workDir, ...(req.workspace.additionalDirectories ? { additionalDirectories: req.workspace.additionalDirectories } : {}), convention: process.platform === "win32" ? "windows" : "posix" },
            };
        },

        async hostState(ref) {
            const host = live(ref);
            return { phase: host ? "ready" : "gone", observedAt: new Date().toISOString() };
        },

        async release(req) {
            const host = live(req.host);
            if (!host) return;
            host.sessions.delete(req.sessionId);
            if (host.sessions.size === 0) await stop(host);
        },

        hosts() {
            return [...hosts.entries()].map(([rootSessionId, host]) => ({
                rootSessionId, pid: host.child.pid, port: host.port, homeDir: host.homeDir, workDir: host.workDir, sessions: [...host.sessions],
            }));
        },

        async stopAll() {
            await Promise.all([...hosts.values()].map(stop));
        },
    };
}
