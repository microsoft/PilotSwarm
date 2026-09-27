/**
 * Runs one command on the host in its own process group, so a timeout or a
 * lost connection kills the whole tree, not only the first process.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, type Hash } from "node:crypto";
import type { StreamResult } from "./protocol.js";

export interface RunOptions {
    command: string[];
    cwd?: string;
    timeoutSeconds: number;
    stdin?: string;
    /** Bytes kept per stream for the inline result. The hash and count still cover every byte. */
    maxInlineBytes: number;
}

export type RunOutcome =
    | {
          status: "exited";
          exitCode: number | null;
          signal: string | null;
          timedOut: boolean;
          durationMs: number;
          stdout: StreamResult;
          stderr: StreamResult;
      }
    | { status: "start_failed"; error: string };

export interface RunningCommand {
    readonly pid: number | undefined;
    readonly outcome: Promise<RunOutcome>;
    /**
     * Kills the whole process tree: SIGTERM, then SIGKILL after a grace period.
     * `force` sends SIGKILL at once. Safe to call more than once.
     */
    kill(force?: boolean): void;
}

/** After SIGTERM, how long the tree gets before SIGKILL. */
const KILL_GRACE_MS = 2000;

class StreamCollector {
    private readonly hash: Hash = createHash("sha256");
    private readonly kept: Buffer[] = [];
    private keptBytes = 0;
    private totalBytes = 0;

    constructor(private readonly limit: number) {}

    add(chunk: Buffer): void {
        this.hash.update(chunk);
        this.totalBytes += chunk.length;
        const room = this.limit - this.keptBytes;
        if (room > 0) {
            const part = chunk.length <= room ? chunk : chunk.subarray(0, room);
            this.kept.push(part);
            this.keptBytes += part.length;
        }
    }

    finish(): StreamResult {
        return {
            text: Buffer.concat(this.kept).toString("utf8"),
            bytes: this.totalBytes,
            sha256: this.hash.digest("hex"),
            truncated: this.totalBytes > this.keptBytes,
        };
    }
}

export function runCommand(options: RunOptions): RunningCommand {
    const started = Date.now();
    const isWindows = process.platform === "win32";
    let child: ChildProcess;
    try {
        child = spawn(options.command[0], options.command.slice(1), {
            cwd: options.cwd,
            stdio: ["pipe", "pipe", "pipe"],
            // A new process group on Unix, so kill(-pid) reaches every descendant.
            detached: !isWindows,
            windowsHide: true,
            shell: false,
        });
    } catch (error) {
        return {
            pid: undefined,
            outcome: Promise.resolve({ status: "start_failed", error: (error as Error).message }),
            kill: () => {},
        };
    }

    const stdout = new StreamCollector(options.maxInlineBytes);
    const stderr = new StreamCollector(options.maxInlineBytes);
    child.stdout!.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr!.on("data", (chunk: Buffer) => stderr.add(chunk));
    child.stdin!.on("error", () => {}); // the process may exit before reading stdin
    child.stdin!.end(options.stdin ?? "");

    let timedOut = false;
    let killed = false;
    let forceTimer: NodeJS.Timeout | undefined;

    const killTree = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
            if (isWindows) {
                spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
            } else {
                process.kill(-child.pid, signal);
            }
        } catch {
            // The group is already gone.
        }
    };

    const kill = (force = false) => {
        if (force) {
            killed = true;
            killTree("SIGKILL");
            return;
        }
        if (killed) return;
        killed = true;
        killTree("SIGTERM");
        forceTimer = setTimeout(() => killTree("SIGKILL"), KILL_GRACE_MS);
        forceTimer.unref();
    };

    const timeoutTimer = setTimeout(() => {
        timedOut = true;
        kill();
    }, options.timeoutSeconds * 1000);

    const outcome = new Promise<RunOutcome>((resolve) => {
        let spawned = false;
        child.once("spawn", () => {
            spawned = true;
        });
        child.once("error", (error) => {
            if (spawned) return;
            clearTimeout(timeoutTimer);
            resolve({ status: "start_failed", error: error.message });
        });
        // "close" waits for stdout and stderr to end, so no output is lost.
        child.once("close", (exitCode, signal) => {
            if (!spawned) return;
            clearTimeout(timeoutTimer);
            // The first process is gone, but something it started may still hold
            // the group. Clear the group so nothing outlives the command.
            if (!killed) killTree("SIGKILL");
            if (forceTimer) clearTimeout(forceTimer);
            resolve({
                status: "exited",
                exitCode,
                signal,
                timedOut,
                durationMs: Date.now() - started,
                stdout: stdout.finish(),
                stderr: stderr.finish(),
            });
        });
    });

    return { pid: child.pid, outcome, kill };
}
