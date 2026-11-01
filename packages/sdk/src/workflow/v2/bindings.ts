import { assertJsonValue, isJsonObject, type JsonValue } from "./json.js";

/**
 * Data bindings: a JSON template in which a string that is exactly one
 * `${path}` or `${path ?? <JSON literal>}` expression is replaced by the
 * value at that path. Nothing is evaluated as code.
 *
 * Roots: `inputs` (static run inputs), `input` (the value arriving at the
 * node: the predecessor's output, or its runtime error envelope on an error
 * route), `kv` (the pinned KV snapshot) and `runtime` (`runtime.error`).
 * Segments: `.name`, `[index]` or `["any key"]`.
 */

export const BINDING_ROOTS = ["inputs", "input", "kv", "runtime"] as const;
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
}

export class WorkflowBindingError extends Error {
    readonly code = "WORKFLOW_BINDING_INVALID";
    constructor(message: string, readonly path: string) {
        super(`${path}: ${message}`);
        this.name = "WorkflowBindingError";
    }
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$-]*/;

/** Parse `text` when it is an expression string; null for a plain string. */
export function parseBindingExpression(text: string, path: string): BindingExpression | null {
    const trimmed = text.trim();
    if (!(trimmed.startsWith("${") && trimmed.endsWith("}") && trimmed.indexOf("${", 2) === -1)) {
        if (text.includes("${")) {
            throw new WorkflowBindingError("a value that uses ${...} must be exactly one expression", path);
        }
        return null;
    }
    let body = trimmed.slice(2, -1).trim();
    let hasDefault = false;
    let defaultValue: JsonValue = null;
    const split = body.indexOf("??");
    if (split !== -1) {
        const literal = body.slice(split + 2).trim();
        body = body.slice(0, split).trim();
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
            const close = rest.startsWith("[\"") ? findStringBracketEnd(rest) : rest.indexOf("]");
            if (close === -1) throw new WorkflowBindingError(`unclosed '[' near '${rest}'`, path);
            const inner = rest.slice(1, close).trim();
            if (/^\d+$/.test(inner)) segments.push(Number(inner));
            else {
                let key: unknown;
                try { key = JSON.parse(inner); }
                catch { throw new WorkflowBindingError(`bracket segment must be an index or a JSON string near '${rest}'`, path); }
                if (typeof key !== "string") throw new WorkflowBindingError("bracket segment must be an index or a JSON string", path);
                segments.push(key);
            }
            rest = rest.slice(close + 1);
            continue;
        }
        throw new WorkflowBindingError(`unexpected text '${rest}' in expression`, path);
    }
    return { root, segments, hasDefault, defaultValue };
}

function findStringBracketEnd(text: string): number {
    // text starts with `["`; find the `"]` that closes the JSON string.
    for (let index = 2; index < text.length; index += 1) {
        if (text[index] === "\\") { index += 1; continue; }
        if (text[index] === "\"") return text[index + 1] === "]" ? index + 1 : -1;
    }
    return -1;
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
    let current: JsonValue = scope[expression.root];
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
