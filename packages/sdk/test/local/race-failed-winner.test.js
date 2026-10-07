/**
 * A failed runTurn that wins the race against the stop queue.
 *
 * Every registered orchestration version races runTurn against the turn's
 * stop queue, then turns an error value into `throw new Error(message)`
 * inside the same try (see normalizeRacedTurnValue in orchestration/turn.ts).
 * duroxide-node before 0.2.0 returned a failed winner's error text as the
 * race value; 0.2.0+ throws the activity's own error from the race. Either
 * way, the orchestration must reach the same catch with the same message, so
 * running instances replay the same steps across the upgrade.
 *
 * Uses an in-memory duroxide runtime. No database, worker or LLM required.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { normalizeRacedTurnValue } from "../../src/orchestration/turn.js";

const { Runtime, Client, SqliteProvider } = createRequire(import.meta.url)("duroxide");

async function runOrchestration(name, register) {
    const provider = await SqliteProvider.inMemory();
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 10, logLevel: "error" });
    register(runtime);
    await runtime.start();
    try {
        const client = new Client(provider);
        const instanceId = `${name}-${Date.now().toString(36)}`;
        await client.startOrchestration(instanceId, name, null);
        return await client.waitForOrchestration(instanceId, 20_000);
    } finally {
        await runtime.shutdown(100);
    }
}

describe("a failed runTurn that wins the stop race", () => {
    it("reaches the catch with the same message as yielding the activity alone", async () => {
        const result = await runOrchestration("RacedFailedTurn", (rt) => {
            rt.registerActivity("runTurn", async () => {
                throw new Error("live Copilot connection closed unexpectedly");
            });
            rt.registerActivity("afterCatch", async (_ctx, input) => `handled: ${input}`);
            rt.registerOrchestration("RacedFailedTurn", function* (ctx) {
                let direct;
                try {
                    yield ctx.scheduleActivity("runTurn", { prompt: "direct" });
                } catch (err) {
                    direct = err.message;
                }

                // The same shape as the turn loop in orchestration/turn.ts.
                let raced;
                let path;
                try {
                    const turnTask = ctx.scheduleActivity("runTurn", { prompt: "raced" });
                    const stopTask = ctx.dequeueEvent("stop-turn-1");
                    const race = yield ctx.race(turnTask, stopTask);
                    if (race.index === 1) {
                        path = "stopped";
                    } else {
                        const value = normalizeRacedTurnValue(race.value);
                        if (value.kind === "error") throw new Error(value.message);
                        path = "result";
                    }
                } catch (err) {
                    path = "catch";
                    raced = err.message;
                }

                // The catch path goes on to schedule more durable work.
                const after = yield ctx.scheduleActivity("afterCatch", path);
                return { direct, raced, path, after };
            });
        });

        expect(result.status).toBe("Completed");
        const { direct, raced, path, after } = result.output;
        expect(path).toBe("catch");
        expect(direct).toMatch(/live Copilot connection closed unexpectedly/);
        expect(raced).toBe(direct);
        expect(after).toBe("handled: catch");
    });

    it("still returns a successful runTurn result as the race value", async () => {
        const result = await runOrchestration("RacedOkTurn", (rt) => {
            rt.registerActivity("runTurn", async () => ({ type: "completed", content: "done" }));
            rt.registerOrchestration("RacedOkTurn", function* (ctx) {
                const race = yield ctx.race(ctx.scheduleActivity("runTurn", {}), ctx.dequeueEvent("stop-turn-1"));
                const value = normalizeRacedTurnValue(race.value);
                return { index: race.index, value };
            });
        });

        expect(result.status).toBe("Completed");
        expect(result.output.index).toBe(0);
        expect(result.output.value).toEqual({ kind: "result", result: { type: "completed", content: "done" } });
    });
});
