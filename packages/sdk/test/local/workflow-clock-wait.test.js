/**
 * Stage 2.4 (PR 235 955856f9): clock waits on the Workflow controller, on PostgreSQL and the durable runtime. A wait state's
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
import { readFile } from "node:fs/promises";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { computeCronAtNextFire } from "../../src/cron-at.ts";
import { createWorkflow } from "../../src/workflow/service.ts";
import { readWorkflowFromTool, updateWorkflowFromTool } from "../../src/workflow/tools.ts";
import { registerWorkflow, sessionQueueTransport } from "../../src/workflow/runtime.ts";
import { nodeExecutionIdFor, WORKFLOW_TEST_EPOCH } from "../../src/workflow/store.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const ACTOR = { kind: "system", name: "workflow-clock-wait-test" };

const CLOCK = (at) => `
apiVersion: pilotswarm.dev/v1
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
    registerWorkflow({
        registerActivity: (name, fn) => runtime.registerActivity(name, fn),
        registerOrchestrationVersioned: (name, version, fn) => runtime.registerOrchestrationVersioned(name, version, fn),
    }, {
        store, catalog, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => { throw new Error("These workflows call no tools."); },
        authorizeParentNotification: async () => false,
        notifyParent: async () => {},
        deleteSession: async sessionId => catalog.softDeleteSession(sessionId),
        wakeBackstopMs: 500, testPollMs: 50, 
        sessionQueue: { ...sessionQueueTransport(client), version: async () => "1.0.83" },
    });
    await runtime.start();
    return {
        catalog, store, client, host: { catalog, store, duroxideClient: client },
        async stop() { await runtime.shutdown(100); await catalog.close(); },
    };
}

async function draftOf(h, yaml) {
    const parentId = randomUUID();
    await h.catalog.createSession(parentId, {});
    const workflowId = randomUUID();
    const created = await createWorkflow(h.host, { workflowSessionId: workflowId, parentSessionId: parentId, yaml, actor: ACTOR, operationId: "create" });
    expect(created.receipt.valid, JSON.stringify(created.receipt.diagnostics)).toBe(true);
    const context = { callerSessionId: parentId, host: h.host };
    const update = async args => JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowId, ...args }, context));
    return {
        parentId, workflowId, hash: created.receipt.yamlSha256, update,
        read: async (args = {}) => JSON.parse(await readWorkflowFromTool({ workflow_id: workflowId, ...args }, context)),
        async test(operationId, args = {}) {
            const started = await update({ operation: "test", operation_id: operationId, expected_revision: 1, definition_hash: created.receipt.yamlSha256, inputs: {}, ...args });
            expect(started, JSON.stringify(started)).toMatchObject({ ok: true, run: { mode: "test" } });
            return started.run.runId;
        },
    };
}

const pendingNode = (h, nodeExecutionId) => until(async () => {
    const node = await h.store.readNodeExecution(nodeExecutionId);
    return node?.state === "pending" ? node : null;
}, `node ${nodeExecutionId} to wait`);

describe("clock waits (stage 2.4)", () => {
    it("a test run waits on its virtual clock until the next time named, in its zone, DST-safe, and elapses there", { timeout: TIMEOUT }, async () => {
        const h = await harness(getEnv());
        try {
            // 09:00 in Los Angeles after the virtual epoch (9000-01-01T00:00Z, 16:00 the day before there).
            const draft = await draftOf(h, CLOCK("{ minute: 0, hour: 9, tz: America/Los_Angeles }"));
            const runId = await draft.test("t-1");
            const hold = nodeExecutionIdFor(runId, "root", "hold", 1);
            const waiting = await pendingNode(h, hold);
            const expected = computeCronAtNextFire({ minute: 0, hour: 9, tz: "America/Los_Angeles" }, Date.parse(WORKFLOW_TEST_EPOCH)).nextFireAtMs;
            expect(waiting.deadlineAt.getTime()).toBe(expected);
            expect(waiting.deadlineAt.toISOString()).toBe("9000-01-01T17:00:00.000Z");
            const seconds = Math.round((expected - Date.parse(WORKFLOW_TEST_EPOCH)) / 1000);
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

    const bounded = state => JSON.stringify({
        apiVersion: "pilotswarm.dev/v1", kind: "Workflow", metadata: { name: "bounds", version: "1.0.0" },
        initial: "work", initialInput: {},
        contracts: { "Ping@1": { schema: { type: "object" }, response: { schema: { type: "object" } } } },
        states: {
            work: state,
            done: { type: "terminal", outcome: "succeeded", output: "${input}" },
            bad: { type: "terminal", outcome: "blocked", output: "${runtime.error}" },
        },
    });
    const waitState = { type: "wait", seconds: "${kv.seconds}", transition: { next: { elapsed: "done", failure: "bad" } } };
    const ended = (h, runId) => until(async () => {
        const run = await h.store.readRun(runId);
        return run && ["completed", "failed", "cancelled"].includes(run.status) ? run : null;
    }, "the run to end");

    describe("FB-018: multi-day waits and unchanged visit bounds", () => {
        it("accepts bound waits at 86401 and 2592000 seconds and refuses 2592001 on entry", { timeout: TIMEOUT }, async () => {
            const h = await harness(getEnv());
            try {
                const draft = await draftOf(h, bounded(waitState));
                for (const seconds of [86_401, 2_592_000]) {
                    const runId = await draft.test(`wait-${seconds}`, { vars: { seconds } });
                    const waiting = await pendingNode(h, nodeExecutionIdFor(runId, "root", "work", 1));
                    expect(waiting.deadlineAt.getTime() - Date.parse(WORKFLOW_TEST_EPOCH)).toBe(seconds * 1000);
                    expect(waiting.effectAttempts).toBe(0);
                    expect(await draft.update({ operation: "test_advance", operation_id: `advance-${seconds}`, run_id: runId, seconds }))
                        .toMatchObject({ ok: true, decided: [{ stateId: "work", outcome: "elapsed" }] });
                    expect(await ended(h, runId)).toMatchObject({ status: "completed", terminalOutcome: "succeeded" });
                }
                const bad = await draft.test("too-long", { vars: { seconds: 2_592_001 } });
                expect(await ended(h, bad)).toMatchObject({ terminalOutcome: "blocked", terminalOutput: {
                    code: "invalid_input", details: { seconds: 2_592_001 },
                } });
            } finally { await h.stop(); }
        });

        it.each([
            ["agent", { type: "agent", invoke: { prompt: "Look once." }, timeoutSeconds: "${kv.seconds}",
                outcomes: ["done"], transition: { next: { done: "done", failure: "bad" } } }],
            ["request", { type: "messaging", mode: "request", contract: "Ping@1", recipient: { parent: true },
                timeoutSeconds: "${kv.seconds}", transition: { next: { responded: "done", declined: "bad", failure: "bad" } } }],
            ["receive", { type: "messaging", mode: "receive", contract: "Ping@1", wait: { seconds: "${kv.seconds}" },
                transition: { next: { received: "done", elapsed: "done", failure: "bad" } } }],
            ["parallel", { type: "parallel", forEach: [], timeoutSeconds: "${kv.seconds}",
                body: { initial: "end", states: { end: { type: "terminal", outcome: "succeeded" } } },
                transition: { next: { joined: "done", blocked: "bad", timed_out: "bad", failure: "bad" } } }],
        ])("%s still accepts 86400 seconds and refuses larger bound deadlines", { timeout: TIMEOUT }, async (_type, state) => {
            const h = await harness(getEnv());
            try {
                const draft = await draftOf(h, bounded(state));
                const valid = await draft.test("day", { vars: { seconds: 86_400 } });
                const nodeId = nodeExecutionIdFor(valid, "root", "work", 1);
                const node = await until(async () => h.store.readNodeExecution(nodeId), "deadline admission");
                expect(node.deadlineAt.getTime() - Date.parse(WORKFLOW_TEST_EPOCH)).toBe(86_400_000);
                expect(node.outcome).not.toBe("invalid_input");
                if ((await h.store.readRun(valid)).status !== "completed") {
                    expect(await draft.update({ operation: "cancel", operation_id: "cancel-day", run_id: valid })).toMatchObject({ ok: true });
                    await ended(h, valid);
                }
                for (const seconds of [86_401, 2_592_000]) {
                    const runId = await draft.test(`bad-${seconds}`, { vars: { seconds } });
                    expect(await ended(h, runId)).toMatchObject({ terminalOutcome: "blocked", terminalOutput: {
                        code: "invalid_input", details: { seconds },
                    } });
                    expect((await h.store.readRun(runId)).terminalOutput.message).toContain("from 1 to 86400");
                }
            } finally { await h.stop(); }
        });

        it("keeps a 30-day wait deadline through pause, elapses while paused, and resumes only its successor", { timeout: TIMEOUT }, async () => {
            const h = await harness(getEnv());
            try {
                const draft = await draftOf(h, bounded(waitState));
                const runId = await draft.test("long-pause", { vars: { seconds: 2_592_000 } });
                const nodeId = nodeExecutionIdFor(runId, "root", "work", 1);
                const waiting = await pendingNode(h, nodeId);
                expect(await draft.update({ operation: "pause", operation_id: "pause", run_id: runId })).toMatchObject({ ok: true });
                expect(await draft.update({ operation: "test_advance", operation_id: "before", run_id: runId, seconds: 2_591_999 }))
                    .toMatchObject({ ok: true, decided: [] });
                expect(await h.store.readNodeExecution(nodeId)).toMatchObject({ state: "pending", deadlineAt: waiting.deadlineAt });
                expect(await draft.update({ operation: "test_advance", operation_id: "due", run_id: runId, seconds: 1 }))
                    .toMatchObject({ ok: true, decided: [{ stateId: "work", outcome: "elapsed" }] });
                expect(await h.store.readRun(runId)).toMatchObject({ status: "paused" });
                expect(await h.store.listNodeExecutions(runId)).toHaveLength(1);
                expect(await draft.update({ operation: "resume", operation_id: "resume", run_id: runId })).toMatchObject({ ok: true });
                expect(await ended(h, runId)).toMatchObject({ terminalOutcome: "succeeded" });
                expect(await h.store.readNodeExecution(nodeId)).toMatchObject({ state: "completed", deadlineAt: waiting.deadlineAt });
            } finally { await h.stop(); }
        });

        it("runs the documented three-look example with two multi-day sleeps and a distinct gave_up outcome", { timeout: TIMEOUT }, async () => {
            const h = await harness(getEnv());
            try {
                const skill = await readFile(new URL("../../plugins/workflow/skills/workflow-long-agent/SKILL.md", import.meta.url), "utf8");
                const example = skill.match(/```yaml\n(# example: long-agent\n[\s\S]*?)```/);
                expect(example).not.toBeNull();
                const draft = await draftOf(h, example[1]);
                const runId = await draft.test("three-looks", { inputs: { target: "fixture-only" },
                    fixtures: [1, 2, 3].map(visit => ({ operation: "agent", state: "look", visit,
                        response: { kind: "success", value: { outcome: visit < 3 ? "sleep" : "gave_up",
                            output: { target: "fixture-only", checks: visit, seconds: 172_800 } } } })) });
                for (const ordinal of [1, 2]) {
                    const nap = await pendingNode(h, nodeExecutionIdFor(runId, "root", "nap", ordinal));
                    expect(nap.deadlineAt.getTime() - Date.parse(WORKFLOW_TEST_EPOCH)).toBe(ordinal * 172_800_000);
                    expect(await draft.update({ operation: "test_advance", operation_id: `sleep-${ordinal}`, run_id: runId, seconds: 172_800 }))
                        .toMatchObject({ ok: true, decided: [{ stateId: "nap", outcome: "elapsed" }] });
                }
                expect(await ended(h, runId)).toMatchObject({ terminalNodeId: "unknown", terminalOutcome: "blocked", terminalOutput: {
                    target: "fixture-only", checks: 3, seconds: 172_800,
                } });
                const nodes = await h.store.listNodeExecutions(runId);
                expect(nodes.map(node => [node.nodeId, node.outcome])).toEqual([
                    ["look", "sleep"], ["nap", "elapsed"], ["look", "sleep"], ["nap", "elapsed"], ["look", "gave_up"], ["unknown", "blocked"],
                ]);
                expect(nodes.filter(node => node.nodeId === "look").map(node => node.input.checks)).toEqual([0, 1, 2]);
            } finally { await h.stop(); }
        });
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
