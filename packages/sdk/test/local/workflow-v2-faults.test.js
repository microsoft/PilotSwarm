/**
 * Workflow v2 recovery at injected fault boundaries, on the real durable
 * runtime (duroxide PostgreSQL provider) and the real PostgreSQL store, with
 * the production activity and orchestration registrations. One activity is
 * wrapped per test to inject the fault; everything else is unchanged.
 *
 * Model cases: docs/formal/workflow-v2/WorkflowV2Run.tla, properties
 * Live_Terminates (lost wake: rv-terminates-lost-wake; effect death:
 * rv-terminates-effect-death; both hd-liveness), Live_CancelStops (crash
 * after the cancel commit, before the stop request: rv-cancel-stops,
 * hd-liveness) and Prop_NoScriptAfterDelete (a deletion that commits while
 * the effect prepares its script: df-no-entry-fence, hd-safety).
 */
import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { registerWorkflowV2, WORKFLOW_V2_ACTIVITIES, workflowEffectInstanceId } from "../../src/workflow/v2/runtime.ts";

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

/** A worker-equivalent registration with one activity wrapped by `wrap`. */
async function harness(env, wrap, options = {}) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error" });
    const registrar = {
        registerActivity: (name, fn) => runtime.registerActivity(name, wrap[name] ? wrap[name](fn) : fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    };
    registerWorkflowV2(registrar, {
        store,
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
    return {
        store, client,
        host: { catalog, store, duroxideClient: client },
        async stop() {
            await runtime.shutdown(100);
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
});
