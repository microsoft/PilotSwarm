import { parseDocument } from "yaml";
import { bindingRootsOf, parseBindingExpression, validateBindingTemplate, WorkflowBindingError } from "./bindings.js";
import { canonicalJson, isJsonObject, isStorableText, sha256Hex, WorkflowJsonError, type JsonValue } from "./json.js";
import { normalizeSchema, SCHEMA_NAME_PATTERN, schemaReferences, unsafeSchemaPattern, WorkflowSchemaError, WorkflowSchemaSet } from "./schema.js";

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
/**
 * IR version this compiler writes for a workflow of script and terminal
 * states. Stored IR is never rewritten or recompiled; every earlier version
 * is still read as stored:
 * - 1: no root outputSchema (each succeeded terminal carries the contract it
 *   was compiled with) and no catchAll;
 * - 2: root outputSchema, no catchAll;
 * - 3: root outputSchema and catchAll;
 * - 4: version 3 plus wait states (WORKFLOW_V2_WAIT_IR_VERSION), written
 *   only for a workflow that has one, so other IR stays byte-identical;
 * - 5: version 4 plus messaging receive states and the root contracts they
 *   name (WORKFLOW_V2_MESSAGING_IR_VERSION), written only for a workflow
 *   that has one;
 * - 6: version 5 plus messaging send states (WORKFLOW_V2_SEND_IR_VERSION),
 *   written only for a workflow that has one;
 * - 7: version 6 plus messaging request states and contract responses
 *   (WORKFLOW_V2_REQUEST_IR_VERSION), written only for a workflow that has
 *   one of them and only when requests are enabled (WorkflowCompileOptions).
 *   A reader takes it only when asked to (parseWorkflowIr's maxIrVersion):
 *   a build that does not run request states refuses it explicitly and
 *   never reads it as version 6.
 * - 8: version 7 plus agent states and parallel states
 *   (WORKFLOW_V2_AGENT_IR_VERSION), written only for a workflow that has one
 *   of them and only when they are enabled (WorkflowCompileOptions;
 *   INACTIVE: only controller 1.9.0 runs them). A parallel state's body
 *   states are in `nodes` with the others, named by its `body.states`. A
 *   reader takes it only when asked to, as version 7.
 */
export const WORKFLOW_V2_IR_VERSION = 3;
export const WORKFLOW_V2_WAIT_IR_VERSION = 4;
export const WORKFLOW_V2_MESSAGING_IR_VERSION = 5;
export const WORKFLOW_V2_SEND_IR_VERSION = 6;
export const WORKFLOW_V2_REQUEST_IR_VERSION = 7;
export const WORKFLOW_V2_AGENT_IR_VERSION = 8;
/** The newest IR version controller 1.9.0's activities read (request and agent states; INACTIVE). */
export const WORKFLOW_V2_MILESTONE_IR_VERSION = WORKFLOW_V2_AGENT_IR_VERSION;
/** The newest IR version a worker reads unless asked for more: request states are not run yet. */
export const WORKFLOW_V2_RUNNABLE_IR_VERSION = 6;
/** A wait state's seconds: an integer in this range, literal or bound. */
export const WAIT_MAX_SECONDS = 86_400;
/** The one business outcome of a wait state, and a receive state's outcome when its wait wins. */
export const WAIT_ELAPSED = "elapsed";
/** A receive state's outcome when a message wins. */
export const RECEIVE_RECEIVED = "received";
/** A send state's outcome: the recipient's durable queue accepted its message (not that it was read). */
export const MESSAGE_SENT = "sent";
/** A request state's business outcomes: an accepted response, or the responder's declared refusal. */
export const REQUEST_RESPONDED = "responded";
export const REQUEST_DECLINED = "declined";
/** A parallel state's business outcomes: every branch succeeded, or not (design 02 parallel scope and join; D10). */
export const PARALLEL_JOINED = "joined";
export const PARALLEL_BLOCKED = "blocked";
/** The most branches one parallel state runs (its manifest's items). */
export const WORKFLOW_V2_PARALLEL_MAX_ITEMS = 64;
/** The most branches of one parallel state that are active at once. */
export const WORKFLOW_V2_PARALLEL_MAX_CONCURRENCY = 16;
/**
 * A run's deadline (root limits.timeoutSeconds; IR 8, INACTIVE: only controller 1.9.0 runs it): at most this many seconds,
 * counted from when the run begins. onExceeded expired (the only policy) ends the run failed with timed_out.
 */
export const WORKFLOW_V2_RUN_TIMEOUT_MAX_SECONDS = 30 * 86_400;
export const WORKFLOW_V2_RUN_ON_EXCEEDED = ["expired"] as const;
/** The largest inline task prompt of an agent state, in UTF-8 bytes. */
export const AGENT_PROMPT_MAX_BYTES = 32 * 1024;
/** The runtime error codes an agent state's agent may report itself (complete_workflow_node), apart from its business outcomes. */
export const AGENT_REPORTED_ERROR_CODES = ["needs_input", "execution_failed"] as const;
/** The largest response schema, with every schema it references, in UTF-8 bytes of their canonical JSON. */
export const REQUEST_RESPONSE_SCHEMA_MAX_BYTES = 8 * 1024;
/** A contract name: a name, '@' and a positive integer version, such as BuildEvent@1. */
export const CONTRACT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}@[1-9][0-9]{0,5}$/;
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
export const SUPPORTED_NODE_TYPES = ["script", "wait", "messaging", "terminal"] as const;
/**
 * Messaging modes this build runs. A request state compiles to IR 7 only
 * when requests are enabled; otherwise it is refused explicitly, so no
 * definition with one is published or run.
 */
export const SUPPORTED_MESSAGING_MODES = ["receive", "send"] as const;
const KNOWN_NODE_TYPES = ["script", "terminal", "wait", "messaging", "agent", "parallel", "join"];

export type TerminalOutcome = typeof TERMINAL_OUTCOMES[number];
export type RuntimeErrorCode = typeof RUNTIME_ERROR_CODES[number];

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** A state id, route label or outcome: a letter, then up to 63 letters, digits, '_' or '-'. */
export const WORKFLOW_V2_ID_PATTERN = ID_PATTERN;
/** A package workflow interface's name, as `interface: <name>@<version>` names it (design 04, 09). */
export const WORKFLOW_INTERFACE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** A package workflow interface's version label, such as `1`. */
export const WORKFLOW_INTERFACE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
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

export interface WorkflowIRWait {
    id: string;
    type: "wait";
    description: string | null;
    /** An integer of seconds, or one whole-string binding evaluated and checked when the state is entered. */
    seconds: number | string;
    /** The value the wait passes on when it elapses; without an input binding, the value that arrived. */
    hasInput: boolean;
    input: JsonValue;
    /** Route label -> target node: elapsed, and runtime routes (failure and error codes). */
    next: Record<string, string>;
}

/** Who a receive state accepts a message from, or a send state sends to, resolved and frozen when it is entered. */
export type WorkflowIRSender = { parent: true } | { sessionId: string };

export interface WorkflowIRReceive {
    id: string;
    type: "messaging";
    description: string | null;
    mode: "receive";
    /** A root contract name; the message payload must satisfy its schema. */
    contract: string;
    /** The parent, or a session id (literal or one whole-string binding); null accepts any sender allowed to send this workflow input. */
    from: WorkflowIRSender | null;
    /** A JSON template of correlation values evaluated on entry; a message's correlation must equal it. Null is {}. */
    correlate: JsonValue;
    /** The seconds of the wait that races the message, as a wait state's seconds; null for no wait. */
    waitSeconds: number | string | null;
    /** The value the state passes on when its wait elapses; without an input binding, the value that arrived. */
    hasInput: boolean;
    input: JsonValue;
    /** Route label -> target node: received, elapsed (with a wait), and runtime routes. */
    next: Record<string, string>;
}

export interface WorkflowIRSend {
    id: string;
    type: "messaging";
    description: string | null;
    mode: "send";
    /** A root contract name; the payload must satisfy its schema when the state is entered. */
    contract: string;
    /** The parent, or a session id (literal or one whole-string binding), resolved and frozen when the state is entered. */
    recipient: WorkflowIRSender;
    /**
     * A JSON template of correlation values evaluated on entry (null is {}):
     * a workflow recipient's receive states match it. Version 6 IR written
     * before this field was added has none (null).
     */
    correlate: JsonValue;
    /** The payload: the input binding's value, or without one the value that arrived. */
    hasInput: boolean;
    input: JsonValue;
    /** Route label -> target node: sent, and runtime routes. */
    next: Record<string, string>;
}

export type WorkflowIRMessaging = WorkflowIRReceive | WorkflowIRSend | WorkflowIRRequest;

/**
 * A request state (IR 7): one typed request of its contract to its
 * recipient, answered by one typed result: an accepted response (outcome
 * responded) or the responder's declared refusal (outcome declined); its
 * deadline (timed_out) and the other runtime errors route by code.
 */
export interface WorkflowIRRequest {
    id: string;
    type: "messaging";
    description: string | null;
    mode: "request";
    /** A root contract that declares a response: the payload must satisfy its schema, a response its response schema. */
    contract: string;
    /** The parent, or a session id (literal or one whole-string binding), resolved and frozen when the state is entered. */
    recipient: WorkflowIRSender;
    /** A JSON template of correlation values evaluated on entry (null is {}). */
    correlate: JsonValue;
    /** The payload: the input binding's value, or without one the value that arrived. */
    hasInput: boolean;
    input: JsonValue;
    /** The deadline: an integer of seconds, or one whole-string binding checked and frozen when the state is entered. */
    timeoutSeconds: number | string;
    /** Route label -> target node: responded, declined, and runtime routes (timed_out among them). */
    next: Record<string, string>;
}

/**
 * An agent state (IR 8; INACTIVE): an ordinary child agent session with the
 * standard base, given the state's validated input in a host-generated
 * wrapper, that finishes the state only with a typed completion
 * (complete_workflow_node: one of `outcomes` with an output that satisfies
 * `outputSchema`, or a reported runtime error), raced against its outer
 * deadline (timed_out).
 */
export interface WorkflowIRAgent {
    id: string;
    type: "agent";
    description: string | null;
    /**
     * Exactly one task source: an inline prompt, or a named agent definition (resolved when the state is entered, then
     * pinned). A package agent may also name the workflow interface it exports (present only when named): publication
     * then requires the state's contract to match that interface exactly and pins its digest (package-interface.ts).
     */
    invoke: { prompt: string } | { agent: { name: string; package: string | null; version: string | null; interface?: { name: string; version: string } } };
    /** The state's input: the input binding's value, or without one the value that arrived. */
    hasInput: boolean;
    input: JsonValue;
    inputSchema: string | null;
    outputSchema: string | null;
    /** Business outcomes the agent may report, each with a route. */
    outcomes: string[];
    /** The outer deadline: an integer of seconds, or one whole-string binding checked and frozen when the state is entered. */
    timeoutSeconds: number | string;
    /** Route label -> target node: the outcomes, and runtime routes (timed_out, needs_input and the others). */
    next: Record<string, string>;
}

/**
 * A parallel state (IR 8; INACTIVE): its manifest (`forEach`, evaluated once
 * on entry and frozen as the state's input; a JSON array of at most
 * WORKFLOW_V2_PARALLEL_MAX_ITEMS items) runs one branch per item through
 * its body, at most `concurrency` at a time. A branch starts at the body's
 * initial state with its item as input (`branch.item` and `branch.index` in
 * its bindings) and ends at a body terminal. The join is all_required: when
 * every branch ended, the state's outcome is `joined` (every branch ended
 * succeeded; its output is their outputs in manifest order) or `blocked`
 * (its output lists every branch's outcome and output). With `failFast`, the
 * first branch that does not succeed cancels the others, and the state is
 * blocked.
 */
export interface WorkflowIRParallel {
    id: string;
    type: "parallel";
    description: string | null;
    /** A JSON template (a binding or a literal array) that gives the manifest. */
    forEach: JsonValue;
    concurrency: number;
    join: "all_required";
    failFast: boolean;
    /** The manifest's schema (the whole array). */
    inputSchema: string | null;
    /** The schema of the joined output (the array of branch outputs). */
    outputSchema: string | null;
    /** Its body: the initial state and every body state's id (each in `nodes`). */
    body: { initial: string; states: string[] };
    /** Route label -> target node: joined, blocked, and runtime routes. */
    next: Record<string, string>;
}

export interface WorkflowIRContract {
    /** The schema (in schemaDefs) every payload of this contract must satisfy. */
    schema: string;
    /** Version 7: the schema (in schemaDefs) a response to a request of this contract must satisfy. */
    response?: { schema: string };
}

export type WorkflowIRNode = WorkflowIRScript | WorkflowIRWait | WorkflowIRMessaging | WorkflowIRAgent | WorkflowIRParallel | WorkflowIRTerminal;

export interface WorkflowIR {
    /**
     * 1 and 2 are read-only earlier shapes (outputSchema and catchAll null when absent); 3, 4 with wait states, 5 with
     * receive states, 6 with send states, 7 with request states or contract responses, or 8 with agent or parallel states is written now.
     */
    irVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
    apiVersion: typeof WORKFLOW_V2_API_VERSION;
    name: string;
    version: string;
    description: string | null;
    initial: string;
    initialInput: JsonValue;
    inputsSchema: string | null;
    /** The workflow's output contract; every succeeded terminal's output must satisfy it. */
    outputSchema: string | null;
    /**
     * The state a runtime error goes to when its own state has no route for
     * it (no route for its code and no failure route). It is entered at most
     * once per run; an unhandled error after that fails the run.
     */
    catchAll: string | null;
    /**
     * maxNodeExecutions, and from version 8 an optional run deadline: timeoutSeconds, counted from when the run begins,
     * with its policy onExceeded (expired: the run ends failed with timed_out). Both are absent without a deadline.
     */
    limits: { maxNodeExecutions: number; timeoutSeconds?: number; onExceeded?: typeof WORKFLOW_V2_RUN_ON_EXCEEDED[number] };
    schemaDefs: Record<string, JsonValue>;
    /** Version 5 and later: the root contracts (absent before version 5). Its receive and send states name them. */
    contracts?: Record<string, WorkflowIRContract>;
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

export interface WorkflowCompileOptions {
    /**
     * Compile request states and contract responses to IR 7. Off by default:
     * they are still checked field by field, but the result is invalid with
     * WORKFLOW_FEATURE_UNSUPPORTED, so no definition with one is stored as
     * valid, published or run until requests are enabled.
     */
    enableRequests?: boolean;
    /**
     * Compile agent states to IR 8 (INACTIVE: only a host that starts runs
     * at controller 1.9.0 sets it). Off by default: a state of type agent
     * stays unsupported, as before.
     */
    enableAgents?: boolean;
    /**
     * Compile parallel states to IR 8 (INACTIVE: only a host that starts runs
     * at controller 1.9.0 sets it). Off by default: a state of type parallel
     * stays unsupported, as before.
     */
    enableParallel?: boolean;
    /**
     * Compile a run deadline (limits.timeoutSeconds and onExceeded) to IR 8
     * (INACTIVE: only a host that starts runs at controller 1.9.0 sets it).
     * Off by default: the fields are refused with WORKFLOW_FEATURE_UNSUPPORTED,
     * so no definition that a 1.8.0 run would not enforce is published.
     */
    enableRunLimits?: boolean;
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

/**
 * UTF-8 bytes of a definition's canonical JSON plus those of every
 * definition it references in a schema position (schemaReferences), each
 * counted once; a literal value that looks like a reference is not one.
 */
function schemaClosureBytes(defs: Record<string, JsonValue>, name: string): number {
    const seen = new Set<string>();
    const pending = [name];
    let bytes = 0;
    while (pending.length > 0) {
        const next = pending.pop()!;
        if (seen.has(next) || !Object.hasOwn(defs, next)) continue;
        seen.add(next);
        bytes += Buffer.byteLength(canonicalJson(defs[next]), "utf8");
        pending.push(...schemaReferences(defs[next]));
    }
    return bytes;
}

/** A state's transition.next: route label -> target state. */
function compileRoutes(raw: Record<string, unknown>, path: string, what: string, nodeIds: ReadonlySet<string>, diagnostics: Diagnostics): Record<string, string> {
    const next: Record<string, string> = {};
    if (!isJsonObject(raw.transition)) {
        diagnostics.error("WORKFLOW_FIELD_REQUIRED", `${path}.transition`, `${what} needs transition.next.`);
    } else {
        checkKeys(raw.transition, ["next", "function"], `${path}.transition`, diagnostics);
        if (raw.transition.function !== undefined) {
            diagnostics.error("WORKFLOW_FEATURE_UNSUPPORTED", `${path}.transition.function`, "transition.function is not supported by this build yet; route on the state's outcome with transition.next.");
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
    return next;
}

function warnUnhandledFailure(path: string, next: Record<string, string>, hasCatchAll: boolean, diagnostics: Diagnostics): void {
    if (!hasCatchAll && !Object.hasOwn(next, FAILURE_ROUTE) && !RUNTIME_ERROR_CODES.some(code => Object.hasOwn(next, code))) {
        diagnostics.warning("WORKFLOW_FAILURE_UNHANDLED", `${path}.transition.next`,
            "no failure route and no catchAll: a runtime error at this state (crash, timeout, invalid input or output) ends the run as failed.");
    }
}

function compileScript(id: string, raw: Record<string, unknown>, nodeIds: ReadonlySet<string>, schemas: SchemaCollector, hasCatchAll: boolean, diagnostics: Diagnostics): WorkflowIRScript | null {
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

    const next = compileRoutes(raw, path, "a script", nodeIds, diagnostics);
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
    warnUnhandledFailure(path, next, hasCatchAll, diagnostics);
    if (!source) return null;
    return {
        id, type: "script", description: optionalText(raw.description, `${path}.description`, diagnostics),
        source, timeoutSeconds, hasInput, input,
        inputSchema, outputSchema, outcomes, next,
    };
}

/**
 * A wait state: a durable timer in the workflow's controller, never a
 * script sleep. Its seconds are an integer or one binding (checked when the
 * state is entered: invalid_input otherwise); it elapses with the value it
 * was given as its output.
 */
/** A wait's seconds (or a request's timeoutSeconds): an integer from 1 to WAIT_MAX_SECONDS, or one whole-string binding checked on entry. */
function secondsField(value: unknown, path: string, diagnostics: Diagnostics, field = "seconds"): number | string | null {
    const message = `${field} must be an integer from 1 to ${WAIT_MAX_SECONDS}, or one \${...} binding that gives one.`;
    if (typeof value === "number") {
        if (!Number.isInteger(value) || value < 1 || value > WAIT_MAX_SECONDS) { diagnostics.error("WORKFLOW_FIELD_INVALID", path, message); return null; }
        return value;
    }
    if (typeof value === "string") {
        try {
            if (parseBindingExpression(value, path) === null) { diagnostics.error("WORKFLOW_FIELD_INVALID", path, message); return null; }
            return value;
        } catch (error) {
            if (!(error instanceof WorkflowBindingError)) throw error;
            diagnostics.error(error.code, path, error.message);
            return null;
        }
    }
    diagnostics.error("WORKFLOW_FIELD_REQUIRED", path, message);
    return null;
}

function compileWait(id: string, raw: Record<string, unknown>, nodeIds: ReadonlySet<string>, hasCatchAll: boolean, diagnostics: Diagnostics): WorkflowIRWait | null {
    const path = `states.${id}`;
    checkKeys(raw, ["type", "description", "seconds", "input", "transition"], path, diagnostics);
    const seconds = secondsField(raw.seconds, `${path}.seconds`, diagnostics);
    const hasInput = Object.hasOwn(raw, "input");
    const input = hasInput ? bindingValue(raw.input, `${path}.input`, diagnostics) : null;
    const next = compileRoutes(raw, path, "a wait", nodeIds, diagnostics);
    for (const label of Object.keys(next)) {
        if (label !== WAIT_ELAPSED && !isRuntimeRoute(label)) {
            diagnostics.error("WORKFLOW_ROUTE_INVALID", `${path}.transition.next.${label}`,
                `a wait has one outcome, '${WAIT_ELAPSED}'; its other routes must be runtime error codes or '${FAILURE_ROUTE}'.`);
        }
    }
    if (isJsonObject(raw.transition) && isJsonObject(raw.transition.next) && !Object.hasOwn(next, WAIT_ELAPSED)) {
        diagnostics.error("WORKFLOW_ROUTE_MISSING", `${path}.transition.next`, `a wait needs an '${WAIT_ELAPSED}' route.`);
    }
    warnUnhandledFailure(path, next, hasCatchAll, diagnostics);
    if (seconds === null) return null;
    return { id, type: "wait", description: optionalText(raw.description, `${path}.description`, diagnostics), seconds, hasInput, input, next };
}

/** A receive's sender or a send's recipient: {parent: true}, a session id or {sessionId: <id>}, where the id may be one whole-string binding. */
function senderField(value: unknown, path: string, diagnostics: Diagnostics, field = "from"): WorkflowIRSender | null {
    if (isJsonObject(value) && Object.keys(value).length === 1 && value.parent === true) return { parent: true };
    const sessionId = typeof value === "string" ? value
        : isJsonObject(value) && Object.keys(value).length === 1 && typeof value.sessionId === "string" ? value.sessionId : null;
    if (sessionId === null || !sessionId.trim()) {
        diagnostics.error("WORKFLOW_FIELD_INVALID", path, `${field} must be {parent: true}, a session id, or {sessionId: <id>}; an id may be one \${...} binding.`);
        return null;
    }
    return typeof bindingValue(sessionId, path, diagnostics) === "string" ? { sessionId } : null;
}

/** A messaging state's contract: a declared root contract name, or null with a diagnostic. */
function contractField(value: unknown, path: string, contracts: ReadonlySet<string>, diagnostics: Diagnostics): string | null {
    if (typeof value !== "string" || !CONTRACT_NAME_PATTERN.test(value)) {
        diagnostics.error("WORKFLOW_FIELD_INVALID", path, "contract must name a root contract, such as BuildEvent@1.");
        return null;
    }
    if (!contracts.has(value)) {
        diagnostics.error("WORKFLOW_CONTRACT_UNKNOWN", path, `contract '${value}' is not declared under contracts.`);
        return null;
    }
    return value;
}

/**
 * A send state: one typed message of its contract to its recipient, the
 * workflow's parent, a named agent session, or a named workflow (typed
 * input for one of its receive states, which match the optional
 * correlation), resolved and authorized when the state is entered and kept
 * for that entry. The payload is the state's input (its input binding, or
 * the value that arrived) and must satisfy the contract's schema. The
 * state's one outcome, sent, means the recipient accepted the message (an
 * agent session's queue, or a workflow's inbox), not that it was read.
 */
function compileSend(id: string, raw: Record<string, unknown>, nodeIds: ReadonlySet<string>, contracts: ReadonlySet<string>, hasCatchAll: boolean,
    diagnostics: Diagnostics): WorkflowIRSend | null {
    const path = `states.${id}`;
    checkKeys(raw, ["type", "description", "mode", "contract", "recipient", "correlate", "input", "transition"], path, diagnostics);
    const contract = contractField(raw.contract, `${path}.contract`, contracts, diagnostics);
    let recipient: WorkflowIRSender | null = null;
    if (raw.recipient === undefined) {
        diagnostics.error("WORKFLOW_FIELD_REQUIRED", `${path}.recipient`, "a send state needs a recipient: {parent: true}, a session id, or {sessionId: <id>}.");
    } else recipient = senderField(raw.recipient, `${path}.recipient`, diagnostics, "recipient");
    let correlate: JsonValue = null;
    if (raw.correlate !== undefined) {
        if (!isJsonObject(raw.correlate)) diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.correlate`, "correlate must map correlation keys to values or bindings.");
        else correlate = bindingValue(raw.correlate, `${path}.correlate`, diagnostics);
    }
    const hasInput = Object.hasOwn(raw, "input");
    const input = hasInput ? bindingValue(raw.input, `${path}.input`, diagnostics) : null;
    const next = compileRoutes(raw, path, "a messaging state", nodeIds, diagnostics);
    for (const label of Object.keys(next)) {
        if (label !== MESSAGE_SENT && !isRuntimeRoute(label)) {
            diagnostics.error("WORKFLOW_ROUTE_INVALID", `${path}.transition.next.${label}`,
                `a send has one outcome, '${MESSAGE_SENT}'; its other routes must be runtime error codes or '${FAILURE_ROUTE}'.`);
        }
    }
    if (isJsonObject(raw.transition) && isJsonObject(raw.transition.next) && !Object.hasOwn(next, MESSAGE_SENT)) {
        diagnostics.error("WORKFLOW_ROUTE_MISSING", `${path}.transition.next`, `a send needs a '${MESSAGE_SENT}' route.`);
    }
    warnUnhandledFailure(path, next, hasCatchAll, diagnostics);
    if (contract === null || recipient === null) return null;
    return {
        id, type: "messaging", description: optionalText(raw.description, `${path}.description`, diagnostics), mode: "send",
        contract, recipient, correlate, hasInput, input, next,
    };
}

/**
 * A request state (IR 7): one typed request of its contract, which must
 * declare a response, to its recipient (the workflow's parent or a named
 * session, resolved and authorized when the state is entered), answered by
 * one typed result: an accepted response (responded), the responder's
 * declared refusal (declined), or a runtime error routed by code, its
 * deadline (timed_out) among them. The payload is the state's input. The
 * obsolete spellings 'request' (for input) and the route 'timeout' (for
 * timed_out) are refused by name and never read as aliases.
 */
function compileRequest(id: string, raw: Record<string, unknown>, nodeIds: ReadonlySet<string>, contracts: ReadonlySet<string>,
    responding: ReadonlySet<string>, hasCatchAll: boolean, diagnostics: Diagnostics): WorkflowIRRequest | null {
    const path = `states.${id}`;
    if (Object.hasOwn(raw, "request")) {
        diagnostics.error("WORKFLOW_FIELD_RENAMED", `${path}.request`, "a request state's payload is 'input', not 'request'.");
    }
    checkKeys(Object.fromEntries(Object.entries(raw).filter(([key]) => key !== "request")),
        ["type", "description", "mode", "contract", "recipient", "correlate", "input", "timeoutSeconds", "transition"], path, diagnostics);
    const contract = contractField(raw.contract, `${path}.contract`, contracts, diagnostics);
    if (contract !== null && !responding.has(contract)) {
        diagnostics.error("WORKFLOW_CONTRACT_NO_RESPONSE", `${path}.contract`,
            `contract '${contract}' declares no response; a request state needs a contract with response: { schema: <JSON Schema> }.`);
    }
    let recipient: WorkflowIRSender | null = null;
    if (raw.recipient === undefined) {
        diagnostics.error("WORKFLOW_FIELD_REQUIRED", `${path}.recipient`, "a request state needs a recipient: {parent: true}, a session id, or {sessionId: <id>}.");
    } else recipient = senderField(raw.recipient, `${path}.recipient`, diagnostics, "recipient");
    let correlate: JsonValue = null;
    if (raw.correlate !== undefined) {
        if (!isJsonObject(raw.correlate)) diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.correlate`, "correlate must map correlation keys to values or bindings.");
        else correlate = bindingValue(raw.correlate, `${path}.correlate`, diagnostics);
    }
    const hasInput = Object.hasOwn(raw, "input");
    const input = hasInput ? bindingValue(raw.input, `${path}.input`, diagnostics) : null;
    const timeoutSeconds = secondsField(raw.timeoutSeconds, `${path}.timeoutSeconds`, diagnostics, "timeoutSeconds");
    const next = compileRoutes(raw, path, "a messaging state", nodeIds, diagnostics);
    for (const label of Object.keys(next)) {
        if (label === "timeout") {
            diagnostics.error("WORKFLOW_ROUTE_RENAMED", `${path}.transition.next.${label}`, "a request's deadline route is 'timed_out', not 'timeout'.");
        } else if (label !== REQUEST_RESPONDED && label !== REQUEST_DECLINED && !isRuntimeRoute(label)) {
            diagnostics.error("WORKFLOW_ROUTE_INVALID", `${path}.transition.next.${label}`,
                `a request's outcomes are '${REQUEST_RESPONDED}' and '${REQUEST_DECLINED}'; its other routes must be runtime error codes or '${FAILURE_ROUTE}'.`);
        }
    }
    if (isJsonObject(raw.transition) && isJsonObject(raw.transition.next)) {
        for (const outcome of [REQUEST_RESPONDED, REQUEST_DECLINED]) {
            if (!Object.hasOwn(next, outcome)) diagnostics.error("WORKFLOW_ROUTE_MISSING", `${path}.transition.next`, `a request needs a '${outcome}' route.`);
        }
    }
    warnUnhandledFailure(path, next, hasCatchAll, diagnostics);
    if (contract === null || recipient === null || timeoutSeconds === null) return null;
    return {
        id, type: "messaging", description: optionalText(raw.description, `${path}.description`, diagnostics), mode: "request",
        contract, recipient, correlate, hasInput, input, timeoutSeconds, next,
    };
}

/**
 * A messaging state. This build compiles modes receive and send, and
 * request (compileRequest) when requests are enabled; otherwise a request
 * state is checked field by field and refused. A receive state takes one
 * typed message of its contract, from its sender and with its correlation,
 * that a sender gave the run (send_workflow_input) before or after the
 * state was entered, in the order the run accepted them. An optional wait
 * races it; the store decides which comes first. A send state is
 * compileSend's.
 */
function compileMessaging(id: string, raw: Record<string, unknown>, nodeIds: ReadonlySet<string>, contracts: ReadonlySet<string>, hasCatchAll: boolean,
    diagnostics: Diagnostics, requests: { responding: ReadonlySet<string>; enabled: boolean }): WorkflowIRMessaging | null {
    const path = `states.${id}`;
    if (raw.mode === "send") return compileSend(id, raw, nodeIds, contracts, hasCatchAll, diagnostics);
    if (raw.mode === "request") {
        if (!requests.enabled) {
            diagnostics.error("WORKFLOW_FEATURE_UNSUPPORTED", `${path}.mode`,
                `messaging mode 'request' is not enabled in this build: a definition with a request state is not published or run (enabled: ${SUPPORTED_MESSAGING_MODES.join(", ")}).`);
        }
        return compileRequest(id, raw, nodeIds, contracts, requests.responding, hasCatchAll, diagnostics);
    }
    if (raw.mode !== "receive") {
        diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.mode`, "mode must be receive, send or request.");
        return null;
    }
    checkKeys(raw, ["type", "description", "mode", "contract", "from", "correlate", "wait", "input", "transition"], path, diagnostics);
    const contract = contractField(raw.contract, `${path}.contract`, contracts, diagnostics);
    const from = raw.from === undefined ? null : senderField(raw.from, `${path}.from`, diagnostics);
    let correlate: JsonValue = null;
    if (raw.correlate !== undefined) {
        if (!isJsonObject(raw.correlate)) diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.correlate`, "correlate must map correlation keys to values or bindings.");
        else correlate = bindingValue(raw.correlate, `${path}.correlate`, diagnostics);
    }
    let waitSeconds: number | string | null = null;
    if (raw.wait !== undefined) {
        if (!isJsonObject(raw.wait)) diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.wait`, "wait must be { seconds: <seconds> }.");
        else {
            checkKeys(raw.wait, ["seconds", "tool"], `${path}.wait`, diagnostics);
            if (raw.wait.tool !== undefined && raw.wait.tool !== "wait") {
                diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.wait.tool`, "wait.tool must be 'wait' when given: a receive races the workflow's durable wait.");
            }
            waitSeconds = secondsField(raw.wait.seconds, `${path}.wait.seconds`, diagnostics);
        }
    }
    const hasInput = Object.hasOwn(raw, "input");
    const input = hasInput ? bindingValue(raw.input, `${path}.input`, diagnostics) : null;
    const next = compileRoutes(raw, path, "a messaging state", nodeIds, diagnostics);
    const outcomes = raw.wait === undefined ? [RECEIVE_RECEIVED] : [RECEIVE_RECEIVED, WAIT_ELAPSED];
    for (const label of Object.keys(next)) {
        if (!outcomes.includes(label) && !isRuntimeRoute(label)) {
            diagnostics.error("WORKFLOW_ROUTE_INVALID", `${path}.transition.next.${label}`,
                `this receive's outcomes are ${outcomes.join(" and ")}${raw.wait === undefined ? " (elapsed needs a wait)" : ""}; its other routes must be runtime error codes or '${FAILURE_ROUTE}'.`);
        }
    }
    if (isJsonObject(raw.transition) && isJsonObject(raw.transition.next)) {
        for (const outcome of outcomes) {
            if (!Object.hasOwn(next, outcome)) diagnostics.error("WORKFLOW_ROUTE_MISSING", `${path}.transition.next`, `a receive needs a '${outcome}' route.`);
        }
    }
    warnUnhandledFailure(path, next, hasCatchAll, diagnostics);
    if (contract === null || (raw.wait !== undefined && waitSeconds === null) || (raw.from !== undefined && from === null)) return null;
    return {
        id, type: "messaging", description: optionalText(raw.description, `${path}.description`, diagnostics), mode: "receive",
        contract, from, correlate, waitSeconds, hasInput, input, next,
    };
}

/** An agent definition's name, or its package's: a letter or digit, then up to 127 letters, digits, '_', '.' or '-'. */
const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** `name@version`, as an agent state names a package's workflow interface (design 09: `interface: review_change@1`); null when it is not one. */
export function parseWorkflowInterfaceRef(text: unknown): { name: string; version: string } | null {
    if (typeof text !== "string") return null;
    const at = text.lastIndexOf("@");
    if (at <= 0) return null;
    const name = text.slice(0, at);
    const version = text.slice(at + 1);
    return WORKFLOW_INTERFACE_NAME_PATTERN.test(name) && WORKFLOW_INTERFACE_VERSION_PATTERN.test(version) ? { name, version } : null;
}

/**
 * An agent state (IR 8; enabled only with enableAgents): an ordinary child
 * agent session (the standard base, normal capabilities) given the state's
 * input in a host-generated wrapper. `invoke` names exactly one task
 * source: an inline `prompt`, or `agent: {name, package?, version?,
 * interface?}`, a visible agent definition resolved when the state is
 * entered and pinned for that entry. The state's own inputSchema and
 * outputSchema are its contract. `interface: <name>@<version>` (it needs
 * `package` and an outputSchema) names the workflow interface the package
 * agent exports: publication then requires the state's outcomes and
 * schemas to be exactly the interface's (CONTRACT_MISMATCH otherwise) and
 * pins the interface's digest; nothing is inferred here. The agent
 * finishes the state only with complete_workflow_node: one of its
 * outcomes (declared, or by default its routes that are not runtime
 * routes) with an output that satisfies outputSchema, or needs_input or
 * execution_failed. timeoutSeconds is its outer deadline (timed_out).
 */
function compileAgent(id: string, raw: Record<string, unknown>, nodeIds: ReadonlySet<string>, schemas: SchemaCollector, hasCatchAll: boolean,
    diagnostics: Diagnostics): WorkflowIRAgent | null {
    const path = `states.${id}`;
    checkKeys(raw, ["type", "description", "invoke", "input", "inputSchema", "outputSchema", "outcomes", "timeoutSeconds", "transition"], path, diagnostics);
    let invoke: WorkflowIRAgent["invoke"] | null = null;
    let namesInterface = false;
    if (!isJsonObject(raw.invoke)) {
        diagnostics.error("WORKFLOW_FIELD_REQUIRED", `${path}.invoke`, "an agent state needs invoke: { prompt: <task> } or { agent: { name: <agent> } }.");
    } else {
        const sources = (["prompt", "agent"] as const).filter(key => Object.hasOwn(raw.invoke as Record<string, unknown>, key));
        checkKeys(raw.invoke, ["prompt", "agent"], `${path}.invoke`, diagnostics);
        if (sources.length !== 1) {
            diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.invoke`, "invoke must give exactly one of prompt or agent.");
        } else if (sources[0] === "prompt") {
            const prompt = raw.invoke.prompt;
            if (typeof prompt !== "string" || !prompt.trim() || !isStorableText(prompt) || Buffer.byteLength(prompt, "utf8") > AGENT_PROMPT_MAX_BYTES) {
                diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.invoke.prompt`, `prompt must be non-empty text of at most ${AGENT_PROMPT_MAX_BYTES} bytes.`);
            } else invoke = { prompt };
        } else {
            const agent = raw.invoke.agent;
            const agentPath = `${path}.invoke.agent`;
            if (!isJsonObject(agent)) {
                diagnostics.error("WORKFLOW_FIELD_INVALID", agentPath, "agent must be { name: <agent>, package?: <package>, version?: <semver>, interface?: <name>@<version> }.");
            } else {
                checkKeys(agent, ["name", "package", "version", "interface"], agentPath, diagnostics);
                let iface: { name: string; version: string } | null = null;
                if (agent.interface !== undefined) {
                    namesInterface = true;
                    iface = parseWorkflowInterfaceRef(agent.interface);
                    if (iface === null) {
                        diagnostics.error("WORKFLOW_FIELD_INVALID", `${agentPath}.interface`,
                            "agent.interface must be <name>@<version> of the workflow interface its package agent exports, such as review_change@1.");
                    }
                    if (agent.package === undefined) diagnostics.error("WORKFLOW_FIELD_INVALID", `${agentPath}.interface`, "agent.interface needs agent.package.");
                }
                const name = typeof agent.name === "string" && AGENT_NAME_PATTERN.test(agent.name) ? agent.name : null;
                if (name === null) diagnostics.error("WORKFLOW_FIELD_INVALID", `${agentPath}.name`, "agent.name must name an agent: a letter or digit, then letters, digits, '_', '.' or '-'.");
                let packageName: string | null = null;
                if (agent.package !== undefined) {
                    if (typeof agent.package === "string" && AGENT_NAME_PATTERN.test(agent.package)) packageName = agent.package;
                    else diagnostics.error("WORKFLOW_FIELD_INVALID", `${agentPath}.package`, "agent.package must name a package.");
                }
                let version: string | null = null;
                if (agent.version !== undefined) {
                    if (typeof agent.version === "string" && SEMVER.test(agent.version)) version = agent.version;
                    else diagnostics.error("WORKFLOW_SEMVER_INVALID", `${agentPath}.version`, "agent.version must be a semantic version string (quote it in YAML).");
                    if (agent.package === undefined) diagnostics.error("WORKFLOW_FIELD_INVALID", `${agentPath}.version`, "agent.version needs agent.package.");
                }
                if (name !== null) invoke = { agent: { name, package: packageName, version, ...(iface !== null ? { interface: iface } : {}) } };
            }
        }
    }
    const hasInput = Object.hasOwn(raw, "input");
    const input = hasInput ? bindingValue(raw.input, `${path}.input`, diagnostics) : null;
    const inputSchema = schemaField(raw.inputSchema, `node.${id}.input`, `${path}.inputSchema`, schemas, diagnostics);
    const outputSchema = schemaField(raw.outputSchema, `node.${id}.output`, `${path}.outputSchema`, schemas, diagnostics);
    if (namesInterface && raw.outputSchema === undefined) {
        diagnostics.error("WORKFLOW_FIELD_REQUIRED", `${path}.outputSchema`,
            "a state that names a workflow interface declares its outputSchema: the interface's output schema, exactly.");
    }
    const timeoutSeconds = secondsField(raw.timeoutSeconds, `${path}.timeoutSeconds`, diagnostics, "timeoutSeconds");
    const next = compileRoutes(raw, path, "an agent state", nodeIds, diagnostics);
    let outcomes: string[];
    if (raw.outcomes !== undefined) {
        if (!isStringList(raw.outcomes) || raw.outcomes.length === 0 || !raw.outcomes.every(item => ID_PATTERN.test(item) && !isRuntimeRoute(item))
            || new Set(raw.outcomes).size !== raw.outcomes.length) {
            diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.outcomes`, "outcomes must be a non-empty list of distinct route labels that are not runtime routes.");
            outcomes = [];
        } else {
            outcomes = raw.outcomes;
            for (const outcome of outcomes) {
                if (!Object.hasOwn(next, outcome)) diagnostics.error("WORKFLOW_ROUTE_MISSING", `${path}.transition.next`, `declared outcome '${outcome}' has no route.`);
            }
            for (const label of Object.keys(next)) {
                if (!outcomes.includes(label) && !isRuntimeRoute(label)) {
                    diagnostics.error("WORKFLOW_ROUTE_INVALID", `${path}.transition.next.${label}`,
                        `route '${label}' is neither a declared outcome nor a runtime route.`);
                }
            }
        }
    } else {
        outcomes = Object.keys(next).filter(label => !isRuntimeRoute(label));
    }
    if (outcomes.length === 0) diagnostics.error("WORKFLOW_ROUTE_MISSING", `${path}.transition.next`, "an agent state needs at least one business outcome route.");
    warnUnhandledFailure(path, next, hasCatchAll, diagnostics);
    if (invoke === null || timeoutSeconds === null) return null;
    return {
        id, type: "agent", description: optionalText(raw.description, `${path}.description`, diagnostics),
        invoke, hasInput, input, inputSchema, outputSchema, outcomes, timeoutSeconds, next,
    };
}

/** The binding templates a compiled state holds, by field (for checks over every binding). */
function nodeTemplates(node: WorkflowIRNode): Array<[string, JsonValue]> {
    const templates: Array<[string, JsonValue]> = [];
    const add = (field: string, value: JsonValue | undefined): void => { if (value !== undefined && value !== null) templates.push([field, value]); };
    if (node.type === "terminal") { if (node.hasOutput) add("output", node.output); return templates; }
    if (node.type === "parallel") { add("forEach", node.forEach); return templates; }
    if (node.hasInput) add("input", node.input);
    if (node.type === "wait") add("seconds", node.seconds);
    if (node.type === "agent") add("timeoutSeconds", node.timeoutSeconds);
    if (node.type === "messaging") {
        add("correlate", node.correlate);
        if (node.mode === "receive") { add("wait.seconds", node.waitSeconds); if (node.from && "sessionId" in node.from) add("from", node.from.sessionId); }
        else {
            if ("sessionId" in node.recipient) add("recipient", node.recipient.sessionId);
            if (node.mode === "request") add("timeoutSeconds", node.timeoutSeconds);
        }
    }
    return templates;
}

/**
 * A parallel state (IR 8; enabled only with enableParallel): `forEach` (a
 * binding, or a literal array) gives its manifest when the state is entered;
 * `concurrency` (1 to WORKFLOW_V2_PARALLEL_MAX_CONCURRENCY, default 1) bounds
 * the active branches; `join` is all_required (the only join of this
 * release; D10); `failFast` (default false) cancels the other branches when
 * one does not succeed. `body` is a graph of its own (`initial`, `states`):
 * its routes stay in it, it holds no parallel state, and its terminals end a
 * branch (succeeded is accepted; any other outcome blocks the join). Its
 * outcomes are joined and blocked; both need routes.
 */
function compileParallel(id: string, raw: Record<string, unknown>, nodeIds: ReadonlySet<string>, schemas: SchemaCollector, hasCatchAll: boolean,
    diagnostics: Diagnostics, compileBody: (bodyIds: ReadonlySet<string>, states: Array<[string, unknown]>) => void): WorkflowIRParallel | null {
    const path = `states.${id}`;
    checkKeys(raw, ["type", "description", "forEach", "concurrency", "join", "failFast", "inputSchema", "outputSchema", "body", "transition"], path, diagnostics);
    let forEach: JsonValue = null;
    if (raw.forEach === undefined) diagnostics.error("WORKFLOW_FIELD_REQUIRED", `${path}.forEach`, "a parallel state needs forEach: one ${...} binding, or a list.");
    else {
        forEach = bindingValue(raw.forEach, `${path}.forEach`, diagnostics);
        const binding = typeof raw.forEach === "string" ? (() => { try { return parseBindingExpression(raw.forEach as string, `${path}.forEach`); } catch { return null; } })() : null;
        if (!Array.isArray(raw.forEach) && binding === null) {
            diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.forEach`, "forEach must be one ${...} binding that gives a list, or a list.");
        } else if (Array.isArray(raw.forEach) && raw.forEach.length > WORKFLOW_V2_PARALLEL_MAX_ITEMS) {
            diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.forEach`, `a parallel state runs at most ${WORKFLOW_V2_PARALLEL_MAX_ITEMS} branches.`);
        }
    }
    let concurrency = 1;
    if (raw.concurrency !== undefined) {
        if (typeof raw.concurrency !== "number" || !Number.isInteger(raw.concurrency) || raw.concurrency < 1 || raw.concurrency > WORKFLOW_V2_PARALLEL_MAX_CONCURRENCY) {
            diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.concurrency`, `concurrency must be an integer from 1 to ${WORKFLOW_V2_PARALLEL_MAX_CONCURRENCY}.`);
        } else concurrency = raw.concurrency;
    }
    if (raw.join !== undefined && raw.join !== "all_required") {
        diagnostics.error("WORKFLOW_FEATURE_UNSUPPORTED", `${path}.join`, "join must be all_required: every branch must succeed (no quorum or any join in this release).");
    }
    let failFast = false;
    if (raw.failFast !== undefined) {
        if (typeof raw.failFast !== "boolean") diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.failFast`, "failFast must be true or false.");
        else failFast = raw.failFast;
    }
    const inputSchema = schemaField(raw.inputSchema, `node.${id}.input`, `${path}.inputSchema`, schemas, diagnostics);
    const outputSchema = schemaField(raw.outputSchema, `node.${id}.output`, `${path}.outputSchema`, schemas, diagnostics);
    const next = compileRoutes(raw, path, "a parallel state", nodeIds, diagnostics);
    for (const label of Object.keys(next)) {
        if (label !== PARALLEL_JOINED && label !== PARALLEL_BLOCKED && !isRuntimeRoute(label)) {
            diagnostics.error("WORKFLOW_ROUTE_INVALID", `${path}.transition.next.${label}`,
                `a parallel state's outcomes are '${PARALLEL_JOINED}' and '${PARALLEL_BLOCKED}'; its other routes must be runtime error codes or '${FAILURE_ROUTE}'.`);
        }
    }
    if (isJsonObject(raw.transition) && isJsonObject(raw.transition.next)) {
        for (const outcome of [PARALLEL_JOINED, PARALLEL_BLOCKED]) {
            if (!Object.hasOwn(next, outcome)) diagnostics.error("WORKFLOW_ROUTE_MISSING", `${path}.transition.next`, `a parallel state needs a '${outcome}' route.`);
        }
    }
    warnUnhandledFailure(path, next, hasCatchAll, diagnostics);
    let body: WorkflowIRParallel["body"] | null = null;
    if (!isJsonObject(raw.body) || !isJsonObject(raw.body.states) || typeof raw.body.initial !== "string") {
        diagnostics.error("WORKFLOW_FIELD_REQUIRED", `${path}.body`, "a parallel state needs body: { initial: <state>, states: { ... } }.");
    } else {
        checkKeys(raw.body, ["initial", "states"], `${path}.body`, diagnostics);
        const entries = Object.entries(raw.body.states);
        const bodyIds = new Set(entries.map(([bodyId]) => bodyId));
        if (entries.length === 0) diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.body.states`, "a parallel state's body needs at least one state.");
        if (!bodyIds.has(raw.body.initial)) {
            diagnostics.error("WORKFLOW_INITIAL_INVALID", `${path}.body.initial`, `body.initial must name a body state (got '${raw.body.initial}').`);
        }
        compileBody(bodyIds, entries);
        body = { initial: raw.body.initial, states: [...bodyIds] };
    }
    if (body === null || raw.forEach === undefined) return null;
    return {
        id, type: "parallel", description: optionalText(raw.description, `${path}.description`, diagnostics),
        forEach, concurrency, join: "all_required", failFast, inputSchema, outputSchema, body, next,
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

function checkGraph(ir: { initial: string; catchAll: string | null; nodes: Record<string, WorkflowIRNode> }, diagnostics: Diagnostics): void {
    const successors = (id: string): string[] => {
        const node = ir.nodes[id];
        return node && node.type !== "terminal" ? Object.values(node.next) : [];
    };
    // A parallel state's body is a graph of its own: its states are reached from its initial and end at its terminals.
    const bodies = Object.values(ir.nodes).flatMap(node => node.type === "parallel" ? [{ id: node.id, initial: node.body.initial, states: new Set(node.body.states) }] : []);
    const inBody = new Set(bodies.flatMap(body => [...body.states]));
    const check = (start: string[], members: (id: string) => boolean, where: (id: string) => string, from: string): void => {
        const reachable = new Set<string>();
        const stack = [...start];
        while (stack.length) {
            const id = stack.pop()!;
            if (reachable.has(id) || !ir.nodes[id] || !members(id)) continue;
            reachable.add(id);
            stack.push(...successors(id));
        }
        for (const id of Object.keys(ir.nodes)) {
            if (members(id) && !reachable.has(id)) diagnostics.warning("WORKFLOW_STATE_UNREACHABLE", where(id), `state '${id}' is not reachable from ${from}.`);
        }
        // Every reachable state must be able to reach a terminal through its own
        // routes; the catch-all is an error path, not a way to finish.
        const canFinish = new Set(Object.values(ir.nodes).filter(node => node.type === "terminal" && members(node.id)).map(node => node.id));
        let changed = true;
        while (changed) {
            changed = false;
            for (const id of reachable) {
                if (!canFinish.has(id) && successors(id).some(target => canFinish.has(target))) { canFinish.add(id); changed = true; }
            }
        }
        for (const id of reachable) {
            if (!canFinish.has(id)) diagnostics.error("WORKFLOW_NO_TERMINAL_PATH", where(id), `state '${id}' cannot reach a terminal state.`);
        }
    };
    // Any script or wait may fail into the catch-all state, so it is reachable when declared.
    const outerStart = ir.catchAll !== null && Object.values(ir.nodes).some(node => node.type !== "terminal" && !inBody.has(node.id))
        ? [ir.initial, ir.catchAll] : [ir.initial];
    check(outerStart, id => !inBody.has(id), id => `states.${id}`, "initial");
    for (const body of bodies) {
        check([body.initial], id => body.states.has(id), id => `states.${body.id}.body.states.${id}`, `the body initial of '${body.id}'`);
    }
}

/** Compile one v2 document. Never throws for document content; returns diagnostics instead. */
export function compileWorkflowV2(yaml: string, options: WorkflowCompileOptions = {}): WorkflowCompileResult {
    const diagnostics = new Diagnostics();
    const enableRequests = options.enableRequests === true;
    const enableAgents = options.enableAgents === true;
    const enableParallel = options.enableParallel === true;
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
    checkKeys(root, ["apiVersion", "kind", "metadata", "description", "inputs", "outputSchema", "initial", "initialInput", "limits", "catchAll", "schemas", "contracts", "states"], "$", diagnostics);
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

    // Named typed exchanges: a receive state names one; a sender's payload must satisfy its schema. A contract may also
    // declare a response (IR 7): the schema a response to a request of it must satisfy.
    const contracts: Record<string, WorkflowIRContract> = {};
    const declaredContracts = new Set<string>();
    const respondingContracts = new Set<string>();
    if (root.contracts !== undefined) {
        if (!isJsonObject(root.contracts)) {
            diagnostics.error("WORKFLOW_FIELD_INVALID", "contracts", "contracts must map contract names (Name@version) to { schema: <JSON Schema> }.");
        } else for (const [contractName, definition] of Object.entries(root.contracts)) {
            const path = `contracts.${contractName}`;
            if (!CONTRACT_NAME_PATTERN.test(contractName)) {
                diagnostics.error("WORKFLOW_CONTRACT_NAME", path, "contract names are a name, '@' and a version number, such as BuildEvent@1.");
                continue;
            }
            declaredContracts.add(contractName);
            if (!isJsonObject(definition) || !Object.hasOwn(definition, "schema")) {
                diagnostics.error("WORKFLOW_FIELD_INVALID", path, "a contract must be { schema: <JSON Schema> }.");
                continue;
            }
            checkKeys(definition, ["schema", "description", "response"], path, diagnostics);
            optionalText(definition.description, `${path}.description`, diagnostics);
            const generated = `contract.${contractName.replace("@", ".v")}`;
            const schema = schemaField(definition.schema, generated, `${path}.schema`, schemas, diagnostics);
            let responseSchema: string | null = null;
            if (Object.hasOwn(definition, "response")) {
                if (!enableRequests) {
                    diagnostics.error("WORKFLOW_FEATURE_UNSUPPORTED", `${path}.response`,
                        "a contract response is not enabled in this build: a definition with one is not published or run.");
                }
                const response = definition.response;
                if (!isJsonObject(response) || !Object.hasOwn(response, "schema")) {
                    diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.response`, "a contract's response must be { schema: <JSON Schema> }.");
                } else {
                    checkKeys(response, ["schema", "description"], `${path}.response`, diagnostics);
                    optionalText(response.description, `${path}.response.description`, diagnostics);
                    responseSchema = schemaField(response.schema, `${generated}.response`, `${path}.response.schema`, schemas, diagnostics);
                }
            }
            if (schema !== null) contracts[contractName] = responseSchema !== null ? { schema, response: { schema: responseSchema } } : { schema };
            if (responseSchema !== null) respondingContracts.add(contractName);
        }
    }

    let maxNodeExecutions = WORKFLOW_V2_DEFAULT_MAX_NODE_EXECUTIONS;
    // A run deadline (IR 8; enableRunLimits): seconds from when the run begins, and what happens when it passes.
    let runDeadline: { timeoutSeconds: number; onExceeded: typeof WORKFLOW_V2_RUN_ON_EXCEEDED[number] } | null = null;
    if (root.limits !== undefined) {
        if (!isJsonObject(root.limits)) diagnostics.error("WORKFLOW_FIELD_INVALID", "limits", "limits must be a mapping.");
        else {
            checkKeys(root.limits, ["maxNodeExecutions", "timeoutSeconds", "onExceeded"], "limits", diagnostics);
            const value = root.limits.maxNodeExecutions;
            if (value !== undefined) {
                if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > WORKFLOW_V2_MAX_NODE_EXECUTIONS) {
                    diagnostics.error("WORKFLOW_FIELD_INVALID", "limits.maxNodeExecutions", `maxNodeExecutions must be an integer from 1 to ${WORKFLOW_V2_MAX_NODE_EXECUTIONS}.`);
                } else maxNodeExecutions = value;
            }
            const timeout = root.limits.timeoutSeconds;
            const onExceeded = root.limits.onExceeded;
            if (timeout !== undefined || onExceeded !== undefined) {
                if (options.enableRunLimits !== true) {
                    diagnostics.error("WORKFLOW_FEATURE_UNSUPPORTED", timeout !== undefined ? "limits.timeoutSeconds" : "limits.onExceeded",
                        "a run deadline (limits.timeoutSeconds, onExceeded) is not enabled in this build: a definition with one is not published or run.");
                }
                if (timeout === undefined) {
                    diagnostics.error("WORKFLOW_FIELD_REQUIRED", "limits.timeoutSeconds", "onExceeded needs limits.timeoutSeconds.");
                } else if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > WORKFLOW_V2_RUN_TIMEOUT_MAX_SECONDS) {
                    diagnostics.error("WORKFLOW_FIELD_INVALID", "limits.timeoutSeconds", `timeoutSeconds must be an integer from 1 to ${WORKFLOW_V2_RUN_TIMEOUT_MAX_SECONDS}.`);
                } else if (onExceeded !== undefined && !(WORKFLOW_V2_RUN_ON_EXCEEDED as readonly unknown[]).includes(onExceeded)) {
                    diagnostics.error("WORKFLOW_FIELD_INVALID", "limits.onExceeded",
                        "onExceeded must be expired: when the deadline passes, the run's pending work is cancelled and the run ends failed with timed_out.");
                } else runDeadline = { timeoutSeconds: timeout, onExceeded: "expired" };
            }
        }
    }
    const initialInput = Object.hasOwn(root, "initialInput") ? bindingValue(root.initialInput, "initialInput", diagnostics) : null;

    const hasCatchAll = typeof root.catchAll === "string";
    const nodes: Record<string, WorkflowIRNode> = {};
    /** Body state id -> its parallel state's id (a body's states are compiled with the body's own ids as their targets). */
    const bodyOf = new Map<string, string>();
    /** Compile one state of the outer graph (`body` null) or of a parallel state's body (`body` its id) into `nodes`. */
    const compileState = (id: string, rawNode: unknown, nodeIds: ReadonlySet<string>, body: string | null, into: Diagnostics): void => {
        const path = `states.${id}`;
        if (!ID_PATTERN.test(id)) { into.error("WORKFLOW_STATE_ID", path, "state ids use a letter followed by up to 63 letters, digits, '_' or '-'."); return; }
        if (!isJsonObject(rawNode)) { into.error("WORKFLOW_FIELD_INVALID", path, "a state must be a mapping."); return; }
        const type = rawNode.type;
        // The catch-all state takes the outer graph's unhandled runtime errors only: in a body, one ends the branch.
        const catchAllApplies = body === null && hasCatchAll;
        if (type === "script") {
            const node = compileScript(id, rawNode, nodeIds, schemas, catchAllApplies, into);
            if (node) nodes[id] = node;
        } else if (type === "wait") {
            const node = compileWait(id, rawNode, nodeIds, catchAllApplies, into);
            if (node) nodes[id] = node;
        } else if (type === "messaging") {
            const node = compileMessaging(id, rawNode, nodeIds, declaredContracts, catchAllApplies, into,
                { responding: respondingContracts, enabled: enableRequests });
            if (node) nodes[id] = node;
        } else if (type === "terminal") {
            const node = compileTerminal(id, rawNode, schemas, into);
            if (node) nodes[id] = node;
        } else if (type === "agent" && enableAgents) {
            const node = compileAgent(id, rawNode, nodeIds, schemas, catchAllApplies, into);
            if (node) nodes[id] = node;
        } else if (type === "parallel" && enableParallel && body !== null) {
            into.error("WORKFLOW_FEATURE_UNSUPPORTED", `${path}.type`, "a parallel state's body cannot hold another parallel state.");
        } else if (type === "parallel" && enableParallel) {
            const node = compileParallel(id, rawNode, nodeIds, schemas, hasCatchAll, into, (bodyIds, bodyStates) => {
                // A body's diagnostics name the body's path, not an outer state's.
                const scoped = new Diagnostics();
                for (const [bodyId, rawBodyNode] of bodyStates) {
                    if (bodyOf.has(bodyId)) {
                        scoped.error("WORKFLOW_STATE_ID", `states.${bodyId}`, `state id '${bodyId}' is used twice; state ids are unique across the workflow.`);
                        continue;
                    }
                    bodyOf.set(bodyId, id);
                    compileState(bodyId, rawBodyNode, bodyIds, id, scoped);
                }
                for (const item of scoped.items) {
                    const rewritten = item.path.replace(/^states\.([^.]+)/, (_match, bodyId: string) => `states.${id}.body.states.${bodyId}`);
                    // In a body, a runtime error no route takes ends the branch (never the run, and never at the catch-all state).
                    const message = item.code === "WORKFLOW_FAILURE_UNHANDLED"
                        ? "no failure route: a runtime error at this state (crash, timeout, invalid input or output) ends its branch without success, "
                            + "which blocks the parallel state's join."
                        : item.message;
                    into.items.push({ ...item, path: rewritten, message });
                }
            });
            if (node) nodes[id] = node;
        } else if (typeof type === "string" && KNOWN_NODE_TYPES.includes(type)) {
            into.error("WORKFLOW_NODE_TYPE_UNSUPPORTED", `${path}.type`, `state type '${type}' is not supported by this build yet (supported: ${SUPPORTED_NODE_TYPES.join(", ")}).`);
        } else {
            into.error("WORKFLOW_NODE_TYPE_UNKNOWN", `${path}.type`, `'${String(type)}' is not a workflow state type.`);
        }
    };
    if (!isJsonObject(root.states)) {
        diagnostics.error("WORKFLOW_FIELD_REQUIRED", "states", "states must map state ids to states.");
    } else {
        const entries = Object.entries(root.states);
        if (entries.length === 0 || entries.length > WORKFLOW_V2_MAX_NODES) {
            diagnostics.error("WORKFLOW_FIELD_INVALID", "states", `states must contain between 1 and ${WORKFLOW_V2_MAX_NODES} states.`);
        }
        const nodeIds = new Set(entries.map(([id]) => id));
        for (const [id, rawNode] of entries) compileState(id, rawNode, nodeIds, null, diagnostics);
        // State ids are unique across the workflow, body states included (a node execution names its state by id).
        const seen = new Set(nodeIds);
        for (const [bodyId, parallel] of bodyOf) {
            if (nodeIds.has(bodyId)) {
                diagnostics.error("WORKFLOW_STATE_ID", `states.${parallel}.body.states.${bodyId}`, `state id '${bodyId}' is used twice; state ids are unique across the workflow.`);
            }
            seen.add(bodyId);
        }
        if (seen.size > WORKFLOW_V2_MAX_NODES) {
            diagnostics.error("WORKFLOW_FIELD_INVALID", "states", `a workflow holds at most ${WORKFLOW_V2_MAX_NODES} states, body states included.`);
        }
        // `branch` is bound only in a parallel state's body.
        for (const node of Object.values(nodes)) {
            if (bodyOf.has(node.id)) continue;
            for (const [field, template] of nodeTemplates(node)) {
                let roots: Set<string>;
                try { roots = bindingRootsOf(template); } catch { continue; }
                if (roots.has("branch")) {
                    diagnostics.error("WORKFLOW_BINDING_INVALID", `states.${node.id}.${field}`, "branch is bound only in a parallel state's body.");
                }
            }
        }
        if (Object.hasOwn(root, "initialInput")) {
            try {
                if (bindingRootsOf(root.initialInput).has("branch")) diagnostics.error("WORKFLOW_BINDING_INVALID", "initialInput", "branch is bound only in a parallel state's body.");
            } catch { /* reported by its own check */ }
        }
    }
    const initial = typeof root.initial === "string" ? root.initial : "";
    if (!initial || !(isJsonObject(root.states) && Object.hasOwn(root.states, initial))) {
        diagnostics.error("WORKFLOW_INITIAL_INVALID", "initial", `initial must name a declared state (got '${String(root.initial)}').`);
    } else if (nodes[initial]?.type === "terminal") {
        diagnostics.error("WORKFLOW_INITIAL_INVALID", "initial", "initial must not be a terminal state.");
    }
    let catchAll: string | null = null;
    if (root.catchAll !== undefined) {
        if (typeof root.catchAll !== "string" || !(isJsonObject(root.states) && Object.hasOwn(root.states, root.catchAll))) {
            diagnostics.error("WORKFLOW_CATCH_ALL_INVALID", "catchAll", `catchAll must name a declared state (got '${String(root.catchAll)}').`);
        } else if (root.catchAll === initial) {
            diagnostics.error("WORKFLOW_CATCH_ALL_INVALID", "catchAll", "catchAll must not be the initial state.");
        } else catchAll = root.catchAll;
    }

    if (!diagnostics.failed) {
        try { new WorkflowSchemaSet(schemas.defs).compileAll(); }
        catch (error) {
            diagnostics.error("WORKFLOW_SCHEMA_INVALID", error instanceof WorkflowSchemaError ? error.path : "schemas",
                error instanceof Error ? error.message : String(error));
        }
    }
    if (diagnostics.failed || !name || !version) return result(name, version, null);
    checkGraph({ initial, catchAll, nodes }, diagnostics);
    if (diagnostics.failed) return result(name, version, null);
    for (const [contractName, contract] of Object.entries(contracts)) {
        if (contract.response && schemaClosureBytes(schemas.defs, contract.response.schema) > REQUEST_RESPONSE_SCHEMA_MAX_BYTES) {
            diagnostics.error("WORKFLOW_SCHEMA_TOO_LARGE", `contracts.${contractName}.response.schema`,
                `a response schema, with the schemas it references, must be at most ${REQUEST_RESPONSE_SCHEMA_MAX_BYTES} bytes of canonical JSON.`);
        }
    }
    if (diagnostics.failed) return result(name, version, null);
    checkFixedInputs(nodes, contracts, schemas.defs, diagnostics);
    if (diagnostics.failed) return result(name, version, null);
    const received = new Set(Object.values(nodes).flatMap(node => node.type === "messaging" && node.mode === "receive" ? [node.contract] : []));
    const sent = new Set(Object.values(nodes).flatMap(node => node.type === "messaging" && node.mode === "send" ? [node.contract] : []));
    const requested = new Set(Object.values(nodes).flatMap(node => node.type === "messaging" && node.mode === "request" ? [node.contract] : []));
    for (const contractName of Object.keys(contracts)) {
        if (!received.has(contractName) && !sent.has(contractName) && !requested.has(contractName)) {
            diagnostics.warning("WORKFLOW_CONTRACT_UNUSED", `contracts.${contractName}`,
                `no state receives, sends or requests contract '${contractName}'; this workflow refuses input of it.`);
        }
    }
    const responds = Object.values(contracts).some(contract => contract.response !== undefined);
    const irVersion: WorkflowIR["irVersion"] = Object.values(nodes).some(node => node.type === "agent" || node.type === "parallel") || runDeadline !== null
        ? WORKFLOW_V2_AGENT_IR_VERSION
        : requested.size > 0 || responds ? WORKFLOW_V2_REQUEST_IR_VERSION
            : sent.size > 0 ? WORKFLOW_V2_SEND_IR_VERSION
                : received.size > 0 ? WORKFLOW_V2_MESSAGING_IR_VERSION
                    : Object.values(nodes).some(node => node.type === "wait") ? WORKFLOW_V2_WAIT_IR_VERSION : WORKFLOW_V2_IR_VERSION;
    // From version 5 on, the IR states its contracts (an empty map when it has none).
    const hasMessaging = irVersion >= WORKFLOW_V2_MESSAGING_IR_VERSION;
    const ir: WorkflowIR = {
        irVersion,
        apiVersion: WORKFLOW_V2_API_VERSION,
        name, version,
        description: optionalText(root.description, "description", diagnostics),
        initial,
        initialInput,
        inputsSchema,
        outputSchema: rootOutputSchema,
        catchAll,
        limits: { maxNodeExecutions, ...(runDeadline !== null ? runDeadline : {}) },
        schemaDefs: schemas.defs,
        ...(hasMessaging ? { contracts } : {}),
        nodes,
    };
    try { canonicalJson(ir); }
    catch (error) {
        if (error instanceof WorkflowJsonError) { diagnostics.error(error.code, error.path, error.message); return result(name, version, null); }
        throw error;
    }
    return result(name, version, ir);
}

/** The schema a value must match, with its references followed (normalized references are "#/$defs/<name>"). */
function schemaTarget(defs: Record<string, JsonValue>, schema: JsonValue | undefined, depth = 0): JsonValue | undefined {
    if (depth > 16 || !isJsonObject(schema) || typeof schema.$ref !== "string") return schema;
    const ref = schema.$ref;
    const name = ref.startsWith("#/$defs/") ? ref.slice("#/$defs/".length) : ref.startsWith("#/schemas/") ? ref.slice("#/schemas/".length) : null;
    return name !== null && !name.includes("/") && Object.hasOwn(defs, name) ? schemaTarget(defs, defs[name], depth + 1) : undefined;
}

/** Whether a schema asks for an object or an array (by its type, or by keywords only those take). */
function schemaWantsStructure(schema: JsonValue | undefined): "an object" | "an array" | null {
    if (!isJsonObject(schema)) return null;
    const types: JsonValue[] = Array.isArray(schema.type) ? schema.type : typeof schema.type === "string" ? [schema.type] : [];
    if (types.includes("string")) return null;
    if (types.includes("object") || (types.length === 0 && (isJsonObject(schema.properties) || Array.isArray(schema.required)))) return "an object";
    if (types.includes("array") || (types.length === 0 && (schema.items !== undefined || Array.isArray(schema.prefixItems)))) return "an array";
    return null;
}

/** Whether a text is a JSON object or array written as text. */
function looksLikeJsonStructure(text: string): boolean {
    const trimmed = text.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return false;
    try {
        const parsed: unknown = JSON.parse(trimmed);
        return parsed !== null && typeof parsed === "object";
    } catch {
        return false;
    }
}

/**
 * Batch 7 (s-2): a warning for each text in a state's input that is a JSON object or array written as a string where its
 * schema asks for an object or an array (the 2026-11-04 send: input: '{"fact": "..."}' for a contract that takes
 * { fact }). Bound inputs are walked too, as far as their schema is known; a binding is not text.
 */
function warnJsonText(value: JsonValue, schema: JsonValue | undefined, defs: Record<string, JsonValue>, path: string, diagnostics: Diagnostics, depth = 0): void {
    if (depth > 32) return;
    const target = schemaTarget(defs, schema);
    if (typeof value === "string") {
        const wanted = schemaWantsStructure(target);
        if (wanted && looksLikeJsonStructure(value)) {
            diagnostics.warning("WORKFLOW_INPUT_JSON_TEXT", path,
                `This is a text string that looks like JSON. Write it as a YAML value (no quotes) so it is ${wanted}.`);
        }
        return;
    }
    if (!isJsonObject(target)) return;
    if (Array.isArray(value)) {
        value.forEach((item, index) => {
            const itemSchema = Array.isArray(target.prefixItems) && index < target.prefixItems.length ? target.prefixItems[index] : target.items;
            warnJsonText(item, itemSchema as JsonValue | undefined, defs, `${path}[${index}]`, diagnostics, depth + 1);
        });
        return;
    }
    if (isJsonObject(value)) {
        const properties = isJsonObject(target.properties) ? target.properties : {};
        for (const [key, item] of Object.entries(value)) {
            const itemSchema = Object.hasOwn(properties, key) ? properties[key] : isJsonObject(target.additionalProperties) ? target.additionalProperties : undefined;
            warnJsonText(item, itemSchema, defs, `${path}.${key}`, diagnostics, depth + 1);
        }
    }
}

/** Whether a value holds a binding anywhere (bindingRootsOf; an unparsable binding counts as one). */
function holdsBinding(value: JsonValue): boolean {
    try { return bindingRootsOf(value).size > 0; } catch { return true; }
}

/**
 * The longest object key the compiler matches against a schema's patterns (E2bm-R1). A pattern the compiler accepts can
 * still take time that grows as a power of its input (repeats side by side, such as a*a*), so a longer key is not
 * matched here: its member, and any fixed part that holds such a key, are left to the run's own check.
 */
const COMPILE_TIME_KEY_MAX_LENGTH = 256;

/** Whether a value has an object key longer than COMPILE_TIME_KEY_MAX_LENGTH anywhere (E2bm-R1). */
function holdsLongKey(value: JsonValue): boolean {
    const stack: JsonValue[] = [value];
    while (stack.length > 0) {
        const next = stack.pop() as JsonValue;
        if (Array.isArray(next)) {
            for (const item of next) stack.push(item);
        } else if (isJsonObject(next)) {
            for (const [key, item] of Object.entries(next)) {
                if (key.length > COMPILE_TIME_KEY_MAX_LENGTH) return true;
                stack.push(item);
            }
        }
    }
    return false;
}

/**
 * The schema a member of an object must match (E2-R3, as JSON Schema applies them): its property's schema and the
 * schema of every patternProperties name its key matches, all of them (allOf); only a key that neither names nor
 * matches takes additionalProperties. Undefined when nothing applies, or when a pattern cannot be evaluated here (the
 * run checks that member): an unsafe pattern, or a key longer than COMPILE_TIME_KEY_MAX_LENGTH (E2bm-R1).
 */
function memberSchema(target: { [key: string]: JsonValue }, key: string): JsonValue | undefined {
    const applied: JsonValue[] = [];
    const properties = isJsonObject(target.properties) ? target.properties : {};
    const named = Object.hasOwn(properties, key);
    if (named) applied.push(properties[key]);
    let matched = false;
    if (isJsonObject(target.patternProperties)) {
        if (key.length > COMPILE_TIME_KEY_MAX_LENGTH && Object.keys(target.patternProperties).length > 0) return undefined;
        for (const [pattern, schema] of Object.entries(target.patternProperties)) {
            // Only a pattern the compiler accepts is evaluated (an unsafe one is refused where the schema is checked).
            if (unsafeSchemaPattern(pattern) !== null) return undefined;
            let matches: boolean;
            try { matches = new RegExp(pattern, "u").test(key); } catch { return undefined; }
            if (matches) { applied.push(schema); matched = true; }
        }
    }
    if (!named && !matched && target.additionalProperties !== undefined && target.additionalProperties !== true) applied.push(target.additionalProperties);
    return applied.length === 0 ? undefined : applied.length === 1 ? applied[0] : { allOf: applied };
}

/** A fixed part of a partly bound input: where it is, the value as written, and the schema it must match. */
interface FixedPart { pointer: string; value: JsonValue; schema: JsonValue }

/**
 * The fixed parts of a partly bound input and what a bound part's written-out object must have (adversarial review SF-8
 * and its verification): a part with no binding is collected whole, to be validated with the run's own validator; in a
 * part that holds a binding, an object written out must have its schema's required properties (returned as problems),
 * and its members and array items are visited with their own schemas (memberSchema: properties and matching
 * patternProperties together, else additionalProperties; prefixItems or items). Composed schemas (allOf, anyOf, oneOf)
 * are visited no further: the run checks them.
 */
function fixedParts(value: JsonValue, schema: JsonValue | undefined, defs: Record<string, JsonValue>, pointer: string,
    parts: FixedPart[], problems: string[], depth = 0): void {
    if (depth > 32 || schema === undefined) return;
    if (!holdsBinding(value)) {
        // The run's validator matches every key against the schema's patterns: a part with a very long key is left to the run.
        if (!holdsLongKey(value)) parts.push({ pointer, value, schema });
        return;
    }
    const target = schemaTarget(defs, schema);
    if (!isJsonObject(target)) return;
    if (Array.isArray(value)) {
        value.forEach((item, index) => {
            const itemSchema = Array.isArray(target.prefixItems) && index < target.prefixItems.length ? target.prefixItems[index] : target.items;
            fixedParts(item, itemSchema as JsonValue | undefined, defs, `${pointer}/${index}`, parts, problems, depth + 1);
        });
        return;
    }
    if (!isJsonObject(value)) return;
    const required = Array.isArray(target.required) ? target.required.filter((key): key is string => typeof key === "string") : [];
    for (const key of required) if (!Object.hasOwn(value, key)) problems.push(`${pointer || "/"} must have required property '${key}'`);
    for (const [key, item] of Object.entries(value)) {
        fixedParts(item, memberSchema(target, key), defs, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, parts, problems, depth + 1);
    }
}

/**
 * The first problems of a partly bound input's fixed parts, as "<pointer> <problem>" (SF-8 verification): each fixed
 * part is validated whole against its schema with the run's validator (nested required properties, minimum, pattern,
 * items and the rest), and each written-out object that holds a binding must have its required properties.
 */
function fixedPartsProblems(input: JsonValue, schema: JsonValue, defs: Record<string, JsonValue>): string[] {
    const parts: FixedPart[] = [];
    const problems: string[] = [];
    fixedParts(input, schema, defs, "", parts, problems);
    if (parts.length > 0) {
        // Each part's schema is added under a name no workflow schema can have (they start with a letter), so its own
        // references still resolve against the workflow's schemas.
        const named = Object.fromEntries(parts.map((part, index) => [`_fixed.${index}`, part.schema]));
        const validator = new WorkflowSchemaSet({ ...defs, ...named });
        parts.forEach((part, index) => {
            for (const problem of validator.validate(`_fixed.${index}`, part.value)) {
                problems.push(`${part.pointer}${problem.path === "/" ? "" : problem.path || ""} ${problem.message}`.replace(/^ /, "/ "));
            }
        });
    }
    return problems;
}

/**
 * Batch 7 (s-1): a state's input that has no binding anywhere is fixed, so it is checked against the schema the run
 * checks it against, with the run's own validator (WorkflowSchemaSet): a send's or request's contract, and a script's or
 * agent's inputSchema. A mismatch is a definition error (the run would fail invalid_input), naming the first problems.
 * Every such input, bound or not, is also checked for JSON written as text (s-2, a warning).
 */
function checkFixedInputs(nodes: Record<string, WorkflowIRNode>, contracts: Record<string, { schema: string }>, defs: Record<string, JsonValue>,
    diagnostics: Diagnostics): void {
    let validator: WorkflowSchemaSet | null = null;
    for (const node of Object.values(nodes)) {
        if (!("hasInput" in node) || !node.hasInput) continue;
        const target = node.type === "messaging" && (node.mode === "send" || node.mode === "request")
            ? { schema: contracts[node.contract]?.schema ?? null, what: `contract '${node.contract}'` }
            : (node.type === "script" || node.type === "agent") && node.inputSchema ? { schema: node.inputSchema, what: "its inputSchema" } : null;
        const schemaName = target?.schema ?? null;
        if (!target || !schemaName || !Object.hasOwn(defs, schemaName)) continue;
        const path = `states.${node.id}.input`;
        warnJsonText(node.input, defs[schemaName], defs, path, diagnostics);
        let bound: boolean;
        try { bound = bindingRootsOf(node.input).size > 0; } catch { continue; }
        if (bound) {
            // SF-8: the fixed parts of a partly bound input are checked too, each whole, with the run's validator.
            const problems = fixedPartsProblems(node.input, defs[schemaName], defs);
            if (problems.length) {
                diagnostics.error("WORKFLOW_STATE_INPUT_INVALID", path, `a fixed part of this input is sent as written, and it does not match ${target.what}: `
                    + `${problems.slice(0, 3).join("; ")}.`);
            }
            continue;
        }
        // E2bm-R1: an input with a very long key is not matched against the schema's patterns here; the run checks it.
        if (holdsLongKey(node.input)) continue;
        validator ??= new WorkflowSchemaSet(defs);
        const problems = validator.validate(schemaName, node.input);
        if (problems.length) {
            diagnostics.error("WORKFLOW_STATE_INPUT_INVALID", path, `this input has no binding, so it is sent as written, and it does not match ${target.what}: `
                + `${problems.slice(0, 3).map(problem => `${problem.path} ${problem.message}`).join("; ")}.`);
        }
    }
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
export function parseWorkflowIr(value: JsonValue, options: { maxIrVersion?: number } = {}): WorkflowIR {
    // A worker reads only the versions it runs: request states (version 7) are read only when asked for.
    const maxIrVersion = options.maxIrVersion ?? WORKFLOW_V2_RUNNABLE_IR_VERSION;
    need(isJsonObject(value), "stored IR is not an object");
    need(value.irVersion === 1 || value.irVersion === 2 || value.irVersion === 3 || value.irVersion === 4 || value.irVersion === 5
        || value.irVersion === 6 || (value.irVersion === 7 && maxIrVersion >= WORKFLOW_V2_REQUEST_IR_VERSION)
        || (value.irVersion === 8 && maxIrVersion >= WORKFLOW_V2_AGENT_IR_VERSION),
        `stored IR version ${String(value.irVersion)} is not supported by this worker`);
    const irVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 = value.irVersion;
    // A field a version introduced must be stated (null when absent) from that version on.
    const rootOutputSchema = irVersion === 1 && !Object.hasOwn(value, "outputSchema") ? null : value.outputSchema;
    const catchAll = irVersion < 3 && !Object.hasOwn(value, "catchAll") ? null : value.catchAll;
    need(value.apiVersion === WORKFLOW_V2_API_VERSION, "stored IR has a different apiVersion");
    need(typeof value.name === "string" && typeof value.version === "string" && typeof value.initial === "string"
        && nullableString(value.description) && nullableString(value.inputsSchema) && nullableString(rootOutputSchema)
        && nullableString(catchAll), "stored IR header is invalid");
    need(isJsonObject(value.limits) && typeof value.limits.maxNodeExecutions === "number", "stored IR limits are invalid");
    // A run deadline is stored from version 8 on, with both its fields.
    const deadlineSeconds = value.limits.timeoutSeconds;
    const onExceeded = value.limits.onExceeded;
    need((deadlineSeconds === undefined && onExceeded === undefined) || (irVersion >= WORKFLOW_V2_AGENT_IR_VERSION
        && typeof deadlineSeconds === "number" && Number.isSafeInteger(deadlineSeconds) && deadlineSeconds >= 1
        && deadlineSeconds <= WORKFLOW_V2_RUN_TIMEOUT_MAX_SECONDS && onExceeded === "expired"), "stored IR run deadline is invalid");
    need(isJsonObject(value.schemaDefs) && isJsonObject(value.nodes), "stored IR schemas or nodes are invalid");
    need(Object.hasOwn(value, "initialInput"), "stored IR has no initialInput");
    const schemaDefs = value.schemaDefs;
    let contracts: Record<string, WorkflowIRContract> | undefined;
    if (irVersion >= WORKFLOW_V2_MESSAGING_IR_VERSION) {
        need(isJsonObject(value.contracts), "stored IR contracts are invalid");
        contracts = {};
        for (const [contractName, contract] of Object.entries(value.contracts)) {
            need(CONTRACT_NAME_PATTERN.test(contractName) && isJsonObject(contract) && typeof contract.schema === "string"
                && Object.hasOwn(schemaDefs, contract.schema), `stored IR contract ${contractName} is invalid`);
            if (Object.hasOwn(contract, "response")) {
                // A response is version 7's; an earlier version with one is not read as if it had none.
                const response = contract.response;
                need(irVersion >= WORKFLOW_V2_REQUEST_IR_VERSION && isJsonObject(response) && Object.keys(response).length === 1
                    && typeof response.schema === "string" && Object.hasOwn(schemaDefs, response.schema),
                    `stored IR contract ${contractName} has an invalid response`);
                contracts[contractName] = { schema: contract.schema, response: { schema: response.schema } };
            } else contracts[contractName] = { schema: contract.schema };
        }
    } else need(!Object.hasOwn(value, "contracts"), "stored IR has contracts before version 5");
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
        } else if (node.type === "wait") {
            const seconds = node.seconds;
            need(irVersion >= WORKFLOW_V2_WAIT_IR_VERSION && (typeof seconds === "number" || typeof seconds === "string")
                && typeof node.hasInput === "boolean" && Object.hasOwn(node, "input") && stringMap(node.next),
                `stored IR wait ${id} is invalid`);
            nodes[id] = { id, type: "wait", description: node.description, seconds, hasInput: node.hasInput, input: node.input, next: node.next };
        } else if (node.type === "messaging" && node.mode === "send") {
            const recipient = node.recipient;
            need(irVersion >= WORKFLOW_V2_SEND_IR_VERSION && contracts !== undefined && typeof node.contract === "string"
                && Object.hasOwn(contracts, node.contract)
                && isJsonObject(recipient) && Object.keys(recipient).length === 1 && (recipient.parent === true || typeof recipient.sessionId === "string")
                && typeof node.hasInput === "boolean" && Object.hasOwn(node, "input") && stringMap(node.next),
                `stored IR messaging state ${id} is invalid`);
            nodes[id] = {
                id, type: "messaging", description: node.description, mode: "send", contract: node.contract,
                recipient: typeof recipient.sessionId === "string" ? { sessionId: recipient.sessionId } : { parent: true },
                correlate: Object.hasOwn(node, "correlate") ? node.correlate : null,
                hasInput: node.hasInput, input: node.input, next: node.next,
            };
        } else if (node.type === "messaging" && node.mode === "request") {
            const recipient = node.recipient;
            const timeoutSeconds = node.timeoutSeconds;
            need(irVersion >= WORKFLOW_V2_REQUEST_IR_VERSION && contracts !== undefined && typeof node.contract === "string"
                && Object.hasOwn(contracts, node.contract) && contracts[node.contract].response !== undefined
                && isJsonObject(recipient) && Object.keys(recipient).length === 1 && (recipient.parent === true || typeof recipient.sessionId === "string")
                && Object.hasOwn(node, "correlate") && (typeof timeoutSeconds === "number" || typeof timeoutSeconds === "string")
                && typeof node.hasInput === "boolean" && Object.hasOwn(node, "input") && stringMap(node.next),
                `stored IR messaging state ${id} is invalid`);
            nodes[id] = {
                id, type: "messaging", description: node.description, mode: "request", contract: node.contract,
                recipient: typeof recipient.sessionId === "string" ? { sessionId: recipient.sessionId } : { parent: true },
                correlate: node.correlate, hasInput: node.hasInput, input: node.input, timeoutSeconds, next: node.next,
            };
        } else if (node.type === "messaging") {
            const from = node.from;
            const waitSeconds = node.waitSeconds;
            const validFrom = from === null || (isJsonObject(from) && Object.keys(from).length === 1
                && (from.parent === true || typeof from.sessionId === "string"));
            need(contracts !== undefined && node.mode === "receive" && typeof node.contract === "string" && Object.hasOwn(contracts, node.contract)
                && validFrom && Object.hasOwn(node, "correlate")
                && (waitSeconds === null || typeof waitSeconds === "number" || typeof waitSeconds === "string")
                && typeof node.hasInput === "boolean" && Object.hasOwn(node, "input") && stringMap(node.next),
                `stored IR messaging state ${id} is invalid`);
            const sender: WorkflowIRSender | null = from === null ? null
                : isJsonObject(from) && typeof from.sessionId === "string" ? { sessionId: from.sessionId } : { parent: true };
            nodes[id] = {
                id, type: "messaging", description: node.description, mode: "receive", contract: node.contract, from: sender,
                correlate: node.correlate, waitSeconds, hasInput: node.hasInput, input: node.input, next: node.next,
            };
        } else if (node.type === "agent") {
            const invoke = node.invoke;
            const agent = isJsonObject(invoke) && isJsonObject(invoke.agent) ? invoke.agent : null;
            // A named package agent may name its workflow interface (present only when named, with its package).
            const storedInterface = agent !== null && Object.hasOwn(agent, "interface") ? agent.interface : undefined;
            const validInterface = storedInterface === undefined || (isJsonObject(storedInterface) && Object.keys(storedInterface).length === 2
                && typeof storedInterface.name === "string" && WORKFLOW_INTERFACE_NAME_PATTERN.test(storedInterface.name)
                && typeof storedInterface.version === "string" && WORKFLOW_INTERFACE_VERSION_PATTERN.test(storedInterface.version)
                && typeof agent?.package === "string");
            const validInvoke = isJsonObject(invoke) && Object.keys(invoke).length === 1
                && (typeof invoke.prompt === "string" || (agent !== null && Object.keys(agent).length === (storedInterface === undefined ? 3 : 4)
                    && typeof agent.name === "string" && nullableString(agent.package) && nullableString(agent.version) && validInterface));
            const timeoutSeconds = node.timeoutSeconds;
            need(irVersion >= WORKFLOW_V2_AGENT_IR_VERSION && validInvoke && typeof node.hasInput === "boolean" && Object.hasOwn(node, "input")
                && nullableString(node.inputSchema) && nullableString(node.outputSchema) && stringArray(node.outcomes) && node.outcomes.length > 0
                && (typeof timeoutSeconds === "number" || typeof timeoutSeconds === "string") && stringMap(node.next),
                `stored IR agent state ${id} is invalid`);
            const named = isJsonObject(storedInterface) ? { name: storedInterface.name as string, version: storedInterface.version as string } : null;
            nodes[id] = {
                id, type: "agent", description: node.description,
                invoke: agent !== null
                    ? { agent: { name: agent.name as string, package: agent.package as string | null, version: agent.version as string | null,
                        ...(named !== null ? { interface: named } : {}) } }
                    : { prompt: (invoke as { prompt: string }).prompt },
                hasInput: node.hasInput, input: node.input, inputSchema: node.inputSchema, outputSchema: node.outputSchema,
                outcomes: node.outcomes, timeoutSeconds, next: node.next,
            };
        } else if (node.type === "parallel") {
            const body = node.body;
            need(irVersion >= WORKFLOW_V2_AGENT_IR_VERSION && Object.hasOwn(node, "forEach") && typeof node.concurrency === "number"
                && Number.isInteger(node.concurrency) && node.concurrency >= 1 && node.concurrency <= WORKFLOW_V2_PARALLEL_MAX_CONCURRENCY && node.join === "all_required" && typeof node.failFast === "boolean"
                && nullableString(node.inputSchema) && nullableString(node.outputSchema)
                && isJsonObject(body) && typeof body.initial === "string" && stringArray(body.states) && body.states.includes(body.initial)
                && stringMap(node.next), `stored IR parallel state ${id} is invalid`);
            nodes[id] = {
                id, type: "parallel", description: node.description, forEach: node.forEach, concurrency: node.concurrency, join: "all_required",
                failFast: node.failFast, inputSchema: node.inputSchema, outputSchema: node.outputSchema,
                body: { initial: body.initial, states: [...body.states] }, next: node.next,
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
    // A parallel state's body states exist, hold no parallel state, and belong to one body only.
    const bodyMembers = new Set<string>();
    for (const node of Object.values(nodes)) {
        if (node.type !== "parallel") continue;
        for (const member of node.body.states) {
            need(Object.hasOwn(nodes, member) && nodes[member].type !== "parallel" && !bodyMembers.has(member), `stored IR parallel state ${node.id} has an invalid body`);
            bodyMembers.add(member);
        }
    }
    need(!bodyMembers.has(value.initial), "stored IR initial state is a body state");
    need(catchAll === null || Object.hasOwn(nodes, catchAll), "stored IR catch-all state is missing");
    need(catchAll === null || !bodyMembers.has(catchAll), "stored IR catch-all state is a body state");
    return {
        irVersion, apiVersion: WORKFLOW_V2_API_VERSION, name: value.name, version: value.version,
        description: value.description, initial: value.initial, initialInput: value.initialInput,
        inputsSchema: value.inputsSchema, outputSchema: rootOutputSchema, catchAll,
        limits: { maxNodeExecutions: value.limits.maxNodeExecutions,
            ...(typeof deadlineSeconds === "number" ? { timeoutSeconds: deadlineSeconds, onExceeded: "expired" as const } : {}) },
        schemaDefs, ...(contracts !== undefined ? { contracts } : {}), nodes,
    };
}
