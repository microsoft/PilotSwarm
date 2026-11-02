#!/usr/bin/env node
/**
 * The host component as a program, for a provider that puts a host
 * together from parts rather than from code
 * (docs/proposals/compute-providers.md, "The handshake and host component").
 *
 * It answers the worker's handshake for one binding and then carries bytes
 * to the runtime's local port. Nothing else.
 *
 * It stops after `--idle-timeout` milliseconds with no connection (30
 * minutes by default, 0 to stay up for ever). Run it so that the runtime
 * goes with it — as its parent, for example — because that timeout is
 * what frees a host nobody came back to.
 *
 *   pilotswarm-compute-host --binding <id> --runtime 127.0.0.1:4100 --listen 0.0.0.0:7000
 *
 * The binding's secret is read from PILOTSWARM_COMPUTE_HANDSHAKE_SECRET
 * and never taken from the command line, where anything on the host could
 * read it out of the process list. It is taken out of the environment as
 * it is read, so nothing this program starts inherits it, and a provider
 * must not pass it to the runtime either.
 */
import { COMPUTE_HOST_IDLE_TIMEOUT_MS, readHandshakeSecret, startComputeHost } from "./compute-host.js";


function argument(argv: string[], name: string): string | undefined {
    const at = argv.indexOf(`--${name}`);
    if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
    const inline = argv.find((entry) => entry.startsWith(`--${name}=`));
    return inline ? inline.slice(name.length + 3) : undefined;
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
    const idle = argument(argv, "idle-timeout");
    const secret = readHandshakeSecret(process.env);
    if (!bindingId || !runtimeAddress || !listen) {
        console.error("usage: pilotswarm-compute-host --binding <id> --runtime <host:port|port> --listen <host:port> [--idle-timeout <ms>]");
        process.exitCode = 2;
        return;
    }
    if (!secret) {
        console.error("set PILOTSWARM_COMPUTE_HANDSHAKE_SECRET to this binding's secret");
        process.exitCode = 2;
        return;
    }
    const host = await startComputeHost({
        bindingId,
        secret,
        runtimeAddress,
        listen: endpoint(listen, "listen"),
        idleTimeoutMs: idle === undefined ? COMPUTE_HOST_IDLE_TIMEOUT_MS : Number(idle),
        onIdle: () => {
            console.log(`[compute-host] binding ${bindingId} had no connection for ${idle ?? COMPUTE_HOST_IDLE_TIMEOUT_MS} ms; stopping`);
            process.exit(0);
        },
        onConnectionClosed: ({ ok, error }) => {
            if (!ok) console.error(`[compute-host] a connection was refused: ${error?.message ?? "no reason given"}`);
        },
    });
    console.log(`[compute-host] binding ${bindingId} listening on ${host.address}`);
    const stop = () => { void host.close().finally(() => process.exit(0)); };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
}

main().catch((error: unknown) => {
    console.error(`[compute-host] ${String((error as Error)?.message ?? error)}`);
    process.exitCode = 1;
});
