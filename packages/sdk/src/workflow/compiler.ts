import { parseDocument } from "yaml";

/**
 * Workflow definitions.
 *
 * The document shape is the general `kind: Workflow` shape (PR 116): a named,
 * versioned graph of `states`, entered at `initial`, ending in `terminal`
 * states. This MVP executes two state types, `script` and `terminal`, and
 * transitions written as a `transition.next` map. Every other state type
 * and `transition.handler` are refused with a clear "not supported yet"
 * error, so documents written for later versions fail loudly here rather
 * than run differently.
 */

export const WORKFLOW_API_VERSION = "pilotswarm.dev/v1alpha1";
export const WORKFLOW_KIND = "Workflow";
export const WORKFLOW_MAX_STATES = 100;
export const SCRIPT_STATE_DEFAULT_TIMEOUT_SECONDS = 300;
export const SCRIPT_STATE_MAX_TIMEOUT_SECONDS = 3_600;
export const WORKFLOW_MAX_YAML_BYTES = 256 * 1024;
export const WORKFLOW_TERMINAL_OUTCOMES = ["succeeded", "blocked", "failed", "cancelled"] as const;

const STATE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const EXACT_EXPRESSION = /^\$\{([^{}]+)\}$/;
const DEFERRED_STATE_TYPES = new Set(["agent", "question", "action", "observed-condition"]);
const INPUT_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array"]);

export type ScriptRuntime = "node" | "python" | "powershell";
export type WorkflowTerminalOutcome = typeof WORKFLOW_TERMINAL_OUTCOMES[number];
type JsonObject = Record<string, unknown>;

export interface WorkflowScriptState {
    id: string;
    type: "script";
    runtime: ScriptRuntime;
    source: string;
    timeoutSeconds: number;
    /** The outcomes this state may return, in declaration order. */
    outcomes: string[];
    /** Outcome -> next state id. Every outcome has exactly one target. */
    next: Record<string, string>;
}

export interface WorkflowTerminalState {
    id: string;
    type: "terminal";
    outcome: WorkflowTerminalOutcome;
    summary: string;
    /** The run's result; may be one `${...}` expression (see resolveWorkflowTemplate). */
    hasOutput: boolean;
    output?: unknown;
}

export type WorkflowState = WorkflowScriptState | WorkflowTerminalState;

export interface WorkflowInputDeclaration {
    type: "string" | "number" | "integer" | "boolean" | "object" | "array";
    required?: boolean;
}

export interface CompiledWorkflow {
    name: string;
    version: string;
    initial: string;
    inputs: Record<string, WorkflowInputDeclaration>;
    configuration: JsonObject;
    states: Record<string, WorkflowState>;
}

export class WorkflowCompileError extends Error {
    constructor(message: string, readonly code = "WORKFLOW_INVALID") {
        super(message);
        this.name = "WorkflowCompileError";
    }
}

function fail(message: string, code?: string): never {
    throw new WorkflowCompileError(message, code);
}

function isObject(value: unknown): value is JsonObject {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value: unknown, path: string): JsonObject {
    if (!isObject(value)) fail(`${path} must be a mapping.`);
    return value;
}

function requireText(value: unknown, path: string): string {
    if (typeof value !== "string" || !value.trim()) fail(`${path} must be a non-empty string.`);
    return value.trim();
}

function requireOutcomes(value: unknown, path: string): string[] {
    if (!Array.isArray(value) || value.length === 0) fail(`${path} must list at least one outcome.`);
    const outcomes = value.map((item, index) => requireText(item, `${path}[${index}]`));
    if (new Set(outcomes).size !== outcomes.length) fail(`${path} must not repeat an outcome.`);
    return outcomes;
}

function parseTimeout(value: unknown, path: string): number {
    if (value === undefined || value === null) return SCRIPT_STATE_DEFAULT_TIMEOUT_SECONDS;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > SCRIPT_STATE_MAX_TIMEOUT_SECONDS) {
        fail(`${path} must be an integer from 1 to ${SCRIPT_STATE_MAX_TIMEOUT_SECONDS}.`);
    }
    return value;
}

function compileInputs(value: unknown): Record<string, WorkflowInputDeclaration> {
    if (value === undefined || value === null) return {};
    const raw = requireObject(value, "inputs");
    const inputs: Record<string, WorkflowInputDeclaration> = {};
    for (const [name, declaration] of Object.entries(raw)) {
        const decl = requireObject(declaration, `inputs.${name}`);
        const type = requireText(decl.type, `inputs.${name}.type`);
        if (!INPUT_TYPES.has(type)) fail(`inputs.${name}.type '${type}' is not supported.`, "WORKFLOW_INPUT_SCHEMA_INVALID");
        if (decl.required !== undefined && typeof decl.required !== "boolean") {
            fail(`inputs.${name}.required must be a boolean when provided.`, "WORKFLOW_INPUT_SCHEMA_INVALID");
        }
        inputs[name] = { type: type as WorkflowInputDeclaration["type"], ...(decl.required ? { required: true } : {}) };
    }
    return inputs;
}

/** Split `${a.b.c}` into its path, or null for a plain value. */
function parseExpression(value: string, path: string): string[] | null {
    const match = EXACT_EXPRESSION.exec(value);
    if (!match) {
        if (value.includes("${")) {
            fail(`${path} embeds an expression; a value may only be exactly one \${...} expression.`, "WORKFLOW_EXPRESSION_UNSUPPORTED");
        }
        return null;
    }
    const segments = match[1].split(".").map((segment) => segment.trim()).filter(Boolean);
    if (segments.length < 2 || !["inputs", "configuration", "states"].includes(segments[0])) {
        fail(`${path} expression '${value}' must start with inputs, configuration or states.`, "WORKFLOW_EXPRESSION_UNSUPPORTED");
    }
    if (segments[0] === "states" && (segments.length < 3 || segments[2] !== "result")) {
        fail(`${path} expression '${value}' must use states.<stateId>.result.`, "WORKFLOW_EXPRESSION_UNSUPPORTED");
    }
    return segments;
}

function validateTemplate(value: unknown, path: string, stateIds: ReadonlySet<string>): void {
    if (typeof value === "string") {
        const segments = parseExpression(value, path);
        if (segments?.[0] === "states" && !stateIds.has(segments[1])) fail(`${path} references unknown state '${segments[1]}'.`);
        return;
    }
    if (Array.isArray(value)) value.forEach((item, index) => validateTemplate(item, `${path}[${index}]`, stateIds));
    else if (isObject(value)) for (const [key, nested] of Object.entries(value)) validateTemplate(nested, `${path}.${key}`, stateIds);
}

function readPath(root: unknown, segments: string[], expression: string): unknown {
    let current = root;
    for (const segment of segments) {
        if (!isObject(current) || !Object.hasOwn(current, segment)) {
            throw new WorkflowCompileError(`Expression '\${${expression}}' could not resolve '${segment}'.`, "WORKFLOW_EXPRESSION_UNRESOLVED");
        }
        current = current[segment];
    }
    return current;
}

/**
 * Resolve a terminal state's `output` template. A string that is exactly one
 * `${inputs.x}`, `${configuration.x}` or `${states.<id>.result[.x]}` expression
 * is replaced by that value; anything else is returned unchanged.
 */
export function resolveWorkflowTemplate(
    value: unknown,
    path: string,
    context: { inputs: JsonObject; configuration: JsonObject; results: Record<string, unknown> },
): unknown {
    if (typeof value === "string") {
        const segments = parseExpression(value, path);
        if (!segments) return value;
        const expression = segments.join(".");
        if (segments[0] === "inputs") return readPath(context.inputs, segments.slice(1), expression);
        if (segments[0] === "configuration") return readPath(context.configuration, segments.slice(1), expression);
        if (!Object.hasOwn(context.results, segments[1])) {
            throw new WorkflowCompileError(`Expression '\${${expression}}' references state '${segments[1]}' before it ran.`, "WORKFLOW_EXPRESSION_UNRESOLVED");
        }
        return readPath({ result: context.results[segments[1]] }, segments.slice(2), expression);
    }
    if (Array.isArray(value)) return value.map((item, index) => resolveWorkflowTemplate(item, `${path}[${index}]`, context));
    if (isObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, resolveWorkflowTemplate(nested, `${path}.${key}`, context)]));
    }
    return value;
}

/** Check a run's inputs against the declared `inputs` schema. Undeclared inputs pass through. */
export function validateWorkflowInputs(workflow: CompiledWorkflow, inputs: Record<string, unknown>): void {
    for (const [name, declaration] of Object.entries(workflow.inputs)) {
        const value = inputs[name];
        if (value === undefined || value === null) {
            if (declaration.required) fail(`Input '${name}' is required.`, "WORKFLOW_INPUT_INVALID");
            continue;
        }
        const ok = declaration.type === "integer" ? Number.isInteger(value)
            : declaration.type === "array" ? Array.isArray(value)
                : declaration.type === "object" ? isObject(value)
                    : typeof value === declaration.type;
        if (!ok) fail(`Input '${name}' must be of type ${declaration.type}.`, "WORKFLOW_INPUT_INVALID");
    }
}

function compileScriptState(id: string, state: JsonObject, stateIds: ReadonlySet<string>): WorkflowScriptState {
    const path = `states.${id}`;
    const runtime = requireText(state.runtime, `${path}.runtime`);
    if (runtime !== "node" && runtime !== "python" && runtime !== "powershell") {
        fail(`${path}.runtime must be node, python or powershell.`);
    }
    const completion = requireObject(state.completion, `${path}.completion`);
    const outcomes = requireOutcomes(completion.outcomes, `${path}.completion.outcomes`);
    const transition = requireObject(state.transition, `${path}.transition`);
    if (transition.handler !== undefined) {
        fail(`${path}.transition.handler is not supported yet; declare transition.next instead.`, "WORKFLOW_TRANSITION_HANDLER_UNSUPPORTED");
    }
    const rawNext = requireObject(transition.next, `${path}.transition.next`);
    const next: Record<string, string> = {};
    for (const outcome of outcomes) {
        if (!Object.hasOwn(rawNext, outcome)) fail(`${path}.transition.next has no target for outcome '${outcome}'.`);
        const target = requireText(rawNext[outcome], `${path}.transition.next.${outcome}`);
        if (!stateIds.has(target)) fail(`${path}.transition.next.${outcome} references unknown state '${target}'.`);
        next[outcome] = target;
    }
    for (const outcome of Object.keys(rawNext)) {
        if (!outcomes.includes(outcome)) fail(`${path}.transition.next.${outcome} is not a declared outcome.`);
    }
    return {
        id,
        type: "script",
        runtime,
        source: requireText(state.source, `${path}.source`),
        timeoutSeconds: parseTimeout(state.timeoutSeconds, `${path}.timeoutSeconds`),
        outcomes,
        next,
    };
}

function compileTerminalState(id: string, state: JsonObject, name: string, stateIds: ReadonlySet<string>): WorkflowTerminalState {
    const path = `states.${id}`;
    const outcome = requireText(state.outcome, `${path}.outcome`);
    if (!(WORKFLOW_TERMINAL_OUTCOMES as readonly string[]).includes(outcome)) {
        fail(`${path}.outcome must be one of ${WORKFLOW_TERMINAL_OUTCOMES.join(", ")}.`);
    }
    const hasOutput = Object.hasOwn(state, "output");
    if (hasOutput) validateTemplate(state.output, `${path}.output`, stateIds);
    return {
        id,
        type: "terminal",
        outcome: outcome as WorkflowTerminalOutcome,
        summary: typeof state.summary === "string" && state.summary.trim()
            ? state.summary.trim()
            : `Workflow '${name}' ended with outcome '${outcome}'.`,
        hasOutput,
        ...(hasOutput ? { output: state.output } : {}),
    };
}

/** Compile and validate one `kind: Workflow` document. */
export function compileWorkflow(yaml: string): CompiledWorkflow {
    if (typeof yaml !== "string" || !yaml.trim()) fail("Workflow YAML must be a non-empty string.");
    if (Buffer.byteLength(yaml, "utf8") > WORKFLOW_MAX_YAML_BYTES) {
        fail(`Workflow YAML must be at most ${WORKFLOW_MAX_YAML_BYTES} bytes.`);
    }
    let parsed: unknown;
    try {
        const document = parseDocument(yaml, { prettyErrors: false, strict: true, uniqueKeys: true });
        if (document.errors.length > 0) fail(`Workflow YAML is invalid: ${document.errors[0].message}`, "WORKFLOW_YAML_INVALID");
        parsed = document.toJS({ maxAliasCount: 50 });
    } catch (error) {
        if (error instanceof WorkflowCompileError) throw error;
        fail(`Workflow YAML is invalid: ${error instanceof Error ? error.message : String(error)}`, "WORKFLOW_YAML_INVALID");
    }

    const root = requireObject(parsed, "workflow");
    if (root.apiVersion !== WORKFLOW_API_VERSION) fail(`apiVersion must be '${WORKFLOW_API_VERSION}'.`);
    if (root.kind !== WORKFLOW_KIND) fail(`kind must be '${WORKFLOW_KIND}'.`);
    if (root.identity !== undefined) fail("identity is not supported yet.", "WORKFLOW_IDENTITY_UNSUPPORTED");
    const metadata = requireObject(root.metadata, "metadata");
    const name = requireText(metadata.name, "metadata.name");
    const version = requireText(metadata.version, "metadata.version");
    const inputs = compileInputs(root.inputs);
    const configuration = root.configuration === undefined || root.configuration === null
        ? {}
        : requireObject(root.configuration, "configuration");

    const rawStates = requireObject(root.states, "states");
    const entries = Object.entries(rawStates);
    if (entries.length === 0 || entries.length > WORKFLOW_MAX_STATES) {
        fail(`states must contain between 1 and ${WORKFLOW_MAX_STATES} states.`);
    }
    const stateIds = new Set(entries.map(([id]) => id));
    for (const id of stateIds) {
        if (!STATE_ID_PATTERN.test(id)) fail(`states.${id} must use a letter followed by up to 63 letters, digits, '_' or '-'.`);
    }
    const initial = requireText(root.initial, "initial");
    if (!stateIds.has(initial)) fail(`initial references unknown state '${initial}'.`);

    const states: Record<string, WorkflowState> = {};
    for (const [id, rawState] of entries) {
        const state = requireObject(rawState, `states.${id}`);
        const type = requireText(state.type, `states.${id}.type`);
        if (state.next !== undefined || state.transitions !== undefined || state.events !== undefined) {
            fail(`states.${id} declares transitions outside 'transition'; use transition.next.`, "WORKFLOW_INLINE_TRANSITION_UNSUPPORTED");
        }
        if (type === "script") states[id] = compileScriptState(id, state, stateIds);
        else if (type === "terminal") states[id] = compileTerminalState(id, state, name, stateIds);
        else if (DEFERRED_STATE_TYPES.has(type)) fail(`states.${id}.type '${type}' is not supported yet; this version runs script and terminal states.`, "WORKFLOW_STATE_TYPE_UNSUPPORTED");
        else fail(`states.${id}.type '${type}' is not a workflow state type.`, "WORKFLOW_STATE_TYPE_UNSUPPORTED");
    }
    if (states[initial].type === "terminal") fail("initial must be a script state.");
    if (!Object.values(states).some((state) => state.type === "terminal")) fail("states must include at least one terminal state.");

    return { name, version, initial, inputs, configuration, states };
}

/** Whether a compiled workflow has script states (they need the worker's script switch). */
export function workflowUsesScripts(workflow: CompiledWorkflow): boolean {
    return Object.values(workflow.states).some((state) => state.type === "script");
}
