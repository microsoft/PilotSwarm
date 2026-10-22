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

/**
 * Apply the default, then the probe-headroom cap.
 *
 * A non-integer limit is REJECTED rather than coerced. The stored procedure
 * takes an INT, so 1.5 would silently become something else on the way down;
 * a caller that asked for a fractional page has made a mistake and should be
 * told, not quietly given a different page than it requested.
 */
export function resolvePageLimit(requested?: number | null): number {
    if (requested === undefined || requested === null) return SESSION_EVENT_PAGE_DEFAULT;
    if (!Number.isSafeInteger(requested)) {
        throw new Error(`limit must be a safe integer, received ${String(requested)}`);
    }
    return Math.max(1, Math.min(requested, SESSION_EVENT_PAGE_MAX));
}

/**
 * Validate a cursor. Sequence numbers are BIGSERIAL values compared against an
 * INT-bounded procedure; a fractional, infinite or unsafe cursor cannot mean
 * anything, so it is refused rather than silently reinterpreted.
 */
export function assertValidCursor(name: string, value: number | undefined): void {
    if (value === undefined) return;
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative safe integer, received ${String(value)}`);
    }
}

/**
 * Post-condition: the returned rows must honour the requested filter.
 *
 * The catalog falls back to an UNFILTERED procedure when the database predates
 * migration 0025 (cms.ts, isUndefinedFunctionError). For the legacy array
 * reads that is a tolerable compatibility shim, but for a paged diagnostic
 * read it would silently BROADEN what the caller receives: they asked to
 * narrow to a few event types and would get the whole stream, with a receipt
 * that mentions nothing. A filter that cannot be applied must fail loudly.
 */
export function assertFilterHonoured(rows: SessionEvent[], eventTypes?: string[]): void {
    if (!Array.isArray(eventTypes) || eventTypes.length === 0) return;
    const allowed = new Set(eventTypes);
    const stray = rows.find((r) => !allowed.has(r.eventType));
    if (stray) {
        throw new Error(
            "event-type filter was not applied by the catalog (event "
            + `${stray.seq} is "${stray.eventType}", which was not requested). `
            + "This database may predate migration 0025; refusing to return a silently broadened page.",
        );
    }
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
