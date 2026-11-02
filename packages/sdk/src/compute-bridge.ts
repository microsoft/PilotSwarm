/**
 * The bridge in front of every runtime that is not the worker's own child
 * process (docs/proposals/compute-providers.md, "Transport contract").
 *
 * PilotSwarm's control plane sees a pipe and nothing else: a two-way byte
 * stream to one host's runtime. Every host this build reaches is reached
 * at an address, and PilotSwarm opens the connection itself
 * (`openTcpPipe`), so there is one path and not two. The opener is
 * injected rather than called directly only so the tests can stand in a
 * stream of their own.
 *
 * Every remote connection goes through the bridge, which is what makes the
 * handshake uniform: the bridge opens a pipe, proves to the host that it
 * holds this binding's secret and makes the host prove the same, and only
 * then joins the pipe to the connection the SDK made. A pipe that fails
 * the handshake is destroyed and the connection dies carrying the reason.
 *
 * The runtime is driven through the Copilot SDK, which can only connect to
 * an address. So the bridge is the smallest thing that turns a pipe into
 * one: a listener on this machine that, for each connection it accepts,
 * asks for a fresh pipe and joins the two. One bridge per session binding,
 * listening on loopback only, on a port the operating system picks and
 * that nothing outside the worker is told. Every connection it accepts
 * goes to that one binding's host and no other, and it closes with the
 * binding.
 *
 * Past the handshake the bridge carries bytes and judges none of them. It
 * serves whoever connects to it on this machine, so what keeps reaching it
 * worthless is the runtime's own connection token, which travels inside
 * the pipe and is still checked at the far end. That token is required of
 * every remote endpoint (`checkRemoteEndpoint`), because a session that
 * runs on the worker is model-chosen code on this same machine.
 *
 * The handshake proves who is at each end of a connection. It does not
 * protect what crosses it: past `ok` the stream is a plain pass-through,
 * so the network between the worker and the host must be private or
 * otherwise protected.
 */
import { connect as netConnect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { COMPUTE_HANDSHAKE_TIMEOUT_MS, runWorkerHandshake, type ComputeHandshakeCredential } from "./compute-handshake.js";

/** How long a pipe has to open before the attempt is abandoned. */
export const COMPUTE_PIPE_OPEN_TIMEOUT_MS = 30_000;
/**
 * The most connections one bridge carries at a time. The SDK needs very
 * few; the cap stops anything else on the machine from making a bridge
 * open pipes without end.
 */
export const COMPUTE_BRIDGE_MAX_CONNECTIONS = 8;

/**
 * The way a pipe is opened: a connection to the host's address. The
 * provider returns an address and PilotSwarm connects to it, so no
 * provider carries transport code and every host travels the same path
 * from here on.
 */
export function openTcpPipe(address: string, signal: AbortSignal, timeoutMs = COMPUTE_PIPE_OPEN_TIMEOUT_MS): Promise<Duplex> {
    const raw = String(address ?? "").trim();
    const at = raw.lastIndexOf(":");
    const port = at > 0 ? Number(raw.slice(at + 1)) : NaN;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        return Promise.reject(new Error(`"${address}" is not a runtime address`));
    }
    const host = raw.slice(0, at).replace(/^\[|\]$/g, "");
    return new Promise<Duplex>((resolve, reject) => {
        const socket = netConnect({ host, port, noDelay: true });
        const give = (error: Error) => { socket.destroy(); reject(error); };
        const timer = setTimeout(() => give(new Error(`nothing accepted at ${host}:${port} within ${timeoutMs} ms`)), timeoutMs);
        const onAbort = () => { clearTimeout(timer); give(new Error("the attempt to reach the host was abandoned")); };
        signal.addEventListener("abort", onAbort, { once: true });
        socket.once("connect", () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            resolve(socket);
        });
        socket.once("error", (error) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            reject(error);
        });
    });
}

/**
 * A listener on this machine standing in for one host's runtime.
 *
 * `openPipe` opens one connection to this host's address: the bridge calls
 * it once per accepted connection, so two connections to the same host
 * never share one pipe, and a connection that breaks is replaced by a
 * fresh pipe rather than a dead one.
 */
export class ComputeRuntimeBridge {
    private server: Server | null = null;
    private readonly live = new Set<{ socket: Socket; pipe: Duplex }>();
    private closed = false;
    private port = 0;
    /** The last reason a pipe could not be opened, for the error a turn shows. */
    lastOpenError: Error | null = null;

    constructor(
        private readonly openPipe: (signal: AbortSignal) => Promise<Duplex>,
        private readonly options: {
            openTimeoutMs?: number;
            maxConnections?: number;
            /**
             * This binding's secret, for the mutual handshake the worker
             * runs over every pipe before anything else crosses. A
             * function is read at each open, so a binding that is
             * re-connected keeps one bridge (and so one address, and so
             * one pooled client) while the secret and the way to the host
             * stay current.
             */
            handshake?: ComputeHandshakeCredential | (() => ComputeHandshakeCredential | undefined);
            handshakeTimeoutMs?: number;
        } = {},
    ) {}

    /** The address the SDK connects to. Meaningful only once `start` has resolved. */
    get address(): string {
        return `127.0.0.1:${this.port}`;
    }

    /** How many connections are open through the bridge right now. */
    get openConnections(): number {
        return this.live.size;
    }

    get isClosed(): boolean {
        return this.closed;
    }

    /**
     * Listen on loopback, on a port the operating system picks. Loopback
     * only: nothing off this machine can reach a session's runtime through
     * the bridge, which is what makes a bridged endpoint satisfy the
     * worker's local-addresses rule by construction.
     */
    async start(): Promise<void> {
        if (this.closed) throw new Error("this compute bridge is closed");
        if (this.server) return;
        const server = createServer({ noDelay: true });
        server.on("connection", (socket) => { void this.accept(socket); });
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => reject(error);
            server.once("error", onError);
            server.listen({ host: "127.0.0.1", port: 0 }, () => {
                server.removeListener("error", onError);
                resolve();
            });
        });
        // After listening, a server error belongs to the connection that hit
        // it, not to the process.
        server.on("error", () => { /* surfaced through the connections */ });
        this.port = (server.address() as AddressInfo).port;
        this.server = server;
    }

    private async accept(socket: Socket): Promise<void> {
        socket.setNoDelay(true);
        // Ending a connection with a reason makes the socket emit it. The
        // bridge reports the reason itself (`lastOpenError`, and the turn's
        // error); the event must not become an unhandled one.
        socket.on("error", () => { /* reported where it can be acted on */ });
        let pipe: Duplex | undefined;
        try {
            if (this.closed) throw new Error("the compute bridge is closed");
            if (this.live.size >= (this.options.maxConnections ?? COMPUTE_BRIDGE_MAX_CONNECTIONS)) {
                throw new Error("this compute bridge already carries as many connections as it will");
            }
            pipe = await this.openProven();
            if (this.closed) throw new Error("the compute bridge is closed");
            this.join(socket, pipe);
        } catch (error) {
            // A connection that cannot be opened must fail where it can be
            // seen, not hang: the socket dies carrying the reason.
            const reason = error instanceof Error ? error : new Error(String(error));
            this.lastOpenError = reason;
            try { pipe?.destroy(); } catch { /* already gone */ }
            socket.destroy(reason);
        }
    }

    /**
     * One usable pipe: opened, shaped like a two-way stream, and with the
     * handshake done. Nothing the bridge hands on has skipped this.
     *
     * The handshake comes first, before the pipe is joined to anything, so
     * a host that cannot prove itself never sees a byte of the worker's
     * traffic and the connection dies carrying the reason.
     */
    private async openProven(): Promise<Duplex> {
        const pipe = await this.openWithDeadline();
        if (!pipe || typeof pipe.pipe !== "function" || typeof pipe.write !== "function") {
            try { (pipe as Duplex | undefined)?.destroy(); } catch { /* nothing to destroy */ }
            throw new Error("opening the connection to the compute host did not give a two-way stream");
        }
        const handshake = typeof this.options.handshake === "function"
            ? this.options.handshake()
            : this.options.handshake;
        if (handshake) {
            try {
                await runWorkerHandshake(pipe, handshake, {
                    timeoutMs: this.options.handshakeTimeoutMs ?? COMPUTE_HANDSHAKE_TIMEOUT_MS,
                });
            } catch (error) {
                try { pipe.destroy(); } catch { /* already gone */ }
                throw error;
            }
        }
        return pipe;
    }

    /**
     * Open a pipe, and give up on it when its deadline passes. The
     * deadline is the bridge's own: the opener is told through the signal,
     * but one that ignores it still cannot leave a connection waiting for
     * ever. A pipe that turns up after that is thrown away rather than
     * used.
     */
    private openWithDeadline(): Promise<Duplex> {
        const controller = new AbortController();
        const timeoutMs = this.options.openTimeoutMs ?? COMPUTE_PIPE_OPEN_TIMEOUT_MS;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const attempt = Promise.resolve().then(() => this.openPipe(controller.signal));
        attempt.then(
            (pipe) => { if (settled) { try { pipe?.destroy(); } catch { /* already gone */ } } },
            () => { /* reported below, or already abandoned */ },
        );
        return new Promise<Duplex>((resolve, reject) => {
            timer = setTimeout(() => {
                settled = true;
                controller.abort();
                reject(new Error(`the connection to the compute host did not open within ${timeoutMs} ms`));
            }, timeoutMs);
            attempt.then(
                (pipe) => { if (!settled) { settled = true; clearTimeout(timer); resolve(pipe); } },
                (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } },
            );
        });
    }

    /** Join the two streams, so the end of either ends both. */
    private join(socket: Socket, pipe: Duplex): void {
        const entry = { socket, pipe };
        this.live.add(entry);
        const close = (error?: Error) => {
            if (!this.live.delete(entry)) return;
            if (error) {
                socket.destroy(error);
                pipe.destroy(error);
            } else {
                socket.destroy();
                pipe.destroy();
            }
        };
        socket.on("error", close);
        pipe.on("error", close);
        socket.on("close", () => close());
        pipe.on("close", () => close());
        socket.pipe(pipe);
        pipe.pipe(socket);
    }

    /**
     * Prove the host can be reached and is the host this binding was
     * given, before the worker tells the SDK to connect. One pipe is
     * opened, handshaken and dropped.
     *
     * Without this, a host that cannot be reached shows up as whatever the
     * SDK makes of a connection that dies on it — a raw socket error with
     * nothing in it about compute. With it, the turn fails where every
     * other compute failure is raised, saying what actually went wrong,
     * and a wrong secret fails the turn before a single prompt or model
     * request leaves the worker.
     *
     * Once per bridge, so once per binding rather than once per turn.
     */
    async verify(): Promise<void> {
        const pipe = await this.openProven();
        try { pipe.destroy(); } catch { /* already gone */ }
    }

    /** Stop listening and drop every connection: the session has left the host. */
    async close(): Promise<void> {
        this.closed = true;
        for (const entry of [...this.live]) {
            this.live.delete(entry);
            try { entry.socket.destroy(); } catch { /* already gone */ }
            try { entry.pipe.destroy(); } catch { /* already gone */ }
        }
        const server = this.server;
        this.server = null;
        if (!server) return;
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}
