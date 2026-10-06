/**
 * Session steering: the one shared mapping module (§6b.1).
 *
 * - The opaque `expectedTarget` token (the CMS writes the same encoding in
 *   `cms_steer_target_token`, so tokens from events and reads agree).
 * - Text normalization, byte limits and the content hash used for
 *   idempotency.
 * - CMS receipt record → public `SteeringReceiptV1` with viewer-derived
 *   actions. The CMS computes eligibility, inclusion and recovery flags in
 *   the same transaction that writes the steering events; this module never
 *   recomputes them differently.
 * - The list cursor, bound to session and filters.
 */

import { createHash, randomUUID } from "node:crypto";
import type { FeatureFlagCache } from "./feature-flag-cache.js";
import { featureOwnerKey, resolveFeatureDefinition, type FeatureOwner, type FeatureSnapshot } from "./feature-flags.js";
import type { MessageSender } from "./message-sender.js";
import type {
    DecodedSteeringTarget,
    SteeringActor,
    SteeringDisposition,
    SteeringLimits,
    SteeringReceiptRecord,
    SteeringReceiptV1,
    SteeringTarget,
} from "./steering-types.js";

export const STEERING_FEATURE = "sessions.steering";

/** OD-G team recommendation (§10.4). */
export const DEFAULT_STEERING_LIMITS: Readonly<SteeringLimits> = Object.freeze({
    maxBytes: 8 * 1024,
    maxUnresolved: 16,
    ratePerMinute: 30,
});

export const STEERING_EVENT_TYPES = Object.freeze({
    accepted: "session.steering_accepted",
    updated: "session.steering_updated",
    windowChanged: "session.steering_window_changed",
} as const);

/** Notification channel raised by acceptance and withdrawal; payload is the session id only. */
export const STEERING_NOTIFY_CHANNEL = "pilotswarm_steering";

const TARGET_PREFIX = "st1.";

/**
 * Whether steering is enabled for a session with this owner, from the
 * worker/server feature cache. Off when the cache is missing or unloaded.
 * The flag has no user override, so the cluster setting decides.
 */
export function steeringEnabled(
    cache: Pick<FeatureFlagCache, "resolve"> | null | undefined,
    owner: { provider?: string | null; subject?: string | null } | null | undefined,
): boolean {
    if (!cache) return false;
    const featureOwner: FeatureOwner | null = owner?.provider && owner?.subject
        ? { provider: owner.provider, subject: owner.subject }
        : null;
    return cache.resolve(STEERING_FEATURE, featureOwner, { fallback: false }).enabled === true;
}

/**
 * Direct read for trusted direct-mode callers without a worker cache (the
 * management client): one `cms_feature_snapshot` read, resolved with the same
 * rules as the cache. Off when the definition is missing.
 */
export async function readSteeringEnabled(
    features: { snapshot(keys: string[]): Promise<FeatureSnapshot> } | null | undefined,
    owner: { provider?: string | null; subject?: string | null } | null | undefined,
): Promise<boolean> {
    if (!features) return false;
    const snapshot = await features.snapshot([STEERING_FEATURE]);
    const definition = snapshot.definitions.find((d) => d.featureKey === STEERING_FEATURE);
    if (!definition) return false;
    const cluster = snapshot.settings.find((s) => s.featureKey === STEERING_FEATURE && s.scope === "cluster");
    const ownerKey = owner?.provider && owner?.subject ? featureOwnerKey({ provider: owner.provider, subject: owner.subject }) : null;
    const user = ownerKey
        ? snapshot.settings.find((s) => s.featureKey === STEERING_FEATURE && s.scope === "user" && s.owner && featureOwnerKey(s.owner) === ownerKey)
        : undefined;
    return resolveFeatureDefinition(definition, cluster, user).enabled === true;
}

/** Same encoding as `cms_steer_target_token`. */
export function encodeSteeringTarget(sessionId: string, target: SteeringTarget): string {
    const raw = `${sessionId}\n${target.epoch}\n${target.turnIndex}\n${target.incarnation}`;
    return TARGET_PREFIX + Buffer.from(raw, "utf8").toString("base64url");
}

/** Returns null for anything that is not a well-formed token. */
export function decodeSteeringTarget(token: unknown): DecodedSteeringTarget | null {
    if (typeof token !== "string" || !token.startsWith(TARGET_PREFIX) || token.length > 1024) return null;
    const body = token.slice(TARGET_PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(body)) return null;
    const parts = Buffer.from(body, "base64url").toString("utf8").split("\n");
    if (parts.length !== 4) return null;
    const [sessionId, epochText, turnText, incarnation] = parts;
    if (!sessionId || !incarnation || !/^-?\d{1,9}$/.test(epochText) || !/^-?\d{1,9}$/.test(turnText)) return null;
    const decoded = { sessionId, epoch: Number(epochText), turnIndex: Number(turnText), incarnation };
    // Reject non-canonical encodings so one target has exactly one token.
    return encodeSteeringTarget(sessionId, decoded) === token ? decoded : null;
}

export function utf8ByteLength(text: string): number {
    return Buffer.byteLength(text, "utf8");
}

/**
 * Trim and bound guidance text. Counts encoded UTF-8 bytes, not characters.
 * The same byte limit is enforced again inside `cms_steer_accept`.
 */
export function normalizeSteerText(
    text: unknown,
    maxBytes: number = DEFAULT_STEERING_LIMITS.maxBytes,
): { ok: true; text: string; bytes: number } | { ok: false; code: "invalid" | "too_large"; bytes?: number; limit?: number } {
    if (typeof text !== "string") return { ok: false, code: "invalid" };
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, code: "invalid" };
    const bytes = utf8ByteLength(trimmed);
    if (bytes > maxBytes) return { ok: false, code: "too_large", bytes, limit: maxBytes };
    return { ok: true, text: trimmed, bytes };
}

/** sha256 hex of the normalized text; part of the idempotency comparison. */
export function steeringContentHash(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

export function newSteeringRequestId(): string {
    return `steer_${randomUUID()}`;
}

/** A well-formed client request id: 1..200 printable characters. */
export function isValidClientRequestId(id: unknown): id is string {
    return typeof id === "string" && id.length > 0 && id.length <= 200 && /^[\x21-\x7e]+$/.test(id);
}

/**
 * The stored actor: the server-stamped sender of a user. Agents and system
 * senders cannot steer (§2.3). Returns null when no canonical identity.
 */
export function steeringActorFromSender(sender: MessageSender | null | undefined): (SteeringActor & MessageSender) | null {
    if (!sender || sender.kind !== "user" || !sender.provider || !sender.subject) return null;
    return {
        ...sender,
        provider: sender.provider,
        subject: sender.subject,
        ...(sender.display ? { displayName: sender.display } : {}),
    };
}

export function sameSteeringActor(
    a: { provider?: string | null; subject?: string | null } | null | undefined,
    b: { provider?: string | null; subject?: string | null } | null | undefined,
): boolean {
    return Boolean(a?.provider && a?.subject && a.provider === b?.provider && a.subject === b?.subject);
}

/** Dispositions from which the viewer may resend the retained text as an ordinary message (OD-B). */
const RESENDABLE: ReadonlySet<SteeringDisposition> = new Set([
    "not_delivered_turn_ended",
    "not_delivered_turn_stopped",
    "withdrawn",
]);

export interface SteeringViewer {
    /** The viewer's canonical identity, if any. */
    actor?: { provider?: string | null; subject?: string | null } | null;
    /** Effective session:write. */
    canWrite: boolean;
    /** Owner, or admin within admin scope. */
    isManager: boolean;
}

/** CMS record → public receipt with viewer-derived actions. */
export function toSteeringReceipt(record: SteeringReceiptRecord, viewer: SteeringViewer): SteeringReceiptV1 {
    const isAuthor = sameSteeringActor(record.actor, viewer.actor);
    return {
        ...record,
        actions: {
            canWithdraw: record.status === "pending" && viewer.canWrite && (isAuthor || viewer.isManager),
            canSendAsNewMessage: viewer.canWrite && RESENDABLE.has(record.disposition),
        },
    };
}

/** Projection for a broadcast event: no text, no actions. */
export function toSteeringProjection(record: SteeringReceiptRecord): Omit<SteeringReceiptRecord, "text"> {
    const { text: _text, ...rest } = record as SteeringReceiptRecord & { text?: string };
    return rest;
}

// ─── List cursor ────────────────────────────────────────────────

export interface SteeringListFilter {
    dispositions?: readonly string[] | null;
    expectedTarget?: string | null;
}

function filterFingerprint(sessionId: string, filter: SteeringListFilter): string {
    const dispositions = [...(filter.dispositions ?? [])].sort();
    return createHash("sha256")
        .update(JSON.stringify([sessionId, dispositions, filter.expectedTarget ?? null, "asc"]))
        .digest("base64url")
        .slice(0, 16);
}

/** Opaque, bound to the session, filter set and ordering direction. */
export function encodeSteeringListCursor(sessionId: string, filter: SteeringListFilter, afterSeq: number): string {
    return Buffer.from(JSON.stringify({ v: 1, f: filterFingerprint(sessionId, filter), a: afterSeq }), "utf8")
        .toString("base64url");
}

/** Returns the after-sequence, or null when the cursor belongs to another session or filter. */
export function decodeSteeringListCursor(sessionId: string, filter: SteeringListFilter, cursor: string): number | null {
    try {
        const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (parsed?.v !== 1 || parsed.f !== filterFingerprint(sessionId, filter)) return null;
        return Number.isSafeInteger(parsed.a) && parsed.a >= 0 ? parsed.a : null;
    } catch {
        return null;
    }
}
