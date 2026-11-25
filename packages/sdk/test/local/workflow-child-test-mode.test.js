/**
 * Child Workflows test mode (T22, C10):
 * - A test run with a spawn state does NOT start a child Workflow session.
 * - A fixture answers the spawn held call with a handle, and a receive fixture supplies WorkflowEnded@1.
 * - The run reaches its expected terminal state cleanly.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { registerWorkflow } from "../../src/workflow/runtime.ts";
import { saveSessionWorkflowDefinition } from "../../src/workflow/session-definitions.ts";
import { startSessionWorkflowTest, waitSessionWorkflowTest } from "../../src/workflow/definition-test.ts";
import { parseTestFixtures } from "../../src/workflow/test-mode.ts";
import { WORKFLOW_REQUEST_CAPABILITY } from "../../src/activity-routing.ts";

const { Runtime, Client, PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 120_000;
const OWNER = { provider: "test", subject: "child-test-mode" };

const PARENT_YAML = `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: monitor-parent, version: "1.0.0" }
initial: launch_child
states:
  launch_child:
    type: spawn
    definition: child-worker
    inputs: { item: "alpha" }
    carry: { tag: "batch-1" }
    transition: { next: { started: wait_child, failure: failed } }
  wait_child:
    type: messaging
    mode: receive
    contract: WorkflowEnded@1
    carry: { spawnedId: "\${input.result.workflowId}", tag: "\${input.carry.tag}" }
    wait: { seconds: 60 }
    transition: { next: { received: done, elapsed: failed, failure: failed } }
  done:
    type: terminal
    outcome: succeeded
    output:
      tag: "\${input.carry.tag}"
      spawnedId: "\${input.carry.spawnedId}"
      childStatus: "\${input.result.status}"
      childResult: "\${input.result.output}"
  failed:
    type: terminal
    outcome: failed
`;

describe("Child Workflows test mode (T22)", () => {
    it("T22: spawn is a held call answered by fixture, no child session is created, and receive fixture supplies WorkflowEnded@1", { timeout: TIMEOUT }, async () => {
        const tag = randomUUID().slice(0, 8);
        const duroxideSchema = `duroxide_cwtm_${tag}`;
        const cmsSchema = `cms_cwtm_${tag}`;
        const env = getEnv();
        const provider = await PostgresProvider.connectWithSchema(env.store, duroxideSchema);
        const client = new Client(provider);
        const catalog = await PgSessionCatalog.create(env.store, cmsSchema);
        await catalog.initialize();
        const store = catalog.workflowStore();
        const pool = new pg.Pool({ connectionString: env.store });
        const runtime = new Runtime(provider, {
            orchestrationConcurrency: 4, workerConcurrency: 4, dispatcherPollIntervalMs: 20,
            workerTagFilter: { defaultAnd: [WORKFLOW_REQUEST_CAPABILITY] }, logLevel: "error",
        });
        const host = { catalog, store, duroxideClient: client, scripts: true, testMode: true };
        registerWorkflow(runtime, {
            store, catalog, enabled: () => true,
            resolveToolBinding: async () => null,
            openToolExecutor: async () => ({ call: async () => { throw new Error("unexpected"); }, close: async () => {} }),
            authorizeParentNotification: async () => true,
            notifyParent: async () => ({ delivered: true }),
            deleteSession: async (id) => { await catalog.softDeleteSession(id); },
            wakeBackstopMs: 200,
            spawnChildHost: () => host,
        });
        await runtime.start();
        try {
            const chat = randomUUID();
            await catalog.createSession(chat, { owner: OWNER });
            const saved = await saveSessionWorkflowDefinition(host, {
                ownerSessionId: chat, name: "monitor-parent", yaml: PARENT_YAML, expected: null,
                actor: { kind: "session", sessionId: chat }, operationId: "save-parent", by: "session",
            });
            expect(saved.receipt.valid, JSON.stringify(saved.receipt.diagnostics)).toBe(true);

            const fixtures = parseTestFixtures([
                {
                    operation: "spawn",
                    state: "launch_child",
                    response: {
                        kind: "success",
                        value: { workflowId: "mock-child-1", runId: "mock-run-1", definition: "child-worker", revision: 1 },
                    },
                },
                {
                    operation: "receive",
                    state: "wait_child",
                    response: {
                        kind: "success",
                        value: {
                            workflowId: "mock-child-1", definition: "child-worker", revision: 1,
                            spawnedBy: { stateId: "launch_child", visit: 1 },
                            status: "completed", outcome: "succeeded", stateId: "done",
                            output: { findings: 3 }, outputTruncated: false, error: null,
                        },
                    },
                },
            ], { receive: true });

            const bench = await startSessionWorkflowTest(host, {
                ownerSessionId: chat,
                definition: { definitionId: saved.receipt.definitionId },
                revision: 1,
                inputs: {},
                expect: "done",
                fixtures,
                actor: { kind: "session", sessionId: chat },
                operationId: "test-spawn-1",
                owner: async () => OWNER,
                binding: async () => null,
            });
            const report = await waitSessionWorkflowTest(host, bench, {
                callerSessionId: chat,
                fixtures,
                waitSeconds: 30,
                actor: { kind: "session", sessionId: chat },
            });
            expect(report.status, JSON.stringify(report)).toBe("passed");
            expect(report.run.terminalState).toBe("done");
            const children = await store.listChildWorkflows(report.testId);
            expect(children).toHaveLength(0);
            const run = await store.readRun(report.runId);
            expect(run?.terminalOutput).toEqual({
                tag: "batch-1",
                spawnedId: "mock-child-1",
                childStatus: "completed",
                childResult: { findings: 3 },
            });
        } finally {
            await runtime.shutdown();
            await catalog.close();
            await pool.query(`DROP SCHEMA IF EXISTS "${duroxideSchema}" CASCADE`);
            await pool.query(`DROP SCHEMA IF EXISTS "${cmsSchema}" CASCADE`);
            await pool.end();
        }
    });
});
