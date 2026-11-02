/**
 * The PilotSwarm host component
 * (docs/proposals/compute-providers.md, "The handshake and host component").
 *
 * A small program that runs on a compute host, next to the agent runtime
 * and nothing else. It answers the worker's handshake and, once the two
 * ends have proved they hold the same per-binding secret, carries bytes
 * between the worker and the runtime's local port and does nothing else
 * with them. The runtime's own connection token still travels inside and
 * is still checked by the runtime, so the host component grants nothing by
 * itself.
 *
 * It exists so the handshake is the same everywhere. A provider does not
 * write one: it places this component and the binding's secret on the
 * host, and hands the worker the same secret.
 *
 * The component listens and the worker's side connects in, so the host
 * must be one the worker can reach at an address. A host that can only
 * reach outwards is left for later (the proposal's future work).
 *
 * The component is the host's end of exactly one binding: it refuses a
 * hello that names another, and it never reaches anything but the one
 * runtime address it was given.
 *
 * The handshake proves who is at each end of a connection. It does not
 * protect what crosses it, so the network between the worker and this
 * host must be private or otherwise protected.
 */
import { connect as netConnect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { COMPUTE_HANDSHAKE_TIMEOUT_MS, ComputeHandshakeError, runHostHandshake, type ComputeHandshakeCredential } from "./compute-handshake.js";

/** The most connections one host component carries at a time. */
export const COMPUTE_HOST_MAX_CONNECTIONS = 16;
/** How long the component waits for the runtime's port to accept. */
export const COMPUTE_HOST_RUNTIME_CONNECT_TIMEOUT_MS = 15_000;

export interface ComputeHostOptions extends ComputeHandshakeCredential {
    /** Listen for the worker's side. `port` 0 asks the operating system for one. */
    listen: { host?: string; port: number };
    /** The runtime's own address on this host, `host:port` or just a port. */
    runtimeAddress: string;
    handshakeTimeoutMs?: number;
    maxConnections?: number;
    /** Told about every connection that ends, so a caller can log or count. */
    onConnectionClosed?: (info: { ok: boolean; error?: Error }) => void;
}

export interface ComputeHostHandle {
    /** Where the worker's side connects, `host:port`. */
    readonly address: string;
    /** How many connections are carried right now. */
    readonly connections: number;
    /** How many handshakes have been refused since it started. */
    readonly refused: number;
    close(): Promise<void>;
}

function parseAddress(address: string): { host: string; port: number } {
    const raw = String(address ?? "").trim();
    if (!raw) throw new Error("the host component needs the runtime's address");
    if (/^\d+$/.test(raw)) return { host: "127.0.0.1", port: Number(raw) };
    const at = raw.lastIndexOf(":");
    if (at <= 0) throw new Error(`"${address}" is not a runtime address`);
    const host = raw.slice(0, at).replace(/^\[|\]$/g, "");
    const port = Number(raw.slice(at + 1));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`"${address}" is not a runtime address`);
    return { host, port };
}

function dial(host: string, port: number, timeoutMs: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = netConnect({ host, port, noDelay: true });
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`nothing accepted at ${host}:${port} within ${timeoutMs} ms`));
        }, timeoutMs);
        socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
        socket.once("error", (error) => { clearTimeout(timer); reject(error); });
    });
}

/** Join two streams, so the end of either ends both. */
function join(a: Socket, b: Socket): void {
    const close = () => { a.destroy(); b.destroy(); };
    a.on("error", close);
    b.on("error", close);
    a.on("close", close);
    b.on("close", close);
    a.pipe(b);
    b.pipe(a);
}

/**
 * Start the host component. Resolves once it is listening and ready for
 * the worker's side.
 */
export async function startComputeHost(options: ComputeHostOptions): Promise<ComputeHostHandle> {
    if (!options.listen) throw new Error("a host component needs the address to listen on");
    const runtime = parseAddress(options.runtimeAddress);
    const credential: ComputeHandshakeCredential = { bindingId: options.bindingId, secret: options.secret };
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? COMPUTE_HANDSHAKE_TIMEOUT_MS;
    const maxConnections = options.maxConnections ?? COMPUTE_HOST_MAX_CONNECTIONS;
    // One memory of worker nonces for the whole component: a hello this
    // host has already answered is refused however it arrives.
    const seenNonces = new Set<string>();
    const live = new Set<Socket>();
    let refused = 0;
    let closed = false;

    async function serve(socket: Socket): Promise<void> {
        socket.setNoDelay(true);
        socket.on("error", () => { /* the connection's end is reported below */ });
        live.add(socket);
        let runtimeSocket: Socket | undefined;
        try {
            if (closed) throw new Error("the host component is closing");
            if (live.size > maxConnections) {
                throw new Error("this host component already carries as many connections as it will");
            }
            await runHostHandshake(socket, credential, { timeoutMs: handshakeTimeoutMs, seenNonces });
            // Only after both sides have proved themselves does anything
            // reach the runtime.
            runtimeSocket = await dial(runtime.host, runtime.port, COMPUTE_HOST_RUNTIME_CONNECT_TIMEOUT_MS);
            runtimeSocket.on("close", () => { live.delete(socket); options.onConnectionClosed?.({ ok: true }); });
            join(socket, runtimeSocket);
        } catch (error) {
            const reason = error instanceof Error ? error : new Error(String(error));
            if (reason instanceof ComputeHandshakeError) refused++;
            live.delete(socket);
            try { runtimeSocket?.destroy(); } catch { /* already gone */ }
            socket.destroy();
            options.onConnectionClosed?.({ ok: false, error: reason });
        }
    }

    const server: Server = createServer({ noDelay: true });
    server.on("connection", (socket) => { void serve(socket); });
    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen({ host: options.listen.host ?? "127.0.0.1", port: options.listen.port }, () => {
            server.removeListener("error", onError);
            resolve();
        });
    });
    server.on("error", () => { /* surfaced through the connections */ });
    const bound = server.address() as AddressInfo;
    return {
        get address() { return `${bound.address}:${bound.port}`; },
        get connections() { return live.size; },
        get refused() { return refused; },
        async close() {
            closed = true;
            for (const socket of [...live]) { live.delete(socket); try { socket.destroy(); } catch { /* already gone */ } }
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}
