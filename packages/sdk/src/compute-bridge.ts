/**
 * The bridge in front of a provider that opens its own connections
 * (docs/proposals/compute-providers.md, "Transport contract").
 *
 * PilotSwarm's control plane sees a pipe and nothing else: a two-way byte
 * stream to one host's runtime. It does not know, and must never need to
 * know, what the pipe is made of. The code that makes one lives in the
 * provider and arrives with the installed provider — never with a
 * registered target.
 *
 * The runtime is driven through the Copilot SDK, which can only connect to
 * an address. So the bridge is the smallest thing that turns a pipe into
 * one: a listener on this machine that, for each connection it accepts,
 * asks the provider for a fresh pipe and joins the two. One bridge per
 * session binding, listening on loopback only, on a port the operating
 * system picks and that nothing outside the worker is told. Every
 * connection it accepts goes to that one binding's host and no other, and
 * it closes with the binding.
 *
 * The bridge carries bytes and judges none of them. The runtime's own
 * connection token still travels inside the pipe and is still checked at
 * the far end, so reaching the bridge grants nothing — exactly as reaching
 * a runtime's own loopback port grants nothing today.
 */
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";

/** How long a pipe has to open before the attempt is abandoned. */
export const COMPUTE_PIPE_OPEN_TIMEOUT_MS = 30_000;
/**
 * The most connections one bridge carries at a time. The SDK needs very
 * few; the cap stops anything else on the machine from making a bridge
 * open pipes without end.
 */
export const COMPUTE_BRIDGE_MAX_CONNECTIONS = 8;

/**
 * A listener on this machine standing in for one host's runtime.
 *
 * `openPipe` is the provider's own `openConnection`, already bound to its
 * host: the bridge calls it once per accepted connection, so two
 * connections to the same host never share one pipe, and a connection that
 * breaks is replaced by a fresh pipe rather than a dead one.
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
        private readonly options: { openTimeoutMs?: number; maxConnections?: number } = {},
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
            pipe = await this.openWithDeadline();
            if (this.closed) throw new Error("the compute bridge is closed");
            if (!pipe || typeof pipe.pipe !== "function" || typeof pipe.write !== "function") {
                throw new Error("the compute provider did not return a two-way stream");
            }
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
     * Ask the provider for a pipe, and give up on it when its deadline
     * passes. The deadline is the bridge's own: a provider is told through
     * the signal, but a provider that ignores it still cannot leave a
     * connection waiting for ever. A pipe that turns up after that is
     * thrown away rather than used.
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
                reject(new Error(`the compute provider did not open a connection within ${timeoutMs} ms`));
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
     * Prove the provider can reach the host, before the worker tells the
     * SDK to connect. One pipe is opened and dropped.
     *
     * Without this, a host that cannot be reached shows up as whatever the
     * SDK makes of a connection that dies on it — a raw socket error with
     * nothing in it about compute. With it, the turn fails where every
     * other compute failure is raised, saying what actually went wrong.
     *
     * Once per bridge, so once per binding rather than once per turn.
     */
    async verify(): Promise<void> {
        const pipe = await this.openWithDeadline();
        if (!pipe || typeof pipe.pipe !== "function" || typeof pipe.write !== "function") {
            throw new Error("the compute provider did not return a two-way stream");
        }
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
