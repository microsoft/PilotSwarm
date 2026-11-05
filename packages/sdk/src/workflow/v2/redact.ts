import { canonicalJson, jsonbSafeText, type JsonValue } from "./json.js";

/**
 * The one secret-safe projection of workflow error text (adversarial review SF-6), used wherever such text is persisted
 * or shown: workflow events' error fields, a node's, an outbox item's and a run's stored error as they are read, tool
 * refusals and the REST and MCP errors of the workflow adapters, and so the parent's notification of a run's end.
 * Truncation is not redaction: this hides
 * - a URL's user and password (scheme://user:password@host -> scheme://<hidden>@host);
 * - the value of an Authorization header or field, whole, after its scheme word (E2-R2): any characters, any length,
 *   to the end of the line or the closing quote;
 * - elsewhere, a Bearer token of 8 or more characters, or a Basic credential of 8 or more base64 characters, whatever
 *   their mix (E2-R2; "a basic idea" is left alone, "basic validation" is not);
 * - the value of a password, token, secret, key, signature, credential, authorization or cookie, written key=value,
 *   key: value (a connection string, a query string, a header) or as a JSON field ("token": "...");
 * - a credential that a clip cut short (text clipped before it is redacted ends in "…", jsonbSafeText; verification
 *   E2bH-T5): a ****** or a Basic credential of any length, a URL's user and password before the cut, of any
 *   length (R3-SF-2; a host and a port of digits only cut right after the port reads the same, and is hidden too:
 *   privacy wins, S6-SF2), and the value of a JSON field named for a secret whose closing quote the cut removed, to the
 *   end of the text (S6-SF2).
 * It never adds or removes anything else, so a message without secrets is unchanged. Pure.
 *
 * Text is redacted whole before it is clipped (redactThenClip, redactErrorThenClip; R3-SF-2), so a cut never keeps part of
 * a secret; the clipped-credential rules are for text that was clipped before (rows and events stored earlier).
 */

// Bounded on both sides, so a long run of word characters costs linear time (no catastrophic backtracking).
const SECRET_NAME = "[A-Za-z0-9_]{0,40}(?:password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|account[_-]?key|"
    + "client[_-]?secret|authorization|signature|credentials?|cookie)[A-Za-z0-9_-]{0,40}|sig|key|pass";
const URL_USERINFO = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@'"<>]+@/gi;
// A URL whose user and password a clip cut off before the "@" (E2bH-T5): everything after the scheme, up to the cut, of
// any length (R3-SF-2). A host and a port of digits only, cut right after the port, cannot be told from a user and a
// password of digits, so it is hidden too (S6-SF2 reverts R3-SF-4's exemption: privacy wins). The user part has no ":"
// and neither part a "…", so an attempt never backtracks into the part before it, and it costs linear time.
const URL_USERINFO_CUT = /\b([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@'"<>…:]*:[^\s/@'"<>…]*…/gi;
// An Authorization header or field written key: value or key=value (E2-R2; any letter case): the whole value.
const AUTHORIZATION = /\b([A-Za-z0-9_-]{0,40}authorization[A-Za-z0-9_-]{0,40})(\s*[=:]\s*)("(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[^\r\n]*)/gi;
// Outside one, any letter case (SF-6 verification): a token of 8 or more characters, whatever its mix (E2-R2), or a
// shorter one that a clip cut (followed by its "…", which stays; E2bH-T5).
const BEARER = /\b(Bearer)\s+(?:[^\s"'<>\\]{8,}|[^\s"'<>\\…]{1,7}(?=…))/gi;
const BASIC = /\b(Basic)\s+(?:[A-Za-z0-9+/=_-]{8,}|[A-Za-z0-9+/=_-]{1,7}(?=…))/gi;
const JSON_FIELD = new RegExp(`"(${SECRET_NAME})"(\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "gi");
const ESCAPED_JSON_FIELD = new RegExp(`\\\\"(${SECRET_NAME})\\\\"(\\s*:\\s*)\\\\"(?:[^"\\\\]|\\\\[^"])*\\\\"`, "gi");
// The same fields with no closing quote before the end of the text: a clip cut the value (S6-SF2), so it is hidden to the
// end. Applied after the fields above, which hide every whole value; each character class is disjoint from the escape
// that follows it, so an attempt costs linear time.
const JSON_FIELD_CUT = new RegExp(`"(${SECRET_NAME})"(\\s*:\\s*)"(?:[^"\\\\]|\\\\[\\s\\S])*\\\\?$`, "i");
const ESCAPED_JSON_FIELD_CUT = new RegExp(`\\\\"(${SECRET_NAME})\\\\"(\\s*:\\s*)\\\\"(?:[^"\\\\]|\\\\[^"])*\\\\?$`, "i");
// Not a value already hidden after its scheme word ("Authorization: Bearer <hidden>").
const KEY_VALUE = new RegExp(`\\b(${SECRET_NAME})(\\s*[=:]\\s*)(?!["']?(?:[A-Za-z][A-Za-z0-9._-]{0,30}\\s+)?<hidden>)(?:"[^"]*"|'[^']*'|[^\\s,;&'"<>)\\]}]+)`, "gi");

/** An Authorization value with everything after its scheme word hidden; an empty value is left as it is. */
function hideAuthorization(match: string, name: string, separator: string, value: string): string {
    const quote = value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0]) ? value[0] : "";
    const inner = quote ? value.slice(1, -1) : value;
    if (inner.trim() === "") return match;
    const scheme = /^([A-Za-z][A-Za-z0-9._-]{0,30})\s+\S/.exec(inner);
    return `${name}${separator}${quote}${scheme ? `${scheme[1]} ` : ""}<hidden>${quote}`;
}

/** `text` with its secrets hidden (see the module's comment). */
export function redactWorkflowSecrets(text: string): string {
    if (typeof text !== "string" || text === "") return text;
    return text
        .replace(URL_USERINFO, "$1<hidden>@")
        .replace(URL_USERINFO_CUT, "$1<hidden>…")
        .replace(AUTHORIZATION, hideAuthorization)
        .replace(BEARER, "$1 <hidden>")
        .replace(BASIC, "$1 <hidden>")
        .replace(ESCAPED_JSON_FIELD, "\\\"$1\\\"$2\\\"<hidden>\\\"")
        .replace(JSON_FIELD, "\"$1\"$2\"<hidden>\"")
        .replace(ESCAPED_JSON_FIELD_CUT, (match, name: string, separator: string) => `\\"${name}\\"${separator}\\"<hidden>${match.endsWith("…") ? "…" : ""}`)
        .replace(JSON_FIELD_CUT, (match, name: string, separator: string) => `"${name}"${separator}"<hidden>${match.endsWith("…") ? "…" : ""}`)
        .replace(KEY_VALUE, (match, name: string, separator: string) => (/<hidden>["']?$/.test(match) ? match : `${name}${separator}<hidden>`));
}

const SECRET_NAME_EXACT = new RegExp(`^(?:${SECRET_NAME})$`, "i");

/** `text` with its secrets hidden, then cut to `max` characters (jsonbSafeText): no part of a secret survives the cut (R3-SF-2). */
export function redactThenClip(text: string, max: number): string {
    return jsonbSafeText(redactWorkflowSecrets(text), max);
}

/** Error text (JSON or not; redactWorkflowErrorText) with its secrets hidden, then cut to `max` characters (R3-SF-2). */
export function redactErrorThenClip(text: string, max: number): string {
    return jsonbSafeText(redactWorkflowErrorText(text, canonicalJson), max);
}

/**
 * How an error is redacted. `keepKey`: its details' `key` member names a workflow variable (see below). `parallelReport`:
 * the caller vouches that the error is a parallel state's own report, written by the controller's parallel decision
 * (store.settleParallelIn, for decideParallelJoin and elapseParallelNode) on a node of type parallel; only then are its
 * finished branches' business outputs kept (R3-SF-3). The shape alone never decides it (S6-SF2): an author's mocked
 * error of the same shape is an ordinary error.
 */
export interface WorkflowErrorRedaction {
    keepKey?: boolean;
    parallelReport?: boolean;
}

/**
 * The error codes whose structured details name a workflow variable in a member called `key` (a KV key, not a secret).
 * Elsewhere a member called `key` is hidden like any other secret-named member (SF-6 verification).
 */
const KEY_SAFE_CODES: ReadonlySet<string> = new Set(["KV_LIMIT", "KV_KEY_NOT_FOUND", "KV_KEY_INVALID", "KV_CONFLICT"]);

/**
 * An error value (text, or a JSON error with its code, message and details) with every secret hidden; null stays null.
 * A member named for a secret is hidden whole when it holds text, a list or an object (E2 verification: a list of
 * tokens too); a number or a flag stays. A member named `key` is kept only in an error whose code says it names a
 * workflow variable: `keepKey`, or the code of the error itself, at the top (nested details cannot label themselves).
 * A parallel state's timed_out report keeps its branches' business outputs only when `parallelReport` vouches for it.
 */
export function redactWorkflowErrorValue<T extends JsonValue | null | undefined>(value: T, options: WorkflowErrorRedaction = {}): T {
    const own = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as { [key: string]: JsonValue }).code : undefined;
    const keepKey = options.keepKey === true || (typeof own === "string" && KEY_SAFE_CODES.has(own));
    if (options.parallelReport === true && isParallelTimeoutReport(value)) return redactParallelTimeoutReport(value, keepKey) as T;
    return redactValue(value, keepKey) as T;
}

type JsonRecord = { [key: string]: JsonValue };
const isRecord = (value: unknown): value is JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * A parallel state's timed_out error (parallelTimeoutResult): its report (details: not joined, by the time limit, with
 * every branch) carries the finished branches' business outputs, which are kept exactly as the blocked report keeps
 * them (R3-SF-3); its envelope, its other details and each branch's error have their secrets hidden as in any error.
 * Applied only where the caller vouches for the error's origin (WorkflowErrorRedaction.parallelReport).
 */
function isParallelTimeoutReport(value: unknown): value is JsonRecord & { details: JsonRecord & { branches: JsonValue[] } } {
    return isRecord(value) && value.code === "timed_out" && isRecord(value.details) && value.details.joined === false
        && value.details.timedOut === true && Array.isArray(value.details.branches);
}

function redactParallelTimeoutReport(value: JsonRecord, keepKey: boolean): JsonRecord {
    // Member by member, in their order, so a report without secrets is unchanged (and its stored text kept as written).
    const branch = (item: JsonValue): JsonValue => (isRecord(item)
        ? Object.fromEntries(Object.entries(item).map(([key, member]): [string, JsonValue] => [key, key === "output" ? member : redactMember(key, member, keepKey)]))
        : redactValue(item, keepKey) as JsonValue);
    const details = (item: JsonRecord): JsonRecord => Object.fromEntries(Object.entries(item).map(([key, member]): [string, JsonValue] => [key,
        key === "branches" && Array.isArray(member) ? member.map(branch) : redactMember(key, member, keepKey)]));
    return Object.fromEntries(Object.entries(value).map(([key, member]): [string, JsonValue] => [key,
        key === "details" && isRecord(member) ? details(member) : redactMember(key, member, keepKey)]));
}

/** One member of an error object: hidden whole when named for a secret (text, a list or an object), else redacted within. */
function redactMember(key: string, item: JsonValue, keepKey: boolean): JsonValue {
    return (item !== null && typeof item === "object") || typeof item === "string"
        ? (SECRET_NAME_EXACT.test(key) && !(key === "key" && keepKey) ? "<hidden>" : redactValue(item, keepKey) as JsonValue)
        : item;
}

function redactValue(value: JsonValue | null | undefined, keepKey: boolean): JsonValue | null | undefined {
    if (typeof value === "string") return redactWorkflowSecrets(value);
    if (Array.isArray(value)) return value.map(item => redactValue(item, keepKey) as JsonValue);
    if (value && typeof value === "object") {
        // Object.fromEntries defines each member as its own, so a JSON member named __proto__ stays one (VR-5).
        return Object.fromEntries(Object.entries(value).map(([key, item]): [string, JsonValue] => [key, redactMember(key, item, keepKey)]));
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
 * `options` as redactWorkflowErrorValue's (only the controller's parallel decision vouches for its report).
 */
export function redactWorkflowErrorText(text: string, canonical: (value: JsonValue) => string, options: WorkflowErrorRedaction = {}): string {
    let parsed: JsonValue;
    try { parsed = JSON.parse(text) as JsonValue; } catch { return redactWorkflowSecrets(text); }
    const redacted = redactWorkflowErrorValue(parsed, options);
    return JSON.stringify(redacted) === JSON.stringify(parsed) ? text : canonical(redacted);
}

/** The fields of a workflow event that carry error text. */
const ERROR_FIELDS: ReadonlySet<string> = new Set(["error", "cause", "message", "reason", "stderrTail", "errorText", "failure", "terminalError", "lastError"]);

/** A workflow event's data with the secrets in its error fields hidden, at any depth; every other field as it was. */
export function redactWorkflowEventData<T extends JsonValue>(data: T): T {
    if (Array.isArray(data)) return data.map(item => redactWorkflowEventData(item)) as T;
    if (!data || typeof data !== "object") return data;
    // As above: a member named __proto__ stays an own member (VR-5).
    return Object.fromEntries(Object.entries(data).map(([key, item]) => [key,
        ERROR_FIELDS.has(key) ? redactWorkflowErrorValue(item as JsonValue) : redactWorkflowEventData(item as JsonValue)])) as T;
}
