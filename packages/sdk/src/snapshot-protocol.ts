/**
 * Session lifecycle protocol: versioned CAS snapshot contract + worker-local
 * marker/sentinel files (docs/proposals/session-lifecycle-protocol.md §3.1–3.3).
 *
 * The store keeps a monotonic per-session `version`, advanced only by
 * compare-and-swap commits. The worker keeps two protocol files inside the
 * session directory:
 *
 *   - `.ps-snapshot-version` (marker) — the version the local files represent.
 *     Written after every successful commit and hydrate; EXCLUDED from tars
 *     (it describes the dir relative to the store; a tarred copy would be
 *     stale by construction).
 *   - `.ps-turn-inprogress` (sentinel) — presence marks the dir as
 *     mid-mutation by a turn body. Written before the LLM body starts,
 *     removed only after the post-turn commit lands. EXCLUDED from tars.
 *   - `.ps-turn-commit.json` — the committed turn's {turnKey, result},
 *     written just before the commit tar so the already-committed recovery
 *     path can return the stored result without re-running the turn.
 *     INCLUDED in tars (it rides in the snapshot itself, dodging any
 *     store-metadata size cap).
 *
 * @internal
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SnapshotCodec } from "./session-store.js";

export const PS_MARKER_FILE = ".ps-snapshot-version";
export const PS_SENTINEL_FILE = ".ps-turn-inprogress";
export const PS_TURN_COMMIT_FILE = ".ps-turn-commit.json";

export interface SnapshotMarker {
    version: number;
    turnKey?: string;
    contentHash?: string;
    /**
     * Transcript epoch the local files belong to (session regeneration).
     * Absent = 0 (legacy). A marker whose epoch differs from the
     * orchestration's current epoch names a DEAD incarnation: the lifecycle
     * preamble must treat the dir as untrusted and resolve from the
     * epoch-scoped store — never trust it warm, never throw.
     */
    epoch?: number;
    updatedAt: string;
}

export interface TurnSentinel {
    turnKey?: string;
    startedAt: string;
    /**
     * The turn started on a conversation this protocol created fresh with
     * nothing saved (its preamble found an empty store, no loss). Stays true
     * along a chain of unsaved turns; a save replaces it with a marker.
     */
    freshChain?: boolean;
}

export interface SnapshotProbe {
    exists: boolean;
    /** Monotonic version; 0 when the snapshot predates the protocol (legacy). */
    version: number;
    turnKey?: string;
    contentHash?: string;
    /** Compressed (stored) tar size in bytes. */
    sizeBytes?: number;
    /** Uncompressed tar-stream size in bytes (feeds the compression-ratio stat). */
    rawSizeBytes?: number;
    /** True when a snapshot exists but carries no version metadata. */
    legacy?: boolean;
    /**
     * Defensive: the tar object carries the opaque-archive marker. Opaque archives live under their own object names, never as a local tar, so this is only ever
     * set by an object another writer put in the wrong place; the local tar commit and hydrate refuse it.
     */
    opaque?: true;
}

export interface SnapshotCommitInput {
    /** The stored version this commit is based on (preamble-resolved). */
    baseVersion: number;
    /** Deterministic per-turn key — makes commit retries idempotent. */
    turnKey: string;
}

export interface SnapshotCommitResult {
    version: number;
    contentHash: string;
    /** Committed (compressed) tar size — feeds session persistence stats. */
    sizeBytes?: number;
    /** Uncompressed tar-stream size — feeds the compression-ratio stat. */
    rawSizeBytes?: number;
    /**
     * True when the store already held baseVersion+1 under the same turnKey —
     * a prior attempt of this same turn committed. The caller must treat this
     * as success without re-writing.
     */
    alreadyCommitted: boolean;
}

export interface SnapshotHydrateResult {
    version: number;
    turnKey?: string;
    contentHash?: string;
    sizeBytes?: number;
    rawSizeBytes?: number;
    legacy?: boolean;
}

/**
 * Foreign writer advanced the session past the caller's base — split-brain
 * fence. Loud by design: the activity fails and re-validates via retry.
 */
export class SnapshotConflictError extends Error {
    storedVersion: number;
    storedTurnKey?: string;
    constructor(sessionId: string, baseVersion: number, storedVersion: number, storedTurnKey?: string) {
        super(
            `Snapshot CAS conflict for ${sessionId}: expected stored version ${baseVersion}, ` +
            `found ${storedVersion}${storedTurnKey ? ` (turnKey ${storedTurnKey})` : ""}`,
        );
        this.name = "SnapshotConflictError";
        this.storedVersion = storedVersion;
        this.storedTurnKey = storedTurnKey;
    }
}

/**
 * Versioned CAS contract implemented by session snapshot stores
 * (filesystem + Azure blob in this phase; PG later). All methods operate on
 * whole snapshots — the same tar the legacy dehydrate/hydrate/checkpoint
 * paths move around.
 */
export interface VersionedSnapshotStore {
    /** Cheap metadata read — no snapshot bytes transferred. */
    probeSnapshot(sessionId: string, epoch?: number): Promise<SnapshotProbe>;
    /**
     * Tar the local session dir and CAS-write it: succeed iff the stored
     * version equals `baseVersion` (or the same turnKey already committed
     * baseVersion+1 → `alreadyCommitted`). Local files are NOT removed.
     * Throws {@link SnapshotConflictError} on a foreign advance.
     */
    commitSnapshot(sessionId: string, input: SnapshotCommitInput, epoch?: number): Promise<SnapshotCommitResult>;
    /**
     * Download the stored snapshot and atomically replace the local session
     * dir (unpack to a temp dir, then rename — a crash mid-hydrate never
     * leaves a plausible-looking dir). Does NOT write the marker; the
     * lifecycle layer does, so marker semantics live in one place.
     */
    hydrateSnapshot(sessionId: string, epoch?: number): Promise<SnapshotHydrateResult>;
    /**
     * Opaque-archive `store-wins` contract (state policy "store-owned"). Optional: a store that does not implement all four is refused by `supportsOpaqueArchives`
     * before any I/O. The opaque chain lives under its OWN object names (`<session>[.e<epoch>].sandbox.bin`), separate from the local tar chain, so no worker that
     * predates this contract can ever see or unpack the bytes.
     */
    probeSnapshotArchive?(sessionId: string, epoch?: number): Promise<OpaqueArchiveProbe>;
    commitSnapshotArchive?(sessionId: string, input: SnapshotArchiveCommitInput, epoch?: number): Promise<SnapshotCommitResult>;
    readSnapshotArchive?(sessionId: string, epoch?: number, options?: SnapshotArchiveReadOptions): Promise<SnapshotArchiveRead | null>;
    readTrustedTurnCommit?(sessionId: string, epoch?: number): Promise<TrustedTurnCommit | null>;
}

/**
 * Epoch key scoping (session regeneration, proposal §6):
 *
 *   epoch 0 (or absent)  →  the LEGACY key family, byte-for-byte — blob
 *                           `S.tar.gz`, fs `S.v<N>.tar.{br,gz}` + `S.meta.json`.
 *                           Every pre-regen session keeps its storage forever;
 *                           there is no migration.
 *   epoch >= 1           →  a separate CAS chain per epoch whose version
 *                           numbering restarts at 1. KEY-SHAPE INVARIANT: no
 *                           epoch-scoped BLOB name may end in `.tar.gz` or
 *                           `.meta.json` — those are the only shapes the
 *                           shipped 1.0.66 resource-manager purge collects as
 *                           delete candidates (resourcemgr-tools.ts:441-449),
 *                           and fail-closed parsing in NEW code cannot protect
 *                           against an OLD binary. Epoch blobs are
 *                           `S.e<E>.tar.br` (brotli is the only codec for new
 *                           chains) with `psepoch` metadata and no meta.json
 *                           mirror.
 *
 * Separate chains are the fence that makes a zombie old-epoch commit harmless
 * to the new epoch: it lands on its own key with its own CAS counter.
 */
export function isLegacyEpoch(epoch: number | undefined): boolean {
    return !epoch || epoch <= 0;
}

export function supportsVersionedSnapshots(store: unknown): store is VersionedSnapshotStore {
    const s = store as VersionedSnapshotStore | null;
    return Boolean(
        s
        && typeof s.probeSnapshot === "function"
        && typeof s.commitSnapshot === "function"
        && typeof s.hydrateSnapshot === "function",
    );
}

// ─── Opaque archives (state policy "store-owned") ───────────────────────────
//
// The store, not the compute host, owns the authoritative session state. The compute host hands the worker one compressed archive per turn; the worker stores it as
// opaque bytes (SHA-256 over the bytes, conditional CAS write, `store-wins`) and NEVER unpacks, parses or lists it.
//
// Objects (blob names; the filesystem store uses the same family with versioned file names):
//   <session>[.e<epoch>].sandbox.bin                      the head: the opaque archive + `psver`, `psturnkey`, `pssha`, `pscodec`, `psopaque`, `psrec`, `psrecsha`
//   <session>[.e<epoch>].turn-commit.<sha256(turnKey)[:32]>.json   the worker-owned turn record, written BEFORE the head, create-only
// Neither name ends `.tar.gz` or `.meta.json`, and a worker that predates this contract never reads or unpacks a `.sandbox.bin`.
// The turn record names its head (session, epoch, version, content hash, turn key) and the head stamps the record's SHA-256, so a record is trusted only for the exact
// head that stamped it; a crash between the record and the head leaves an orphan that the next attempt of the same turn replaces.

/** The hard cap on one opaque archive (16 MiB). A caller may lower it; nothing raises it and nothing is unbounded. */
export const REMOTE_SNAPSHOT_ARCHIVE_MAX_BYTES = 16 * 1024 * 1024;
/** The cap on a turn record's `{ turnKey, result }` JSON (64 KiB). */
export const REMOTE_TURN_COMMIT_MAX_BYTES = 64 * 1024;
const TURN_COMMIT_RECORD_SCHEMA = "pilotswarm.turn-commit/v2";
const TURN_KEY_MAX_LENGTH = 512;
const COMPACT_TEXT_CHARS = 4096;

export interface OpaqueArchiveProbe extends SnapshotProbe {
    /** The head's ETag (blob store) or its content hash (filesystem store); pass it back as `expectedEtag` to pin this exact head. */
    etag?: string;
    codec?: SnapshotCodec;
}

export interface SnapshotArchiveCommitInput {
    /** The stored version this commit is based on; 0 for a chain with no head. */
    baseVersion: number;
    /** Deterministic per-turn key; makes a retry of the same commit idempotent. */
    turnKey: string;
    /** The compressed archive, opaque to the worker. Copied before use. */
    archiveBytes: Uint8Array;
    /** How the bytes are compressed (declared, never sniffed). */
    codec: SnapshotCodec;
    /** Uncompressed size the host reports, informational. */
    rawSizeBytes?: number;
    /** Pins the exact head the commit is based on (the probe's `etag`): a head that is not that exact object, or no head at all, is a conflict. */
    expectedEtag?: string;
    /** The turn's result, kept in the worker-owned record. `turnKey` must equal the commit's. At most 64 KiB of JSON (see `fitTurnCommit`). */
    turnCommit?: TrustedTurnCommit;
    /** A lower cap than the hard cap for this commit. */
    maxArchiveBytes?: number;
}

export interface SnapshotArchiveReadOptions {
    /** A lower cap than the hard cap for this read. */
    maxBytes?: number;
}

export interface SnapshotArchiveRead {
    version: number;
    turnKey?: string;
    contentHash: string;
    codec: SnapshotCodec;
    sizeBytes: number;
    rawSizeBytes?: number;
    /** The head's ETag (blob store) or its content hash (filesystem store). */
    etag?: string;
    archiveBytes: Uint8Array;
}

export interface TrustedTurnCommit {
    turnKey: string;
    result: unknown;
}

export type OpaqueArchiveErrorCode = "ARCHIVE_INVALID" | "ARCHIVE_TOO_LARGE" | "ARCHIVE_CORRUPT" | "ARCHIVE_REPRESENTATION_CONFLICT";

/** An opaque-archive request or stored object outside the accepted limits. Nothing was written; fixed text, never archive bytes. */
export class OpaqueArchiveError extends Error {
    code: OpaqueArchiveErrorCode;
    constructor(code: OpaqueArchiveErrorCode, message: string) {
        super(`${code}: ${message}`);
        this.name = "OpaqueArchiveError";
        this.code = code;
    }
}

export function isOpaqueArchiveError(error: unknown): error is OpaqueArchiveError {
    return error instanceof OpaqueArchiveError || (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "OpaqueArchiveError");
}

export function supportsOpaqueArchives(store: unknown): store is VersionedSnapshotStore
    & Required<Pick<VersionedSnapshotStore, "probeSnapshotArchive" | "commitSnapshotArchive" | "readSnapshotArchive" | "readTrustedTurnCommit">> {
    const s = store as Partial<VersionedSnapshotStore> | null;
    return supportsVersionedSnapshots(s)
        && typeof s?.probeSnapshotArchive === "function"
        && typeof s?.commitSnapshotArchive === "function"
        && typeof s?.readSnapshotArchive === "function"
        && typeof s?.readTrustedTurnCommit === "function";
}

/** The effective byte cap: the hard cap, or a lower positive integer. A higher or invalid value is refused, never clamped silently. */
export function effectiveArchiveCap(requested: number | undefined): number {
    if (requested === undefined) return REMOTE_SNAPSHOT_ARCHIVE_MAX_BYTES;
    if (!Number.isInteger(requested) || requested < 1 || requested > REMOTE_SNAPSHOT_ARCHIVE_MAX_BYTES) {
        throw new OpaqueArchiveError("ARCHIVE_INVALID", `the archive size cap must be an integer from 1 to ${REMOTE_SNAPSHOT_ARCHIVE_MAX_BYTES}`);
    }
    return requested;
}

export interface ValidatedArchiveCommit {
    /** A private copy of the bytes (the caller's buffer may change after validation). */
    body: Buffer;
    contentHash: string;
    codec: SnapshotCodec;
    rawSizeBytes: number | undefined;
    turnCommit: TrustedTurnCommit | null;
}

/** Everything about a commit that can be checked without touching a store: refused BEFORE any storage access. The archive is never opened. */
export function validateArchiveCommit(sessionId: string, input: SnapshotArchiveCommitInput): ValidatedArchiveCommit {
    const bad = (message: string) => new OpaqueArchiveError("ARCHIVE_INVALID", message);
    if (typeof sessionId !== "string" || sessionId.length === 0) throw bad("the session id is required");
    if (!input || typeof input !== "object") throw bad("the commit input is required");
    if (!Number.isInteger(input.baseVersion) || input.baseVersion < 0) throw bad("the base version must be a non-negative integer");
    if (typeof input.turnKey !== "string" || input.turnKey.length === 0 || input.turnKey.length > TURN_KEY_MAX_LENGTH) throw bad("the turn key must be a non-empty string of bounded length");
    if (input.codec !== "gzip" && input.codec !== "brotli") throw bad("the codec must be gzip or brotli");
    if (input.rawSizeBytes !== undefined && (!Number.isFinite(input.rawSizeBytes) || input.rawSizeBytes < 0)) throw bad("the raw size must be a non-negative number");
    if (input.expectedEtag !== undefined && (typeof input.expectedEtag !== "string" || input.expectedEtag.length === 0 || input.expectedEtag.length > 256)) throw bad("the expected ETag must be a bounded string");
    const cap = effectiveArchiveCap(input.maxArchiveBytes);
    const bytes = input.archiveBytes;
    if (!(bytes instanceof Uint8Array)) throw bad("the archive must be bytes");
    if (bytes.byteLength === 0) throw bad("the archive is empty");
    if (bytes.byteLength > cap) throw new OpaqueArchiveError("ARCHIVE_TOO_LARGE", `the archive is ${bytes.byteLength} bytes, over the ${cap}-byte cap; nothing was stored`);
    let turnCommit: TrustedTurnCommit | null = null;
    if (input.turnCommit !== undefined) {
        const tc = input.turnCommit;
        if (!tc || typeof tc !== "object" || tc.turnKey !== input.turnKey) throw bad("the turn commit must carry the commit's own turn key");
        turnCommitJson(tc);
        turnCommit = { turnKey: tc.turnKey, result: tc.result };
    }
    const body = Buffer.from(bytes);
    return {
        body,
        contentHash: crypto.createHash("sha256").update(body).digest("hex"),
        codec: input.codec,
        rawSizeBytes: input.rawSizeBytes === undefined ? undefined : Math.floor(input.rawSizeBytes),
        turnCommit,
    };
}

function turnCommitJson(turnCommit: TrustedTurnCommit): string {
    let json: string | undefined;
    try {
        json = JSON.stringify({ turnKey: turnCommit.turnKey, result: turnCommit.result });
    } catch {
        json = undefined;
    }
    if (json === undefined) throw new OpaqueArchiveError("ARCHIVE_INVALID", "the turn result is not JSON data");
    if (Buffer.byteLength(json, "utf8") > REMOTE_TURN_COMMIT_MAX_BYTES) {
        throw new OpaqueArchiveError("ARCHIVE_TOO_LARGE", `the turn commit is over ${REMOTE_TURN_COMMIT_MAX_BYTES} bytes; nothing was stored`);
    }
    return json;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function compactTurnResult(result: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = { truncated: true };
    if (isPlainRecord(result)) {
        for (const key of ["type", "status", "reason"]) {
            const value = result[key];
            if (typeof value === "string") out[key] = value.slice(0, 256);
        }
        for (const key of ["content", "message"]) {
            const value = result[key];
            if (typeof value === "string") out[key] = value.slice(0, COMPACT_TEXT_CHARS);
        }
    }
    return out;
}

/**
 * The turn record that fits 64 KiB: the result itself; else the result without its `events`; else a bounded compact result (its `type`, `status`, `reason` and the first
 * part of its `content` or `message`, marked `truncated: true`). A turn is never left without a record because its result was large.
 */
export function fitTurnCommit(turnKey: string, result: unknown): { turnCommit: TrustedTurnCommit; record: "stored" | "compacted" } {
    const size = (value: unknown) => Buffer.byteLength(JSON.stringify({ turnKey, result: value }), "utf8");
    if (size(result) <= REMOTE_TURN_COMMIT_MAX_BYTES) return { turnCommit: { turnKey, result }, record: "stored" };
    if (isPlainRecord(result) && Object.hasOwn(result, "events")) {
        const { events: _events, ...rest } = result;
        if (size(rest) <= REMOTE_TURN_COMMIT_MAX_BYTES) return { turnCommit: { turnKey, result: rest }, record: "compacted" };
    }
    return { turnCommit: { turnKey, result: compactTurnResult(result) }, record: "compacted" };
}

/** The 32-hex scope of a turn's record name and head stamp. */
export function turnCommitSuffix(turnKey: string): string {
    return crypto.createHash("sha256").update(turnKey, "utf8").digest("hex").slice(0, 32);
}

function opaquePrefix(sessionId: string, epoch: number | undefined): string {
    return isLegacyEpoch(epoch) ? sessionId : `${sessionId}.e${epoch}`;
}

/** The blob head of the opaque chain: `S.sandbox.bin` for epoch 0, `S.e<N>.sandbox.bin` for a later epoch. */
export function sandboxArchiveObjectName(sessionId: string, epoch?: number): string {
    return `${opaquePrefix(sessionId, epoch)}.sandbox.bin`;
}

/** The turn record of one turn: create-only and scoped by the turn key, so it never names (or overwrites) another turn's record. */
export function turnCommitObjectName(sessionId: string, epoch: number | undefined, turnKey: string): string {
    return `${opaquePrefix(sessionId, epoch)}.turn-commit.${turnCommitSuffix(turnKey)}.json`;
}

/** The prefix every turn record of one chain starts with (for deletion). */
export function turnCommitObjectPrefix(sessionId: string, epoch?: number): string {
    return `${opaquePrefix(sessionId, epoch)}.turn-commit.`;
}

/**
 * Fail-closed parse of an opaque-chain object name (blob head, filesystem versioned archive or meta, turn record). Deletion paths may remove ONLY names this
 * accepts; anything else under a prefix is left alone.
 */
export function parseOpaqueObjectName(
    sessionId: string,
    name: string,
): { epoch: number; kind: "archive" | "fs-archive" | "fs-meta" | "turn-commit"; version?: number } | null {
    const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = name.match(new RegExp(`^${escaped}(?:\\.e(\\d+))?\\.(sandbox\\.bin|sandbox\\.v(\\d+)\\.bin|sandbox\\.meta\\.json|turn-commit\\.[0-9a-f]{32}\\.json)$`));
    if (!match) return null;
    const epoch = match[1] === undefined ? 0 : Number(match[1]);
    if (match[1] !== undefined && epoch < 1) return null;
    const tail = match[2];
    if (tail === "sandbox.bin") return { epoch, kind: "archive" };
    if (tail === "sandbox.meta.json") return { epoch, kind: "fs-meta" };
    if (tail.startsWith("turn-commit.")) return { epoch, kind: "turn-commit" };
    return { epoch, kind: "fs-archive", version: Number(match[3]) };
}

export interface TurnCommitRecordBinding {
    sessionId: string;
    epoch?: number;
    version: number;
    contentHash: string;
    turnKey: string;
}

/** The worker-owned record for a head about to be written, with the SHA-256 the head stamps. Refuses a result over 64 KiB (see `fitTurnCommit`). */
export function encodeTurnCommitRecord(binding: TurnCommitRecordBinding, result: unknown): { text: string; sha256: string; suffix: string } {
    const json = turnCommitJson({ turnKey: binding.turnKey, result });
    const parsed = JSON.parse(json) as { result?: unknown };
    const text = JSON.stringify({
        schema: TURN_COMMIT_RECORD_SCHEMA,
        sessionId: binding.sessionId,
        epoch: isLegacyEpoch(binding.epoch) ? 0 : binding.epoch,
        version: binding.version,
        contentHash: binding.contentHash,
        turnKey: binding.turnKey,
        result: parsed.result === undefined ? null : parsed.result,
    });
    return { text, sha256: crypto.createHash("sha256").update(text, "utf8").digest("hex"), suffix: turnCommitSuffix(binding.turnKey) };
}

/** The record's turn commit when its digest is the one the head stamped AND it names exactly this head; null for anything else (torn, replaced, another head). */
export function parseTurnCommitRecord(text: string | null, binding: TurnCommitRecordBinding, stampedSha256: string): TrustedTurnCommit | null {
    if (text === null || Buffer.byteLength(text, "utf8") > REMOTE_TURN_COMMIT_MAX_BYTES + 4096) return null;
    if (crypto.createHash("sha256").update(text, "utf8").digest("hex") !== stampedSha256) return null;
    let value: Record<string, unknown>;
    try {
        value = JSON.parse(text) as Record<string, unknown>;
    } catch {
        return null;
    }
    if (!value || typeof value !== "object" || value.schema !== TURN_COMMIT_RECORD_SCHEMA) return null;
    if (value.sessionId !== binding.sessionId || value.epoch !== (isLegacyEpoch(binding.epoch) ? 0 : binding.epoch)) return null;
    if (value.version !== binding.version || value.contentHash !== binding.contentHash || value.turnKey !== binding.turnKey) return null;
    return { turnKey: binding.turnKey, result: value.result };
}

// ─── Worker-local protocol files ────────────────────────────────────────────

function markerPath(sessionDir: string): string {
    return path.join(sessionDir, PS_MARKER_FILE);
}

function sentinelPath(sessionDir: string): string {
    return path.join(sessionDir, PS_SENTINEL_FILE);
}

export function turnCommitFilePath(sessionDir: string): string {
    return path.join(sessionDir, PS_TURN_COMMIT_FILE);
}

export function readSnapshotMarker(sessionDir: string): SnapshotMarker | null {
    try {
        const raw = fs.readFileSync(markerPath(sessionDir), "utf8");
        const parsed = JSON.parse(raw) as SnapshotMarker;
        if (!Number.isFinite(parsed?.version)) return null;
        return parsed;
    } catch {
        return null;
    }
}

export function writeSnapshotMarker(
    sessionDir: string,
    marker: Omit<SnapshotMarker, "updatedAt">,
): void {
    fs.mkdirSync(sessionDir, { recursive: true });
    const tmp = `${markerPath(sessionDir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...marker, updatedAt: new Date().toISOString() }));
    fs.renameSync(tmp, markerPath(sessionDir));
}

export function readTurnSentinel(sessionDir: string): TurnSentinel | null {
    try {
        const raw = fs.readFileSync(sentinelPath(sessionDir), "utf8");
        return JSON.parse(raw) as TurnSentinel;
    } catch {
        return fs.existsSync(sentinelPath(sessionDir)) ? { startedAt: "" } : null;
    }
}

export function writeTurnSentinel(sessionDir: string, turnKey?: string, opts?: { freshChain?: boolean }): void {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
        sentinelPath(sessionDir),
        JSON.stringify({
            ...(turnKey ? { turnKey } : {}),
            startedAt: new Date().toISOString(),
            ...(opts?.freshChain ? { freshChain: true } : {}),
        }),
    );
}

export function clearTurnSentinel(sessionDir: string): void {
    try { fs.unlinkSync(sentinelPath(sessionDir)); } catch {}
}

export function writeTurnCommitFile(sessionDir: string, turnKey: string, result: unknown): void {
    const tmp = `${turnCommitFilePath(sessionDir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ turnKey, result }));
    fs.renameSync(tmp, turnCommitFilePath(sessionDir));
}

export function readTurnCommitFile(sessionDir: string): { turnKey: string; result: unknown } | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(turnCommitFilePath(sessionDir), "utf8"));
        if (typeof parsed?.turnKey !== "string") return null;
        return parsed;
    } catch {
        return null;
    }
}

export function sha256File(filePath: string): string {
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(filePath));
    return hash.digest("hex");
}
