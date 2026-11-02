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
 * A connection says in its hello what it is for. `runtime` is the
 * session's own stream and is all a connection was ever for. `control` is
 * the side channel (compute-host-services.ts) that carries the read-only
 * copies of a session's folders and the traffic of the MCP servers that
 * stay on the trusted side; it never touches the runtime's port. The
 * purpose is signed into both proofs, so neither connection can be used
 * as the other.
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
import { ComputeChannel } from "./compute-channel.js";
import { ComputeHandshakeError, runHostHandshake, type ComputeHandshakeCredential, type ComputeHandshakePurpose } from "./compute-handshake.js";
import { serveComputeHostControl, type ComputeHostServiceOptions, type ComputeHostServices } from "./compute-host-services.js";

/** The most proved connections one host component carries at a time. */
export const COMPUTE_HOST_MAX_CONNECTIONS = 16;
/**
 * The most connections that may be part-way through proving themselves.
 *
 * Counted apart from the proved ones, and much smaller, because anything
 * that can reach this port can open a connection and then say nothing.
 * Counted together, a handful of silent connections would hold every slot
 * for the whole handshake deadline and the worker could not get in.
 */
export const COMPUTE_HOST_MAX_PENDING_CONNECTIONS = 4;
/**
 * How long a connection has to prove itself. Shorter than the handshake's
 * own deadline, since the worker's side answers at once and anything
 * slower is not the worker.
 */
export const COMPUTE_HOST_PREAUTH_TIMEOUT_MS = 5_000;
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
/**
 * How long a connection may carry no bytes before the operating system
 * starts asking the other end whether it is still there.
 *
 * Idle shutdown is the backstop for a worker that crashed or a network
 * that went away. Without this, such a connection stays open for ever as
 * far as this component can tell, it is counted as live, and the host
 * never ends itself — which is the one thing the backstop exists for.
 */
export const COMPUTE_HOST_KEEPALIVE_MS = 30_000;
/** How often the component looks at how long its connections have been silent. */
export const COMPUTE_HOST_IDLE_SWEEP_MS = 15_000;

/**
 * This binding's secret, taken out of the environment as it is read.
 *
 * It must not be inherited by anything this program starts, and on a host
 * the runtime often is started from the same environment. A provider must
 * not export it to the runtime either: the runtime has its own connection
 * token and has no use for this one.
 */
export function readHandshakeSecret(env: Record<string, string | undefined>): string {
    const secret = env.PILOTSWARM_COMPUTE_HANDSHAKE_SECRET ?? "";
    delete env.PILOTSWARM_COMPUTE_HANDSHAKE_SECRET;
    return secret;
}

export interface ComputeHostOptions extends ComputeHandshakeCredential {
    /** Listen for the worker's side. `port` 0 asks the operating system for one. */
    listen: { host?: string; port: number };
    /** The runtime's own address on this host, `host:port` or just a port. */
    runtimeAddress: string;
    handshakeTimeoutMs?: number;
    maxConnections?: number;
    /** The most connections proving themselves at once. */
    maxPendingConnections?: number;
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
    /**
     * Serve the side channel as well as the runtime stream: the read-only
     * copies of a session's folders, and the way a runtime reaches the
     * servers that stay on the trusted side
     * (compute-host-services.ts). Left out, this component serves the
     * runtime stream alone and refuses a connection that asks for
     * anything else.
     */
    services?: Omit<ComputeHostServiceOptions, "directory"> & { directory: string };
}

export interface ComputeHostHandle {
    /** Whether it has stopped, by `close()` or by going idle. */
    readonly isClosed: boolean;
    /** The side channel's local listeners, once a worker has opened one. */
    readonly services: ComputeHostServices | null;
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
    const handshakeTimeoutMs = options.handshakeTimeoutMs ?? COMPUTE_HOST_PREAUTH_TIMEOUT_MS;
    const maxConnections = options.maxConnections ?? COMPUTE_HOST_MAX_CONNECTIONS;
    const maxPending = options.maxPendingConnections ?? COMPUTE_HOST_MAX_PENDING_CONNECTIONS;
    // One memory of worker nonces for the whole component: a hello this
    // host has already answered is refused however it arrives.
    const seenNonces = new Set<string>();
    const purposes: ComputeHandshakePurpose[] = options.services ? ["runtime", "control"] : ["runtime"];
    /** The side channel's listeners, made when the first control connection is proved. */
    let services: ComputeHostServices | null = null;
    /** Connections that have proved themselves and reach the runtime. */
    const live = new Set<Socket>();
    /** Connections part-way through the handshake; they prove nothing yet. */
    const pending = new Set<Socket>();
    const idleTimeoutMs = options.idleTimeoutMs ?? COMPUTE_HOST_IDLE_TIMEOUT_MS;
    let refused = 0;
    let closed = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let sweeper: ReturnType<typeof setInterval> | null = null;
    let stopListening: (() => Promise<void>) | null = null;
    /** When each connection last carried a byte, so a silent one can be seen. */
    const lastByte = new WeakMap<Socket, number>();

    function endOfIdleness(): void {
        void (async () => {
            await stopListening?.().catch(() => { /* going away anyway */ });
            options.onIdle?.();
        })();
    }

    /**
     * A connection that has carried no bytes for the idle time does not
     * count as company.
     *
     * A worker that crashed, or a network that went away, leaves a
     * connection this end still believes in. Counting it as live is what
     * would keep a host up for ever with nobody on the other end.
     */
    function silent(socket: Socket): boolean {
        const at = lastByte.get(socket) ?? 0;
        return Date.now() - at >= idleTimeoutMs;
    }

    function busy(): boolean {
        if (pending.size > 0) return true;
        for (const socket of live) if (!silent(socket)) return true;
        return false;
    }

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
            endOfIdleness();
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
        // So a connection whose other end has gone without saying so is
        // found rather than believed in for ever.
        try { socket.setKeepAlive(true, COMPUTE_HOST_KEEPALIVE_MS); } catch { /* not every platform */ }
        lastByte.set(socket, Date.now());
        socket.on("data", () => lastByte.set(socket, Date.now()));
        socket.on("error", () => { /* the connection's end is reported below */ });
        disarmIdle();
        pending.add(socket);
        let runtimeSocket: Socket | undefined;
        try {
            if (closed) throw new Error("the host component is closing");
            if (pending.size > maxPending) {
                throw new Error("this host component already has as many connections proving themselves as it will");
            }
            if (live.size >= maxConnections) {
                throw new Error("this host component already carries as many connections as it will");
            }
            const proved = await runHostHandshake(socket, credential, { timeoutMs: handshakeTimeoutMs, seenNonces, purposes });
            pending.delete(socket);
            live.add(socket);
            if (proved.purpose === "control") {
                // The side channel: copies in, and the servers that stay
                // on the trusted side reached back out. It never touches
                // the runtime's port.
                const channel = new ComputeChannel(socket, { side: "host" });
                socket.on("close", () => { forget(socket); options.onConnectionClosed?.({ ok: true }); });
                const made = await serveComputeHostControl(channel, options.services!);
                services = made;
                channel.on("close", () => { if (services === made) services = null; });
                return;
            }
            // Only after both sides have proved themselves does anything
            // reach the runtime.
            runtimeSocket = await dial(runtime.host, runtime.port, COMPUTE_HOST_RUNTIME_CONNECT_TIMEOUT_MS);
            try { runtimeSocket.setKeepAlive(true, COMPUTE_HOST_KEEPALIVE_MS); } catch { /* not every platform */ }
            runtimeSocket.on("data", () => lastByte.set(socket, Date.now()));
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
    if (idleTimeoutMs > 0) {
        sweeper = setInterval(() => {
            // With nothing connected at all the ordinary clock applies;
            // this is only for connections that are open and silent.
            if (closed || live.size === 0 || busy()) return;
            endOfIdleness();
        }, Math.min(COMPUTE_HOST_IDLE_SWEEP_MS, Math.max(1_000, Math.floor(idleTimeoutMs / 2))));
        sweeper.unref?.();
    }
    stopListening = async () => {
        closed = true;
        disarmIdle();
        if (sweeper) { clearInterval(sweeper); sweeper = null; }
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
        get services() { return services; },
        get address() { return `${bound.address}:${bound.port}`; },
        get connections() { return live.size; },
        get refused() { return refused; },
        async close() { await stopListening!(); },
    };
}
