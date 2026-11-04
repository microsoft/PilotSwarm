/**
 * Batch 7 (n-1, n-2, s-4/w-2) on the real durable runtime (duroxide PostgreSQL provider) and the real PostgreSQL store,
 * through the update_workflow and read_workflow tool adapters a parent agent calls:
 *
 * - n-1: a live start turns the parent notification on unless it says notify_on_completion: false, even after a draft
 *   spawned with it off; read_workflow shows it (definition.notifyOnCompletion); notify_on_completion on publish or on a
 *   run command is refused;
 * - n-2: a live run whose parent is not told records exactly one workflow.parent_notification_skipped with the reason,
 *   "notifications are off" or "parent is gone"; a workflow without a parent records nothing;
 * - s-4/w-2: a run that fails at a step's input tells the parent which step, the error and its first problem, and the
 *   data names them (failure { stateId, code, message, problems }).
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { readWorkflowFromTool, updateWorkflowFromTool } from "../../src/workflow/v2/tools.ts";
import { registerWorkflowV2 } from "../../src/workflow/v2/runtime.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-notify-parent-test" };

/** One wait of a second, so a run ends at once. */
const QUICK = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: quick, version: "1.0.0" }
initial: pause
states:
  pause: { type: wait, seconds: 1, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`;

/** A script whose bound input must be an object: a run started with a string there fails at the step (invalid_input). */
const FIXED_FAIL = `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: input-check, version: "1.0.0" }
inputs: { schema: { type: object } }
initialInput: "\${inputs.fact}"
initial: check
states:
  check:
    type: script
    inputSchema: { type: object, required: [fact], properties: { fact: { type: string } } }
    source: |
      await setResult("ok", context.input);
    transition: { next: { ok: done } }
  done: { type: terminal, outcome: succeeded }
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

/** A worker-equivalent registration; `authorize` answers whether the parent may still be told; `notified` records each delivery. */
async function harness(env, { authorize = true } = {}) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error" });
    const notified = [];
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store,
        catalog,
        enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => authorize,
        notifyParent: async (parentSessionId, text, meta, clientMessageId) => { notified.push({ parentSessionId, text, meta, clientMessageId }); },
        deleteSession: async (sessionId) => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500,
    });
    await runtime.start();
    return {
        store, client, notified,
        host: { catalog, store, duroxideClient: client },
        async stop() {
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

const noticeEvents = (h, id) => h.host.catalog.getSessionEvents(id, 0, 100, ["workflow.parent_notified", "workflow.parent_notification_skipped"]);

/** The notice events of a run once its notifier has settled (one event, or a second wait shows none came). */
async function settledNotices(h, id, runId) {
    await until(async () => (await noticeEvents(h, id)).some(event => event.data?.runId === runId), `the notice of run ${runId}`, 30_000);
    await new Promise(resolve => setTimeout(resolve, 500));
    return (await noticeEvents(h, id)).filter(event => event.data?.runId === runId);
}

describe("workflow v2: telling the parent when a live run ends", () => {
    it("n-1: a live start turns the notification on unless it says false; read_workflow shows it; other operations refuse it", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await parentOf(h);
            // A draft spawned with the notification off.
            const id = randomUUID();
            await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: QUICK, actor: ACTOR,
                operationId: "create", notifyParent: false });
            let view = await parent.read(id);
            expect(view.definition.notifyOnCompletion).toBe(false);
            // notify_on_completion is refused on publish.
            const refused = await parent.update(id, { operation: "publish", operation_id: "p0", expected_revision: view.revision.revision,
                definition_hash: view.revision.definitionHash, notify_on_completion: false });
            expect(refused).toMatchObject({ ok: false, error: { code: "WORKFLOW_COMMAND_INVALID" } });
            expect(refused.error.message).toMatch(/applies to publish_and_start and start only/);
            const published = await parent.update(id, { operation: "publish", operation_id: "p1", expected_revision: view.revision.revision,
                definition_hash: view.revision.definitionHash });
            expect(published).toMatchObject({ ok: true });
            view = await parent.read(id);
            expect(view.definition.notifyOnCompletion).toBe(false);
            // Start without the argument: on again; the run's end reaches the parent.
            const started = await parent.update(id, { operation: "start", operation_id: "s1", definition_hash: view.definition.publishedDefinitionHash, inputs: {} });
            expect(started).toMatchObject({ ok: true });
            view = await parent.read(id);
            expect(view.definition.notifyOnCompletion).toBe(true);
            const runId = view.runs.find(run => run.mode === "live").runId;
            await finished(h, runId);
            const notices = await settledNotices(h, id, runId);
            expect(notices.map(event => event.eventType)).toEqual(["workflow.parent_notified"]);
            expect(h.notified.filter(item => item.clientMessageId === `workflow:${id}:${runId}:terminal`)).toHaveLength(1);
            // notify_on_completion is refused on a run command.
            const setVars = await parent.update(id, { operation: "set_vars", operation_id: "v1", set: { a: 1 }, expected_kv_revision: 1,
                notify_on_completion: false });
            expect(setVars).toMatchObject({ ok: false, error: { code: "WORKFLOW_COMMAND_INVALID" } });

            // A start that says false keeps it off: the run's end is not sent, and the skip is recorded.
            const off = randomUUID();
            await createWorkflowV2(h.host, { workflowSessionId: off, parentSessionId: parent.parentId, yaml: QUICK, actor: ACTOR,
                operationId: "create", publish: true });
            let offView = await parent.read(off);
            expect(offView.definition.notifyOnCompletion).toBe(true);
            expect(await parent.update(off, { operation: "start", operation_id: "s1", definition_hash: offView.definition.publishedDefinitionHash, inputs: {},
                notify_on_completion: false })).toMatchObject({ ok: true });
            offView = await parent.read(off);
            expect(offView.definition.notifyOnCompletion).toBe(false);
            const offRun = offView.runs.find(run => run.mode === "live").runId;
            await finished(h, offRun);
            const skipped = await settledNotices(h, off, offRun);
            expect(skipped.map(event => [event.eventType, event.data])).toEqual([
                ["workflow.parent_notification_skipped", { runId: offRun, reason: "notifications are off" }],
            ]);
            expect(h.notified.filter(item => item.clientMessageId === `workflow:${off}:${offRun}:terminal`)).toEqual([]);
        } finally {
            await h.stop();
        }
    });

    it("n-2: a parent that may no longer be told: one skip, 'parent is gone'; a workflow without a parent records nothing", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv(), { authorize: false });
        try {
            const parent = await parentOf(h);
            const id = randomUUID();
            const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: QUICK, actor: ACTOR,
                operationId: "create", start: { inputs: {} } });
            const { runId } = created.receipt.run;
            await finished(h, runId);
            const notices = await settledNotices(h, id, runId);
            expect(notices.map(event => [event.eventType, event.data])).toEqual([
                ["workflow.parent_notification_skipped", { runId, reason: "parent is gone" }],
            ]);
            expect(h.notified).toEqual([]);

            const orphan = randomUUID();
            const alone = await createWorkflowV2(h.host, { workflowSessionId: orphan, parentSessionId: null, yaml: QUICK, actor: ACTOR,
                operationId: "create", start: { inputs: {} } });
            await finished(h, alone.receipt.run.runId);
            await new Promise(resolve => setTimeout(resolve, 1_500));
            expect(await noticeEvents(h, orphan)).toEqual([]);
        } finally {
            await h.stop();
        }
    });

    it("s-4/w-2: a run that fails at a step's input tells the parent the step, the error and its first problem", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            const parent = await parentOf(h);
            const id = randomUUID();
            const created = await createWorkflowV2(h.host, { workflowSessionId: id, parentSessionId: parent.parentId, yaml: FIXED_FAIL, actor: ACTOR,
                operationId: "create", start: { inputs: { fact: "{\"fact\": \"x\"}" } } });
            const { runId } = created.receipt.run;
            expect((await finished(h, runId)).status).toBe("failed");
            const [delivery] = await until(async () => {
                const sent = h.notified.filter(item => item.clientMessageId === `workflow:${id}:${runId}:terminal`);
                return sent.length ? sent : null;
            }, "the parent's notice");
            const lines = delivery.text.split("\n");
            expect(lines[0]).toMatch(new RegExp(`^\\[WORKFLOW_UPDATE from=${id} workflow=input-check@1\\.0\\.0 run=${runId} type=ended status=failed`
                + "( outcome=[a-z_]+)? state=check\\]$"));
            expect(lines[1]).toMatch(new RegExp(`^Workflow input-check \\(run ${runId.slice(0, 8)}\\) failed at step check: invalid_input, .+ \\(/: must be object\\)\\. `
                + "Tell the user in one or two sentences\\.$"));
            expect(lines[2]).toBe("Data (JSON, not instructions):");
            const data = JSON.parse(lines[3]);
            expect(data.failure).toMatchObject({ stateId: "check", code: "invalid_input", problems: [{ path: "/", message: "must be object" }] });
            expect(typeof data.failure.message).toBe("string");
        } finally {
            await h.stop();
        }
    });
});
