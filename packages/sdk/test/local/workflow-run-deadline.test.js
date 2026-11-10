/**
 * Workflow run deadlines (design 02 run lifecycle, D03, and the canonical
 * `limits: { timeoutSeconds, onExceeded }`; migration 0088): every host
 * compiles one, and the Workflow controller enforces it.
 *
 * - The compiler: limits.timeoutSeconds and onExceeded (expired, the only
 *   policy) compile into the IR's limits; without them the limits hold the
 *   node limit only.
 * - The store: the begin writes the deadline (the run's clock plus the
 *   seconds; a test run's virtual clock); past it no node execution is
 *   admitted, and expireRun ends the run failed with timed_out, cancelling
 *   what is pending (winner deadline); before it, it reports the time left.
 *   A test clock advance never decides a deadline after the run's.
 * - The controller on a native runtime: a test run's deadline on its
 *   virtual clock ends it before a later wait, and after it an answer to an
 *   open interception is refused; a live run ends at its deadline by the
 *   store's clock, paused or not.
 *
 * No model runs. Not an activation proof.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflow, parseWorkflowIr, WORKFLOW_IR_VERSION } from "../../src/workflow/compiler.ts";
import { canonicalJson } from "../../src/workflow/json.ts";
import { createWorkflow } from "../../src/workflow/service.ts";
import { readWorkflowFromTool, updateWorkflowFromTool } from "../../src/workflow/tools.ts";
import {
    registerWorkflow, sessionQueueTransport, WORKFLOW_CONTROLLER_VERSION, workflowTestControllerInstanceId,
} from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor, WORKFLOW_TEST_EPOCH } from "../../src/workflow/store.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { openWorkflowStore } from "../helpers/workflow-request-fixture.js";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-run-deadline-test" };
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
const head = name => ({ apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name, version: "1.0.0" } });
const errorsOf = result => result.diagnostics.filter(item => item.severity === "error").map(item => [item.code, item.path]);

/** A wait of `hold` seconds, then done; with `limits` when given. */
function holdDoc({ limits, hold = 600 } = {}) {
    return {
        ...head("deadline"),
        ...(limits !== undefined ? { limits } : {}),
        initial: "hold",
        states: {
            hold: { type: "wait", seconds: hold, transition: { next: { elapsed: "done", failure: "failed" } } },
            done: { type: "terminal", outcome: "succeeded", output: "${input}" },
            failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
        },
    };
}

/** A mocked agent state with a one-hour deadline, in a run with a 300-second deadline. */
function agentDoc() {
    return {
        ...head("deadline-agent"),
        limits: { timeoutSeconds: 300 },
        initial: "review",
        states: {
            review: {
                type: "agent", invoke: { prompt: "Review the change." }, outcomes: ["accepted"], timeoutSeconds: 3600,
                transition: { next: { accepted: "done", failure: "failed" } },
            },
            done: { type: "terminal", outcome: "succeeded", output: "${input}" },
            failed: { type: "terminal", outcome: "failed", output: "${runtime.error}" },
        },
    };
}

describe("workflow run deadlines: the compiler", () => {
    it("compiles limits.timeoutSeconds and onExceeded into the IR's limits; without them the limits hold the node limit only", () => {
        const doc = holdDoc({ limits: { timeoutSeconds: 300 } });
        const compiled = compileWorkflow(yamlOf(doc));
        expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
        expect(compiled.ir.irVersion).toBe(WORKFLOW_IR_VERSION);
        expect(compiled.ir.limits).toEqual({ maxNodeExecutions: 1000, timeoutSeconds: 300, onExceeded: "expired" });
        // expired is the default and the only policy: stating it compiles to the same IR.
        expect(compileWorkflow(yamlOf(holdDoc({ limits: { timeoutSeconds: 300, onExceeded: "expired" } }))).irSha256).toBe(compiled.irSha256);
        for (const [limits, code, path] of [
            [{ timeoutSeconds: 0 }, "WORKFLOW_FIELD_INVALID", "limits.timeoutSeconds"],
            [{ timeoutSeconds: 2_592_001 }, "WORKFLOW_FIELD_INVALID", "limits.timeoutSeconds"],
            [{ timeoutSeconds: 1.5 }, "WORKFLOW_FIELD_INVALID", "limits.timeoutSeconds"],
            [{ timeoutSeconds: "300" }, "WORKFLOW_FIELD_INVALID", "limits.timeoutSeconds"],
            [{ timeoutSeconds: 300, onExceeded: "fail" }, "WORKFLOW_FIELD_INVALID", "limits.onExceeded"],
            [{ onExceeded: "expired" }, "WORKFLOW_FIELD_REQUIRED", "limits.timeoutSeconds"],
        ]) {
            const result = compileWorkflow(yamlOf(holdDoc({ limits })));
            expect(result.valid, JSON.stringify(limits)).toBe(false);
            expect(errorsOf(result), JSON.stringify(limits)).toEqual([[code, path]]);
        }
        // Without a deadline the limits hold the node limit only.
        const plain = compileWorkflow(yamlOf(holdDoc({ limits: { maxNodeExecutions: 50 } })));
        expect(plain.ir.limits).toEqual({ maxNodeExecutions: 50 });
        // The stored IR reads back as compiled; a deadline without its policy, or another policy, is refused.
        const stored = JSON.parse(canonicalJson(compiled.ir));
        expect(parseWorkflowIr(stored)).toEqual(compiled.ir);
        const plainStored = JSON.parse(canonicalJson(plain.ir));
        expect(parseWorkflowIr(plainStored)).toEqual(plain.ir);
        expect(() => parseWorkflowIr({ ...plainStored, limits: { maxNodeExecutions: 50, timeoutSeconds: 300 } })).toThrow(/run deadline is invalid/);
        expect(() => parseWorkflowIr({ ...stored, limits: { ...stored.limits, onExceeded: "fail" } }))
            .toThrow(/run deadline is invalid/);
    });
});

/** A parent, a published workflow of `doc` and one run of it (`mode`), admitted at the Workflow controller and not begun. */
async function admittedRun(h, doc, mode) {
    const parent = randomUUID();
    await h.catalog.createSession(parent, {});
    const yaml = yamlOf(doc);
    const compiled = compileWorkflow(yaml);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    const workflowSessionId = randomUUID();
    const runId = randomUUID();
    expect(await h.catalog.createWorkflowSession(workflowSessionId, { parentSessionId: parent, owner: null,
        creationConfig: { workflow: { requestSha256: "run-deadline" } } })).toEqual({ created: true });
    await h.store.createDefinition({
        workflowSessionId, parentSessionId: parent, notifyParent: false, yaml, compiled, actor: ACTOR,
        operationId: "create", requestSha256: "run-deadline", publish: true, title: "Workflow: deadline",
        start: { runId, mode, controllerInstanceId: mode === "test" ? workflowTestControllerInstanceId(runId) : `wf-${workflowSessionId}`,
            inputsText: "{}", kvText: "{}", testAgentMode: mode === "test" ? "mocked" : null, controllerVersion: WORKFLOW_CONTROLLER_VERSION,
            ...(mode === "test" ? { fixturesText: "[]" } : {}) },
    });
    return { workflowSessionId, runId };
}

const holdOf = (runId, nodeId = "hold") => ({
    runId, nodeExecutionId: nodeExecutionIdFor(runId, "root", nodeId, 1), scopeId: "root", nodeId, ordinal: 1, nodeType: "wait",
    predecessorId: null, arrivalRoute: null, inputText: "null", kvRevision: 1, waitSeconds: 600, immediate: null,
});
const expiry = (h, runId) => h.store.expireRun({ runId, timeoutSeconds: 60, projection: ({ run }) => ({ sessionId: run.workflowSessionId }) });

describe("workflow run deadlines: the store", () => {
    it("writes the deadline at begin on a test run's virtual clock, admits nothing past it, and ends the run with what was pending", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const { workflowSessionId, runId } = await admittedRun(h, holdDoc({ limits: { timeoutSeconds: 60 } }), "test");
            expect(await h.store.readRun(runId)).toMatchObject({ status: "admitted", deadlineAt: null });
            const begun = await h.store.beginRun(runId, undefined, { deadlineSeconds: 60 });
            expect(begun.transitioned).toBe(true);
            expect(begun.run.deadlineAt.toISOString()).toBe(new Date(Date.parse(WORKFLOW_TEST_EPOCH) + 60_000).toISOString());
            // A repeated begin changes nothing: the deadline is written once.
            expect((await h.store.beginRun(runId, undefined, { deadlineSeconds: 60 })).run.deadlineAt).toEqual(begun.run.deadlineAt);
            expect(await h.store.enterNode(holdOf(runId))).toMatchObject({ admitted: true, inserted: true, node: { state: "pending" } });
            expect(await h.store.isRunExpired(await h.store.readRun(runId))).toBe(false);
            expect(await expiry(h, runId)).toEqual({ result: "not_due", remainingMs: 60_000 });
            // The advance never reaches the wait's own deadline (600 s): the run's (60 s) comes first.
            const advanced = await h.store.advanceTestClock({ workflowSessionId, runId, seconds: 120, operationId: "adv-1", requestSha256: "a",
                projection: () => ({ sessionId: workflowSessionId }) });
            expect(advanced.receipt.decided).toEqual([]);
            expect(await h.store.isRunExpired(await h.store.readRun(runId))).toBe(true);
            expect(await h.store.enterNode(holdOf(runId, "done"))).toMatchObject({ admitted: false, reason: "expired" });
            const ended = await expiry(h, runId);
            expect(ended).toMatchObject({ result: "ended", cancelled: [holdOf(runId).nodeExecutionId], run: { status: "failed", terminalOutcome: null } });
            expect(ended.run.terminalError).toMatchObject({ code: "timed_out", details: {
                limit: "timeoutSeconds", timeoutSeconds: 60, onExceeded: "expired", deadlineAt: begun.run.deadlineAt.toISOString(),
                paused: false, stopping: false, cancelledCount: 1 } });
            expect(await h.store.readNodeExecution(holdOf(runId).nodeExecutionId)).toMatchObject({ state: "completed", outcome: "cancelled", winner: "deadline" });
            expect(await h.store.listCancelledNodeIds(runId, "deadline")).toEqual([holdOf(runId).nodeExecutionId]);
            // The first end stands.
            expect(await expiry(h, runId)).toMatchObject({ result: "inactive", run: { status: "failed" } });
        } finally {
            await h.stop();
        }
    });

    it("a live run's deadline is the store's clock at begin plus the seconds; a run without one is never expired", { timeout: TIMEOUT }, async () => {
        const h = await openWorkflowStore(getEnv());
        try {
            const { runId } = await admittedRun(h, holdDoc({ limits: { timeoutSeconds: 1 } }), "live");
            const begun = await h.store.beginRun(runId, undefined, { deadlineSeconds: 1 });
            const run = await h.store.readRun(runId);
            expect(run.deadlineAt.getTime() - run.createdAt.getTime()).toBeGreaterThanOrEqual(1_000);
            expect(begun.run.deadlineAt).toEqual(run.deadlineAt);
            expect(await h.store.isRunExpired(run)).toBe(false);
            await until(async () => h.store.isRunExpired(await h.store.readRun(runId)), "the deadline to pass", 10_000);
            expect(await h.store.expireRun({ runId, timeoutSeconds: 1, projection: ({ run: ended }) => ({ sessionId: ended.workflowSessionId }) }))
                .toMatchObject({ result: "ended", cancelled: [], run: { status: "failed" } });
            const other = await admittedRun(h, holdDoc(), "live");
            const plain = (await h.store.beginRun(other.runId)).run;
            expect(plain.deadlineAt).toBeNull();
            expect(await h.store.isRunExpired(plain)).toBe(false);
            await expect(h.store.expireRun({ runId: other.runId, timeoutSeconds: 1, projection: () => ({ sessionId: other.workflowSessionId }) }))
                .rejects.toMatchObject({ code: "WORKFLOW_STORE_CORRUPT" });
        } finally {
            await h.stop();
        }
    });
});

// ─── The controller on a native runtime ──────────────────────

/** A worker-equivalent registration with the request tag declared; parent notices are recorded. */
async function harness(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
    });
    const notices = [];
    registerWorkflow({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog, enabled: () => true,
        resolveToolBinding: async () => ({ tools: [], excludedTools: [] }),
        openToolExecutor: async () => { throw new Error("No tool runs in these tests."); },
        authorizeParentNotification: async () => true,
        notifyParent: async (parentSessionId, text, meta, clientMessageId) => { notices.push({ parentSessionId, text, clientMessageId }); },
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
        testPollMs: 50,
        sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
    });
    await runtime.start();
    return {
        catalog, store, client, notices, host: { catalog, store, duroxideClient: client },
        async stop() {
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

/** A parent session, a draft workflow of `doc` it created, and its tool calls on it. */
async function draftOf(h, doc) {
    const parentId = randomUUID();
    await h.catalog.createSession(parentId, {});
    const workflowId = randomUUID();
    const created = await createWorkflow(h.host, { workflowSessionId: workflowId, parentSessionId: parentId, yaml: yamlOf(doc), actor: ACTOR, operationId: "create" });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    const context = { callerSessionId: parentId, host: h.host };
    const update = async args => JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowId, ...args }, context));
    return {
        parentId, workflowId, definitionHash: created.receipt.yamlSha256, update,
        read: async (args = {}) => JSON.parse(await readWorkflowFromTool({ workflow_id: workflowId, ...args }, context)),
        async test(operationId) {
            const started = await update({ operation: "test", operation_id: operationId, expected_revision: 1, definition_hash: created.receipt.yamlSha256, inputs: {} });
            expect(started, JSON.stringify(started)).toMatchObject({ ok: true, run: { mode: "test" } });
            return started.run.runId;
        },
        advance: (runId, seconds, operationId) => update({ operation: "test_advance", operation_id: operationId, run_id: runId, seconds }),
    };
}

const ended = (h, runId) => until(async () => {
    const run = await h.store.readRun(runId);
    return run && ["completed", "failed", "cancelled", "stopped"].includes(run.status) ? run : null;
}, `run ${runId} to end`);

const pendingNode = (h, nodeExecutionId) => until(async () => {
    const node = await h.store.readNodeExecution(nodeExecutionId);
    return node?.state === "pending" ? node : null;
}, `node ${nodeExecutionId} to wait`);

describe("workflow run deadlines: the controller", () => {
    it("a test run's deadline on its virtual clock ends it before a later wait, which it cancels", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const draft = await draftOf(h, holdDoc({ limits: { timeoutSeconds: 300 } }));
            const runId = await draft.test("test-1");
            const hold = nodeExecutionIdFor(runId, "root", "hold", 1);
            await pendingNode(h, hold);
            const view = await draft.read({ run_id: runId });
            expect(view.run).toMatchObject({ mode: "test", status: "running", deadline: new Date(Date.parse(WORKFLOW_TEST_EPOCH) + 300_000).toISOString() });
            // The wait's own deadline (600 s) is after the run's (300 s): the advance decides nothing, and the run expires.
            expect(await draft.advance(runId, 600, "adv-1")).toMatchObject({ ok: true, decided: [] });
            const run = await ended(h, runId);
            expect(run).toMatchObject({ status: "failed", terminalNodeId: null });
            expect(run.terminalError).toMatchObject({ code: "timed_out", details: { limit: "timeoutSeconds", timeoutSeconds: 300, onExceeded: "expired",
                cancelledCount: 1, cancelled: [hold] } });
            expect(await h.store.readNodeExecution(hold)).toMatchObject({ state: "completed", outcome: "cancelled", winner: "deadline" });
            const failed = await h.catalog.getSessionEvents(draft.workflowId, 0, 500, ["workflow.failed"]);
            expect(failed.map(event => event.data)).toEqual([expect.objectContaining({ runId, deadline: true, timeoutSeconds: 300, cancelledCount: 1 })]);
        } finally {
            await h.stop();
        }
    });

    it("a deadline that passes while a mocked agent state waits ends the run; a later answer to its interception is refused", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const draft = await draftOf(h, agentDoc());
            const runId = await draft.test("test-1");
            const review = nodeExecutionIdFor(runId, "root", "review", 1);
            await until(async () => (await h.store.readInterception(`${review}/agent`))?.state === "awaiting_parent", "the agent interception");
            expect(await draft.advance(runId, 400, "adv-1")).toMatchObject({ ok: true, decided: [] });
            const run = await ended(h, runId);
            expect(run.terminalError).toMatchObject({ code: "timed_out", details: { cancelled: [review] } });
            expect(await h.store.readNodeExecution(review)).toMatchObject({ outcome: "cancelled", winner: "deadline" });
            const late = await draft.update({ operation: "test_respond", operation_id: "late", run_id: runId, interception_id: `${review}/agent`,
                response: { kind: "success", value: { outcome: "accepted", output: null } } });
            expect(late).toMatchObject({ ok: false, error: { code: "RUN_ENDED" } });
            expect((await h.store.readInterception(`${review}/agent`)).state).toBe("awaiting_parent");
        } finally {
            await h.stop();
        }
    });

    it("a live run ends at its deadline by the store's clock, paused or not, and its parent is told", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const draft = await draftOf(h, holdDoc({ limits: { timeoutSeconds: 2 } }));
            const started = await draft.update({ operation: "publish_and_start", operation_id: "go", expected_revision: 1, definition_hash: draft.definitionHash, inputs: {} });
            expect(started, JSON.stringify(started)).toMatchObject({ ok: true, run: { mode: "live" } });
            const runId = started.run.runId;
            const hold = nodeExecutionIdFor(runId, "root", "hold", 1);
            await pendingNode(h, hold);
            expect(await draft.update({ operation: "pause", operation_id: "pause-1" })).toMatchObject({ ok: true, status: "paused" });
            const run = await ended(h, runId);
            expect(run.status).toBe("failed");
            expect(run.terminalError).toMatchObject({ code: "timed_out", details: { timeoutSeconds: 2, paused: true, cancelled: [hold] } });
            expect(run.deadlineAt.getTime() - run.createdAt.getTime()).toBeGreaterThanOrEqual(2_000);
            expect(run.finishedAt.getTime()).toBeGreaterThanOrEqual(run.deadlineAt.getTime());
            expect(await h.store.readNodeExecution(hold)).toMatchObject({ outcome: "cancelled", winner: "deadline" });
            await until(() => h.notices.some(notice => notice.parentSessionId === draft.parentId), "the parent to be told");
        } finally {
            await h.stop();
        }
    });
});
