/**
 * Workflow v2 messaging request states: the disabled foundation (design
 * docs/proposals/workflow-messaging-request.md, section 8.4).
 *
 * - With requests enabled, a request state compiles to IR version 7: its
 *   contract declares a response, its payload is `input`, its deadline is
 *   `timeoutSeconds` (1 to 86,400, or one binding), and its routes are
 *   responded, declined and runtime error codes (timed_out among them). The
 *   obsolete spellings `request` and the route `timeout` are refused by
 *   name. A send or receive state may use a contract that declares a
 *   response; such a workflow is version 7 too. A response schema, with the
 *   schemas it references, is at most 8 KiB.
 * - The compiler's own options can leave requests out (its unit tests use
 *   that): a request state or a contract response is then checked field by
 *   field and refused. Every host compiles with them on.
 * - A worker reads IR version 7 only when asked to: by default it refuses it
 *   explicitly, and a version 6 or earlier IR never carries a response or a
 *   request state. IR 1 to 6 compile exactly as before.
 *
 * Nothing here runs a request: the controller, the tool and the delivery
 * are gated (design section 8.4).
 *
 * The store's request records and response transaction (migration 0097),
 * called directly as no runtime calls them yet:
 * - a request state admitted pending writes its message intent (outbox, mode
 *   request) and its immutable request record with the node's deadline; a
 *   responder that is a workflow, of another user or missing fails the state
 *   at admission and stores nothing; delivery methods refuse a request's
 *   message;
 * - the request's status is derived from its node and response record, and
 *   any other combination is store corruption;
 * - a response call passes the request rule first (only the frozen
 *   responder, live and related to the requester; an unknown request and
 *   every refusal are the same REQUEST_NOT_FOUND, with nothing written),
 *   then the call's shape and size, a known operation (its binding decides
 *   alone), the schema, the 50-operation bound and one reading of the
 *   store's clock against the deadline; a decision writes the node, the
 *   response record, its receipt, the operation's binding and the wake
 *   intent together;
 * - every admitted operation keeps one binding (A/X, B/X, B/Y gives
 *   OPERATION_CONFLICT); a soft-deleted requester gets read-only answers;
 * - JSON values (null, false, arrays, NUL, lone and paired surrogates,
 *   special keys) are kept exactly;
 * - request rows, responses and bindings never change except a binding's
 *   repeat counters, a settled wake never changes, and none is deleted.
 *
 * The independent review of the store (RQF-1 to RQF-4), each on the real
 * store: a response's identity is hashed from its canonical text, so a value
 * at the full JSON depth keeps it; the admission and every new decision use
 * the response schema that the state's contract declares in the pinned
 * definition, and anything else is store corruption; inspection and every
 * response path, a known operation's replay included, check a request's
 * committed state whole (its node, run, message, response, receipt, winning
 * binding and wake intent); and the request rule comes before the operation
 * id and the call, so every refused caller gets the same REQUEST_NOT_FOUND.
 *
 * Durable expiry (formal intent model CP1 trace): the store's clock can step
 * back, so once an operation of a pending request is bound expired, a later
 * new operation is expired too, whatever its own reading; known operations
 * replay, and a request with no expired binding is still decided by its one
 * reading. Only that reading is injected (requestClock). A-ISO (CP6): a call
 * that read the request and then waited on the requester's lock while an
 * expired call committed is expired too, on a connection whose sessions
 * default to REPEATABLE READ, because the store's transactions state READ
 * COMMITTED (the level inside the call is read back).
 */
import { describe, it, expect } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { checkpoint, reachedDuring, requestClock, requestFixture } from "../helpers/workflow-v2-request-fixture.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import {
    compileWorkflowV2, parseWorkflowIr, REQUEST_RESPONSE_SCHEMA_MAX_BYTES, WORKFLOW_V2_REQUEST_IR_VERSION, WORKFLOW_V2_SEND_IR_VERSION,
} from "../../src/workflow/v2/compiler.ts";
import { canonicalJson, jsonSha256, kindValueSha256 } from "../../src/workflow/v2/json.ts";
import { schemaReferences } from "../../src/workflow/v2/schema.ts";
import { describeWorkflowV2State, workflowLiveControllerInstanceId } from "../../src/workflow/v2/runtime.ts";
import {
    nodeExecutionIdFor, WORKFLOW_V2_MAX_REQUEST_OPERATIONS, WORKFLOW_V2_MAX_RESPONSE_BYTES, WorkflowStore,
} from "../../src/workflow/v2/store.ts";

const getEnv = useSuiteEnv(import.meta.url);
const ACTOR = { kind: "system", name: "workflow-v2-request-test" };
const TIMEOUT = 120_000;
const ENABLED = { enableRequests: true };

const SCHEMAS = `schemas:
  Question: { type: object, required: [q], properties: { q: { type: string } }, additionalProperties: false }
  Answer: { type: object, required: [approved], properties: { approved: { type: boolean } }, additionalProperties: false }`;

/** One request state to the parent, then terminals for each outcome. */
const REQUESTER = ({
    state = `    recipient: { parent: true }
    contract: Approval@1
    input: { q: "ship?" }
    timeoutSeconds: 3600
    transition: { next: { responded: done, declined: blocked, timed_out: blocked, failure: failed } }`,
    response = `    response: { schema: { $ref: "#/schemas/Answer" } }\n`,
    schemas = SCHEMAS,
} = {}) => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: requester, version: "1.0.0" }
initial: ask
${schemas}
contracts:
  Approval@1:
    schema: { $ref: "#/schemas/Question" }
${response}states:
  ask:
    type: messaging
    mode: request
${state}
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  blocked: { type: terminal, outcome: blocked }
  failed: { type: terminal, outcome: failed }
`;

/** One send state whose contract may declare a response. */
const SENDER = ({ response = "" } = {}) => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: sender, version: "1.0.0" }
initial: tell
${SCHEMAS}
contracts:
  Approval@1:
    schema: { $ref: "#/schemas/Question" }
${response}states:
  tell:
    type: messaging
    mode: send
    recipient: { parent: true }
    contract: Approval@1
    input: { q: "ship?" }
    transition: { next: { sent: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

/** One receive state whose contract may declare a response. */
const RECEIVER = ({ response = "" } = {}) => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: receiver, version: "1.0.0" }
initial: listen
${SCHEMAS}
contracts:
  Approval@1:
    schema: { $ref: "#/schemas/Question" }
${response}states:
  listen:
    type: messaging
    mode: receive
    contract: Approval@1
    transition: { next: { received: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

const RESPONDING = `    response: { schema: { $ref: "#/schemas/Answer" } }\n`;

/** A request workflow whose contract's response is the named schema, with extra declared schemas. */
const WITH_RESPONSE_SCHEMA = (name, extraSchemas) => REQUESTER({
    schemas: `${SCHEMAS}\n${extraSchemas}`,
    response: `    response: { schema: { $ref: "#/schemas/${name}" } }\n`,
});

function errorsOf(result) {
    return result.diagnostics.filter(item => item.severity === "error");
}

function storedForm(ir) {
    return JSON.parse(canonicalJson(ir));
}

function storeError(fn) {
    let caught;
    try { fn(); } catch (error) { caught = error; }
    expect(caught, "expected a stored-shape refusal").toBeDefined();
    expect(caught.code).toBe("WORKFLOW_STORE_CORRUPT");
    return caught;
}

async function expectCode(promise, code) {
    let caught;
    try { await promise; } catch (error) { caught = error; }
    expect(caught?.code, caught?.message).toBe(code);
    return caught;
}

describe("workflow v2 request states: compiler and IR 7", () => {
    it("compiles a request state to IR 7 only when requests are enabled", () => {
        const compiled = compileWorkflowV2(REQUESTER(), ENABLED);
        expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
        expect(compiled.ir.irVersion).toBe(WORKFLOW_V2_REQUEST_IR_VERSION);
        expect(compiled.ir.contracts).toEqual({ "Approval@1": { schema: "Question", response: { schema: "Answer" } } });
        expect(compiled.ir.nodes.ask).toEqual({
            id: "ask", type: "messaging", description: null, mode: "request", contract: "Approval@1", recipient: { parent: true },
            correlate: null, hasInput: true, input: { q: "ship?" }, timeoutSeconds: 3600,
            next: { responded: "done", declined: "blocked", timed_out: "blocked", failure: "failed" },
        });
        expect(compileWorkflowV2(REQUESTER(), ENABLED).irSha256).toBe(compiled.irSha256);
        expect(describeWorkflowV2State(compiled.ir.nodes.ask)).toEqual({
            id: "ask", type: "messaging", mode: "request", contract: "Approval@1", recipient: "parent", timeoutSeconds: 3600,
            outcomes: ["responded", "declined"], next: { responded: "done", declined: "blocked", timed_out: "blocked", failure: "failed" },
        });

        // A bound deadline, a named recipient and a correlation are kept as templates, evaluated when the state is entered.
        const bound = compileWorkflowV2(REQUESTER({
            state: `    recipient: "\${kv.approver}"
    contract: Approval@1
    correlate: { candidate: "\${inputs.head}" }
    timeoutSeconds: "\${kv.secs}"
    transition: { next: { responded: done, declined: blocked, failure: failed } }`,
        }), ENABLED);
        expect(bound.valid, JSON.stringify(bound.diagnostics)).toBe(true);
        expect(bound.ir.nodes.ask).toMatchObject({
            recipient: { sessionId: "${kv.approver}" }, correlate: { candidate: "${inputs.head}" }, hasInput: false, input: null,
            timeoutSeconds: "${kv.secs}",
        });

        // Not enabled (the default): the same document is refused field by field, never compiled.
        const disabled = compileWorkflowV2(REQUESTER());
        expect(disabled.valid).toBe(false);
        expect(disabled.ir).toBeNull();
        expect(disabled.irSha256).toBeNull();
        expect(errorsOf(disabled)).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "WORKFLOW_FEATURE_UNSUPPORTED", path: "states.ask.mode" }),
            expect.objectContaining({ code: "WORKFLOW_FEATURE_UNSUPPORTED", path: "contracts.Approval@1.response" }),
        ]));
        expect(errorsOf(disabled)).toHaveLength(2);
    });

    it("lets send and receive states use a contract that declares a response, as IR 7", () => {
        const plain = compileWorkflowV2(SENDER());
        expect(plain.valid, JSON.stringify(plain.diagnostics)).toBe(true);
        expect(plain.ir.irVersion).toBe(WORKFLOW_V2_SEND_IR_VERSION);
        // A workflow without request states or responses is the same IR whether or not requests are enabled.
        expect(compileWorkflowV2(SENDER(), ENABLED).irSha256).toBe(plain.irSha256);
        const plainReceive = compileWorkflowV2(RECEIVER());
        expect(plainReceive.valid, JSON.stringify(plainReceive.diagnostics)).toBe(true);
        expect(compileWorkflowV2(RECEIVER(), ENABLED).irSha256).toBe(plainReceive.irSha256);

        const sent = compileWorkflowV2(SENDER({ response: RESPONDING }), ENABLED);
        expect(sent.valid, JSON.stringify(sent.diagnostics)).toBe(true);
        expect(sent.ir.irVersion).toBe(WORKFLOW_V2_REQUEST_IR_VERSION);
        expect(sent.ir.nodes.tell.mode).toBe("send");
        expect(sent.ir.contracts["Approval@1"]).toEqual({ schema: "Question", response: { schema: "Answer" } });
        const received = compileWorkflowV2(RECEIVER({ response: RESPONDING }), ENABLED);
        expect(received.valid, JSON.stringify(received.diagnostics)).toBe(true);
        expect(received.ir.irVersion).toBe(WORKFLOW_V2_REQUEST_IR_VERSION);
        expect(received.ir.nodes.listen.mode).toBe("receive");
        expect(received.ir.contracts["Approval@1"]).toEqual({ schema: "Question", response: { schema: "Answer" } });
        expect(parseWorkflowIr(storedForm(received.ir), { maxIrVersion: WORKFLOW_V2_REQUEST_IR_VERSION })).toEqual(received.ir);
        storeError(() => parseWorkflowIr(storedForm(received.ir)));

        for (const yaml of [SENDER({ response: RESPONDING }), RECEIVER({ response: RESPONDING })]) {
            const disabled = compileWorkflowV2(yaml);
            expect(disabled.valid).toBe(false);
            expect(errorsOf(disabled)).toEqual([expect.objectContaining({ code: "WORKFLOW_FEATURE_UNSUPPORTED", path: "contracts.Approval@1.response" })]);
        }
    });

    it("counts a response schema and the schemas it references in schema positions, each once", () => {
        // Only $ref keywords in schema positions are references; the same text as data (const, enum, default, examples) is not.
        expect(schemaReferences({
            type: "object",
            properties: { a: { $ref: "#/$defs/A" }, b: { type: "array", items: { $ref: "#/$defs/B/properties/x" } } },
            allOf: [{ $ref: "#/$defs/A" }],
            $defs: { inner: { $ref: "#/$defs/C" } },
            const: { $ref: "#/$defs/D" }, enum: [{ $ref: "#/$defs/E" }], default: { $ref: "#/$defs/F" }, examples: [{ $ref: "#/$defs/G" }],
        })).toEqual(["A", "B", "C"]);
        expect(schemaReferences(true)).toEqual([]);

        const limit = REQUEST_RESPONSE_SCHEMA_MAX_BYTES;
        // {"description":"<n x>","type":"string"} is 34 + n bytes of canonical JSON.
        const exact = n => `  Exact: { type: string, description: "${"x".repeat(n)}" }`;
        const atLimit = compileWorkflowV2(WITH_RESPONSE_SCHEMA("Exact", exact(limit - 34)), ENABLED);
        expect(atLimit.valid, JSON.stringify(atLimit.diagnostics)).toBe(true);
        const overLimit = compileWorkflowV2(WITH_RESPONSE_SCHEMA("Exact", exact(limit - 33)), ENABLED);
        expect(overLimit.diagnostics).toContainEqual(expect.objectContaining({ code: "WORKFLOW_SCHEMA_TOO_LARGE", path: "contracts.Approval@1.response.schema" }));

        // A literal that looks like a reference adds nothing, even when it names a large declared schema.
        const large = `  Large: { type: string, description: "${"x".repeat(limit)}" }`;
        const literal = compileWorkflowV2(WITH_RESPONSE_SCHEMA("Literal", `${large}
  Literal: { const: { $ref: "#/$defs/Large" }, examples: [{ $ref: "#/$defs/Large" }] }`), ENABLED);
        expect(literal.valid, JSON.stringify(literal.diagnostics)).toBe(true);
        // The same schema referenced in a schema position counts (the control).
        const referenced = compileWorkflowV2(WITH_RESPONSE_SCHEMA("Holder", `${large}
  Holder: { type: object, properties: { detail: { $ref: "#/schemas/Large" } } }`), ENABLED);
        expect(referenced.diagnostics).toContainEqual(expect.objectContaining({ code: "WORKFLOW_SCHEMA_TOO_LARGE", path: "contracts.Approval@1.response.schema" }));

        // A schema referenced twice counts once (5,034 + 5,034 bytes would be over the limit), and a recursive one ends.
        const half = `  Half: { type: string, description: "${"x".repeat(5_000)}" }`;
        const twice = compileWorkflowV2(WITH_RESPONSE_SCHEMA("Pair", `${half}
  Pair: { type: object, properties: { a: { $ref: "#/schemas/Half" }, b: { $ref: "#/schemas/Half" } } }`), ENABLED);
        expect(twice.valid, JSON.stringify(twice.diagnostics)).toBe(true);
        const recursive = compileWorkflowV2(WITH_RESPONSE_SCHEMA("Tree", `  Tree: { type: object, properties: { child: { $ref: "#/schemas/Tree" } } }`), ENABLED);
        expect(recursive.valid, JSON.stringify(recursive.diagnostics)).toBe(true);
    });

    it("refuses obsolete spellings, missing parts and oversize response schemas by name", () => {
        const refusals = [
            // The payload is input and the deadline route is timed_out; neither old spelling is an alias.
            [REQUESTER({ state: `    recipient: { parent: true }
    contract: Approval@1
    request: { q: "ship?" }
    timeoutSeconds: 60
    transition: { next: { responded: done, declined: blocked } }` }), "WORKFLOW_FIELD_RENAMED", "states.ask.request"],
            [REQUESTER({ state: `    recipient: { parent: true }
    contract: Approval@1
    timeoutSeconds: 60
    transition: { next: { responded: done, declined: blocked, timeout: blocked } }` }), "WORKFLOW_ROUTE_RENAMED", "states.ask.transition.next.timeout"],
            [REQUESTER({ response: "" }), "WORKFLOW_CONTRACT_NO_RESPONSE", "states.ask.contract"],
            [REQUESTER({ state: `    recipient: { parent: true }
    contract: Approval@1
    transition: { next: { responded: done, declined: blocked } }` }), "WORKFLOW_FIELD_REQUIRED", "states.ask.timeoutSeconds"],
            [REQUESTER({ state: `    recipient: { parent: true }
    contract: Approval@1
    timeoutSeconds: 0
    transition: { next: { responded: done, declined: blocked } }` }), "WORKFLOW_FIELD_INVALID", "states.ask.timeoutSeconds"],
            [REQUESTER({ state: `    recipient: { parent: true }
    contract: Approval@1
    timeoutSeconds: 86401
    transition: { next: { responded: done, declined: blocked } }` }), "WORKFLOW_FIELD_INVALID", "states.ask.timeoutSeconds"],
            [REQUESTER({ state: `    recipient: { parent: true }
    contract: Approval@1
    timeoutSeconds: 1.5
    transition: { next: { responded: done, declined: blocked } }` }), "WORKFLOW_FIELD_INVALID", "states.ask.timeoutSeconds"],
            [REQUESTER({ state: `    recipient: { parent: true }
    contract: Approval@1
    timeoutSeconds: 60
    transition: { next: { responded: done } }` }), "WORKFLOW_ROUTE_MISSING", "states.ask.transition.next"],
            [REQUESTER({ state: `    recipient: { parent: true }
    contract: Approval@1
    timeoutSeconds: 60
    transition: { next: { responded: done, declined: blocked, sent: done } }` }), "WORKFLOW_ROUTE_INVALID", "states.ask.transition.next.sent"],
            [REQUESTER({ state: `    contract: Approval@1
    timeoutSeconds: 60
    transition: { next: { responded: done, declined: blocked } }` }), "WORKFLOW_FIELD_REQUIRED", "states.ask.recipient"],
            [REQUESTER({ state: `    recipient: { parent: true }
    from: { parent: true }
    contract: Approval@1
    timeoutSeconds: 60
    transition: { next: { responded: done, declined: blocked } }` }), "WORKFLOW_FIELD_UNKNOWN", "states.ask.from"],
            [REQUESTER({ response: "    response: { $ref: \"#/schemas/Answer\" }\n" }), "WORKFLOW_FIELD_INVALID", "contracts.Approval@1.response"],
            [REQUESTER({ response: "    response: { schema: { $ref: \"#/schemas/Answer\" }, tool: x }\n" }), "WORKFLOW_FIELD_UNKNOWN", "contracts.Approval@1.response.tool"],
            [REQUESTER({ response: "    response: { schema: { $ref: \"#/schemas/Missing\" } }\n" }), "WORKFLOW_SCHEMA_UNKNOWN", "contracts.Approval@1.response.schema.$ref"],
        ];
        for (const [yaml, code, path] of refusals) {
            const result = compileWorkflowV2(yaml, ENABLED);
            expect(result.valid, `${code} ${path}: ${JSON.stringify(result.diagnostics)}`).toBe(false);
            expect(result.diagnostics, `${code} ${path}`).toContainEqual(expect.objectContaining({ code, path }));
        }

        // A response schema counts every schema it references; the limit is on their canonical JSON.
        const big = "x".repeat(REQUEST_RESPONSE_SCHEMA_MAX_BYTES);
        const oversize = REQUESTER({
            schemas: `${SCHEMAS}
  Wrapper: { type: object, properties: { detail: { $ref: "#/schemas/Detail" } } }
  Detail: { type: string, description: "${big}" }`,
            response: `    response: { schema: { $ref: "#/schemas/Wrapper" } }\n`,
        });
        const refused = compileWorkflowV2(oversize, ENABLED);
        expect(refused.valid).toBe(false);
        expect(refused.diagnostics).toContainEqual(expect.objectContaining({ code: "WORKFLOW_SCHEMA_TOO_LARGE", path: "contracts.Approval@1.response.schema" }));
        const small = compileWorkflowV2(REQUESTER({
            schemas: `${SCHEMAS}
  Wrapper: { type: object, properties: { detail: { $ref: "#/schemas/Detail" } } }
  Detail: { type: string, description: "short" }`,
            response: `    response: { schema: { $ref: "#/schemas/Wrapper" } }\n`,
        }), ENABLED);
        expect(small.valid, JSON.stringify(small.diagnostics)).toBe(true);
    });

    it("reads IR 7 only when asked to, and never a response or a request state in earlier versions", () => {
        const compiled = compileWorkflowV2(REQUESTER(), ENABLED);
        const stored = storedForm(compiled.ir);
        const refused = storeError(() => parseWorkflowIr(stored));
        expect(refused.message).toContain("stored IR version 7 is not supported by this worker");
        expect(parseWorkflowIr(stored, { maxIrVersion: WORKFLOW_V2_REQUEST_IR_VERSION })).toEqual(compiled.ir);

        // A request state needs its contract's response, and version 7.
        const { response: _response, ...withoutResponse } = stored.contracts["Approval@1"];
        storeError(() => parseWorkflowIr({ ...stored, contracts: { "Approval@1": withoutResponse } }, { maxIrVersion: 7 }));
        storeError(() => parseWorkflowIr({ ...stored, nodes: { ...stored.nodes, ask: { ...stored.nodes.ask, timeoutSeconds: null } } }, { maxIrVersion: 7 }));

        const send = storedForm(compileWorkflowV2(SENDER()).ir);
        expect(send.irVersion).toBe(WORKFLOW_V2_SEND_IR_VERSION);
        expect(parseWorkflowIr(send).nodes.tell.mode).toBe("send");
        // Version 6 never carries a response or a request state, even for a reader that takes version 7.
        const withResponse = { ...send, contracts: { "Approval@1": { schema: "Question", response: { schema: "Answer" } } } };
        storeError(() => parseWorkflowIr(withResponse));
        storeError(() => parseWorkflowIr(withResponse, { maxIrVersion: 7 }));
        storeError(() => parseWorkflowIr({ ...send, nodes: { ...send.nodes, tell: { ...send.nodes.tell, mode: "request", timeoutSeconds: 60 } } },
            { maxIrVersion: 7 }));
    });
});

/** A definition with two request states: ask (an Answer response) and free (any JSON response). */
const REQUESTS = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: requests, version: "1.0.0" }
initial: ask
${SCHEMAS}
  Any: true
contracts:
  Approval@1:
    schema: { $ref: "#/schemas/Question" }
    response: { schema: { $ref: "#/schemas/Answer" } }
  Free@1:
    schema: true
    response: { schema: { $ref: "#/schemas/Any" } }
states:
  ask:
    type: messaging
    mode: request
    recipient: { parent: true }
    contract: Approval@1
    input: { q: "ship?" }
    timeoutSeconds: 3600
    transition: { next: { responded: free, declined: blocked, failure: failed } }
  free:
    type: messaging
    mode: request
    recipient: { parent: true }
    contract: Free@1
    timeoutSeconds: 3600
    transition: { next: { responded: done, declined: blocked, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  blocked: { type: terminal, outcome: blocked }
  failed: { type: terminal, outcome: failed }
`;

/** ISO 8601 UTC with microseconds, as the store records its times. */
const EXACT_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;

/**
 * The store with a published request definition and an admitted run (no runtime: nothing dispatches it): the
 * requester workflow, its parent (the responder) and other sessions, of user alice unless named otherwise.
 */
async function requestHarness(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const direct = new pg.Pool({ connectionString: env.store, max: 2 });
    const q = async (text, params = []) => (await direct.query(text.replaceAll("SCHEMA.", `"${env.cmsSchema}".`), params)).rows;
    const alice = { provider: "test", subject: `alice-${randomUUID()}` };
    const bob = { provider: "test", subject: `bob-${randomUUID()}` };
    const session = async (owner, opts = {}) => {
        const sessionId = randomUUID();
        await catalog.createSession(sessionId, { ...(owner ? { owner } : {}), ...opts });
        return sessionId;
    };
    const parent = await session(alice);
    const peer = await session(alice);
    const stranger = await session(bob);
    const compiled = compileWorkflowV2(REQUESTS, ENABLED);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    const workflow = async (owner = alice, parentSessionId = parent) => {
        const workflowSessionId = randomUUID();
        const runId = randomUUID();
        expect((await catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId, owner, creationConfig: { workflowV2: { requestSha256: "test" } } })).created)
            .toBe(true);
        await store.createDefinition({
            workflowSessionId, parentSessionId, notifyParent: false, yaml: REQUESTS, compiled, actor: ACTOR, operationId: "create",
            requestSha256: "test", publish: true, title: "Workflow: requests",
            start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId), inputsText: "{}", kvText: "{}", testAgentMode: null },
        });
        return { workflowSessionId, runId };
    };
    const refusal = (code) => ({ result: { outcome: code, resultKind: "runtime_error", valueText: canonicalJson({ code, message: code }), winner: "controller" } });
    /**
     * Enter request state `nodeId` (ordinal `ordinal`) of a run for `recipient`, with the spec the compiled definition
     * gives unless `contract` or `responseSchema` overrides it (a spec no runtime would pass).
     */
    const enter = (run, recipient, { nodeId = "ask", ordinal = 1, timeoutSeconds = 3600, payload = { q: "ship?" }, contract, responseSchema } = {}) => {
        const node = compiled.ir.nodes[nodeId];
        return store.enterNode({
            runId: run.runId, nodeExecutionId: nodeExecutionIdFor(run.runId, "root", nodeId, ordinal), scopeId: "root", nodeId, ordinal,
            nodeType: "messaging", predecessorId: null, arrivalRoute: null, inputText: canonicalJson(payload), kvRevision: 1, waitSeconds: null, immediate: null,
            request: {
                recipient, contract: contract ?? node.contract, payloadText: canonicalJson(payload), correlationText: "{}",
                refused: { unavailable: refusal("unavailable"), forbidden: refusal("forbidden") },
                timeoutSeconds, responseSchema: responseSchema ?? compiled.ir.contracts[node.contract].response.schema,
                workflowRecipient: refusal("unsupported_contract"),
            },
        });
    };
    /** Admit request state `nodeId` (ordinal `ordinal`) of a run to `recipient`. */
    const admit = async (run, recipient, options = {}) => {
        const admitted = await enter(run, recipient, options);
        expect(admitted.admitted).toBe(true);
        return { exchangeId: nodeExecutionIdFor(run.runId, "root", options.nodeId ?? "ask", options.ordinal ?? 1), node: admitted.node };
    };
    const respond = (exchangeId, actorSessionId, operationId, call) => store.respondToRequest({ exchangeId, actorSessionId, operationId, call });
    const operations = async (exchangeId) => Number((await q("SELECT count(*)::int AS n FROM SCHEMA.workflow_request_operations WHERE exchange_id = $1",
        [exchangeId]))[0].n);
    const binding = async (exchangeId, operationId) => (await q(
        "SELECT result_sha256, outcome, status, count FROM SCHEMA.workflow_request_operations WHERE exchange_id = $1 AND operation_id = $2",
        [exchangeId, operationId]))[0] ?? null;
    /** Run one statement with migration 0097's guard trigger on `table` off: a committed fixture the store's own writes never make. */
    const withoutGuard = async (table, text, params = []) => {
        await q(`ALTER TABLE SCHEMA.${table} DISABLE TRIGGER ${table}_guard`);
        try { return await q(text, params); } finally { await q(`ALTER TABLE SCHEMA.${table} ENABLE TRIGGER ${table}_guard`); }
    };
    /** The requester's workflow.state_completed events for one request. */
    const stateCompleted = async (workflowSessionId, exchangeId) => (await catalog.getSessionEvents(workflowSessionId, 0, 1000))
        .filter(event => event.eventType === "workflow.state_completed" && event.data?.exchangeId === exchangeId).length;
    return {
        catalog, store, q, alice, bob, parent, peer, stranger, compiled, session, workflow, enter, admit, respond, operations, binding, withoutGuard,
        stateCompleted,
        async stop() { await catalog.close(); await direct.end(); },
    };
}

describe("workflow v2 request states: records and the response transaction (store)", () => {
    it("admits a request with its immutable record, refuses every caller but its responder alike, and decides it once", { timeout: TIMEOUT }, async () => {
        const h = await requestHarness(getEnv());
        try {
            const run = await h.workflow();
            const { exchangeId, node } = await h.admit(run, h.parent);
            expect(node).toMatchObject({ state: "pending", nodeType: "messaging" });
            // The deadline is the admission's accepted-entry reading plus the frozen seconds; the record keeps both.
            const [times] = await h.q(`SELECT (node.deadline_at = node.entered_at + interval '3600 seconds') AS deadline_ok,
                    (req.deadline_at = node.deadline_at AND req.created_at = node.entered_at) AS record_ok
               FROM SCHEMA.workflow_node_executions node JOIN SCHEMA.workflow_requests req ON req.exchange_id = node.node_execution_id
              WHERE node.node_execution_id = $1`, [exchangeId]);
            expect(times).toEqual({ deadline_ok: true, record_ok: true });
            expect(await h.store.readOutboxMessage(exchangeId)).toMatchObject({ mode: "request", state: "pending", recipientSessionId: h.parent,
                recipientKind: "agent", contract: "Approval@1", payload: { q: "ship?" } });
            const pending = await h.store.readRequest(exchangeId);
            expect(pending).toMatchObject({ exchangeId, workflowSessionId: run.workflowSessionId, runId: run.runId, stateId: "ask",
                responderSessionId: h.parent, contract: "Approval@1", responseSchema: "Answer", status: "pending", failure: null,
                response: null, wake: null, operations: 0 });
            expect(pending.deadlineAt).toMatch(EXACT_TIME);
            expect((await h.store.listRequests(run.runId)).map(item => item.exchangeId)).toEqual([exchangeId]);
            // Delivery by a send orchestration refuses a request's message.
            await expectCode(h.store.beginDelivery(exchangeId, { refused: { unavailable: { result: null }, forbidden: { result: null } }, ended: null,
                delivered: { stateId: "ask", projection: () => ({ sessionId: run.workflowSessionId }) } }), "WORKFLOW_STORE_CORRUPT");
            // Requests are stored, not run: IR 7 is read only when asked for.
            await expectCode(h.store.readRevisionIr(run.workflowSessionId, 1, h.compiled.irSha256), "WORKFLOW_STORE_CORRUPT");
            expect((await h.store.readRevisionIr(run.workflowSessionId, 1, h.compiled.irSha256, { maxIrVersion: 7 })).irVersion).toBe(7);

            // The request rule: only the frozen responder. Another session of the same user, another user's, an unknown request
            // and an unknown session all get the same refusal, before any structural check, and nothing is written.
            for (const [id, actor, call] of [
                [exchangeId, h.peer, { response: { approved: true } }],
                [exchangeId, h.stranger, { response: { approved: true } }],
                [exchangeId, randomUUID(), { response: { approved: true } }],
                [exchangeId, h.peer, { nonsense: 1 }],
                [`nx-${"0".repeat(40)}`, h.parent, { response: { approved: true } }],
            ]) await expectCode(h.respond(id, actor, "op-wrong", call), "REQUEST_NOT_FOUND");
            // The call: exactly one of response or decline, JSON within 16 KiB, matching its schema; nothing is bound.
            for (const call of [
                {}, { response: { approved: true }, decline: { reason: "no" } }, { response: undefined }, { response: { approved: "yes" } },
                { response: { approved: true, extra: 1 } }, { decline: { reason: "" } }, { decline: { reason: "x".repeat(2_001) } },
                { decline: { reason: "no", why: "x" } }, { decline: "no" },
                { response: { approved: true, pad: "x".repeat(WORKFLOW_V2_MAX_RESPONSE_BYTES) } },
            ]) await expectCode(h.respond(exchangeId, h.parent, "op-invalid", call), "RESPONSE_INVALID");
            expect(await h.operations(exchangeId)).toBe(0);
            expect((await h.store.readRequest(exchangeId)).status).toBe("pending");

            // Operation A decides with X: node, response record, receipt, binding and wake intent in one transaction.
            const X = { approved: true };
            const Y = { approved: false };
            const decided = await h.respond(exchangeId, h.parent, "A", { response: X });
            expect(decided).toMatchObject({ kind: "accepted", replayed: false, status: "responded" });
            expect(decided.receipt).toEqual({
                exchangeId, workflowSessionId: run.workflowSessionId, runId: run.runId, stateId: "ask", responderSessionId: h.parent,
                operationId: "A", kind: "response", resultSha256: jsonSha256({ kind: "response", value: X }), decidedAt: decided.receipt.decidedAt,
            });
            expect(decided.receipt.decidedAt).toMatch(EXACT_TIME);
            const view = await h.store.readRequest(exchangeId);
            expect(view).toMatchObject({ status: "responded", operations: 1, wake: { state: "pending", attempts: 0, settledAt: null } });
            expect(view.response).toMatchObject({ kind: "response", value: X, operationId: "A", actorSessionId: h.parent, receipt: decided.receipt });
            const [stored] = await h.q(`SELECT node.state, node.outcome, node.result_kind, node.winner, node.output,
                    (node.completed_at = resp.decided_at) AS one_reading, (wake.next_attempt_at = resp.decided_at) AS wake_due,
                    (resp.decided_at < req.deadline_at) AS before_deadline
               FROM SCHEMA.workflow_node_executions node JOIN SCHEMA.workflow_request_responses resp ON resp.exchange_id = node.node_execution_id
               JOIN SCHEMA.workflow_requests req ON req.exchange_id = node.node_execution_id
               JOIN SCHEMA.workflow_response_wakes wake ON wake.exchange_id = node.node_execution_id
              WHERE node.node_execution_id = $1`, [exchangeId]);
            expect(stored).toEqual({ state: "completed", outcome: "responded", result_kind: "business", winner: "response", output: canonicalJson(X),
                one_reading: true, wake_due: true, before_deadline: true });
            const events = await h.catalog.getSessionEvents(run.workflowSessionId, 0, 1000);
            expect(events.filter(event => event.eventType === "workflow.state_completed" && event.data?.exchangeId === exchangeId)).toHaveLength(1);

            // Operation identity: A/X replays, B/X is an alias of the winner, B/Y is the same operation with another result.
            const replay = await h.respond(exchangeId, h.parent, "A", { response: X });
            expect(replay).toEqual({ kind: "accepted", replayed: true, receipt: decided.receipt, status: "responded" });
            expect(await h.respond(exchangeId, h.parent, "B", { response: X })).toEqual({ kind: "accepted", replayed: true, receipt: decided.receipt, status: "responded" });
            expect(await h.respond(exchangeId, h.parent, "B", { response: Y })).toMatchObject({ kind: "refused", code: "OPERATION_CONFLICT", replayed: true });
            expect(await h.respond(exchangeId, h.parent, "C", { response: Y })).toMatchObject({ kind: "refused", code: "RESPONSE_CONFLICT", replayed: false });
            expect(await h.respond(exchangeId, h.parent, "C", { response: Y })).toMatchObject({ kind: "refused", code: "RESPONSE_CONFLICT", replayed: true });
            expect(await h.respond(exchangeId, h.parent, "C", { response: X })).toMatchObject({ kind: "refused", code: "OPERATION_CONFLICT" });
            // A decline never has a response's identity, even with the same value.
            expect(await h.respond(exchangeId, h.parent, "D", { decline: { reason: "no" } })).toMatchObject({ kind: "refused", code: "RESPONSE_CONFLICT" });
            expect(await h.respond(exchangeId, h.parent, "D", { response: { reason: "no" } })).toMatchObject({ code: "OPERATION_CONFLICT" });
            expect(await h.binding(exchangeId, "A")).toEqual({ result_sha256: decided.receipt.resultSha256, outcome: "decided", status: "responded", count: 2 });
            expect(await h.binding(exchangeId, "B")).toMatchObject({ outcome: "same", count: 2 });
            expect(await h.binding(exchangeId, "C")).toMatchObject({ outcome: "conflict", count: 3 });
            expect(await h.operations(exchangeId)).toBe(4);
            // The winner is unchanged by all of them, and so is the wake intent: a replay writes none.
            const after = await h.store.readRequest(exchangeId);
            expect(after.response).toEqual(view.response);
            expect(after.wake).toEqual(view.wake);
            // The wrong actor learns nothing, also with the winner's operation id.
            await expectCode(h.respond(exchangeId, h.peer, "A", { response: X }), "REQUEST_NOT_FOUND");

            // Records are written once; a binding changes only its counters; a settled wake never changes; nothing is deleted.
            for (const statement of [
                "UPDATE SCHEMA.workflow_requests SET contract = 'Other@1' WHERE exchange_id = $1",
                "DELETE FROM SCHEMA.workflow_requests WHERE exchange_id = $1",
                "UPDATE SCHEMA.workflow_request_responses SET value = 'null' WHERE exchange_id = $1",
                "DELETE FROM SCHEMA.workflow_request_responses WHERE exchange_id = $1",
                "UPDATE SCHEMA.workflow_request_operations SET outcome = 'same' WHERE exchange_id = $1 AND operation_id = 'A'",
                "DELETE FROM SCHEMA.workflow_request_operations WHERE exchange_id = $1",
                "DELETE FROM SCHEMA.workflow_response_wakes WHERE exchange_id = $1",
                "UPDATE SCHEMA.workflow_response_wakes SET run_id = run_id || 'x' WHERE exchange_id = $1",
            ]) {
                let caught;
                try { await h.q(statement, [exchangeId]); } catch (error) { caught = error; }
                expect(caught, statement).toBeDefined();
            }
            await h.q("UPDATE SCHEMA.workflow_response_wakes SET state = 'dispatched', settled_at = clock_timestamp() WHERE exchange_id = $1", [exchangeId]);
            let settled;
            try { await h.q("UPDATE SCHEMA.workflow_response_wakes SET attempts = attempts + 1 WHERE exchange_id = $1", [exchangeId]); } catch (error) { settled = error; }
            expect(settled?.message).toContain("a settled wake intent never changes");
        } finally { await h.stop(); }
    });

    it("decides a declined refusal, expires at its deadline, and fails a workflow, another user's or a missing responder at admission", { timeout: TIMEOUT }, async () => {
        const h = await requestHarness(getEnv());
        try {
            const run = await h.workflow();
            // A declined refusal: the strict decline schema.
            const declined = await h.admit(run, h.parent, { ordinal: 1 });
            const refused = await h.respond(declined.exchangeId, h.parent, "D1", { decline: { reason: "not now" } });
            expect(refused).toMatchObject({ kind: "accepted", replayed: false, status: "declined",
                receipt: { kind: "decline", resultSha256: jsonSha256({ kind: "decline", value: { reason: "not now" } }) } });
            expect(await h.store.readRequest(declined.exchangeId)).toMatchObject({ status: "declined", response: { kind: "decline", value: { reason: "not now" } } });
            expect((await h.store.readNodeExecution(declined.exchangeId))).toMatchObject({ state: "completed", outcome: "declined", winner: "response" });

            // A call whose one reading is at or after the deadline accepts nothing and decides nothing; it is bound once.
            const late = await h.admit(run, h.parent, { ordinal: 2, timeoutSeconds: 1 });
            await new Promise(resolve => setTimeout(resolve, 1_200));
            expect(await h.respond(late.exchangeId, h.parent, "E", { response: { approved: true } }))
                .toEqual({ kind: "refused", replayed: false, code: "REQUEST_EXPIRED", status: "pending", currentStatus: "pending" });
            expect(await h.respond(late.exchangeId, h.parent, "E", { response: { approved: true } })).toMatchObject({ code: "REQUEST_EXPIRED", replayed: true });
            expect(await h.respond(late.exchangeId, h.parent, "E", { decline: { reason: "late" } })).toMatchObject({ code: "OPERATION_CONFLICT" });
            expect(await h.respond(late.exchangeId, h.parent, "F", { decline: { reason: "late" } })).toMatchObject({ code: "REQUEST_EXPIRED" });
            expect(await h.store.readRequest(late.exchangeId)).toMatchObject({ status: "pending", response: null, wake: null, operations: 2 });
            expect((await h.store.readNodeExecution(late.exchangeId)).state).toBe("pending");

            // Responders the admission refuses: the state fails at once; no message, no record.
            const otherWorkflow = await h.workflow();
            for (const [ordinal, recipient, outcome] of [
                [3, otherWorkflow.workflowSessionId, "unsupported_contract"],
                [4, h.stranger, "forbidden"],
                [5, randomUUID(), "unavailable"],
            ]) {
                const refusedAtEntry = await h.admit(run, recipient, { ordinal });
                expect(refusedAtEntry.node, String(recipient)).toMatchObject({ state: "completed", outcome, resultKind: "runtime_error" });
                expect(await h.store.readRequest(refusedAtEntry.exchangeId)).toBeNull();
                expect(await h.store.readOutboxMessage(refusedAtEntry.exchangeId)).toBeNull();
            }
        } finally { await h.stop(); }
    });

    it("closes a request with its run's end and answers a deleted requester read-only", { timeout: TIMEOUT }, async () => {
        const h = await requestHarness(getEnv());
        try {
            // The run's end cancels a pending request; a later response is closed and bound.
            const ended = await h.workflow();
            const open = await h.admit(ended, h.parent);
            await h.store.finishRun({ runId: ended.runId, status: "cancelled", terminalNodeId: null, terminalOutcome: null, outputText: null,
                errorText: canonicalJson({ code: "cancelled", message: "cancelled by the test" }), endPending: { winner: "cancel", message: "cancelled by the test" } });
            expect(await h.store.readRequest(open.exchangeId)).toMatchObject({ status: "cancelled", response: null });
            expect(await h.respond(open.exchangeId, h.parent, "G", { response: { approved: true } }))
                .toEqual({ kind: "refused", replayed: false, code: "REQUEST_CLOSED", status: "cancelled", currentStatus: "cancelled" });
            expect(await h.binding(open.exchangeId, "G")).toMatchObject({ outcome: "closed", status: "cancelled", count: 1 });

            // A requester deleted after one request was answered and while another waits.
            const run = await h.workflow();
            const answered = await h.admit(run, h.parent, { ordinal: 1 });
            const waiting = await h.admit(run, h.parent, { ordinal: 2 });
            const won = await h.respond(answered.exchangeId, h.parent, "H", { response: { approved: true } });
            await h.catalog.softDeleteSession(run.workflowSessionId);
            expect(await h.store.readRequest(waiting.exchangeId)).toMatchObject({ status: "cancelled", response: null });
            expect(await h.store.readRequest(answered.exchangeId)).toMatchObject({ status: "responded", response: { receipt: won.receipt } });
            // The frozen responder, still related to the kept rows, gets read-only answers: its receipt, or closed; no binding,
            // no counter, no session touch.
            const [before] = await h.q("SELECT last_active_at FROM SCHEMA.sessions WHERE session_id = $1", [run.workflowSessionId]);
            expect(await h.respond(answered.exchangeId, h.parent, "H", { response: { approved: true } }))
                .toEqual({ kind: "accepted", replayed: true, receipt: won.receipt, status: "responded" });
            expect(await h.binding(answered.exchangeId, "H")).toMatchObject({ count: 1 });
            expect(await h.respond(answered.exchangeId, h.parent, "I", { response: { approved: true } }))
                .toMatchObject({ kind: "refused", code: "REQUEST_CLOSED", status: "responded" });
            expect(await h.respond(waiting.exchangeId, h.parent, "J", { response: { approved: true } }))
                .toEqual({ kind: "refused", replayed: false, code: "REQUEST_CLOSED", status: "cancelled", currentStatus: "cancelled" });
            expect(await h.binding(answered.exchangeId, "I")).toBeNull();
            expect(await h.binding(waiting.exchangeId, "J")).toBeNull();
            const [afterTouch] = await h.q("SELECT last_active_at FROM SCHEMA.sessions WHERE session_id = $1", [run.workflowSessionId]);
            expect(afterTouch).toEqual(before);
            // Every other caller learns nothing, the winner's operation id included.
            await expectCode(h.respond(answered.exchangeId, h.peer, "H", { response: { approved: true } }), "REQUEST_NOT_FOUND");
            await expectCode(h.respond(waiting.exchangeId, h.stranger, "J", { response: { approved: true } }), "REQUEST_NOT_FOUND");
            // A deleted responder learns nothing either, its own winning operation included.
            await h.catalog.softDeleteSession(h.parent);
            await expectCode(h.respond(answered.exchangeId, h.parent, "H", { response: { approved: true } }), "REQUEST_NOT_FOUND");
        } finally { await h.stop(); }
    });

    it("keeps any JSON value of a response exactly, through storage, hashing and replay", { timeout: TIMEOUT }, async () => {
        const h = await requestHarness(getEnv());
        try {
            const run = await h.workflow();
            const special = JSON.parse('{"__proto__":"proto","constructor":"c","":"empty key","nul":"\\u0000","high":"\\ud800","low":"\\udc00","pair":"\\ud83d\\ude00","nested":[[],[null,false],{"a":[1,2]}]}');
            expect(Object.keys(special)).toContain("__proto__");
            const values = [null, false, [], [null, false, [], "\u0000", "\ud800"], special];
            let ordinal = 0;
            for (const value of values) {
                ordinal += 1;
                const { exchangeId } = await h.admit(run, h.parent, { nodeId: "free", ordinal, payload: null });
                const decided = await h.respond(exchangeId, h.parent, `v${ordinal}`, { response: value });
                expect(decided, canonicalJson(value)).toMatchObject({ kind: "accepted", replayed: false, status: "responded",
                    receipt: { resultSha256: jsonSha256({ kind: "response", value }) } });
                const view = await h.store.readRequest(exchangeId);
                expect(canonicalJson(view.response.value)).toBe(canonicalJson(value));
                const [row] = await h.q("SELECT value FROM SCHEMA.workflow_request_responses WHERE exchange_id = $1", [exchangeId]);
                expect(row.value).toBe(canonicalJson(value));
                expect(await h.respond(exchangeId, h.parent, `v${ordinal}`, { response: value })).toMatchObject({ kind: "accepted", replayed: true });
            }
            // A value that differs only by one lone surrogate is another result.
            const { exchangeId } = await h.admit(run, h.parent, { nodeId: "free", ordinal: 99, payload: null });
            await h.respond(exchangeId, h.parent, "s", { response: { text: "\ud800" } });
            expect(await h.respond(exchangeId, h.parent, "s", { response: { text: "\udc00" } })).toMatchObject({ code: "OPERATION_CONFLICT" });
        } finally { await h.stop(); }
    });

    it("binds at most 50 operations per request, keeps known ones replayable, and refuses corrupt combinations", { timeout: TIMEOUT }, async () => {
        const h = await requestHarness(getEnv());
        try {
            const run = await h.workflow();
            const { exchangeId } = await h.admit(run, h.parent);
            const won = await h.respond(exchangeId, h.parent, "op-0", { response: { approved: true } });
            for (let index = 1; index < WORKFLOW_V2_MAX_REQUEST_OPERATIONS; index += 1) {
                await h.respond(exchangeId, h.parent, `op-${index}`, { response: { approved: true } });
            }
            expect(await h.operations(exchangeId)).toBe(WORKFLOW_V2_MAX_REQUEST_OPERATIONS);
            const limited = await expectCode(h.respond(exchangeId, h.parent, "op-new", { response: { approved: false } }), "OPERATION_LIMIT");
            expect(limited.details).toEqual({ limit: WORKFLOW_V2_MAX_REQUEST_OPERATIONS });
            expect(await h.operations(exchangeId)).toBe(WORKFLOW_V2_MAX_REQUEST_OPERATIONS);
            expect(await h.respond(exchangeId, h.parent, "op-0", { response: { approved: true } }))
                .toEqual({ kind: "accepted", replayed: true, receipt: won.receipt, status: "responded" });
            expect(await h.respond(exchangeId, h.parent, "op-49", { response: { approved: true } })).toMatchObject({ kind: "accepted", replayed: true });

            // No default status: a node and a record that do not match fail as store corruption.
            const pending = await h.admit(run, h.parent, { ordinal: 2 });
            await h.q(`UPDATE SCHEMA.workflow_node_executions SET state = 'completed', outcome = 'responded', result_kind = 'business', output = 'null',
                winner = 'response', completed_at = now() WHERE node_execution_id = $1`, [pending.exchangeId]);
            await expectCode(h.store.readRequest(pending.exchangeId), "WORKFLOW_STORE_CORRUPT");
            const other = await h.admit(run, h.parent, { ordinal: 3 });
            await h.q(`UPDATE SCHEMA.workflow_node_executions SET state = 'completed', outcome = 'sent', result_kind = 'business', output = 'null',
                winner = 'controller', completed_at = now() WHERE node_execution_id = $1`, [other.exchangeId]);
            await expectCode(h.store.readRequest(other.exchangeId), "WORKFLOW_STORE_CORRUPT");
            await expectCode(h.respond(other.exchangeId, h.parent, "x", { response: { approved: true } }), "WORKFLOW_STORE_CORRUPT");
        } finally { await h.stop(); }
    });
});

/** The independent review of the store (RQF-1 to RQF-4): each finding's real-store oracle. */
describe("workflow v2 request states: the store's review corrections", () => {
    const X = { approved: true };

    it("keeps a response at the full JSON depth: its identity is hashed from its canonical text (RQF-1)", { timeout: TIMEOUT }, async () => {
        const h = await requestHarness(getEnv());
        try {
            const run = await h.workflow();
            const nest = depth => {
                let value = null;
                for (let level = 0; level < depth; level += 1) value = [value];
                return value;
            };
            // The identity is the sha256 of the exact canonical text {"kind":...,"value":...}, computed here on its own.
            const envelope = (kind, value) => createHash("sha256").update(`{"kind":"${kind}","value":${canonicalJson(value)}}`, "utf8").digest("hex");
            expect(envelope("response", nest(63))).toBe(jsonSha256({ kind: "response", value: nest(63) }));
            expect(kindValueSha256("decline", canonicalJson({ reason: "no" }))).toBe(jsonSha256({ kind: "decline", value: { reason: "no" } }));
            expect(kindValueSha256("response", canonicalJson(nest(64)))).toBe(envelope("response", nest(64)));
            for (const [ordinal, depth] of [[1, 63], [2, 64]]) {
                const value = nest(depth);
                const { exchangeId } = await h.admit(run, h.parent, { nodeId: "free", ordinal, payload: null });
                const decided = await h.respond(exchangeId, h.parent, `deep-${depth}`, { response: value });
                expect(decided, `depth ${depth}`).toMatchObject({ kind: "accepted", replayed: false, status: "responded",
                    receipt: { resultSha256: envelope("response", value) } });
                expect(await h.respond(exchangeId, h.parent, `deep-${depth}`, { response: value }), `depth ${depth}`).toEqual({ ...decided, replayed: true });
                const view = await h.store.readRequest(exchangeId);
                expect(view.response.resultSha256).toBe(envelope("response", value));
                expect(canonicalJson(view.response.value)).toBe(canonicalJson(value));
                expect(view.wake).toMatchObject({ state: "pending" });
            }
            // One level deeper is not a workflow JSON value: refused, and nothing is written.
            const { exchangeId } = await h.admit(run, h.parent, { nodeId: "free", ordinal: 3, payload: null });
            await expectCode(h.respond(exchangeId, h.parent, "deep-65", { response: nest(65) }), "RESPONSE_INVALID");
            expect(await h.store.readRequest(exchangeId)).toMatchObject({ status: "pending", response: null, wake: null, operations: 0 });
            expect(await h.stateCompleted(run.workflowSessionId, exchangeId)).toBe(0);
        } finally { await h.stop(); }
    });

    it("freezes the response schema that the state's contract declares in the pinned definition (RQF-2)", { timeout: TIMEOUT }, async () => {
        const h = await requestHarness(getEnv());
        try {
            const run = await h.workflow();
            // The admission refuses a spec that is not its state's: another schema of the definition, an unknown schema,
            // or a contract that is not the state's. Nothing is stored.
            for (const [ordinal, spec] of [
                [1, { contract: "Approval@1", responseSchema: "Any" }],
                [2, { contract: "Approval@1", responseSchema: "Nope" }],
                [3, { contract: "Free@1", responseSchema: "Any" }],
            ]) {
                const exchangeId = nodeExecutionIdFor(run.runId, "root", "ask", ordinal);
                await expectCode(h.enter(run, h.parent, { ordinal, ...spec }), "WORKFLOW_STORE_CORRUPT");
                expect(await h.store.readNodeExecution(exchangeId), JSON.stringify(spec)).toBeNull();
                expect(await h.store.readOutboxMessage(exchangeId)).toBeNull();
                expect(await h.store.readRequest(exchangeId)).toBeNull();
            }
            // Positive controls: Approval@1 answered against Answer, Free@1 with any JSON, and a strict decline.
            const ask = await h.admit(run, h.parent, { ordinal: 4 });
            expect(await h.store.readRequest(ask.exchangeId)).toMatchObject({ contract: "Approval@1", responseSchema: "Answer" });
            await expectCode(h.respond(ask.exchangeId, h.parent, "bad", { response: null }), "RESPONSE_INVALID");
            expect(await h.respond(ask.exchangeId, h.parent, "ok", { response: X })).toMatchObject({ kind: "accepted", status: "responded" });
            const free = await h.admit(run, h.parent, { nodeId: "free", ordinal: 5, payload: null });
            expect(await h.respond(free.exchangeId, h.parent, "ok", { response: null })).toMatchObject({ kind: "accepted", status: "responded" });
            const declined = await h.admit(run, h.parent, { ordinal: 6 });
            expect(await h.respond(declined.exchangeId, h.parent, "no", { decline: { reason: "not now" } })).toMatchObject({ kind: "accepted", status: "declined" });
            // A committed record whose schema is another schema of the definition decides nothing, for a response or a
            // decline: it is store corruption, never validation against that other schema.
            const tampered = await h.admit(run, h.parent, { ordinal: 7 });
            await h.withoutGuard("workflow_requests", "UPDATE SCHEMA.workflow_requests SET response_schema = 'Any' WHERE exchange_id = $1", [tampered.exchangeId]);
            for (const call of [{ response: null }, { response: X }, { decline: { reason: "no" } }]) {
                await expectCode(h.respond(tampered.exchangeId, h.parent, "t", call), "WORKFLOW_STORE_CORRUPT");
            }
            expect(await h.operations(tampered.exchangeId)).toBe(0);
            expect(await h.store.readNodeExecution(tampered.exchangeId)).toMatchObject({ state: "pending" });
            expect(await h.stateCompleted(run.workflowSessionId, tampered.exchangeId)).toBe(0);
        } finally { await h.stop(); }
    });

    it("refuses a stored request that contradicts itself, on inspection and on every response path (RQF-3)", { timeout: TIMEOUT }, async () => {
        const h = await requestHarness(getEnv());
        try {
            const run = await h.workflow();
            const other = await h.workflow();
            let ordinal = 0;
            const decided = async () => {
                ordinal += 1;
                const { exchangeId } = await h.admit(run, h.parent, { ordinal });
                expect(await h.respond(exchangeId, h.parent, "w", { response: X })).toMatchObject({ kind: "accepted", replayed: false });
                return exchangeId;
            };
            // Committed rows that the store's one transaction never writes: each contradicts one part of a decided request.
            const corruptions = [
                ["no wake intent", id => h.withoutGuard("workflow_response_wakes", "DELETE FROM SCHEMA.workflow_response_wakes WHERE exchange_id = $1", [id])],
                ["a wake intent of another run", id => h.withoutGuard("workflow_response_wakes",
                    "UPDATE SCHEMA.workflow_response_wakes SET run_id = $2 WHERE exchange_id = $1", [id, other.runId])],
                ["a wake intent for another controller", id => h.withoutGuard("workflow_response_wakes",
                    "UPDATE SCHEMA.workflow_response_wakes SET controller_instance_id = controller_instance_id || '-other' WHERE exchange_id = $1", [id])],
                ["no winning binding", id => h.withoutGuard("workflow_request_operations",
                    "DELETE FROM SCHEMA.workflow_request_operations WHERE exchange_id = $1 AND operation_id = 'w'", [id])],
                ["a second winning binding", id => h.q(`INSERT INTO SCHEMA.workflow_request_operations
                        (exchange_id, operation_id, actor_session_id, result_sha256, outcome, status, first_at, last_at)
                    SELECT exchange_id, 'w2', actor_session_id, result_sha256, outcome, status, first_at, last_at
                      FROM SCHEMA.workflow_request_operations WHERE exchange_id = $1 AND operation_id = 'w'`, [id])],
                ["an identity that is not its value's", async id => {
                    const wrong = "0".repeat(64);
                    await h.withoutGuard("workflow_request_responses",
                        "UPDATE SCHEMA.workflow_request_responses SET result_sha256 = $2, receipt = replace(receipt, result_sha256, $2) WHERE exchange_id = $1",
                        [id, wrong]);
                    await h.withoutGuard("workflow_request_operations",
                        "UPDATE SCHEMA.workflow_request_operations SET result_sha256 = $2 WHERE exchange_id = $1", [id, wrong]);
                }],
                ["a node output that is not the response", id => h.q(
                    "UPDATE SCHEMA.workflow_node_executions SET output = 'false' WHERE node_execution_id = $1", [id])],
                ["a node completion that is not the decision's reading", id => h.q(
                    "UPDATE SCHEMA.workflow_node_executions SET completed_at = completed_at + interval '1 microsecond' WHERE node_execution_id = $1", [id])],
                ["a response by another session", id => h.withoutGuard("workflow_request_responses",
                    "UPDATE SCHEMA.workflow_request_responses SET actor_session_id = $2 WHERE exchange_id = $1", [id, h.peer])],
                ["a receipt for another run", id => h.withoutGuard("workflow_request_responses",
                    "UPDATE SCHEMA.workflow_request_responses SET receipt = replace(receipt, $2, $3) WHERE exchange_id = $1", [id, run.runId, other.runId])],
                ["a receipt for another responder", id => h.withoutGuard("workflow_request_responses",
                    "UPDATE SCHEMA.workflow_request_responses SET receipt = replace(receipt, $2, $3) WHERE exchange_id = $1", [id, h.parent, h.peer])],
                ["a record of another run", id => h.withoutGuard("workflow_requests",
                    "UPDATE SCHEMA.workflow_requests SET run_id = $2 WHERE exchange_id = $1", [id, other.runId])],
                ["a record of another workflow", id => h.withoutGuard("workflow_requests",
                    "UPDATE SCHEMA.workflow_requests SET workflow_session_id = $2 WHERE exchange_id = $1", [id, other.workflowSessionId])],
                ["a message intent to another responder", id => h.q(
                    "UPDATE SCHEMA.workflow_outbox SET recipient_session_id = $2 WHERE exchange_id = $1", [id, h.peer])],
            ];
            for (const [name, corruptIt] of corruptions) {
                const exchangeId = await decided();
                await corruptIt(exchangeId);
                const before = { operations: await h.operations(exchangeId), winner: await h.binding(exchangeId, "w") };
                await expectCode(h.store.readRequest(exchangeId), "WORKFLOW_STORE_CORRUPT");
                // The known operation's replay, a new response and a new decline all refuse, and nothing is written.
                await expectCode(h.respond(exchangeId, h.parent, "w", { response: X }), "WORKFLOW_STORE_CORRUPT");
                await expectCode(h.respond(exchangeId, h.parent, "fresh", { response: X }), "WORKFLOW_STORE_CORRUPT");
                await expectCode(h.respond(exchangeId, h.parent, "fresh", { decline: { reason: "no" } }), "WORKFLOW_STORE_CORRUPT");
                expect({ operations: await h.operations(exchangeId), winner: await h.binding(exchangeId, "w") }, name).toEqual(before);
                // Every other caller still learns nothing, corruption included.
                await expectCode(h.respond(exchangeId, h.stranger, "w", { response: X }), "REQUEST_NOT_FOUND");
            }
            // A winning binding without a response, on a request still pending.
            ordinal += 1;
            const pending = await h.admit(run, h.parent, { ordinal });
            await h.q(`INSERT INTO SCHEMA.workflow_request_operations (exchange_id, operation_id, actor_session_id, result_sha256, outcome, status, first_at, last_at)
                VALUES ($1, 'ghost', $2, $3, 'decided', 'responded', clock_timestamp(), clock_timestamp())`,
                [pending.exchangeId, h.parent, kindValueSha256("response", canonicalJson(X))]);
            await expectCode(h.store.readRequest(pending.exchangeId), "WORKFLOW_STORE_CORRUPT");
            await expectCode(h.respond(pending.exchangeId, h.parent, "ghost", { response: X }), "WORKFLOW_STORE_CORRUPT");
            await expectCode(h.respond(pending.exchangeId, h.parent, "fresh", { response: X }), "WORKFLOW_STORE_CORRUPT");
            expect(await h.store.readNodeExecution(pending.exchangeId)).toMatchObject({ state: "pending" });

            // A well-formed decided request still replays after its deadline, its run's end and its requester's deletion,
            // with no second wake intent.
            const ended = await h.workflow();
            const short = await h.admit(ended, h.parent, { timeoutSeconds: 1 });
            const won = await h.respond(short.exchangeId, h.parent, "w", { response: X });
            await new Promise(resolve => setTimeout(resolve, 1_100));
            const replayed = { ...won, replayed: true };
            expect(await h.respond(short.exchangeId, h.parent, "w", { response: X })).toEqual(replayed);
            await h.store.finishRun({ runId: ended.runId, status: "cancelled", terminalNodeId: null, terminalOutcome: null, outputText: null,
                errorText: canonicalJson({ code: "cancelled", message: "cancelled by the test" }), endPending: { winner: "cancel", message: "cancelled by the test" } });
            expect(await h.respond(short.exchangeId, h.parent, "w", { response: X })).toEqual(replayed);
            await h.catalog.softDeleteSession(ended.workflowSessionId);
            expect(await h.respond(short.exchangeId, h.parent, "w", { response: X })).toEqual(replayed);
            expect(await h.store.readRequest(short.exchangeId)).toMatchObject({ status: "responded", response: { receipt: won.receipt }, operations: 1 });
            expect((await h.q("SELECT count(*)::int AS n FROM SCHEMA.workflow_response_wakes WHERE exchange_id = $1", [short.exchangeId]))[0].n).toBe(1);
            // Its one wake intent targets its run's own controller.
            expect(await h.q("SELECT run_id, controller_instance_id FROM SCHEMA.workflow_response_wakes WHERE exchange_id = $1", [short.exchangeId]))
                .toEqual([{ run_id: ended.runId, controller_instance_id: workflowLiveControllerInstanceId(ended.workflowSessionId) }]);
        } finally { await h.stop(); }
    });

    it("answers a known operation only when its binding agrees with the request's state (RQF-3)", { timeout: TIMEOUT }, async () => {
        const h = await requestHarness(getEnv());
        try {
            const Y = { approved: false };
            const sha = value => kindValueSha256("response", canonicalJson(value));
            const run = await h.workflow();
            let ordinal = 0;
            /** A request decided by A with X, B an alias of the winner (same), C another result (conflict). */
            const decided = async () => {
                ordinal += 1;
                const { exchangeId } = await h.admit(run, h.parent, { ordinal });
                const won = await h.respond(exchangeId, h.parent, "A", { response: X });
                expect(await h.respond(exchangeId, h.parent, "B", { response: X })).toEqual({ ...won, replayed: true });
                expect(await h.respond(exchangeId, h.parent, "C", { response: Y })).toMatchObject({ kind: "refused", code: "RESPONSE_CONFLICT", replayed: false });
                expect(await h.binding(exchangeId, "B")).toMatchObject({ outcome: "same", status: "responded" });
                expect(await h.binding(exchangeId, "C")).toMatchObject({ outcome: "conflict", status: "responded" });
                return { exchangeId, won };
            };
            const tamper = (exchangeId, operationId, set, params = []) => h.withoutGuard("workflow_request_operations",
                `UPDATE SCHEMA.workflow_request_operations SET ${set} WHERE exchange_id = $1 AND operation_id = $2`, [exchangeId, operationId, ...params]);
            const bindings = async exchangeId => h.q(
                "SELECT operation_id, result_sha256, outcome, status, count FROM SCHEMA.workflow_request_operations WHERE exchange_id = $1 ORDER BY operation_id",
                [exchangeId]);

            // Controls: intact bindings replay as they were bound.
            const intact = await decided();
            expect(await h.respond(intact.exchangeId, h.parent, "A", { response: X })).toEqual({ ...intact.won, replayed: true });
            expect(await h.respond(intact.exchangeId, h.parent, "B", { response: X })).toEqual({ ...intact.won, replayed: true });
            expect(await h.respond(intact.exchangeId, h.parent, "B", { response: Y })).toMatchObject({ kind: "refused", code: "OPERATION_CONFLICT", replayed: true });
            expect(await h.respond(intact.exchangeId, h.parent, "C", { response: Y })).toMatchObject({ kind: "refused", code: "RESPONSE_CONFLICT", replayed: true });

            // A binding that contradicts the decision never answers, whatever value the call repeats, and nothing is written.
            for (const [name, operationId, set, params] of [
                ["an alias bound to another result (the review's case)", "B", "result_sha256 = $3", [sha(Y)]],
                ["an alias with another status", "B", "status = 'declined'", []],
                ["an alias bound by another session", "B", "actor_session_id = $3", [h.peer]],
                ["a conflict bound to the winner's result", "C", "result_sha256 = $3", [sha(X)]],
                ["a conflict with another status", "C", "status = 'declined'", []],
            ]) {
                const { exchangeId } = await decided();
                await tamper(exchangeId, operationId, set, params);
                const before = await bindings(exchangeId);
                for (const value of [X, Y]) {
                    await expectCode(h.respond(exchangeId, h.parent, operationId, { response: value }), "WORKFLOW_STORE_CORRUPT");
                }
                expect(await bindings(exchangeId), name).toEqual(before);
                // The winner's own replay is not affected by another operation's binding.
                expect(await h.respond(exchangeId, h.parent, "A", { response: X }), name).toMatchObject({ kind: "accepted", replayed: true });
            }

            // Expired and closed bindings: a valid replay answers as it was bound; a contradicting one is corrupt.
            const late = await h.admit(run, h.parent, { ordinal: 90, timeoutSeconds: 1 });
            await new Promise(resolve => setTimeout(resolve, 1_100));
            expect(await h.respond(late.exchangeId, h.parent, "E", { response: X })).toMatchObject({ code: "REQUEST_EXPIRED", replayed: false });
            expect(await h.respond(late.exchangeId, h.parent, "F", { response: X })).toMatchObject({ code: "REQUEST_EXPIRED", replayed: false });
            expect(await h.respond(late.exchangeId, h.parent, "E", { response: X }))
                .toEqual({ kind: "refused", replayed: true, code: "REQUEST_EXPIRED", status: "pending", currentStatus: "pending" });
            await tamper(late.exchangeId, "F", "status = 'responded'");
            await expectCode(h.respond(late.exchangeId, h.parent, "F", { response: X }), "WORKFLOW_STORE_CORRUPT");
            expect(await h.binding(late.exchangeId, "F")).toMatchObject({ count: 1 });
            const ended = await h.workflow();
            const closing = await h.admit(ended, h.parent);
            await h.store.finishRun({ runId: ended.runId, status: "cancelled", terminalNodeId: null, terminalOutcome: null, outputText: null,
                errorText: canonicalJson({ code: "cancelled", message: "cancelled by the test" }), endPending: { winner: "cancel", message: "cancelled by the test" } });
            expect(await h.respond(closing.exchangeId, h.parent, "G", { response: X })).toMatchObject({ code: "REQUEST_CLOSED", status: "cancelled" });
            expect(await h.respond(closing.exchangeId, h.parent, "H", { response: X })).toMatchObject({ code: "REQUEST_CLOSED", status: "cancelled" });
            expect(await h.respond(closing.exchangeId, h.parent, "G", { response: X }))
                .toEqual({ kind: "refused", replayed: true, code: "REQUEST_CLOSED", status: "cancelled", currentStatus: "cancelled" });
            await tamper(closing.exchangeId, "H", "status = 'timed_out'");
            await expectCode(h.respond(closing.exchangeId, h.parent, "H", { response: X }), "WORKFLOW_STORE_CORRUPT");
            expect(await h.binding(closing.exchangeId, "H")).toMatchObject({ count: 1 });
        } finally { await h.stop(); }
    });

    it("refuses every caller but the responder before it reads the operation id or the call (RQF-4)", { timeout: TIMEOUT }, async () => {
        const h = await requestHarness(getEnv());
        try {
            const run = await h.workflow();
            const { exchangeId } = await h.admit(run, h.parent);
            const won = await h.respond(exchangeId, h.parent, "A", { response: X });
            // A responder deleted after it answered its own request.
            const leaving = await h.session(h.alice);
            const leavingRun = await h.workflow(h.alice, leaving);
            const theirs = await h.admit(leavingRun, leaving);
            await h.respond(theirs.exchangeId, leaving, "L", { response: X });
            await h.catalog.softDeleteSession(leaving);

            const badOperationIds = ["", "   ", "x".repeat(257), "a\u0000b", "\ud800", 42, null, undefined];
            const badCalls = [{}, null, [], "response", { response: X, decline: { reason: "no" } }, { response: undefined }, { nonsense: 1 }];
            const unauthorized = [
                [`nx-${"0".repeat(40)}`, h.parent], [exchangeId, h.stranger], [exchangeId, h.peer], [exchangeId, randomUUID()],
                [theirs.exchangeId, leaving],
                // Ids that no stored row can hold.
                [42, h.parent], ["nx-\u0000", h.parent], [exchangeId, null], [exchangeId, "a\u0000"],
            ];
            const observed = async () => {
                const [requester] = await h.q("SELECT last_active_at FROM SCHEMA.sessions WHERE session_id = $1", [run.workflowSessionId]);
                return {
                    operations: [await h.operations(exchangeId), await h.operations(theirs.exchangeId)],
                    bindings: [await h.binding(exchangeId, "A"), await h.binding(theirs.exchangeId, "L")],
                    events: (await h.catalog.getSessionEvents(run.workflowSessionId, 0, 1000)).length,
                    touched: requester.last_active_at,
                };
            };
            const before = await observed();
            for (const [id, actor] of unauthorized) {
                for (const operationId of [...badOperationIds, "A", "L", "fresh"]) {
                    await expectCode(h.respond(id, actor, operationId, { response: X }), "REQUEST_NOT_FOUND");
                }
                for (const call of badCalls) await expectCode(h.respond(id, actor, "A", call), "REQUEST_NOT_FOUND");
            }
            expect(await observed()).toEqual(before);
            // The responder gets the diagnostics meant for it, and nothing is bound.
            for (const operationId of badOperationIds) {
                await expectCode(h.respond(exchangeId, h.parent, operationId, { response: X }), "WORKFLOW_COMMAND_INVALID");
            }
            for (const call of badCalls) await expectCode(h.respond(exchangeId, h.parent, "A", call), "RESPONSE_INVALID");
            expect(await observed()).toEqual(before);
            expect(await h.respond(exchangeId, h.parent, "A", { response: X })).toEqual({ ...won, replayed: true });

            // Authority is decided on the rows as they are now. A named session of the same user is a responder; once that
            // relationship is gone it is refused like any other caller, with its old or a new operation id. The parent stays
            // related through the parent link. A purged requester refuses everyone.
            const named = await h.admit(run, h.peer, { ordinal: 2 });
            const namedWon = await h.respond(named.exchangeId, h.peer, "N", { response: X });
            expect(namedWon).toMatchObject({ kind: "accepted", replayed: false, receipt: { responderSessionId: h.peer } });
            expect(await h.respond(named.exchangeId, h.peer, "N", { response: X })).toEqual({ ...namedWon, replayed: true });
            await h.q("DELETE FROM SCHEMA.session_owners WHERE session_id = $1", [h.peer]);
            for (const operationId of ["N", "N2"]) {
                await expectCode(h.respond(named.exchangeId, h.peer, operationId, { response: X }), "REQUEST_NOT_FOUND");
            }
            await h.q("DELETE FROM SCHEMA.session_owners WHERE session_id = $1", [h.parent]);
            expect(await h.respond(exchangeId, h.parent, "A", { response: X })).toEqual({ ...won, replayed: true });
            await h.q("DELETE FROM SCHEMA.sessions WHERE session_id = $1", [run.workflowSessionId]);
            for (const operationId of ["A", "A2"]) {
                await expectCode(h.respond(exchangeId, h.parent, operationId, { response: X }), "REQUEST_NOT_FOUND");
            }
            expect(await h.binding(exchangeId, "A2")).toBeNull();
        } finally { await h.stop(); }
    });
});

describe("workflow v2 request states: durable expiry (store)", () => {
    // Formal intent model CP1 trace: o1 is bound expired, the store's clock steps back, o2's reading is before the deadline.
    // clock_timestamp() is not monotonic, so the first expired binding, written under the node's lock, is the request's
    // expiry point. Only the deciding reading is injected (requestClock); every lock, guard and write is real PostgreSQL.
    it("keeps a pending request expired once an operation was bound expired, even when the clock steps back", { timeout: TIMEOUT }, async () => {
        const h = await requestFixture(getEnv());
        const YES = { response: { approved: true } };
        const EXPIRED = { kind: "refused", replayed: false, code: "REQUEST_EXPIRED", status: "pending", currentStatus: "pending" };
        try {
            const run = await h.workflow();
            const exchangeId = await h.admit(run);
            let readings = 0;
            const count = () => { readings += 1; };
            // o1: its one deciding reading is the deadline itself (equal is late): expired, nothing decided.
            h.control.hook = requestClock(h, exchangeId, 0, count);
            expect(await h.respond(exchangeId, "o1", YES)).toEqual(EXPIRED);
            // o2 and o3: the clock stepped back one second; each reading is before the deadline, and the request stays expired.
            h.control.hook = requestClock(h, exchangeId, -1_000_000, count);
            expect(await h.respond(exchangeId, "o2", YES)).toEqual(EXPIRED);
            expect(await h.respond(exchangeId, "o3", { decline: { reason: "late" } })).toEqual(EXPIRED);
            h.control.hook = null;
            expect(readings).toBe(3);
            for (const operationId of ["o1", "o2", "o3"]) {
                expect(await h.binding(exchangeId, operationId)).toMatchObject({ outcome: "expired", status: "pending", count: 1 });
            }
            expect(await h.counts(exchangeId)).toEqual({ decisions: 0, responses: 0, wakes: 0, operations: 3, decided: 0, same: 0, conflict: 0 });
            expect(await h.store.readNodeExecution(exchangeId)).toMatchObject({ state: "pending", output: null, winner: null });
            expect(await h.store.readRequest(exchangeId)).toMatchObject({ status: "pending", response: null, wake: null, operations: 3 });
            expect((await h.catalog.getSessionEvents(run.workflowSessionId, 0, 1000))
                .filter(event => event.eventType === "workflow.state_completed" && event.data?.exchangeId === exchangeId)).toHaveLength(0);
            // Known operations replay what they were bound, without a reading; another result is an operation conflict.
            h.control.hook = requestClock(h, exchangeId, -1_000_000, count);
            expect(await h.respond(exchangeId, "o2", YES)).toEqual({ ...EXPIRED, replayed: true });
            expect(await h.respond(exchangeId, "o1", { decline: { reason: "other" } })).toMatchObject({ code: "OPERATION_CONFLICT", replayed: true });
            h.control.hook = null;
            expect(readings).toBe(3);

            // Control: with no expired binding, the same stepped-back reading decides (the one reading still decides), and a
            // later call whose reading is after the deadline finds it decided and gets the winner's receipt.
            const fresh = await h.admit(run, { ordinal: 2 });
            h.control.hook = requestClock(h, fresh, -1_000_000);
            const winner = await h.respond(fresh, "w1", YES);
            expect(winner).toMatchObject({ kind: "accepted", replayed: false, status: "responded" });
            h.control.hook = requestClock(h, fresh, 1);
            expect(await h.respond(fresh, "w2", YES)).toEqual({ kind: "accepted", replayed: true, status: "responded", receipt: winner.receipt });
            h.control.hook = null;
            expect(await h.counts(fresh)).toEqual({ decisions: 1, responses: 1, wakes: 1, operations: 2, decided: 1, same: 1, conflict: 0 });
        } finally {
            h.control.hook = null;
            await h.stop();
        }
    });

    // A-ISO (formal CP6): a response call reads its request before it waits for the requester's lock. Under an inherited
    // REPEATABLE READ default, that first read would fix its snapshot before an expired call commits, and after the wait it would
    // miss the expired binding and decide with its stepped-back reading, with no serialization error (the expired call writes
    // only its binding). The store states READ COMMITTED in its BEGIN, so each statement after the wait reads what was committed.
    it("keeps a request expired for a call that waited on the requester's lock while an expired call committed, at an inherited "
        + "REPEATABLE READ default", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const h = await requestFixture(env);
        const YES = { response: { approved: true } };
        const EXPIRED = { kind: "refused", replayed: false, code: "REQUEST_EXPIRED", status: "pending", currentStatus: "pending" };
        // A private pool whose sessions default to REPEATABLE READ, as a role or database default could make them; ended below.
        const rrPool = new pg.Pool({ connectionString: env.store, max: 2, connectionTimeoutMillis: 10_000, statement_timeout: 15_000,
            lock_timeout: 10_000 });
        const connectRepeatableRead = async () => {
            const client = await rrPool.connect();
            try { await client.query("SET default_transaction_isolation TO 'repeatable read'"); } catch (error) { client.release(error); throw error; }
            return client;
        };
        const rr = { hook: null };
        const rrStore = new WorkflowStore({
            async connect() {
                const client = await connectRepeatableRead();
                const query = (text, params) => client.query(text, params);
                return {
                    query(text, params) {
                        const sql = typeof text === "string" ? text : text.text;
                        return rr.hook ? rr.hook({ sql, params, query, client }) : query(text, params);
                    },
                    release: (...args) => client.release(...args),
                };
            },
            query: (text, params) => rrPool.query(text, params),
        }, env.cmsSchema);
        const settle = promise => promise.then(value => ({ value }), error => ({ error }));
        /** `waiterPid` waits for a lock `holderPid` holds: the lock graph for exactly that pair, read at most 1,000 times, no sleep. */
        const blockedBy = async (waiterPid, holderPid) => {
            for (let attempt = 0; attempt < 1_000; attempt += 1) {
                const [row] = await h.q("SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked", [waiterPid, holderPid]);
                if (row.blocked) return true;
            }
            return false;
        };
        const o1Commit = checkpoint();
        let o1Settled = null;
        let o2Settled = null;
        try {
            // Control: a connection of this pool inherits REPEATABLE READ, and a plain BEGIN runs at it.
            const probe = await connectRepeatableRead();
            try {
                expect((await probe.query("SELECT current_setting('default_transaction_isolation') AS level")).rows[0].level).toBe("repeatable read");
                await probe.query("BEGIN");
                expect((await probe.query("SELECT current_setting('transaction_isolation') AS level")).rows[0].level).toBe("repeatable read");
                await probe.query("ROLLBACK");
            } finally { probe.release(); }

            const run = await h.workflow();
            const exchangeId = await h.admit(run);
            // o1 (the fixture's store): its one reading is the deadline itself, so it is bound expired; its COMMIT is held.
            let o1Pid = null;
            const o1Clock = requestClock(h, exchangeId, 0);
            h.control.hook = async context => {
                if (context.sql === "COMMIT") {
                    o1Pid = context.client.processID;
                    o1Commit.enter();
                    await o1Commit.released;
                }
                return o1Clock(context);
            };
            o1Settled = settle(h.respond(exchangeId, "o1", YES));
            await reachedDuring(o1Commit, o1Settled, "o1's COMMIT");

            // o2 (the REPEATABLE READ pool): it reads the request, then waits for the requester's lock that o1 holds; its one
            // reading is a second before the deadline, as after the clock stepped back.
            let o2Pid = null;
            let o2Isolation = null;
            let readBeforeLock = null;
            let readRequest = false;
            const o2Waits = checkpoint();
            const o2Clock = requestClock(h, exchangeId, -1_000_000);
            rr.hook = async context => {
                o2Pid ??= context.client.processID;
                if (/^BEGIN\b/.test(context.sql)) {
                    const begun = await context.query(context.sql, context.params);
                    o2Isolation = (await context.query("SELECT current_setting('transaction_isolation') AS level")).rows[0].level;
                    return begun;
                }
                if (context.sql.includes(".sessions") && context.sql.includes("FOR NO KEY UPDATE") && readBeforeLock === null) {
                    readBeforeLock = readRequest;
                    o2Waits.enter();
                }
                if (context.sql.includes(".workflow_requests")) readRequest = true;
                return o2Clock(context);
            };
            o2Settled = settle(rrStore.respondToRequest({ exchangeId, actorSessionId: h.parent, operationId: "o2", call: YES }));
            await reachedDuring(o2Waits, o2Settled, "o2's lock on the requester's session");
            expect(await blockedBy(o2Pid, o1Pid)).toBe(true);
            o1Commit.release();
            const [o1, o2] = [await o1Settled, await o2Settled];
            h.control.hook = null;
            rr.hook = null;
            expect(o1.error, o1.error?.message).toBeUndefined();
            expect(o2.error, o2.error?.message).toBeUndefined();
            expect(readBeforeLock).toBe(true);
            expect(o2Isolation).toBe("read committed");
            expect(o1.value).toEqual(EXPIRED);
            expect(o2.value).toEqual(EXPIRED);
            for (const operationId of ["o1", "o2"]) {
                expect(await h.binding(exchangeId, operationId)).toMatchObject({ outcome: "expired", status: "pending", count: 1 });
            }
            expect(await h.counts(exchangeId)).toEqual({ decisions: 0, responses: 0, wakes: 0, operations: 2, decided: 0, same: 0, conflict: 0 });
            expect(await h.store.readNodeExecution(exchangeId)).toMatchObject({ state: "pending", output: null, winner: null });
            expect((await h.catalog.getSessionEvents(run.workflowSessionId, 0, 1000))
                .filter(event => event.eventType === "workflow.state_completed" && event.data?.exchangeId === exchangeId)).toHaveLength(0);

            // Positive control: a fresh request on the same pool, with the same stepped-back reading and no expired binding, decides.
            const fresh = await h.admit(run, { ordinal: 2 });
            rr.hook = requestClock(h, fresh, -1_000_000);
            expect(await rrStore.respondToRequest({ exchangeId: fresh, actorSessionId: h.parent, operationId: "w1", call: YES }))
                .toMatchObject({ kind: "accepted", replayed: false, status: "responded" });
            rr.hook = null;
            expect(await h.counts(fresh)).toEqual({ decisions: 1, responses: 1, wakes: 1, operations: 1, decided: 1, same: 0, conflict: 0 });
        } finally {
            o1Commit.release();
            h.control.hook = null;
            rr.hook = null;
            if (o1Settled) await o1Settled;
            if (o2Settled) await o2Settled;
            await rrPool.end();
            await h.stop();
        }
    });
});
