import { createHash } from "node:crypto";

/**
 * Canonical JSON for workflow values.
 *
 * Workflow inputs, KV values, node outputs and receipts are stored as
 * canonical JSON TEXT, never as JSONB: PostgreSQL JSONB rejects strings that
 * contain `\u0000` or lone surrogates, which are valid JavaScript/JSON
 * string values. The canonical text escapes both (ES2019 well-formed
 * JSON.stringify), sorts object keys by UTF-16 code unit order and is the
 * byte string every hash covers.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const WORKFLOW_JSON_MAX_DEPTH = 64;
/** Default cap for one payload (D07). */
export const WORKFLOW_PAYLOAD_MAX_BYTES = 256 * 1024;

export class WorkflowJsonError extends Error {
    readonly code = "WORKFLOW_JSON_INVALID";
    constructor(message: string, readonly path: string) {
        super(`${path}: ${message}`);
        this.name = "WorkflowJsonError";
    }
}

function isPlainObject(value: object): boolean {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/** Throw unless `value` is plain JSON data: null, boolean, finite number, string, array or plain object. */
export function assertJsonValue(value: unknown, path = "$", depth = 0): asserts value is JsonValue {
    if (depth > WORKFLOW_JSON_MAX_DEPTH) throw new WorkflowJsonError(`nesting exceeds ${WORKFLOW_JSON_MAX_DEPTH} levels`, path);
    if (value === null || typeof value === "boolean" || typeof value === "string") return;
    if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new WorkflowJsonError("numbers must be finite", path);
        return;
    }
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index += 1) {
            if (!(index in value)) throw new WorkflowJsonError("sparse arrays are not JSON", `${path}[${index}]`);
            assertJsonValue(value[index], `${path}[${index}]`, depth + 1);
        }
        return;
    }
    if (typeof value === "object" && value !== null && isPlainObject(value)) {
        for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`, depth + 1);
        return;
    }
    throw new WorkflowJsonError(`${value === undefined ? "undefined" : typeof value} is not a JSON value`, path);
}

/** A plain (not class-instance) object. Its values are checked separately by assertJsonValue. */
export function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value) && isPlainObject(value);
}

function encode(value: JsonValue): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(encode).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${encode(value[key])}`).join(",")}}`;
}

/** Canonical text of a JSON value. Validates the value first. */
export function canonicalJson(value: unknown): string {
    assertJsonValue(value);
    return encode(value);
}

/** Parse stored canonical text back into the exact value. */
export function parseStoredJson(text: string, path = "$"): JsonValue {
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch (error) {
        throw new WorkflowJsonError(`stored JSON does not parse: ${error instanceof Error ? error.message : String(error)}`, path);
    }
    assertJsonValue(parsed, path);
    return parsed;
}

export function utf8ByteLength(text: string): number {
    return Buffer.byteLength(text, "utf8");
}

export function sha256Hex(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256 of the canonical text of a value. */
export function jsonSha256(value: unknown): string {
    return sha256Hex(canonicalJson(value));
}

/**
 * sha256 of the canonical text of `{kind, value}`, built from the value's
 * canonical text (`valueText`, already validated): the same bytes as
 * jsonSha256({kind, value}), but the envelope adds no nesting level, so a
 * value at the full WORKFLOW_JSON_MAX_DEPTH keeps its identity.
 */
export function kindValueSha256(kind: string, valueText: string): string {
    return sha256Hex(`{"kind":${JSON.stringify(kind)},"value":${valueText}}`);
}

/** Canonical text bounded by `maxBytes`; the error names what was too large. */
export function boundedCanonicalJson(value: unknown, what: string, maxBytes = WORKFLOW_PAYLOAD_MAX_BYTES): string {
    const text = canonicalJson(value);
    const bytes = utf8ByteLength(text);
    if (bytes > maxBytes) {
        throw new WorkflowJsonError(`${what} is ${bytes} bytes; the limit is ${maxBytes}. Store large data as an artifact and pass its reference`, "$");
    }
    return text;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** True when the string is well-formed UTF-16 (no lone surrogates) and has no NUL character. */
export function isStorableText(text: string): boolean {
    return !LONE_SURROGATE.test(text) && !text.includes("\u0000");
}

/**
 * Text that PostgreSQL JSONB and TEXT accept: NUL and lone surrogates become
 * U+FFFD, and truncation never splits a surrogate pair. For display and
 * telemetry only; authoritative values stay canonical JSON.
 */
export function jsonbSafeText(text: string, maxChars?: number): string {
    let out = text.replace(/\u0000/g, "\uFFFD").replace(LONE_SURROGATES, "\uFFFD");
    if (maxChars !== undefined && out.length > maxChars) {
        let cut = maxChars;
        const last = out.charCodeAt(cut - 1);
        if (last >= 0xD800 && last <= 0xDBFF) cut -= 1;
        out = `${out.slice(0, cut)}…`;
    }
    return out;
}

/** A JSON value whose strings and keys are all JSONB-safe (see jsonbSafeText). */
export function jsonbSafeValue(value: JsonValue): JsonValue {
    if (typeof value === "string") return jsonbSafeText(value);
    if (Array.isArray(value)) return value.map(jsonbSafeValue);
    if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [jsonbSafeText(key), jsonbSafeValue(item)]));
    }
    return value;
}

/** A bounded, JSONB-safe preview of a value for events and views. */
export function previewJson(value: JsonValue, maxChars = 1_000): string {
    return jsonbSafeText(canonicalJson(value), maxChars);
}
