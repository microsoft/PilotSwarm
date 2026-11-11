/**
 * Named branches (owner decision 2026-11-08T00:35Z, option A), on the Workflow controller. Branch states
 * are real script processes and waits; no model runs.
 *
 * - All: each branch starts at its own initial with its own input (its template, else the value that arrived); the
 *   joined output is { <name>: output }; `branch.name` binds in its states and a script reads context.branch.name.
 * - The first k: a race of two branches joins with the winner only ({ <name>: output }); the other is cancelled.
 * - failFast: a branch that fails cancels the other; the blocked report names each branch.
 * - The time limit: timed_out, its details name each branch.
 * - A cancel of the run cancels the branches' work.
 * - A worker restart while a branch waits: the run goes on and joins by name (its plan, with each branch's initial, replays).
 * - Slice 2: each workflow.branches_cancelled event names the branches it cut (the first k, failFast, the time limit).
 * - Review NB-R1: a cut whose branch names cannot be read (the run's IR refused) still cancels, and its event has no names.
 * - Review NB-R2: after an accepted graceful stop, the fork's own time limit decides nothing: its started branches run to
 *   their own end, nothing of theirs is cut, no report is written, and the stop's end cancels the pending fork.
 * - Review NB-R5: a failFast block cuts the other branch and decides the fork in one store transaction (the controller's
 *   later cut finds the fork already decided).
 * - The stop hold on its other paths: a join asked after the stop was accepted answers wait and writes no report; a test
 *   run's clock advanced during a stop settles nothing; and when the stop's grace ends with branch work still running, the
 *   run ends stopped and the fork is cancelled without a report.
 * - A cut of two forks' branches names each from its own fork, never from the first scope's.
 *
 * Run: npx vitest run test/local/workflow-branches.test.js
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { testTime, useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { controlWorkflowRun, createWorkflow } from "../../src/workflow/service.ts";
import { updateWorkflowFromTool } from "../../src/workflow/tools.ts";
import { branchScopeId, registerWorkflow, sessionQueueTransport } from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
// CI run 114 (HorizonDB, about ten times slower): the test's own bounds grow with the database (test/helpers/time-scale.js).
const TIMEOUT = testTime.ms(120_000);
const ACTOR = { kind: "system", name: "workflow-branches-test" };
const WORKER_SLOTS = 16;
const ENDED = ["completed", "failed", "cancelled", "stopped"];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const yamlOf = doc => JSON.stringify(doc, null, 2);

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + testTime.ms(timeoutMs);
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await pause(50);
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

/** A branch's script: waits `ms`, then ends `bad` when told to fail, else `ok` with its branch's name, index and input. */
const WORK = "const item = context.input;\n"
    + "await new Promise(resolve => setTimeout(resolve, item.ms ?? 0));\n"
    + "await setResult(item.fail ? \"bad\" : \"ok\", { name: context.branch.name, index: context.branch.index, input: item });\n";

/** A branch: `first` (a script that passes its input on) then `work`, or `work` alone; its end names the branch by binding. */
function branch(prefix, { input, prepare = false, wait = false } = {}) {
    const states = {
        ...(prepare ? { [`${prefix}_prepare`]: { type: "script", source: "await setResult(\"ready\", context.input);\n",
            transition: { next: { ready: `${prefix}_work`, failure: `${prefix}_failed` } } } } : {}),
        ...(wait ? { [`${prefix}_hold`]: { type: "wait", seconds: 600, transition: { next: { elapsed: `${prefix}_work` } } } } : {}),
        [`${prefix}_work`]: { type: "script", source: WORK, transition: { next: { ok: `${prefix}_end`, bad: `${prefix}_failed`, failure: `${prefix}_failed` } } },
        [`${prefix}_end`]: { type: "terminal", outcome: "succeeded", output: { lane: "${branch.name}", result: "${input}" } },
        [`${prefix}_failed`]: { type: "terminal", outcome: "failed", output: "${input}" },
    };
    return { initial: prepare ? `${prefix}_prepare` : wait ? `${prefix}_hold` : `${prefix}_work`, states, ...(input !== undefined ? { input } : {}) };
}

/** A Workflow of one parallel state with named branches `quick` and `careful`. */
function branchesDoc({ quick = {}, careful = {}, join, failFast = false, timeoutSeconds, input = { ms: 0 } } = {}) {
    const timed = timeoutSeconds !== undefined;
    return {
        apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: "named-branches", version: "1.0.0" },
        initialInput: input, initial: "views",
        states: {
            views: {
                type: "parallel",
                branches: { quick: branch("quick", quick), careful: branch("careful", careful) },
                ...(join !== undefined ? { join } : {}), ...(failFast ? { failFast: true } : {}), ...(timed ? { timeoutSeconds } : {}),
                transition: { next: { joined: "finished", blocked: "stuck", failure: "failed", ...(timed ? { timed_out: "late" } : {}) } },
            },
            finished: { type: "terminal", outcome: "succeeded", output: "${input}" },
            stuck: { type: "terminal", outcome: "blocked", output: "${input}" },
            failed: { type: "terminal", outcome: "failed", output: "${input}" },
            ...(timed ? { late: { type: "terminal", outcome: "blocked", output: "${input}" } } : {}),
        },
    };
}

async function baseOf(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    return { catalog, store, provider, client, host: { catalog, store, duroxideClient: client } };
}

async function runtimeOn(base) {
    const runtime = new Runtime(base.provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerConcurrency: WORKER_SLOTS, workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
        workerLockTimeoutMs: 2_000, orchestratorLockTimeoutMs: 2_000,
    });
    registerWorkflow({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store: base.store, catalog: base.catalog, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows notify no parent."); },
        deleteSession: async sessionId => base.catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500, 
        sessionQueue: { ...sessionQueueTransport(base.client), version: async () => "1.0.83" },
    });
    await runtime.start();
    let running = true;
    return { async stop() { if (!running) return; running = false; await runtime.shutdown(100); } };
}

/** A parent and a started run of `doc`, with ids of its parallel state's branch states. */
async function started(base, doc) {
    const parent = randomUUID();
    await base.catalog.createSession(parent, {});
    const workflowSessionId = randomUUID();
    const created = await createWorkflow(base.host, {
        workflowSessionId, parentSessionId: parent, yaml: yamlOf(doc), actor: ACTOR, operationId: "start", start: { inputs: {} },
    });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    const runId = created.receipt.run.runId;
    const views = nodeExecutionIdFor(runId, "root", "views", 1);
    return { workflowSessionId, runId, views, at: (index, nodeId) => nodeExecutionIdFor(runId, branchScopeId(views, index), nodeId, 1) };
}

/** The workflow.branches_cancelled events of a workflow, their data in order. */
const cancelEvents = async (base, workflowSessionId) => (await base.catalog.getSessionEvents(workflowSessionId, 0, 1_000))
    .filter(event => event.eventType === "workflow.branches_cancelled").map(event => event.data);

const endedRun = (base, runId, timeoutMs = 60_000) => until(async () => {
    const run = await base.store.readRun(runId);
    return run && ENDED.includes(run.status) ? run : null;
}, `run ${runId} to end`, timeoutMs);

/** A run against one fresh runtime. */
async function withRuntime(fn) {
    const base = await baseOf(getEnv());
    const worker = await runtimeOn(base);
    try {
        await fn(base);
    } finally {
        await worker.stop();
        await base.catalog.close();
    }
}

describe("named branches: the controller", () => {
    it("each branch starts at its own initial with its own input; the join is { <name>: output }; branch.name binds", { timeout: TIMEOUT }, async () => {
        await withRuntime(async base => {
            const doc = branchesDoc({ input: { ms: 100 }, careful: { prepare: true, input: { ms: 300, depth: "deep" } } });
            const { runId, at } = await started(base, doc);
            const run = await endedRun(base, runId);
            expect(run).toMatchObject({ status: "completed", terminalNodeId: "finished" });
            expect(run.terminalOutput).toEqual({
                quick: { lane: "quick", result: { name: "quick", index: 0, input: { ms: 100 } } },
                careful: { lane: "careful", result: { name: "careful", index: 1, input: { ms: 300, depth: "deep" } } },
            });
            // Each branch began at its own initial, in its own scope.
            expect(await base.store.readNodeExecution(at(0, "quick_work"))).toMatchObject({ state: "completed", outcome: "ok" });
            expect(await base.store.readNodeExecution(at(1, "careful_prepare"))).toMatchObject({ state: "completed", outcome: "ready" });
            expect(await base.store.readNodeExecution(at(1, "careful_work"))).toMatchObject({ state: "completed", outcome: "ok" });
            expect(await base.store.readNodeExecution(at(0, "careful_prepare"))).toBeFalsy();
        });
    });

    it("a join of the first 1: the winner only, by name; the other branch is cancelled", { timeout: TIMEOUT }, async () => {
        await withRuntime(async base => {
            const doc = branchesDoc({ join: { first: 1 }, quick: { input: { ms: 200 } }, careful: { input: { ms: 9_000 } } });
            const { workflowSessionId, runId, at } = await started(base, doc);
            const run = await endedRun(base, runId);
            expect(run).toMatchObject({ status: "completed", terminalNodeId: "finished" });
            expect(run.terminalOutput).toEqual({ quick: { lane: "quick", result: { name: "quick", index: 0, input: { ms: 200 } } } });
            expect(await base.store.readNodeExecution(at(1, "careful_work"))).toMatchObject({ state: "completed", outcome: "cancelled" });
            // The cut names the branch it canceled.
            expect(await cancelEvents(base, workflowSessionId)).toContainEqual(expect.objectContaining({ reason: "join", branches: ["careful"] }));
        });
    });

    it("failFast: a failing branch cancels the other; the blocked report names each branch", { timeout: TIMEOUT }, async () => {
        await withRuntime(async base => {
            const doc = branchesDoc({ failFast: true, quick: { input: { ms: 100, fail: true } }, careful: { input: { ms: 9_000 } } });
            const { workflowSessionId, runId } = await started(base, doc);
            const run = await endedRun(base, runId);
            expect(run).toMatchObject({ status: "completed", terminalNodeId: "stuck" });
            expect(run.terminalOutput.joined).toBe(false);
            expect(run.terminalOutput.branches.map(item => [item.index, item.name])).toEqual([[0, "quick"], [1, "careful"]]);
            expect(run.terminalOutput.branches[1]).toMatchObject({ ended: "cancelled" });
            const cuts = await cancelEvents(base, workflowSessionId);
            expect(cuts).toContainEqual(expect.objectContaining({ branches: ["careful"] }));
            expect(cuts.every(data => data.reason === undefined)).toBe(true);
        });
    });

    // CI run 114 (HorizonDB): the 3 s limit passed before the quick branch had ended and the careful one had begun its wait,
    // so the quick one was cut and the careful one never started. The limit is scaled, and the case first waits until the
    // quick branch has ended and the careful one is in its wait; seen only after the limit, the case is VOID.
    it("the time limit: timed_out, its details name each branch", { timeout: TIMEOUT }, async () => {
        await withRuntime(async base => {
            const doc = branchesDoc({ timeoutSeconds: testTime.seconds(3), careful: { wait: true } });
            const { workflowSessionId, runId, views, at } = await started(base, doc);
            await until(async () => {
                const [end, hold] = await Promise.all([base.store.readNodeExecution(at(0, "quick_end")), base.store.readNodeExecution(at(1, "careful_hold"))]);
                return end?.state === "completed" && hold?.state === "pending";
            }, "the quick branch's end and the careful branch's wait");
            expect(Date.now(), "VOID (not a product result): the branches were seen only after the time limit; run the case again")
                .toBeLessThan((await base.store.readNodeExecution(views)).deadlineAt.getTime());
            const run = await endedRun(base, runId);
            expect(run).toMatchObject({ status: "completed", terminalNodeId: "late" });
            const node = await base.store.readNodeExecution(views);
            expect(node).toMatchObject({ outcome: "timed_out", resultKind: "runtime_error" });
            expect(node.error.details.branches.map(item => [item.name, item.ended])).toEqual([["quick", "terminal"], ["careful", "cancelled"]]);
            expect(await cancelEvents(base, workflowSessionId)).toContainEqual(expect.objectContaining({ reason: "timeout", branches: ["careful"] }));
        });
    });

    it("a cancel of the run cancels the branches' work", { timeout: TIMEOUT }, async () => {
        await withRuntime(async base => {
            const { workflowSessionId, runId, at } = await started(base, branchesDoc({ quick: { wait: true }, careful: { wait: true } }));
            await until(async () => (await base.store.readNodeExecution(at(1, "careful_hold")))?.state === "pending", "the waits to start");
            await controlWorkflowRun(base.host, workflowSessionId, { operation: "cancel", runId: null, reason: "not needed" },
                { actor: ACTOR, operationId: "cancel-1" });
            expect(await endedRun(base, runId)).toMatchObject({ status: "cancelled" });
            for (const [index, nodeId] of [[0, "quick_hold"], [1, "careful_hold"]]) {
                expect(await base.store.readNodeExecution(at(index, nodeId))).toMatchObject({ state: "completed", outcome: "cancelled" });
            }
            expect(await base.store.hasPendingNodes(runId)).toBe(false);
        });
    });

    it("NB-R1: a cut whose branch names cannot be read still cancels; its event names no branch", { timeout: TIMEOUT }, async () => {
        await withRuntime(async base => {
            const { workflowSessionId, runId, views, at } = await started(base, branchesDoc({ quick: { wait: true }, careful: { wait: true } }));
            await until(async () => (await base.store.readNodeExecution(at(1, "careful_hold")))?.state === "pending", "the waits to start");
            // The run's IR cannot be read for the names: a stored shape this reader refuses.
            const read = base.store.revisionIrIn;
            base.store.revisionIrIn = async () => { throw Object.assign(new Error("stored IR parallel state views has invalid branches"), { name: "StoredShapeError" }); };
            let answer;
            try {
                answer = await base.store.cancelBranchScopes({ runId, scopeIds: [branchScopeId(views, 0), branchScopeId(views, 1)], reason: "join",
                    projection: (cancelled, scopeIds, names) => ({ sessionId: workflowSessionId, events: [{ eventType: "workflow.branches_cancelled",
                        data: { runId, scopeIds, cancelled, reason: "join", ...(names !== null ? { branches: names } : {}) } }] }) });
            } finally {
                base.store.revisionIrIn = read;
            }
            expect(answer.active).toBe(true);
            expect(answer.cancelled.map(item => item.nodeExecutionId).sort()).toEqual([at(0, "quick_hold"), at(1, "careful_hold")].sort());
            for (const [index, nodeId] of [[0, "quick_hold"], [1, "careful_hold"]]) {
                expect(await base.store.readNodeExecution(at(index, nodeId))).toMatchObject({ state: "completed", outcome: "cancelled", winner: "join" });
            }
            const cut = (await cancelEvents(base, workflowSessionId)).find(data => data.reason === "join");
            expect(cut).toBeTruthy();
            expect(Object.hasOwn(cut, "branches")).toBe(false);
            // Its branches ended by the cut: the run goes on to its end.
            expect((await endedRun(base, runId)).status).toBe("completed");
        });
    });

    it("NB-R2: a graceful stop holds the fork: its time limit cuts nothing, writes no report; the stop cancels it", { timeout: TIMEOUT }, async () => {
        await withRuntime(async base => {
            // Keep the stop before the fork's limit, and the work after it, also with a remote database.
            const doc = branchesDoc({ timeoutSeconds: testTime.seconds(4),
                quick: { input: { ms: testTime.ms(8_000) } }, careful: { input: { ms: testTime.ms(8_000) } } });
            const { workflowSessionId, runId, views, at } = await started(base, doc);
            await until(async () => {
                const rows = await Promise.all([base.store.readNodeExecution(at(0, "quick_work")), base.store.readNodeExecution(at(1, "careful_work"))]);
                return rows.every(row => row?.state === "pending");
            }, "both branches' work to start");
            await controlWorkflowRun(base.host, workflowSessionId, { operation: "stop", runId: null, reason: "enough", graceSeconds: testTime.seconds(60) },
                { actor: ACTOR, operationId: "stop-r2" });
            expect(Date.now(), "VOID: the stop was accepted only after the fork's time limit")
                .toBeLessThan((await base.store.readNodeExecution(views)).deadlineAt.getTime());
            const run = await endedRun(base, runId, 60_000);
            expect(run.status).toBe("stopped");
            // The started work ran to its own end: neither branch was cut by the fork's time limit.
            for (const [index, nodeId] of [[0, "quick_work"], [1, "careful_work"]]) {
                expect(await base.store.readNodeExecution(at(index, nodeId))).toMatchObject({ state: "completed", outcome: "ok", resultKind: "business" });
            }
            // The fork was cancelled by the stop's end, with no report: not timed_out, not blocked.
            const fork = await base.store.readNodeExecution(views);
            expect(fork).toMatchObject({ state: "completed", outcome: "cancelled", resultKind: "runtime_error", winner: "stop" });
            expect(fork.error).toMatchObject({ code: "cancelled", message: "The run stopped before this parallel state joined its branches." });
            expect(fork.error.details).toBeUndefined();
            expect(await cancelEvents(base, workflowSessionId)).toEqual([]);
        });
    });

    it("NB-R5: a failFast block cuts the other branch and decides the fork in one transaction", { timeout: TIMEOUT }, async () => {
        await withRuntime(async base => {
            const doc = branchesDoc({ failFast: true, quick: { input: { ms: 1_500, fail: true } }, careful: { input: { ms: 9_000 } } });
            // Every cut the controller asks for finds the fork already decided: the store cut and decided it together.
            const cut = base.store.cancelBranchScopes.bind(base.store);
            const forkAtCut = [];
            let forkId = null;
            base.store.cancelBranchScopes = async input => {
                if (forkId !== null) forkAtCut.push((await base.store.readNodeExecution(forkId))?.state ?? null);
                return cut(input);
            };
            try {
                const { runId, views, at } = await started(base, doc);
                forkId = views;
                const run = await endedRun(base, runId);
                expect(run).toMatchObject({ status: "completed", terminalNodeId: "stuck" });
                expect(await base.store.readNodeExecution(at(1, "careful_work"))).toMatchObject({ state: "completed", outcome: "cancelled", winner: "fail_fast" });
                expect(forkAtCut.length).toBeGreaterThan(0);
                expect(forkAtCut.every(state => state === "completed")).toBe(true);
                expect((await base.store.readNodeExecution(views)).output.branches.map(item => [item.name, item.ended])).toEqual([["quick", "terminal"], ["careful", "cancelled"]]);
                // The store's report: a branch a cut ended says why.
                expect((await base.store.readNodeExecution(views)).output.branches[1]).toMatchObject({ cancelledBy: "failFast" });
            } finally {
                base.store.cancelBranchScopes = cut;
            }
        });
    });

    it("the stop hold: a join asked after the stop was accepted answers wait, cuts nothing and writes no report", { timeout: TIMEOUT }, async () => {
        await withRuntime(async base => {
            // failFast; quick fails after 3 s, careful runs 60 s. The stop is accepted before quick fails, so the controller
            // routes nothing after; quick's failure is stored, and a join asked now would block the fork and cut careful.
            const doc = branchesDoc({ failFast: true, quick: { input: { ms: 3_000, fail: true } }, careful: { input: { ms: 60_000 } } });
            const { workflowSessionId, runId, views, at } = await started(base, doc);
            await until(async () => (await base.store.readNodeExecution(at(1, "careful_work")))?.state === "pending", "both branches' work to start");
            await controlWorkflowRun(base.host, workflowSessionId, { operation: "stop", runId: null, reason: "enough", graceSeconds: 300 },
                { actor: ACTOR, operationId: "stop-join" });
            await until(async () => (await base.store.readNodeExecution(at(0, "quick_work")))?.outcome === "bad", "quick's failure to be stored");
            const projected = [];
            const asked = await base.store.decideParallelJoin({
                nodeExecutionId: views, notStarted: [],
                joined: () => { throw new Error("nothing joins"); },
                projection: decided => { projected.push(decided); return { sessionId: workflowSessionId, events: [] }; },
            });
            expect(asked.result).toBe("wait");
            expect(asked.cancelled).toEqual([]);
            expect(projected).toEqual([]);
            expect(await base.store.readNodeExecution(views)).toMatchObject({ state: "pending" });
            expect(await base.store.readNodeExecution(at(1, "careful_work"))).toMatchObject({ state: "pending" });
            expect(await cancelEvents(base, workflowSessionId)).toEqual([]);
            await controlWorkflowRun(base.host, workflowSessionId, { operation: "cancel", runId: null, reason: "done" }, { actor: ACTOR, operationId: "cancel-join" });
            expect((await endedRun(base, runId)).status).toBe("cancelled");
        });
    });

    it("the stop hold: a test run's clock advanced past the fork's time limit during a stop settles nothing", { timeout: TIMEOUT }, async () => {
        await withRuntime(async base => {
            // A test run: the fork's time limit is 60 virtual seconds; each branch waits 600.
            const parent = randomUUID();
            await base.catalog.createSession(parent, {});
            const workflowSessionId = randomUUID();
            const doc = branchesDoc({ timeoutSeconds: 60, quick: { wait: true }, careful: { wait: true } });
            const created = await createWorkflow(base.host, { workflowSessionId, parentSessionId: parent, yaml: yamlOf(doc), actor: ACTOR, operationId: "create" });
            expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
            const update = async args => JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowSessionId, ...args },
                { callerSessionId: parent, host: base.host }));
            const test = await update({ operation: "test", operation_id: "test-1", expected_revision: 1, definition_hash: created.receipt.yamlSha256, inputs: {} });
            expect(test, JSON.stringify(test)).toMatchObject({ ok: true, run: { mode: "test" } });
            const runId = test.run.runId;
            const views = nodeExecutionIdFor(runId, "root", "views", 1);
            const hold = index => nodeExecutionIdFor(runId, branchScopeId(views, index), index === 0 ? "quick_hold" : "careful_hold", 1);
            await until(async () => (await base.store.readNodeExecution(hold(1)))?.state === "pending", "both waits to start");
            await controlWorkflowRun(base.host, workflowSessionId, { operation: "stop", runId, reason: "enough", graceSeconds: 300 },
                { actor: ACTOR, operationId: "stop-clock" });
            const advanced = await update({ operation: "test_advance", operation_id: "advance-1", run_id: runId, seconds: 61 });
            expect(advanced, JSON.stringify(advanced)).toMatchObject({ ok: true });
            // Nothing decided: the fork is pending, both waits still run, nothing was cut.
            expect(JSON.stringify(advanced)).not.toContain(views);
            expect(await base.store.readNodeExecution(views)).toMatchObject({ state: "pending" });
            for (const index of [0, 1]) expect(await base.store.readNodeExecution(hold(index))).toMatchObject({ state: "pending" });
            expect(await cancelEvents(base, workflowSessionId)).toEqual([]);
            await controlWorkflowRun(base.host, workflowSessionId, { operation: "cancel", runId, reason: "done" }, { actor: ACTOR, operationId: "cancel-clock" });
            expect((await endedRun(base, runId)).status).toBe("cancelled");
        });
    });

    it("the stop's grace ends with branch work still running: the run ends stopped, the fork cancelled with no report", { timeout: TIMEOUT }, async () => {
        await withRuntime(async base => {
            const { workflowSessionId, runId, views, at } = await started(base, branchesDoc({ quick: { wait: true }, careful: { wait: true } }));
            await until(async () => (await base.store.readNodeExecution(at(1, "careful_hold")))?.state === "pending", "both waits to start");
            await controlWorkflowRun(base.host, workflowSessionId, { operation: "stop", runId: null, reason: "enough", graceSeconds: 2 },
                { actor: ACTOR, operationId: "stop-grace" });
            const run = await endedRun(base, runId, 60_000);
            expect(run.status).toBe("stopped");
            expect(run.terminalError).toMatchObject({ code: "stopped", details: { graceExpired: true } });
            // The branches' waits were still running: the stop's end cancelled them, and the fork with them, with no report.
            for (const [index, nodeId] of [[0, "quick_hold"], [1, "careful_hold"]]) {
                expect(await base.store.readNodeExecution(at(index, nodeId))).toMatchObject({ state: "completed", outcome: "cancelled", winner: "stop" });
            }
            const fork = await base.store.readNodeExecution(views);
            expect(fork).toMatchObject({ state: "completed", outcome: "cancelled", resultKind: "runtime_error", winner: "stop" });
            expect(fork.error).toEqual({ code: "cancelled", message: "The run stopped before this parallel state joined its branches." });
            expect(await cancelEvents(base, workflowSessionId)).toEqual([]);
        });
    });

    it("a cut of two forks' branches names each from its own fork, never from the first scope's", { timeout: TIMEOUT }, async () => {
        await withRuntime(async base => {
            // Two named forks in a row: first (a1, a2) joins at once; second (b1, b2) waits.
            const doc = {
                apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: "two-forks", version: "1.0.0" },
                initialInput: { ms: 0 }, initial: "first",
                states: {
                    first: { type: "parallel", branches: { a1: branch("a1"), a2: branch("a2") },
                        transition: { next: { joined: "second", blocked: "failed", failure: "failed" } } },
                    second: { type: "parallel", branches: { b1: branch("b1", { wait: true }), b2: branch("b2", { wait: true }) },
                        transition: { next: { joined: "finished", blocked: "failed", failure: "failed" } } },
                    finished: { type: "terminal", outcome: "succeeded", output: "${input}" },
                    failed: { type: "terminal", outcome: "failed", output: "${input}" },
                },
            };
            const parent = randomUUID();
            await base.catalog.createSession(parent, {});
            const workflowSessionId = randomUUID();
            const created = await createWorkflow(base.host, {
                workflowSessionId, parentSessionId: parent, yaml: yamlOf(doc), actor: ACTOR, operationId: "start", start: { inputs: {} },
            });
            expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
            const runId = created.receipt.run.runId;
            const first = nodeExecutionIdFor(runId, "root", "first", 1);
            const second = nodeExecutionIdFor(runId, "root", "second", 1);
            await until(async () => (await base.store.readNodeExecution(nodeExecutionIdFor(runId, branchScopeId(second, 1), "b2_hold", 1)))?.state === "pending",
                "the second fork's waits to start");
            expect(await base.store.readNodeExecution(first)).toMatchObject({ state: "completed", outcome: "joined" });
            // One cut over both forks' scopes (as retryOwedCuts may ask): first's ended already, so only second's are cut.
            const named = [];
            const answer = await base.store.cancelBranchScopes({ runId, scopeIds: [branchScopeId(first, 0), branchScopeId(second, 0), branchScopeId(second, 1)],
                reason: "join", projection: (cancelled, scopeIds, names) => { named.push({ scopeIds, names }); return { sessionId: workflowSessionId, events: [] }; } });
            expect(answer.active).toBe(true);
            expect(named).toEqual([{ scopeIds: [branchScopeId(second, 0), branchScopeId(second, 1)], names: ["b1", "b2"] }]);
            // Its branches ended by the cut: the second fork blocks and the run ends at its failed end (a run that ends at a
            // terminal with outcome failed is failed).
            expect(await endedRun(base, runId)).toMatchObject({ status: "failed", terminalNodeId: "failed" });
        });
    });

    it("a worker restart while a branch waits: the run goes on and joins by name", { timeout: 180_000 }, async () => {
        const base = await baseOf(getEnv());
        const workers = [await runtimeOn(base)];
        try {
            const doc = branchesDoc({ quick: { input: { ms: 0 } }, careful: { wait: true } });
            doc.states.views.branches.careful.states.careful_hold.seconds = 4;
            const { runId, at } = await started(base, doc);
            await until(async () => (await base.store.readNodeExecution(at(1, "careful_hold")))?.state === "pending", "the wait to start");
            await workers[0].stop();
            await pause(1_000);
            workers.push(await runtimeOn(base));
            const run = await endedRun(base, runId, 90_000);
            expect(run).toMatchObject({ status: "completed", terminalNodeId: "finished" });
            expect(Object.keys(run.terminalOutput).sort()).toEqual(["careful", "quick"]);
            expect(run.terminalOutput.careful.lane).toBe("careful");
        } finally {
            for (const worker of workers) await worker.stop();
            await base.catalog.close();
        }
    });
});
