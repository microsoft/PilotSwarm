/**
 * Host bindings — the data access layer over the `cms_compute_binding_*`
 * procedures (migration 0084). Like `ComputeTargetStore`, every rule about
 * who may do what lives in SQL; this class adds shape and a typed error.
 *
 * The store never holds a secret. A binding says which host a session tree
 * is using and until when, and never the handshake secret that proves the
 * worker to it.
 */
import type { Pool } from "pg";
import { computeHostKey, type ComputeHostRef } from "./compute.js";

/** A refusal from the database, with the marker turned into a code. */
export class ComputeBindingError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = "ComputeBindingError";
        this.code = code;
    }
}

const COMPUTE_BINDING_ERROR = /^(COMPUTE_BINDING_[A-Z_]+):\s*(.*)$/s;

function rethrow(err: any): never {
    const raw = String(err?.message ?? "");
    const m = COMPUTE_BINDING_ERROR.exec(raw);
    if (m) throw new ComputeBindingError(m[1], m[2].trim());
    throw err;
}

const iso = (v: any): string | null =>
    v === null || v === undefined ? null : (v instanceof Date ? v.toISOString() : String(v));

/** A binding as the CMS holds it. */
export interface ComputeBindingRow {
    bindingId: string;
    rootSessionId: string;
    targetId: string;
    kind: string;
    hostRef: ComputeHostRef;
    workerNodeId: string;
    leasedUntil: string | null;
    releasedAt: string | null;
    doneAt: string | null;
}

function toBinding(r: any): ComputeBindingRow {
    return {
        bindingId: String(r.binding_id ?? ""),
        rootSessionId: String(r.root_session_id ?? ""),
        targetId: String(r.target_id ?? ""),
        kind: String(r.kind ?? ""),
        hostRef: (r.host_ref && typeof r.host_ref === "object" ? r.host_ref : {}) as ComputeHostRef,
        workerNodeId: String(r.worker_node_id ?? ""),
        leasedUntil: iso(r.leased_until),
        releasedAt: iso(r.released_at),
        doneAt: iso(r.done_at),
    };
}

class ComputeSqlStore {
    constructor(protected readonly pool: Pool, protected readonly schema: string) {}

    protected fn(name: string): string {
        return `"${this.schema}".${name}`;
    }

    protected async call(sql: string, params: any[] = []): Promise<any[]> {
        try {
            const { rows } = await this.pool.query(sql, params);
            return rows;
        } catch (err) {
            return rethrow(err);
        }
    }
}

export class ComputeBindingStore extends ComputeSqlStore {
    /** At bind: write the binding and take a lease on it. */
    async record(input: {
        rootSessionId: string; targetId: string; kind: string;
        host: ComputeHostRef; workerNodeId: string; leaseMs: number;
    }): Promise<ComputeBindingRow> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_compute_binding_record")}($1,$2,$3,$4,$5,$6,$7)`,
            [input.rootSessionId, input.targetId, input.kind, computeHostKey(input.host),
                JSON.stringify(input.host), input.workerNodeId, Math.max(0, Math.trunc(input.leaseMs))]);
        return toBinding(rows[0] ?? {});
    }

    /** On the lease timer. False when the binding is gone or already finished with. */
    async renew(bindingId: string, workerNodeId: string, leaseMs: number): Promise<boolean> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_compute_binding_renew")}($1,$2,$3) AS held`,
            [bindingId, workerNodeId, Math.max(0, Math.trunc(leaseMs))]);
        return Boolean(rows[0]?.held);
    }

    /** At release: this worker is no longer using the host. */
    async release(bindingId: string): Promise<boolean> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_compute_binding_release")}($1) AS let_go`, [bindingId]);
        return Boolean(rows[0]?.let_go);
    }

    /** The sweep: bindings whose session tree has ended, claimed for this worker. */
    async claimDone(workerNodeId: string, limit: number, retryAfterMs: number): Promise<Array<{
        bindingId: string; rootSessionId: string; targetId: string; kind: string;
        hostRef: ComputeHostRef; reason: "ended" | "deleted";
    }>> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_compute_binding_claim_done")}($1,$2,$3)`,
            [workerNodeId, Math.max(1, Math.trunc(limit)), Math.max(0, Math.trunc(retryAfterMs))]);
        return rows.map((r) => ({
            bindingId: String(r.binding_id ?? ""),
            rootSessionId: String(r.root_session_id ?? ""),
            targetId: String(r.target_id ?? ""),
            kind: String(r.kind ?? ""),
            hostRef: (r.host_ref && typeof r.host_ref === "object" ? r.host_ref : {}) as ComputeHostRef,
            reason: r.reason === "deleted" ? "deleted" : "ended",
        }));
    }

    /** The provider has been told. Idempotent: only the first notice counts. */
    async markDone(bindingId: string): Promise<boolean> {
        const rows = await this.call(
            `SELECT ${this.fn("cms_compute_binding_mark_done")}($1) AS marked`, [bindingId]);
        return Boolean(rows[0]?.marked);
    }

    /** The bindings of one session tree. */
    async forRootSession(rootSessionId: string): Promise<ComputeBindingRow[]> {
        const rows = await this.call(
            `SELECT * FROM ${this.fn("cms_compute_binding_list")}($1)`, [rootSessionId]);
        return rows.map(toBinding);
    }
}
