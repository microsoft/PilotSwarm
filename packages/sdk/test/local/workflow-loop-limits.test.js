/**
 * Focused PG16 runtime tests for Change C: maxVisits + wait.totalSeconds.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalogProvider } from "../../src/cms.ts";
import { registerWorkflow } from "../../src/workflow/runtime.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";
import { saveSessionWorkflowDefinition, startSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { sendTypedWorkflowInput } from "../../src/workflow/service.ts";
import { startSessionWorkflowTest, definitionTestBench, waitSessionWorkflowTest } from "../../src/workflow/definition-test.ts";
import { parseTestFixtures } from "../../src/workflow/test-mode.ts";

const require = createRequire(import.meta.url);
const { PostgresProvider, Client, Runtime } = require("duroxide");
const TIMEOUT = 60_000;
const OWNER = { provider: "dev", subject: "loop-limits-user", email: "ll@example.com", displayName: "Loop Limits" };
const ENGINE = { kind: "system", label: "loop-limits-test" };
const getEnv = useSuiteEnv(import.meta.url);

async function startHarness(env) {
    const id = randomUUID().replace(/-/g, "").slice(0, 10);
    const cmsSchema = `wrm_${id}`, duroxideSchema = `wrmd_${id}`;
    const catalog = await PgSessionCatalogProvider.create(env.store, cmsSchema);
    await catalog.initialize();
    const provider = await PostgresProvider.connectWithSchema(env.store, duroxideSchema);
    const client = new Client(provider);
    const store = catalog.workflowStore();
    const pool = new pg.Pool({ connectionString: env.store });
    const runtime = new Runtime(provider, {
        orchestrationConcurrency: 8, workerConcurrency: 8, dispatcherPollIntervalMs: 20,
        workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] }, logLevel: "error",
    });
    const host = { catalog, store, duroxideClient: client, scripts: true };
    registerWorkflow(runtime, {
        store, catalog, enabled: () => true,
        resolveToolBinding: async () => null,
        openToolExecutor: async () => ({ call: async () => { throw new Error("no tools"); }, close: async () => {} }),
        authorizeParentNotification: async () => true,
        notifyParent: async () => ({ delivered: true }),
        deleteSession: async (sid) => { await catalog.softDeleteSession(sid); },
        wakeBackstopMs: 200,
        spawnChildHost: () => host,
    });
    await runtime.start();
    const waitRun = async (runId, statuses = ["completed", "failed", "cancelled", "stopped"], ms = 30_000) => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            const run = await store.readRun(runId);
            if (run && statuses.includes(run.status)) return run;
            await new Promise(r => setTimeout(r, 60));
        }
        throw new Error(`Timed out waiting for run ${runId}`);
    };
    return {
        catalog, store, client, host, pool, runtime, cmsSchema, waitRun,
        q: async (sql, params = []) => (await pool.query(sql.replaceAll("SCHEMA", `"${cmsSchema}"`), params)).rows,
        stop: async () => {
            await runtime.shutdown();
            await catalog.close();
            await pool.query(`DROP SCHEMA IF EXISTS "${duroxideSchema}" CASCADE`);
            await pool.query(`DROP SCHEMA IF EXISTS "${cmsSchema}" CASCADE`);
            await pool.end();
        },
    };
}


const MAX_VISITS_YAML = "apiVersion: pilotswarm.dev/v1\nkind: Workflow\nmetadata:\n  name: max-visits-loop\n  version: 0.1.0\ninitial: work\nstates:\n  work:\n    type: script\n    maxVisits: 3\n    input:\n      n: \"${states.work.output.n ?? 0}\"\n      tag: \"passed-in\"\n    outcomes: [again]\n    source: |\n      await setResult(\"again\", { n: context.input.n + 1, ran: true });\n    transition:\n      next:\n        again: work\n        exhausted: done\n        failure: failed\n  done:\n    type: terminal\n    outcome: succeeded\n    output:\n      exhaustedOutput: \"${input}\"\n      lastRan: \"${states.work.output}\"\n  failed:\n    type: terminal\n    outcome: failed\n    output: \"${runtime.error}\"\n";
const TOTAL_WAIT_YAML = "apiVersion: pilotswarm.dev/v1\nkind: Workflow\nmetadata:\n  name: receive-total-wait\n  version: 0.1.0\nschemas:\n  Tick:\n    type: object\n    properties:\n      seq: { type: integer }\ncontracts:\n  Tick@1: { schema: { type: object, properties: { seq: { type: integer } } } }\ninitial: listen\nstates:\n  listen:\n    type: messaging\n    mode: receive\n    contract: Tick@1\n    wait: { totalSeconds: \"${inputs.totalSeconds}\" }\n    transition:\n      next:\n        received: record\n        elapsed: done\n        failure: failed\n  record:\n    type: script\n    input:\n      prev: \"${states.record.output.ticks ?? []}\"\n      seq: \"${input.seq}\"\n    outcomes: [pause]\n    source: |\n      await setResult(\"pause\", { ticks: [...context.input.prev, context.input.seq] });\n    transition: { next: { pause: nap, failure: failed } }\n  nap:\n    type: wait\n    seconds: \"${inputs.napSeconds}\"\n    transition: { next: { elapsed: listen, failure: failed } }\n  done:\n    type: terminal\n    outcome: succeeded\n    output:\n      ticks: \"${states.record.output.ticks ?? []}\"\n  failed:\n    type: terminal\n    outcome: failed\n    output: \"${runtime.error}\"\n";

describe("Loop limits (Change C: maxVisits and wait.totalSeconds)", () => {
    it("maxVisits exhausts at visit N+1 without running effect and wait.totalSeconds bounds total time across 3 visits", { timeout: TIMEOUT }, async () => {
        const h = await startHarness(getEnv());
        try {
            const chat = randomUUID();
            await h.catalog.createSession(chat, { owner: OWNER });

            const s1 = await saveSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, name: "max-visits-loop", yaml: MAX_VISITS_YAML, expected: null,
                actor: { kind: "session", sessionId: chat }, operationId: "save-max-visits",
            });
            expect(s1.receipt.valid, JSON.stringify(s1.receipt.diagnostics)).toBe(true);

            // 1. maxVisits: 3 -> visits 1..3 run script; visit 4 finishes immediately with outcome=exhausted, output=input, effectAttempts=0.
            const r1 = await startSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, definition: { name: "max-visits-loop" }, inputs: {},
                actor: ENGINE, operationId: "start-max-visits", owner: OWNER,
            });
            const end1 = await h.waitRun(r1.runId);
            expect(end1.status).toBe("completed");
            expect(end1.terminalOutput).toEqual({
                exhaustedOutput: { n: 3, ran: true },
                lastRan: { n: 3, ran: true },
            });
            const visits1 = (await h.store.listNodeExecutions(r1.runId)).filter(n => n.nodeId === "work");
            expect(visits1.map(v => ({ ordinal: v.ordinal, outcome: v.outcome, attempts: v.effectAttempts, output: v.output }))).toEqual([
                { ordinal: 1, outcome: "again", attempts: 1, output: { n: 1, ran: true } },
                { ordinal: 2, outcome: "again", attempts: 1, output: { n: 2, ran: true } },
                { ordinal: 3, outcome: "again", attempts: 1, output: { n: 3, ran: true } },
                { ordinal: 4, outcome: "exhausted", attempts: 0, output: { n: 3, ran: true } },
            ]);

            // 2. wait.totalSeconds across 3 visits: totalSeconds=3, napSeconds=2.
            const s2 = await saveSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, name: "receive-total-wait", yaml: TOTAL_WAIT_YAML, expected: null,
                actor: { kind: "session", sessionId: chat }, operationId: "save-total-wait",
            });
            expect(s2.receipt.valid, JSON.stringify(s2.receipt.diagnostics)).toBe(true);

            let capturedStart = null;
            const r2 = await startSessionWorkflowDefinition({
                ...h.host,
                duroxideClient: { ...h.client, startOrchestrationVersioned: async (...args) => { capturedStart = args; } },
            }, {
                ownerSessionId: chat, definition: { name: "receive-total-wait" }, inputs: { totalSeconds: 3, napSeconds: 2 },
                actor: ENGINE, operationId: "start-total-wait-3visits", owner: OWNER,
            });
            for (const seq of [1, 2, 3]) {
                await sendTypedWorkflowInput(h.host, {
                    workflowSessionId: r2.workflowId, senderSessionId: chat, runId: r2.runId,
                    contract: "Tick@1", payload: { seq }, operationId: `tick-${seq}`,
                });
            }
            await h.client.startOrchestrationVersioned(...capturedStart);
            const end2 = await h.waitRun(r2.runId);
            expect(end2.status).toBe("completed");
            expect(end2.terminalOutput).toEqual({ ticks: [1, 2] });
            const listenVisits = (await h.store.listNodeExecutions(r2.runId)).filter(n => n.nodeId === "listen");
            expect(listenVisits.map(v => ({ ordinal: v.ordinal, outcome: v.outcome }))).toEqual([
                { ordinal: 1, outcome: "received" },
                { ordinal: 2, outcome: "received" },
                { ordinal: 3, outcome: "elapsed" },
            ]);
            expect(listenVisits[2].completedAt.getTime() - listenVisits[2].enteredAt.getTime()).toBeLessThan(200);
            const tick3 = await h.q("SELECT consumed_by FROM SCHEMA.workflow_inbox WHERE run_id = $1 AND (payload::jsonb->>'seq') = '3'", [r2.runId]);
            expect(tick3[0].consumed_by).toBeNull();
            // E3: store-decided totalExpired -> elapsed emits workflow.state_completed just like inbox-claim.
            const events2 = await h.catalog.getSessionEvents(r2.workflowId);
            const elapsedEvt = events2.find(e => e.eventType === "workflow.state_completed"
                && e.data?.nodeExecutionId === listenVisits[2].nodeExecutionId);
            expect(elapsedEvt, "E3: store-decided elapsed must emit workflow.state_completed").toBeTruthy();
            expect(elapsedEvt.data).toMatchObject({ stateId: "listen", step: 3, outcome: "elapsed", resultKind: "business" });

            // 3. Remaining-time deadline on visit 2: totalSeconds=3, napSeconds=1, only 1 tick queued.
            let capturedStart3 = null;
            const r3 = await startSessionWorkflowDefinition({
                ...h.host,
                duroxideClient: { ...h.client, startOrchestrationVersioned: async (...args) => { capturedStart3 = args; } },
            }, {
                ownerSessionId: chat, definition: { name: "receive-total-wait" }, inputs: { totalSeconds: 3, napSeconds: 1 },
                actor: ENGINE, operationId: "start-total-wait-remaining", owner: OWNER,
            });
            await sendTypedWorkflowInput(h.host, {
                workflowSessionId: r3.workflowId, senderSessionId: chat, runId: r3.runId,
                contract: "Tick@1", payload: { seq: 1 }, operationId: "tick-rem-1",
            });
            await h.client.startOrchestrationVersioned(...capturedStart3);
            const end3 = await h.waitRun(r3.runId);
            expect(end3.status).toBe("completed");
            expect(end3.terminalOutput).toEqual({ ticks: [1] });
            const remVisits = (await h.store.listNodeExecutions(r3.runId)).filter(n => n.nodeId === "listen");
            expect(remVisits).toHaveLength(2);
            expect(remVisits[0].outcome).toBe("received");
            expect(remVisits[1].outcome).toBe("elapsed");
            const deltaFromFirstMs = remVisits[1].deadlineAt.getTime() - remVisits[0].enteredAt.getTime();
            expect(deltaFromFirstMs).toBeGreaterThanOrEqual(2950);
            expect(deltaFromFirstMs).toBeLessThanOrEqual(3050);

            // 4. E2: maxVisits: 1 whose input & carry mappings fail on visit 2 routes exhausted (NOT invalid_input) with incoming value as output.
            const e2CleanYaml = "apiVersion: pilotswarm.dev/v1\nkind: Workflow\nmetadata: { name: max-visits-bad-input, version: \"1.0.0\" }\ninitial: seed\nstates:\n  seed:\n    type: script\n    outcomes: [go]\n    source: \"await setResult('go', { okKey: 42 });\"\n    transition: { next: { go: work, failure: failed } }\n  work:\n    type: script\n    maxVisits: 1\n    input:\n      x: \"${input.okKey}\"\n    carry:\n      c: \"${input.okKey}\"\n    outcomes: [again]\n    source: \"await setResult('again', { noOkKeyHere: 99 });\"\n    transition:\n      next:\n        again: work\n        exhausted: done\n        failure: failed\n  done: { type: terminal, outcome: succeeded, output: \"${input}\" }\n  failed: { type: terminal, outcome: failed, output: \"${runtime.error}\" }\n";
            const sE2 = await saveSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, name: "max-visits-bad-input", yaml: e2CleanYaml, expected: null,
                actor: { kind: "session", sessionId: chat }, operationId: "save-e2",
            });
            expect(sE2.receipt.valid, JSON.stringify(sE2.receipt.diagnostics)).toBe(true);
            const rE2 = await startSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, definition: { name: "max-visits-bad-input" }, inputs: {},
                actor: ENGINE, operationId: "start-e2", owner: OWNER,
            });
            const endE2 = await h.waitRun(rE2.runId);
            expect(endE2.status).toBe("completed");
            expect(endE2.terminalOutput).toEqual({
                carry: null,
                result: { carry: { c: 42 }, result: { noOkKeyHere: 99 } },
            });

            // 5. E1/V2: wait.totalSeconds binding uses 5 s on visit 1 (via ?? 5) and bump sets nextBudget = 60 for visit 2.
            // Both live and test mode MUST elapse at visit 1's 5 s deadline (NOT 60 s), even when visit 1 finishes at entry!
            const e1Yaml = "apiVersion: pilotswarm.dev/v1\nkind: Workflow\nmetadata: { name: total-wait-fixed-v1, version: \"1.0.0\" }\ncontracts:\n  Tick@1: { schema: { type: object, properties: { seq: { type: integer } } } }\ninitial: listen\nstates:\n  listen:\n    type: messaging\n    mode: receive\n    contract: Tick@1\n    wait: { totalSeconds: \"${states.bump.output.nextBudget ?? 5}\" }\n    transition:\n      next:\n        received: bump\n        elapsed: done\n        failure: failed\n  bump:\n    type: script\n    outcomes: [again]\n    source: \"await setResult('again', { nextBudget: 60, saw: context.input.seq });\"\n    transition: { next: { again: listen, failure: failed } }\n  done: { type: terminal, outcome: succeeded, output: \"${states.bump.output}\" }\n  failed: { type: terminal, outcome: failed, output: \"${runtime.error}\" }\n";
            const sE1 = await saveSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, name: "total-wait-fixed-v1", yaml: e1Yaml, expected: null,
                actor: { kind: "session", sessionId: chat }, operationId: "save-e1",
            });
            expect(sE1.receipt.valid, JSON.stringify(sE1.receipt.diagnostics)).toBe(true);

            // Live mode: visit 1 pre-queued claim (finishes at entry with 5 s anchor), bump sets nextBudget = 60,
            // visit 2 elapses at visit 1's 5 s deadline (either pending until visit 1's deadlineAt, or immediate elapsed if already past).
            let capE1 = null;
            const rE1 = await startSessionWorkflowDefinition({
                ...h.host,
                duroxideClient: { ...h.client, startOrchestrationVersioned: async (...args) => { capE1 = args; } },
            }, {
                ownerSessionId: chat, definition: { name: "total-wait-fixed-v1" }, inputs: {},
                actor: ENGINE, operationId: "start-e1-live", owner: OWNER,
            });
            await sendTypedWorkflowInput(h.host, {
                workflowSessionId: rE1.workflowId, senderSessionId: chat, runId: rE1.runId,
                contract: "Tick@1", payload: { seq: 1 }, operationId: "e1-live-tick1",
            });
            await h.client.startOrchestrationVersioned(...capE1);
            const endE1 = await h.waitRun(rE1.runId);
            expect(endE1.status).toBe("completed");
            expect(endE1.terminalOutput).toEqual({ nextBudget: 60, saw: 1 });
            const e1Visits = (await h.store.listNodeExecutions(rE1.runId)).filter(n => n.nodeId === "listen");
            expect(e1Visits).toHaveLength(2);
            expect(e1Visits[0].deadlineAt).not.toBeNull();
            expect(e1Visits[1].outcome).toBe("elapsed");
            if (e1Visits[1].deadlineAt !== null) {
                expect(e1Visits[1].deadlineAt.getTime()).toBe(e1Visits[0].deadlineAt.getTime());
            } else {
                expect(e1Visits[1].enteredAt.getTime()).toBeGreaterThanOrEqual(e1Visits[0].deadlineAt.getTime());
            }

            // Test mode: visit 1 has fixture (finishes without waiting, 5 s anchor), bump sets nextBudget = 60,
            // visit 2 has no fixture and advances virtual clock ONLY to visit 1's virtual + 5 s (NOT +60 s).
            const tE1 = await startSessionWorkflowTest(h.host, {
                ownerSessionId: chat, definition: { definitionId: sE1.receipt.definitionId },
                inputs: {},
                fixtures: parseTestFixtures([{
                    operation: "receive", state: "listen", visit: 1,
                    response: { kind: "success", value: { seq: 1 } },
                }], { receive: true }),
                actor: ENGINE, operationId: "test-e1-virtual", owner: async () => OWNER, binding: async () => null,
            });
            const benchE1 = await definitionTestBench(h.host, chat, tE1.testId);
            const reportE1 = await waitSessionWorkflowTest(h.host, benchE1, { waitMs: 20_000, actor: ENGINE });
            expect(reportE1.status).toBe("passed");
            const tRunE1 = await h.store.readRun(reportE1.runId);
            const tVisitsE1 = (await h.store.listNodeExecutions(reportE1.runId)).filter(n => n.nodeId === "listen");
            expect(tVisitsE1).toHaveLength(2);
            expect(tVisitsE1[0].deadlineAt).not.toBeNull();
            expect(tVisitsE1[1].outcome).toBe("elapsed");
            expect(tVisitsE1[1].deadlineAt.getTime()).toBe(tVisitsE1[0].deadlineAt.getTime());
            expect(tRunE1.virtualNow.getTime() - tVisitsE1[0].deadlineAt.getTime()).toBe(0);

            // 6. V1: visit 1 has no budget -> invalid_input (no stored deadline) -> recovery script returns { budget } ->
            // visit 2 evaluates totalSeconds itself and stores the anchor deadline (live AND test mode).
            const v1Yaml = "apiVersion: pilotswarm.dev/v1\nkind: Workflow\nmetadata: { name: total-wait-recover-v1, version: \"1.0.0\" }\ncontracts:\n  Tick@1: { schema: { type: object, properties: { seq: { type: integer } } } }\ninitial: listen\ninitialInput: {}\nstates:\n  listen:\n    type: messaging\n    mode: receive\n    contract: Tick@1\n    wait: { totalSeconds: \"${input.budget}\" }\n    transition:\n      next:\n        received: done\n        elapsed: done\n        invalid_input: recover\n        failure: failed\n  recover:\n    type: script\n    outcomes: [retry]\n    source: \"await setResult('retry', { budget: context.inputs.recoveredBudget });\"\n    transition: { next: { retry: listen, failure: failed } }\n  done: { type: terminal, outcome: succeeded, output: \"${input}\" }\n  failed: { type: terminal, outcome: failed, output: \"${runtime.error}\" }\n";
            const sV1 = await saveSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, name: "total-wait-recover-v1", yaml: v1Yaml, expected: null,
                actor: { kind: "session", sessionId: chat }, operationId: "save-v1",
            });
            expect(sV1.receipt.valid, JSON.stringify(sV1.receipt.diagnostics)).toBe(true);

            // Live mode (recoveredBudget: 2s for fast test, verify visit 2 sets ~2s deadline and elapses cleanly).
            const rV1 = await startSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, definition: { name: "total-wait-recover-v1" }, inputs: { recoveredBudget: 2 },
                actor: ENGINE, operationId: "start-v1-live", owner: OWNER,
            });
            const endV1 = await h.waitRun(rV1.runId);
            expect(endV1.status).toBe("completed");
            expect(endV1.terminalOutput).toEqual({ budget: 2 });
            const v1LiveVisits = (await h.store.listNodeExecutions(rV1.runId)).filter(n => n.nodeId === "listen");
            expect(v1LiveVisits).toHaveLength(2);
            expect(v1LiveVisits[0].outcome).toBe("invalid_input");
            expect(v1LiveVisits[0].deadlineAt).toBeNull();
            expect(v1LiveVisits[1].outcome).toBe("elapsed");
            expect(v1LiveVisits[1].deadlineAt).not.toBeNull();
            const liveDeltaMs = v1LiveVisits[1].deadlineAt.getTime() - v1LiveVisits[1].enteredAt.getTime();
            expect(liveDeltaMs).toBeGreaterThanOrEqual(1950);
            expect(liveDeltaMs).toBeLessThanOrEqual(2050);

            // Test mode (recoveredBudget: 10s, virtual clock advances cleanly by 10s on visit 2).
            const tV1 = await startSessionWorkflowTest(h.host, {
                ownerSessionId: chat, definition: { definitionId: sV1.receipt.definitionId },
                inputs: { recoveredBudget: 10 },
                fixtures: [],
                actor: ENGINE, operationId: "test-v1-virtual", owner: async () => OWNER, binding: async () => null,
            });
            const benchV1 = await definitionTestBench(h.host, chat, tV1.testId);
            const reportV1 = await waitSessionWorkflowTest(h.host, benchV1, { waitMs: 20_000, actor: ENGINE });
            expect(reportV1.status).toBe("passed");
            const tRunV1 = await h.store.readRun(reportV1.runId);
            const v1TestVisits = (await h.store.listNodeExecutions(reportV1.runId)).filter(n => n.nodeId === "listen");
            expect(v1TestVisits).toHaveLength(2);
            expect(v1TestVisits[0].outcome).toBe("invalid_input");
            expect(v1TestVisits[0].deadlineAt).toBeNull();
            expect(v1TestVisits[1].outcome).toBe("elapsed");
            expect(v1TestVisits[1].deadlineAt).not.toBeNull();
            expect(tRunV1.virtualNow.getTime() - v1TestVisits[1].deadlineAt.getTime()).toBe(0);
            expect(v1TestVisits[1].deadlineAt.getTime() - tRunV1.createdAt.getTime()).toBeGreaterThanOrEqual(9900);
        } finally {
            await h.stop();
        }
    });
});
