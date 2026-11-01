/**
 * Compute targets — the data access layer over the `cms_compute_target_*`
 * procedures (migration 0084). Like ProviderStore, every rule about who may
 * do what lives in SQL; this class adds shape and a typed error.
 */
import type { Pool } from "pg";
import { advertisedHostModels, normalizeAdvertisement, targetModelRef, type ComputeAdvertisement, type ComputeTarget, type ComputeTargetAdvertisement, type ComputeTargetClass } from "./compute.js";

/** A refusal from the database, with the marker turned into a code. */
export class ComputeTargetError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = "ComputeTargetError";
        this.code = code;
    }
}

const COMPUTE_TARGET_ERROR = /^(COMPUTE_TARGET_[A-Z_]+):\s*(.*)$/s;

function rethrow(err: any): never {
    const raw = String(err?.message ?? "");
    const m = COMPUTE_TARGET_ERROR.exec(raw);
    if (m) throw new ComputeTargetError(m[1], m[2].trim());
    if (err?.code === "23514" && /compute_targets_(name_shape|name_space|kind_shape)/.test(raw)) {
        throw new ComputeTargetError("COMPUTE_TARGET_INVALID",
            /kind_shape/.test(raw)
                ? "A compute kind uses lowercase letters, numbers and dash."
                : /name_space/.test(raw)
                    ? 'A compute target everyone shares is named "shared/<label>", and one of someone\'s own is named after them.'
                    : 'A compute target is named "<owner>/<label>": the owner\'s sign-in address, or "shared" for one an administrator registers for everyone, then a label of letters, numbers, dot, dash and underscore.');
    }
    throw err;
}

export interface ComputeTargetRow extends ComputeTarget {
    /** Whether the viewer may change or delete it. */
    manageable: boolean;
    createdAt: string | null;
    updatedAt: string | null;
}

const iso = (v: any): string | null =>
    v === null || v === undefined ? null : (v instanceof Date ? v.toISOString() : String(v));

function toTarget(r: any): ComputeTarget {
    return {
        id: String(r.target_id ?? ""),
        name: r.name,
        kind: r.kind,
        class: r.class as ComputeTargetClass,
        ownerUserId: r.owner_user_id === null || r.owner_user_id === undefined ? null : Number(r.owner_user_id),
        displayName: r.display_name ?? null,
        config: r.config && typeof r.config === "object" ? r.config : {},
        enabled: r.enabled !== false,
        advertised: toAdvertisement(r.advertised, r.advertised_at),
    };
}

function toAdvertisement(raw: unknown, at: unknown): ComputeTargetAdvertisement | null {
    if (!raw || typeof raw !== "object") return null;
    return { ...normalizeAdvertisement(raw), observedAt: iso(at) ?? "" };
}

/** A model a target offers, as a session names it. */
export interface ComputeTargetModel {
    /** The name a session uses: `@<target>:<model>`. */
    ref: string;
    target: string;
    id: string;
    name?: string;
    /** When the target last said it offers this, or "" if it never has. */
    advertisedAt: string;
}

export class ComputeTargetStore {
    constructor(private readonly pool: Pool, private readonly schema: string) {}

    private fn(name: string): string {
        return `"${this.schema}".${name}`;
    }

    private async call(sql: string, params: any[] = []): Promise<any[]> {
        try {
            const { rows } = await this.pool.query(sql, params);
            return rows;
        } catch (err) {
            return rethrow(err);
        }
    }

    /** Principal → user id, without creating the user (shared with model providers). */
    async lookupUserId(principal: { provider: string; subject: string } | null | undefined): Promise<number | null> {
        if (!principal?.provider || !principal?.subject) return null;
        const rows = await this.call(
            `SELECT ${this.fn("cms_provider_user_id")}($1, $2) AS user_id`,
            [principal.provider, principal.subject]);
        const id = rows[0]?.user_id;
        return id === null || id === undefined ? null : Number(id);
    }

    async list(viewer: number | null, isAdmin: boolean): Promise<ComputeTargetRow[]> {
        const rows = await this.call(`SELECT * FROM ${this.fn("cms_compute_target_list")}($1, $2)`, [viewer, isAdmin]);
        return rows.map((r) => ({
            ...toTarget(r),
            manageable: Boolean(r.manageable),
            createdAt: iso(r.created_at),
            updatedAt: iso(r.updated_at),
        }));
    }

    async create(input: {
        name: string; kind: string; class: ComputeTargetClass;
        displayName?: string | null; config?: Record<string, unknown> | null;
    }, actor: number | null, isAdmin: boolean): Promise<ComputeTarget> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_compute_target_create")}($1,$2,$3,$4,$5,$6,$7)`,
            [input.name, input.kind, input.class, input.displayName ?? null,
                JSON.stringify(input.config ?? {}), actor, isAdmin]);
        return toTarget(rows[0] ?? {});
    }

    async update(name: string, patch: {
        displayName?: string | null; config?: Record<string, unknown> | null; enabled?: boolean | null;
    }, actor: number | null, isAdmin: boolean): Promise<ComputeTarget> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_compute_target_update")}($1,$2,$3,$4,$5,$6)`,
            [name, patch.displayName ?? null,
                patch.config === undefined || patch.config === null ? null : JSON.stringify(patch.config),
                patch.enabled ?? null, actor, isAdmin]);
        return toTarget(rows[0] ?? {});
    }

    /** Returns how many open sessions still name the target. */
    async delete(name: string, actor: number | null, isAdmin: boolean): Promise<number> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_compute_target_delete")}($1,$2,$3) AS waiting`, [name, actor, isAdmin]);
        return Number(rows[0]?.waiting ?? 0);
    }

    /**
     * Worker side: store what a target advertises. A shared target's models
     * are dropped (only personal targets may offer models). Returns the
     * target, or null when it is gone. Trusted caller.
     */
    async recordAdvertisement(targetId: string, advertisement: ComputeAdvertisement): Promise<ComputeTarget | null> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_compute_target_record_advertisement")}($1,$2)`,
            [targetId, JSON.stringify(normalizeAdvertisement(advertisement))]);
        return rows[0] ? toTarget(rows[0]) : null;
    }

    /**
     * The models the viewer's targets offer, as sessions name them. Only a
     * viewer's own (personal) targets offer models, so a shared target
     * contributes none however it advertises itself. Pass a target name for
     * one target. What a target advertises can be out of date: this is the
     * list of options to show, not a decision about what may run.
     */
    async listTargetModels(viewer: number | null, isAdmin: boolean, targetName?: string): Promise<ComputeTargetModel[]> {
        const targets = await this.list(viewer, isAdmin);
        return targets
            .filter((t) => t.enabled && (!targetName || t.name === targetName))
            .flatMap((t) => advertisedHostModels(t).map((m) => ({
                ref: targetModelRef(t.name, m.id), target: t.name, id: m.id,
                ...(m.name ? { name: m.name } : {}),
                advertisedAt: t.advertised?.observedAt ?? "",
            })));
    }

    /**
     * Worker side, before every turn: the target with this id if the session's
     * owner may still use it, else null. Trusted caller.
     */
    async resolveForSession(
        targetId: string,
        owner: { provider: string; subject: string } | null,
        isSystem: boolean,
    ): Promise<ComputeTarget | null> {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetId)) return null;
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_compute_target_resolve_for_session")}($1,$2,$3,$4)`,
            [targetId, owner?.provider ?? null, owner?.subject ?? null, isSystem]);
        return rows[0] ? toTarget(rows[0]) : null;
    }
}
