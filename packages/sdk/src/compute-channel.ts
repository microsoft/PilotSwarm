/**
 * The side channel between a worker and a compute host
 * (docs/proposals/compute-providers.md, "Skills and MCP servers on remote
 * sessions").
 *
 * A session's turn travels down one connection to the host: the runtime
 * stream. Two other things have to travel between the same two ends — the
 * read-only copies of a session's skill and package folders, and the MCP
 * traffic of the servers that stay on the trusted side — and neither of
 * them belongs inside the runtime's own protocol.
 *
 * So the worker opens a second connection to the same host component,
 * proved by the same handshake and named `control` in its hello. This
 * module is what runs over it: length-prefixed frames carrying notices and
 * any number of independent byte streams, so one connection can carry a
 * file copy and several MCP conversations at once without any of them
 * waiting for another.
 *
 * It judges nothing it carries. A stream is opened with a kind and a small
 * object of its own, and after that it is bytes in both directions until
 * one end finishes. That is deliberate: the MCP traffic that crosses it is
 * forwarded, not interpreted, so whatever the runtime and the server
 * support keeps working.
 *
 * What it does enforce is size: a frame is bounded, a notice is bounded,
 * and one channel carries a bounded number of streams at a time. A peer
 * that breaks any of those ends the channel rather than being allowed to
 * make the other end buffer without limit.
 *
 * Frame layout, big-endian:
 *
 *   u8  type     notice | open | data | end | close
 *   u32 stream   0 for a notice
 *   u32 length   payload bytes, bounded
 *   …   payload  UTF-8 JSON for notice/open/close, raw bytes for data
 *
 * Stream numbers are allocated from different halves at the two ends —
 * the worker takes the even ones, the host the odd ones — so neither has
 * to ask the other for a number.
 */
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";

/** The most one frame's payload may carry. */
export const COMPUTE_CHANNEL_MAX_FRAME_BYTES = 1024 * 1024;
/** The most a notice or a stream's opening object may carry. */
export const COMPUTE_CHANNEL_MAX_NOTICE_BYTES = 64 * 1024;
/** The most streams one channel carries at a time. */
export const COMPUTE_CHANNEL_MAX_STREAMS = 64;

const FRAME_HEADER_BYTES = 9;
const TYPE_NOTICE = 1;
const TYPE_OPEN = 2;
const TYPE_DATA = 3;
const TYPE_END = 4;
const TYPE_CLOSE = 5;

/** Which end of the channel this is; it decides which stream numbers it may allocate. */
export type ComputeChannelSide = "worker" | "host";

export interface ComputeChannelOptions {
    side: ComputeChannelSide;
    maxFrameBytes?: number;
    maxStreams?: number;
}

function frame(type: number, streamId: number, payload: Buffer): Buffer {
    const header = Buffer.allocUnsafe(FRAME_HEADER_BYTES);
    header.writeUInt8(type, 0);
    header.writeUInt32BE(streamId, 1);
    header.writeUInt32BE(payload.length, 5);
    return payload.length ? Buffer.concat([header, payload]) : header;
}

/**
 * One byte stream inside a channel.
 *
 * `data` arrives as it is read, `end` says the other side has finished
 * writing, and `close` says the stream is over in both directions. Writing
 * resolves when the bytes have been handed to the connection, so a sender
 * that awaits it cannot run ahead of a slow link.
 */
export class ComputeChannelStream extends EventEmitter {
    private writeEnded = false;
    private closed = false;
    private holding = false;

    constructor(
        private readonly channel: ComputeChannel,
        readonly id: number,
        readonly kind: string,
        readonly meta: Record<string, unknown>,
    ) {
        super();
    }

    get isClosed(): boolean {
        return this.closed;
    }

    /** Send bytes. Resolves once the connection has taken them. */
    async write(chunk: Buffer | string): Promise<void> {
        if (this.closed) throw new Error("this stream is closed");
        if (this.writeEnded) throw new Error("this stream has already been finished");
        const body = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        const limit = this.channel.maxFrameBytes;
        for (let at = 0; at < body.length; at += limit) {
            await this.channel.send(TYPE_DATA, this.id, body.subarray(at, Math.min(at + limit, body.length)));
        }
        if (body.length === 0) await this.channel.send(TYPE_DATA, this.id, Buffer.alloc(0));
    }

    /** Finish writing. The other side sees `end`; it may still be writing back. */
    async end(): Promise<void> {
        if (this.closed || this.writeEnded) return;
        this.writeEnded = true;
        await this.channel.send(TYPE_END, this.id, Buffer.alloc(0));
    }

    /**
     * Stop reading the connection until this stream lets go.
     *
     * What a stream hands on — a server's own input, a response being
     * written — can take bytes more slowly than the link delivers them.
     * Holding here stops more arriving, instead of letting them pile up
     * in the worker's memory. One stream holds at most once.
     */
    holdChannel(): void {
        if (this.holding || this.closed) return;
        this.holding = true;
        this.channel.hold();
    }

    /** Let go of the hold this stream took, if it took one. */
    releaseChannel(): void {
        if (!this.holding) return;
        this.holding = false;
        this.channel.release();
    }

    /** Finish the stream in both directions. */
    close(reason?: string): void {
        if (this.closed) return;
        this.closed = true;
        this.releaseChannel();
        this.channel.forget(this.id);
        void this.channel.send(TYPE_CLOSE, this.id, Buffer.from(JSON.stringify(reason ? { reason } : {}), "utf8"))
            .catch(() => { /* the channel is already going */ });
        this.emit("close", reason);
    }

    /** Called by the channel when the far end closed it. */
    closedByPeer(reason?: string): void {
        if (this.closed) return;
        this.closed = true;
        this.releaseChannel();
        this.emit("close", reason);
    }
}

/**
 * The framed channel itself.
 *
 * Events: `notice` (a plain object from the other end), `stream` (the
 * other end opened one), `close` (the channel is over, with the reason if
 * there was one).
 */
export class ComputeChannel extends EventEmitter {
    readonly maxFrameBytes: number;
    private readonly maxStreams: number;
    private readonly streams = new Map<number, ComputeChannelStream>();
    /**
     * What has arrived and is not yet a whole frame.
     *
     * Kept as the pieces it arrived in rather than one growing buffer:
     * concatenating on every chunk copies everything held so far each
     * time, so a frame delivered in many small pieces costs the square of
     * its size to receive.
     */
    private parts: Buffer[] = [];
    private held = 0;
    private nextId: number;
    private closed = false;
    private holds = 0;
    private started = false;

    constructor(private readonly connection: Duplex, private readonly options: ComputeChannelOptions) {
        super();
        this.maxFrameBytes = options.maxFrameBytes ?? COMPUTE_CHANNEL_MAX_FRAME_BYTES;
        this.maxStreams = options.maxStreams ?? COMPUTE_CHANNEL_MAX_STREAMS;
        this.nextId = options.side === "worker" ? 2 : 1;
        connection.on("data", (chunk: Buffer) => this.receive(chunk));
        connection.on("error", (error: Error) => this.finish(error.message));
        connection.on("close", () => this.finish("the connection to the compute host closed"));
        connection.on("end", () => this.finish("the connection to the compute host ended"));
    }

    /**
     * Begin reading. Called once both ends of this channel have their
     * listeners in place, so a frame that is already on the connection is
     * never delivered to nobody.
     */
    start(): this {
        this.started = true;
        if (this.holds === 0) this.connection.resume();
        return this;
    }

    /** Internal: a stream asks for nothing more to be read until it lets go. */
    hold(): void {
        this.holds += 1;
        if (this.holds === 1) this.connection.pause();
    }

    /** Internal: a stream lets go; reading starts again when the last one has. */
    release(): void {
        if (this.holds === 0) return;
        this.holds -= 1;
        if (this.holds > 0 || this.closed) return;
        if (this.started) this.connection.resume();
        // Whole frames may already be held from before the hold. Nothing
        // new has to arrive for them to be delivered.
        queueMicrotask(() => {
            if (this.closed || this.holds > 0) return;
            this.receive(Buffer.alloc(0));
        });
    }

    get isClosed(): boolean {
        return this.closed;
    }

    /** Test and diagnostic view: how many streams are open. */
    get openStreams(): number {
        return this.streams.size;
    }

    /** Send a small object the other end reads as a notice. */
    async notice(message: Record<string, unknown>): Promise<void> {
        const body = Buffer.from(JSON.stringify(message), "utf8");
        if (body.length > COMPUTE_CHANNEL_MAX_NOTICE_BYTES) throw new Error("this notice is larger than a channel carries");
        await this.send(TYPE_NOTICE, 0, body);
    }

    /** Open a stream to the other end. */
    open(kind: string, meta: Record<string, unknown> = {}): ComputeChannelStream {
        if (this.closed) throw new Error("this channel is closed");
        if (this.streams.size >= this.maxStreams) throw new Error("this channel already carries as many streams as it will");
        const id = this.nextId;
        this.nextId += 2;
        const body = Buffer.from(JSON.stringify({ kind, meta }), "utf8");
        if (body.length > COMPUTE_CHANNEL_MAX_NOTICE_BYTES) throw new Error("this stream's opening details are larger than a channel carries");
        const stream = new ComputeChannelStream(this, id, kind, meta);
        this.streams.set(id, stream);
        void this.send(TYPE_OPEN, id, body).catch((error: Error) => stream.closedByPeer(error.message));
        return stream;
    }

    /** Internal: a stream has finished and no longer needs its number. */
    forget(id: number): void {
        this.streams.delete(id);
    }

    /** Internal: write one frame. */
    async send(type: number, streamId: number, payload: Buffer): Promise<void> {
        if (this.closed) throw new Error("this channel is closed");
        if (payload.length > this.maxFrameBytes) throw new Error("this frame is larger than the channel carries");
        await new Promise<void>((resolve, reject) => {
            this.connection.write(frame(type, streamId, payload), (error) => error ? reject(error) : resolve());
        });
    }

    /** Stop the channel and every stream on it. */
    close(reason?: string): void {
        this.finish(reason);
        try { this.connection.destroy(); } catch { /* already gone */ }
    }

    private finish(reason?: string): void {
        if (this.closed) return;
        this.closed = true;
        for (const stream of [...this.streams.values()]) {
            this.streams.delete(stream.id);
            stream.closedByPeer(reason);
        }
        this.emit("close", reason);
    }

    /** The first `count` bytes held, taken out of the pieces they arrived in. */
    private take(count: number): Buffer {
        if (this.parts.length === 1 && this.parts[0].length === count) {
            const only = this.parts[0];
            this.parts = [];
            this.held = 0;
            return only;
        }
        const out = Buffer.allocUnsafe(count);
        let at = 0;
        while (at < count) {
            const piece = this.parts[0];
            const want = Math.min(piece.length, count - at);
            piece.copy(out, at, 0, want);
            at += want;
            if (want === piece.length) this.parts.shift();
            else this.parts[0] = piece.subarray(want);
        }
        this.held -= count;
        return out;
    }

    /** Read `count` bytes of the head without taking them. */
    private peek(count: number): Buffer {
        if (this.parts.length > 0 && this.parts[0].length >= count) return this.parts[0];
        const out = Buffer.allocUnsafe(count);
        let at = 0;
        for (const piece of this.parts) {
            const want = Math.min(piece.length, count - at);
            piece.copy(out, at, 0, want);
            at += want;
            if (at === count) break;
        }
        return out;
    }

    private receive(chunk: Buffer): void {
        if (this.closed) return;
        if (chunk.length) { this.parts.push(chunk); this.held += chunk.length; }
        for (;;) {
            if (this.held < FRAME_HEADER_BYTES) return;
            const header = this.peek(FRAME_HEADER_BYTES);
            const length = header.readUInt32BE(5);
            if (length > this.maxFrameBytes) {
                this.close(`a channel frame says it is ${length} bytes; this build reads at most ${this.maxFrameBytes}`);
                return;
            }
            if (this.held < FRAME_HEADER_BYTES + length) return;
            const type = header.readUInt8(0);
            const streamId = header.readUInt32BE(1);
            this.take(FRAME_HEADER_BYTES);
            const payload = length ? this.take(length) : Buffer.alloc(0);
            try {
                this.dispatch(type, streamId, payload);
            } catch (error) {
                this.close(String((error as Error)?.message ?? error));
                return;
            }
            if (this.closed) return;
            // A stream may have asked for the link to stop while this
            // frame was dispatched. Stop reading the frames already held
            // too, or the hold would only slow new arrivals.
            if (this.holds > 0) return;
        }
    }

    private object(payload: Buffer): Record<string, unknown> {
        if (payload.length > COMPUTE_CHANNEL_MAX_NOTICE_BYTES) throw new Error("a channel frame's details are larger than this build reads");
        const parsed: unknown = JSON.parse(payload.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("a channel frame's details are not an object");
        return parsed as Record<string, unknown>;
    }

    private dispatch(type: number, streamId: number, payload: Buffer): void {
        if (type === TYPE_NOTICE) {
            this.emit("notice", this.object(payload));
            return;
        }
        if (type === TYPE_OPEN) {
            if (streamId === 0 || streamId % 2 === (this.options.side === "worker" ? 0 : 1)) {
                throw new Error("the other end opened a stream with a number that is not its own to give");
            }
            if (this.streams.has(streamId)) throw new Error("the other end opened a stream number that is already in use");
            if (this.streams.size >= this.maxStreams) throw new Error("the other end opened more streams than this channel carries");
            const details = this.object(payload);
            const kind = typeof details.kind === "string" ? details.kind : "";
            const meta = details.meta && typeof details.meta === "object" && !Array.isArray(details.meta)
                ? details.meta as Record<string, unknown> : {};
            const stream = new ComputeChannelStream(this, streamId, kind, meta);
            this.streams.set(streamId, stream);
            this.emit("stream", stream);
            return;
        }
        const stream = this.streams.get(streamId);
        if (!stream) return; // Already finished here; the other end will see the close.
        if (type === TYPE_DATA) {
            stream.emit("data", Buffer.from(payload));
            return;
        }
        if (type === TYPE_END) {
            stream.emit("end");
            return;
        }
        if (type === TYPE_CLOSE) {
            const details = payload.length ? this.object(payload) : {};
            this.streams.delete(streamId);
            stream.closedByPeer(typeof details.reason === "string" ? details.reason : undefined);
            return;
        }
        throw new Error(`the other end sent a channel frame of type ${type}, which this build does not read`);
    }
}
