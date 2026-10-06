import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assert, assertEqual } from "../helpers/assertions.js";
import { STEER_AUTHOR, STEER_OTHER, STEER_LIMITS, withSteeringLedger } from "../helpers/steering-ledger.js";

const TIMEOUT = 120_000;

describe.concurrent("session steering ledger and procedures", () => {
    it("ST-U01: admission requires an open matching target and a fresh lease", { timeout: TIMEOUT }, async () => {
        await withSteeringLedger(async (h) => {
            assertEqual((await h.accept()).result.outcome, "no_active_turn");
            await h.open();
            assertEqual((await h.accept({ turn: 2 })).result.outcome, "stale_target");
            assertEqual((await h.accept({ epoch: 1 })).result.outcome, "stale_target");
            assertEqual((await h.accept({ incarnation: "other-incarnation" })).result.outcome, "stale_target");
            await h.query(`UPDATE ${h.schema}.session_steering_windows SET lease_expires_at=now()-interval '1 second' WHERE session_id=$1`, [h.sessionId]);
            assertEqual((await h.accept()).result.outcome, "no_active_turn");
            assertEqual((await h.requests()).length, 0, "refusals write no accepted request");
        });
    });

    it("ST-U02/ST-I02: raced same-key retries retain identity and are not charged twice", { timeout: TIMEOUT }, async () => {
        await withSteeringLedger(async (h) => {
            await h.open();
            const idempotencyKey = randomUUID();
            const limits = { ...STEER_LIMITS, perActorPerMinute: 1, perSessionPerMinute: 1 };
            const answers = await Promise.all(Array.from({ length: 8 }, () => h.accept({ idempotencyKey, limits })));
            const rows = await h.requests();
            assertEqual(rows.length, 1, "unique acceptance authority");
            for (const answer of answers) assertEqual(answer.result.requestId, rows[0].request_id, "all callers observe the winner");
            await h.finalize();
            const retry = await h.accept({ idempotencyKey, limits });
            assertEqual(retry.result.requestId, rows[0].request_id, "reauthorized replay works after closure");
            console.log(`  same-key race: ${answers.length} callers, ${rows.length} accepted row`);
        });
    });

    it("ST-U02/ST-A04: a retry cannot alter text, target, or canonical author", { timeout: TIMEOUT }, async () => {
        await withSteeringLedger(async (h) => {
            await h.open();
            const original = await h.accept();
            for (const change of [{ content: "different" }, { turn: 2 }, { epoch: 1 }, { incarnation: "other" }, { actor: STEER_OTHER }]) {
                const retry = await h.accept({ idempotencyKey: original.idempotencyKey, ...change });
                assertEqual(retry.result.outcome, "idempotency_conflict");
                assert(!JSON.stringify(retry.result).includes(original.content), "conflict discloses no stored text");
            }
            const row = await h.request(original.requestId);
            assertEqual(row.content, original.content);
            expect(row.actor).toEqual(STEER_AUTHOR);
            assertEqual((await h.requests()).length, 1);
        });
    });

    it("ST-U02: limits count UTF-8 bytes rather than code units", { timeout: TIMEOUT }, async () => {
        await withSteeringLedger(async (h) => {
            await h.open();
            const limits = { ...STEER_LIMITS, maxBytes: 4 };
            const accepted = await h.accept({ content: "\u00e9\u00e9", limits });
            assert(await h.request(accepted.requestId), "four-byte payload is accepted");
            assertEqual((await h.accept({ content: "\u00e9\u00e9a", limits })).result.outcome, "too_large");
            assertEqual((await h.requests()).length, 1);
        });
    });

    it("ST-I02/ST-A04: concurrent authors and identical text remain separate ordered rows", { timeout: TIMEOUT }, async () => {
        await withSteeringLedger(async (h) => {
            await h.open();
            await Promise.all([h.accept({ actor: STEER_AUTHOR }), h.accept({ actor: STEER_OTHER })]);
            const accepted = await h.requests();
            assertEqual(accepted.length, 2);
            assert(BigInt(accepted[0].seq) < BigInt(accepted[1].seq), "server sequence is the only order");
            expect(new Set(accepted.map((row) => row.actor.subject))).toEqual(new Set([STEER_AUTHOR.subject, STEER_OTHER.subject]));
            await h.proc("cms_steer_claim", [h.sessionId, h.target.owner, 5]);
            expect((await h.requests()).map((row) => row.status)).toEqual(["claimed", "claimed"]);
        });
    });

    it("ST-A04: actor rate admission is atomic across different sessions", { timeout: TIMEOUT }, async () => {
        await withSteeringLedger(async (h) => {
            const otherSession = randomUUID();
            await h.catalog.createSession(otherSession, { owner: STEER_AUTHOR });
            await h.catalog.updateSession(otherSession, { state: "running" });
            await Promise.all([h.open(), h.open({ sessionId: otherSession })]);
            const limits = { ...STEER_LIMITS, perActorPerMinute: 1 };
            await Promise.all([h.accept({ limits }), h.accept({ sessionId: otherSession, limits })]);
            assertEqual((await h.requests()).length + (await h.requests(otherSession)).length, 1, "global actor cap cannot overshoot");
        });
    });

    it("ST-U03/ST-I03/ST-A03: withdraw and claim have exactly one winner", { timeout: TIMEOUT }, async () => {
        await withSteeringLedger(async (h) => {
            await h.open();
            const accepted = await h.accept();
            const [withdraw] = await Promise.all([
                h.proc("cms_steer_withdraw", [h.sessionId, accepted.requestId, STEER_AUTHOR, false]),
                h.proc("cms_steer_claim", [h.sessionId, h.target.owner, 1]),
            ]);
            const row = await h.request(accepted.requestId);
            if (row.status === "withdrawn") {
                assertEqual(withdraw.outcome, "withdrawn");
                await h.proc("cms_steer_mark_submitting", [accepted.requestId, h.target.owner]);
                assertEqual((await h.attempts(accepted.requestId)).length, 0, "withdrawal prevents write-ahead authority");
            } else {
                assertEqual(row.status, "claimed");
                assertEqual(withdraw.outcome, "not_withdrawable");
            }
        });
    });

    it("ST-A03: another writer cannot withdraw; a manager can withdraw pending input", { timeout: TIMEOUT }, async () => {
        await withSteeringLedger(async (h) => {
            await h.open();
            const accepted = await h.accept();
            assertEqual((await h.proc("cms_steer_withdraw", [h.sessionId, accepted.requestId, STEER_OTHER, false])).outcome, "forbidden");
            assertEqual((await h.request(accepted.requestId)).status, "pending");
            assertEqual((await h.proc("cms_steer_withdraw", [h.sessionId, accepted.requestId, STEER_OTHER, true])).outcome, "withdrawn");
        });
    });

    it("ST-U03: submitting is durable before acknowledgment; released proves non-invocation", { timeout: TIMEOUT }, async () => {
        await withSteeringLedger(async (h) => {
            await h.open();
            const accepted = await h.accept();
            assertEqual((await h.request(accepted.requestId)).status, "pending");
            await h.proc("cms_steer_claim", [h.sessionId, h.target.owner, 1]);
            assertEqual((await h.request(accepted.requestId)).status, "claimed");
            const attemptId = await h.submitting(accepted.requestId);
            const [attempt] = await h.attempts(accepted.requestId);
            assert(attempt.submitting_at, "write-ahead timestamp persisted");
            assertEqual(attempt.outcome, null, "null means SDK invocation is uncertain");
            assertEqual((await h.request(accepted.requestId)).status, "submitting");
            await h.proc("cms_steer_mark_released", [attemptId, h.target.owner]);
            assertEqual((await h.request(accepted.requestId)).status, "pending");
            assertEqual((await h.attempts(accepted.requestId))[0].outcome, "released");
            await h.finalize();
            assertEqual((await h.request(accepted.requestId)).disposition, "not_delivered_turn_ended");
        });
    });

    it("ST-U05: acknowledgment is not delivery; duplicate SDK IDs produce one projection", { timeout: TIMEOUT }, async () => {
        await withSteeringLedger(async (h) => {
            await h.open();
            const accepted = await h.accept();
            await h.proc("cms_steer_claim", [h.sessionId, h.target.owner, 1]);
            const attemptId = await h.submitting(accepted.requestId);
            await h.proc("cms_steer_mark_submitted", [attemptId, h.target.owner, "sdk-steer-1"]);
            assertEqual((await h.request(accepted.requestId)).status, "submitted");
            assertEqual((await h.attempts(accepted.requestId))[0].delivered_at, null);
            await Promise.all(Array.from({ length: 3 }, () => h.proc("cms_steer_mark_delivered", [attemptId, "sdk-steer-1", "steering"])));
            assertEqual((await h.request(accepted.requestId)).disposition, "delivered_current_turn");
            const events = await h.catalog.getSessionEvents(h.sessionId);
            const projections = events.filter((event) => event.eventType === "user.message" && event.data?.steering?.requestId === accepted.requestId);
            assertEqual(projections.length, 1, "only the delivery transaction projects user.message");
            assertEqual(projections[0].data.steering.requestId, accepted.requestId);
        });
    });

    for (const state of ["idle", "waiting", "input_required", "error"]) {
        it(`ST-C07: ${state} writeback does not terminally close a commit-pending target`, { timeout: TIMEOUT }, async () => {
            await withSteeringLedger(async (h) => {
                await h.open();
                const accepted = await h.accept();
                await h.proc("cms_steer_window_quiesce", [h.sessionId, h.target.owner]);
                await h.catalog.updateSession(h.sessionId, { state });
                assertEqual((await h.request(accepted.requestId)).status, "pending");
                const { rows } = await h.query(`SELECT state FROM ${h.schema}.session_steering_windows WHERE session_id=$1`, [h.sessionId]);
                assertEqual(rows[0].state, "quiesced");
            });
        });
    }

    it("ST-C06: durable turn_stopped backstop closes input without a surviving pump", { timeout: TIMEOUT }, async () => {
        await withSteeringLedger(async (h) => {
            await h.open();
            const accepted = await h.accept();
            await h.catalog.recordEvents(h.sessionId, [{ eventType: "session.turn_stopped", data: { turnIndex: h.target.turn } }]);
            const row = await h.request(accepted.requestId);
            assertEqual(row.status, "closed");
            assertEqual(row.disposition, "not_delivered_turn_stopped");
            await h.open({ owner: randomUUID() });
            assertEqual((await h.proc("cms_steer_claim", [h.sessionId, h.target.owner, 5])).length, 0, "stopped target never reopens");
        });
    });
});
