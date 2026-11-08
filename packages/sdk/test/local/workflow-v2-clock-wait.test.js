/**
 * Stage 2.4 (PR 235 955856f9): clock waits on controller 1.9.0, on PostgreSQL and the durable runtime. A wait state's
 * `at` (the cron_at fields: minute; hour; day_of_week or day_of_month; tz) waits until the next time it names, decided
 * once when the state is entered, from the store's clock (a test run's virtual clock), DST-safe (cron-at.ts):
 * - a test run's clock wait gets the next 09:00 in its zone after the virtual epoch as its deadline; an advance to one
 *   second before decides nothing, and to the deadline elapses it;
 * - across a DST change (America/Los_Angeles, spring forward) the deadline is the local wall time, not 24 h later;
 * - a live run's deadline is the next fire after the entry's own clock reading (its entered_at);
 * - the read describes the wait in words.
 * Not in the formal model (wait states are not); these regressions are its evidence.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { computeCronAtNextFire } from "../../src/cron-at.ts";
import { createWorkflowV2 } from "../../src/workflow/v2/service.ts";
import { readWorkflowFromTool, updateWorkflowFromTool } from "../../src/workflow/v2/tools.ts";
import { registerWorkflowV2, sessionQueueTransport } from "../../src/workflow/v2/runtime.ts";
import { nodeExecutionIdFor, WORKFLOW_V2_TEST_EPOCH } from "../../src/workflow/v2/store.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-v2-clock-wait-test" };

const CLOCK = (at) => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: morning, version: "1.0.0" }
initial: hold
states:
  hold:
    type: wait
    at: ${at}
    transition: { next: { elapsed: done } }
  done: { type: terminal, outcome: succeeded }
`;

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

async function harness(env) {
    const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
    await catalog.initialize();
    const store = catalog.workflowStore();
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error", workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] } });
    registerWorkflowV2({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => {},
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500, testPollMs: 50, workflowRequests: true,
        sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
    });
    await runtime.start();
    return {
        catalog, store, client, host: { catalog, store, duroxideClient: client, requests: true },
        async stop() { await runtime.shutdown(100); await catalog.close(); },
    };
}

async function draftOf(h, yaml) {
    const parentId = randomUUID();
    await h.catalog.createSession(parentId, {});
    const workflowId = randomUUID();
    const created = await createWorkflowV2(h.host, { workflowSessionId: workflowId, parentSessionId: parentId, yaml, actor: ACTOR, operationId: "create" });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    const context = { callerSessionId: parentId, host: h.host };
    const update = async args => JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowId, ...args }, context));
    return {
        parentId, workflowId, hash: created.receipt.yamlSha256, update,
        read: async (args = {}) => JSON.parse(await readWorkflowFromTool({ workflow_id: workflowId, ...args }, context)),
        async test(operationId) {
            const started = await update({ operation: "test", operation_id: operationId, expected_revision: 1, definition_hash: created.receipt.yamlSha256, inputs: {} });
            expect(started, JSON.stringify(started)).toMatchObject({ ok: true, run: { mode: "test" } });
            return started.run.runId;
        },
    };
}

const pendingNode = (h, nodeExecutionId) => until(async () => {
    const node = await h.store.readNodeExecution(nodeExecutionId);
    return node?.state === "pending" ? node : null;
}, `node ${nodeExecutionId} to wait`);

describe("clock waits (stage 2.4; controller 1.9.0)", () => {
    it("a test run waits on its virtual clock until the next time named, in its zone, DST-safe, and elapses there", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            // 09:00 in Los Angeles after the virtual epoch (9000-01-01T00:00Z, 16:00 the day before there).
            const draft = await draftOf(h, CLOCK("{ minute: 0, hour: 9, tz: America/Los_Angeles }"));
            const runId = await draft.test("t-1");
            const hold = nodeExecutionIdFor(runId, "root", "hold", 1);
            const waiting = await pendingNode(h, hold);
            const expected = computeCronAtNextFire({ minute: 0, hour: 9, tz: "America/Los_Angeles" }, Date.parse(WORKFLOW_V2_TEST_EPOCH)).nextFireAtMs;
            expect(waiting.deadlineAt.getTime()).toBe(expected);
            expect(waiting.deadlineAt.toISOString()).toBe("9000-01-01T17:00:00.000Z");
            const seconds = Math.round((expected - Date.parse(WORKFLOW_V2_TEST_EPOCH)) / 1000);
            expect(await draft.update({ operation: "test_advance", operation_id: "a-1", run_id: runId, seconds: seconds - 1 })).toMatchObject({ ok: true, decided: [] });
            const due = await draft.update({ operation: "test_advance", operation_id: "a-2", run_id: runId, seconds: 1 });
            expect(due).toMatchObject({ ok: true, decided: [{ nodeExecutionId: hold, stateId: "hold", outcome: "elapsed" }] });
            const run = await until(async () => { const row = await h.store.readRun(runId); return row?.status === "completed" ? row : null; }, "the run to end");
            expect(run).toMatchObject({ terminalOutcome: "succeeded" });
            // The read describes the wait in words.
            const view = await draft.read({ run_id: runId });
            expect(JSON.stringify(view)).toContain('"until":"the next 09:00 (America/Los_Angeles)"');
        } finally {
            await h.stop();
        }
    });

    it("across a DST change the deadline is the local wall time, and a live run's is the next fire after its own entry", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            // Spring forward in Los Angeles (second Sunday of March): the next 09:00 after the Saturday's 09:00 is 23 h later.
            const saturday = Date.parse("2026-03-07T17:00:00.000Z");
            const sunday = computeCronAtNextFire({ minute: 0, hour: 9, tz: "America/Los_Angeles" }, saturday).nextFireAtMs;
            expect(new Date(sunday).toISOString()).toBe("2026-03-08T16:00:00.000Z");
            expect((sunday - saturday) / 3_600_000).toBe(23);
            // A live run (started, not a test): its deadline is the next fire after its entered_at, in its zone.
            const draft = await draftOf(h, CLOCK("{ minute: 30, hour: 6, day_of_week: 1, tz: Europe/Paris }"));
            const started = await draft.update({ operation: "publish_and_start", operation_id: "go", expected_revision: 1, definition_hash: draft.hash, inputs: {} });
            expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
            const runId = started.run.runId;
            const node = await pendingNode(h, nodeExecutionIdFor(runId, "root", "hold", 1));
            const next = computeCronAtNextFire({ minute: 30, hour: 6, dayOfWeek: 1, tz: "Europe/Paris" }, node.enteredAt.getTime()).nextFireAtMs;
            expect(node.deadlineAt.getTime()).toBe(next);
            expect(node.deadlineAt.getTime()).toBeGreaterThan(node.enteredAt.getTime());
            // Monday 06:30 in Paris, whatever the offset that day.
            const local = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Paris", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
                .format(node.deadlineAt);
            expect(local).toBe("Mon 06:30");
            // Cancel: nothing waits a week in the suite.
            expect(await draft.update({ operation: "cancel", operation_id: "stop", run_id: runId })).toMatchObject({ ok: true });
        } finally {
            await h.stop();
        }
    });
});
