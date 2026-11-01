/**
 * Workflow v2 wait states on the real durable runtime (duroxide PostgreSQL
 * provider) and the real PostgreSQL store (design R06; test plan T035,
 * T043, T044, T049, T050):
 *
 * - a wait is a durable timer in the workflow's controller, never a script
 *   sleep or an effect orchestration, and it passes its input on;
 * - its seconds are read once, when it is entered: the store fixes its
 *   absolute deadline in its own clock then, a later KV change does not move
 *   it, and a bad value is invalid_input;
 * - it elapses only once the store's clock reached the deadline: the store
 *   refuses an early elapse and reports the time left, and a controller whose
 *   clock runs ahead (fault injection) waits that time;
 * - the deadline survives a worker restart and continue-as-new;
 * - pause does not freeze it (the wait elapses while paused, and its
 *   successor is admitted after resume); a cancel ends a waiting run at once,
 *   and a later elapse keeps the cancellation.
 *
 * Wait states are not in the formal model (README "Model simplifications");
 * these regressions are their evidence. A deliberate outage window below is
 * a fault parameter, not a wait for a condition.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflowV2, parseWorkflowIr, WORKFLOW_V2_IR_VERSION, WORKFLOW_V2_WAIT_IR_VERSION } from "../../src/workflow/v2/compiler.ts";
import { createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { readWorkflowFromTool, updateWorkflowFromTool } from "../../src/workflow/v2/tools.ts";
import { registerWorkflowV2, WORKFLOW_V2_ACTIVITIES, workflowEffectInstanceId } from "../../src/workflow/v2/runtime.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-wait-test" };

/** A wait whose seconds and output come from the run's KV; bad seconds route to 'bad'. */
const NAP = (seconds = '"${kv.secs}"') => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: nap, version: "1.0.0" }
initialInput: { from: "start" }
initial: nap
states:
  nap:
    type: wait
    seconds: ${seconds}
    transition: { next: { elapsed: after, invalid_input: bad } }
  after:
    type: script
    source: |
      await setResult("ok", { woke: context.input });
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
  bad: { type: terminal, outcome: blocked, output: "\${runtime.error}" }
`;

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

/** The catalog, store and durable provider that one test's workers share. */
async function baseOf(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    return { catalog, store: catalog.workflowStore(), provider, client: new Client(provider) };
}

/**
 * A worker-equivalent registration. `refusals` lists runs whose admission the
 * store refused for a pause; `elapses` lists the elapse activity's results;
 * `beforeElapse` runs before each elapse activity (a fault-injection hook).
 */
async function harness(env, { base: shared, runtimeOptions, wakeBackstopMs = 500, beforeElapse } = {}) {
    const base = shared ?? await baseOf(env);
    const { catalog, store, provider, client } = base;
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error", ...runtimeOptions });
    const refusals = [];
    const elapses = [];
    const wrap = (name, fn) => {
        if (name === WORKFLOW_V2_ACTIVITIES.enter) {
            return async (ctx, input) => {
                const entered = await fn(ctx, input);
                if (entered.admitted === false && entered.status === "paused") refusals.push(input.runId);
                return entered;
            };
        }
        if (name === WORKFLOW_V2_ACTIVITIES.elapse) {
            return async (ctx, input) => {
                if (beforeElapse) await beforeElapse(input);
                const elapsed = await fn(ctx, input);
                elapses.push(elapsed);
                return elapsed;
            };
        }
        return fn;
    };
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, wrap(name, fn)),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog,
        enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows notify no parent."); },
        deleteSession: async (sessionId) => catalog.softDeleteSession(sessionId),
        wakeBackstopMs,
    });
    await runtime.start();
    let running = true;
    return {
        store, client, refusals, elapses, base,
        host: { catalog, store, duroxideClient: client },
        async stopRuntime() {
            if (!running) return;
            running = false;
            await runtime.shutdown(100);
        },
        async stop() {
            await this.stopRuntime();
            if (!shared) await catalog.close();
        },
    };
}

async function finished(store, runId, timeoutMs = 60_000) {
    return until(async () => {
        const run = await store.readRun(runId);
        return run && ["completed", "failed", "cancelled"].includes(run.status) ? run : null;
    }, `run ${runId} to finish`, timeoutMs);
}

/** A parent session and the tool calls it makes on its workflow children. */
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

/** Start a NAP run with these vars and wait until its wait state is admitted. */
async function napEntered(h, parent, { vars, seconds } = {}) {
    const id = randomUUID();
    const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: NAP(seconds),
        actor: ACTOR, operationId: "start", start: { inputs: {}, vars: vars ?? {} } });
    const { runId, controllerInstanceId } = created.receipt.run;
    const node = await until(async () => (await h.store.listNodeExecutions(runId))[0] ?? null, "the wait state's admission");
    return { id, runId, controllerInstanceId, node };
}

/** Poll until the node has a result; returns the stored row. */
async function completion(store, nodeExecutionId, timeoutMs = 60_000) {
    return until(async () => {
        const node = await store.readNodeExecution(nodeExecutionId);
        return node?.state === "completed" ? node : null;
    }, `${nodeExecutionId} to complete`, timeoutMs);
}

/**
 * Every time below is the store's clock (PostgreSQL now()), read from the
 * stored row: the deadline is fixed at the admission (deadline_at - entered_at
 * is the wait's seconds exactly), and the elapse commits only at or after it
 * (completed_at >= deadline_at). Lateness bounds also assume this worker's
 * clock and the store's agree within a few milliseconds, as they do here.
 */
function lateness(node) {
    return node.completedAt.getTime() - node.deadlineAt.getTime();
}

describe("workflow v2 wait states", () => {
    it("compiles a wait state's seconds, input and routes, and writes IR version 4 only for a workflow with one", () => {
        const compiled = compileWorkflowV2(NAP());
        expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
        expect(compiled.ir.irVersion).toBe(WORKFLOW_V2_WAIT_IR_VERSION);
        expect(compiled.ir.nodes.nap).toEqual({ id: "nap", type: "wait", description: null, seconds: "${kv.secs}", hasInput: false, input: null,
            next: { elapsed: "after", invalid_input: "bad" } });
        expect(parseWorkflowIr(JSON.parse(JSON.stringify(compiled.ir))).nodes.nap).toEqual(compiled.ir.nodes.nap);
        // The same IR stated as version 3 is refused: version 3 has no wait states.
        expect(() => parseWorkflowIr({ ...JSON.parse(JSON.stringify(compiled.ir)), irVersion: 3 })).toThrow("stored IR wait nap is invalid");
        // A workflow without a wait state keeps IR version 3.
        const scriptsOnly = compileWorkflowV2(NAP().replace(/  nap:\n    type: wait\n    seconds: "\$\{kv.secs\}"\n    transition: \{ next: \{ elapsed: after, invalid_input: bad \} \}\n/, "")
            .replace("initial: nap", "initial: after"));
        expect(scriptsOnly.valid, JSON.stringify(scriptsOnly.diagnostics)).toBe(true);
        expect(scriptsOnly.ir.irVersion).toBe(WORKFLOW_V2_IR_VERSION);
        for (const [seconds, path] of [["0", "states.nap.seconds"], ["86401", "states.nap.seconds"], ["1.5", "states.nap.seconds"],
            ['"soon"', "states.nap.seconds"], ['"${nowhere.x}"', "states.nap.seconds"]]) {
            const result = compileWorkflowV2(NAP(seconds));
            expect(result.valid, `${seconds}: ${JSON.stringify(result.diagnostics)}`).toBe(false);
            expect(result.diagnostics.map(item => item.path)).toContain(path);
        }
        const noElapsed = compileWorkflowV2(NAP("5").replace("next: { elapsed: after, invalid_input: bad }", "next: { invalid_input: bad }"));
        expect(noElapsed.diagnostics).toContainEqual(expect.objectContaining({ code: "WORKFLOW_ROUTE_MISSING", path: "states.nap.transition.next" }));
        const businessRoute = compileWorkflowV2(NAP("5").replace("elapsed: after,", "elapsed: after, woke: after,"));
        expect(businessRoute.diagnostics).toContainEqual(expect.objectContaining({ code: "WORKFLOW_ROUTE_INVALID", path: "states.nap.transition.next.woke" }));
    });

    it("waits durably for its seconds, with no effect orchestration, and passes its input on", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await parentOf(h);
            const { id, runId, node } = await napEntered(h, parent, { seconds: "1" });
            expect(node).toMatchObject({ nodeId: "nap", nodeType: "wait", effectAttempts: 0, input: { from: "start" } });
            // The deadline is the store's clock at the admission plus 1 s, exactly.
            expect(node.deadlineAt.getTime() - node.enteredAt.getTime()).toBe(1_000);
            const view = await parent.read(id);
            expect(view.run.nodeExecutions[0]).toMatchObject({ stateId: "nap", deadline: node.deadlineAt.toISOString() });
            expect(view.graph.states).toContainEqual({ id: "nap", type: "wait", seconds: 1, outcomes: ["elapsed"], next: { elapsed: "after", invalid_input: "bad" } });
            const elapsed = await completion(h.store, node.nodeExecutionId);
            // Never early in the store's clock; on time within the lateness bound.
            expect(lateness(elapsed)).toBeGreaterThanOrEqual(0);
            expect(lateness(elapsed)).toBeLessThan(2_000);
            expect(elapsed).toMatchObject({ outcome: "elapsed", resultKind: "business", winner: "controller", output: { from: "start" }, effectAttempts: 0,
                deadlineAt: node.deadlineAt });
            const run = await finished(h.store, runId);
            expect(run).toMatchObject({ status: "completed", terminalOutput: { woke: { from: "start" } } });
            // The elapse that completed it reported nothing left (the run ended after that activity returned).
            expect(h.elapses.at(-1)).toEqual({ notDue: [] });
            // No effect orchestration ever existed for the wait.
            expect((await h.client.getStatus(workflowEffectInstanceId(node.nodeExecutionId))).status).toBe("NotFound");
        } finally { await h.stop(); }
    });

    it("reads its seconds once at entry: a later KV change does not move the deadline, and bad seconds are invalid_input", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await parentOf(h);
            const { id, runId, node } = await napEntered(h, parent, { vars: { secs: 2 } });
            expect(node.deadlineAt.getTime() - node.enteredAt.getTime()).toBe(2_000);
            expect(await parent.update(id, { operation: "set_vars", operation_id: "longer", set: { secs: 600 }, expected_kv_revision: 1 }))
                .toMatchObject({ ok: true, kvRevision: 2 });
            const elapsed = await completion(h.store, node.nodeExecutionId, 30_000);
            expect(elapsed.deadlineAt.getTime()).toBe(node.deadlineAt.getTime());
            expect(lateness(elapsed)).toBeGreaterThanOrEqual(0);
            expect(lateness(elapsed)).toBeLessThan(5_000);
            expect((await finished(h.store, runId)).status).toBe("completed");

            // A KV value that is not an integer from 1 to 86400 is stored, and the wait that reads it fails at entry.
            for (const secs of ["soon", -5, 0, 1.5, 86_401]) {
                const bad = await napEntered(h, parent, { vars: { secs } });
                expect(bad.node).toMatchObject({ state: "completed", outcome: "invalid_input", resultKind: "runtime_error", winner: "controller", deadlineAt: null });
                const run = await finished(h.store, bad.runId);
                expect(run, JSON.stringify(secs)).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "bad",
                    terminalOutput: { code: "invalid_input", details: { seconds: secs } } });
                expect(run.terminalOutput.message).toContain("states.nap.seconds must be an integer from 1 to 86400");
            }
        } finally { await h.stop(); }
    });

    it("keeps the absolute deadline across a worker restart and across continue-as-new", { timeout: 180_000 }, async () => {
        const base = await baseOf(getEnv());
        const runtimeOptions = { workerLockTimeoutMs: 1_000, orchestratorLockTimeoutMs: 2_000 };
        const workers = [];
        try {
            // The worker stops while the wait is pending and stays down for a 2.5 s outage window.
            let worker = await harness(getEnv(), { base, runtimeOptions });
            workers.push(worker);
            const parent = await parentOf(worker);
            const restarted = await napEntered(worker, parent, { seconds: "6" });
            await worker.stopRuntime();
            const stoppedAt = Date.now();
            await until(async () => Date.now() - stoppedAt >= 2_500, "the outage window");
            worker = await harness(getEnv(), { base, runtimeOptions });
            workers.push(worker);
            const afterRestart = await completion(base.store, restarted.node.nodeExecutionId);
            // On time in the store's clock: a timer started again at the restart would elapse about 3 s late.
            expect(lateness(afterRestart)).toBeGreaterThanOrEqual(0);
            expect(lateness(afterRestart)).toBeLessThan(2_000);
            expect(afterRestart).toMatchObject({ outcome: "elapsed", deadlineAt: restarted.node.deadlineAt });
            expect(restarted.node.deadlineAt.getTime() - restarted.node.enteredAt.getTime()).toBe(6_000);
            expect((await finished(base.store, restarted.runId)).status).toBe("completed");
            await worker.stopRuntime();

            // A 100 ms backstop continues the controller as new (50 idle waits) during a 15 s wait.
            worker = await harness(getEnv(), { base, runtimeOptions, wakeBackstopMs: 100 });
            workers.push(worker);
            const continued = await napEntered(worker, parent, { seconds: "15" });
            const afterContinue = await completion(base.store, continued.node.nodeExecutionId);
            expect((await base.client.listExecutions(continued.controllerInstanceId)).length).toBeGreaterThanOrEqual(2);
            expect(lateness(afterContinue)).toBeGreaterThanOrEqual(0);
            expect(lateness(afterContinue)).toBeLessThan(2_000);
            expect(afterContinue).toMatchObject({ outcome: "elapsed", deadlineAt: continued.node.deadlineAt });
            expect((await finished(base.store, continued.runId)).status).toBe("completed");
        } finally {
            for (const worker of workers) await worker.stop();
            await base.catalog.close();
        }
    });

    it("elapses while paused and admits its successor only after resume", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await parentOf(h);
            const { id, runId, node } = await napEntered(h, parent, { seconds: "2" });
            expect(await parent.update(id, { operation: "pause", operation_id: "pause" })).toMatchObject({ ok: true, status: "paused" });
            expect((await parent.read(id)).run).toMatchObject({ status: "paused", pauseSettled: false });
            // Pause does not freeze the deadline: the wait elapses on time while the run is paused.
            const elapsed = await completion(h.store, node.nodeExecutionId);
            expect(lateness(elapsed)).toBeGreaterThanOrEqual(0);
            expect(lateness(elapsed)).toBeLessThan(5_000);
            expect(elapsed.outcome).toBe("elapsed");
            await until(async () => h.refusals.includes(runId), "the successor's admission refused for the pause");
            expect((await h.store.listNodeExecutions(runId)).map(item => item.nodeId)).toEqual(["nap"]);
            expect((await parent.read(id)).run).toMatchObject({ status: "paused", pauseSettled: true });
            expect(await parent.update(id, { operation: "resume", operation_id: "resume" })).toMatchObject({ ok: true, status: "running" });
            const run = await finished(h.store, runId);
            expect(run).toMatchObject({ status: "completed", terminalOutput: { woke: { from: "start" } } });
            expect((await h.store.listNodeExecutions(runId)).map(item => [item.nodeId, item.ordinal])).toEqual([["nap", 1], ["after", 1], ["done", 1]]);
        } finally { await h.stop(); }
    });

    it("ends a waiting run at once when it is cancelled; the store refuses an early elapse, and the cancellation keeps its node", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await parentOf(h);
            const { id, runId, controllerInstanceId, node } = await napEntered(h, parent, { seconds: "300" });
            // Before its deadline the store elapses nothing: it reports the time left, and the wait stays pending.
            const early = await h.store.elapseWait(node.nodeExecutionId);
            expect(early).toMatchObject({ result: "not_due", node: { state: "pending", deadlineAt: node.deadlineAt } });
            expect(early.remainingMs).toBeGreaterThan(0);
            expect(early.remainingMs).toBeLessThanOrEqual(300_000);
            expect(await h.store.readNodeExecution(node.nodeExecutionId)).toMatchObject({ state: "pending", completedAt: null });
            const askedAt = Date.now();
            expect(await parent.update(id, { operation: "cancel", operation_id: "cancel", reason: "not needed" })).toMatchObject({ ok: true });
            const run = await finished(h.store, runId, 30_000);
            expect(Date.now() - askedAt).toBeLessThan(30_000);
            expect(run).toMatchObject({ status: "cancelled", terminalError: { code: "cancelled", message: "not needed" } });
            const cancelled = await h.store.readNodeExecution(node.nodeExecutionId);
            expect(cancelled).toMatchObject({ state: "completed", outcome: "cancelled", winner: "cancel" });
            // The first result stands: a later elapse changes nothing.
            expect(await h.store.elapseWait(node.nodeExecutionId)).toMatchObject({ result: "decided", node: { outcome: "cancelled", winner: "cancel" } });
            expect(await h.store.readNodeExecution(node.nodeExecutionId)).toEqual(cancelled);
            expect((await h.client.waitForOrchestration(controllerInstanceId, 30_000)).status).toBe("Completed");
        } finally { await h.stop(); }
    });

    it("never elapses before the store's clock reaches the deadline, even when the controller's clock runs ahead of it", { timeout: TIMEOUT }, async () => {
        // Fault injection: after the controller read the deadline, the stored
        // deadline moves 3 s later. To the controller this is a worker clock
        // 3 s ahead of the store's; the first elapse waits until the move commits.
        const env = getEnv();
        let moved;
        const movedCommitted = new Promise(resolve => { moved = resolve; });
        const h = await harness(env, { beforeElapse: () => movedCommitted });
        const db = new pg.Client({ connectionString: env.store });
        try {
            await db.connect();
            const parent = await parentOf(h);
            const { runId, node } = await napEntered(h, parent, { seconds: "1" });
            const shifted = await db.query(
                `UPDATE "${env.cmsSchema}".workflow_node_executions SET deadline_at = deadline_at + interval '3 seconds'
                  WHERE node_execution_id = $1 AND state = 'pending' RETURNING deadline_at`, [node.nodeExecutionId]);
            expect(shifted.rows).toHaveLength(1);
            moved();
            const elapsed = await completion(h.store, node.nodeExecutionId);
            expect(elapsed.deadlineAt.getTime()).toBe(node.deadlineAt.getTime() + 3_000);
            // It elapsed only once the store's clock reached the moved deadline, and then on time.
            expect(lateness(elapsed)).toBeGreaterThanOrEqual(0);
            expect(lateness(elapsed)).toBeLessThan(2_000);
            expect(elapsed).toMatchObject({ outcome: "elapsed", winner: "controller" });
            expect((await finished(h.store, runId)).status).toBe("completed");
            // At the deadline it had read, the controller asked; the store refused and reported the time left
            // (3 s, plus at most the difference between this worker's clock and the store's). The run ended
            // after the elapse that completed the wait returned, which reported nothing left.
            expect(h.elapses[0]).toEqual({ notDue: [{ nodeExecutionId: node.nodeExecutionId, remainingMs: expect.any(Number) }] });
            expect(h.elapses[0].notDue[0].remainingMs).toBeGreaterThan(0);
            expect(h.elapses[0].notDue[0].remainingMs).toBeLessThan(3_500);
            expect(h.elapses.at(-1)).toEqual({ notDue: [] });
        } finally {
            moved();
            await h.stop();
            await db.end();
        }
    });
});
