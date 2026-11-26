// Claude keep-warm pings in the session stats pane. The controller reads the newest session.keepwarm_ping events of a
// session; these helpers reduce them to a small summary and turn that summary into the two Tokens-card rows.

/** The most ping events one stats load reads, and so the most the summary can count. */
export const KEEPWARM_STATS_EVENT_LIMIT = 1000;

/**
 * Reduces session.keepwarm_ping events to { pings, failed, nanoAiu, reported, truncated }.
 * pings are the rows with ok true, failed the other rows, nanoAiu the sum of the finite totalNanoAiu values,
 * reported how many rows carried one, and truncated whether the read hit its limit (older pings may exist).
 * Anything that is not an array is unavailable (null).
 */
export function summarizeKeepWarmPings(events) {
    if (!Array.isArray(events)) return null;
    const summary = { pings: 0, failed: 0, nanoAiu: 0, reported: 0, truncated: events.length === KEEPWARM_STATS_EVENT_LIMIT };
    for (const event of events) {
        const data = event?.data && typeof event.data === "object" ? event.data : {};
        if (data.ok === true) summary.pings += 1;
        else summary.failed += 1;
        const nano = data.totalNanoAiu;
        if (typeof nano === "number" && Number.isFinite(nano)) {
            summary.nanoAiu += nano;
            summary.reported += 1;
        }
    }
    return summary;
}

/** AIU with four decimals from nano-AIU, rounded to ten-thousandths of an AIU. */
function formatAiu(nanoAiu) {
    const tenThousandths = Math.round(nanoAiu / 1e5);
    return `${Math.floor(tenThousandths / 1e4)}.${String(tenThousandths % 1e4).padStart(4, "0")} AIU`;
}

/**
 * The "Keep-warm Pings" and "Keep-warm Cost" rows for the Tokens card; none when the summary is unavailable or has no
 * ping. Past the read limit the count and the cost say they cover the newest pings only.
 */
export function keepWarmStatsRows(keepWarm) {
    if (!keepWarm) return [];
    const rows = keepWarm.pings + keepWarm.failed;
    if (!(rows > 0)) return [];
    const truncated = keepWarm.truncated === true;
    const count = `${keepWarm.pings}${truncated ? "+" : ""}${keepWarm.failed > 0 ? ` (${keepWarm.failed} failed)` : ""}`;
    let cost = "not reported";
    if (keepWarm.reported > 0) {
        cost = `${truncated ? "≥ " : ""}${formatAiu(keepWarm.nanoAiu)}${keepWarm.reported < rows ? " (partial)" : ""}${truncated ? ` (newest ${KEEPWARM_STATS_EVENT_LIMIT.toLocaleString("en-US")})` : ""}`;
    }
    return [["Keep-warm Pings", count], ["Keep-warm Cost", cost]];
}
