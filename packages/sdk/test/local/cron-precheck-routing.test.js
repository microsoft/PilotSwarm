/**
 * runCronPrecheck carries the cron-precheck capability tag, so during a
 * rolling deploy an older worker (which lacks the activity) never takes it.
 *
 * Needs PostgreSQL: PS_TEST_DATABASE_URL.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createTestEnv } from "../helpers/local-env.js";
import { createSessionManagerProxy } from "../../src/session-proxy.ts";
import {
    AGENT_HANDOFF_CAPABILITY,
    CRON_PRECHECK_CAPABILITY,
    TURN_CONTROL_CAPABILITY,
    WORKSPACE_CAPABILITY,
} from "../../src/activity-routing.ts";

const { PostgresProvider, Runtime, Client } = createRequire(import.meta.url)("duroxide");

describe("cron precheck capability routing", () => {
    it("old workers cannot execute runCronPrecheck even when they register its name", async () => {
        const env = createTestEnv("cron_precheck_route");
        const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
        const client = new Client(provider);
        const executions = [];
        function* work(ctx) {
            const manager = createSessionManagerProxy(ctx, "turn-control-v1", { childResultProvenance: true });
            return yield manager.runCronPrecheck({ sessionId: "fixture", precheck: "queue", reason: "poll", intervalSeconds: 60, consecutiveSkips: 0 });
        }
        function worker(id, tags) {
            const runtime = new Runtime(provider, {
                workerNodeId: `${env.runId}-${id}`,
                workerConcurrency: 2,
                orchestrationConcurrency: 1,
                dispatcherPollIntervalMs: 20,
                workerLockTimeoutMs: 10_000,
                workerTagFilter: { defaultAnd: tags },
                logLevel: "error",
            });
            runtime.registerOrchestration("cron-precheck-routing", work);
            runtime.registerActivity("runCronPrecheck", async (ctx) => {
                executions.push({ worker: id, tag: ctx.tag() });
                return { skip: false, outcome: "unregistered", precheck: "queue" };
            });
            return runtime;
        }
        const old = worker("old", [AGENT_HANDOFF_CAPABILITY, WORKSPACE_CAPABILITY, TURN_CONTROL_CAPABILITY]);
        const current = worker("current", [AGENT_HANDOFF_CAPABILITY, WORKSPACE_CAPABILITY, TURN_CONTROL_CAPABILITY, CRON_PRECHECK_CAPABILITY]);
        try {
            await old.start();
            await client.startOrchestration("protected-precheck", "cron-precheck-routing", {});
            await new Promise(resolve => setTimeout(resolve, 2_000));
            expect(executions).toEqual([]);
            await current.start();
            const status = await client.waitForOrchestration("protected-precheck", 30_000);
            expect(status.status).toBe("Completed");
            expect(executions).toEqual([{ worker: "current", tag: CRON_PRECHECK_CAPABILITY }]);
        } finally {
            await current.shutdown(3_000);
            await old.shutdown(3_000);
            await env.cleanup();
        }
    });
});
