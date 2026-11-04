/**
 * Workflow v2 parallel states and their join (IR 8; design 02 parallel scope
 * and join, D10; requirement R21), INACTIVE: only controller 1.9.0 runs
 * them, and only tests register it and start runs there (the test-only
 * option workflowRequests and a host with `requests`).
 *
 * - The compiler: a parallel state compiles to IR 8 only with
 *   enableParallel; its body states are in the IR's nodes, named by its
 *   body; its manifest, concurrency, join, routes and body are checked;
 *   `branch` is bound only in a body; ids are unique across bodies.
 * - The store: branches are admitted in their own scopes; a failFast
 *   cancellation decides their pending work once (winner fail_fast); a
 *   parallel state's own pending node is not work for a stop.
 * - Controller 1.9.0 on a native duroxide runtime: one branch per manifest
 *   item, at most its concurrency at a time, each with its item and index;
 *   the joined outputs in manifest order; a blocked join that reports every
 *   branch; failFast; empty and invalid manifests; the join's outputSchema;
 *   a stop during a parallel state; a worker restart while every branch
 *   waits (each joined once, each wait's deadline kept).
 *
 * Branch scripts run as real script processes. The failFast case relies on
 * a timing margin: the failing branch waits 5 seconds before it fails, and
 * the other branch reaches its long wait well before that. No model runs.
 * Not an activation proof.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import {
    compileWorkflowV2, parseWorkflowIr, WORKFLOW_V2_AGENT_IR_VERSION, WORKFLOW_V2_MILESTONE_IR_VERSION, WORKFLOW_V2_PARALLEL_MAX_CONCURRENCY,
    WORKFLOW_V2_PARALLEL_MAX_ITEMS,
} from "../../src/workflow/v2/compiler.ts";
import { canonicalJson } from "../../src/workflow/v2/json.ts";
import { controlWorkflowV2Run, createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { readWorkflowV2View } from "../../src/workflow/v2/tools.ts";
import {
    BRANCH_ROUTE, branchScopeId, describeWorkflowV2State, describeWorkflowV2States, parseBranchScope, registerWorkflowV2, sessionQueueTransport,
    WORKFLOW_V2_REQUEST_CONTROLLER_VERSION, WORKFLOW_V2_STOP_CONTROLLER_VERSIONS, workflowLiveControllerInstanceId,
} from "../../src/workflow/v2/runtime.ts";
import { nodeExecutionIdFor } from "../../src/workflow/v2/store.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { openWorkflowStore } from "../helpers/workflow-v2-request-fixture.js";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-parallel-test" };
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

/** Three branches, two at a time, failFast: the second fails after a 5-second wait; the others wait 600 seconds. */
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
                        pause: { type: "wait", seconds: 5, transition: { next: { elapsed: "refused" } } },
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

describe("workflow v2 parallel states: compiler and IR 8", () => {
    it("compiles a parallel state to IR 8 only when enabled; its body states are in the IR, named by its body; a reader takes it only when asked to", () => {
        const refused = compileWorkflowV2(yamlOf(fanOut()), { enableRequests: true, enableAgents: true });
        expect(refused.valid).toBe(false);
        expect(errorsOf(refused).map(item => [item.code, item.path])).toEqual([["WORKFLOW_NODE_TYPE_UNSUPPORTED", "states.fan.type"]]);

        const compiled = compileWorkflowV2(yamlOf(fanOut()), PARALLEL);
        expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
        expect(compiled.ir.irVersion).toBe(WORKFLOW_V2_AGENT_IR_VERSION);
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
        expect(parseWorkflowIr(stored, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION })).toEqual(compiled.ir);
        expect(() => parseWorkflowIr(stored)).toThrow(/stored IR version 8 is not supported/);
        // A stored body that names a missing state or another parallel state, or an initial that is a body state, is refused.
        for (const broken of [
            { ...stored, nodes: { ...stored.nodes, fan: { ...stored.nodes.fan, body: { initial: "work", states: ["work", "gone"] } } } },
            { ...stored, nodes: { ...stored.nodes, fan: { ...stored.nodes.fan, body: { initial: "work", states: ["work", "fan"] } } } },
            { ...stored, initial: "work" },
            { ...stored, nodes: { ...stored.nodes, fan: { ...stored.nodes.fan, concurrency: WORKFLOW_V2_PARALLEL_MAX_CONCURRENCY + 1 } } },
        ]) {
            expect(() => parseWorkflowIr(broken, { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION })).toThrow(/stored IR/);
        }

        expect(describeWorkflowV2State(compiled.ir.nodes.fan)).toEqual({
            id: "fan", type: "parallel", forEach: "${input.items}", concurrency: 2, join: "all_required", failFast: false,
            body: { initial: "work", states: ["work", "done", "refused"] }, outcomes: ["joined", "blocked"], next: compiled.ir.nodes.fan.next,
        });
        const states = describeWorkflowV2States(compiled.ir);
        expect(states.filter(state => state.parallel === "fan").map(state => state.id).sort()).toEqual(["done", "refused", "work"]);
        expect(states.find(state => state.id === "finished").parallel).toBeUndefined();
    });

    it("checks a parallel state's manifest, concurrency, join, routes and body; branch is bound only in a body; ids are unique across bodies", () => {
        const variant = change => {
            const doc = structuredClone(fanOut());
            change(doc, doc.states.fan, doc.states.fan.body.states);
            return compileWorkflowV2(yamlOf(doc), PARALLEL);
        };
        for (const [label, change, code, path] of [
            ["concurrency 0", (_, fan) => { fan.concurrency = 0; }, "WORKFLOW_FIELD_INVALID", "states.fan.concurrency"],
            ["concurrency above the limit", (_, fan) => { fan.concurrency = WORKFLOW_V2_PARALLEL_MAX_CONCURRENCY + 1; }, "WORKFLOW_FIELD_INVALID", "states.fan.concurrency"],
            ["another join", (_, fan) => { fan.join = "any"; }, "WORKFLOW_FEATURE_UNSUPPORTED", "states.fan.join"],
            ["a forEach that is no binding or list", (_, fan) => { fan.forEach = "items"; }, "WORKFLOW_FIELD_INVALID", "states.fan.forEach"],
            ["a literal manifest over the limit", (_, fan) => { fan.forEach = Array.from({ length: WORKFLOW_V2_PARALLEL_MAX_ITEMS + 1 }, (_, n) => ({ n })); },
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
            fan.forEach = Array.from({ length: WORKFLOW_V2_PARALLEL_MAX_ITEMS }, (_, n) => ({ n: n + 1 }));
            fan.failFast = true;
            fan.concurrency = WORKFLOW_V2_PARALLEL_MAX_CONCURRENCY;
        });
        expect(literal.valid, JSON.stringify(literal.diagnostics)).toBe(true);
        expect(literal.ir.nodes.fan).toMatchObject({ failFast: true, concurrency: WORKFLOW_V2_PARALLEL_MAX_CONCURRENCY });
    });
});

describe("workflow v2 parallel states: the store", () => {
    it("admits branches in their own scopes, cancels branch scopes once, and does not count a parallel state's own node as work", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const parent = randomUUID();
            await h.catalog.createSession(parent, {});
            const yaml = yamlOf(holdOut([1, 2]));
            const compiled = compileWorkflowV2(yaml, PARALLEL);
            expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
            const workflowSessionId = randomUUID();
            const runId = randomUUID();
            expect(await h.catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: parent, owner: null,
                creationConfig: { workflowV2: { requestSha256: "parallel" } } })).toEqual({ created: true });
            await h.store.createDefinition({
                workflowSessionId, parentSessionId: parent, notifyParent: false, yaml, compiled, actor: ACTOR,
                operationId: "create", requestSha256: "parallel", publish: true, title: "Workflow: parallel",
                start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
                    inputsText: "{}", kvText: "{}", testAgentMode: null, controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION },
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
            const once = { active: true, cancelled: [{ nodeExecutionId: holds[1], nodeType: "wait" }] };
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
                graceSeconds: 600, stoppableVersions: WORKFLOW_V2_STOP_CONTROLLER_VERSIONS });
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

// ─── Controller 1.9.0 on a native runtime ────────────────────

/** A worker-equivalent registration with workflowRequests and the request tag declared. */
async function harness(env) {
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
        wakeBackstopMs: 500,
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

/** A parent session and a started run of `doc` it created, with the ids of its parallel state and its branches' states. */
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
    return { workflowSessionId, runId, fan, at: (index, nodeId) => nodeExecutionIdFor(runId, branchScopeId(fan, index), nodeId, 1) };
}

const ended = (h, runId) => until(async () => {
    const run = await h.store.readRun(runId);
    return run && ["completed", "failed", "cancelled", "stopped"].includes(run.status) ? run : null;
}, `run ${runId} to end`);

describe("workflow v2 parallel states: controller 1.9.0 (inactive, test-only registration)", () => {
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
                .toBe(WORKFLOW_V2_REQUEST_CONTROLLER_VERSION);

            // read_workflow: the graph marks the body's states; a branch's node execution names its branch.
            const view = await readWorkflowV2View(h.store, workflowSessionId);
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
                joined: false, total: 3, succeeded: 1, failFast: false,
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
                joined: false, total: 3, succeeded: 0, failFast: true,
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
            await controlWorkflowV2Run(h.host, workflowSessionId, { operation: "stop", runId: null, reason: "enough", graceSeconds: 1 },
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
 * 1-second wait, the second a 4-second wait. The run is paused while both wait. The first wait elapses and its next
 * state is refused (the controller is now on its paused path); the second wait must still elapse at its deadline while
 * the run is paused, and nothing after it is admitted until the resume.
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
                        shortWait: { type: "wait", seconds: 1, transition: { next: { elapsed: "done" } } },
                        longWait: { type: "wait", seconds: 4, transition: { next: { elapsed: "done" } } },
                        done: { type: "terminal", outcome: "succeeded", output: "${branch.item}" },
                    },
                },
                transition: { next: { joined: "finished", blocked: "stuck", failure: "failed" } },
            },
            ...OUTER,
        },
    };
}

describe("workflow v2 parallel states: deadlines while paused (controller 1.9.0, test-only)", () => {
    it("elapses a pending state at its deadline while the run is paused, and admits nothing until the resume", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const { workflowSessionId, runId, at } = await started(h, pausedDeadlines());
            const longWait = at(1, "longWait");
            await until(async () => (await h.store.readNodeExecution(longWait))?.state === "pending"
                && (await h.store.readNodeExecution(at(0, "shortWait")))?.state === "pending", "both waits");
            await controlWorkflowV2Run(h.host, workflowSessionId, { operation: "pause", runId: null, reason: "look first" },
                { actor: ACTOR, operationId: "pause-1" });
            // The long wait elapses at its deadline though the run is paused.
            await until(async () => (await h.store.readNodeExecution(longWait))?.state === "completed", "the long wait to elapse while paused", 30_000);
            expect(await h.store.readNodeExecution(longWait)).toMatchObject({ outcome: "elapsed" });
            expect((await h.store.readRun(runId)).status).toBe("paused");
            // Nothing after the waits was admitted.
            const admitted = (await h.store.listNodeExecutions(runId)).map(node => node.nodeId);
            expect(admitted.filter(nodeId => nodeId === "done")).toEqual([]);
            await controlWorkflowV2Run(h.host, workflowSessionId, { operation: "resume", runId: null, reason: null }, { actor: ACTOR, operationId: "resume-1" });
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
const RESTART_SECONDS = 6;
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

describe("workflow v2 parallel states: a worker restart while every branch waits (controller 1.9.0, test-only)", () => {
    it("joins each branch exactly once after the runtime stops with every branch persisted as waiting, keeping each wait's deadline", { timeout: 180_000 }, async () => {
        const base = await restartBaseOf(getEnv());
        const workers = [await restartRuntimeOn(base)];
        try {
            const parent = randomUUID();
            await base.catalog.createSession(parent, {});
            const workflowSessionId = randomUUID();
            const created = await createWorkflowV2(base.host, {
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

            // Stop the runtime, stay down 2.5 s, and start another over the same catalog and provider.
            await workers[0].stop();
            const stoppedAt = Date.now();
            for (const index of RESTART_ITEMS.keys()) expect((await base.store.readNodeExecution(at(index, "hold"))).state).toBe("pending");
            await until(async () => Date.now() - stoppedAt >= 2_500, "the outage window");
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
                expect(late).toBeLessThan(2_000);
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
