/**
 * Canvas app registry: the service (issue 181).
 *
 * Owns an app's bytes and lifecycle on top of {@link CanvasAppStore} (the CMS
 * procedures, which own authorization) and the provider-neutral
 * {@link ArtifactStore}. Every app gets its own byte space, a reserved
 * artifact "session" id derived from its app id:
 *
 *   publish  check page → sha256 → reserve (SQL picks the version, inserts a
 *            pending row) → upload <version_id>.<sha12>.html → commit
 *            (the object is named after the reservation, never reused, so a
 *            stale cleanup cannot delete a later version's bytes)
 *   delete   SQL deletes rows + writes a tombstone → delete bytes → purged
 *   prune    stale pending rows and unfinished tombstones → delete bytes
 *
 * Pure functions over injected stores, like canvas-app-catalog.ts, so the
 * management client, the session bridge, scripts and tests share one code path.
 */
import { createHash, randomUUID } from "node:crypto";
import type { ArtifactStore } from "./session-store.js";
import {
    CanvasAppError,
    CANVAS_APP_SPACE_PREFIX,
    CANVAS_APP_VERSION_MAX_BYTES,
    looksLikeCanvasAppSpace,
    type CanvasAppScope,
    type CanvasAppStore,
    type CanvasAppTarget,
    type CanvasAppViewer,
} from "./canvas-app-store.js";
import {
    extractCanvasAppManifest,
    normalizeCanvasResponseContract,
    canvasAppCard,
    CANVAS_APP_NAME_RE,
    type CanvasAppManifest,
} from "./canvas-app-manifest.js";
import { buildCanonicalTarGz, readCanonicalTarGz } from "./agent-package-format.js";

/** The canvas document cap, the same as draw_canvas's. */
export const CANVAS_APP_MAX_BYTES = 900_000;
export const CANVAS_APP_DESCRIPTION_MIN = 20;
export const CANVAS_APP_ARCHIVE_MAX_BYTES = 20 * 1024 * 1024;
export const CANVAS_APP_ARCHIVE_MAX_EXPANDED_BYTES = 40 * 1024 * 1024;
export const CANVAS_APP_ARCHIVE_FORMAT = 1;
/** Pending rows older than this are abandoned publishes. */
export const CANVAS_APP_PENDING_TTL_MS = 15 * 60 * 1000;

const SPACE_PREFIX = CANVAS_APP_SPACE_PREFIX;

/**
 * The byte space of one app: an artifact "session" id nobody can create.
 * Fixed 12-hex prefix, UUID version nibble 8 (real session ids are v4), rest
 * from sha256(appId).
 */
export function canvasAppArtifactSessionId(appId: string): string {
    const h = createHash("sha256").update(`pilotswarm-canvas-app:${appId}`).digest("hex");
    const hex = SPACE_PREFIX + h.slice(0, 20);
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        "8" + hex.slice(13, 16),
        ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20),
        hex.slice(20, 32),
    ].join("-");
}

export { looksLikeCanvasAppSpace };

/** JSON with sorted object keys: equal values give equal strings. */
export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        const keys = Object.keys(value as Record<string, unknown>).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as any)[k])}`).join(",")}}`;
    }
    return JSON.stringify(value ?? null);
}

/** The key two pages share when they declare the same workspace access. */
export function canvasAppWorkspaceKey(manifest: CanvasAppManifest | null | undefined): string | null {
    if (!manifest?.workspace) return null;
    return createHash("sha256").update(canonicalJson(manifest.workspace)).digest("hex");
}

export function sha256Hex(text: string | Buffer): string {
    return createHash("sha256").update(text).digest("hex");
}

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export function isSemver(version: unknown): boolean {
    return typeof version === "string" && SEMVER_RE.test(version.trim());
}

export { CANVAS_APP_VERSION_MAX_BYTES };

function checkVersionLength(version: string, where: string): void {
    const size = Buffer.byteLength(version, "utf8");
    if (size > CANVAS_APP_VERSION_MAX_BYTES) {
        throw new CanvasAppError("BAD_VERSION", `${where} "${version.slice(0, 40)}…" is ${size} bytes; a canvas app version is at most ${CANVAS_APP_VERSION_MAX_BYTES} bytes`);
    }
}

export interface CanvasAppPageCheck {
    html: string;
    sha256: string;
    sizeBytes: number;
    manifest: CanvasAppManifest;
    card: Record<string, unknown>;
    workspaceKey: string | null;
}

/**
 * The publish checks (R6), with today's error texts: a manifest, an
 * `interface` block, a valid contract, at most 900 KB.
 */
export function checkCanvasAppPage(html: string, responseContract?: unknown): CanvasAppPageCheck {
    const text = String(html ?? "");
    const sizeBytes = Buffer.byteLength(text, "utf8");
    if (!text.trim()) throw new CanvasAppError("BAD_REQUEST", "the page is empty");
    if (sizeBytes > CANVAS_APP_MAX_BYTES) {
        throw new CanvasAppError("BAD_REQUEST", `the page is ${sizeBytes} bytes; the canvas cap is 900 KB`);
    }
    const extraction = extractCanvasAppManifest(text);
    if (extraction.error) throw new CanvasAppError("BAD_REQUEST", `the canvas's CANVAS-APP-MANIFEST is broken: ${extraction.error}`);
    if (!extraction.manifest) {
        throw new CanvasAppError("BAD_REQUEST", "the canvas has no CANVAS-APP-MANIFEST. A published app must carry one — with an `interface` block (keys, requests, events) — so another agent can drive it from the card without reading the HTML. Add the manifest, redraw, then publish.");
    }
    if (!extraction.manifest.interface) {
        throw new CanvasAppError("BAD_REQUEST", "the manifest has no `interface` block. Declare the KV keys the page uses, the req/* ops it queues and what it expects back (see the canvas-apps skill); that is what another agent drives the app from.");
    }
    let contract: Record<string, any> | null = null;
    const rawContract = responseContract ?? extraction.manifest.responseContract;
    if (rawContract !== undefined && rawContract !== null) {
        const normalized = normalizeCanvasResponseContract(rawContract);
        if (normalized.error) throw new CanvasAppError("BAD_REQUEST", `the response contract is invalid: ${normalized.error}`);
        contract = normalized.contract ?? null;
    }
    const card: Record<string, unknown> = { ...(canvasAppCard(extraction.manifest) ?? {}) };
    if (contract) card.responseContract = contract;
    card.kv = extraction.manifest.kv ?? { write: "owner", shared: [] };
    return {
        html: text,
        sha256: sha256Hex(text),
        sizeBytes,
        manifest: extraction.manifest,
        card,
        workspaceKey: canvasAppWorkspaceKey(extraction.manifest),
    };
}

export interface CanvasAppRegistryDeps {
    store: CanvasAppStore;
    artifactStore: ArtifactStore;
}

export interface PublishCanvasAppHtmlInput {
    html: string;
    name: string;
    scope?: CanvasAppScope;
    version?: string | null;
    description?: string | null;
    tags?: string[] | null;
    responseContract?: unknown;
    viewer: CanvasAppViewer;
    sourceSessionId?: string | null;
    sourceSlot?: number | null;
    createdBy?: string | null;
    mode?: "publish" | "import";
    /** Legacy migration only (admin): a shared app with no owner. */
    allowOwnerless?: boolean;
    /** Import of several versions into an app this call sequence created. */
    importCreatedApp?: boolean;
    /** Legacy migration: extend an existing app only with these same bytes. */
    requireNewOrSameBytes?: boolean;
}

export interface PublishCanvasAppHtmlResult {
    status: "published" | "unchanged";
    appId: string;
    appCreated: boolean;
    versionId: string;
    version: string;
    sha256: string;
    scope: CanvasAppScope;
    active: boolean;
    card: Record<string, unknown>;
}

function normalizeName(value: unknown): string {
    const name = String(value ?? "").trim().toLowerCase();
    if (!CANVAS_APP_NAME_RE.test(name)) {
        throw new CanvasAppError("BAD_REQUEST", "name must be a slug: lowercase letters, digits and dashes, ≤64 chars (e.g. release-signoff)");
    }
    return name;
}

function normalizeTags(tags: unknown): string[] | null {
    if (!Array.isArray(tags)) return null;
    return [...new Set(tags.filter((t) => typeof t === "string").map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
}

async function waitForReady(store: CanvasAppStore, viewer: CanvasAppViewer, target: CanvasAppTarget, versionId: string): Promise<boolean> {
    for (let i = 0; i < 40; i++) {
        try {
            const detail = await store.get(target, viewer);
            if (detail.versions.some((v) => v.versionId === versionId)) return true;
        } catch { /* not visible yet */ }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
}

/** Publish one page as a version of an app (R2, R4, R5, R6). */
export async function publishCanvasAppHtml(deps: CanvasAppRegistryDeps, input: PublishCanvasAppHtmlInput): Promise<PublishCanvasAppHtmlResult> {
    const name = normalizeName(input.name);
    const scope: CanvasAppScope = input.scope === "shared" ? "shared" : "user";
    const mode = input.mode === "import" ? "import" : "publish";
    const page = checkCanvasAppPage(input.html, input.responseContract);
    const description = input.description == null ? null : String(input.description).trim();
    if (mode === "publish" && description !== null && description.length > 0 && description.length < CANVAS_APP_DESCRIPTION_MIN) {
        throw new CanvasAppError("BAD_REQUEST", "description is the text search ranks on — say WHEN to use the app, in at least one full sentence (e.g. \"Use when several approvers sign off a release train together\")");
    }
    const requested = input.version != null && String(input.version).trim() !== ""
        ? String(input.version).trim()
        : (isSemver(page.manifest.version) ? String(page.manifest.version).trim() : null);
    if (requested !== null) checkVersionLength(requested, input.version != null && String(input.version).trim() !== "" ? "version" : "the manifest's version");
    const newAppId = randomUUID();
    const reserved = await deps.store.reserve({
        newAppId,
        newVersionId: randomUUID(),
        artifactSessionId: canvasAppArtifactSessionId(newAppId),
        name, scope,
        viewer: input.viewer,
        allowOwnerless: Boolean(input.allowOwnerless),
        sha256: page.sha256,
        sizeBytes: page.sizeBytes,
        version: requested,
        card: page.card,
        workspaceKey: page.workspaceKey,
        description: description || page.manifest.description || null,
        tags: normalizeTags(input.tags) ?? normalizeTags(page.manifest.tags),
        sourceSessionId: input.sourceSessionId ?? null,
        sourceSlot: input.sourceSlot ?? null,
        createdBy: input.createdBy ?? null,
        mode,
        requireNewOrSameBytes: Boolean(input.requireNewOrSameBytes),
    });
    const base = {
        appId: reserved.appId, appCreated: reserved.appCreated, versionId: reserved.versionId,
        version: reserved.version, sha256: page.sha256, scope, card: page.card,
    };
    const target: CanvasAppTarget = { name, scope, owner: scope === "user" ? input.viewer.principal : null };
    // The same bytes are already a version: report THAT version as stored
    // (its card and whether it is the active one), not this call's input
    // (review S06).
    const existing = async () => {
        const detail = await deps.store.get(target, input.viewer);
        const row = detail.versions.find((v) => v.versionId === reserved.versionId);
        return { card: row?.card ?? base.card, active: detail.activeVersionId === reserved.versionId };
    };
    if (reserved.status === "noop") {
        return { ...base, status: "unchanged", ...(await existing()) };
    }
    if (reserved.status === "in-progress") {
        // Another publish of the same bytes holds the reservation.
        const ready = await waitForReady(deps.store, input.viewer, target, reserved.versionId);
        if (!ready) throw new CanvasAppError("BAD_REQUEST", "another publish of the same page is still in progress; try again");
        return { ...base, status: "unchanged", ...(await existing()) };
    }
    try {
        await deps.artifactStore.uploadArtifact(reserved.artifactSessionId, reserved.artifactFilename, page.html, "text/html", { pinned: true } as any);
        // A version becomes ready only for the bytes it was reserved for: read
        // the stored page back and compare before commit.
        const stored = await deps.artifactStore.downloadArtifactText(reserved.artifactSessionId, reserved.artifactFilename);
        if (sha256Hex(stored) !== page.sha256) {
            throw new CanvasAppError("BAD_REQUEST", `stored bytes of ${name}@${reserved.version} do not match the published page; nothing was published`);
        }
    } catch (err) {
        // Remove whatever was written, then the pending row. When the bytes
        // cannot be confirmed gone, the pending row stays as the cleanup
        // record: the prune claims it after the pending window.
        let bytesGone = false;
        try {
            await deps.artifactStore.deleteArtifact(reserved.artifactSessionId, reserved.artifactFilename);
            bytesGone = true;
        } catch (cleanupErr: any) {
            console.warn(`[canvas-apps] could not remove ${reserved.artifactSessionId}/${reserved.artifactFilename} after a failed publish; the prune will: ${cleanupErr?.message || cleanupErr}`);
        }
        if (bytesGone) await deps.store.abort(reserved.versionId).catch(() => false);
        throw err;
    }
    const mayActivate = mode === "publish" || reserved.appCreated || Boolean(input.importCreatedApp);
    let committed: Awaited<ReturnType<CanvasAppStore["commit"]>>;
    try {
        committed = await deps.store.commit(reserved.versionId, mayActivate);
    } catch (err) {
        // Definitely not committed (the pruner claimed the version, or it is
        // gone): the bytes just written are this reservation's own object
        // (its path carries the version id and is never reused), so remove
        // them. Any other failure leaves them: the version may have committed.
        if (err instanceof CanvasAppError && (err.code === "ABORTED" || err.code === "NOT_FOUND")) {
            try {
                await deps.artifactStore.deleteArtifact(reserved.artifactSessionId, reserved.artifactFilename);
                await deps.store.abort(reserved.versionId).catch(() => false);
            } catch (cleanupErr: any) {
                console.warn(`[canvas-apps] could not remove ${reserved.artifactSessionId}/${reserved.artifactFilename} after a refused commit: ${cleanupErr?.message || cleanupErr}`);
            }
        }
        throw err;
    }
    return { ...base, status: "published", active: committed.active };
}

/** The bytes of one version, checked against their recorded sha256. */
export async function readCanvasAppHtml(
    deps: CanvasAppRegistryDeps,
    target: CanvasAppTarget,
    viewer: CanvasAppViewer,
    version?: string | null,
): Promise<{ html: string; resolved: Awaited<ReturnType<CanvasAppStore["getVersion"]>> }> {
    const resolved = await deps.store.getVersion(target, viewer, version ?? null);
    const html = await deps.artifactStore.downloadArtifactText(resolved.artifactSessionId, resolved.artifactFilename);
    if (sha256Hex(html) !== resolved.sha256) {
        throw new CanvasAppError("BAD_REQUEST", `stored bytes of ${resolved.name}@${resolved.version} do not match their sha256`);
    }
    return { html, resolved };
}

/** Delete an app (owner or admin): rows first, then its byte space. */
export async function deleteCanvasApp(deps: CanvasAppRegistryDeps, target: CanvasAppTarget, viewer: CanvasAppViewer): Promise<{ deleted: true; files: number; pendingCleanup: boolean }> {
    const gone = await deps.store.delete(target, viewer);
    let files = 0;
    let failed = 0;
    if (gone.appId) {
        for (const filename of gone.artifactFilenames) {
            try {
                if (await deps.artifactStore.deleteArtifact(gone.artifactSessionId, filename)) files++;
            } catch (err: any) {
                failed++;
                console.warn(`[canvas-apps] could not delete ${gone.artifactSessionId}/${filename}; the prune will retry: ${err?.message || err}`);
            }
        }
        // Anything else in the app's own space goes too: a late upload whose
        // refused-commit cleanup failed leaves an object no version row names
        // (review T02). The space is listed, as the pruner does for tombstones.
        try {
            for (const f of await deps.artifactStore.listArtifacts(gone.artifactSessionId)) {
                const name = (f as any).filename ?? (f as any).name;
                if (!name) continue;
                try {
                    if (await deps.artifactStore.deleteArtifact(gone.artifactSessionId, name)) files++;
                } catch (err: any) {
                    failed++;
                    console.warn(`[canvas-apps] could not delete ${gone.artifactSessionId}/${name}; the prune will retry: ${err?.message || err}`);
                }
            }
        } catch (err: any) {
            failed++;
            console.warn(`[canvas-apps] could not list ${gone.artifactSessionId}; the prune will retry: ${err?.message || err}`);
        }
        // The tombstone is the retry record: it is marked purged only when
        // every file is confirmed gone.
        if (failed === 0) await deps.store.markPurged(gone.appId);
    }
    return { deleted: true, files, pendingCleanup: failed > 0 };
}

/**
 * Finish what interrupted publishes and deletes left: stale pending rows and
 * unpurged tombstones. Called by the sweeper hook; safe to run any time. A
 * storage failure leaves its record in place for the next run; nothing is
 * marked done that is not confirmed done.
 */
export async function pruneCanvasAppArtifacts(deps: CanvasAppRegistryDeps, now = new Date()): Promise<{ pendingRemoved: number; spacesPurged: number; failures: number }> {
    let failures = 0;
    let pendingRemoved = 0;
    for (const p of await deps.store.prunePending(new Date(now.getTime() - CANVAS_APP_PENDING_TTL_MS))) {
        try {
            await deps.artifactStore.deleteArtifact(p.artifactSessionId, p.artifactFilename);
        } catch (err: any) {
            failures++;
            console.warn(`[canvas-apps] could not delete abandoned ${p.artifactSessionId}/${p.artifactFilename}; kept for retry: ${err?.message || err}`);
            continue;
        }
        if (await deps.store.abort(p.versionId)) pendingRemoved++;
    }
    let spacesPurged = 0;
    for (const t of await deps.store.listTombstones(100)) {
        let files: any[];
        try {
            files = await deps.artifactStore.listArtifacts(t.artifactSessionId);
        } catch (err: any) {
            failures++;
            console.warn(`[canvas-apps] could not list ${t.artifactSessionId}; tombstone kept: ${err?.message || err}`);
            continue;
        }
        let ok = true;
        for (const f of files) {
            try {
                await deps.artifactStore.deleteArtifact(t.artifactSessionId, (f as any).filename ?? (f as any).name);
            } catch (err: any) {
                ok = false;
                failures++;
                console.warn(`[canvas-apps] could not delete ${t.artifactSessionId}/${(f as any).filename}; tombstone kept: ${err?.message || err}`);
            }
        }
        if (ok) {
            await deps.store.markPurged(t.appId);
            spacesPurged++;
        }
    }
    return { pendingRemoved, spacesPurged, failures };
}

// ── Export and import (R16, R17) ─────────────────────────────────

export interface CanvasAppArchiveManifest {
    format: number;
    name: string;
    description: string;
    tags: string[];
    versions: Array<{ version: string; sha256: string; size: number; card: Record<string, unknown> }>;
}

/**
 * The exact length of the uncompressed canonical tar for members of these
 * body sizes: a 512-byte header per member, each body padded to 512 bytes,
 * and two 512-byte end blocks. The importer bounds this same length.
 */
export function canvasAppArchiveExpandedBytes(bodySizes: number[]): number {
    let total = 1024;
    for (const size of bodySizes) total += 512 + Math.ceil(Math.max(0, size) / 512) * 512;
    return total;
}

/** One deterministic .tar.gz of every version, with no owner, scope or user/session id. */
export async function exportCanvasApp(deps: CanvasAppRegistryDeps, target: CanvasAppTarget, viewer: CanvasAppViewer): Promise<{ filename: string; bytes: Buffer; sha256: string }> {
    const detail = await deps.store.get(target, viewer);
    const versions = [...detail.versions].reverse(); // ascending precedence
    const files: Array<{ name: string; body: Buffer }> = [];
    const manifest: CanvasAppArchiveManifest = {
        format: CANVAS_APP_ARCHIVE_FORMAT,
        name: detail.name,
        description: detail.description,
        tags: [...detail.tags].sort(),
        versions: [],
    };
    // Every export must be importable: the importer expands the whole tar to
    // at most CANVAS_APP_ARCHIVE_MAX_EXPANDED_BYTES. Count the exact tar
    // (headers, padded bodies, the end blocks and the real manifest with
    // every card) from the recorded sizes before reading any page.
    for (const v of versions) manifest.versions.push({ version: v.version, sha256: v.sha256, size: v.sizeBytes, card: v.card });
    const manifestBody = Buffer.from(canonicalJson(manifest) + "\n", "utf8");
    const planned = canvasAppArchiveExpandedBytes([manifestBody.length, ...versions.map((v) => Number(v.sizeBytes || 0))]);
    if (planned > CANVAS_APP_ARCHIVE_MAX_EXPANDED_BYTES) {
        throw new CanvasAppError("BAD_REQUEST", `the app's archive would expand to ${planned} bytes, more than the ${CANVAS_APP_ARCHIVE_MAX_EXPANDED_BYTES} an import accepts; delete old versions first`);
    }
    for (const v of versions) {
        const { html } = await readCanvasAppHtml(deps, target, viewer, v.version);
        files.push({ name: `versions/${v.version}.html`, body: Buffer.from(html, "utf8") });
    }
    files.unshift({ name: "canvas-app.json", body: manifestBody });
    const expanded = canvasAppArchiveExpandedBytes(files.map((f) => f.body.length));
    if (expanded > CANVAS_APP_ARCHIVE_MAX_EXPANDED_BYTES) {
        throw new CanvasAppError("BAD_REQUEST", `the app's archive expands to ${expanded} bytes, more than the ${CANVAS_APP_ARCHIVE_MAX_EXPANDED_BYTES} an import accepts; delete old versions first`);
    }
    const bytes = buildCanonicalTarGz(files);
    if (bytes.length > CANVAS_APP_ARCHIVE_MAX_BYTES) {
        throw new CanvasAppError("BAD_REQUEST", `the archive is ${bytes.length} bytes; the limit is ${CANVAS_APP_ARCHIVE_MAX_BYTES}`);
    }
    return { filename: `${detail.name}.canvas-app.tar.gz`, bytes, sha256: sha256Hex(bytes) };
}

export function readCanvasAppArchive(bytes: Buffer): { manifest: CanvasAppArchiveManifest; pages: Map<string, string> } {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new CanvasAppError("BAD_REQUEST", "INVALID_ARCHIVE: empty archive");
    if (bytes.length > CANVAS_APP_ARCHIVE_MAX_BYTES) throw new CanvasAppError("BAD_REQUEST", `INVALID_ARCHIVE: the archive is larger than ${CANVAS_APP_ARCHIVE_MAX_BYTES} bytes`);
    let entries;
    try {
        entries = readCanonicalTarGz(bytes, CANVAS_APP_ARCHIVE_MAX_EXPANDED_BYTES);
    } catch (err: any) {
        throw new CanvasAppError("BAD_REQUEST", `INVALID_ARCHIVE: ${err?.message || String(err)}`);
    }
    const names = entries.map((e) => e.name);
    if (new Set(names).size !== names.length) throw new CanvasAppError("BAD_REQUEST", "INVALID_ARCHIVE: duplicate member");
    const manifestEntry = entries.find((e) => e.name === "canvas-app.json");
    if (!manifestEntry) throw new CanvasAppError("BAD_REQUEST", "INVALID_ARCHIVE: canvas-app.json is missing");
    let raw: any;
    try { raw = JSON.parse(manifestEntry.body.toString("utf8")); } catch { throw new CanvasAppError("BAD_REQUEST", "INVALID_ARCHIVE: canvas-app.json is not JSON"); }
    if (raw?.format !== CANVAS_APP_ARCHIVE_FORMAT || !Array.isArray(raw?.versions) || raw.versions.length === 0) {
        throw new CanvasAppError("BAD_REQUEST", "INVALID_ARCHIVE: unsupported format or no versions");
    }
    const manifest: CanvasAppArchiveManifest = {
        format: CANVAS_APP_ARCHIVE_FORMAT,
        name: normalizeName(raw.name),
        description: String(raw.description ?? ""),
        tags: normalizeTags(raw.tags) ?? [],
        versions: [],
    };
    const expected = new Set(["canvas-app.json"]);
    const pages = new Map<string, string>();
    for (const v of raw.versions) {
        if (!isSemver(v?.version)) throw new CanvasAppError("BAD_REQUEST", `INVALID_ARCHIVE: "${v?.version}" is not SemVer`);
        if (Buffer.byteLength(String(v.version), "utf8") > CANVAS_APP_VERSION_MAX_BYTES) {
            throw new CanvasAppError("BAD_REQUEST", `INVALID_ARCHIVE: a version is longer than ${CANVAS_APP_VERSION_MAX_BYTES} bytes`);
        }
        const member = `versions/${v.version}.html`;
        if (expected.has(member)) throw new CanvasAppError("BAD_REQUEST", `INVALID_ARCHIVE: version ${v.version} listed twice`);
        expected.add(member);
        const entry = entries.find((e) => e.name === member);
        if (!entry) throw new CanvasAppError("BAD_REQUEST", `INVALID_ARCHIVE: ${member} is missing`);
        const html = entry.body.toString("utf8");
        if (sha256Hex(html) !== v.sha256) throw new CanvasAppError("BAD_REQUEST", `INVALID_ARCHIVE: ${member} does not match its sha256`);
        // The version's effective contract travels with it: taken from the
        // archived card only when it passes the same checks as at publish.
        const archivedContract = v?.card && typeof v.card === "object" ? (v.card as any).responseContract : undefined;
        const checked = checkCanvasAppPage(html, archivedContract);
        manifest.versions.push({ version: v.version, sha256: v.sha256, size: Buffer.byteLength(html, "utf8"), card: checked.card });
        pages.set(v.version, html);
    }
    const extra = names.filter((n) => !expected.has(n));
    if (extra.length) throw new CanvasAppError("BAD_REQUEST", `INVALID_ARCHIVE: unexpected member ${extra[0]}`);
    return { manifest, pages };
}

export interface ImportCanvasAppResult {
    name: string;
    appId: string | null;
    scope: CanvasAppScope;
    versions: Array<{ version: string; status: "imported" | "unchanged" | "failed"; code?: string; message?: string }>;
}

/**
 * Import an archive (R17): validate everything before any write, then publish
 * each version in import mode. A VERSION_EXISTS fails only that version.
 */
export async function importCanvasApp(
    deps: CanvasAppRegistryDeps,
    bytes: Buffer,
    viewer: CanvasAppViewer,
    opts: { scope?: CanvasAppScope; createdBy?: string | null } = {},
): Promise<ImportCanvasAppResult> {
    const { manifest, pages } = readCanvasAppArchive(bytes);
    const scope: CanvasAppScope = opts.scope === "shared" ? "shared" : "user";
    const result: ImportCanvasAppResult = { name: manifest.name, appId: null, scope, versions: [] };
    let createdHere = false;
    for (const v of manifest.versions) {
        try {
            const r = await publishCanvasAppHtml(deps, {
                html: pages.get(v.version)!,
                name: manifest.name, scope, version: v.version,
                description: manifest.description || null, tags: manifest.tags,
                responseContract: (v.card as any)?.responseContract,
                viewer, createdBy: opts.createdBy ?? null, mode: "import",
                importCreatedApp: createdHere,
            });
            createdHere = createdHere || r.appCreated;
            result.appId = r.appId;
            result.versions.push({ version: v.version, status: r.status === "published" ? "imported" : "unchanged" });
        } catch (err: any) {
            if (err instanceof CanvasAppError && err.code === "VERSION_EXISTS") {
                result.versions.push({ version: v.version, status: "failed", code: err.code, message: err.message });
                continue;
            }
            throw err;
        }
    }
    // The app this import created is now established: later imports keep
    // its active pointer. A crash before this line leaves import_open set,
    // so a resumed import still activates the highest version.
    if (result.appId) await deps.store.finishImport(result.appId);
    return result;
}

// ── Legacy migration (R22) ───────────────────────────────────────

export interface LegacyMigrationDeps extends CanvasAppRegistryDeps {
    factStore: import("./facts-store.js").FactStore;
    /** Owner of a session id, or null when the session or its owner is gone. */
    sessionOwner: (sessionId: string) => Promise<{ provider: string; subject: string } | null>;
}

export interface LegacyMigrationLine {
    key: string;
    name: string;
    outcome: "migrate" | "migrated" | "skipped";
    version?: string;
    owner?: { provider: string; subject: string } | null;
    reason?: string;
}

/**
 * One-time import of the `apps/<name>` shared facts into the registry as
 * shared apps. Admin only (the caller passes an unrestricted-admin viewer).
 * Dry run by default. Safe to run again: same bytes are a no-op, and a fact
 * is deleted only after the stored version is read back and matches.
 */
export async function migrateLegacyCanvasApps(
    deps: LegacyMigrationDeps,
    viewer: CanvasAppViewer,
    opts: { dryRun?: boolean } = {},
): Promise<{ dryRun: boolean; lines: LegacyMigrationLine[]; migrated: number; skipped: number }> {
    if (!viewer.resourceAdmin) throw new CanvasAppError("FORBIDDEN", "migrating legacy canvas apps needs an unrestricted admin");
    const dryRun = opts.dryRun !== false;
    const res = await deps.factStore.readFacts({ keyPattern: "apps/*", scope: "shared", limit: 1000 } as any);
    const lines: LegacyMigrationLine[] = [];
    for (const fact of (res as any).facts ?? []) {
        const key = String(fact.key);
        const card: any = typeof fact.value === "string" ? (() => { try { return JSON.parse(fact.value); } catch { return null; } })() : fact.value;
        const name = String(card?.name ?? key.replace(/^apps\//, "")).toLowerCase();
        const src = card?.source ?? {};
        const skip = (reason: string) => lines.push({ key, name, outcome: "skipped", reason });
        if (!CANVAS_APP_NAME_RE.test(name)) { skip("the name is not a valid app name; fact kept"); continue; }
        if (!src.sessionId || !src.filename || !src.sha256) { skip("the card has no source; fact kept"); continue; }
        let html: string;
        try {
            html = await deps.artifactStore.downloadArtifactText(String(src.sessionId), String(src.filename));
        } catch {
            skip("source artifact missing; fact kept"); continue;
        }
        if (sha256Hex(html) !== String(src.sha256)) { skip("source bytes do not match the card's sha256; fact kept"); continue; }
        let page: CanvasAppPageCheck;
        try { page = checkCanvasAppPage(html, card?.responseContract); } catch (err: any) { skip(`the page fails the publish checks (${err?.message}); fact kept`); continue; }
        const owner = await deps.sessionOwner(String(src.sessionId)).catch(() => null);
        const manifestVersion = isSemver(page.manifest.version) ? String(page.manifest.version).trim() : null;
        const version = manifestVersion && Buffer.byteLength(manifestVersion, "utf8") <= CANVAS_APP_VERSION_MAX_BYTES ? manifestVersion : "1.0.0";
        // A shared app with this name and other bytes already exists: keep the fact.
        try {
            const existing = await deps.store.getVersion({ name, scope: "shared" }, viewer, null);
            const sameBytes = (await deps.store.get({ name, scope: "shared" }, viewer)).versions.some((v) => v.sha256 === page.sha256);
            if (existing && !sameBytes) { skip("a shared app with this name and other bytes exists; fact kept"); continue; }
        } catch (err: any) {
            if (!(err instanceof CanvasAppError) || (err.code !== "NOT_FOUND" && err.code !== "VERSION_NOT_FOUND")) throw err;
        }
        if (dryRun) { lines.push({ key, name, outcome: "migrate", version, owner }); continue; }
        // As the owner, without admin rights: a shared app of this name created
        // meanwhile by someone else is NAME_TAKEN, never extended. An ownerless
        // app needs the admin path; the procedure refuses it for a named app.
        const asOwner: CanvasAppViewer = owner ? { principal: owner, resourceAdmin: false } : { principal: null, resourceAdmin: true };
        let published: PublishCanvasAppHtmlResult;
        try {
            const legacyDescription = String(card?.description ?? "").trim();
            published = await publishCanvasAppHtml(deps, {
                html, name, scope: "shared", version,
                description: legacyDescription.length >= CANVAS_APP_DESCRIPTION_MIN ? legacyDescription : null,
                tags: Array.isArray(card?.tags) ? card.tags : null,
                responseContract: card?.responseContract,
                viewer: asOwner, allowOwnerless: !owner, createdBy: "legacy-migration", requireNewOrSameBytes: true,
                sourceSessionId: String(src.sessionId), mode: "publish",
            });
        } catch (err: any) {
            skip(`publish failed (${err?.code ?? "ERROR"}: ${err?.message}); fact kept`); continue;
        }
        const check = await readCanvasAppHtml(deps, { name, scope: "shared" }, viewer, published.version);
        if (check.resolved.sha256 !== page.sha256) { skip("read-back does not match; fact kept"); continue; }
        // Delete only the revision that was migrated, atomically: a fact
        // replaced after it was read has a new etag and is kept (the next run
        // looks at the new value). A store that cannot compare-and-delete
        // keeps the fact.
        const deleteIfEtag = (deps.factStore as any).deleteFactIfEtag;
        if (typeof deleteIfEtag !== "function" || typeof fact.etag !== "number") {
            lines.push({ key, name, outcome: "migrated", version: published.version, owner, reason: "this fact store cannot delete only the migrated revision; fact kept" });
            continue;
        }
        const deleted = await deleteIfEtag.call(deps.factStore, { key, shared: true, etag: fact.etag });
        lines.push(deleted
            ? { key, name, outcome: "migrated", version: published.version, owner }
            : { key, name, outcome: "migrated", version: published.version, owner, reason: "the fact changed during migration; fact kept" });
    }
    return {
        dryRun,
        lines,
        migrated: lines.filter((l) => l.outcome === "migrated" || l.outcome === "migrate").length,
        skipped: lines.filter((l) => l.outcome === "skipped").length,
    };
}

// ── Draw trust and attribution (plan decision 4) ─────────────────

export type CanvasDrawTrust = "owner" | "cross-owner" | "agent";

export interface CanvasDrawAttribution {
    appId: string;
    versionId: string;
    name: string;
    version: string;
    scope: CanvasAppScope;
    owner: { provider: string; subject: string } | null;
}

export interface CanvasDrawClassification {
    trust: CanvasDrawTrust;
    /** Set only for fromApp and exact sha256 matches; never by the workspace rule. */
    app: CanvasDrawAttribution | null;
    pageSha256: string;
}

function samePrincipal(a: { provider: string; subject: string } | null | undefined, b: { provider: string; subject: string } | null | undefined): boolean {
    return Boolean(a && b && a.provider === b.provider && a.subject === b.subject);
}

/**
 * Classify a draw for the canvas's owner (the viewer):
 * - fromApp keeps the app it resolved; owner when the viewer owns it, else cross-owner;
 * - other bytes equal to a version the viewer owns → owner (attributed);
 * - else equal to a visible version owned by someone else → cross-owner
 *   (attributed: shared first, then the oldest app);
 * - else a workspace block equal to a visible version owned by someone else
 *   → cross-owner (not attributed);
 * - else agent, as today.
 */
export async function classifyCanvasDraw(
    store: CanvasAppStore,
    input: {
        html: string;
        manifest: CanvasAppManifest | null;
        viewer: CanvasAppViewer;
        fromApp?: CanvasDrawAttribution | null;
    },
): Promise<CanvasDrawClassification> {
    const pageSha256 = sha256Hex(input.html);
    if (input.fromApp) {
        return {
            trust: samePrincipal(input.fromApp.owner, input.viewer.principal) ? "owner" : "cross-owner",
            app: input.fromApp,
            pageSha256,
        };
    }
    if (!input.html) return { trust: "agent", app: null, pageSha256 };
    const matches = await store.matchBySha(pageSha256, input.viewer);
    const mine = matches.find((m) => samePrincipal(m.owner, input.viewer.principal));
    const toAttribution = (m: typeof matches[number]): CanvasDrawAttribution => ({
        appId: m.appId, versionId: m.versionId, name: m.name, version: m.version, scope: m.scope, owner: m.owner,
    });
    if (mine) return { trust: "owner", app: toAttribution(mine), pageSha256 };
    const foreign = matches.find((m) => !samePrincipal(m.owner, input.viewer.principal));
    if (foreign) return { trust: "cross-owner", app: toAttribution(foreign), pageSha256 };
    const workspaceKey = canvasAppWorkspaceKey(input.manifest);
    if (workspaceKey && await store.foreignWorkspaceMatch(workspaceKey, input.viewer)) {
        return { trust: "cross-owner", app: null, pageSha256 };
    }
    return { trust: "agent", app: null, pageSha256 };
}


// ── Bytes that agents do not receive (plan decision 14) ──────────

export interface CanvasBytesGuardDeps {
    store: CanvasAppStore;
    /** The calling session's owner as a registry viewer. */
    resolveViewer: (sessionId: string) => Promise<CanvasAppViewer>;
}

/**
 * Defense in depth for the artifact and canvas read tools: they do not hand
 * an agent bytes the registry identifies as another owner's app page it may
 * not edit (the exact bytes, or a page with that app's workspace block), nor
 * any byte of an app's own storage space. Drawing with fromApp keeps the
 * app's identity, so its owner is named and its network is blocked.
 *
 * This is accident reduction, not an authority boundary: a near-copy is not
 * recognized, and folders, the web, facts and messages are other channels.
 * Workspace access is decided by the session owner's positive approval of
 * each exact program, whoever wrote it. Returns a refusal message, or null
 * when the read may proceed.
 */
/**
 * Can this viewer already obtain these exact bytes as a version it may see
 * (its own app, a shared app, or any app for an unrestricted admin)? Another
 * person's private copy of the same bytes must not hide them (review S02,
 * T05). This only lifts a PRIVATE-only hit: a foreign shared app's exact
 * bytes or workspace block is still refused (the read guard keeps the
 * workspace rule; see canvasBytesRefusal).
 */
export async function viewerCanObtainCanvasBytes(store: CanvasAppStore, sha256: string, viewer: CanvasAppViewer): Promise<boolean> {
    return (await store.matchBySha(sha256, viewer)).length > 0;
}

export async function canvasBytesRefusal(
    deps: CanvasBytesGuardDeps,
    input: {
        callerSessionId: string | null | undefined; artifactSessionId: string; bytes?: Buffer | string | null;
        /** Metadata-only reads (list, metaOnly, manifestOnly): the stored sha256, and only private apps are hidden. */
        sha256?: string | null; privateOnly?: boolean;
    },
): Promise<string | null> {
    if (looksLikeCanvasAppSpace(input.artifactSessionId) && await deps.store.isSpace(input.artifactSessionId)) {
        return "canvas app storage is read only through the canvas app registry (find_canvas_app, draw_canvas({fromApp}))";
    }
    if (input.bytes == null) {
        if (!input.sha256) return null;
        const viewer = input.callerSessionId ? await deps.resolveViewer(input.callerSessionId) : { principal: null, resourceAdmin: false };
        const owner = await deps.store.foreignBytes(String(input.sha256), null, viewer);
        if (owner === "(private)" && await viewerCanObtainCanvasBytes(deps.store, String(input.sha256), viewer)) return null;
        return owner === "(private)" ? "artifact not found" : null;
    }
    const text = Buffer.isBuffer(input.bytes) ? input.bytes.toString("utf8") : String(input.bytes);
    if (!text.includes("CANVAS-APP-MANIFEST") && !text.includes("<")) return null;
    const viewer = input.callerSessionId ? await deps.resolveViewer(input.callerSessionId) : { principal: null, resourceAdmin: false };
    const extraction = extractCanvasAppManifest(text);
    const sha = sha256Hex(text);
    const owner = await deps.store.foreignBytes(sha, canvasAppWorkspaceKey(extraction.manifest), viewer);
    if (!owner) return null;
    // foreign_bytes reports a visible foreign shared app first; "(private)"
    // means the only foreign hit is a private copy the viewer cannot see.
    if (owner === "(private)" && await viewerCanObtainCanvasBytes(deps.store, sha, viewer)) return null;
    if (input.privateOnly && owner !== "(private)") return null;
    return owner === "(private)"
        ? "artifact not found"
        : `these bytes are the canvas app "${owner}" of another user; agents do not receive its page. Draw it with draw_canvas({fromApp: {name: "${owner}"}}), or read its card with find_canvas_app({name}).`;
}
