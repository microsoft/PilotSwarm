import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import {
    DEFAULT_WORKSPACE_FILE_MAX_BYTES, WORKSPACE_FILE_ERROR_CODES,
    checkWorkspaceFilePath, type WorkspaceFilesConfig,
} from "./workspace-files.js";
import { runWorkspaceTransferProcess } from "./workspace-transfer-process.js";
import { WORKSPACE_UPLOAD_SCRIPT } from "./workspace-upload-process.js";

export const DEFAULT_WORKSPACE_UPLOAD_PART_BYTES = 524_288;
export const WORKSPACE_UPLOAD_LEGACY_MAX_BYTES = 65_536;
const IDLE_MS = 30 * 60_000, LIFETIME_MS = 2 * 60 * 60_000, RECEIPT_MS = 30 * 60_000;
const MAX_RECORDS = 256, MAX_PARTS = 65_536;
const PREFIX = "WORKSPACE_FILES_UPLOAD_";
export type WorkspaceUploadState = "open" | "completing" | "completed" | "aborted" | "expired" | "failed" | "unknown";
export interface WorkspaceUploadInput {
    folder: string;
    path: string;
    size: number;
    sha256?: string;
    ifMatch?: string | null;
    createParents?: boolean;
}
export interface WorkspaceUploadResult { etag: string; size: number; mtimeMs: number; created: boolean; notificationFailed?: boolean; receiptPersistenceFailed?: boolean }
export interface WorkspaceUploadStatus {
    uploadId: string; state: WorkspaceUploadState; size: number; partBytes: number; partCount: number;
    acceptedParts: number; expiresAt: string; result?: WorkspaceUploadResult;
}
/** @internal Resolved anew by management for every control/data operation. */
export interface WorkspaceTransferContext { sessionId: string; principal: string; folder: string; root: string; base: string; rootPath: string }
/** @internal Shared admission seam for upload and future snapshot resource promises. */
export interface WorkspaceTransferReservation { release(): Promise<void> }
interface Identity { dev: string; ino: string }
interface Prepared {
    binding: { root: string; base: string; target: string; rootId: Identity; baseId: Identity; parentId: Identity };
    stage: { path: string; identity: Identity };
}
interface Transfer {
    id: string; context: WorkspaceTransferContext; input: WorkspaceUploadInput; state: WorkspaceUploadState;
    created: number; touched: number; terminalAt?: number; spool: string; spoolIdentity?: Identity; prepared?: Prepared; candidate?: Identity;
    reservation: WorkspaceTransferReservation; accepted: Array<{ bytes: number; sha256: string }>;
    result?: WorkspaceUploadResult; busy: boolean; abort: AbortController; active?: Promise<unknown>;
    cleaned: boolean; publicationStarted: boolean; notificationAttempted: boolean;
    preparationSafe?: boolean; cleaning?: Promise<void>;
}
function uploadError(reason: string, message: string, status = 409): Error {
    return Object.assign(new Error(message), { code: PREFIX + reason, status, expose: true });
}
function integer(value: number, name: string, min: number, max: number): number {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw uploadError("INVALID", `${name} must be an integer from ${min} to ${max}.`, 400);
    return value;
}
/** @internal */
export function workspaceUploadPartBytes(config: WorkspaceFilesConfig): number {
    return integer(config.uploadPartBytes ?? DEFAULT_WORKSPACE_UPLOAD_PART_BYTES, "uploadPartBytes", 16_384, DEFAULT_WORKSPACE_UPLOAD_PART_BYTES);
}
function isMissing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }

const coordinators = new Map<string, { coordinator: WorkspaceTransferCoordinator; users: number }>();
let runningDataCalls = 0;
/** @internal Clients with the same mount/policy share process-owned state and admission. */
export function acquireWorkspaceTransferCoordinator(config: WorkspaceFilesConfig): { coordinator: WorkspaceTransferCoordinator; release(): Promise<void> } {
    const key = JSON.stringify({
        roots: config.roots.map((root) => [root.name, path.resolve(root.path)]).sort(),
        transferDir: path.resolve(config.transferDir ?? os.tmpdir()),
        maxBytes: config.maxBytes ?? DEFAULT_WORKSPACE_FILE_MAX_BYTES,
        partBytes: config.uploadPartBytes ?? DEFAULT_WORKSPACE_UPLOAD_PART_BYTES,
        diskBytes: config.transferDiskBytes ?? 512 * 1024 ** 2,
        requireMarker: config.requireMarker !== false, timeoutMs: config.timeoutMs ?? 30_000,
    });
    for (const existingKey of coordinators.keys()) {
        if (existingKey !== key) throw uploadError("INVALID", "This process already owns a different workspace transfer configuration; a second admission pool is not allowed.", 400);
    }
    let entry = coordinators.get(key);
    if (!entry) {
        entry = { coordinator: new WorkspaceTransferCoordinator(config), users: 0 };
        coordinators.set(key, entry);
    }
    if (entry.coordinator.lifetimeSignal.aborted) throw uploadError("BUSY", "Workspace transfer coordinator is stopping or has quarantined resources.", 503);
    entry.users++;
    const owned = entry;
    let released = false, releasePromise: Promise<void> | undefined;
    return { coordinator: owned.coordinator, release: () => releasePromise ??= (async () => {
        if (released) return;
        if (owned.users === 1) {
            await owned.coordinator.stop();
            coordinators.delete(key);
        }
        owned.users--; released = true;
    })().catch((error) => { releasePromise = undefined; throw error; }) };
}

/**
 * One management client's process-local coordinator. No shared-store adoption or crash resumption.
 * A reservation/data lane is released only after resource promises and identity-checked cleanup settle.
 */
export class WorkspaceTransferCoordinator {
    readonly partBytes: number;
    private readonly maxBytes: number;
    private readonly diskBytes: number;
    private readonly records = new Map<string, Transfer>();
    private readonly claims = new Map<string, { bytes: number; principal: string; root: string }>();
    private usedBytes = 0;
    private pendingStarts = 0;
    private generation?: Promise<string>;
    private generationIdentity?: Identity;
    private readonly sweepTimer: ReturnType<typeof setInterval>;
    private sweeping?: Promise<void>;
    private stopping = false;
    private readonly lifetime = new AbortController();
    private readonly resources = new Set<Promise<unknown>>();
    private readonly starts = new Set<Promise<unknown>>();
    get lifetimeSignal(): AbortSignal { return this.lifetime.signal; }

    constructor(private readonly config: WorkspaceFilesConfig) {
        this.partBytes = workspaceUploadPartBytes(config);
        this.maxBytes = integer(config.maxBytes ?? DEFAULT_WORKSPACE_FILE_MAX_BYTES, "maxBytes", 1, 1024 ** 3);
        this.diskBytes = integer(config.transferDiskBytes ?? 512 * 1024 ** 2, "transferDiskBytes", 4096, Number.MAX_SAFE_INTEGER);
        integer(config.timeoutMs ?? 30_000, "timeoutMs", 1, 300_000);
        this.sweepTimer = setInterval(() => {
            void this.sweep().catch((error) => console.error("[WorkspaceTransfers] cleanup failed:", error));
        }, 60_000);
        this.sweepTimer.unref();
    }

    /** Reserve synchronously before yielding, including zero-length transfers' finite metadata charge. */
    async reserve(request: { bytes: number; principal: string; root: string }, signal?: AbortSignal): Promise<WorkspaceTransferReservation> {
        if (this.stopping || signal?.aborted) throw uploadError("BUSY", "Workspace transfer coordinator is stopping.", 503);
        integer(request.bytes, "reserved bytes", 4096, Number.MAX_SAFE_INTEGER);
        const claims = [...this.claims.values()];
        if (claims.length >= 128 || claims.filter((c) => c.root === request.root).length >= 8 ||
            claims.filter((c) => c.root === request.root && c.principal === request.principal).length >= 2 ||
            this.usedBytes + request.bytes > this.diskBytes) {
            throw uploadError("QUOTA", "Workspace transfer capacity is full; abort an unused transfer or retry after cleanup.", 429);
        }
        const id = randomUUID();
        this.claims.set(id, request); this.usedBytes += request.bytes;
        return { release: async () => {
            const claim = this.claims.get(id);
            if (claim) { this.claims.delete(id); this.usedBytes -= claim.bytes; }
        } };
    }

    /** Future download primitives use the same process-wide lane, not another semaphore. */
    async runData<T>(operation: () => Promise<T>): Promise<T> {
        if (this.stopping) throw uploadError("BUSY", "Workspace transfer coordinator is stopping.", 503);
        if (runningDataCalls >= 2) throw uploadError("BUSY", "Two workspace data operations are already running here.", 503);
        runningDataCalls++;
        const resource = Promise.resolve().then(operation);
        this.resources.add(resource);
        try { return await resource; } finally { this.resources.delete(resource); runningDataCalls--; }
    }

    folder(sessionId: string, id: string): string {
        const t = this.records.get(id);
        if (!t || t.context.sessionId !== sessionId) throw uploadError("EXPIRED", "Upload handle is unavailable, expired, or belongs to a previous process. Refresh the target before restarting.", 410);
        return t.context.folder;
    }

    filePath(sessionId: string, id: string): string {
        this.folder(sessionId, id);
        return this.records.get(id)!.input.path;
    }

    private async directory(): Promise<string> {
        this.generation ??= (async () => {
            const base = path.resolve(this.config.transferDir ?? os.tmpdir());
            await fs.mkdir(base, { recursive: true, mode: 0o700 });
            if ((await fs.lstat(base)).isSymbolicLink()) throw uploadError("INVALID", "Transfer storage must not be a symlink.", 400);
            const real = await fs.realpath(base);
            const dir = await fs.mkdtemp(path.join(real, "pilotswarm-transfers-"));
            await fs.chmod(dir, 0o700);
            const stat = await fs.lstat(dir, { bigint: true });
            this.generationIdentity = { dev: String(stat.dev), ino: String(stat.ino) };
            return dir;
        })();
        return this.generation;
    }

    private async persist(t: Transfer): Promise<void> {
        const temp = path.join(t.spool, "manifest.next");
        await fs.writeFile(temp, JSON.stringify({
            id: t.id, context: t.context, input: t.input, state: t.state, prepared: t.prepared,
            candidate: t.candidate, accepted: t.accepted, result: t.result,
            publicationStarted: t.publicationStarted,
        }), { mode: 0o600 });
        await fs.rename(temp, path.join(t.spool, "manifest.json"));
    }

    private helper<T>(t: Transfer, op: string, extra: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
        return runWorkspaceTransferProcess<T>(WORKSPACE_UPLOAD_SCRIPT, {
            ...t.input, ...t.context, ...t.prepared, candidate: t.candidate, id: t.id, op,
            spool: t.spool, partBytes: this.partBytes, partCount: Math.ceil(t.input.size / this.partBytes),
            spoolIdentity: t.spoolIdentity,
            maxBytes: this.maxBytes, codes: WORKSPACE_FILE_ERROR_CODES,
            roots: this.config.roots,
            requireMarker: this.config.requireMarker !== false, ...extra,
        }, this.config.timeoutMs ?? 30_000, signal);
    }

    /** HTTP deadline, deliberately independent of the still-tracked resource promise. */
    private async response<T>(operation: Promise<T>): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([operation, new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(uploadError("IN_PROGRESS", "The operation is still being stopped or finalized. Check upload status; do not start publication again.", 409)), (this.config.timeoutMs ?? 30_000) + 100);
            })]);
        } finally { clearTimeout(timer); }
    }

    start(context: WorkspaceTransferContext, input: WorkspaceUploadInput): Promise<WorkspaceUploadStatus> {
        const operation = this.startInternal(context, input);
        this.starts.add(operation);
        void operation.then(() => this.starts.delete(operation), () => this.starts.delete(operation));
        return operation;
    }

    private async startInternal(context: WorkspaceTransferContext, input: WorkspaceUploadInput): Promise<WorkspaceUploadStatus> {
        integer(input?.size, "size", 0, this.maxBytes);
        if (typeof input.folder !== "string" || input.folder !== context.folder) throw uploadError("INVALID", "folder must identify the resolved session folder.", 400);
        const relative = checkWorkspaceFilePath(input.path);
        if (!relative || relative.includes("\\") || relative.split("/").some((part) => part === "..")) throw uploadError("INVALID", "Upload path must name a file inside the folder.", 400);
        if (input.ifMatch !== undefined && input.ifMatch !== null && typeof input.ifMatch !== "string") throw uploadError("INVALID", "ifMatch must be a string or null.", 400);
        if (typeof input.ifMatch === "string" && (input.ifMatch.length > 256 || input.ifMatch.length === 0)) throw uploadError("INVALID", "ifMatch must be a nonempty version tag of at most 256 characters.", 400);
        if (input.createParents !== undefined && typeof input.createParents !== "boolean") throw uploadError("INVALID", "createParents must be boolean.", 400);
        if (input.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.sha256)) throw uploadError("INVALID", "sha256 must be 64 lowercase hexadecimal characters.", 400);
        integer(Math.ceil(input.size / this.partBytes), "partCount", 0, MAX_PARTS);
        if (this.records.size + this.pendingStarts >= MAX_RECORDS) throw uploadError("QUOTA", "Workspace transfer receipt capacity is full.", 429);
        this.pendingStarts++;
        let reservation: WorkspaceTransferReservation;
        try { reservation = await this.reserve({ bytes: input.size * 2 + 4096 + Math.ceil(input.size / this.partBytes) * 512, principal: context.principal, root: context.root }); }
        catch (error) { this.pendingStarts--; throw error; }
        const id = randomUUID(), now = Date.now();
        let spool: string;
        try {
            if (this.stopping) throw uploadError("BUSY", "Workspace transfer coordinator is stopping.", 503);
            spool = path.join(await this.directory(), id);
            if (this.stopping) throw uploadError("BUSY", "Workspace transfer coordinator is stopping.", 503);
            await fs.mkdir(spool, { mode: 0o700 });
        }
        catch (error) { this.pendingStarts--; await reservation.release(); throw error; }
        const t: Transfer = {
            id, context: { ...context }, input: {
                folder: input.folder, path: relative, size: input.size,
                ...(input.ifMatch !== undefined ? { ifMatch: input.ifMatch } : {}),
                ...(input.sha256 !== undefined ? { sha256: input.sha256 } : {}),
                ...(input.createParents !== undefined ? { createParents: input.createParents } : {}),
            }, state: "open", created: now, touched: now,
            spool, reservation, accepted: [], busy: true, abort: new AbortController(), cleaned: false,
            publicationStarted: false, notificationAttempted: false,
        };
        this.records.set(id, t);
        this.pendingStarts--;
        let running = false;
        const operation = (async () => {
            const stat = await fs.lstat(spool, { bigint: true });
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw uploadError("CLEANUP", "Private transfer storage changed before preparation.", 500);
            t.spoolIdentity = { dev: String(stat.dev), ino: String(stat.ino) };
            return this.runData(async () => {
                running = true;
                try {
                    await this.persist(t);
                    t.prepared = await this.helper<Prepared>(t, "prepare", {}, t.abort.signal);
                    await this.persist(t);
                    return this.statusOf(t);
                } catch (error) {
                    t.state = "failed"; t.terminalAt = Date.now();
                    t.preparationSafe = (error as { preparationSafe?: boolean }).preparationSafe === true;
                    await this.cleanup(t);
                    throw error;
                } finally { t.busy = false; }
            });
        })().catch(async (error) => {
            if (!running) { t.preparationSafe = true; t.state = "failed"; t.terminalAt = Date.now(); await this.cleanup(t); t.busy = false; }
            throw error;
        });
        t.active = operation;
        return this.response(operation);
    }

    private row(context: WorkspaceTransferContext, id: string): Transfer {
        const t = this.records.get(id);
        if (!t || JSON.stringify(context) !== JSON.stringify(t.context)) throw uploadError("EXPIRED", "Upload handle is unavailable for this principal, session, or workspace binding.", 410);
        if (t.state === "open" && this.expired(t)) throw uploadError("EXPIRED", "Upload expired. Refresh the target before starting again.", 410);
        t.touched = Date.now();
        return t;
    }

    private statusOf(t: Transfer): WorkspaceUploadStatus {
        return {
            uploadId: t.id, state: t.state, size: t.input.size, partBytes: this.partBytes,
            partCount: Math.ceil(t.input.size / this.partBytes), acceptedParts: t.accepted.length,
            expiresAt: new Date(Math.min(t.touched + IDLE_MS, t.created + LIFETIME_MS)).toISOString(),
            ...(t.result ? { result: t.result } : {}),
        };
    }

    async status(context: WorkspaceTransferContext, id: string): Promise<WorkspaceUploadStatus> {
        const t = this.row(context, id);
        if (!t.busy && !t.cleaned) await this.response(this.runData(() => this.helper(t, "validate")));
        return this.statusOf(t);
    }

    async put(context: WorkspaceTransferContext, id: string, part: number, input: Uint8Array | (() => Promise<Uint8Array>), signal?: AbortSignal): Promise<{ part: number; bytes: number; sha256: string }> {
        const t = this.row(context, id);
        if (t.state !== "open") throw uploadError("IN_PROGRESS", `Upload is ${t.state}; no further parts can be accepted.`);
        if (t.busy) throw uploadError("BUSY", "Another operation is using this upload.", 503);
        integer(part, "part", 0, Math.ceil(t.input.size / this.partBytes) - 1);
        const expected = Math.min(this.partBytes, t.input.size - part * this.partBytes);
        if (part > t.accepted.length) throw uploadError("INCOMPLETE", "Upload parts must be accepted in order.", 409);
        if (typeof input !== "function" && (!(input instanceof Uint8Array) || input.byteLength !== expected)) throw uploadError("INCOMPLETE", `Part ${part} must contain exactly ${expected} bytes.`, 400);
        const direct = typeof input !== "function" ? Buffer.from(input) : undefined;
        t.busy = true;
        const operation = this.runData(async () => {
            const attempt = path.join(t.spool, "part-" + randomUUID());
            try {
                await this.helper(t, "validate", {}, t.abort.signal);
                const bytes = direct ?? await (input as () => Promise<Uint8Array>)();
                if (!(bytes instanceof Uint8Array) || bytes.byteLength !== expected) throw uploadError("INCOMPLETE", `Part ${part} must contain exactly ${expected} bytes.`, 400);
                const digest = createHash("sha256").update(bytes).digest("hex");
                const previous = t.accepted[part];
                if (previous) {
                    if (previous.sha256 !== digest || previous.bytes !== bytes.byteLength) throw uploadError("PART_CONFLICT", "This part was already accepted with different bytes.");
                    return { part, ...previous };
                }
                if (signal?.aborted || t.abort.signal.aborted) throw uploadError("CANCELLED", "Upload part cancelled.", 499);
                await fs.writeFile(attempt, bytes, { flag: "wx", mode: 0o600, signal });
                if (signal?.aborted || t.abort.signal.aborted) throw uploadError("CANCELLED", "Upload part cancelled.", 499);
                await fs.rename(attempt, path.join(t.spool, String(part)));
                t.accepted.push({ bytes: bytes.byteLength, sha256: digest });
                await this.persist(t);
                return { part, bytes: bytes.byteLength, sha256: digest };
            } catch (error) {
                if (["ENOSPC", "EDQUOT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw uploadError("QUOTA", "Local upload storage is full; abort the transfer to release its reservation.", 507);
                throw error;
            } finally {
                try { await fs.unlink(attempt); }
                catch (error) {
                    if (!isMissing(error)) {
                        t.state = "failed"; t.terminalAt = Date.now();
                        console.error("[WorkspaceTransfers] part cleanup failed; reservation retained:", error);
                        throw uploadError("CLEANUP", "Part cleanup failed. The transfer is closed and its capacity remains reserved until cleanup succeeds.", 500);
                    }
                }
                t.busy = false;
            }
        }).finally(() => { t.busy = false; });
        t.active = operation;
        return this.response(operation);
    }

    async complete(context: WorkspaceTransferContext, id: string, notify: (result: WorkspaceUploadResult) => Promise<void>, revalidate?: () => Promise<void>): Promise<WorkspaceUploadResult> {
        const t = this.row(context, id);
        if (t.state === "completed" && t.result) return t.result;
        if (t.state === "unknown") throw uploadError("COMMIT_UNKNOWN", "Publication may have completed. Refresh the target before deciding whether to upload again.");
        if (t.state !== "open" || t.busy) throw uploadError("IN_PROGRESS", `Upload is ${t.state} or has an active operation; check its status.`, 409);
        if (t.accepted.length !== Math.ceil(t.input.size / this.partBytes)) throw uploadError("INCOMPLETE", "Upload is missing one or more parts.");
        t.state = "completing"; t.busy = true;
        let running = false;
        const operation = this.runData(async () => {
            running = true;
            try {
                await this.persist(t);
                const candidate = await this.helper<{ identity: Identity }>(t, "candidate", {}, t.abort.signal);
                t.candidate = candidate.identity; await this.persist(t);
                const assembled = await this.helper<{ etag: string }>(t, "assemble", { receipts: t.accepted }, t.abort.signal);
                await revalidate?.();
                await this.helper(t, "validate", {}, t.abort.signal);
                t.publicationStarted = true; await this.persist(t);
                try {
                    t.result = await this.helper<WorkspaceUploadResult>(t, "publish", { etag: assembled.etag }, t.abort.signal);
                } catch (error) {
                    const code = (error as { code?: string }).code;
                    if (code === WORKSPACE_FILE_ERROR_CODES.TIMEOUT || code === WORKSPACE_FILE_ERROR_CODES.IO) {
                        t.state = "unknown";
                        throw uploadError("COMMIT_UNKNOWN", "The publication helper exited without a confirmed receipt. Refresh the destination; publication will not be retried.");
                    }
                    throw error;
                }
                t.state = "completed";
                try { await this.persist(t); }
                catch (error) {
                    console.error("[WorkspaceTransfers] file committed but local receipt persistence failed:", error);
                    t.result.receiptPersistenceFailed = true;
                }
                t.notificationAttempted = true;
                try { await notify(t.result); }
                catch (error) {
                    console.error("[WorkspaceTransfers] file committed but change notification failed:", error);
                    t.result.notificationFailed = true;
                    try { await this.persist(t); }
                    catch (receiptError) {
                        console.error("[WorkspaceTransfers] committed-file warning persistence failed:", receiptError);
                        t.result.receiptPersistenceFailed = true;
                    }
                }
                return t.result;
            } catch (error) {
                if (t.state === "completing") t.state = t.result ? "completed" : "failed";
                throw error;
            } finally {
                t.terminalAt = Date.now();
                try { await this.cleanup(t); }
                catch (error) { console.error("[WorkspaceTransfers] upload cleanup retained its reservation:", error); }
                t.busy = false;
            }
        }).catch((error) => {
            if (!running) { t.state = "open"; t.busy = false; }
            throw error;
        });
        t.active = operation;
        return this.response(operation);
    }

    async abort(context: WorkspaceTransferContext, id: string): Promise<{ state: WorkspaceUploadState }> {
        const t = this.row(context, id);
        if (t.state === "completing" || t.state === "completed" || t.state === "unknown") throw uploadError("IN_PROGRESS", `Upload is ${t.state}; abort cannot roll back publication.`);
        t.state = "aborted"; t.terminalAt = Date.now(); t.abort.abort();
        await this.response((async () => {
            if (t.active) await t.active.catch(() => {});
            await this.cleanup(t);
        })());
        return { state: t.state };
    }

    private async cleanup(t: Transfer): Promise<void> {
        if (t.cleaning) return t.cleaning;
        t.cleaning = this.removeResources(t);
        try { await t.cleaning; } finally { t.cleaning = undefined; }
    }

    private async removeResources(t: Transfer): Promise<void> {
        if (t.cleaned) return;
        const [spoolStat, generationStat] = await Promise.all([fs.lstat(t.spool, { bigint: true }), fs.lstat(path.dirname(t.spool), { bigint: true })]);
        if (spoolStat.isSymbolicLink() || generationStat.isSymbolicLink() ||
            String(spoolStat.dev) !== t.spoolIdentity?.dev || String(spoolStat.ino) !== t.spoolIdentity?.ino ||
            String(generationStat.dev) !== this.generationIdentity?.dev || String(generationStat.ino) !== this.generationIdentity?.ino) {
            throw uploadError("CLEANUP", "Private transfer storage identity changed; no files were deleted and the reservation is retained.", 500);
        }
        if (t.prepared) await this.helper(t, "cleanup");
        else if (!t.preparationSafe) {
            // prepare may have died before acknowledging a directory identity.
            // Never guess that deleting a possible destination entry is safe.
            if (await fs.stat(path.join(t.spool, "manifest.json")).then(() => true, (e) => { if (isMissing(e)) return false; throw e; })) {
                throw uploadError("CLEANUP", "Destination preparation was not acknowledged; its reservation is retained for operator inspection.", 500);
            }
        }
        await fs.rm(t.spool, { recursive: true });
        t.cleaned = true;
        await t.reservation.release();
    }

    private expired(t: Transfer): boolean { return Date.now() >= Math.min(t.touched + IDLE_MS, t.created + LIFETIME_MS); }
    async sweep(): Promise<void> {
        if (this.sweeping) return this.sweeping;
        this.sweeping = (async () => {
            for (const t of this.records.values()) {
                if (t.state === "open" && this.expired(t)) {
                    t.state = "expired"; t.terminalAt = Date.now(); t.abort.abort();
                    if (t.active) await t.active.catch(() => {});
                }
                if (!t.busy && t.state !== "open" && t.state !== "completing" && !t.cleaned) {
                    try { await this.cleanup(t); }
                    catch (error) { console.error("[WorkspaceTransfers] cleanup will retry with reservation retained:", error); }
                }
                if (t.cleaned && t.terminalAt !== undefined && Date.now() - t.terminalAt >= RECEIPT_MS) this.records.delete(t.id);
            }
        })();
        try { await this.sweeping; } finally { this.sweeping = undefined; }
    }

    async stop(): Promise<void> {
        this.stopping = true; clearInterval(this.sweepTimer); this.lifetime.abort();
        for (const t of this.records.values()) t.abort.abort();
        await Promise.allSettled([...this.starts]);
        for (const t of this.records.values()) t.abort.abort();
        await Promise.allSettled([...this.records.values()].map((t) => t.active));
        await Promise.allSettled([...this.resources]);
        for (const t of this.records.values()) {
            if (t.state === "open") { t.state = "aborted"; t.terminalAt = Date.now(); }
        }
        await this.sweep();
        const retained = [...this.records.values()].filter((t) => !t.cleaned);
        if (retained.length || this.claims.size) throw uploadError("CLEANUP", `${Math.max(retained.length, this.claims.size)} workspace transfer reservation(s) remain quarantined after shutdown.`, 500);
        if (this.generation) await fs.rmdir(await this.generation);
    }
}
