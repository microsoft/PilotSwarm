import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assert, assertEqual } from "../helpers/assertions.js";
import { deliveredManifest, withSteeringLedger } from "../helpers/steering-ledger.js";

const TIMEOUT = 120_000;

async function handoff(h, cut) {
    await h.open();
    const accepted = await h.accept();
    if (cut === "accepted") return { accepted };
    await h.proc("cms_steer_claim", [h.sessionId, h.target.owner, 1]);
    if (cut === "claimed") return { accepted };
    const attemptId = await h.submitting(accepted.requestId);
    if (cut === "submitting") return { accepted, attemptId };
    const sdkMessageId = "sdk-fault-cut";
    await h.proc("cms_steer_mark_submitted", [attemptId, h.target.owner, sdkMessageId]);
    if (cut === "submitted") return { accepted, attemptId, sdkMessageId };
    await h.proc("cms_steer_mark_delivered", [attemptId, sdkMessageId, "steering"]);
    return { accepted, attemptId, sdkMessageId };
}

describe.concurrent("session steering causal ledger cuts", () => {
    it("ST-C01: acceptance response loss recovers one original identity", { timeout: TIMEOUT }, async () => {
        await withSteeringLedger(async (h) => {
            await h.open();
            const original = await h.accept();
            // Drop the response, not the transaction: reconcile using the caller's original key.
            const recovered = await h.accept({ idempotencyKey: original.idempotencyKey });
            assertEqual(recovered.result.requestId, original.requestId);
            assertEqual((await h.requests()).length, 1);
            const events = await h.catalog.getSessionEvents(h.sessionId);
            assertEqual(events.filter((event) => event.eventType === "session.steering_accepted").length, 1);
        });
    });

    for (const cut of ["accepted", "claimed", "submitting", "submitted", "delivered"]) {
        for (const stopping of [false, true]) {
            it(`ST-C02/ST-C06: ${cut} cut closes honestly on ${stopping ? "Stop" : "turn end"}`, { timeout: TIMEOUT }, async () => {
                await withSteeringLedger(async (h) => {
                    const { accepted } = await handoff(h, cut);
                    const before = await h.attempts(accepted.requestId);
                    if (stopping) await h.proc("cms_steer_close_stopped", [h.sessionId, h.target.turn]);
                    else await h.finalize();
                    const row = await h.request(accepted.requestId);
                    const expected = cut === "delivered"
                        ? stopping ? "delivered_before_stop" : "delivered_current_turn"
                        : ["submitting", "submitted"].includes(cut)
                            ? "delivery_unconfirmed"
                            : stopping ? "not_delivered_turn_stopped" : "not_delivered_turn_ended";
                    assertEqual(row.status, "closed");
                    assertEqual(row.disposition, expected);
                    expect(await h.attempts(accepted.requestId)).toEqual(before);
                    await h.open({ owner: randomUUID() });
                    assertEqual((await h.request(accepted.requestId)).status, "closed", "terminal target never revives");
                    console.log(`  ${cut}: ${row.disposition}, ${before.length} immutable attempt(s)`);
                });
            });
        }
    }

    it("ST-C03: abandoned startup writes a tombstone before a late window-open", { timeout: TIMEOUT }, async () => {
        await withSteeringLedger(async (h) => {
            await h.proc("cms_steer_window_abandon", [h.sessionId, h.target.epoch, h.target.turn, h.target.incarnation, h.target.owner]);
            await h.open();
            assertEqual((await h.accept()).result.outcome, "no_active_turn");
            const { rows } = await h.query(`SELECT * FROM ${h.schema}.session_steering_windows WHERE session_id=$1`, [h.sessionId]);
            assertEqual(rows.length, 1);
            assertEqual(rows[0].state, "closed");
            assertEqual(rows[0].closed_reason, "abandoned");
        });
    });

    it("ST-C05: failed projection transaction leaves neither half of delivery committed", { timeout: TIMEOUT }, async () => {
        await withSteeringLedger(async (h) => {
            const { accepted, attemptId, sdkMessageId } = await handoff(h, "submitted");
            await h.query(`CREATE FUNCTION ${h.schema}.reject_steer_projection() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    IF NEW.event_type='user.message' AND NEW.data ? 'steering' THEN
                        RAISE EXCEPTION 'fixture: steering projection unavailable';
                    END IF;
                    RETURN NEW;
                END $$`);
            await h.query(`CREATE TRIGGER reject_steer_projection BEFORE INSERT ON ${h.schema}.session_events
                FOR EACH ROW EXECUTE FUNCTION ${h.schema}.reject_steer_projection()`);
            await expect(h.proc("cms_steer_mark_delivered", [attemptId, sdkMessageId, "steering"])).rejects.toThrow("fixture: steering projection unavailable");
            const [attempt] = await h.attempts(accepted.requestId);
            assertEqual(attempt.delivered_at, null, "projection failure rolls back delivery evidence");
            assertEqual((await h.request(accepted.requestId)).status, "submitted");
            await h.query(`DROP TRIGGER reject_steer_projection ON ${h.schema}.session_events`);
            // This is receipt repair with positive evidence, not a second SDK invocation.
            await h.proc("cms_steer_mark_delivered", [attemptId, sdkMessageId, "steering"]);
            assertEqual((await h.request(accepted.requestId)).disposition, "delivered_current_turn");
        });
    });

    it("ST-C06/ST-C10: a late positive receipt corrects Stop history without reopening input", { timeout: TIMEOUT }, async () => {
        await withSteeringLedger(async (h) => {
            const { accepted, attemptId, sdkMessageId } = await handoff(h, "submitted");
            await h.proc("cms_steer_close_stopped", [h.sessionId, h.target.turn]);
            const closed = await h.request(accepted.requestId);
            assertEqual(closed.disposition, "delivery_unconfirmed");
            await h.proc("cms_steer_mark_delivered", [attemptId, sdkMessageId, "steering"]);
            const repaired = await h.request(accepted.requestId);
            assertEqual(repaired.status, "closed");
            assertEqual(repaired.disposition, "delivered_before_stop");
            assert(repaired.revision > closed.revision, "historical correction increments revision");
            await h.open({ owner: randomUUID() });
            assertEqual((await h.proc("cms_steer_claim", [h.sessionId, h.target.owner, 5])).length, 0);
        });
    });

    it("ST-C06: delayed old-target Stop cannot close a newer window", { timeout: TIMEOUT }, async () => {
        await withSteeringLedger(async (h) => {
            await h.open();
            await h.finalize();
            const next = { turn: 2, incarnation: "snapshot-turn-2", owner: randomUUID() };
            await h.open(next);
            const accepted = await h.accept(next);
            await h.proc("cms_steer_close_stopped", [h.sessionId, h.target.turn]);
            assertEqual((await h.request(accepted.requestId)).status, "pending");
            await h.proc("cms_steer_claim", [h.sessionId, next.owner, 1]);
            assertEqual((await h.request(accepted.requestId)).status, "claimed");
        });
    });

    for (const recovery of ["present", "absent", "failed"]) {
        it(`ST-C07: delivered-but-uncommitted recovery is ${recovery}`, { timeout: TIMEOUT }, async () => {
            await withSteeringLedger(async (h) => {
                const { accepted } = await handoff(h, "delivered");
                await h.proc("cms_steer_window_quiesce", [h.sessionId, h.target.owner]);
                const history = await h.attempts(accepted.requestId);
                const owner = randomUUID();
                await h.open({ owner });
                assertEqual((await h.request(accepted.requestId)).status, "orphaned");
                assertEqual((await h.proc("cms_steer_claim", [h.sessionId, owner, 5])).length, 0, "SDK id requires a complete restored-history check");
                await h.proc("cms_steer_record_recovery_check", [accepted.requestId, owner, recovery]);
                await h.proc("cms_steer_claim", [h.sessionId, owner, 5]);
                const row = await h.request(accepted.requestId);
                if (recovery === "present") assertEqual(row.included, "included");
                else if (recovery === "absent") assertEqual(row.status, "claimed");
                else assertEqual(row.status, "orphaned", "failed read does not authorize resend");
                expect(await h.attempts(accepted.requestId)).toEqual(history);
            });
        });
    }

    it("ST-C08: committed recovery adopts authority without reopening admission", { timeout: TIMEOUT }, async () => {
        await withSteeringLedger(async (h) => {
            const { accepted, attemptId, sdkMessageId } = await handoff(h, "delivered");
            await h.proc("cms_steer_window_quiesce", [h.sessionId, h.target.owner]);
            const owner = randomUUID();
            assertEqual(await h.proc("cms_steer_window_adopt", [h.sessionId, h.target.epoch, h.target.turn, h.target.incarnation, owner]), true);
            assertEqual(await h.proc("cms_steer_window_renew", [h.sessionId, h.target.owner, 10_000]), false);
            assertEqual((await h.accept()).result.outcome, "no_active_turn");
            assertEqual((await h.proc("cms_steer_claim", [h.sessionId, owner, 5])).length, 0);
            await h.finalize({ owner: h.target.owner });
            assertEqual((await h.request(accepted.requestId)).status, "delivered", "stale finalizer cannot close the winner");
            await h.finalize({ owner, outcome: "adopted", manifest: deliveredManifest(accepted.requestId, attemptId, sdkMessageId), snapshotVersion: 7 });
            const row = await h.request(accepted.requestId);
            assertEqual(row.status, "closed");
            assertEqual(row.included, "included");
            assertEqual(row.included_snapshot_version, 7);
            await h.finalize({ owner: h.target.owner });
            assertEqual((await h.request(accepted.requestId)).included, "included");
            assertEqual(await h.proc("cms_steer_window_adopt", [h.sessionId, h.target.epoch, h.target.turn, h.target.incarnation, randomUUID()]), false);
        });
    });

    it("ST-C08: adopted publication without a manifest stays inclusion-unconfirmed", { timeout: TIMEOUT }, async () => {
        await withSteeringLedger(async (h) => {
            const { accepted } = await handoff(h, "delivered");
            await h.finalize({ outcome: "adopted", snapshotVersion: 3 });
            assertEqual((await h.request(accepted.requestId)).included, "unconfirmed");
        });
    });

    it("ST-C09: stale release/finalize cannot overwrite replacement ownership", { timeout: TIMEOUT }, async () => {
        await withSteeringLedger(async (h) => {
            const { accepted, attemptId } = await handoff(h, "submitting");
            const owner = randomUUID();
            await h.open({ owner });
            await h.proc("cms_steer_claim", [h.sessionId, owner, 1]);
            await h.proc("cms_steer_mark_released", [attemptId, h.target.owner]);
            await h.finalize();
            const row = await h.request(accepted.requestId);
            assertEqual(row.status, "claimed");
            assertEqual(row.owner_token, owner);
            assertEqual(row.included, null, "stale result has no inclusion authority");
        });
    });

    it("ST-C10: expired/stale owner cannot claim or write a new submitting attempt", { timeout: TIMEOUT }, async () => {
        await withSteeringLedger(async (h) => {
            await h.open();
            const accepted = await h.accept();
            await h.query(`UPDATE ${h.schema}.session_steering_windows SET lease_expires_at=now()-interval '1 second' WHERE session_id=$1`, [h.sessionId]);
            assertEqual((await h.proc("cms_steer_claim", [h.sessionId, h.target.owner, 5])).length, 0);
            await h.proc("cms_steer_mark_submitting", [accepted.requestId, h.target.owner]);
            assertEqual((await h.attempts(accepted.requestId)).length, 0);
            assertEqual((await h.request(accepted.requestId)).status, "pending", "lease loss is not terminal closure");
        });
    });
});
