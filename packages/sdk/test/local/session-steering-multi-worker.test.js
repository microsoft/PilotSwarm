import { describe, it } from "vitest";
import { createTestEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { PilotSwarmClient } from "../helpers/local-workers.js";
import { forkKillWorker, expectFaultDeath, killStoreDir } from "../helpers/kill-harness.js";
import { startScriptedModel } from "../helpers/scripted-model.mjs";
import { registerScriptedProvider, setClusterFeature } from "../helpers/scripted-workers.js";
import { FilesystemSessionStore } from "../../src/session-store.ts";
import { within } from "../helpers/steering-cli.mjs";
import { messageText } from "../helpers/scripted-model.mjs";
import { createCatalog } from "../helpers/cms-helpers.js";
import { assignSteeringTestOwner, STEER_AUTHOR } from "../helpers/steering-ledger.js";
import { decodeSteeringTarget, steeringContentHash } from "../../src/steering.ts";

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

    for (const cut of ["before-cas", "after-cas"]) {
        it(`ST-M01/ST-C07/ST-C08: real ${cut} death accounts for steering and saved inclusion`, { timeout: TIMEOUT }, async () => {
            const env = createTestEnv(`steering-${cut}`);
            const entered = Promise.withResolvers();
            const release = Promise.withResolvers();
            const guidance = `recoverable-guidance-${cut}`;
            const model = await startScriptedModel({
                respond: async (body) => {
                    const messages = body.messages ?? [];
                    const faultTurn = messages.some((message) => message.role === "user" && messageText(message).includes("literal steering fault turn"));
                    if (!faultTurn) return { content: "saved baseline" };
                    const toolDone = messages.some((message) => message.role === "tool" && messageText(message).includes("steer-fault-tool-result"));
                    if (!toolDone) {
                        entered.resolve();
                        await release.promise;
                        return { tools: [{ name: "bash", args: { command: "echo steer-fault-tool-result", description: "Synthetic fault boundary" } }] };
                    }
                    return { content: "steered fault reply" };
                },
            });
            const workers = [];
            let client;
            let unsubscribe;
            let catalog;
            try {
                const modelProvidersPath = await registerScriptedProvider(env, model.baseUrl);
                await setClusterFeature(env, "sessions.steering", true, { allowUserOverride: false });
                catalog = await createCatalog(env);
                client = new PilotSwarmClient({
                    store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema,
                    modelProvidersPath,
                });
                const first = forkKillWorker(env, `steering-${cut}-a`, {
                    modelProvidersPath, faultInject: `turn.commit.${cut}:exit:2`,
                });
                workers.push(first);
                await first.ready;
                await client.start();
                const session = await client.createSession();
                await assignSteeringTestOwner(env, session.sessionId);
                assertEqual(await session.sendAndWait("baseline before literal steering", 60_000), "saved baseline");
                const store = new FilesystemSessionStore(killStoreDir(env), env.sessionStateDir);
                assertEqual((await store.probeSnapshot(session.sessionId)).version, 1);
                const opened = Promise.withResolvers();
                const handed = Promise.withResolvers();
                let requestId;
                unsubscribe = session.on((event) => {
                    if (event.eventType === "session.steering_window_changed" && event.data?.state === "open") opened.resolve();
                    if (event.eventType === "session.steering_updated" && event.data?.requestId === requestId
                        && ["submitted", "delivered"].includes(event.data?.projection?.status)) handed.resolve();
                });
                await session.send("literal steering fault turn");
                await within(entered.promise, "held real model request", 30_000);
                await within(opened.promise, "fault-turn steering window", 30_000);
                const target = decodeSteeringTarget((await catalog.steerState(session.sessionId)).expectedTarget);
                const accepted = await catalog.steerAccept({
                    sessionId: session.sessionId, requestId: `steer-${env.runId}`, idempotencyKey: `caller-${env.runId}`,
                    actor: STEER_AUTHOR, content: guidance, contentHash: steeringContentHash(guidance), ...target,
                });
                assertEqual(accepted.outcome, "accepted");
                requestId = accepted.receipt.requestId;
                const now = await catalog.steerGet(session.sessionId, requestId);
                if (!["submitted", "delivered"].includes(now.status)) await within(handed.promise, "real immediate handoff", 30_000);
                release.resolve();
                await within(expectFaultDeath(first, cut), `literal ${cut} exit`, 60_000);
                const beforeRecovery = await catalog.steerGet(session.sessionId, requestId);
                assertEqual(beforeRecovery.attempts.total, 1);
                assertEqual(beforeRecovery.attempts.items[0].outcome, "delivered", "fault happened after real correlated delivery");
                assertEqual(beforeRecovery.inclusion.state, "unconfirmed", "CAS alone without ledger finalize is not stamped inclusion");
                const requestsAtDeath = model.sessionRequests().length;
                assertEqual((await store.probeSnapshot(session.sessionId)).version, cut === "after-cas" ? 2 : 1);
                const second = forkKillWorker(env, `steering-${cut}-b`, { modelProvidersPath });
                workers.push(second);
                await second.ready;
                assertEqual(await session.wait(120_000), "steered fault reply");
                const receipt = await catalog.steerGet(session.sessionId, requestId);
                assertEqual(receipt.status, "closed");
                assertEqual(receipt.inclusion.state, "included");
                assertEqual((await store.probeSnapshot(session.sessionId)).version, 2, "one saved winner");
                if (cut === "after-cas") {
                    assertEqual(receipt.attempts.total, 1, "included winner is never rerun");
                    assertEqual(model.sessionRequests().length, requestsAtDeath);
                } else {
                    assertEqual(receipt.attempts.total, 2, "missing saved input is delivered again under legitimate recovery");
                    assert(receipt.recoveryFlags.includes("delivered_again"), "redelivery is visible");
                    assert(model.sessionRequests().length > requestsAtDeath, "the missing-memory turn reran");
                }
                assert(model.sessionRequests().some((request) => request.body.messages.some((message) =>
                    message.role === "user" && messageText(message).includes(guidance))), "actual model requests contain separate guidance");
                assertEqual(await session.sendAndWait("convergence after literal steering", 60_000), "steered fault reply");
                assertEqual((await store.probeSnapshot(session.sessionId)).version, 3);
                console.log(`  ${cut}: ${receipt.attempts.total} delivered attempt(s), saved winner v2, converged v3`);
            } finally {
                release.resolve();
                unsubscribe?.();
                await client?.stop();
                for (const worker of workers) await worker.stop();
                await catalog?.close();
                await model.close();
                await env.cleanup();
            }
        });
    }
});
