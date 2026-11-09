/**
 * Workflow v2 request states, the inactive request runtime (design
 * docs/proposals/workflow-messaging-request.md sections 4, 5 and 8; decisions
 * request-runtime-inactive-phase and request-durable-expiry-semantics):
 *
 * - the store transactions of a request's deadline (durable expiry), its
 *   responder's observation, its delivery and its response wakes (lease,
 *   token-guarded settlement, backoff, abandonment with one event), on real
 *   PostgreSQL;
 * - controller 1.9.0 on a native duroxide runtime registered with the
 *   test-only option workflowRequests and a worker tag filter that declares
 *   the workflow-request capability: a request to the parent answered,
 *   declined or left to time out, and a responder without the response
 *   capability. The responder is a test double (an inbox orchestration);
 *   the test answers through the real respond_session_request tool function
 *   and wake dispatcher. No model runs;
 * - the registrations with and without the option.
 *
 * Not an activation, a routing proof against an older worker, or a model
 * qualification.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { canonicalJson } from "../../src/workflow/v2/json.ts";
import { createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import {
    registerWorkflowV2, sessionQueueTransport, WORKFLOW_V2_ACTIVITIES, WORKFLOW_V2_CONTROLLER_NAME, WORKFLOW_V2_REQUEST_ACTIVITIES,
    WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, WORKFLOW_V2_REQUEST_NAME, workflowLiveControllerInstanceId, workflowRequestClientMessageId,
} from "../../src/workflow/v2/runtime.ts";
import { RESPOND_SESSION_REQUEST_TOOL, respondSessionRequestFromTool, WorkflowResponseWakeDispatcher } from "../../src/workflow/v2/request-service.ts";
import { WORKFLOW_V2_WAKE_MAX_ATTEMPTS } from "../../src/workflow/v2/store.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { REQUEST_TIMEOUT, requestClock, requestFixture } from "../helpers/workflow-v2-request-fixture.js";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const ACTOR = { kind: "system", name: "workflow-v2-request-runtime-test" };

const runtimeError = (code, winner = "controller") => ({
    outcome: code, resultKind: "runtime_error", valueText: canonicalJson({ code, message: code }), winner,
});
const refusal = code => ({ result: runtimeError(code) });
const REFUSED = { unavailable: refusal("unavailable"), forbidden: refusal("forbidden") };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await pause(50);
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

// ─── The store's request runtime transactions ────────────────

describe("workflow v2 request runtime: the store", () => {
    it("elapses a request as timed_out only at or after its deadline, or once an operation was bound expired (durable expiry)", { timeout: REQUEST_TIMEOUT }, async () => {
        const h = await requestFixture(getEnv());
        try {
            const timedOut = runtimeError("timed_out");
            const id = await h.admit(await h.workflow(), { timeoutSeconds: 3600 });
            // Before the deadline nothing changes, and the time left is the store's.
            const early = await h.store.elapseRequest(id, timedOut);
            expect(early.result).toBe("not_due");
            expect(early.remainingMs).toBeGreaterThan(3_500_000);
            // A response whose one reading is at the deadline (equal is late) binds the operation expired...
            h.control.hook = requestClock(h, id, 0);
            const late = await h.respond(id, "op-late", { response: { approved: true } });
            h.control.hook = null;
            expect(late).toMatchObject({ kind: "refused", code: "REQUEST_EXPIRED", status: "pending" });
            // ...so the elapse decides now, though the store's own clock is an hour before the deadline; its completed_at is
            // its actual reading.
            const elapsed = await h.store.elapseRequest(id, timedOut);
            expect(elapsed.result).toBe("elapsed");
            expect(elapsed.node).toMatchObject({ state: "completed", outcome: "timed_out", resultKind: "runtime_error", winner: "controller" });
            const [times] = await h.q(`SELECT node.completed_at < request.deadline_at AS before FROM SCHEMA.workflow_node_executions node
                JOIN SCHEMA.workflow_requests request ON request.exchange_id = node.node_execution_id WHERE node.node_execution_id = $1`, [id]);
            expect(times.before).toBe(true);
            expect((await h.store.readRequest(id)).status).toBe("timed_out");
            expect((await h.store.elapseRequest(id, timedOut)).result).toBe("decided");
            // Only timed_out decided by the controller.
            await expect(h.store.elapseRequest(id, { ...timedOut, winner: "delivery" })).rejects.toMatchObject({ code: "WORKFLOW_STORE_CORRUPT" });
            // On the store's clock, a request whose deadline passed elapses; elapseWait never decides a request.
            const due = await h.admit(await h.workflow(), { timeoutSeconds: 1 });
            const other = await h.admit(await h.workflow(), { timeoutSeconds: 1 });
            await pause(1_200);
            await expect(h.store.elapseWait(other)).rejects.toMatchObject({ code: "WORKFLOW_STORE_CORRUPT" });
            expect((await h.store.readNodeExecution(other)).state).toBe("pending");
            expect(await h.store.elapseRequest(due, timedOut)).toMatchObject({ result: "elapsed", node: { outcome: "timed_out" } });
        } finally {
            await h.stop();
        }
    });

    it("observes a waiting request's responder under the session locks: ended or deleted fails it, only before its deadline and any expired binding", { timeout: REQUEST_TIMEOUT }, async () => {
        const h = await requestFixture(getEnv());
        try {
            const results = { refused: REFUSED, ended: null };
            // A live, allowed responder: nothing changes.
            const id = await h.admit(await h.workflow());
            expect(await h.store.observeRequestResponder(id, results)).toMatchObject({ result: "live", node: { state: "pending" } });
            // Its session orchestration found ended: the request fails with that result, winner controller; decided stays.
            expect(await h.store.observeRequestResponder(id, { ...results, ended: refusal("unavailable") }))
                .toMatchObject({ result: "failed", node: { state: "completed", outcome: "unavailable", winner: "controller" } });
            expect((await h.store.readRequest(id)).status).toBe("failed");
            expect((await h.store.observeRequestResponder(id, { ...results, ended: refusal("unavailable") })).result).toBe("decided");
            // A deleted responder (a peer of the same user): unavailable, decided under the locks.
            const peer = randomUUID();
            await h.catalog.createSession(peer, { owner: h.owner });
            const entry = h.entry(await h.workflow());
            entry.request = { ...entry.request, recipient: peer };
            expect(await h.store.enterNode(entry)).toMatchObject({ admitted: true, node: { state: "pending" } });
            await h.catalog.softDeleteSession(peer);
            expect(await h.store.observeRequestResponder(entry.nodeExecutionId, results))
                .toMatchObject({ result: "failed", node: { outcome: "unavailable" } });
            // After an expired binding, only the elapse decides: the observation changes nothing.
            const expired = await h.admit(await h.workflow());
            h.control.hook = requestClock(h, expired, 0);
            expect(await h.respond(expired, "op-late", { response: { approved: true } })).toMatchObject({ code: "REQUEST_EXPIRED" });
            h.control.hook = null;
            expect(await h.store.observeRequestResponder(expired, { ...results, ended: refusal("unavailable") }))
                .toMatchObject({ result: "expired", node: { state: "pending" } });
        } finally {
            await h.stop();
        }
    });

    it("delivers a request once per attempt, records the delivery without deciding it, and fails it only while it is pending", { timeout: REQUEST_TIMEOUT }, async () => {
        const h = await requestFixture(getEnv());
        try {
            const refusals = { refused: REFUSED, ended: null, unsupported: null };
            const record = (run, id) => h.store.recordRequestDelivery(id, { stateId: "ask", clientMessageId: `cm-${id}` }, receipt => ({
                sessionId: run.workflowSessionId, events: [{ eventType: "workflow.request_delivered", data: { exchangeId: receipt.exchangeId } }],
            }));
            const run = await h.workflow();
            const id = await h.admit(run);
            expect(await h.store.beginRequestDelivery(id, refusals))
                .toMatchObject({ kind: "deliver", node: { state: "pending" }, message: { mode: "request", attempts: 1, state: "pending" } });
            expect(await record(run, id)).toMatchObject({ recorded: true, node: { state: "pending" }, message: { state: "delivered" } });
            expect((await record(run, id)).recorded).toBe(false);
            expect((await h.store.beginRequestDelivery(id, refusals)).kind).toBe("decided");
            // A delivery recorded first keeps the message, and the request stays pending.
            expect(await h.store.failRequestDelivery(id, runtimeError("delivery_failed", "delivery")))
                .toMatchObject({ won: false, node: { state: "pending" }, message: { state: "delivered" } });
            // A responder without the response capability fails the request at the attempt, and its message with it.
            const unsupported = await h.admit(await h.workflow());
            expect(await h.store.beginRequestDelivery(unsupported, { ...refusals, unsupported: refusal("unsupported_contract") }))
                .toMatchObject({ kind: "refused", node: { outcome: "unsupported_contract" }, message: { state: "failed" } });
            // Every attempt failed while pending: delivery_failed.
            const failed = await h.admit(await h.workflow());
            expect(await h.store.failRequestDelivery(failed, runtimeError("delivery_failed", "delivery")))
                .toMatchObject({ won: true, node: { outcome: "delivery_failed", winner: "delivery" }, message: { state: "failed" } });
            // A response before the delivery record is valid; the record then marks only the message.
            const fourthRun = await h.workflow();
            const fourth = await h.admit(fourthRun);
            expect((await h.store.beginRequestDelivery(fourth, refusals)).kind).toBe("deliver");
            expect(await h.respond(fourth, "op-1", { response: { approved: true } })).toMatchObject({ kind: "accepted" });
            expect(await record(fourthRun, fourth)).toMatchObject({ recorded: true, node: { outcome: "responded" }, message: { state: "delivered" } });
            // A send's transactions refuse a request, and the request's refuse a send.
            await expect(h.store.recordDelivery(fourth, { stateId: "ask", clientMessageId: "x", input: null }, () => ({ sessionId: fourthRun.workflowSessionId })))
                .rejects.toMatchObject({ code: "WORKFLOW_STORE_CORRUPT" });
        } finally {
            await h.stop();
        }
    });

    it("leases a response's wake to one holder at a time, settles it only by that holder's token, backs off a retry, and never changes a settled wake", { timeout: REQUEST_TIMEOUT }, async () => {
        const h = await requestFixture(getEnv());
        try {
            const id = await h.admit(await h.workflow());
            expect(await h.respond(id, "op-1", { response: { approved: true } })).toMatchObject({ kind: "accepted" });
            const wake = async () => (await h.q(`SELECT state, lease_token, attempts, last_error, next_attempt_at > clock_timestamp() AS later
                FROM SCHEMA.workflow_response_wakes WHERE exchange_id = $1`, [id]))[0];
            const [first] = await h.store.leaseResponseWakes({ limit: 1, exchangeId: id });
            expect(first).toMatchObject({ exchangeId: id, attempts: 1 });
            expect(await h.store.leaseResponseWakes({ limit: 1, exchangeId: id })).toEqual([]);
            expect(await h.store.settleResponseWake(id, "not-the-token", { kind: "dispatched" })).toEqual({ settled: false });
            // A retry: pending again, due after its backoff, with the error kept.
            expect(await h.store.settleResponseWake(id, first.leaseToken, { kind: "retry", error: "the enqueue failed" })).toEqual({ settled: true });
            expect(await wake()).toMatchObject({ state: "pending", lease_token: null, attempts: 1, last_error: "the enqueue failed", later: true });
            expect(await h.store.leaseResponseWakes({ limit: 1, exchangeId: id })).toEqual([]);
            // Due again: a second lease; its holder stalls past its lease, another reclaims, and the stale holder changes nothing.
            await h.q("UPDATE SCHEMA.workflow_response_wakes SET next_attempt_at = clock_timestamp() WHERE exchange_id = $1", [id]);
            const [second] = await h.store.leaseResponseWakes({ limit: 1, exchangeId: id });
            expect(second.attempts).toBe(2);
            await h.q("UPDATE SCHEMA.workflow_response_wakes SET lease_until = clock_timestamp() - interval '1 second' WHERE exchange_id = $1", [id]);
            const [third] = await h.store.leaseResponseWakes({ limit: 1, exchangeId: id });
            expect(third.attempts).toBe(3);
            expect(third.leaseToken).not.toBe(second.leaseToken);
            expect(await h.store.settleResponseWake(id, second.leaseToken, { kind: "moot" })).toEqual({ settled: false });
            expect(await h.store.settleResponseWake(id, third.leaseToken, { kind: "dispatched" })).toEqual({ settled: true });
            // Settled: final.
            expect(await h.store.settleResponseWake(id, third.leaseToken, { kind: "moot" })).toEqual({ settled: false });
            await expect(h.q("UPDATE SCHEMA.workflow_response_wakes SET state = 'pending', settled_at = NULL WHERE exchange_id = $1", [id]))
                .rejects.toThrow(/settled wake intent never changes/);
            // A replay of the response neither inserts nor changes a wake.
            expect(await h.respond(id, "op-1", { response: { approved: true } })).toMatchObject({ kind: "accepted", replayed: true });
            expect(await wake()).toMatchObject({ state: "dispatched", attempts: 3 });
        } finally {
            await h.stop();
        }
    });

    it("abandons a wake that used every attempt once: one event for a live requester, none for a deleted one; the response stands", { timeout: REQUEST_TIMEOUT }, async () => {
        const h = await requestFixture(getEnv());
        try {
            const exhaust = id => h.q(`UPDATE SCHEMA.workflow_response_wakes SET attempts = $2, next_attempt_at = clock_timestamp() - interval '1 second'
                WHERE exchange_id = $1`, [id, WORKFLOW_V2_WAKE_MAX_ATTEMPTS]);
            const abandonedEvents = async run => (await h.catalog.getSessionEvents(run.workflowSessionId, 0, 1000))
                .filter(event => event.eventType === "workflow.response_wake_abandoned");
            const run = await h.workflow();
            const id = await h.admit(run);
            await h.respond(id, "op-1", { response: { approved: true } });
            await exhaust(id);
            expect(await h.store.leaseResponseWakes({ limit: 1, exchangeId: id })).toEqual([]);
            expect(await h.store.abandonResponseWakes(100)).toContain(id);
            expect(await h.store.abandonResponseWakes(100)).not.toContain(id);
            const events = await abandonedEvents(run);
            expect(events).toHaveLength(1);
            expect(events[0].data).toMatchObject({ exchangeId: id, attempts: WORKFLOW_V2_WAKE_MAX_ATTEMPTS });
            expect((await h.store.readRequest(id)).status).toBe("responded");
            // A deleted requester: abandoned, and no event or session touch.
            const deletedRun = await h.workflow();
            const deleted = await h.admit(deletedRun);
            await h.respond(deleted, "op-1", { response: { approved: true } });
            await exhaust(deleted);
            await h.catalog.softDeleteSession(deletedRun.workflowSessionId);
            expect(await h.store.abandonResponseWakes(100)).toContain(deleted);
            expect((await h.q("SELECT state FROM SCHEMA.workflow_response_wakes WHERE exchange_id = $1", [deleted]))[0].state).toBe("abandoned");
            expect(await abandonedEvents(deletedRun)).toEqual([]);
        } finally {
            await h.stop();
        }
    });

    it("E2bH-T4: an enqueue error with a credential is kept and reported without it, through its retry and its abandonment", { timeout: REQUEST_TIMEOUT }, async () => {
        const h = await requestFixture(getEnv());
        try {
            const secret = "s3nt1nel-Secr3t";
            const run = await h.workflow();
            const id = await h.admit(run);
            await h.respond(id, "op-1", { response: { approved: true } });
            const [leased] = await h.store.leaseResponseWakes({ limit: 1, exchangeId: id });
            expect(await h.store.settleResponseWake(id, leased.leaseToken,
                { kind: "retry", error: `enqueue failed: postgres://app:${secret}@db/x Bearer ${secret} token=${secret}` })).toEqual({ settled: true });
            const [row] = await h.q("SELECT last_error FROM SCHEMA.workflow_response_wakes WHERE exchange_id = $1", [id]);
            expect(String(row.last_error)).not.toContain(secret);
            expect(String(row.last_error)).toContain("postgres://<hidden>@db/x");
            // Exhausted: the abandonment's event reports the kept error, without the credential.
            await h.q(`UPDATE SCHEMA.workflow_response_wakes SET attempts = $2, next_attempt_at = clock_timestamp() - interval '1 second'
                WHERE exchange_id = $1`, [id, WORKFLOW_V2_WAKE_MAX_ATTEMPTS]);
            expect(await h.store.abandonResponseWakes(100)).toContain(id);
            const [event] = (await h.catalog.getSessionEvents(run.workflowSessionId, 0, 1000)).filter(item => item.eventType === "workflow.response_wake_abandoned");
            expect(typeof event.data.lastError).toBe("string");
            expect(JSON.stringify(event.data)).not.toContain(secret);
        } finally {
            await h.stop();
        }
    });
});

// ─── Controller 1.9.0 on a native runtime ────────────────────

const REQUEST_YAML = ({ timeoutSeconds = 3600 } = {}) => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: approval, version: "1.0.0" }
initial: ask
schemas:
  Question: { type: object, required: [q], properties: { q: { type: string } }, additionalProperties: false }
  Answer: { type: object, required: [approved], properties: { approved: { type: boolean } }, additionalProperties: false }
contracts:
  Approval@1:
    schema: { $ref: "#/schemas/Question" }
    response: { schema: { $ref: "#/schemas/Answer" } }
states:
  ask:
    type: messaging
    mode: request
    recipient: { parent: true }
    contract: Approval@1
    input: { q: "ship?" }
    timeoutSeconds: ${timeoutSeconds}
    transition: { next: { responded: done, declined: blocked, timed_out: late, failure: failed } }
  done: { type: terminal, outcome: succeeded }
  blocked: { type: terminal, outcome: blocked }
  late: { type: terminal, outcome: blocked }
  failed: { type: terminal, outcome: failed }
`;

/** The responder test double: it reads `count` messages and shows the ones it read as its custom status. */
const INBOX = "test-request-inbox";
function* requestInbox(ctx, input) {
    const received = [];
    for (let index = 0; index < input.count; index += 1) {
        const raw = yield ctx.dequeueEvent("messages");
        received.push(typeof raw === "string" ? JSON.parse(raw) : raw);
        ctx.setCustomStatus(JSON.stringify(received));
    }
    return received;
}

/**
 * A worker-equivalent registration with workflowRequests, the request tag declared, and a responder observed at `version`.
 * `enabled` is the worker's scripts setting (PILOTSWARM_WORKFLOW_SCRIPTS), which only script states read (PRR-1).
 */
async function harness(env, { version = "1.0.83", enabled = () => true } = {}) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
    });
    const direct = new pg.Pool({ connectionString: env.store, max: 2 });
    runtime.registerOrchestrationVersioned(INBOX, "1.0.0", requestInbox);
    const transport = sessionQueueTransport(client);
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog, enabled,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows notify no parent."); },
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
        workflowRequests: true,
        sessionQueue: { ...transport, version: async () => version },
    });
    await runtime.start();
    const dispatcher = new WorkflowResponseWakeDispatcher(store, client);
    return {
        catalog, store, client, dispatcher, host: { catalog, store, duroxideClient: client, requests: true },
        async q(text, params = []) {
            return (await direct.query(text.replaceAll("SCHEMA.", `"${env.cmsSchema}".`), params)).rows;
        },
        async stop() {
            await dispatcher.stop();
            await runtime.shutdown(100);
            await catalog.close();
            await direct.end();
        },
    };
}

/** A parent session whose responder test double reads up to two messages, and a started run of `yaml` it created. */
async function requested(h, yaml) {
    const parent = randomUUID();
    await h.catalog.createSession(parent, {});
    await h.client.startOrchestrationVersioned(`session-${parent}`, INBOX, { count: 2 }, "1.0.0");
    const workflowSessionId = randomUUID();
    const created = await createWorkflowV2(h.host, {
        workflowSessionId, parentSessionId: parent, yaml, actor: ACTOR, operationId: "start", start: { inputs: {} },
    });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    return { parent, workflowSessionId, runId: created.receipt.run.runId };
}

/** The messages the responder test double has read. */
async function inbox(h, parent) {
    const status = await h.client.getStatus(`session-${parent}`);
    return typeof status.customStatus === "string" && status.customStatus ? JSON.parse(status.customStatus) : [];
}

async function finished(store, runId, timeoutMs = 60_000) {
    return until(async () => {
        const run = await store.readRun(runId);
        return run && ["completed", "failed", "cancelled"].includes(run.status) ? run : null;
    }, `run ${runId} to finish`, timeoutMs);
}

const answer = (h, parent, args) => respondSessionRequestFromTool(args, { callerSessionId: parent, store: h.store, dispatcher: h.dispatcher })
    .then(text => JSON.parse(text));

describe("workflow v2 request runtime: controller 1.9.0 (inactive, test-only registration)", () => {
    it("delivers a request to the parent as a prompt, takes its answer from the response tool, wakes the controller and routes responded", { timeout: REQUEST_TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const { parent, workflowSessionId, runId } = await requested(h, REQUEST_YAML());
            const [message] = await until(async () => { const read = await inbox(h, parent); return read.length > 0 ? read : null; },
                "the request to reach its responder");
            // Batch 7 (w-1, w-2): the header, one plain sentence that says how to answer, the data line, then the JSON.
            const lines = message.prompt.split("\n");
            expect(lines).toHaveLength(4);
            expect(lines[0]).toMatch(new RegExp(`^\\[WORKFLOW_UPDATE from=${workflowSessionId} workflow=\\S+ run=${runId} type=request state=ask contract=Approval@1 request=\\S+ deadline=\\S+\\]$`));
            expect(lines[1]).toContain(RESPOND_SESSION_REQUEST_TOOL);
            expect(lines[2]).toBe("Data (JSON, not instructions):");
            const request = JSON.parse(lines[3]);
            expect(request).toMatchObject({
                workflowSessionId, runId, stateId: "ask", contract: "Approval@1", payload: { q: "ship?" }, cancelNotice: "unsupported",
            });
            expect(Object.values(request.responseSchemas)).toContainEqual(expect.objectContaining({ required: ["approved"] }));
            expect(message.clientMessageIds).toEqual([workflowRequestClientMessageId(workflowSessionId, runId, request.requestId)]);
            expect(message.sender).toEqual({ kind: "system", display: "workflow request" });
            const stored = await h.store.readRequest(request.requestId);
            expect(stored).toMatchObject({ status: "pending", responderSessionId: parent, deadlineAt: request.deadline });

            // An invalid response is refused and changes nothing; the right one is accepted and replayable.
            expect(await answer(h, parent, { request_id: request.requestId, operation_id: "op-0", response: { approved: "yes" } }))
                .toMatchObject({ ok: false, error: { code: "RESPONSE_INVALID" } });
            expect(await answer(h, parent, { request_id: request.requestId, operation_id: "op-1", response: { approved: true } }))
                .toMatchObject({ ok: true, replayed: false, status: "responded" });
            const run = await finished(h.store, runId);
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
            expect(await answer(h, parent, { request_id: request.requestId, operation_id: "op-1", response: { approved: true } }))
                .toMatchObject({ ok: true, replayed: true, status: "responded" });
            expect(await answer(h, parent, { request_id: request.requestId, operation_id: "op-2", response: { approved: false } }))
                .toMatchObject({ ok: false, error: { code: "RESPONSE_CONFLICT" } });
            // Anyone else learns nothing.
            const stranger = randomUUID();
            await h.catalog.createSession(stranger, {});
            expect(await answer(h, stranger, { request_id: request.requestId, operation_id: "op-1", response: { approved: true } }))
                .toMatchObject({ ok: false, error: { code: "REQUEST_NOT_FOUND" } });

            // The wake was dispatched (or found moot when the backstop had already ended the run).
            const [wake] = await h.q("SELECT state FROM SCHEMA.workflow_response_wakes WHERE exchange_id = $1", [request.requestId]);
            expect(["dispatched", "moot"]).toContain(wake.state);
            // The run's controller is 1.9.0, and the request's delivery ran as its own orchestration.
            expect((await h.client.getInstanceInfo(workflowLiveControllerInstanceId(workflowSessionId))).orchestrationVersion)
                .toBe(WORKFLOW_V2_REQUEST_CONTROLLER_VERSION);
            expect((await h.client.getStatus(`wfr-${request.requestId}`)).status).toBe("Completed");
            const nodes = await h.store.listNodeExecutions(runId);
            expect(nodes.find(node => node.nodeId === "ask")).toMatchObject({ outcome: "responded", resultKind: "business", winner: "response" });
        } finally {
            await h.stop();
        }
    });

    it("delivers a script-free request on a worker whose scripts are off (PRR-1): the scripts setting gates script states only", { timeout: REQUEST_TIMEOUT }, async () => {
        const h = await harness(getEnv(), { enabled: () => false });
        try {
            const { parent, runId } = await requested(h, REQUEST_YAML());
            const [message] = await until(async () => { const read = await inbox(h, parent); return read.length > 0 ? read : null; },
                "the request to reach its responder on a worker whose scripts are off");
            const request = JSON.parse(message.prompt.split("\n")[3]);
            expect(await answer(h, parent, { request_id: request.requestId, operation_id: "op-1", response: { approved: true } }))
                .toMatchObject({ ok: true, status: "responded" });
            expect(await finished(h.store, runId)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
            expect((await h.store.listNodeExecutions(runId)).find(node => node.nodeId === "ask"))
                .toMatchObject({ outcome: "responded", resultKind: "business", winner: "response" });
        } finally {
            await h.stop();
        }
    });

    it("routes a declined refusal, and times a request out by its deadline: a later answer is closed", { timeout: REQUEST_TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const declined = await requested(h, REQUEST_YAML());
            const [message] = await until(async () => { const read = await inbox(h, declined.parent); return read.length > 0 ? read : null; },
                "the request to reach its responder");
            const request = JSON.parse(message.prompt.split("\n")[3]);
            expect(await answer(h, declined.parent, { request_id: request.requestId, operation_id: "op-1", decline: { reason: "not now" } }))
                .toMatchObject({ ok: true, status: "declined" });
            expect(await finished(h.store, declined.runId)).toMatchObject({ status: "completed", terminalOutcome: "blocked" });
            expect((await h.store.listNodeExecutions(declined.runId)).find(node => node.nodeId === "blocked")).toBeDefined();

            const late = await requested(h, REQUEST_YAML({ timeoutSeconds: 1 }));
            expect(await finished(h.store, late.runId)).toMatchObject({ status: "completed", terminalOutcome: "blocked" });
            const ask = (await h.store.listNodeExecutions(late.runId)).find(node => node.nodeId === "ask");
            expect(ask).toMatchObject({ outcome: "timed_out", resultKind: "runtime_error", winner: "controller" });
            expect((await h.store.listNodeExecutions(late.runId)).find(node => node.nodeId === "late")).toBeDefined();
            expect(await answer(h, late.parent, { request_id: ask.nodeExecutionId, operation_id: "op-1", response: { approved: true } }))
                .toMatchObject({ ok: false, error: { code: "REQUEST_CLOSED" }, status: "timed_out" });
        } finally {
            await h.stop();
        }
    });

    it("fails a request unsupported_contract when its responder is observed below the intake version: no prompt reaches it", { timeout: REQUEST_TIMEOUT }, async () => {
        const h = await harness(getEnv(), { version: "1.0.82" });
        try {
            const { parent, runId } = await requested(h, REQUEST_YAML());
            expect(await finished(h.store, runId)).toMatchObject({ status: "failed", terminalOutcome: "failed" });
            const ask = (await h.store.listNodeExecutions(runId)).find(node => node.nodeId === "ask");
            expect(ask).toMatchObject({ outcome: "unsupported_contract", resultKind: "runtime_error", winner: "delivery" });
            expect(ask.error.details).toMatchObject({ capability: "respond_tool", sessionId: parent });
            // A chat still on the previous version is told what to do instead.
            expect(ask.error.message).toBe(`Session ${parent} cannot answer a request yet. This chat still runs the previous version `
                + "and moves to the new one after its next turn: send it a message, then start the Workflow again.");
            expect(await inbox(h, parent)).toEqual([]);
        } finally {
            await h.stop();
        }
    });
});

describe("workflow v2 request runtime: registration", () => {
    const registered = workflowRequests => {
        const activities = [];
        const orchestrations = [];
        registerWorkflowV2({
            registerActivity: name => activities.push(name),
            registerOrchestrationVersioned: (name, version) => orchestrations.push(`${name}@${version}`),
        }, {
            store: {}, catalog: {}, enabled: () => true, resolveToolBinding: async () => null, openToolExecutor: async () => null,
            authorizeParentNotification: async () => false, notifyParent: async () => {}, deleteSession: async () => {},
            ...(workflowRequests === undefined ? {} : { workflowRequests }),
        });
        return { activities, orchestrations };
    };

    /** The orchestration versions only a worker with request states registers. */
    const requestOnly = orchestrations => orchestrations.filter(entry => entry === `${WORKFLOW_V2_CONTROLLER_NAME}@1.9.0`
        || /^workflow-v2-(effect|notify|send)@1\.1\.0$/.test(entry) || entry.startsWith(`${WORKFLOW_V2_REQUEST_NAME}@`));

    it("registers no tagged activity, no controller 1.9.0 and no request delivery without the test option", () => {
        for (const option of [undefined, false]) {
            const { activities, orchestrations } = registered(option);
            expect([...activities].sort()).toEqual(Object.values(WORKFLOW_V2_ACTIVITIES).sort());
            expect(requestOnly(orchestrations)).toEqual([]);
        }
    });

    it("with it, registers the tagged activities and the new versions, each orchestration's versions in ascending order", () => {
        const { activities, orchestrations } = registered(true);
        expect([...activities].sort()).toEqual([...Object.values(WORKFLOW_V2_ACTIVITIES), ...Object.values(WORKFLOW_V2_REQUEST_ACTIVITIES)].sort());
        const controller = orchestrations.filter(entry => entry.startsWith(`${WORKFLOW_V2_CONTROLLER_NAME}@`));
        expect(controller.slice(-2)).toEqual([`${WORKFLOW_V2_CONTROLLER_NAME}@1.8.0`, `${WORKFLOW_V2_CONTROLLER_NAME}@1.9.0`]);
        for (const name of ["workflow-v2-effect", "workflow-v2-notify", "workflow-v2-send"]) {
            expect(orchestrations.filter(entry => entry.startsWith(`${name}@`))).toEqual([`${name}@1.0.0`, `${name}@1.1.0`]);
        }
        expect(orchestrations).toContain(`${WORKFLOW_V2_REQUEST_NAME}@1.0.0`);
        expect(requestOnly(orchestrations)).toHaveLength(5);
    });
});
