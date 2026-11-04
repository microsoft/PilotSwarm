import { WorkflowStoreError } from "./store.js";

/**
 * A workflow read or command that failed, as one coded error with a message that is safe to show (batch 7, n-3): never a
 * bare "Tool execution failed". A refusal (a WorkflowStoreError) keeps its own code. A store that cannot be reached or
 * has no room now (PostgreSQL's connection and resource errors, a socket that failed, a pool that timed out) is
 * WORKFLOW_STORE_UNAVAILABLE with its message; anything else is WORKFLOW_ERROR with its message. Messages are sanitized:
 * a URL (a connection string with its password) and a password, token, secret or key value are hidden, whitespace is
 * collapsed, and the text is at most 500 characters.
 */

/** SQLSTATEs of a server that refuses or drops the connection, or has no room for it (classes 08, 53 and 57P). */
const UNAVAILABLE_SQLSTATES: ReadonlySet<string> = new Set([
    "08000", "08001", "08003", "08004", "08006", "08P01", "53000", "53100", "53200", "53300", "53400", "57P01", "57P02", "57P03",
]);
/** Socket and lookup errors of a connection that could not be made or was lost. */
const UNAVAILABLE_ERRNOS: ReadonlySet<string> = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH", "ENETUNREACH"]);
const UNAVAILABLE_TEXT = /too many connections|remaining connection slots|connection terminated|timeout exceeded when trying to connect|could not connect|connection refused|cannot connect now|the database system is (starting|shutting) down|pool (is )?(closed|ended|draining)/i;
const MESSAGE_MAX = 500;

/** A message that is safe to show: no URL, no secret value, one line, bounded. */
export function sanitizeWorkflowErrorText(value: unknown): string {
    const raw = value instanceof Error ? value.message : typeof value === "string" ? value : String(value);
    const clean = raw
        .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/gi, "<url>")
        .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|sig|signature)\s*[=:]\s*[^\s,;&'"]+/gi, "$1=<hidden>")
        .replace(/\s+/g, " ")
        .trim();
    return clean.length > MESSAGE_MAX ? `${clean.slice(0, MESSAGE_MAX - 1)}…` : clean;
}

/** Whether an error means the workflow store cannot be reached or has no room now. */
export function workflowStoreUnavailable(error: unknown): boolean {
    if (error instanceof WorkflowStoreError) return error.code === "WORKFLOW_STORE_UNAVAILABLE";
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string" && (UNAVAILABLE_SQLSTATES.has(code) || UNAVAILABLE_ERRNOS.has(code))) return true;
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    return UNAVAILABLE_TEXT.test(message);
}

/** The coded failure for any error a workflow read or command met. */
export function workflowStoreFailure(error: unknown): WorkflowStoreError {
    if (error instanceof WorkflowStoreError) return error;
    const message = sanitizeWorkflowErrorText(error) || "No reason was given.";
    if (workflowStoreUnavailable(error)) {
        return new WorkflowStoreError("WORKFLOW_STORE_UNAVAILABLE", `The workflow store is not available right now: ${message}`);
    }
    return new WorkflowStoreError("WORKFLOW_ERROR", message);
}

/**
 * For a management adapter (Web API, MCP): a store that is not available becomes a coded 503 whose message may be shown
 * (expose); any other error is returned as it was, for the adapter's own handling.
 */
export function workflowAdapterFailure(error: unknown): unknown {
    if (!workflowStoreUnavailable(error)) return error;
    const failure = workflowStoreFailure(error);
    return Object.assign(new Error(failure.message), { code: failure.code, status: 503, expose: true });
}
