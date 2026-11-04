import type { JsonValue } from "./json.js";

/**
 * The one secret-safe projection of workflow error text (adversarial review SF-6), used wherever such text is persisted
 * or shown: workflow events' error fields, a node's, an outbox item's and a run's stored error as they are read, tool
 * refusals and the REST and MCP errors of the workflow adapters, and so the parent's notification of a run's end.
 * Truncation is not redaction: this hides
 * - a URL's user and password (scheme://user:password@host -> scheme://<hidden>@host);
 * - a Bearer or Basic credential;
 * - the value of a password, token, secret, key, signature, credential, authorization or cookie, written key=value,
 *   key: value (a connection string, a query string, a header) or as a JSON field ("token": "...").
 * It never adds or removes anything else, so a message without secrets is unchanged. Pure.
 */

// Bounded on both sides, so a long run of word characters costs linear time (no catastrophic backtracking).
const SECRET_NAME = "[A-Za-z0-9_]{0,40}(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|account[_-]?key|"
    + "client[_-]?secret|authorization|signature|credentials?|cookie)[A-Za-z0-9_-]{0,40}|sig|key|pass";
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@'"<>]+@/gi;
// Any letter case (SF-6 verification); a credential is 8 or more characters with a digit or a symbol, so prose such
// as "basic validation" is left alone.
const AUTH_SCHEME = /\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]{8})(?=[A-Za-z]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]+/gi;
const JSON_FIELD = new RegExp(`"(${SECRET_NAME})"(\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "gi");
const ESCAPED_JSON_FIELD = new RegExp(`\\\\"(${SECRET_NAME})\\\\"(\\s*:\\s*)\\\\"(?:[^"\\\\]|\\\\[^"])*\\\\"`, "gi");
const KEY_VALUE = new RegExp(`\\b(${SECRET_NAME})(\\s*[=:]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;&'"<>)\\]}]+)`, "gi");

/** `text` with its secrets hidden (see the module's comment). */
export function redactWorkflowSecrets(text: string): string {
    if (typeof text !== "string" || text === "") return text;
    return text
        .replace(URL_USERINFO, "$1<hidden>@")
        .replace(AUTH_SCHEME, "$1 <hidden>")
        .replace(ESCAPED_JSON_FIELD, "\\\"$1\\\"$2\\\"<hidden>\\\"")
        .replace(JSON_FIELD, "\"$1\"$2\"<hidden>\"")
        .replace(KEY_VALUE, (match, name: string, separator: string) => (match.endsWith("<hidden>") ? match : `${name}${separator}<hidden>`));
}

const SECRET_NAME_EXACT = new RegExp(`^(?:${SECRET_NAME})$`, "i");

/**
 * The error codes whose structured details name a workflow variable in a member called `key` (a KV key, not a secret).
 * Elsewhere a member called `key` is hidden like any other secret-named member (SF-6 verification).
 */
const KEY_SAFE_CODES: ReadonlySet<string> = new Set(["KV_LIMIT", "KV_KEY_NOT_FOUND", "KV_KEY_INVALID", "KV_CONFLICT"]);

/**
 * An error value (text, or a JSON error with its code, message and details) with every secret hidden; null stays null.
 * A member named `key` is kept only in an error whose code says it names a workflow variable (`keepKey`, or the
 * envelope's own `code`).
 */
export function redactWorkflowErrorValue<T extends JsonValue | null | undefined>(value: T, options: { keepKey?: boolean } = {}): T {
    if (typeof value === "string") return redactWorkflowSecrets(value) as T;
    if (Array.isArray(value)) return value.map(item => redactWorkflowErrorValue(item, options)) as T;
    if (value && typeof value === "object") {
        const record = value as { [key: string]: JsonValue };
        const keepKey = options.keepKey === true || (typeof record.code === "string" && KEY_SAFE_CODES.has(record.code));
        // Object.fromEntries defines each member as its own, so a JSON member named __proto__ stays one (VR-5).
        return Object.fromEntries(Object.entries(record).map(([key, item]) => [key,
            typeof item === "string" && SECRET_NAME_EXACT.test(key) && !(key === "key" && keepKey) ? "<hidden>"
                : redactWorkflowErrorValue(item, { keepKey })])) as T;
    }
    return value;
}

/** Whether a refusal's code names a workflow variable in its details' `key` member. */
export function workflowErrorKeepsKey(code: string): boolean {
    return KEY_SAFE_CODES.has(code);
}

/**
 * Error text as it is stored (a node's, an outbox message's or a run's error column; SF-6 verification): JSON text has
 * its secrets hidden member by member and is written back as canonical JSON; any other text has them hidden as text.
 */
export function redactWorkflowErrorText(text: string, canonical: (value: JsonValue) => string): string {
    let parsed: JsonValue;
    try { parsed = JSON.parse(text) as JsonValue; } catch { return redactWorkflowSecrets(text); }
    const redacted = redactWorkflowErrorValue(parsed);
    return JSON.stringify(redacted) === JSON.stringify(parsed) ? text : canonical(redacted);
}

/** The fields of a workflow event that carry error text. */
const ERROR_FIELDS: ReadonlySet<string> = new Set(["error", "cause", "message", "reason", "stderrTail", "errorText", "failure", "terminalError"]);

/** A workflow event's data with the secrets in its error fields hidden, at any depth; every other field as it was. */
export function redactWorkflowEventData<T extends JsonValue>(data: T): T {
    if (Array.isArray(data)) return data.map(item => redactWorkflowEventData(item)) as T;
    if (!data || typeof data !== "object") return data;
    // As above: a member named __proto__ stays an own member (VR-5).
    return Object.fromEntries(Object.entries(data).map(([key, item]) => [key,
        ERROR_FIELDS.has(key) ? redactWorkflowErrorValue(item as JsonValue) : redactWorkflowEventData(item as JsonValue)])) as T;
}
