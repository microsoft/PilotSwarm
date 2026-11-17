/**
 * The session list's "Terminated" row (Plan 3): every child list of a real session shows its live children and then
 * one virtual row that holds the finished ones. This module is the single source for what "finished" means, for the
 * virtual row's id, and for its words, so the tree, the selectors, the portal and the TUI cannot disagree.
 */

/** A session whose status is one of these has ended: it is listed under its parent's Terminated row. */
export const TERMINAL_SESSION_STATUSES = new Set(["completed", "cancelled", "failed", "error"]);

/** Terminal statuses that count as failures in the row's "· N failed". */
export const FAILED_SESSION_STATUSES = new Set(["failed", "error"]);

export function isTerminalSession(session) {
    return TERMINAL_SESSION_STATUSES.has(session?.status);
}

export function isFailedSession(session) {
    return FAILED_SESSION_STATUSES.has(session?.status);
}

const TERMINATED_ROW_PREFIX = "terminated:";
const GROUP_ROW_PREFIX = "group:";

/** The Terminated row's id under a parent session. */
export function terminatedRowId(parentSessionId) {
    return `${TERMINATED_ROW_PREFIX}${parentSessionId}`;
}

export function isTerminatedRowId(id) {
    return typeof id === "string" && id.startsWith(TERMINATED_ROW_PREFIX) && id.length > TERMINATED_ROW_PREFIX.length;
}

/** The parent session id of a Terminated row id, or null for any other id. */
export function terminatedRowParentId(id) {
    return isTerminatedRowId(id) ? id.slice(TERMINATED_ROW_PREFIX.length) : null;
}

/**
 * A list row that is not a session: a folder (`group:<id>`) or a Terminated row (`terminated:<parentSessionId>`).
 * Such an id must never reach a per-session API, the chat, pins, manual order or a multi-selection.
 */
export function isVirtualSessionRowId(id) {
    return isTerminatedRowId(id) || (typeof id === "string" && id.startsWith(GROUP_ROW_PREFIX));
}

export const TERMINATED_ROW_LABEL = "Terminated";

const countFormat = new Intl.NumberFormat("en-US");

/**
 * The Terminated row's words: `Terminated 8`, and `· 1 failed` when any member failed.
 * Returns { label, failed (null when none), text }.
 */
export function terminatedRowWords({ count = 0, failed = 0 } = {}) {
    const label = `${TERMINATED_ROW_LABEL} ${countFormat.format(count)}`;
    const failedText = failed > 0 ? `${countFormat.format(failed)} failed` : null;
    return { label, failed: failedText, text: failedText ? `${label} · ${failedText}` : label };
}
