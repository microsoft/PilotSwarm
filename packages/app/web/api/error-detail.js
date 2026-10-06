/**
 * The body of an error answer, the same on /api/v1 and the legacy /api/rpc:
 * its code and message, plus the fields a client needs to act on a 4xx:
 * `candidates`, `validation`, a workspace file conflict's `etag` (null: the
 * file was deleted) and a too-large file's `size`.
 *
 * A 5xx is an unexpected fault: its raw message can hold connection
 * strings, file paths or stack detail, so it becomes "Internal server
 * error" unless the error says it may be shown (`expose`, set on errors
 * whose message is fixed, such as a workspace timeout).
 */
export function errorDetail(error, status, code) {
    const detail = {
        code,
        message: status >= 500 && error?.expose !== true ? "Internal server error" : (error?.message || String(error)),
    };
    if (status >= 500) return detail;
    if (Array.isArray(error?.candidates)) detail.candidates = error.candidates;
    if (Array.isArray(error?.validation?.errors)) detail.validation = error.validation;
    if (error && Object.prototype.hasOwnProperty.call(error, "etag") && (error.etag === null || typeof error.etag === "string")) detail.etag = error.etag;
    if (Number.isFinite(error?.size)) detail.size = error.size;
    if (typeof error?.reason === "string" && error.reason.length <= 128) detail.reason = error.reason;
    if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0) detail.retryAfterMs = error.retryAfterMs;
    return detail;
}
