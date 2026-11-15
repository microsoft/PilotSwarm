/**
 * Workflow wait states on the real durable runtime (duroxide PostgreSQL
 * provider) and the real PostgreSQL store (design R06; test plan T035,
 * T043, T044, T049, T050):
 *
 * - a wait is a durable timer in the workflow's controller, never a script
 *   sleep or an effect orchestration, and it passes its input on;
 * - its seconds are read once, when it is entered: the store fixes its
 *   absolute deadline in its own clock then, a later KV change does not move
 *   it, and a bad value is invalid_input;
 * - the seconds count from the store's clock reading when the admission is
 *   accepted, after its locks and guards: neither a lock wait after its
 *   transaction began nor a delay before it consumes them (W1);
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
import { testTime, useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflow, parseWorkflowIr, WORKFLOW_IR_VERSION } from "../../src/workflow/compiler.ts";
import { createWorkflow } from "../../src/workflow/service.ts";
import { readWorkflowFromTool, updateWorkflowFromTool } from "../../src/workflow/tools.ts";
import { registerWorkflow, WORKFLOW_ACTIVITIES, workflowEffectInstanceId } from "../../src/workflow/runtime.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
// CI run 114: the test's own bounds grow with the database the suite runs on (test/helpers/time-scale.js).
const TIMEOUT = testTime.ms(120_000);
const ACTOR = { kind: "system", name: "workflow-wait-test" };

/** A wait whose seconds and output come from the run's KV; bad seconds route to 'bad'. */
const NAP = (seconds = '"${kv.secs}"') => `
apiVersion: pilotswarm.dev/v1
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
    const deadline = Date.now() + testTime.ms(timeoutMs);
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
 * store refused for a pause; `withheld` lists runs whose results a collection
 * kept from the controller while paused; `elapses` lists the elapse activity's results;
 * `beforeElapse` runs before each elapse activity, and `wrapStore` wraps the
 * store the runtime uses (fault-injection hooks).
 */
async function harness(env, { base: shared, runtimeOptions, wakeBackstopMs = 500, beforeElapse, wrapStore } = {}) {
    const base = shared ?? await baseOf(env);
    const { catalog, store, provider, client } = base;
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] }, ...runtimeOptions });
    const refusals = [];
    const elapses = [];
    const withheld = [];
    const wrap = (name, fn) => {
        // Review R2-RT-1: a collection that reported the run paused while results of the work it asked about were stored.
        if (name === WORKFLOW_ACTIVITIES.collect) {
            return async (ctx, input) => {
                const collected = await fn(ctx, input);
                if (collected?.paused === true && input.nodeExecutionIds.length > 0
                    && (await store.readCompletedNodes(input.runId, input.nodeExecutionIds)).length > 0) withheld.push(input.runId);
                return collected;
            };
        }
        if (name === WORKFLOW_ACTIVITIES.enter) {
            return async (ctx, input) => {
                const entered = await fn(ctx, input);
                if (entered.admitted === false && entered.status === "paused") refusals.push(input.runId);
                return entered;
            };
        }
        if (name === WORKFLOW_ACTIVITIES.elapse) {
            return async (ctx, input) => {
                if (beforeElapse) await beforeElapse(input);
                const elapsed = await fn(ctx, input);
                elapses.push(elapsed);
                return elapsed;
            };
        }
        return fn;
    };
    registerWorkflow({
        registerActivity: (name, fn) => runtime.registerActivity(name, wrap(name, fn)),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store: wrapStore ? wrapStore(store) : store, catalog,
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
        store, client, refusals, elapses, withheld, base,
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
    const created = await createWorkflow(h.host, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: NAP(seconds),
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

describe("workflow wait states", () => {
    it("compiles a wait state's seconds, input and routes", () => {
        const compiled = compileWorkflow(NAP());
        expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
        expect(compiled.ir.irVersion).toBe(WORKFLOW_IR_VERSION);
        expect(compiled.ir.nodes.nap).toEqual({ id: "nap", type: "wait", description: null, seconds: "${kv.secs}", hasInput: false, input: null,
            next: { elapsed: "after", invalid_input: "bad" } });
        expect(parseWorkflowIr(JSON.parse(JSON.stringify(compiled.ir))).nodes.nap).toEqual(compiled.ir.nodes.nap);
        // A stored IR of another version is refused.
        expect(() => parseWorkflowIr({ ...JSON.parse(JSON.stringify(compiled.ir)), irVersion: WORKFLOW_IR_VERSION + 1 }))
            .toThrow(`stored IR version ${WORKFLOW_IR_VERSION + 1} is not supported`);
        for (const [seconds, path] of [["0", "states.nap.seconds"], ["86401", "states.nap.seconds"], ["1.5", "states.nap.seconds"],
            ['"soon"', "states.nap.seconds"], ['"${nowhere.x}"', "states.nap.seconds"]]) {
            const result = compileWorkflow(NAP(seconds));
            expect(result.valid, `${seconds}: ${JSON.stringify(result.diagnostics)}`).toBe(false);
            expect(result.diagnostics.map(item => item.path)).toContain(path);
        }
        const noElapsed = compileWorkflow(NAP("5").replace("next: { elapsed: after, invalid_input: bad }", "next: { invalid_input: bad }"));
        expect(noElapsed.diagnostics).toContainEqual(expect.objectContaining({ code: "WORKFLOW_ROUTE_MISSING", path: "states.nap.transition.next" }));
        const businessRoute = compileWorkflow(NAP("5").replace("elapsed: after,", "elapsed: after, woke: after,"));
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

    // CI run 114 (HorizonDB): 50 idle passes of the controller did not fit in the 15 s wait there, so it elapsed before any
    // continue-as-new. The waits, the outage window and the lateness bounds are scaled together: a timer started again at
    // the restart or at the continue-as-new would still be later than the bound.
    it("keeps the absolute deadline across a worker restart and across continue-as-new", { timeout: testTime.ms(180_000) }, async () => {
        const restartWait = testTime.seconds(6);
        const outageMs = testTime.ms(2_500);
        const continueWait = testTime.seconds(15);
        const lateBoundMs = testTime.ms(2_000);
        const base = await baseOf(getEnv());
        // Whole seconds of at least 2: a shorter activity lock renews no earlier than it expires (duroxide 0.1.32).
        const runtimeOptions = { workerLockTimeoutMs: 2_000, orchestratorLockTimeoutMs: 2_000 };
        const workers = [];
        try {
            // The worker stops while the wait is pending and stays down for a 2.5 s outage window (scaled).
            let worker = await harness(getEnv(), { base, runtimeOptions });
            workers.push(worker);
            const parent = await parentOf(worker);
            const restarted = await napEntered(worker, parent, { seconds: String(restartWait) });
            await worker.stopRuntime();
            const stoppedAt = Date.now();
            await until(async () => Date.now() - stoppedAt >= outageMs, "the outage window");
            worker = await harness(getEnv(), { base, runtimeOptions });
            workers.push(worker);
            const afterRestart = await completion(base.store, restarted.node.nodeExecutionId);
            // On time in the store's clock: a timer started again at the restart would elapse about the outage late.
            expect(lateness(afterRestart)).toBeGreaterThanOrEqual(0);
            expect(lateness(afterRestart)).toBeLessThan(lateBoundMs);
            expect(afterRestart).toMatchObject({ outcome: "elapsed", deadlineAt: restarted.node.deadlineAt });
            expect(restarted.node.deadlineAt.getTime() - restarted.node.enteredAt.getTime()).toBe(restartWait * 1_000);
            expect((await finished(base.store, restarted.runId)).status).toBe("completed");
            await worker.stopRuntime();

            // A 100 ms backstop continues the controller as new (50 idle waits) during a 15 s wait (scaled).
            worker = await harness(getEnv(), { base, runtimeOptions, wakeBackstopMs: 100 });
            workers.push(worker);
            const continued = await napEntered(worker, parent, { seconds: String(continueWait) });
            const afterContinue = await completion(base.store, continued.node.nodeExecutionId);
            expect((await base.client.listExecutions(continued.controllerInstanceId)).length).toBeGreaterThanOrEqual(2);
            expect(lateness(afterContinue)).toBeGreaterThanOrEqual(0);
            expect(lateness(afterContinue)).toBeLessThan(lateBoundMs);
            expect(afterContinue).toMatchObject({ outcome: "elapsed", deadlineAt: continued.node.deadlineAt });
            expect((await finished(base.store, continued.runId)).status).toBe("completed");
        } finally {
            for (const worker of workers) await worker.stop();
            await base.catalog.close();
        }
    });

    it("elapses while paused, does not look again at the decided wait while paused, and admits its successor only after resume", { timeout: TIMEOUT }, async () => {
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
            // Its result is kept for the resume (review R2-RT-1): no successor is admitted, and none is tried.
            await until(async () => h.withheld.includes(runId), "a collection that keeps the result for the resume");
            expect(h.refusals).not.toContain(runId);
            expect((await h.store.listNodeExecutions(runId)).map(item => item.nodeId)).toEqual(["nap"]);
            expect((await parent.read(id)).run).toMatchObject({ status: "paused", pauseSettled: true });
            // A sustained pause: the decided wait has no deadline left, so the controller does not elapse it again.
            const before = h.elapses.length;
            const collections = h.withheld.filter(id => id === runId).length;
            await until(async () => h.withheld.filter(id => id === runId).length >= collections + 2,
                "two more paused collections that keep the decided wait");
            expect(h.elapses.slice(before)).toEqual([]);
            expect((await h.store.readRun(runId)).status).toBe("paused");
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

    it("counts a wait's seconds from the store's clock when its admission is accepted, after a lock wait longer than the wait", { timeout: TIMEOUT }, async () => {
        // Fault injection: the admission's transaction begins, takes the
        // session row and then waits 2.5 s for the run row, which this test
        // holds without changing it. The wait is 1 s, so a deadline counted
        // from the transaction's start (now()) would already be due when the
        // row is inserted.
        const env = getEnv();
        let reached;
        const atStore = new Promise(resolve => { reached = resolve; });
        let release;
        const locked = new Promise(resolve => { release = resolve; });
        const h = await harness(env, {
            wrapStore: (store) => {
                const watched = Object.create(store);
                watched.enterNode = async (input) => {
                    if (input.nodeType === "wait") { reached(); await locked; }
                    return store.enterNode(input);
                };
                return watched;
            },
        });
        const holder = new pg.Client({ connectionString: env.store });
        // Polled outside the holder's transaction: pg_stat_activity is fixed for the rest of a transaction once read.
        const observer = new pg.Client({ connectionString: env.store });
        try {
            await holder.connect();
            await observer.connect();
            const parent = await parentOf(h);
            const created = await createWorkflow(h.host, { workflowSessionId: randomUUID(), parentSessionId: parent.parentId, yaml: NAP("1"),
                actor: ACTOR, operationId: "start", start: { inputs: {}, vars: {} } });
            const { runId } = created.receipt.run;
            await atStore;
            const { pid: holderPid } = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0];
            await holder.query("BEGIN");
            const { rows: [held] } = await holder.query(
                `SELECT status, kv_revision FROM "${env.cmsSchema}".workflow_runs WHERE run_id = $1 FOR UPDATE`, [runId]);
            // The test holds the run as it is and changes nothing.
            expect(held).toEqual({ status: "running", kv_revision: 1 });
            release();
            const blocked = await until(async () => (await observer.query(
                "SELECT pid, xact_start FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [holderPid])).rows[0] ?? null,
            "the admission's transaction to wait for the run row");
            const heldFrom = Date.now();
            await until(async () => Date.now() - heldFrom >= 2_500, "the lock window");
            const { at: releasedAt } = (await holder.query("SELECT clock_timestamp() AS at")).rows[0];
            await holder.query("ROLLBACK");

            const node = await until(async () => (await h.store.listNodeExecutions(runId))[0] ?? null, "the wait state's admission");
            // Accepted after the lock wait: its entry is the store's clock once it held the run row, not its transaction's start.
            expect(node.enteredAt.getTime()).toBeGreaterThanOrEqual(releasedAt.getTime());
            expect(node.enteredAt.getTime() - blocked.xact_start.getTime()).toBeGreaterThanOrEqual(2_500);
            expect(node.deadlineAt.getTime() - node.enteredAt.getTime()).toBe(1_000);
            // The admission pinned the unchanged KV revision; the run kept it to the end.
            expect(node).toMatchObject({ nodeId: "nap", kvRevision: 1 });
            const elapsed = await completion(h.store, node.nodeExecutionId);
            expect(lateness(elapsed)).toBeGreaterThanOrEqual(0);
            expect(lateness(elapsed)).toBeLessThan(2_000);
            // Its whole second passed after the run row was released.
            expect(elapsed.completedAt.getTime() - releasedAt.getTime()).toBeGreaterThanOrEqual(1_000);
            expect(await finished(h.store, runId)).toMatchObject({ status: "completed", kvRevision: 1 });
        } finally {
            release();
            // Close the holder first: it releases the run row if a check above failed while it was held.
            await holder.end();
            await observer.end();
            await h.stop();
        }
    });

    it("counts a wait's seconds from its accepted entry when its admission reaches the store late", { timeout: TIMEOUT }, async () => {
        // Fault injection: the admission reaches the store 2.5 s after its
        // seconds were read, before its transaction begins.
        const env = getEnv();
        const db = new pg.Client({ connectionString: env.store });
        const clock = async () => (await db.query("SELECT clock_timestamp() AS at")).rows[0].at;
        let readAt = null;
        let reachedAt = null;
        const h = await harness(env, {
            wrapStore: (store) => {
                const watched = Object.create(store);
                watched.enterNode = async (input) => {
                    if (input.nodeType === "wait" && readAt === null) {
                        readAt = await clock();
                        const from = Date.now();
                        await until(async () => Date.now() - from >= 2_500, "the delay window");
                        reachedAt = await clock();
                    }
                    return store.enterNode(input);
                };
                return watched;
            },
        });
        try {
            await db.connect();
            const parent = await parentOf(h);
            const { runId, node } = await napEntered(h, parent, { seconds: "1" });
            expect(reachedAt.getTime() - readAt.getTime()).toBeGreaterThanOrEqual(2_500);
            expect(node.enteredAt.getTime()).toBeGreaterThanOrEqual(reachedAt.getTime());
            expect(node.deadlineAt.getTime() - node.enteredAt.getTime()).toBe(1_000);
            const elapsed = await completion(h.store, node.nodeExecutionId);
            expect(lateness(elapsed)).toBeGreaterThanOrEqual(0);
            expect(lateness(elapsed)).toBeLessThan(2_000);
            // Its whole second passed after the admission reached the store.
            expect(elapsed.completedAt.getTime() - reachedAt.getTime()).toBeGreaterThanOrEqual(1_000);
            expect((await finished(h.store, runId)).status).toBe("completed");
        } finally {
            await h.stop();
            await db.end();
        }
    });
});
