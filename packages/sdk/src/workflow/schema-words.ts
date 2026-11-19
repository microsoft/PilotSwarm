/**
 * A JSON Schema problem (Ajv's ErrorObject) in plain words: one clause that names the place and says what is wrong, with
 * no JSON and no parameter object, e.g. "model is required", "sessions needs at least 6 items", "items 1 and 2 of
 * sessions are the same", "topic needs at least 3 characters", "count must be a number". The one formatter for every
 * place a workflow schema problem is shown or returned: a Start that is refused (the Start dialog and the session's
 * workflow_definition answer), a node's input or output that does not match, a response, a compiler diagnostic. No full
 * stop, as Ajv's own messages: callers join several with "; " and end the sentence.
 *
 * The values a schema's author wrote for a const or an enum are never named (adversarial review R2-SF-4): the words say
 * only that the value is not an allowed one. Nor is a pattern. Limits (a length, a count, a bound) are named.
 */

/** The parts of an Ajv error that the words use (structurally an ErrorObject). */
export interface SchemaErrorLike {
    keyword: string;
    instancePath?: string;
    params?: Record<string, unknown> | null;
    message?: string;
}

const INDEX = /^(?:0|[1-9][0-9]*)$/;

/** A JSON pointer's parts, unescaped ("/a~1b/0" → ["a/b", "0"]); "" and "/" are the value itself. */
export function schemaPointerParts(pointer: string | undefined | null): string[] {
    if (!pointer || pointer === "/") return [];
    return pointer.replace(/^\//, "").split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** A field name longer than this is cut, with "…" (a key of the value checked can be any length). */
const NAME_MAX = 80;

/**
 * How a place is named: a field by its name, a nested field with dots ("home.city"), a list's item by its 1-based number
 * ("item 3 of sessions"), a field of an item after it ("name in item 3 of sessions"); the value itself is "the value".
 */
export function schemaPlaceWords(parts: readonly string[]): string {
    let label = "";
    let inItem = false;
    for (const whole of parts) {
        const part = whole.length > NAME_MAX ? `${whole.slice(0, NAME_MAX)}…` : whole;
        if (INDEX.test(part)) {
            label = label ? `item ${Number(part) + 1} of ${label}` : `item ${Number(part) + 1}`;
            inItem = true;
        } else if (!label) label = part === "" ? '""' : part;
        else label = inItem ? `${part} in ${label}` : `${label}.${part}`;
    }
    return label || "the value";
}

const TYPE_WORDS: Readonly<Record<string, string>> = {
    string: "text", number: "a number", integer: "a whole number", boolean: "true or false", object: "an object", array: "a list",
    null: "null",
};

function typeWords(type: unknown): string {
    const names = (Array.isArray(type) ? type : String(type ?? "").split(",")).map(name => String(name).trim()).filter(Boolean);
    const words = names.map(name => TYPE_WORDS[name] ?? name);
    return words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}` : words[0] ?? "of another type";
}

const count = (value: unknown, one: string, many: string): string => `${String(value)} ${Number(value) === 1 ? one : many}`;

const asIndex = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * One Ajv problem in plain words (a clause; no full stop). `at`: the JSON pointer the validated value sits at in a larger
 * one, when the words should name places from there ("" or "/" for the value itself).
 */
export function schemaProblemWords(error: SchemaErrorLike, at = ""): string {
    const parts = [...schemaPointerParts(at), ...schemaPointerParts(error.instancePath)];
    const params = error.params ?? {};
    const place = schemaPlaceWords(parts);
    const field = (name: unknown): string => schemaPlaceWords([...parts, String(name ?? "")]);
    let words: string;
    switch (error.keyword) {
        case "required": words = `${field(params.missingProperty)} is required`; break;
        case "dependentRequired": words = `${field(params.missingProperty)} is required when ${field(params.property)} is given`; break;
        case "additionalProperties": words = `${field(params.additionalProperty)} is not a known field`; break;
        case "unevaluatedProperties": words = `${field(params.unevaluatedProperty)} is not a known field`; break;
        case "propertyNames": words = `${place} has a field name that is not allowed`; break;
        case "minItems": words = `${place} needs at least ${count(params.limit, "item", "items")}`; break;
        case "maxItems": words = `${place} can have at most ${count(params.limit, "item", "items")}`; break;
        case "uniqueItems": {
            const i = asIndex(params.i), j = asIndex(params.j);
            words = i !== null && j !== null
                ? `items ${Math.min(i, j) + 1} and ${Math.max(i, j) + 1} of ${place} are the same`
                : params.limit !== undefined ? `${place} has more than ${count(params.limit, "item", "items")}, too many to check for duplicates`
                    : `${place} has items that are the same`;
            break;
        }
        case "minLength": words = `${place} needs at least ${count(params.limit, "character", "characters")}`; break;
        case "maxLength": words = `${place} can have at most ${count(params.limit, "character", "characters")}`; break;
        case "minProperties": words = `${place} needs at least ${count(params.limit, "field", "fields")}`; break;
        case "maxProperties": words = `${place} can have at most ${count(params.limit, "field", "fields")}`; break;
        case "type": words = `${place} must be ${typeWords(params.type)}`; break;
        case "enum": words = `${place} must be one of the allowed values`; break;
        case "const": words = `${place} must be the allowed value`; break;
        case "minimum": words = `${place} must be at least ${String(params.limit)}`; break;
        case "maximum": words = `${place} must be at most ${String(params.limit)}`; break;
        case "exclusiveMinimum": words = `${place} must be more than ${String(params.limit)}`; break;
        case "exclusiveMaximum": words = `${place} must be less than ${String(params.limit)}`; break;
        case "multipleOf": words = `${place} must be a multiple of ${String(params.multipleOf)}`; break;
        case "pattern": words = `${place} does not have the expected form`; break;
        case "format": words = `${place} is not in the expected format`; break;
        case "anyOf": words = `${place} does not match any of the allowed shapes`; break;
        case "oneOf": words = `${place} must match exactly one of the allowed shapes`; break;
        case "not": case "false schema": words = `${place} is not allowed`; break;
        case "contains": {
            const least = params.minContains ?? 1;
            words = params.maxContains === undefined ? `${place} needs at least ${count(least, "matching item", "matching items")}`
                : Number(least) > 0 ? `${place} needs at least ${String(least)} and at most ${count(params.maxContains, "matching item", "matching items")}`
                    : `${place} can have at most ${count(params.maxContains, "matching item", "matching items")}`;
            break;
        }
        // Anything else: Ajv's own message (which names no parameter values), after the place.
        default: words = `${place} ${String(error.message ?? "is invalid").replace(/[.\s]+$/, "")}`;
    }
    return words.startsWith("the value") ? `T${words.slice(1)}` : words;
}
