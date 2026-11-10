/**
 * Workflow v2 graceful stop (design 02 run lifecycle and D03).
 *
 * - The store: a stop is accepted once per operation id, with its deadline
 *   from one reading of the store's clock; a stopping run admits nothing, is neither paused nor resumed, and ends
 *   stopped once nothing is pending or at its deadline, when what is still
 *   pending is cancelled (winner stop).
 * - The controller on a native duroxide runtime: the admitted work settles
 *   and keeps its result, no successor is admitted, and the parent is told;
 *   at the deadline the work still pending is cancelled and its effect is
 *   asked to stop; a paused run with nothing pending stops at once; a cancel
 *   during the grace ends the run cancelled.
 *
 * No model runs. Not an activation or a routing proof against an older worker.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { compileWorkflowV2 } from "../../src/workflow/v2/compiler.ts";
import { canonicalJson } from "../../src/workflow/v2/json.ts";
import { createWorkflowV2, WORKFLOW_V2_STOP_DEFAULT_GRACE_SECONDS } from "../../src/workflow/v2/service.ts";
import { readWorkflowFromTool, updateWorkflowFromTool } from "../../src/workflow/v2/tools.ts";
import {
    registerWorkflowV2,
    sessionQueueTransport,
    WORKFLOW_V2_CONTROLLER_VERSION,
    workflowEffectInstanceId,
    workflowLiveControllerInstanceId,
} from "../../src/workflow/v2/runtime.ts";
import { nodeExecutionIdFor, WORKFLOW_V2_STOP_MAX_GRACE_SECONDS } from "../../src/workflow/v2/store.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { openWorkflowStore } from "../helpers/workflow-v2-request-fixture.js";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-stop-test" };
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

/** Two scripts in a row: a stop while `work` runs must never admit `next`. */
const STOPPABLE = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: stoppable, version: "1.0.0" }
initial: work
states:
  work:
    type: script
    source: |
      await setResult("ok", { worked: true });
    transition: { next: { ok: next } }
  next:
    type: script
    source: |
      await setResult("ok", { next: true });
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded }
`;

const scriptEntry = (runId, nodeId = "work", ordinal = 1) => ({
    runId, nodeExecutionId: nodeExecutionIdFor(runId, "root", nodeId, ordinal), scopeId: "root", nodeId, ordinal, nodeType: "script",
    predecessorId: null, arrivalRoute: null, inputText: "null", kvRevision: 1, waitSeconds: null, immediate: null,
});

const stopRequest = (run, fields = {}) => ({
    workflowSessionId: run.workflowSessionId, runId: run.runId, operationId: "stop-1", requestSha256: "stop-a", actor: ACTOR,
    reason: "wrap up", graceSeconds: 30, ...fields,
});

const stoppedProjection = ({ run, graceExpired, cancelled }) => ({
    sessionId: run.workflowSessionId,
    events: [{ eventType: "workflow.stopped", data: { runId: run.runId, graceExpired, cancelledCount: cancelled.length } }],
    update: { state: "cancelled", touch: true },
});

/** A store over a migrated schema, and published workflows whose live run is admitted (no controller runs them). */
async function stopFixture(env) {
    const h = await openWorkflowStore(env);
    const parent = randomUUID();
    await h.catalog.createSession(parent, {});
    const compiled = compileWorkflowV2(STOPPABLE);
    expect(compiled.valid, JSON.stringify(compiled.diagnostics)).toBe(true);
    return Object.assign(h, {
        parent,
        /** A published workflow and its admitted live run, for `controllerVersion` (undefined: none recorded, as before 0100). */
        async workflow(controllerVersion) {
            const workflowSessionId = randomUUID();
            const runId = randomUUID();
            expect(await h.catalog.createWorkflowSessionV2(workflowSessionId, { parentSessionId: parent, owner: null,
                creationConfig: { workflowV2: { requestSha256: "stop" } } })).toEqual({ created: true });
            await h.store.createDefinition({
                workflowSessionId, parentSessionId: parent, notifyParent: false, yaml: STOPPABLE, compiled, actor: ACTOR,
                operationId: "create", requestSha256: "stop", publish: true, title: "Workflow: stoppable",
                start: { runId, mode: "live", controllerInstanceId: workflowLiveControllerInstanceId(workflowSessionId),
                    inputsText: "{}", kvText: "{}", testAgentMode: null, ...(controllerVersion === undefined ? {} : { controllerVersion }) },
            });
            return { workflowSessionId, runId };
        },
        async admit(run, nodeId = "work") {
            const entry = scriptEntry(run.runId, nodeId);
            expect(await h.store.enterNode(entry)).toMatchObject({ admitted: true, inserted: true, node: { state: "pending" } });
            return entry.nodeExecutionId;
        },
    });
}

describe("workflow v2 graceful stop: the store", () => {
    it("accepts a stop once per operation; a stopping run admits nothing and is neither paused nor resumed", { timeout: TIMEOUT }, async () => {
        const h = await stopFixture(getEnv());
        try {
            // The grace is an integer from 0 to the bound; nothing is stored otherwise.
            const run = await h.workflow(WORKFLOW_V2_CONTROLLER_VERSION);
            for (const graceSeconds of [-1, 1.5, WORKFLOW_V2_STOP_MAX_GRACE_SECONDS + 1]) {
                await expect(h.store.requestRunStop(stopRequest(run, { graceSeconds }))).rejects.toMatchObject({ code: "WORKFLOW_COMMAND_INVALID" });
            }
            const work = await h.admit(run);

            const accepted = await h.store.requestRunStop(stopRequest(run));
            expect(accepted.replayed).toBe(false);
            expect(accepted.receipt).toEqual({ workflowSessionId: run.workflowSessionId, operation: "stop", runId: run.runId, status: "admitted", kvRevision: 1 });
            const stopping = await h.store.readRun(run.runId);
            expect(stopping).toMatchObject({ status: "admitted", controllerVersion: WORKFLOW_V2_CONTROLLER_VERSION,
                stop: { operationId: "stop-1", reason: "wrap up", graceSeconds: 30, actor: ACTOR } });
            // One reading of the store's clock is the stop's time, and the deadline is that reading plus the grace.
            expect(stopping.stop.deadlineAt.getTime() - stopping.stop.requestedAt.getTime()).toBe(30_000);
            const [exact] = await h.q(`SELECT stop_deadline_at - stop_requested_at = interval '30 seconds' AS exact FROM SCHEMA.workflow_runs WHERE run_id = $1`, [run.runId]);
            expect(exact.exact).toBe(true);
            // A repeat returns the receipt; the id with another request conflicts; another stop is refused.
            expect(await h.store.requestRunStop(stopRequest(run))).toMatchObject({ receipt: accepted.receipt, replayed: true });
            await expect(h.store.requestRunStop(stopRequest(run, { requestSha256: "stop-b", graceSeconds: 5 }))).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
            await expect(h.store.requestRunStop(stopRequest(run, { operationId: "stop-2", requestSha256: "stop-c" })))
                .rejects.toMatchObject({ code: "RUN_ALREADY_STOPPING" });
            expect((await h.store.readRun(run.runId)).stop).toEqual(stopping.stop);

            // No new admission; an admission made before the stop is returned as stored.
            expect(await h.store.enterNode(scriptEntry(run.runId, "next"))).toMatchObject({ admitted: false, reason: "stopping", run: { runId: run.runId } });
            expect(await h.store.readNodeExecution(nodeExecutionIdFor(run.runId, "root", "next", 1))).toBeNull();
            expect(await h.store.enterNode(scriptEntry(run.runId))).toMatchObject({ admitted: true, inserted: false, node: { nodeExecutionId: work } });
            // Neither paused nor resumed.
            for (const pauseIt of [true, false]) {
                await expect(h.store.setRunPaused({ workflowSessionId: run.workflowSessionId, runId: run.runId, pause: pauseIt,
                    operationId: `pause-${pauseIt}`, requestSha256: `pause-${pauseIt}`, actor: ACTOR, reason: null })).rejects.toMatchObject({ code: "RUN_STOPPING" });
            }
            const events = await h.catalog.getSessionEvents(run.workflowSessionId, 0, 100);
            expect(events.filter(event => event.eventType === "workflow.stop_requested").map(event => event.data))
                .toEqual([expect.objectContaining({ runId: run.runId, graceSeconds: 30, reason: "wrap up", deadlineAt: stopping.stop.deadlineAt.toISOString() })]);
        } finally {
            await h.stop();
        }
    });

    it("ends a stopping run stopped once nothing is pending, or at its deadline by the store's clock, cancelling what is still pending", { timeout: TIMEOUT }, async () => {
        const h = await stopFixture(getEnv());
        try {
            // Before the deadline, with work pending, nothing changes and the store reports the time left.
            const settled = await h.workflow(WORKFLOW_V2_CONTROLLER_VERSION);
            const work = await h.admit(settled);
            await h.store.requestRunStop(stopRequest(settled, { graceSeconds: 3600 }));
            const early = await h.store.finishStoppedRun({ runId: settled.runId, projection: stoppedProjection });
            expect(early.result).toBe("not_due");
            expect(early.remainingMs).toBeGreaterThan(3_500_000);
            expect((await h.store.readRun(settled.runId)).status).toBe("admitted");
            // The work settles: the run ends stopped at once, and the result is kept.
            await h.store.completeNode(work, { outcome: "ok", resultKind: "business", valueText: canonicalJson({ worked: true }), winner: "effect" });
            const ended = await h.store.finishStoppedRun({ runId: settled.runId, projection: stoppedProjection });
            expect(ended).toMatchObject({ result: "ended", graceExpired: false, cancelled: [], run: { status: "stopped", pausedFrom: null } });
            expect(ended.run.finishedAt).not.toBeNull();
            expect(ended.run.terminalError).toMatchObject({ code: "stopped", message: "wrap up", details: {
                operationId: "stop-1", graceSeconds: 3600, graceExpired: false, cancelledCount: 0, cancelled: [] } });
            expect(await h.store.readNodeExecution(work)).toMatchObject({ outcome: "ok", resultKind: "business", winner: "effect" });
            // The first end stands.
            expect(await h.store.finishStoppedRun({ runId: settled.runId, projection: stoppedProjection })).toMatchObject({ result: "inactive", run: { status: "stopped" } });
            await expect(h.store.requestRunStop(stopRequest(settled, { operationId: "stop-9", requestSha256: "stop-9" }))).rejects.toMatchObject({ code: "RUN_ENDED" });
            const events = await h.catalog.getSessionEvents(settled.workflowSessionId, 0, 100);
            expect(events.filter(event => event.eventType === "workflow.stopped")).toHaveLength(1);

            // At the deadline, the work still pending is cancelled with winner stop.
            const expired = await h.workflow(WORKFLOW_V2_CONTROLLER_VERSION);
            const stuck = await h.admit(expired);
            await h.store.requestRunStop(stopRequest(expired, { graceSeconds: 1 }));
            await pause(1_200);
            const cancelled = await h.store.finishStoppedRun({ runId: expired.runId, projection: stoppedProjection });
            expect(cancelled).toMatchObject({ result: "ended", graceExpired: true, cancelled: [stuck], run: { status: "stopped" } });
            expect(cancelled.run.terminalError.details).toMatchObject({ graceExpired: true, cancelledCount: 1, cancelled: [stuck] });
            expect(await h.store.readNodeExecution(stuck)).toMatchObject({ state: "completed", outcome: "cancelled", resultKind: "runtime_error", winner: "stop" });
            expect(await h.store.listCancelledNodeIds(expired.runId, "stop")).toEqual([stuck]);
            expect(await h.store.listCancelledNodeIds(expired.runId)).toEqual([]);
            // A late result cannot change the cancelled state.
            const late = await h.store.completeNode(stuck, { outcome: "ok", resultKind: "business", valueText: "{}", winner: "effect" });
            expect(late.won).toBe(false);

            // A stop with no work admitted and no grace ends the run at once.
            const empty = await h.workflow(WORKFLOW_V2_CONTROLLER_VERSION);
            await h.store.requestRunStop(stopRequest(empty, { graceSeconds: 0 }));
            expect(await h.store.finishStoppedRun({ runId: empty.runId, projection: stoppedProjection }))
                .toMatchObject({ result: "ended", graceExpired: false, cancelled: [] });
            // A run without a stop cannot end stopped, even by direct SQL.
            const plain = await h.workflow(WORKFLOW_V2_CONTROLLER_VERSION);
            await expect(h.q(`UPDATE SCHEMA.workflow_runs SET status = 'stopped', finished_at = now() WHERE run_id = $1`, [plain.runId]))
                .rejects.toThrow(/workflow_runs_stop/);
            await expect(h.store.finishStoppedRun({ runId: plain.runId, projection: stoppedProjection })).rejects.toMatchObject({ code: "WORKFLOW_STORE_CORRUPT" });
        } finally {
            await h.stop();
        }
    });
});

// ─── The controller on a native runtime ──────────────────────

/** A gate the test opens; `reached` resolves when code arrives at it. */
function gate() {
    let arrive, open;
    const reached = new Promise(resolve => { arrive = resolve; });
    const opened = new Promise(resolve => { open = resolve; });
    return { reached, arrive: () => arrive(), wait: () => opened, open: () => open() };
}

/**
 * A worker-equivalent registration with the request tag
 * declared. `hold(workflowId)` holds that
 * workflow's next script after its node was admitted and before it starts
 * (the tool binding read). Parent notifications are authorized and recorded.
 */
async function harness(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, {
        dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] },
    });
    const holds = new Map();
    const notified = [];
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog, enabled: () => true,
        resolveToolBinding: async (sessionId) => {
            const held = holds.get(sessionId);
            if (held) { holds.delete(sessionId); held.arrive(); await held.wait(); }
            return null;
        },
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => true,
        notifyParent: async (parentSessionId, text, meta, clientMessageId) => { notified.push({ parentSessionId, clientMessageId }); },
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
        sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
    });
    await runtime.start();
    const held = [];
    return {
        catalog, store, client, notified,
        host: { catalog, store, duroxideClient: client },
        hold(workflowId) { const entry = gate(); holds.set(workflowId, entry); held.push(entry); return entry; },
        async stop() {
            for (const entry of held) entry.open();
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

/** A parent session and the tool calls it makes on its workflow children, through `host`. */
async function parentOf(h, host = h.host) {
    const parentId = randomUUID();
    await h.catalog.createSession(parentId, {});
    const context = { callerSessionId: parentId, host };
    return {
        parentId,
        update: async (workflowId, args) => JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowId, ...args }, context)),
        read: async (workflowId, args = {}) => JSON.parse(await readWorkflowFromTool({ workflow_id: workflowId, ...args }, context)),
    };
}

/** Start a run of STOPPABLE whose first script is held before it starts. */
async function startHeld(h, parent, host = h.host) {
    const workflowSessionId = randomUUID();
    const held = h.hold(workflowSessionId);
    const created = await createWorkflowV2(host, { workflowSessionId, parentSessionId: parent.parentId, yaml: STOPPABLE, actor: ACTOR,
        operationId: "start", notifyParent: true, start: { inputs: {} } });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    await held.reached;
    return { workflowSessionId, runId: created.receipt.run.runId, held };
}

const ended = (h, runId, statuses = ["completed", "failed", "cancelled", "stopped"]) => until(async () => {
    const run = await h.store.readRun(runId);
    return run && statuses.includes(run.status) ? run : null;
}, `run ${runId} to end`);

describe("workflow v2 graceful stop: the controller", () => {
    it("stops a run once its admitted work settled: the result is kept, no successor is admitted, and the parent that asked is not told", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await parentOf(h);
            const { workflowSessionId: id, runId, held } = await startHeld(h, parent);
            const stopped = await parent.update(id, { operation: "stop", operation_id: "stop-1", reason: "enough", grace_seconds: 60 });
            expect(stopped, JSON.stringify(stopped)).toEqual({ ok: true, workflowId: id, operation: "stop", replayed: false, runId, status: "running", kvRevision: 1 });
            expect(await parent.update(id, { operation: "stop", operation_id: "stop-1", reason: "enough", grace_seconds: 60 })).toEqual({ ...stopped, replayed: true });
            expect(await parent.update(id, { operation: "stop", operation_id: "stop-2" })).toMatchObject({ ok: false, error: { code: "RUN_ALREADY_STOPPING" } });
            expect(await parent.update(id, { operation: "pause", operation_id: "pause-1" })).toMatchObject({ ok: false, error: { code: "RUN_STOPPING" } });
            const reading = await parent.read(id);
            expect(reading.run).toMatchObject({ status: "running", stop: { graceSeconds: 60, reason: "enough", settled: false } });

            held.open();
            const run = await ended(h, runId);
            expect(run).toMatchObject({ status: "stopped", terminalOutcome: null });
            expect(run.terminalError).toMatchObject({ code: "stopped", message: "enough", details: { graceExpired: false, cancelledCount: 0 } });
            const nodes = await h.store.listNodeExecutions(runId);
            expect(nodes.map(node => [node.nodeId, node.state, node.outcome])).toEqual([["work", "completed", "ok"]]);
            expect(nodes[0].output).toEqual({ worked: true });
            const events = await h.catalog.getSessionEvents(id, 0, 200);
            expect(events.filter(event => event.eventType === "workflow.stopped").map(event => event.data))
                .toEqual([expect.objectContaining({ runId, graceExpired: false, cancelledCount: 0, reason: "enough" })]);
            expect(events.some(event => event.eventType === "workflow.cancel_requested")).toBe(false);
            expect((await h.catalog.getSession(id)).state).toBe("cancelled");
            // RT-4 (documented: "the parent is told unless it asked"): the parent's own stop ended the run, so it is not told,
            // and no notice is recorded for it.
            await pause(1_500);
            expect(h.notified).toEqual([]);
            expect((await h.catalog.getSessionEvents(id, 0, 200, ["workflow.parent_notified", "workflow.parent_notification_skipped"]))).toEqual([]);
            expect((await h.client.getInstanceInfo(workflowLiveControllerInstanceId(id))).orchestrationVersion).toBe(WORKFLOW_V2_CONTROLLER_VERSION);
            // The read view keeps the stop; nothing further applies to the ended run.
            const after = await parent.read(id);
            expect(after.run).toMatchObject({ status: "stopped", stop: { graceSeconds: 60, reason: "enough" } });
            expect(after.run.stop.settled).toBeUndefined();
            expect(await parent.update(id, { operation: "resume", operation_id: "resume-1" })).toMatchObject({ ok: false, error: { code: "RUN_ENDED" } });
            expect(await parent.update(id, { operation: "stop", operation_id: "stop-3" })).toMatchObject({ ok: false, error: { code: "RUN_ENDED" } });
        } finally {
            await h.stop();
        }
    });

    it("at the stop's deadline, cancels the work still pending, asks its effect to stop and ends the run stopped", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await parentOf(h);
            const { workflowSessionId: id, runId, held } = await startHeld(h, parent);
            const work = nodeExecutionIdFor(runId, "root", "work", 1);
            expect(await parent.update(id, { operation: "stop", operation_id: "stop-1", grace_seconds: 1 })).toMatchObject({ ok: true, status: "running" });
            const run = await ended(h, runId);
            expect(run).toMatchObject({ status: "stopped" });
            expect(run.terminalError).toMatchObject({ code: "stopped", message: "Stopped", details: { graceExpired: true, cancelledCount: 1, cancelled: [work] } });
            expect(await h.store.readNodeExecution(work)).toMatchObject({ state: "completed", outcome: "cancelled", winner: "stop" });
            // The run ends stopped in the store's transaction; the stop activity asks the effect to stop after it, and records that.
            const requested = await until(async () => {
                const events = await h.catalog.getSessionEvents(id, 0, 200);
                const found = events.filter(event => event.eventType === "workflow.cancel_requested");
                return found.length > 0 ? found : null;
            }, "the stop's request to the effect");
            expect(requested.map(event => event.data))
                .toEqual([expect.objectContaining({ runId, stop: true, effects: [expect.objectContaining({ nodeExecutionId: work, instanceId: workflowEffectInstanceId(work) })] })]);
            // The held script starts after its node was decided: its result is not taken, and nothing else is admitted.
            held.open();
            await pause(1_000);
            expect(await h.store.readNodeExecution(work)).toMatchObject({ outcome: "cancelled", winner: "stop" });
            expect((await h.store.listNodeExecutions(runId)).map(node => node.nodeId)).toEqual(["work"]);
            expect((await h.store.readRun(runId)).status).toBe("stopped");
        } finally {
            await h.stop();
        }
    });

    it("stops a paused run with nothing pending at once, and ends a stopping run cancelled on a cancel", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await parentOf(h);
            // Paused after its work settled: the stop finds nothing pending, far before its grace.
            const paused = await startHeld(h, parent);
            expect(await parent.update(paused.workflowSessionId, { operation: "pause", operation_id: "pause-1" })).toMatchObject({ ok: true, status: "paused" });
            paused.held.open();
            await until(async () => (await h.store.readNodeExecution(nodeExecutionIdFor(paused.runId, "root", "work", 1)))?.state === "completed",
                "the paused run's work to settle");
            const started = Date.now();
            expect(await parent.update(paused.workflowSessionId, { operation: "stop", operation_id: "stop-1", grace_seconds: 600 }))
                .toMatchObject({ ok: true, status: "paused" });
            const stoppedRun = await ended(h, paused.runId);
            expect(Date.now() - started).toBeLessThan(30_000);
            expect(stoppedRun).toMatchObject({ status: "stopped", pausedFrom: null, terminalError: { details: { graceExpired: false } } });
            expect((await h.store.listNodeExecutions(paused.runId)).map(node => node.nodeId)).toEqual(["work"]);

            // A cancel during the grace decides the run first: it ends cancelled, and its pending work loses to the cancel.
            const cancelled = await startHeld(h, parent);
            expect(await parent.update(cancelled.workflowSessionId, { operation: "stop", operation_id: "stop-1", grace_seconds: 600 })).toMatchObject({ ok: true });
            expect(await parent.update(cancelled.workflowSessionId, { operation: "cancel", operation_id: "cancel-1", reason: "now" })).toMatchObject({ ok: true });
            expect(await ended(h, cancelled.runId)).toMatchObject({ status: "cancelled" });
            expect(await h.store.readNodeExecution(nodeExecutionIdFor(cancelled.runId, "root", "work", 1))).toMatchObject({ outcome: "cancelled", winner: "cancel" });
            cancelled.held.open();
            expect(WORKFLOW_V2_STOP_DEFAULT_GRACE_SECONDS).toBeLessThanOrEqual(WORKFLOW_V2_STOP_MAX_GRACE_SECONDS);
        } finally {
            await h.stop();
        }
    });
});
