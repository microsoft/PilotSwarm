/**
 * A short, safe label for a failed Postgres connect, for one log line.
 * Uses only the error code (SQLSTATE, TLS or socket code) or the error
 * name, never the message, so no URL, user or token can leak.
 */
export function pgErrorCode(error) {
    const raw = error?.code || error?.name || "unknown";
    return String(raw).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || "unknown";
}
