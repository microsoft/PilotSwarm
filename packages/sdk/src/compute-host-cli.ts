#!/usr/bin/env node
/**
 * The host component as a program, for a provider that puts a host
 * together from parts rather than from code
 * (docs/proposals/compute-providers.md, "The handshake and host component").
 *
 * It answers the worker's handshake for one binding and then carries bytes
 * to the runtime's local port. It also serves the side channel, which is
 * how a session's skill folders and the deployment's own MCP servers
 * reach the runtime: a session that has either of them needs it, so it is
 * on by default and `--no-services` turns it off.
 *
 * It stops after `--idle-timeout` milliseconds with no connection (30
 * minutes by default, 0 to stay up for ever). Run it so that the runtime
 * goes with it — as its parent, for example — because that timeout is
 * what frees a host nobody came back to.
 *
 *   pilotswarm-compute-host --binding <id> --runtime 127.0.0.1:4100 --listen 0.0.0.0:7000
 *
 * The copies and the relay are written under `--services-dir`, which
 * defaults to a folder of this binding's own under the system temporary
 * folder. `--copy-max-bytes` and `--copy-max-files` bound what one
 * session's copy may lay out there.
 *
 * The binding's secret is read from PILOTSWARM_COMPUTE_HANDSHAKE_SECRET
 * and never taken from the command line, where anything on the host could
 * read it out of the process list. It is taken out of the environment as
 * it is read, so nothing this program starts inherits it, and a provider
 * must not pass it to the runtime either.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { COMPUTE_HOST_IDLE_TIMEOUT_MS, readHandshakeSecret, startComputeHost } from "./compute-host.js";


function argument(argv: string[], name: string): string | undefined {
    const at = argv.indexOf(`--${name}`);
    if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
    const inline = argv.find((entry) => entry.startsWith(`--${name}=`));
    return inline ? inline.slice(name.length + 3) : undefined;
}

/** A whole number of milliseconds, or the reason it is not one. */
export function wholeMilliseconds(value: string | undefined, what: string, fallback: number): number {
    if (value === undefined) return fallback;
    const raw = value.trim();
    if (!/^\d+$/.test(raw)) throw new Error(`--${what} needs a whole number of milliseconds`);
    const number = Number(raw);
    if (!Number.isSafeInteger(number)) throw new Error(`--${what} needs a whole number of milliseconds`);
    return number;
}

/** A positive whole number, or undefined when it was not given. */
export function positiveWhole(value: string | undefined, what: string): number | undefined {
    if (value === undefined) return undefined;
    const raw = value.trim();
    if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw new Error(`--${what} needs a whole number greater than zero`);
    return Number(raw);
}

/** A name a folder can be made from, so a binding id cannot name a path. */
function folderSafe(value: string): string {
    return value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) || "binding";
}

function endpoint(value: string, what: string): { host: string; port: number } {
    const raw = value.trim();
    const at = raw.lastIndexOf(":");
    if (at <= 0) throw new Error(`--${what} needs <host>:<port>`);
    const port = Number(raw.slice(at + 1));
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--${what} needs <host>:<port>`);
    return { host: raw.slice(0, at).replace(/^\[|\]$/g, ""), port };
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const bindingId = argument(argv, "binding") ?? "";
    const runtimeAddress = argument(argv, "runtime") ?? "";
    const listen = argument(argv, "listen");
    const secret = readHandshakeSecret(process.env);
    if (!bindingId || !runtimeAddress || !listen) {
        console.error("usage: pilotswarm-compute-host --binding <id> --runtime <host:port|port> --listen <host:port>"
            + " [--idle-timeout <ms>] [--max-connections <n>] [--services-dir <folder>] [--no-services]"
            + " [--copy-max-bytes <n>] [--copy-max-files <n>]");
        process.exitCode = 2;
        return;
    }
    if (!secret) {
        console.error("set PILOTSWARM_COMPUTE_HANDSHAKE_SECRET to this binding's secret");
        process.exitCode = 2;
        return;
    }
    const idleTimeoutMs = wholeMilliseconds(argument(argv, "idle-timeout"), "idle-timeout", COMPUTE_HOST_IDLE_TIMEOUT_MS);
    const maxConnections = positiveWhole(argument(argv, "max-connections"), "max-connections");
    const maxBytes = positiveWhole(argument(argv, "copy-max-bytes"), "copy-max-bytes");
    const maxFiles = positiveWhole(argument(argv, "copy-max-files"), "copy-max-files");
    // On by default: a session with any skill folder or any MCP server
    // needs the side channel, and a host that refuses it leaves every one
    // of those sessions without them.
    const servesControl = !argv.includes("--no-services");
    const servicesDirectory = argument(argv, "services-dir")
        ?? path.join(os.tmpdir(), `pilotswarm-compute-host-${folderSafe(bindingId)}`);
    const host = await startComputeHost({
        bindingId,
        secret,
        runtimeAddress,
        listen: endpoint(listen, "listen"),
        idleTimeoutMs,
        ...(maxConnections !== undefined ? { maxConnections } : {}),
        ...(servesControl ? {
            services: {
                directory: servicesDirectory,
                ...(maxBytes !== undefined || maxFiles !== undefined
                    ? { limits: { ...(maxBytes !== undefined ? { maxBytes } : {}), ...(maxFiles !== undefined ? { maxFiles } : {}) } }
                    : {}),
            },
        } : {}),
        onIdle: () => {
            console.log(`[compute-host] binding ${bindingId} had no connection for ${idleTimeoutMs} ms; stopping`);
            process.exit(0);
        },
        onConnectionClosed: ({ ok, error }) => {
            if (!ok) console.error(`[compute-host] a connection was refused: ${error?.message ?? "no reason given"}`);
        },
    });
    console.log(`[compute-host] binding ${bindingId} listening on ${host.address}`
        + (servesControl ? `, copies and relay in ${servicesDirectory}` : ", runtime stream only"));
    const stop = () => { void host.close().finally(() => process.exit(0)); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
}

/**
 * Run only as a program. The checks above are exported so they can be
 * held to their behaviour without starting a host component.
 */
function startedAsProgram(): boolean {
    const started = process.argv[1];
    if (!started) return false;
    const mine = fileURLToPath(import.meta.url);
    try {
        return fs.realpathSync(started) === fs.realpathSync(mine);
    } catch {
        return path.resolve(started) === path.resolve(mine);
    }
}

if (startedAsProgram()) {
    main().catch((error: unknown) => {
        console.error(`[compute-host] ${String((error as Error)?.message ?? error)}`);
        process.exitCode = 1;
    });
}
