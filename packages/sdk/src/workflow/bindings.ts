import { assertJsonValue, isJsonObject, type JsonValue } from "./json.js";

/**
 * Data bindings: a JSON template in which a string that is exactly one
 * `${path}` or `${path ?? <JSON literal>}` expression is replaced by the
 * value at that path. Nothing is evaluated as code.
 *
 * Roots: `inputs` (static run inputs), `input` (the value arriving at the
 * node: the predecessor's output, or its runtime error envelope on an error
 * route), `kv` (the pinned KV snapshot), `runtime` (`runtime.error`) and,
 * only in a parallel state's body (the compiler refuses it elsewhere),
 * `branch` (`branch.item` and `branch.index` of the branch, and IR 11 `branch.name` of a named branch).
 * Segments: `.name`, `[index]` or `["any key"]` (a JSON string, so any open
 * KV key can be named). The operator `??` and a nested `${` count only
 * outside JSON strings: a quoted key or a string default may contain them.
 */

export const BINDING_ROOTS = ["inputs", "input", "kv", "runtime", "branch"] as const;
export type BindingRoot = typeof BINDING_ROOTS[number];

function isBindingRoot(value: string | undefined): value is BindingRoot {
    return value !== undefined && (BINDING_ROOTS as readonly string[]).includes(value);
}

export interface BindingExpression {
    root: BindingRoot;
    segments: Array<string | number>;
    hasDefault: boolean;
    defaultValue: JsonValue;
}

export interface BindingScope {
    inputs: JsonValue;
    input: JsonValue;
    kv: JsonValue;
    runtime: JsonValue;
    /** A parallel branch's `{ item, index }` (IR 11: and a named branch's `name`); absent (null) outside a branch. */
    branch?: JsonValue;
}

export class WorkflowBindingError extends Error {
    readonly code = "WORKFLOW_BINDING_INVALID";
    constructor(message: string, readonly path: string) {
        super(`${path}: ${message}`);
        this.name = "WorkflowBindingError";
    }
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$-]*/;
const EXACTLY_ONE = "a value that uses ${...} must be exactly one expression";

/**
 * The index of the quote that closes the JSON string whose opening quote is
 * at `start` (a backslash escapes the character after it), or -1 when the
 * string is not closed.
 */
function jsonStringEnd(text: string, start: number): number {
    for (let index = start + 1; index < text.length; index += 1) {
        if (text[index] === "\\") { index += 1; continue; }
        if (text[index] === "\"") return index;
    }
    return -1;
}

/**
 * Where, outside JSON strings, an expression body has its first default
 * operator `??` and its first `${` (-1 when it has none). Only a JSON string
 * holds a quote in a valid body (a `["key"]` segment or a string default),
 * and a key or a default may contain `??`, `${` or `}` as data.
 */
function scanExpressionBody(body: string): { defaultAt: number; nestedAt: number } {
    let defaultAt = -1;
    let nestedAt = -1;
    for (let index = 0; index < body.length; index += 1) {
        const char = body[index];
        if (char === "\"") {
            const end = jsonStringEnd(body, index);
            // An unclosed string: the segment or default parse reports it.
            if (end === -1) break;
            index = end;
            continue;
        }
        if (defaultAt === -1 && char === "?" && body[index + 1] === "?") { defaultAt = index; index += 1; continue; }
        if (nestedAt === -1 && char === "$" && body[index + 1] === "{") nestedAt = index;
    }
    return { defaultAt, nestedAt };
}

/**
 * An expression string as a reader is shown it (adversarial review R3-SF-1): its path as written, and its default
 * literal replaced by `project(default)` (as JSON) when that gives a value; any other string, an expression without a
 * default, or text that does not parse, as it is.
 */
export function bindingWithDefaultShown(text: string, project: (value: JsonValue) => JsonValue | undefined): string {
    let parsed: BindingExpression | null;
    try { parsed = parseBindingExpression(text, "binding"); } catch { return text; }
    if (!parsed?.hasDefault) return text;
    const shown = project(parsed.defaultValue);
    if (shown === undefined) return text;
    const inner = text.trim().slice(2, -1);
    const { defaultAt } = scanExpressionBody(inner);
    return `\${${inner.slice(0, defaultAt).trim()} ?? ${JSON.stringify(shown)}}`;
}

/** Parse `text` when it is an expression string; null for a plain string. */
export function parseBindingExpression(text: string, path: string): BindingExpression | null {
    const trimmed = text.trim();
    if (!(trimmed.startsWith("${") && trimmed.endsWith("}"))) {
        if (text.includes("${")) throw new WorkflowBindingError(EXACTLY_ONE, path);
        return null;
    }
    const inner = trimmed.slice(2, -1);
    const { defaultAt, nestedAt } = scanExpressionBody(inner);
    if (nestedAt !== -1) throw new WorkflowBindingError(EXACTLY_ONE, path);
    const body = (defaultAt === -1 ? inner : inner.slice(0, defaultAt)).trim();
    let hasDefault = false;
    let defaultValue: JsonValue = null;
    if (defaultAt !== -1) {
        const literal = inner.slice(defaultAt + 2).trim();
        let parsed: unknown;
        try { parsed = JSON.parse(literal); }
        catch { throw new WorkflowBindingError(`default '${literal}' must be a JSON literal`, path); }
        assertJsonValue(parsed, path);
        hasDefault = true;
        defaultValue = parsed;
    }
    const root = IDENT.exec(body)?.[0];
    if (!isBindingRoot(root)) {
        throw new WorkflowBindingError(`expression must start with ${BINDING_ROOTS.join(", ")}`, path);
    }
    const segments: Array<string | number> = [];
    let rest = body.slice(root.length);
    while (rest.length > 0) {
        if (rest.startsWith(".")) {
            const ident = IDENT.exec(rest.slice(1));
            if (!ident) throw new WorkflowBindingError(`invalid segment near '${rest}'`, path);
            segments.push(ident[0]);
            rest = rest.slice(1 + ident[0].length);
            continue;
        }
        if (rest.startsWith("[")) {
            // `[index]` or `["key"]`, with optional whitespace inside the brackets.
            const notIndex = `bracket segment must be an index or a JSON string near '${rest}'`;
            let at = 1;
            while (at < rest.length && /\s/.test(rest[at])) at += 1;
            let segment: string | number;
            if (rest[at] === "\"") {
                const end = jsonStringEnd(rest, at);
                if (end === -1) throw new WorkflowBindingError(`unclosed '[' near '${rest}'`, path);
                let key: unknown;
                try { key = JSON.parse(rest.slice(at, end + 1)); }
                catch { throw new WorkflowBindingError(notIndex, path); }
                if (typeof key !== "string") throw new WorkflowBindingError(notIndex, path);
                segment = key;
                at = end + 1;
            } else {
                const digits = /^\d+/.exec(rest.slice(at));
                if (!digits) throw new WorkflowBindingError(notIndex, path);
                segment = Number(digits[0]);
                at += digits[0].length;
            }
            while (at < rest.length && /\s/.test(rest[at])) at += 1;
            if (rest[at] !== "]") throw new WorkflowBindingError(at >= rest.length ? `unclosed '[' near '${rest}'` : notIndex, path);
            segments.push(segment);
            rest = rest.slice(at + 1);
            continue;
        }
        throw new WorkflowBindingError(`unexpected text '${rest}' in expression`, path);
    }
    return { root, segments, hasDefault, defaultValue };
}

/** Validate a template at compile time and return it as JSON. */
export function validateBindingTemplate(template: unknown, path: string): JsonValue {
    if (typeof template === "string") {
        parseBindingExpression(template, path);
        return template;
    }
    if (Array.isArray(template)) return template.map((item, index) => validateBindingTemplate(item, `${path}[${index}]`));
    if (isJsonObject(template)) {
        return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, validateBindingTemplate(value, `${path}.${key}`)]));
    }
    assertJsonValue(template, path);
    return template;
}

function resolvePath(scope: BindingScope, expression: BindingExpression, path: string): JsonValue {
    let current: JsonValue = scope[expression.root] ?? null;
    for (const segment of expression.segments) {
        if (typeof segment === "number") {
            if (Array.isArray(current) && segment < current.length) { current = current[segment]; continue; }
        } else if (isJsonObject(current) && Object.hasOwn(current, segment)) {
            current = current[segment];
            continue;
        }
        if (expression.hasDefault) return expression.defaultValue;
        throw new WorkflowBindingError(`could not resolve '${String(segment)}' of ${expression.root}`, path);
    }
    return current;
}

/** The roots a template's expressions use (a plain value uses none). */
export function bindingRootsOf(template: unknown, path = "$"): Set<BindingRoot> {
    const roots = new Set<BindingRoot>();
    const visit = (value: unknown, at: string): void => {
        if (typeof value === "string") {
            const expression = parseBindingExpression(value, at);
            if (expression) roots.add(expression.root);
        } else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${at}[${index}]`));
        else if (isJsonObject(value)) for (const [key, item] of Object.entries(value)) visit(item, `${at}.${key}`);
    };
    visit(template, path);
    return roots;
}

/** Evaluate a template against a scope. Throws WorkflowBindingError on an unresolved path without default. */
export function evaluateBindingTemplate(template: unknown, scope: BindingScope, path = "$"): JsonValue {
    if (typeof template === "string") {
        const expression = parseBindingExpression(template, path);
        return expression ? resolvePath(scope, expression, path) : template;
    }
    if (Array.isArray(template)) return template.map((item, index) => evaluateBindingTemplate(item, scope, `${path}[${index}]`));
    if (isJsonObject(template)) {
        // fromEntries defines own properties, so a "__proto__" key stays data.
        return Object.fromEntries(Object.entries(template)
            .map(([key, value]) => [key, evaluateBindingTemplate(value, scope, `${path}.${key}`)]));
    }
    assertJsonValue(template, path);
    return template;
}
