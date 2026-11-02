/**
 * The `process` compute provider: each session tree gets its own agent
 * runtime, a separate `copilot --headless` process on this machine that
 * the worker reaches over TCP like any remote runtime.
 *
 * **Test provider. Not part of the SDK's public surface** — it is not
 * exported from `index.ts`, so nothing outside this package can reach it.
 * It exists so the remote-runtime path (connection token, handshake,
 * SessionFs, credential placeholders, release) can be exercised without a
 * cluster, and as the smallest readable example of a provider. It is not an
 * isolation boundary. A real provider replaces `spawn` with its platform's
 * call and returns the address its platform gives.
 *
 * The runtime gets a scrubbed environment: no worker variables, so no
 * database URLs, tokens or keys reach the commands the model runs.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { COMPUTE_ERROR_CODES, type ComputeHostRef, type ComputeProvider } from "./compute.js";
import { newComputeHandshakeSecret } from "./compute-handshake.js";
import { startComputeHost, type ComputeHostHandle } from "./compute-host.js";

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
    /**
     * How long a host stays up with no connection before its component
     * ends it, and the runtime with it. Default
     * COMPUTE_HOST_IDLE_TIMEOUT_MS; 0 keeps it for ever. Tests use a
     * short one.
     */
    idleTimeoutMs?: number;
}

interface ProcessHost {
    key: string;
    ref: ComputeHostRef;
    child: ChildProcess;
    port: number;
    token: string;
    hostDir: string;
    homeDir: string;
    workDir: string;
    sessions: Set<string>;
    exited: boolean;
    /** The PilotSwarm host component in front of this runtime. */
    component: ComputeHostHandle;
    /** This binding's handshake secret. Fresh per host, never written down. */
    bindingId: string;
    secret: string;
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
        USERPROFILE: homeDir,
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

const OUTPUT_TAIL_BYTES = 4_096;

/**
 * Best effort: a process that just exited can still hold its folders for a
 * moment on some platforms, and a failed cleanup must not fail a release.
 */
function removeHostDir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* left for the OS temp cleaner */ }
}

export function createProcessComputeProvider(options: ProcessComputeProviderOptions = {}): ComputeProvider & {
    /** Test and diagnostic view: the live hosts. */
    hosts(): Array<{ targetId: string; rootSessionId: string; pid: number | undefined; port: number; homeDir: string; workDir: string; sessions: string[] }>;
    /** Stop every host. */
    stopAll(): Promise<void>;
} {
    const rootDir = options.rootDir ?? path.join(os.tmpdir(), `pilotswarm-process-compute-${process.pid}`);
    const startTimeoutMs = options.startTimeoutMs ?? 30_000;
    const hosts = new Map<string, ProcessHost>();
    const starting = new Map<string, Promise<ProcessHost>>();
    const hostKey = (targetId: string, rootSessionId: string) => `${targetId}\0${rootSessionId}`;

    function signalGroup(child: ChildProcess, name: NodeJS.Signals): void {
        try {
            // The runtime leads its own process group: stop the commands it started too.
            if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
            else child.kill(name);
        } catch { /* already gone */ }
    }

    async function start(key: string, targetId: string, rootSessionId: string): Promise<ProcessHost> {
        const cliPath = options.cliPath ?? defaultCliPath();
        const incarnation = randomUUID();
        const hostDir = path.join(rootDir, incarnation);
        const homeDir = path.join(hostDir, "home");
        const workDir = path.join(hostDir, "work");
        fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
        fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
        fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
        const token = randomBytes(24).toString("hex");
        const env = { ...baseRuntimeEnv(homeDir), ...(options.env ?? {}), COPILOT_CONNECTION_TOKEN: token };
        const args = ["--headless", "--no-auto-update", "--no-auto-login"];
        const spawnOptions: SpawnOptions = { cwd: workDir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" };
        const child: ChildProcess = /\.[cm]?js$/.test(cliPath)
            ? spawn(process.execPath, [cliPath, ...args], spawnOptions)
            : spawn(cliPath, args, spawnOptions);
        const cleanup = () => removeHostDir(hostDir);
        let port: number;
        try {
            port = await new Promise<number>((resolve, reject) => {
                let stdout = "";
                let stderr = "";
                const tail = (text: string, more: string) => (text + more).slice(-OUTPUT_TAIL_BYTES);
                const timer = setTimeout(() => {
                    signalGroup(child, "SIGKILL");
                    reject(new Error(`the runtime did not listen within ${startTimeoutMs} ms${stderr ? `: ${stderr.trim().slice(-500)}` : ""}`));
                }, startTimeoutMs);
                child.stdout!.on("data", (data: Buffer) => {
                    stdout = tail(stdout, data.toString());
                    const match = stdout.match(/listening on port (\d+)/i);
                    if (match) {
                        clearTimeout(timer);
                        resolve(Number(match[1]));
                    }
                });
                child.stderr!.on("data", (data: Buffer) => { stderr = tail(stderr, data.toString()); });
                child.once("error", (error) => { clearTimeout(timer); reject(error); });
                child.once("exit", (code, signal) => {
                    clearTimeout(timer);
                    reject(new Error(`the runtime exited before listening (code ${code}, signal ${signal})${stderr ? `: ${stderr.trim().slice(-500)}` : ""}`));
                });
            });
        } catch (error) {
            cleanup();
            throw error;
        }
        // Keep draining the pipes so the runtime never blocks, without keeping its output.
        child.stdout!.removeAllListeners("data");
        child.stderr!.removeAllListeners("data");
        child.stdout!.resume();
        child.stderr!.resume();
        // The PilotSwarm host component goes in front of the runtime, as
        // it would on a real host: the worker reaches the component, the
        // two prove they hold this binding's secret, and only then does
        // anything reach the runtime's own port. Here it runs in the
        // provider's own process, which is honest for a provider that is
        // not an isolation boundary to begin with; on a real host it is a
        // separate program (`startComputeHost`, or the bin entry).
        const bindingId = incarnation;
        const secret = newComputeHandshakeSecret();
        // The host's life follows its component, the way a real host's
        // should: when the component ends itself for want of a
        // connection, the runtime goes with it and the next turn of a
        // session that comes back gets a fresh host.
        let self: ProcessHost | undefined;
        let component: ComputeHostHandle;
        try {
            component = await startComputeHost({
                bindingId, secret,
                listen: { host: "127.0.0.1", port: 0 },
                runtimeAddress: `127.0.0.1:${port}`,
                ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
                onIdle: () => { if (self) void stop(self); },
            });
        } catch (error) {
            signalGroup(child, "SIGKILL");
            cleanup();
            throw error;
        }
        const host: ProcessHost = {
            key,
            ref: { kind: PROCESS_COMPUTE_KIND, id: `${targetId}/${rootSessionId}`, incarnation, data: { port } },
            child, port, token, hostDir, homeDir, workDir, sessions: new Set(), exited: false,
            component, bindingId, secret,
        };
        self = host;
        child.once("exit", () => {
            host.exited = true;
            if (hosts.get(key) === host) hosts.delete(key);
        });
        return host;
    }

    async function stop(host: ProcessHost): Promise<void> {
        if (hosts.get(host.key) === host) hosts.delete(host.key);
        await host.component.close().catch(() => { /* best effort */ });
        if (!host.exited) {
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => { signalGroup(host.child, "SIGKILL"); resolve(); }, 5_000);
                host.child.once("exit", () => { clearTimeout(timer); resolve(); });
                signalGroup(host.child, "SIGTERM");
            });
        }
        // The runtime's home holds conversation data; it goes with the host.
        removeHostDir(host.hostDir);
    }

    function live(ref: ComputeHostRef): ProcessHost | undefined {
        for (const host of hosts.values()) {
            if (!host.exited && host.ref.id === ref.id && host.ref.incarnation === ref.incarnation) return host;
        }
        return undefined;
    }

    return {
        kind: PROCESS_COMPUTE_KIND,
        capabilities: { files: "worker-local" },

        async bind(req) {
            const key = hostKey(req.target.id, req.rootSessionId);
            let host = hosts.get(key);
            if (!host || host.exited) {
                let pending = starting.get(key);
                if (!pending) {
                    pending = start(key, req.target.id, req.rootSessionId).finally(() => starting.delete(key));
                    starting.set(key, pending);
                }
                try {
                    host = await pending;
                } catch (error) {
                    return { ok: false, code: COMPUTE_ERROR_CODES.UNAVAILABLE, message: String((error as Error)?.message ?? error), retryAfterMs: 5_000 };
                }
                hosts.set(key, host);
            }
            host.sessions.add(req.sessionId);
            return { ok: true, host: host.ref };
        },

        async connect(req) {
            const host = live(req.host);
            if (!host) {
                return { ok: false, code: COMPUTE_ERROR_CODES.UNAVAILABLE, message: `the runtime for host ${req.host.id} is not running`, retryAfterMs: 1_000 };
            }
            // Same machine: the worker's folders are valid paths for the host.
            // The address is the host component's, never the runtime's own
            // port: everything the worker sends goes through the handshake.
            return {
                ok: true,
                endpoint: {
                    transport: "uri",
                    address: host.component.address,
                    connectionToken: host.token,
                    handshake: { bindingId: host.bindingId, secret: host.secret },
                },
                workspace: { cwd: req.workspace.cwd ?? host.workDir, ...(req.workspace.additionalDirectories ? { additionalDirectories: req.workspace.additionalDirectories } : {}) },
            };
        },

        async release(req) {
            const host = live(req.host);
            if (!host) return;
            host.sessions.delete(req.sessionId);
            if (host.sessions.size === 0) await stop(host);
        },

        hosts() {
            return [...hosts.values()].map((host) => {
                const [targetId, rootSessionId] = host.key.split("\0");
                return { targetId, rootSessionId, pid: host.child.pid, port: host.port, homeDir: host.homeDir, workDir: host.workDir, sessions: [...host.sessions] };
            });
        },

        async stopAll() {
            await Promise.all([...hosts.values()].map(stop));
        },
    };
}
