/**
 * Session steering: the runTurn activity's side (§6a.6, §7.4).
 *
 * - `SteeringTurn` decides whether a turn is steerable, mints one owner
 *   token per ManagedSession.runTurn() call (a retry on a fresh live
 *   session gets a fresh owner), and implements the `SteeringChannel`
 *   over the `cms_steer_*` procedures.
 * - `finalize` / `adoptAndFinalize` run after the snapshot commit outcome
 *   is known, as the target's current owner (INV-R1..R4).
 */

import { randomUUID } from "node:crypto";
import type { SessionCatalog } from "./cms.js";
import { STEERING_NOTIFY_CHANNEL, steeringEnabled } from "./steering.js";
import type {
    SteerFinalizeOutcome,
    SteerRow,
    SteeringChannel,
    SteeringManifest,
    SteeringTarget,
} from "./steering-types.js";

export const STEERING_LEASE_MS = 10_000;

/** A source of notification wake-ups: subscribe to one session's hints. */
export interface SteeringWakeSource {
    subscribe(sessionId: string, cb: () => void): () => void;
}

type SteeringCatalog = Pick<SessionCatalog,
    | "supportsSteering" | "steerWindowOpen" | "steerWindowAbandon" | "steerWindowRenew" | "steerWindowQuiesce"
    | "steerWindowAdopt" | "steerClaim" | "steerRecordRecoveryCheck" | "steerMarkSubmitting" | "steerMarkReleased"
    | "steerMarkSubmitted" | "steerMarkDelivered" | "steerMarkUnconfirmed" | "steerTurnFinalize" | "steerCloseStopped"
    | "steerAddCounters">;

function failOnFalse(label: string): (ok: boolean) => void {
    return (ok) => {
        if (!ok) throw new Error(`steering ${label} was refused`);
    };
}

export function createCmsSteeringChannel(
    catalog: SteeringCatalog,
    sessionId: string,
    target: SteeringTarget,
    ownerToken: string,
    opts: {
        leaseMs?: number;
        wake?: SteeringWakeSource | null;
        recoverySource?: "restored" | "local";
        ordered?: <T>(fn: () => Promise<T>) => Promise<T>;
    } = {},
): SteeringChannel {
    const leaseMs = opts.leaseMs ?? STEERING_LEASE_MS;
    return {
        sessionId,
        target,
        ownerToken,
        // Fail closed: without an explicit restore, local state is never an inclusion oracle.
        recoverySource: opts.recoverySource ?? "local",
        leaseMs,
        openWindow: () => catalog.steerWindowOpen(sessionId, target, ownerToken, leaseMs),
        recordRecoveryCheck: async (requestId, result, sdkMessageId) => {
            await catalog.steerRecordRecoveryCheck(requestId, ownerToken, result, sdkMessageId ?? null);
        },
        renew: () => catalog.steerWindowRenew(sessionId, ownerToken, leaseMs),
        quiesce: async () => { await catalog.steerWindowQuiesce(sessionId, ownerToken); },
        abandonWindow: async () => { await catalog.steerWindowAbandon(sessionId, target, ownerToken); },
        claim: (limit) => catalog.steerClaim(sessionId, ownerToken, limit),
        markSubmitting: async (requestId) => {
            const attemptId = await catalog.steerMarkSubmitting(requestId, ownerToken);
            return attemptId ? { attemptId } : null;
        },
        // A refused receipt write is evidence the row moved on (stale owner, Stop);
        // the write queue reports it, and the DB state already reads as uncertain.
        markReleased: async (attemptId) => failOnFalse("release")(await catalog.steerMarkReleased(attemptId, ownerToken)),
        markSubmitted: async (attemptId, id) => failOnFalse("submitted")(await catalog.steerMarkSubmitted(attemptId, ownerToken, id)),
        markDelivered: async (attemptId, id, kind) => {
            const r = await catalog.steerMarkDelivered(attemptId, id, kind);
            if (!r.changed && r.reason !== "already_recorded") throw new Error(`steering delivery not recorded: ${r.reason}`);
        },
        markUnconfirmed: async (attemptId) => { await catalog.steerMarkUnconfirmed(attemptId, ownerToken); },
        recordCounters: async (counts) => { await catalog.steerAddCounters(sessionId, counts); },
        ...(opts.wake ? { onWake: (cb: () => void) => opts.wake!.subscribe(sessionId, cb) } : {}),
        ...(opts.ordered ? { ordered: opts.ordered } : {}),
    };
}

export interface SteeringTurnInput {
    catalog: SteeringCatalog | null | undefined;
    sessionId: string;
    turnKey?: string | null;
    transcriptEpoch?: number | null;
    turnIndex?: number | null;
    /** The CMS session row (owner, serviceKind). */
    sessionRow?: { owner?: { provider?: string | null; subject?: string | null } | null; serviceKind?: string | null } | null;
    featureCache?: Parameters<typeof steeringEnabled>[0];
    wake?: SteeringWakeSource | null;
    trace?: (message: string) => void;
}

/** Per-activity steering state. Null when the turn is not steerable. */
export class SteeringTurn {
    private owners: string[] = [];
    private restoredBase = false;
    private constructor(
        private readonly catalog: SteeringCatalog,
        readonly sessionId: string,
        readonly target: SteeringTarget,
        private readonly wake: SteeringWakeSource | null,
        private readonly trace: (m: string) => void,
    ) {}

    /**
     * Steerable only with a catalog that has the procedures, a turn key
     * (no retry-count fallback, §6a.2), a non-service session, and the flag
     * on for the session owner.
     */
    static async create(input: SteeringTurnInput): Promise<SteeringTurn | null> {
        const { catalog } = input;
        if (!catalog || !input.turnKey || !input.sessionRow || input.sessionRow.serviceKind) return null;
        if (!steeringEnabled(input.featureCache ?? null, input.sessionRow.owner ?? null)) return null;
        if (!(await catalog.supportsSteering().catch(() => false))) return null;
        return new SteeringTurn(
            catalog,
            input.sessionId,
            { epoch: input.transcriptEpoch ?? 0, turnIndex: input.turnIndex ?? 0, incarnation: input.turnKey },
            input.wake ?? null,
            input.trace ?? (() => {}),
        );
    }

    /**
     * The lifecycle preamble restored (or validated) the local session against
     * the stored base for this activity. Only the FIRST runTurn call after it
     * reads a restored conversation; any later call in the same activity
     * resumes local state the activity itself changed (FR-13).
     */
    markRestoredBase(): void { this.restoredBase = true; }

    /** A fresh channel and owner token for one ManagedSession.runTurn() call. */
    newChannel(opts: { ordered?: <T>(fn: () => Promise<T>) => Promise<T> } = {}): SteeringChannel {
        const owner = randomUUID();
        const recoverySource = this.restoredBase && this.owners.length === 0 ? "restored" : "local";
        this.owners.push(owner);
        return createCmsSteeringChannel(this.catalog, this.sessionId, this.target, owner,
            { wake: this.wake, recoverySource, ordered: opts.ordered });
    }

    /** The owner token that finalizes: the last channel's, or a fresh one for adoption. */
    get currentOwner(): string | null { return this.owners.at(-1) ?? null; }

    /**
     * Finalize after the commit outcome is known (INV-R1..R3), as the
     * target's current owner. Every token tried belongs to THIS activity
     * (one per runTurn call), newest first, so a retry on a fresh live
     * session that never opened its window still finalizes. Failures are
     * traced, not thrown: the turn result already stands, and the target is
     * closed later by Stop, the next window open or a terminal state.
     */
    async finalize(outcome: SteerFinalizeOutcome, manifest: SteeringManifest | undefined | null, snapshotVersion: number | null, owner?: string): Promise<void> {
        const owners = owner ? [owner] : [...this.owners].reverse();
        const ids = manifest ? manifest.delivered.map((d) => d.requestId) : null;
        for (const candidate of owners) {
            const r = await this.finalizeAs(candidate, outcome, ids, snapshotVersion);
            if (r !== "not_owner") return;
        }
    }

    private async finalizeAs(owner: string, outcome: SteerFinalizeOutcome, ids: string[] | null, snapshotVersion: number | null): Promise<string> {
        for (const delay of [0, 200, 800]) {
            if (delay) await new Promise((r) => setTimeout(r, delay));
            try {
                const r = await this.catalog.steerTurnFinalize(this.sessionId, this.target, owner, outcome, ids, snapshotVersion);
                if (r.finalized) return "finalized";
                return r.reason ?? "refused";
            } catch (err: any) {
                this.trace(`[steering] finalize ${outcome} failed: ${err?.message ?? String(err)}`);
            }
        }
        return "failed";
    }

    /**
     * Already-committed path (§6a.6): take reconciliation authority over this
     * target with a fresh owner token, then finalize with the stored result's
     * manifest. A false adopt means nothing is left to finalize.
     */
    async adoptAndFinalize(storedManifest: SteeringManifest | undefined | null, snapshotVersion: number | null): Promise<void> {
        const owner = randomUUID();
        let adopted = false;
        try {
            adopted = await this.catalog.steerWindowAdopt(this.sessionId, this.target, owner);
        } catch (err: any) {
            this.trace(`[steering] adopt failed: ${err?.message ?? String(err)}`);
            return;
        }
        if (!adopted) return;
        this.owners.push(owner);
        await this.finalize("adopted", storedManifest ?? null, snapshotVersion, owner);
    }
}

/** Bounds for the Stop fast path: per database call and for the whole path (§7.5, §9.1 rule 4). */
export const STOP_CLOSE_CALL_TIMEOUT_MS = 2_000;
export const STOP_CLOSE_BUDGET_MS = 5_000;

const STOP_TIMEOUT = Symbol("stop-close-timeout");

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof STOP_TIMEOUT> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        p,
        new Promise<typeof STOP_TIMEOUT>((resolve) => {
            timer = setTimeout(() => resolve(STOP_TIMEOUT), ms);
            (timer as any).unref?.();
        }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * Stop fast path (§7.5): target-scoped by turn index. Every database call is
 * bounded and the whole path has one budget, so a held procedure cannot delay
 * the Stop activity; on expiry it returns false (counted by the caller) and the
 * durable session.turn_stopped close remains the authority. A late write that
 * commits after the budget is still scoped to that turn index. Never throws.
 */
export async function closeStoppedSteering(
    catalog: Pick<SessionCatalog, "supportsSteering" | "steerCloseStopped"> | null | undefined,
    sessionId: string,
    turnIndex: number | null | undefined,
    trace: (m: string) => void = () => {},
    bounds: { callTimeoutMs?: number; budgetMs?: number } = {},
): Promise<boolean> {
    if (!catalog || turnIndex == null) return true;
    const callMs = bounds.callTimeoutMs ?? STOP_CLOSE_CALL_TIMEOUT_MS;
    const deadline = Date.now() + (bounds.budgetMs ?? STOP_CLOSE_BUDGET_MS);
    const remaining = () => Math.max(0, Math.min(callMs, deadline - Date.now()));
    try {
        const supported = await withTimeout(catalog.supportsSteering().catch(() => false), remaining());
        if (supported === STOP_TIMEOUT) { trace("[steering] Stop close: support check timed out"); return false; }
        if (!supported) return true;
        for (const delay of [0, 200, 800]) {
            if (delay) await new Promise((r) => setTimeout(r, Math.min(delay, Math.max(0, deadline - Date.now()))));
            if (remaining() <= 0) break;
            const r = await withTimeout(catalog.steerCloseStopped(sessionId, turnIndex).then(() => true, (err: any) => {
                trace(`[steering] Stop close failed: ${err?.message ?? String(err)}`);
                return false;
            }), remaining());
            if (r === true) return true;
            if (r === STOP_TIMEOUT) trace("[steering] Stop close timed out");
        }
    } catch (err: any) {
        trace(`[steering] Stop close failed: ${err?.message ?? String(err)}`);
    }
    return false;
}

/** Re-check the author's write access before hand-off (NFR-10). Deny on any doubt. */
export function createSteeringAuthorizer(deps: {
    sessionId: string;
    getSessionAccess: (sessionId: string, viewer: { provider: string; subject: string }) => Promise<any>;
    isAdmin: (principal: { provider: string; subject: string }) => Promise<boolean>;
    decide: (snapshot: any, isAdmin: boolean) => boolean;
}): (row: SteerRow) => Promise<boolean> {
    return async (row) => {
        const provider = typeof row.actor?.provider === "string" ? row.actor.provider : "";
        const subject = typeof row.actor?.subject === "string" ? row.actor.subject : "";
        if (!provider || !subject) return false;
        const snapshot = await deps.getSessionAccess(deps.sessionId, { provider, subject });
        if (!snapshot) return false;
        const admin = await deps.isAdmin({ provider, subject }).catch(() => false);
        return deps.decide(snapshot, admin);
    };
}

export { STEERING_NOTIFY_CHANNEL };

/** A live LISTEN connection. */
export interface SteeringListenerConnection {
    close(): Promise<void>;
}

/**
 * At most one notification listener per worker (NFR-6). Connects lazily on
 * the first subscription, wakes the pump of the named session, and
 * reconnects with backoff while anyone is subscribed. A missed notification
 * costs at most one fallback scan interval; every (re)connect wakes all
 * subscribers so they rescan.
 */
export class SteeringWakeHub implements SteeringWakeSource {
    private readonly subs = new Map<string, Set<() => void>>();
    private conn: SteeringListenerConnection | null = null;
    private connecting: Promise<void> | null = null;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private backoffMs = 1_000;
    private stopped = false;

    constructor(
        private readonly connect: (onNotify: (sessionId: string) => void, onError: (err: unknown) => void) => Promise<SteeringListenerConnection>,
        private readonly trace: (m: string) => void = () => {},
    ) {}

    subscribe(sessionId: string, cb: () => void): () => void {
        let set = this.subs.get(sessionId);
        if (!set) { set = new Set(); this.subs.set(sessionId, set); }
        set.add(cb);
        this.ensureConnected();
        return () => {
            const s = this.subs.get(sessionId);
            s?.delete(cb);
            if (s && s.size === 0) this.subs.delete(sessionId);
        };
    }

    private ensureConnected(): void {
        if (this.stopped || this.conn || this.connecting || this.retryTimer) return;
        this.connecting = this.connect(
            (sessionId) => { for (const cb of this.subs.get(sessionId) ?? []) { try { cb(); } catch {} } },
            (err) => this.onError(err),
        ).then((conn) => {
            this.connecting = null;
            if (this.stopped) { void conn.close().catch(() => {}); return; }
            this.conn = conn;
            this.backoffMs = 1_000;
            this.wakeAll();
        }, (err) => {
            this.connecting = null;
            this.onError(err);
        });
    }

    private onError(err: unknown): void {
        this.trace(`[steering] notification listener error: ${(err as any)?.message ?? String(err)}`);
        const conn = this.conn;
        this.conn = null;
        if (conn) void conn.close().catch(() => {});
        if (this.stopped || this.retryTimer || this.subs.size === 0) return;
        const delay = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
        this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.subs.size > 0) this.ensureConnected(); }, delay);
        (this.retryTimer as any).unref?.();
    }

    private wakeAll(): void {
        for (const set of this.subs.values()) for (const cb of set) { try { cb(); } catch {} }
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        await this.connecting?.catch(() => {});
        const conn = this.conn;
        this.conn = null;
        this.subs.clear();
        if (conn) await conn.close().catch(() => {});
    }
}

/**
 * One ordered writer for a turn's CMS events (session steering turns). Each
 * call enqueues `fn` synchronously and runs it after every earlier call has
 * settled, so `session_events.seq` follows enqueue order. A failure or a
 * rejection never stops the queue.
 */
export function createOrderedEventWriter(): <T>(fn: () => Promise<T>) => Promise<T> {
    let tail: Promise<unknown> = Promise.resolve();
    return <T>(fn: () => Promise<T>): Promise<T> => {
        const run = tail.then(fn, fn);
        tail = run.catch(() => {});
        return run;
    };
}
