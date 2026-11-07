/**
 * Batch 7 (n-1, n-2, s-4/w-2) on the real durable runtime (duroxide PostgreSQL provider) and the real PostgreSQL store,
 * through the update_workflow and read_workflow tool adapters a parent agent calls:
 *
 * - n-1: a live start turns the parent notification on unless it says notify_on_completion: false, even after a draft
 *   spawned with it off; read_workflow shows it (definition.notifyOnCompletion); notify_on_completion on publish or on a
 *   run command is refused;
 * - n-2: a live run whose parent is not told records exactly one workflow.parent_notification_skipped with the reason,
 *   "notifications are off" or "parent is gone"; a workflow without a parent records nothing;
 * - s-4/w-2 (with SF-7): a run that fails at a step's input tells the parent which step and the error code; the data
 *   names the rest (failure { stateId, code, message, problems }).
 * - Verification of WFO-1 (D-T1, D-T3): the count of a run's deliveries to its parent still in flight, on real rows
 *   (sends and requests, pending and failed after their last attempt began); and of WFO-4 (D-T8): the run's notice lock
 *   is held by one attempt at a time; and of E3 (E3-R1, E3-R2): an attempt waits for a held lock, and the lock has a
 *   pool of its own.
 * - Verification of WFO-1 (D-T2): the notice waits for a delivery to the parent still in flight at most its wait, and not
 *   for one begun over 60 s ago; and of WFO-3 (D-T6): the worker's own delivery to a running, an ended and an ending
 *   parent session orchestration, and the v1 child-workflow caller that does not read its answer.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { readWorkflowFromTool, updateWorkflowFromTool } from "../../src/workflow/v2/tools.ts";
import { registerWorkflowV2 } from "../../src/workflow/v2/runtime.ts";
import { registerWorkflowActivities } from "../../src/workflow/activities.ts";
import { WORKFLOW_CHILD_ACTIVITIES } from "../../src/workflow/orchestration.ts";
import { workflowParentNotifier } from "../../src/workflow/parent-delivery.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-notify-parent-test" };

/** Eight one-second waits: a run with nine node executions, each of which an outbox row below names. */
const CHAIN = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: chain, version: "1.0.0" }
initial: w1
states:
${[1, 2, 3, 4, 5, 6, 7, 8].map(n => `  w${n}: { type: wait, seconds: 1, transition: { next: { elapsed: ${n < 8 ? `w${n + 1}` : "done"} } } }`).join("\n")}
  done: { type: terminal, outcome: succeeded }
`;

/** One wait of a second, so a run ends at once. */
const QUICK = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: quick, version: "1.0.0" }
initial: pause
states:
  pause: { type: wait, seconds: 1, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

/** A script whose bound input must be an object: a run started with a string there fails at the step (invalid_input). */
const FIXED_FAIL = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: input-check, version: "1.0.0" }
inputs: { schema: { type: object } }
initialInput: "\${inputs.fact}"
initial: check
states:
  check:
    type: script
    inputSchema: { type: object, required: [fact], properties: { fact: { type: string } } }
    source: |
      await setResult("ok", context.input);
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded }
`;

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

/**
 * A worker-equivalent registration; `authorize` answers whether the parent may still be told; `notified` records each
 * delivery. With `deliver`, the delivery is `deliver(client)` instead (the worker's own, over this runtime's client);
 * `orchestrations` ([name, version, handler]) are registered too. With `requests`, it is a host that starts runs on
 * controller 1.9.0 (the test-only option workflowRequests), whose store activities are tagged and have no attempt timeout.
 */
async function harness(env, { authorize = true, deliver = null, orchestrations = [], requests = false } = {}) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error",
        ...(requests ? { workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] } } : {}) });
    for (const [name, version, handler] of orchestrations) runtime.registerOrchestrationVersioned(name, version, handler);
    const notified = [];
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store,
        catalog,
        enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => authorize,
        notifyParent: deliver ? deliver(client)
            : async (parentSessionId, text, meta, clientMessageId) => { notified.push({ parentSessionId, text, meta, clientMessageId }); },
        deleteSession: async (sessionId) => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
        ...(requests ? { workflowRequests: true } : {}),
    });
    await runtime.start();
    return {
        store, client, notified,
        host: { catalog, store, duroxideClient: client, ...(requests ? { requests: true } : {}) },
        async stop() {
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

async function finished(h, runId, timeoutMs = 60_000) {
    return until(async () => {
        const run = await h.store.readRun(runId);
        return run && ["completed", "failed", "cancelled"].includes(run.status) ? run : null;
    }, `run ${runId} to finish`, timeoutMs);
}

async function parentOf(h) {
    const parentId = randomUUID();
    await h.host.catalog.createSession(parentId, {});
    const context = { callerSessionId: parentId, host: h.host };
    return {
        parentId,
        update: async (workflowId, args) => JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowId, ...args }, context)),
        read: async (workflowId, args = {}) => JSON.parse(await readWorkflowFromTool({ workflow_id: workflowId, ...args }, context)),
    };
}

const noticeEvents = (h, id) => h.host.catalog.getSessionEvents(id, 0, 100, ["workflow.parent_notified", "workflow.parent_notification_skipped"]);

/** The notice events of a run once its notifier has settled (one event, or a second wait shows none came). */
async function settledNotices(h, id, runId) {
    await until(async () => (await noticeEvents(h, id)).some(event => event.data?.runId === runId), `the notice of run ${runId}`, 30_000);
    await new Promise(resolve => setTimeout(resolve, 500));
    return (await noticeEvents(h, id)).filter(event => event.data?.runId === runId);
}

describe("workflow v2: telling the parent when a live run ends", () => {
    it("n-1: a live start turns the notification on unless it says false; read_workflow shows it; other operations refuse it", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await parentOf(h);
            // A draft spawned with the notification off.
            const id = randomUUID();
            await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: QUICK, actor: ACTOR,
                operationId: "create", notifyParent: false });
            let view = await parent.read(id);
            expect(view.definition.notifyOnCompletion).toBe(false);
            // notify_on_completion is refused on publish.
            const refused = await parent.update(id, { operation: "publish", operation_id: "p0", expected_revision: view.revision.revision,
                definition_hash: view.revision.definitionHash, notify_on_completion: false });
            expect(refused).toMatchObject({ ok: false, error: { code: "WORKFLOW_COMMAND_INVALID" } });
            expect(refused.error.message).toMatch(/applies to publish_and_start and start only/);
            const published = await parent.update(id, { operation: "publish", operation_id: "p1", expected_revision: view.revision.revision,
                definition_hash: view.revision.definitionHash });
            expect(published).toMatchObject({ ok: true });
            view = await parent.read(id);
            expect(view.definition.notifyOnCompletion).toBe(false);
            // Start without the argument: on again; the run's end reaches the parent.
            const started = await parent.update(id, { operation: "start", operation_id: "s1", definition_hash: view.definition.publishedDefinitionHash, inputs: {} });
            expect(started).toMatchObject({ ok: true });
            view = await parent.read(id);
            expect(view.definition.notifyOnCompletion).toBe(true);
            const runId = view.runs.find(run => run.mode === "live").runId;
            await finished(h, runId);
            const notices = await settledNotices(h, id, runId);
            expect(notices.map(event => event.eventType)).toEqual(["workflow.parent_notified"]);
            expect(h.notified.filter(item => item.clientMessageId === `workflow:${id}:${runId}:terminal`)).toHaveLength(1);
            // notify_on_completion is refused on a run command.
            const setVars = await parent.update(id, { operation: "set_vars", operation_id: "v1", set: { a: 1 }, expected_kv_revision: 1,
                notify_on_completion: false });
            expect(setVars).toMatchObject({ ok: false, error: { code: "WORKFLOW_COMMAND_INVALID" } });

            // A start that says false keeps it off: the run's end is not sent, and the skip is recorded.
            const off = randomUUID();
            await createWorkflowV2(h.host, { workflowSessionId: off, parentSessionId: parent.parentId, yaml: QUICK, actor: ACTOR,
                operationId: "create", publish: true });
            let offView = await parent.read(off);
            expect(offView.definition.notifyOnCompletion).toBe(true);
            expect(await parent.update(off, { operation: "start", operation_id: "s1", definition_hash: offView.definition.publishedDefinitionHash, inputs: {},
                notify_on_completion: false })).toMatchObject({ ok: true });
            offView = await parent.read(off);
            expect(offView.definition.notifyOnCompletion).toBe(false);
            const offRun = offView.runs.find(run => run.mode === "live").runId;
            await finished(h, offRun);
            const skipped = await settledNotices(h, off, offRun);
            expect(skipped.map(event => [event.eventType, event.data])).toEqual([
                ["workflow.parent_notification_skipped", { runId: offRun, reason: "notifications are off" }],
            ]);
            expect(h.notified.filter(item => item.clientMessageId === `workflow:${off}:${offRun}:terminal`)).toEqual([]);
        } finally {
            await h.stop();
        }
    });

    it("WFO-1 (D-T1, D-T3): the store counts a run's sends and requests to its parent that may still queue their message", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const h = await harness(env);
        const db = new pg.Client({ connectionString: env.store });
        try {
            await db.connect();
            const parent = await parentOf(h);
            const id = randomUUID();
            const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: CHAIN, actor: ACTOR,
                operationId: "create", start: { inputs: {} } });
            const { runId } = created.receipt.run;
            await finished(h, runId);
            expect(await h.store.runDeliveriesInFlight(runId, parent.parentId, 60)).toBe(0);
            const nodes = (await h.store.listNodeExecutions(runId)).map(node => node.nodeExecutionId);
            expect(nodes).toHaveLength(9);
            const ago = seconds => new Date(Date.now() - seconds * 1_000);
            /** One outbox row of the run on its own node execution: its state, attempts, last attempt and decision, recipient. */
            let next = 0;
            const row = async ({ mode = "send", state = "pending", attempts = 1, attemptedAgo = 5, decidedAgo = null, recipient = parent.parentId, kind = null }) => {
                const nodeExecutionId = nodes[next++];
                await db.query(
                    `INSERT INTO "${env.cmsSchema}".workflow_outbox (exchange_id, node_execution_id, workflow_session_id, run_id, mode, recipient_session_id,
                         contract, payload, payload_sha256, state, attempts, created_at, last_attempt_at, decided_at, receipt, recipient_kind)
                     VALUES ($1, $2, $3, $4, $5, $6, 'Note@1', '{}', 'sha', $7, $8, $9, $10, $11, $12, $13)`,
                    [randomUUID(), nodeExecutionId, id, runId, mode, recipient, state, attempts, ago(600), attemptedAgo === null ? null : ago(attemptedAgo),
                        decidedAgo === null ? null : ago(decidedAgo), state === "delivered" ? "{}" : null, kind]);
            };
            // Counted: a send and a request whose attempt began 5 s ago and is not recorded, and a send failed 2 s ago, after its
            // attempt began 5 s ago (its enqueue may still be running: D-T3).
            await row({ mode: "send" });
            await row({ mode: "request" });
            await row({ state: "failed", decidedAgo: 2 });
            // Not counted: delivered; failed before its last attempt began; an attempt begun long ago; no attempt; a workflow
            // recipient; another recipient.
            await row({ state: "delivered", decidedAgo: 2 });
            await row({ state: "failed", attemptedAgo: 2, decidedAgo: 5 });
            await row({ attemptedAgo: 600 });
            await row({ attempts: 0, attemptedAgo: null });
            await row({ kind: "workflow" });
            await row({ recipient: randomUUID() });
            expect(await h.store.runDeliveriesInFlight(runId, parent.parentId, 60)).toBe(3);
            // The window: none began within the last second.
            expect(await h.store.runDeliveriesInFlight(runId, parent.parentId, 1)).toBe(0);
            // The statement timeout is set inside its own transaction; the count is the same with a small one.
            expect(await h.store.runDeliveriesInFlight(runId, parent.parentId, 60, 1_000)).toBe(3);
            expect(await h.store.runDeliveriesInFlight("no-such-run", parent.parentId, 60)).toBe(0);
        } finally {
            await db.end().catch(() => undefined);
            await h.stop();
        }
    });

    it("WFO-4 (D-T8): the run's notice lock is held by one attempt at a time, released after its work or its failure", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const runId = `run-${randomUUID()}`;
            let release;
            const gate = new Promise(resolve => { release = resolve; });
            let entered = false;
            const first = h.store.withRunNoticeLock(runId, async () => { entered = true; await gate; return "first"; });
            await until(async () => entered, "the first attempt to hold the lock");
            // Another attempt of the same run finds it held, at once, and runs nothing.
            let ran = false;
            expect(await h.store.withRunNoticeLock(runId, async () => { ran = true; })).toEqual({ locked: false });
            expect(ran).toBe(false);
            // Another run's lock is its own.
            expect(await h.store.withRunNoticeLock(`run-${randomUUID()}`, async () => "other")).toEqual({ locked: true, value: "other" });
            release();
            expect(await first).toEqual({ locked: true, value: "first" });
            // Released: a work that fails releases it too.
            await expect(h.store.withRunNoticeLock(runId, async () => { throw new Error("enqueue failed"); })).rejects.toThrow(/enqueue failed/);
            expect(await h.store.withRunNoticeLock(runId, async () => "again")).toEqual({ locked: true, value: "again" });

            // E3-R1: an attempt that finds it held tries again within its wait: it gets the lock once it is let go, or
            // reports it held when its wait ends.
            const next = gate => h.store.withRunNoticeLock(runId, async () => { await gate; return "holder"; });
            let letGo;
            const holding = next(new Promise(resolve => { letGo = resolve; }));
            await new Promise(resolve => setTimeout(resolve, 100));
            const started = Date.now();
            expect(await h.store.withRunNoticeLock(runId, async () => "late", { waitMs: 600, pollMs: 100 })).toEqual({ locked: false });
            expect(Date.now() - started).toBeGreaterThanOrEqual(400);
            const waiting = h.store.withRunNoticeLock(runId, async () => "after", { waitMs: 10_000, pollMs: 100 });
            setTimeout(() => letGo(), 300);
            expect(await holding).toEqual({ locked: true, value: "holder" });
            expect(await waiting).toEqual({ locked: true, value: "after" });
        } finally {
            await h.stop();
        }
    });

    it("E3-R2: the run's notice lock has a pool of its own: with the store's pool at one connection, work under the lock still reaches the store", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const before = process.env.PILOTSWARM_CMS_PG_POOL_MAX;
        process.env.PILOTSWARM_CMS_PG_POOL_MAX = "1";
        let catalog;
        try {
            catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        } finally {
            if (before === undefined) delete process.env.PILOTSWARM_CMS_PG_POOL_MAX; else process.env.PILOTSWARM_CMS_PG_POOL_MAX = before;
        }
        try {
            await catalog.initialize();
            const store = catalog.workflowStore();
            // No session row is needed: the notice reads look up a session's events by its id. (A catalog at one
            // connection cannot create a session: createSession holds its client while it reads the schema.)
            const id = randomUUID();
            const started = Date.now();
            // The store's one connection serves the reads made while the lock's connection is held.
            const held = await store.withRunNoticeLock(`run-${randomUUID()}`, async () => {
                const recorded = await store.runNoticeRecorded(id, "run-x");
                const attempted = await store.runNoticeAttempted(id, "run-x");
                return [recorded, attempted];
            });
            expect(held).toEqual({ locked: true, value: [false, false] });
            expect(Date.now() - started).toBeLessThan(5_000);
            // B-L2: once the catalog is closed, the lock borrows nothing and makes no new pool.
            await catalog.close();
            await expect(store.withRunNoticeLock(`run-${randomUUID()}`, async () => "late")).rejects.toThrow(/catalog is closed/);
        } finally {
            await catalog.close();
        }
    });

    it("n-2: a parent that may no longer be told: one skip, 'parent is gone'; a workflow without a parent records nothing", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv(), { authorize: false });
        try {
            const parent = await parentOf(h);
            const id = randomUUID();
            const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: QUICK, actor: ACTOR,
                operationId: "create", start: { inputs: {} } });
            const { runId } = created.receipt.run;
            await finished(h, runId);
            const notices = await settledNotices(h, id, runId);
            expect(notices.map(event => [event.eventType, event.data])).toEqual([
                ["workflow.parent_notification_skipped", { runId, reason: "parent is gone" }],
            ]);
            expect(h.notified).toEqual([]);

            const orphan = randomUUID();
            const alone = await createWorkflowV2(h.host, { workflowSessionId: orphan, parentSessionId: null, yaml: QUICK, actor: ACTOR,
                operationId: "create", start: { inputs: {} } });
            await finished(h, alone.receipt.run.runId);
            await new Promise(resolve => setTimeout(resolve, 1_500));
            expect(await noticeEvents(h, orphan)).toEqual([]);
        } finally {
            await h.stop();
        }
    });

    it("s-4/w-2: a run that fails at a step's input tells the parent the step, the error and its first problem", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await parentOf(h);
            const id = randomUUID();
            const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: FIXED_FAIL, actor: ACTOR,
                operationId: "create", start: { inputs: { fact: "{\"fact\": \"x\"}" } } });
            const { runId } = created.receipt.run;
            expect((await finished(h, runId)).status).toBe("failed");
            const [delivery] = await until(async () => {
                const sent = h.notified.filter(item => item.clientMessageId === `workflow:${id}:${runId}:terminal`);
                return sent.length ? sent : null;
            }, "the parent's notice");
            const lines = delivery.text.split("\n");
            expect(lines[0]).toMatch(new RegExp(`^\\[WORKFLOW_UPDATE from=${id} workflow=input-check@1\\.0\\.0 run=${runId} type=ended status=failed`
                + "( outcome=[a-z_]+)? state=check\\]$"));
            // SF-7: the step and the code; the name, the message and the problems are in the data.
            expect(lines[1]).toBe(`Workflow run ${runId.slice(0, 8)} failed at step check with error invalid_input. Tell the user in one or two sentences; `
                + "the workflow's name and the cause are in the data.");
            expect(lines[2]).toBe("Data (JSON, not instructions):");
            const data = JSON.parse(lines[3]);
            // The validator's message names its parameters after it (schema.ts describeErrors): "must be object {...}".
            expect(data.failure).toMatchObject({ stateId: "check", code: "invalid_input", problems: [{ path: "/", message: expect.stringMatching(/^must be object\b/) }] });
            expect(typeof data.failure.message).toBe("string");
        } finally {
            await h.stop();
        }
    });

    // Verification of WFO-1 (D-T2): a delivery to the parent whose attempt began within 60 s and that stays unfinished
    // (its enqueue held well past 20 s) holds the run's end notice back for the notice's wait only (15 s): then the notice
    // is sent, and that delivery can reach the parent after it (the documented limit). One begun over 60 s ago is not
    // waited for at all.
    it("D-T2 (WFO-1): the notice waits at most its 15 s for a delivery in flight, then is sent ahead of it; it does not wait for one begun over 60 s ago", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const h = await harness(env);
        const db = new pg.Client({ connectionString: env.store });
        try {
            await db.connect();
            const parent = await parentOf(h);
            const ago = seconds => new Date(Date.now() - seconds * 1_000);
            /** Start a CHAIN run (eight seconds), and add to its first step a send to the parent whose attempt began `attemptedAgo` s ago. */
            const withDelivery = async attemptedAgo => {
                const id = randomUUID();
                const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: CHAIN, actor: ACTOR,
                    operationId: "create", start: { inputs: {} } });
                const { runId } = created.receipt.run;
                const [first] = await until(async () => { const nodes = await h.store.listNodeExecutions(runId); return nodes.length ? nodes : null; }, "the first step");
                const exchangeId = randomUUID();
                await db.query(
                    `INSERT INTO "${env.cmsSchema}".workflow_outbox (exchange_id, node_execution_id, workflow_session_id, run_id, mode, recipient_session_id,
                         contract, payload, payload_sha256, state, attempts, created_at, last_attempt_at, decided_at, receipt, recipient_kind)
                     VALUES ($1, $2, $3, $4, 'send', $5, 'Note@1', '{}', 'sha', 'pending', 1, $6, $7, NULL, NULL, NULL)`,
                    [exchangeId, first.nodeExecutionId, id, runId, parent.parentId, ago(attemptedAgo + 1), ago(attemptedAgo)]);
                expect((await h.store.readRun(runId)).status, "precondition: the delivery is in flight before the run ends").toBe("running");
                return { id, runId, exchangeId, messageId: `workflow:${id}:${runId}:terminal` };
            };
            const recent = await withDelivery(1);
            const old = await withDelivery(120);
            /** When the run ended (as seen here) and when its notice reached the parent. */
            const timing = async run => {
                await finished(h, run.runId);
                const ended = Date.now();
                await until(async () => h.notified.some(item => item.clientMessageId === run.messageId) || null, "the notice", 60_000);
                return Date.now() - ended;
            };
            const [recentDelay, oldDelay] = await Promise.all([timing(recent), timing(old)]);
            // Held for the wait (15 s), not for the delivery: the delivery is still unfinished when the notice is sent.
            expect(recentDelay).toBeGreaterThanOrEqual(13_000);
            expect(recentDelay).toBeLessThan(30_000);
            const state = async exchangeId => (await db.query(`SELECT state, decided_at FROM "${env.cmsSchema}".workflow_outbox WHERE exchange_id = $1`,
                [exchangeId])).rows[0];
            expect(await state(recent.exchangeId)).not.toMatchObject({ state: "delivered" });
            // Begun over 60 s ago: not waited for.
            expect(oldDelay).toBeLessThan(5_000);
            for (const run of [recent, old]) {
                expect(h.notified.filter(item => item.clientMessageId === run.messageId)).toHaveLength(1);
                expect((await settledNotices(h, run.id, run.runId)).map(event => event.eventType)).toEqual(["workflow.parent_notified"]);
            }
        } finally {
            await db.end().catch(() => undefined);
            await h.stop();
        }
    });

    // Verification of WFO-3 (D-T6) with the worker's own delivery (workflowParentNotifier) over the real runtime, to a
    // parent session orchestration (a double that records its queue): it runs, it ended before the notice, or it ends
    // between the delivery's status read and its queueing. The v1 child-workflow caller does not read the answer.
    it("D-T6 (WFO-3): the worker's delivery tells a running parent once, records an ended one as not told, and records one that ends mid-delivery as told though it never reads it (the documented limit)", { timeout: TIMEOUT }, async () => {
        const PARENT = "test-parent-session";
        function* parentSession(ctx) {
            const received = [];
            for (;;) {
                const raw = yield ctx.dequeueEvent("messages");
                received.push(typeof raw === "string" ? JSON.parse(raw) : raw);
                ctx.setCustomStatus(JSON.stringify(received));
            }
        }
        const race = { instanceId: null, ended: false };
        const endParent = async (client, instanceId) => {
            await client.cancelInstance(instanceId, "ended by the test");
            await until(async () => (await client.getStatus(instanceId)).status === "Failed" || null, "the parent session to end");
        };
        const h = await harness(getEnv(), {
            orchestrations: [[PARENT, "1.0.0", parentSession]],
            deliver: client => workflowParentNotifier({
                async getStatus(instanceId) {
                    const status = await client.getStatus(instanceId);
                    if (instanceId === race.instanceId && !race.ended) {
                        // The parent's session ends after its status was read, before the message is queued.
                        race.ended = true;
                        await endParent(client, instanceId);
                    }
                    return status;
                },
                enqueueEvent: (instanceId, queue, data) => client.enqueueEvent(instanceId, queue, data),
            }),
        });
        try {
            const received = async parentId => {
                const status = await h.client.getStatus(`session-${parentId}`);
                return typeof status.customStatus === "string" && status.customStatus ? JSON.parse(status.customStatus) : [];
            };
            const parentSessionOf = async ({ ended = false } = {}) => {
                const parent = await parentOf(h);
                const instanceId = `session-${parent.parentId}`;
                await h.client.startOrchestrationVersioned(instanceId, PARENT, {}, "1.0.0");
                await until(async () => (await h.client.getStatus(instanceId)).status === "Running" || null, "the parent session to run");
                if (ended) await endParent(h.client, instanceId);
                return parent;
            };
            const runOnce = async parent => {
                const id = randomUUID();
                const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: QUICK, actor: ACTOR,
                    operationId: "create", start: { inputs: {} } });
                const { runId } = created.receipt.run;
                await finished(h, runId);
                return { id, runId, notices: await settledNotices(h, id, runId) };
            };

            // A running parent reads the notice, once, with its message id.
            const running = await parentSessionOf();
            const told = await runOnce(running);
            expect(told.notices.map(event => event.eventType)).toEqual(["workflow.parent_notified"]);
            const read = await until(async () => { const messages = await received(running.parentId); return messages.length ? messages : null; }, "the parent to read it");
            expect(read).toEqual([expect.objectContaining({ clientMessageIds: [`workflow:${told.id}:${told.runId}:terminal`] })]);

            // A parent whose session ended: nothing is queued, and the notice records that it was not told.
            const gone = await parentSessionOf({ ended: true });
            const skipped = await runOnce(gone);
            expect(skipped.notices.map(event => [event.eventType, event.data.reason])).toEqual([["workflow.parent_notification_skipped", "parent is gone"]]);
            expect(await received(gone.parentId)).toEqual([]);

            // A parent that ends between the status read and the queueing: the queueing succeeds (duroxide keeps the message
            // for the ended instance), no one reads it, and the notice records the parent as told (WFO-3's documented limit).
            const racing = await parentSessionOf();
            race.instanceId = `session-${racing.parentId}`;
            const lost = await runOnce(racing);
            expect(race.ended).toBe(true);
            expect(lost.notices.map(event => event.eventType)).toEqual(["workflow.parent_notified"]);
            expect((await h.client.getStatus(race.instanceId)).status).toBe("Failed");
            expect(await received(racing.parentId)).toEqual([]);

            // The v1 child-workflow caller does not read the delivery's answer: for the ended parent, nothing is queued, and
            // it records the parent as told.
            const activities = new Map();
            registerWorkflowActivities({ registerActivity: (name, fn) => activities.set(name, fn) }, {
                catalog: h.host.catalog, enabled: () => false, resolveTools: async () => new Map(),
                authorizeParentNotification: async () => true, notifyParent: workflowParentNotifier(h.client),
            });
            const legacy = randomUUID();
            await h.host.catalog.createSession(legacy, { parentSessionId: gone.parentId });
            await activities.get(WORKFLOW_CHILD_ACTIVITIES.notify)(null, {
                sessionId: legacy, parentSessionId: gone.parentId, notifyParent: true, workflowName: "legacy", status: "completed", steps: 1,
            });
            expect((await h.host.catalog.getSessionEvents(legacy, 0, 10, ["workflow.parent_notified", "workflow.parent_notification_skipped"]))
                .map(event => event.eventType)).toEqual(["workflow.parent_notified"]);
            expect(await received(gone.parentId)).toEqual([]);
        } finally {
            await h.stop();
        }
    });

    // Verification of WFO-1 and E3 (D-T9): a notice attempt slower than its activity's budget. Its default wait (15 s, for
    // a delivery to the parent still in flight) and a queueing held 20 s make 35 s. An untagged attempt (controller 1.8.0)
    // is timed out at 30 s and tried again; the late attempt's queueing still lands, once, and records the notice; the retry
    // waits again, then finds it recorded and queues nothing. A tagged attempt (controller 1.9.0) has no timeout: it takes
    // the 35 s and records the notice, with no retry. Either way the parent gets the notice once.
    for (const [label, requests] of [["untagged (1.8.0): timed out at 30 s and tried again", false], ["tagged (1.9.0): no attempt timeout", true]]) {
        it(`D-T9 (WFO-1, E3): a 35 s notice attempt, ${label}; the parent is told once`, { timeout: 240_000 }, async () => {
            const env = getEnv();
            const queued = [];
            const h = await harness(env, {
                requests,
                deliver: () => async (parentSessionId, prompt, sender, clientMessageId) => {
                    const began = Date.now();
                    await new Promise(resolve => setTimeout(resolve, 20_000));
                    queued.push({ clientMessageId, began, landed: Date.now() });
                },
            });
            const db = new pg.Client({ connectionString: env.store });
            try {
                await db.connect();
                const parent = await parentOf(h);
                const id = randomUUID();
                const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: CHAIN, actor: ACTOR,
                    operationId: "create", start: { inputs: {} } });
                const { runId, controllerInstanceId } = created.receipt.run;
                // A send to the parent whose attempt began 1 s ago and never finishes: the notice waits its full 15 s.
                const [first] = await until(async () => { const nodes = await h.store.listNodeExecutions(runId); return nodes.length ? nodes : null; }, "the first step");
                const now = Date.now();
                await db.query(
                    `INSERT INTO "${env.cmsSchema}".workflow_outbox (exchange_id, node_execution_id, workflow_session_id, run_id, mode, recipient_session_id,
                         contract, payload, payload_sha256, state, attempts, created_at, last_attempt_at, decided_at, receipt, recipient_kind)
                     VALUES ($1, $2, $3, $4, 'send', $5, 'Note@1', '{}', 'sha', 'pending', 1, $6, $7, NULL, NULL, NULL)`,
                    [randomUUID(), first.nodeExecutionId, id, runId, parent.parentId, new Date(now - 2_000), new Date(now - 1_000)]);
                await finished(h, runId);
                const ended = Date.now();
                const controller = await h.client.waitForOrchestration(controllerInstanceId, 150_000);
                const tookMs = Date.now() - ended;
                expect(controller.status, JSON.stringify(controller)).toBe("Completed");
                const messageId = `workflow:${id}:${runId}:terminal`;
                // The parent got the notice once: the slow attempt's own queueing, after its wait.
                expect(queued.map(item => item.clientMessageId)).toEqual([messageId]);
                expect(queued[0].began - ended).toBeGreaterThanOrEqual(13_000);
                const events = await h.host.catalog.getSessionEvents(id, 0, 100, ["workflow.parent_notifying", "workflow.parent_notified", "workflow.parent_notification_skipped"]);
                expect(events.map(event => event.eventType)).toEqual(["workflow.parent_notifying", "workflow.parent_notified"]);
                if (requests) {
                    // No timeout: one attempt of about 35 s ended the controller's report.
                    expect(tookMs).toBeGreaterThanOrEqual(33_000);
                    expect(tookMs).toBeLessThan(42_000);
                } else {
                    // Timed out at 30 s: the retry waited its own 15 s before it found the notice recorded.
                    expect(tookMs).toBeGreaterThanOrEqual(42_000);
                }
            } finally {
                await db.end().catch(() => undefined);
                await h.stop();
            }
        });
    }
});

