/**
 * Cron prechecks: application code that decides, before a scheduled `cron`
 * wake-up reaches the model, whether the wake-up has any work to do.
 *
 * A recurring agent that only polls ("is there a job? no, sleep") pays for a
 * full model turn on every empty cycle. A precheck is registered on the worker
 * (`PilotSwarmWorker.registerCronPrechecks`), runs in an activity when the
 * session's interval cron fires, and answers `run` or `skip`. The model never
 * sees a skipped cycle: the orchestration records the decision and re-arms the
 * same schedule.
 *
 * Rollout is two-staged:
 *   - A registered precheck always runs and its decision is recorded as a
 *     `session.cron_precheck` event (shadow mode).
 *   - The decision is enforced only while the `sessions.cron_precheck_skip`
 *     feature flag is on for the session owner. Off, unresolved or stale
 *     configuration means the model turn runs as before.
 *
 * Fail open: a missing match, a thrown or timed-out handler, or an invalid
 * answer all run the normal model turn.
 */

import type { FeatureFlagCache } from "./feature-flag-cache.js";
import type { FeatureOwner } from "./feature-flags.js";

export const CRON_PRECHECK_SKIP_FEATURE = "sessions.cron_precheck_skip";

export const CRON_PRECHECK_DEFAULT_TIMEOUT_MS = 10_000;
export const CRON_PRECHECK_MAX_TIMEOUT_MS = 60_000;
const CRON_PRECHECK_DETAIL_MAX_CHARS = 500;

/** What a precheck handler is told about the wake-up. Serializable values only. */
export interface CronPrecheckContext {
    sessionId: string;
    /** Agent id recorded in the session catalog, or null. */
    agentId: string | null;
    /** The cron schedule's reason, exactly as the agent set it. */
    reason: string;
    intervalSeconds: number;
    /** Cycles skipped in a row by this precheck since the last model turn of this schedule. */
    consecutiveSkips: number;
    /** Aborted when the handler exceeds its timeout. */
    signal: AbortSignal;
}

export interface CronPrecheckAnswer {
    /** `skip` asks PilotSwarm not to run the model for this cycle. */
    action: "run" | "skip";
    /** Short operator-facing explanation recorded on the event. */
    detail?: string;
}

export interface CronPrecheckRegistration {
    /** Stable name recorded on every decision. */
    name: string;
    /** Agent ids this precheck applies to (exact match, or the unqualified name of a `namespace:agent` id). */
    agents: string[];
    /** Optional exact cron reasons. Omitted: every interval cron of a matching agent. */
    reasons?: string[];
    /** Handler timeout. Defaults to 10s; capped at 60s. A timeout runs the model turn. */
    timeoutMs?: number;
    /**
     * Force a model turn after this many consecutive skips, so an agent that
     * renews a lease or heartbeat in its turn still runs periodically.
     * Omitted: no limit.
     */
    maxConsecutiveSkips?: number;
    check: (context: CronPrecheckContext) => CronPrecheckAnswer | Promise<CronPrecheckAnswer>;
}

/** Activity input; the orchestration sends only serializable schedule facts. */
export interface CronPrecheckInput {
    sessionId: string;
    reason: string;
    intervalSeconds: number;
    consecutiveSkips?: number;
}

export type CronPrecheckOutcome =
    | "unbound"
    | "run"
    | "skip"
    | "max_skips"
    | "error"
    | "timeout"
    | "invalid";

/** Activity result. The orchestration skips the model turn only when `skip` is true. */
export interface CronPrecheckResult {
    skip: boolean;
    outcome: CronPrecheckOutcome;
    precheck?: string;
    enforced?: boolean;
}

export interface CronPrecheckSession {
    agentId: string | null;
    owner?: { provider?: string | null; subject?: string | null } | null;
}

export function validateCronPrecheckRegistration(registration: CronPrecheckRegistration): CronPrecheckRegistration {
    if (!registration || typeof registration !== "object") throw new TypeError("Cron precheck registration must be an object");
    const name = typeof registration.name === "string" ? registration.name.trim() : "";
    if (!name) throw new TypeError("Cron precheck registration requires a name");
    if (!Array.isArray(registration.agents) || registration.agents.length === 0
        || registration.agents.some((agent) => typeof agent !== "string" || !agent.trim())) {
        throw new TypeError(`Cron precheck "${name}" requires at least one agent id`);
    }
    if (registration.reasons !== undefined && (!Array.isArray(registration.reasons)
        || registration.reasons.some((reason) => typeof reason !== "string" || !reason))) {
        throw new TypeError(`Cron precheck "${name}" reasons must be non-empty strings`);
    }
    if (typeof registration.check !== "function") throw new TypeError(`Cron precheck "${name}" requires a check function`);
    if (registration.timeoutMs !== undefined
        && (!Number.isInteger(registration.timeoutMs) || registration.timeoutMs < 1 || registration.timeoutMs > CRON_PRECHECK_MAX_TIMEOUT_MS)) {
        throw new TypeError(`Cron precheck "${name}" timeoutMs must be an integer from 1 to ${CRON_PRECHECK_MAX_TIMEOUT_MS}`);
    }
    if (registration.maxConsecutiveSkips !== undefined
        && (!Number.isInteger(registration.maxConsecutiveSkips) || registration.maxConsecutiveSkips < 1)) {
        throw new TypeError(`Cron precheck "${name}" maxConsecutiveSkips must be a positive integer`);
    }
    return {
        ...registration,
        name,
        agents: registration.agents.map((agent) => agent.trim()),
        ...(registration.reasons ? { reasons: [...registration.reasons] } : {}),
    };
}

function agentMatches(registered: string, agentId: string): boolean {
    if (registered === agentId) return true;
    const segments = agentId.split(":");
    return segments.length === 2 && segments[1] === registered;
}

/** The first registration bound to this agent and reason, in registration order. */
export function findCronPrecheck(
    registrations: readonly CronPrecheckRegistration[],
    agentId: string | null,
    reason: string,
): CronPrecheckRegistration | null {
    if (!agentId) return null;
    return registrations.find((registration) =>
        registration.agents.some((agent) => agentMatches(agent, agentId))
        && (!registration.reasons || registration.reasons.includes(reason))) ?? null;
}

/** Enforcement follows the session owner's feature setting; unresolved means shadow only. */
export function cronPrecheckSkipEnforced(
    cache: Pick<FeatureFlagCache, "resolve"> | null | undefined,
    owner: CronPrecheckSession["owner"],
): boolean {
    if (!cache) return false;
    const featureOwner: FeatureOwner | null = owner?.provider && owner?.subject
        ? { provider: owner.provider, subject: owner.subject }
        : null;
    return cache.resolve(CRON_PRECHECK_SKIP_FEATURE, featureOwner, { fallback: false }).enabled === true;
}

export interface CronPrecheckEvaluation {
    result: CronPrecheckResult;
    /** Event payload to record, or null when no precheck applies. */
    event: Record<string, unknown> | null;
}

/**
 * Evaluate the registered precheck for one cron wake-up. Never throws: every
 * failure becomes a recorded `run`.
 */
export async function evaluateCronPrecheck(params: {
    registrations: readonly CronPrecheckRegistration[];
    input: CronPrecheckInput;
    session: CronPrecheckSession | null;
    featureFlags: Pick<FeatureFlagCache, "resolve"> | null | undefined;
    now?: () => number;
}): Promise<CronPrecheckEvaluation> {
    const { registrations, input, session } = params;
    const now = params.now ?? Date.now;
    if (registrations.length === 0 || !session) return { result: { skip: false, outcome: "unbound" }, event: null };
    const registration = findCronPrecheck(registrations, session.agentId, input.reason);
    if (!registration) return { result: { skip: false, outcome: "unbound" }, event: null };

    const consecutiveSkips = Number.isInteger(input.consecutiveSkips) && input.consecutiveSkips! > 0 ? input.consecutiveSkips! : 0;
    const enforced = cronPrecheckSkipEnforced(params.featureFlags, session.owner);
    const base = { precheck: registration.name, enforced, consecutiveSkips };

    if (registration.maxConsecutiveSkips !== undefined && consecutiveSkips >= registration.maxConsecutiveSkips) {
        return {
            result: { skip: false, outcome: "max_skips", precheck: registration.name, enforced },
            event: { ...base, outcome: "max_skips", skipped: false, durationMs: 0 },
        };
    }

    const timeoutMs = registration.timeoutMs ?? CRON_PRECHECK_DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const startedAt = now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: CronPrecheckOutcome;
    let detail: string | undefined;
    try {
        const answer = await Promise.race([
            Promise.resolve().then(() => registration.check({
                sessionId: input.sessionId,
                agentId: session.agentId,
                reason: input.reason,
                intervalSeconds: input.intervalSeconds,
                consecutiveSkips,
                signal: controller.signal,
            })),
            new Promise<"timeout">((resolve) => {
                timer = setTimeout(() => resolve("timeout"), timeoutMs);
            }),
        ]);
        if (answer === "timeout") {
            controller.abort();
            outcome = "timeout";
        } else if (answer && (answer.action === "run" || answer.action === "skip")) {
            outcome = answer.action;
            if (typeof answer.detail === "string" && answer.detail) detail = answer.detail.slice(0, CRON_PRECHECK_DETAIL_MAX_CHARS);
        } else {
            outcome = "invalid";
        }
    } catch (err) {
        outcome = "error";
        detail = String((err as Error)?.message ?? err).slice(0, CRON_PRECHECK_DETAIL_MAX_CHARS);
    } finally {
        if (timer) clearTimeout(timer);
    }

    const skipped = outcome === "skip" && enforced;
    return {
        result: { skip: skipped, outcome, precheck: registration.name, enforced },
        event: {
            ...base,
            outcome,
            skipped,
            durationMs: Math.max(0, now() - startedAt),
            ...(detail ? { detail } : {}),
        },
    };
}
