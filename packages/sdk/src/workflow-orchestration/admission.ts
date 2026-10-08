import { createHash } from "node:crypto";
import type {
    CompiledWorkflowManifest,
} from "./compiler.js";

type JsonObject = Record<string, unknown>;

function admissionError(message: string, code: string): Error {
    return Object.assign(new Error(message), { code });
}

function isPlainObject(value: unknown): value is JsonObject {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function canonicalizeJson(
    value: unknown,
    path = "$",
    ancestors = new Set<object>(),
): unknown {
    if (
        value === null
        || typeof value === "string"
        || typeof value === "boolean"
        || (typeof value === "number" && Number.isFinite(value))
    ) {
        return value;
    }
    if (typeof value !== "object") {
        throw new TypeError(`${path} must contain only JSON-compatible values.`);
    }
    if (ancestors.has(value)) {
        throw new TypeError(`${path} must not contain a circular reference.`);
    }
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((item, index) => canonicalizeJson(
                item,
                `${path}[${index}]`,
                ancestors,
            ));
        }
        if (!isPlainObject(value)) {
            throw new TypeError(`${path} must be a plain JSON object.`);
        }
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map(key => [
                    key,
                    canonicalizeJson(value[key], `${path}.${key}`, ancestors),
                ]),
        );
    } finally {
        ancestors.delete(value);
    }
}

export function workflowCanonicalJsonSha256(value: unknown): string {
    return createHash("sha256")
        .update(JSON.stringify(canonicalizeJson(value)), "utf8")
        .digest("hex");
}

function validateInputType(name: string, value: unknown, type: string): void {
    const valid = type === "string"
        ? typeof value === "string"
        : type === "number"
            ? typeof value === "number" && Number.isFinite(value)
            : type === "integer"
                ? typeof value === "number" && Number.isInteger(value)
                : type === "boolean"
                    ? typeof value === "boolean"
                    : type === "object"
                        ? isPlainObject(value)
                        : type === "array"
                            ? Array.isArray(value)
                            : false;
    if (!valid) {
        throw admissionError(
            `Workflow input '${name}' must have type '${type}'.`,
            "WORKFLOW_INPUT_INVALID",
        );
    }
}

export function validateWorkflowInputs(
    manifest: CompiledWorkflowManifest,
    inputs: Record<string, unknown>,
): void {
    if (!isPlainObject(inputs)) {
        throw admissionError(
            "Workflow inputs must be an object.",
            "WORKFLOW_INPUT_INVALID",
        );
    }
    try {
        canonicalizeJson(inputs, "inputs");
    } catch (error) {
        throw admissionError(
            error instanceof Error
                ? error.message
                : "Workflow inputs must contain only JSON-compatible values.",
            "WORKFLOW_INPUT_INVALID",
        );
    }
    for (const [name, rawDeclaration] of Object.entries(manifest.inputSchema)) {
        if (!isPlainObject(rawDeclaration)) {
            throw admissionError(
                `Workflow input declaration '${name}' is invalid.`,
                "WORKFLOW_INPUT_SCHEMA_INVALID",
            );
        }
        const present = Object.prototype.hasOwnProperty.call(inputs, name);
        if (rawDeclaration.required === true && !present) {
            throw admissionError(
                `Workflow input '${name}' is required.`,
                "WORKFLOW_INPUT_REQUIRED",
            );
        }
        if (!present) continue;
        if (typeof rawDeclaration.type !== "string") {
            throw admissionError(
                `Workflow input declaration '${name}' does not specify a type.`,
                "WORKFLOW_INPUT_SCHEMA_INVALID",
            );
        }
        validateInputType(name, inputs[name], rawDeclaration.type);
    }
}

export interface ResolvedWorkflowPrimaryKey {
    values: readonly unknown[];
    sha256: string;
}

export function resolveWorkflowPrimaryKey(
    manifest: CompiledWorkflowManifest,
    inputs: Record<string, unknown>,
): ResolvedWorkflowPrimaryKey | null {
    const expressions = manifest.identity?.primaryKey;
    if (!expressions?.length) return null;
    const values = expressions.map(expression => {
        const name = expression.slice("inputs.".length);
        const value = inputs[name];
        if (
            value === null
            || !["string", "number", "boolean"].includes(typeof value)
            || (typeof value === "string" && value.trim().length === 0)
        ) {
            throw admissionError(
                `Workflow primary-key input '${name}' must resolve to a scalar value.`,
                "WORKFLOW_PRIMARY_KEY_INVALID",
            );
        }
        return value;
    });
    return {
        values,
        sha256: workflowCanonicalJsonSha256(values),
    };
}
