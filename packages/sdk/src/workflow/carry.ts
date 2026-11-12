import { evaluateBindingTemplate, type BindingScope } from "./bindings.js";
import { boundedCanonicalJson, isJsonObject, parseStoredJson, WorkflowJsonError, type JsonValue } from "./json.js";

export const WORKFLOW_CARRY_MAX_BYTES = 64 * 1024;

/** Canonical text keeps every JSON string, including NUL and lone surrogates. */
export function carrySnapshotText(value: unknown, path = "carry"): string {
    if (!isJsonObject(value)) throw new WorkflowJsonError("carry must be an object", path);
    return boundedCanonicalJson(value, path, WORKFLOW_CARRY_MAX_BYTES);
}

export function evaluateCarry(template: { [key: string]: JsonValue }, scope: BindingScope, path: string): string {
    return carrySnapshotText(evaluateBindingTemplate(template, scope, path), path);
}

export function readCarrySnapshot(text: string | null): JsonValue {
    if (text === null) return null;
    const value = parseStoredJson(text, "carry_snapshot");
    carrySnapshotText(value, "carry_snapshot");
    return value;
}

/** The successor sees the stored entry snapshot, never a new evaluation against current KV. */
export function carryArrival(snapshot: JsonValue, result: JsonValue): JsonValue {
    const incoming = { carry: snapshot, result };
    boundedCanonicalJson(incoming, "Carried input");
    return incoming;
}
