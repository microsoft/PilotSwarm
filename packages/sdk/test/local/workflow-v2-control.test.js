/**
 * Workflow v2 run control on the real durable runtime (duroxide PostgreSQL
 * provider) and the real PostgreSQL store, through the update_workflow and
 * read_workflow tool adapters a parent agent calls:
 *
 * - open KV: the initial map, one atomic set/delete batch at the expected
 *   revision, idempotency by operation id, limits, and the snapshot each
 *   state pins when it is admitted (a running script keeps its own);
 * - pause and resume: a paused run admits no new state, while work already
 *   running finishes and its result is kept; resume admits again;
 * - cancel while paused, a run paused before its controller began, and
 *   recover of such a run whose dispatch was lost.
 *
 * Pause, resume and KV are not in the formal model (README "Model
 * simplifications"); these regressions are their evidence.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { readWorkflowFromTool, updateWorkflowFromTool } from "../../src/workflow/v2/tools.ts";
import { registerWorkflowV2, WORKFLOW_V2_ACTIVITIES } from "../../src/workflow/v2/runtime.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-control-test" };

/** Two script states; each reports the KV snapshot it was given and its input. */
const TWO_STATES = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: control, version: "1.0.0" }
initialInput: { from: "start" }
initial: first
states:
  first:
    type: script
    source: |
      await setResult("ok", { kv: context.kv, input: context.input });
    transition: { next: { ok: second } }
  second:
    type: script
    source: |
      await setResult("ok", { kv: context.kv, prior: context.input });
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded, output: { last: "\${input}", mode: "\${kv.mode}" } }
`;

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

/** A gate the test opens; `reached` resolves when code arrives at it. */
function gate() {
    let arrive, open;
    const reached = new Promise(resolve => { arrive = resolve; });
    const opened = new Promise(resolve => { open = resolve; });
    return { reached, arrive: () => arrive(), wait: () => opened, open: () => open() };
}

/**
 * A worker-equivalent registration. `hold` pauses each effect named in it
 * after its node was admitted and before its script starts (the tool binding
 * read); `refusals` counts admissions the store refused for a pause.
 */
async function harness(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error" });
    const holds = new Map();
    const refusals = [];
    const registrar = {
        registerActivity: (name, fn) => runtime.registerActivity(name, name !== WORKFLOW_V2_ACTIVITIES.enter ? fn : async (ctx, input) => {
            const entered = await fn(ctx, input);
            if (entered.admitted === false && entered.status === "paused") refusals.push(input.runId);
            return entered;
        }),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    };
    registerWorkflowV2(registrar, {
        store,
        catalog,
        enabled: () => true,
        resolveToolBinding: async (sessionId) => {
            const held = holds.get(sessionId);
            if (held) { holds.delete(sessionId); held.arrive(); await held.wait(); }
            return null;
        },
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows notify no parent."); },
        deleteSession: async (sessionId) => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
    });
    await runtime.start();
    return {
        store, client, refusals,
        host: { catalog, store, duroxideClient: client },
        /** Hold the next effect of this workflow before its script starts. */
        hold(workflowId) { const held = gate(); holds.set(workflowId, held); return held; },
        async stop() {
            for (const held of holds.values()) held.open();
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

async function finished(h, runId, timeoutMs = 60_000) {
    return until(async () => {
        const run = await h.store.readRun(runId);
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

describe("workflow v2 run control on the real runtime", () => {
    it("pins each state's KV snapshot at admission and applies set_vars as one atomic batch at the expected revision", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await parentOf(h);
            const id = randomUUID();
            const held = h.hold(id);
            const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: TWO_STATES,
                actor: ACTOR, operationId: "start", start: { inputs: {}, vars: { mode: "a", keep: null } } });
            const { runId } = created.receipt.run;
            await held.reached;

            // The first state was admitted with revision 1 and holds before its script starts.
            const before = await parent.read(id);
            expect(before.run).toMatchObject({ status: "running", kvRevision: 1 });
            // The read view previews the map as canonical JSON text, like outputs and errors.
            expect(JSON.parse(before.run.kv)).toEqual({ mode: "a", keep: null });
            expect(before.run.nodeExecutions.map(node => [node.stateId, node.state, node.kvRevision])).toEqual([["first", "pending", 1]]);

            // One batch: set two keys, delete one; null was a value until it is deleted explicitly.
            const set = await parent.update(id, { operation: "set_vars", operation_id: "vars-1", set: { mode: "b", extra: 1 }, delete: ["keep"], expected_kv_revision: 1 });
            expect(set, JSON.stringify(set)).toEqual({ ok: true, workflowId: id, operation: "set_vars", replayed: false, runId, status: "running", kvRevision: 2 });
            expect(await parent.update(id, { operation: "set_vars", operation_id: "vars-1", set: { mode: "b", extra: 1 }, delete: ["keep"], expected_kv_revision: 1 }))
                .toEqual({ ...set, replayed: true });
            // A stale revision, a value over the limit and a contradictory batch change nothing.
            expect(await parent.update(id, { operation: "set_vars", operation_id: "vars-stale", set: { mode: "c" }, expected_kv_revision: 1 }))
                .toMatchObject({ ok: false, error: { code: "KV_REVISION_CONFLICT", details: { kvRevision: 2 } } });
            expect(await parent.update(id, { operation: "set_vars", operation_id: "vars-big", set: { mode: "c", big: "x".repeat(300 * 1024) }, expected_kv_revision: 2 }))
                .toMatchObject({ ok: false, error: { code: "KV_LIMIT" } });
            expect(await parent.update(id, { operation: "set_vars", operation_id: "vars-both", set: { mode: "c" }, delete: ["mode"], expected_kv_revision: 2 }))
                .toMatchObject({ ok: false, error: { code: "WORKFLOW_COMMAND_INVALID" } });
            expect(await parent.update(id, { operation: "set_vars", operation_id: "vars-1", set: { mode: "z" }, expected_kv_revision: 2 }))
                .toMatchObject({ ok: false, error: { code: "OPERATION_CONFLICT" } });
            const after = (await parent.read(id)).run;
            expect(after.kvRevision).toBe(2);
            expect(JSON.parse(after.kv)).toEqual({ mode: "b", extra: 1 });
            expect(await h.store.readKv(runId, 1)).toEqual({ mode: "a", keep: null });

            // The running state keeps the snapshot it was admitted with; the next state pins revision 2.
            held.open();
            const run = await finished(h, runId);
            expect(run.status, JSON.stringify(run)).toBe("completed");
            const nodes = await h.store.listNodeExecutions(runId);
            expect(nodes.map(node => [node.nodeId, node.kvRevision])).toEqual([["first", 1], ["second", 2], ["done", 2]]);
            expect(nodes[0].output).toEqual({ kv: { mode: "a", keep: null }, input: { from: "start" } });
            expect(nodes[1].output).toEqual({ kv: { mode: "b", extra: 1 }, prior: { kv: { mode: "a", keep: null }, input: { from: "start" } } });
            expect(run.terminalOutput).toEqual({ last: nodes[1].output, mode: "b" });

            // After the run ends, its KV no longer changes; one vars event was recorded.
            expect(await parent.update(id, { operation: "set_vars", operation_id: "vars-late", set: { mode: "d" }, expected_kv_revision: 2 }))
                .toMatchObject({ ok: false, error: { code: "RUN_ENDED" } });
            const events = await h.host.catalog.getSessionEvents(id, 0, 50, ["workflow.vars_set"]);
            expect(events.map(event => event.data)).toEqual([expect.objectContaining({ runId, kvRevision: 2, set: ["mode", "extra"], deleted: ["keep"] })]);
        } finally { await h.stop(); }
    });

    it("pauses admission without stopping admitted work, and resumes it", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await parentOf(h);
            const id = randomUUID();
            const held = h.hold(id);
            const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: TWO_STATES,
                actor: ACTOR, operationId: "start", start: { inputs: {}, vars: { mode: "a" } } });
            const { runId } = created.receipt.run;
            await held.reached;
            expect(await parent.update(id, { operation: "resume", operation_id: "resume-early" })).toMatchObject({ ok: false, error: { code: "RUN_NOT_PAUSED" } });

            const paused = await parent.update(id, { operation: "pause", operation_id: "pause-1", reason: "review" });
            expect(paused, JSON.stringify(paused)).toEqual({ ok: true, workflowId: id, operation: "pause", replayed: false, runId, status: "paused", kvRevision: 1 });
            expect(await parent.update(id, { operation: "pause", operation_id: "pause-1", reason: "review" })).toEqual({ ...paused, replayed: true });
            expect(await parent.update(id, { operation: "pause", operation_id: "pause-2" })).toMatchObject({ ok: false, error: { code: "RUN_ALREADY_PAUSED" } });
            // Requested, not yet settled: the admitted state is still running.
            expect((await parent.read(id)).run).toMatchObject({ status: "paused", pausedFrom: "running", pauseSettled: false });

            // The admitted script still runs and its result is kept; the next state is refused while paused.
            held.open();
            await until(async () => (await h.store.listNodeExecutions(runId))[0]?.state === "completed", "the admitted script's result");
            await until(async () => h.refusals.includes(runId), "an admission refused for the pause");
            expect((await h.store.listNodeExecutions(runId)).map(node => [node.nodeId, node.state, node.winner])).toEqual([["first", "completed", "effect"]]);
            const view = await parent.read(id);
            expect(view.run).toMatchObject({ status: "paused", pausedFrom: "running", pauseSettled: true, controller: { needsRecovery: false } });
            // KV still changes while paused; the next state will pin it.
            expect(await parent.update(id, { operation: "set_vars", operation_id: "vars-paused", set: { mode: "p" }, expected_kv_revision: 1 }))
                .toMatchObject({ ok: true, status: "paused", kvRevision: 2 });

            const resumed = await parent.update(id, { operation: "resume", operation_id: "resume-1" });
            expect(resumed).toMatchObject({ ok: true, replayed: false, status: "running" });
            const run = await finished(h, runId);
            expect(run).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
            expect(run.terminalOutput.mode).toBe("p");
            expect((await h.store.listNodeExecutions(runId)).map(node => [node.nodeId, node.ordinal, node.kvRevision])).toEqual([["first", 1, 1], ["second", 1, 2], ["done", 1, 2]]);
            expect(await parent.update(id, { operation: "resume", operation_id: "resume-1" })).toEqual({ ...resumed, replayed: true });
            expect(await parent.update(id, { operation: "resume", operation_id: "resume-late" })).toMatchObject({ ok: false, error: { code: "RUN_ENDED" } });
            const events = await h.host.catalog.getSessionEvents(id, 0, 50, ["workflow.paused", "workflow.resumed"]);
            expect(events.map(event => [event.eventType, event.data.reason ?? null])).toEqual([["workflow.paused", "review"], ["workflow.resumed", null]]);
        } finally { await h.stop(); }
    });

    it("starts a run paused before it began as paused, recovers its lost dispatch, and cancels it while paused", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await parentOf(h);
            const id = randomUUID();
            const undispatched = { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async () => undefined } };
            const created = await createWorkflowV2(undispatched, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: TWO_STATES,
                actor: ACTOR, operationId: "start", start: { inputs: {} } });
            const { runId, controllerInstanceId } = created.receipt.run;
            expect(await parent.update(id, { operation: "pause", operation_id: "pause-1" })).toMatchObject({ ok: true, status: "paused" });
            expect(await h.store.readRun(runId)).toMatchObject({ status: "paused", pausedFrom: "admitted" });
            expect((await parent.read(id)).run).toMatchObject({ status: "paused", controller: { status: "NotFound", needsRecovery: true } });

            // Recover dispatches the paused, never-begun run; it begins and stays paused, admitting nothing.
            expect(await parent.update(id, { operation: "recover", operation_id: "recover-1" })).toMatchObject({ ok: true, action: "dispatched", status: "paused" });
            await until(async () => h.refusals.includes(runId), "an admission refused for the pause");
            expect(await h.store.readRun(runId)).toMatchObject({ status: "paused", pausedFrom: "running" });
            expect(await h.store.listNodeExecutions(runId)).toEqual([]);
            const begun = await h.host.catalog.getSessionEvents(id, 0, 50, ["workflow.started"]);
            expect(begun).toHaveLength(1);

            // A cancel is processed while paused; its receipt only says it was accepted.
            const cancel = await parent.update(id, { operation: "cancel", operation_id: "cancel-1", reason: "not needed" });
            expect(cancel, JSON.stringify(cancel)).toMatchObject({ ok: true, operation: "cancel", replayed: false, status: "paused" });
            const run = await finished(h, runId);
            expect(run).toMatchObject({ status: "cancelled", pausedFrom: null, terminalError: { code: "cancelled", message: "not needed" } });
            expect((await h.client.waitForOrchestration(controllerInstanceId, 30_000)).status).toBe("Completed");
            expect(await parent.update(id, { operation: "cancel", operation_id: "cancel-1", reason: "not needed" })).toEqual({ ...cancel, replayed: true });
            expect(await parent.update(id, { operation: "pause", operation_id: "pause-late" })).toMatchObject({ ok: false, error: { code: "RUN_ENDED" } });
            expect(await h.store.listNodeExecutions(runId)).toEqual([]);
        } finally { await h.stop(); }
    });
});
