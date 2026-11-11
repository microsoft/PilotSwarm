/**
 * The Sweeper and Workflow recovery together, on the real durable runtime (duroxide PostgreSQL provider) and the real
 * PostgreSQL store, with the production Workflow registrations (review of aeb684f5, test review item 2).
 *
 * Between a lost dispatch (a run admitted whose controller never started) or a dead controller (a running run whose
 * controller was terminated) and the parent's `update_workflow` operation `recover`, the Sweeper runs every pass it has:
 * scan, cleanup_session at its default grace and at grace 0, and prune_orchestrations, whose bulk passes delete the dead
 * controller's instance for real. None of them touches either run: the store counts both as active. Recover then
 * dispatches the lost run, which runs to its end, and ends the dead one as failed, with its receipt and the parent's
 * notice. A test bench whose test ended is cleaned, and its real `wft-<run>` controller instance is deleted.
 *
 * The owner session stands for a live session: its `session-<id>` instance is a stand-in orchestration that waits, so
 * the Sweeper reads it as Running (a session's lifecycle owns its children's: cleaning an ended owner removes them).
 *
 * Run: npx vitest run test/local/workflow-sweeper-recover.test.js
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { testTime, useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { createWorkflow } from "../../src/workflow/service.ts";
import { updateWorkflowFromTool } from "../../src/workflow/tools.ts";
import { registerWorkflow, sessionQueueTransport, workflowNotifyInstanceId } from "../../src/workflow/runtime.ts";
import { saveSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { workflowDefinitionFromTool } from "../../src/workflow/definition-tool.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { createSweeperTools } from "../../src/sweeper-tools.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = testTime.ms(180_000);
const ACTOR = { kind: "system", name: "workflow-sweeper-recover-test" };
const OWNER = { provider: "test", subject: "workflow-sweeper-recover" };
const OWNER_STAND_IN = "sweeper-test-owner-session";

const TWO_STEPS = `
apiVersion: pilotswarm.dev/v1
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
apiVersion: pilotswarm.dev/v1
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

/** The session's own definition, tested on its hidden bench: one script, then the end. */
const QUICK = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: quick, version: "1.0.0" }
initial: first
states:
  first:
    type: script
    source: |
      await setResult("ok", { n: 1 });
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded, output: "\${input}" }
`;

async function until(check, label, timeoutMs = 60_000) {
    const deadline = Date.now() + testTime.ms(timeoutMs);
    let last;
    while (Date.now() < deadline) {
        last = await check();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

/** A worker-equivalent registration, plus the owner session's stand-in orchestration; parent notices are recorded. */
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
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => true,
        notifyParent: async (parentSessionId, text, meta, clientMessageId) => { notices.push({ parentSessionId, text, clientMessageId }); },
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
        testPollMs: 50,
        sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
    });
    // The owner's session orchestration, as the Sweeper reads it: running until the test ends it.
    runtime.registerOrchestration(OWNER_STAND_IN, function* (ctx) {
        yield ctx.waitForEvent("end");
        return null;
    });
    await runtime.start();
    const host = { catalog, store, duroxideClient: client, scripts: true };
    const owner = randomUUID();
    await catalog.createSession(owner, { owner: OWNER });
    await client.startOrchestration(`session-${owner}`, OWNER_STAND_IN, {});
    await until(async () => (await client.getStatus(`session-${owner}`)).status === "Running", "the owner's stand-in to run");
    return {
        catalog, store, client, notices, host, owner,
        async stop() {
            try { await client.raiseEvent(`session-${owner}`, "end", {}); } catch {}
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

async function ageSessions(env, ids, minutes) {
    const db = new pg.Pool({ connectionString: env.store, max: 1 });
    try {
        await db.query(`UPDATE "${env.cmsSchema}".sessions SET updated_at = now() - make_interval(mins => $2) WHERE session_id = ANY($1::text[])`,
            [ids, minutes]);
    } finally {
        await db.end();
    }
}

const isLive = async (catalog, sessionId) => {
    const row = await catalog.getSession(sessionId);
    return !!row && row.deletedAt == null;
};

describe("the Sweeper and Workflow recovery on the real runtime", () => {
    it("every Sweeper pass between a lost dispatch or a dead controller and recover keeps the run; recover then works; an ended bench's wft-<run> is deleted",
        { timeout: TIMEOUT }, async () => {
            const env = getEnv();
            const h = await harness(env);
            try {
                const tool = name => findTool(createSweeperTools({ catalog: h.catalog, duroxideClient: h.client, factStore: null }), name);
                const recover = async (id, operationId) => JSON.parse(await updateWorkflowFromTool({ workflow_id: id, operation: "recover", operation_id: operationId },
                    { callerSessionId: h.owner, host: h.host }));

                // A test bench whose test ended: its controller wft-<run> exists and has completed.
                const saved = (await saveSessionWorkflowDefinition(h.host, { ownerSessionId: h.owner, name: "quick", yaml: QUICK, expected: null,
                    actor: { kind: "session", sessionId: h.owner }, operationId: `save-${randomUUID()}`, by: "session" })).receipt;
                expect(saved.valid, JSON.stringify(saved.diagnostics)).toBe(true);
                const report = JSON.parse(await workflowDefinitionFromTool({ name: "quick", operation: "test", fixtures: [] }, {
                    callerSessionId: h.owner, host: h.host, toolCallId: randomUUID(), owner: OWNER, binding: async () => null,
                    testWait: { waitMs: testTime.ms(90_000), pollMs: 50, graceMs: 10_000 } }));
                expect(report, JSON.stringify(report)).toMatchObject({ ok: true, status: "passed" });
                const benchId = report.testId;
                const [benchRun] = await h.store.listRuns(benchId);
                expect(benchRun).toMatchObject({ mode: "test", status: "completed" });
                const wft = benchRun.controllerInstanceId;
                expect(wft.startsWith("wft-"), wft).toBe(true);
                await until(async () => (await h.client.getStatus(wft)).status === "Completed", "the bench's controller to complete");

                // A lost dispatch: the run is admitted; its controller never started.
                const lostId = randomUUID();
                const undispatched = { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async () => undefined } };
                const lost = (await createWorkflow(undispatched, { workflowSessionId: lostId, parentSessionId: h.owner, yaml: TWO_STEPS, notifyParent: true,
                    actor: ACTOR, operationId: "start", start: { inputs: {} } })).receipt.run;
                expect((await h.store.readRun(lost.runId)).status).toBe("admitted");
                expect((await h.client.getStatus(lost.controllerInstanceId)).status).toBe("NotFound");

                // A dead controller: the run runs its script; its controller is terminated.
                const deadId = randomUUID();
                const dead = (await createWorkflow(h.host, { workflowSessionId: deadId, parentSessionId: h.owner, yaml: SLOW, notifyParent: true,
                    actor: ACTOR, operationId: "start", start: { inputs: {} } })).receipt.run;
                await until(async () => (await h.store.listNodeExecutions(dead.runId))[0]?.effectAttempts >= 1, "the slow script to start");
                await h.client.cancelInstance(dead.controllerInstanceId, "terminated by the test");
                await until(async () => (await h.client.getStatus(dead.controllerInstanceId)).status === "Failed", "the dead controller to end");
                expect((await h.store.readRun(dead.runId)).status).toBe("running");

                await ageSessions(env, [benchId, lostId, deadId], 60);

                // scan: the ended bench is a candidate; neither run's session is.
                const scanned = await tool("scan_completed_sessions").handler({ graceMinutes: 5 });
                const listed = scanned.sessions.map(s => s.sessionId);
                expect(listed).toContain(benchId);
                expect(listed).not.toContain(lostId);
                expect(listed).not.toContain(deadId);
                expect(listed).not.toContain(h.owner);

                // cleanup_session, at its default grace and at grace 0: refused for both.
                for (const grace of [undefined, 0]) {
                    for (const id of [lostId, deadId]) {
                        const refused = await tool("cleanup_session").handler({ sessionId: id, ...(grace === undefined ? {} : { graceMinutes: grace }) });
                        expect(refused, `${id} grace ${grace ?? "default"}`).toMatchObject({ ok: false, refused: true, status: "ActiveRun" });
                    }
                }

                // The ended bench is cleaned: its real wft-<run> instance is deleted, its run is kept as history.
                const cleaned = await tool("cleanup_session").handler({ sessionId: benchId });
                expect(cleaned, JSON.stringify(cleaned)).toMatchObject({ ok: true, instancesDeleted: [wft] });
                expect((await h.client.getStatus(wft)).status).toBe("NotFound");
                expect(await isLive(h.catalog, benchId)).toBe(false);
                expect((await h.store.readRun(benchRun.runId)).status).toBe("completed");

                // prune_orchestrations, at its default cutoff and at 0: its bulk pass deletes the dead controller's instance
                // for real; its session pass keeps both rows.
                for (const minutes of [5, 0]) {
                    const pruned = await tool("prune_orchestrations").handler({ deleteTerminalOlderThanMinutes: minutes });
                    expect(pruned.ok, JSON.stringify(pruned)).toBe(true);
                }
                expect((await h.client.getStatus(dead.controllerInstanceId)).status).toBe("NotFound");
                for (const id of [lostId, deadId]) expect(await isLive(h.catalog, id), id).toBe(true);
                expect((await h.store.readRun(lost.runId)).status).toBe("admitted");
                expect((await h.store.readRun(dead.runId)).status).toBe("running");
                expect(await isLive(h.catalog, h.owner)).toBe(true);

                // recover: the lost run is dispatched and runs to its end; the dead one ends failed, and the parent is told.
                expect(await recover(lostId, "recover-lost")).toMatchObject({ ok: true, action: "dispatched", status: "admitted" });
                const lostEnd = await until(async () => {
                    const run = await h.store.readRun(lost.runId);
                    return run && run.status === "completed" ? run : null;
                }, "the recovered run to complete");
                expect(lostEnd.terminalOutput).toEqual({ n: 2 });
                const ended = await recover(deadId, "recover-dead");
                expect(ended, JSON.stringify(ended)).toMatchObject({ ok: true, replayed: false, action: "ended", status: "failed" });
                expect((await h.store.readRun(dead.runId)).terminalError).toMatchObject({ code: "controller_ended", details: { requestedBy: h.owner } });
                // Its receipt is stored: the same operation answers the same result again.
                expect(await recover(deadId, "recover-dead")).toMatchObject({ ok: true, replayed: true, action: "ended", status: "failed" });
                // The parent is told of each run's end, once: the recovered run's completion, and the failure recover ended
                // (by the notifier recover started).
                const noticesOf = async id => (await h.catalog.getSessionEvents(id, 0, 50, ["workflow.parent_notified", "workflow.parent_notification_skipped"]))
                    .map(event => [event.eventType, event.data.runId]);
                await until(async () => (await noticesOf(lostId)).length > 0, "the notice of the recovered run's end");
                const notifier = await until(async () => {
                    const status = await h.client.getStatus(workflowNotifyInstanceId(dead.runId));
                    return ["Completed", "Failed", "Terminated"].includes(status.status) ? status : null;
                }, "the notifier recover started");
                expect(notifier.status, JSON.stringify(notifier)).toBe("Completed");
                expect(await noticesOf(lostId)).toEqual([["workflow.parent_notified", lost.runId]]);
                expect(await noticesOf(deadId)).toEqual([["workflow.parent_notified", dead.runId]]);
                expect(h.notices.map(notice => [notice.parentSessionId, notice.clientMessageId]).sort()).toEqual([
                    [h.owner, `workflow:${deadId}:${dead.runId}:terminal`], [h.owner, `workflow:${lostId}:${lost.runId}:terminal`]].sort());

                // With the run ended, the ordinary path cleans it.
                const after = await tool("cleanup_session").handler({ sessionId: lostId, graceMinutes: 0 });
                expect(after, JSON.stringify(after)).toMatchObject({ ok: true });
                expect((await h.store.readRun(lost.runId)).status).toBe("completed");
            } finally {
                await h.stop();
            }
        });
});

function findTool(tools, name) {
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new Error(`tool not found: ${name}`);
    return tool;
}
