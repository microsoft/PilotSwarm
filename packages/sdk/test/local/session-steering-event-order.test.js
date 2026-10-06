/**
 * Session steering: persisted event order follows SDK emission order on the
 * real queued-delivery path (real Copilot CLI, scripted model, PostgreSQL).
 *
 * A steer handed off while a no-tool answer is in flight is delivered by the
 * CLI as `queued`: after that answer, in the same run (Spike S-1 E). The
 * steer's user.message (data.steering) must get a higher session_events.seq
 * than the assistant.message it followed, and a lower one than the follow-up
 * run's assistant.turn_start. Browser UX-02 saw the reverse on a deployed
 * build (two writers racing).
 *
 * Storage contention is reproduced deterministically: the worker's generic
 * event writes of assistant.message are delayed at the catalog boundary, as a
 * busy pool delays them in production. Without one ordered writer the steer's
 * projection then commits first.
 *
 * Run: npx vitest run test/local/session-steering-event-order.test.js
 */
import { describe, it } from "vitest";
import { useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { setClusterFeature, withScriptedModel } from "../helpers/scripted-workers.js";
import { messageText } from "../helpers/scripted-model.mjs";
import { decodeSteeringTarget, steeringContentHash } from "../../src/steering.ts";

const TIMEOUT = 240_000;
const RUNS = 3;
const getEnv = useSuiteEnv(import.meta.url);
const AUTHOR = { kind: "user", provider: "test", subject: "order-author", display: "Author" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, label) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
        await sleep(50);
    }
}

async function ownSession(env, sessionId) {
    const { default: pg } = await import("pg");
    const c = new pg.Client({ connectionString: env.store });
    await c.connect();
    try {
        await c.query(`SELECT "${env.cmsSchema}".cms_set_session_owner($1, $2, $3, $4, $5)`, [sessionId, "test", "order-author", null, "Author"]);
    } finally {
        await c.end();
    }
}

describe("session steering event order (real CLI, queued delivery)", () => {
    it("a queued steer's user.message is persisted after the response it followed", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        await setClusterFeature(env, "sessions.steering", true, { allowUserOverride: false });

        // Held answers: the test releases each turn's first (no-tool) answer once its steer is handed off.
        const holds = new Map();
        const holdFor = (label) => {
            if (!holds.has(label)) {
                let release;
                const gate = new Promise((r) => { release = r; });
                holds.set(label, { gate, release, entered: false });
            }
            return holds.get(label);
        };
        const respond = async (body) => {
            const messages = body?.messages ?? [];
            const first = messageText(messages.find((m) => m.role === "user") ?? {});
            const label = (/order-run-\d+/.exec(first) ?? [])[0];
            const steered = messages.some((m) => m.role === "user" && messageText(m).includes("[STEERING from"));
            if (steered) return { content: `follow-up:${label}` };
            const h = holdFor(label);
            h.entered = true;
            await Promise.race([h.gate, sleep(120_000)]);
            return { content: `answer:${label}` };
        };

        await withScriptedModel(env, { respond }, async ({ client, worker, qualifiedModel }) => {
            const catalog = await createCatalog(env);
            const workerCatalog = worker._catalog;
            assert(workerCatalog && typeof workerCatalog.recordEvents === "function", "the worker has a CMS catalog");
            const originalRecordEvents = workerCatalog.recordEvents;
            let delayedWrites = 0;
            workerCatalog.recordEvents = async function (sessionId, events, nodeId) {
                if (Array.isArray(events) && events.some((e) => e?.eventType === "assistant.message")) {
                    delayedWrites++;
                    await sleep(400);
                }
                return originalRecordEvents.call(this, sessionId, events, nodeId);
            };
            try {
                for (let run = 0; run < RUNS; run++) {
                    const label = `order-run-${run}`;
                    const session = await client.createSession({ model: qualifiedModel });
                    await ownSession(env, session.sessionId);
                    await session.send(label);
                    const h = holdFor(label);
                    await waitFor(() => h.entered, 60_000, "the in-flight answer");
                    const state = await waitFor(async () => {
                        const s = await catalog.steerState(session.sessionId);
                        return s.steerable ? s : null;
                    }, 60_000, "an open window");
                    const t = decodeSteeringTarget(state.expectedTarget);
                    const text = `steer for ${label}`;
                    const accepted = await catalog.steerAccept({
                        sessionId: session.sessionId, requestId: `steer_${label}_${env.runId}`, idempotencyKey: `k-${label}`,
                        actor: AUTHOR, content: text, contentHash: steeringContentHash(text),
                        epoch: t.epoch, turnIndex: t.turnIndex, incarnation: t.incarnation,
                    });
                    assertEqual(accepted.outcome, "accepted");
                    const requestId = accepted.receipt.requestId;
                    await waitFor(async () => (await catalog.steerGet(session.sessionId, requestId))?.status === "submitted",
                        30_000, "the hand-off");
                    h.release();

                    const receipt = await waitFor(async () => {
                        const r = await catalog.steerGet(session.sessionId, requestId);
                        return r?.status === "closed" ? r : null;
                    }, 60_000, "finalize");
                    assertEqual(receipt.attempts.items[0].deliveryKind, "queued", "the real CLI delivered the steer as queued");
                    assertEqual(receipt.disposition, "delivered_after_response");

                    const events = await catalog.getSessionEvents(session.sessionId, undefined, 1000);
                    const steerMsg = events.find((e) => e.eventType === "user.message" && e.data?.steering?.requestId === requestId);
                    assert(steerMsg, "the steering user.message projection exists");
                    const answer = events.find((e) => e.eventType === "assistant.message"
                        && String(e.data?.content ?? "").includes(`answer:${label}`));
                    assert(answer, "the earlier response was persisted");
                    assert(steerMsg.seq > answer.seq,
                        `run ${run}: queued steer user.message seq ${steerMsg.seq} must follow the response it followed (seq ${answer.seq})`);
                    const followTurn = events.find((e) => e.eventType === "assistant.turn_start" && e.seq > answer.seq);
                    if (followTurn) {
                        assert(steerMsg.seq < followTurn.seq,
                            `run ${run}: steer user.message seq ${steerMsg.seq} must precede the follow-up run's turn_start (seq ${followTurn.seq})`);
                    }
                    const followUp = events.find((e) => e.eventType === "assistant.message"
                        && String(e.data?.content ?? "").includes(`follow-up:${label}`));
                    assert(followUp && followUp.seq > steerMsg.seq, `run ${run}: the follow-up answer follows the steer`);
                }
                assert(delayedWrites >= RUNS, "the latency injection reached the worker's event writer");
            } finally {
                workerCatalog.recordEvents = originalRecordEvents;
                for (const h of holds.values()) h.release();
                await catalog.close();
            }
        });
    });
});
