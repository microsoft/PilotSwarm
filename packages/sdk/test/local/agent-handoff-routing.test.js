/** Real Duroxide/Postgres routing and replay; no provider credentials or LLM calls. */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { createTestEnv } from "../helpers/local-env.js";
import { createSessionManagerProxy, createSessionProxy } from "../../src/session-proxy.ts";
import { AGENT_HANDOFF_CAPABILITY, HANDOFF_ACTIVITY_NAMES } from "../../src/activity-routing.ts";
import { handleSubAgentAction as frozenSpawn } from "../../src/orchestration_1_0_74/agents.ts";
const { PostgresProvider, Runtime, Client } = createRequire(import.meta.url)("duroxide");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await sleep(25);
    }
    throw new Error("Timed out waiting for durable routing progress");
}

// An activity callback runs before its completion is acknowledged. Replacing a
// worker at that point races shutdown against the commit and tests cancellation
// rather than replay of completed work. Wait for the persisted wait boundary.
async function untilParked(client, instanceId) {
    await until(async () => {
        let info;
        try { info = await client.getInstanceInfo(instanceId); }
        catch (error) {
            // startOrchestration enqueues work; the first dispatcher turn
            // creates the durable instance record asynchronously.
            if (error.message.includes("Instance not found")) return false;
            throw error;
        }
        const history = await client.readExecutionHistory(instanceId, info.currentExecutionId);
        return history.some(event => event.kind === "ExternalSubscribed");
    });
}

async function withStore(body) {
    const env = createTestEnv("handoff_routing");
    const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
    const client = new Client(provider);
    const runtimes = [];
    const events = [];
    function worker(id, capable, orchestrationName, generator, customActivities = []) {
        const runtime = new Runtime(provider, {
            orchestrationConcurrency: 1,
            workerConcurrency: capable ? 2 : 8,
            dispatcherPollIntervalMs: capable ? 20 : 1,
            workerLockTimeoutMs: 1_000,
            // Match the production idle retention; takeover depends on the
            // separate ~30-second ownership lease, not this one-hour value.
            sessionIdleTimeoutMs: 3_600_000,
            workerNodeId: `${env.runId}-${id}`,
            logLevel: "error",
            ...(capable ? { workerTagFilter: { defaultAnd: [AGENT_HANDOFF_CAPABILITY] } } : {}),
        });
        runtime.registerOrchestration(orchestrationName, generator);
        // Deliberately give the old worker every activity name as a trap. A
        // name is NOT a routing guard; only the provider's tag filter is.
        for (const name of new Set([...Object.keys(HANDOFF_ACTIVITY_NAMES), ...Object.values(HANDOFF_ACTIVITY_NAMES), "legacyProbe"])) {
            if (customActivities.includes(name)) continue;
            runtime.registerActivity(name, async (ctx, input) => {
                events.push({ worker: id, name, tag: ctx.tag(), sessionId: ctx.sessionId, input });
                return { worker: id, name };
            });
        }
        runtimes.push(runtime);
        return runtime;
    }
    try {
        await body({ provider, client, worker, events });
    } finally {
        for (const runtime of runtimes.reverse()) {
            try { await runtime.shutdown(3_000); } catch {}
        }
        await env.cleanup();
    }
}

function* routedHandoff(ctx) {
    const manager = createSessionManagerProxy(ctx, "agent-handoff-v2", { childResultProvenance: true });
    const session = createSessionProxy(ctx, "child", `affinity-${ctx.instanceId}`, {}, "agent-handoff-v2");
    const results = yield ctx.all([
        manager.resolveAgentConfig("analyst"),
        manager.resolveAgentForRequiredTool("lookup"),
        manager.spawnChildSession("parent", { boundAgentName: "analyst", boundAgentPackageId: "pkg" }, "work"),
        session.runTurn("work"),
        session.runTurn("new epoch", true, 0, { epochStart: true }),
        manager.getSessionStatus("child"),
        manager.listChildSessions("parent"),
    ]);
    return results;
}

// These exercise production proxy descriptors through the native SDK and
// PostgreSQL's dequeue filters, not a simulated scheduler.
describe("agent handoff capability routing", () => {
    it("keeps protected work pending with no capable worker, even while old workers poll", async () => {
        await withStore(async ({ client, worker, events }) => {
            const old = worker("old", false, "handoff", routedHandoff);
            old.registerOrchestration("probe", function* (ctx) { return yield ctx.scheduleActivity("legacyProbe", {}); });
            await old.start();
            await client.startOrchestration("protected", "handoff", {});
            await client.startOrchestration("probe", "probe", {});
            await client.waitForOrchestration("probe", 10_000);
            expect(events.some(e => e.worker === "old" && e.name === "legacyProbe")).toBe(true);
            await sleep(400);
            expect((await client.getStatus("protected")).status).toBe("Running");
            expect(events.filter(e => e.name !== "legacyProbe")).toEqual([]);

            const upgraded = worker("upgraded", true, "handoff", routedHandoff);
            await upgraded.start();
            const result = await client.waitForOrchestration("protected", 10_000);
            expect(result.status).toBe("Completed");
            const protectedEvents = events.filter(e => e.name !== "legacyProbe");
            expect(protectedEvents).toHaveLength(7);
            expect(protectedEvents.every(e => e.worker === "upgraded" && e.tag === AGENT_HANDOFF_CAPABILITY)).toBe(true);
        });
    });

    it("routes concurrent protected handoffs only to upgraded workers in a mixed pool", async () => {
        await withStore(async ({ client, worker, events }) => {
            await worker("old", false, "handoff", routedHandoff).start();
            await worker("upgraded", true, "handoff", routedHandoff).start();
            await Promise.all(Array.from({ length: 8 }, (_, i) => client.startOrchestration(`mixed-${i}`, "handoff", {})));
            const results = await Promise.all(Array.from({ length: 8 }, (_, i) => client.waitForOrchestration(`mixed-${i}`, 20_000)));
            expect(results.every(r => r.status === "Completed")).toBe(true);
            expect(events).toHaveLength(56);
            expect(events.every(e => e.worker === "upgraded" && e.tag === AGENT_HANDOFF_CAPABILITY)).toBe(true);
        });
    });

    it("resumes tagged work after the old affinity owner shuts down and its lease expires", async () => {
        await withStore(async ({ client, worker, events }) => {
            function* migrate(ctx) {
                yield createSessionProxy(ctx, "child", "fixed-affinity", {}).runTurn("before");
                yield ctx.waitForEvent("continue");
                return yield createSessionProxy(ctx, "child", "fixed-affinity", {}, "agent-handoff-v2").runTurn("after");
            }
            const old = worker("old", false, "migrate", migrate);
            await old.start();
            await client.startOrchestration("migration", "migrate", {});
            await untilParked(client, "migration");
            expect(events).toHaveLength(1);
            await old.shutdown(3_000);
            await worker("upgraded", true, "migrate", migrate).start();
            await client.raiseEvent("migration", "continue", {});
            const result = await client.waitForOrchestration("migration", 45_000);
            expect(result.status).toBe("Completed");
            expect(events.map(e => [e.worker, e.name, e.sessionId])).toEqual([
                ["old", "runTurn", "fixed-affinity"],
                ["upgraded", "runTurnV3", "fixed-affinity"],
            ]);
        });
    });

    it("replays a frozen named-child handoff after worker replacement without spawning twice", async () => {
        await withStore(async ({ client, worker }) => {
            const recorded = [];
            function* frozenHandoff(ctx) {
                const runtime = {
                    ctx, input: { sessionId: "parent" }, options: { nestingLevel: 0 },
                    state: { config: { toolNames: ["parent_tool"] }, subAgents: [], pendingPrompt: undefined },
                    manager: createSessionManagerProxy(ctx),
                };
                yield* frozenSpawn(runtime, { type: "spawn_agent", agentName: "analyst", task: "inspect" });
                yield ctx.waitForEvent("continue");
                return runtime.state.subAgents;
            }
            function install(runtime, label) {
                runtime.registerActivity("resolveAgentConfig", async (_ctx, input) => {
                    recorded.push([label, "resolve", input.agentName]);
                    return { name: "analyst", id: "analyst", tools: ["lookup"], initialRequiredTool: "lookup", packageId: "pkg-shared" };
                });
                runtime.registerActivity("spawnChildSession", async (_ctx, input) => {
                    recorded.push([label, "spawn", input.config.boundAgentPackageId]);
                    expect(input.requiredTool).toBe("lookup");
                    return "child-from-history";
                });
                runtime.registerActivity("recordSessionEvent", async () => null);
            }
            const first = worker("first", false, "frozen-handoff", frozenHandoff, ["resolveAgentConfig", "spawnChildSession"]);
            install(first, "first");
            await first.start();
            await client.startOrchestration("frozen", "frozen-handoff", {});
            await untilParked(client, "frozen");
            expect(recorded).toHaveLength(2);
            await first.shutdown(3_000);
            const upgraded = worker("upgraded", true, "frozen-handoff", frozenHandoff, ["resolveAgentConfig", "spawnChildSession"]);
            install(upgraded, "upgraded");
            await upgraded.start();
            await client.raiseEvent("frozen", "continue", {});
            // Replacement waits for the same ~30-second ownership lease as the
            // migration case above; a 10-second deadline races valid takeover.
            const result = await client.waitForOrchestration("frozen", 45_000);
            expect(result.status).toBe("Completed");
            expect(result.output[0].sessionId).toBe("child-from-history");
            expect(recorded).toEqual([["first", "resolve", "analyst"], ["first", "spawn", "pkg-shared"]]);
        });
    });
});
