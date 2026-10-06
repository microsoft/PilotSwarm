import { evaluateSessionAccess, type AdminScope } from "pilotswarm-sdk/api";
import type { SessionCatalog } from "./cms.js";
import type { MessageSender } from "./message-sender.js";
import {
    DEFAULT_STEERING_LIMITS, decodeSteeringTarget, decodeSteeringListCursor,
    encodeSteeringListCursor, isValidClientRequestId, newSteeringRequestId,
    normalizeSteerText, readSteeringEnabled,
    steeringActorFromSender, steeringContentHash, toSteeringReceipt,
} from "./steering.js";
import type {
    GetSteeringRequestOptions, ListSteeringRequestsOptions, SessionSteeringState,
    SteeringDisposition, SteeringReceiptV1, SteeringRefusalCode,
    SteeringStatsOptions, SteerSessionTurnOptions, SteerSessionTurnResult,
    SteeringListPage, SessionSteeringStats, WithdrawSteeringRequestResult,
} from "./steering-types.js";

/** Trusted direct-mode context; Web API callers cannot supply this authority. */
export interface SteeringCallerContext {
    sender?: MessageSender;
    isAdmin?: boolean;
    adminScope?: AdminScope;
    systemReadable?: boolean;
    authzEnforced?: boolean;
}

/** Optional provenance for an explicit ordinary resend, never a steering submission. */
export interface SteeringResendOptions {
    steeringRequestId?: string;
    /** Trusted direct-mode context; overwritten by the Web API. */
    steeringContext?: SteeringCallerContext;
}

export class SteeringError extends Error {
    constructor(public readonly code: SteeringRefusalCode, message: string, public readonly reason?: string) {
        super(message);
        this.name = "SteeringError";
    }
}

const DISPOSITIONS: ReadonlySet<SteeringDisposition> = new Set([
    "accepted", "delivered_current_turn", "delivered_after_response", "delivered_before_stop",
    "not_delivered_turn_ended", "not_delivered_turn_stopped", "withdrawn", "delivery_unconfirmed", "rejected",
]);

function boundedInteger(value: number | undefined, fallback: number, max: number): number {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > max) {
        throw new SteeringError("invalid", `Limit must be an integer from 1 to ${max}`);
    }
    return value;
}

/** One implementation shared by the management client and session facade. */
export class SteeringManagement {
    constructor(private readonly catalog: SessionCatalog) {}

    private async authorize(sessionId: string, edge: SteeringCallerContext, action: string, write = false) {
        const actor = steeringActorFromSender(edge.sender);
        const snapshot = actor ? await this.catalog.getSessionAccess(sessionId, actor) : null;
        const permission = {
            isAdmin: edge.isAdmin === true,
            adminScope: edge.adminScope,
            systemReadable: edge.systemReadable ?? true,
        };
        const read = snapshot ? evaluateSessionAccess("session:read", snapshot, permission) : null;
        const writing = snapshot ? evaluateSessionAccess("session:write", snapshot, permission) : null;
        if (!actor || !snapshot || !read?.allowed || write && !writing?.allowed) {
            const hidden = !snapshot || !read?.allowed;
            await this.catalog.recordAuthzAudit({
                actor, action, sessionId, decision: "deny",
                reason: hidden ? "not visible" : "write access required",
            });
            throw new SteeringError(hidden ? "not_found" : "forbidden",
                hidden ? "Session not found." : "Write access is required.");
        }
        if (edge.authzEnforced === false && action !== "getSessionSteeringState") {
            throw new SteeringError("unsupported", "Steering requires enforcing ownership authorization.", "authz_not_enforced");
        }
        return {
            actor, canWrite: writing?.allowed === true,
            isManager: evaluateSessionAccess("session:manage", snapshot, permission).allowed,
        };
    }

    private async requireSchema() {
        if (typeof this.catalog.supportsSteering !== "function" || !await this.catalog.supportsSteering()) {
            throw new SteeringError("unsupported", "Steering storage is unavailable.", "schema_missing");
        }
    }

    async state(sessionId: string, edge: SteeringCallerContext = {}): Promise<SessionSteeringState> {
        const viewer = await this.authorize(sessionId, edge, "getSessionSteeringState");
        const session = await this.catalog.getSession(sessionId);
        if (!session) throw new SteeringError("not_found", "Session not found.");
        const base = {
            sessionId, steerable: false, supported: false, canWrite: viewer.canWrite,
            expectedTarget: null, reason: "unsupported" as const, recovering: false,
            window: null, windowSeq: 0, unresolved: 0, limits: { ...DEFAULT_STEERING_LIMITS },
        };
        if (edge.authzEnforced === false) return { ...base, unsupportedReason: "authz_not_enforced" };
        if (session.serviceKind) return { ...base, unsupportedReason: "service_session" };
        if (["completed", "cancelled", "failed", "error"].includes(session.state)) return { ...base, unsupportedReason: "terminal_session" };
        if (!await this.catalog.supportsSteering()) return { ...base, unsupportedReason: "schema_missing" };
        if (!await readSteeringEnabled(this.catalog.features, session.owner)) return { ...base, unsupportedReason: "feature_disabled" };
        const record = await this.catalog.steerState(sessionId);
        return {
            ...base, ...record, supported: true, steerable: record.steerable && viewer.canWrite,
        };
    }

    async accept(sessionId: string, options: SteerSessionTurnOptions, edge: SteeringCallerContext = {}): Promise<SteerSessionTurnResult> {
        try {
            const viewer = await this.authorize(sessionId, edge, "steerSessionTurn", true);
            if (!isValidClientRequestId(options?.clientRequestId)) return { ok: false, code: "invalid" };
            const target = decodeSteeringTarget(options.expectedTarget);
            if (!target || target.sessionId !== sessionId) return { ok: false, code: "stale_target" };
            const normalized = normalizeSteerText(options.text);
            if (!normalized.ok) return { ok: false, code: normalized.code, ...("limit" in normalized ? { limit: normalized.limit } : {}) };
            await this.requireSchema();
            const identity = {
                sessionId, idempotencyKey: options.clientRequestId, actor: { ...viewer.actor },
                contentHash: steeringContentHash(normalized.text),
                epoch: target.epoch, turnIndex: target.turnIndex, incarnation: target.incarnation,
            };
            const existing = await this.catalog.steerMatchExisting(identity);
            if (existing) {
                return existing.outcome === "accepted"
                    ? { ok: true, duplicate: true, receipt: toSteeringReceipt(existing.receipt, viewer) }
                    : { ok: false, code: existing.outcome, reason: existing.reason, limit: existing.limit, retryAfterMs: existing.retryAfterMs };
            }
            const session = await this.catalog.getSession(sessionId);
            if (!session) return { ok: false, code: "not_found" };
            if (session.serviceKind) return { ok: false, code: "unsupported", reason: "service_session" };
            if (["completed", "cancelled", "failed", "error"].includes(session.state)) return { ok: false, code: "unsupported", reason: "terminal_session" };
            if (!await readSteeringEnabled(this.catalog.features, session.owner)) {
                return { ok: false, code: "unsupported", reason: "feature_disabled" };
            }
            const result = await this.catalog.steerAccept({
                ...identity, requestId: newSteeringRequestId(), content: normalized.text, limits: DEFAULT_STEERING_LIMITS,
            });
            if (result.outcome === "accepted") {
                return { ok: true, duplicate: result.duplicate, receipt: toSteeringReceipt(result.receipt, viewer) };
            }
            return { ok: false, code: result.outcome, reason: result.reason, limit: result.limit, retryAfterMs: result.retryAfterMs };
        } catch (error) {
            if (error instanceof SteeringError) return { ok: false, code: error.code, reason: error.reason };
            throw error;
        }
    }

    async get(sessionId: string, requestId: string, options: GetSteeringRequestOptions = {}, edge: SteeringCallerContext = {}): Promise<SteeringReceiptV1> {
        const viewer = await this.authorize(sessionId, edge, "getSteeringRequest");
        await this.requireSchema();
        const attemptAfter = options.attemptCursor == null ? 0 : Number(options.attemptCursor);
        if (!Number.isSafeInteger(attemptAfter) || attemptAfter < 0
            || options.attemptCursor != null && !/^\d+$/.test(options.attemptCursor)) {
            throw new SteeringError("invalid", "Invalid attempt cursor");
        }
        const record = await this.catalog.steerGet(sessionId, requestId, {
            attemptAfter, attemptLimit: boundedInteger(options.attemptLimit, 20, 200),
        });
        if (!record) throw new SteeringError("not_found", "Guidance request not found.");
        return toSteeringReceipt(record, viewer);
    }

    async list(sessionId: string, options: ListSteeringRequestsOptions = {}, edge: SteeringCallerContext = {}): Promise<SteeringListPage> {
        const viewer = await this.authorize(sessionId, edge, "listSteeringRequests");
        await this.requireSchema();
        if (options.dispositions !== undefined && (!Array.isArray(options.dispositions)
            || options.dispositions.some(value => !DISPOSITIONS.has(value)))) {
            throw new SteeringError("invalid", "Invalid disposition filter");
        }
        const target = options.expectedTarget === undefined ? null : decodeSteeringTarget(options.expectedTarget);
        if (options.expectedTarget !== undefined && (!target || target.sessionId !== sessionId)) {
            throw new SteeringError("stale_target", "The target does not belong to this session.");
        }
        const afterSeq = options.cursor == null ? undefined : decodeSteeringListCursor(sessionId, options, options.cursor);
        if (afterSeq === null) throw new SteeringError("invalid", "The cursor does not match this session and filter.");
        const page = await this.catalog.steerList(sessionId, {
            afterSeq, limit: boundedInteger(options.limit, 50, 200), dispositions: options.dispositions, target,
        });
        return {
            items: page.items.map(record => toSteeringReceipt(record, viewer)),
            nextCursor: page.nextAfterSeq == null ? null : encodeSteeringListCursor(sessionId, options, page.nextAfterSeq),
        };
    }

    async withdraw(sessionId: string, requestId: string, edge: SteeringCallerContext = {}): Promise<WithdrawSteeringRequestResult> {
        const viewer = await this.authorize(sessionId, edge, "withdrawSteeringRequest");
        await this.requireSchema();
        const result = await this.catalog.steerWithdraw(sessionId, requestId, viewer.actor, viewer.isManager);
        if (result.outcome === "forbidden") {
            await this.catalog.recordAuthzAudit({
                actor: viewer.actor, action: "withdrawSteeringRequest", sessionId,
                decision: "deny", reason: "original author or session manager required",
            });
        }
        return { outcome: result.outcome, receipt: result.receipt ? toSteeringReceipt(result.receipt, viewer) : null };
    }

    async stats(sessionId: string, options: SteeringStatsOptions = {}, edge: SteeringCallerContext = {}): Promise<SessionSteeringStats> {
        await this.authorize(sessionId, edge, "getSessionSteeringStats");
        await this.requireSchema();
        if (options.since != null && !Number.isFinite(Date.parse(options.since))) throw new SteeringError("invalid", "Invalid since timestamp");
        return this.catalog.steerStats(sessionId, options);
    }

    async recordResendIntent(sessionId: string, requestId: string, text: string, clientMessageIds: string[] | undefined, edge: SteeringCallerContext = {}): Promise<void> {
        const viewer = await this.authorize(sessionId, edge, "sendMessage.steeringResend", true);
        await this.requireSchema();
        if (!isValidClientRequestId(requestId) || clientMessageIds?.length !== 1 || !isValidClientRequestId(clientMessageIds[0])) {
            throw new SteeringError("invalid", "A guidance resend requires its request ID and one fresh client message ID.");
        }
        const record = await this.catalog.steerGet(sessionId, requestId);
        if (!record) throw new SteeringError("not_found", "Guidance request not found.");
        if (clientMessageIds[0] === record.clientRequestId || clientMessageIds[0] === record.requestId) {
            throw new SteeringError("invalid", "A guidance resend must use a new client message identity.");
        }
        if (text !== record.text) {
            throw new SteeringError("invalid", "The resend text must match its original guidance receipt.");
        }
        // The queue and CMS have different commit boundaries. Record intent,
        // not success; a normal user.message with this fresh ID proves uptake.
        const result = await this.catalog.steerRecordResendIntent(sessionId, requestId, clientMessageIds[0],
            { provider: viewer.actor.provider, subject: viewer.actor.subject }, edge.sender ? { ...edge.sender } : null);
        if (result.outcome === "conflict") throw new SteeringError("idempotency_conflict", "The resend identity is already bound to different guidance or another sender.");
        if (result.outcome === "not_found") throw new SteeringError("not_found", "Guidance request not found.");
        if (result.outcome === "not_resendable") throw new SteeringError("invalid", "Only retained guidance can be resent through its original receipt.");
        if (result.outcome === "invalid") throw new SteeringError("invalid", "Invalid guidance resend identity.");
    }
}
