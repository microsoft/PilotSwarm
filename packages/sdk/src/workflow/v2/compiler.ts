import { parseDocument } from "yaml";
import { validateBindingTemplate, WorkflowBindingError } from "./bindings.js";
import { canonicalJson, isJsonObject, isStorableText, sha256Hex, WorkflowJsonError, type JsonValue } from "./json.js";
import { normalizeSchema, SCHEMA_NAME_PATTERN, WorkflowSchemaError, WorkflowSchemaSet } from "./schema.js";

/**
 * Workflow v2 compiler: YAML -> diagnostics and an immutable, hashed IR.
 *
 * Compilation never executes anything. An invalid document still yields a
 * stable YAML hash and field-level diagnostics, so a draft can be stored and
 * reviewed; only a valid document produces IR. The runtime interprets the
 * stored IR of a published revision and never recompiles its YAML, so a
 * compiler change cannot alter an admitted run.
 */

export const WORKFLOW_V2_API_VERSION = "pilotswarm.dev/v2-draft";
export const WORKFLOW_V2_KIND = "Workflow";
export const WORKFLOW_V2_IR_VERSION = 1;
export const WORKFLOW_V2_MAX_YAML_BYTES = 256 * 1024;
export const WORKFLOW_V2_MAX_NODES = 100;
export const WORKFLOW_V2_DEFAULT_MAX_NODE_EXECUTIONS = 1_000;
export const WORKFLOW_V2_MAX_NODE_EXECUTIONS = 10_000;
export const SCRIPT_DEFAULT_TIMEOUT_SECONDS = 300;
export const SCRIPT_MAX_TIMEOUT_SECONDS = 3_600;
export const TERMINAL_OUTCOMES = ["succeeded", "blocked", "failed", "cancelled"] as const;
/** Runtime error codes (D05 plus execution_failed for a script that crashed or exited non-zero). */
export const RUNTIME_ERROR_CODES = [
    "invalid_input", "invalid_output", "timed_out", "cancelled", "forbidden", "unavailable",
    "unsupported_contract", "delivery_failed", "budget_exceeded", "needs_input", "execution_failed",
] as const;
/** The catch route a runtime error takes when its own code has no route. */
export const FAILURE_ROUTE = "failure";
/** Node types this build compiles. Others are refused explicitly, never run differently. */
export const SUPPORTED_NODE_TYPES = ["script", "terminal"] as const;
const KNOWN_NODE_TYPES = ["script", "terminal", "wait", "messaging", "agent", "parallel", "join"];

export type TerminalOutcome = typeof TERMINAL_OUTCOMES[number];
export type RuntimeErrorCode = typeof RUNTIME_ERROR_CODES[number];

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const V2_MARKER = /^apiVersion:\s*["']?pilotswarm\.dev\/v2-draft["']?\s*(?:#.*)?$/m;

export interface WorkflowDiagnostic {
    severity: "error" | "warning";
    code: string;
    path: string;
    message: string;
    line?: number;
}

export interface WorkflowIRScript {
    id: string;
    type: "script";
    description: string | null;
    source: string;
    timeoutSeconds: number;
    hasInput: boolean;
    input: JsonValue;
    inputSchema: string | null;
    outputSchema: string | null;
    /** Business outcomes the script may report, each with a route. */
    outcomes: string[];
    /** Route label -> target node. Includes runtime routes (failure and error codes). */
    next: Record<string, string>;
}

export interface WorkflowIRTerminal {
    id: string;
    type: "terminal";
    description: string | null;
    outcome: TerminalOutcome;
    summary: string | null;
    hasOutput: boolean;
    output: JsonValue;
    /** This terminal's own contract. A succeeded terminal must also satisfy the workflow's outputSchema. */
    outputSchema: string | null;
}

export type WorkflowIRNode = WorkflowIRScript | WorkflowIRTerminal;

export interface WorkflowIR {
    irVersion: typeof WORKFLOW_V2_IR_VERSION;
    apiVersion: typeof WORKFLOW_V2_API_VERSION;
    name: string;
    version: string;
    description: string | null;
    initial: string;
    initialInput: JsonValue;
    inputsSchema: string | null;
    /** The workflow's output contract; every succeeded terminal's output must satisfy it. */
    outputSchema: string | null;
    limits: { maxNodeExecutions: number };
    schemaDefs: Record<string, JsonValue>;
    nodes: Record<string, WorkflowIRNode>;
}

export interface WorkflowCompileResult {
    valid: boolean;
    diagnostics: WorkflowDiagnostic[];
    yamlSha256: string;
    name: string | null;
    version: string | null;
    ir: WorkflowIR | null;
    irSha256: string | null;
}

/** True when the text declares the v2 apiVersion (used to route spawn_workflow; legacy YAML keeps its path). */
export function declaresWorkflowV2(yaml: string): boolean {
    return typeof yaml === "string" && V2_MARKER.test(yaml);
}

export function isRuntimeRoute(label: string): boolean {
    return label === FAILURE_ROUTE || (RUNTIME_ERROR_CODES as readonly string[]).includes(label);
}

class Diagnostics {
    readonly items: WorkflowDiagnostic[] = [];
    error(code: string, path: string, message: string, line?: number): void {
        this.items.push({ severity: "error", code, path, message, ...(line ? { line } : {}) });
    }
    warning(code: string, path: string, message: string): void {
        this.items.push({ severity: "warning", code, path, message });
    }
    get failed(): boolean { return this.items.some(item => item.severity === "error"); }
}

function lineOf(yaml: string, offset: number | undefined): number | undefined {
    if (typeof offset !== "number" || offset < 0) return undefined;
    let line = 1;
    for (let index = 0; index < offset && index < yaml.length; index += 1) if (yaml.charCodeAt(index) === 10) line += 1;
    return line;
}

function checkKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, diagnostics: Diagnostics): void {
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) diagnostics.error("WORKFLOW_FIELD_UNKNOWN", `${path}.${key}`, `'${key}' is not a field of ${path} (allowed: ${allowed.join(", ")}).`);
    }
}

function optionalText(value: unknown, path: string, diagnostics: Diagnostics): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") { diagnostics.error("WORKFLOW_FIELD_INVALID", path, `${path} must be a string.`); return null; }
    return value.trim() || null;
}

/** The template as JSON when its bindings are valid; null (with a diagnostic) otherwise. */
function bindingValue(template: unknown, path: string, diagnostics: Diagnostics): JsonValue {
    try {
        return validateBindingTemplate(template, path);
    } catch (error) {
        if (error instanceof WorkflowBindingError || error instanceof WorkflowJsonError) {
            diagnostics.error(error.code, path, error.message);
            return null;
        }
        throw error;
    }
}

function isStringList(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === "string");
}

interface SchemaCollector {
    defs: Record<string, JsonValue>;
    declared: Set<string>;
}

/**
 * A node/root schema field: `{ $ref: "#/schemas/X" }` names X; a mapping or a
 * boolean becomes a generated definition. Only an omitted field means "no
 * contract"; an explicit null is an error, never a disabled check.
 */
function schemaField(value: unknown, generatedName: string, path: string, schemas: SchemaCollector, diagnostics: Diagnostics): string | null {
    if (value === undefined) return null;
    if (value === null) {
        diagnostics.error("WORKFLOW_SCHEMA_INVALID", path, `${path} is null; give a JSON Schema (a mapping or true/false) or omit the field.`);
        return null;
    }
    if (isJsonObject(value) && Object.keys(value).length === 1 && typeof value.$ref === "string" && value.$ref.startsWith("#/schemas/")) {
        const name = value.$ref.slice("#/schemas/".length);
        if (!schemas.declared.has(name)) {
            diagnostics.error("WORKFLOW_SCHEMA_UNKNOWN", `${path}.$ref`, `schema '${name}' is not declared under schemas.`);
            return null;
        }
        return name;
    }
    try {
        schemas.defs[generatedName] = normalizeSchema(value, path);
        return generatedName;
    } catch (error) {
        if (error instanceof WorkflowSchemaError) { diagnostics.error(error.code, error.path, error.message); return null; }
        throw error;
    }
}

function compileScript(id: string, raw: Record<string, unknown>, nodeIds: ReadonlySet<string>, schemas: SchemaCollector, diagnostics: Diagnostics): WorkflowIRScript | null {
    const path = `states.${id}`;
    checkKeys(raw, ["type", "description", "runtime", "source", "timeoutSeconds", "input", "inputSchema", "outputSchema", "outcomes", "transition"], path, diagnostics);
    if (raw.runtime !== undefined && raw.runtime !== "node") {
        diagnostics.error("WORKFLOW_RUNTIME_UNSUPPORTED", `${path}.runtime`, "workflow v2 scripts run as Node ES modules; runtime must be 'node' when given.");
    }
    const source = typeof raw.source === "string" && raw.source.trim() ? raw.source : null;
    if (!source) diagnostics.error("WORKFLOW_FIELD_REQUIRED", `${path}.source`, "a script needs non-empty source.");
    let timeoutSeconds = SCRIPT_DEFAULT_TIMEOUT_SECONDS;
    if (raw.timeoutSeconds !== undefined) {
        if (typeof raw.timeoutSeconds !== "number" || !Number.isInteger(raw.timeoutSeconds)
            || raw.timeoutSeconds < 1 || raw.timeoutSeconds > SCRIPT_MAX_TIMEOUT_SECONDS) {
            diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.timeoutSeconds`, `timeoutSeconds must be an integer from 1 to ${SCRIPT_MAX_TIMEOUT_SECONDS}.`);
        } else timeoutSeconds = raw.timeoutSeconds;
    }
    const hasInput = Object.hasOwn(raw, "input");
    const input = hasInput ? bindingValue(raw.input, `${path}.input`, diagnostics) : null;
    const inputSchema = schemaField(raw.inputSchema, `node.${id}.input`, `${path}.inputSchema`, schemas, diagnostics);
    const outputSchema = schemaField(raw.outputSchema, `node.${id}.output`, `${path}.outputSchema`, schemas, diagnostics);

    const next: Record<string, string> = {};
    if (!isJsonObject(raw.transition)) {
        diagnostics.error("WORKFLOW_FIELD_REQUIRED", `${path}.transition`, "a script needs transition.next.");
    } else {
        checkKeys(raw.transition, ["next", "function"], `${path}.transition`, diagnostics);
        if (raw.transition.function !== undefined) {
            diagnostics.error("WORKFLOW_FEATURE_UNSUPPORTED", `${path}.transition.function`, "transition.function is not supported by this build yet; route on the script's outcome with transition.next.");
        }
        if (!isJsonObject(raw.transition.next) || Object.keys(raw.transition.next).length === 0) {
            diagnostics.error("WORKFLOW_FIELD_REQUIRED", `${path}.transition.next`, "transition.next must map at least one route label to a state.");
        } else {
            for (const [label, target] of Object.entries(raw.transition.next)) {
                if (!ID_PATTERN.test(label)) diagnostics.error("WORKFLOW_ROUTE_INVALID", `${path}.transition.next.${label}`, "route labels use a letter followed by letters, digits, '_' or '-'.");
                if (typeof target !== "string" || !nodeIds.has(target)) {
                    diagnostics.error("WORKFLOW_TARGET_UNKNOWN", `${path}.transition.next.${label}`, `route '${label}' targets unknown state '${String(target)}'.`);
                } else next[label] = target;
            }
        }
    }
    let outcomes: string[];
    if (raw.outcomes !== undefined) {
        if (!isStringList(raw.outcomes) || raw.outcomes.length === 0 || !raw.outcomes.every(item => ID_PATTERN.test(item))
            || new Set(raw.outcomes).size !== raw.outcomes.length) {
            diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.outcomes`, "outcomes must be a non-empty list of distinct route labels.");
            outcomes = [];
        } else {
            outcomes = raw.outcomes;
            for (const outcome of outcomes) {
                if (!Object.hasOwn(next, outcome)) diagnostics.error("WORKFLOW_ROUTE_MISSING", `${path}.transition.next`, `declared outcome '${outcome}' has no route.`);
            }
        }
    } else {
        outcomes = Object.keys(next).filter(label => !isRuntimeRoute(label));
    }
    if (outcomes.length === 0) diagnostics.error("WORKFLOW_ROUTE_MISSING", `${path}.transition.next`, "a script needs at least one business outcome route.");
    if (!Object.hasOwn(next, FAILURE_ROUTE) && !RUNTIME_ERROR_CODES.some(code => Object.hasOwn(next, code))) {
        diagnostics.warning("WORKFLOW_FAILURE_UNHANDLED", `${path}.transition.next`,
            "no failure route: a runtime error at this state (crash, timeout, invalid output) ends the run as failed.");
    }
    if (!source) return null;
    return {
        id, type: "script", description: optionalText(raw.description, `${path}.description`, diagnostics),
        source, timeoutSeconds, hasInput, input,
        inputSchema, outputSchema, outcomes, next,
    };
}

function compileTerminal(id: string, raw: Record<string, unknown>, schemas: SchemaCollector, diagnostics: Diagnostics): WorkflowIRTerminal | null {
    const path = `states.${id}`;
    checkKeys(raw, ["type", "description", "outcome", "output", "summary", "outputSchema"], path, diagnostics);
    const outcome = raw.outcome;
    if (!isTerminalOutcome(outcome)) {
        diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.outcome`, `outcome must be one of ${TERMINAL_OUTCOMES.join(", ")}.`);
        return null;
    }
    const hasOutput = Object.hasOwn(raw, "output");
    const output = hasOutput ? bindingValue(raw.output, `${path}.output`, diagnostics) : null;
    const own = schemaField(raw.outputSchema, `node.${id}.output`, `${path}.outputSchema`, schemas, diagnostics);
    return {
        id, type: "terminal", description: optionalText(raw.description, `${path}.description`, diagnostics), outcome,
        summary: optionalText(raw.summary, `${path}.summary`, diagnostics),
        hasOutput, output,
        outputSchema: own,
    };
}

function checkGraph(ir: { initial: string; nodes: Record<string, WorkflowIRNode> }, diagnostics: Diagnostics): void {
    const successors = (id: string): string[] => {
        const node = ir.nodes[id];
        return node && node.type === "script" ? Object.values(node.next) : [];
    };
    const reachable = new Set<string>();
    const stack = [ir.initial];
    while (stack.length) {
        const id = stack.pop()!;
        if (reachable.has(id) || !ir.nodes[id]) continue;
        reachable.add(id);
        stack.push(...successors(id));
    }
    for (const id of Object.keys(ir.nodes)) {
        if (!reachable.has(id)) diagnostics.warning("WORKFLOW_STATE_UNREACHABLE", `states.${id}`, `state '${id}' is not reachable from initial.`);
    }
    // Every reachable state must be able to reach a terminal.
    const canFinish = new Set(Object.values(ir.nodes).filter(node => node.type === "terminal").map(node => node.id));
    let changed = true;
    while (changed) {
        changed = false;
        for (const id of reachable) {
            if (!canFinish.has(id) && successors(id).some(target => canFinish.has(target))) { canFinish.add(id); changed = true; }
        }
    }
    for (const id of reachable) {
        if (!canFinish.has(id)) diagnostics.error("WORKFLOW_NO_TERMINAL_PATH", `states.${id}`, `state '${id}' cannot reach a terminal state.`);
    }
}

/** Compile one v2 document. Never throws for document content; returns diagnostics instead. */
export function compileWorkflowV2(yaml: string): WorkflowCompileResult {
    const diagnostics = new Diagnostics();
    if (typeof yaml !== "string") throw new TypeError("Workflow YAML must be a string.");
    const yamlSha256 = sha256Hex(yaml);
    const result = (name: string | null, version: string | null, ir: WorkflowIR | null): WorkflowCompileResult => {
        const valid = Boolean(ir) && !diagnostics.failed;
        return {
            valid, diagnostics: diagnostics.items, yamlSha256, name, version,
            ir: valid ? ir : null, irSha256: valid && ir ? sha256Hex(canonicalJson(ir)) : null,
        };
    };
    if (!yaml.trim()) { diagnostics.error("WORKFLOW_YAML_EMPTY", "$", "Workflow YAML is empty."); return result(null, null, null); }
    if (Buffer.byteLength(yaml, "utf8") > WORKFLOW_V2_MAX_YAML_BYTES) {
        diagnostics.error("WORKFLOW_YAML_TOO_LARGE", "$", `Workflow YAML must be at most ${WORKFLOW_V2_MAX_YAML_BYTES} bytes.`);
        return result(null, null, null);
    }
    let parsed: unknown;
    const document = parseDocument(yaml, { prettyErrors: false, strict: true, uniqueKeys: true });
    for (const error of document.errors) diagnostics.error("WORKFLOW_YAML_INVALID", "$", error.message, lineOf(yaml, error.pos?.[0]));
    for (const warning of document.warnings) diagnostics.warning("WORKFLOW_YAML_WARNING", "$", warning.message);
    if (document.errors.length) return result(null, null, null);
    try {
        parsed = document.toJS({ maxAliasCount: 50 });
    } catch (error) {
        diagnostics.error("WORKFLOW_YAML_INVALID", "$", error instanceof Error ? error.message : String(error));
        return result(null, null, null);
    }
    if (!isJsonObject(parsed)) { diagnostics.error("WORKFLOW_FIELD_INVALID", "$", "a workflow document must be a mapping."); return result(null, null, null); }
    const root: Record<string, unknown> = parsed;
    checkKeys(root, ["apiVersion", "kind", "metadata", "description", "inputs", "outputSchema", "initial", "initialInput", "limits", "schemas", "states"], "$", diagnostics);
    if (root.apiVersion !== WORKFLOW_V2_API_VERSION) diagnostics.error("WORKFLOW_API_VERSION", "apiVersion", `apiVersion must be '${WORKFLOW_V2_API_VERSION}'.`);
    if (root.kind !== WORKFLOW_V2_KIND) diagnostics.error("WORKFLOW_KIND", "kind", `kind must be '${WORKFLOW_V2_KIND}'.`);

    let name: string | null = null;
    let version: string | null = null;
    if (!isJsonObject(root.metadata)) diagnostics.error("WORKFLOW_FIELD_REQUIRED", "metadata", "metadata with name and version is required.");
    else {
        checkKeys(root.metadata, ["name", "version", "description"], "metadata", diagnostics);
        if (typeof root.metadata.name === "string" && root.metadata.name.trim() && root.metadata.name.length <= 128 && isStorableText(root.metadata.name)) {
            name = root.metadata.name.trim();
        } else diagnostics.error("WORKFLOW_FIELD_INVALID", "metadata.name", "metadata.name must be a non-empty string of at most 128 characters.");
        if (typeof root.metadata.version === "string" && SEMVER.test(root.metadata.version)) version = root.metadata.version;
        else diagnostics.error("WORKFLOW_SEMVER_INVALID", "metadata.version", "metadata.version must be a semantic version string such as \"1.0.0\" (quote it in YAML).");
    }

    const schemas: SchemaCollector = { defs: {}, declared: new Set() };
    if (root.schemas !== undefined) {
        if (!isJsonObject(root.schemas)) diagnostics.error("WORKFLOW_FIELD_INVALID", "schemas", "schemas must map names to JSON Schemas.");
        else for (const [schemaName, schema] of Object.entries(root.schemas)) {
            if (!SCHEMA_NAME_PATTERN.test(schemaName)) {
                diagnostics.error("WORKFLOW_SCHEMA_NAME", `schemas.${schemaName}`, "schema names use a letter followed by up to 63 letters, digits, '_' or '-'.");
                continue;
            }
            schemas.declared.add(schemaName);
        }
        if (isJsonObject(root.schemas)) for (const schemaName of schemas.declared) {
            try { schemas.defs[schemaName] = normalizeSchema(root.schemas[schemaName], `schemas.${schemaName}`); }
            catch (error) {
                if (error instanceof WorkflowSchemaError) diagnostics.error(error.code, error.path, error.message);
                else throw error;
            }
        }
    }

    let inputsSchema: string | null = null;
    if (root.inputs !== undefined) {
        if (!isJsonObject(root.inputs) || !Object.hasOwn(root.inputs, "schema")) {
            diagnostics.error("WORKFLOW_FIELD_INVALID", "inputs", "inputs must be { schema: <JSON Schema> }.");
        } else {
            checkKeys(root.inputs, ["schema"], "inputs", diagnostics);
            inputsSchema = schemaField(root.inputs.schema, "workflow.inputs", "inputs.schema", schemas, diagnostics);
        }
    }
    const rootOutputSchema = schemaField(root.outputSchema, "workflow.output", "outputSchema", schemas, diagnostics);

    let maxNodeExecutions = WORKFLOW_V2_DEFAULT_MAX_NODE_EXECUTIONS;
    if (root.limits !== undefined) {
        if (!isJsonObject(root.limits)) diagnostics.error("WORKFLOW_FIELD_INVALID", "limits", "limits must be a mapping.");
        else {
            checkKeys(root.limits, ["maxNodeExecutions"], "limits", diagnostics);
            const value = root.limits.maxNodeExecutions;
            if (value !== undefined) {
                if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > WORKFLOW_V2_MAX_NODE_EXECUTIONS) {
                    diagnostics.error("WORKFLOW_FIELD_INVALID", "limits.maxNodeExecutions", `maxNodeExecutions must be an integer from 1 to ${WORKFLOW_V2_MAX_NODE_EXECUTIONS}.`);
                } else maxNodeExecutions = value;
            }
        }
    }
    const initialInput = Object.hasOwn(root, "initialInput") ? bindingValue(root.initialInput, "initialInput", diagnostics) : null;

    const nodes: Record<string, WorkflowIRNode> = {};
    if (!isJsonObject(root.states)) {
        diagnostics.error("WORKFLOW_FIELD_REQUIRED", "states", "states must map state ids to states.");
    } else {
        const entries = Object.entries(root.states);
        if (entries.length === 0 || entries.length > WORKFLOW_V2_MAX_NODES) {
            diagnostics.error("WORKFLOW_FIELD_INVALID", "states", `states must contain between 1 and ${WORKFLOW_V2_MAX_NODES} states.`);
        }
        const nodeIds = new Set(entries.map(([id]) => id));
        for (const [id, rawNode] of entries) {
            const path = `states.${id}`;
            if (!ID_PATTERN.test(id)) { diagnostics.error("WORKFLOW_STATE_ID", path, "state ids use a letter followed by up to 63 letters, digits, '_' or '-'."); continue; }
            if (!isJsonObject(rawNode)) { diagnostics.error("WORKFLOW_FIELD_INVALID", path, "a state must be a mapping."); continue; }
            const type = rawNode.type;
            if (type === "script") {
                const node = compileScript(id, rawNode, nodeIds, schemas, diagnostics);
                if (node) nodes[id] = node;
            } else if (type === "terminal") {
                const node = compileTerminal(id, rawNode, schemas, diagnostics);
                if (node) nodes[id] = node;
            } else if (typeof type === "string" && KNOWN_NODE_TYPES.includes(type)) {
                diagnostics.error("WORKFLOW_NODE_TYPE_UNSUPPORTED", `${path}.type`, `state type '${type}' is not supported by this build yet (supported: ${SUPPORTED_NODE_TYPES.join(", ")}).`);
            } else {
                diagnostics.error("WORKFLOW_NODE_TYPE_UNKNOWN", `${path}.type`, `'${String(type)}' is not a workflow state type.`);
            }
        }
    }
    const initial = typeof root.initial === "string" ? root.initial : "";
    if (!initial || !(isJsonObject(root.states) && Object.hasOwn(root.states, initial))) {
        diagnostics.error("WORKFLOW_INITIAL_INVALID", "initial", `initial must name a declared state (got '${String(root.initial)}').`);
    } else if (nodes[initial]?.type === "terminal") {
        diagnostics.error("WORKFLOW_INITIAL_INVALID", "initial", "initial must not be a terminal state.");
    }

    if (!diagnostics.failed) {
        try { new WorkflowSchemaSet(schemas.defs).compileAll(); }
        catch (error) {
            diagnostics.error("WORKFLOW_SCHEMA_INVALID", error instanceof WorkflowSchemaError ? error.path : "schemas",
                error instanceof Error ? error.message : String(error));
        }
    }
    if (diagnostics.failed || !name || !version) return result(name, version, null);
    checkGraph({ initial, nodes }, diagnostics);
    if (diagnostics.failed) return result(name, version, null);
    const ir: WorkflowIR = {
        irVersion: WORKFLOW_V2_IR_VERSION,
        apiVersion: WORKFLOW_V2_API_VERSION,
        name, version,
        description: optionalText(root.description, "description", diagnostics),
        initial,
        initialInput,
        inputsSchema,
        outputSchema: rootOutputSchema,
        limits: { maxNodeExecutions },
        schemaDefs: schemas.defs,
        nodes,
    };
    try { canonicalJson(ir); }
    catch (error) {
        if (error instanceof WorkflowJsonError) { diagnostics.error(error.code, error.path, error.message); return result(name, version, null); }
        throw error;
    }
    return result(name, version, ir);
}

/** Extract metadata.version without full compilation (for the one-semver rule on invalid drafts). */
export function declaredSemver(yaml: string): string | null {
    const document = parseDocument(yaml, { prettyErrors: false, strict: false, uniqueKeys: false });
    const value = document.getIn(["metadata", "version"]);
    return typeof value === "string" && SEMVER.test(value) ? value : null;
}

class StoredShapeError extends Error {
    readonly code = "WORKFLOW_STORE_CORRUPT";
    constructor(message: string) {
        super(message);
        this.name = "StoredShapeError";
    }
}

function need(condition: boolean, message: string): asserts condition {
    if (!condition) throw new StoredShapeError(message);
}

function nullableString(value: JsonValue | undefined): value is string | null {
    return value === null || typeof value === "string";
}

function stringMap(value: JsonValue | undefined): value is Record<string, string> {
    return isJsonObject(value) && Object.values(value).every(item => typeof item === "string");
}

function stringArray(value: JsonValue | undefined): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isTerminalOutcome(value: unknown): value is TerminalOutcome {
    return typeof value === "string" && (TERMINAL_OUTCOMES as readonly string[]).includes(value);
}

/** Read stored diagnostics back with their declared shape. */
export function parseDiagnostics(value: JsonValue): WorkflowDiagnostic[] {
    need(Array.isArray(value), "stored diagnostics are not a list");
    return value.map(item => {
        need(isJsonObject(item) && (item.severity === "error" || item.severity === "warning")
            && typeof item.code === "string" && typeof item.path === "string" && typeof item.message === "string"
            && (item.line === undefined || typeof item.line === "number"), "stored diagnostic has an invalid shape");
        return {
            severity: item.severity, code: item.code, path: item.path, message: item.message,
            ...(typeof item.line === "number" ? { line: item.line } : {}),
        };
    });
}

/** Read stored IR (already hash-verified) back with its declared shape. */
export function parseWorkflowIr(value: JsonValue): WorkflowIR {
    need(isJsonObject(value), "stored IR is not an object");
    need(value.irVersion === WORKFLOW_V2_IR_VERSION, `stored IR version ${String(value.irVersion)} is not supported by this worker`);
    need(value.apiVersion === WORKFLOW_V2_API_VERSION, "stored IR has a different apiVersion");
    need(typeof value.name === "string" && typeof value.version === "string" && typeof value.initial === "string"
        && nullableString(value.description) && nullableString(value.inputsSchema) && nullableString(value.outputSchema),
        "stored IR header is invalid");
    need(isJsonObject(value.limits) && typeof value.limits.maxNodeExecutions === "number", "stored IR limits are invalid");
    need(isJsonObject(value.schemaDefs) && isJsonObject(value.nodes), "stored IR schemas or nodes are invalid");
    need(Object.hasOwn(value, "initialInput"), "stored IR has no initialInput");
    const nodes: Record<string, WorkflowIRNode> = {};
    for (const [id, node] of Object.entries(value.nodes)) {
        need(isJsonObject(node) && node.id === id && nullableString(node.description), `stored IR node ${id} is invalid`);
        if (node.type === "script") {
            need(typeof node.source === "string" && typeof node.timeoutSeconds === "number" && typeof node.hasInput === "boolean"
                && Object.hasOwn(node, "input") && nullableString(node.inputSchema) && nullableString(node.outputSchema)
                && stringArray(node.outcomes) && stringMap(node.next),
                `stored IR script ${id} is invalid`);
            nodes[id] = {
                id, type: "script", description: node.description, source: node.source, timeoutSeconds: node.timeoutSeconds,
                hasInput: node.hasInput, input: node.input, inputSchema: node.inputSchema, outputSchema: node.outputSchema,
                outcomes: node.outcomes, next: node.next,
            };
        } else if (node.type === "terminal") {
            need(isTerminalOutcome(node.outcome)
                && nullableString(node.summary) && typeof node.hasOutput === "boolean" && Object.hasOwn(node, "output")
                && nullableString(node.outputSchema), `stored IR terminal ${id} is invalid`);
            nodes[id] = {
                id, type: "terminal", description: node.description, outcome: node.outcome,
                summary: node.summary, hasOutput: node.hasOutput, output: node.output, outputSchema: node.outputSchema,
            };
        } else {
            throw new StoredShapeError(`stored IR node ${id} has unsupported type ${String(node.type)}`);
        }
    }
    need(Object.hasOwn(nodes, value.initial), "stored IR initial state is missing");
    return {
        irVersion: WORKFLOW_V2_IR_VERSION, apiVersion: WORKFLOW_V2_API_VERSION, name: value.name, version: value.version,
        description: value.description, initial: value.initial, initialInput: value.initialInput,
        inputsSchema: value.inputsSchema, outputSchema: value.outputSchema, limits: { maxNodeExecutions: value.limits.maxNodeExecutions },
        schemaDefs: value.schemaDefs, nodes,
    };
}
