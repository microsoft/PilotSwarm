/**
 * Workflow: a person sending typed input to a Workflow waiting at a receive step
 * (Gap G8: store.acceptInput trustedPersonSender, service.acceptTypedInput,
 * human-commands.sendWorkflowInputForPerson, and management.sendWorkflowInput)
 * on real PostgreSQL / HorizonDB and the real Duroxide runtime.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PilotSwarmManagementClient } from "../helpers/local-workers.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflow } from "../../src/workflow/compiler.ts";
import { WORKFLOW_HUMAN_INPUT_DENIED } from "../../src/workflow/input-policy.ts";
import { sendWorkflowInputForPerson } from "../../src/workflow/human-commands.ts";
import { createWorkflow, WORKFLOW_INBOX_LIMITS } from "../../src/workflow/service.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { registerWorkflow, WORKFLOW_CONTROLLER_VERSION, workflowLiveControllerInstanceId } from "../../src/workflow/runtime.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { canonicalJson, sha256Hex } from "../../src/workflow/json.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;

const USER_A = { kind: "user", provider: "entra", subject: "user-1" };
const USER_B = { kind: "user", provider: "entra", subject: "user-2" };
const SYSTEM_ACTOR = { kind: "system", name: "workflow-person-send-input-test" };

const DEPLOY_SCHEMAS = `
schemas:
  DeploySignal:
    type: object
    additionalProperties: false
    required: [approvedBy, slot]
    properties:
      approvedBy: { type: string, minLength: 1 }
      slot: { type: string, minLength: 1 }
  CancelSignal:
    type: object
    additionalProperties: false
    required: [reason]
    properties:
      reason: { type: string, minLength: 1 }
contracts:
  DeploySignal@1: { schema: { $ref: "#/schemas/DeploySignal" } }
  CancelSignal@1: { schema: { $ref: "#/schemas/CancelSignal" } }
`;

const OPEN_RECEIVE_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: deploy-receiver, version: "1.0.0" }
inputs: { schema: { type: object, required: [ticketId], properties: { ticketId: { type: string } } } }
initial: await_signal
${DEPLOY_SCHEMAS}
states:
  await_signal:
    type: messaging
    mode: receive
    contract: DeploySignal@1
    correlate: { ticketId: "\${inputs.ticketId}" }
    transition: { next: { received: done } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
`;

const LIST_RECEIVE_AFTER_WAIT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: list-receiver, version: "1.0.0" }
initial: pause_briefly
${DEPLOY_SCHEMAS}
states:
  pause_briefly:
    type: wait
    seconds: 1
    transition: { next: { elapsed: await_any } }
  await_any:
    type: messaging
    mode: receive
    contract: [DeploySignal@1, CancelSignal@1]
    transition: { next: { "DeploySignal@1": done, "CancelSignal@1": done } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
`;

const PARENT_ONLY_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-only, version: "1.0.0" }
initial: await_parent
${DEPLOY_SCHEMAS}
states:
  await_parent:
    type: messaging
    mode: receive
    contract: DeploySignal@1
    from: { parent: true }
    transition: { next: { received: done } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
`;

const MIXED_SENDER_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: mixed-sender, version: "1.0.0" }
initial: first_from_parent
${DEPLOY_SCHEMAS}
states:
  first_from_parent:
    type: messaging
    mode: receive
    contract: DeploySignal@1
    from: { parent: true }
    transition: { next: { received: second_open } }
  second_open:
    type: messaging
    mode: receive
    contract: DeploySignal@1
    transition: { next: { received: done } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
`;

const CHILD_ENDED_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: ended-receiver, version: "1.0.0" }
initial: await_ended
${DEPLOY_SCHEMAS}
states:
  await_ended:
    type: messaging
    mode: receive
    contract: [DeploySignal@1, WorkflowEnded@1]
    transition: { next: { "DeploySignal@1": done, "WorkflowEnded@1": done } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
`;

const AGENT_CONTAINER_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: agent-container, version: "1.0.0" }
initial: step
schemas:
  Out: { type: object, required: [ok], properties: { ok: { type: boolean } }, additionalProperties: false }
states:
  step:
    type: agent
    invoke: { prompt: "work" }
    outputSchema: { $ref: "#/schemas/Out" }
    timeoutSeconds: 3600
    transition: { next: { accepted: done, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  failed: { type: terminal, outcome: failed }
`;

async function until(check, label, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

async function rejectsCode(fn, code) {
    let caught;
    try { await fn(); } catch (err) { caught = err; }
    expect(caught?.code, caught?.message).toBe(code);
    return caught;
}

async function runtimeHarness(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] } });
    registerWorkflow({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store,
        catalog,
        enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("no tools"); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => {},
        deleteSession: async (sessionId) => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
    });
    await runtime.start();
    const host = { catalog, store, duroxideClient: client };
    return {
        catalog, store, client, host,
        async stop() {
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

async function createPublishedRun(catalog, parentSessionId, yaml, { mode = "live", inputsText = "{}" } = {}) {
    const store = catalog.workflowStore();
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    const compiled = compileWorkflow(yaml);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    await catalog.createWorkflowSession(workflowSessionId, {
        parentSessionId, owner: null, creationConfig: { workflow: { requestSha256: "person-send-input" } },
    });
    if (mode === "test") {
        await store.createDefinition({
            workflowSessionId, parentSessionId, notifyParent: false, yaml, compiled, actor: SYSTEM_ACTOR,
            operationId: "create", requestSha256: "person-send-input", publish: false,
            title: `Workflow: ${compiled.name}`, start: null,
        });
        await store.startTest({
            workflowSessionId, expectedRevision: 1, definitionHash: compiled.yamlSha256,
            operationId: "start-test", requestSha256: sha256Hex("start-test"),
            start: {
                runId, mode: "test", controllerInstanceId: `workflow-test-${runId}`,
                inputsText, kvText: "{}", testAgentMode: "mocked",
                controllerVersion: WORKFLOW_CONTROLLER_VERSION, fixturesText: "[]",
            },
        });
        return { workflowSessionId, runId, compiled };
    }
    await store.createDefinition({
        workflowSessionId, parentSessionId, notifyParent: false, yaml, compiled, actor: SYSTEM_ACTOR,
        operationId: "create", requestSha256: "person-send-input", publish: true,
        title: `Workflow: ${compiled.name}`,
        start: {
            runId, mode: "live",
            controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
            inputsText, kvText: "{}", testAgentMode: null,
            controllerVersion: WORKFLOW_CONTROLLER_VERSION,
        },
    });
    return { workflowSessionId, runId, compiled };
}

describe("workflow: person typed input (store, service, human-commands)", () => {
    it("enforces store.acceptInput trustedPersonSender safety invariants", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const store = catalog.workflowStore();
            const parent = randomUUID();
            await catalog.createSession(parent, { owner: { provider: "entra", subject: "user-1" } });
            const { workflowSessionId, runId } = await createPublishedRun(catalog, parent, OPEN_RECEIVE_YAML, {
                inputsText: canonicalJson({ ticketId: "T-0" }),
            });
            const base = {
                workflowSessionId, runId, messageId: randomUUID(), senderSessionId: "person:user:entra:user-1",
                operationId: "op-guard", requestSha256: sha256Hex("x"), contract: "DeploySignal@1",
                correlationText: canonicalJson({ ticketId: "T-0" }),
                payloadText: canonicalJson({ approvedBy: "affan", slot: "prod" }),
                ttlSeconds: 3600, limits: WORKFLOW_INBOX_LIMITS, trustedPersonSender: true,
            };
            await rejectsCode(() => store.acceptInput({ ...base, bypassInboxLimits: true }), "WORKFLOW_STORE_CORRUPT");
            await rejectsCode(() => store.acceptInput({ ...base, sendExchangeId: "ex-1" }), "WORKFLOW_STORE_CORRUPT");
            await rejectsCode(() => store.acceptInput({ ...base, senderSessionId: randomUUID() }), "WORKFLOW_STORE_CORRUPT");
        } finally {
            await catalog.close();
        }
    });

    it("delivers immediate and queued-before-entry person input (including list-receive) and supports idempotent replay", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const h = await runtimeHarness(env);
        try {
            const parent = randomUUID();
            await h.catalog.createSession(parent, { owner: { provider: "entra", subject: "user-1" } });
            // 1. Immediate claim while waiting at correlated receive.
            const created = (await createWorkflow(h.host, {
                workflowSessionId: randomUUID(), parentSessionId: parent, yaml: OPEN_RECEIVE_YAML, actor: SYSTEM_ACTOR,
                operationId: "wf-open-1", publish: true, start: { inputs: { ticketId: "T-1" } },
            })).receipt;
            const wfId = created.workflowSessionId;
            await until(async () => {
                const nodes = await h.store.listNodeExecutions(created.run.runId);
                return nodes.find(n => n.nodeId === "await_signal" && n.state === "pending");
            }, "await_signal pending");

            const receipt = await sendWorkflowInputForPerson({
                contract: "DeploySignal@1",
                payload: { approvedBy: "affan", slot: "westus2" },
                correlation: { ticketId: "T-1" },
                operationId: "op-1",
            }, { host: h.host, workflowSessionId: wfId, actor: USER_A });
            expect(receipt.replayed).toBe(false);
            expect(receipt.workflowId).toBe(wfId);
            expect(receipt.runId).toBe(created.run.runId);
            expect(receipt.senderSessionId).toBe("person:user:entra:user-1");
            expect(receipt.claimedBy).toMatchObject({ stateId: "await_signal" });

            // Replay while active or after run completes returns same receipt with replayed: true.
            const finished = await until(async () => {
                const run = await h.store.readRun(created.run.runId);
                return run?.status === "completed" ? run : null;
            }, "run completed");
            expect(finished.terminalOutcome).toBe("succeeded");
            expect(finished.terminalOutput).toEqual({ approvedBy: "affan", slot: "westus2" });

            const replay = await sendWorkflowInputForPerson({
                contract: "DeploySignal@1",
                payload: { approvedBy: "affan", slot: "westus2" },
                correlation: { ticketId: "T-1" },
                operationId: "op-1",
            }, { host: h.host, workflowSessionId: wfId, actor: USER_A });
            expect(replay).toEqual({ ...receipt, replayed: true });

            // Conflict on same operationId with different payload.
            await rejectsCode(() => sendWorkflowInputForPerson({
                contract: "DeploySignal@1",
                payload: { approvedBy: "other", slot: "westus2" },
                correlation: { ticketId: "T-1" },
                operationId: "op-1",
            }, { host: h.host, workflowSessionId: wfId, actor: USER_A }), "OPERATION_CONFLICT");

            // Non-replay on finished run -> RUN_ENDED (from another user reusing same op-1).
            await rejectsCode(() => sendWorkflowInputForPerson({
                contract: "DeploySignal@1",
                payload: { approvedBy: "bob", slot: "westus2" },
                correlation: { ticketId: "T-1" },
                operationId: "op-1",
            }, { host: h.host, workflowSessionId: wfId, actor: USER_B }), "RUN_ENDED");

            // 2. Queued-before-entry on list-receive produces { contract, from, payload }.
            const listCreated = (await createWorkflow(h.host, {
                workflowSessionId: randomUUID(), parentSessionId: parent, yaml: LIST_RECEIVE_AFTER_WAIT_YAML, actor: SYSTEM_ACTOR,
                operationId: "wf-list-1", publish: true, start: { inputs: {} },
            })).receipt;
            const queued = await sendWorkflowInputForPerson({
                contract: "DeploySignal@1",
                payload: { approvedBy: "affan", slot: "eastus" },
                operationId: "list-op-1",
            }, { host: h.host, workflowSessionId: listCreated.workflowSessionId, actor: USER_A });
            expect(queued.claimedBy).toBeNull();
            expect(queued.senderSessionId).toBe("person:user:entra:user-1");

            // Same operationId from USER_B succeeds independently in its own bucket.
            const queuedB = await sendWorkflowInputForPerson({
                contract: "CancelSignal@1",
                payload: { reason: "backup" },
                operationId: "list-op-1",
            }, { host: h.host, workflowSessionId: listCreated.workflowSessionId, actor: USER_B });
            expect(queuedB.replayed).toBe(false);
            expect(queuedB.senderSessionId).toBe("person:user:entra:user-2");

            const listDone = await until(async () => {
                const run = await h.store.readRun(listCreated.run.runId);
                return run?.status === "completed" ? run : null;
            }, "list-receive run completed");
            expect(listDone.terminalOutcome).toBe("succeeded");
            expect(listDone.terminalOutput).toEqual({
                contract: "DeploySignal@1",
                from: "person:user:entra:user-1",
                payload: { approvedBy: "affan", slot: "eastus" },
            });
        } finally {
            await h.stop();
        }
    });

    it("enforces open-sender receive check (S6) and prevents receive.from spoofing", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const store = catalog.workflowStore();
            const host = { catalog, store, duroxideClient: { enqueueEvent: async () => {} } };
            const parent = randomUUID();
            await catalog.createSession(parent, { owner: { provider: "entra", subject: "user-1" } });

            // Contract only on from: parent receive -> 409 UNSUPPORTED_CONTRACT.
            const parentOnly = await createPublishedRun(catalog, parent, PARENT_ONLY_YAML);
            const err = await rejectsCode(() => sendWorkflowInputForPerson({
                contract: "DeploySignal@1",
                payload: { approvedBy: "affan", slot: "prod" },
                operationId: "po-1",
            }, { host, workflowSessionId: parentOnly.workflowSessionId, actor: USER_A }), "UNSUPPORTED_CONTRACT");
            expect(err.details).toEqual({ receives: [] });

            // Mixed: state 1 has from: parent, state 2 is open. Person cannot claim state 1, claims state 2 when entered.
            const mixed = await createPublishedRun(catalog, parent, MIXED_SENDER_YAML);
            const exec1 = nodeExecutionIdFor(mixed.runId, "root", "first_from_parent", 1);
            const refusedSpec = {
                forbidden: { result: { outcome: "forbidden", resultKind: "runtime_error", errorText: "{}" } },
                unavailable: { result: { outcome: "unavailable", resultKind: "runtime_error", errorText: "{}" } },
            };
            await store.enterNode({
                runId: mixed.runId, nodeExecutionId: exec1, scopeId: "root", nodeId: "first_from_parent", ordinal: 1,
                nodeType: "messaging", predecessorId: null, arrivalRoute: null, inputText: "null", kvRevision: 1,
                waitSeconds: null, immediate: null,
                receive: { contract: "DeploySignal@1", from: parent, correlationText: "{}", refused: refusedSpec },
            });
            const personSent = await sendWorkflowInputForPerson({
                contract: "DeploySignal@1",
                payload: { approvedBy: "affan", slot: "open-slot" },
                operationId: "mix-1",
            }, { host, workflowSessionId: mixed.workflowSessionId, actor: USER_A });
            expect(personSent.claimedBy).toBeNull();

            // Entering state 2 (open receive) claims the queued person message.
            const exec2 = nodeExecutionIdFor(mixed.runId, "root", "second_open", 2);
            const entered2 = await store.enterNode({
                runId: mixed.runId, nodeExecutionId: exec2, scopeId: "root", nodeId: "second_open", ordinal: 2,
                nodeType: "messaging", predecessorId: exec1, arrivalRoute: "received", inputText: "null", kvRevision: 1,
                waitSeconds: null, immediate: null,
                receive: { contract: "DeploySignal@1", from: null, correlationText: "{}", refused: null },
            });
            expect(entered2.admitted).toBe(true);
            expect(entered2.node.state).toBe("completed");
            expect(entered2.node.output).toEqual({ approvedBy: "affan", slot: "open-slot" });
        } finally {
            await catalog.close();
        }
    });

    it("handles concurrent person send vs receive entry and vs soft delete cleanly without deadlock", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const store = catalog.workflowStore();
            const host = { catalog, store, duroxideClient: { enqueueEvent: async () => {} } };
            const parent = randomUUID();
            await catalog.createSession(parent, { owner: { provider: "entra", subject: "user-1" } });

            // Race 1: person send vs enterNode(receive) — message claimed exactly once.
            const wf1 = await createPublishedRun(catalog, parent, OPEN_RECEIVE_YAML, {
                inputsText: canonicalJson({ ticketId: "RACE-1" }),
            });
            const exec1 = nodeExecutionIdFor(wf1.runId, "root", "await_signal", 1);
            const [sent, entered] = await Promise.all([
                sendWorkflowInputForPerson({
                    contract: "DeploySignal@1",
                    payload: { approvedBy: "affan", slot: "race" },
                    correlation: { ticketId: "RACE-1" },
                    operationId: "race-op-1",
                }, { host, workflowSessionId: wf1.workflowSessionId, actor: USER_A }),
                store.enterNode({
                    runId: wf1.runId, nodeExecutionId: exec1, scopeId: "root", nodeId: "await_signal", ordinal: 1,
                    nodeType: "messaging", predecessorId: null, arrivalRoute: null, inputText: "null", kvRevision: 1,
                    waitSeconds: null, immediate: null,
                    receive: { contract: "DeploySignal@1", from: null, correlationText: canonicalJson({ ticketId: "RACE-1" }), refused: null },
                }),
            ]);
            const inbox = await store.listInbox(wf1.runId);
            expect(inbox).toHaveLength(1);
            expect(inbox[0].consumedBy).toBe(exec1);
            const nodes = await store.listNodeExecutions(wf1.runId);
            expect(nodes).toHaveLength(1);
            expect(nodes[0].state).toBe("completed");
            // Exactly one side performed the claim (either acceptInput claimed pending node, or enterNode claimed queued row).
            const claimedAtSend = sent.claimedBy !== null;
            const claimedAtEnter = entered.node.state === "completed";
            expect(claimedAtSend !== claimedAtEnter).toBe(true);

            // Race 2: person send vs soft delete — resolves cleanly with either receipt or 404/WORKFLOW_DELETED.
            const wf2 = await createPublishedRun(catalog, parent, OPEN_RECEIVE_YAML, {
                inputsText: canonicalJson({ ticketId: "RACE-2" }),
            });
            const [sendOutcome] = await Promise.allSettled([
                sendWorkflowInputForPerson({
                    contract: "DeploySignal@1",
                    payload: { approvedBy: "affan", slot: "del" },
                    correlation: { ticketId: "RACE-2" },
                    operationId: "race-del-1",
                }, { host, workflowSessionId: wf2.workflowSessionId, actor: USER_A }),
                catalog.softDeleteSession(wf2.workflowSessionId),
            ]);
            if (sendOutcome.status === "rejected") {
                expect(["WORKFLOW_NOT_FOUND", "WORKFLOW_DELETED"]).toContain(sendOutcome.reason?.code);
            } else {
                expect(sendOutcome.value.workflowId).toBe(wf2.workflowSessionId);
            }
        } finally {
            await catalog.close();
        }
    });

    it("enforces engine error codes (M2), SF-5 test-run hiding, agent subtree denial, originatingSessionId refusal, and inbox limits", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        try {
            const store = catalog.workflowStore();
            const baseHost = { catalog, store, duroxideClient: { enqueueEvent: async () => {} } };
            const parent = randomUUID();
            await catalog.createSession(parent, { owner: { provider: "entra", subject: "user-1" } });

            const wf = await createPublishedRun(catalog, parent, CHILD_ENDED_YAML);
            const send = (input, opts = {}) => sendWorkflowInputForPerson(input, {
                host: opts.host ?? baseHost,
                workflowSessionId: opts.workflowSessionId ?? wf.workflowSessionId,
                actor: opts.actor ?? USER_A,
                originatingSessionId: opts.originatingSessionId,
            });

            // Agent actor & originatingSessionId -> FORBIDDEN.
            await rejectsCode(() => send({ contract: "DeploySignal@1", payload: { approvedBy: "a", slot: "b" }, operationId: "f-1" },
                { actor: { kind: "agent", sessionId: parent } }), "FORBIDDEN");
            await rejectsCode(() => send({ contract: "DeploySignal@1", payload: { approvedBy: "a", slot: "b" }, operationId: "f-2" },
                { originatingSessionId: parent }), "FORBIDDEN");

            // ttlSeconds / correlation -> WORKFLOW_COMMAND_INVALID.
            await rejectsCode(() => send({ contract: "DeploySignal@1", payload: { approvedBy: "a", slot: "b" }, operationId: "e-1", ttlSeconds: 0 }), "WORKFLOW_COMMAND_INVALID");
            await rejectsCode(() => send({ contract: "DeploySignal@1", payload: { approvedBy: "a", slot: "b" }, operationId: "e-2", ttlSeconds: 86401 }), "WORKFLOW_COMMAND_INVALID");
            await rejectsCode(() => send({ contract: "DeploySignal@1", payload: { approvedBy: "a", slot: "b" }, operationId: "e-3", correlation: ["bad"] }), "WORKFLOW_COMMAND_INVALID");
            await rejectsCode(() => send({ contract: "DeploySignal@1", payload: { approvedBy: "a", slot: "b" }, operationId: "e-4", correlation: { big: "x".repeat(5000) } }), "WORKFLOW_COMMAND_INVALID");

            // Schema mismatch / >256 KiB / >64 depth -> INPUT_INVALID.
            await rejectsCode(() => send({ contract: "DeploySignal@1", payload: { wrong: 1 }, operationId: "i-1" }), "INPUT_INVALID");
            await rejectsCode(() => send({ contract: "DeploySignal@1", payload: { approvedBy: "a", slot: "x".repeat(270_000) }, operationId: "i-2" }), "INPUT_INVALID");
            let deep = { approvedBy: "a", slot: "b" };
            for (let i = 0; i < 66; i += 1) deep = { nested: deep };
            await rejectsCode(() => send({ contract: "DeploySignal@1", payload: deep, operationId: "i-3" }), "INPUT_INVALID");

            // Undeclared contract & WorkflowEnded@1 on live run -> UNSUPPORTED_CONTRACT.
            await rejectsCode(() => send({ contract: "NoSuch@1", payload: {}, operationId: "u-1" }), "UNSUPPORTED_CONTRACT");
            const endedErr = await rejectsCode(() => send({ contract: "WorkflowEnded@1", payload: {}, operationId: "u-2" }), "UNSUPPORTED_CONTRACT");
            expect(endedErr.details).toEqual({ receives: ["DeploySignal@1"] });

            // SF-5 test-run hiding: hidden when testMode is off, reachable when testMode is on.
            const testWf = await createPublishedRun(catalog, parent, OPEN_RECEIVE_YAML, {
                mode: "test", inputsText: canonicalJson({ ticketId: "T-TEST" }),
            });
            await rejectsCode(() => send({
                contract: "DeploySignal@1", payload: { approvedBy: "a", slot: "b" },
                correlation: { ticketId: "T-TEST" }, operationId: "t-off", runId: testWf.runId,
            }, { workflowSessionId: testWf.workflowSessionId, host: { ...baseHost, testMode: false } }), "RUN_NOT_FOUND");
            const testReceipt = await send({
                contract: "DeploySignal@1", payload: { approvedBy: "a", slot: "b" },
                correlation: { ticketId: "T-TEST" }, operationId: "t-on", runId: testWf.runId,
            }, { workflowSessionId: testWf.workflowSessionId, host: { ...baseHost, testMode: true } });
            expect(testReceipt.runId).toBe(testWf.runId);

            // Agent-controlled child Workflow -> 403 WORKFLOW_HUMAN_INPUT_DENIED with details.controllingSessionId.
            const container = await createPublishedRun(catalog, parent, AGENT_CONTAINER_YAML);
            const agentChild = randomUUID();
            const agentNodeExecId = nodeExecutionIdFor(container.runId, "root", "step", 1);
            await store.enterNode({
                runId: container.runId, nodeExecutionId: agentNodeExecId, scopeId: "root", nodeId: "step", ordinal: 1,
                nodeType: "agent", predecessorId: null, arrivalRoute: null, inputText: "null", kvRevision: 1,
                waitSeconds: null, immediate: null,
                agent: { childSessionId: agentChild, controllingSessionId: parent, task: { source: "prompt", prompt: "work" },
                    outcomes: ["accepted"], outputSchema: "Out", timeoutSeconds: 3600 },
            });
            await catalog.createSession(agentChild, { parentSessionId: container.workflowSessionId });
            const nestedWf = await createPublishedRun(catalog, agentChild, OPEN_RECEIVE_YAML, {
                inputsText: canonicalJson({ ticketId: "NESTED" }),
            });
            const denied = await rejectsCode(() => send({
                contract: "DeploySignal@1", payload: { approvedBy: "a", slot: "b" },
                correlation: { ticketId: "NESTED" }, operationId: "nested-1",
            }, { workflowSessionId: nestedWf.workflowSessionId }), WORKFLOW_HUMAN_INPUT_DENIED);
            expect(denied.details).toMatchObject({ controllingSessionId: parent, workflowSessionId: container.workflowSessionId });

            // 21st unconsumed message from same user -> INBOX_FULL.
            for (let i = 1; i <= 20; i += 1) {
                const r = await send({ contract: "DeploySignal@1", payload: { approvedBy: "a", slot: `s-${i}` }, operationId: `cap-${i}` });
                expect(r.replayed).toBe(false);
            }
            await rejectsCode(() => send({ contract: "DeploySignal@1", payload: { approvedBy: "a", slot: "s-21" }, operationId: "cap-21" }), "INBOX_FULL");
        } finally {
            await catalog.close();
        }
    });

    it("exposes PilotSwarmManagementClient.sendWorkflowInput with HTTP statuses and exposeDetails on refusals", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const plain = new PilotSwarmManagementClient({
            store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema, workflowCommands: null,
        });
        const mgmt = new PilotSwarmManagementClient({
            store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema, workflowCommands: {},
        });
        await plain.start();
        await mgmt.start();
        try {
            const store = catalog.workflowStore();
            const parent = randomUUID();
            await catalog.createSession(parent, { owner: { provider: "entra", subject: "user-1" } });
            const wf = await createPublishedRun(catalog, parent, OPEN_RECEIVE_YAML, {
                inputsText: canonicalJson({ ticketId: "MGMT-1" }),
            });

            // Commands disabled -> 501 WORKFLOW_COMMANDS_UNAVAILABLE with expose: true.
            const unavail = await rejectsCode(() => plain.sendWorkflowInput(wf.workflowSessionId, {
                contract: "DeploySignal@1", payload: { approvedBy: "a", slot: "b" }, operationId: "m-0",
            }), "WORKFLOW_COMMANDS_UNAVAILABLE");
            expect(unavail.status).toBe(501);
            expect(unavail.expose).toBe(true);

            // Commands enabled -> delivers as person:user:entra:user-1 and returns receipt.
            const receipt = await mgmt.sendWorkflowInput(wf.workflowSessionId, {
                contract: "DeploySignal@1", payload: { approvedBy: "affan", slot: "prod" },
                correlation: { ticketId: "MGMT-1" }, operationId: "m-1",
            }, { principal: { provider: "entra", subject: "user-1" } });
            expect(receipt.replayed).toBe(false);
            expect(receipt.senderSessionId).toBe("person:user:entra:user-1");

            // UNSUPPORTED_CONTRACT carries status 409, exposeDetails: true, details.receives.
            const unsupported = await rejectsCode(() => mgmt.sendWorkflowInput(wf.workflowSessionId, {
                contract: "Missing@1", payload: {}, operationId: "m-2",
            }), "UNSUPPORTED_CONTRACT");
            expect(unsupported.status).toBe(409);
            expect(unsupported.exposeDetails).toBe(true);
            expect(unsupported.details).toEqual({ receives: ["DeploySignal@1"] });

            // INPUT_INVALID carries status 400, exposeDetails: true, schema details.
            const invalid = await rejectsCode(() => mgmt.sendWorkflowInput(wf.workflowSessionId, {
                contract: "DeploySignal@1", payload: { bad: true }, operationId: "m-3",
            }), "INPUT_INVALID");
            expect(invalid.status).toBe(400);
            expect(invalid.exposeDetails).toBe(true);
            expect(Array.isArray(invalid.details)).toBe(true);

            // Agent-controlled child Workflow -> 403 WORKFLOW_HUMAN_INPUT_DENIED with exposeDetails: true and controllingSessionId.
            const container = await createPublishedRun(catalog, parent, AGENT_CONTAINER_YAML);
            const agentChild = randomUUID();
            const agentNodeExecId = nodeExecutionIdFor(container.runId, "root", "step", 1);
            await store.enterNode({
                runId: container.runId, nodeExecutionId: agentNodeExecId, scopeId: "root", nodeId: "step", ordinal: 1,
                nodeType: "agent", predecessorId: null, arrivalRoute: null, inputText: "null", kvRevision: 1,
                waitSeconds: null, immediate: null,
                agent: { childSessionId: agentChild, controllingSessionId: parent, task: { source: "prompt", prompt: "work" },
                    outcomes: ["accepted"], outputSchema: "Out", timeoutSeconds: 3600 },
            });
            await catalog.createSession(agentChild, { parentSessionId: container.workflowSessionId });
            const nestedWf = await createPublishedRun(catalog, agentChild, OPEN_RECEIVE_YAML, {
                inputsText: canonicalJson({ ticketId: "MGMT-NESTED" }),
            });
            const denied = await rejectsCode(() => mgmt.sendWorkflowInput(nestedWf.workflowSessionId, {
                contract: "DeploySignal@1", payload: { approvedBy: "a", slot: "b" }, operationId: "m-4",
            }, { principal: { provider: "entra", subject: "user-1" } }), WORKFLOW_HUMAN_INPUT_DENIED);
            expect(denied.status).toBe(403);
            expect(denied.exposeDetails).toBe(true);
            expect(denied.details).toMatchObject({ controllingSessionId: parent });

            // originatingSessionId -> 403 FORBIDDEN.
            const fromAgent = await rejectsCode(() => mgmt.sendWorkflowInput(wf.workflowSessionId, {
                contract: "DeploySignal@1", payload: { approvedBy: "a", slot: "b" }, operationId: "m-5",
            }, { originatingSessionId: parent }), "FORBIDDEN");
            expect(fromAgent.status).toBe(403);
        } finally {
            await plain.stop();
            await mgmt.stop();
            await catalog.close();
        }
    });
});
