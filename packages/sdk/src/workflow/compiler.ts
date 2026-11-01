import { parseDocument } from "yaml";
import { describeCronAt, normalizeCronAtInput } from "../cron-at.js";

/**
 * Workflow definitions.
 *
 * The document shape is the general `kind: Workflow` shape (PR 116): a named,
 * versioned graph of `states`, entered at `initial`, ending in `terminal`
 * states. This MVP executes three state types: `script`, `wait` (a durable
 * timer, which is how a workflow polls or repeats) and `terminal`, with
 * transitions written as `transition.next`. Every other state type and
 * `transition.handler` are refused with a clear "not supported yet" error,
 * so documents written for later versions fail loudly here rather than run
 * differently.
 */

export const WORKFLOW_API_VERSION = "pilotswarm.dev/v1alpha1";
export const WORKFLOW_KIND = "Workflow";
export const WORKFLOW_MAX_STATES = 100;
export const SCRIPT_STATE_DEFAULT_TIMEOUT_SECONDS = 300;
export const SCRIPT_STATE_MAX_TIMEOUT_SECONDS = 3_600;
export const WORKFLOW_MAX_YAML_BYTES = 256 * 1024;
export const WORKFLOW_TERMINAL_OUTCOMES = ["succeeded", "blocked", "failed", "cancelled"] as const;
/** The shortest wait a document may declare, unless PILOTSWARM_WORKFLOW_MIN_WAIT_SECONDS lowers it. */
export const WORKFLOW_WAIT_MIN_SECONDS = 60;
export const WORKFLOW_WAIT_MAX_SECONDS = 7 * 24 * 60 * 60;
/** The one outcome a wait state has: its time passed. */
export const WORKFLOW_WAIT_OUTCOME = "elapsed";

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

/**
 * A clock time to wait for, in the fields the agent `cron_at` tool uses:
 * `minute` alone is hourly; with `hour`, daily; add `dayOfWeek` (0-6,
 * Sunday 0) for weekly or `dayOfMonth` (1-31) for monthly. `tz` is an IANA zone.
 */
export interface WorkflowWaitAt {
    minute: number;
    hour?: number;
    dayOfWeek?: number;
    dayOfMonth?: number;
    tz: string;
}

/**
 * A durable timer: no process runs and no model is called while it waits.
 * It waits either `seconds`, or until the next clock time `at`.
 */
export interface WorkflowWaitState {
    id: string;
    type: "wait";
    seconds?: number;
    at?: WorkflowWaitAt;
    /** `{ elapsed: <state id> }`: where the run goes when the time has passed. */
    next: Record<typeof WORKFLOW_WAIT_OUTCOME, string>;
}

export type WorkflowState = WorkflowScriptState | WorkflowWaitState | WorkflowTerminalState;

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

export interface CompileWorkflowOptions {
    /** The shortest wait allowed. Default: workflowMinWaitSeconds(). */
    minWaitSeconds?: number;
}

/**
 * The shortest wait a document may declare: 60 seconds, or a lower whole
 * number of seconds (at least 1) set in PILOTSWARM_WORKFLOW_MIN_WAIT_SECONDS
 * for development and tests.
 */
export function workflowMinWaitSeconds(env: Record<string, string | undefined> = process.env): number {
    const raw = env.PILOTSWARM_WORKFLOW_MIN_WAIT_SECONDS;
    if (raw === undefined || raw.trim() === "") return WORKFLOW_WAIT_MIN_SECONDS;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 1 ? Math.min(value, WORKFLOW_WAIT_MAX_SECONDS) : WORKFLOW_WAIT_MIN_SECONDS;
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

const WAIT_AT_KEYS = new Set(["minute", "hour", "day_of_week", "day_of_month", "tz"]);

function compileWaitAt(value: unknown, path: string): WorkflowWaitAt {
    const raw = requireObject(value, path);
    for (const key of Object.keys(raw)) {
        if (!WAIT_AT_KEYS.has(key)) fail(`${path}.${key} is not a field of a clock wait; use minute, hour, day_of_week, day_of_month and tz.`);
    }
    for (const key of ["minute", "hour", "day_of_week", "day_of_month"]) {
        if (raw[key] !== undefined && typeof raw[key] !== "number") fail(`${path}.${key} must be a number.`);
    }
    const normalized = normalizeCronAtInput({
        minute: raw.minute as number | undefined,
        hour: raw.hour as number | undefined,
        day_of_week: raw.day_of_week as number | undefined,
        day_of_month: raw.day_of_month as number | undefined,
        tz: typeof raw.tz === "string" ? raw.tz : undefined,
        reason: "workflow wait",
    });
    if (!normalized.ok) fail(normalized.error.replace(/^cron_at /, `${path} `).replace(/cron_at /g, ""));
    const { minute, hour, dayOfWeek, dayOfMonth, tz } = normalized.schedule;
    return {
        minute,
        ...(hour !== undefined ? { hour } : {}),
        ...(dayOfWeek !== undefined ? { dayOfWeek } : {}),
        ...(dayOfMonth !== undefined ? { dayOfMonth } : {}),
        tz,
    };
}

/** How a wait reads in the views: "10 min", or "daily at 02:00 America/Los_Angeles". */
export function describeWorkflowWait(state: Pick<WorkflowWaitState, "seconds" | "at">): string {
    if (state.at) return describeCronAt(state.at);
    const seconds = state.seconds ?? 0;
    if (seconds > 0 && seconds % 86_400 === 0) return `${seconds / 86_400} d`;
    if (seconds > 0 && seconds % 3_600 === 0) return `${seconds / 3_600} h`;
    if (seconds > 0 && seconds % 60 === 0) return `${seconds / 60} min`;
    return `${seconds} s`;
}

function compileWaitState(id: string, state: JsonObject, stateIds: ReadonlySet<string>, minSeconds: number): WorkflowWaitState {
    const path = `states.${id}`;
    const hasSeconds = state.seconds !== undefined;
    const hasAt = state.at !== undefined;
    if (hasSeconds === hasAt) fail(`${path} must declare exactly one of seconds or at.`);
    let timing: { seconds: number } | { at: WorkflowWaitAt };
    if (hasAt) {
        timing = { at: compileWaitAt(state.at, `${path}.at`) };
    } else {
        const seconds = state.seconds;
        if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < minSeconds || seconds > WORKFLOW_WAIT_MAX_SECONDS) {
            fail(`${path}.seconds must be an integer from ${minSeconds} to ${WORKFLOW_WAIT_MAX_SECONDS}.`);
        }
        timing = { seconds };
    }
    if (state.completion !== undefined) fail(`${path} is a wait state; it has no completion outcomes (its one outcome is '${WORKFLOW_WAIT_OUTCOME}').`);
    const transition = requireObject(state.transition, `${path}.transition`);
    if (transition.handler !== undefined) {
        fail(`${path}.transition.handler is not supported yet; declare transition.next instead.`, "WORKFLOW_TRANSITION_HANDLER_UNSUPPORTED");
    }
    let target: string;
    if (typeof transition.next === "string") {
        target = requireText(transition.next, `${path}.transition.next`);
    } else {
        const rawNext = requireObject(transition.next, `${path}.transition.next`);
        const keys = Object.keys(rawNext);
        if (keys.length !== 1 || keys[0] !== WORKFLOW_WAIT_OUTCOME) {
            fail(`${path}.transition.next must be a state id, or { ${WORKFLOW_WAIT_OUTCOME}: <state id> }.`);
        }
        target = requireText(rawNext[WORKFLOW_WAIT_OUTCOME], `${path}.transition.next.${WORKFLOW_WAIT_OUTCOME}`);
    }
    if (!stateIds.has(target)) fail(`${path}.transition.next references unknown state '${target}'.`);
    if (target === id) fail(`${path}.transition.next must lead to another state.`);
    return { id, type: "wait", ...timing, next: { [WORKFLOW_WAIT_OUTCOME]: target } as WorkflowWaitState["next"] };
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

/** `${...}` inside a `{ }` flow mapping must be quoted; this is the usual cause of a parse error. */
function yamlHint(yaml: string): string {
    return /\{[^\n]*\$\{/.test(yaml) ? ' Quote ${...} expressions written inside { } (for example output: "${states.x.result}").' : "";
}

/** Compile and validate one `kind: Workflow` document. */
export function compileWorkflow(yaml: string, options: CompileWorkflowOptions = {}): CompiledWorkflow {
    const minWaitSeconds = options.minWaitSeconds ?? workflowMinWaitSeconds();
    if (typeof yaml !== "string" || !yaml.trim()) fail("Workflow YAML must be a non-empty string.");
    if (Buffer.byteLength(yaml, "utf8") > WORKFLOW_MAX_YAML_BYTES) {
        fail(`Workflow YAML must be at most ${WORKFLOW_MAX_YAML_BYTES} bytes.`);
    }
    let parsed: unknown;
    try {
        const document = parseDocument(yaml, { prettyErrors: false, strict: true, uniqueKeys: true });
        if (document.errors.length > 0) fail(`Workflow YAML is invalid: ${document.errors[0].message}${yamlHint(yaml)}`, "WORKFLOW_YAML_INVALID");
        parsed = document.toJS({ maxAliasCount: 50 });
    } catch (error) {
        if (error instanceof WorkflowCompileError) throw error;
        fail(`Workflow YAML is invalid: ${error instanceof Error ? error.message : String(error)}${yamlHint(yaml)}`, "WORKFLOW_YAML_INVALID");
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
        else if (type === "wait") states[id] = compileWaitState(id, state, stateIds, minWaitSeconds);
        else if (type === "terminal") states[id] = compileTerminalState(id, state, name, stateIds);
        else if (DEFERRED_STATE_TYPES.has(type)) fail(`states.${id}.type '${type}' is not supported yet; this version runs script, wait and terminal states.`, "WORKFLOW_STATE_TYPE_UNSUPPORTED");
        else fail(`states.${id}.type '${type}' is not a workflow state type.`, "WORKFLOW_STATE_TYPE_UNSUPPORTED");
    }
    if (states[initial].type === "terminal") fail("initial must be a script or wait state.");
    // A workflow ends at a terminal state, or runs until it is cancelled; a
    // loop that never waits would only spin, so it needs a wait to go on forever.
    const values = Object.values(states);
    if (!values.some((state) => state.type === "terminal" || state.type === "wait")) {
        fail("states must include a terminal state, or a wait state for a workflow that runs until it is cancelled.");
    }

    return { name, version, initial, inputs, configuration, states };
}

/** Whether a compiled workflow has a wait state (it can run until cancelled). */
export function workflowHasWaits(workflow: CompiledWorkflow): boolean {
    return Object.values(workflow.states).some((state) => state.type === "wait");
}

/** Whether a compiled workflow has script states. */
export function workflowUsesScripts(workflow: CompiledWorkflow): boolean {
    return Object.values(workflow.states).some((state) => state.type === "script");
}

/**
 * State types an operator turns on with PILOTSWARM_WORKFLOW_STATE_TYPES. Only
 * types that run something are listed; `wait` and `terminal` run nothing and
 * are always allowed. New types join this list as they ship.
 */
export const WORKFLOW_RUNNABLE_STATE_TYPES = ["script"] as const;
export type WorkflowRunnableStateType = typeof WORKFLOW_RUNNABLE_STATE_TYPES[number];

/** The runnable state types a workflow uses, in a stable order. */
export function workflowRunnableStateTypes(workflow: CompiledWorkflow): WorkflowRunnableStateType[] {
    const used = new Set(Object.values(workflow.states).map((state) => state.type as string));
    return WORKFLOW_RUNNABLE_STATE_TYPES.filter((type) => used.has(type));
}

/** Why this worker will not run the workflow, or null when it will. */
export function workflowNotRunnableReason(workflow: CompiledWorkflow, allowed: ReadonlySet<string>): string | null {
    if (allowed.size === 0) return WORKFLOWS_DISABLED_MESSAGE;
    const missing = workflowRunnableStateTypes(workflow).filter((type) => !allowed.has(type));
    return missing.length ? workflowStateTypesDisabledMessage(missing) : null;
}

export const WORKFLOWS_DISABLED_MESSAGE =
    "Workflows are not enabled on this worker. An operator enables them by listing the state types to run in "
    + "PILOTSWARM_WORKFLOW_STATE_TYPES (for example 'script'), or the worker option workflows.stateTypes.";

export function workflowStateTypesDisabledMessage(types: readonly string[]): string {
    const list = types.map((type) => `'${type}'`).join(", ");
    return `This workflow uses state type${types.length === 1 ? "" : "s"} ${list}, which this worker does not run. `
        + `An operator adds ${types.length === 1 ? "it" : "them"} to PILOTSWARM_WORKFLOW_STATE_TYPES (or the worker option workflows.stateTypes)`
        + (types.includes("script") ? "; script states run as processes on the worker." : ".");
}
