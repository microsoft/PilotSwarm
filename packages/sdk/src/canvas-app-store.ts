/**
 * Canvas app registry: the CMS side (migration 0084, issue 181).
 *
 * Thin typed wrappers over the `cms_canvas_app_*` procedures. Authorization
 * happens in SQL; this class only shapes arguments and rows and maps
 * `CANVAS_APP_<CODE>: …` exceptions to {@link CanvasAppError} with the public
 * code. The service (canvas-app-registry.ts) owns bytes and lifecycle.
 */
import type { Pool } from "pg";
import { migrationAppliedAt } from "./pg-migrator.js";
import { CANVAS_APP_REGISTRY_MIGRATION_VERSION, type CanvasRegistryPresence } from "./canvas-legacy.js";

export { CANVAS_APP_SPACE_PREFIX, looksLikeCanvasAppSpace } from "./canvas-app-space.js";

export type CanvasAppScope = "shared" | "user";

export interface CanvasAppPrincipal { provider: string; subject: string }

/** One exact workspace program in one slot of one session, for its owner. */
export interface CanvasWorkspaceGrantKey {
    sessionId: string;
    slot: number;
    pageSha256: string;
    declarationSha256: string;
    bindingsSha256: string;
    owner: CanvasAppPrincipal;
}

/** Who is asking. `resourceAdmin` is the unrestricted admin, never a cluster-scoped one. */
export interface CanvasAppViewer {
    principal: CanvasAppPrincipal | null;
    resourceAdmin: boolean;
}

/** Which copy a name means. Omitted: the viewer's own, then the shared one. */
export interface CanvasAppTarget {
    name: string;
    scope?: CanvasAppScope | null;
    owner?: CanvasAppPrincipal | null;
}

export const CANVAS_APP_ERROR_CODES = [
    "NOT_FOUND", "FORBIDDEN", "NAME_TAKEN", "NO_OWNER", "VERSION_EXISTS", "VERSION_NOT_FOUND",
    "APP_DISABLED", "BAD_VERSION", "BAD_SCOPE", "BAD_REQUEST", "USER_NOT_FOUND",
    // An abandoned upload of the same bytes is being cleaned up / this
    // publish outlived the pending TTL and was claimed: publish again.
    "BUSY", "ABORTED",
] as const;
export type CanvasAppErrorCode = (typeof CANVAS_APP_ERROR_CODES)[number];

const STATUS: Record<CanvasAppErrorCode, number> = {
    NOT_FOUND: 404, VERSION_NOT_FOUND: 404, USER_NOT_FOUND: 404,
    FORBIDDEN: 403, NAME_TAKEN: 409, VERSION_EXISTS: 409, NO_OWNER: 400,
    APP_DISABLED: 409, BAD_VERSION: 400, BAD_SCOPE: 400, BAD_REQUEST: 400,
    BUSY: 409, ABORTED: 409,
};

export class CanvasAppError extends Error {
    readonly status: number;
    constructor(readonly code: CanvasAppErrorCode, message: string) {
        super(message);
        this.name = "CanvasAppError";
        this.status = STATUS[code] ?? 400;
    }
}

/**
 * The canvas app transition (issue 181): what a registry lookup's outcome
 * says about a same-name old-catalog app. Success, a disabled app or a
 * refused one: the registry has it (present, it wins). NOT_FOUND, which an
 * invisible private app also answers: absent. Anything else is rethrown.
 */
export async function canvasRegistryPresence(lookup: () => Promise<unknown>): Promise<CanvasRegistryPresence> {
    try {
        await lookup();
        return "present";
    } catch (err) {
        if (!(err instanceof CanvasAppError)) throw err;
        if (err.code === "NOT_FOUND") return "absent";
        if (err.code === "APP_DISABLED" || err.code === "FORBIDDEN") return "present";
        throw err;
    }
}

/** Map a procedure exception to the public error; anything else is rethrown. */
export function mapCanvasAppError(err: unknown): never {
    const message = String((err as any)?.message ?? err);
    const m = /CANVAS_APP_([A-Z_]+):\s*(.*)$/s.exec(message);
    if (m) {
        const raw = m[1] === "DISABLED" ? "APP_DISABLED" : m[1];
        if ((CANVAS_APP_ERROR_CODES as readonly string[]).includes(raw)) {
            throw new CanvasAppError(raw as CanvasAppErrorCode, m[2]);
        }
    }
    // Two concurrent scope changes can both pass a procedure's name check;
    // the unique index then refuses the second one. That is the same
    // conflict the procedure reports as NAME_TAKEN, not a server error.
    const pg = err as { code?: unknown; constraint?: unknown };
    if (pg?.code === "23505") {
        const constraint = String(pg.constraint ?? "");
        if (constraint === "canvas_apps_shared_name_uniq") {
            throw new CanvasAppError("NAME_TAKEN", "a shared canvas app with that name already exists");
        }
        if (constraint === "canvas_apps_user_name_uniq") {
            throw new CanvasAppError("NAME_TAKEN", "the owner already has a private canvas app with that name");
        }
    }
    throw err;
}

export interface CanvasAppVersionRow {
    versionId: string;
    version: string;
    sha256: string;
    sizeBytes: number;
    artifactFilename: string;
    card: Record<string, unknown>;
    sourceSessionId: string | null;
    sourceSlot: number | null;
    createdBy: string | null;
    createdAt: Date;
}

export interface CanvasAppSummary {
    appId: string;
    name: string;
    scope: CanvasAppScope;
    owner: CanvasAppPrincipal | null;
    ownerEmail: string | null;
    ownerDisplayName: string | null;
    description: string;
    tags: string[];
    enabled: boolean;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    activeVersionId: string | null;
    version: string | null;
    sha256: string | null;
    sizeBytes: number | null;
    card: Record<string, unknown> | null;
    canEdit: boolean;
    canManage: boolean;
    shadowed: boolean;
}

export interface CanvasAppDetail extends Omit<CanvasAppSummary, "version" | "sha256" | "sizeBytes" | "card" | "shadowed"> {
    versions: CanvasAppVersionRow[];
}

export interface CanvasAppSearchHit {
    appId: string;
    name: string;
    scope: CanvasAppScope;
    owner: CanvasAppPrincipal | null;
    description: string;
    tags: string[];
    enabled: boolean;
    version: string | null;
    card: Record<string, unknown> | null;
    score: number;
}

export interface CanvasAppResolvedVersion {
    appId: string;
    name: string;
    scope: CanvasAppScope;
    owner: CanvasAppPrincipal | null;
    enabled: boolean;
    artifactSessionId: string;
    versionId: string;
    version: string;
    sha256: string;
    sizeBytes: number;
    artifactFilename: string;
    card: Record<string, unknown>;
    workspaceKey: string | null;
}

export interface CanvasAppShaMatch {
    appId: string;
    name: string;
    scope: CanvasAppScope;
    owner: CanvasAppPrincipal | null;
    enabled: boolean;
    appCreatedAt: Date;
    versionId: string;
    version: string;
}

export interface CanvasAppReserveInput {
    newAppId: string;
    newVersionId: string;
    artifactSessionId: string;
    name: string;
    scope: CanvasAppScope;
    viewer: CanvasAppViewer;
    /** Admin-only legacy migration: a shared app with no owner. */
    allowOwnerless?: boolean;
    sha256: string;
    sizeBytes: number;
    version?: string | null;
    card: Record<string, unknown>;
    workspaceKey?: string | null;
    description?: string | null;
    tags?: string[] | null;
    sourceSessionId?: string | null;
    sourceSlot?: number | null;
    createdBy?: string | null;
    mode: "publish" | "import";
    /**
     * Legacy migration: an existing app may be extended only by these same
     * bytes (refused with NAME_TAKEN otherwise), decided under the app lock.
     */
    requireNewOrSameBytes?: boolean;
}

export interface CanvasAppReserveResult {
    status: "reserved" | "noop" | "in-progress";
    appId: string;
    versionId: string;
    version: string;
    artifactSessionId: string;
    artifactFilename: string;
    appCreated: boolean;
}

export interface CanvasAppLoadRow {
    loadId: string;
    appName: string;
    version: string;
    sessionId: string;
    user: CanvasAppPrincipal | null;
    userEmail: string | null;
    userDisplayName: string | null;
    loadedAt: Date;
}

export interface CanvasAppLoadPage {
    rows: CanvasAppLoadRow[];
    total30d: number;
    nextCursor: { loadedAt: string; loadId: string } | null;
}

export interface CanvasAppEditorInfo {
    provider: string;
    subject: string;
    email: string | null;
    displayName: string | null;
    grantedAt: Date;
}

function principalOf(provider: unknown, subject: unknown): CanvasAppPrincipal | null {
    return provider && subject ? { provider: String(provider), subject: String(subject) } : null;
}

function viewerArgs(viewer: CanvasAppViewer): [string | null, string | null, boolean] {
    return [viewer.principal?.provider ?? null, viewer.principal?.subject ?? null, Boolean(viewer.resourceAdmin)];
}

function targetArgs(target: CanvasAppTarget): [string, string | null, string | null, string | null] {
    const scope = target.scope === "shared" || target.scope === "user" ? target.scope : null;
    return [String(target.name ?? ""), scope, target.owner?.provider ?? null, target.owner?.subject ?? null];
}

function json(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object") return value as Record<string, unknown>;
    if (typeof value === "string") { try { return JSON.parse(value); } catch { return {}; } }
    return {};
}

/**
 * The longest version text the registry accepts, in bytes. An exported
 * archive names each version's page `versions/<version>.html` in a ustar
 * member whose last path part is at most 100 bytes, so 95 is the most that
 * always exports and imports again (review S01, T03).
 */
export const CANVAS_APP_VERSION_MAX_BYTES = 95;

export class CanvasAppStore {
    private readonly s: string;
    constructor(private readonly pool: Pool, private readonly schema: string) { this.s = `"${schema.replace(/"/g, '""')}"`; }

    /**
     * When this registry was installed (its CMS migration was applied): the
     * cutoff for the old catalog's exemptions (canvas-legacy.ts). Null when
     * unknown, which exempts nothing.
     */
    async installedAt(): Promise<Date | null> {
        return migrationAppliedAt(this.pool, this.schema, CANVAS_APP_REGISTRY_MIGRATION_VERSION);
    }

    private fn(name: string): string { return `${this.s}.cms_canvas_app_${name}`; }
    private wsFn(name: string): string { return `${this.s}.cms_canvas_workspace_${name}`; }

    private async call(sql: string, values: unknown[]): Promise<any[]> {
        try {
            const { rows } = await this.pool.query(sql, values);
            return rows;
        } catch (err) {
            mapCanvasAppError(err);
        }
    }

    async reserve(input: CanvasAppReserveInput): Promise<CanvasAppReserveResult> {
        // The same limit as the registry service, at the public store boundary:
        // no path may create a version an export cannot name.
        if (input.version != null) {
            const size = Buffer.byteLength(String(input.version).trim(), "utf8");
            if (size > CANVAS_APP_VERSION_MAX_BYTES) {
                throw new CanvasAppError("BAD_VERSION", `version is ${size} bytes; a canvas app version is at most ${CANVAS_APP_VERSION_MAX_BYTES} bytes`);
            }
        }
        const rows = await this.call(
            `SELECT * FROM ${this.fn("reserve")}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
            [
                input.newAppId, input.newVersionId, input.artifactSessionId, input.name, input.scope,
                ...viewerArgs(input.viewer), Boolean(input.allowOwnerless),
                input.sha256, input.sizeBytes, input.version ?? null, JSON.stringify(input.card ?? {}),
                input.workspaceKey ?? null, input.description ?? null, input.tags ?? null,
                input.sourceSessionId ?? null, input.sourceSlot ?? null, input.createdBy ?? null, input.mode,
                Boolean(input.requireNewOrSameBytes),
            ],
        );
        const r = rows[0];
        return {
            status: r.status, appId: r.app_id, versionId: r.version_id, version: r.version,
            artifactSessionId: r.artifact_session_id, artifactFilename: r.artifact_filename,
            appCreated: Boolean(r.app_created),
        };
    }

    async commit(versionId: string, mayActivate: boolean): Promise<{ appId: string; versionId: string; version: string; active: boolean }> {
        const rows = await this.call(`SELECT * FROM ${this.fn("commit")}($1,$2)`, [versionId, mayActivate]);
        const r = rows[0];
        return { appId: r.app_id, versionId: r.version_id, version: r.version, active: Boolean(r.active) };
    }

    async finishImport(appId: string): Promise<void> {
        await this.call(`SELECT ${this.fn("finish_import")}($1)`, [appId]);
    }

    /** Bytes of a ready version of an app this viewer may not see. */
    async shaHidden(sha256: string, viewer: CanvasAppViewer): Promise<boolean> {
        const rows = await this.call(`SELECT ${this.fn("sha_hidden")}($1,$2,$3,$4) AS hidden`, [sha256, ...viewerArgs(viewer)]);
        return Boolean(rows[0]?.hidden);
    }

    /**
     * Another owner's app bytes (exact sha256, or a shared app's workspace block)
     * that this viewer may not edit: the app name, '(private)', or null.
     */
    async foreignBytes(sha256: string, workspaceKey: string | null, viewer: CanvasAppViewer): Promise<string | null> {
        const rows = await this.call(`SELECT ${this.fn("foreign_bytes")}($1,$2,$3,$4,$5) AS name`, [sha256, workspaceKey, ...viewerArgs(viewer)]);
        return rows[0]?.name ?? null;
    }

    /** Is this artifact "session" id an app byte space (live or deleted)? */
    async isSpace(sessionId: string): Promise<boolean> {
        const rows = await this.call(`SELECT ${this.fn("is_space")}($1) AS space`, [sessionId]);
        return Boolean(rows[0]?.space);
    }

    /** Remove a version that never became ready (pending or claimed); true when a row was removed. */
    async abort(versionId: string): Promise<boolean> {
        const rows = await this.call(`SELECT ${this.fn("abort")}($1) AS removed`, [versionId]);
        return Boolean(rows[0]?.removed);
    }

    async list(viewer: CanvasAppViewer): Promise<CanvasAppSummary[]> {
        const rows = await this.call(`SELECT * FROM ${this.fn("list")}($1,$2,$3)`, viewerArgs(viewer));
        return rows.map((r) => ({
            appId: r.app_id, name: r.name, scope: r.scope, owner: principalOf(r.owner_provider, r.owner_subject),
            ownerEmail: r.owner_email ?? null, ownerDisplayName: r.owner_display_name ?? null,
            description: r.description ?? "", tags: r.tags ?? [], enabled: Boolean(r.enabled),
            createdBy: r.created_by ?? null, createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at),
            activeVersionId: r.active_version_id ?? null, version: r.version ?? null, sha256: r.sha256 ?? null,
            sizeBytes: r.size_bytes == null ? null : Number(r.size_bytes), card: r.card ? json(r.card) : null,
            canEdit: Boolean(r.can_edit), canManage: Boolean(r.can_manage), shadowed: Boolean(r.shadowed),
        }));
    }

    async search(viewer: CanvasAppViewer, query: string, limit: number): Promise<CanvasAppSearchHit[]> {
        const rows = await this.call(`SELECT * FROM ${this.fn("search")}($1,$2,$3,$4,$5)`, [...viewerArgs(viewer), query, limit]);
        return rows.map((r) => ({
            appId: r.app_id, name: r.name, scope: r.scope, owner: principalOf(r.owner_provider, r.owner_subject),
            description: r.description ?? "", tags: r.tags ?? [], enabled: Boolean(r.enabled),
            version: r.version ?? null, card: r.card ? json(r.card) : null, score: Number(r.score),
        }));
    }

    async get(target: CanvasAppTarget, viewer: CanvasAppViewer): Promise<CanvasAppDetail> {
        const [name, scope, op, os] = targetArgs(target);
        const rows = await this.call(`SELECT * FROM ${this.fn("get")}($1,$2,$3,$4,$5,$6,$7)`, [name, ...viewerArgs(viewer), scope, op, os]);
        const first = rows[0];
        return {
            appId: first.app_id, name: first.name, scope: first.scope,
            owner: principalOf(first.owner_provider, first.owner_subject),
            ownerEmail: first.owner_email ?? null, ownerDisplayName: first.owner_display_name ?? null,
            description: first.description ?? "", tags: first.tags ?? [], enabled: Boolean(first.enabled),
            createdBy: first.created_by ?? null, createdAt: new Date(first.created_at), updatedAt: new Date(first.updated_at),
            activeVersionId: first.active_version_id ?? null,
            canEdit: Boolean(first.can_edit), canManage: Boolean(first.can_manage),
            versions: rows.filter((r) => r.version_id != null).map((r) => ({
                versionId: r.version_id, version: r.version, sha256: r.sha256, sizeBytes: Number(r.size_bytes),
                artifactFilename: r.artifact_filename, card: json(r.card),
                sourceSessionId: r.source_session_id ?? null, sourceSlot: r.source_slot ?? null,
                createdBy: r.version_created_by ?? null, createdAt: new Date(r.version_created_at),
            })),
        };
    }

    async getVersion(target: CanvasAppTarget, viewer: CanvasAppViewer, version?: string | null): Promise<CanvasAppResolvedVersion> {
        const [name, scope, op, os] = targetArgs(target);
        const rows = await this.call(
            `SELECT * FROM ${this.fn("get_version")}($1,$2,$3,$4,$5,$6,$7,$8)`,
            [name, ...viewerArgs(viewer), scope, op, os, version ?? null],
        );
        const r = rows[0];
        return {
            appId: r.app_id, name: r.name, scope: r.scope, owner: principalOf(r.owner_provider, r.owner_subject),
            enabled: Boolean(r.enabled), artifactSessionId: r.artifact_session_id, versionId: r.version_id,
            version: r.version, sha256: r.sha256, sizeBytes: Number(r.size_bytes),
            artifactFilename: r.artifact_filename, card: json(r.card), workspaceKey: r.workspace_key ?? null,
        };
    }

    async matchBySha(sha256: string, viewer: CanvasAppViewer): Promise<CanvasAppShaMatch[]> {
        const rows = await this.call(`SELECT * FROM ${this.fn("match_by_sha")}($1,$2,$3,$4)`, [sha256, ...viewerArgs(viewer)]);
        return rows.map((r) => ({
            appId: r.app_id, name: r.name, scope: r.scope, owner: principalOf(r.owner_provider, r.owner_subject),
            enabled: Boolean(r.enabled), appCreatedAt: new Date(r.app_created_at), versionId: r.version_id, version: r.version,
        }));
    }

    async foreignWorkspaceMatch(workspaceKey: string, viewer: CanvasAppViewer): Promise<boolean> {
        const rows = await this.call(
            `SELECT ${this.fn("foreign_workspace_match")}($1,$2,$3) AS hit`,
            [workspaceKey, viewer.principal?.provider ?? null, viewer.principal?.subject ?? null],
        );
        return Boolean(rows[0]?.hit);
    }

    async setEnabled(target: CanvasAppTarget, enabled: boolean, viewer: CanvasAppViewer): Promise<void> {
        const [name, scope, op, os] = targetArgs(target);
        await this.call(`SELECT ${this.fn("set_enabled")}($1,$2,$3,$4,$5,$6,$7,$8)`, [name, enabled, ...viewerArgs(viewer), scope, op, os]);
    }

    async setMetadata(target: CanvasAppTarget, metadata: { description?: string | null; tags?: string[] | null }, viewer: CanvasAppViewer): Promise<void> {
        const [name, scope, op, os] = targetArgs(target);
        await this.call(
            `SELECT ${this.fn("set_metadata")}($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [name, metadata.description ?? null, metadata.tags ?? null, ...viewerArgs(viewer), scope, op, os],
        );
    }

    async pin(target: CanvasAppTarget, version: string, viewer: CanvasAppViewer): Promise<string> {
        const [name, scope, op, os] = targetArgs(target);
        const rows = await this.call(`SELECT ${this.fn("pin")}($1,$2,$3,$4,$5,$6,$7,$8) AS version_id`, [name, version, ...viewerArgs(viewer), scope, op, os]);
        return rows[0].version_id;
    }

    async setScope(target: CanvasAppTarget, scope: CanvasAppScope, viewer: CanvasAppViewer): Promise<void> {
        const [name, sel, op, os] = targetArgs(target);
        await this.call(`SELECT ${this.fn("set_scope")}($1,$2,$3,$4,$5,$6,$7,$8)`, [name, scope, ...viewerArgs(viewer), sel, op, os]);
    }

    /** Deletes the rows and returns the byte space and files the caller must delete. */
    async delete(target: CanvasAppTarget, viewer: CanvasAppViewer): Promise<{ appId: string; artifactSessionId: string; artifactFilenames: string[] }> {
        const [name, scope, op, os] = targetArgs(target);
        const rows = await this.call(`SELECT * FROM ${this.fn("delete")}($1,$2,$3,$4,$5,$6,$7)`, [name, ...viewerArgs(viewer), scope, op, os]);
        if (rows.length === 0) {
            // An app with no versions still has a tombstone; the prune op finds it.
            return { appId: "", artifactSessionId: "", artifactFilenames: [] };
        }
        return {
            appId: rows[0].app_id,
            artifactSessionId: rows[0].artifact_session_id,
            artifactFilenames: rows.map((r) => r.artifact_filename).filter(Boolean),
        };
    }

    async grantEditor(name: string, grantee: CanvasAppPrincipal, viewer: CanvasAppViewer): Promise<void> {
        await this.call(`SELECT ${this.fn("grant_editor")}($1,$2,$3,$4,$5,$6)`, [name, grantee.provider, grantee.subject, ...viewerArgs(viewer)]);
    }

    async revokeEditor(name: string, grantee: CanvasAppPrincipal, viewer: CanvasAppViewer): Promise<void> {
        await this.call(`SELECT ${this.fn("revoke_editor")}($1,$2,$3,$4,$5,$6)`, [name, grantee.provider, grantee.subject, ...viewerArgs(viewer)]);
    }

    async listEditors(name: string, viewer: CanvasAppViewer): Promise<CanvasAppEditorInfo[]> {
        const rows = await this.call(`SELECT * FROM ${this.fn("list_editors")}($1,$2,$3,$4)`, [name, ...viewerArgs(viewer)]);
        return rows.map((r) => ({
            provider: r.provider, subject: r.subject, email: r.email ?? null, displayName: r.display_name ?? null,
            grantedAt: new Date(r.granted_at),
        }));
    }

    async recordLoad(input: { appId: string; versionId: string; sessionId: string; user: CanvasAppPrincipal | null }): Promise<string | null> {
        const rows = await this.call(
            `SELECT ${this.fn("record_load")}($1,$2,$3,$4,$5) AS load_id`,
            [input.appId, input.versionId, input.sessionId, input.user?.provider ?? null, input.user?.subject ?? null],
        );
        return rows[0]?.load_id == null ? null : String(rows[0].load_id);
    }

    async listLoads(
        target: CanvasAppTarget,
        viewer: CanvasAppViewer,
        opts: { since?: Date | null; until?: Date | null; limit?: number; cursor?: { loadedAt: string; loadId: string } | null } = {},
    ): Promise<CanvasAppLoadPage> {
        const [name, scope, op, os] = targetArgs(target);
        const limit = Math.max(1, Math.min(500, Math.floor(Number(opts.limit) || 50)));
        const rows = await this.call(
            `SELECT * FROM ${this.fn("list_loads")}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
                name, ...viewerArgs(viewer), scope, op, os,
                opts.since ?? null, opts.until ?? null, limit,
                opts.cursor?.loadedAt ?? null, opts.cursor?.loadId ?? null,
            ],
        );
        const mapped: CanvasAppLoadRow[] = rows.map((r) => ({
            loadId: String(r.load_id), appName: r.app_name, version: r.version, sessionId: r.session_id,
            user: principalOf(r.user_provider, r.user_subject), userEmail: r.user_email ?? null,
            userDisplayName: r.user_display_name ?? null, loadedAt: new Date(r.loaded_at),
        }));
        let total30d = rows.length ? Number(rows[0].total_30d) : 0;
        if (!rows.length) {
            // An empty page still owes the total; one row past the start gives it.
            const probe = await this.call(
                `SELECT * FROM ${this.fn("list_loads")}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                [name, ...viewerArgs(viewer), scope, op, os, null, null, 1, null, null],
            );
            total30d = probe.length ? Number(probe[0].total_30d) : 0;
        }
        const lastRow = rows[rows.length - 1];
        return {
            rows: mapped,
            total30d,
            nextCursor: mapped.length === limit && lastRow
                ? { loadedAt: String(lastRow.cursor_at), loadId: String(lastRow.load_id) }
                : null,
        };
    }

    async pruneLoads(olderThan: Date, batch = 1000): Promise<number> {
        const rows = await this.call(`SELECT ${this.fn("prune_loads")}($1,$2) AS n`, [olderThan, batch]);
        return Number(rows[0]?.n ?? 0);
    }

    /**
     * Claims stale pending versions for cleanup (they can never be committed
     * afterwards) and returns every claimed version still to clean up.
     */
    async prunePending(olderThan: Date): Promise<Array<{ versionId: string; artifactSessionId: string; artifactFilename: string }>> {
        const rows = await this.call(`SELECT * FROM ${this.fn("prune_pending")}($1)`, [olderThan]);
        return rows.map((r) => ({ versionId: r.version_id, artifactSessionId: r.artifact_session_id, artifactFilename: r.artifact_filename }));
    }

    async listTombstones(limit = 100): Promise<Array<{ appId: string; artifactSessionId: string; name: string; deletedAt: Date }>> {
        const rows = await this.call(`SELECT * FROM ${this.fn("list_tombstones")}($1)`, [limit]);
        return rows.map((r) => ({ appId: r.app_id, artifactSessionId: r.artifact_session_id, name: r.name, deletedAt: new Date(r.deleted_at) }));
    }

    async markPurged(appId: string): Promise<void> {
        await this.call(`SELECT ${this.fn("mark_purged")}($1)`, [appId]);
    }

    /** Record the session owner's decision on one exact workspace program. */
    async setWorkspaceGrant(input: CanvasWorkspaceGrantKey & {
        rev: number; trust: string; versionId?: string | null;
        decision: "granted" | "denied"; by: CanvasAppPrincipal;
    }): Promise<void> {
        await this.call(
            `SELECT ${this.wsFn("set_grant")}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [input.sessionId, input.slot, input.pageSha256, input.declarationSha256, input.bindingsSha256,
                input.owner.provider, input.owner.subject, input.rev, input.trust, input.versionId ?? null,
                input.decision, input.by.provider, input.by.subject],
        );
    }

    async getWorkspaceGrant(key: CanvasWorkspaceGrantKey): Promise<"granted" | "denied" | null> {
        const rows = await this.call(
            `SELECT ${this.wsFn("get_grant")}($1,$2,$3,$4,$5,$6,$7) AS d`,
            [key.sessionId, key.slot, key.pageSha256, key.declarationSha256, key.bindingsSha256, key.owner.provider, key.owner.subject],
        );
        const d = rows[0]?.d;
        return d === "granted" || d === "denied" ? d : null;
    }
}
