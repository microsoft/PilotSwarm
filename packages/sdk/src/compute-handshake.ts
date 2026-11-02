/**
 * The mutual handshake between a worker and a compute host
 * (docs/proposals/compute-providers.md, "The handshake").
 *
 * Every connection to a runtime that is not the worker's own child process
 * starts with this exchange, whoever opened it and whatever it is made of.
 * PilotSwarm defines it once so no provider has to invent one, and so a
 * worker can tell "I am talking to the host this binding was given" from
 * "something answered on that address".
 *
 * What it proves: both ends hold the same per-binding secret. The provider
 * places that secret on the host and gives the same secret to the worker
 * over the registered link; it is fresh for every new binding, lives only
 * in worker memory, and is never written to the CMS or to a log.
 *
 * What it is not: it does not say what the host is made of, who runs it,
 * or that it is clean. Those are the provider's guarantees. Extra evidence
 * a provider or host may want later is additive — the `extra` field is
 * reserved for it and ignored today.
 *
 * The exchange, four frames, with a deadline over the whole of it:
 *
 *   worker -> host   hello    protocol version, binding id, purpose, worker nonce
 *   host   -> worker host     host nonce, proof over both nonces
 *   worker -> host   worker   proof over both nonces
 *   host   -> worker ok
 *
 * A proof is HMAC-SHA256 of a domain-separated string under the secret, so
 * the host's proof can never be replayed as the worker's. Comparisons are
 * constant time. Any failure closes the connection; the worker turns it
 * into COMPUTE_HANDSHAKE_FAILED. After `ok` the stream carries the
 * runtime's own protocol and nothing else — including the runtime's
 * connection token, which is still checked at the far end.
 *
 * What it does NOT do: protect the stream. No key is derived from the
 * exchange and nothing is bound to the channel, so after `ok` the stream
 * is a plain pass-through. A party that can sit in the middle and relay
 * these four frames can then read or change everything that follows; the
 * host answering a hello before the worker has proved anything is what
 * makes relaying them possible. The network between the worker and the
 * host must therefore be private or otherwise protected. Encrypting it is
 * designed in the proposal's future work.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";

/** The protocol version this build speaks. */
export const COMPUTE_HANDSHAKE_VERSION = 1;
/**
 * What a proved connection is for.
 *
 * `runtime` is the session's own stream, which is all a connection was
 * ever for before. `control` is the side channel that carries the
 * read-only copies of a session's folders and the MCP traffic of the
 * servers that stay on the trusted side (see compute-channel.ts).
 *
 * The purpose is named in the hello and signed into both proofs, so a
 * connection proved for one purpose can never be used as the other and
 * neither end has to take the other's word for which it is. A hello with
 * no purpose means `runtime`.
 */
export const COMPUTE_HANDSHAKE_PURPOSES = ["runtime", "control"] as const;
export type ComputeHandshakePurpose = (typeof COMPUTE_HANDSHAKE_PURPOSES)[number];
export const COMPUTE_HANDSHAKE_DEFAULT_PURPOSE: ComputeHandshakePurpose = "runtime";
/** How long the whole exchange has, from the first byte. */
export const COMPUTE_HANDSHAKE_TIMEOUT_MS = 15_000;
/**
 * The most one handshake frame may take. Frames carry four short fields;
 * the cap stops anything on the other end from making the reader buffer.
 */
export const COMPUTE_HANDSHAKE_MAX_FRAME_BYTES = 4096;
/**
 * The shortest secret this build accepts, in characters of whatever
 * encoding the provider chose. A secret must carry at least 32 random
 * bytes, and no common encoding writes 32 bytes in fewer than 43
 * characters, so a shorter string cannot be one.
 */
export const COMPUTE_HANDSHAKE_SECRET_MIN_CHARS = 43;
/** How many worker nonces one host remembers, to refuse a replayed hello. */
export const COMPUTE_HANDSHAKE_NONCE_MEMORY = 4096;

/** The code a failed handshake raises, matching COMPUTE_ERROR_CODES.HANDSHAKE_FAILED. */
export const COMPUTE_HANDSHAKE_FAILED = "COMPUTE_HANDSHAKE_FAILED";

/** What a provider's `connect` hands the worker so it can prove itself to the host. */
export interface ComputeHandshakeCredential {
    /** Names the binding this secret belongs to. Both ends must agree on it. */
    bindingId: string;
    /** Never logged, never stored, never reused for another binding. */
    secret: string;
}

/** A refused handshake. Always this code, so a turn can say what happened. */
export class ComputeHandshakeError extends Error {
    readonly code = COMPUTE_HANDSHAKE_FAILED;
    constructor(message: string) {
        super(message);
        this.name = "ComputeHandshakeError";
    }
}

/** A fresh per-binding secret: 32 random bytes, hex. */
export function newComputeHandshakeSecret(): string {
    return randomBytes(32).toString("hex");
}

/** Whether a secret is long enough to carry 32 random bytes. */
export function isUsableHandshakeSecret(secret: unknown): secret is string {
    return typeof secret === "string" && secret.length >= COMPUTE_HANDSHAKE_SECRET_MIN_CHARS;
}

type HandshakeRole = "host" | "worker";

/**
 * The proof one side sends. The role is inside the signed string, so a
 * host's proof is not a worker's and neither can be replayed as the other.
 */
export function computeHandshakeProof(
    secret: string,
    role: HandshakeRole,
    parts: { bindingId: string; workerNonce: string; hostNonce: string; purpose?: string },
): string {
    const message = [
        "pilotswarm-compute-handshake",
        `v${COMPUTE_HANDSHAKE_VERSION}`,
        role,
        parts.bindingId,
        parts.workerNonce,
        parts.hostNonce,
        // What the connection is for. A hello that names none means the
        // session's own runtime stream, which is what every hello meant
        // before there was a second purpose.
        parts.purpose || COMPUTE_HANDSHAKE_DEFAULT_PURPOSE,
    ].join(":");
    return createHmac("sha256", Buffer.from(secret, "utf8")).update(message, "utf8").digest("hex");
}

/** Equal or not, in time that does not depend on where they differ. */
export function proofsMatch(a: unknown, b: unknown): boolean {
    if (typeof a !== "string" || typeof b !== "string") return false;
    const left = Buffer.from(a, "utf8");
    const right = Buffer.from(b, "utf8");
    // timingSafeEqual needs equal lengths. The length this build compares
    // against is fixed (a hex SHA-256 digest), so a length difference
    // reveals nothing about the secret and can be answered at once; the
    // bytes themselves are only ever compared in constant time.
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
}

/**
 * Reads whole frames off a stream, and gives back whatever it read past the
 * last one so the stream can carry on as if it had never been touched.
 *
 * A frame is four bytes of big-endian length and that many bytes of UTF-8
 * JSON. A length over the cap, or bytes that are not an object, ends the
 * handshake rather than being skipped.
 */
class HandshakeFrameReader {
    private buffered: Buffer = Buffer.alloc(0);
    private waiting: { resolve: (frame: Record<string, unknown>) => void; reject: (error: Error) => void } | null = null;
    private failure: Error | null = null;
    private finished = false;
    private released = false;

    private readonly onData = (chunk: Buffer) => {
        this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
        this.pump();
    };
    private readonly onError = (error: Error) => this.fail(error);
    private readonly onEnd = () => {
        this.finished = true;
        if (this.waiting) this.fail(new ComputeHandshakeError("the connection closed during the handshake"));
    };

    constructor(private readonly stream: Duplex, private readonly maxFrameBytes = COMPUTE_HANDSHAKE_MAX_FRAME_BYTES) {
        stream.on("data", this.onData);
        stream.on("error", this.onError);
        stream.on("end", this.onEnd);
        stream.on("close", this.onEnd);
    }

    private fail(error: Error): void {
        this.failure ??= error instanceof ComputeHandshakeError
            ? error
            : new ComputeHandshakeError(`the connection failed during the handshake: ${error.message}`);
        const waiting = this.waiting;
        this.waiting = null;
        waiting?.reject(this.failure);
    }

    private pump(): void {
        if (!this.waiting) return;
        if (this.buffered.length < 4) {
            if (this.finished) this.fail(new ComputeHandshakeError("the connection closed during the handshake"));
            return;
        }
        const length = this.buffered.readUInt32BE(0);
        if (length === 0 || length > this.maxFrameBytes) {
            this.fail(new ComputeHandshakeError(
                `a handshake frame says it is ${length} bytes; this build reads at most ${this.maxFrameBytes}`));
            return;
        }
        if (this.buffered.length < 4 + length) {
            if (this.finished) this.fail(new ComputeHandshakeError("a handshake frame was cut short"));
            return;
        }
        const body = this.buffered.subarray(4, 4 + length);
        this.buffered = this.buffered.subarray(4 + length);
        let frame: unknown;
        try {
            frame = JSON.parse(body.toString("utf8"));
        } catch {
            this.fail(new ComputeHandshakeError("a handshake frame is not readable"));
            return;
        }
        if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
            this.fail(new ComputeHandshakeError("a handshake frame is not an object"));
            return;
        }
        const waiting = this.waiting;
        this.waiting = null;
        waiting!.resolve(frame as Record<string, unknown>);
    }

    next(): Promise<Record<string, unknown>> {
        if (this.failure) return Promise.reject(this.failure);
        return new Promise((resolve, reject) => {
            this.waiting = { resolve, reject };
            this.pump();
        });
    }

    /**
     * Stop reading and put back anything read past the last frame.
     *
     * The stream is left paused, with those bytes at the front of it, so
     * nothing can be lost between the handshake and whatever takes the
     * stream over. Whoever does take it over resumes it — the bridge and
     * the host component both do, by piping it.
     */
    release(): void {
        if (this.released) return;
        this.released = true;
        this.stream.removeListener("data", this.onData);
        this.stream.removeListener("error", this.onError);
        this.stream.removeListener("end", this.onEnd);
        this.stream.removeListener("close", this.onEnd);
        this.stream.pause();
        if (this.buffered.length && !this.finished) {
            try {
                this.stream.unshift(this.buffered);
            } catch { /* the stream is already done with; nothing can use those bytes */ }
        }
        this.buffered = Buffer.alloc(0);
    }
}

function writeFrame(stream: Duplex, frame: Record<string, unknown>): Promise<void> {
    const body = Buffer.from(JSON.stringify(frame), "utf8");
    if (body.length > COMPUTE_HANDSHAKE_MAX_FRAME_BYTES) {
        return Promise.reject(new ComputeHandshakeError("a handshake frame is larger than this build writes"));
    }
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(body.length, 0);
    return new Promise((resolve, reject) => {
        stream.write(Buffer.concat([header, body]), (error) => error
            ? reject(new ComputeHandshakeError(`the handshake could not be sent: ${error.message}`))
            : resolve());
    });
}

/** Run the exchange, or give up when the deadline passes. */
async function withDeadline<T>(timeoutMs: number, run: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            run(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new ComputeHandshakeError(`the handshake did not finish within ${timeoutMs} ms`)),
                    timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function nonce(): string {
    return randomBytes(16).toString("hex");
}

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function checkCredential(credential: ComputeHandshakeCredential): void {
    if (!credential || !text(credential.bindingId).trim()) {
        throw new ComputeHandshakeError("a handshake needs the binding it belongs to");
    }
    if (!isUsableHandshakeSecret(credential.secret)) {
        throw new ComputeHandshakeError(
            `a handshake secret must carry at least 32 random bytes (at least ${COMPUTE_HANDSHAKE_SECRET_MIN_CHARS} characters encoded)`);
    }
}

/**
 * The worker's half. Resolves when the host has proved itself and accepted
 * the worker's own proof; after that the stream is the runtime's.
 */
export async function runWorkerHandshake(
    stream: Duplex,
    credential: ComputeHandshakeCredential,
    options: { timeoutMs?: number; purpose?: ComputeHandshakePurpose } = {},
): Promise<void> {
    checkCredential(credential);
    const purpose = options.purpose ?? COMPUTE_HANDSHAKE_DEFAULT_PURPOSE;
    const reader = new HandshakeFrameReader(stream);
    try {
        await withDeadline(options.timeoutMs ?? COMPUTE_HANDSHAKE_TIMEOUT_MS, async () => {
            const workerNonce = nonce();
            await writeFrame(stream, {
                v: COMPUTE_HANDSHAKE_VERSION,
                t: "hello",
                bindingId: credential.bindingId,
                nonce: workerNonce,
                purpose,
                // Reserved for evidence a provider or host may add later.
                // This build sends nothing in it and ignores whatever comes back.
                extra: null,
            });
            const answer = await reader.next();
            if (answer.t !== "host") throw new ComputeHandshakeError(`the host answered "${text(answer.t)}" instead of proving itself`);
            if (answer.v !== COMPUTE_HANDSHAKE_VERSION) {
                throw new ComputeHandshakeError(`the host speaks handshake version ${String(answer.v)}, this worker speaks ${COMPUTE_HANDSHAKE_VERSION}`);
            }
            const hostNonce = text(answer.nonce);
            if (hostNonce.length < 16) throw new ComputeHandshakeError("the host sent no usable nonce");
            const parts = { bindingId: credential.bindingId, workerNonce, hostNonce, purpose };
            if (!proofsMatch(answer.proof, computeHandshakeProof(credential.secret, "host", parts))) {
                throw new ComputeHandshakeError("the host did not prove it holds this binding's secret");
            }
            await writeFrame(stream, {
                v: COMPUTE_HANDSHAKE_VERSION,
                t: "worker",
                proof: computeHandshakeProof(credential.secret, "worker", parts),
            });
            const done = await reader.next();
            if (done.t !== "ok") {
                throw new ComputeHandshakeError(`the host refused this worker: ${text(done.reason) || text(done.t) || "no reason given"}`);
            }
        });
    } finally {
        reader.release();
    }
}

/**
 * The host's half. `seenNonces` is the host component's memory of the
 * worker nonces it has already answered for this binding: a hello that
 * repeats one is refused, so a recording of an earlier exchange cannot be
 * played back at it.
 */
export async function runHostHandshake(
    stream: Duplex,
    credential: ComputeHandshakeCredential,
    options: { timeoutMs?: number; seenNonces?: Set<string>; purposes?: readonly ComputeHandshakePurpose[] } = {},
): Promise<{ purpose: ComputeHandshakePurpose }> {
    checkCredential(credential);
    const offered = options.purposes ?? [COMPUTE_HANDSHAKE_DEFAULT_PURPOSE];
    const reader = new HandshakeFrameReader(stream);
    try {
        return await withDeadline(options.timeoutMs ?? COMPUTE_HANDSHAKE_TIMEOUT_MS, async () => {
            const hello = await reader.next();
            if (hello.t !== "hello") throw new ComputeHandshakeError(`the worker opened with "${text(hello.t)}" instead of a hello`);
            if (hello.v !== COMPUTE_HANDSHAKE_VERSION) {
                throw new ComputeHandshakeError(`the worker speaks handshake version ${String(hello.v)}, this host speaks ${COMPUTE_HANDSHAKE_VERSION}`);
            }
            if (text(hello.bindingId) !== credential.bindingId) {
                throw new ComputeHandshakeError("the worker named a different binding than this host serves");
            }
            const workerNonce = text(hello.nonce);
            if (workerNonce.length < 16) throw new ComputeHandshakeError("the worker sent no usable nonce");
            const purpose = (text(hello.purpose) || COMPUTE_HANDSHAKE_DEFAULT_PURPOSE) as ComputeHandshakePurpose;
            if (!offered.includes(purpose)) {
                await writeFrame(stream, { v: COMPUTE_HANDSHAKE_VERSION, t: "no", reason: "this host does not serve connections for that purpose" })
                    .catch(() => { /* the refusal is the close */ });
                throw new ComputeHandshakeError(`the worker asked for a "${purpose}" connection, which this host does not serve`);
            }
            const seen = options.seenNonces;
            if (seen) {
                if (seen.has(workerNonce)) {
                    await writeFrame(stream, { v: COMPUTE_HANDSHAKE_VERSION, t: "no", reason: "this hello has been used before" })
                        .catch(() => { /* the refusal is the close */ });
                    throw new ComputeHandshakeError("the worker replayed a hello this host has already answered");
                }
                // Bounded: the oldest is dropped rather than letting a
                // caller grow the host's memory without limit.
                if (seen.size >= COMPUTE_HANDSHAKE_NONCE_MEMORY) {
                    const oldest = seen.values().next();
                    if (!oldest.done) seen.delete(oldest.value);
                }
                seen.add(workerNonce);
            }
            const hostNonce = nonce();
            const parts = { bindingId: credential.bindingId, workerNonce, hostNonce, purpose };
            await writeFrame(stream, {
                v: COMPUTE_HANDSHAKE_VERSION,
                t: "host",
                nonce: hostNonce,
                proof: computeHandshakeProof(credential.secret, "host", parts),
                extra: null,
            });
            const answer = await reader.next();
            if (answer.t !== "worker") throw new ComputeHandshakeError(`the worker answered "${text(answer.t)}" instead of proving itself`);
            if (!proofsMatch(answer.proof, computeHandshakeProof(credential.secret, "worker", parts))) {
                await writeFrame(stream, { v: COMPUTE_HANDSHAKE_VERSION, t: "no", reason: "the worker did not prove it holds this binding's secret" })
                    .catch(() => { /* the refusal is the close */ });
                throw new ComputeHandshakeError("the worker did not prove it holds this binding's secret");
            }
            await writeFrame(stream, { v: COMPUTE_HANDSHAKE_VERSION, t: "ok" });
            return { purpose };
        });
    } finally {
        reader.release();
    }
}
