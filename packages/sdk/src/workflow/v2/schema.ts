import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import { isJsonObject, type JsonValue } from "./json.js";

type Validator = NonNullable<ReturnType<Ajv2020["getSchema"]>>;

/**
 * JSON Schema 2020-12 for workflow v2 contracts (D06).
 *
 * A definition's named `schemas` and every inline node schema become one
 * document under `$defs`. References are local only: `#/schemas/<Name>`
 * (rewritten to `#/$defs/<Name>`) or `#/$defs/<Name>`. Remote, relative and
 * anchor references are refused at compile time, so validation never reads
 * the network or the file system.
 */

export const WORKFLOW_SCHEMA_ROOT_ID = "urn:pilotswarm:workflow:schemas";
export const SCHEMA_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_REPORTED_ERRORS = 20;

const SUBSCHEMA_KEYWORDS = new Set([
    "not", "if", "then", "else", "items", "contains", "additionalProperties", "propertyNames",
    "unevaluatedItems", "unevaluatedProperties", "contentSchema", "additionalItems",
]);
const SUBSCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SUBSCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties", "$defs", "dependentSchemas", "definitions"]);
const FORBIDDEN_KEYWORDS = new Set(["$id", "$anchor", "$dynamicAnchor", "$dynamicRef", "$recursiveRef", "$recursiveAnchor", "$schema", "$vocabulary"]);

export interface SchemaProblem {
    path: string;
    message: string;
}

export class WorkflowSchemaError extends Error {
    readonly code = "WORKFLOW_SCHEMA_INVALID";
    constructor(message: string, readonly path: string) {
        super(`${path}: ${message}`);
        this.name = "WorkflowSchemaError";
    }
}

/** The two keywords workflow schemas refuse (owner decision Q1 (d)): each makes the validator run a regular expression. */
const PATTERN_KEYWORDS: ReadonlySet<string> = new Set(["pattern", "patternProperties"]);

/**
 * The legacy `dependencies` keyword, refused (review Q2 of the owner batch): Ajv2020 8.20.0 still registers it in its
 * applicator vocabulary (dist/vocabularies/applicator/index.js, getApplicator: dependencies_1 for both drafts), and its
 * schema-valued entries are compiled as subschemas (applicator/dependencies.js, validateSchemaDeps). It is not a
 * subschema keyword this module follows, so a pattern inside it would be copied as data and then run. 2020-12 splits it
 * into dependentSchemas (followed) and dependentRequired (data).
 */
const DEPENDENCIES_REFUSAL = "'dependencies' is not supported in workflow schemas: use dependentSchemas or dependentRequired (JSON Schema 2020-12).";

/** A `$ref` names one whole schema (review R1 of the owner batch): `#/schemas/<Name>` or `#/$defs/<Name>`, nothing after the name. */
export function wholeSchemaRefusal(value: string): string {
    return `a $ref names one whole schema: '#/schemas/<Name>', with nothing after the name (got '${value}').`;
}

/**
 * Why a workflow schema may not use `pattern` or `patternProperties`, and what to use instead. A regular expression can
 * take a very long time on some inputs, and no check of the expression can rule that out (adversarial review SF-5 and
 * its verifications), so neither keyword is accepted anywhere in a workflow schema.
 */
export function patternRefusal(keyword: string): string {
    return `'${keyword}' is not supported in workflow schemas: a regular expression can take a very long time on some inputs. `
        + "Use enum or const for fixed values, minLength and maxLength for a length, or check the text in an agent step.";
}

/**
 * The first use a workflow schema may not have, in a normalized schema's schema positions (the subschema keywords
 * normalizeSchema follows; the values of const, enum, default, examples and annotations are data, and a $ref may not
 * point into them): `pattern` or `patternProperties` (Q1 (d)), `dependencies` (review Q2), or a `$ref` with anything after
 * the schema's name (review R1). Null when there is none. For revisions saved before these rules (WorkflowSchemaSet).
 */
export function refusedSchemaUseIn(schema: JsonValue, path: string): { keyword: string; path: string; message: string } | null {
    if (!isJsonObject(schema)) return null;
    for (const [key, item] of Object.entries(schema)) {
        const at = `${path}.${key}`;
        if (PATTERN_KEYWORDS.has(key)) return { keyword: key, path: at, message: patternRefusal(key) };
        if (key === "dependencies") return { keyword: key, path: at, message: DEPENDENCIES_REFUSAL };
        if (key === "$ref" && (typeof item !== "string" || !item.startsWith("#/$defs/") || !SCHEMA_NAME_PATTERN.test(item.slice("#/$defs/".length)))) {
            return { keyword: key, path: at, message: wholeSchemaRefusal(String(item)) };
        }
        let found: { keyword: string; path: string; message: string } | null = null;
        if (SUBSCHEMA_KEYWORDS.has(key)) found = refusedSchemaUseIn(item, at);
        else if (SUBSCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(item)) {
            for (const [index, entry] of item.entries()) { found = refusedSchemaUseIn(entry, `${at}[${index}]`); if (found) break; }
        } else if (SUBSCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(item)) {
            for (const [name, entry] of Object.entries(item)) { found = refusedSchemaUseIn(entry, `${at}.${name}`); if (found) break; }
        }
        if (found) return found;
    }
    return null;
}

/**
 * Copy a schema, rewriting `#/schemas/` references to `#/$defs/` and
 * refusing non-local references, identity keywords, and `pattern` and
 * `patternProperties` wherever they are (patternRefusal).
 */
export function normalizeSchema(schema: unknown, path: string): JsonValue {
    if (typeof schema === "boolean") return schema;
    if (!isJsonObject(schema)) throw new WorkflowSchemaError("a schema must be a mapping or a boolean", path);
    const out: Array<[string, JsonValue]> = [];
    for (const [key, value] of Object.entries(schema)) {
        const at = `${path}.${key}`;
        if (PATTERN_KEYWORDS.has(key)) throw new WorkflowSchemaError(patternRefusal(key), at);
        if (key === "dependencies") throw new WorkflowSchemaError(DEPENDENCIES_REFUSAL, at);
        if (FORBIDDEN_KEYWORDS.has(key)) throw new WorkflowSchemaError(`'${key}' is not supported in workflow schemas`, at);
        if (key === "$ref") {
            if (typeof value !== "string") throw new WorkflowSchemaError("$ref must be a string", at);
            let ref: string;
            if (value.startsWith("#/schemas/")) ref = `#/$defs/${value.slice("#/schemas/".length)}`;
            else if (value.startsWith("#/$defs/")) ref = value;
            else throw new WorkflowSchemaError(`only local references '#/schemas/<Name>' are allowed (got '${value}')`, at);
            const name = ref.slice("#/$defs/".length);
            // R1: a pointer into a schema (#/schemas/Holder/const) could reach data, such as a const or an example that
            // holds a pattern, and the validator would then run it as a schema. Only a whole named schema may be named.
            if (name.includes("/")) throw new WorkflowSchemaError(wholeSchemaRefusal(value), at);
            if (!SCHEMA_NAME_PATTERN.test(name)) throw new WorkflowSchemaError(`reference '${value}' names an invalid schema`, at);
            out.push([key, ref]);
        } else if (SUBSCHEMA_KEYWORDS.has(key)) {
            out.push([key, normalizeSchema(value, at)]);
        } else if (SUBSCHEMA_ARRAY_KEYWORDS.has(key)) {
            if (!Array.isArray(value)) throw new WorkflowSchemaError(`${key} must be an array of schemas`, at);
            out.push([key, value.map((item, index) => normalizeSchema(item, `${at}[${index}]`))]);
        } else if (SUBSCHEMA_MAP_KEYWORDS.has(key)) {
            if (!isJsonObject(value)) throw new WorkflowSchemaError(`${key} must map names to schemas`, at);
            out.push([key, Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalizeSchema(item, `${at}.${name}`)]))]);
        } else {
            out.push([key, value]);
        }
    }
    return Object.fromEntries(out);
}

/**
 * The definitions a normalized schema references: the `$ref` keywords in its
 * schema positions, the same subschema keywords normalizeSchema follows,
 * each name once in first-seen order. The values of other keywords (const,
 * enum, default, examples and annotations) are data, never references, even
 * when they hold an object with a "$ref" member.
 */
export function schemaReferences(schema: JsonValue): string[] {
    const names: string[] = [];
    const visit = (value: JsonValue): void => {
        if (!isJsonObject(value)) return;
        for (const [key, item] of Object.entries(value)) {
            if (key === "$ref") {
                if (typeof item === "string" && item.startsWith("#/$defs/")) {
                    const name = item.slice("#/$defs/".length).split("/")[0];
                    if (!names.includes(name)) names.push(name);
                }
            } else if (SUBSCHEMA_KEYWORDS.has(key)) {
                visit(item);
            } else if (SUBSCHEMA_ARRAY_KEYWORDS.has(key)) {
                if (Array.isArray(item)) for (const entry of item) visit(entry);
            } else if (SUBSCHEMA_MAP_KEYWORDS.has(key)) {
                if (isJsonObject(item)) for (const entry of Object.values(item)) visit(entry);
            }
        }
    };
    visit(schema);
    return names;
}

function createAjv(): Ajv2020 {
    return new Ajv2020({
        allErrors: true,
        strict: true,
        strictTypes: false,
        strictTuples: false,
        strictRequired: false,
        validateFormats: false,
        allowUnionTypes: true,
    });
}

function describeErrors(errors: ErrorObject[] | null | undefined): SchemaProblem[] {
    return (errors ?? []).slice(0, MAX_REPORTED_ERRORS).map(error => ({
        path: error.instancePath || "/",
        message: `${error.message ?? "is invalid"}${error.params && Object.keys(error.params).length ? ` ${JSON.stringify(error.params)}` : ""}`,
    }));
}

/** Compiled validators for one definition's `$defs`. */
export class WorkflowSchemaSet {
    private readonly ajv = createAjv();
    private readonly validators = new Map<string, Validator>();

    /**
     * Throws WorkflowSchemaError when a definition uses `pattern`, `patternProperties` or `dependencies`, or a `$ref` with
     * anything after the schema's name (refusedSchemaUseIn): a revision saved before those rules fails here, plainly,
     * instead of running an expression nobody checked.
     */
    constructor(readonly defs: Record<string, JsonValue>) {
        for (const [name, schema] of Object.entries(defs)) {
            const found = refusedSchemaUseIn(schema, `$defs.${name}`);
            if (found) {
                throw new WorkflowSchemaError(`${found.message} This revision was saved before that rule; save and publish `
                    + "a revision without it.", found.path);
            }
        }
        this.ajv.addSchema({ $id: WORKFLOW_SCHEMA_ROOT_ID, $defs: defs });
    }

    /** Compile every definition now; throws WorkflowSchemaError naming the first invalid one. */
    compileAll(): void {
        for (const name of Object.keys(this.defs)) {
            try { this.validator(name); }
            catch (error) {
                throw new WorkflowSchemaError(error instanceof Error ? error.message : String(error), `$defs.${name}`);
            }
        }
    }

    private validator(name: string): Validator {
        let validate = this.validators.get(name);
        if (!validate) {
            if (!Object.hasOwn(this.defs, name)) throw new WorkflowSchemaError(`schema '${name}' is not defined`, `$defs.${name}`);
            const found = this.ajv.getSchema(`${WORKFLOW_SCHEMA_ROOT_ID}#/$defs/${name}`);
            if (!found) throw new WorkflowSchemaError(`schema '${name}' did not compile`, `$defs.${name}`);
            validate = found;
            this.validators.set(name, validate);
        }
        return validate;
    }

    /** Problems found validating `value` against the named schema; empty when valid. */
    validate(name: string, value: JsonValue): SchemaProblem[] {
        const validate = this.validator(name);
        const valid = validate(value);
        if (typeof valid !== "boolean") throw new WorkflowSchemaError("asynchronous schemas are not supported", `$defs.${name}`);
        return valid ? [] : describeErrors(validate.errors);
    }
}

const cache = new Map<string, WorkflowSchemaSet>();
const CACHE_LIMIT = 64;

/** A schema set for an immutable compiled definition, cached by its IR hash. */
export function schemaSetFor(irSha256: string, defs: Record<string, JsonValue>): WorkflowSchemaSet {
    const cached = cache.get(irSha256);
    if (cached) return cached;
    const created = new WorkflowSchemaSet(defs);
    if (cache.size >= CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(irSha256, created);
    return created;
}
