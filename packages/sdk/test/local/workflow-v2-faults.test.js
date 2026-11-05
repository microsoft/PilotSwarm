/**
 * Workflow v2 recovery at injected fault boundaries, on the real durable
 * runtime (duroxide PostgreSQL provider) and the real PostgreSQL store, with
 * the production activity and orchestration registrations. One activity is
 * wrapped per test to inject the fault; everything else is unchanged.
 *
 * Model cases: docs/formal/workflow-v2/WorkflowV2Run.tla, properties
 * Live_Terminates (lost wake: rv-terminates-lost-wake; effect death:
 * rv-terminates-effect-death; both hd-liveness), Prop_CancelAsksLiveEffects
 * (a crash after the cancel commit, before the stop request: rv-cancel-stops),
 * Prop_NoScriptAfterDelete (a deletion that commits while the effect
 * prepares its script: df-no-entry-fence, hd-safety), worker crashes inside
 * the entry transaction followed by a healthy worker (the model's crash
 * assumption, README "Assumptions"), explicit recovery (hd-controller-death,
 * df-no-recovery), and the controller's fail-closed
 * finalization, continue-as-new with a pending state, at-least-once parent
 * notification (also of a run that a recover ended), recover receipts and
 * the command-read boundary (README "Regressions"). The outcomes of a
 * parent notification (WorkflowV2Lifecycle.tla AuthorityLoss, NotifyFaults,
 * CtlFallback): a delivery that finds the parent's authority gone records a
 * skip and returns; a delivery that runs out fails the notifier, and the
 * controller after its failure path's one more delivery; a begin whose
 * notifier start runs out takes the failure path, whose delivery tells the
 * parent or runs out too. A run-end notice owed after an interrupted report
 * outlives notifiers that run out and is delivered once by a new recover,
 * also by two recovers at once and past 60 earlier notices (verification of
 * RT-4, M-10).
 */
import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { controlWorkflowV2Run, createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { readWorkflowFromTool, updateWorkflowFromTool } from "../../src/workflow/v2/tools.ts";
import {
    registerWorkflowV2, WORKFLOW_V2_ACTIVITIES, WORKFLOW_V2_CONTROLLER_NAME, WORKFLOW_V2_CONTROLLER_VERSION, WORKFLOW_V2_FINALIZE_DELAYS_MS,
    WORKFLOW_V2_NOTIFY_NAME, WORKFLOW_V2_NOTIFY_VERSION,
    workflowEffectInstanceId, workflowLiveControllerInstanceId, workflowNotifyInstanceId,
} from "../../src/workflow/v2/runtime.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-fault-test" };

const TWO_STEPS = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: two-steps, version: "1.0.0" }
initialInput: { n: 0 }
initial: first
states:
  first:
    type: script
    source: |
      await setResult("ok", { n: context.input.n + 1 });
    transition: { next: { ok: second } }
  second:
    type: script
    source: |
      await setResult("ok", { n: context.input.n + 1 });
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
`;

const SLOW = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: slow, version: "1.0.0" }
initial: wait
states:
  wait:
    type: script
    timeoutSeconds: 120
    source: |
      await new Promise(resolve => setTimeout(resolve, 90_000));
      await setResult("ok", { late: true });
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
`;

const CAUGHT = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: caught, version: "1.0.0" }
initial: wait
states:
  wait:
    type: script
    timeoutSeconds: 120
    source: |
      await new Promise(resolve => setTimeout(resolve, 90_000));
      await setResult("ok", { late: true });
    transition: { next: { ok: done, failure: caught } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  caught: { type: terminal, outcome: blocked, output: "\${runtime.error}" }
`;

async function until(check, label, timeoutMs = 60_000, diagnose = async () => null) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}; diagnosis: ${JSON.stringify(await diagnose())}`);
}

/**
 * The catalog, store and durable provider one test shares among its
 * workers. duroxide-node has no way to close a provider, so its pool stays
 * open until the provider is collected; a test that needs several workers
 * runs them all on one base instead of opening a pool per worker.
 */
async function baseOf(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    return { catalog, store: catalog.workflowStore(), provider, client: new Client(provider) };
}

/** A worker-equivalent registration with one activity wrapped by `wrap` (and, optionally, its store wrapped by `wrapStore`). */
async function harness(env, wrap, { wrapStore, runtimeOptions, base: shared, ...options } = {}) {
    const base = shared ?? await baseOf(env);
    const { catalog, store, provider, client } = base;
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error", ...runtimeOptions });
    const registrar = {
        registerActivity: (name, fn) => runtime.registerActivity(name, wrap[name] ? wrap[name](fn) : fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    };
    registerWorkflowV2(registrar, {
        store: wrapStore ? wrapStore(store) : store,
        catalog,
        enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows have no parent."); },
        deleteSession: async (sessionId) => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
        ...options,
    });
    await runtime.start();
    let running = true;
    return {
        store, client, base,
        host: { catalog, store, duroxideClient: client },
        /** Stop this worker's runtime (as if the worker died); the shared store stays open for work it abandoned. */
        async stopRuntime() {
            if (!running) return;
            running = false;
            await runtime.shutdown(100);
        },
        /** Stop the runtime, and close the catalog unless another test part shares it. */
        async stop() {
            await this.stopRuntime();
            if (!shared) await catalog.close();
        },
    };
}

/** A loopback server that counts the external effects scripts attempt. */
async function probeServer() {
    const hits = [];
    const server = createServer((req, res) => {
        hits.push(req.url);
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        count: (path) => hits.filter(hit => hit === path).length,
        close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
    };
}

/** A gate the test opens; `reached` resolves when code arrives at it. */
function gate() {
    let arrive, open;
    const reached = new Promise(resolve => { arrive = resolve; });
    const opened = new Promise(resolve => { open = resolve; });
    return { reached, arrive: () => arrive(), wait: () => opened, open: () => open() };
}

/** The production finalize schedule (runtime.ts): nine durable delays between ten batches, about 29 minutes. */
const PRODUCTION_FINALIZE_DELAYS_MS = [1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 600_000];

/**
 * Compress the controller's finalize schedule in time only (fault injection): each of its nine delays becomes
 * `delayMs`, so a delivery that always fails still runs ten batches of the store retry policy's five attempts (50), in
 * seconds instead of about 29 minutes. It first checks that the schedule is the production one, so no earlier test
 * left it changed. The returned restore puts the production values back and checks them; call it after every runtime
 * of the test stopped. This changes the module that the test's runtime runs; the tests of this file run one at a time.
 */
function compressFinalizeSchedule(delayMs) {
    expect([...WORKFLOW_V2_FINALIZE_DELAYS_MS]).toEqual(PRODUCTION_FINALIZE_DELAYS_MS);
    WORKFLOW_V2_FINALIZE_DELAYS_MS.fill(delayMs);
    return () => {
        WORKFLOW_V2_FINALIZE_DELAYS_MS.splice(0, WORKFLOW_V2_FINALIZE_DELAYS_MS.length, ...PRODUCTION_FINALIZE_DELAYS_MS);
        expect([...WORKFLOW_V2_FINALIZE_DELAYS_MS]).toEqual(PRODUCTION_FINALIZE_DELAYS_MS);
    };
}

/** An operation receipt's stored row, as stored: kind, request hash, receipt text and creation time. */
async function receiptRow(db, schema, workflowId, operationId) {
    return (await db.query(`SELECT kind, request_sha256, receipt, created_at FROM "${schema}".workflow_operations
        WHERE workflow_session_id = $1 AND operation_id = $2`, [workflowId, operationId])).rows;
}

/** The parent notifications a workflow recorded: [event type, run id]. */
async function notificationsOf(h, workflowId) {
    return (await h.host.catalog.getSessionEvents(workflowId, 0, 50, ["workflow.parent_notified", "workflow.parent_notification_skipped"]))
        .map(event => [event.eventType, event.data.runId]);
}

/** Start a workflow with `yaml` that tells `parentId` its runs' ends; with `dispatch: false` its controller is not started. */
async function notifying(h, parentId, yaml, { dispatch = true } = {}) {
    const id = randomUUID();
    const host = dispatch ? h.host : { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async () => undefined } };
    const created = await createWorkflowV2(host, { workflowSessionId: id, parentSessionId: parentId, yaml, notifyParent: true,
        actor: ACTOR, operationId: "start", start: { inputs: {} } });
    return { id, ...created.receipt.run };
}

/** End a SLOW run's controller (terminated) and recover it as its parent: the run ends failed and the notifier starts. */
async function recoverEnded(h, parentId, run) {
    await until(async () => (await h.store.listNodeExecutions(run.runId))[0]?.effectAttempts >= 1, "the script to start");
    await h.client.cancelInstance(run.controllerInstanceId, "terminated by the test");
    await until(async () => (await h.client.getStatus(run.controllerInstanceId)).status === "Failed", "the controller to end");
    const recovered = JSON.parse(await updateWorkflowFromTool({ workflow_id: run.id, operation: "recover", operation_id: "recover" },
        { callerSessionId: parentId, host: h.host }));
    expect(recovered, JSON.stringify(recovered)).toMatchObject({ ok: true, replayed: false, action: "ended", status: "failed" });
}

async function finished(h, runId, timeoutMs) {
    return until(async () => {
        const run = await h.store.readRun(runId);
        return run && ["completed", "failed", "cancelled"].includes(run.status) ? run : null;
    }, `run ${runId} to finish`, timeoutMs, async () => {
        const run = await h.store.readRun(runId);
        const status = run ? await h.client.getStatus(run.controllerInstanceId) : null;
        return { runStatus: run?.status ?? null, orchestration: status && { status: status.status, error: status.error ?? null } };
    });
}

describe("workflow v2 fault boundaries on the real runtime", () => {
    it("finishes from stored results when every wake is lost (backstop collection)", { timeout: TIMEOUT }, async () => {
        let dropped = 0;
        const h = await harness(getEnv(), {
            // The effect stored its result; its wake never reaches the controller.
            [WORKFLOW_V2_ACTIVITIES.wake]: () => async () => { dropped += 1; return { woke: false }; },
        });
        try {
            const id = randomUUID();
            const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: null, yaml: TWO_STEPS,
                actor: ACTOR, operationId: "start", start: { inputs: {} } });
            const run = await finished(h, created.receipt.run.runId, 60_000);
            expect(run.status, JSON.stringify(run.terminalError)).toBe("completed");
            expect(run.terminalOutput).toEqual({ n: 2 });
            expect(dropped).toBe(2);
            const nodes = await h.store.listNodeExecutions(run.runId);
            expect(nodes.map(node => [node.nodeId, node.state, node.winner])).toEqual([
                ["first", "completed", "effect"], ["second", "completed", "effect"], ["done", "completed", "controller"],
            ]);
            const status = await h.client.waitForOrchestration(created.receipt.run.controllerInstanceId, 30_000);
            expect(status.status, JSON.stringify(status)).toBe("Completed");
        } finally { await h.stop(); }
    });

    it("fails a script state whose effect orchestration ended without storing a result", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv(), {}, { livenessIntervalMs: 120_000 });
        try {
            const created = await createWorkflowV2(h.host, { workflowSessionId: randomUUID(), parentSessionId: null, yaml: CAUGHT,
                actor: ACTOR, operationId: "start", start: { inputs: {} } });
            const runId = created.receipt.run.runId;
            const node = await until(async () => {
                const [first] = await h.store.listNodeExecutions(runId);
                return first?.effectAttempts >= 1 ? first : null;
            }, "the script to start");
            // Terminate the effect (as an operator or a lost record activity would leave it): no result is stored.
            await h.client.cancelInstance(workflowEffectInstanceId(node.nodeExecutionId), "terminated by the test");
            const run = await finished(h, runId, 30_000);
            expect(run.status, JSON.stringify(run)).toBe("completed");
            expect(run.terminalOutcome).toBe("blocked");
            expect(run.terminalOutput).toMatchObject({ code: "execution_failed", details: { effectStatus: "Failed" } });
            const stored = await h.store.readNodeExecution(node.nodeExecutionId);
            expect(stored).toMatchObject({ state: "completed", outcome: "execution_failed", winner: "controller" });
        } finally { await h.stop(); }
    });

    it("still asks the effect to stop when the cancel activity is retried after its commit", { timeout: TIMEOUT }, async () => {
        let executions = 0;
        // The script's own liveness check is slowed past the test window, so
        // only the cancel activity's stop request can end the effect early.
        const h = await harness(getEnv(), {
            // First execution: the cancellation commits, then the activity fails
            // before any stop request (a crash at that boundary). Retries run normally.
            [WORKFLOW_V2_ACTIVITIES.cancel]: (fn) => async (ctx, input) => {
                executions += 1;
                if (executions > 1) return fn(ctx, input);
                const crashing = Object.create(ctx);
                crashing.getClient = () => ({
                    getStatus: async () => { throw new Error("injected crash after the cancellation commit"); },
                    cancelInstance: async () => { throw new Error("unreachable"); },
                });
                return fn(crashing, input);
            },
        }, { livenessIntervalMs: 120_000 });
        try {
            const id = randomUUID();
            const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: null, yaml: SLOW,
                actor: ACTOR, operationId: "start", start: { inputs: {} } });
            const runId = created.receipt.run.runId;
            const node = await until(async () => {
                const [first] = await h.store.listNodeExecutions(runId);
                return first?.effectAttempts >= 1 ? first : null;
            }, "the script to start");
            await h.client.enqueueEvent(created.receipt.run.controllerInstanceId, "messages",
                JSON.stringify({ type: "cmd", cmd: "cancel", id: "cancel-1", args: { reason: "fault test" } }));
            const run = await finished(h, runId, 30_000);
            expect(run.status).toBe("cancelled");
            // The script sleeps 90 s; only a stop request ends its effect this early.
            const effect = await until(async () => {
                const status = await h.client.getStatus(workflowEffectInstanceId(node.nodeExecutionId));
                return status.status !== "Running" ? status : null;
            }, "the effect to stop", 30_000);
            expect(effect.status).not.toBe("NotFound");
            expect(executions).toBeGreaterThanOrEqual(2);
            const stored = await h.store.readNodeExecution(node.nodeExecutionId);
            expect(stored).toMatchObject({ state: "completed", outcome: "cancelled", winner: "cancel" });
        } finally { await h.stop(); }
    });

    it("starts no script once a deletion commits before its entry, even while its effect prepares it", { timeout: TIMEOUT }, async () => {
        const probe = await probeServer();
        let current = null;
        // The effect waits here after it read its node and before its entry.
        const h = await harness(getEnv(), {}, {
            resolveToolBinding: async () => {
                const waiting = current;
                if (waiting) { waiting.arrive(); await waiting.wait(); }
                return null;
            },
        });
        const yaml = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: entry-probe, version: "1.0.0" }
initial: act
states:
  act:
    type: script
    source: |
      await fetch("${probe.url}/start");
      await setResult("ok", {});
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded }
`;
        try {
            // Positive control: the same pause without a deletion; the script then starts and finishes.
            current = gate();
            const control = await createWorkflowV2(h.host, { workflowSessionId: randomUUID(), parentSessionId: null, yaml,
                actor: ACTOR, operationId: "control", start: { inputs: {} } });
            await current.reached;
            expect(probe.count("/start")).toBe(0);
            current.open();
            const controlRun = await finished(h, control.receipt.run.runId, 60_000);
            expect(controlRun.status, JSON.stringify(controlRun)).toBe("completed");
            expect(probe.count("/start")).toBe(1);
            const [controlNode] = await h.store.listNodeExecutions(controlRun.runId);
            expect(controlNode.effectAttempts).toBe(1);

            // The deletion commits (softDeleteSession returns after its commit) while the effect waits.
            current = gate();
            const id = randomUUID();
            const started = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: null, yaml,
                actor: ACTOR, operationId: "deleted", start: { inputs: {} } });
            await current.reached;
            const [node] = await h.store.listNodeExecutions(started.receipt.run.runId);
            expect(node).toMatchObject({ state: "pending", effectAttempts: 0 });
            await h.host.catalog.softDeleteSession(id);
            current.open();
            const effect = await h.client.waitForOrchestration(workflowEffectInstanceId(node.nodeExecutionId), 30_000);
            expect(effect.status, JSON.stringify(effect)).toBe("Completed");
            expect(probe.count("/start")).toBe(1);
            expect(await h.store.readNodeExecution(node.nodeExecutionId)).toMatchObject({
                state: "completed", outcome: "cancelled", winner: "delete", effectAttempts: 0,
            });
            expect((await h.store.readRun(started.receipt.run.runId)).status).toBe("cancelled");
            expect((await h.store.readDefinition(id)).state).toBe("deleted");
        } finally {
            current?.open();
            await h.stop();
            await probe.close();
        }
    });

    it("ends a run as failed with its cause when its IR cannot be read, even after the first finish attempts fail", { timeout: 240_000 }, async () => {
        let blocked = null;
        let failedFinishes = 0;
        const h = await harness(getEnv(), {
            // The first five failure finishes fail: one whole attempt of the store retry policy.
            [WORKFLOW_V2_ACTIVITIES.finish]: (fn) => async (ctx, input) => {
                if (input?.failure && failedFinishes < 5) { failedFinishes += 1; throw new Error("injected store fault while finishing"); }
                return fn(ctx, input);
            },
        }, {
            // The pinned IR of the blocked workflow cannot be read (as if its stored IR were damaged).
            wrapStore: (store) => {
                const faulty = Object.create(store);
                faulty.readRevisionIr = async (workflowSessionId, ...rest) => {
                    if (workflowSessionId === blocked) throw new Error("injected IR read fault");
                    return store.readRevisionIr(workflowSessionId, ...rest);
                };
                return faulty;
            },
        });
        try {
            blocked = randomUUID();
            const created = await createWorkflowV2(h.host, { workflowSessionId: blocked, parentSessionId: null, yaml: TWO_STEPS,
                actor: ACTOR, operationId: "start", start: { inputs: {} } });
            const run = await finished(h, created.receipt.run.runId, 200_000);
            expect(run.status, JSON.stringify(run)).toBe("failed");
            expect(run.terminalError).toMatchObject({ code: "controller_error" });
            expect(run.terminalError.message).toContain("injected IR read fault");
            expect(failedFinishes).toBe(5);
            const controller = await h.client.waitForOrchestration(created.receipt.run.controllerInstanceId, 30_000);
            expect(controller.status, JSON.stringify(controller)).toBe("Completed");
            expect(await h.store.listNodeExecutions(run.runId)).toEqual([]);
            const events = await h.host.catalog.getSessionEvents(blocked, 0, 50, ["workflow.failed"]);
            expect(events).toHaveLength(1);
            expect(events[0].data).toMatchObject({ runId: run.runId, name: "two-steps" });
        } finally { await h.stop(); }
    });

    it("ends a run as failed when its controller starts with input it cannot parse", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv(), {});
        try {
            // Admit the run without dispatching it, then start its controller with damaged input that still names the run.
            const undispatched = { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async () => undefined } };
            const id = randomUUID();
            const created = await createWorkflowV2(undispatched, { workflowSessionId: id, parentSessionId: null, yaml: TWO_STEPS,
                actor: ACTOR, operationId: "start", start: { inputs: {} } });
            const { runId, controllerInstanceId } = created.receipt.run;
            expect((await h.store.readRun(runId)).status).toBe("admitted");
            await h.client.startOrchestrationVersioned(controllerInstanceId, WORKFLOW_V2_CONTROLLER_NAME,
                { v: 1, workflowSessionId: id, runId }, WORKFLOW_V2_CONTROLLER_VERSION);
            const run = await finished(h, runId, 60_000);
            expect(run.status).toBe("failed");
            expect(run.terminalError).toMatchObject({ code: "controller_error" });
            expect(run.terminalError.message).toContain("controller input is invalid");
            const controller = await h.client.waitForOrchestration(controllerInstanceId, 30_000);
            expect(controller.status, JSON.stringify(controller)).toBe("Completed");
        } finally { await h.stop(); }
    });

    it("shows a run whose controller can no longer end it without changing it, and recovers it only on request", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv(), {});
        try {
            const parentId = randomUUID();
            await h.host.catalog.createSession(parentId, {});
            const context = { callerSessionId: parentId, host: h.host };
            const read = async (id) => JSON.parse(await readWorkflowFromTool({ workflow_id: id }, context));
            const recover = async (id, operationId) => JSON.parse(await updateWorkflowFromTool({ workflow_id: id, operation: "recover", operation_id: operationId }, context));

            // A terminated controller: reading shows it and changes nothing; recover ends the run.
            const slowId = randomUUID();
            const slow = await createWorkflowV2(h.host, { workflowSessionId: slowId, parentSessionId: parentId, yaml: SLOW,
                actor: ACTOR, operationId: "start", start: { inputs: {} } });
            const node = await until(async () => {
                const [first] = await h.store.listNodeExecutions(slow.receipt.run.runId);
                return first?.effectAttempts >= 1 ? first : null;
            }, "the script to start");
            await h.client.cancelInstance(slow.receipt.run.controllerInstanceId, "terminated by the test");
            await until(async () => (await h.client.getStatus(slow.receipt.run.controllerInstanceId)).status === "Failed", "the controller to end");
            for (let read_ = 0; read_ < 2; read_ += 1) {
                const view = await read(slowId);
                expect(view.ok, JSON.stringify(view)).toBe(true);
                expect(view.run).toMatchObject({ status: "running", controller: { status: "Failed", needsRecovery: true } });
            }
            expect((await h.store.readRun(slow.receipt.run.runId)).status).toBe("running");
            expect(await h.store.readNodeExecution(node.nodeExecutionId)).toMatchObject({ state: "pending" });
            const recovered = await recover(slowId, "recover-1");
            expect(recovered, JSON.stringify(recovered)).toMatchObject({ ok: true, action: "ended", status: "failed", controller: { status: "Failed", needsRecovery: true } });
            const ended = await h.store.readRun(slow.receipt.run.runId);
            expect(ended.terminalError).toMatchObject({ code: "controller_ended", details: { controllerStatus: "Failed", requestedBy: parentId } });
            expect(await h.store.readNodeExecution(node.nodeExecutionId)).toMatchObject({ state: "completed", outcome: "cancelled", winner: "controller" });
            expect(await recover(slowId, "recover-2")).toMatchObject({ ok: true, action: "none", status: "failed" });
            expect((await read(slowId)).run.controller).toBeUndefined();
            // The running script stops through its liveness check.
            const effect = await h.client.waitForOrchestration(workflowEffectInstanceId(node.nodeExecutionId), 30_000);
            expect(effect.status, JSON.stringify(effect)).toBe("Completed");

            // An admitted run whose dispatch was lost: reading shows it; recover starts it, and it runs to its end.
            const lostId = randomUUID();
            const undispatched = { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async () => undefined } };
            const lost = await createWorkflowV2(undispatched, { workflowSessionId: lostId, parentSessionId: parentId, yaml: TWO_STEPS,
                actor: ACTOR, operationId: "start", start: { inputs: {} } });
            expect((await read(lostId)).run).toMatchObject({ status: "admitted", controller: { status: "NotFound", needsRecovery: true } });
            expect((await h.client.getStatus(lost.receipt.run.controllerInstanceId)).status).toBe("NotFound");
            expect(await recover(lostId, "recover-lost")).toMatchObject({ ok: true, action: "dispatched", status: "admitted" });
            const run = await finished(h, lost.receipt.run.runId, 60_000);
            expect(run.status, JSON.stringify(run)).toBe("completed");
            expect(run.terminalOutput).toEqual({ n: 2 });
            const recoveredEvents = await h.host.catalog.getSessionEvents(lostId, 0, 50, ["workflow.recovered"]);
            expect(recoveredEvents.map(event => event.data)).toEqual([{ runId: run.runId, action: "dispatched", requestedBy: parentId, operationId: "recover-lost" }]);

            // Only the parent may recover.
            const stranger = JSON.parse(await updateWorkflowFromTool({ workflow_id: slowId, operation: "recover", operation_id: "x" },
                { callerSessionId: randomUUID(), host: h.host }));
            expect(stranger).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
            expect((await h.store.readRun(lost.receipt.run.runId)).status).toBe("completed");
        } finally { await h.stop(); }
    });

    it("fails a controller instance of each pre-release version visibly, and recover ends its run", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv(), {});
        try {
            const parentId = randomUUID();
            await h.host.catalog.createSession(parentId, {});
            const context = { callerSessionId: parentId, host: h.host };
            const undispatched = { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async () => undefined } };
            // 1.4.0 to 1.7.0 are fenced too: no test replays a history an earlier build wrote.
            for (const version of ["1.1.0", "1.4.0", "1.5.0", "1.6.0", "1.7.0"]) {
                const id = randomUUID();
                const created = await createWorkflowV2(undispatched, { workflowSessionId: id, parentSessionId: parentId, yaml: TWO_STEPS,
                    actor: ACTOR, operationId: "start", start: { inputs: {} } });
                const { runId, controllerInstanceId } = created.receipt.run;
                // As a pre-release build would have started it.
                await h.client.startOrchestrationVersioned(controllerInstanceId, WORKFLOW_V2_CONTROLLER_NAME, { v: 2, workflowSessionId: id, runId }, version);
                const failed = await until(async () => {
                    const status = await h.client.getStatus(controllerInstanceId);
                    return status.status === "Failed" ? status : null;
                }, `the pre-release ${version} controller to fail`);
                expect(failed.error).toContain(`version ${version}, written by a pre-release build`);
                expect((await h.store.readRun(runId)).status, version).toBe("admitted");
                expect(await h.store.listNodeExecutions(runId)).toEqual([]);
                const view = JSON.parse(await readWorkflowFromTool({ workflow_id: id }, context));
                expect(view.run, version).toMatchObject({ status: "admitted", controller: { status: "Failed", needsRecovery: true } });
                expect(view.run.controller.error).toContain("pre-release build");
                const recovered = JSON.parse(await updateWorkflowFromTool({ workflow_id: id, operation: "recover", operation_id: "recover" }, context));
                expect(recovered, version).toMatchObject({ ok: true, action: "ended", status: "failed" });
                const run = await h.store.readRun(runId);
                expect(run.terminalError).toMatchObject({ code: "controller_ended", details: { controllerStatus: "Failed" } });
                expect(run.terminalError.details.controllerError).toContain(`version ${version}, written by a pre-release build`);
            }
        } finally { await h.stop(); }
    });

    it("carries a pending state across continue-as-new without admitting or starting it again", { timeout: TIMEOUT }, async () => {
        // A 100 ms backstop makes 50 idle waits (the continue-as-new bound) pass while the script still runs.
        const h = await harness(getEnv(), {}, { wakeBackstopMs: 100 });
        try {
            const yaml = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: long-wait, version: "1.0.0" }
initial: wait
states:
  wait:
    type: script
    source: |
      await new Promise(resolve => setTimeout(resolve, 12_000));
      await setResult("ok", { waited: true });
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
`;
            const created = await createWorkflowV2(h.host, { workflowSessionId: randomUUID(), parentSessionId: null, yaml,
                actor: ACTOR, operationId: "start", start: { inputs: {} } });
            const { runId, controllerInstanceId } = created.receipt.run;
            const executions = await until(async () => {
                const ids = await h.client.listExecutions(controllerInstanceId);
                const [node] = await h.store.listNodeExecutions(runId);
                return ids.length >= 2 && node?.state === "pending" ? ids : null;
            }, "continue-as-new while the script runs", 30_000);
            expect(executions.length).toBeGreaterThanOrEqual(2);
            const run = await finished(h, runId, 60_000);
            expect(run.status, JSON.stringify(run)).toBe("completed");
            expect(run.terminalOutput).toEqual({ waited: true });
            const nodes = await h.store.listNodeExecutions(runId);
            expect(nodes.map(node => [node.nodeId, node.ordinal, node.effectAttempts, node.winner])).toEqual([
                ["wait", 1, 1, "effect"], ["done", 1, 0, "controller"],
            ]);
            expect(await h.client.listExecutions(workflowEffectInstanceId(nodes[0].nodeExecutionId))).toEqual([1]);
        } finally { await h.stop(); }
    });

    it("notifies the parent at least once with one stable message id when it crashes after the parent accepted the message", { timeout: TIMEOUT }, async () => {
        const sent = [];
        const h = await harness(getEnv(), {}, {
            authorizeParentNotification: async () => true,
            notifyParent: async (parentSessionId, prompt, sender, clientMessageId) => {
                sent.push({ parentSessionId, prompt, clientMessageId });
                // The parent's queue accepted the message; the activity crashes before it records that.
                if (sent.length === 1) throw new Error("injected crash after the parent enqueue");
            },
        });
        try {
            const parentId = randomUUID();
            await h.host.catalog.createSession(parentId, {});
            const id = randomUUID();
            const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parentId, yaml: TWO_STEPS,
                actor: ACTOR, operationId: "start", start: { inputs: {} } });
            const run = await finished(h, created.receipt.run.runId, 60_000);
            expect(run.status).toBe("completed");
            await h.client.waitForOrchestration(created.receipt.run.controllerInstanceId, 30_000);
            expect(sent).toHaveLength(2);
            expect(sent[1]).toEqual(sent[0]);
            expect(sent[0]).toMatchObject({ parentSessionId: parentId, clientMessageId: `workflow:${id}:${run.runId}:terminal` });
            const recorded = await h.host.catalog.getSessionEvents(id, 0, 50, ["workflow.parent_notified"]);
            expect(recorded).toHaveLength(1);
        } finally { await h.stop(); }
    });

    it("takes a cancel that arrives after a result's wake before it admits the next state", { timeout: TIMEOUT }, async () => {
        let target = null;
        let cancels = 0;
        const h = await harness(getEnv(), {
            // When the collection returns the first state's stored result (its wake was already read),
            // the parent's cancel reaches the queue: wake first, cancel second.
            [WORKFLOW_V2_ACTIVITIES.collect]: (fn) => async (ctx, input) => {
                const rows = await fn(ctx, input);
                if (target && rows.length > 0 && cancels === 0) {
                    cancels += 1;
                    await h.client.enqueueEvent(target, "messages", JSON.stringify({ type: "cmd", cmd: "cancel", id: "cancel-behind-wake", args: { reason: "after the wake" } }));
                }
                return rows;
            },
        });
        try {
            const yaml = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: cancel-behind-wake, version: "1.0.0" }
initial: first
states:
  first:
    type: script
    source: |
      await setResult("ok", { n: 1 });
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
`;
            const id = randomUUID();
            target = `session-${id}`;
            const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: null, yaml,
                actor: ACTOR, operationId: "start", start: { inputs: {} } });
            const run = await finished(h, created.receipt.run.runId, 60_000);
            expect(cancels).toBe(1);
            expect(run.status, JSON.stringify(run)).toBe("cancelled");
            expect(run.terminalError).toMatchObject({ code: "cancelled", message: "after the wake" });
            // The first state's result stands; the terminal state was never admitted.
            const nodes = await h.store.listNodeExecutions(run.runId);
            expect(nodes.map(node => [node.nodeId, node.state, node.winner])).toEqual([["first", "completed", "effect"]]);
        } finally { await h.stop(); }
    });

    it("takes a queued cancel within one step of a long chain of states that complete at admission", { timeout: TIMEOUT }, async () => {
        let target = null;
        let entered = 0;
        const h = await harness(getEnv(), {
            [WORKFLOW_V2_ACTIVITIES.enter]: (fn) => async (ctx, input) => {
                entered += 1;
                if (target && entered === 30) {
                    await h.client.enqueueEvent(target, "messages", JSON.stringify({ type: "cmd", cmd: "cancel", id: "cancel-in-chain", args: { reason: "during the chain" } }));
                }
                return fn(ctx, input);
            },
        });
        try {
            // Every admission of 'spin' fails its input contract at once (no script runs) and routes back to it.
            const yaml = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: immediate-chain, version: "1.0.0" }
initialInput: { n: 1 }
limits: { maxNodeExecutions: 400 }
initial: spin
states:
  spin:
    type: script
    inputSchema: { type: string }
    source: |
      await setResult("ok", {});
    transition: { next: { ok: done, invalid_input: spin } }
  done: { type: terminal, outcome: succeeded }
`;
            const id = randomUUID();
            target = `session-${id}`;
            const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: null, yaml,
                actor: ACTOR, operationId: "start", start: { inputs: {} } });
            const run = await finished(h, created.receipt.run.runId, 90_000);
            expect(run.status, JSON.stringify(run)).toBe("cancelled");
            expect(run.terminalError).toMatchObject({ code: "cancelled", message: "during the chain" });
            const nodes = await h.store.listNodeExecutions(run.runId, 500);
            expect(nodes.length).toBeGreaterThanOrEqual(30);
            expect(nodes.length).toBeLessThanOrEqual(31);
            expect(nodes.every(node => node.nodeId === "spin" && node.outcome === "invalid_input" && node.winner === "controller")).toBe(true);
        } finally { await h.stop(); }
    });

    it("notifies the parent when a recover ends a run whose controller ended, and keeps each recover request's receipt", { timeout: TIMEOUT }, async () => {
        const sent = [];
        const h = await harness(getEnv(), {}, {
            authorizeParentNotification: async () => true,
            notifyParent: async (parentSessionId, prompt, sender, clientMessageId) => { sent.push({ parentSessionId, prompt, clientMessageId }); },
        });
        try {
            const parentId = randomUUID();
            await h.host.catalog.createSession(parentId, {});
            const id = randomUUID();
            const context = { callerSessionId: parentId, host: h.host };
            const recover = async (operationId) => JSON.parse(await updateWorkflowFromTool({ workflow_id: id, operation: "recover", operation_id: operationId }, context));
            const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parentId, yaml: SLOW, notifyParent: true,
                actor: ACTOR, operationId: "start", start: { inputs: {} } });
            const { runId, controllerInstanceId } = created.receipt.run;
            await until(async () => (await h.store.listNodeExecutions(runId))[0]?.effectAttempts >= 1, "the script to start");
            await h.client.cancelInstance(controllerInstanceId, "terminated by the test");
            await until(async () => (await h.client.getStatus(controllerInstanceId)).status === "Failed", "the controller to end");
            expect(sent).toEqual([]);

            const first = await recover("recover-1");
            expect(first, JSON.stringify(first)).toMatchObject({ ok: true, replayed: false, runId, action: "ended", status: "failed" });
            const notifier = await h.client.waitForOrchestration(workflowNotifyInstanceId(runId), 30_000);
            expect(notifier.status, JSON.stringify(notifier)).toBe("Completed");
            expect(sent).toHaveLength(1);
            expect(sent[0]).toMatchObject({ parentSessionId: parentId, clientMessageId: `workflow:${id}:${runId}:terminal` });
            expect(sent[0].prompt).toContain('"status":"failed"');
            expect(sent[0].prompt).toContain("controller_ended");

            // Repeating a request returns its receipt; a new request finds nothing to do; neither notifies again.
            expect(await recover("recover-1")).toEqual({ ...first, replayed: true });
            expect(await recover("recover-2")).toMatchObject({ ok: true, replayed: false, action: "none", status: "failed" });
            expect(await recover("recover-2")).toMatchObject({ ok: true, replayed: true, action: "none", status: "failed" });
            // An operation id that another request used is refused.
            expect(await recover("start")).toMatchObject({ ok: false, error: { code: "OPERATION_CONFLICT" } });
            expect((await h.client.waitForOrchestration(workflowNotifyInstanceId(runId), 30_000)).status).toBe("Completed");
            expect(sent).toHaveLength(1);
            expect(await h.host.catalog.getSessionEvents(id, 0, 50, ["workflow.parent_notified"])).toHaveLength(1);
            expect(await h.store.readRun(runId)).toMatchObject({ status: "failed", terminalError: { code: "controller_ended" } });
        } finally { await h.stop(); }
    });

    it("records a skip and completes when a delivery finds the parent's authority gone: the controller's own report and the notifier", { timeout: TIMEOUT }, async () => {
        const sent = [];
        const revoked = new Set();
        const h = await harness(getEnv(), {}, {
            authorizeParentNotification: async (workflowSessionId, parentSessionId) => !revoked.has(parentSessionId),
            notifyParent: async (parentSessionId, prompt, sender, clientMessageId) => { sent.push({ parentSessionId, clientMessageId }); },
        });
        /** The skips a workflow recorded, as stored. */
        const skipsOf = async workflowId => (await h.host.catalog.getSessionEvents(workflowId, 0, 50, ["workflow.parent_notification_skipped"]))
            .map(event => event.data);
        // Batch 7 (n-2): the reason is said in plain words.
        const skip = runId => ({ runId, reason: "parent is gone" });
        try {
            const parentId = randomUUID();
            await h.host.catalog.createSession(parentId, {});
            revoked.add(parentId);
            // The controller's own report: the run completes; the delivery records a skip and returns; the controller
            // completes; the run stays as it ended.
            const done = await notifying(h, parentId, TWO_STEPS);
            const doneEnded = await finished(h, done.runId, 60_000);
            expect(doneEnded).toMatchObject({ status: "completed", terminalOutput: { n: 2 } });
            const doneController = await h.client.waitForOrchestration(done.controllerInstanceId, 30_000);
            expect(doneController.status, JSON.stringify(doneController)).toBe("Completed");
            expect(doneController.output).toEqual({ runId: done.runId, status: "completed", outcome: "succeeded" });
            expect(await notificationsOf(h, done.id)).toEqual([["workflow.parent_notification_skipped", done.runId]]);
            expect(await skipsOf(done.id)).toEqual([skip(done.runId)]);
            expect(await h.store.readRun(done.runId)).toEqual(doneEnded);
            // The notifier, started by a recover: its delivery records a skip, and it completes; it does not fail. The
            // run stays as the recover ended it.
            const slow = await notifying(h, parentId, SLOW);
            await recoverEnded(h, parentId, slow);
            const failedRun = await h.store.readRun(slow.runId);
            expect(failedRun).toMatchObject({ status: "failed", terminalError: { code: "controller_ended" } });
            const notifier = await h.client.waitForOrchestration(workflowNotifyInstanceId(slow.runId), 30_000);
            expect(notifier.status, JSON.stringify(notifier)).toBe("Completed");
            expect(notifier.output ?? null).toBeNull();
            expect(await notificationsOf(h, slow.id)).toEqual([["workflow.parent_notification_skipped", slow.runId]]);
            expect(await skipsOf(slow.id)).toEqual([skip(slow.runId)]);
            expect(await h.store.readRun(slow.runId)).toEqual(failedRun);
            expect(sent).toEqual([]);

            // With the parent's authority back, a later notification of either run (another notifier instance) finds
            // that run's skip and tells no one.
            revoked.delete(parentId);
            for (const run of [done, slow]) {
                const again = `wfn-again-${run.runId}`;
                await h.client.startOrchestrationVersioned(again, WORKFLOW_V2_NOTIFY_NAME, { runId: run.runId }, WORKFLOW_V2_NOTIFY_VERSION);
                const repeated = await h.client.waitForOrchestration(again, 30_000);
                expect(repeated.status, JSON.stringify(repeated)).toBe("Completed");
                expect(await notificationsOf(h, run.id)).toEqual([["workflow.parent_notification_skipped", run.runId]]);
                expect(await skipsOf(run.id)).toEqual([skip(run.runId)]);
            }
            expect(sent).toEqual([]);

            // Control: with the parent's authority back, a new run's report is delivered once, with the stable client
            // message id, and its controller completes with the run's result.
            const told = await notifying(h, parentId, TWO_STEPS);
            await finished(h, told.runId, 60_000);
            const toldController = await h.client.waitForOrchestration(told.controllerInstanceId, 30_000);
            expect(toldController.status, JSON.stringify(toldController)).toBe("Completed");
            expect(toldController.output).toEqual({ runId: told.runId, status: "completed", outcome: "succeeded" });
            expect(sent).toEqual([{ parentSessionId: parentId, clientMessageId: `workflow:${told.id}:${told.runId}:terminal` }]);
            expect(await notificationsOf(h, told.id)).toEqual([["workflow.parent_notified", told.runId]]);
        } finally { await h.stop(); }
    });

    it("fails the notifier when a delivery runs out, and the controller after its failure path's one more delivery runs out; the run's end is kept", { timeout: 240_000 }, async () => {
        const env = getEnv();
        const attempts = [];
        const restore = compressFinalizeSchedule(10);
        const db = new pg.Pool({ connectionString: env.store, max: 1 });
        let h = null;
        try {
            h = await harness(env, {}, {
                authorizeParentNotification: async () => true,
                notifyParent: async (parentSessionId, prompt, sender, clientMessageId) => {
                    attempts.push(clientMessageId);
                    throw new Error("injected: the parent's session does not take the message");
                },
            });
            const parentId = randomUUID();
            await h.host.catalog.createSession(parentId, {});
            // The controller's report runs out: ten batches of five attempts. Its failure path keeps the completed run
            // (the finish returns the run as it ended) and delivers once more, ten batches again: the controller fails.
            const done = await notifying(h, parentId, TWO_STEPS);
            const ended = await finished(h, done.runId, 60_000);
            expect(ended).toMatchObject({ status: "completed", terminalOutput: { n: 2 } });
            const controller = await h.client.waitForOrchestration(done.controllerInstanceId, 150_000);
            expect(controller.status, JSON.stringify(controller)).toBe("Failed");
            expect(JSON.stringify(controller)).toContain("injected: the parent's session does not take the message");
            const doneId = `workflow:${done.id}:${done.runId}:terminal`;
            expect(attempts.filter(id => id === doneId)).toHaveLength(100);
            expect(await h.store.readRun(done.runId)).toEqual(ended);
            expect(await notificationsOf(h, done.id)).toEqual([]);

            // The notifier of a run a recover ended: its delivery runs out (ten batches of five attempts), and it fails.
            // The run's end and the recover's receipt stay as stored.
            const slow = await notifying(h, parentId, SLOW);
            await recoverEnded(h, parentId, slow);
            const failedRun = await h.store.readRun(slow.runId);
            const recoverReceipt = await receiptRow(db, env.cmsSchema, slow.id, "recover");
            expect(recoverReceipt).toHaveLength(1);
            const notifier = await h.client.waitForOrchestration(workflowNotifyInstanceId(slow.runId), 150_000);
            expect(notifier.status, JSON.stringify(notifier)).toBe("Failed");
            expect(attempts.filter(id => id === `workflow:${slow.id}:${slow.runId}:terminal`)).toHaveLength(50);
            expect(await h.store.readRun(slow.runId)).toEqual(failedRun);
            expect(failedRun).toMatchObject({ status: "failed", terminalError: { code: "controller_ended" } });
            expect(await receiptRow(db, env.cmsSchema, slow.id, "recover")).toEqual(recoverReceipt);
            expect(await notificationsOf(h, slow.id)).toEqual([]);
        } finally {
            try { if (h) await h.stop(); } finally {
                try { await db.end(); } finally { restore(); }
            }
        }
    });

    it("takes the controller's failure path when a begin's notifier start runs out: its delivery tells the parent, or runs out too; the run's end is kept", { timeout: 240_000 }, async () => {
        const sent = [];
        const beginStarts = new Map();
        const failDelivery = new Set();
        const env = getEnv();
        const restore = compressFinalizeSchedule(10);
        const db = new pg.Pool({ connectionString: env.store, max: 1 });
        let h = null;
        try {
            h = await harness(env, {
                // Fault injection: the begin activity of a run listed here cannot start the notifier (its client refuses).
                [WORKFLOW_V2_ACTIVITIES.begin]: (fn) => async (ctx, input) => {
                    if (!beginStarts.has(input?.runId)) return fn(ctx, input);
                    const refusing = Object.create(ctx);
                    refusing.getClient = () => ({
                        startOrchestrationVersioned: async () => {
                            beginStarts.set(input.runId, beginStarts.get(input.runId) + 1);
                            throw new Error("injected: the notifier start fails for good");
                        },
                    });
                    return fn(refusing, input);
                },
            }, {
                authorizeParentNotification: async () => true,
                notifyParent: async (parentSessionId, prompt, sender, clientMessageId) => {
                    sent.push({ parentSessionId, clientMessageId });
                    if (failDelivery.has(clientMessageId)) throw new Error("injected: the parent's session does not take the message");
                },
            });
            const parentId = randomUUID();
            await h.host.catalog.createSession(parentId, {});
            /**
             * A run that a system actor's cancel ended before it began, whose request stopped before it started the notifier;
             * then its controller starts late, and its begin cannot start the notifier. With `deliveryFails`, every delivery
             * of its end fails.
             */
            const cancelledBeforeBegin = async ({ deliveryFails = false } = {}) => {
                const run = await notifying(h, parentId, TWO_STEPS, { dispatch: false });
                const notifierStartFails = { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async (instanceId, ...rest) => {
                    if (instanceId === workflowNotifyInstanceId(run.runId)) throw new Error("injected: interrupted before the notifier started");
                    return h.host.duroxideClient.startOrchestrationVersioned(instanceId, ...rest);
                } } };
                await expect(controlWorkflowV2Run(notifierStartFails, run.id, { operation: "cancel", runId: null, reason: "stop it" },
                    { actor: { kind: "system", name: "workflow-v2-fault-test-user" }, operationId: "cancel-n" }))
                    .rejects.toThrow("injected: interrupted before the notifier started");
                const ended = await h.store.readRun(run.runId);
                expect(ended).toMatchObject({ status: "cancelled", terminalError: { details: { requestedBy: null, operationId: "cancel-n", beforeBegin: true } } });
                const receipt = await receiptRow(db, env.cmsSchema, run.id, "cancel-n");
                expect(receipt).toHaveLength(1);
                const clientMessageId = `workflow:${run.id}:${run.runId}:terminal`;
                if (deliveryFails) failDelivery.add(clientMessageId);
                beginStarts.set(run.runId, 0);
                await h.client.startOrchestrationVersioned(run.controllerInstanceId, WORKFLOW_V2_CONTROLLER_NAME,
                    { v: 2, workflowSessionId: run.id, runId: run.runId }, WORKFLOW_V2_CONTROLLER_VERSION);
                return { ...run, ended, receipt, clientMessageId };
            };
            /** The run and the cancel's receipt are as the cancel stored them: nothing began, and the notifier never started. */
            const unchanged = async (run) => {
                expect(await h.store.readRun(run.runId)).toEqual(run.ended);
                expect(await receiptRow(db, env.cmsSchema, run.id, "cancel-n")).toEqual(run.receipt);
                expect(await h.store.listNodeExecutions(run.runId)).toEqual([]);
                expect(await h.host.catalog.getSessionEvents(run.id, 0, 50, ["workflow.started"])).toEqual([]);
                expect((await h.client.getStatus(workflowNotifyInstanceId(run.runId))).status).toBe("NotFound");
            };

            // The begin activity runs out its five attempts; the controller's failure path keeps the cancelled run and
            // delivers: the parent is told once, and the controller completes with the run's cancelled result.
            const told = await cancelledBeforeBegin();
            const toldController = await h.client.waitForOrchestration(told.controllerInstanceId, 60_000);
            expect(toldController.status, JSON.stringify(toldController)).toBe("Completed");
            // A cancel before begin stores no outcome; the controller's result says the same, literally.
            expect(told.ended.terminalOutcome).toBeNull();
            expect(toldController.output).toEqual({ runId: told.runId, status: "cancelled", outcome: null });
            expect(beginStarts.get(told.runId)).toBe(5);
            expect(sent.filter(item => item.clientMessageId === told.clientMessageId)).toEqual([{ parentSessionId: parentId, clientMessageId: told.clientMessageId }]);
            expect(await notificationsOf(h, told.id)).toEqual([["workflow.parent_notified", told.runId]]);
            await unchanged(told);

            // The same, and the failure path's delivery runs out too (ten batches of five attempts): the controller fails.
            const lost = await cancelledBeforeBegin({ deliveryFails: true });
            const lostController = await h.client.waitForOrchestration(lost.controllerInstanceId, 150_000);
            expect(lostController.status, JSON.stringify(lostController)).toBe("Failed");
            expect(JSON.stringify(lostController)).toContain("injected: the parent's session does not take the message");
            expect(beginStarts.get(lost.runId)).toBe(5);
            expect(sent.filter(item => item.clientMessageId === lost.clientMessageId)).toHaveLength(50);
            expect(await notificationsOf(h, lost.id)).toEqual([]);
            await unchanged(lost);
        } finally {
            try { if (h) await h.stop(); } finally {
                try { await db.end(); } finally { restore(); }
            }
        }
    });

    it("refuses a read or a recover that selects a run of another workflow before it changes anything", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv(), {});
        try {
            const parentId = randomUUID();
            await h.host.catalog.createSession(parentId, {});
            const context = { callerSessionId: parentId, host: h.host };
            // Two admitted runs whose dispatch was lost: any start of their controllers would show.
            const undispatched = { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async () => undefined } };
            const lostId = randomUUID();
            const lost = await createWorkflowV2(undispatched, { workflowSessionId: lostId, parentSessionId: parentId, yaml: TWO_STEPS,
                actor: ACTOR, operationId: "start", start: { inputs: {} } });
            const otherId = randomUUID();
            const other = await createWorkflowV2(undispatched, { workflowSessionId: otherId, parentSessionId: parentId, yaml: TWO_STEPS,
                actor: ACTOR, operationId: "start", start: { inputs: {} } });
            for (const runId of [other.receipt.run.runId, "no-such-run"]) {
                const read = JSON.parse(await readWorkflowFromTool({ workflow_id: lostId, run_id: runId }, context));
                expect(read, JSON.stringify(read)).toMatchObject({ ok: false, error: { code: "RUN_NOT_FOUND" } });
                const recovered = JSON.parse(await updateWorkflowFromTool({ workflow_id: lostId, operation: "recover", operation_id: `recover-${runId}`, run_id: runId }, context));
                expect(recovered, JSON.stringify(recovered)).toMatchObject({ ok: false, error: { code: "RUN_NOT_FOUND" } });
            }
            for (const [workflowId, receipt] of [[lostId, lost.receipt], [otherId, other.receipt]]) {
                expect((await h.client.getStatus(receipt.run.controllerInstanceId)).status).toBe("NotFound");
                expect((await h.store.readRun(receipt.run.runId)).status).toBe("admitted");
                expect(await h.host.catalog.getSessionEvents(workflowId, 0, 50, ["workflow.recovered", "workflow.failed"])).toEqual([]);
            }
            // The right selection reads the run and still changes nothing.
            const view = JSON.parse(await readWorkflowFromTool({ workflow_id: lostId, run_id: lost.receipt.run.runId }, context));
            expect(view.run).toMatchObject({ runId: lost.receipt.run.runId, status: "admitted", controller: { status: "NotFound", needsRecovery: true } });
            expect((await h.client.getStatus(lost.receipt.run.controllerInstanceId)).status).toBe("NotFound");
            expect((await h.store.readRun(lost.receipt.run.runId)).status).toBe("admitted");
        } finally { await h.stop(); }
    });

    it("stores a recover's dispatch receipt before it starts the controller, so a concurrent or interrupted repeat returns it", { timeout: 180_000 }, async () => {
        const h = await harness(getEnv(), {});
        try {
            const parentId = randomUUID();
            await h.host.catalog.createSession(parentId, {});
            /** Every controller start that a recover made, through any host below. */
            const starts = [];
            const hostWith = ({ store = h.store, beforeStart = async () => undefined, afterStart = async () => undefined } = {}) => {
                const client = Object.create(h.client);
                client.startOrchestrationVersioned = async (instanceId, name, input, version) => {
                    await beforeStart();
                    await h.client.startOrchestrationVersioned(instanceId, name, input, version);
                    starts.push({ instanceId, name, input, version });
                    await afterStart();
                };
                return { ...h.host, store, duroxideClient: client };
            };
            const recover = async (host, workflowId, operationId) => JSON.parse(await updateWorkflowFromTool(
                { workflow_id: workflowId, operation: "recover", operation_id: operationId }, { callerSessionId: parentId, host }));
            const undispatched = { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async () => undefined } };
            const lostRun = async () => {
                const id = randomUUID();
                const created = await createWorkflowV2(undispatched, { workflowSessionId: id, parentSessionId: parentId, yaml: TWO_STEPS,
                    actor: ACTOR, operationId: "start", start: { inputs: {} } });
                expect((await h.client.getStatus(created.receipt.run.controllerInstanceId)).status).toBe("NotFound");
                return { id, run: created.receipt.run };
            };
            const recovered = async (id) => (await h.host.catalog.getSessionEvents(id, 0, 50, ["workflow.recovered"])).map(event => event.data);
            const completesOnce = async (lost) => {
                const run = await finished(h, lost.run.runId, 60_000);
                expect(run.status, JSON.stringify(run)).toBe("completed");
                expect(run.terminalOutput).toEqual({ n: 2 });
                expect((await h.store.listNodeExecutions(run.runId)).map(node => [node.nodeId, node.ordinal])).toEqual([["first", 1], ["second", 1], ["done", 1]]);
                expect(await h.client.listExecutions(lost.run.controllerInstanceId)).toEqual([1]);
            };

            // 1. The reviewed race: a repeat reads no receipt, the first request dispatches and the
            // controller starts, then the repeat sees no recovery to do. It returns the first receipt.
            const raced = await lostRun();
            const paused = gate();
            const pausingStore = Object.create(h.store);
            pausingStore.readOperationReceipt = async (...args) => {
                const stored = await h.store.readOperationReceipt(...args);
                if (stored === null) { paused.arrive(); await paused.wait(); }
                return stored;
            };
            const late = recover(hostWith({ store: pausingStore }), raced.id, "recover-race");
            await paused.reached;
            const first = await recover(hostWith(), raced.id, "recover-race");
            expect(first, JSON.stringify(first)).toMatchObject({ ok: true, replayed: false, action: "dispatched", status: "admitted" });
            await until(async () => (await h.client.getStatus(raced.run.controllerInstanceId)).status !== "NotFound", "the dispatched controller to start");
            paused.open();
            expect(await late).toEqual({ ...first, replayed: true });
            await completesOnce(raced);
            expect(await recovered(raced.id)).toEqual([{ runId: raced.run.runId, action: "dispatched", requestedBy: parentId, operationId: "recover-race" }]);

            // 2. Both requests decide to dispatch: the first stores its intent and pauses before its start;
            // the repeat's intent conflicts, rolls back, returns the first receipt and starts the controller.
            const both = await lostRun();
            const beforeIntent = gate();
            const intentStore = Object.create(h.store);
            intentStore.recordRecoverDispatch = async (...args) => { beforeIntent.arrive(); await beforeIntent.wait(); return h.store.recordRecoverDispatch(...args); };
            const beforeStart = gate();
            const decided = recover(hostWith({ store: intentStore }), both.id, "recover-both");
            await beforeIntent.reached;
            const owner = recover(hostWith({ beforeStart: async () => { beforeStart.arrive(); await beforeStart.wait(); } }), both.id, "recover-both");
            await beforeStart.reached;
            expect(await recovered(both.id)).toHaveLength(1);
            beforeIntent.open();
            const repeat = await decided;
            expect(repeat, JSON.stringify(repeat)).toMatchObject({ ok: true, replayed: true, action: "dispatched", status: "admitted" });
            beforeStart.open();
            expect(await owner).toEqual({ ...repeat, replayed: false });
            await completesOnce(both);
            expect(await recovered(both.id)).toEqual([{ runId: both.run.runId, action: "dispatched", requestedBy: parentId, operationId: "recover-both" }]);

            // 3. Interrupted after the intent and before the start: nothing started; a repeat starts it.
            const crashed = await lostRun();
            const failedStart = await recover(hostWith({ beforeStart: async () => { throw new Error("injected crash before the controller start"); } }),
                crashed.id, "recover-crash");
            expect(failedStart).toMatchObject({ ok: false, error: { message: "injected crash before the controller start" } });
            expect((await h.client.getStatus(crashed.run.controllerInstanceId)).status).toBe("NotFound");
            expect((await h.store.readRun(crashed.run.runId)).status).toBe("admitted");
            expect(await recover(hostWith(), crashed.id, "recover-crash")).toMatchObject({ ok: true, replayed: true, action: "dispatched", status: "admitted" });
            await completesOnce(crashed);
            expect(await recovered(crashed.id)).toHaveLength(1);

            // 4. Interrupted after the start: a repeat returns the receipt; its second start is ignored.
            const interrupted = await lostRun();
            const failedReturn = await recover(hostWith({ afterStart: async () => { throw new Error("injected crash after the controller start"); } }),
                interrupted.id, "recover-after-start");
            expect(failedReturn).toMatchObject({ ok: false, error: { message: "injected crash after the controller start" } });
            expect(await recover(hostWith(), interrupted.id, "recover-after-start")).toMatchObject({ ok: true, replayed: true, action: "dispatched" });
            await completesOnce(interrupted);
            expect(await recovered(interrupted.id)).toHaveLength(1);

            // 5. An operation id that another request used is refused before anything starts.
            const conflicting = await lostRun();
            expect(await recover(hostWith(), conflicting.id, "start")).toMatchObject({ ok: false, error: { code: "OPERATION_CONFLICT" } });
            expect((await h.client.getStatus(conflicting.run.controllerInstanceId)).status).toBe("NotFound");
            expect(await recovered(conflicting.id)).toEqual([]);

            // Every start named the run's stored controller instance, controller and version.
            const runs = [raced, both, crashed, interrupted];
            expect(new Set(starts.map(start => start.instanceId))).toEqual(new Set(runs.map(lost => lost.run.controllerInstanceId)));
            for (const start of starts) {
                const lost = runs.find(item => item.run.controllerInstanceId === start.instanceId);
                expect(start.instanceId).toBe(workflowLiveControllerInstanceId(lost.id));
                expect(start).toMatchObject({ name: WORKFLOW_V2_CONTROLLER_NAME, version: WORKFLOW_V2_CONTROLLER_VERSION,
                    input: { v: 2, workflowSessionId: lost.id, runId: lost.run.runId } });
            }
        } finally { await h.stop(); }
    });

    it("runs a script once, on a healthy worker, after one and after two worker crashes inside its entry transaction", { timeout: 240_000 }, async () => {
        const probe = await probeServer();
        const yaml = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: entry-crash, version: "1.0.0" }
initial: act
states:
  act:
    type: script
    source: |
      await fetch("${probe.url}/start");
      await setResult("ok", { done: true });
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
`;
        // Every worker runs on one base (one provider pool and one catalog), as workers share one database.
        const base = await baseOf(getEnv());
        const workers = [];
        const abandoned = [];
        const crashes = [];
        // Short locks: work a stopped worker held is taken by the next worker within seconds. Whole seconds of at least 2: a
        // shorter activity lock renews no earlier than it expires (duroxide 0.1.32), so a script would run again (J3-fix2).
        const runtimeOptions = { workerLockTimeoutMs: 2_000, orchestratorLockTimeoutMs: 2_000 };
        /** A worker that crashes inside the first script entry it makes: the process started, the entry transaction rolled back. */
        const crashingWorker = async (name) => {
            let armed = true;
            const worker = await harness(getEnv(), {}, {
                base,
                runtimeOptions,
                wrapStore: (store) => {
                    const crashing = Object.create(store);
                    crashing.enterScript = async (nodeExecutionId, start) => {
                        if (!armed) return store.enterScript(nodeExecutionId, start);
                        armed = false;
                        const hits = probe.count("/start");
                        const crash = new Error("injected worker crash inside the entry transaction");
                        let thrown = null;
                        try {
                            await store.enterScript(nodeExecutionId, attempt => { start(attempt); throw crash; });
                        } catch (error) {
                            thrown = error;
                        }
                        // The started process is outside the transaction; its external effect happens anyway.
                        await until(async () => probe.count("/start") > hits, `the process of ${name}'s crashed entry to act`);
                        crashes.push({ worker: name, rolledBack: thrown === crash });
                        // The worker is gone: this entry never returns to its activity.
                        return new Promise(resolve => abandoned.push(() => resolve({ entered: false, attempt: 0 })));
                    };
                    return crashing;
                },
            });
            workers.push(worker);
            return worker;
        };
        try {
            for (const crashCount of [1, 2]) {
                crashes.length = 0;
                const hitsBefore = probe.count("/start");
                let worker = await crashingWorker("crash-1");
                const created = await createWorkflowV2(worker.host, { workflowSessionId: randomUUID(), parentSessionId: null, yaml,
                    actor: ACTOR, operationId: "start", start: { inputs: {} } });
                const runId = created.receipt.run.runId;
                for (let index = 1; index <= crashCount; index += 1) {
                    await until(async () => crashes.length === index, `crash ${index} of ${crashCount}`);
                    // The crashed entry committed nothing: no attempt, no result, and the run goes on.
                    const [node] = await worker.store.listNodeExecutions(runId);
                    expect(node).toMatchObject({ nodeId: "act", state: "pending", effectAttempts: 0, winner: null });
                    expect((await worker.store.readRun(runId)).status).toBe("running");
                    await worker.stopRuntime();
                    worker = index < crashCount ? await crashingWorker(`crash-${index + 1}`) : await harness(getEnv(), {}, { base });
                    if (index === crashCount) workers.push(worker);
                }
                const run = await finished(worker, runId, 60_000);
                expect(run.status, JSON.stringify(run)).toBe("completed");
                expect(run.terminalOutput).toEqual({ done: true });
                expect(crashes).toEqual(Array.from({ length: crashCount }, (_, index) => ({ worker: `crash-${index + 1}`, rolledBack: true })));
                const nodes = await worker.store.listNodeExecutions(runId);
                expect(nodes.map(node => [node.nodeId, node.effectAttempts, node.winner, node.outcome])).toEqual([
                    ["act", 1, "effect", "ok"], ["done", 0, "controller", "succeeded"],
                ]);
                // At least once: each crashed entry's process acted, and the committed entry acted once.
                expect(probe.count("/start") - hitsBefore).toBe(crashCount + 1);
                await worker.stopRuntime();
            }
        } finally {
            for (const worker of workers) await worker.stop();
            for (const release of abandoned) release();
            await base.catalog.close();
            await probe.close();
        }
    });

    // Verification of RT-4 (M-10): a normal terminal run whose controller is interrupted before its report owes its parent
    // the notice. That debt outlives a notifier that runs out and a recover's notifier that runs out; a repeat of a recover
    // whose notifier ended starts nothing; a new recover's notifier delivers the notice, also when its first delivery is
    // lost after the parent took it; two recovers at once deliver another run's notice once; and 60 earlier notices of the
    // workflow do not hide a run's debt. The stored run never changes.
    it("M-10: an owed run-end notice outlives notifiers that run out and is delivered once by a new recover, also by concurrent recovers and past 60 earlier notices", { timeout: 420_000 }, async () => {
        const deliveries = [];
        const control = { fail: true, loseFirst: false, hold: null };
        const restore = compressFinalizeSchedule(10);
        let h = null;
        try {
            h = await harness(getEnv(), {
                // The controller's own report waits while `hold` is set; the test ends the controller meanwhile.
                [WORKFLOW_V2_ACTIVITIES.notifyParent]: (fn) => async (ctx, input) => {
                    const hold = control.hold;
                    if (hold) {
                        hold.arrive();
                        await hold.wait();
                        throw new Error("interrupted by the test");
                    }
                    return await fn(ctx, input);
                },
            }, {
                authorizeParentNotification: async () => true,
                notifyParent: async (parentSessionId, prompt, sender, clientMessageId) => {
                    deliveries.push(clientMessageId);
                    if (control.fail) throw new Error("injected: the parent's session does not take the message");
                    if (control.loseFirst) {
                        // The parent's queue took the message; the activity fails before it records that.
                        control.loseFirst = false;
                        throw new Error("injected: lost after the parent took the message");
                    }
                },
            });
            const parentId = randomUUID();
            await h.host.catalog.createSession(parentId, {});
            const recover = async (id, operationId) => JSON.parse(await updateWorkflowFromTool({ workflow_id: id, operation: "recover", operation_id: operationId },
                { callerSessionId: parentId, host: h.host }));
            /** A completed run whose controller ends while its report waits: the run is stored as ended, and its notice is owed. */
            const interrupted = async () => {
                control.hold = gate();
                const run = await notifying(h, parentId, TWO_STEPS);
                await control.hold.reached;
                const ended = await finished(h, run.runId, 60_000);
                expect(ended).toMatchObject({ status: "completed", terminalOutput: { n: 2 } });
                await h.client.cancelInstance(run.controllerInstanceId, "terminated by the test");
                await until(async () => (await h.client.getStatus(run.controllerInstanceId)).status === "Failed", "the controller to end");
                const hold = control.hold;
                control.hold = null;
                hold.open();
                expect(await h.store.runNoticeRecorded(run.id, run.runId)).toBe(false);
                expect(await notificationsOf(h, run.id)).toEqual([]);
                return { ...run, ended, messageId: `workflow:${run.id}:${run.runId}:terminal` };
            };
            const sent = messageId => deliveries.filter(id => id === messageId).length;

            const done = await interrupted();
            const base = workflowNotifyInstanceId(done.runId);
            // A recover of the ended run changes nothing in it and starts the notifier, whose delivery runs out (ten
            // batches of five attempts). The debt stays: no notice is recorded.
            expect(await recover(done.id, "recover-1")).toMatchObject({ ok: true, replayed: false, action: "none", status: "completed" });
            expect((await h.client.waitForOrchestration(base, 150_000)).status).toBe("Failed");
            expect(sent(done.messageId)).toBe(50);
            expect(await h.store.runNoticeRecorded(done.id, done.runId)).toBe(false);
            // The repeat of that recover finds the notifier ended: it starts one of its own, which runs out too.
            expect(await recover(done.id, "recover-1")).toMatchObject({ ok: true, replayed: true, action: "none" });
            await until(async () => sent(done.messageId) >= 100 || null, "the recover's notifier to run out", 150_000);
            await new Promise(resolve => setTimeout(resolve, 1_000));
            expect(sent(done.messageId)).toBe(100);
            // A further repeat finds that notifier ended as well, and starts nothing: no delivery is attempted.
            expect(await recover(done.id, "recover-1")).toMatchObject({ ok: true, replayed: true, action: "none" });
            await new Promise(resolve => setTimeout(resolve, 1_500));
            expect(sent(done.messageId)).toBe(100);
            expect(await notificationsOf(h, done.id)).toEqual([]);
            // With the parent reachable, a new recover's notifier delivers the notice; its first delivery is lost after the
            // parent took it, and the next sends the same message id. The notice is recorded once.
            control.fail = false;
            control.loseFirst = true;
            expect(await recover(done.id, "recover-2")).toMatchObject({ ok: true, replayed: false, action: "none", status: "completed" });
            await until(async () => (await notificationsOf(h, done.id)).length > 0 || null, "the notice to be recorded", 60_000);
            expect(sent(done.messageId)).toBe(102);
            expect(await notificationsOf(h, done.id)).toEqual([["workflow.parent_notified", done.runId]]);
            expect(await h.store.readRun(done.runId)).toEqual(done.ended);
            // Recorded: neither a repeat nor a new recover delivers it again.
            expect(await recover(done.id, "recover-2")).toMatchObject({ ok: true, replayed: true });
            expect(await recover(done.id, "recover-3")).toMatchObject({ ok: true, replayed: false, action: "none" });
            await new Promise(resolve => setTimeout(resolve, 1_500));
            expect(sent(done.messageId)).toBe(102);
            expect(await notificationsOf(h, done.id)).toEqual([["workflow.parent_notified", done.runId]]);

            // Another owed notice, behind 60 earlier notices of other runs of the workflow (more than one page of 50), and two
            // recovers at once: the debt is found, and the notice is delivered and recorded once.
            const other = await interrupted();
            await h.store.recordSessionEvents(other.id, Array.from({ length: 60 }, () => ({
                eventType: "workflow.parent_notified", data: { runId: randomUUID(), parentSessionId: parentId } })));
            expect(await h.store.runNoticeRecorded(other.id, other.runId)).toBe(false);
            const [a, b] = await Promise.all([recover(other.id, "together-a"), recover(other.id, "together-b")]);
            expect([a, b]).toEqual([expect.objectContaining({ ok: true, action: "none" }), expect.objectContaining({ ok: true, action: "none" })]);
            await until(async () => (await h.store.runNoticeRecorded(other.id, other.runId)) || null, "the other notice to be recorded", 60_000);
            await new Promise(resolve => setTimeout(resolve, 1_500));
            expect(sent(other.messageId)).toBe(1);
            const told = (await h.host.catalog.getSessionEvents(other.id, 0, 200, ["workflow.parent_notified"]))
                .filter(event => event.data?.runId === other.runId);
            expect(told).toHaveLength(1);
            expect(await h.store.readRun(other.runId)).toEqual(other.ended);
        } finally {
            try { if (h) await h.stop(); } finally { restore(); }
        }
    });
});

