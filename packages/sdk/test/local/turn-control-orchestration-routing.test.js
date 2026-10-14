import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createTestEnv } from "../helpers/local-env.js";
import { createSessionProxy } from "../../src/session-proxy.ts";
import { AGENT_HANDOFF_CAPABILITY, WORKSPACE_CAPABILITY, TURN_CONTROL_CAPABILITY } from "../../src/activity-routing.ts";

const { PostgresProvider, Runtime, Client } = createRequire(import.meta.url)("duroxide");

describe("turn-control capability routing", () => {
    it("old workers cannot execute V4 even when they register its names", async () => {
        const env = createTestEnv("turn_control_route");
        const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
        const client = new Client(provider);
        const executions = [];
        function* work(ctx) {
            const proxy = createSessionProxy(ctx, "fixture", `affinity-${ctx.instanceId}`, {}, "turn-control-v1");
            return yield ctx.all([
                proxy.runTurn("ordinary", false, 1),
                proxy.runTurn("epoch", true, 0, { epochStart: true }),
            ]);
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
            runtime.registerOrchestration("v4-routing", work);
            runtime.registerOrchestration("probe", function* (ctx) {
                return yield ctx.scheduleActivity("legacyProbe", {});
            });
            for (const name of ["runTurnV4", "runTurnEpochV4", "legacyProbe"]) {
                runtime.registerActivity(name, async (ctx) => {
                    executions.push({ worker: id, name, tag: ctx.tag() });
                    return { type: "completed", content: name };
                });
            }
            return runtime;
        }
        const old = worker("old", [AGENT_HANDOFF_CAPABILITY, WORKSPACE_CAPABILITY]);
        const current = worker("current", [AGENT_HANDOFF_CAPABILITY, WORKSPACE_CAPABILITY, TURN_CONTROL_CAPABILITY]);
        try {
            await old.start();
            await client.startOrchestration("protected-v4", "v4-routing", {});
            await client.startOrchestration("old-probe", "probe", {});
            expect((await client.waitForOrchestration("old-probe", 15_000)).status).toBe("Completed");
            expect(executions).toEqual([{ worker: "old", name: "legacyProbe", tag: null }]);
            await current.start();
            expect((await client.waitForOrchestration("protected-v4", 30_000)).status).toBe("Completed");
            expect(executions.filter(e => e.name !== "legacyProbe")).toEqual(expect.arrayContaining([
                { worker: "current", name: "runTurnV4", tag: TURN_CONTROL_CAPABILITY },
                { worker: "current", name: "runTurnEpochV4", tag: TURN_CONTROL_CAPABILITY },
            ]));
            expect(executions.filter(e => e.name !== "legacyProbe")).toHaveLength(2);
        } finally {
            await current.shutdown(3_000);
            await old.shutdown(3_000);
            await env.cleanup();
        }
    });
});
