/**
 * Canvas app registry: the service (issue 181).
 *
 * Owns an app's bytes and lifecycle on top of {@link CanvasAppStore} (the CMS
 * procedures, which own authorization) and the provider-neutral
 * {@link ArtifactStore}. Every app gets its own byte space, a reserved
 * artifact "session" id derived from its app id:
 *
 *   publish  check page → sha256 → reserve (SQL picks the version, inserts a
 *            pending row) → upload <name>@<version>.<sha12>.html → commit
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

const SPACE_PREFIX = createHash("sha256").update("pilotswarm-canvas-apps:artifacts").digest("hex").slice(0, 12);

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

/**
 * Cheap first filter: could this id be an app byte space? The answer is
 * confirmed against the CMS before anything is refused, so a session created
 * before this release whose id happens to match keeps working.
 */
export function looksLikeCanvasAppSpace(id: string): boolean {
    const s = String(id ?? "").toLowerCase();
    return s.length === 36 && s.replace(/-/g, "").startsWith(SPACE_PREFIX) && s[14] === "8";
}

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
    });
    const base = {
        appId: reserved.appId, appCreated: reserved.appCreated, versionId: reserved.versionId,
        version: reserved.version, sha256: page.sha256, scope, card: page.card,
    };
    const target: CanvasAppTarget = { name, scope, owner: scope === "user" ? input.viewer.principal : null };
    if (reserved.status === "noop") {
        return { ...base, status: "unchanged", active: mode === "publish" };
    }
    if (reserved.status === "in-progress") {
        // Another publish of the same bytes holds the reservation.
        const ready = await waitForReady(deps.store, input.viewer, target, reserved.versionId);
        if (!ready) throw new CanvasAppError("BAD_REQUEST", "another publish of the same page is still in progress; try again");
        return { ...base, status: "unchanged", active: false };
    }
    try {
        await deps.artifactStore.uploadArtifact(reserved.artifactSessionId, reserved.artifactFilename, page.html, "text/html", { pinned: true } as any);
    } catch (err) {
        await deps.store.abort(reserved.versionId).catch(() => {});
        throw err;
    }
    const mayActivate = mode === "publish" || reserved.appCreated || Boolean(input.importCreatedApp);
    const committed = await deps.store.commit(reserved.versionId, mayActivate);
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
export async function deleteCanvasApp(deps: CanvasAppRegistryDeps, target: CanvasAppTarget, viewer: CanvasAppViewer): Promise<{ deleted: true; files: number }> {
    const gone = await deps.store.delete(target, viewer);
    let files = 0;
    if (gone.appId) {
        for (const filename of gone.artifactFilenames) {
            if (await deps.artifactStore.deleteArtifact(gone.artifactSessionId, filename).catch(() => false)) files++;
        }
        await deps.store.markPurged(gone.appId);
    }
    return { deleted: true, files };
}

/**
 * Finish what interrupted publishes and deletes left: stale pending rows and
 * unpurged tombstones. Called by the sweeper hook; safe to run any time.
 */
export async function pruneCanvasAppArtifacts(deps: CanvasAppRegistryDeps, now = new Date()): Promise<{ pendingRemoved: number; spacesPurged: number }> {
    const stale = await deps.store.prunePending(new Date(now.getTime() - CANVAS_APP_PENDING_TTL_MS));
    for (const p of stale) {
        await deps.artifactStore.deleteArtifact(p.artifactSessionId, p.artifactFilename).catch(() => false);
    }
    let spacesPurged = 0;
    for (const t of await deps.store.listTombstones(100)) {
        const files = await deps.artifactStore.listArtifacts(t.artifactSessionId).catch(() => []);
        for (const f of files) {
            await deps.artifactStore.deleteArtifact(t.artifactSessionId, (f as any).filename ?? (f as any).name).catch(() => false);
        }
        await deps.store.markPurged(t.appId);
        spacesPurged++;
    }
    return { pendingRemoved: stale.length, spacesPurged };
}

// ── Export and import (R16, R17) ─────────────────────────────────

export interface CanvasAppArchiveManifest {
    format: number;
    name: string;
    description: string;
    tags: string[];
    versions: Array<{ version: string; sha256: string; size: number; card: Record<string, unknown> }>;
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
    for (const v of versions) {
        const { html } = await readCanvasAppHtml(deps, target, viewer, v.version);
        manifest.versions.push({ version: v.version, sha256: v.sha256, size: v.sizeBytes, card: v.card });
        files.push({ name: `versions/${v.version}.html`, body: Buffer.from(html, "utf8") });
    }
    files.unshift({ name: "canvas-app.json", body: Buffer.from(canonicalJson(manifest) + "\n", "utf8") });
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
        const member = `versions/${v.version}.html`;
        if (expected.has(member)) throw new CanvasAppError("BAD_REQUEST", `INVALID_ARCHIVE: version ${v.version} listed twice`);
        expected.add(member);
        const entry = entries.find((e) => e.name === member);
        if (!entry) throw new CanvasAppError("BAD_REQUEST", `INVALID_ARCHIVE: ${member} is missing`);
        const html = entry.body.toString("utf8");
        if (sha256Hex(html) !== v.sha256) throw new CanvasAppError("BAD_REQUEST", `INVALID_ARCHIVE: ${member} does not match its sha256`);
        checkCanvasAppPage(html);
        manifest.versions.push({ version: v.version, sha256: v.sha256, size: Buffer.byteLength(html, "utf8"), card: {} });
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
