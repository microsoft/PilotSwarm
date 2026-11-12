import { isScalar, parseDocument, visit, type Document } from "yaml";
import { bindingRootsOf, parseBindingExpression, validateBindingTemplate, WorkflowBindingError } from "./bindings.js";
import { canonicalJson, isJsonObject, isStorableText, sha256Hex, WorkflowJsonError, type JsonValue } from "./json.js";
import { normalizeSchema, SCHEMA_NAME_PATTERN, schemaReferences, wholeSchemaRefusal, WorkflowSchemaError, WorkflowSchemaSet } from "./schema.js";
import { schemaPlaceWords, schemaPointerParts } from "./schema-words.js";
import { isValidTimezone, normalizeCronAtInput } from "../cron-at.js";
import { scriptToolRequirements, WORKFLOW_TOOL_CONCURRENCY_MESSAGE } from "./script-analysis.js";

/**
 * Workflow compiler: YAML -> diagnostics and an immutable, hashed IR.
 *
 * Compilation never executes anything. An invalid document still yields a
 * stable YAML hash and field-level diagnostics, so a draft can be stored and
 * reviewed; only a valid document produces IR. The runtime interprets the
 * stored IR of a published revision and never recompiles its YAML, so a
 * compiler change cannot alter an admitted run.
 */

export const WORKFLOW_API_VERSION = "pilotswarm.dev/v1";
export const WORKFLOW_KIND = "Workflow";
/**
 * The IR version this compiler writes, and the only one a reader takes. Stored IR is never rewritten or recompiled: a
 * run reads the IR its revision was compiled to.
 */
export const WORKFLOW_IR_VERSION = 1;
/** A wait state's seconds: an integer in this range, literal or bound. */
export const WAIT_MAX_SECONDS = 2_592_000;
/** Request, receive, agent and parallel deadlines keep the one-day bound. */
export const STATE_TIMEOUT_MAX_SECONDS = 86_400;
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
export const WORKFLOW_PARALLEL_MAX_ITEMS = 64;
/** FU-17: the most tools one agent state's `tools` list names. */
export const WORKFLOW_AGENT_TOOLS_MAX = 64;
/** FU-17: a tool name in an agent state's `tools` list, as the agent sees it (a PilotSwarm, built-in or MCP tool). */
export const WORKFLOW_AGENT_TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:\/-]{0,127}$/;
/** FU-17: the tool an agent state's own session always keeps: it is how the session finishes the state. */
export const WORKFLOW_AGENT_COMPLETION_TOOL = "complete_workflow_node";
/** The most branches of one parallel state that are active at once. */
export const WORKFLOW_PARALLEL_MAX_CONCURRENCY = 16;
/**
 * A run's deadline (root limits.timeoutSeconds): at most this many seconds,
 * counted from when the run begins. onExceeded expired (the only policy) ends the run failed with timed_out.
 */
export const WORKFLOW_RUN_TIMEOUT_MAX_SECONDS = 30 * 86_400;
export const WORKFLOW_RUN_ON_EXCEEDED = ["expired"] as const;
/** The largest inline task prompt of an agent state, in UTF-8 bytes. */
export const AGENT_PROMPT_MAX_BYTES = 32 * 1024;
/** The runtime error codes an agent state's agent may report itself (complete_workflow_node), apart from its business outcomes. */
export const AGENT_REPORTED_ERROR_CODES = ["needs_input", "execution_failed"] as const;
/** The largest response schema, with every schema it references, in UTF-8 bytes of their canonical JSON. */
export const REQUEST_RESPONSE_SCHEMA_MAX_BYTES = 8 * 1024;
/** Characters a workflow's name may not hold (R2-SF-3): control characters, line and paragraph separators, and direction controls. */
const WORKFLOW_NAME_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
/** A contract name: a name, '@' and a positive integer version, such as BuildEvent@1. */
export const CONTRACT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}@[1-9][0-9]{0,5}$/;
export const WORKFLOW_MAX_YAML_BYTES = 256 * 1024;
export const WORKFLOW_MAX_NODES = 100;
export const WORKFLOW_DEFAULT_MAX_NODE_EXECUTIONS = 1_000;
export const WORKFLOW_MAX_NODE_EXECUTIONS = 10_000;
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
export const SUPPORTED_NODE_TYPES = ["script", "wait", "messaging", "agent", "parallel", "terminal"] as const;
/** A state type that is named but not compiled: refused as unsupported rather than unknown. */
const KNOWN_NODE_TYPES = [...SUPPORTED_NODE_TYPES, "join"] as readonly string[];

/**
 * I2 (owner 2026-11-09T06:40Z; UXP-AC-01: a real user's session invented state types): words a writer uses for a state type,
 * and the type that does it (a messaging mode is its own `type` nowhere).
 */
const STATE_TYPE_WORDS: Readonly<Record<string, string>> = Object.freeze({
    send: "messaging with mode: send", receive: "messaging with mode: receive", request: "messaging with mode: request",
    message: "messaging", messages: "messaging", notify: "messaging with mode: send", ask: "messaging with mode: request",
    code: "script", js: "script", javascript: "script", node: "script", python: "script", function: "script", tool: "script",
    task: "script", action: "script", step: "script", check: "script", compute: "script", http: "script", fetch: "script",
    sleep: "wait", delay: "wait", timer: "wait", pause: "wait", schedule: "wait", poll: "wait",
    llm: "agent", ai: "agent", prompt: "agent", model: "agent", assistant: "agent", subagent: "agent", "sub-agent": "agent",
    end: "terminal", done: "terminal", stop: "terminal", finish: "terminal", final: "terminal", exit: "terminal", success: "terminal",
    foreach: "parallel", for_each: "parallel", "for-each": "parallel", map: "parallel", fork: "parallel", fanout: "parallel",
    fan_out: "parallel", "fan-out": "parallel", branch: "parallel", branches: "parallel",
});

/** The edit distance of two short words (I2's nearest type). Pure. */
function editDistance(a: string, b: string): number {
    const row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
        let diagonal = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j += 1) {
            const above = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
            diagonal = above;
        }
    }
    return row[b.length];
}

/**
 * I2: the type a writer most likely meant by `word`, of `types` (the ones this compile takes): a known word for one
 * (STATE_TYPE_WORDS), else the nearest by spelling (at most 2 edits, or a third of the word), else null. Pure.
 */
export function workflowNearestStateType(word: string, types: readonly string[]): string | null {
    const key = word.trim().toLowerCase();
    const meant = STATE_TYPE_WORDS[key];
    if (meant && types.includes(meant.split(" ")[0])) return meant;
    let best: { type: string; distance: number } | null = null;
    for (const type of types) {
        const distance = editDistance(key, type);
        if (!best || distance < best.distance) best = { type, distance };
    }
    return best && best.distance <= Math.max(2, Math.floor(key.length / 3)) ? best.type : null;
}

export type TerminalOutcome = typeof TERMINAL_OUTCOMES[number];
export type RuntimeErrorCode = typeof RUNTIME_ERROR_CODES[number];

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
/** A state id, route label or outcome: a letter, then up to 63 letters, digits, '_' or '-'. */
export const WORKFLOW_ID_PATTERN = ID_PATTERN;
/** A package workflow interface's name, as `interface: <name>@<version>` names it (design 04, 09). */
export const WORKFLOW_INTERFACE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** A package workflow interface's version label, such as `1`. */
export const WORKFLOW_INTERFACE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const API_VERSION_MARKER = /^apiVersion:\s*["']?pilotswarm\.dev\/v1["']?\s*(?:#.*)?$/m;

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

/**
 * A clock wait's time (Workflow Simplified stage 2.4): the next wall-clock time a cron_at schedule names, in its
 * time zone: `minute` alone (hourly), with `hour` (daily), with `dayOfWeek` (weekly, 0 Sunday) or `dayOfMonth` (monthly).
 */
export interface WorkflowIRClockWait {
    minute: number;
    hour?: number;
    dayOfWeek?: number;
    dayOfMonth?: number;
    tz: string;
}

export interface WorkflowIRWait {
    id: string;
    type: "wait";
    description: string | null;
    /**
     * An integer of seconds, or one whole-string binding evaluated and checked when the state is entered; null for a clock
     * wait (`at`).
     */
    seconds: number | string | null;
    /** A clock wait waits until the next time this names, decided once when the state is entered. */
    at?: WorkflowIRClockWait;
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
     * a workflow recipient's receive states match it.
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
 * A request state: one typed request of its contract to its
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
 * An agent state: an ordinary child agent session with the
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
    /**
     * The YAML's `session` (owner decision agent-node-continue-20261106): `continue` keeps ONE agent session for this state across its visits in a
     * run (each later visit is a new cycle prompt in the same session); absent for `new` (a new agent session each visit).
     * Owner 2026-11-09T05:38Z: `continue` is the default where it is allowed, so a compile writes it for an agent state
     * outside a parallel state's body (a For each body or a named branch) that does not set `session`; in a body an unset
     * `session` is `new`. Absent is still `new`, so a stored IR means what it meant; a Start compiles the revision's YAML
     * again, so a revision saved without `session` before the default changed starts with `continue`.
     */
    session?: "continue";
    /**
     * FU-17: the tools the state's agent session (and every session it starts) may use: `[]` for `tools: none`, else the names
     * listed; the session always keeps complete_workflow_node. Absent: every tool its session has (the IR of a definition that
     * does not set it is unchanged).
     */
    tools?: string[];
    /** Tools that this agent must call at least once in each visit before reporting an outcome. */
    requiredTools?: string[];
}

/**
 * A parallel state: its manifest (`forEach`, evaluated once
 * on entry and frozen as the state's input; a JSON array of at most
 * WORKFLOW_PARALLEL_MAX_ITEMS items) runs one branch per item through
 * its body, at most `concurrency` at a time. A branch starts at the body's
 * initial state with its item as input (`branch.item` and `branch.index` in
 * its bindings) and ends at a body terminal. The join `all_required` (k is
 * the item count n): when every branch ended, the state's outcome is
 * `joined` (every branch ended succeeded; its output is their outputs in
 * manifest order) or `blocked` (its output lists every branch's outcome and
 * output). The join `{ first: k }` is joined as soon as k branches
 * succeeded (its output is `[{ index, output }]` of those k, in the order the
 * store committed their successes, ties by index); the branches still running
 * are cancelled and the queued ones not started. Either join is blocked once
 * k successes cannot happen: with `failFast` the other branches are cancelled
 * at once, without it they run to their end first. An optional
 * `timeoutSeconds`, from the state's entry, races the join: a success counts
 * only when committed by then. When it passes, the running branches are
 * cancelled; with k counted successes the state still joins, with fewer it
 * ends with the runtime error timed_out (its details report every branch,
 * finished ones with their output or error), or blocked when k could already
 * no longer happen (owner decision join-k-of-n; formal questions Q1 to Q3).
 */
export interface WorkflowIRParallel {
    id: string;
    type: "parallel";
    description: string | null;
    /** A JSON template (a binding or a literal array) that gives the manifest; null for a state with named branches. */
    forEach: JsonValue;
    /**
     * Named branches, in their declared order (branch i is the manifest's item i): each its own graph, from its own
     * initial over its own states (all of them in `body.states` too), started with its `input` (a template read in the
     * parallel state's scope when it is entered; without one, the value that arrived at the parallel state). Its joined
     * output is `{ <name>: output }`; `branch.name` binds in its states. Absent: a For each over `forEach`.
     */
    branches?: WorkflowIRBranch[];
    concurrency: number;
    /** Every branch must succeed (k = n), or joined at the first k successes. */
    join: "all_required" | { first: number };
    failFast: boolean;
    /** The state's own time limit, seconds from its entry (an integer, or one binding read at entry); absent without one. */
    timeoutSeconds?: number | string;
    /** The manifest's schema (the whole array). */
    inputSchema: string | null;
    /** The schema of the joined output (the array of branch outputs). */
    outputSchema: string | null;
    /** Its body: the initial state and every body state's id (each in `nodes`). */
    body: { initial: string; states: string[] };
    /** Route label -> target node: joined, blocked, and runtime routes. */
    next: Record<string, string>;
}

/** One named branch of a parallel state. */
export interface WorkflowIRBranch {
    name: string;
    initial: string;
    states: string[];
    hasInput: boolean;
    input: JsonValue;
}

export interface WorkflowIRContract {
    /** The schema (in schemaDefs) every payload of this contract must satisfy. */
    schema: string;
    /** The schema (in schemaDefs) a response to a request of this contract must satisfy. */
    response?: { schema: string };
}

export type WorkflowIRNode = WorkflowIRScript | WorkflowIRWait | WorkflowIRMessaging | WorkflowIRAgent | WorkflowIRParallel | WorkflowIRTerminal;

export interface WorkflowIR {
    irVersion: typeof WORKFLOW_IR_VERSION;
    apiVersion: typeof WORKFLOW_API_VERSION;
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
     * maxNodeExecutions, and an optional run deadline: timeoutSeconds, counted from when the run begins,
     * with its policy onExceeded (expired: the run ends failed with timed_out). Both are absent without a deadline.
     */
    limits: { maxNodeExecutions: number; timeoutSeconds?: number; onExceeded?: typeof WORKFLOW_RUN_ON_EXCEEDED[number] };
    schemaDefs: Record<string, JsonValue>;
    /** The root contracts (an empty map when there are none). Its messaging states name them. */
    contracts: Record<string, WorkflowIRContract>;
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

/** True when the text declares the Workflow apiVersion (spawn_workflow refuses any other document). */
export function declaresWorkflow(yaml: string): boolean {
    return typeof yaml === "string" && API_VERSION_MARKER.test(yaml);
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

/**
 * UXFD-F2: a duplicated key's words name the key and both lines, as `Duplicate key "required" at line 11 (first at line 8)`,
 * from the key the parser flags (its offset) and the first key of the same name in the same map; null when not found.
 */
function duplicateKeyWords(document: Document, yaml: string, offset: number | undefined): string | null {
    if (typeof offset !== "number") return null;
    let words: string | null = null;
    visit(document, {
        Map(_key, map) {
            if (words !== null) return visit.BREAK;
            const keys = map.items.map(pair => pair.key).filter(isScalar);
            const second = keys.find(key => key.range?.[0] === offset);
            if (!second) return undefined;
            const first = keys.find(key => key !== second && key.value === second.value && (key.range?.[0] ?? Infinity) < offset);
            if (!first) return undefined;
            words = `Duplicate key "${String(second.value).slice(0, 100)}" at line ${lineOf(yaml, offset)} (first at line ${lineOf(yaml, first.range?.[0])}): `
                + "a mapping may name each key once.";
            return visit.BREAK;
        },
    });
    return words;
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
        // Review R1: only a whole named schema, never a pointer into one.
        if (name.includes("/")) {
            diagnostics.error("WORKFLOW_SCHEMA_INVALID", `${path}.$ref`, `${path}.$ref: ${wholeSchemaRefusal(value.$ref)}`);
            return null;
        }
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
                if (Array.isArray(target)) {
                    // Arrow shorthand (next: [a, b]) is not built (owner 2026-11-08): say what runs several nodes at once.
                    diagnostics.error("WORKFLOW_TARGET_INVALID", `${path}.transition.next.${label}`,
                        `route '${label}' lists several states: a route has one target; use a parallel state with branches to run several nodes at once.`);
                } else if (typeof target !== "string" || !nodeIds.has(target)) {
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
        diagnostics.error("WORKFLOW_RUNTIME_UNSUPPORTED", `${path}.runtime`, "Workflow scripts run as Node ES modules; runtime must be 'node' when given.");
    }
    const source = typeof raw.source === "string" && raw.source.trim() ? raw.source : null;
    if (!source) diagnostics.error("WORKFLOW_FIELD_REQUIRED", `${path}.source`, "a script needs non-empty source.");
    if (source) {
        const analysis = scriptToolRequirements(source);
        if (analysis.syntaxError) diagnostics.error("WORKFLOW_SCRIPT_SYNTAX", `${path}.source`,
            `This script is not a valid Node ES module: ${analysis.syntaxError}`);
        else if (analysis.unchecked) diagnostics.warning("WORKFLOW_SCRIPT_UNCHECKED", `${path}.source`,
            "This script is too deeply nested to analyze. Its module syntax and tool requirements could not be checked; run-time checks still apply.");
        if (analysis.concurrent) diagnostics.warning("WORKFLOW_TOOLS_CONCURRENT", `${path}.source`,
            `Promise.all or Promise.allSettled may overlap this script's tool calls. ${WORKFLOW_TOOL_CONCURRENCY_MESSAGE}`);
    }
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
/** Duration bounds apply to the individual field, including its value after binding at entry. */
function secondsField(value: unknown, path: string, diagnostics: Diagnostics, field = "seconds",
    maximum = STATE_TIMEOUT_MAX_SECONDS, guidance = ""): number | string | null {
    const message = `${field} must be an integer from 1 to ${maximum}, or one \${...} binding that gives one.`
        + (maximum === WAIT_MAX_SECONDS ? " This is 30 days per wait, not per run. For longer observation, use bounded repeated waits; see workflow-polling." : "")
        + guidance;
    if (typeof value === "number") {
        if (!Number.isInteger(value) || value < 1 || value > maximum) { diagnostics.error("WORKFLOW_FIELD_INVALID", path, message); return null; }
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

/** The fields of a clock wait's `at`, as the cron_at tool names them. */
const CLOCK_WAIT_FIELDS = ["minute", "hour", "day_of_week", "day_of_month", "tz"] as const;

/**
 * A wait's `at`: the cron_at tool's fields (minute; hour; day_of_week or day_of_month, with hour; tz, an IANA
 * time zone), literal, checked by the cron_at rules. Null with its diagnostics when it is not one.
 */
function clockWaitField(value: unknown, path: string, diagnostics: Diagnostics): WorkflowIRClockWait | null {
    if (!isJsonObject(value)) {
        diagnostics.error("WORKFLOW_FIELD_INVALID", path, "at must be a mapping of the cron_at fields: minute, and optionally hour, day_of_week or "
            + "day_of_month (with hour), and tz, such as { minute: 0, hour: 9, tz: America/Los_Angeles }.");
        return null;
    }
    checkKeys(value, CLOCK_WAIT_FIELDS, path, diagnostics);
    for (const key of CLOCK_WAIT_FIELDS) {
        if (key !== "tz" && value[key] !== undefined && typeof value[key] !== "number") {
            diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.${key}`, `${key} must be a number (a clock wait's time is literal).`);
            return null;
        }
    }
    if (typeof value.tz === "string" && value.tz.trim() && !isValidTimezone(value.tz.trim())) {
        diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.tz`, `tz is not a recognized IANA time zone: ${value.tz}.`);
        return null;
    }
    const normalized = normalizeCronAtInput({ minute: value.minute as number | undefined, hour: value.hour as number | undefined,
        day_of_week: value.day_of_week as number | undefined, day_of_month: value.day_of_month as number | undefined,
        tz: typeof value.tz === "string" ? value.tz : undefined, reason: "wait" });
    if (!normalized.ok) {
        diagnostics.error("WORKFLOW_FIELD_INVALID", path, normalized.error.replace(/^cron_at /, "at ").replace(/cron_at '/g, "'"));
        return null;
    }
    const schedule = normalized.schedule;
    return {
        minute: schedule.minute, ...(schedule.hour !== undefined ? { hour: schedule.hour } : {}),
        ...(schedule.dayOfWeek !== undefined ? { dayOfWeek: schedule.dayOfWeek } : {}),
        ...(schedule.dayOfMonth !== undefined ? { dayOfMonth: schedule.dayOfMonth } : {}), tz: schedule.tz,
    };
}

/** A clock wait's time in words: "the next 09:00 (America/Los_Angeles)", "the next Monday 09:00 (UTC)", ":30 past the next hour (UTC)". */
export function workflowClockWaitWords(at: WorkflowIRClockWait): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    if (at.hour === undefined) return `:${pad(at.minute)} past the next hour (${at.tz})`;
    const time = `${pad(at.hour)}:${pad(at.minute)}`;
    if (at.dayOfWeek !== undefined) {
        const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][at.dayOfWeek];
        return `the next ${day} ${time} (${at.tz})`;
    }
    if (at.dayOfMonth !== undefined) return `the next day ${at.dayOfMonth} of a month, ${time} (${at.tz})`;
    return `the next ${time} (${at.tz})`;
}

function compileWait(id: string, raw: Record<string, unknown>, nodeIds: ReadonlySet<string>, hasCatchAll: boolean, diagnostics: Diagnostics)
    : WorkflowIRWait | null {
    const path = `states.${id}`;
    checkKeys(raw, ["type", "description", "seconds", "at", "input", "transition"], path, diagnostics);
    // Stage 2.4: a wait waits a number of seconds, or until a clock time (`at`); exactly one of the two.
    const clock = Object.hasOwn(raw, "at");
    if (clock && Object.hasOwn(raw, "seconds")) {
        diagnostics.error("WORKFLOW_FIELD_INVALID", path, "a wait has seconds or at, not both.");
    }
    const at = clock ? clockWaitField(raw.at, `${path}.at`, diagnostics) : null;
    const seconds = clock ? null : secondsField(raw.seconds, `${path}.seconds`, diagnostics, "seconds", WAIT_MAX_SECONDS);
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
    if (clock ? at === null : seconds === null) return null;
    return { id, type: "wait", description: optionalText(raw.description, `${path}.description`, diagnostics), seconds, ...(at ? { at } : {}),
        hasInput, input, next };
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
 * A request state: one typed request of its contract, which must
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
 * A messaging state: mode receive, send (compileSend) or request
 * (compileRequest). A receive state takes one
 * typed message of its contract, from its sender and with its correlation,
 * that a sender gave the run (send_workflow_input) before or after the
 * state was entered, in the order the run accepted them. An optional wait
 * races it; the store decides which comes first. A send state is
 * compileSend's.
 */
function compileMessaging(id: string, raw: Record<string, unknown>, nodeIds: ReadonlySet<string>, contracts: ReadonlySet<string>, hasCatchAll: boolean,
    diagnostics: Diagnostics, responding: ReadonlySet<string>): WorkflowIRMessaging | null {
    const path = `states.${id}`;
    if (raw.mode === "send") return compileSend(id, raw, nodeIds, contracts, hasCatchAll, diagnostics);
    if (raw.mode === "request") return compileRequest(id, raw, nodeIds, contracts, responding, hasCatchAll, diagnostics);
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
 * An agent state: an ordinary child
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
    checkKeys(raw, ["type", "description", "invoke", "input", "inputSchema", "outputSchema", "outcomes", "timeoutSeconds", "transition", "session",
        "tools", "requiredTools"], path, diagnostics);
    let session: "continue" | null = null;
    if (raw.session !== undefined && raw.session !== "new") {
        if (raw.session === "continue") session = "continue";
        else diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.session`, "session must be continue (one agent session across the state's visits, the default) "
            + "or new (a new agent session for each visit, the only choice inside a For each or a parallel branch).");
    }
    // FU-17: `tools: none` or a list of tool names limits what the state's agent may use; absent, it has its session's tools.
    let tools: string[] | null = null;
    if (raw.tools !== undefined) {
        if (raw.tools === "none") tools = [];
        else if (isStringList(raw.tools) && raw.tools.length >= 1 && raw.tools.length <= WORKFLOW_AGENT_TOOLS_MAX
            && raw.tools.every(name => WORKFLOW_AGENT_TOOL_NAME.test(name)) && new Set(raw.tools).size === raw.tools.length) {
            tools = raw.tools.filter(name => name !== WORKFLOW_AGENT_COMPLETION_TOOL);
        } else {
            diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.tools`, `tools must be none (no tools but ${WORKFLOW_AGENT_COMPLETION_TOOL}) or a list `
                + `of 1 to ${WORKFLOW_AGENT_TOOLS_MAX} distinct tool names, as the agent sees them (such as web_fetch or read_facts).`);
        }
    }
    let requiredTools: string[] | undefined;
    if (raw.requiredTools !== undefined) {
        if (!isStringList(raw.requiredTools) || raw.requiredTools.length < 1 || raw.requiredTools.length > 16
            || raw.requiredTools.some(name => !WORKFLOW_AGENT_TOOL_NAME.test(name))
            || new Set(raw.requiredTools).size !== raw.requiredTools.length) {
            diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.requiredTools`, "requiredTools must list 1 to 16 distinct tool names, as the agent sees them.");
        } else {
            requiredTools = [...raw.requiredTools];
            if (tools !== null && requiredTools.some(name => !tools.includes(name) && !tools.includes(`custom:${name}`))) {
                diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.requiredTools`, "Every required tool must be inside this state's tools list.");
            }
        }
    }
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
    const timeoutSeconds = secondsField(raw.timeoutSeconds, `${path}.timeoutSeconds`, diagnostics, "timeoutSeconds",
        STATE_TIMEOUT_MAX_SECONDS, " For longer work, use session: continue with short visits and a sleep outcome routed to a wait; see workflow-patterns.");
    const next = compileRoutes(raw, path, "an agent state", nodeIds, diagnostics);
    if (next.timed_out === id) diagnostics.warning("WORKFLOW_AGENT_TIMEOUT_LOOP", `${path}.transition.next.timed_out`,
        "This timeout starts the same agent state again, possibly while its previous turn is stopping. Use a sleep outcome and a wait between short visits; see workflow-patterns.");
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
        ...(requiredTools ? { requiredTools } : {}),
        ...(session !== null ? { session } : {}),
        ...(tools !== null ? { tools } : {}),
    };
}

/** The binding templates a compiled state holds, by field (for checks over every binding). */
function nodeTemplates(node: WorkflowIRNode): Array<[string, JsonValue]> {
    const templates: Array<[string, JsonValue]> = [];
    const add = (field: string, value: JsonValue | undefined): void => { if (value !== undefined && value !== null) templates.push([field, value]); };
    if (node.type === "terminal") { if (node.hasOutput) add("output", node.output); return templates; }
    if (node.type === "parallel") {
        add("forEach", node.forEach);
        add("timeoutSeconds", node.timeoutSeconds);
        for (const branch of node.branches ?? []) if (branch.hasInput) add(`branches.${branch.name}.input`, branch.input);
        return templates;
    }
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
 * A parallel state: `forEach` (a
 * binding, or a literal array) gives its manifest when the state is entered;
 * `concurrency` (1 to WORKFLOW_PARALLEL_MAX_CONCURRENCY, default 1) bounds
 * the active branches; `join` is `all` (the default; `all_required` is the
 * same) or `{ first: k }` (k from 1 to WORKFLOW_PARALLEL_MAX_ITEMS,
 * and at most the items of a literal list); `failFast` (default false)
 * cancels the other branches once the join can no longer be had.
 * `timeoutSeconds` (as a wait's seconds) is the state's own time limit; it
 * needs a `timed_out` route, which is refused without it. `body` is a graph
 * of its own (`initial`, `states`): its routes stay in it, it holds no
 * parallel state, and its terminals end a branch (succeeded is accepted; any
 * other outcome does not count toward the join). Its outcomes are joined
 * and blocked; both need routes.
 *
 * Named branches (owner decision 2026-11-08): `branches` instead of
 * `forEach` and `body`: `{ <name>: { initial, states, input? } }`, each
 * branch its own graph (its routes stay in it), all of them started when the
 * state is entered (`concurrency` defaults to their number). The same joins,
 * failFast and time limit; the joined output is `{ <name>: output }`.
 */
function compileParallel(id: string, raw: Record<string, unknown>, nodeIds: ReadonlySet<string>, schemas: SchemaCollector, hasCatchAll: boolean,
    diagnostics: Diagnostics, compileBody: (bodyIds: ReadonlySet<string>, states: Array<[string, unknown]>, branch?: string) => void): WorkflowIRParallel | null {
    const path = `states.${id}`;
    checkKeys(raw, ["type", "description", "forEach", "branches", "concurrency", "join", "failFast", "timeoutSeconds", "inputSchema", "outputSchema", "body",
        "transition"], path, diagnostics);
    const named = raw.branches !== undefined;
    if (named && raw.forEach !== undefined) {
        diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.branches`, "a parallel state has forEach (one body for each item of a list) or branches "
            + "(named branches, each its own graph), not both.");
    }
    if (named && raw.body !== undefined) {
        diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.body`, "a parallel state with branches has no body: each branch has its own initial and states.");
    }
    const branchCount = named && isJsonObject(raw.branches) ? Object.keys(raw.branches).length : null;
    let forEach: JsonValue = null;
    if (named) { /* its branches are its manifest */ }
    else if (raw.forEach === undefined) diagnostics.error("WORKFLOW_FIELD_REQUIRED", `${path}.forEach`, "a parallel state needs forEach: one ${...} binding, or a list "
        + "(or branches: named branches, each its own graph).");
    else {
        forEach = bindingValue(raw.forEach, `${path}.forEach`, diagnostics);
        const binding = typeof raw.forEach === "string" ? (() => { try { return parseBindingExpression(raw.forEach as string, `${path}.forEach`); } catch { return null; } })() : null;
        if (!Array.isArray(raw.forEach) && binding === null) {
            diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.forEach`, "forEach must be one ${...} binding that gives a list, or a list.");
        } else if (Array.isArray(raw.forEach) && raw.forEach.length > WORKFLOW_PARALLEL_MAX_ITEMS) {
            diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.forEach`, `a parallel state runs at most ${WORKFLOW_PARALLEL_MAX_ITEMS} branches.`);
        }
    }
    // Named branches run at once unless the state says otherwise. Review NB-R3: never a silent clamp: more branches than run
    // at once need an explicit concurrency.
    let concurrency = branchCount !== null ? Math.max(1, Math.min(branchCount, WORKFLOW_PARALLEL_MAX_CONCURRENCY)) : 1;
    if (raw.concurrency === undefined && branchCount !== null && branchCount > WORKFLOW_PARALLEL_MAX_CONCURRENCY) {
        diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.concurrency`, `${branchCount} branches would not all start at once: set concurrency `
            + `(at most ${WORKFLOW_PARALLEL_MAX_CONCURRENCY}) or use fewer branches.`);
    }
    if (raw.concurrency !== undefined) {
        if (typeof raw.concurrency !== "number" || !Number.isInteger(raw.concurrency) || raw.concurrency < 1 || raw.concurrency > WORKFLOW_PARALLEL_MAX_CONCURRENCY) {
            diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.concurrency`, `concurrency must be an integer from 1 to ${WORKFLOW_PARALLEL_MAX_CONCURRENCY}.`);
        } else concurrency = raw.concurrency;
    }
    let join: WorkflowIRParallel["join"] = "all_required";
    if (raw.join !== undefined && raw.join !== "all" && raw.join !== "all_required") {
        const first = isJsonObject(raw.join) && Object.keys(raw.join).length === 1 ? raw.join.first : undefined;
        if (typeof first !== "number" || !Number.isInteger(first) || first < 1 || first > WORKFLOW_PARALLEL_MAX_ITEMS) {
            diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.join`, `join must be all (every branch must succeed) or { first: k }, `
                + `joined at the first k successes, with k an integer from 1 to ${WORKFLOW_PARALLEL_MAX_ITEMS}.`);
        } else {
            join = { first };
            // A literal list has a known number of items: k above it can never be reached.
            if (Array.isArray(raw.forEach) && first > raw.forEach.length) {
                diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.join.first`, `join.first is ${first}, but forEach lists ${raw.forEach.length} `
                    + `item${raw.forEach.length === 1 ? "" : "s"}: ${first} successes can never happen.`);
            }
            if (branchCount !== null && first > branchCount) {
                diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.join.first`, `join.first is ${first}, but the state has ${branchCount} `
                    + `branch${branchCount === 1 ? "" : "es"}: ${first} successes can never happen.`);
            }
        }
    }
    const timeoutSeconds = raw.timeoutSeconds === undefined ? undefined : secondsField(raw.timeoutSeconds, `${path}.timeoutSeconds`, diagnostics, "timeoutSeconds");
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
        // Its own time limit ends it with timed_out, which has its own route; without a time limit it never times out.
        if (raw.timeoutSeconds !== undefined && !Object.hasOwn(next, "timed_out")) {
            diagnostics.error("WORKFLOW_ROUTE_MISSING", `${path}.transition.next`, "a parallel state with timeoutSeconds needs a 'timed_out' route.");
        }
        if (raw.timeoutSeconds === undefined && Object.hasOwn(next, "timed_out")) {
            diagnostics.error("WORKFLOW_ROUTE_INVALID", `${path}.transition.next.timed_out`,
                "a parallel state times out only at its own timeoutSeconds; without one, its 'timed_out' route is never taken.");
        }
    }
    warnUnhandledFailure(path, next, hasCatchAll, diagnostics);
    let body: WorkflowIRParallel["body"] | null = null;
    let branches: WorkflowIRBranch[] | undefined;
    if (named) {
        branches = [];
        if (!isJsonObject(raw.branches) || Object.keys(raw.branches).length === 0) {
            diagnostics.error("WORKFLOW_FIELD_REQUIRED", `${path}.branches`, "branches must map each branch's name to { initial, states, input? }.");
        } else {
            if (Object.keys(raw.branches).length > WORKFLOW_PARALLEL_MAX_ITEMS) {
                diagnostics.error("WORKFLOW_FIELD_INVALID", `${path}.branches`, `a parallel state runs at most ${WORKFLOW_PARALLEL_MAX_ITEMS} branches.`);
            }
            for (const [name, spec] of Object.entries(raw.branches)) {
                const where = `${path}.branches.${name}`;
                if (!ID_PATTERN.test(name)) {
                    diagnostics.error("WORKFLOW_FIELD_INVALID", where, "branch names use a letter followed by up to 63 letters, digits, '_' or '-'.");
                    continue;
                }
                if (!isJsonObject(spec) || !isJsonObject(spec.states) || typeof spec.initial !== "string") {
                    diagnostics.error("WORKFLOW_FIELD_REQUIRED", where, `branch '${name}' needs { initial: <state>, states: { ... } } and may give input.`);
                    continue;
                }
                checkKeys(spec, ["initial", "states", "input"], where, diagnostics);
                const entries = Object.entries(spec.states);
                const ids = new Set(entries.map(([stateId]) => stateId));
                if (entries.length === 0) diagnostics.error("WORKFLOW_FIELD_INVALID", `${where}.states`, `branch '${name}' needs at least one state.`);
                if (!ids.has(spec.initial)) {
                    diagnostics.error("WORKFLOW_INITIAL_INVALID", `${where}.initial`, `initial must name a state of branch '${name}' (got '${spec.initial}').`);
                }
                const hasInput = Object.hasOwn(spec, "input");
                const input = hasInput ? bindingValue(spec.input, `${where}.input`, diagnostics) : null;
                compileBody(ids, entries, name);
                branches.push({ name, initial: spec.initial, states: [...ids], hasInput, input });
            }
        }
        if (branches.length > 0) body = { initial: branches[0].initial, states: branches.flatMap(branch => branch.states) };
    } else if (!isJsonObject(raw.body) || !isJsonObject(raw.body.states) || typeof raw.body.initial !== "string") {
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
    if (body === null || (!named && raw.forEach === undefined) || timeoutSeconds === null) return null;
    return {
        id, type: "parallel", description: optionalText(raw.description, `${path}.description`, diagnostics),
        forEach, ...(branches !== undefined ? { branches } : {}), concurrency, join, failFast, ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
        inputSchema, outputSchema, body, next,
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
    // A parallel state's body is a graph of its own: its states are reached from its initial and end at its terminals. Each
    // named branch is its own graph.
    const bodies = Object.values(ir.nodes).flatMap(node => node.type !== "parallel" ? []
        : node.branches !== undefined
            ? node.branches.map(branch => ({ id: node.id, initial: branch.initial, states: new Set(branch.states), branch: branch.name as string | null }))
            : [{ id: node.id, initial: node.body.initial, states: new Set(node.body.states), branch: null as string | null }]);
    const inBody = new Set(bodies.flatMap(body => [...body.states]));
    // Owner decision agent-node-continue-20261106: items of a For each run side by side, so they cannot share one agent session.
    for (const body of bodies) {
        for (const member of body.states) {
            const node = ir.nodes[member];
            if (node?.type === "agent" && node.session === "continue") {
                diagnostics.error("WORKFLOW_FIELD_INVALID", body.branch !== null ? `states.${body.id}.branches.${body.branch}.states.${member}.session`
                    : `states.${body.id}.body.states.${member}.session`, body.branch !== null
                    ? `state '${member}' cannot continue its agent session: it runs inside branch '${body.branch}' of parallel state '${body.id}'. Use session: new.`
                    : `state '${member}' cannot continue its agent session: it runs inside For each state '${body.id}', whose items run side by side and cannot share one agent session. Use session: new.`);
            }
        }
    }
    // FJ-S11 (formal fork-join model): a join of every branch waits as long as its slowest branch runs, and a branch that
    // never ends holds it until a cancel or stop. A named branch with a state that can wait long (an agent, up to its own
    // timeoutSeconds, or a receive with no wait) gets a warning when its parallel state has no time limit of its own.
    for (const node of Object.values(ir.nodes)) {
        if (node.type !== "parallel" || node.branches === undefined || node.timeoutSeconds !== undefined) continue;
        for (const branch of node.branches) {
            const slow = branch.states.map(member => ir.nodes[member]).find(state => state?.type === "agent"
                || (state?.type === "messaging" && state.mode === "receive" && state.waitSeconds === null));
            if (slow === undefined) continue;
            diagnostics.warning("WORKFLOW_BRANCH_UNBOUNDED", `states.${node.id}.branches.${branch.name}`,
                `branch '${branch.name}' has ${slow.type === "agent" ? "agent" : "receive"} state '${slow.id}'${slow.type === "agent" ? "" : " with no wait"}, `
                + `and parallel state '${node.id}' has no timeoutSeconds: its join waits as long as that branch runs`
                + `${slow.type === "agent" ? "" : ", and without a message, until the run is cancelled or stopped"}. `
                + `Give '${node.id}' a timeoutSeconds and a timed_out route to bound the wait.`);
        }
    }
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
        if (body.branch !== null) {
            check([body.initial], id => body.states.has(id), id => `states.${body.id}.branches.${body.branch}.states.${id}`,
                `the initial of branch '${body.branch}' of '${body.id}'`);
        } else check([body.initial], id => body.states.has(id), id => `states.${body.id}.body.states.${id}`, `the body initial of '${body.id}'`);
    }
}

/** Compile one document. Never throws for document content; returns diagnostics instead. */
export function compileWorkflow(yaml: string): WorkflowCompileResult {
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
    if (Buffer.byteLength(yaml, "utf8") > WORKFLOW_MAX_YAML_BYTES) {
        diagnostics.error("WORKFLOW_YAML_TOO_LARGE", "$", `Workflow YAML must be at most ${WORKFLOW_MAX_YAML_BYTES} bytes.`);
        return result(null, null, null);
    }
    let parsed: unknown;
    const document = parseDocument(yaml, { prettyErrors: false, strict: true, uniqueKeys: true });
    for (const error of document.errors) {
        const message = error.code === "DUPLICATE_KEY" ? duplicateKeyWords(document, yaml, error.pos?.[0]) ?? error.message : error.message;
        diagnostics.error("WORKFLOW_YAML_INVALID", "$", message, lineOf(yaml, error.pos?.[0]));
    }
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
    if (root.apiVersion !== WORKFLOW_API_VERSION) diagnostics.error("WORKFLOW_API_VERSION", "apiVersion", `apiVersion must be '${WORKFLOW_API_VERSION}'.`);
    if (root.kind !== WORKFLOW_KIND) diagnostics.error("WORKFLOW_KIND", "kind", `kind must be '${WORKFLOW_KIND}'.`);

    let name: string | null = null;
    let version: string | null = null;
    if (!isJsonObject(root.metadata)) diagnostics.error("WORKFLOW_FIELD_REQUIRED", "metadata", "metadata with name and version is required.");
    else {
        checkKeys(root.metadata, ["name", "version", "description"], "metadata", diagnostics);
        if (typeof root.metadata.name === "string" && root.metadata.name.trim() && root.metadata.name.length <= 128 && isStorableText(root.metadata.name)) {
            // Adversarial review R2-SF-3: a name is one line of plain text, so where it is quoted (a message to the parent agent,
            // a title) it cannot start a line of its own or turn text around.
            if (WORKFLOW_NAME_CONTROL.test(root.metadata.name)) {
                diagnostics.error("WORKFLOW_FIELD_INVALID", "metadata.name", "metadata.name must be one line of plain text, without line breaks or control characters.");
            } else name = root.metadata.name.trim();
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
    // declare a response: the schema a response to a request of it must satisfy.
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

    let maxNodeExecutions = WORKFLOW_DEFAULT_MAX_NODE_EXECUTIONS;
    // A run deadline: seconds from when the run begins, and what happens when it passes.
    let runDeadline: { timeoutSeconds: number; onExceeded: typeof WORKFLOW_RUN_ON_EXCEEDED[number] } | null = null;
    if (root.limits !== undefined) {
        if (!isJsonObject(root.limits)) diagnostics.error("WORKFLOW_FIELD_INVALID", "limits", "limits must be a mapping.");
        else {
            checkKeys(root.limits, ["maxNodeExecutions", "timeoutSeconds", "onExceeded"], "limits", diagnostics);
            const value = root.limits.maxNodeExecutions;
            if (value !== undefined) {
                if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > WORKFLOW_MAX_NODE_EXECUTIONS) {
                    diagnostics.error("WORKFLOW_FIELD_INVALID", "limits.maxNodeExecutions", `maxNodeExecutions must be an integer from 1 to ${WORKFLOW_MAX_NODE_EXECUTIONS}.`
                        + ` The default is ${WORKFLOW_DEFAULT_MAX_NODE_EXECUTIONS}; every state visit counts, including waits, branches and terminals.`
                        + " Reserve visits for the exit path and end loops before the limit; see workflow-polling.");
                } else maxNodeExecutions = value;
            }
            const timeout = root.limits.timeoutSeconds;
            const onExceeded = root.limits.onExceeded;
            if (timeout !== undefined || onExceeded !== undefined) {
                if (timeout === undefined) {
                    diagnostics.error("WORKFLOW_FIELD_REQUIRED", "limits.timeoutSeconds", "onExceeded needs limits.timeoutSeconds.");
                } else if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > WORKFLOW_RUN_TIMEOUT_MAX_SECONDS) {
                    diagnostics.error("WORKFLOW_FIELD_INVALID", "limits.timeoutSeconds", `timeoutSeconds must be an integer from 1 to ${WORKFLOW_RUN_TIMEOUT_MAX_SECONDS}.`
                        + " This optional run deadline is at most 30 days; pauses do not stop it. Expiry fails the run with timed_out.");
                } else if (onExceeded !== undefined && !(WORKFLOW_RUN_ON_EXCEEDED as readonly unknown[]).includes(onExceeded)) {
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
    /** A named branch's state id -> its branch's name (for the paths of its diagnostics). */
    const branchOfState = new Map<string, string>();
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
            const node = compileMessaging(id, rawNode, nodeIds, declaredContracts, catchAllApplies, into, respondingContracts);
            if (node) nodes[id] = node;
        } else if (type === "terminal") {
            const node = compileTerminal(id, rawNode, schemas, into);
            if (node) nodes[id] = node;
        } else if (type === "agent") {
            const node = compileAgent(id, rawNode, nodeIds, schemas, catchAllApplies, into);
            // Owner 2026-11-09T05:38Z: an agent state that does not set `session` continues its agent session across its
            // visits, where it may: outside a parallel state's body. In a body (For each items, named branches) it is `new`.
            if (node && body === null && rawNode.session === undefined) node.session = "continue";
            if (node) nodes[id] = node;
        } else if (type === "parallel" && body !== null) {
            into.error("WORKFLOW_FEATURE_UNSUPPORTED", `${path}.type`, "a parallel state's body cannot hold another parallel state.");
        } else if (type === "parallel") {
            const node = compileParallel(id, rawNode, nodeIds, schemas, hasCatchAll, into, (bodyIds, bodyStates, branchName) => {
                // A body's diagnostics name the body's path, not an outer state's.
                const scoped = new Diagnostics();
                for (const [bodyId, rawBodyNode] of bodyStates) {
                    if (bodyOf.has(bodyId)) {
                        scoped.error("WORKFLOW_STATE_ID", `states.${bodyId}`, `state id '${bodyId}' is used twice; state ids are unique across the workflow.`);
                        continue;
                    }
                    bodyOf.set(bodyId, id);
                    if (branchName !== undefined) branchOfState.set(bodyId, branchName);
                    compileState(bodyId, rawBodyNode, bodyIds, id, scoped);
                }
                for (const item of scoped.items) {
                    const rewritten = item.path.replace(/^states\.([^.]+)/, (_match, bodyId: string) => branchName !== undefined
                        ? `states.${id}.branches.${branchName}.states.${bodyId}` : `states.${id}.body.states.${bodyId}`);
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
            // I2: the types this compile takes, and the one most likely meant.
            const types: string[] = [...SUPPORTED_NODE_TYPES];
            const meant = typeof type === "string" ? workflowNearestStateType(type, types) : null;
            into.error("WORKFLOW_NODE_TYPE_UNKNOWN", `${path}.type`, `'${String(type)}' is not a workflow state type. The types are ${types.join(", ")}.`
                + (meant ? ` Did you mean ${meant}?` : ""));
        }
    };
    if (!isJsonObject(root.states)) {
        diagnostics.error("WORKFLOW_FIELD_REQUIRED", "states", "states must map state ids to states.");
    } else {
        const entries = Object.entries(root.states);
        if (entries.length === 0 || entries.length > WORKFLOW_MAX_NODES) {
            diagnostics.error("WORKFLOW_FIELD_INVALID", "states", `states must contain between 1 and ${WORKFLOW_MAX_NODES} states.`);
        }
        const nodeIds = new Set(entries.map(([id]) => id));
        for (const [id, rawNode] of entries) compileState(id, rawNode, nodeIds, null, diagnostics);
        // State ids are unique across the workflow, body states included (a node execution names its state by id).
        const seen = new Set(nodeIds);
        for (const [bodyId, parallel] of bodyOf) {
            if (nodeIds.has(bodyId)) {
                const branchName = branchOfState.get(bodyId);
                diagnostics.error("WORKFLOW_STATE_ID", branchName !== undefined ? `states.${parallel}.branches.${branchName}.states.${bodyId}`
                    : `states.${parallel}.body.states.${bodyId}`, `state id '${bodyId}' is used twice; state ids are unique across the workflow.`);
            }
            seen.add(bodyId);
        }
        if (seen.size > WORKFLOW_MAX_NODES) {
            diagnostics.error("WORKFLOW_FIELD_INVALID", "states", `a workflow holds at most ${WORKFLOW_MAX_NODES} states, body states included.`);
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
        // `branch.name` names a named branch; a For each's items have none.
        const named = new Set(Object.values(nodes).flatMap(node => node.type === "parallel" && node.branches !== undefined ? [node.id] : []));
        for (const node of Object.values(nodes)) {
            const parallel = bodyOf.get(node.id);
            if (parallel === undefined || named.has(parallel)) continue;
            for (const [field, template] of nodeTemplates(node)) {
                if (/\$\{\s*branch\s*\.\s*name\b/.test(JSON.stringify(template))) {
                    diagnostics.error("WORKFLOW_BINDING_INVALID", `states.${parallel}.body.states.${node.id}.${field}`,
                        "branch.name is bound only in a parallel state with branches; in a For each, use branch.index or branch.item.");
                }
            }
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
    warnInputMismatches(nodes, schemas.defs, diagnostics);
    if (runDeadline !== null) {
        for (const node of Object.values(nodes)) {
            if (node.type === "wait" && typeof node.seconds === "number" && node.seconds > runDeadline.timeoutSeconds) {
                diagnostics.warning("WORKFLOW_WAIT_EXCEEDS_RUN_TIMEOUT", `states.${node.id}.seconds`,
                    "This wait is longer than limits.timeoutSeconds. The run deadline ends pending work even while paused; shorten the wait or change the run's intended time budget.");
            }
        }
    }
    const received = new Set(Object.values(nodes).flatMap(node => node.type === "messaging" && node.mode === "receive" ? [node.contract] : []));
    const sent = new Set(Object.values(nodes).flatMap(node => node.type === "messaging" && node.mode === "send" ? [node.contract] : []));
    const requested = new Set(Object.values(nodes).flatMap(node => node.type === "messaging" && node.mode === "request" ? [node.contract] : []));
    for (const contractName of Object.keys(contracts)) {
        if (!received.has(contractName) && !sent.has(contractName) && !requested.has(contractName)) {
            diagnostics.warning("WORKFLOW_CONTRACT_UNUSED", `contracts.${contractName}`,
                `no state receives, sends or requests contract '${contractName}'; this workflow refuses input of it.`);
        }
    }
    const ir: WorkflowIR = {
        irVersion: WORKFLOW_IR_VERSION,
        apiVersion: WORKFLOW_API_VERSION,
        name, version,
        description: optionalText(root.description, "description", diagnostics),
        initial,
        initialInput,
        inputsSchema,
        outputSchema: rootOutputSchema,
        catchAll,
        limits: { maxNodeExecutions, ...(runDeadline !== null ? runDeadline : {}) },
        schemaDefs: schemas.defs,
        contracts,
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
 * The schema a member of an object must match (E2-R3): its property's schema, else additionalProperties; undefined
 * when nothing applies. Workflow schemas have no patternProperties (owner decision Q1 (d)).
 */
function memberSchema(target: { [key: string]: JsonValue }, key: string): JsonValue | undefined {
    const properties = isJsonObject(target.properties) ? target.properties : {};
    if (Object.hasOwn(properties, key)) return properties[key];
    return target.additionalProperties !== undefined && target.additionalProperties !== true ? target.additionalProperties : undefined;
}

/** A fixed part of a partly bound input: where it is, the value as written, and the schema it must match. */
interface FixedPart { pointer: string; value: JsonValue; schema: JsonValue }

/**
 * The fixed parts of a partly bound input and what a bound part's written-out object must have (adversarial review SF-8
 * and its verification): a part with no binding is collected whole, to be validated with the run's own validator; in a
 * part that holds a binding, an object written out must have its schema's required properties (returned as problems),
 * and its members and array items are visited with their own schemas (memberSchema: a named property's schema, else
 * additionalProperties; prefixItems or items). Composed schemas (allOf, anyOf, oneOf) are visited no further: the run
 * checks them.
 */
function fixedParts(value: JsonValue, schema: JsonValue | undefined, defs: Record<string, JsonValue>, pointer: string,
    parts: FixedPart[], problems: string[], depth = 0): void {
    if (depth > 32 || schema === undefined) return;
    if (!holdsBinding(value)) {
        parts.push({ pointer, value, schema });
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
    for (const key of required) if (!Object.hasOwn(value, key)) problems.push(`${schemaPlaceWords([...schemaPointerParts(pointer), key])} is required`);
    for (const [key, item] of Object.entries(value)) {
        fixedParts(item, memberSchema(target, key), defs, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`, parts, problems, depth + 1);
    }
}

/**
 * The first problems of a partly bound input's fixed parts, as "<pointer> <problem>" (SF-8 verification): each fixed
 * part is validated whole against its schema with the run's validator (nested required properties, minimum, lengths,
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
            // Plain words that name the place in the whole input (schema-words.ts).
            for (const problem of validator.validate(`_fixed.${index}`, part.value, part.pointer)) problems.push(problem.message);
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
        validator ??= new WorkflowSchemaSet(defs);
        const problems = validator.validate(schemaName, node.input);
        if (problems.length) {
            diagnostics.error("WORKFLOW_STATE_INPUT_INVALID", path, `this input has no binding, so it is sent as written, and it does not match ${target.what}: `
                + `${problems.slice(0, 3).map(problem => problem.message).join("; ")}.`);
        }
    }
}

/** The keywords a simple object schema may have: none of them changes which properties it allows or requires but these. */
const SIMPLE_OBJECT_KEYWORDS: ReadonlySet<string> = new Set(["type", "properties", "required", "additionalProperties", "title", "description", "$comment"]);

/**
 * A simple object schema's properties, required properties and whether it is closed (additionalProperties: false); null
 * for any other schema (a $ref, anyOf, patternProperties, a schema for additional properties, no properties, and so on).
 */
function simpleObjectShape(schema: JsonValue | undefined): { properties: ReadonlySet<string>; required: readonly string[]; closed: boolean } | null {
    if (!isJsonObject(schema) || schema.type !== "object" || !isJsonObject(schema.properties)) return null;
    if (Object.keys(schema).some(key => !SIMPLE_OBJECT_KEYWORDS.has(key))) return null;
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") return null;
    const required: JsonValue = schema.required ?? [];
    if (!isStringList(required)) return null;
    return { properties: new Set(Object.keys(schema.properties)), required, closed: schema.additionalProperties === false };
}

/**
 * A warning, never an error, for a script or agent state with no `input:` whose inputSchema refuses what a route brings it
 * (2026-11-08: a session's check_ci took a closed { checks } and gave { checks, ciState }; its wait passed that back, and the
 * second visit failed invalid_input). The value a route brings is a script's or agent's output (its outputSchema), or what a
 * wait, or a receive's elapsed route, without an `input:` of its own passes on. Both schemas must be simple objects; it warns
 * when the consumer is closed and the producer declares a property the consumer does not, or when the producer is closed
 * and lacks a property the consumer requires. Anything else stays silent.
 */
function warnInputMismatches(nodes: Record<string, WorkflowIRNode>, defs: Record<string, JsonValue>, diagnostics: Diagnostics): void {
    const pathOf = new Map<string, string>();
    for (const node of Object.values(nodes)) {
        if (node.type !== "parallel") continue;
        if (node.branches !== undefined) {
            for (const branch of node.branches) for (const id of branch.states) pathOf.set(id, `states.${node.id}.branches.${branch.name}.states.${id}`);
        } else for (const id of node.body.states) pathOf.set(id, `states.${node.id}.body.states.${id}`);
    }
    const arriving = new Map<string, Array<{ from: string; label: string }>>();
    for (const node of Object.values(nodes)) {
        if (node.type === "terminal") continue;
        for (const [label, target] of Object.entries(node.next)) {
            if (isRuntimeRoute(label)) continue;
            arriving.set(target, [...(arriving.get(target) ?? []), { from: node.id, label }]);
        }
    }
    const producers = (from: string, label: string, seen: Set<string>): string[] => {
        const node = nodes[from];
        if (node?.type === "script" || node?.type === "agent") return node.outputSchema !== null ? [node.id] : [];
        const passes = (node?.type === "wait" || (node?.type === "messaging" && node.mode === "receive")) && label === WAIT_ELAPSED && !node.hasInput;
        if (!passes || seen.has(from)) return [];
        seen.add(from);
        return (arriving.get(from) ?? []).flatMap(edge => producers(edge.from, edge.label, seen));
    };
    for (const consumer of Object.values(nodes)) {
        if ((consumer.type !== "script" && consumer.type !== "agent") || consumer.hasInput || consumer.inputSchema === null) continue;
        const wants = simpleObjectShape(defs[consumer.inputSchema]);
        if (wants === null) continue;
        const said = new Set<string>();
        const warn = (message: string): void => {
            if (said.has(message)) return;
            said.add(message);
            diagnostics.warning("WORKFLOW_INPUT_MISMATCH", `${pathOf.get(consumer.id) ?? `states.${consumer.id}`}.inputSchema`, message);
        };
        for (const edge of arriving.get(consumer.id) ?? []) {
            for (const producerId of new Set(producers(edge.from, edge.label, new Set()))) {
                const producer = nodes[producerId];
                if (producer?.type !== "script" && producer?.type !== "agent") continue;
                const gives = producer.outputSchema !== null ? simpleObjectShape(defs[producer.outputSchema]) : null;
                if (gives === null) continue;
                const from = edge.from === producerId ? edge.from : `${edge.from} (which passes on ${producerId}'s output)`;
                if (wants.closed) {
                    for (const property of gives.properties) {
                        if (wants.properties.has(property)) continue;
                        warn(`${consumer.id} ${gives.required.includes(property) ? "gets" : "can get"} "${property}" from ${from}, `
                            + "but its inputSchema does not allow it: map the input with input: or allow the property.");
                    }
                }
                if (gives.closed) {
                    for (const property of wants.required) {
                        if (gives.properties.has(property)) continue;
                        warn(`${consumer.id} needs "${property}" from ${from}, but ${producerId}'s outputSchema does not have it: `
                            + "map the input with input: or add the property.");
                    }
                }
            }
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
/** A stored clock wait's `at`, checked as the compiler wrote it; null when it is not one. */
function storedClockWait(value: unknown): WorkflowIRClockWait | null {
    if (!isJsonObject(value)) return null;
    const int = (x: unknown, min: number, max: number) => typeof x === "number" && Number.isInteger(x) && x >= min && x <= max;
    if (!int(value.minute, 0, 59) || typeof value.tz !== "string" || !isValidTimezone(value.tz)) return null;
    if (value.hour !== undefined && !int(value.hour, 0, 23)) return null;
    if (value.dayOfWeek !== undefined && !int(value.dayOfWeek, 0, 6)) return null;
    if (value.dayOfMonth !== undefined && !int(value.dayOfMonth, 1, 31)) return null;
    if ((value.dayOfWeek !== undefined || value.dayOfMonth !== undefined) && value.hour === undefined) return null;
    if (value.dayOfWeek !== undefined && value.dayOfMonth !== undefined) return null;
    if (Object.keys(value).some(key => !["minute", "hour", "dayOfWeek", "dayOfMonth", "tz"].includes(key))) return null;
    return {
        minute: value.minute as number, ...(value.hour !== undefined ? { hour: value.hour as number } : {}),
        ...(value.dayOfWeek !== undefined ? { dayOfWeek: value.dayOfWeek as number } : {}),
        ...(value.dayOfMonth !== undefined ? { dayOfMonth: value.dayOfMonth as number } : {}), tz: value.tz,
    };
}

export function parseWorkflowIr(value: JsonValue): WorkflowIR {
    need(isJsonObject(value), "stored IR is not an object");
    need(value.irVersion === WORKFLOW_IR_VERSION, `stored IR version ${String(value.irVersion)} is not supported by this worker`);
    const rootOutputSchema = value.outputSchema;
    const catchAll = value.catchAll;
    need(value.apiVersion === WORKFLOW_API_VERSION, "stored IR has a different apiVersion");
    need(typeof value.name === "string" && typeof value.version === "string" && typeof value.initial === "string"
        && nullableString(value.description) && nullableString(value.inputsSchema) && nullableString(rootOutputSchema)
        && nullableString(catchAll), "stored IR header is invalid");
    need(isJsonObject(value.limits) && typeof value.limits.maxNodeExecutions === "number", "stored IR limits are invalid");
    // A run deadline is stored with both its fields, or neither.
    const deadlineSeconds = value.limits.timeoutSeconds;
    const onExceeded = value.limits.onExceeded;
    need((deadlineSeconds === undefined && onExceeded === undefined) || (typeof deadlineSeconds === "number" && Number.isSafeInteger(deadlineSeconds) && deadlineSeconds >= 1
        && deadlineSeconds <= WORKFLOW_RUN_TIMEOUT_MAX_SECONDS && onExceeded === "expired"), "stored IR run deadline is invalid");
    need(isJsonObject(value.schemaDefs) && isJsonObject(value.nodes), "stored IR schemas or nodes are invalid");
    need(Object.hasOwn(value, "initialInput"), "stored IR has no initialInput");
    const schemaDefs = value.schemaDefs;
    need(isJsonObject(value.contracts), "stored IR contracts are invalid");
    const contracts: Record<string, WorkflowIRContract> = {};
    for (const [contractName, contract] of Object.entries(value.contracts)) {
        need(CONTRACT_NAME_PATTERN.test(contractName) && isJsonObject(contract) && typeof contract.schema === "string"
            && Object.hasOwn(schemaDefs, contract.schema), `stored IR contract ${contractName} is invalid`);
        if (Object.hasOwn(contract, "response")) {
            const response = contract.response;
            need(isJsonObject(response) && Object.keys(response).length === 1
                && typeof response.schema === "string" && Object.hasOwn(schemaDefs, response.schema),
                `stored IR contract ${contractName} has an invalid response`);
            contracts[contractName] = { schema: contract.schema, response: { schema: response.schema } };
        } else contracts[contractName] = { schema: contract.schema };
    }
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
            // A clock wait has its `at` and no seconds.
            const at = seconds === null ? storedClockWait(node.at) : null;
            need((typeof seconds === "number" || typeof seconds === "string" || at !== null)
                && (at !== null || node.at === undefined)
                && typeof node.hasInput === "boolean" && Object.hasOwn(node, "input") && stringMap(node.next),
                `stored IR wait ${id} is invalid`);
            nodes[id] = { id, type: "wait", description: node.description, seconds: at !== null ? null : seconds as number | string, ...(at ? { at } : {}),
                hasInput: node.hasInput, input: node.input, next: node.next };
        } else if (node.type === "messaging" && node.mode === "send") {
            const recipient = node.recipient;
            need(typeof node.contract === "string" && Object.hasOwn(contracts, node.contract) && Object.hasOwn(node, "correlate")
                && isJsonObject(recipient) && Object.keys(recipient).length === 1 && (recipient.parent === true || typeof recipient.sessionId === "string")
                && typeof node.hasInput === "boolean" && Object.hasOwn(node, "input") && stringMap(node.next),
                `stored IR messaging state ${id} is invalid`);
            nodes[id] = {
                id, type: "messaging", description: node.description, mode: "send", contract: node.contract,
                recipient: typeof recipient.sessionId === "string" ? { sessionId: recipient.sessionId } : { parent: true },
                correlate: node.correlate,
                hasInput: node.hasInput, input: node.input, next: node.next,
            };
        } else if (node.type === "messaging" && node.mode === "request") {
            const recipient = node.recipient;
            const timeoutSeconds = node.timeoutSeconds;
            need(typeof node.contract === "string"
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
            need(node.mode === "receive" && typeof node.contract === "string" && Object.hasOwn(contracts, node.contract)
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
            need(validInvoke && typeof node.hasInput === "boolean" && Object.hasOwn(node, "input")
                && nullableString(node.inputSchema) && nullableString(node.outputSchema) && stringArray(node.outcomes) && node.outcomes.length > 0
                && (typeof timeoutSeconds === "number" || typeof timeoutSeconds === "string") && stringMap(node.next)
                && (node.session === undefined || node.session === "continue")
                && (node.tools === undefined || (stringArray(node.tools) && node.tools.length <= WORKFLOW_AGENT_TOOLS_MAX
                    && node.tools.every(name => WORKFLOW_AGENT_TOOL_NAME.test(name))))
                && (node.requiredTools === undefined || (stringArray(node.requiredTools)
                    && node.requiredTools.length >= 1 && node.requiredTools.length <= 16
                    && new Set(node.requiredTools).size === node.requiredTools.length
                    && node.requiredTools.every(name => WORKFLOW_AGENT_TOOL_NAME.test(name)
                        && (node.tools === undefined || (Array.isArray(node.tools)
                            && (node.tools.includes(name) || node.tools.includes(`custom:${name}`))))))),
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
                ...(node.session === "continue" ? { session: "continue" as const } : {}),
                ...(Array.isArray(node.tools) ? { tools: [...node.tools as string[]] } : {}),
                ...(Array.isArray(node.requiredTools) ? { requiredTools: [...node.requiredTools as string[]] } : {}),
            };
        } else if (node.type === "parallel") {
            const body = node.body;
            // A join of the first k successes, and the state's own time limit (absent without one).
            const first = isJsonObject(node.join) && Object.keys(node.join).length === 1 ? node.join.first : undefined;
            const joinValid = node.join === "all_required" || (typeof first === "number" && Number.isSafeInteger(first)
                && first >= 1 && first <= WORKFLOW_PARALLEL_MAX_ITEMS);
            const timeout = node.timeoutSeconds;
            const timeoutValid = timeout === undefined || ((typeof timeout === "string"
                || (typeof timeout === "number" && Number.isSafeInteger(timeout) && timeout >= 1 && timeout <= STATE_TIMEOUT_MAX_SECONDS)));
            need(Object.hasOwn(node, "forEach") && typeof node.concurrency === "number"
                && Number.isInteger(node.concurrency) && node.concurrency >= 1 && node.concurrency <= WORKFLOW_PARALLEL_MAX_CONCURRENCY && joinValid
                && timeoutValid && typeof node.failFast === "boolean"
                && nullableString(node.inputSchema) && nullableString(node.outputSchema)
                && isJsonObject(body) && typeof body.initial === "string" && stringArray(body.states) && body.states.includes(body.initial)
                && stringMap(node.next), `stored IR parallel state ${id} is invalid`);
            // Named branches, whose states are exactly the body's, in order, each from its own initial.
            let branches: WorkflowIRBranch[] | undefined;
            if (node.branches !== undefined) {
                const list = node.branches;
                need(Array.isArray(list) && list.length >= 1 && list.length <= WORKFLOW_PARALLEL_MAX_ITEMS
                    && list.every(item => isJsonObject(item) && typeof item.name === "string" && ID_PATTERN.test(item.name) && typeof item.initial === "string"
                        && stringArray(item.states) && item.states.includes(item.initial) && typeof item.hasInput === "boolean" && Object.hasOwn(item, "input"))
                    && new Set(list.map(item => (item as { name: string }).name)).size === list.length
                    && JSON.stringify(list.flatMap(item => (item as { states: string[] }).states)) === JSON.stringify(body.states)
                    && body.initial === (list[0] as { initial: string }).initial && node.forEach === null,
                `stored IR parallel state ${id} has invalid branches`);
                branches = list.map(item => {
                    const branch = item as { name: string; initial: string; states: string[]; hasInput: boolean; input: JsonValue };
                    return { name: branch.name, initial: branch.initial, states: [...branch.states], hasInput: branch.hasInput, input: branch.input };
                });
            }
            nodes[id] = {
                id, type: "parallel", description: node.description, forEach: node.forEach, ...(branches !== undefined ? { branches } : {}),
                concurrency: node.concurrency,
                join: typeof first === "number" ? { first } : "all_required",
                failFast: node.failFast, ...(timeout !== undefined ? { timeoutSeconds: timeout as number | string } : {}),
                inputSchema: node.inputSchema, outputSchema: node.outputSchema,
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
        irVersion: WORKFLOW_IR_VERSION, apiVersion: WORKFLOW_API_VERSION, name: value.name, version: value.version,
        description: value.description, initial: value.initial, initialInput: value.initialInput,
        inputsSchema: value.inputsSchema, outputSchema: rootOutputSchema, catchAll,
        limits: { maxNodeExecutions: value.limits.maxNodeExecutions,
            ...(typeof deadlineSeconds === "number" ? { timeoutSeconds: deadlineSeconds, onExceeded: "expired" as const } : {}) },
        schemaDefs, contracts, nodes,
    };
}
