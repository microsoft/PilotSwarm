/**
 * Store-owned remote state: the opt-in `statePolicy: "store-owned"` of a compute target. Provider neutral.
 *
 * DEFAULT UNCHANGED. Nothing here runs unless a worker is configured with `remoteStoreOwnedTargets` AND a session names one of them as its compute target. A worker without
 * them, and every ordinary session, behave exactly as before.
 *
 * WHAT IT IS. The session store and CMS own the authoritative session state under `store-wins`; the remote sandbox is a DISPOSABLE WARM CACHE that runs the Copilot CLI behind
 * the worker-side model broker (compute-runtime.ts). For each durable turn the worker:
 *   1. probes the store (metadata only);
 *   2. answers an already-committed turn key from the worker-owned turn record, with ZERO sandbox contact;
 *   3. opens a lease, telling the executor the stored head `(version, contentHash)` and giving it a lazy `readArchive()`: a sandbox that already holds that head skips the
 *      download; anything else (cold start, cache miss, a replaced or evicted sandbox) hydrates from the stored archive;
 *   4. checks that the sandbox holds exactly the stored head, then runs the ordinary turn on the lease's client (no model key reaches the host);
 *   5. asks the host to dehydrate ONE opaque archive and commits it with the conditional `store-wins` write, pinned to the exact head the turn started from, together with the
 *      worker-owned turn record;
 *   6. on a `store-wins` conflict does NOT brick the session: it invalidates the warm cache, reports the turn unpublished with reason "conflict", and returns the turn's
 *      outcome, so the next turn rehydrates whatever won;
 *   7. always closes the lease.
 *
 * WHAT IT IS NOT. The worker never unpacks, parses or lists the archive: it is bytes between the host and the store, hashed with SHA-256 and capped (16 MiB, lower if
 * configured). Sandbox state is never authoritative: any turn that does not commit invalidates the warm cache, so a diverged sandbox is never mistaken for the stored head.
 */
import type { CopilotClient } from "@github/copilot-sdk";
import type { RemoteRuntimeRequestHandler } from "./compute-runtime.js";
import {
    parseComputeTarget,
    STORE_OWNED_DEFAULT_DEADLINES_MS,
    type ComputeProvider,
    type ComputeTarget,
    type ParsedComputeTarget,
    type StoreOwnedDeadlinesMs,
} from "./compute-target.js";
import type { RemoteRuntimeBinding } from "./remote-runtime.js";
import type { SnapshotCodec } from "./session-store.js";
import {
    OpaqueArchiveError,
    SnapshotConflictError,
    effectiveArchiveCap,
    fitTurnCommit,
    isOpaqueArchiveError,
    supportsOpaqueArchives,
    type OpaqueArchiveProbe,
    type SnapshotArchiveRead,
    type SnapshotCommitResult,
    type TrustedTurnCommit,
    type VersionedSnapshotStore,
} from "./snapshot-protocol.js";

// ─── Errors ────────────────────────────────────────────────────────────────

export type StoreOwnedErrorCode =
    | "STORE_OWNED_INVALID"
    | "STORE_OWNED_STORE_UNSUPPORTED"
    | "STORE_OWNED_EXECUTOR_UNAVAILABLE"
    | "STORE_OWNED_PROTOCOL_REQUIRED"
    | "STORE_OWNED_UNSUPPORTED"
    | "STORE_OWNED_CHAIN_CONFLICT"
    | "STORE_OWNED_STATE_MISSING"
    | "STORE_OWNED_RESULT_UNAVAILABLE"
    | "STORE_OWNED_TURN_ALREADY_COMMITTED"
    | "STORE_OWNED_OPEN_FAILED"
    | "STORE_OWNED_LEASE_INVALID"
    | "STORE_OWNED_HYDRATE_MISMATCH"
    | "STORE_OWNED_DEHYDRATE_FAILED"
    | "STORE_OWNED_DEADLINE"
    | "STORE_OWNED_ABORTED"
    | "STORE_OWNED_SESSION_LOST"
    | "STORE_OWNED_SESSION_UNAVAILABLE"
    | "STORE_OWNED_BROKER_REFUSED";

/**
 * A typed refusal with fixed text. `terminal`: repeating the turn cannot help (or must not happen on its own). A non-terminal error is safe to retry: the stored head stands and
 * the next attempt starts from it.
 */
export class StoreOwnedError extends Error {
    readonly code: StoreOwnedErrorCode;
    readonly terminal: boolean;

    constructor(code: StoreOwnedErrorCode, message: string, options: { terminal?: boolean; cause?: unknown } = {}) {
        super(`${code}: ${message}`);
        this.name = "StoreOwnedError";
        this.code = code;
        this.terminal = options.terminal !== false;
        if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
    }
}

export function isStoreOwnedError(error: unknown): error is StoreOwnedError {
    return error instanceof StoreOwnedError
        || (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "StoreOwnedError");
}

// ─── Targets ───────────────────────────────────────────────────────────────

export type { StoreOwnedDeadlinesMs };
export { STORE_OWNED_DEFAULT_DEADLINES_MS };

/** A validated, frozen compute target configured with `statePolicy: "store-owned"`. */
export type StoreOwnedTarget = ParsedComputeTarget;

/**
 * Validate a trusted compute target for `statePolicy: "store-owned"` and enabled state.
 */
export function parseStoreOwnedTarget(target: ComputeTarget): Readonly<StoreOwnedTarget> {
    let parsed: Readonly<ParsedComputeTarget>;
    try {
        parsed = parseComputeTarget(target);
    } catch (cause) {
        throw new StoreOwnedError("STORE_OWNED_INVALID", cause instanceof Error ? cause.message : "invalid store-owned compute target", { cause });
    }
    if (parsed.target.statePolicy !== "store-owned" || parsed.target.enabled !== true) {
        throw new StoreOwnedError("STORE_OWNED_INVALID", "the target must be enabled and opt in to statePolicy store-owned");
    }
    effectiveArchiveCap(parsed.maxArchiveBytes);
    return parsed;
}

// ─── The store-owned lease contract a ComputeProvider implements ───────────

/** The head the store holds, as a provider can compare it with what its sandbox holds. */
export interface RemoteStoreOwnedHead {
    version: number;
    contentHash: string;
}

export interface RemoteStoreOwnedOpenRequest {
    readonly sessionId: string;
    readonly epoch: number;
    readonly target: Readonly<StoreOwnedTarget>;
    readonly turnKey: string;
    /** The worker's model broker. Create the sandbox's Copilot client with it unchanged; no model key is ever sent to the host. */
    readonly requestHandler: RemoteRuntimeRequestHandler;
    /** The stored head, or null when the session has none yet. A sandbox that already holds exactly this `(version, contentHash)` needs no download. */
    readonly expectedHead: RemoteStoreOwnedHead | null;
    /**
     * Lazily reads the stored archive (size and hash checked, never unpacked by the worker). Call it only to hydrate. At most one read per turn; it refuses when the stored head is
     * not `expectedHead` any more.
     */
    readonly readArchive: () => Promise<SnapshotArchiveRead | null>;
    /** Aborted when the turn's deadline for opening passes or the turn is cancelled. */
    readonly signal?: AbortSignal;
}

export interface RemoteStoreOwnedDehydrateRequest {
    readonly sessionId: string;
    readonly epoch: number;
    readonly signal?: AbortSignal;
}

export interface RemoteStoreOwnedArchive {
    archiveBytes: Uint8Array;
    codec: SnapshotCodec;
    rawSizeBytes?: number;
}

/**
 * One turn's connection to a remote sandbox. `client` is a STARTED Copilot CLI client created with the request handler the worker gave to `openStoreOwned`. `hydratedHead` is the
 * stored head the sandbox's state corresponds to when the turn starts: equal to the request's `expectedHead` after a cache hit or a hydrate, null only for a fresh sandbox when the
 * store has no head. `close` ends the worker's connection for this turn; it does not destroy the sandbox.
 */
export interface RemoteStoreOwnedLease {
    readonly client: CopilotClient;
    readonly hostId: string;
    readonly reusedWarm: boolean;
    readonly hydratedHead: RemoteStoreOwnedHead | null;
    dehydrateArchive(request: RemoteStoreOwnedDehydrateRequest): Promise<RemoteStoreOwnedArchive>;
    /** Drop the sandbox's warm cache: its state may differ from the stored head, so the next open must hydrate. */
    invalidateWarmCache?(reason: string): Promise<void> | void;
    /** The archive this lease dehydrated was accepted as this head, so the sandbox may label its warm cache with it. */
    acknowledgeCommit?(head: RemoteStoreOwnedHead): Promise<void> | void;
    close(): Promise<void>;
}

function isHead(value: unknown): value is RemoteStoreOwnedHead {
    const head = value as Partial<RemoteStoreOwnedHead> | null;
    return !!head && typeof head === "object" && Number.isInteger(head.version) && (head.version as number) >= 0
        && typeof head.contentHash === "string" && head.contentHash.length > 0;
}

/** A lease checked for the shape the worker needs; anything else is refused. */
export function assertStoreOwnedLease(value: unknown): RemoteStoreOwnedLease {
    const lease = value as Partial<RemoteStoreOwnedLease> | null;
    const client = lease?.client as { createSession?: unknown; resumeSession?: unknown } | null | undefined;
    const optionalFunction = (member: unknown) => member === undefined || typeof member === "function";
    if (!lease || typeof lease !== "object" || !client || typeof client !== "object" || typeof client.createSession !== "function" || typeof client.resumeSession !== "function"
        || typeof lease.hostId !== "string" || lease.hostId.length === 0 || typeof lease.reusedWarm !== "boolean"
        || !(lease.hydratedHead === null || isHead(lease.hydratedHead))
        || typeof lease.dehydrateArchive !== "function" || typeof lease.close !== "function"
        || !optionalFunction(lease.invalidateWarmCache) || !optionalFunction(lease.acknowledgeCommit)) {
        throw new StoreOwnedError("STORE_OWNED_LEASE_INVALID", "the store-owned executor did not return a usable runtime lease");
    }
    return lease as RemoteStoreOwnedLease;
}

function sameHead(a: RemoteStoreOwnedHead | null, b: RemoteStoreOwnedHead | null): boolean {
    if (a === null || b === null) return a === b;
    return a.version === b.version && a.contentHash === b.contentHash;
}

// ─── Deadlines ─────────────────────────────────────────────────────────────

/**
 * Runs one phase under the turn's signal and the phase's own deadline. The phase function gets a signal that aborts on either. A phase that outlives its deadline is abandoned
 * (a store call cannot be cancelled, so it may still land; the turn key makes a repeat of the turn answer from the stored record). `late` receives a value that arrives after
 * the phase was abandoned, so a lease opened too late can still be closed.
 */
async function runPhase<T>(
    phase: "open" | "read" | "dehydrate" | "commit",
    ms: number,
    parent: AbortSignal | undefined,
    fn: (signal: AbortSignal) => Promise<T>,
    late?: (value: T) => void,
): Promise<T> {
    if (parent?.aborted) throw new StoreOwnedError("STORE_OWNED_ABORTED", `the turn was cancelled before ${phase}`, { terminal: false });
    const controller = new AbortController();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onParentAbort: (() => void) | undefined;
    const abandoned = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new StoreOwnedError("STORE_OWNED_DEADLINE", `the ${phase} phase did not finish within ${ms} ms`, { terminal: false }));
        }, ms);
        if (parent) {
            onParentAbort = () => {
                controller.abort();
                reject(new StoreOwnedError("STORE_OWNED_ABORTED", `the turn was cancelled during ${phase}`, { terminal: false }));
            };
            parent.addEventListener("abort", onParentAbort, { once: true });
        }
    });
    abandoned.catch(() => undefined);
    const work = Promise.resolve().then(() => fn(controller.signal));
    work.then(
        (value) => { if (settled && late) { try { late(value); } catch { /* a late value is only cleaned up */ } } },
        () => undefined,
    );
    try {
        return await Promise.race([work, abandoned]);
    } finally {
        settled = true;
        if (timer) clearTimeout(timer);
        if (parent && onParentAbort) parent.removeEventListener("abort", onParentAbort);
    }
}

// ─── The store, at the start of a turn ─────────────────────────────────────

function requireText(value: unknown, what: string, max = 512): string {
    if (typeof value !== "string" || value.length === 0 || value.length > max) throw new StoreOwnedError("STORE_OWNED_INVALID", `${what} must be a non-empty string of bounded length`);
    return value;
}

function requireEpoch(value: unknown): number {
    if (!Number.isInteger(value) || (value as number) < 0) throw new StoreOwnedError("STORE_OWNED_INVALID", "the transcript epoch must be a non-negative integer");
    return value as number;
}

type OpaqueStore = VersionedSnapshotStore & Required<Pick<VersionedSnapshotStore, "probeSnapshotArchive" | "commitSnapshotArchive" | "readSnapshotArchive" | "readTrustedTurnCommit">>;

function requireOpaqueStore(store: unknown): OpaqueStore {
    if (!supportsOpaqueArchives(store)) {
        throw new StoreOwnedError("STORE_OWNED_STORE_UNSUPPORTED", "the session store cannot keep opaque archives with a conditional write and a worker-owned turn record; nothing was done");
    }
    return store as OpaqueStore;
}

function headOf(probe: OpaqueArchiveProbe): RemoteStoreOwnedHead | null {
    if (!probe.exists) return null;
    if (!probe.contentHash) throw new StoreOwnedError("STORE_OWNED_CHAIN_CONFLICT", "the stored archive head carries no content hash; it is never replaced");
    return { version: probe.version, contentHash: probe.contentHash };
}

export type StoreOwnedStartCheck =
    /** The turn key is already committed: its stored result, read from the worker-owned record. No sandbox is needed. */
    | { readonly kind: "stored"; readonly version: number; readonly result: unknown }
    /** The turn has not been committed: `baseVersion` is the stored head's version (0 when none). */
    | { readonly kind: "open"; readonly baseVersion: number };

/**
 * The read-only start of a store-owned turn: the stored head, and the result of a turn key it already carries. Touches the store only: no sandbox, no local directory. Refuses a
 * session that also has a local tar chain (it was not created as a store-owned session).
 */
export async function checkStoreOwnedTurn(input: { store: unknown; sessionId: string; epoch: number; turnKey: string }): Promise<StoreOwnedStartCheck> {
    const sessionId = requireText(input.sessionId, "the session id");
    const turnKey = requireText(input.turnKey, "the turn key");
    const epoch = requireEpoch(input.epoch);
    const store = requireOpaqueStore(input.store);
    const local = await store.probeSnapshot(sessionId, epoch);
    if (local.exists) {
        throw new StoreOwnedError("STORE_OWNED_CHAIN_CONFLICT", "this session also has a local snapshot chain, so it was not created as a store-owned session; it is never replaced");
    }
    const probe = await store.probeSnapshotArchive(sessionId, epoch);
    headOf(probe);
    if (probe.exists && probe.turnKey === turnKey) {
        const stored = await store.readTrustedTurnCommit(sessionId, epoch);
        if (stored && stored.turnKey === turnKey) return Object.freeze({ kind: "stored" as const, version: probe.version, result: stored.result });
        throw new StoreOwnedError("STORE_OWNED_RESULT_UNAVAILABLE", "this turn was already committed but its result record is missing; the turn is not run again");
    }
    return Object.freeze({ kind: "open" as const, baseVersion: probe.exists ? probe.version : 0 });
}

// ─── The turn ──────────────────────────────────────────────────────────────

export interface StoreOwnedTurnRequest {
    readonly sessionId: string;
    /** 0 for the legacy chain, 1 and later for a regenerated chain. */
    readonly epoch: number;
    readonly turnKey: string;
    readonly target: Readonly<StoreOwnedTarget>;
    /** The worker's session store: it must implement the opaque-archive methods. */
    readonly store: unknown;
    readonly provider: Pick<ComputeProvider, "openStoreOwned">;
    readonly requestHandler: RemoteRuntimeRequestHandler;
    /** A turn after the first needs a stored head: without one the turn is held instead of starting an empty conversation. */
    readonly requireHead?: boolean;
    /** Runs the ordinary turn on the opened lease and returns its result. */
    readonly runBody: (lease: RemoteStoreOwnedLease, context: { baseVersion: number; resume: boolean }) => Promise<unknown>;
    readonly signal?: AbortSignal;
}

export type StoreOwnedTurnOutcome =
    /** The turn key was already committed: its stored result is returned and no sandbox ran the turn. */
    | { readonly status: "stored"; readonly version: number; readonly result: unknown; readonly sandboxContacted: boolean }
    | {
        readonly status: "committed";
        readonly version: number;
        readonly contentHash: string;
        readonly sizeBytes: number;
        readonly rawSizeBytes?: number;
        readonly result: unknown;
        readonly hostId: string;
        readonly reusedWarm: boolean;
        readonly hydratedHead: RemoteStoreOwnedHead | null;
        readonly turnRecord: "stored" | "compacted";
        readonly leaseCloseFailed: boolean;
    }
    /** Not published: the turn's state is NOT the stored head (`store-wins`). The warm cache was invalidated; the next turn rehydrates the head. */
    | {
        readonly status: "unpublished";
        readonly unpublishedReason: "conflict" | "stopped";
        readonly version: number;
        readonly storedTurnKey?: string;
        readonly result: unknown;
        readonly leaseCloseFailed: boolean;
    };

/** A plain JSON copy, taken once before any later await: a body that mutates its result afterwards cannot change what is committed or returned. */
function jsonSnapshot(value: unknown): unknown {
    let text: string | undefined;
    try {
        text = JSON.stringify(value === undefined ? null : value);
    } catch (cause) {
        throw new StoreOwnedError("STORE_OWNED_INVALID", "the turn result is not JSON data", { cause });
    }
    if (text === undefined) throw new StoreOwnedError("STORE_OWNED_INVALID", "the turn result is not JSON data");
    return JSON.parse(text) as unknown;
}

/**
 * Runs one durable turn against a store-owned session (see the module comment). Refusals are `StoreOwnedError` or `OpaqueArchiveError`; any other store or executor error that
 * escapes a phase is wrapped or propagates unchanged. A lease that was opened is always closed, and the warm cache is invalidated on every path that does not commit.
 */
export async function runStoreOwnedRemoteTurn(request: StoreOwnedTurnRequest): Promise<StoreOwnedTurnOutcome> {
    const sessionId = requireText(request.sessionId, "the session id");
    const turnKey = requireText(request.turnKey, "the turn key");
    const epoch = requireEpoch(request.epoch);
    const store = requireOpaqueStore(request.store);
    const openStoreOwned = request.provider?.openStoreOwned;
    if (typeof openStoreOwned !== "function") throw new StoreOwnedError("STORE_OWNED_EXECUTOR_UNAVAILABLE", "a store-owned turn needs a compute provider implementing openStoreOwned", { terminal: false });
    const handler = request.requestHandler;
    if (handler === null || (typeof handler !== "object" && typeof handler !== "function")) {
        throw new StoreOwnedError("STORE_OWNED_INVALID", "a store-owned turn needs the worker's model-broker request handler");
    }
    const cap = request.target.maxArchiveBytes;
    const deadlines = request.target.deadlinesMs;

    // 1. The store's head, metadata only. Its ETag (or content hash) pins the commit to this exact head.
    const probe = await runPhase("read", deadlines.read, request.signal, () => store.probeSnapshotArchive(sessionId, epoch));
    const expectedHead = headOf(probe);
    const baseVersion = probe.exists ? probe.version : 0;

    // 2. A turn key the head already carries: its result comes from the worker-owned record. No sandbox is contacted.
    if (probe.exists && probe.turnKey === turnKey) {
        const stored = await store.readTrustedTurnCommit(sessionId, epoch);
        if (stored && stored.turnKey === turnKey) return Object.freeze({ status: "stored" as const, version: probe.version, result: stored.result, sandboxContacted: false });
        throw new StoreOwnedError("STORE_OWNED_RESULT_UNAVAILABLE", "this turn was already committed but its result record is missing; the turn is not run again");
    }
    if (request.requireHead === true && expectedHead === null) {
        throw new StoreOwnedError("STORE_OWNED_STATE_MISSING", "a later turn of this session found no stored state; the turn is held instead of starting an empty conversation");
    }

    // 3. The lease. The archive is read at most once, only if the executor asks, and only while the stored head is still the one this turn started from.
    let pendingRead: Promise<SnapshotArchiveRead | null> | null = null;
    const readArchive = (): Promise<SnapshotArchiveRead | null> => {
        pendingRead ??= (async () => {
            const archive = await runPhase("read", deadlines.read, request.signal, () => store.readSnapshotArchive(sessionId, epoch, { maxBytes: cap }));
            const got = archive === null ? null : { version: archive.version, contentHash: archive.contentHash };
            if (!sameHead(got, expectedHead)) {
                throw new StoreOwnedError("STORE_OWNED_HYDRATE_MISMATCH", "the stored head changed while this turn was opening; the turn may be retried from the stored head", { terminal: false });
            }
            return archive;
        })();
        return pendingRead;
    };
    const closeQuietly = (value: unknown) => {
        const close = (value as { close?: unknown } | null)?.close;
        if (typeof close === "function") void Promise.resolve().then(() => Reflect.apply(close, value, [])).then(() => undefined, () => undefined);
    };
    let opened: unknown;
    try {
        opened = await runPhase("open", deadlines.open, request.signal, (signal) => openStoreOwned.call(request.provider, {
            sessionId,
            epoch,
            target: request.target,
            turnKey,
            requestHandler: handler,
            expectedHead,
            readArchive,
            signal,
        }), closeQuietly);
    } catch (cause) {
        if (isStoreOwnedError(cause) || isOpaqueArchiveError(cause)) throw cause;
        throw new StoreOwnedError("STORE_OWNED_OPEN_FAILED", "the executor could not open a runtime for this turn; nothing was committed and the turn may be retried", { terminal: false, cause });
    }
    let lease: RemoteStoreOwnedLease;
    try {
        lease = assertStoreOwnedLease(opened);
    } catch (error) {
        closeQuietly(opened);
        throw error;
    }

    let closed: { readonly failed: boolean } | null = null;
    const close = async (): Promise<{ readonly failed: boolean }> => {
        if (closed) return closed;
        try {
            await lease.close();
            closed = { failed: false };
        } catch {
            closed = { failed: true };
        }
        return closed;
    };
    // An invalidation that itself fails cannot be repaired here: the next open compares `(version, contentHash)`, and the cache is still only a cache.
    const invalidate = async (reason: string): Promise<void> => {
        if (typeof lease.invalidateWarmCache !== "function") return;
        try {
            await lease.invalidateWarmCache(reason);
        } catch {
            // The turn is already ending without a commit.
        }
    };

    try {
        // The sandbox must hold exactly the stored head, or nothing when the store holds nothing: anything else would be committed over the head.
        if (!sameHead(lease.hydratedHead, expectedHead) || (lease.reusedWarm && expectedHead === null)) {
            await invalidate("hydrate-mismatch");
            throw new StoreOwnedError(
                "STORE_OWNED_HYDRATE_MISMATCH",
                "the sandbox's state is not the stored head; the turn was not run",
                { terminal: typeof lease.invalidateWarmCache !== "function" },
            );
        }

        // 4. The ordinary turn.
        let produced: unknown;
        try {
            produced = await request.runBody(lease, { baseVersion, resume: expectedHead !== null });
        } catch (error) {
            await invalidate("turn-failed");
            throw error;
        }
        let result: unknown;
        try {
            result = jsonSnapshot(produced);
        } catch (error) {
            await invalidate("result-invalid");
            throw error;
        }
        if ((result as { type?: unknown } | null)?.type === "stopped") {
            // A stopped turn is discarded: its sandbox state is not the head.
            await invalidate("turn-stopped");
            const end = await close();
            return Object.freeze({ status: "unpublished" as const, unpublishedReason: "stopped" as const, version: baseVersion, result, leaseCloseFailed: end.failed });
        }

        // 5. One opaque archive, bounded before the store sees it.
        let archive: RemoteStoreOwnedArchive;
        try {
            archive = await runPhase("dehydrate", deadlines.dehydrate, request.signal, (signal) => lease.dehydrateArchive({ sessionId, epoch, signal }));
        } catch (cause) {
            await invalidate("dehydrate-failed");
            if (isStoreOwnedError(cause)) throw cause;
            throw new StoreOwnedError("STORE_OWNED_DEHYDRATE_FAILED", "the sandbox could not produce its archive; the turn was not committed and may be retried from the stored head", { terminal: false, cause });
        }
        const size = archive?.archiveBytes instanceof Uint8Array ? archive.archiveBytes.byteLength : -1;
        if (size < 1 || size > cap) {
            await invalidate("archive-rejected");
            throw size < 1
                ? new OpaqueArchiveError("ARCHIVE_INVALID", "the sandbox returned no archive bytes; nothing was stored")
                : new OpaqueArchiveError("ARCHIVE_TOO_LARGE", `the archive is ${size} bytes, over the ${cap}-byte cap; nothing was stored`);
        }
        const fit = fitTurnCommit(turnKey, result);
        let committed: SnapshotCommitResult;
        try {
            committed = await runPhase("commit", deadlines.commit, request.signal, () => store.commitSnapshotArchive(sessionId, {
                baseVersion,
                turnKey,
                archiveBytes: archive.archiveBytes,
                codec: archive.codec,
                ...(archive.rawSizeBytes !== undefined ? { rawSizeBytes: archive.rawSizeBytes } : {}),
                ...(probe.etag ? { expectedEtag: probe.etag } : {}),
                maxArchiveBytes: cap,
                turnCommit: fit.turnCommit,
            }, epoch));
        } catch (error) {
            await invalidate(error instanceof SnapshotConflictError ? "snapshot-conflict" : "commit-failed");
            if (error instanceof SnapshotConflictError) {
                // store-wins: another writer advanced the head. The session is not bricked; the next turn rehydrates what won.
                const end = await close();
                return Object.freeze({
                    status: "unpublished" as const,
                    unpublishedReason: "conflict" as const,
                    version: error.storedVersion,
                    ...(error.storedTurnKey ? { storedTurnKey: error.storedTurnKey } : {}),
                    result,
                    leaseCloseFailed: end.failed,
                });
            }
            throw error;
        }

        if (committed.alreadyCommitted) {
            // A racing attempt of this same turn won; this sandbox's state is not its bytes. Its result is the one that counts.
            await invalidate("already-committed");
            const winner: TrustedTurnCommit | null = await store.readTrustedTurnCommit(sessionId, epoch);
            if (winner && winner.turnKey === turnKey) {
                await close();
                return Object.freeze({ status: "stored" as const, version: committed.version, result: winner.result, sandboxContacted: true });
            }
            throw new StoreOwnedError("STORE_OWNED_RESULT_UNAVAILABLE", "a racing attempt of this turn committed first and its result record is missing; the turn is not run again");
        }
        if (typeof lease.acknowledgeCommit === "function") {
            try {
                await lease.acknowledgeCommit({ version: committed.version, contentHash: committed.contentHash });
            } catch {
                await invalidate("acknowledge-failed");
            }
        }
        const end = await close();
        return Object.freeze({
            status: "committed" as const,
            version: committed.version,
            contentHash: committed.contentHash,
            sizeBytes: committed.sizeBytes ?? size,
            ...(committed.rawSizeBytes !== undefined ? { rawSizeBytes: committed.rawSizeBytes } : {}),
            result,
            hostId: lease.hostId,
            reusedWarm: lease.reusedWarm,
            hydratedHead: lease.hydratedHead,
            turnRecord: fit.record,
            leaseCloseFailed: end.failed,
        });
    } finally {
        await close();
    }
}

// ─── The bridge between the durable runTurn activity and the turn ──────────

/**
 * What the durable turn sees of one started store-owned turn: it is waiting at its body, with the lease's client bound for `getOrCreate`. `quiesce` drops the worker's native
 * session before the archive is taken; `commit` hands the result over (archive, conditional commit, close); `abort` ends a turn that did not reach its commit.
 */
export interface StoreOwnedTurnPolicy {
    readonly kind: "store-owned";
    readonly sessionId: string;
    readonly transcriptEpoch: number;
    readonly turnKey: string;
    /** The stored head's version the turn started from (0 when none): the turn's base for telemetry. */
    readonly baseVersion: number;
    quiesce(): Promise<void>;
    commit(result: unknown): Promise<StoreOwnedTurnOutcome>;
    /**
     * Ends a turn that did not reach its commit: the warm cache is invalidated and the lease closed. It never throws and never replaces the error that ended the turn (a body
     * failure, a terminal refusal, or the cut a worker drain makes); the caller keeps that error. Idempotent.
     */
    abort(cause: unknown): Promise<void>;
}

export interface StoreOwnedTurnStartInput {
    readonly sessionId: string;
    readonly transcriptEpoch: number;
    readonly turnKey: string;
    readonly target: Readonly<StoreOwnedTarget>;
    readonly provider: Pick<ComputeProvider, "openStoreOwned"> | null;
    readonly store: unknown;
    readonly requestHandler: RemoteRuntimeRequestHandler;
    readonly requireHead?: boolean;
    /** Binds the turn's native client for `getOrCreate`; `resume` says whether the sandbox already holds the native session (a stored head) or must create it. */
    readonly bindRuntime: (binding: RemoteRuntimeBinding, hints: { resume: boolean }) => void;
    /** Drops the worker's native session and releases the turn's binding; idempotent. It does not close the lease: the turn does. */
    readonly releaseRuntime: () => Promise<void>;
    readonly trace: (message: string) => void;
    readonly signal?: AbortSignal;
}

/**
 * Starts one store-owned turn: the probe, the lease and its hydrate check. Returns once the turn is ready to run on the bound native client (it is waiting at its body). A refusal
 * is a typed error and nothing was committed. A turn key that was committed in the meantime is a non-terminal refusal: the repeat answers from the stored record at its start.
 */
export async function beginStoreOwnedTurn(input: StoreOwnedTurnStartInput): Promise<StoreOwnedTurnPolicy> {
    const sessionId = requireText(input.sessionId, "the session id");
    const turnKey = requireText(input.turnKey, "the turn key");
    const epoch = requireEpoch(input.transcriptEpoch);
    const provider = input.provider;
    if (!provider || typeof provider.openStoreOwned !== "function") {
        throw new StoreOwnedError("STORE_OWNED_EXECUTOR_UNAVAILABLE", "this worker has no compute provider implementing openStoreOwned for this target; the turn is held and no local session is started", { terminal: false });
    }

    let bodyEntered = false;
    let finished = false;
    let baseVersion = 0;
    let resolveBody!: (value: unknown) => void;
    let rejectBody!: (reason: unknown) => void;
    const bodyResult = new Promise<unknown>((resolve, reject) => { resolveBody = resolve; rejectBody = reject; });
    bodyResult.catch(() => undefined);
    let signalStart!: () => void;
    let failStart!: (error: unknown) => void;
    const started = new Promise<void>((resolve, reject) => { signalStart = resolve; failStart = reject; });
    started.catch(() => undefined);

    const run = runStoreOwnedRemoteTurn({
        sessionId,
        epoch,
        turnKey,
        target: input.target,
        store: input.store,
        provider,
        requestHandler: input.requestHandler,
        ...(input.requireHead ? { requireHead: true } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        runBody: async (lease, context) => {
            baseVersion = context.baseVersion;
            // The session manager binds the lease's client for this turn. The turn, not the manager, closes the lease.
            input.bindRuntime(Object.freeze({ client: lease.client }), { resume: context.resume });
            bodyEntered = true;
            signalStart();
            return await bodyResult;
        },
    }).then(
        (outcome) => {
            if (!bodyEntered) {
                failStart(outcome.status === "stored"
                    ? new StoreOwnedError("STORE_OWNED_TURN_ALREADY_COMMITTED", "this turn was committed while it was starting; a repeat of the turn returns its stored result", { terminal: false })
                    : new StoreOwnedError("STORE_OWNED_ABORTED", "the store-owned turn ended without running its body", { terminal: false }));
            }
            return outcome;
        },
        (error: unknown) => {
            if (!bodyEntered) failStart(error);
            throw error;
        },
    );
    run.catch(() => undefined);

    await started;
    input.trace(`session=${sessionId} store-owned turn ${turnKey} ready on the bound runtime (base v${baseVersion})`);

    return Object.freeze({
        kind: "store-owned" as const,
        sessionId,
        transcriptEpoch: epoch,
        turnKey,
        baseVersion,
        quiesce: () => input.releaseRuntime(),
        commit: async (result: unknown): Promise<StoreOwnedTurnOutcome> => {
            if (finished) throw new StoreOwnedError("STORE_OWNED_ABORTED", "this store-owned turn was already completed or aborted; it is not committed again");
            finished = true;
            resolveBody(result);
            return await run;
        },
        abort: async (cause: unknown): Promise<void> => {
            if (finished) return;
            finished = true;
            if (bodyEntered) rejectBody(cause ?? new Error("the turn ended before its commit"));
            // The body's rejection makes the runner invalidate the warm cache and close the lease; its own error is the caller's, not ours.
            await run.then(() => undefined, () => undefined);
        },
    });
}

// ─── Failures of the native session on the remote runtime ──────────────────

const PERMANENT_BROKER_REFUSAL = /refusing a model (?:request|WebSocket)/i;
const PERMANENT_TOOL_REFUSAL = /duplicate\s+(?:tool|custom\s+tool)|tool\s+\S+\s+(?:is\s+)?already\s+(?:registered|defined|exists)/i;

/**
 * What a failure to create or resume the native session on the remote runtime, or a session error the model run reported, means for the turn. A typed error is kept. A refusal the
 * worker's own broker made, or a tool declaration the runtime refuses as a duplicate, is permanent (the configuration is what is wrong, so repeating the turn cannot help). Anything
 * else is a cache problem: the sandbox is invalidated, and the turn may be retried from the stored head.
 */
export function classifyStoreOwnedSessionFailure(error: unknown, text?: string): unknown {
    if (isStoreOwnedError(error) || isOpaqueArchiveError(error)) return error;
    const name = (error as { name?: unknown } | null)?.name;
    if (name === "RemoteRuntimeError" || name === "ComputeTargetError") return error;
    const message = text ?? (error instanceof Error ? error.message : typeof error === "string" ? error : "");
    if (PERMANENT_BROKER_REFUSAL.test(message)) {
        return new StoreOwnedError("STORE_OWNED_BROKER_REFUSED", "the worker's model broker refused a request of the remote runtime; the session's model provider configuration cannot be served remotely", { cause: error });
    }
    if (PERMANENT_TOOL_REFUSAL.test(message)) {
        return new StoreOwnedError("STORE_OWNED_SESSION_UNAVAILABLE", "the remote runtime refused the session's tool declarations as a duplicate; the session's tool configuration is what must change", { cause: error });
    }
    return new StoreOwnedError("STORE_OWNED_SESSION_UNAVAILABLE", "the native session could not be created or resumed on the remote sandbox; the turn may be retried from the stored head", { terminal: false, cause: error });
}
