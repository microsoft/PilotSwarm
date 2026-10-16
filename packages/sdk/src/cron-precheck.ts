/**
 * Cron prechecks: application code that decides, before a scheduled `cron`
 * wake-up reaches the model, whether the wake-up has any work to do.
 *
 * A recurring agent that only polls ("is there a job? no, sleep") pays for a
 * full model turn on every empty cycle. The application registers named
 * prechecks on the worker (`PilotSwarmWorker.registerCronPrechecks`). A
 * schedule opts in by name: the agent calls
 * `cron(seconds, reason, precheck="<name>")`, or the session was created with
 * a default `cronPrecheck`. When that schedule fires, the precheck runs in an
 * activity and answers `run` or `skip`. The model never sees a skipped cycle:
 * the orchestration records the decision and re-arms the same schedule.
 *
 * A schedule without a precheck behaves exactly as before.
 *
 * Fail open: an unregistered name, a thrown or timed-out handler, or an
 * invalid answer all run the normal model turn. A registration with
 * `shadow: true` records its decisions but never skips.
 */

export const CRON_PRECHECK_DEFAULT_TIMEOUT_MS = 10_000;
export const CRON_PRECHECK_MAX_TIMEOUT_MS = 60_000;
export const CRON_PRECHECK_NAME_MAX_CHARS = 100;
const CRON_PRECHECK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const CRON_PRECHECK_DETAIL_MAX_CHARS = 500;

/** What a precheck handler is told about the wake-up. Serializable values only. */
export interface CronPrecheckContext {
    sessionId: string;
    /** The cron schedule's reason, exactly as the agent set it. */
    reason: string;
    intervalSeconds: number;
    /** Cycles this precheck skipped in a row since the schedule's last model turn. */
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
    /** The name a schedule or session refers to. Letters, digits, `.`, `_`, `:`, `-`. */
    name: string;
    /**
     * Record decisions without skipping, to compare them with the turns that
     * ran before relying on the precheck. Default false.
     */
    shadow?: boolean;
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
    precheck: string;
    reason: string;
    intervalSeconds: number;
    consecutiveSkips?: number;
}

export type CronPrecheckOutcome =
    | "run"
    | "skip"
    | "unregistered"
    | "max_skips"
    | "error"
    | "timeout"
    | "invalid";

/** Activity result. The orchestration skips the model turn only when `skip` is true. */
export interface CronPrecheckResult {
    skip: boolean;
    outcome: CronPrecheckOutcome;
    precheck: string;
    shadow?: boolean;
}

/** A precheck name, trimmed, or null when it is not a valid name. */
export function normalizeCronPrecheckName(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const name = value.trim();
    return name && name.length <= CRON_PRECHECK_NAME_MAX_CHARS && CRON_PRECHECK_NAME_PATTERN.test(name) ? name : null;
}

export function validateCronPrecheckRegistration(registration: CronPrecheckRegistration): CronPrecheckRegistration {
    if (!registration || typeof registration !== "object") throw new TypeError("Cron precheck registration must be an object");
    const name = normalizeCronPrecheckName(registration.name);
    if (!name) {
        throw new TypeError(`Cron precheck name must be 1-${CRON_PRECHECK_NAME_MAX_CHARS} characters of letters, digits, '.', '_', ':' or '-'`);
    }
    if (typeof registration.check !== "function") throw new TypeError(`Cron precheck "${name}" requires a check function`);
    if (registration.shadow !== undefined && typeof registration.shadow !== "boolean") {
        throw new TypeError(`Cron precheck "${name}" shadow must be a boolean`);
    }
    if (registration.timeoutMs !== undefined
        && (!Number.isInteger(registration.timeoutMs) || registration.timeoutMs < 1 || registration.timeoutMs > CRON_PRECHECK_MAX_TIMEOUT_MS)) {
        throw new TypeError(`Cron precheck "${name}" timeoutMs must be an integer from 1 to ${CRON_PRECHECK_MAX_TIMEOUT_MS}`);
    }
    if (registration.maxConsecutiveSkips !== undefined
        && (!Number.isInteger(registration.maxConsecutiveSkips) || registration.maxConsecutiveSkips < 1)) {
        throw new TypeError(`Cron precheck "${name}" maxConsecutiveSkips must be a positive integer`);
    }
    return { ...registration, name };
}

export interface CronPrecheckEvaluation {
    result: CronPrecheckResult;
    /** Payload of the `session.cron_precheck` event. */
    event: Record<string, unknown>;
}

/**
 * Evaluate the named precheck for one cron wake-up. Never throws: every
 * failure becomes a recorded `run`.
 */
export async function evaluateCronPrecheck(params: {
    registrations: readonly CronPrecheckRegistration[];
    input: CronPrecheckInput;
    now?: () => number;
}): Promise<CronPrecheckEvaluation> {
    const { registrations, input } = params;
    const now = params.now ?? Date.now;
    const name = String(input.precheck ?? "");
    const consecutiveSkips = Number.isInteger(input.consecutiveSkips) && input.consecutiveSkips! > 0 ? input.consecutiveSkips! : 0;
    const registration = registrations.find((entry) => entry.name === name);
    if (!registration) {
        return {
            result: { skip: false, outcome: "unregistered", precheck: name },
            event: { precheck: name, outcome: "unregistered", skipped: false, consecutiveSkips, durationMs: 0 },
        };
    }

    const shadow = registration.shadow === true;
    const base = { precheck: name, shadow, consecutiveSkips };

    if (registration.maxConsecutiveSkips !== undefined && consecutiveSkips >= registration.maxConsecutiveSkips) {
        return {
            result: { skip: false, outcome: "max_skips", precheck: name, shadow },
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

    const skipped = outcome === "skip" && !shadow;
    return {
        result: { skip: skipped, outcome, precheck: name, shadow },
        event: {
            ...base,
            outcome,
            skipped,
            durationMs: Math.max(0, now() - startedAt),
            ...(detail ? { detail } : {}),
        },
    };
}
