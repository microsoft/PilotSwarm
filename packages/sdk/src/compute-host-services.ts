/**
 * What the host component does on the side channel
 * (docs/proposals/compute-providers.md, "Skills and MCP servers on remote
 * sessions").
 *
 * The runtime stream carries the turn. This carries the two things the
 * turn needs that are not part of it:
 *
 * 1. **The copies.** The worker sends the bytes of the folders this
 *    session is authorized to see, each named by its own digest, and asks
 *    for them to be laid out. They are written read-only into one folder
 *    of this host component's own, and nowhere else.
 *
 * 2. **The servers that stay on the trusted side.** The runtime reaches
 *    them as ordinary remote servers: a small relay program for one that
 *    speaks over its input and output, and a local address for one
 *    reached over HTTP. Both of them do the same thing — take what the
 *    runtime says, hand it to the worker down a stream of the channel,
 *    and hand back what comes the other way. Neither reads a byte of it.
 *
 * Nothing here knows what MCP is, and that is the point: whatever the
 * runtime and the server can do between them keeps working, because
 * PilotSwarm is not in the middle of their conversation.
 *
 * Each of those connections names a ticket and nothing else. The ticket
 * is the worker's own: it decides which session asked and which server it
 * may reach. A ticket this host has never been given is refused by the
 * worker, not here, because here is the untrusted side.
 *
 * **The relay program** is written out by this component when it starts,
 * rather than shipped as a file beside it. A host component may be
 * running from a built package, from a source tree under a test runner,
 * or as part of a provider's own process, and in each of those its own
 * code is in a different place or in a form a runtime could not start. It
 * is the same handful of lines in every one of them, so it is written
 * where the runtime can certainly reach it.
 */
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { ComputeAssetStore, computeCopyLimits, type ComputeCopyLimits } from "./compute-assets.js";
import { ComputeChannel, type ComputeChannelStream } from "./compute-channel.js";
import { COMPUTE_NATIVE_STATE_MAX_BYTES, type ComputeNativeState, type ComputeNativeStateHost } from "./compute-native-state.js";
import type { ComputeExecutionIdentity } from "./compute-execution.js";

/** How long a relay connection may say nothing about which ticket it carries. */
export const COMPUTE_RELAY_TICKET_TIMEOUT_MS = 10_000;
/** The longest ticket line a relay connection may send. */
const MAX_TICKET_BYTES = 512;

/**
 * The relay: everything the runtime starts for a server that stays on the
 * trusted side. It connects to this component, says which ticket it
 * carries, and from then on is a pipe.
 */
const RELAY_PROGRAM = `#!/usr/bin/env node
"use strict";
// Written by the PilotSwarm host component. It connects to the component
// on this host, names the ticket it was started for, and then carries
// bytes between its own input and output and that connection. It reads
// nothing that passes through it.
const net = require("node:net");
function argument(name) {
    const at = process.argv.indexOf("--" + name);
    return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : "";
}
const at = argument("at");
const ticket = argument("ticket");
if (!at || !ticket) {
    process.stderr.write("usage: relay --at <host:port> --ticket <ticket>\\n");
    process.exit(2);
}
const cut = at.lastIndexOf(":");
const socket = net.connect({ host: at.slice(0, cut) || "127.0.0.1", port: Number(at.slice(cut + 1)), noDelay: true }, () => {
    socket.write(ticket + "\\n");
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
});
socket.on("error", (error) => {
    process.stderr.write("[relay] " + error.message + "\\n");
    process.exit(1);
});
socket.on("close", () => process.exit(0));
process.stdin.on("end", () => socket.end());
`;

export interface ComputeHostServiceOptions {
    /** The folder this host component owns: the copies and the relay go in it. */
    directory: string;
    limits?: Partial<ComputeCopyLimits>;
    /** What starts the relay. Default: this machine's Node and the written program. */
    relayCommand?: { command: string; args: string[] };
    nativeState?: ComputeNativeStateHost;
}

export interface ComputeHostServices {
    readonly relayAddress: string;
    readonly httpAddress: string;
    close(): Promise<void>;
}

function reply(stream: ComputeChannelStream, message: Record<string, unknown>): void {
    void stream.write(Buffer.from(JSON.stringify(message), "utf8"))
        .then(() => stream.end())
        .catch(() => { /* the channel is already going */ });
}

/**
 * Serve one control channel. Resolves once the two local listeners are up
 * and the worker has been told where they are.
 */
export async function serveComputeHostControl(
    channel: ComputeChannel,
    options: ComputeHostServiceOptions,
): Promise<ComputeHostServices> {
    const limits = computeCopyLimits(options.limits);
    const store = new ComputeAssetStore(path.join(options.directory, "copies"), limits);
    fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    const relayPath = path.join(options.directory, "relay.cjs");
    fs.rmSync(relayPath, { force: true });
    fs.writeFileSync(relayPath, RELAY_PROGRAM, { mode: 0o500 });

    /** Bytes arriving for one file, held until the sender has finished. */
    const incoming = new Map<number, Buffer[]>();
    /**
     * A folder's file list, as it arrives.
     *
     * A notice is bounded and a copy's limits are not, so a manifest
     * arrives in pieces: piece 0 starts a fresh list, each later piece is
     * added to it, and `place` lays out what has been gathered.
     */
    const manifests = new Map<string, { digest: string; files: unknown[] }>();

    channel.on("notice", (message: Record<string, unknown>) => {
        const id = message.id;
        try {
            if (message.t === "alive") return;
            if (message.t === "have") {
                void channel.notice({ t: "have:ok", id, missing: store.missing(message.digests) });
                return;
            }
            if (message.t === "manifest") {
                const name = String(message.name ?? "");
                const digest = String(message.digest ?? "");
                const at = Number(message.at ?? 0);
                const files = Array.isArray(message.files) ? message.files : [];
                const held = at === 0 ? { digest, files: [] as unknown[] } : manifests.get(name);
                if (!held || held.digest !== digest) throw new Error("that folder's manifest did not arrive in order");
                held.files.push(...files);
                if (held.files.length > limits.maxFiles) throw new Error("that folder carries more files than a session's copy does");
                manifests.set(name, held);
                void channel.notice({ t: "manifest:ok", id });
                return;
            }
            if (message.t === "place") {
                const name = String(message.name ?? "");
                const digest = String(message.digest ?? "");
                const held = manifests.get(name);
                const files = Array.isArray(message.files) ? message.files
                    : held && held.digest === digest ? held.files : null;
                if (files === null) throw new Error("that folder's manifest was never sent");
                const where = store.place({ name, digest, files });
                manifests.delete(name);
                void channel.notice({ t: "place:ok", id, where });
                return;
            }
        } catch (error) {
            void channel.notice({ t: "failed", id, error: String((error as Error)?.message ?? error) });
        }
    });

    channel.on("stream", (stream: ComputeChannelStream) => {
        if (stream.kind === "native-state") {
            const parts: Buffer[] = [];
            let size = 0;
            const max = 2 * (options.nativeState?.options.maxBytes ?? COMPUTE_NATIVE_STATE_MAX_BYTES) + 1024 * 1024;
            stream.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > max) stream.close("Native state request exceeds its byte budget");
                else parts.push(chunk);
            });
            stream.on("end", () => { void (async () => {
                try {
                    if (!options.nativeState) throw new Error("This host does not support native session state");
                    if (size > max) throw new Error("Native state request exceeds its byte budget");
                    const request = JSON.parse(Buffer.concat(parts).toString("utf8")) as {
                        op: string; identity: ComputeExecutionIdentity; state?: ComputeNativeState; barrierId?: string; disposition?: string;
                        path?: string; data?: string; sha256?: string;
                    };
                    const host = options.nativeState;
                    let value: unknown;
                    switch (request.op) {
                        case "describe": value = host.describe(); break;
                        case "prepare": value = await host.prepare(request.identity, request.state); break;
                        case "begin-checkpoint": value = await host.beginCheckpoint(request.identity); break;
                        case "export-state":
                            if (!request.barrierId) throw new Error("Native export requires a barrier ID");
                            value = await host.exportState(request.identity, request.barrierId); break;
                        case "end-checkpoint":
                            if (!request.barrierId || !["committed", "discarded"].includes(request.disposition ?? "")) throw new Error("Invalid native barrier disposition");
                            await host.endCheckpoint(request.identity, request.barrierId, request.disposition as "committed" | "discarded");
                            break;
                        case "retire": value = await host.retire(request.identity); break;
                        case "artifact-read": value = await host.readArtifact(request.identity, String(request.path ?? "")); break;
                        case "artifact-write": value = await host.writeArtifact(request.identity, String(request.path ?? ""),
                            String(request.data ?? ""), String(request.sha256 ?? "")); break;
                        default: throw new Error("Unknown native state operation");
                    }
                    await stream.write(JSON.stringify({ ok: true, value }));
                    await stream.end();
                } catch (error) {
                    await stream.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
                    await stream.end();
                }
            })().catch(error => stream.close(error instanceof Error ? error.message : String(error))); });
            return;
        }
        if (stream.kind !== "blob") {
            stream.close("this host does not serve streams of that kind");
            return;
        }
        incoming.set(stream.id, []);
        stream.on("data", (chunk: Buffer) => incoming.get(stream.id)?.push(chunk));
        stream.on("close", () => incoming.delete(stream.id));
        stream.on("end", () => {
            const parts = incoming.get(stream.id) ?? [];
            incoming.delete(stream.id);
            try {
                store.put(String(stream.meta.digest ?? ""), Buffer.concat(parts));
                reply(stream, { ok: true });
            } catch (error) {
                reply(stream, { ok: false, error: String((error as Error)?.message ?? error) });
            }
        });
    });

    // A server that speaks over its own input and output: the relay the
    // runtime starts connects here, names its ticket, and becomes a pipe.
    const relayServer: TcpServer = createTcpServer({ noDelay: true }, (socket: Socket) => {
        socket.setNoDelay(true);
        socket.on("error", () => { /* the connection's end is enough */ });
        let header = Buffer.alloc(0);
        const timer = setTimeout(() => socket.destroy(), COMPUTE_RELAY_TICKET_TIMEOUT_MS);
        const onData = (chunk: Buffer) => {
            header = Buffer.concat([header, chunk]);
            const at = header.indexOf(0x0a);
            if (at < 0) {
                if (header.length > MAX_TICKET_BYTES) { clearTimeout(timer); socket.destroy(); }
                return;
            }
            clearTimeout(timer);
            socket.off("data", onData);
            const ticket = header.subarray(0, at).toString("utf8").trim();
            const rest = header.subarray(at + 1);
            let stream: ComputeChannelStream;
            try {
                stream = channel.open("mcp", { ticket });
            } catch {
                socket.destroy();
                return;
            }
            socket.pause();
            stream.on("data", (data: Buffer) => { socket.write(data); });
            stream.on("end", () => socket.end());
            stream.on("close", () => socket.destroy());
            socket.on("data", (data: Buffer) => { void stream.write(data).catch(() => socket.destroy()); });
            socket.on("end", () => { void stream.end().catch(() => { /* already gone */ }); });
            socket.on("close", () => stream.close());
            if (rest.length) void stream.write(rest).catch(() => socket.destroy());
            socket.resume();
        };
        socket.on("data", onData);
    });

    // A server reached over HTTP: the runtime is given a local address
    // here, and every request is handed to the worker as it arrived.
    const httpServer: HttpServer = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
        const url = request.url ?? "/";
        const cut = url.indexOf("/", 1);
        const ticket = decodeURIComponent(cut < 0 ? url.slice(1) : url.slice(1, cut));
        const rest = cut < 0 ? "" : url.slice(cut);
        if (!ticket) {
            response.writeHead(404).end();
            return;
        }
        let stream: ComputeChannelStream;
        try {
            stream = channel.open("mcp-http", {
                ticket,
                method: request.method ?? "GET",
                path: rest,
                headers: request.headers,
            });
        } catch {
            response.writeHead(503).end();
            return;
        }
        let head = false;
        stream.on("data", (chunk: Buffer) => {
            if (!head) {
                head = true;
                try {
                    const answer = JSON.parse(chunk.toString("utf8")) as { status?: number; headers?: Record<string, string> };
                    response.writeHead(Number(answer.status) || 502, answer.headers ?? {});
                } catch {
                    response.writeHead(502).end();
                    stream.close();
                }
                return;
            }
            response.write(chunk);
        });
        stream.on("end", () => response.end());
        stream.on("close", () => { if (!response.writableEnded) response.end(); });
        request.on("data", (chunk: Buffer) => { void stream.write(chunk).catch(() => stream.close()); });
        request.on("end", () => { void stream.end().catch(() => { /* already gone */ }); });
        request.on("error", () => stream.close());
        response.on("close", () => stream.close());
    });

    const listen = (server: TcpServer | HttpServer) => new Promise<number>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen({ host: "127.0.0.1", port: 0 }, () => {
            server.removeListener("error", onError);
            resolve((server.address() as AddressInfo).port);
        });
    });
    channel.start();
    const relayPort = await listen(relayServer);
    const httpPort = await listen(httpServer);
    relayServer.on("error", () => { /* surfaced through the connections */ });
    httpServer.on("error", () => { /* surfaced through the connections */ });

    const relayCommand = options.relayCommand ?? { command: process.execPath, args: [relayPath] };
    await channel.notice({
        t: "ready",
        separator: path.sep,
        relay: { command: relayCommand.command, args: [...relayCommand.args, "--at", `127.0.0.1:${relayPort}`] },
        httpBase: `http://127.0.0.1:${httpPort}/`,
    });

    const close = async () => {
        await new Promise<void>((resolve) => relayServer.close(() => resolve()));
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    };
    channel.on("close", () => { void close().catch(() => { /* going away anyway */ }); });
    return {
        relayAddress: `127.0.0.1:${relayPort}`,
        httpAddress: `127.0.0.1:${httpPort}`,
        close,
    };
}
