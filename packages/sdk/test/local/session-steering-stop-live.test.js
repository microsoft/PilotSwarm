/**
 * Session steering: Stop with an in-flight steer on a REAL model (owner Stop UX).
 * Real worker, real Copilot CLI, the configured default provider (the dev pool in
 * the dev workspace), PostgreSQL. Model-dependent: a missing provider fails the
 * preflight loudly; nothing is skipped.
 *
 * For each Stop delay (0, 600, 1,500 ms after the steer is accepted): a long
 * streaming answer is running, a steer is accepted, Stop is issued. Stop must be
 * acknowledged as `stopped` (not `stop_forced`) within the bound, and the
 * receipt must close with an honest Stop disposition.
 *
 * Run: npx vitest run test/local/session-steering-stop-live.test.js
 */
import { beforeAll, describe, it } from "vitest";
import { preflightChecks, useSuiteEnv } from "../helpers/local-env.js";
import { assert, assertEqual } from "../helpers/assertions.js";
import { createCatalog } from "../helpers/cms-helpers.js";
import { createManagementClient, withClient } from "../helpers/local-workers.js";
import { setClusterFeature } from "../helpers/scripted-workers.js";
import { decodeSteeringTarget, steeringContentHash } from "../../src/steering.ts";

const TIMEOUT = 600_000;
const STOP_ACK_BOUND_MS = Number(process.env.STEER_STOP_ACK_BOUND_MS || 3_000);
const DELAYS = [0, 600, 1_500];
const ATTEMPTS_PER_DELAY = 3;
const getEnv = useSuiteEnv(import.meta.url);
const AUTHOR = { kind: "user", provider: "test", subject: "live-stop-author", display: "Author" };
const HONEST = ["delivery_unconfirmed", "delivered_before_stop", "not_delivered_turn_stopped", "delivered_timing_unconfirmed"];

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

describe("session steering Stop on a real model", () => {
    beforeAll(async () => { await preflightChecks(); });

    it("Stop with an in-flight steer is acknowledged as stopped within the bound at 0, 600 and 1,500 ms", { timeout: TIMEOUT }, async () => {
        const env = await getEnv();
        await setClusterFeature(env, "sessions.steering", true, { allowUserOverride: false });
        await withClient(env, async (client) => {
            const catalog = await createCatalog(env);
            const mgmt = await createManagementClient(env);
            const { default: pg } = await import("pg");
            try {
                for (const delay of DELAYS) {
                    let measured = null;
                    for (let attempt = 0; attempt < ATTEMPTS_PER_DELAY && !measured; attempt++) {
                        const session = await client.createSession();
                        const c = new pg.Client({ connectionString: env.store });
                        await c.connect();
                        try {
                            await c.query(`SELECT "${env.cmsSchema}".cms_set_session_owner($1, $2, $3, $4, $5)`,
                                [session.sessionId, "test", "live-stop-author", null, "Author"]);
                        } finally {
                            await c.end();
                        }
                        await session.send(`Write a very long, detailed essay (at least 4000 words) about the history of lighthouses. Run ${delay}-${attempt}.`);
                        const state = await waitFor(async () => {
                            const s = await catalog.steerState(session.sessionId);
                            return s.steerable ? s : null;
                        }, 120_000, "a steerable real-model turn");
                        // Let the answer stream for a while; the model may still finish early.
                        await sleep(2_000);
                        const now = await catalog.steerState(session.sessionId);
                        if (!now.steerable || now.expectedTarget !== state.expectedTarget) {
                            console.log(`  delay ${delay}: attempt ${attempt} finished before the steer; retrying`);
                            continue;
                        }
                        const t = decodeSteeringTarget(now.expectedTarget);
                        const text = `Please make the essay focus on lighthouse keepers. (${delay}-${attempt})`;
                        const accepted = await catalog.steerAccept({
                            sessionId: session.sessionId, requestId: `steer_live_${delay}_${attempt}_${env.runId}`,
                            idempotencyKey: `k-live-${delay}-${attempt}`, actor: AUTHOR,
                            content: text, contentHash: steeringContentHash(text),
                            epoch: t.epoch, turnIndex: t.turnIndex, incarnation: t.incarnation,
                        });
                        if (accepted.outcome !== "accepted") {
                            console.log(`  delay ${delay}: attempt ${attempt} refused (${accepted.outcome}); retrying`);
                            continue;
                        }
                        if (delay) await sleep(delay);
                        const started = performance.now();
                        const stop = await mgmt.stopSessionTurn(session.sessionId, { reason: "live Stop test" });
                        const ackMs = Math.round(performance.now() - started);
                        const receipt = await waitFor(async () => {
                            const r = await catalog.steerGet(session.sessionId, accepted.receipt.requestId);
                            return r?.status === "closed" ? r : null;
                        }, 60_000, "the receipt to close");
                        measured = { ackMs, stop, receipt };
                        console.log(`  delay ${delay} ms: Stop ${ackMs} ms → ${stop.outcome}; receipt ${receipt.disposition}`);
                        await waitFor(async () => (await catalog.getSession(session.sessionId))?.state !== "running", 60_000, "not running");
                    }
                    assert(measured, `could not hold a steerable real-model turn for delay ${delay} ms in ${ATTEMPTS_PER_DELAY} attempts`);
                    assertEqual(measured.stop.outcome, "stopped", `delay ${delay}: Stop outcome (${measured.stop.detail ?? ""})`);
                    assert(measured.ackMs <= STOP_ACK_BOUND_MS, `delay ${delay}: Stop acknowledged in ${measured.ackMs} ms; bound ${STOP_ACK_BOUND_MS} ms`);
                    assertEqual(measured.receipt.closureReason, "stopped");
                    assert(HONEST.includes(measured.receipt.disposition), `delay ${delay}: honest Stop disposition (got ${measured.receipt.disposition})`);
                }
            } finally {
                await mgmt.stop?.();
                await catalog.close();
            }
        });
    });
});
