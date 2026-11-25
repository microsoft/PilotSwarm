import { parseTestFixtures } from "../../dist/workflow/test-mode.js";
/**
 * Multi-contract receive tests on real Duroxide Runtime + PostgreSQL 16 (and HorizonDB):
 * - Store: entry claims earliest accepted of two listed contracts; arriving listed contract completes pending receive
 *   with outcome = contract and output = { contract, from, payload }; unlisted contract stays unclaimed; elapsed works.
 * - Runtime: child sends two Progress@1 messages and completes -> parent takes all three through one receive state;
 *   child fails early after step 1 -> parent sees WorkflowEnded@1 immediately without waiting for timeout.
 * - Test mode: fixture gives { contract, payload } for listed contract; unlisted contract is refused.
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

const require = createRequire(import.meta.url);
const { PostgresProvider, Client, Runtime } = require("duroxide");
const TIMEOUT = 60_000;
const OWNER = { provider: "dev", subject: "multi-recv-user", email: "m@example.com", displayName: "Multi Recv" };
const ENGINE = { kind: "system", label: "multi-recv-test" };
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

const MULTI_DIRECT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: multi-direct, version: "1.0.0" }
contracts:
  Alpha@1: { schema: { type: object, required: [n], properties: { n: { type: integer } } } }
  Beta@1: { schema: { type: object, required: [tag], properties: { tag: { type: string } } } }
  Other@1: { schema: { type: object, required: [x], properties: { x: { type: integer } } } }
initial: wait_ab
states:
  wait_ab:
    type: messaging
    mode: receive
    contract: [Alpha@1, Beta@1]
    wait: { seconds: 1 }
    transition:
      next:
        Alpha@1: got_a
        Beta@1: got_b
        elapsed: got_elapsed
        failure: failed
  never_reached:
    type: messaging
    mode: receive
    contract: Other@1
    transition: { next: { received: got_elapsed } }
  got_a: { type: terminal, outcome: succeeded, output: { route: "Alpha@1", val: "\${input}" } }
  got_b: { type: terminal, outcome: succeeded, output: { route: "Beta@1", val: "\${input}" } }
  got_elapsed: { type: terminal, outcome: succeeded, output: { route: "elapsed" } }
  failed: { type: terminal, outcome: failed, output: "\${runtime.error}" }
`;

const PROGRESS_CHILD_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: progress-child, version: "1.0.0" }
inputs:
  schema:
    type: object
    required: [failEarly]
    properties: { failEarly: { type: boolean } }
contracts:
  Progress@1:
    schema: { type: object, required: [step], properties: { step: { type: integer } } }
initial: send_1
states:
  send_1:
    type: messaging
    mode: send
    contract: Progress@1
    recipient: { parent: true }
    input: { step: 1 }
    transition: { next: { sent: branch_check, failure: failed } }
  branch_check:
    type: script
    outcomes: [continue_work]
    source: |
      if (context.inputs.failEarly) throw new Error("early boom");
      await setResult("continue_work", {});
    transition: { next: { continue_work: send_2 } }
  send_2:
    type: messaging
    mode: send
    contract: Progress@1
    recipient: { parent: true }
    input: { step: 2 }
    transition: { next: { sent: done, failure: failed } }
  done: { type: terminal, outcome: succeeded, output: { ok: true } }
  failed: { type: terminal, outcome: failed, output: "\${runtime.error}" }
`;

const PARENT_ONE_RECV_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: parent-one-recv, version: "1.0.0" }
inputs:
  schema:
    type: object
    required: [failEarly]
    properties: { failEarly: { type: boolean } }
contracts:
  Progress@1:
    schema: { type: object, required: [step], properties: { step: { type: integer } } }
initial: spawn_c
states:
  spawn_c:
    type: spawn
    definition: progress-child
    inputs: { failEarly: "\${inputs.failEarly}" }
    transition: { next: { started: init_state, failure: failed } }
  init_state:
    type: script
    outcomes: [go]
    source: |
      await setResult("go", { childId: context.input.workflowId, steps: [] });
    transition: { next: { go: wait_any, failure: failed } }
  wait_any:
    type: messaging
    mode: receive
    contract: [Progress@1, WorkflowEnded@1]
    from: "\${input.childId}"
    wait: { seconds: 30 }
    carry: { childId: "\${input.childId}", steps: "\${input.steps}" }
    transition:
      next:
        Progress@1: record_step
        WorkflowEnded@1: done
        elapsed: failed
        failure: failed
  record_step:
    type: script
    outcomes: [loop]
    source: |
      const { carry, result } = context.input;
      await setResult("loop", {
        childId: carry.childId,
        steps: [...carry.steps, { contract: result.contract, from: result.from, step: result.payload.step }],
      });
    transition: { next: { loop: wait_any, failure: failed } }
  done:
    type: terminal
    outcome: succeeded
    output:
      steps: "\${input.carry.steps}"
      endedContract: "\${input.result.contract}"
      endedFrom: "\${input.result.from}"
      endedStatus: "\${input.result.payload.status}"
      endedOutput: "\${input.result.payload.output}"
  failed: { type: terminal, outcome: failed, output: "\${runtime.error}" }
`;

describe("Multi-contract receive (Change A)", () => {
    it("store, runtime, and test-mode cover earliest-of-two, pending arrival, unlisted ignored, elapsed, child progress+end, early failure, and fixtures", { timeout: TIMEOUT }, async () => {
        const h = await startHarness(getEnv());
        try {
            const chat = randomUUID();
            await h.catalog.createSession(chat, { owner: OWNER });
            const saved = {};
            for (const [name, yaml] of [
                ["multi-direct", MULTI_DIRECT_YAML],
                ["progress-child", PROGRESS_CHILD_YAML],
                ["parent-one-recv", PARENT_ONE_RECV_YAML],
            ]) {
                const s = await saveSessionWorkflowDefinition(h.host, {
                    ownerSessionId: chat, name, yaml, expected: null,
                    actor: { kind: "session", sessionId: chat }, operationId: `save-${name}`, by: "session",
                });
                expect(s.receipt.valid, JSON.stringify(s.receipt.diagnostics)).toBe(true);
                saved[name] = s.receipt;
            }

            // 1. Arriving unlisted contract stays unclaimed; arriving listed contract completes pending receive with { contract, from, payload }.
            const r1 = await startSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, definition: { name: "multi-direct" }, inputs: {},
                actor: ENGINE, operationId: "start-pending-arrival", owner: OWNER,
            });
            // X2: wait until wait_ab is pending BEFORE sending so we truly exercise the pending-arrival path.
            let pendingWait = null;
            for (let i = 0; i < 100 && !pendingWait; i += 1) {
                const nodes = await h.store.listNodeExecutions(r1.runId);
                pendingWait = nodes.find(n => n.nodeId === "wait_ab" && n.state === "pending") ?? null;
                if (!pendingWait) await new Promise(r => setTimeout(r, 50));
            }
            expect(pendingWait, "wait_ab must be pending before messages arrive").toBeTruthy();

            // Send unlisted Other@1 first -> must NOT claim wait_ab
            const otherReceipt = await sendTypedWorkflowInput(h.host, {
                workflowSessionId: r1.workflowId, senderSessionId: chat, runId: r1.runId,
                contract: "Other@1", payload: { x: 1 }, operationId: "op-other-1",
            });
            expect(otherReceipt.receipt.claimedBy).toBeNull();

            // Send listed Beta@1 -> receipt claims pending wait_ab execution directly
            const betaReceipt = await sendTypedWorkflowInput(h.host, {
                workflowSessionId: r1.workflowId, senderSessionId: chat, runId: r1.runId,
                contract: "Beta@1", payload: { tag: "hello" }, operationId: "op-beta-1",
            });
            expect(betaReceipt.receipt.claimedBy?.nodeExecutionId).toBe(pendingWait.nodeExecutionId);
            const end1 = await h.waitRun(r1.runId);
            expect(end1.status).toBe("completed");
            expect(end1.terminalOutput).toEqual({
                route: "Beta@1",
                val: { contract: "Beta@1", from: chat, payload: { tag: "hello" } },
            });
            // Unlisted Other@1 row stayed unconsumed in inbox
            const otherRows = await h.q("SELECT consumed_by FROM SCHEMA.workflow_inbox WHERE run_id = $1 AND contract = 'Other@1'", [r1.runId]);
            expect(otherRows).toHaveLength(1);
            expect(otherRows[0].consumed_by).toBeNull();

            // 2. Entry takes earliest of two contracts already in inbox (Beta@1 before Alpha@1 -> picks Beta@1).
            let capturedStart = null;
            const r2 = await startSessionWorkflowDefinition({
                ...h.host,
                duroxideClient: {
                    ...h.client,
                    startOrchestrationVersioned: async (...args) => { capturedStart = args; },
                },
            }, {
                ownerSessionId: chat, definition: { name: "multi-direct" }, inputs: {},
                actor: ENGINE, operationId: "start-prequeued", owner: OWNER,
            });
            await sendTypedWorkflowInput(h.host, {
                workflowSessionId: r2.workflowId, senderSessionId: chat, runId: r2.runId,
                contract: "Beta@1", payload: { tag: "first-in" }, operationId: "op-pre-beta",
            });
            await sendTypedWorkflowInput(h.host, {
                workflowSessionId: r2.workflowId, senderSessionId: chat, runId: r2.runId,
                contract: "Alpha@1", payload: { n: 2 }, operationId: "op-pre-alpha",
            });
            // Now dispatch controller so wait_ab enters with both already in inbox
            await h.client.startOrchestrationVersioned(...capturedStart);
            const end2 = await h.waitRun(r2.runId);
            expect(end2.terminalOutput).toEqual({
                route: "Beta@1",
                val: { contract: "Beta@1", from: chat, payload: { tag: "first-in" } },
            });

            // 3. Elapsed still works on multi-contract receive with wait.
            const r3 = await startSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, definition: { name: "multi-direct" }, inputs: {},
                actor: ENGINE, operationId: "start-elapsed", owner: OWNER,
            });
            const end3 = await h.waitRun(r3.runId);
            expect(end3.terminalOutput).toEqual({ route: "elapsed" });

            // 4. Real run: child sends 2 Progress@1 messages then ends -> parent takes all 3 through ONE receive state.
            const r4 = await startSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, definition: { name: "parent-one-recv" }, inputs: { failEarly: false },
                actor: ENGINE, operationId: "start-parent-ok", owner: OWNER,
            });
            const end4 = await h.waitRun(r4.runId);
            expect(end4.status).toBe("completed");
            expect(end4.terminalOutput.steps.map(s => s.step)).toEqual([1, 2]);
            expect(end4.terminalOutput.endedContract).toBe("WorkflowEnded@1");
            expect(end4.terminalOutput.endedStatus).toBe("completed");
            expect(end4.terminalOutput.endedOutput).toEqual({ ok: true });

            // 5. Real run: child fails early after step 1 -> parent immediately takes WorkflowEnded@1 (status failed), no 30s wait.
            const t0 = Date.now();
            const r5 = await startSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, definition: { name: "parent-one-recv" }, inputs: { failEarly: true },
                actor: ENGINE, operationId: "start-parent-fail-early", owner: OWNER,
            });
            const end5 = await h.waitRun(r5.runId);
            expect(Date.now() - t0).toBeLessThan(15_000);
            expect(end5.status).toBe("completed");
            expect(end5.terminalOutput.steps.map(s => s.step)).toEqual([1]);
            expect(end5.terminalOutput.endedContract).toBe("WorkflowEnded@1");
            expect(end5.terminalOutput.endedStatus).toBe("failed");

            // 6. Test mode fixture: { contract, payload } delivers listed contract; unlisted contract fails the test cleanly.
            const started = await startSessionWorkflowTest(h.host, {
                ownerSessionId: chat, definition: { definitionId: saved["multi-direct"].definitionId },
                inputs: {},
                fixtures: parseTestFixtures([{
                    operation: "receive", state: "wait_ab",
                    response: { kind: "success", value: { contract: "Alpha@1", payload: { n: 99 } } },
                }], { receive: true }),
                actor: ENGINE, operationId: "test-multi-ok", owner: async () => OWNER, binding: async () => null,
            });
            const bench = await definitionTestBench(h.host, chat, started.testId);
            const report = await waitSessionWorkflowTest(h.host, bench, { waitMs: 20_000, actor: ENGINE });
            expect(report.status).toBe("passed");
            expect(report.run.status).toBe("completed");
            const testRun = await h.store.readRun(report.runId);
            expect(testRun.terminalOutput).toEqual({
                route: "Alpha@1",
                val: { contract: "Alpha@1", from: chat, payload: { n: 99 } },
            });

            const startedBad = await startSessionWorkflowTest(h.host, {
                ownerSessionId: chat, definition: { definitionId: saved["multi-direct"].definitionId },
                inputs: {},
                fixtures: parseTestFixtures([{
                    operation: "receive", state: "wait_ab",
                    response: { kind: "success", value: { contract: "Other@1", payload: { x: 1 } } },
                }], { receive: true }),
                actor: ENGINE, operationId: "test-multi-bad", owner: async () => OWNER, binding: async () => null,
            });
            const benchBad = await definitionTestBench(h.host, chat, startedBad.testId);
            const reportBad = await waitSessionWorkflowTest(h.host, benchBad, { waitMs: 20_000, actor: ENGINE });
            expect(reportBad.status).toBe("failed");
            expect(JSON.stringify(reportBad)).toContain("Other@1");
        } finally {
            await h.stop();
        }
    });
});
