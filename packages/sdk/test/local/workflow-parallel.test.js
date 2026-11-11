/**
 * Workflow parallel states and their join (design 02 parallel scope and
 * join, D10; requirement R21), on the Workflow controller.
 *
 * - The compiler: its body states are in the IR's nodes, named by its
 *   body; its manifest, concurrency, join, routes and body are checked;
 *   `branch` is bound only in a body; ids are unique across bodies.
 * - The store: branches are admitted in their own scopes; a failFast
 *   cancellation decides their pending work once (winner fail_fast); a
 *   parallel state's own pending node is not work for a stop.
 * - The controller on a native duroxide runtime: one branch per manifest
 *   item, at most its concurrency at a time, each with its item and index;
 *   the joined outputs in manifest order; a blocked join that reports every
 *   branch; failFast; empty and invalid manifests; the join's outputSchema;
 *   a stop during a parallel state; a worker restart while every branch
 *   waits (each joined once, each wait's deadline kept).
 * - A literal forEach list (verification of SF-3, M-03): the new started
 *   event and a reader's view of the graph show it only as its count and
 *   digest; the owner's YAML keeps it; a started event an earlier build
 *   stored keeps its list (stored events are not rewritten); a binding's
 *   list default the same way (R3-SF-1).
 * - A timed_out report keeps its finished branches' business outputs as the
 *   blocked report does (R3-SF-3). Each state's end event carries its node's
 *   completed_at (S6-UI2).
 *
 * Branch scripts run as real script processes. The failFast case relies on
 * a timing margin: the failing branch waits 5 seconds before it fails, and
 * the other branch reaches its long wait well before that. No model runs.
 * Not an activation proof.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { testTime, useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import {
    compileWorkflow, parseWorkflowIr, WORKFLOW_IR_VERSION, WORKFLOW_PARALLEL_MAX_CONCURRENCY,
    WORKFLOW_PARALLEL_MAX_ITEMS,
} from "../../src/workflow/compiler.ts";
import { canonicalJson } from "../../src/workflow/json.ts";
import { controlWorkflowRun, createWorkflow } from "../../src/workflow/service.ts";
import { readWorkflowView, workflowReaderView } from "../../src/workflow/tools.ts";
import {
    BRANCH_ROUTE, branchScopeId, describeWorkflowState, describeWorkflowStates, parseBranchScope, registerWorkflow, sessionQueueTransport,
    WORKFLOW_CONTROLLER_VERSION, workflowLiveControllerInstanceId,
} from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/store.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
// CI run 114 (HorizonDB, about ten times slower): the test's own bounds grow with the database (test/helpers/time-scale.js).
const TIMEOUT = testTime.ms(120_000);
const ACTOR = { kind: "system", name: "workflow-parallel-test" };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

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

/** A definition as a document (JSON is YAML). */
const yamlOf = doc => JSON.stringify(doc, null, 2);
const errorsOf = result => result.diagnostics.filter(item => item.severity === "error");
const head = name => ({ apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name, version: "1.0.0" } });
const OUTER = {
    finished: { type: "terminal", outcome: "succeeded", output: "${input}" },
    stuck: { type: "terminal", outcome: "blocked", output: "${input}" },
    failed: { type: "terminal", outcome: "failed" },
};

/**
 * A fan-out over `items`: each branch's script doubles its item's n (outcome
 * ok), refuses a negative n (outcome negative, to a blocked terminal) and
 * reports an undeclared outcome for 0 (a runtime error no body route takes).
 */
function fanOut({ items = [{ n: 1 }, { n: 2 }, { n: 3 }], concurrency = 2, outputSchema } = {}) {
    return {
        ...head("fan-out"),
        initialInput: { items },
        initial: "fan",
        schemas: {
            Item: { type: "object", required: ["n"], properties: { n: { type: "integer" } } },
            Items: { type: "array", items: { $ref: "#/schemas/Item" } },
        },
        states: {
            fan: {
                type: "parallel", forEach: "${input.items}", concurrency, inputSchema: { $ref: "#/schemas/Items" },
                ...(outputSchema !== undefined ? { outputSchema } : {}),
                body: {
                    initial: "work",
                    states: {
                        work: {
                            type: "script",
                            source: "const n = context.input.n;\n"
                                + "await setResult(n < 0 ? \"negative\" : n === 0 ? \"zero\" : \"ok\", "
                                + "{ doubled: n * 2, index: context.branch.index, item: context.branch.item });\n",
                            transition: { next: { ok: "done", negative: "refused" } },
                        },
                        done: { type: "terminal", outcome: "succeeded", output: { doubled: "${input.doubled}", index: "${branch.index}" } },
                        refused: { type: "terminal", outcome: "blocked", output: "${input}" },
                    },
                },
                transition: { next: { joined: "finished", blocked: "stuck", failure: "failed" } },
            },
            ...OUTER,
        },
    };
}

/** Three branches, two at a time, failFast: the second fails after a 5-second wait (scaled with the database); the others wait 600 seconds. */
function failFastOut() {
    return {
        ...head("fail-fast"),
        initialInput: { items: [{ fail: false }, { fail: true }, { fail: false }] },
        initial: "fan",
        states: {
            fan: {
                type: "parallel", forEach: "${input.items}", concurrency: 2, failFast: true,
                body: {
                    initial: "decide",
                    states: {
                        decide: {
                            type: "script", source: "await setResult(context.input.fail ? \"bad\" : \"slow\", context.input);\n",
                            transition: { next: { bad: "pause", slow: "hold" } },
                        },
                        pause: { type: "wait", seconds: testTime.seconds(5), transition: { next: { elapsed: "refused" } } },
                        hold: { type: "wait", seconds: 600, transition: { next: { elapsed: "done" } } },
                        refused: { type: "terminal", outcome: "blocked", output: "${input}" },
                        done: { type: "terminal", outcome: "succeeded", output: "${input}" },
                    },
                },
                transition: { next: { joined: "finished", blocked: "stuck", failure: "failed" } },
            },
            ...OUTER,
        },
    };
}

/** One branch per item that waits 600 seconds, then succeeds with its item. */
function holdOut(items = [1]) {
    return {
        ...head("hold-out"),
        initialInput: { items },
        initial: "fan",
        states: {
            fan: {
                type: "parallel", forEach: "${input.items}",
                body: {
                    initial: "hold",
                    states: {
                        hold: { type: "wait", seconds: 600, transition: { next: { elapsed: "done" } } },
                        done: { type: "terminal", outcome: "succeeded", output: "${branch.item}" },
                    },
                },
                transition: { next: { joined: "finished", blocked: "stuck", failure: "failed" } },
            },
            ...OUTER,
        },
    };
}

describe("workflow parallel states: compiler and IR", () => {
    it("compiles a parallel state; its body states are in the IR, named by its body; the stored IR reads back", () => {
        const compiled = compileWorkflow(yamlOf(fanOut()));
        expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
        expect(compiled.ir.irVersion).toBe(WORKFLOW_IR_VERSION);
        expect(compiled.ir.nodes.fan).toEqual({
            id: "fan", type: "parallel", description: null, forEach: "${input.items}", concurrency: 2, join: "all_required", failFast: false,
            inputSchema: "Items", outputSchema: null, body: { initial: "work", states: ["work", "done", "refused"] },
            next: { joined: "finished", blocked: "stuck", failure: "failed" },
        });
        expect(Object.keys(compiled.ir.nodes).sort()).toEqual(["done", "failed", "fan", "finished", "refused", "stuck", "work"]);
        expect(compiled.ir.nodes.done).toMatchObject({ type: "terminal", outcome: "succeeded", output: { doubled: "${input.doubled}", index: "${branch.index}" } });
        // In a body, a runtime error no route takes ends the branch, which the warning says.
        expect(compiled.diagnostics).toEqual([expect.objectContaining({
            severity: "warning", code: "WORKFLOW_FAILURE_UNHANDLED", path: "states.fan.body.states.work.transition.next",
            message: expect.stringMatching(/ends its branch without success/),
        })]);

        const stored = JSON.parse(canonicalJson(compiled.ir));
        expect(parseWorkflowIr(stored)).toEqual(compiled.ir);
        // A stored body that names a missing state or another parallel state, or an initial that is a body state, is refused.
        for (const broken of [
            { ...stored, nodes: { ...stored.nodes, fan: { ...stored.nodes.fan, body: { initial: "work", states: ["work", "gone"] } } } },
            { ...stored, nodes: { ...stored.nodes, fan: { ...stored.nodes.fan, body: { initial: "work", states: ["work", "fan"] } } } },
            { ...stored, initial: "work" },
            { ...stored, nodes: { ...stored.nodes, fan: { ...stored.nodes.fan, concurrency: WORKFLOW_PARALLEL_MAX_CONCURRENCY + 1 } } },
        ]) {
            expect(() => parseWorkflowIr(broken)).toThrow(/stored IR/);
        }

        expect(describeWorkflowState(compiled.ir.nodes.fan)).toEqual({
            id: "fan", type: "parallel", forEach: "${input.items}", concurrency: 2, join: "all_required", failFast: false,
            body: { initial: "work", states: ["work", "done", "refused"] }, outcomes: ["joined", "blocked"], next: compiled.ir.nodes.fan.next,
        });
        const states = describeWorkflowStates(compiled.ir);
        expect(states.filter(state => state.parallel === "fan").map(state => state.id).sort()).toEqual(["done", "refused", "work"]);
        expect(states.find(state => state.id === "finished").parallel).toBeUndefined();
    });

    it("checks a parallel state's manifest, concurrency, join, routes and body; branch is bound only in a body; ids are unique across bodies", () => {
        const variant = change => {
            const doc = structuredClone(fanOut());
            change(doc, doc.states.fan, doc.states.fan.body.states);
            return compileWorkflow(yamlOf(doc));
        };
        for (const [label, change, code, path] of [
            ["concurrency 0", (_, fan) => { fan.concurrency = 0; }, "WORKFLOW_FIELD_INVALID", "states.fan.concurrency"],
            ["concurrency above the limit", (_, fan) => { fan.concurrency = WORKFLOW_PARALLEL_MAX_CONCURRENCY + 1; }, "WORKFLOW_FIELD_INVALID", "states.fan.concurrency"],
            // `all` and `{ first: k }` are the joins; any other is refused (workflow-join.test.js has every form).
            ["another join", (_, fan) => { fan.join = "any"; }, "WORKFLOW_FIELD_INVALID", "states.fan.join"],
            ["a forEach that is no binding or list", (_, fan) => { fan.forEach = "items"; }, "WORKFLOW_FIELD_INVALID", "states.fan.forEach"],
            ["a literal manifest over the limit", (_, fan) => { fan.forEach = Array.from({ length: WORKFLOW_PARALLEL_MAX_ITEMS + 1 }, (_, n) => ({ n })); },
                "WORKFLOW_FIELD_INVALID", "states.fan.forEach"],
            ["no forEach", (_, fan) => { delete fan.forEach; }, "WORKFLOW_FIELD_REQUIRED", "states.fan.forEach"],
            ["no blocked route", (_, fan) => { delete fan.transition.next.blocked; }, "WORKFLOW_ROUTE_MISSING", "states.fan.transition.next"],
            ["an outcome of its own", (_, fan) => { fan.transition.next.done = "finished"; }, "WORKFLOW_ROUTE_INVALID", "states.fan.transition.next.done"],
            ["a body route out of the body", (_, __, body) => { body.work.transition.next.ok = "finished"; },
                "WORKFLOW_TARGET_UNKNOWN", "states.fan.body.states.work.transition.next.ok"],
            ["a body id an outer state has", (_, __, body) => { body.stuck = { type: "terminal", outcome: "blocked" }; },
                "WORKFLOW_STATE_ID", "states.fan.body.states.stuck"],
            ["a parallel state in a body", (_, __, body) => {
                body.inner = { type: "parallel", forEach: "${input}", body: { initial: "x", states: { x: { type: "terminal", outcome: "succeeded" } } },
                    transition: { next: { joined: "done", blocked: "refused" } } };
            }, "WORKFLOW_FEATURE_UNSUPPORTED", "states.fan.body.states.inner.type"],
            ["branch in an outer state", doc => { doc.states.finished.output = "${branch.index}"; }, "WORKFLOW_BINDING_INVALID", "states.finished.output"],
            ["branch in the initial input", doc => { doc.initialInput = { items: "${branch.item}" }; }, "WORKFLOW_BINDING_INVALID", "initialInput"],
            ["branch in the manifest", (_, fan) => { fan.forEach = "${branch.item}"; }, "WORKFLOW_BINDING_INVALID", "states.fan.forEach"],
            ["a body initial outside the body", (_, fan) => { fan.body.initial = "finished"; }, "WORKFLOW_INITIAL_INVALID", "states.fan.body.initial"],
            ["no body", (_, fan) => { delete fan.body; }, "WORKFLOW_FIELD_REQUIRED", "states.fan.body"],
            ["a body state with no way to a body terminal", (_, __, body) => {
                body.work.transition.next.negative = "loop";
                body.loop = { type: "wait", seconds: 1, transition: { next: { elapsed: "loop" } } };
            }, "WORKFLOW_NO_TERMINAL_PATH", "states.fan.body.states.loop"],
        ]) {
            const result = variant(change);
            expect(result.valid, label).toBe(false);
            expect(errorsOf(result).map(item => [item.code, item.path]), label).toContainEqual([code, path]);
        }
        // An unreachable body state is a warning that names its body.
        const unreachable = variant((_, __, body) => { body.spare = { type: "terminal", outcome: "succeeded" }; });
        expect(unreachable.valid, JSON.stringify(unreachable.diagnostics)).toBe(true);
        expect(unreachable.diagnostics).toContainEqual(expect.objectContaining({
            severity: "warning", code: "WORKFLOW_STATE_UNREACHABLE", path: "states.fan.body.states.spare",
            message: "state 'spare' is not reachable from the body initial of 'fan'.",
        }));
        // A literal manifest of up to 64 items, with failFast and the most concurrency, compiles.
        const literal = variant((_, fan) => {
            fan.forEach = Array.from({ length: WORKFLOW_PARALLEL_MAX_ITEMS }, (_, n) => ({ n: n + 1 }));
            fan.failFast = true;
            fan.concurrency = WORKFLOW_PARALLEL_MAX_CONCURRENCY;
        });
        expect(literal.valid, JSON.stringify(literal.diagnostics)).toBe(true);
        expect(literal.ir.nodes.fan).toMatchObject({ failFast: true, concurrency: WORKFLOW_PARALLEL_MAX_CONCURRENCY });
    });
});

describe("workflow parallel states: the store", () => {
    it("admits branches in their own scopes, cancels branch scopes once, and does not count a parallel state's own node as work", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const parent = randomUUID();
            await h.catalog.createSession(parent, {});
            const yaml = yamlOf(holdOut([1, 2]));
            const compiled = compileWorkflow(yaml);
            expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
            const workflowSessionId = randomUUID();
            const runId = randomUUID();
            expect(await h.catalog.createWorkflowSession(workflowSessionId, { parentSessionId: parent, owner: null,
                creationConfig: { workflow: { requestSha256: "parallel" } } })).toEqual({ created: true });
            await h.store.createDefinition({
                workflowSessionId, parentSessionId: parent, notifyParent: false, yaml, compiled, actor: ACTOR,
                operationId: "create", requestSha256: "parallel", publish: true, title: "Workflow: parallel",
                start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
                    inputsText: "{}", kvText: "{}", testAgentMode: null, controllerVersion: WORKFLOW_CONTROLLER_VERSION },
            });

            const fan = nodeExecutionIdFor(runId, "root", "fan", 1);
            expect(await h.store.enterNode({
                runId, nodeExecutionId: fan, scopeId: "root", nodeId: "fan", ordinal: 1, nodeType: "parallel", predecessorId: null, arrivalRoute: null,
                inputText: "[1,2]", kvRevision: 1, waitSeconds: null, immediate: null,
            })).toMatchObject({ admitted: true, inserted: true, node: { state: "pending", nodeType: "parallel", input: [1, 2], deadlineAt: null } });
            const scopes = [0, 1].map(index => branchScopeId(fan, index));
            expect(scopes.map(parseBranchScope)).toEqual([{ parallelNodeExecutionId: fan, index: 0 }, { parallelNodeExecutionId: fan, index: 1 }]);
            expect(parseBranchScope("root")).toBeNull();
            const holds = [];
            for (const [index, scopeId] of scopes.entries()) {
                const nodeExecutionId = nodeExecutionIdFor(runId, scopeId, "hold", 1);
                expect(await h.store.enterNode({
                    runId, nodeExecutionId, scopeId, nodeId: "hold", ordinal: 1, nodeType: "wait", predecessorId: fan, arrivalRoute: BRANCH_ROUTE,
                    inputText: String(index + 1), kvRevision: 1, waitSeconds: 600, immediate: null,
                })).toMatchObject({ admitted: true, inserted: true, node: { state: "pending", scopeId } });
                holds.push(nodeExecutionId);
            }
            expect(await h.store.hasPendingNodes(runId)).toBe(true);

            // A failFast cancellation decides the pending work of the named branches once; a retry lists the same.
            const projection = cancelled => ({ sessionId: workflowSessionId, events: [{ eventType: "workflow.branches_cancelled", data: { runId, cancelled } }] });
            const once = { active: true, cancelled: [{ nodeExecutionId: holds[1], nodeType: "wait", reason: "failFast" }] };
            expect(await h.store.cancelBranchScopes({ runId, scopeIds: [scopes[1]], projection })).toEqual(once);
            expect(await h.store.readNodeExecution(holds[1])).toMatchObject({
                state: "completed", outcome: "cancelled", resultKind: "runtime_error", winner: "fail_fast", error: { code: "cancelled" },
            });
            expect(await h.store.readNodeExecution(holds[0])).toMatchObject({ state: "pending" });
            expect(await h.store.cancelBranchScopes({ runId, scopeIds: [scopes[1]], projection })).toEqual(once);
            const events = await h.catalog.getSessionEvents(workflowSessionId, 0, 200);
            expect(events.filter(event => event.eventType === "workflow.branches_cancelled").map(event => event.data)).toEqual([{ runId, cancelled: [holds[1]] }]);
            expect(await h.store.listCancelledNodeIds(runId, "fail_fast")).toEqual([holds[1]]);

            // With the branches' work decided, only the parallel state is pending, and it is not work.
            await h.store.completeNode(holds[0], { outcome: "elapsed", resultKind: "business", valueText: "1", winner: "controller" });
            expect(await h.store.hasPendingNodes(runId)).toBe(false);
            expect(await h.store.isNodePending(fan)).toBe(true);
            // A stop with a long grace ends the run at once: the parallel state is cancelled with it, and the grace did not expire.
            await h.store.requestRunStop({ workflowSessionId, runId, operationId: "stop-1", requestSha256: "stop", actor: ACTOR, reason: null,
                graceSeconds: 600 });
            const finished = await h.store.finishStoppedRun({ runId,
                projection: ({ run }) => ({ sessionId: run.workflowSessionId, update: { state: "cancelled", touch: true } }) });
            expect(finished).toMatchObject({ result: "ended", graceExpired: false, cancelled: [fan], run: { status: "stopped" } });
            expect(await h.store.readNodeExecution(fan)).toMatchObject({
                outcome: "cancelled", winner: "stop", error: { code: "cancelled", message: "The run stopped before this parallel state joined its branches." },
            });
            // An ended run's branches are not cancelled again; the earlier cancellation is still listed.
            expect(await h.store.cancelBranchScopes({ runId, scopeIds: scopes, projection })).toEqual({ ...once, active: false });
        } finally {
            await h.stop();
        }
    });
});

// ─── The controller on a native runtime ──────────────────────

/** A worker-equivalent registration with the request tag declared. */
async function harness(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
    });
    registerWorkflow({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows notify no parent."); },
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
        sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
    });
    await runtime.start();
    return {
        catalog, store, client, host: { catalog, store, duroxideClient: client },
        async stop() {
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

/** A parent session and a started run of `doc` it created, with the ids of its parallel state and its branches' states. */
async function started(h, doc) {
    const parent = randomUUID();
    await h.catalog.createSession(parent, {});
    const workflowSessionId = randomUUID();
    const created = await createWorkflow(h.host, {
        workflowSessionId, parentSessionId: parent, yaml: yamlOf(doc), actor: ACTOR, operationId: "start", start: { inputs: {} },
    });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    const runId = created.receipt.run.runId;
    const fan = nodeExecutionIdFor(runId, "root", "fan", 1);
    return { workflowSessionId, runId, fan, at: (index, nodeId) => nodeExecutionIdFor(runId, branchScopeId(fan, index), nodeId, 1) };
}

const ended = (h, runId) => until(async () => {
    const run = await h.store.readRun(runId);
    return run && ["completed", "failed", "cancelled", "stopped"].includes(run.status) ? run : null;
}, `run ${runId} to end`);

describe("workflow parallel states: the controller", () => {
    it("runs one branch per item, at most its concurrency at a time, each with its item and index, and joins their outputs in manifest order", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const { workflowSessionId, runId, fan, at } = await started(h, fanOut());
            const run = await ended(h, runId);
            const joined = [{ doubled: 2, index: 0 }, { doubled: 4, index: 1 }, { doubled: 6, index: 2 }];
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalNodeId: "finished", terminalOutput: joined });
            expect(await h.store.readNodeExecution(fan)).toMatchObject({
                state: "completed", outcome: "joined", resultKind: "business", winner: "controller", output: joined, input: [{ n: 1 }, { n: 2 }, { n: 3 }],
            });
            for (const index of [0, 1, 2]) {
                expect(await h.store.readNodeExecution(at(index, "work"))).toMatchObject({
                    scopeId: branchScopeId(fan, index), predecessorId: fan, arrivalRoute: BRANCH_ROUTE, input: { n: index + 1 },
                    outcome: "ok", output: { doubled: 2 * (index + 1), index, item: { n: index + 1 } },
                });
                expect(await h.store.readNodeExecution(at(index, "done"))).toMatchObject({
                    scopeId: branchScopeId(fan, index), outcome: "succeeded", resultKind: "business", winner: "controller", output: joined[index],
                });
            }
            // Two branches ran at once (the second began before the first ended), and no more: the third began only after one
            // of the first two ended.
            const ends = [];
            for (const index of [0, 1]) ends.push((await h.store.readNodeExecution(at(index, "done"))).completedAt.getTime());
            expect((await h.store.readNodeExecution(at(1, "work"))).enteredAt.getTime()).toBeLessThan(ends[0]);
            expect((await h.store.readNodeExecution(at(2, "work"))).enteredAt.getTime()).toBeGreaterThanOrEqual(Math.min(...ends));
            expect((await h.client.getInstanceInfo(workflowLiveControllerInstanceId(workflowSessionId))).orchestrationVersion)
                .toBe(WORKFLOW_CONTROLLER_VERSION);

            // read_workflow: the graph marks the body's states; a branch's node execution names its branch.
            const view = await readWorkflowView(h.store, workflowSessionId);
            expect(view.graph.states.find(state => state.id === "fan")).toMatchObject({ type: "parallel", concurrency: 2, join: "all_required", failFast: false });
            expect(view.graph.states.find(state => state.id === "work")).toMatchObject({ parallel: "fan" });
            const shown = view.run.nodeExecutions.find(node => node.nodeExecutionId === fan);
            expect(shown).toMatchObject({ stateId: "fan", outcome: "joined", branches: 3 });
            expect(shown.scopeId).toBeUndefined();
            expect(view.run.nodeExecutions.find(node => node.nodeExecutionId === at(1, "work")))
                .toMatchObject({ stateId: "work", scopeId: branchScopeId(fan, 1), branch: { parallelNodeExecutionId: fan, index: 1 } });
            const events = await h.catalog.getSessionEvents(workflowSessionId, 0, 500);
            expect(events.filter(event => event.eventType === "workflow.state_completed" && event.data.branchEnded === true)
                .map(event => event.data.branch).sort()).toEqual([0, 1, 2]);
        } finally {
            await h.stop();
        }
    });

    it("blocks the join after every branch ended when one does not succeed, reporting every branch; an unrouted result ends only its branch", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const { runId, fan, at } = await started(h, fanOut({ items: [{ n: 1 }, { n: -1 }, { n: 0 }], concurrency: 3 }));
            const run = await ended(h, runId);
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "stuck" });
            expect(run.terminalOutput).toEqual({
                // Every branch was needed (join all), and the state's own time limit did not end it (the report's fields).
                joined: false, timedOut: false, total: 3, needed: 3, succeeded: 1, failFast: false,
                branches: [
                    { index: 0, ended: "terminal", nodeExecutionId: at(0, "done"), outcome: "succeeded", resultKind: "business", output: { doubled: 2, index: 0 } },
                    { index: 1, ended: "terminal", nodeExecutionId: at(1, "refused"), outcome: "blocked", resultKind: "business",
                        output: { doubled: -2, index: 1, item: { n: -1 } } },
                    { index: 2, ended: "error", nodeExecutionId: at(2, "work"), outcome: "invalid_output", resultKind: "runtime_error",
                        error: expect.objectContaining({ code: "invalid_output" }) },
                ],
            });
            expect(await h.store.readNodeExecution(fan)).toMatchObject({ outcome: "blocked", resultKind: "business", winner: "controller" });
            // The unrouted error ended its branch, not the run: no catch-all, and the run went on to its blocked route.
            expect((await h.store.listNodeExecutions(runId)).filter(node => node.scopeId === "root").map(node => node.nodeId)).toEqual(["fan", "stuck"]);
        } finally {
            await h.stop();
        }
    });

    it("with failFast, cancels the other branches' pending work and the items not started, then blocks the join", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const { workflowSessionId, runId, fan, at } = await started(h, failFastOut());
            const run = await ended(h, runId);
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "blocked", terminalNodeId: "stuck" });
            expect(run.terminalOutput).toEqual({
                joined: false, timedOut: false, total: 3, needed: 3, succeeded: 0, failFast: true,
                branches: [
                    { index: 0, ended: "cancelled", nodeExecutionId: at(0, "hold"), outcome: "cancelled", resultKind: "runtime_error",
                        error: expect.objectContaining({ code: "cancelled" }) },
                    { index: 1, ended: "terminal", nodeExecutionId: at(1, "refused"), outcome: "blocked", resultKind: "business", output: { fail: true } },
                    { index: 2, ended: "not_started", nodeExecutionId: null, outcome: null, resultKind: null },
                ],
            });
            expect(await h.store.readNodeExecution(at(0, "hold"))).toMatchObject({ state: "completed", outcome: "cancelled", winner: "fail_fast" });
            const nodes = await h.store.listNodeExecutions(runId);
            expect(nodes.some(node => node.scopeId === branchScopeId(fan, 2))).toBe(false);
            expect(nodes.filter(node => node.state === "pending")).toEqual([]);
            const events = await h.catalog.getSessionEvents(workflowSessionId, 0, 500);
            expect(events.filter(event => event.eventType === "workflow.branches_cancelled").map(event => event.data))
                .toEqual([expect.objectContaining({ runId, scopeIds: [branchScopeId(fan, 0)], cancelled: [at(0, "hold")], cancelledCount: 1 })]);
        } finally {
            await h.stop();
        }
    });

    it("joins an empty manifest at once; fails a manifest that is not a list or does not match; checks the joined output's schema", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const empty = await started(h, fanOut({ items: [] }));
            expect(await ended(h, empty.runId)).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalOutput: [] });
            expect(await h.store.readNodeExecution(empty.fan)).toMatchObject({ outcome: "joined", output: [] });

            for (const [items, message] of [["nope", /must be a list; it is string/], [[{ n: "x" }], /does not match Items/]]) {
                const invalid = await started(h, fanOut({ items }));
                expect(await ended(h, invalid.runId)).toMatchObject({ status: "failed", terminalNodeId: "failed" });
                expect(await h.store.readNodeExecution(invalid.fan)).toMatchObject({
                    outcome: "invalid_input", resultKind: "runtime_error", winner: "controller", error: { message: expect.stringMatching(message) },
                });
                expect((await h.store.listNodeExecutions(invalid.runId)).map(node => node.nodeId)).toEqual(["fan", "failed"]);
            }

            // The joined outputs must match the state's outputSchema: an empty join does not match minItems 1.
            const unmatched = await started(h, fanOut({ items: [], outputSchema: { type: "array", minItems: 1 } }));
            expect(await ended(h, unmatched.runId)).toMatchObject({ status: "failed", terminalNodeId: "failed" });
            expect(await h.store.readNodeExecution(unmatched.fan)).toMatchObject({
                outcome: "invalid_output", resultKind: "runtime_error", error: { message: expect.stringMatching(/joined output does not match/) },
            });
        } finally {
            await h.stop();
        }
    });

    it("a stop during a parallel state cancels its branches' pending work at the deadline, and the parallel state with it", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const { workflowSessionId, runId, fan, at } = await started(h, holdOut());
            const hold = at(0, "hold");
            await until(async () => (await h.store.readNodeExecution(hold))?.state === "pending", "the branch's wait");
            await controlWorkflowRun(h.host, workflowSessionId, { operation: "stop", runId: null, reason: "enough", graceSeconds: 1 },
                { actor: ACTOR, operationId: "stop-1" });
            const run = await ended(h, runId);
            expect(run).toMatchObject({ status: "stopped", terminalError: { code: "stopped", details: { graceExpired: true, cancelledCount: 2 } } });
            expect(run.terminalError.details.cancelled).toEqual([fan, hold].sort());
            expect(await h.store.readNodeExecution(hold)).toMatchObject({ outcome: "cancelled", winner: "stop" });
            expect(await h.store.readNodeExecution(fan)).toMatchObject({
                outcome: "cancelled", winner: "stop", error: { message: "The run stopped before this parallel state joined its branches." },
            });
            expect((await h.store.listNodeExecutions(runId)).map(node => node.nodeId).sort()).toEqual(["fan", "hold"]);
        } finally {
            await h.stop();
        }
    });
});

/**
 * Adversarial review RT-6: a paused run still keeps its pending states' deadlines. Two branches: the first takes a
 * 1-second wait, the second a 4-second wait. The run is paused while both wait. The first wait elapses and the
 * collection that finds it finds the pause (review R2-RT-1: the controller is now on its paused path, and routes
 * nothing); the second wait must still elapse at its deadline while the run is paused, and nothing after it is admitted
 * until the resume.
 */
function pausedDeadlines() {
    return {
        ...head("paused-deadlines"),
        initialInput: { items: [1, 2] },
        initial: "fan",
        states: {
            fan: {
                type: "parallel", forEach: "${input.items}", concurrency: 2,
                body: {
                    initial: "pick",
                    states: {
                        pick: {
                            type: "script", outcomes: ["short", "long"],
                            source: "await setResult(context.branch.index === 0 ? \"short\" : \"long\", {});\n",
                            transition: { next: { short: "shortWait", long: "longWait" } },
                        },
                        // Scaled with the database: both waits are still pending when the pause lands (HorizonDB is slower).
                        shortWait: { type: "wait", seconds: testTime.seconds(1), transition: { next: { elapsed: "done" } } },
                        longWait: { type: "wait", seconds: testTime.seconds(4), transition: { next: { elapsed: "done" } } },
                        done: { type: "terminal", outcome: "succeeded", output: "${branch.item}" },
                    },
                },
                transition: { next: { joined: "finished", blocked: "stuck", failure: "failed" } },
            },
            ...OUTER,
        },
    };
}

describe("workflow parallel states: deadlines while paused", () => {
    it("elapses a pending state at its deadline while the run is paused, and admits nothing until the resume", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const { workflowSessionId, runId, at } = await started(h, pausedDeadlines());
            const longWait = at(1, "longWait");
            await until(async () => (await h.store.readNodeExecution(longWait))?.state === "pending"
                && (await h.store.readNodeExecution(at(0, "shortWait")))?.state === "pending", "both waits");
            await controlWorkflowRun(h.host, workflowSessionId, { operation: "pause", runId: null, reason: "look first" },
                { actor: ACTOR, operationId: "pause-1" });
            // The long wait elapses at its deadline though the run is paused.
            await until(async () => (await h.store.readNodeExecution(longWait))?.state === "completed", "the long wait to elapse while paused", 30_000);
            expect(await h.store.readNodeExecution(longWait)).toMatchObject({ outcome: "elapsed" });
            expect((await h.store.readRun(runId)).status).toBe("paused");
            // Nothing after the waits was admitted.
            const admitted = (await h.store.listNodeExecutions(runId)).map(node => node.nodeId);
            expect(admitted.filter(nodeId => nodeId === "done")).toEqual([]);
            await controlWorkflowRun(h.host, workflowSessionId, { operation: "resume", runId: null, reason: null }, { actor: ACTOR, operationId: "resume-1" });
            expect(await ended(h, runId)).toMatchObject({ status: "completed", terminalNodeId: "finished", terminalOutput: [1, 2] });
        } finally {
            await h.stop();
        }
    });
});

// Adapted from the independent test design 090ad919-r2 (P1): a worker restart while every branch of a parallel state
// waits (design 02 "Parallel scope and join": all_required, duplicates do not count; R21, R27; T101). Two runtimes run in
// turn over one catalog and provider (the wait restart test's split); each is stopped once. The precondition is read from
// the store, not inferred from time: if it is read after a deadline, the case is VOID (its message says so), not a pass
// and not a product failure.
// CI run 114 (HorizonDB): the recovery after the restart took 3.8 s there, past the 2 s lateness bound. The wait, the
// outage window and the bound are scaled together, so a timer started again at the restart is still later than the bound.
const RESTART_SECONDS = testTime.seconds(6);
const RESTART_OUTAGE_MS = testTime.ms(2_500);
const RESTART_LATE_BOUND_MS = testTime.ms(2_000);
const RESTART_ITEMS = ["a", "b", "c"];

function restartHoldOut() {
    return {
        ...head("hold-restart"), initialInput: { items: RESTART_ITEMS }, initial: "fan",
        states: {
            fan: {
                type: "parallel", forEach: "${input.items}", concurrency: RESTART_ITEMS.length,
                body: { initial: "hold", states: {
                    hold: { type: "wait", seconds: RESTART_SECONDS, transition: { next: { elapsed: "done" } } },
                    done: { type: "terminal", outcome: "succeeded", output: "${branch.item}" },
                } },
                transition: { next: { joined: "finished", blocked: "stuck", failure: "failed" } },
            },
            ...OUTER,
        },
    };
}

async function restartBaseOf(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    return { catalog, store, provider, client, host: { catalog, store, duroxideClient: client } };
}

async function restartRuntimeOn(base) {
    const runtime = new Runtime(base.provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
        // Whole seconds of at least 2: a shorter activity lock renews no earlier than it expires (duroxide 0.1.32).
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

describe("workflow parallel states: a worker restart while every branch waits", () => {
    it("joins each branch exactly once after the runtime stops with every branch persisted as waiting, keeping each wait's deadline", { timeout: testTime.ms(180_000) }, async () => {
        const base = await restartBaseOf(getEnv());
        const workers = [await restartRuntimeOn(base)];
        try {
            const parent = randomUUID();
            await base.catalog.createSession(parent, {});
            const workflowSessionId = randomUUID();
            const created = await createWorkflow(base.host, {
                workflowSessionId, parentSessionId: parent, yaml: yamlOf(restartHoldOut()), actor: ACTOR, operationId: "start", start: { inputs: {} },
            });
            expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
            const runId = created.receipt.run.runId;
            const fan = nodeExecutionIdFor(runId, "root", "fan", 1);
            const at = (index, nodeId, visit = 1) => nodeExecutionIdFor(runId, branchScopeId(fan, index), nodeId, visit);

            // Precondition, persisted: every branch's wait is pending with an absolute deadline RESTART_SECONDS after its entry;
            // nothing has completed; the parallel state is pending; the run is running.
            const before = await until(async () => {
                const holds = await Promise.all(RESTART_ITEMS.map((_, index) => base.store.readNodeExecution(at(index, "hold"))));
                return holds.every(node => node?.state === "pending" && node.deadlineAt instanceof Date) ? holds : null;
            }, "every branch wait persisted as pending", 90_000);
            RESTART_ITEMS.forEach((_, index) => {
                expect(before[index]).toMatchObject({ scopeId: branchScopeId(fan, index), predecessorId: fan, arrivalRoute: BRANCH_ROUTE, outcome: null, completedAt: null });
                expect(before[index].deadlineAt.getTime() - before[index].enteredAt.getTime()).toBe(RESTART_SECONDS * 1_000);
            });
            expect(await base.store.readNodeExecution(fan)).toMatchObject({ state: "pending" });
            for (const index of RESTART_ITEMS.keys()) expect(await base.store.readNodeExecution(at(index, "done"))).toBeFalsy();
            expect(await base.store.hasPendingNodes(runId)).toBe(true);
            expect((await base.store.readRun(runId)).status).toBe("running");
            expect(Date.now(), "VOID (not a product result): the precondition was read after a wait's deadline; run the case again")
                .toBeLessThan(Math.min(...before.map(node => node.deadlineAt.getTime())));

            // Stop the runtime, stay down 2.5 s (scaled), and start another over the same catalog and provider.
            await workers[0].stop();
            const stoppedAt = Date.now();
            for (const index of RESTART_ITEMS.keys()) expect((await base.store.readNodeExecution(at(index, "hold"))).state).toBe("pending");
            await until(async () => Date.now() - stoppedAt >= RESTART_OUTAGE_MS, "the outage window");
            workers.push(await restartRuntimeOn(base));

            const run = await until(async () => {
                const current = await base.store.readRun(runId);
                return current && ["completed", "failed", "cancelled", "stopped"].includes(current.status) ? current : null;
            }, `run ${runId} to end`, 90_000);

            // One join, in manifest order; no second visit of the parallel state or of `finished`.
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "succeeded", terminalNodeId: "finished", terminalOutput: RESTART_ITEMS });
            expect(await base.store.readNodeExecution(fan)).toMatchObject({ state: "completed", outcome: "joined", resultKind: "business", output: RESTART_ITEMS });
            expect(await base.store.readNodeExecution(nodeExecutionIdFor(runId, "root", "fan", 2))).toBeFalsy();
            expect(await base.store.readNodeExecution(nodeExecutionIdFor(runId, "root", "finished", 2))).toBeFalsy();
            // One visit per branch state, each wait's deadline kept: the same rows, never admitted again.
            for (const index of RESTART_ITEMS.keys()) {
                const hold = await base.store.readNodeExecution(at(index, "hold"));
                expect(hold).toMatchObject({ state: "completed", outcome: "elapsed", arrivalRoute: BRANCH_ROUTE });
                expect(hold.enteredAt).toEqual(before[index].enteredAt);
                expect(hold.deadlineAt).toEqual(before[index].deadlineAt);
                const late = hold.completedAt.getTime() - hold.deadlineAt.getTime();
                expect(late).toBeGreaterThanOrEqual(0);
                expect(late).toBeLessThan(RESTART_LATE_BOUND_MS);
                expect(await base.store.readNodeExecution(at(index, "done"))).toMatchObject({ state: "completed", outcome: "succeeded", output: RESTART_ITEMS[index] });
                expect(await base.store.readNodeExecution(at(index, "hold", 2))).toBeFalsy();
                expect(await base.store.readNodeExecution(at(index, "done", 2))).toBeFalsy();
            }
            // One branch-ended event per branch, none repeated by the recovery.
            const events = await base.catalog.getSessionEvents(workflowSessionId, 0, 500);
            const branchEnds = events.filter(event => event.eventType === "workflow.state_completed" && event.data.branchEnded === true);
            expect(branchEnds.map(event => event.data.branch).sort()).toEqual([0, 1, 2]);
            expect(new Set(branchEnds.map(event => event.data.nodeExecutionId)).size).toBe(RESTART_ITEMS.length);
            expect(await base.store.hasPendingNodes(runId)).toBe(false);
        } finally {
            for (const worker of workers) await worker.stop();
            await base.catalog.close();
        }
    });
});

// Verification of SF-3 (M-03): a parallel state's literal list (here with sentinel values) is shown in the graph and in the
// workflow.started event as how many items it has and its digest, to everyone; the owner's YAML keeps the list exactly. The
// run's own execution data (a branch's item, its inputs) is another surface, shown as the run is. A started event that an
// earlier build stored with the list is not rewritten: it stays as stored.
describe("workflow parallel states: a literal list is shown as its count and digest (verification of SF-3, M-03)", () => {
    it("M-03: the new started event and a reader's graph omit the list's values; the owner's YAML keeps them; an earlier stored event stays as it was", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const SENTINELS = ["m03-SENTINEL-alpha-7c1e", "m03-SENTINEL-beta-2f9d"];
            const doc = {
                ...head("literal-list"), initial: "fan",
                states: {
                    fan: {
                        type: "parallel", forEach: SENTINELS,
                        body: {
                            initial: "hold",
                            states: {
                                hold: { type: "wait", seconds: 600, transition: { next: { elapsed: "done" } } },
                                done: { type: "terminal", outcome: "succeeded" },
                            },
                        },
                        transition: { next: { joined: "finished", blocked: "stuck", failure: "failed" } },
                    },
                    ...OUTER,
                },
            };
            const { workflowSessionId, runId } = await started(h, doc);
            const hasSentinel = value => SENTINELS.some(sentinel => JSON.stringify(value).includes(sentinel));

            // The newly stored started event: the list's count and digest, not its values.
            const [startedEvent] = await until(async () => {
                const events = await h.catalog.getSessionEvents(workflowSessionId, 0, 100, ["workflow.started"]);
                return events.length ? events : null;
            }, "the started event");
            const fan = startedEvent.data.states.find(state => state.id === "fan");
            expect(fan.forEach).toEqual({ count: 2, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
            expect(hasSentinel(startedEvent.data)).toBe(false);

            // A reader's view of the workflow (the portal's, for a person who cannot change it): its graph, revision and
            // definition show no value of the list. The owner's view shows the same graph.
            const view = await readWorkflowView(h.store, workflowSessionId);
            const reader = workflowReaderView(view);
            for (const shown of [view, reader]) {
                expect(shown.graph.states.find(state => state.id === "fan").forEach).toEqual(fan.forEach);
                expect(hasSentinel({ graph: shown.graph, revision: shown.revision, definition: shown.definition })).toBe(false);
            }
            // The owner's YAML keeps the list exactly.
            const withYaml = await readWorkflowView(h.store, workflowSessionId, { includeYaml: true });
            expect(JSON.parse(withYaml.revision.yaml).states.fan.forEach).toEqual(SENTINELS);

            // A started event an earlier build stored with the list's values: stored events are not rewritten, so it keeps
            // them; the graph a reader gets is still built from the revision, with the count and digest.
            await h.store.recordSessionEvents(workflowSessionId, [{ eventType: "workflow.started", data: {
                runId: "earlier-run", states: [{ id: "fan", type: "parallel", forEach: SENTINELS }] } }]);
            const stored = (await h.catalog.getSessionEvents(workflowSessionId, 0, 100, ["workflow.started"]))
                .find(event => event.data?.runId === "earlier-run");
            expect(stored.data.states[0].forEach).toEqual(SENTINELS);
            expect((await readWorkflowView(h.store, workflowSessionId)).graph.states.find(state => state.id === "fan").forEach).toEqual(fan.forEach);

            await controlWorkflowRun(h.host, workflowSessionId, { operation: "cancel", runId: null, reason: "done" }, { actor: ACTOR, operationId: "cancel-1" });
            expect(await ended(h, runId)).toMatchObject({ status: "cancelled" });
        } finally {
            await h.stop();
        }
    });

    // Adversarial review R3-SF-1: the same list as a binding's default (here unused: the run's input has the items). The
    // graph (the owner's and a reader's) and the workflow.started event show the binding's path with the default as its
    // count and digest; the owner's YAML keeps it exactly. (The REST view and the web-backed MCP read apply
    // workflowReaderView to this same view for a reader who cannot change the workflow.)
    it("R3-SF-1: a forEach binding's list default is shown as its count and digest in the graph and the started event, never its values", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const MARKER = "r3sf1-private-marker-9c2e";
            const forEach = `\${input.items ?? [{"note":"${MARKER}"}]}`;
            const doc = {
                ...head("binding-default"), initialInput: { items: [1] }, initial: "fan",
                states: {
                    fan: {
                        type: "parallel", forEach,
                        body: {
                            initial: "hold",
                            states: {
                                hold: { type: "wait", seconds: 600, transition: { next: { elapsed: "done" } } },
                                done: { type: "terminal", outcome: "succeeded" },
                            },
                        },
                        transition: { next: { joined: "finished", blocked: "stuck", failure: "failed" } },
                    },
                    ...OUTER,
                },
            };
            const { workflowSessionId, runId } = await started(h, doc);
            const [startedEvent] = await until(async () => {
                const events = await h.catalog.getSessionEvents(workflowSessionId, 0, 100, ["workflow.started"]);
                return events.length ? events : null;
            }, "the started event");
            const shown = startedEvent.data.states.find(state => state.id === "fan").forEach;
            expect(shown).toMatch(/^\$\{input\.items \?\? \{"count":1,"sha256":"[0-9a-f]{64}"\}\}$/);
            expect(JSON.stringify(startedEvent.data)).not.toContain(MARKER);
            const view = await readWorkflowView(h.store, workflowSessionId);
            for (const read of [view, workflowReaderView(view)]) {
                expect(read.graph.states.find(state => state.id === "fan").forEach).toBe(shown);
                expect(JSON.stringify(read)).not.toContain(MARKER);
            }
            expect(JSON.stringify(await h.catalog.getSessionEvents(workflowSessionId, 0, 500))).not.toContain(MARKER);
            // The owner's YAML keeps the default exactly.
            const withYaml = await readWorkflowView(h.store, workflowSessionId, { includeYaml: true });
            expect(JSON.parse(withYaml.revision.yaml).states.fan.forEach).toBe(forEach);
            await controlWorkflowRun(h.host, workflowSessionId, { operation: "cancel", runId: null, reason: "done" }, { actor: ACTOR, operationId: "cancel-1" });
            expect(await ended(h, runId)).toMatchObject({ status: "cancelled" });
        } finally {
            await h.stop();
        }
    });
});

// Adversarial review R3-SF-3: a parallel state whose time limit passes before its join records its report as its
// error; a finished branch's business output in it stays exactly as the branch stored it, as the blocked report keeps it.
// Branch 1 ends after a 1 s wait with { key, token } (ordinary business fields); branch 2 waits 600 s (the time limit,
// 3 s scaled by the database's time scale, passes first) or is refused at once (0 s: the join of both can no longer
// happen, so it is blocked). CI run 117 (HorizonDB): with an unscaled 3 s limit branch 1 did not reach `done` in time.
describe("workflow parallel states: a timed_out report keeps business outputs (adversarial review R3-SF-3)", () => {
    it("R3-SF-3: a timed_out report's finished branch output equals the branch's own and the blocked report's", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const doc = second => ({
                ...head("report-outputs"), initialInput: { items: [{ seconds: 1, n: 0 }, { seconds: second, n: 1 }] }, initial: "fan",
                states: {
                    fan: {
                        type: "parallel", forEach: "${input.items}", concurrency: 2, join: { first: 2 }, timeoutSeconds: testTime.seconds(3),
                        body: {
                            initial: "hold",
                            states: {
                                hold: { type: "wait", seconds: "${branch.item.seconds}", input: { key: "ordinary-value", token: "an-ordinary-field", n: "${branch.item.n}" },
                                    transition: { next: { elapsed: "done" } } },
                                done: { type: "terminal", outcome: "succeeded", output: "${input}" },
                            },
                        },
                        transition: { next: { joined: "finished", blocked: "stuck", timed_out: "late", failure: "failed" } },
                    },
                    ...OUTER,
                    late: { type: "terminal", outcome: "blocked", output: "${input}" },
                },
            });
            const output = { key: "ordinary-value", token: "an-ordinary-field", n: 0 };

            const timed = await started(h, doc(600));
            expect(await ended(h, timed.runId)).toMatchObject({ status: "completed", terminalNodeId: "late" });
            const fan = await h.store.readNodeExecution(timed.fan);
            expect(fan).toMatchObject({ outcome: "timed_out", resultKind: "runtime_error" });
            const branch = await h.store.readNodeExecution(timed.at(0, "done"));
            expect(branch.output).toEqual(output);
            const timedEntry = fan.error.details.branches.find(item => item.index === 0);
            expect(timedEntry.output).toEqual(branch.output);
            // The whole value read shows it the same (the execution read of the parallel state).
            const whole = await readWorkflowView(h.store, timed.workflowSessionId, { executionId: timed.fan });
            expect(whole.execution.result).toMatchObject({ whole: true });
            expect(whole.execution.result.value.details.branches.find(item => item.index === 0).output).toEqual(output);
            // R3-UI-1 (S6-UI2): each end event carries its node's completed_at, the completion clock the read rows give (the
            // parallel decision's time limit and a branch's elapsed wait), never the event's own time.
            const endEvents = await h.catalog.getSessionEvents(timed.workflowSessionId, 0, 500, ["workflow.state_completed", "workflow.state_failed"]);
            for (const id of [timed.fan, timed.at(0, "hold")]) {
                const stored = await h.store.readNodeExecution(id);
                const event = endEvents.find(item => item.data.nodeExecutionId === id);
                expect(event, id).toBeTruthy();
                expect(event.data.completedAt).toBe(stored.completedAt.toISOString());
            }

            const blocked = await started(h, doc(0));
            expect(await ended(h, blocked.runId)).toMatchObject({ status: "completed", terminalNodeId: "stuck" });
            const blockedFan = await h.store.readNodeExecution(blocked.fan);
            expect(blockedFan).toMatchObject({ outcome: "blocked", resultKind: "business" });
            const blockedEntry = blockedFan.output.branches.find(item => item.index === 0);
            expect(blockedEntry.output).toEqual(output);
            expect(timedEntry.output).toEqual(blockedEntry.output);
        } finally {
            await h.stop();
        }
    });
});
