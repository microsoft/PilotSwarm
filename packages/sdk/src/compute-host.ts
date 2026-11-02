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
 * It ends itself after a set time with no connection. That is what frees
 * a host nobody came back to: PilotSwarm asks a provider to release a
 * host, but that is a hint and may never arrive, while this clock runs on
 * the host itself. Whatever runs the runtime should end it when this
 * component ends.
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
/**
 * How long a host component stays up with no connection at all before it
 * ends itself.
 *
 * It is the only thing that frees a host nobody came back to. PilotSwarm
 * asks a provider to release a host when a session lets go of it, but that
 * is a hint and may never arrive — a worker can crash, a session can move,
 * a network can go away. The component is on the host, so its clock keeps
 * running whatever happens on the worker's side.
 *
 * A session that is warm holds its connection open, so a host in use is
 * never touched. A session whose host has gone simply gets a new one from
 * its provider at its next turn.
 */
export const COMPUTE_HOST_IDLE_TIMEOUT_MS = 30 * 60_000;

export interface ComputeHostOptions extends ComputeHandshakeCredential {
    /** Listen for the worker's side. `port` 0 asks the operating system for one. */
    listen: { host?: string; port: number };
    /** The runtime's own address on this host, `host:port` or just a port. */
    runtimeAddress: string;
    handshakeTimeoutMs?: number;
    maxConnections?: number;
    /**
     * End the component after this long with no connection — none proved
     * and none still proving itself. Default
     * COMPUTE_HOST_IDLE_TIMEOUT_MS; 0 keeps it up for ever. The clock
     * starts when it does, so a host nobody ever reaches goes away too.
     */
    idleTimeoutMs?: number;
    /**
     * Called after an idle shutdown has closed the component. Whatever
     * runs the runtime should end it here, so the host goes with its
     * component rather than leaving a runtime behind with nothing in
     * front of it.
     */
    onIdle?: () => void;
    /** Told about every connection that ends, so a caller can log or count. */
    onConnectionClosed?: (info: { ok: boolean; error?: Error }) => void;
}

export interface ComputeHostHandle {
    /** Whether it has stopped, by `close()` or by going idle. */
    readonly isClosed: boolean;
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
    /** Connections that have proved themselves and reach the runtime. */
    const live = new Set<Socket>();
    /** Connections part-way through the handshake; they prove nothing yet. */
    const pending = new Set<Socket>();
    const idleTimeoutMs = options.idleTimeoutMs ?? COMPUTE_HOST_IDLE_TIMEOUT_MS;
    let refused = 0;
    let closed = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let stopListening: (() => Promise<void>) | null = null;

    /**
     * The idle clock runs only while nothing at all is connected, and it
     * is deliberately not unref'd: ending the host is this component's
     * job, not a side effect of an empty event loop.
     */
    function armIdle(): void {
        if (idleTimer || closed || idleTimeoutMs <= 0) return;
        if (live.size > 0 || pending.size > 0) return;
        idleTimer = setTimeout(() => {
            idleTimer = null;
            if (closed || live.size > 0 || pending.size > 0) return;
            void (async () => {
                await stopListening?.().catch(() => { /* going away anyway */ });
                options.onIdle?.();
            })();
        }, idleTimeoutMs);
    }

    function disarmIdle(): void {
        if (!idleTimer) return;
        clearTimeout(idleTimer);
        idleTimer = null;
    }

    /** One connection has gone; start the clock again if it was the last. */
    function forget(socket: Socket): void {
        live.delete(socket);
        pending.delete(socket);
        armIdle();
    }

    async function serve(socket: Socket): Promise<void> {
        socket.setNoDelay(true);
        socket.on("error", () => { /* the connection's end is reported below */ });
        disarmIdle();
        pending.add(socket);
        let runtimeSocket: Socket | undefined;
        try {
            if (closed) throw new Error("the host component is closing");
            if (live.size + pending.size > maxConnections) {
                throw new Error("this host component already carries as many connections as it will");
            }
            await runHostHandshake(socket, credential, { timeoutMs: handshakeTimeoutMs, seenNonces });
            pending.delete(socket);
            live.add(socket);
            // Only after both sides have proved themselves does anything
            // reach the runtime.
            runtimeSocket = await dial(runtime.host, runtime.port, COMPUTE_HOST_RUNTIME_CONNECT_TIMEOUT_MS);
            runtimeSocket.on("close", () => { forget(socket); options.onConnectionClosed?.({ ok: true }); });
            join(socket, runtimeSocket);
        } catch (error) {
            const reason = error instanceof Error ? error : new Error(String(error));
            if (reason instanceof ComputeHandshakeError) refused++;
            forget(socket);
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
    stopListening = async () => {
        closed = true;
        disarmIdle();
        for (const socket of [...live, ...pending]) {
            live.delete(socket);
            pending.delete(socket);
            try { socket.destroy(); } catch { /* already gone */ }
        }
        await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    armIdle();
    return {
        get isClosed() { return closed; },
        get address() { return `${bound.address}:${bound.port}`; },
        get connections() { return live.size; },
        get refused() { return refused; },
        async close() { await stopListening!(); },
    };
}
