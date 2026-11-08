import { canonicalJson, isJsonObject, utf8ByteLength, type JsonValue } from "./json.js";

/*
 * Moved from tools.ts (stage 2.3) so that the package validator (package-card.ts) can resolve a definition's schemas
 * without importing the workflow service. tools.ts re-exports it.
 */

/** The largest resolved input schema a read shows; a larger one is left out (null), and nothing else changes. */
const INPUTS_SCHEMA_VIEW_MAX_BYTES = 32 * 1024;

/**
 * The workflow's input schema (inputs.schema) as its run checks it, with every reference to a schema of `schemas`
 * replaced by that schema (batch 7, f-05), so a reader (the portal's sample inputs) needs no reference resolution of its
 * own: compiled, from the revision's IR. Keywords beside a reference are kept. A reference back into a schema it is
 * still resolving (a recursive schema), or into part of one, becomes {} (anything). Null without an input schema, or when
 * the result is larger than INPUTS_SCHEMA_VIEW_MAX_BYTES.
 */
export function workflowV2ResolvedInputsSchema(ir: { inputsSchema: string | null; schemaDefs?: Record<string, JsonValue> },
    stats: { values: number; bytes: number } = { values: 0, bytes: 0 }): JsonValue | null {
    const defs = ir.schemaDefs ?? {};
    if (!ir.inputsSchema || !Object.hasOwn(defs, ir.inputsSchema)) return null;
    // SF-4 and its verification: two budgets while resolving, so a small definition whose references branch cannot make
    // an exponential copy (values made) or an exponential text (the bytes its copy would have as JSON, counted as each
    // string, key and scalar is reached, before anything is serialized). Past either, no schema is shown. `stats`
    // reports what was counted (tests).
    const charge = (bytes: number) => {
        stats.bytes += bytes;
        if (stats.bytes > INPUTS_SCHEMA_VIEW_MAX_BYTES) throw INPUTS_SCHEMA_OVER_BUDGET;
    };
    const resolve = (value: JsonValue, resolving: readonly string[], depth: number): JsonValue => {
        stats.values += 1;
        if (stats.values > INPUTS_SCHEMA_VIEW_MAX_VALUES) throw INPUTS_SCHEMA_OVER_BUDGET;
        if (depth > 64) { charge(2); return {}; }
        // A string as JSON writes it, its escapes included (SF-4 residual).
        if (typeof value === "string") { charge(utf8ByteLength(JSON.stringify(value))); return value; }
        if (!Array.isArray(value) && !isJsonObject(value)) { charge(String(value).length); return value; }
        charge(2);
        if (Array.isArray(value)) return value.map(item => { charge(1); return resolve(item, resolving, depth + 1); });
        const entry = (key: string, item: JsonValue): [string, JsonValue] => { charge(utf8ByteLength(JSON.stringify(key)) + 2); return [key, resolve(item, resolving, depth + 1)]; };
        const ref = typeof value.$ref === "string" ? value.$ref : null;
        if (ref === null) return Object.fromEntries(Object.entries(value).map(([key, item]) => entry(key, item)));
        const name = ref.startsWith("#/$defs/") ? ref.slice("#/$defs/".length) : ref.startsWith("#/schemas/") ? ref.slice("#/schemas/".length) : null;
        const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref").map(([key, item]) => entry(key, item)));
        if (name === null || name.includes("/") || !Object.hasOwn(defs, name) || resolving.includes(name)) return rest;
        const target = resolve(defs[name], [...resolving, name], depth + 1);
        if (!isJsonObject(target)) return Object.keys(rest).length ? rest : target;
        return Object.fromEntries([...Object.entries(target), ...Object.entries(rest)]);
    };
    let resolved: JsonValue;
    try {
        resolved = resolve(defs[ir.inputsSchema], [ir.inputsSchema], 0);
    } catch (error) {
        if (error === INPUTS_SCHEMA_OVER_BUDGET) return null;
        throw error;
    }
    return utf8ByteLength(canonicalJson(resolved)) > INPUTS_SCHEMA_VIEW_MAX_BYTES ? null : resolved;
}

/** The most values one resolution may make (SF-4); a schema of 32 KiB has far fewer. */
const INPUTS_SCHEMA_VIEW_MAX_VALUES = 20_000;
const INPUTS_SCHEMA_OVER_BUDGET = new Error("The resolved input schema is too large to show.");
