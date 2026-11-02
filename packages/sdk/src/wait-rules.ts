/**
 * Wait rules shared by the agent's `wait`, `cron` and `cron_at` tools and
 * the workflow `wait` state.
 *
 * A wait state with `seconds` is the workflow form of the agent `wait`
 * tool; with `at` it follows the `cron_at` clock rules; a loop through a
 * wait state is the workflow form of `cron`. Both sides sleep on the same
 * duroxide timer (`ctx.scheduleTimer`) and compute clock times with the
 * same `computeCronAtNextFire`. This module holds the rest: the limits per
 * surface and "when does this wait end".
 *
 * Pure: no I/O, no clock reads, no durable yields. Callers work out a
 * deadline inside an activity or a tool handler, so a replay reuses the
 * recorded answer.
 *
 * @module
 */
import { computeCronAtNextFire, type CronAtSchedule } from "./cron-at.js";

/** The shortest interval the agent `cron` tool accepts. */
export const AGENT_CRON_MIN_INTERVAL_SECONDS = 15;

/**
 * The shortest `seconds` a workflow wait state may declare, unless
 * PILOTSWARM_WORKFLOW_MIN_WAIT_SECONDS lowers it for development and tests.
 * Every script state after a wait may start a Copilot CLI tool session, so
 * a loop should not spin faster than this.
 */
export const WORKFLOW_WAIT_MIN_SECONDS = 60;

/** The longest `seconds` a workflow wait state may declare: 7 days. */
export const WORKFLOW_WAIT_MAX_SECONDS = 7 * 24 * 60 * 60;

/**
 * The shortest workflow wait: 60 seconds, or a lower whole number of
 * seconds (at least 1) set in PILOTSWARM_WORKFLOW_MIN_WAIT_SECONDS.
 */
export function workflowMinWaitSeconds(env: Record<string, string | undefined> = process.env): number {
    const raw = env.PILOTSWARM_WORKFLOW_MIN_WAIT_SECONDS;
    if (raw === undefined || raw.trim() === "") return WORKFLOW_WAIT_MIN_SECONDS;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 1 ? Math.min(value, WORKFLOW_WAIT_MAX_SECONDS) : WORKFLOW_WAIT_MIN_SECONDS;
}

/** Whether `seconds` is a whole number within a workflow wait's limits. */
export function workflowWaitSecondsAllowed(seconds: unknown, minSeconds: number = WORKFLOW_WAIT_MIN_SECONDS): seconds is number {
    return typeof seconds === "number" && Number.isInteger(seconds) && seconds >= minSeconds && seconds <= WORKFLOW_WAIT_MAX_SECONDS;
}

/** Whether `seconds` is an interval the agent `cron` tool accepts. */
export function agentCronIntervalAllowed(seconds: number): boolean {
    return Number.isFinite(seconds) && seconds >= AGENT_CRON_MIN_INTERVAL_SECONDS;
}

/** The end of a `seconds` wait that starts at `startMs`. */
export function waitDeadlineMs(startMs: number, seconds: number): number {
    return startMs + seconds * 1000;
}

/** A clock time in `cron_at` fields. */
export type WaitClock = Pick<CronAtSchedule, "minute" | "hour" | "dayOfWeek" | "dayOfMonth" | "tz">;

/** When a wait that starts at `afterMs` ends. */
export interface WaitTiming {
    until: number;
    /** For a clock wait: which occurrence it waits for (keeps a DST fall-back hour from firing twice). */
    occurrenceKey?: string;
    /** For a clock wait: the local wall-clock time it ends, with its zone. */
    localTime?: string;
}

/**
 * The end of a wait that starts at `afterMs`: `seconds` later, or the next
 * clock time `at` strictly after it (the `cron_at` rules, DST included).
 */
export function waitUntil(
    wait: { seconds?: number; at?: WaitClock },
    afterMs: number,
    lastOccurrenceKey?: string,
    nextFire: typeof computeCronAtNextFire = computeCronAtNextFire,
): WaitTiming {
    if (!wait.at) return { until: waitDeadlineMs(afterMs, wait.seconds ?? 0) };
    const fire = nextFire(wait.at, afterMs, lastOccurrenceKey);
    return { until: fire.nextFireAtMs, occurrenceKey: fire.occurrenceKey, localTime: fire.localTime };
}
