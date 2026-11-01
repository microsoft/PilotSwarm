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
 * - By default requests are not enabled: a request state or a contract
 *   response is checked field by field and refused, so the definition is
 *   only an invalid draft and is never published or started.
 * - A worker reads IR version 7 only when asked to: by default it refuses it
 *   explicitly, and a version 6 or earlier IR never carries a response or a
 *   request state. IR 1 to 6 compile exactly as before.
 *
 * Nothing here runs a request: the controller, the tool and the delivery
 * are gated (design section 8.4).
 *
 * The store's request records and response transaction (migration 0093),
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
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import {
    compileWorkflowV2, parseWorkflowIr, REQUEST_RESPONSE_SCHEMA_MAX_BYTES, WORKFLOW_V2_REQUEST_IR_VERSION, WORKFLOW_V2_SEND_IR_VERSION,
} from "../../src/workflow/v2/compiler.ts";
import { canonicalJson, jsonSha256 } from "../../src/workflow/v2/json.ts";
import { schemaReferences } from "../../src/workflow/v2/schema.ts";
import { createWorkflowV2, updateWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { describeWorkflowV2State, workflowLiveControllerInstanceId } from "../../src/workflow/v2/runtime.ts";
import {
    nodeExecutionIdFor, WORKFLOW_V2_MAX_REQUEST_OPERATIONS, WORKFLOW_V2_MAX_RESPONSE_BYTES,
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

describe("workflow v2 request states: the definition path refuses them", () => {
    it("keeps a request definition an invalid draft: it is not published or started", { timeout: TIMEOUT }, async () => {
        await withClient(getEnv(), { worker: { workflowScripts: { enabled: true } } }, async (client) => {
            const h = { catalog: client._catalog, store: client._catalog.workflowStore(), duroxideClient: client.duroxideClient };
            const draftId = randomUUID();
            const draft = await createWorkflowV2(h, { workflowSessionId: draftId, parentSessionId: null, yaml: REQUESTER(), actor: ACTOR, operationId: "create" });
            expect(draft.receipt).toMatchObject({ state: "draft", revision: 1, valid: false, run: null });
            await expectCode(updateWorkflowV2(h, draftId, { operation: "publish", expectedRevision: 1, definitionHash: draft.receipt.yamlSha256 },
                { actor: ACTOR, operationId: "publish" }), "DEFINITION_INVALID");
            await expectCode(updateWorkflowV2(h, draftId, { operation: "publish_and_start", expectedRevision: 1, definitionHash: draft.receipt.yamlSha256, inputs: {} },
                { actor: ACTOR, operationId: "publish-start" }), "DEFINITION_INVALID");
            expect(await h.store.listRuns(draftId)).toEqual([]);

            for (const [yaml, request] of [
                [REQUESTER(), { publish: true }],
                [REQUESTER(), { start: { inputs: {} } }],
                [SENDER({ response: `    response: { schema: { $ref: "#/schemas/Answer" } }\n` }), { publish: true }],
            ]) {
                const id = randomUUID();
                await expectCode(createWorkflowV2(h, { workflowSessionId: id, parentSessionId: null, yaml, actor: ACTOR, operationId: "create", ...request }),
                    "DEFINITION_INVALID");
                expect(await h.store.listRuns(id)).toEqual([]);
            }
        });
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
    /** Admit request state `nodeId` (ordinal `ordinal`) of a run to `recipient`. */
    const admit = async (run, recipient, { nodeId = "ask", ordinal = 1, timeoutSeconds = 3600, payload = { q: "ship?" } } = {}) => {
        const node = compiled.ir.nodes[nodeId];
        const nodeExecutionId = nodeExecutionIdFor(run.runId, "root", nodeId, ordinal);
        const admitted = await store.enterNode({
            runId: run.runId, nodeExecutionId, scopeId: "root", nodeId, ordinal, nodeType: "messaging", predecessorId: null, arrivalRoute: null,
            inputText: canonicalJson(payload), kvRevision: 1, waitSeconds: null, immediate: null,
            request: {
                recipient, contract: node.contract, payloadText: canonicalJson(payload), correlationText: "{}",
                refused: { unavailable: refusal("unavailable"), forbidden: refusal("forbidden") },
                timeoutSeconds, responseSchema: compiled.ir.contracts[node.contract].response.schema,
                workflowRecipient: refusal("unsupported_contract"),
            },
        });
        expect(admitted.admitted).toBe(true);
        return { exchangeId: nodeExecutionId, node: admitted.node };
    };
    const respond = (exchangeId, actorSessionId, operationId, call) => store.respondToRequest({ exchangeId, actorSessionId, operationId, call });
    const operations = async (exchangeId) => Number((await q("SELECT count(*)::int AS n FROM SCHEMA.workflow_request_operations WHERE exchange_id = $1",
        [exchangeId]))[0].n);
    const binding = async (exchangeId, operationId) => (await q(
        "SELECT result_sha256, outcome, status, count FROM SCHEMA.workflow_request_operations WHERE exchange_id = $1 AND operation_id = $2",
        [exchangeId, operationId]))[0] ?? null;
    return {
        catalog, store, q, alice, bob, parent, peer, stranger, compiled, session, workflow, admit, respond, operations, binding,
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
