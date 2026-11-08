import {
    MESSAGE_SENT, REQUEST_DECLINED, REQUEST_RESPONDED, RUNTIME_ERROR_CODES,
    type WorkflowIR, type WorkflowIRNode,
} from "./compiler.js";
import { assertJsonValue, boundedCanonicalJson, canonicalJson, isJsonObject, jsonbSafeText, sha256Hex, WorkflowJsonError, type JsonValue } from "./json.js";
import { schemaSetFor, WorkflowSchemaSet, type SchemaProblem } from "./schema.js";
import {
    WORKFLOW_V2_DECLINE_SCHEMA, WORKFLOW_V2_TEST_OPERATIONS, WorkflowStoreError,
    type NodeResultInput, type SessionProjection, type WorkflowNodeExecutionRow, type WorkflowRunRow, type WorkflowTestInterception,
    type WorkflowTestOperation, type WorkflowTestResponseKind,
} from "./store.js";
import { promptSafeJson, workflowUpdateHeader, workflowUpdateMessage, workflowUpdateSentenceId, workflowUpdateShortId } from "./parent-messages.js";
import { redactErrorThenClip } from "./redact.js";

/**
 * Workflow test runs (design 05 tool-mocked testing; R19, R20, R28;
 * controller 1.9.0 runs them).
 *
 * A test run executes its scripts normally: their direct effects (network,
 * files, processes, the clock, randomness) are real. What the framework
 * brokers is intercepted instead: a script's tool calls, an agent state's
 * agent (agent mode mocked) or its real agent's framework tool calls (agent
 * mode real), a send's delivery and a request's exchange each become an
 * interception record that the parent answers by its id (or a fixture
 * answers), and every deadline runs on the run's virtual clock,
 * which only an explicit advance moves. Nothing intercepted falls back to a
 * live call. A test run is never evidence that a definition is safe to run
 * live.
 */
export const WORKFLOW_V2_TEST_NOTICE = "TEST — workflow tools are mocked, but scripts run normally: their files, network, processes and "
    + "clock are real. A passing test does not show that the workflow is safe to run live.";

/**
 * The agent modes of a test run: mocked (the parent supplies the agent's typed result) or real (a real agent child whose
 * framework tool calls are intercepted; test-agent-tools.ts).
 */
export const WORKFLOW_V2_TEST_AGENT_MODES = ["mocked", "real"] as const;
/** What a real-agent test run adds to WORKFLOW_V2_TEST_NOTICE (design 05: real-agent mode spends model tokens; model variability stays). */
export const WORKFLOW_V2_TEST_REAL_AGENT_NOTICE = "Agent steps run real agent sessions: they spend model tokens and their results vary as a "
    + "model's do. Their workflow tool calls are mocked; their model's own built-in tools (shell, files) run normally; MCP tools are refused.";
/** The most fixtures one test run carries. */
export const WORKFLOW_V2_TEST_MAX_FIXTURES = 200;
/** The most bytes of a test run's fixtures, as canonical JSON. */
export const WORKFLOW_V2_TEST_FIXTURES_MAX_BYTES = 256 * 1024;
/** How often a script waiting for a test response looks for it (milliseconds). */
export const WORKFLOW_V2_TEST_POLL_MS = 200;

/** A parent's (or a fixture's) answer to an intercepted effect. */
export interface WorkflowTestResponse {
    kind: WorkflowTestResponseKind;
    /** success: the effect's value; error: { code?, message, details? }; cancel: null. */
    value: JsonValue;
}

/**
 * What a fixture answers: an intercepted effect (WORKFLOW_V2_TEST_OPERATIONS), or, in an agent's test of a revision only
 * (chat-test.ts), `receive`: a message the test delivers to a receive state before its clock moves on (G1).
 */
export type WorkflowTestFixtureOperation = WorkflowTestOperation | "receive";

/** A fixture: an answer given in advance for the effect with this operation, tool or state, and arguments. */
export interface WorkflowTestFixture {
    operation: WorkflowTestFixtureOperation;
    /** The tool of a tool call; null for the other operations. */
    tool: string | null;
    /** The state of an agent, send or request effect; null for a tool call. */
    state: string | null;
    /**
     * The hash of the arguments' canonical JSON (a tool call's arguments; an agent's input; a send's or request's message);
     * null for a fixture that gave no arguments (stage 2.2): it answers any call of its tool or state, after every exact one.
     */
    argumentsSha256: string | null;
    /**
     * G2: the visit it answers (the n-th time the run reaches the state in its scope: the root, or one branch or item; for a
     * tool call, its script state's visit); absent (or null) for any visit. A fixture for the visit wins over one for any
     * visit. Absent, not null, when it names none, so fixtures without one keep their stored form (and request digest).
     */
    visit?: number | null;
    response: WorkflowTestResponse;
}

const invalid = (message: string, details?: JsonValue): WorkflowStoreError => new WorkflowStoreError("TEST_RESPONSE_INVALID", message, details);

/** Parse a response (`{ kind, value }`) as a tool or an API gives it; refuses anything else with TEST_RESPONSE_INVALID. */
export function parseTestResponse(value: unknown, path = "response"): WorkflowTestResponse {
    if (!isJsonObject(value)) throw invalid(`${path} must be { kind: success | error | cancel, value }.`);
    for (const key of Object.keys(value)) if (key !== "kind" && key !== "value") throw invalid(`${path}.${key} is not a field of a response.`);
    const kind = value.kind;
    if (kind !== "success" && kind !== "error" && kind !== "cancel") throw invalid(`${path}.kind must be success, error or cancel.`);
    const raw = value.value === undefined ? null : value.value;
    try { assertJsonValue(raw, `${path}.value`); }
    catch (error) {
        if (error instanceof WorkflowJsonError) throw invalid(error.message);
        throw error;
    }
    if (kind === "cancel" && raw !== null) throw invalid(`${path}.value must be absent for a cancel.`);
    if (kind === "error") {
        if (!isJsonObject(raw) || typeof raw.message !== "string" || !raw.message.trim() || raw.message.length > 4_000
            || (raw.code !== undefined && (typeof raw.code !== "string" || !raw.code.trim() || raw.code.length > 100))
            || Object.keys(raw).some(key => key !== "code" && key !== "message" && key !== "details")) {
            throw invalid(`${path}.value of an error must be { code?, message, details? } with a message of 1 to 4,000 characters.`);
        }
    }
    let text: string;
    try { text = boundedCanonicalJson(raw, `${path}.value`); }
    catch (error) {
        if (error instanceof WorkflowJsonError) throw invalid(error.message);
        throw error;
    }
    return { kind, value: JSON.parse(text) as JsonValue };
}

/**
 * Parse a test run's fixtures: a list of `{ operation?, tool?, state?, arguments?, visit?, response }`. A tool call's fixture
 * (operation tool.call, the default) names its tool; an agent's, send's or request's names its state. Each is matched by
 * its operation, tool or state and the hash of its arguments' canonical JSON. Stage 2.2 (an agent's test): a fixture
 * without `arguments` answers any call of its tool or state, but only when no fixture gives that call's exact arguments.
 * G2: `visit` (1 to 10000) answers only that visit of its state. G1: `receive` (options.receive: an agent's test only,
 * chat-test.ts) is a receive state's message, given as the response's value; it takes no arguments.
 */
export function parseTestFixtures(value: unknown, options: { receive?: boolean } = {}): WorkflowTestFixture[] {
    if (value === undefined || value === null) return [];
    const refuse = (message: string) => new WorkflowStoreError("WORKFLOW_COMMAND_INVALID", message);
    if (!Array.isArray(value)) throw refuse("fixtures must be a list.");
    if (value.length > WORKFLOW_V2_TEST_MAX_FIXTURES) throw refuse(`fixtures may hold at most ${WORKFLOW_V2_TEST_MAX_FIXTURES} entries.`);
    const operations: readonly string[] = options.receive === true ? [...WORKFLOW_V2_TEST_OPERATIONS, "receive"] : WORKFLOW_V2_TEST_OPERATIONS;
    const fixtures = value.map((item, index): WorkflowTestFixture => {
        const at = `fixtures[${index}]`;
        if (!isJsonObject(item)) throw refuse(`${at} must be { operation?, tool?, state?, arguments?, visit?, response }.`);
        for (const key of Object.keys(item)) {
            if (!["operation", "tool", "state", "arguments", "visit", "response"].includes(key)) throw refuse(`${at}.${key} is not a field of a fixture.`);
        }
        const operation = item.operation === undefined ? "tool.call" : item.operation;
        if (typeof operation !== "string" || !operations.includes(operation)) {
            throw refuse(`${at}.operation must be one of ${operations.join(", ")}.`);
        }
        const visit = item.visit === undefined || item.visit === null ? null : item.visit;
        if (visit !== null && (typeof visit !== "number" || !Number.isSafeInteger(visit) || visit < 1 || visit > 10_000)) {
            throw refuse(`${at}.visit must be the visit it answers, 1 to 10000 (the n-th time the run reaches the state).`);
        }
        if (operation === "receive" && Object.hasOwn(item, "arguments")) {
            throw refuse(`${at}: a receive fixture gives the message as its response's value, not arguments.`);
        }
        const isTool = operation === "tool.call";
        const name = isTool ? item.tool : item.state;
        if (typeof name !== "string" || !name.trim() || name.length > 256) throw refuse(`${at} needs ${isTool ? "tool" : "state"}: the ${isTool ? "tool" : "state"} it answers.`);
        if ((isTool && item.state !== undefined) || (!isTool && item.tool !== undefined)) {
            throw refuse(`${at}: a tool call's fixture names a tool, and an ${operation} fixture names a state.`);
        }
        let argumentsText: string | null = null;
        if (Object.hasOwn(item, "arguments")) {
            try { argumentsText = boundedCanonicalJson(item.arguments, `${at}.arguments`); }
            catch (error) {
                if (error instanceof WorkflowJsonError) throw refuse(error.message);
                throw error;
            }
        }
        let response: WorkflowTestResponse;
        try { response = parseTestResponse(item.response, `${at}.response`); }
        catch (error) {
            if (error instanceof WorkflowStoreError) throw refuse(error.message);
            throw error;
        }
        if (operation === "receive" && response.kind !== "success") {
            throw refuse(`${at}: a receive fixture's response is { kind: success, value: <the message> }.`);
        }
        return {
            operation: operation as WorkflowTestFixtureOperation, tool: isTool ? name : null, state: isTool ? null : name,
            argumentsSha256: argumentsText === null ? null : sha256Hex(argumentsText), ...(visit !== null ? { visit: visit as number } : {}), response,
        };
    });
    if (Buffer.byteLength(canonicalJson(fixtures), "utf8") > WORKFLOW_V2_TEST_FIXTURES_MAX_BYTES) {
        throw refuse(`fixtures may be at most ${WORKFLOW_V2_TEST_FIXTURES_MAX_BYTES} bytes.`);
    }
    return fixtures;
}

/** Read a test run's stored fixtures back (they were parsed when the run was admitted). */
export function storedTestFixtures(value: JsonValue): WorkflowTestFixture[] {
    if (!Array.isArray(value)) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "Stored test fixtures are not a list.");
    return value.map(item => {
        const visit = isJsonObject(item) && item.visit !== undefined ? item.visit : null;
        if (!isJsonObject(item) || typeof item.operation !== "string" || ![...WORKFLOW_V2_TEST_OPERATIONS, "receive"].includes(item.operation)
            || (item.tool !== null && typeof item.tool !== "string") || (item.state !== null && typeof item.state !== "string")
            || (item.argumentsSha256 !== null && typeof item.argumentsSha256 !== "string") || !isJsonObject(item.response)
            || (visit !== null && (typeof visit !== "number" || !Number.isSafeInteger(visit) || visit < 1))) {
            throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", "A stored test fixture has an invalid shape.");
        }
        return {
            operation: item.operation as WorkflowTestFixtureOperation, tool: item.tool as string | null, state: item.state as string | null,
            argumentsSha256: item.argumentsSha256 as string | null, ...(visit !== null ? { visit: visit as number } : {}), response: parseTestResponse(item.response),
        };
    });
}

/**
 * The first fixture for this effect: its operation, its tool (a tool call) or state, and the exact hash of its arguments;
 * else the first one of its operation and tool or state that gave no arguments (any arguments). G2: among those, one for
 * the effect's visit wins over one for any visit (`visit` null); a fixture for another visit never answers. An effect with
 * no visit (null) takes only fixtures for any visit.
 */
export function matchTestFixture(fixtures: readonly WorkflowTestFixture[], effect: {
    operation: WorkflowTestFixtureOperation; tool: string | null; state: string | null; argumentsSha256: string | null; visit?: number | null;
}): WorkflowTestFixture | null {
    const visit = effect.visit ?? null;
    const same = (fixture: WorkflowTestFixture): boolean => fixture.operation === effect.operation
        && (effect.operation === "tool.call" ? fixture.tool === effect.tool : fixture.state === effect.state);
    const forVisit = (fixture: WorkflowTestFixture, exact: boolean): boolean => (exact ? visit !== null && fixture.visit === visit : (fixture.visit ?? null) === null);
    for (const [args, exact] of [[true, true], [true, false], [false, true], [false, false]] as const) {
        const found = fixtures.find(fixture => same(fixture) && forVisit(fixture, exact)
            && (args ? effect.argumentsSha256 !== null && fixture.argumentsSha256 === effect.argumentsSha256 : fixture.argumentsSha256 === null));
        if (found) return found;
    }
    return null;
}

let declineSchemas: WorkflowSchemaSet | null = null;
function declineProblems(value: JsonValue): SchemaProblem[] {
    declineSchemas ??= new WorkflowSchemaSet({ decline: WORKFLOW_V2_DECLINE_SCHEMA });
    return declineSchemas.validate("decline", value);
}

const problemsJson = (problems: SchemaProblem[]): JsonValue => problems.map(problem => ({ path: problem.path, message: problem.message }));

/** A runtime error result of an intercepted state, decided by its test response (winner test). */
function testError(code: string, message: string, details?: JsonValue): NodeResultInput {
    return {
        outcome: code, resultKind: "runtime_error", winner: "test",
        valueText: canonicalJson({ code, message, ...(details !== undefined ? { details } : {}) }),
    };
}

/**
 * The result an agent, send or request state gets from its test response,
 * checked as the live effect's result would be (design 05): an agent's
 * success is `{ outcome, output }` with an outcome its state declares and an
 * output that matches its outputSchema; a send's success is `sent`, its
 * output the mock's value with what was sent; a request's success is
 * `{ response }` (it must match the contract's response schema) or
 * `{ decline: { reason } }`; an error is `{ code, message, details? }` with
 * a runtime error code, and a cancel is the runtime error cancelled. An
 * invalid response decides nothing: it is refused with its field errors
 * (TEST_RESPONSE_INVALID), and the effect stays open. A tool call has no
 * state result (null): its script receives the response.
 */
export function testResultFor(interception: Pick<WorkflowTestInterception, "operation" | "interceptionId" | "arguments">,
    node: WorkflowIRNode, ir: Pick<WorkflowIR, "schemaDefs" | "contracts">, irSha256: string, response: WorkflowTestResponse): NodeResultInput | null {
    if (interception.operation === "tool.call") return null;
    if (response.kind === "cancel") return testError("cancelled", "The test's parent cancelled this mocked effect.");
    if (response.kind === "error") {
        const error = response.value as { code?: string; message: string; details?: JsonValue };
        if (error.code === undefined || !(RUNTIME_ERROR_CODES as readonly string[]).includes(error.code)) {
            throw invalid(`An error response to ${interception.operation} needs code: one of ${RUNTIME_ERROR_CODES.join(", ")}.`);
        }
        return testError(error.code, error.message, error.details);
    }
    const value = response.value;
    if (interception.operation === "agent") {
        if (node.type !== "agent") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `State ${node.id} is not an agent state.`);
        if (!isJsonObject(value) || typeof value.outcome !== "string" || Object.keys(value).some(key => key !== "outcome" && key !== "output")) {
            throw invalid("An agent's success response is { outcome, output }.", { outcomes: node.outcomes });
        }
        if (!node.outcomes.includes(value.outcome)) {
            throw invalid(`Outcome '${value.outcome}' is not one of the state's outcomes.`, { outcomes: node.outcomes });
        }
        const output = value.output === undefined ? null : value.output;
        if (node.outputSchema) {
            const problems = schemaSetFor(irSha256, ir.schemaDefs).validate(node.outputSchema, output);
            if (problems.length > 0) throw invalid(`The output does not match ${node.outputSchema}.`, { problems: problemsJson(problems) });
        }
        return { outcome: value.outcome, resultKind: "business", valueText: canonicalJson(output), winner: "test" };
    }
    if (node.type !== "messaging" || node.mode === "receive") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `State ${node.id} does not send.`);
    if (interception.operation === "send") {
        const sent: { [key: string]: JsonValue } = isJsonObject(interception.arguments) ? interception.arguments : {};
        return {
            outcome: MESSAGE_SENT, resultKind: "business", winner: "test",
            valueText: canonicalJson({ mocked: true, interceptionId: interception.interceptionId, recipientSessionId: sent.recipient ?? null,
                contract: sent.contract ?? null, value }),
        };
    }
    if (!isJsonObject(value) || Object.keys(value).length !== 1 || !(Object.hasOwn(value, "response") || Object.hasOwn(value, "decline"))) {
        throw invalid("A request's success response is { response } or { decline: { reason } }.");
    }
    if (Object.hasOwn(value, "decline")) {
        const problems = declineProblems(value.decline);
        if (problems.length > 0) throw invalid("A decline is { reason: <1 to 2,000 characters> } and nothing else.", { problems: problemsJson(problems) });
        return { outcome: REQUEST_DECLINED, resultKind: "business", valueText: canonicalJson(value.decline), winner: "test" };
    }
    if (node.mode !== "request") throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `State ${node.id} is not a request state.`);
    const schema = ir.contracts?.[node.contract]?.response?.schema;
    if (!schema) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Contract ${node.contract} declares no response.`);
    const problems = schemaSetFor(irSha256, ir.schemaDefs).validate(schema, value.response);
    if (problems.length > 0) throw invalid(`The response does not match ${schema}.`, { problems: problemsJson(problems) });
    return { outcome: REQUEST_RESPONDED, resultKind: "business", valueText: canonicalJson(value.response), winner: "test" };
}

/** What a script's tool call returns, or the error it throws, from its test response. */
export function toolCallResultOf(interception: WorkflowTestInterception): { value: JsonValue } | { error: string } {
    const response = interception.response;
    if (!response) throw new WorkflowStoreError("WORKFLOW_STORE_CORRUPT", `Interception ${interception.interceptionId} has no response yet.`);
    if (response.kind === "success") return { value: response.value };
    if (response.kind === "cancel") return { error: `The test's parent cancelled tool call ${interception.interceptionId}.` };
    const error = response.value as { code?: string; message: string };
    return { error: error.code ? `${error.code}: ${error.message}` : error.message };
}

/**
 * The prompt that tells a test's parent that an intercepted effect waits for its answer (best effort; design 05; batch 7,
 * w-1 and w-2): the header (type=test_waiting, its state and interception), one plain sentence that says how to answer,
 * then the effect as JSON on one line, with the characters that could close a marker escaped inside its strings
 * (promptSafeJson; its own arrays stay JSON).
 * `workflow`: its name and version when the caller knows them.
 */
export function workflowTestNoticePrompt(data: { [key: string]: JsonValue }, workflow: { name: string | null; version: string | null } | null = null): string {
    const json = promptSafeJson(data);
    const field = (key: string): string | null => (typeof data[key] === "string" && data[key] ? data[key] as string : null);
    const header = workflowUpdateHeader({ from: field("sessionId") ?? "-", workflow, run: field("runId") ?? "-", type: "test_waiting",
        fields: [["state", field("stateId")], ["interception", field("interceptionId")]] });
    // SF-7: checked identifiers only; the workflow's name is in the header, never in the sentence.
    const say = (value: unknown): string | null => workflowUpdateSentenceId(value);
    const what = [say(field("operation")), say(field("tool"))].filter(Boolean).join(" ");
    const state = say(field("stateId"));
    return workflowUpdateMessage(header, `A workflow (session ${workflowUpdateShortId(field("sessionId"))}) test run ${workflowUpdateShortId(field("runId"))} `
        + `waits for your mock answer to ${what || "a held call"}${state ? ` in step ${state}` : ""}. Answer with update_workflow `
        + `operation test_respond (run_id ${say(field("runId")) ?? "(see the data)"}, interception_id ${say(field("interceptionId")) ?? "(see the data)"}).`, json);
}

/** Whether a state's node execution is the one an interception is for, and its arguments' match key for fixtures. */
export function interceptionMatchKey(interception: WorkflowTestInterception, node: WorkflowNodeExecutionRow): { state: string | null; argumentsSha256: string } {
    return interception.operation === "tool.call"
        ? { state: null, argumentsSha256: interception.argumentsSha256 }
        : { state: node.nodeId, argumentsSha256: node.inputSha256 };
}

/** The events of an answered interception of a test run, and of the state it decided (if any). */
export function workflowTestAnsweredProjection(run: Pick<WorkflowRunRow, "workflowSessionId" | "runId">,
    executed: Pick<WorkflowNodeExecutionRow, "nodeExecutionId" | "nodeId" | "ordinal">, answered: WorkflowTestInterception,
    decided: NodeResultInput | null): SessionProjection {
    return {
        sessionId: run.workflowSessionId,
        events: [
            { eventType: "workflow.test_answered", data: {
                runId: run.runId, interceptionId: answered.interceptionId, operation: answered.operation, kind: answered.response?.kind ?? null,
                disposition: answered.response?.disposition ?? null,
            } },
            ...(decided === null ? [] : [{ eventType: decided.resultKind === "business" ? "workflow.state_completed" : "workflow.state_failed", data: {
                runId: run.runId, nodeExecutionId: executed.nodeExecutionId, stateId: executed.nodeId, step: executed.ordinal, outcome: decided.outcome,
                resultKind: decided.resultKind, mocked: true,
                // S6-SF2: a mocked error has its secrets hidden in full before it is cut (redactErrorThenClip).
                ...(decided.resultKind === "business" ? { outputPreview: jsonbSafeText(decided.valueText, 1_000) } : { error: redactErrorThenClip(decided.valueText, 2_000) }),
            } }]),
        ],
        update: { touch: true },
    };
}
