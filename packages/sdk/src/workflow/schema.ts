import { Ajv2020 } from "ajv/dist/2020.js";
import type { AnySchemaObject, ErrorObject, FuncKeywordDefinition, SchemaValidateFunction } from "ajv";
import { schemaProblemWords } from "./schema-words.js";
import { isJsonObject, type JsonValue } from "./json.js";

type Validator = NonNullable<ReturnType<Ajv2020["getSchema"]>>;

/**
 * JSON Schema 2020-12 for workflow contracts (D06).
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
 * The most schema parts one schema may stand for once every `$ref` in it is replaced by the schema it names, each time it
 * is named (adversarial review R2-SF-1): a few lines of YAML that name a schema twice, which names one twice, and so on,
 * would otherwise make one check of a small value do millions of checks.
 */
export const WORKFLOW_SCHEMA_MAX_EXPANDED_PARTS = 10_000;
/**
 * The most items a list may have when its schema asks for unique items that are not all plain values (R2-SF-1): those
 * items are compared with each other, and many of them would take very long.
 */
export const WORKFLOW_SCHEMA_UNIQUE_ITEMS_MAX = 100;

/** Keywords whose schemas apply to a property, an item or a property name of the value: a `$ref` under one goes one level into it. */
const CHILD_KEYWORDS: ReadonlySet<string> = new Set([
    "properties", "patternProperties", "additionalProperties", "unevaluatedProperties", "propertyNames",
    "items", "prefixItems", "additionalItems", "unevaluatedItems", "contains", "contentSchema",
]);
/** Keywords that only hold schemas (a `$ref` names only a whole workflow schema, never one in these): never applied to a value. */
const HOLDER_KEYWORDS: ReadonlySet<string> = new Set(["$defs", "definitions"]);
const PLAIN_TYPES: ReadonlySet<string> = new Set(["string", "number", "integer", "boolean", "null"]);

/** Whether a schema requires a type of plain values only (strings, numbers, booleans, null). */
function plainTyped(schema: JsonValue): boolean {
    if (!isJsonObject(schema)) return false;
    const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
    return types.length > 0 && types.every(type => typeof type === "string" && PLAIN_TYPES.has(type));
}

/**
 * Whether every item of a list a schema checks must be a plain value: its `items` has a plain type, and so has each
 * schema of its `prefixItems`, which apply to the first items instead (re-check S-SF-F1: a tuple of objects before plain
 * items is not plain). Such items are looked up by value, never compared one by one.
 */
function plainItems(schema: Record<string, JsonValue>): boolean {
    if (!plainTyped(schema.items)) return false;
    return schema.prefixItems === undefined || (Array.isArray(schema.prefixItems) && schema.prefixItems.every(plainTyped));
}

interface SchemaShape {
    /** Schema parts in schema positions, references not replaced. */
    parts: number;
    /** Each `$ref` to a workflow schema, with whether it is under a keyword that goes into the value. */
    refs: Array<{ name: string; deeper: boolean }>;
    /** The first `uniqueItems` whose items may be compared one by one without a small maxItems. */
    uniqueItems: string | null;
}

function shapeOf(schema: JsonValue, path: string): SchemaShape {
    const shape: SchemaShape = { parts: 0, refs: [], uniqueItems: null };
    const visit = (value: JsonValue, at: string, deeper: boolean): void => {
        shape.parts += 1;
        if (!isJsonObject(value)) return;
        if (value.uniqueItems === true && shape.uniqueItems === null && !plainItems(value)
            && !(typeof value.maxItems === "number" && value.maxItems <= WORKFLOW_SCHEMA_UNIQUE_ITEMS_MAX)) shape.uniqueItems = `${at}.uniqueItems`;
        for (const [key, item] of Object.entries(value)) {
            const into = deeper || CHILD_KEYWORDS.has(key);
            if (key === "$ref") {
                if (typeof item === "string" && item.startsWith("#/$defs/")) shape.refs.push({ name: item.slice("#/$defs/".length), deeper });
            } else if (HOLDER_KEYWORDS.has(key)) {
                continue;
            } else if (SUBSCHEMA_KEYWORDS.has(key)) {
                visit(item, `${at}.${key}`, into);
            } else if (SUBSCHEMA_ARRAY_KEYWORDS.has(key)) {
                if (Array.isArray(item)) item.forEach((entry, index) => visit(entry, `${at}.${key}[${index}]`, into));
            } else if (SUBSCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(item)) {
                for (const [name, entry] of Object.entries(item)) visit(entry, `${at}.${key}.${name}`, into);
            }
        }
    };
    visit(schema, path, false);
    return shape;
}

/**
 * Why a set of normalized workflow schemas could make a check of a small value take very long (adversarial review
 * R2-SF-1), or null. Each schema's parts are counted with every `$ref` replaced by the schema it names, each time it is
 * named; more than WORKFLOW_SCHEMA_MAX_EXPANDED_PARTS is refused. A schema may refer back to itself (directly or through
 * others) in one place only, and that place must go into a property or an item of the value: two places can double the
 * checks at each level of the value, and none would never end. `uniqueItems` on items that are not plain values needs
 * a maxItems of at most WORKFLOW_SCHEMA_UNIQUE_ITEMS_MAX.
 */
export function schemaCostRefusal(defs: Record<string, JsonValue>): { path: string; message: string } | null {
    const names = Object.keys(defs);
    const shapes = new Map(names.map(name => [name, shapeOf(defs[name], `$defs.${name}`)] as const));
    for (const shape of shapes.values()) {
        if (shape.uniqueItems !== null) {
            return { path: shape.uniqueItems, message: `uniqueItems on items that are not plain values (strings, numbers, booleans or null) needs `
                + `maxItems of at most ${WORKFLOW_SCHEMA_UNIQUE_ITEMS_MAX} beside it: comparing many objects or lists with each other could take very long.` };
        }
    }
    const referred = new Map(names.map(name => [name, shapes.get(name)!.refs.map(ref => ref.name).filter(target => shapes.has(target))] as const));
    const targets = (name: string): readonly string[] => referred.get(name)!;
    // The schemas that refer to each other (strongly connected), without recursion (Kosaraju): the first pass orders the
    // schemas by when their search ended; the second takes them in reverse on the reversed references.
    const finished: string[] = [];
    const visited = new Set<string>();
    for (const start of names) {
        if (visited.has(start)) continue;
        visited.add(start);
        const stack: Array<{ name: string; next: number }> = [{ name: start, next: 0 }];
        while (stack.length > 0) {
            const top = stack[stack.length - 1];
            const out = targets(top.name);
            if (top.next < out.length) {
                const target = out[top.next++];
                if (!visited.has(target)) { visited.add(target); stack.push({ name: target, next: 0 }); }
            } else {
                finished.push(top.name);
                stack.pop();
            }
        }
    }
    const referrers = new Map<string, string[]>(names.map(name => [name, []]));
    for (const name of names) for (const target of targets(name)) referrers.get(target)!.push(name);
    const component = new Map<string, number>();
    const components: string[][] = [];
    for (const start of [...finished].reverse()) {
        if (component.has(start)) continue;
        const members: string[] = [];
        const pending = [start];
        component.set(start, components.length);
        while (pending.length > 0) {
            const name = pending.pop()!;
            members.push(name);
            for (const referrer of referrers.get(name)!) {
                if (!component.has(referrer)) { component.set(referrer, components.length); pending.push(referrer); }
            }
        }
        components.push(members);
    }
    // Each schema that refers back to itself does so in one place, which goes into the value.
    const cyclic = (index: number): boolean => components[index].length > 1 || targets(components[index][0]).includes(components[index][0]);
    for (const [index, members] of components.entries()) {
        if (!cyclic(index)) continue;
        let goesDeeper = false;
        for (const name of members) {
            const back = shapes.get(name)!.refs.filter(ref => shapes.has(ref.name) && component.get(ref.name) === index);
            if (back.length > 1) {
                const through = members.length > 1 ? ` (through ${members.filter(member => member !== name).map(member => `'${member}'`).join(", ")})` : "";
                return { path: `$defs.${name}`, message: `schema '${name}' refers back to itself${through} in ${back.length} places; it may do so in one place only, `
                    + "because each further place could double the checks at every level of a value. Use one list of children, or {} for any value." };
            }
            if (back.some(ref => ref.deeper)) goesDeeper = true;
        }
        if (!goesDeeper) {
            return { path: `$defs.${members[0]}`, message: `schema '${members[0]}' refers back to itself without going into a property or an item `
                + "of the value, so checking a value against it would never end." };
        }
    }
    // Expanded parts, schemas that are referred to first (the second pass found referrers before what they refer to). A
    // reference back into its own schemas counts one part: the rule above bounds how often it applies.
    const expanded = new Map<string, number>();
    for (let index = components.length - 1; index >= 0; index -= 1) {
        for (const name of components[index]) {
            let parts = shapes.get(name)!.parts;
            for (const ref of shapes.get(name)!.refs) {
                if (!shapes.has(ref.name)) continue;
                parts += component.get(ref.name) === index ? 1 : expanded.get(ref.name)!;
                if (parts > WORKFLOW_SCHEMA_MAX_EXPANDED_PARTS) break;
            }
            expanded.set(name, Math.min(parts, WORKFLOW_SCHEMA_MAX_EXPANDED_PARTS + 1));
        }
    }
    for (const name of names) {
        if (expanded.get(name)! > WORKFLOW_SCHEMA_MAX_EXPANDED_PARTS) {
            return { path: `$defs.${name}`, message: `schema '${name}' stands for more than ${WORKFLOW_SCHEMA_MAX_EXPANDED_PARTS.toLocaleString("en-US")} schema `
                + "parts once each schema it names is put in its place, each time it is named, so checking even a small value could take very long. "
                + "Name fewer schemas, or each one fewer times." };
        }
    }
    return null;
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

/** The keywords of a schema shown to a reader that hold schemas (schemaWithoutLiterals): followed, and kept. */
const READER_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
    "not", "if", "then", "else", "items", "contains", "additionalProperties", "propertyNames", "unevaluatedItems", "unevaluatedProperties",
]);
const READER_SCHEMA_LIST_KEYWORDS: ReadonlySet<string> = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const READER_SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set(["properties", "dependentSchemas"]);
/** The shape keywords a reader is shown, with the kind of value each may have: a count, a number, a flag. */
const READER_COUNT_KEYWORDS: ReadonlySet<string> = new Set([
    "minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties", "minContains", "maxContains",
]);
const READER_NUMBER_KEYWORDS: ReadonlySet<string> = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]);
const JSON_TYPES: ReadonlySet<string> = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const nameList = (value: JsonValue): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");

/**
 * A schema as a person who may read a workflow but not its YAML sees it (adversarial review R2-SF-2 and its re-check
 * S-SF-F2): only its shape, by an allowlist. Kept: the schema keywords that hold schemas (properties, items,
 * prefixItems, additionalProperties, allOf, anyOf, oneOf, not, if, then, else, contains, propertyNames,
 * dependentSchemas, unevaluated*), each schema in them projected the same way, and type, required, dependentRequired,
 * uniqueItems and the counts and limits (lengths, item and property counts, minimum, maximum, multipleOf), each only
 * with a value of its kind. Everything else is left out: default, const, enum, examples, title, description,
 * $comment, format, contentMediaType, contentEncoding, contentSchema, $defs, and any other or unknown keyword
 * (vendor ones included), so no text the author wrote there reaches the reader. Property names stay: they are the shape.
 */
export function schemaWithoutLiterals(schema: JsonValue): JsonValue {
    if (!isJsonObject(schema)) return typeof schema === "boolean" ? schema : {};
    const out: Array<[string, JsonValue]> = [];
    for (const [key, value] of Object.entries(schema)) {
        if (READER_SCHEMA_KEYWORDS.has(key)) out.push([key, schemaWithoutLiterals(value)]);
        else if (READER_SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value)) out.push([key, value.map(schemaWithoutLiterals)]);
        else if (READER_SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(value)) {
            out.push([key, Object.fromEntries(Object.entries(value).map(([name, item]) => [name, schemaWithoutLiterals(item)]))]);
        } else if (key === "type" && ((typeof value === "string" && JSON_TYPES.has(value)) || (nameList(value) && value.every(item => JSON_TYPES.has(item))))) {
            out.push([key, value]);
        } else if (key === "required" && nameList(value)) out.push([key, value]);
        else if (key === "dependentRequired" && isJsonObject(value) && Object.values(value).every(nameList)) out.push([key, value]);
        else if (key === "uniqueItems" && typeof value === "boolean") out.push([key, value]);
        else if (READER_COUNT_KEYWORDS.has(key) && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) out.push([key, value]);
        else if (READER_NUMBER_KEYWORDS.has(key) && typeof value === "number" && Number.isFinite(value)) out.push([key, value]);
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

/** A value's JSON with every object's keys in order, so equal values have the same text (no checks: the value is being validated). */
function sortedJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${sortedJson(object[key])}`).join(",")}}`;
}

/**
 * uniqueItems at a bounded cost, in place of Ajv's (adversarial review R2-SF-1). Ajv compares items that are not plain
 * values each with each, and with allErrors it does so even when maxItems has already failed. Here plain items (the
 * schema's items has a plain type; others are left to that items schema, as Ajv does) are looked up by their value, and
 * other items by their JSON with sorted keys, at most WORKFLOW_SCHEMA_UNIQUE_ITEMS_MAX of them: a longer list fails this keyword
 * without being compared (the compiler asks such a schema for that maxItems). Ajv's message, from the last items back.
 */
function uniqueItemsKeyword(): FuncKeywordDefinition {
    const validate: SchemaValidateFunction = (schema: unknown, data: unknown, parentSchema?: AnySchemaObject): boolean => {
        if (schema !== true || !Array.isArray(data) || data.length < 2) return true;
        const plain = parentSchema !== undefined && isJsonObject(parentSchema) && plainItems(parentSchema);
        if (!plain && data.length > WORKFLOW_SCHEMA_UNIQUE_ITEMS_MAX) {
            validate.errors = [{ keyword: "uniqueItems", params: { limit: WORKFLOW_SCHEMA_UNIQUE_ITEMS_MAX },
                message: `must NOT have more than ${WORKFLOW_SCHEMA_UNIQUE_ITEMS_MAX} items to be checked for duplicates` }];
            return false;
        }
        const seen = new Map<string, number>();
        for (let i = data.length - 1; i >= 0; i -= 1) {
            const item: unknown = data[i];
            if (plain && item !== null && typeof item === "object") continue;
            const key = plain ? `${typeof item}:${String(item)}` : sortedJson(item);
            const j = seen.get(key);
            if (j !== undefined) {
                validate.errors = [{ keyword: "uniqueItems", params: { i, j }, message: `must NOT have duplicate items (items ## ${j} and ${i} are identical)` }];
                return false;
            }
            seen.set(key, i);
        }
        return true;
    };
    return { keyword: "uniqueItems", type: "array", schemaType: "boolean", errors: true, validate };
}

function createAjv(): Ajv2020 {
    const ajv = new Ajv2020({
        allErrors: true,
        strict: true,
        strictTypes: false,
        strictTuples: false,
        strictRequired: false,
        validateFormats: false,
        allowUnionTypes: true,
    });
    ajv.removeKeyword("uniqueItems");
    ajv.addKeyword(uniqueItemsKeyword());
    return ajv;
}

/**
 * Each problem as its place (a JSON pointer) and plain words that name the place and what is wrong
 * (schemaProblemWords): "sessions needs at least 6 items", "model is required". No JSON of Ajv's params: the message is
 * returned to the caller (a refused Start, in the Start dialog and the chat's answer alike), stored with the node and
 * shown. It names no value a schema's author wrote for a const or an enum (adversarial review R2-SF-4); it still says what
 * is wrong ("must be one of the allowed values").
 */
function describeErrors(errors: ErrorObject[] | null | undefined, at: string): SchemaProblem[] {
    return (errors ?? []).slice(0, MAX_REPORTED_ERRORS).map(error => ({ path: error.instancePath || "/", message: schemaProblemWords(error, at) }));
}

/** Compiled validators for one definition's `$defs`. */
export class WorkflowSchemaSet {
    private readonly ajv = createAjv();
    private readonly validators = new Map<string, Validator>();

    /**
     * Throws WorkflowSchemaError when a definition uses `pattern`, `patternProperties` or `dependencies`, or a `$ref` with
     * anything after the schema's name (refusedSchemaUseIn): a revision saved before those rules fails here, plainly,
     * instead of running an expression nobody checked. Also when the schemas could make a check take very long
     * (schemaCostRefusal, review R2-SF-1): the compiler refuses such a definition through this, and a revision saved before
     * that rule fails here.
     */
    constructor(readonly defs: Record<string, JsonValue>) {
        for (const [name, schema] of Object.entries(defs)) {
            const found = refusedSchemaUseIn(schema, `$defs.${name}`);
            if (found) {
                throw new WorkflowSchemaError(`${found.message} This revision was saved before that rule; save and publish `
                    + "a revision without it.", found.path);
            }
        }
        const costly = schemaCostRefusal(defs);
        if (costly) throw new WorkflowSchemaError(costly.message, costly.path);
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

    /**
     * Problems found validating `value` against the named schema; empty when valid. `at`: where `value` sits in a larger
     * value (a JSON pointer), for the words of each message only ("/home" → "home.city is required"); each `path` stays
     * relative to `value`.
     */
    validate(name: string, value: JsonValue, at = ""): SchemaProblem[] {
        const validate = this.validator(name);
        const valid = validate(value);
        if (typeof valid !== "boolean") throw new WorkflowSchemaError("asynchronous schemas are not supported", `$defs.${name}`);
        return valid ? [] : describeErrors(validate.errors, at);
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
