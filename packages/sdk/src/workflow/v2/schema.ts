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

/** The longest pattern a schema may have (SF-5). */
export const SCHEMA_PATTERN_MAX_LENGTH = 512;

/**
 * A set of characters (code points) for the pattern check: the listed ranges, or (`neg`) every character but them.
 * Sets are compared only to tell whether two can share a character; they need not be exact.
 */
interface CharSet { neg: boolean; ranges: Array<[number, number]> }
const NONE: CharSet = { neg: false, ranges: [] };
const ANY: CharSet = { neg: true, ranges: [] };
const DIGITS: Array<[number, number]> = [[48, 57]];
const WORD: Array<[number, number]> = [[48, 57], [65, 90], [95, 95], [97, 122]];
const SPACE: Array<[number, number]> = [[9, 13], [32, 32], [160, 160], [5760, 5760], [8192, 8202], [8232, 8233], [8239, 8239], [8287, 8287], [12288, 12288], [65279, 65279]];
const LINE_ENDS: Array<[number, number]> = [[10, 10], [13, 13], [8232, 8233]];

function merged(ranges: Array<[number, number]>): Array<[number, number]> {
    const sorted = ranges.filter(([lo, hi]) => lo <= hi).sort((a, b) => a[0] - b[0]);
    const out: Array<[number, number]> = [];
    for (const [lo, hi] of sorted) {
        const last = out[out.length - 1];
        if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
        else out.push([lo, hi]);
    }
    return out;
}
/** `a` minus `b`, as ranges. */
function subtract(a: Array<[number, number]>, b: Array<[number, number]>): Array<[number, number]> {
    let out = merged(a);
    for (const [lo, hi] of merged(b)) {
        out = out.flatMap(([x, y]): Array<[number, number]> => (hi < x || lo > y ? [[x, y]]
            : [...(x < lo ? [[x, lo - 1] as [number, number]] : []), ...(y > hi ? [[hi + 1, y] as [number, number]] : [])]));
    }
    return out;
}
function intersect(a: Array<[number, number]>, b: Array<[number, number]>): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const [x, y] of merged(a)) for (const [lo, hi] of merged(b)) if (Math.max(x, lo) <= Math.min(y, hi)) out.push([Math.max(x, lo), Math.min(y, hi)]);
    return merged(out);
}
function union(a: CharSet, b: CharSet): CharSet {
    if (!a.neg && !b.neg) return { neg: false, ranges: merged([...a.ranges, ...b.ranges]) };
    if (a.neg && b.neg) return { neg: true, ranges: intersect(a.ranges, b.ranges) };
    const [negative, positive] = a.neg ? [a, b] : [b, a];
    return { neg: true, ranges: subtract(negative.ranges, positive.ranges) };
}
/** Whether two sets can share a character. */
function overlaps(a: CharSet, b: CharSet): boolean {
    if (a.neg && b.neg) return true;
    if (!a.neg && !b.neg) return intersect(a.ranges, b.ranges).length > 0;
    const [negative, positive] = a.neg ? [a, b] : [b, a];
    return subtract(positive.ranges, negative.ranges).length > 0;
}
const single = (code: number): CharSet => ({ neg: false, ranges: [[code, code]] });

/** The parsed pattern: alternatives of sequences of quantified atoms. */
interface Alt { options: Item[][] }
interface Item { atom: Atom; min: number; max: number }
type Atom =
    | { kind: "set"; set: CharSet; nullable?: boolean }
    | { kind: "group"; alt: Alt }
    | { kind: "assert" };

class UnsafePattern extends Error {}

/** Parse a JSON Schema (ECMAScript, u-mode) pattern; throws UnsafePattern with a reason for what is refused. */
function parsePattern(pattern: string): Alt {
    let at = 0;
    const fail = (reason: string): never => { throw new UnsafePattern(reason); };
    const code = (): number => {
        const value = pattern.codePointAt(at);
        if (value === undefined) fail("a pattern ends inside an escape or a class");
        at += value! > 0xffff ? 2 : 1;
        return value!;
    };
    const hex = (digits: number): number => {
        const text = pattern.slice(at, at + digits);
        if (!/^[0-9A-Fa-f]+$/.test(text) || text.length !== digits) return -1;
        at += digits;
        return Number.parseInt(text, 16);
    };
    /** An escape after its backslash: a set, or an assertion (\b, \B). */
    const escape = (inClass: boolean): Atom => {
        const c = pattern[at];
        if (c === undefined) return fail("a pattern ends with a backslash");
        at += 1;
        switch (c) {
            case "d": return { kind: "set", set: { neg: false, ranges: DIGITS } };
            case "D": return { kind: "set", set: { neg: true, ranges: DIGITS } };
            case "w": return { kind: "set", set: { neg: false, ranges: WORD } };
            case "W": return { kind: "set", set: { neg: true, ranges: WORD } };
            case "s": return { kind: "set", set: { neg: false, ranges: SPACE } };
            case "S": return { kind: "set", set: { neg: true, ranges: SPACE } };
            case "b": return inClass ? { kind: "set", set: single(8) } : { kind: "assert" };
            case "B": return inClass ? fail("a class holds \\B") : { kind: "assert" };
            case "t": return { kind: "set", set: single(9) };
            case "n": return { kind: "set", set: single(10) };
            case "v": return { kind: "set", set: single(11) };
            case "f": return { kind: "set", set: single(12) };
            case "r": return { kind: "set", set: single(13) };
            case "0": return { kind: "set", set: single(0) };
            case "c": { const letter = pattern.charCodeAt(at); at += 1; return { kind: "set", set: single(letter % 32) }; }
            case "x": { const value = hex(2); return { kind: "set", set: value < 0 ? ANY : single(value) }; }
            case "u": {
                if (pattern[at] === "{") {
                    const end = pattern.indexOf("}", at);
                    const value = end > at ? Number.parseInt(pattern.slice(at + 1, end), 16) : Number.NaN;
                    at = end > at ? end + 1 : at;
                    return { kind: "set", set: Number.isFinite(value) ? single(value) : ANY };
                }
                const value = hex(4);
                return { kind: "set", set: value < 0 ? ANY : single(value) };
            }
            case "p": case "P": {
                if (pattern[at] === "{") { const end = pattern.indexOf("}", at); at = end > at ? end + 1 : at; }
                return { kind: "set", set: ANY };
            }
            case "k": {
                if (pattern[at] === "<") { const end = pattern.indexOf(">", at); at = end > at ? end + 1 : at; }
                return { kind: "set", set: ANY, nullable: true };
            }
            default:
                if (c >= "1" && c <= "9") {
                    while (pattern[at] >= "0" && pattern[at] <= "9") at += 1;
                    return { kind: "set", set: ANY, nullable: true };
                }
                return { kind: "set", set: single(c.codePointAt(0)!) };
        }
    };
    const charClass = (): CharSet => {
        let neg = false;
        if (pattern[at] === "^") { neg = true; at += 1; }
        let ranges: Array<[number, number]> = [];
        let everything = false;
        const member = (): CharSet => {
            if (pattern[at] === "\\") { at += 1; const atom = escape(true); return atom.kind === "set" ? atom.set : NONE; }
            return single(code());
        };
        while (at < pattern.length && pattern[at] !== "]") {
            const first = member();
            if (pattern[at] === "-" && pattern[at + 1] !== "]" && at + 1 < pattern.length && !first.neg && first.ranges.length === 1
                && first.ranges[0][0] === first.ranges[0][1]) {
                at += 1;
                const second = member();
                if (!second.neg && second.ranges.length === 1 && second.ranges[0][0] === second.ranges[0][1]) {
                    ranges.push([first.ranges[0][0], second.ranges[0][0]]);
                    continue;
                }
                ranges.push([45, 45]);
                if (second.neg) everything = true; else ranges = [...ranges, ...second.ranges];
            }
            if (first.neg) everything = true; else ranges = [...ranges, ...first.ranges];
        }
        if (pattern[at] !== "]") fail("a pattern has an unclosed class");
        at += 1;
        if (everything) return neg ? NONE : ANY;
        return { neg, ranges: merged(ranges) };
    };
    const quantifier = (): { min: number; max: number } | null => {
        const c = pattern[at];
        let bounds: { min: number; max: number } | null = null;
        if (c === "*") { bounds = { min: 0, max: Infinity }; at += 1; }
        else if (c === "+") { bounds = { min: 1, max: Infinity }; at += 1; }
        else if (c === "?") { bounds = { min: 0, max: 1 }; at += 1; }
        else if (c === "{") {
            const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(at));
            if (!match) return null;
            const min = Number(match[1]);
            bounds = { min, max: match[2] === undefined ? min : match[3] === "" ? Infinity : Number(match[3]) };
            at += match[0].length;
        }
        if (bounds && pattern[at] === "?") at += 1;
        return bounds;
    };
    const alternation = (inGroup: boolean): Alt => {
        const options: Item[][] = [[]];
        while (at < pattern.length) {
            const c = pattern[at];
            if (c === ")") {
                if (!inGroup) fail("a pattern has an unmatched ')'");
                return { options };
            }
            if (c === "|") { at += 1; options.push([]); continue; }
            let atom: Atom;
            if (c === "(") {
                const prefix = /^\((\?(:|=|!|<=|<!|<[A-Za-z_$][A-Za-z0-9_$]*>))?/.exec(pattern.slice(at))![0];
                if (prefix === "(" && pattern[at + 1] === "?") fail("a pattern may not use inline flags or unknown groups such as (?i:...)");
                at += prefix.length;
                const inner = alternation(true);
                if (pattern[at] !== ")") fail("a pattern has an unmatched '('");
                at += 1;
                atom = /^\(\?(=|!|<=|<!)$/.test(prefix) ? { kind: "assert" } : { kind: "group", alt: inner };
            } else if (c === "[") { at += 1; atom = { kind: "set", set: charClass() }; }
            else if (c === "\\") { at += 1; atom = escape(false); }
            else if (c === ".") { at += 1; atom = { kind: "set", set: { neg: true, ranges: LINE_ENDS } }; }
            else if (c === "^" || c === "$") { at += 1; atom = { kind: "assert" }; }
            else atom = { kind: "set", set: single(code()) };
            const bounds = quantifier() ?? { min: 1, max: 1 };
            options[options.length - 1].push({ atom, ...bounds });
        }
        if (inGroup) fail("a pattern has an unmatched '('");
        return { options };
    };
    return alternation(false);
}

const nullableAlt = (alt: Alt): boolean => alt.options.some(option => option.every(nullableItem));
function nullableItem(item: Item): boolean {
    if (item.min === 0) return true;
    if (item.atom.kind === "assert") return true;
    if (item.atom.kind === "group") return nullableAlt(item.atom.alt);
    return item.atom.nullable === true;
}
/** The characters an alternation can start with. */
function firstOfAlt(alt: Alt): CharSet {
    return alt.options.reduce((set, option) => union(set, firstOfSeq(option)), NONE);
}
function firstOfSeq(items: Item[]): CharSet {
    let set = NONE;
    for (const item of items) {
        set = union(set, firstOfItem(item));
        if (!nullableItem(item)) break;
    }
    return set;
}
function firstOfItem(item: Item): CharSet {
    if (item.atom.kind === "assert") return NONE;
    if (item.atom.kind === "group") return firstOfAlt(item.atom.alt);
    return item.atom.set;
}
/** Every character an item can match. */
function charsOfItem(item: Item): CharSet {
    if (item.atom.kind === "assert") return NONE;
    if (item.atom.kind === "set") return item.atom.set;
    return item.atom.alt.options.flat().reduce((set, inner) => union(set, charsOfItem(inner)), NONE);
}
/** The shortest and the longest string an item can match (the longest may be Infinity). */
function lengthsOfItem(item: Item): [number, number] {
    let atom: [number, number];
    if (item.atom.kind === "assert") atom = [0, 0];
    else if (item.atom.kind === "set") atom = item.atom.nullable ? [0, Infinity] : [1, 1];
    else {
        const options = item.atom.alt.options.map(option => option.reduce<[number, number]>((sum, inner) => {
            const [low, high] = lengthsOfItem(inner);
            return [sum[0] + low, sum[1] + high];
        }, [0, 0]));
        atom = [Math.min(...options.map(option => option[0])), Math.max(...options.map(option => option[1]))];
    }
    const scale = (length: number, count: number) => (length === 0 || count === 0 ? 0 : length * count);
    return [scale(atom[0], item.min), scale(atom[1], item.max)];
}
/** Whether an item can match strings of different lengths: only such an item can split a string in more than one way. */
const variable = (item: Item): boolean => { const [low, high] = lengthsOfItem(item); return low !== high; };
/** Whether an item can stretch far (longer than LARGE_COUNT characters, or without bound). */
const stretchesFar = (item: Item): boolean => lengthsOfItem(item)[1] > LARGE_COUNT;

/** A count above this is treated as unbounded. */
const LARGE_COUNT = 16;

/**
 * Check one repeated group (its count may reach 2 or more): its iterations must split a string in one way. Two
 * alternatives that can start with the same character, or an empty alternative, can split it in many ways; so can an
 * item of varying length whose characters can also start what follows it in the same iteration (or, at the end of an
 * iteration, the next one). Only a repeat that can run long (above LARGE_COUNT) makes that exponential, or a short
 * one over an item that can stretch without bound.
 */
function checkRepeatedGroup(alt: Alt, max: number): void {
    const longRepeat = max > LARGE_COUNT;
    if (alt.options.length > 1) {
        const firsts = alt.options.map(firstOfSeq);
        const emptyOption = alt.options.some(option => option.every(nullableItem));
        if (longRepeat && emptyOption) throw new UnsafePattern("a repeated group has an alternative that can match nothing; remove it or make it match something");
        for (let i = 0; i < firsts.length; i += 1) {
            for (let j = i + 1; j < firsts.length; j += 1) {
                if (overlaps(firsts[i], firsts[j]) && (longRepeat || max > 4)) {
                    throw new UnsafePattern("a repeated group has alternatives that can start the same way (such as (a|ab)*); make them start differently");
                }
            }
        }
    }
    const wrap = firstOfAlt(alt);
    for (const option of alt.options) {
        option.forEach((item, index) => {
            if (!variable(item)) return;
            let follow = NONE;
            let rest = index + 1;
            for (; rest < option.length; rest += 1) {
                follow = union(follow, firstOfItem(option[rest]));
                if (!nullableItem(option[rest])) break;
            }
            if (rest >= option.length) follow = union(follow, wrap);
            if (!overlaps(charsOfItem(item), follow)) return;
            if (longRepeat || stretchesFar(item)) {
                throw new UnsafePattern("a repeated group holds a repeat that can also match the start of what follows it (such as (a+)+ or (\\d+\\d)+); "
                    + "write it so each repeat stops at a different character");
            }
        });
    }
}

function checkAlt(alt: Alt): void {
    for (const item of alt.options.flat()) {
        if (item.atom.kind !== "group") continue;
        if (item.max >= 2) checkRepeatedGroup(item.atom.alt, item.max);
        checkAlt(item.atom.alt);
    }
}

/**
 * Why a schema's regular expression (a `pattern`, or a `patternProperties` name) could take exponential time on a
 * small input, or null when it cannot in the ways checked (adversarial review SF-5 and its verification; no regex
 * engine is added). It is parsed, and each group that can repeat is checked: its alternatives must start with
 * different characters (all of each alternative's possible first characters, nested groups included), and an item
 * of varying length in it must not be able to match the start of what follows it. Fixed counts ({2}) never vary, so
 * ^([0-9]{2}-){2}[0-9]{2}$ is accepted; ^((a|b)|aa)+$ and ^(a+)+$ are refused. Also refused: a pattern longer than
 * SCHEMA_PATTERN_MAX_LENGTH, unmatched parentheses or classes, and inline flags. Repeats side by side (a*a*) are
 * accepted: their cost grows as a power of the input, not exponentially (a known limit). Pure.
 */
export function unsafeSchemaPattern(pattern: string): string | null {
    if (pattern.length > SCHEMA_PATTERN_MAX_LENGTH) return `a pattern may have at most ${SCHEMA_PATTERN_MAX_LENGTH} characters`;
    try {
        checkAlt(parsePattern(pattern));
        return null;
    } catch (error) {
        if (error instanceof UnsafePattern) return error.message;
        throw error;
    }
}

function refuseUnsafePattern(pattern: string, at: string): void {
    const reason = unsafeSchemaPattern(pattern);
    if (reason !== null) throw new WorkflowSchemaError(`unsafe pattern: ${reason}`, at);
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
            if (key === "patternProperties") {
                for (const name of Object.keys(value)) refuseUnsafePattern(name, `${at}.${name}`);
            }
            out.push([key, Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalizeSchema(item, `${at}.${name}`)]))]);
        } else {
            if (key === "pattern" && typeof value === "string") refuseUnsafePattern(value, at);
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
