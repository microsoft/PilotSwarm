/**
 * Session steering: public and internal types
 * (docs/proposals/session-steering.md §6a.2, §6a.5, §6a.8, §6b.1, Appendix C).
 *
 * One vocabulary for every surface. The receipt projection is computed by the
 * CMS (`cms_steer_projection`); `steering.ts` maps it to these types.
 */

/** Ledger row states (`session_steering_requests.status`). */
export type SteeringRowStatus =
    | "pending" | "claimed" | "submitting" | "submitted" | "delivered"
    | "orphaned" | "withdrawn" | "closed";

/** Canonical receipt dispositions. `rejected` is only used for refusals that never created a row. */
export type SteeringDisposition =
    | "accepted"
    | "delivered_current_turn"
    | "delivered_after_response"
    /** Delivered (found on recovery), but the CLI recorded no delivery kind: timing unknown (0086). */
    | "delivered_timing_unconfirmed"
    | "delivered_before_stop"
    | "not_delivered_turn_ended"
    | "not_delivered_turn_stopped"
    | "withdrawn"
    | "delivery_unconfirmed"
    | "rejected";

/** Derived recovery flags; never stored. */
export type SteeringRecoveryFlag = "redelivery_pending" | "delivered_again" | "recovery_unconfirmed";

/** SDK `user.message.data.delivery` kinds that count as delivery of a steer. */
export type SteeringDeliveryKind = "steering" | "queued" | "idle";

export type SteeringAttemptOutcome = "released" | "acknowledged" | "delivered" | "unconfirmed";

export type SteeringInclusionState = "included" | "not_included" | "unconfirmed";

export type SteeringEligibilityState = "pending" | "recovery_eligible" | "terminal";

export type SteeringSubmissionEvidence = "never_invoked" | "may_have_submitted" | "acknowledged";

export type SteeringClosureReason = "turn_ended" | "stopped" | "withdrawn";

export type SteeringWindowState = "open" | "quiesced" | "closed";

/** Typed refusal codes (Appendix C). */
export type SteeringRefusalCode =
    | "no_active_turn"
    | "stale_target"
    | "unsupported"
    | "rate_limited"
    | "too_large"
    | "forbidden"
    | "idempotency_conflict"
    | "not_withdrawable"
    | "not_found"
    | "invalid";

/** Reasons that accompany `unsupported`. */
export type SteeringUnsupportedReason =
    | "feature_disabled"
    | "authz_not_enforced"
    | "no_turn_identity"
    | "service_session"
    | "terminal_session"
    | "schema_missing"
    | "web_mode_unsupported";

/** Effective limits (OD-G team recommendation). */
export interface SteeringLimits {
    /** Maximum UTF-8 bytes of guidance text. */
    maxBytes: number;
    /** Maximum unresolved requests per session. */
    maxUnresolved: number;
    /** Maximum accepted requests per canonical actor per minute, across sessions. */
    ratePerMinute: number;
}

/** A steering target: one window incarnation of one session turn (§6a.2). */
export interface SteeringTarget {
    epoch: number;
    turnIndex: number;
    /** The runTurn input's `snapshot.turnKey`. */
    incarnation: string;
}

/** Decoded `expectedTarget` token. Callers treat the token as opaque. */
export interface DecodedSteeringTarget extends SteeringTarget {
    sessionId: string;
}

/** Canonical actor stamped by the server. Never taken from a request body. */
export interface SteeringActor {
    provider: string;
    subject: string;
    displayName?: string;
}

/** Submission input (§6b.1). */
export interface SteerSessionTurnOptions {
    text: string;
    clientRequestId: string;
    expectedTarget: string;
}

export interface SteeringAttemptV1 {
    attemptId: string;
    attemptNo: number;
    submittingAt: string;
    acknowledgedAt: string | null;
    deliveredAt: string | null;
    deliveryKind: SteeringDeliveryKind | null;
    outcome: SteeringAttemptOutcome | null;
}

/** The authoritative receipt (§6b.1). Timestamps are ISO-8601 UTC strings. */
export interface SteeringReceiptV1 {
    schemaVersion: 1;
    sessionId: string;
    requestId: string;
    clientRequestId: string;
    expectedTarget: string;
    /** Safe display metadata for the original target. */
    target: { transcriptEpoch: number; turnIndex: number };
    sequence: number;
    acceptedAt: string;
    settledAt: string | null;
    actor: SteeringActor;
    text: string;
    revision: number;
    status: SteeringRowStatus;
    disposition: SteeringDisposition;
    closureReason: SteeringClosureReason | null;
    submission: SteeringSubmissionEvidence;
    /** The row's window lost its owner (stale lease or orphaned row); recovery may follow. */
    recovering: boolean;
    /** Same-target recovery check (migration 0083): pending | present | absent | failed, or null. */
    recoveryCheck: "pending" | "present" | "absent" | "failed" | null;
    eligibility: { state: SteeringEligibilityState; reason: string | null };
    inclusion: { state: SteeringInclusionState; snapshotVersion: number | null };
    recoveryFlags: SteeringRecoveryFlag[];
    attempts: { total: number; items: SteeringAttemptV1[]; nextCursor: string | null };
    /** Viewer-derived. Never stored in a broadcast event. */
    actions: { canWithdraw: boolean; canSendAsNewMessage: boolean };
}

/** `session.steering_updated` projection: no text, no actions. */
export type SteeringProjectionV1 = Omit<SteeringReceiptV1, "text" | "actions">;

/** The CMS record before viewer actions are added. */
export type SteeringReceiptRecord = Omit<SteeringReceiptV1, "actions">;

/** `getSessionSteeringState` result. */
export interface SessionSteeringState {
    sessionId: string;
    /**
     * Steering can work on this session at all (schema, flag, enforcing authz,
     * not a service or terminal session). Live `session.steering_window_changed`
     * events may enable Steer only when this is true.
     */
    supported: boolean;
    /** A window is open with a fresh lease now. Implies `supported`. */
    steerable: boolean;
    /** The viewer has effective session:write (management-computed). Steer is enabled only with it. */
    canWrite: boolean;
    /** Opaque token for the open window, or null. Pass unchanged on submission. */
    expectedTarget: string | null;
    /** Why not steerable: a refusal code, or null when steerable. */
    reason: SteeringRefusalCode | null;
    /** Detail for `unsupported` (for example `authz_not_enforced`). */
    unsupportedReason?: SteeringUnsupportedReason | null;
    /** Window exists but its lease is stale. */
    recovering: boolean;
    window: {
        state: SteeringWindowState;
        transcriptEpoch: number;
        turnIndex: number;
        leaseFresh: boolean;
        openedAt: string;
        leaseExpiresAt: string | null;
    } | null;
    unresolved: number;
    /** `session_events.seq` of the latest window event read with this state (0 when none). */
    windowSeq: number;
    limits: SteeringLimits;
}

/** CMS part of the steering state (no limits, no flag/authz decision). */
export type SteeringStateRecord = Omit<SessionSteeringState, "sessionId" | "limits" | "unsupportedReason" | "supported" | "canWrite"> & {
    reason: "no_active_turn" | null;
};

/** Result of `cms_steer_accept`. */
export type SteerAcceptResult =
    | { outcome: "accepted"; duplicate: boolean; receipt: SteeringReceiptRecord }
    | { outcome: Exclude<SteeringRefusalCode, "not_withdrawable" | "unsupported">; reason?: string | null; limit?: number; retryAfterMs?: number };

export interface SteerAcceptInput {
    sessionId: string;
    requestId: string;
    idempotencyKey: string;
    actor: SteeringActor & Record<string, unknown>;
    content: string;
    contentHash: string;
    epoch: number;
    turnIndex: number;
    incarnation: string;
    limits?: Partial<SteeringLimits>;
}

/** Management-client submission result: a receipt or a typed refusal. Never a bare boolean. */
export type SteerSessionTurnResult =
    | { ok: true; duplicate: boolean; receipt: SteeringReceiptV1 }
    | {
        ok: false;
        code: SteeringRefusalCode;
        reason?: string | null;
        limit?: number;
        retryAfterMs?: number;
    };

export type SteeringWithdrawOutcome = "withdrawn" | "not_withdrawable" | "already_settled" | "forbidden" | "not_found";

export interface SteerWithdrawRecord {
    outcome: SteeringWithdrawOutcome;
    receipt?: SteeringReceiptRecord;
}

export interface WithdrawSteeringRequestResult {
    outcome: SteeringWithdrawOutcome;
    receipt: SteeringReceiptV1 | null;
}

export interface ListSteeringRequestsOptions {
    /** Opaque cursor from a previous page; bound to the session and filters. */
    cursor?: string | null;
    /** Default 50, maximum 200. */
    limit?: number;
    dispositions?: SteeringDisposition[];
    /** Restrict to one target (opaque token). */
    expectedTarget?: string;
}

export interface SteeringListPage {
    items: SteeringReceiptV1[];
    nextCursor: string | null;
}

/** Raw CMS list page (`cms_steer_list`). */
export interface SteerListRecord {
    items: SteeringReceiptRecord[];
    nextAfterSeq: number | null;
}

export interface GetSteeringRequestOptions {
    /** Attempt-page cursor from `attempts.nextCursor`. */
    attemptCursor?: string | null;
    attemptLimit?: number;
}

/** Latency distribution in milliseconds; null percentiles when count is 0. */
export interface SteeringLatency { count: number; p50: number | null; p95: number | null }

/** `getSessionSteeringStats` (§11). No content, no identities. */
export interface SessionSteeringStats {
    schemaVersion: 1;
    since: string | null;
    requests: {
        accepted: number;
        unresolved: number;
        claimable: number;
        oldestUnresolvedAt: string | null;
        byDisposition: Partial<Record<SteeringDisposition, number>>;
        byInclusion: { included: number; notIncluded: number; unconfirmed: number };
        recoveryChecks: { pending: number; present: number; absent: number; failed: number };
    };
    attempts: {
        attempts: number;
        deliveries: number;
        deliveredByKind: Record<SteeringDeliveryKind, number>;
        redeliveries: number;
        released: number;
        unconfirmed: number;
        inFlight: number;
    };
    latency: { handoffMs: SteeringLatency; safePointMs: SteeringLatency };
    /** Cumulative counters: `duplicate` and `rejected:<code>`. Not bounded by `since`. */
    counters: Record<string, number>;
    windows: { opened: number; abandoned: number; openDurationMs: SteeringLatency };
}

export interface SteeringStatsOptions {
    /** ISO timestamp lower bound; default all history. */
    since?: string | null;
}

// ─── Runtime (worker) types ─────────────────────────────────────

/** A row returned by `cms_steer_claim`. */
export interface SteerRow {
    requestId: string;
    sequence: number;
    text: string;
    actor: SteeringActor & Record<string, unknown>;
    /** An earlier attempt was delivered (same-target recovery): label as redelivery. */
    redelivery: boolean;
}

/** A row returned by `cms_steer_window_open` on same-target recovery. */
export interface SteerRecoveredRow {
    requestId: string;
    sequence: number;
    recoveryCheck: "pending" | null;
    /** Latest SDK id handed off for this row, if any. */
    sdkMessageId: string | null;
    sdkMessageIds: string[];
}

export interface SteerWindowOpenResult {
    ok: boolean;
    reason?: "closed" | "stale";
    recovery?: boolean;
    recovered: SteerRecoveredRow[];
}

/**
 * `present`: the id is in the conversation restored from the stored base (inclusion oracle).
 * `present_local`: the id is in local state this activity resumed (delivered; inclusion decided by finalize).
 */
export type SteerRecoveryCheckResult = "present" | "present_local" | "absent" | "failed";

export type SteerFinalizeOutcome = "published" | "adopted" | "unpublished" | "stopped" | "unknown";

export interface SteerFinalizeResult {
    finalized: boolean;
    reason?: "no_window" | "not_owner" | "closed" | "left_open";
    /** On an already-closed target: rows whose inclusion this owner recorded. */
    inclusionUpdated?: number;
}

export interface SteerMarkDeliveredResult {
    changed: boolean;
    current?: boolean;
    revision?: number;
    reason?: "not_found" | "message_id_mismatch" | "already_recorded";
}

/** One delivered steer in a turn result manifest (§6a.8). */
export interface SteeringManifestEntry {
    requestId: string;
    /** Null for a steer found in local state on same-activity recovery. */
    attemptId: string | null;
    sdkMessageId: string;
    /** Null when the recovered history event carried no recognized kind. */
    kind: SteeringDeliveryKind | null;
    /** Present in the resumed local conversation (not handed off by this pump). */
    recovered?: true;
}

export interface SteeringManifest {
    delivered: SteeringManifestEntry[];
}

/** Optional field carried on a turn result (§6a.8). */
export interface SteeringCarrier {
    steering?: SteeringManifest;
}

/**
 * The storage-agnostic channel the steering pump talks to (§6a.5).
 * `session-proxy.ts` implements it with the `cms_steer_*` procedures for one
 * target and one owner token.
 */
export interface SteeringChannel {
    readonly sessionId: string;
    readonly target: SteeringTarget;
    readonly ownerToken: string;
    /**
     * Where this turn's live conversation came from. Only `restored` (the lifecycle
     * preamble restored or validated it against the stored base) makes the recovery
     * check an inclusion oracle (FR-13); `local` is resumed activity-local state.
     */
    readonly recoverySource: "restored" | "local";
    /** Lease the window procedures grant (ms). The pump also enforces it locally. */
    readonly leaseMs?: number;
    openWindow(): Promise<SteerWindowOpenResult>;
    /** `kind`: the delivery kind recorded with the found user.message, when recognized. */
    recordRecoveryCheck(requestId: string, result: SteerRecoveryCheckResult, sdkMessageId?: string, kind?: SteeringDeliveryKind | null): Promise<void>;
    renew(): Promise<boolean>;
    quiesce(): Promise<void>;
    abandonWindow(): Promise<void>;
    claim(limit: number): Promise<SteerRow[]>;
    /** Must succeed before send(). Null when the window or claim is no longer ours. */
    markSubmitting(requestId: string): Promise<{ attemptId: string } | null>;
    markReleased(attemptId: string): Promise<void>;
    markSubmitted(attemptId: string, sdkMessageId: string): Promise<void>;
    /** Also writes the `user.message` projection with `data.steering`. */
    markDelivered(attemptId: string, sdkMessageId: string, kind: SteeringDeliveryKind): Promise<void>;
    markUnconfirmed(attemptId: string): Promise<void>;
    /** Notification hint; optional. Returns an unsubscribe function. */
    onWake?(cb: () => void): () => void;
    /** Durable, content-free runtime counters (§11). Optional; best-effort. */
    recordCounters?(counts: Record<string, number>): Promise<void>;
    /**
     * The session's ordered event writer for this turn. `fn` is ENQUEUED
     * synchronously, before this call returns, and runs after every write
     * enqueued earlier (generic SDK events included), so persisted seq order
     * matches SDK emission order. Absent ⇒ writes run directly.
     */
    ordered?<T>(fn: () => Promise<T>): Promise<T>;
}

/** `session.steering_window_changed` payload. */
export interface SteeringWindowChangedEventData {
    schemaVersion: 1;
    state: SteeringWindowState;
    expectedTarget: string | null;
    reason: string | null;
}

/** `user.message` steering correlation (`data.steering`). */
export interface SteeringUserMessageData {
    requestId: string;
    revision: number;
    attemptId: string;
    deliveryKind: SteeringDeliveryKind;
}

/** "Send as new message" linkage (§3.5, migration 0084). */
export interface SteeringResendLinkage {
    sessionId: string;
    requestId: string;
    clientMessageId: string;
    actor: { provider: string; subject: string };
    createdAt: string;
}

export type SteerResendIntentResult =
    | { outcome: "recorded"; duplicate: boolean; linkage: SteeringResendLinkage }
    | { outcome: "conflict" | "not_found" | "not_resendable" | "invalid" };
