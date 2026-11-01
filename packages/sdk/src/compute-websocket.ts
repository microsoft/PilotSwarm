/**
 * A WebSocket as a two-way byte stream, for provider services whose hosts
 * are not reachable at an address
 * (docs/proposals/compute-providers.md, "Provider services").
 *
 * A registered provider service declares one of two transports. `direct`
 * means its hosts are reachable and PilotSwarm connects to the address its
 * `connect` returned. `pipe` means they are not: `connect` returns a URL
 * instead, and the worker opens an ordinary WebSocket to it, with the same
 * credentials it uses for the service's other calls, and treats the
 * connection as a pipe. The service carries the bytes to the host however
 * it likes — that is its business and PilotSwarm never asks.
 *
 * WebSocket is used because it is the one two-way byte stream that goes
 * wherever ordinary web traffic goes, over the same TLS and the same
 * credentials as the rest of the protocol. Nothing here is specific to any
 * product: the far end is a standard WebSocket endpoint.
 *
 * Only what a byte stream needs is implemented: binary data frames in both
 * directions, close, and ping/pong. Fragments are carried straight through,
 * since a byte stream has no message boundaries to keep. Client frames are
 * masked and server frames are not, as the protocol requires.
 */
import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions as HttpsRequestOptions } from "node:https";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";

/** The fixed string the protocol mixes into the handshake answer. */
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** The most one frame may carry, so nothing on the far end can make us buffer. */
export const COMPUTE_WEBSOCKET_MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** How long the opening exchange has. */
export const COMPUTE_WEBSOCKET_OPEN_TIMEOUT_MS = 30_000;

function acceptFor(key: string): string {
    return createHash("sha1").update(key + WEBSOCKET_GUID, "utf8").digest("base64");
}

/**
 * One end of a WebSocket, as a Duplex of the payload bytes.
 *
 * `masked` says which end this is: a client masks what it sends, a server
 * does not. Everything else is the same on both sides.
 */
class WebSocketDuplex extends Duplex {
    private buffered: Buffer = Buffer.alloc(0);
    private closing = false;

    constructor(private readonly socket: Socket, private readonly masked: boolean) {
        super();
        socket.setNoDelay(true);
        socket.on("data", (chunk: Buffer) => {
            this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
            this.parse();
        });
        socket.on("error", (error) => this.destroy(error));
        socket.on("close", () => { if (!this.closing) this.push(null); this.closing = true; });
        socket.on("end", () => this.push(null));
    }

    private parse(): void {
        for (;;) {
            const frame = this.buffered;
            if (frame.length < 2) return;
            const opcode = frame[0] & 0x0f;
            const isMasked = (frame[1] & 0x80) !== 0;
            let length = frame[1] & 0x7f;
            let at = 2;
            if (length === 126) {
                if (frame.length < 4) return;
                length = frame.readUInt16BE(2);
                at = 4;
            } else if (length === 127) {
                if (frame.length < 10) return;
                const big = frame.readBigUInt64BE(2);
                if (big > BigInt(COMPUTE_WEBSOCKET_MAX_FRAME_BYTES)) {
                    this.destroy(new Error("a WebSocket frame is larger than this build reads"));
                    return;
                }
                length = Number(big);
                at = 10;
            }
            if (length > COMPUTE_WEBSOCKET_MAX_FRAME_BYTES) {
                this.destroy(new Error("a WebSocket frame is larger than this build reads"));
                return;
            }
            const maskAt = at;
            if (isMasked) at += 4;
            if (frame.length < at + length) return;
            let payload = frame.subarray(at, at + length);
            if (isMasked) {
                const mask = frame.subarray(maskAt, maskAt + 4);
                const unmasked = Buffer.allocUnsafe(length);
                for (let i = 0; i < length; i++) unmasked[i] = payload[i] ^ mask[i & 3];
                payload = unmasked;
            }
            this.buffered = frame.subarray(at + length);
            if (opcode === 0x8) {
                this.closing = true;
                this.sendFrame(0x8, Buffer.alloc(0));
                this.push(null);
                this.socket.end();
                return;
            }
            if (opcode === 0x9) { this.sendFrame(0xa, payload); continue; }
            if (opcode === 0xa) continue;
            // 0x0 continuation, 0x1 text, 0x2 binary: a byte stream keeps
            // no message boundaries, so every data byte goes straight on.
            if (payload.length) this.push(payload);
        }
    }

    private sendFrame(opcode: number, payload: Buffer): void {
        if (this.socket.destroyed) return;
        const header: number[] = [0x80 | opcode];
        const length = payload.length;
        const maskBit = this.masked ? 0x80 : 0;
        if (length < 126) header.push(maskBit | length);
        else if (length < 65536) header.push(maskBit | 126, (length >> 8) & 0xff, length & 0xff);
        else {
            header.push(maskBit | 127);
            const big = Buffer.allocUnsafe(8);
            big.writeBigUInt64BE(BigInt(length));
            for (const byte of big) header.push(byte);
        }
        if (!this.masked) {
            this.socket.write(Buffer.concat([Buffer.from(header), payload]));
            return;
        }
        const mask = randomBytes(4);
        const body = Buffer.allocUnsafe(length);
        for (let i = 0; i < length; i++) body[i] = payload[i] ^ mask[i & 3];
        this.socket.write(Buffer.concat([Buffer.from(header), mask, body]));
    }

    override _write(chunk: Buffer | string, encoding: BufferEncoding, done: (error?: Error | null) => void): void {
        try {
            const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
            // Frames are bounded, so a large write becomes several.
            for (let at = 0; at < payload.length; at += COMPUTE_WEBSOCKET_MAX_FRAME_BYTES) {
                this.sendFrame(0x2, payload.subarray(at, at + COMPUTE_WEBSOCKET_MAX_FRAME_BYTES));
            }
            done();
        } catch (error) {
            done(error as Error);
        }
    }

    override _read(): void { /* pushed as frames arrive */ }

    override _final(done: (error?: Error | null) => void): void {
        this.closing = true;
        this.sendFrame(0x8, Buffer.alloc(0));
        this.socket.end();
        done();
    }

    override _destroy(error: Error | null, done: (error: Error | null) => void): void {
        this.closing = true;
        try { this.socket.destroy(); } catch { /* already gone */ }
        done(error);
    }
}

export interface ComputeWebSocketClientOptions {
    /** Sent with the opening request: the credentials the deployment's hook supplies. */
    headers?: Record<string, string>;
    /** TLS checks for an `https`/`wss` URL, as the service's registration pins them. */
    tls?: Pick<HttpsRequestOptions, "servername" | "checkServerIdentity" | "ca" | "rejectUnauthorized">;
    signal?: AbortSignal;
    timeoutMs?: number;
}

/**
 * Open a WebSocket and hand back the byte stream. `wss:`/`https:` go over
 * TLS with whatever checks the caller pinned; `ws:`/`http:` are for a
 * service on this machine, in tests.
 */
export function openComputeWebSocket(url: string, options: ComputeWebSocketClientOptions = {}): Promise<Duplex> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return Promise.reject(new Error(`"${url}" is not a connection URL`));
    }
    const secure = parsed.protocol === "wss:" || parsed.protocol === "https:";
    if (!secure && parsed.protocol !== "ws:" && parsed.protocol !== "http:") {
        return Promise.reject(new Error(`a compute connection URL is ws: or wss:, not "${parsed.protocol}"`));
    }
    const key = randomBytes(16).toString("base64");
    const timeoutMs = options.timeoutMs ?? COMPUTE_WEBSOCKET_OPEN_TIMEOUT_MS;
    return new Promise<Duplex>((resolve, reject) => {
        const send = secure ? httpsRequest : httpRequest;
        const req = send({
            protocol: secure ? "https:" : "http:",
            hostname: parsed.hostname,
            port: parsed.port || (secure ? 443 : 80),
            path: `${parsed.pathname}${parsed.search}`,
            method: "GET",
            headers: {
                ...(options.headers ?? {}),
                Host: parsed.host,
                Connection: "Upgrade",
                Upgrade: "websocket",
                "Sec-WebSocket-Key": key,
                "Sec-WebSocket-Version": "13",
            },
            ...(secure ? options.tls ?? {} : {}),
        });
        let settled = false;
        const give = (error: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { req.destroy(); } catch { /* already gone */ }
            reject(error);
        };
        const timer = setTimeout(() => give(new Error(`the connection to ${parsed.host} was not accepted within ${timeoutMs} ms`)), timeoutMs);
        options.signal?.addEventListener("abort", () => give(new Error("the attempt to open the connection was abandoned")), { once: true });
        req.on("upgrade", (res: IncomingMessage, socket: Socket, head: Buffer) => {
            if (settled) { socket.destroy(); return; }
            const accept = String(res.headers["sec-websocket-accept"] ?? "");
            if (accept !== acceptFor(key)) {
                socket.destroy();
                give(new Error("the far end did not answer the WebSocket handshake correctly"));
                return;
            }
            settled = true;
            clearTimeout(timer);
            const stream = new WebSocketDuplex(socket, true);
            if (head?.length) socket.unshift(head);
            resolve(stream);
        });
        req.on("response", (res: IncomingMessage) => {
            res.resume();
            give(new Error(`the far end answered ${res.statusCode} instead of opening a connection`));
        });
        req.on("error", give);
        req.end();
    });
}

/**
 * Serve WebSocket connections on an HTTP server, at one path.
 *
 * `authorize` sees the opening request's headers — the same credentials as
 * every other call — and says whether to accept. An unauthorized upgrade
 * gets a plain refusal and the socket is dropped.
 */
export function serveComputeWebSocket(
    server: HttpServer,
    options: {
        path: string;
        authorize: (req: IncomingMessage) => boolean | Promise<boolean>;
        onConnection: (stream: Duplex, req: IncomingMessage) => void | Promise<void>;
    },
): void {
    server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
        void (async () => {
            const path = (req.url ?? "").split("?")[0];
            const key = String(req.headers["sec-websocket-key"] ?? "");
            if (path !== options.path || !key || String(req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
                socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
                return;
            }
            let allowed = false;
            try {
                allowed = await options.authorize(req);
            } catch {
                allowed = false;
            }
            if (!allowed) {
                socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
                return;
            }
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + `Sec-WebSocket-Accept: ${acceptFor(key)}\r\n\r\n`);
            const stream = new WebSocketDuplex(socket, false);
            if (head?.length) socket.unshift(head);
            await options.onConnection(stream, req);
        })().catch(() => { try { socket.destroy(); } catch { /* already gone */ } });
    });
}
