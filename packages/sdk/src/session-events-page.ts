/**
 * Pure page-shaping logic for session event paging (issue 148).
 *
 * Deliberately a separate module from `management-client.ts`, which reaches
 * the database and therefore transitively imports the Postgres and Azure
 * credential stack. Importing that stack to exercise arithmetic made the
 * "pure" unit test fail to even load (ERR_MODULE_NOT_FOUND on
 * `@azure/identity`, via `pg-pool-factory.js`). The logic here has no runtime
 * dependency at all: the type imports below are erased at compile time.
 *
 * The management client fetches rows and delegates every decision to these
 * functions.
 */

import type {
    SessionEvent,
    SessionEventPage,
    SessionEventPageMode,
} from "./cms.js";

/**
 * The stored procedures clamp their own limit:
 *   v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 1000), 1000));
 * (`cms_get_session_events` — cms-migrations.ts:7370;
 *  `cms_get_session_events_before` — :7398)
 */
export const SESSION_EVENT_PROVIDER_CLAMP = 1000;

/**
 * Largest page delivered. ONE below the provider clamp, because the extra row
 * is spent proving whether more exist. If a page were allowed to reach the
 * clamp, the clamp would silently remove that probe row and `hasMore` would
 * degrade back into a guess from `count === limit`.
 */
export const SESSION_EVENT_PAGE_MAX = SESSION_EVENT_PROVIDER_CLAMP - 1;

/** Unchanged from the existing MCP default; the adopted decision keeps it at 50. */
export const SESSION_EVENT_PAGE_DEFAULT = 50;

/**
 * Classify by the procedure's OWN rule, not by whether the caller supplied an
 * argument: its guard is `p_after_seq IS NOT NULL AND p_after_seq > 0`, so
 * `afterSeq = 0` falls through to the latest-page branch and is NOT
 * "from the beginning".
 */
export function classifyPageMode(opts: { afterSeq?: number; beforeSeq?: number }): SessionEventPageMode {
    if (opts.beforeSeq !== undefined) return "backward";
    if (opts.afterSeq !== undefined && opts.afterSeq > 0) return "forward";
    return "latest";
}

/** Apply the default, then the probe-headroom cap. Never returns below 1. */
export function resolvePageLimit(requested?: number | null): number {
    const base = requested ?? SESSION_EVENT_PAGE_DEFAULT;
    return Math.max(1, Math.min(base, SESSION_EVENT_PAGE_MAX));
}

/** Rows to request so the eligible-existence probe fits inside the clamp. */
export function probeFetchSize(limitApplied: number): number {
    return limitApplied + 1;
}

/**
 * Shape one page from the rows the procedure returned.
 *
 * Both procedures return ASCENDING by seq, but they select opposite ends of
 * the range, so the surplus probe row sits at a different end per mode.
 * Dropping the wrong end would silently discard a real delivered event:
 *
 *   forward  — selects the OLDEST rows above the cursor; surplus is LAST.
 *   latest   — selects the NEWEST rows overall;          surplus is FIRST.
 *   backward — selects the NEWEST rows below the cursor; surplus is FIRST.
 *
 * Continuation direction follows from where the remaining history lies: ABOVE
 * a forward page, BELOW the other two. A latest page therefore continues
 * BACKWARD — continuing it forward is the latest-page trap and skips every
 * older event.
 */
export function buildSessionEventPage(input: {
    mode: SessionEventPageMode;
    fetched: SessionEvent[];
    limitApplied: number;
    limitRequested: number | null;
}): SessionEventPage {
    const { mode, fetched, limitApplied, limitRequested } = input;

    const hasMore = fetched.length > limitApplied;
    const events = !hasMore
        ? fetched
        : mode === "forward"
            ? fetched.slice(0, limitApplied)
            : fetched.slice(fetched.length - limitApplied);

    const range = events.length > 0
        ? { fromSeq: events[0]!.seq, toSeq: events[events.length - 1]!.seq }
        : null;

    const nextDirection: "forward" | "backward" | null =
        !hasMore || range === null ? null : (mode === "forward" ? "forward" : "backward");

    // Always the last DELIVERED record in the continuation direction, so a
    // fetched-but-undelivered row can never be stepped over.
    const nextCursor = nextDirection === null
        ? null
        : (nextDirection === "forward" ? range!.toSeq : range!.fromSeq);

    return {
        events,
        receipt: {
            mode,
            range,
            limitRequested,
            limitApplied,
            providerClamp: SESSION_EVENT_PROVIDER_CLAMP,
            maxPageSize: SESSION_EVENT_PAGE_MAX,
            hasMore,
            nextCursor,
            nextDirection,
            // One query, one read view. NOT an immutable membership snapshot:
            // a late-committing transaction may still become visible below
            // this page's bound.
            completeness: "read-view",
            truncatedReason: hasMore ? "limit" : null,
        },
    };
}
