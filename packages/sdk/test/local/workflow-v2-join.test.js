/**
 * Workflow v2 parallel joins of the first k and a parallel state's own time
 * limit (IR 9; owner decision join-k-of-n of 2026-11-04), INACTIVE: only
 * controller 1.9.0 runs them, and only tests register it and start runs there
 * (the test-only option workflowRequests and a host with `requests`).
 *
 * - The compiler: every accepted and refused form of `join` (all,
 *   all_required, { first: k }) and of `timeoutSeconds`, the timed_out route
 *   it needs (and that is refused without it), k against a literal list; IR 9
 *   only for a state that uses one of them, so every other IR stays as it was;
 *   the stored IR's checks.
 * - The store: the time limit decides once by its clock (not due, then
 *   timed_out with every branch's end and their pending work cancelled), and
 *   once only against a join (both orders); a branch of a decided parallel
 *   state admits nothing more; the cancellations are listed with why.
 * - Controller 1.9.0 on a native duroxide runtime: a race of three scripts of
 *   different lengths (one winner, the others cancelled, nothing of theirs
 *   routed later); the first 2 of 4 in the order they finished; k that can no
 *   longer happen with failFast and without; a time limit with 1 of 3
 *   finished (its output kept, the running one cancelled, the queued one not
 *   started; a late result loses); a binding with fewer items than k, and no
 *   items; the time limit and the join at one virtual instant (a test run's
 *   clock: one decision); the time limit while the run is paused; a worker
 *   restart, and a continue-as-new, while the time limit is pending; an IR 8
 *   parallel run schedules what it did before.
 *
 * Branch scripts run as real script processes; the race cases rely on timing
 * margins of at least a second between the branches that win and those that
 * lose. No model runs. Not an activation proof. The agent branch cancelled at
 * the time limit is in workflow-v2-agent-node.test.js (its child double).
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import {
    compileWorkflowV2, parseWorkflowIr, WORKFLOW_V2_AGENT_IR_VERSION, WORKFLOW_V2_JOIN_IR_VERSION, WORKFLOW_V2_MILESTONE_IR_VERSION,
    WORKFLOW_V2_PARALLEL_MAX_ITEMS,
} from "../../src/workflow/v2/compiler.ts";
import { canonicalJson } from "../../src/workflow/v2/json.ts";
import { PARALLEL_TIMEOUT_MESSAGE } from "../../src/workflow/v2/parallel.ts";
import { controlWorkflowV2Run, createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { readWorkflowV2View, updateWorkflowFromTool } from "../../src/workflow/v2/tools.ts";
import {
    BRANCH_ROUTE, branchScopeId, describeWorkflowV2State, registerWorkflowV2, sessionQueueTransport, WORKFLOW_V2_REQUEST_ACTIVITIES,
    WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, workflowLiveControllerInstanceId,
} from "../../src/workflow/v2/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/v2/store.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { openWorkflowStore } from "../helpers/workflow-v2-request-fixture.js";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-join-test" };
const PARALLEL = { enableRequests: true, enableAgents: true, enableParallel: true };
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

/** A definition as a document (JSON is YAML). */
const yamlOf = doc => JSON.stringify(doc, null, 2);
const errorsOf = result => result.diagnostics.filter(item => item.severity === "error");
const head = name => ({ apiVersion: "pilotswarm.dev/v2-draft", kind: "Workflow", metadata: { name, version: "1.0.0" } });

/**
 * Each branch's script waits its item's `ms`, then ends `bad` for an item with `fail`, `hold` for an item with `seconds`
 * (a wait of that many seconds, then success), and `ok` otherwise; its output is its index and its item.
 */
const WORK = "const item = context.input;\n"
    + "await new Promise(resolve => setTimeout(resolve, item.ms ?? 0));\n"
    + "await setResult(item.fail ? \"bad\" : item.seconds ? \"hold\" : \"ok\", { index: context.branch.index, ...item });\n";

/** A parallel state over `items` with the join, failFast, concurrency and time limit given; its routes lead to the outer terminals. */
function joinDoc({ items = [], forEach = "${input.items}", join, failFast = false, concurrency, timeoutSeconds } = {}) {
    const timed = timeoutSeconds !== undefined;
    return {
        ...head("join-k"),
        initialInput: { items },
        initial: "fan",
        states: {
            fan: {
                type: "parallel", forEach, concurrency: concurrency ?? Math.max(1, Math.min(Array.isArray(items) ? items.length : 1, 16)),
                ...(join !== undefined ? { join } : {}), ...(failFast ? { failFast: true } : {}), ...(timed ? { timeoutSeconds } : {}),
                body: {
                    initial: "work",
                    states: {
                        work: { type: "script", source: WORK, transition: { next: { ok: "done", bad: "refused", hold: "hold" } } },
                        hold: { type: "wait", seconds: "${input.seconds}", transition: { next: { elapsed: "done" } } },
                        done: { type: "terminal", outcome: "succeeded", output: "${input}" },
                        refused: { type: "terminal", outcome: "blocked", output: "${input}" },
                    },
                },
                transition: { next: { joined: "finished", blocked: "stuck", failure: "failed", ...(timed ? { timed_out: "late" } : {}) } },
            },
            finished: { type: "terminal", outcome: "succeeded", output: "${input}" },
            stuck: { type: "terminal", outcome: "blocked", output: "${input}" },
            failed: { type: "terminal", outcome: "failed" },
            ...(timed ? { late: { type: "terminal", outcome: "blocked", output: "${input}" } } : {}),
        },
    };
}

describe("workflow v2 parallel joins: compiler and IR 9", () => {
    it("compiles join all, all_required and { first: k }, and timeoutSeconds; IR 9 only for a state that uses one of them", () => {
        for (const join of [undefined, "all", "all_required"]) {
            const compiled = compileWorkflowV2(yamlOf(joinDoc({ items: [{ ms: 0 }], join })), PARALLEL);
            expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
            // A join of every branch without a time limit is IR 8, written exactly as before.
            expect(compiled.ir.irVersion).toBe(WORKFLOW_V2_AGENT_IR_VERSION);
            expect(compiled.ir.nodes.fan.join).toBe("all_required");
            expect(Object.keys(compiled.ir.nodes.fan).sort()).toEqual(
                ["body", "concurrency", "description", "failFast", "forEach", "id", "inputSchema", "join", "next", "outputSchema", "type"]);
        }
        const first = compileWorkflowV2(yamlOf(joinDoc({ items: [{ ms: 0 }, { ms: 1 }], join: { first: 2 } })), PARALLEL);
        expect(first.valid, JSON.stringify(first.diagnostics)).toBe(true);
        expect(first.ir.irVersion).toBe(WORKFLOW_V2_JOIN_IR_VERSION);
        expect(first.ir.nodes.fan).toMatchObject({ join: { first: 2 } });
        expect(first.ir.nodes.fan.timeoutSeconds).toBeUndefined();

        const timed = compileWorkflowV2(yamlOf(joinDoc({ items: [{ ms: 0 }], timeoutSeconds: 30 })), PARALLEL);
        expect(timed.valid, JSON.stringify(timed.diagnostics)).toBe(true);
        expect(timed.ir.irVersion).toBe(WORKFLOW_V2_JOIN_IR_VERSION);
        expect(timed.ir.nodes.fan).toMatchObject({ join: "all_required", timeoutSeconds: 30, next: expect.objectContaining({ timed_out: "late" }) });
        const bound = compileWorkflowV2(yamlOf({ ...joinDoc({ items: [{ ms: 0 }], timeoutSeconds: "${input.limit}" }), initialInput: { items: [{ ms: 0 }], limit: 5 } }),
            PARALLEL);
        expect(bound.valid, JSON.stringify(bound.diagnostics)).toBe(true);
        expect(bound.ir.nodes.fan.timeoutSeconds).toBe("${input.limit}");
        // The graph and events show them; an IR 8 state shows neither.
        expect(describeWorkflowV2State(timed.ir.nodes.fan)).toMatchObject({ join: "all_required", timeoutSeconds: 30 });
        expect(describeWorkflowV2State(first.ir.nodes.fan)).toMatchObject({ join: { first: 2 } });
        expect(describeWorkflowV2State(first.ir.nodes.fan).timeoutSeconds).toBeUndefined();

        // A reader takes IR 9 only when asked to, and stored IR 9 reads back as compiled.
        for (const compiled of [first, timed, bound]) {
            const stored = JSON.parse(canonicalJson(compiled.ir));
            expect(parseWorkflowIr(stored, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION })).toEqual(compiled.ir);
            expect(() => parseWorkflowIr(stored, { maxIrVersion: WORKFLOW_V2_AGENT_IR_VERSION })).toThrow(/stored IR version 9 is not supported/);
            expect(() => parseWorkflowIr(stored)).toThrow(/stored IR version 9 is not supported/);
        }
        expect(WORKFLOW_V2_MILESTONE_IR_VERSION).toBe(WORKFLOW_V2_JOIN_IR_VERSION);
    });

    it("refuses every other join, a k above a literal list, a bad time limit, and a timed_out route without a time limit or the reverse", () => {
        const variant = (options, change = () => {}) => {
            const doc = joinDoc(options);
            change(doc, doc.states.fan);
            return compileWorkflowV2(yamlOf(doc), PARALLEL);
        };
        const items = [{ ms: 0 }, { ms: 0 }];
        for (const [label, options, change, code, path] of [
            ["first 0", { items, join: { first: 0 } }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.join"],
            ["first negative", { items, join: { first: -1 } }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.join"],
            ["first not an integer", { items, join: { first: 1.5 } }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.join"],
            ["first as text", { items, join: { first: "2" } }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.join"],
            ["first above the item limit", { join: { first: WORKFLOW_V2_PARALLEL_MAX_ITEMS + 1 } }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.join"],
            ["first with another field", { items, join: { first: 1, of: 2 } }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.join"],
            ["any", { items, join: "any" }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.join"],
            ["a number", { items, join: 2 }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.join"],
            ["k above a literal list", { join: { first: 3 } }, (_, fan) => { fan.forEach = items; }, "WORKFLOW_FIELD_INVALID", "states.fan.join.first"],
            ["timeout 0", { items, timeoutSeconds: 0 }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.timeoutSeconds"],
            ["timeout above a day", { items, timeoutSeconds: 86_401 }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.timeoutSeconds"],
            ["timeout not an integer", { items, timeoutSeconds: 1.5 }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.timeoutSeconds"],
            ["timeout text that is no binding", { items, timeoutSeconds: "soon" }, undefined, "WORKFLOW_FIELD_INVALID", "states.fan.timeoutSeconds"],
            ["timeout bound to branch", { items, timeoutSeconds: "${branch.index}" }, undefined, "WORKFLOW_BINDING_INVALID", "states.fan.timeoutSeconds"],
            ["timeout without a timed_out route", { items, timeoutSeconds: 5 }, (_, fan) => { delete fan.transition.next.timed_out; },
                "WORKFLOW_ROUTE_MISSING", "states.fan.transition.next"],
            ["a timed_out route without a timeout", { items }, (doc, fan) => {
                fan.transition.next.timed_out = "stuck";
            }, "WORKFLOW_ROUTE_INVALID", "states.fan.transition.next.timed_out"],
        ]) {
            const result = variant(options, change);
            expect(result.valid, label).toBe(false);
            expect(errorsOf(result).map(item => [item.code, item.path]), label).toContainEqual([code, path]);
        }
        // k equal to a literal list's items, and the largest k, compile.
        const equal = variant({ join: { first: 2 } }, (_, fan) => { fan.forEach = items; });
        expect(equal.valid, JSON.stringify(equal.diagnostics)).toBe(true);
        expect(equal.ir.nodes.fan.join).toEqual({ first: 2 });
        const largest = variant({ items, join: { first: WORKFLOW_V2_PARALLEL_MAX_ITEMS }, timeoutSeconds: 86_400 });
        expect(largest.valid, JSON.stringify(largest.diagnostics)).toBe(true);
        // The message for k above a literal list says why.
        expect(errorsOf(variant({ join: { first: 3 } }, (_, fan) => { fan.forEach = items; })).find(item => item.path === "states.fan.join.first").message)
            .toBe("join.first is 3, but forEach lists 2 items: 3 successes can never happen.");
    });

    it("refuses stored IR whose join or time limit its version does not have, or that is malformed", () => {
        const first = compileWorkflowV2(yamlOf(joinDoc({ items: [{ ms: 0 }], join: { first: 1 }, timeoutSeconds: 10 })), PARALLEL);
        expect(first.valid, JSON.stringify(first.diagnostics)).toBe(true);
        const stored = JSON.parse(canonicalJson(first.ir));
        const read = value => parseWorkflowIr(value, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION });
        const withFan = change => ({ ...stored, nodes: { ...stored.nodes, fan: { ...stored.nodes.fan, ...change } } });
        for (const broken of [
            { ...stored, irVersion: 8 },
            { ...withFan({ timeoutSeconds: undefined }), irVersion: 8 },
            withFan({ join: { first: 0 } }),
            withFan({ join: { first: 2.5 } }),
            withFan({ join: { first: 1, extra: true } }),
            withFan({ join: "any" }),
            withFan({ timeoutSeconds: 0 }),
            withFan({ timeoutSeconds: true }),
        ]) {
            expect(() => read(JSON.parse(JSON.stringify(broken)))).toThrow(/stored IR/);
        }
        // An IR 8 state with neither reads back as it was.
        const plain = compileWorkflowV2(yamlOf(joinDoc({ items: [{ ms: 0 }] })), PARALLEL);
        expect(read(JSON.parse(canonicalJson(plain.ir)))).toEqual(plain.ir);
    });
});

// ─── The store ───────────────────────────────────────────────

/** A published workflow of `doc` with an admitted live run (no controller), and its parallel state's node execution id. */
async function storedRun(h, doc) {
    const parent = randomUUID();
    await h.catalog.createSession(parent, {});
    const yaml = yamlOf(doc);
    const compiled = compileWorkflowV2(yaml, PARALLEL);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    expect(await h.catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: parent, owner: null,
        creationConfig: { workflowV2: { requestSha256: "join" } } })).toEqual({ created: true });
    await h.store.createDefinition({
        workflowSessionId, parentSessionId: parent, notifyParent: false, yaml, compiled, actor: ACTOR,
        operationId: "create", requestSha256: "join", publish: true, title: "Workflow: join",
        start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
            inputsText: "{}", kvText: "{}", testAgentMode: null, controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION },
    });
    const fan = nodeExecutionIdFor(runId, "root", "fan", 1);
    return { workflowSessionId, runId, fan };
}

const enterFan = (h, { runId, fan }, seconds) => h.store.enterNode({
    runId, nodeExecutionId: fan, scopeId: "root", nodeId: "fan", ordinal: 1, nodeType: "parallel", predecessorId: null, arrivalRoute: null,
    inputText: canonicalJson([{ seconds: 600 }, { seconds: 600 }]), kvRevision: 1, waitSeconds: seconds, immediate: null,
});
const enterHold = (h, { runId, fan }, index) => h.store.enterNode({
    runId, nodeExecutionId: nodeExecutionIdFor(runId, branchScopeId(fan, index), "hold", 1), scopeId: branchScopeId(fan, index), nodeId: "hold",
    ordinal: 1, nodeType: "wait", predecessorId: fan, arrivalRoute: BRANCH_ROUTE, inputText: canonicalJson({ seconds: 600 }), kvRevision: 1,
    waitSeconds: 600, immediate: null,
});

describe("workflow v2 parallel joins: the store", () => {
    it("decides a parallel state's time limit once by its clock: not due, then timed_out with every branch's end and their work cancelled", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const run = await storedRun(h, joinDoc({ items: [{ seconds: 600 }, { seconds: 600 }], timeoutSeconds: 1 }));
            const entered = await enterFan(h, run, 1);
            expect(entered).toMatchObject({ admitted: true, node: { state: "pending", nodeType: "parallel" } });
            expect(entered.node.deadlineAt.getTime() - entered.node.enteredAt.getTime()).toBe(1_000);
            const hold = (await enterHold(h, run, 0)).node.nodeExecutionId;
            const projection = decided => ({ sessionId: run.workflowSessionId, events: [{ eventType: "workflow.state_failed",
                data: { runId: run.runId, nodeExecutionId: run.fan, outcome: "timed_out", branches: decided.total, succeeded: decided.succeeded } }] });
            const early = await h.store.elapseParallelNode(run.fan, projection);
            expect(early).toMatchObject({ result: "not_due", node: { state: "pending" } });
            expect(early.remainingMs).toBeGreaterThanOrEqual(1);
            expect(early.remainingMs).toBeLessThanOrEqual(1_000);

            const elapsed = await until(async () => {
                const result = await h.store.elapseParallelNode(run.fan, projection);
                return result.result === "elapsed" ? result : null;
            }, "the time limit to pass", 10_000);
            expect(elapsed.cancelled).toEqual([hold]);
            const report = {
                joined: false, timedOut: true, total: 2, needed: 2, succeeded: 0, failFast: false,
                branches: [
                    { index: 0, ended: "cancelled", nodeExecutionId: hold, outcome: "cancelled", resultKind: "runtime_error",
                        error: { code: "cancelled", message: "The parallel state's time limit passed before its join, so this branch was cancelled." } },
                    { index: 1, ended: "not_started", nodeExecutionId: null, outcome: null, resultKind: null },
                ],
            };
            expect(await h.store.readNodeExecution(run.fan)).toMatchObject({
                state: "completed", outcome: "timed_out", resultKind: "runtime_error", winner: "controller",
                error: { code: "timed_out", message: PARALLEL_TIMEOUT_MESSAGE, details: report },
            });
            const fanRow = await h.store.readNodeExecution(run.fan);
            expect(fanRow.completedAt.getTime()).toBeGreaterThanOrEqual(fanRow.deadlineAt.getTime());
            expect(await h.store.readNodeExecution(hold)).toMatchObject({ state: "completed", outcome: "cancelled", winner: "join_timeout" });
            const events = await h.catalog.getSessionEvents(run.workflowSessionId, 0, 200);
            expect(events.filter(event => event.data?.nodeExecutionId === run.fan && event.eventType === "workflow.state_failed").map(event => event.data))
                .toEqual([{ runId: run.runId, nodeExecutionId: run.fan, outcome: "timed_out", branches: 2, succeeded: 0 }]);
            expect(events.filter(event => event.eventType === "workflow.branches_cancelled").map(event => event.data)).toEqual([expect.objectContaining({
                runId: run.runId, cancelled: [hold], cancelledCount: 1, reason: "timeout" })]);

            // Once only: the time limit again, a join after it, and a later result of the branch all find it decided.
            expect(await h.store.elapseParallelNode(run.fan, projection)).toMatchObject({ result: "decided", node: { outcome: "timed_out" } });
            expect(await h.store.completeNode(run.fan, { outcome: "joined", resultKind: "business", valueText: "[]", winner: "controller" }))
                .toMatchObject({ won: false, node: { outcome: "timed_out" } });
            expect(await h.store.completeNode(hold, { outcome: "elapsed", resultKind: "business", valueText: "{}", winner: "controller" }))
                .toMatchObject({ won: false, node: { outcome: "cancelled" } });
            // A branch of the decided state admits nothing more.
            expect(await enterHold(h, run, 1)).toMatchObject({ admitted: false, reason: "cut" });
            expect(await h.store.readNodeExecution(nodeExecutionIdFor(run.runId, branchScopeId(run.fan, 1), "hold", 1))).toBeFalsy();
            // The controller's cut of the branches finds what the time limit cancelled, with why, for their effects and children.
            expect(await h.store.cancelBranchScopes({ runId: run.runId, scopeIds: [0, 1].map(index => branchScopeId(run.fan, index)), reason: "timeout" }))
                .toEqual({ active: true, cancelled: [{ nodeExecutionId: hold, nodeType: "wait", reason: "timeout" }] });
            // It cancelled nothing new, so it recorded nothing new.
            expect((await h.catalog.getSessionEvents(run.workflowSessionId, 0, 200)).filter(event => event.eventType === "workflow.branches_cancelled")).toHaveLength(1);
        } finally {
            await h.stop();
        }
    });

    it("a join decided first keeps the state from its time limit; a join's cancellation is recorded as such", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const run = await storedRun(h, joinDoc({ items: [{ seconds: 600 }, { seconds: 600 }], join: { first: 1 }, timeoutSeconds: 1 }));
            await enterFan(h, run, 1);
            const first = (await enterHold(h, run, 0)).node.nodeExecutionId;
            const second = (await enterHold(h, run, 1)).node.nodeExecutionId;
            // The first branch won the join of the first 1: the other is cancelled for the join, then the state is joined.
            await h.store.completeNode(first, { outcome: "elapsed", resultKind: "business", valueText: "{}", winner: "controller" });
            expect(await h.store.cancelBranchScopes({ runId: run.runId, scopeIds: [branchScopeId(run.fan, 1)], reason: "join" }))
                .toEqual({ active: true, cancelled: [{ nodeExecutionId: second, nodeType: "wait", reason: "join" }] });
            expect(await h.store.readNodeExecution(second)).toMatchObject({ outcome: "cancelled", winner: "join",
                error: { code: "cancelled", message: "The parallel state's join had the successes it needs, so this branch was cancelled." } });
            expect(await h.store.completeNode(run.fan, { outcome: "joined", resultKind: "business", valueText: "[]", winner: "controller" }))
                .toMatchObject({ won: true });
            // Past the time limit, it finds the state decided and changes nothing.
            await pause(1_100);
            expect(await h.store.elapseParallelNode(run.fan)).toMatchObject({ result: "decided", node: { outcome: "joined", resultKind: "business" } });
            expect(await h.store.readNodeExecution(first)).toMatchObject({ outcome: "elapsed" });
        } finally {
            await h.stop();
        }
    });
});

// ─── Controller 1.9.0 on a native runtime ────────────────────

/** A worker-equivalent registration with workflowRequests and the request tag declared. */
async function harness(env, { wakeBackstopMs = 500 } = {}) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
    });
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows notify no parent."); },
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs,
        workflowRequests: true,
        sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
    });
    await runtime.start();
    return {
        catalog, store, client, host: { catalog, store, duroxideClient: client, requests: true },
        async stop() {
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

/** A parent session and a started live run of `doc` it created, with the ids of its parallel state and its branches' states. */
async function started(h, doc) {
    const parent = randomUUID();
    await h.catalog.createSession(parent, {});
    const workflowSessionId = randomUUID();
    const created = await createWorkflowV2(h.host, {
        workflowSessionId, parentSessionId: parent, yaml: yamlOf(doc), actor: ACTOR, operationId: "start", start: { inputs: {} },
    });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    const runId = created.receipt.run.runId;
    const fan = nodeExecutionIdFor(runId, "root", "fan", 1);
    return { parent, workflowSessionId, runId, fan, at: (index, nodeId) => nodeExecutionIdFor(runId, branchScopeId(fan, index), nodeId, 1) };
}

const ENDED = ["completed", "failed", "cancelled", "stopped"];
const ended = (h, runId, timeoutMs = 60_000) => until(async () => {
    const run = await h.store.readRun(runId);
    return run && ENDED.includes(run.status) ? run : null;
}, `run ${runId} to end`, timeoutMs);
const branchRows = async (h, runId, fan, index) => (await h.store.listNodeExecutions(runId)).filter(node => node.scopeId === branchScopeId(fan, index));
const eventsOf = async (h, workflowSessionId) => h.catalog.getSessionEvents(workflowSessionId, 0, 1_000);

/** The inputs of every `name` activity a controller instance scheduled, in every execution (selected by the name token first). */
async function scheduledInputs(client, instanceId, name) {
    const executions = await client.listExecutions(instanceId);
    const histories = await Promise.all(executions.map(id => client.readExecutionHistory(instanceId, id)));
    const prefix = `{"name":${JSON.stringify(name)}`;
    return histories.flat().filter(event => event.kind === "ActivityScheduled" && String(event.data).startsWith(prefix)).map(event => {
        const payload = JSON.parse(event.data);
        return typeof payload.input === "string" ? JSON.parse(payload.input) : payload.input;
    });
}

describe("workflow v2 parallel joins of the first k: controller 1.9.0 (inactive, test-only registration)", () => {
    it("a race of three scripts: the first success joins, the others are cancelled with their effects, and nothing of theirs is routed later", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const begun = Date.now();
            const { workflowSessionId, runId, fan, at } = await started(h, joinDoc({ items: [{ ms: 200 }, { ms: 5_000 }, { ms: 9_000 }], join: { first: 1 } }));
            const run = await ended(h, runId);
            const won = [{ index: 0, output: { index: 0, ms: 200 } }];
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalNodeId: "finished", terminalOutput: won });
            expect(await h.store.readNodeExecution(fan)).toMatchObject({ state: "completed", outcome: "joined", resultKind: "business", output: won });
            for (const index of [1, 2]) {
                expect(await h.store.readNodeExecution(at(index, "work"))).toMatchObject({
                    state: "completed", outcome: "cancelled", resultKind: "runtime_error", winner: "join", error: { code: "cancelled" },
                });
            }
            const events = await eventsOf(h, workflowSessionId);
            expect(events.filter(event => event.eventType === "workflow.branches_cancelled").map(event => event.data)).toEqual([expect.objectContaining({
                runId, scopeIds: [1, 2].map(index => branchScopeId(fan, index)), cancelled: [at(1, "work"), at(2, "work")].sort(), cancelledCount: 2, reason: "join",
            })]);
            const asked = events.filter(event => event.eventType === "workflow.cancel_requested").map(event => event.data);
            expect(asked).toEqual([expect.objectContaining({ runId, branchesCancelled: "join" })]);
            expect(asked[0].effects.map(effect => effect.nodeExecutionId).sort()).toEqual([at(1, "work"), at(2, "work")].sort());

            // Nothing of the losers is routed later: past the slowest script's length, their branches hold only the cancelled state.
            await until(async () => Date.now() - begun >= 10_000, "the slowest script's length");
            for (const index of [1, 2]) {
                expect((await branchRows(h, runId, fan, index)).map(node => [node.nodeId, node.outcome, node.winner])).toEqual([["work", "cancelled", "join"]]);
            }
            expect((await h.store.listNodeExecutions(runId)).filter(node => node.scopeId === "root").map(node => node.nodeId)).toEqual(["fan", "finished"]);
            expect(await h.store.hasPendingNodes(runId)).toBe(false);
        } finally {
            await h.stop();
        }
    });

    it("the first 2 of 4 join in the order they finished; the other two are cancelled for the join", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const { runId, fan, at } = await started(h, joinDoc({ items: [{ ms: 6_000 }, { ms: 200 }, { ms: 10_000 }, { ms: 1_800 }], join: { first: 2 } }));
            const run = await ended(h, runId);
            const won = [{ index: 1, output: { index: 1, ms: 200 } }, { index: 3, output: { index: 3, ms: 1_800 } }];
            expect(run).toMatchObject({ status: "completed", terminalNodeId: "finished", terminalOutput: won });
            expect(await h.store.readNodeExecution(fan)).toMatchObject({ outcome: "joined", output: won });
            for (const index of [0, 2]) expect(await h.store.readNodeExecution(at(index, "work"))).toMatchObject({ outcome: "cancelled", winner: "join" });
            for (const index of [1, 3]) expect(await h.store.readNodeExecution(at(index, "done"))).toMatchObject({ outcome: "succeeded" });
        } finally {
            await h.stop();
        }
    });

    it("k that can no longer happen: failFast cancels the rest at once; without it they run to their end, then the join blocks", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const fast = await started(h, joinDoc({ items: [{ fail: true, ms: 100 }, { fail: true, ms: 300 }, { seconds: 600 }], join: { first: 2 }, failFast: true }));
            const run = await ended(h, fast.runId);
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "stuck" });
            expect(run.terminalOutput).toMatchObject({ joined: false, timedOut: false, total: 3, needed: 2, succeeded: 0, failFast: true });
            expect(run.terminalOutput.branches.map(branch => [branch.index, branch.ended, branch.outcome])).toEqual([
                [0, "terminal", "blocked"], [1, "terminal", "blocked"], [2, "cancelled", "cancelled"]]);
            const cut = await branchRows(h, fast.runId, fast.fan, 2);
            expect(cut.filter(node => node.winner === "fail_fast").map(node => node.outcome)).toEqual(["cancelled"]);
            expect(cut.some(node => node.nodeId === "done")).toBe(false);

            const slow = await started(h, joinDoc({ items: [{ fail: true, ms: 100 }, { fail: true, ms: 300 }, { seconds: 3 }], join: { first: 2 } }));
            const after = await ended(h, slow.runId);
            expect(after).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "stuck" });
            expect(after.terminalOutput).toMatchObject({ joined: false, timedOut: false, total: 3, needed: 2, succeeded: 1, failFast: false });
            expect(after.terminalOutput.branches[2]).toMatchObject({ index: 2, ended: "terminal", outcome: "succeeded", output: { index: 2, seconds: 3 } });
            // The join waited for the last branch's end.
            const done = await h.store.readNodeExecution(slow.at(2, "done"));
            expect((await h.store.readNodeExecution(slow.fan)).completedAt.getTime()).toBeGreaterThanOrEqual(done.completedAt.getTime());
        } finally {
            await h.stop();
        }
    });

    it("a binding with fewer items than k blocks at once without starting a branch; so do no items", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const few = await started(h, joinDoc({ items: [{ ms: 0 }, { ms: 0 }], join: { first: 3 } }));
            const run = await ended(h, few.runId);
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "stuck", terminalOutput: {
                joined: false, timedOut: false, total: 2, needed: 3, succeeded: 0, failFast: false,
                branches: [0, 1].map(index => ({ index, ended: "not_started", nodeExecutionId: null, outcome: null, resultKind: null })),
            } });
            expect((await h.store.listNodeExecutions(few.runId)).map(node => node.nodeId).sort()).toEqual(["fan", "stuck"]);

            const none = await started(h, joinDoc({ items: [], join: { first: 1 } }));
            expect(await ended(h, none.runId)).toMatchObject({ terminalNodeId: "stuck", terminalOutput: {
                joined: false, timedOut: false, total: 0, needed: 1, succeeded: 0, failFast: false, branches: [] } });
            // With every branch needed, no items still joins with none (as before).
            const all = await started(h, joinDoc({ items: [] }));
            expect(await ended(h, all.runId)).toMatchObject({ terminalNodeId: "finished", terminalOutput: [] });
        } finally {
            await h.stop();
        }
    });
});

describe("workflow v2 parallel time limits: controller 1.9.0 (inactive, test-only registration)", () => {
    it("ends the state timed_out with 1 of 3 finished: its output kept, the running branch cancelled, the queued one not started; a late result loses", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const { workflowSessionId, runId, fan, at } = await started(h, joinDoc({ items: [{ ms: 0 }, { seconds: 600 }, { seconds: 600 }], concurrency: 1,
                timeoutSeconds: 2 }));
            const run = await ended(h, runId);
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "late" });
            const fanRow = await h.store.readNodeExecution(fan);
            expect(fanRow).toMatchObject({ state: "completed", outcome: "timed_out", resultKind: "runtime_error", winner: "controller" });
            expect(fanRow.deadlineAt.getTime() - fanRow.enteredAt.getTime()).toBe(2_000);
            expect(fanRow.completedAt.getTime()).toBeGreaterThanOrEqual(fanRow.deadlineAt.getTime());
            const cut = (await branchRows(h, runId, fan, 1)).find(node => node.winner === "join_timeout");
            expect(cut).toMatchObject({ state: "completed", outcome: "cancelled", winner: "join_timeout" });
            const report = {
                joined: false, timedOut: true, total: 3, needed: 3, succeeded: 1, failFast: false,
                branches: [
                    { index: 0, ended: "terminal", nodeExecutionId: at(0, "done"), outcome: "succeeded", resultKind: "business", output: { index: 0, ms: 0 } },
                    { index: 1, ended: "cancelled", nodeExecutionId: cut.nodeExecutionId, outcome: "cancelled", resultKind: "runtime_error",
                        error: expect.objectContaining({ code: "cancelled" }) },
                    { index: 2, ended: "not_started", nodeExecutionId: null, outcome: null, resultKind: null },
                ],
            };
            expect(fanRow.error).toEqual({ code: "timed_out", message: PARALLEL_TIMEOUT_MESSAGE, details: report });
            // On its route, the run took the error envelope as its input.
            expect(run.terminalOutput).toEqual({ code: "timed_out", message: PARALLEL_TIMEOUT_MESSAGE, details: report });
            expect(await branchRows(h, runId, fan, 2)).toEqual([]);
            // A late result of the cancelled branch loses, and nothing of it is admitted.
            expect(await h.store.completeNode(cut.nodeExecutionId, { outcome: "elapsed", resultKind: "business", valueText: "{}", winner: "controller" }))
                .toMatchObject({ won: false });
            expect((await branchRows(h, runId, fan, 1)).map(node => node.nodeId)).not.toContain("done");

            const events = await eventsOf(h, workflowSessionId);
            expect(events.filter(event => event.data?.nodeExecutionId === fan && event.eventType.startsWith("workflow.state_")).map(event => event.eventType))
                .toEqual(["workflow.state_started", "workflow.state_failed"]);
            expect(events.find(event => event.eventType === "workflow.state_failed" && event.data.nodeExecutionId === fan).data)
                .toMatchObject({ outcome: "timed_out", resultKind: "runtime_error", branches: 3, succeeded: 1 });
            expect(events.filter(event => event.eventType === "workflow.branches_cancelled").map(event => event.data))
                .toEqual([expect.objectContaining({ cancelled: [cut.nodeExecutionId], reason: "timeout" })]);
            // read_workflow: the graph says the join and the time limit; the parallel state's visit says its deadline.
            const view = await readWorkflowV2View(h.store, workflowSessionId);
            expect(view.graph.states.find(state => state.id === "fan")).toMatchObject({ join: "all_required", timeoutSeconds: 2 });
            expect(view.run.nodeExecutions.find(node => node.nodeExecutionId === fan)).toMatchObject({
                outcome: "timed_out", resultKind: "runtime_error", deadline: fanRow.deadlineAt.toISOString(), branches: 3 });
            expect(view.run.nodeExecutions.find(node => node.nodeExecutionId === cut.nodeExecutionId)).toMatchObject({ winner: "join_timeout" });
        } finally {
            await h.stop();
        }
    });

    it("the time limit and the last branch at one instant of a test run's clock: one decision, timed_out, and nothing of the branch routed", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parentId = randomUUID();
            await h.catalog.createSession(parentId, {});
            const workflowSessionId = randomUUID();
            const created = await createWorkflowV2(h.host, { workflowSessionId, parentSessionId: parentId,
                yaml: yamlOf(joinDoc({ items: [{ seconds: 60 }], timeoutSeconds: 60 })), actor: ACTOR, operationId: "create" });
            expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
            const update = async args => JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowSessionId, ...args },
                { callerSessionId: parentId, host: h.host }));
            const test = await update({ operation: "test", operation_id: "test-1", expected_revision: 1, definition_hash: created.receipt.yamlSha256, inputs: {} });
            expect(test, JSON.stringify(test)).toMatchObject({ ok: true, run: { mode: "test" } });
            const runId = test.run.runId;
            const fan = nodeExecutionIdFor(runId, "root", "fan", 1);
            const hold = nodeExecutionIdFor(runId, branchScopeId(fan, 0), "hold", 1);
            const [fanRow, holdRow] = await until(async () => {
                const rows = await Promise.all([h.store.readNodeExecution(fan), h.store.readNodeExecution(hold)]);
                return rows.every(row => row?.state === "pending") ? rows : null;
            }, "the branch's wait");
            // Both deadlines are 60 virtual seconds after the same virtual instant.
            expect(holdRow.deadlineAt).toEqual(fanRow.deadlineAt);
            expect(await update({ operation: "test_advance", operation_id: "advance-1", run_id: runId, seconds: 60 })).toMatchObject({ ok: true });
            const run = await ended(h, runId);
            expect(run).toMatchObject({ status: "completed", terminalNodeId: "late" });
            expect(await h.store.readNodeExecution(fan)).toMatchObject({ outcome: "timed_out", resultKind: "runtime_error" });
            expect((await h.store.readNodeExecution(fan)).error.details).toMatchObject({ timedOut: true, succeeded: 0,
                branches: [expect.objectContaining({ index: 0, ended: "cancelled" })] });
            // One decision: no join, and the branch's wait (elapsed or cancelled in the same advance) led nowhere.
            const events = await eventsOf(h, workflowSessionId);
            expect(events.filter(event => event.data?.nodeExecutionId === fan && event.eventType !== "workflow.state_started").map(event => event.eventType))
                .toEqual(["workflow.state_failed"]);
            expect((await branchRows(h, runId, fan, 0)).map(node => node.nodeId).sort()).toEqual(["hold", "work"]);
            expect((await h.store.listNodeExecutions(runId)).filter(node => node.scopeId === "root").map(node => node.nodeId)).toEqual(["fan", "late"]);
        } finally {
            await h.stop();
        }
    });

    it("while the run is paused the time limit still passes; the state is timed_out then, and its route is taken after the resume", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const { workflowSessionId, runId, fan, at } = await started(h, joinDoc({ items: [{ seconds: 600 }], timeoutSeconds: 3 }));
            await until(async () => (await h.store.readNodeExecution(at(0, "hold")))?.state === "pending", "the branch's wait");
            await controlWorkflowV2Run(h.host, workflowSessionId, { operation: "pause", runId: null, reason: "look first" }, { actor: ACTOR, operationId: "pause-1" });
            await until(async () => (await h.store.readNodeExecution(fan))?.state === "completed", "the time limit to pass while paused", 30_000);
            expect(await h.store.readNodeExecution(fan)).toMatchObject({ outcome: "timed_out" });
            expect(await h.store.readNodeExecution(at(0, "hold"))).toMatchObject({ outcome: "cancelled", winner: "join_timeout" });
            expect((await h.store.readRun(runId)).status).toBe("paused");
            // Its route is not taken while paused.
            await pause(1_000);
            expect((await h.store.listNodeExecutions(runId)).map(node => node.nodeId)).not.toContain("late");
            await controlWorkflowV2Run(h.host, workflowSessionId, { operation: "resume", runId: null, reason: null }, { actor: ACTOR, operationId: "resume-1" });
            expect(await ended(h, runId)).toMatchObject({ status: "completed", terminalNodeId: "late" });
            expect(await branchRows(h, runId, fan, 0)).toHaveLength(2);
        } finally {
            await h.stop();
        }
    });

    it("carries a pending time limit across continue-as-new and decides it once at its deadline", { timeout: TIMEOUT }, async () => {
        // A 100 ms backstop makes 50 idle waits (the continue-as-new bound) pass long before the 9-second time limit.
        const h = await harness(getEnv(), { wakeBackstopMs: 100 });
        try {
            const { workflowSessionId, runId, fan } = await started(h, joinDoc({ items: [{ seconds: 600 }], timeoutSeconds: 9 }));
            const instanceId = workflowLiveControllerInstanceId(workflowSessionId);
            await until(async () => (await h.client.listExecutions(instanceId)).length >= 2
                && (await h.store.readNodeExecution(fan))?.state === "pending", "a continue-as-new while the time limit is pending", 30_000);
            const run = await ended(h, runId);
            expect(run).toMatchObject({ terminalNodeId: "late" });
            const fanRow = await h.store.readNodeExecution(fan);
            expect(fanRow).toMatchObject({ outcome: "timed_out" });
            const late = fanRow.completedAt.getTime() - fanRow.deadlineAt.getTime();
            expect(late).toBeGreaterThanOrEqual(0);
            expect(late).toBeLessThan(2_000);
            expect(await h.store.readNodeExecution(nodeExecutionIdFor(runId, "root", "fan", 2))).toBeFalsy();
            const events = await eventsOf(h, workflowSessionId);
            expect(events.filter(event => event.data?.nodeExecutionId === fan && event.eventType === "workflow.state_failed")).toHaveLength(1);
        } finally {
            await h.stop();
        }
    });
});

// A worker restart across the time limit: two runtimes in turn over one catalog and provider (the parallel restart test's
// split). The precondition is read from the store; read after the deadline, the case is VOID, not a pass or a product failure.
async function restartBaseOf(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    return { catalog, store, provider, client, host: { catalog, store, duroxideClient: client, requests: true } };
}

async function restartRuntimeOn(base) {
    const runtime = new Runtime(base.provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
        workerLockTimeoutMs: 1_000, orchestratorLockTimeoutMs: 2_000,
    });
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store: base.store, catalog: base.catalog, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows notify no parent."); },
        deleteSession: async sessionId => base.catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500, workflowRequests: true,
        sessionQueue: { ...sessionQueueTransport(base.client), version: async () => "1.0.83" },
    });
    await runtime.start();
    let running = true;
    return { async stop() { if (!running) return; running = false; await runtime.shutdown(100); } };
}

describe("workflow v2 parallel time limits: a worker restart across the deadline (controller 1.9.0, test-only)", () => {
    it("decides the time limit once after the runtime was down at its deadline, keeping the deadline", { timeout: 180_000 }, async () => {
        const base = await restartBaseOf(getEnv());
        const workers = [await restartRuntimeOn(base)];
        try {
            const parent = randomUUID();
            await base.catalog.createSession(parent, {});
            const workflowSessionId = randomUUID();
            const created = await createWorkflowV2(base.host, { workflowSessionId, parentSessionId: parent,
                yaml: yamlOf(joinDoc({ items: [{ seconds: 600 }, { seconds: 600 }], timeoutSeconds: 6 })), actor: ACTOR, operationId: "start", start: { inputs: {} } });
            expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
            const runId = created.receipt.run.runId;
            const fan = nodeExecutionIdFor(runId, "root", "fan", 1);
            const holds = [0, 1].map(index => nodeExecutionIdFor(runId, branchScopeId(fan, index), "hold", 1));
            const before = await until(async () => {
                const rows = await Promise.all([fan, ...holds].map(id => base.store.readNodeExecution(id)));
                return rows.every(row => row?.state === "pending") ? rows[0] : null;
            }, "the parallel state and its branches' waits persisted as pending", 90_000);
            expect(Date.now(), "VOID (not a product result): the precondition was read after the time limit; run the case again")
                .toBeLessThan(before.deadlineAt.getTime());
            await workers[0].stop();
            // Stay down until the deadline has passed, then start another runtime over the same catalog and provider.
            await until(async () => Date.now() >= before.deadlineAt.getTime() + 1_000, "the deadline to pass while no runtime runs", 30_000);
            expect((await base.store.readNodeExecution(fan)).state).toBe("pending");
            workers.push(await restartRuntimeOn(base));
            const run = await until(async () => {
                const current = await base.store.readRun(runId);
                return current && ENDED.includes(current.status) ? current : null;
            }, `run ${runId} to end`, 90_000);
            expect(run).toMatchObject({ status: "completed", terminalNodeId: "late" });
            const after = await base.store.readNodeExecution(fan);
            expect(after).toMatchObject({ outcome: "timed_out", enteredAt: before.enteredAt, deadlineAt: before.deadlineAt });
            for (const hold of holds) expect(await base.store.readNodeExecution(hold)).toMatchObject({ outcome: "cancelled", winner: "join_timeout" });
            expect(await base.store.readNodeExecution(nodeExecutionIdFor(runId, "root", "fan", 2))).toBeFalsy();
            const events = await base.catalog.getSessionEvents(workflowSessionId, 0, 500);
            expect(events.filter(event => event.data?.nodeExecutionId === fan && event.eventType === "workflow.state_failed")).toHaveLength(1);
            expect(await base.store.hasPendingNodes(runId)).toBe(false);
        } finally {
            for (const worker of workers) await worker.stop();
            await base.catalog.close();
        }
    });
});

describe("workflow v2 parallel states of IR 8 (controller 1.9.0, test-only)", () => {
    it("an IR 8 parallel run schedules what it did before: no time limit, no reason for its cancellation, the same join input", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const doc = joinDoc({ items: [{ fail: true, ms: 1_500 }, { seconds: 600 }], failFast: true });
            expect(compileWorkflowV2(yamlOf(doc), PARALLEL).ir.irVersion).toBe(WORKFLOW_V2_AGENT_IR_VERSION);
            const { workflowSessionId, runId, fan, at } = await started(h, doc);
            expect(await ended(h, runId)).toMatchObject({ terminalNodeId: "stuck" });
            expect((await h.store.readNodeExecution(fan)).deadlineAt).toBeNull();
            const instanceId = workflowLiveControllerInstanceId(workflowSessionId);
            expect(await scheduledInputs(h.client, instanceId, WORKFLOW_V2_REQUEST_ACTIVITIES.cancelBranches))
                .toEqual([{ runId, scopeIds: [branchScopeId(fan, 1)] }]);
            expect((await scheduledInputs(h.client, instanceId, WORKFLOW_V2_REQUEST_ACTIVITIES.elapse)).some(input => input.nodeExecutionIds.includes(fan)))
                .toBe(false);
            const joins = await scheduledInputs(h.client, instanceId, WORKFLOW_V2_REQUEST_ACTIVITIES.join);
            expect(joins).toHaveLength(1);
            expect(Object.keys(joins[0]).sort()).toEqual(["parallelNodeExecutionId", "results", "runId"]);
            expect(joins[0]).toMatchObject({ runId, parallelNodeExecutionId: fan });
            expect(joins[0].results[0]).toEqual({ index: 0, nodeExecutionId: at(0, "refused"), via: "terminal" });
            expect(joins[0].results[1]).toMatchObject({ index: 1, via: "cancelled" });
            // The second branch's state was cancelled under failFast, as before (none when it was between two states).
            const cancelled = joins[0].results[1].nodeExecutionId;
            if (cancelled !== null) expect(await h.store.readNodeExecution(cancelled)).toMatchObject({ winner: "fail_fast" });
        } finally {
            await h.stop();
        }
    });
});
