/**
 * Focused PG16 runtime tests for Change B: ${states.<id>.output}.
 * Covers: null before first visit, latest visit in a loop without carry,
 * parallel-branch isolation + root visibility, and value frozen at state entry.
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

const require = createRequire(import.meta.url);
const { PostgresProvider, Client, Runtime } = require("duroxide");
const TIMEOUT = 60_000;
const OWNER = { provider: "dev", subject: "state-bindings-user", email: "sb@example.com", displayName: "State Bindings" };
const ENGINE = { kind: "system", label: "state-bindings-test" };
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


const LOOP_AND_PARALLEL_YAML = "apiVersion: pilotswarm.dev/v1\nkind: Workflow\nmetadata:\n  name: state-bindings-loop-parallel\n  version: 0.1.0\ninitial: check_before_first\nstates:\n  check_before_first:\n    type: script\n    input:\n      beforeRaw: \"${states.loop_step.output}\"\n      beforeDefault: '${states.loop_step.output ?? \"none\"}'\n      beforeNested: \"${states.loop_step.output.items ?? []}\"\n    outcomes: [next]\n    source: |\n      if (\"states\" in context) throw new Error(\"context.states must not exist\");\n      await setResult(\"next\", {\n        beforeRaw: context.input.beforeRaw,\n        beforeDefault: context.input.beforeDefault,\n        beforeNested: context.input.beforeNested,\n        rootTag: \"from-root\",\n      });\n    transition: { next: { next: loop_step, failure: failed } }\n  loop_step:\n    type: script\n    input:\n      prev: \"${states.loop_step.output.items ?? []}\"\n      prevCount: \"${states.loop_step.output.count ?? 0}\"\n      rootTag: \"${states.check_before_first.output.rootTag}\"\n    outcomes: [again, go_parallel]\n    source: |\n      const count = context.input.prevCount + 1;\n      const items = [...context.input.prev, \"r\" + count];\n      await setResult(count < 3 ? \"again\" : \"go_parallel\", { count, items, seenRoot: context.input.rootTag });\n    transition:\n      next:\n        again: loop_step\n        go_parallel: fan\n        failure: failed\n  fan:\n    type: parallel\n    concurrency: 2\n    branches:\n      alpha:\n        initial: alpha_work\n        states:\n          alpha_work:\n            type: script\n            input:\n              rootCount: \"${states.loop_step.output.count}\"\n              rootTag: \"${states.check_before_first.output.rootTag}\"\n            outcomes: [ok]\n            source: |\n              await setResult(\"ok\", { who: \"alpha\", rootCount: context.input.rootCount, rootTag: context.input.rootTag });\n            transition: { next: { ok: alpha_check, failure: alpha_end } }\n          alpha_check:\n            type: script\n            input:\n              own: \"${states.alpha_work.output}\"\n              sibling: \"${states.beta_work.output}\"\n              rootItems: \"${states.loop_step.output.items}\"\n            outcomes: [done]\n            source: |\n              await setResult(\"done\", context.input);\n            transition: { next: { done: alpha_end, failure: alpha_end } }\n          alpha_end:\n            type: terminal\n            outcome: succeeded\n            output: \"${states.alpha_check.output}\"\n      beta:\n        initial: beta_work\n        states:\n          beta_work:\n            type: script\n            input:\n              rootCount: \"${states.loop_step.output.count}\"\n            outcomes: [ok]\n            source: |\n              await setResult(\"ok\", { who: \"beta\", rootCount: context.input.rootCount });\n            transition: { next: { ok: beta_check, failure: beta_end } }\n          beta_check:\n            type: script\n            input:\n              own: \"${states.beta_work.output}\"\n              sibling: \"${states.alpha_work.output}\"\n              rootTag: \"${states.check_before_first.output.rootTag}\"\n            outcomes: [done]\n            source: |\n              await setResult(\"done\", context.input);\n            transition: { next: { done: beta_end, failure: beta_end } }\n          beta_end:\n            type: terminal\n            outcome: succeeded\n            output: \"${states.beta_check.output}\"\n    transition: { next: { joined: done, blocked: failed, failure: failed } }\n  done:\n    type: terminal\n    outcome: succeeded\n    output:\n      before: \"${states.check_before_first.output}\"\n      latestLoop: \"${states.loop_step.output}\"\n      alphaBranchNotInRoot: \"${states.alpha_work.output}\"\n      joined: \"${states.fan.output}\"\n  failed:\n    type: terminal\n    outcome: failed\n    output: \"${runtime.error}\"\n";

describe("State output bindings (Change B: states.<id>.output)", () => {
    it("resolves null before first visit, tracks latest in a loop frozen per visit, and isolates parallel branches", { timeout: TIMEOUT }, async () => {
        const h = await startHarness(getEnv());
        try {
            const chat = randomUUID();
            await h.catalog.createSession(chat, { owner: OWNER });
            const saved = await saveSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, name: "state-bindings-loop-parallel", yaml: LOOP_AND_PARALLEL_YAML, expected: null,
                actor: { kind: "session", sessionId: chat }, operationId: "save-state-bindings",
            });
            expect(saved.receipt.valid, JSON.stringify(saved.receipt.diagnostics)).toBe(true);

            const started = await startSessionWorkflowDefinition(h.host, {
                ownerSessionId: chat, definition: { name: "state-bindings-loop-parallel" }, inputs: {},
                actor: ENGINE, operationId: "start-state-bindings", owner: OWNER,
            });
            const ended = await h.waitRun(started.runId);
            expect(ended.status).toBe("completed");
            expect(ended.terminalOutput).toEqual({
                before: { beforeRaw: null, beforeDefault: "none", beforeNested: [], rootTag: "from-root" },
                latestLoop: { count: 3, items: ["r1", "r2", "r3"], seenRoot: "from-root" },
                alphaBranchNotInRoot: null,
                joined: {
                    alpha: { own: { who: "alpha", rootCount: 3, rootTag: "from-root" }, sibling: null, rootItems: ["r1", "r2", "r3"] },
                    beta: { own: { who: "beta", rootCount: 3 }, sibling: null, rootTag: "from-root" },
                },
            });

            // Verify each loop visit froze its own entry input (never mutated by later visits).
            const execs = (await h.store.listNodeExecutions(started.runId)).filter(n => n.nodeId === "loop_step");
            expect(execs.map(e => ({ ordinal: e.ordinal, input: e.input, output: e.output }))).toEqual([
                { ordinal: 1, input: { prev: [], prevCount: 0, rootTag: "from-root" }, output: { count: 1, items: ["r1"], seenRoot: "from-root" } },
                { ordinal: 2, input: { prev: ["r1"], prevCount: 1, rootTag: "from-root" }, output: { count: 2, items: ["r1", "r2"], seenRoot: "from-root" } },
                { ordinal: 3, input: { prev: ["r1", "r2"], prevCount: 2, rootTag: "from-root" }, output: { count: 3, items: ["r1", "r2", "r3"], seenRoot: "from-root" } },
            ]);
        } finally {
            await h.stop();
        }
    });
});
