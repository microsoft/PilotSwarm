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

/**
 * Copy a schema, rewriting `#/schemas/` references to `#/$defs/` and
 * refusing non-local references and identity keywords.
 */
export function normalizeSchema(schema: unknown, path: string): JsonValue {
    if (typeof schema === "boolean") return schema;
    if (!isJsonObject(schema)) throw new WorkflowSchemaError("a schema must be a mapping or a boolean", path);
    const out: Array<[string, JsonValue]> = [];
    for (const [key, value] of Object.entries(schema)) {
        const at = `${path}.${key}`;
        if (FORBIDDEN_KEYWORDS.has(key)) throw new WorkflowSchemaError(`'${key}' is not supported in workflow schemas`, at);
        if (key === "$ref") {
            if (typeof value !== "string") throw new WorkflowSchemaError("$ref must be a string", at);
            let ref: string;
            if (value.startsWith("#/schemas/")) ref = `#/$defs/${value.slice("#/schemas/".length)}`;
            else if (value.startsWith("#/$defs/")) ref = value;
            else throw new WorkflowSchemaError(`only local references '#/schemas/<Name>' are allowed (got '${value}')`, at);
            const name = ref.slice("#/$defs/".length).split("/")[0];
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

    constructor(readonly defs: Record<string, JsonValue>) {
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
