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
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { withClient } from "../helpers/local-workers.js";
import {
    compileWorkflowV2, parseWorkflowIr, REQUEST_RESPONSE_SCHEMA_MAX_BYTES, WORKFLOW_V2_REQUEST_IR_VERSION, WORKFLOW_V2_SEND_IR_VERSION,
} from "../../src/workflow/v2/compiler.ts";
import { canonicalJson } from "../../src/workflow/v2/json.ts";
import { createWorkflowV2, updateWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { describeWorkflowV2State } from "../../src/workflow/v2/runtime.ts";

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

        const responding = `    response: { schema: { $ref: "#/schemas/Answer" } }\n`;
        const sent = compileWorkflowV2(SENDER({ response: responding }), ENABLED);
        expect(sent.valid, JSON.stringify(sent.diagnostics)).toBe(true);
        expect(sent.ir.irVersion).toBe(WORKFLOW_V2_REQUEST_IR_VERSION);
        expect(sent.ir.nodes.tell.mode).toBe("send");
        expect(sent.ir.contracts["Approval@1"]).toEqual({ schema: "Question", response: { schema: "Answer" } });
        const disabled = compileWorkflowV2(SENDER({ response: responding }));
        expect(disabled.valid).toBe(false);
        expect(errorsOf(disabled)).toEqual([expect.objectContaining({ code: "WORKFLOW_FEATURE_UNSUPPORTED", path: "contracts.Approval@1.response" })]);
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
