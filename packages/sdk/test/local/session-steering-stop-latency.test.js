/**
 * Session steering: Stop's acknowledgement never waits on steering.
 * Real worker + real Copilot CLI + scripted model + PostgreSQL.
 *
 * The steer's immediate send() is issued to the real SDK, but its response is
 * withheld by a barrier (no sleeps), so the pump is mid-hand-off when Stop
 * arrives. Stop must be acknowledged as `stopped` within the bound; the
 * receipt then closes with the Stop labels once the barrier is released, and
 * the session stays usable.
 *
 * Run: npx vitest run test/local/session-steering-stop-latency.test.js
 */
import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { createManagementClient } from "../helpers/local-workers.js";
import { setClusterFeature, withScriptedModel } from "../helpers/scripted-workers.js";
import { messageText } from "../helpers/scripted-model.mjs";
import { decodeSteeringTarget, steeringContentHash } from "../../src/steering.ts";

const TIMEOUT = 240_000;
/** Acknowledgement bound with an in-flight steer (owner requirement; see the measurement report). */
const STOP_ACK_BOUND_MS = Number(process.env.STEER_STOP_ACK_BOUND_MS || 3_000);
/**
 * With both activity slots busy, Stop is reached through duroxide's cancellation of the busy
 * runTurn (about 6.4 s on 0.8.2 too, measured). A steer must add at most this much to an
 * unsteered Stop under the same contention.
 */
const CONTENTION_STEER_OVERHEAD_MS = Number(process.env.STEER_CONTENTION_OVERHEAD_MS || 1_500);
const getEnv = useSuiteEnv(import.meta.url);
const AUTHOR = { kind: "user", provider: "test", subject: "stop-author", display: "Author" };

async function waitFor(fn, ms, label) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
        await new Promise((r) => setTimeout(r, 25));
    }
}

async function ownSession(env, sessionId) {
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: env.store });
    await c.connect();
    try {
        await c.query(`SELECT "${env.cmsSchema}".cms_set_session_owner($1, $2, $3, $4, $5)`, [sessionId, "test", "stop-author", null, "Author"]);
    } finally {
        await c.end();
    }
}

function barrier() {
    let release;
    const promise = new Promise((r) => { release = r; });
    let enter;
    const entered = new Promise((r) => { enter = r; });
    return { promise, release, entered, enter };
}

describe("session steering Stop latency (real CLI)", () => {
    it("Stop is acknowledged within the bound while a steer's SDK send is still unanswered", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        await setClusterFeature(env, "sessions.steering", true, { allowUserOverride: false });
        const answer = barrier();
        const respond = async (body) => {
            const users = (body?.messages ?? []).filter((m) => m.role === "user").map(messageText);
            if (users.some((u) => u.includes("stop-latency-follow-up"))) return { content: "follow-up ok" };
            answer.enter();
            await answer.promise;                                         // the long answer stays in flight
            return { content: "late essay" };
        };
        await withScriptedModel(env, { respond }, async ({ client, worker, qualifiedModel }) => {
            const catalog = await createCatalog(env);
            const mgmt = await createManagementClient(env);
            const send = barrier();
            let managed;
            let originalSend;
            try {
                const session = await client.createSession({ model: qualifiedModel });
                await ownSession(env, session.sessionId);
                await session.send("stop-latency essay");
                await answer.entered;
                const state = await waitFor(async () => {
                    const s = await catalog.steerState(session.sessionId);
                    return s.steerable ? s : null;
                }, 60_000, "an open window");

                // Withhold the SDK's answer to the steer's immediate send (the RPC itself is issued).
                managed = worker.sessionManager.get(session.sessionId);
                assert(managed?.copilotSession, "the warm ManagedSession is reachable");
                originalSend = managed.copilotSession.send.bind(managed.copilotSession);
                managed.copilotSession.send = (opts) => {
                    const issued = originalSend(opts);
                    if (opts?.mode !== "immediate") return issued;
                    send.enter();
                    return send.promise.then(() => issued);
                };

                const t = decodeSteeringTarget(state.expectedTarget);
                const text = "please focus on the summary";
                const accepted = await catalog.steerAccept({
                    sessionId: session.sessionId, requestId: `steer_stop_${env.runId}`, idempotencyKey: `k-stop-${env.runId}`,
                    actor: AUTHOR, content: text, contentHash: steeringContentHash(text),
                    epoch: t.epoch, turnIndex: t.turnIndex, incarnation: t.incarnation,
                });
                assertEqual(accepted.outcome, "accepted");
                await send.entered;                                       // the pump is inside send()
                assertEqual((await catalog.steerGet(session.sessionId, accepted.receipt.requestId)).status, "submitting");

                const started = performance.now();
                const stop = await mgmt.stopSessionTurn(session.sessionId, { reason: "latency test" });
                const ackMs = Math.round(performance.now() - started);
                console.log(`  Stop ack with an in-flight steer: ${ackMs} ms → ${JSON.stringify(stop)}`);
                assertEqual(stop.outcome, "stopped", `Stop outcome (${stop.detail ?? ""})`);
                assert(ackMs <= STOP_ACK_BOUND_MS, `Stop acknowledged in ${ackMs} ms; bound ${STOP_ACK_BOUND_MS} ms`);

                // Afterwards: the SDK answers, the receipt closes with Stop labels, the session is usable.
                send.release();
                answer.release();
                const receipt = await waitFor(async () => {
                    const r = await catalog.steerGet(session.sessionId, accepted.receipt.requestId);
                    return r?.status === "closed" ? r : null;
                }, 60_000, "the Stop closure");
                assertEqual(receipt.closureReason, "stopped");
                assert(["delivery_unconfirmed", "delivered_before_stop"].includes(receipt.disposition),
                    `a handed-off steer is never "not delivered" after Stop (got ${receipt.disposition})`);
                await waitFor(async () => (await catalog.getSession(session.sessionId))?.state === "idle", 60_000, "idle");
                const next = await session.sendAndWait("stop-latency-follow-up", 120_000);
                assertEqual(next, "follow-up ok", "the session takes the next turn");
            } finally {
                send.release();
                answer.release();
                if (managed && originalSend) managed.copilotSession.send = originalSend;
                await mgmt.stop?.();
                await catalog.close();
            }
        });
    });
});

describe("session steering Stop under activity-slot contention (real CLI)", () => {
    it("with both worker slots busy, a queued steer adds nothing material to Stop (test-env 79d544be)", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        await setClusterFeature(env, "sessions.steering", true, { allowUserOverride: false });
        const held = new Map();
        const holdFor = (key) => {
            if (!held.has(key)) { const b = barrier(); held.set(key, b); }
            return held.get(key);
        };
        const respond = async (body) => {
            const users = (body?.messages ?? []).filter((m) => m.role === "user").map(messageText);
            if (users.some((u) => u.includes("contention-follow-up"))) return { content: "follow-up ok" };
            const key = (users.join(" ").match(/contention-(?:peer|essay|baseline)[a-z-]*/) ?? ["essay"])[0];
            const b = holdFor(key);
            b.enter();
            await b.promise;
            return { content: `${key} done` };
        };
        const previous = process.env.PILOTSWARM_WORKER_CONCURRENCY;
        process.env.PILOTSWARM_WORKER_CONCURRENCY = "2";
        try {
            await withScriptedModel(env, { respond }, async ({ client, qualifiedModel }) => {
                const catalog = await createCatalog(env);
                const mgmt = await createManagementClient(env);
                try {
                    // Baseline: an unsteered Stop under the same contention (one peer holds a slot).
                    const basePeer = await client.createSession({ model: qualifiedModel });
                    await basePeer.send("contention-peer-baseline");
                    await holdFor("contention-peer-baseline").entered;
                    const baseSession = await client.createSession({ model: qualifiedModel });
                    await baseSession.send("contention-baseline");
                    await holdFor("contention-baseline").entered;
                    await waitFor(async () => (await catalog.getSession(baseSession.sessionId))?.state === "running", 30_000, "baseline running");
                    const baseStarted = performance.now();
                    const baseStop = await mgmt.stopSessionTurn(baseSession.sessionId, { reason: "contention baseline" });
                    const baselineMs = Math.round(performance.now() - baseStarted);
                    console.log(`  Unsteered Stop with both slots busy: ${baselineMs} ms → ${JSON.stringify(baseStop)}`);
                    assertEqual(baseStop.outcome, "stopped");
                    holdFor("contention-baseline").release();
                    holdFor("contention-peer-baseline").release();
                    await waitFor(async () => (await catalog.getSession(basePeer.sessionId))?.state !== "running"
                        && (await catalog.getSession(baseSession.sessionId))?.state !== "running", 60_000, "baseline settled");

                    // A second session keeps one of the two activity slots busy.
                    const peer = await client.createSession({ model: qualifiedModel });
                    await peer.send("contention-peer");
                    await holdFor("contention-peer").entered;

                    const session = await client.createSession({ model: qualifiedModel });
                    await ownSession(env, session.sessionId);
                    await session.send("contention-essay");
                    await holdFor("contention-essay").entered;
                    const state = await waitFor(async () => {
                        const s = await catalog.steerState(session.sessionId);
                        return s.steerable ? s : null;
                    }, 60_000, "an open window");
                    const t = decodeSteeringTarget(state.expectedTarget);
                    const text = "focus on the keepers";
                    const accepted = await catalog.steerAccept({
                        sessionId: session.sessionId, requestId: `steer_contention_${env.runId}`, idempotencyKey: `k-contention-${env.runId}`,
                        actor: AUTHOR, content: text, contentHash: steeringContentHash(text),
                        epoch: t.epoch, turnIndex: t.turnIndex, incarnation: t.incarnation,
                    });
                    assertEqual(accepted.outcome, "accepted");
                    await waitFor(async () => (await catalog.steerGet(session.sessionId, accepted.receipt.requestId))?.status === "submitted",
                        30_000, "the steer queued in the CLI");

                    const started = performance.now();
                    const stop = await mgmt.stopSessionTurn(session.sessionId, { reason: "contention test" });
                    const ackMs = Math.round(performance.now() - started);
                    console.log(`  Stop ack with both slots busy and a queued steer: ${ackMs} ms → ${JSON.stringify(stop)}`);
                    assertEqual(stop.outcome, "stopped", `Stop outcome (${stop.detail ?? ""})`);
                    assert(ackMs <= baselineMs + CONTENTION_STEER_OVERHEAD_MS,
                        `steered Stop ${ackMs} ms vs unsteered ${baselineMs} ms; allowed overhead ${CONTENTION_STEER_OVERHEAD_MS} ms`);

                    const receipt = await waitFor(async () => {
                        const r = await catalog.steerGet(session.sessionId, accepted.receipt.requestId);
                        return r?.status === "closed" ? r : null;
                    }, 60_000, "the Stop closure");
                    assertEqual(receipt.closureReason, "stopped");
                    assert(["delivery_unconfirmed", "delivered_before_stop"].includes(receipt.disposition),
                        `honest Stop disposition (got ${receipt.disposition})`);
                    holdFor("contention-essay").release();
                    holdFor("contention-peer").release();
                    await waitFor(async () => (await catalog.getSession(session.sessionId))?.state === "idle", 60_000, "idle");
                    assertEqual(await session.sendAndWait("contention-follow-up", 120_000), "follow-up ok");
                } finally {
                    for (const b of held.values()) b.release();
                    await mgmt.stop?.();
                    await catalog.close();
                }
            });
        } finally {
            if (previous === undefined) delete process.env.PILOTSWARM_WORKER_CONCURRENCY;
            else process.env.PILOTSWARM_WORKER_CONCURRENCY = previous;
        }
    });
});
