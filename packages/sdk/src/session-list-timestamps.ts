/**
 * CMS timestamps are epoch milliseconds; tolerate ISO timestamps from older
 * adapters, and Date objects: the catalog's rows carry Dates, and the
 * in-session list_sessions reads them as they are. A Date is one instant, so
 * it does not depend on the worker's time zone either.
 */
export function sessionTimestampMillis(value: unknown): number {
    const millis = typeof value === "number"
        ? value
        : value instanceof Date
            ? value.getTime()
        // Require an explicit timezone: durable replay must not depend on the worker's TZ.
        : typeof value === "string" && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
            ? Date.parse(value)
            : NaN;
    return Number.isFinite(millis) ? new Date(millis).getTime() : NaN;
}

/** Never invent a creation/update time for incomplete catalog rows. */
export function formatSessionTimestamp(value: unknown): string {
    const millis = sessionTimestampMillis(value);
    return Number.isFinite(millis) ? new Date(millis).toISOString() : "unknown";
}
