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
 * the command-read boundary (README "Regressions").
 */
import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { readWorkflowFromTool, updateWorkflowFromTool } from "../../src/workflow/v2/tools.ts";
import {
    registerWorkflowV2, WORKFLOW_V2_ACTIVITIES, WORKFLOW_V2_CONTROLLER_NAME, WORKFLOW_V2_CONTROLLER_VERSION, workflowEffectInstanceId,
    workflowNotifyInstanceId,
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

/** A worker-equivalent registration with one activity wrapped by `wrap` (and, optionally, its store wrapped by `wrapStore`). */
async function harness(env, wrap, { wrapStore, runtimeOptions, ...options } = {}) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
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
        store, client,
        host: { catalog, store, duroxideClient: client },
        /** Stop this worker's runtime (as if the worker died); its store stays open for work it abandoned. */
        async stopRuntime() {
            if (!running) return;
            running = false;
            await runtime.shutdown(100);
        },
        async stop() {
            await this.stopRuntime();
            await catalog.close();
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
            expect(recoveredEvents.map(event => event.data)).toEqual([{ runId: run.runId, action: "dispatched", requestedBy: parentId }]);

            // Only the parent may recover.
            const stranger = JSON.parse(await updateWorkflowFromTool({ workflow_id: slowId, operation: "recover", operation_id: "x" },
                { callerSessionId: randomUUID(), host: h.host }));
            expect(stranger).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
            expect((await h.store.readRun(lost.receipt.run.runId)).status).toBe("completed");
        } finally { await h.stop(); }
    });

    it("fails a controller instance of a pre-release version visibly, and recover ends its run", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv(), {});
        try {
            const parentId = randomUUID();
            await h.host.catalog.createSession(parentId, {});
            const context = { callerSessionId: parentId, host: h.host };
            const undispatched = { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async () => undefined } };
            const id = randomUUID();
            const created = await createWorkflowV2(undispatched, { workflowSessionId: id, parentSessionId: parentId, yaml: TWO_STEPS,
                actor: ACTOR, operationId: "start", start: { inputs: {} } });
            const { runId, controllerInstanceId } = created.receipt.run;
            // As a pre-release build would have started it.
            await h.client.startOrchestrationVersioned(controllerInstanceId, WORKFLOW_V2_CONTROLLER_NAME, { v: 2, workflowSessionId: id, runId }, "1.1.0");
            const failed = await until(async () => {
                const status = await h.client.getStatus(controllerInstanceId);
                return status.status === "Failed" ? status : null;
            }, "the pre-release controller to fail");
            expect(failed.error).toContain("pre-release build");
            expect((await h.store.readRun(runId)).status).toBe("admitted");
            expect(await h.store.listNodeExecutions(runId)).toEqual([]);
            const view = JSON.parse(await readWorkflowFromTool({ workflow_id: id }, context));
            expect(view.run).toMatchObject({ status: "admitted", controller: { status: "Failed", needsRecovery: true } });
            expect(view.run.controller.error).toContain("pre-release build");
            const recovered = JSON.parse(await updateWorkflowFromTool({ workflow_id: id, operation: "recover", operation_id: "recover" }, context));
            expect(recovered).toMatchObject({ ok: true, action: "ended", status: "failed" });
            const run = await h.store.readRun(runId);
            expect(run.terminalError).toMatchObject({ code: "controller_ended", details: { controllerStatus: "Failed" } });
            expect(run.terminalError.details.controllerError).toContain("pre-release build");
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
        const workers = [];
        const abandoned = [];
        const crashes = [];
        // Short locks: work a stopped worker held is taken by the next worker within seconds.
        const runtimeOptions = { workerLockTimeoutMs: 1_000, orchestratorLockTimeoutMs: 2_000 };
        /** A worker that crashes inside the first script entry it makes: the process started, the entry transaction rolled back. */
        const crashingWorker = async (name) => {
            let armed = true;
            const worker = await harness(getEnv(), {}, {
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
                    worker = index < crashCount ? await crashingWorker(`crash-${index + 1}`) : await harness(getEnv(), {});
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
            for (const worker of workers) await worker.stopRuntime();
            for (const release of abandoned) release();
            for (const worker of workers) await worker.stop();
            await probe.close();
        }
    });
});
