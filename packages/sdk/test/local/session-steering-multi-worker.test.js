import { describe, it } from "vitest";
import { createTestEnv } from "../helpers/local-env.js";
import { assertEqual } from "../helpers/assertions.js";
import { PilotSwarmClient } from "../helpers/local-workers.js";
import { forkKillWorker, expectFaultDeath, killStoreDir } from "../helpers/kill-harness.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";
import { registerScriptedProvider } from "../helpers/scripted-workers.js";
import { FilesystemSessionStore } from "../../src/session-store.ts";
import { within } from "../helpers/steering-cli.mjs";

const TIMEOUT = 240_000;

describe.concurrent("session steering literal worker recovery prerequisites", () => {
    it("ST-M01/ST-C08 prerequisite: post-CAS worker death adopts the actual stored winner without another model call", { timeout: TIMEOUT }, async () => {
        const env = createTestEnv("steering-kill");
        const model = await startScriptedModel({
            respond: (_body, position) => ({ content: `scripted turn ${position.turn}` }),
        });
        const workers = [];
        let client;
        try {
            const modelProvidersPath = await registerScriptedProvider(env, model.baseUrl);
            client = new PilotSwarmClient({
                store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema,
                modelProvidersPath,
            });
            const first = forkKillWorker(env, "steering-cas-a", {
                modelProvidersPath, faultInject: "turn.commit.after-cas:exit:2",
            });
            workers.push(first);
            await first.ready;
            await client.start();
            const session = await client.createSession();
            const store = new FilesystemSessionStore(killStoreDir(env), env.sessionStateDir);
            assertEqual(await session.sendAndWait("synthetic baseline", 60_000), "scripted turn 1");
            assertEqual((await store.probeSnapshot(session.sessionId)).version, 1);
            await session.send("synthetic committed turn");
            await within(expectFaultDeath(first, "post-CAS steering prerequisite"), "exact post-CAS process death", 60_000);
            const requestsAtDeath = model.sessionRequests().length;
            const second = forkKillWorker(env, "steering-cas-b", { modelProvidersPath });
            workers.push(second);
            await second.ready;
            assertEqual(await session.wait(120_000), "scripted turn 2");
            assertEqual((await store.probeSnapshot(session.sessionId)).version, 2, "actual same-key winner is adopted, not recommitted");
            assertEqual(model.sessionRequests().length, requestsAtDeath, "already-committed recovery makes no model call");
            assertEqual(await session.sendAndWait("synthetic convergence turn", 60_000), "scripted turn 3");
            assertEqual((await store.probeSnapshot(session.sessionId)).version, 3);
            console.log("  literal exit 137: stored winner adopted; no duplicate model execution; next turn converged");
        } finally {
            await client?.stop();
            for (const worker of workers) await worker.stop();
            await model.close();
            await env.cleanup();
        }
    });
});
