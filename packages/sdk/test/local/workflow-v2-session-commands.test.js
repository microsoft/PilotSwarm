/**
 * A parent session's lifecycle commands to its children. cancel_agent,
 * delete_agent and the shutdown cascade of the parent's durable session send
 * cancel, done or delete through the sendCommandToSession activity. Here the
 * real activity (session-proxy registerActivities) runs in a real duroxide
 * runtime, scheduled by an orchestration whose instance id is the parent
 * session's (`session-<id>`), so the caller is the runtime's instance id,
 * not a value in the command:
 * - a v2 workflow child whose run has not begun ends in the store (cancel,
 *   done) or is deleted with its receipt in one transaction (delete), and so
 *   is a draft child with no run (delete; cancel has nothing to apply); no
 *   command is queued for a controller that does not exist;
 * - a delete is always applied in the store, whatever the child's run did:
 *   a running run ends by the deletion, a run that ended keeps its result,
 *   and a delete an earlier head accepted as queued (then interrupted before
 *   it queued the command, while the run ended on its own) is applied by its
 *   repeat; the child's facts are removed each time;
 * - a cancel or done for a begun v2 workflow child, and any command for an
 *   ordinary agent child, is queued as before (positive controls);
 * - only the child's parent may send them, and a requestedBy must name the
 *   sender;
 * - each command's receipt is keyed by its deterministic command id: a retry
 *   replays it, another request with that id is refused.
 * Every session here is a disposable fixture of this file's own schemas.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { PgFactStore } from "../../src/facts-store.ts";
import { canonicalJson, jsonSha256 } from "../../src/workflow/v2/json.ts";
import { registerActivities } from "../../src/session-proxy.ts";
import { controlWorkflowV2Run, createWorkflowV2, SESSION_COMMAND_OPERATION_PREFIX } from "../../src/workflow/v2/service.ts";
import { registerWorkflowV2, workflowLiveControllerInstanceId } from "../../src/workflow/v2/runtime.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-session-commands-test" };

/** A run that waits five minutes once it has begun. */
const LONG_WAIT = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: long-wait, version: "1.0.0" }
initial: nap
states:
  nap:
    type: wait
    seconds: 300
    transition: { next: { elapsed: done } }
  done: { type: terminal, outcome: succeeded }
`;

/** A run that ends on its own a second after it begins. */
const SHORT_WAIT = LONG_WAIT.replace("name: long-wait", "name: short-wait").replace("seconds: 300", "seconds: 1");

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

/**
 * The v2 runtime as a worker registers it, the real sendCommandToSession
 * activity, an orchestration that sends a list of commands as a parent's
 * session would (one activity per command, each result recorded), and an
 * ordinary agent child's orchestration that returns the first message of
 * its queue.
 */
async function harness(env, { factStore } = {}) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error" });
    registerWorkflowV2(runtime, {
        store, catalog,
        enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => { throw new Error("These workflows notify no parent."); },
        deleteSession: async (sessionId) => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
    });
    const activities = new Map();
    registerActivities({ registerActivity: (name, fn) => activities.set(name, fn) }, {}, null, undefined, catalog, undefined,
        env.store, env.cmsSchema, { duroxideSchema: env.duroxideSchema, factsSchema: env.factsSchema },
        undefined, undefined, undefined, undefined, factStore ?? null);
    runtime.registerActivity("sendCommandToSession", activities.get("sendCommandToSession"));
    runtime.registerOrchestration("test-parent-sends-commands", function* (ctx, input) {
        const results = [];
        for (const item of input.items) {
            try {
                yield ctx.scheduleActivity("sendCommandToSession", item);
                results.push({ ok: true });
            } catch (error) {
                results.push({ ok: false, error: error.message });
            }
        }
        return results;
    });
    runtime.registerOrchestration("test-agent-child", function* (ctx) {
        return yield ctx.dequeueEvent("messages");
    });
    await runtime.start();
    const host = { catalog, store, duroxideClient: client };
    return {
        catalog, store, client, host,
        /** Send these commands from the parent session's own orchestration instance; one result per command. */
        async send(parentSessionId, items) {
            const instanceId = `session-${parentSessionId}`;
            await client.startOrchestration(instanceId, "test-parent-sends-commands", { items });
            const ended = await client.waitForOrchestration(instanceId, 60_000);
            expect(ended.status, JSON.stringify(ended)).toBe("Completed");
            return ended.output;
        },
        async stop() {
            await runtime.shutdown(100);
            await catalog.close();
        },
    };
}

/** A lifecycle command as the parent's durable session builds it. */
function lifecycle(cmd, id, parentSessionId, reason) {
    return { type: "cmd", cmd, id, ...(reason ? { args: { reason } } : {}), requestedBy: parentSessionId };
}

describe("a parent session's lifecycle commands to a v2 workflow child", () => {
    it("ends or deletes a child whose run has not begun in the store, for its parent only, and keys each receipt by the command id", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const h = await harness(env);
        const db = new pg.Client({ connectionString: env.store });
        try {
            await db.connect();
            const parentId = randomUUID();
            await h.catalog.createSession(parentId, {});
            // Admitted runs whose dispatch is lost: no controller instance exists for any of them.
            const undispatched = { ...h.host, duroxideClient: { ...h.host.duroxideClient, startOrchestrationVersioned: async () => undefined } };
            const child = async (parent = parentId) => {
                const id = randomUUID();
                const run = (await createWorkflowV2(undispatched, { workflowSessionId: id, parentSessionId: parent, yaml: LONG_WAIT,
                    actor: ACTOR, operationId: "start", start: { inputs: {} } })).receipt.run;
                return { id, ...run };
            };
            const [a, b, c, e] = [await child(), await child(), await child(), await child()];
            // Drafts: no run, so no controller at all.
            const draft = async () => {
                const id = randomUUID();
                await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parentId, yaml: LONG_WAIT, actor: ACTOR, operationId: "draft" });
                return { id };
            };
            const [f, g] = [await draft(), await draft()];
            expect(await controlWorkflowV2Run(h.host, b.id, { operation: "pause", runId: null, reason: null },
                { actor: { kind: "agent", sessionId: parentId }, operationId: "pause" })).toMatchObject({ receipt: { status: "paused" } });
            const receiptOf = async (workflowId, commandId) => (await db.query(`SELECT kind, receipt FROM "${env.cmsSchema}".workflow_operations
                WHERE workflow_session_id = $1 AND operation_id = $2`, [workflowId, `${SESSION_COMMAND_OPERATION_PREFIX}${commandId}`])).rows
                .map(row => ({ kind: row.kind, ...JSON.parse(row.receipt) }));
            const providerRows = async (workflowId) => {
                const instanceId = workflowLiveControllerInstanceId(workflowId);
                const count = async (table) => Number((await db.query(
                    `SELECT count(*) AS n FROM "${env.duroxideSchema}".${table} WHERE instance_id = $1`, [instanceId])).rows[0].n);
                return { queued: await count("orchestrator_queue"), executions: await count("executions") };
            };

            const results = await h.send(parentId, [
                { sessionId: a.id, command: lifecycle("cancel", "cancel-1-aaaa", parentId, "parent cancelled") },
                // The activity retried: the receipt replays.
                { sessionId: a.id, command: lifecycle("cancel", "cancel-1-aaaa", parentId, "parent cancelled") },
                // Another request with that command id.
                { sessionId: a.id, command: lifecycle("cancel", "cancel-1-aaaa", parentId, "another reason") },
                { sessionId: b.id, command: lifecycle("done", "done-1-bbbb", parentId) },
                { sessionId: c.id, command: lifecycle("delete", "delete-1-cccc", parentId, "parent deleted") },
                { sessionId: c.id, command: lifecycle("delete", "delete-1-cccc", parentId, "parent deleted") },
                // A requestedBy that does not name the sending session.
                { sessionId: e.id, command: lifecycle("cancel", "cancel-1-eeee", randomUUID(), "not the parent") },
                { sessionId: f.id, command: lifecycle("delete", "delete-1-ffff", parentId) },
                { sessionId: g.id, command: lifecycle("cancel", "cancel-1-gggg", parentId) },
            ]);
            expect(results.slice(0, 2)).toEqual([{ ok: true }, { ok: true }]);
            expect(results[2]).toMatchObject({ ok: false, error: expect.stringContaining("already used for a different request") });
            expect(results.slice(3, 6)).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
            expect(results[6]).toMatchObject({ ok: false, error: expect.stringContaining(`Only the session that created workflow ${e.id}`) });
            expect(results.slice(7)).toEqual([{ ok: true }, { ok: true }]);

            // cancel: ended before begin, as update_workflow cancel ends it, with the command's receipt.
            expect(await h.store.readRun(a.runId)).toMatchObject({ status: "cancelled", terminalError: { code: "cancelled", message: "parent cancelled",
                details: { command: "cancel", requestedBy: parentId, operationId: `${SESSION_COMMAND_OPERATION_PREFIX}cancel-1-aaaa`, beforeBegin: true } } });
            expect(await receiptOf(a.id, "cancel-1-aaaa")).toEqual([{ kind: "session-cancel", workflowSessionId: a.id, command: "cancel", applied: "store",
                runId: a.runId, status: "cancelled" }]);
            // done, paused before begin: the same end, with done's meaning.
            expect(await h.store.readRun(b.runId)).toMatchObject({ status: "cancelled", pausedFrom: null, terminalError: { code: "cancelled", message: "Stopped",
                details: { command: "done", requestedBy: parentId, beforeBegin: true } } });
            expect(await receiptOf(b.id, "done-1-bbbb")).toMatchObject([{ kind: "session-done", applied: "store", status: "cancelled" }]);
            // delete: the child is soft-deleted, its definition tombstoned and its run ended, with the receipt.
            expect(await h.catalog.getSession(c.id)).toBeNull();
            expect(await h.store.readDefinition(c.id)).toMatchObject({ state: "deleted" });
            expect(await h.store.readRun(c.runId)).toMatchObject({ status: "cancelled", terminalError: { message: "The workflow session was deleted." } });
            expect(await receiptOf(c.id, "delete-1-cccc")).toEqual([{ kind: "session-delete", workflowSessionId: c.id, command: "delete", applied: "store",
                runId: c.runId, status: "deleted" }]);
            // Refused: unchanged, no receipt.
            expect(await h.store.readRun(e.runId)).toMatchObject({ status: "admitted" });
            expect(await receiptOf(e.id, "cancel-1-eeee")).toEqual([]);
            // A draft: delete tombstones it with its receipt; cancel has no run to end and records that.
            expect(await h.catalog.getSession(f.id)).toBeNull();
            expect(await h.store.readDefinition(f.id)).toMatchObject({ state: "deleted" });
            expect(await receiptOf(f.id, "delete-1-ffff")).toEqual([{ kind: "session-delete", workflowSessionId: f.id, command: "delete", applied: "store",
                runId: null, status: "deleted" }]);
            expect(await receiptOf(g.id, "cancel-1-gggg")).toEqual([{ kind: "session-cancel", workflowSessionId: g.id, command: "cancel", applied: "none",
                runId: null, status: null }]);
            expect(await h.store.readDefinition(g.id)).toMatchObject({ state: "draft" });
            // Nothing was queued for any child's controller, which does not exist: no queue row, and no provider drop.
            for (const item of [a, b, c, e, f, g]) expect(await providerRows(item.id), item.id).toEqual({ queued: 0, executions: 0 });
            expect(await h.store.listNodeExecutions(a.runId)).toEqual([]);

            // Another session, even one naming the parent as requestedBy, may not command the parent's child.
            const other = randomUUID();
            await h.catalog.createSession(other, {});
            const d = await child();
            const refused = await h.send(other, [
                { sessionId: d.id, command: lifecycle("cancel", "cancel-9-dddd", parentId, "spoofed") },
                { sessionId: d.id, command: lifecycle("delete", "delete-9-dddd", other, "not mine") },
            ]);
            expect(refused.map(result => result.ok)).toEqual([false, false]);
            expect(refused.every(result => result.error.includes(`Only the session that created workflow ${d.id}`))).toBe(true);
            expect(await h.store.readRun(d.runId)).toMatchObject({ status: "admitted" });
            expect(await h.catalog.getSession(d.id)).not.toBeNull();
            expect(await providerRows(d.id)).toEqual({ queued: 0, executions: 0 });
        } finally {
            await h.stop();
            await db.end();
        }
    });

    it("still queues the command for a begun v2 child and for an ordinary agent child", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const h = await harness(env);
        const db = new pg.Client({ connectionString: env.store });
        try {
            await db.connect();
            const parentId = randomUUID();
            await h.catalog.createSession(parentId, {});
            // A begun v2 child, waiting in its wait state.
            const begunId = randomUUID();
            const begun = (await createWorkflowV2(h.host, { workflowSessionId: begunId, parentSessionId: parentId, yaml: LONG_WAIT,
                actor: ACTOR, operationId: "start", start: { inputs: {} } })).receipt.run;
            await until(async () => (await h.store.listNodeExecutions(begun.runId))[0] ?? null, "the begun child's wait state");
            const stoppedId = randomUUID();
            const stopped = (await createWorkflowV2(h.host, { workflowSessionId: stoppedId, parentSessionId: parentId, yaml: LONG_WAIT,
                actor: ACTOR, operationId: "start", start: { inputs: {} } })).receipt.run;
            await until(async () => (await h.store.listNodeExecutions(stopped.runId))[0] ?? null, "the second begun child's wait state");
            // An ordinary agent child with a running orchestration that waits for its queue.
            const agentId = randomUUID();
            await h.catalog.createSession(agentId, { parentSessionId: parentId });
            await h.client.startOrchestration(`session-${agentId}`, "test-agent-child", null);
            await until(async () => (await h.client.getStatus(`session-${agentId}`)).status === "Running", "the agent child's orchestration");

            const toBegun = lifecycle("cancel", "cancel-2-ffff", parentId, "stop the wait");
            const toAgent = lifecycle("cancel", "cancel-2-gggg", parentId, "stop the agent");
            expect(await h.send(parentId, [{ sessionId: begunId, command: toBegun }, { sessionId: agentId, command: toAgent },
                { sessionId: stoppedId, command: lifecycle("done", "done-2-hhhh", parentId) }]))
                .toEqual([{ ok: true }, { ok: true }, { ok: true }]);

            // Begun: the receipt says so, and the run's controller, which began it, applies the queued command.
            const receipt = (await db.query(`SELECT kind, receipt FROM "${env.cmsSchema}".workflow_operations
                WHERE workflow_session_id = $1 AND operation_id = $2`, [begunId, `${SESSION_COMMAND_OPERATION_PREFIX}cancel-2-ffff`])).rows;
            expect(receipt.map(row => ({ kind: row.kind, ...JSON.parse(row.receipt) }))).toEqual([{ kind: "session-cancel", workflowSessionId: begunId,
                command: "cancel", applied: "queued", runId: begun.runId, status: "running" }]);
            const ended = await until(async () => {
                const run = await h.store.readRun(begun.runId);
                return run.status === "cancelled" ? run : null;
            }, "the begun child's controller to cancel it");
            expect(ended.terminalError).toMatchObject({ code: "cancelled", message: "stop the wait", details: { command: "cancel", requestedBy: parentId } });
            expect(ended.terminalError.details.beforeBegin).toBeUndefined();
            expect((await h.store.listNodeExecutions(begun.runId)).map(node => [node.nodeId, node.outcome, node.winner])).toEqual([["nap", "cancelled", "cancel"]]);
            expect((await h.client.waitForOrchestration(begun.controllerInstanceId, 30_000)).status).toBe("Completed");
            // done keeps its meaning for a begun child: its controller cancels the run as stopped.
            const stoppedRun = await until(async () => {
                const run = await h.store.readRun(stopped.runId);
                return run.status === "cancelled" ? run : null;
            }, "the second begun child's controller to stop it");
            expect(stoppedRun.terminalError).toMatchObject({ code: "cancelled", message: "Stopped", details: { command: "done", requestedBy: parentId } });

            // Ordinary agent: its orchestration receives exactly the command the parent sent; nothing else is written.
            const agent = await h.client.waitForOrchestration(`session-${agentId}`, 30_000);
            expect(agent.status, JSON.stringify(agent)).toBe("Completed");
            expect(JSON.parse(agent.output)).toEqual(toAgent);
            expect((await db.query(`SELECT count(*) AS n FROM "${env.cmsSchema}".workflow_operations WHERE workflow_session_id = $1`, [agentId])).rows[0].n)
                .toBe("0");
        } finally {
            await h.stop();
            await db.end();
        }
    });

    it("applies an accepted delete whatever its child's run did since, keeps a run's own result, and removes the child's facts", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const factStore = await PgFactStore.create(env.store, env.factsSchema);
        await factStore.initialize();
        const h = await harness(env, { factStore });
        const db = new pg.Client({ connectionString: env.store });
        try {
            await db.connect();
            const parentId = randomUUID();
            await h.catalog.createSession(parentId, {});
            const begunChild = async (yaml) => {
                const id = randomUUID();
                const run = (await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parentId, yaml, actor: ACTOR,
                    operationId: "start", start: { inputs: {} } })).receipt.run;
                await until(async () => (await h.store.listNodeExecutions(run.runId))[0] ?? null, "the child's wait state");
                return { id, ...run };
            };
            const completed = async (child) => until(async () => {
                const run = await h.store.readRun(child.runId);
                return run.status === "completed" ? run : null;
            }, "the child's run to end on its own");
            const liveFacts = async (id) => Number((await db.query(
                `SELECT count(*) AS n FROM "${env.factsSchema}".facts WHERE session_id = $1 AND deleted_at IS NULL`, [id])).rows[0].n);
            const receiptRows = async (id, commandId) => (await db.query(`SELECT kind, request_sha256, receipt, created_at FROM "${env.cmsSchema}".workflow_operations
                WHERE workflow_session_id = $1 AND operation_id = $2`, [id, `${SESSION_COMMAND_OPERATION_PREFIX}${commandId}`])).rows;

            // A begun child, still running.
            const running = await begunChild(LONG_WAIT);
            // A begun child whose run ended on its own before the delete arrived.
            const ended = await begunChild(SHORT_WAIT);
            const endedRun = await completed(ended);
            // A delete that an earlier head (9fda34bd) accepted for a begun run as queued, exactly as it stored the
            // receipt, and then was interrupted before it queued the command; the run then ended on its own.
            const interrupted = await begunChild(SHORT_WAIT);
            await db.query(`INSERT INTO "${env.cmsSchema}".workflow_operations (workflow_session_id, operation_id, kind, request_sha256, receipt)
                VALUES ($1, $2, 'session-delete', $3, $4)`, [interrupted.id, `${SESSION_COMMAND_OPERATION_PREFIX}delete-5-iiii`,
                jsonSha256({ kind: "session-delete", reason: null }),
                canonicalJson({ workflowSessionId: interrupted.id, command: "delete", applied: "queued", runId: interrupted.runId, status: "running" })]);
            const interruptedRun = await completed(interrupted);
            const before = await receiptRows(interrupted.id, "delete-5-iiii");
            for (const child of [running, ended, interrupted]) {
                await factStore.storeFact({ key: `test/${child.id}`, value: { child: child.id }, sessionId: child.id });
                expect(await liveFacts(child.id)).toBe(1);
            }

            // One parent orchestration sends all of them (an instance id starts once).
            expect(await h.send(parentId, [
                { sessionId: running.id, command: lifecycle("delete", "delete-5-rrrr", parentId) },
                { sessionId: ended.id, command: lifecycle("delete", "delete-5-eeee", parentId) },
                // The same-id repeat of the interrupted delete.
                { sessionId: interrupted.id, command: lifecycle("delete", "delete-5-iiii", parentId) },
                // Another request with that id, once the child is deleted.
                { sessionId: interrupted.id, command: lifecycle("delete", "delete-5-iiii", parentId, "another reason") },
            ])).toEqual([{ ok: true }, { ok: true }, { ok: true },
                { ok: false, error: expect.stringContaining("already used for a different request") }]);

            for (const child of [running, ended, interrupted]) {
                expect(await h.catalog.getSession(child.id), child.id).toBeNull();
                expect(await h.store.readDefinition(child.id), child.id).toMatchObject({ state: "deleted" });
                expect(await liveFacts(child.id), child.id).toBe(0);
            }
            // Running: the deletion itself ended the run, in the store (the trigger's end, not the controller's
            // delete command), and its pending wait lost to it; its controller then ends.
            expect(await h.store.readRun(running.runId)).toMatchObject({ status: "cancelled",
                terminalError: { code: "cancelled", message: "The workflow session was deleted." } });
            expect((await h.store.listNodeExecutions(running.runId)).map(node => [node.nodeId, node.state, node.winner])).toEqual([["nap", "completed", "delete"]]);
            expect((await receiptRows(running.id, "delete-5-rrrr")).map(row => JSON.parse(row.receipt)))
                .toEqual([{ workflowSessionId: running.id, command: "delete", applied: "store", runId: running.runId, status: "deleted" }]);
            expect((await h.client.waitForOrchestration(running.controllerInstanceId, 30_000)).status).toBe("Completed");
            // Ended on its own: the deletion keeps the run's result.
            expect(await h.store.readRun(ended.runId)).toEqual(endedRun);
            expect((await receiptRows(ended.id, "delete-5-eeee")).map(row => JSON.parse(row.receipt)))
                .toEqual([{ workflowSessionId: ended.id, command: "delete", applied: "store", runId: ended.runId, status: "deleted" }]);
            // Interrupted: its repeat applied it; the run's own result and the stored receipt are unchanged.
            expect(await h.store.readRun(interrupted.runId)).toEqual(interruptedRun);
            expect(await receiptRows(interrupted.id, "delete-5-iiii")).toEqual(before);
        } finally {
            await h.stop();
            await db.end();
            await factStore.close();
        }
    });
});
