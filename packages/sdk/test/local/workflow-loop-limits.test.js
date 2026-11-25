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
                exhaustedOutput: { n: 3, tag: "passed-in" },
                lastRan: { n: 3, tag: "passed-in" },
            });
            const visits1 = (await h.store.listNodeExecutions(r1.runId)).filter(n => n.nodeId === "work");
            expect(visits1.map(v => ({ ordinal: v.ordinal, outcome: v.outcome, attempts: v.effectAttempts, output: v.output }))).toEqual([
                { ordinal: 1, outcome: "again", attempts: 1, output: { n: 1, ran: true } },
                { ordinal: 2, outcome: "again", attempts: 1, output: { n: 2, ran: true } },
                { ordinal: 3, outcome: "again", attempts: 1, output: { n: 3, ran: true } },
                { ordinal: 4, outcome: "exhausted", attempts: 0, output: { n: 3, tag: "passed-in" } },
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
        } finally {
            await h.stop();
        }
    });
});
