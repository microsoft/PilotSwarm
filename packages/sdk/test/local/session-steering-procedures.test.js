/**
 * Session steering: stored-procedure contract (migration 0082).
 * docs/proposals/session-steering.md §6a.2, §6a.3, §7.3; ST-U01..U03, ST-I02, ST-I03 (CMS part).
 *
 * Real PostgreSQL, isolated schema, no model. Exercises every cms_steer_*
 * procedure through the PgSessionCatalog methods the runtime and the
 * management client call.
 *
 * Needs PostgreSQL: PS_TEST_DATABASE_URL (or TEST_DATABASE_URL / DATABASE_URL).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgSessionCatalog } from "../../src/cms.ts";
import { FEATURE_FLAGS } from "../../src/feature-flags.ts";
import {
    STEERING_FEATURE, readSteeringEnabled, decodeSteeringTarget, encodeSteeringTarget, steeringContentHash, toSteeringReceipt,
    encodeSteeringListCursor, decodeSteeringListCursor,
} from "../../src/steering.ts";

const url = process.env.PS_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
    || "postgres://postgres:postgres@localhost:5432/pilotswarm";
const schema = `ps_test_steer_${randomUUID().replaceAll("-", "")}`;
const pool = new pg.Pool({ connectionString: url, max: 4 });
let catalog;

const alice = { kind: "user", provider: "test", subject: "alice", display: "Alice" };
const bob = { kind: "user", provider: "test", subject: "bob", display: "Bob" };
const LEASE = 10_000;

beforeAll(async () => {
    catalog = await PgSessionCatalog.create(url, schema);
    await catalog.initialize();
});

afterAll(async () => {
    await catalog?.close();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
});

async function newSession() {
    const id = randomUUID();
    await catalog.createSession(id, { model: "test-model" });
    return id;
}

function target(turnIndex = 0, epoch = 0) {
    return { epoch, turnIndex, incarnation: randomUUID() };
}

function accept(sessionId, t, text, opts = {}) {
    return catalog.steerAccept({
        sessionId, requestId: `steer_${randomUUID()}`, idempotencyKey: opts.key ?? randomUUID(),
        actor: opts.actor ?? alice, content: text, contentHash: steeringContentHash(text),
        // One actor is reused across this file; the per-actor rate is exercised explicitly below.
        epoch: t.epoch, turnIndex: t.turnIndex, incarnation: t.incarnation, limits: { ratePerMinute: 1000, ...opts.limits },
    });
}

async function events(sessionId, types) {
    const { rows } = await pool.query(
        `SELECT event_type, data FROM "${schema}".session_events WHERE session_id = $1 ${types ? "AND event_type = ANY($2)" : ""} ORDER BY seq`,
        types ? [sessionId, types] : [sessionId]);
    return rows;
}

async function attempts(requestId) {
    const { rows } = await pool.query(
        `SELECT * FROM "${schema}".session_steering_attempts WHERE request_id = $1 ORDER BY attempt_no`, [requestId]);
    return rows;
}

/** Open, claim, write-ahead, submit, deliver one steer; returns ids. */
async function deliverOne(sessionId, owner, kind = "steering") {
    const [row] = await catalog.steerClaim(sessionId, owner, 1);
    const attemptId = await catalog.steerMarkSubmitting(row.requestId, owner);
    const sdkId = `sdk-${randomUUID()}`;
    await catalog.steerMarkSubmitted(attemptId, owner, sdkId);
    const d = await catalog.steerMarkDelivered(attemptId, sdkId, kind);
    return { requestId: row.requestId, attemptId, sdkId, delivered: d };
}

describe("session steering procedures (0082)", () => {
    it("publishes sessions.steering exactly as the code defines it: Off, no user override", async () => {
        const snapshot = await catalog.features.snapshot([STEERING_FEATURE]);
        expect(snapshot.definitions).toEqual([{ featureKey: STEERING_FEATURE, ...FEATURE_FLAGS[STEERING_FEATURE], revision: "1" }]);
        expect(FEATURE_FLAGS[STEERING_FEATURE].defaultEnabled).toBe(false);
        expect(FEATURE_FLAGS[STEERING_FEATURE].defaultAllowUserOverride).toBe(false);
        const { rows } = await pool.query(
            `SELECT scope, user_id, enabled, allow_user_override, updated_by FROM "${schema}".feature_flag_settings WHERE feature_key = $1`,
            [STEERING_FEATURE]);
        expect(rows).toEqual([{ scope: "cluster", user_id: null, enabled: false, allow_user_override: false, updated_by: "migration:0082" }]);
        expect(await catalog.supportsSteering()).toBe(true);
        expect(await readSteeringEnabled(catalog.features, { provider: "test", subject: "alice" })).toBe(false);
        await pool.query(`UPDATE "${schema}".feature_flag_settings SET enabled = true WHERE feature_key = $1 AND scope = 'cluster'`, [STEERING_FEATURE]);
        expect(await readSteeringEnabled(catalog.features, { provider: "test", subject: "alice" })).toBe(true);
        expect(await readSteeringEnabled(catalog.features, null)).toBe(true);
        await pool.query(`UPDATE "${schema}".feature_flag_settings SET enabled = false WHERE feature_key = $1 AND scope = 'cluster'`, [STEERING_FEATURE]);
    });

    it("is idempotent when initialization is repeated", async () => {
        const fresh = await PgSessionCatalog.create(url, schema);
        await fresh.initialize();
        await pool.query(`SELECT "${schema}".cms_steer_state('none')`);
        const { rows } = await pool.query(
            `SELECT count(*)::int AS n FROM "${schema}".feature_flag_settings WHERE feature_key = $1`, [STEERING_FEATURE]);
        expect(rows[0].n).toBe(1);
        await fresh.close();
    });

    it("refuses without an open window and never creates a row", async () => {
        const sid = await newSession();
        const t = target();
        expect(await accept(sid, t, "hello")).toEqual({ outcome: "no_active_turn", reason: null });
        const state = await catalog.steerState(sid);
        expect(state).toMatchObject({ steerable: false, reason: "no_active_turn", expectedTarget: null, window: null, unresolved: 0 });
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${schema}".session_steering_requests WHERE session_id = $1`, [sid]);
        expect(rows[0].n).toBe(0);
        expect(await accept("missing-session", t, "x")).toEqual({ outcome: "not_found" });
    });

    it("opens a window whose token the SDK encodes identically; acceptance, idempotency and typed refusals", async () => {
        const sid = await newSession();
        const t = target(3, 1);
        const owner = randomUUID();
        expect(await catalog.steerWindowOpen(sid, t, owner, LEASE)).toEqual({ ok: true, recovery: false, recovered: [] });
        const state = await catalog.steerState(sid);
        const token = encodeSteeringTarget(sid, t);
        expect(state.steerable).toBe(true);
        expect(state.expectedTarget).toBe(token);
        expect(decodeSteeringTarget(token)).toEqual({ sessionId: sid, ...t });
        expect(decodeSteeringTarget("st1.not base64")).toBeNull();
        expect(decodeSteeringTarget(`st1.${Buffer.from("a\n1\n2", "utf8").toString("base64url")}`)).toBeNull();
        expect(decodeSteeringTarget(token.replace("st1.", "st2."))).toBeNull();
        expect(decodeSteeringTarget(42)).toBeNull();

        const key = randomUUID();
        const a = await accept(sid, t, "focus on tests", { key });
        expect(a.outcome).toBe("accepted");
        expect(a.duplicate).toBe(false);
        expect(a.receipt).toMatchObject({
            schemaVersion: 1, sessionId: sid, clientRequestId: key, expectedTarget: token,
            target: { transcriptEpoch: 1, turnIndex: 3 }, text: "focus on tests", revision: 1,
            status: "pending", disposition: "accepted", submission: "never_invoked", recovering: false,
            eligibility: { state: "pending", reason: "awaiting_handoff" },
            inclusion: { state: "not_included", snapshotVersion: null }, recoveryFlags: [],
            actor: { provider: "test", subject: "alice", displayName: "Alice" },
            attempts: { total: 0, items: [], nextCursor: null },
        });
        expect(a.receipt.acceptedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);

        const again = await accept(sid, t, "focus on tests", { key });
        expect(again.duplicate).toBe(true);
        expect(again.receipt.requestId).toBe(a.receipt.requestId);
        expect(again.receipt.sequence).toBe(a.receipt.sequence);

        expect(await accept(sid, t, "different body", { key })).toEqual({ outcome: "idempotency_conflict" });
        const probe = (text, extra = {}) => catalog.steerMatchExisting({ sessionId: sid, idempotencyKey: key, actor: alice,
            contentHash: steeringContentHash(text), epoch: t.epoch, turnIndex: t.turnIndex, incarnation: t.incarnation, ...extra });
        expect((await probe("focus on tests")).receipt.requestId).toBe(a.receipt.requestId);
        expect(await probe("other")).toEqual({ outcome: "idempotency_conflict" });
        expect(await catalog.steerMatchExisting({ sessionId: sid, idempotencyKey: "new-key", actor: alice,
            contentHash: "h", epoch: t.epoch, turnIndex: t.turnIndex, incarnation: t.incarnation })).toBeNull();
        expect(await accept(sid, t, "focus on tests", { key, actor: bob })).toEqual({ outcome: "idempotency_conflict" });
        expect(await accept(sid, { ...t, incarnation: randomUUID() }, "x")).toEqual({ outcome: "stale_target" });
        expect(await accept(sid, t, "   ")).toMatchObject({ outcome: "invalid" });
        expect(await accept(sid, t, "x", { actor: { kind: "user", provider: "test" } })).toMatchObject({ outcome: "forbidden" });

        // UTF-8 bytes, not characters: 4 three-byte characters = 12 bytes.
        expect(await accept(sid, t, "€€€€", { limits: { maxBytes: 11 } })).toEqual({ outcome: "too_large", limit: 11 });
        expect((await accept(sid, t, "€€€€", { limits: { maxBytes: 12 } })).outcome).toBe("accepted");

        const accepted = await events(sid, ["session.steering_accepted"]);
        expect(accepted).toHaveLength(2);
        expect(accepted[0].data.receipt.requestId).toBe(a.receipt.requestId);
        const windowEvents = await events(sid, ["session.steering_window_changed"]);
        expect(windowEvents[0].data).toEqual({ schemaVersion: 1, state: "open", expectedTarget: token, reason: "turn_started" });

        const stats = await catalog.steerStats(sid);
        expect(stats.counters).toMatchObject({ duplicate: 2, "rejected:idempotency_conflict": 3, "rejected:stale_target": 1, "rejected:too_large": 1 });
        expect(stats.requests.accepted).toBe(2);
    });

    it("same-key concurrent acceptance yields one row and one receipt", async () => {
        const sid = await newSession();
        const t = target();
        await catalog.steerWindowOpen(sid, t, randomUUID(), LEASE);
        const key = randomUUID();
        const results = await Promise.all([accept(sid, t, "same", { key }), accept(sid, t, "same", { key }), accept(sid, t, "same", { key })]);
        expect(new Set(results.map((r) => r.receipt.requestId)).size).toBe(1);
        expect(results.filter((r) => r.duplicate === false)).toHaveLength(1);
    });

    it("enforces the unresolved cap per session and the actor rate across sessions; a retry is not charged", async () => {
        const s1 = await newSession(); const s2 = await newSession();
        const t1 = target(); const t2 = target();
        await catalog.steerWindowOpen(s1, t1, randomUUID(), LEASE);
        await catalog.steerWindowOpen(s2, t2, randomUUID(), LEASE);
        const carol = { kind: "user", provider: "test", subject: `carol-${randomUUID()}` };
        const key = randomUUID();
        expect((await accept(s1, t1, "a", { key, actor: carol, limits: { maxUnresolved: 1 } })).outcome).toBe("accepted");
        expect(await accept(s1, t1, "b", { actor: carol, limits: { maxUnresolved: 1 } }))
            .toEqual({ outcome: "rate_limited", reason: "unresolved_cap", limit: 1 });
        expect((await accept(s1, t1, "a", { key, actor: carol, limits: { maxUnresolved: 1 } })).duplicate).toBe(true);

        expect((await accept(s2, t2, "c", { actor: carol, limits: { ratePerMinute: 2 } })).outcome).toBe("accepted");
        expect(await accept(s2, t2, "d", { actor: carol, limits: { ratePerMinute: 2 } }))
            .toMatchObject({ outcome: "rate_limited", reason: "actor_rate", limit: 2 });
    });

    it("claims in sequence order; withdraw only before claim, by author or manager", async () => {
        const sid = await newSession();
        const t = target();
        const owner = randomUUID();
        await catalog.steerWindowOpen(sid, t, owner, LEASE);
        const r1 = (await accept(sid, t, "one")).receipt;
        const r2 = (await accept(sid, t, "two")).receipt;
        const r3 = (await accept(sid, t, "three")).receipt;

        expect(await catalog.steerWithdraw(sid, r3.requestId, bob, false)).toEqual({ outcome: "forbidden" });
        expect(await catalog.steerWithdraw(sid, "steer_nope", alice, false)).toEqual({ outcome: "not_found" });
        const w = await catalog.steerWithdraw(sid, r3.requestId, bob, true);
        expect(w.outcome).toBe("withdrawn");
        expect(w.receipt).toMatchObject({ status: "withdrawn", disposition: "withdrawn", eligibility: { state: "terminal", reason: "withdrawn" } });
        expect((await catalog.steerWithdraw(sid, r3.requestId, alice, false)).outcome).toBe("already_settled");

        expect(await catalog.steerClaim(sid, "someone-else", 5)).toEqual([]);
        const claimed = await catalog.steerClaim(sid, owner, 5);
        expect(claimed.map((r) => r.requestId)).toEqual([r1.requestId, r2.requestId]);
        expect(claimed[0]).toMatchObject({ text: "one", redelivery: false, actor: { subject: "alice" } });
        expect(await catalog.steerClaim(sid, owner, 5)).toEqual([]);

        const nw = await catalog.steerWithdraw(sid, r1.requestId, alice, false);
        expect(nw.outcome).toBe("not_withdrawable");
        expect(nw.receipt.status).toBe("claimed");

        const viewer = toSteeringReceipt(nw.receipt, { actor: alice, canWrite: true, isManager: false });
        expect(viewer.actions).toEqual({ canWithdraw: false, canSendAsNewMessage: false });
    });

    it("records hand-off, correlated delivery and the single user.message projection", async () => {
        const sid = await newSession();
        const t = target();
        const owner = randomUUID();
        await catalog.steerWindowOpen(sid, t, owner, LEASE);
        await accept(sid, t, "use the cache");
        const [row] = await catalog.steerClaim(sid, owner, 1);
        expect(await catalog.steerMarkSubmitting(row.requestId, "intruder")).toBeNull();
        const attemptId = await catalog.steerMarkSubmitting(row.requestId, owner);
        expect(attemptId).toMatch(/[0-9a-f-]{36}/);
        let rec = await catalog.steerGet(sid, row.requestId);
        expect(rec).toMatchObject({ status: "submitting", submission: "may_have_submitted", inclusion: { state: "unconfirmed" } });

        expect(await catalog.steerMarkSubmitted(attemptId, owner, "sdk-1")).toBe(true);
        expect(await catalog.steerMarkSubmitted(attemptId, owner, "sdk-other")).toBe(false);
        expect(await catalog.steerMarkDelivered(attemptId, "sdk-other", "steering")).toMatchObject({ changed: false, reason: "message_id_mismatch" });
        const d = await catalog.steerMarkDelivered(attemptId, "sdk-1", "queued");
        expect(d).toMatchObject({ changed: true, current: true });
        expect(await catalog.steerMarkDelivered(attemptId, "sdk-1", "queued")).toMatchObject({ changed: false, reason: "already_recorded" });

        rec = await catalog.steerGet(sid, row.requestId);
        expect(rec).toMatchObject({ status: "delivered", disposition: "delivered_after_response", submission: "acknowledged",
            eligibility: { state: "pending", reason: "awaiting_turn_outcome" } });
        expect(rec.attempts.items[0]).toMatchObject({ attemptNo: 1, deliveryKind: "queued", outcome: "delivered" });

        const um = await events(sid, ["user.message"]);
        expect(um).toHaveLength(1);
        expect(um[0].data).toMatchObject({ content: "use the cache", sender: { subject: "alice" },
            steering: { requestId: row.requestId, attemptId, deliveryKind: "queued", revision: d.revision } });
        const updates = await events(sid, ["session.steering_updated"]);
        expect(updates.length).toBeGreaterThanOrEqual(4);
        expect(updates.at(-1).data.projection.text).toBeUndefined();
        expect(updates.at(-1).data.revision).toBe(d.revision);
    });

    it("finalize is owner-fenced; published manifest ⇒ included; never-invoked ⇒ not delivered, not included; tombstone never reopens", async () => {
        const sid = await newSession();
        const t = target();
        const owner = randomUUID();
        await catalog.steerWindowOpen(sid, t, owner, LEASE);
        await accept(sid, t, "delivered one");
        await accept(sid, t, "never sent");
        const { requestId: deliveredId } = await deliverOne(sid, owner);
        const pendingId = (await catalog.steerList(sid)).items.find((i) => i.text === "never sent").requestId;
        expect(await catalog.steerWindowQuiesce(sid, owner)).toBe(true);
        expect((await catalog.steerState(sid)).steerable).toBe(false);

        expect(await catalog.steerTurnFinalize(sid, t, "stale", "published", [deliveredId], 7)).toEqual({ finalized: false, reason: "not_owner" });
        expect((await catalog.steerGet(sid, deliveredId)).status).toBe("delivered");

        expect(await catalog.steerTurnFinalize(sid, t, owner, "published", [deliveredId], 7)).toEqual({ finalized: true });
        expect(await catalog.steerGet(sid, deliveredId)).toMatchObject({ status: "closed", disposition: "delivered_current_turn",
            inclusion: { state: "included", snapshotVersion: 7 }, eligibility: { state: "terminal", reason: "turn_ended" } });
        const left = await catalog.steerGet(sid, pendingId);
        expect(left).toMatchObject({ status: "closed", disposition: "not_delivered_turn_ended", inclusion: { state: "not_included" } });
        expect(toSteeringReceipt(left, { actor: alice, canWrite: true, isManager: false }).actions.canSendAsNewMessage).toBe(true);

        expect(await catalog.steerWindowOpen(sid, t, randomUUID(), LEASE)).toMatchObject({ ok: false, reason: "closed" });
        expect(await catalog.steerTurnFinalize(sid, t, owner, "published", [], 8)).toEqual({ finalized: false, reason: "closed", inclusionUpdated: 0 });
        const wev = (await events(sid, ["session.steering_window_changed"])).map((e) => e.data.state);
        expect(wev).toEqual(["open", "quiesced", "closed"]);
    });

    it("published without a manifest ⇒ inclusion unconfirmed; unpublished ⇒ this owner's sends not included", async () => {
        const s1 = await newSession(); const t1 = target(); const o1 = randomUUID();
        await catalog.steerWindowOpen(s1, t1, o1, LEASE);
        await accept(s1, t1, "x");
        const a = await deliverOne(s1, o1);
        await catalog.steerTurnFinalize(s1, t1, o1, "published", null, 2);
        expect(await catalog.steerGet(s1, a.requestId)).toMatchObject({ inclusion: { state: "unconfirmed" } });

        const s2 = await newSession(); const t2 = target(); const o2 = randomUUID();
        await catalog.steerWindowOpen(s2, t2, o2, LEASE);
        await accept(s2, t2, "y");
        const b = await deliverOne(s2, o2);
        await catalog.steerTurnFinalize(s2, t2, o2, "unpublished", [b.requestId], null);
        expect(await catalog.steerGet(s2, b.requestId)).toMatchObject({ inclusion: { state: "not_included" }, disposition: "delivered_current_turn" });
    });

    it("a stopped result closes with Stop labels; after Stop closed first, the owner still records inclusion only", async () => {
        const s1 = await newSession(); const t1 = target(); const o1 = randomUUID();
        await catalog.steerWindowOpen(s1, t1, o1, LEASE);
        await accept(s1, t1, "delivered"); await accept(s1, t1, "pending");
        const a = await deliverOne(s1, o1);
        expect(await catalog.steerTurnFinalize(s1, t1, o1, "stopped", [a.requestId], null)).toEqual({ finalized: true });
        const by1 = Object.fromEntries((await catalog.steerList(s1)).items.map((i) => [i.text, i]));
        expect(by1.delivered).toMatchObject({ disposition: "delivered_before_stop", closureReason: "stopped", inclusion: { state: "not_included" }, recoveryFlags: [] });
        expect(by1.pending).toMatchObject({ disposition: "not_delivered_turn_stopped", inclusion: { state: "not_included" } });

        const s2 = await newSession(); const t2 = target(5); const o2 = randomUUID();
        await catalog.steerWindowOpen(s2, t2, o2, LEASE);
        await accept(s2, t2, "x");
        const b = await deliverOne(s2, o2);
        await catalog.steerCloseStopped(s2, 5);
        expect(await catalog.steerGet(s2, b.requestId)).toMatchObject({ disposition: "delivered_before_stop", inclusion: { state: "unconfirmed" }, recoveryFlags: [] });
        expect(await catalog.steerTurnFinalize(s2, t2, "stale", "stopped", null, null)).toMatchObject({ finalized: false, reason: "not_owner" });
        expect(await catalog.steerTurnFinalize(s2, t2, o2, "stopped", null, null)).toEqual({ finalized: false, reason: "closed", inclusionUpdated: 1 });
        expect(await catalog.steerGet(s2, b.requestId)).toMatchObject({ status: "closed", disposition: "delivered_before_stop", inclusion: { state: "not_included" } });
    });

    it("write-ahead cut and released attempts close with evidence-based labels", async () => {
        const sid = await newSession(); const t = target(); const owner = randomUUID();
        await catalog.steerWindowOpen(sid, t, owner, LEASE);
        await accept(sid, t, "crash after marker");
        await accept(sid, t, "released");
        const [r1, r2] = await catalog.steerClaim(sid, owner, 2);
        await catalog.steerMarkSubmitting(r1.requestId, owner);          // dies here: outcome stays NULL
        const a2 = await catalog.steerMarkSubmitting(r2.requestId, owner);
        expect(await catalog.steerMarkReleased(a2, owner)).toBe(true);
        expect(await catalog.steerGet(sid, r2.requestId)).toMatchObject({ status: "pending", submission: "never_invoked" });
        expect((await attempts(r2.requestId))[0].outcome).toBe("released");
        await catalog.steerTurnFinalize(sid, t, owner, "published", [], 1);
        expect(await catalog.steerGet(sid, r1.requestId)).toMatchObject({ disposition: "delivery_unconfirmed", inclusion: { state: "unconfirmed" } });
        expect(await catalog.steerGet(sid, r2.requestId)).toMatchObject({ disposition: "not_delivered_turn_ended", inclusion: { state: "not_included" } });
    });

    it("Stop closes through the durable session.turn_stopped event, target-scoped by turn index; late evidence corrects only the label", async () => {
        const sid = await newSession(); const t = target(4); const owner = randomUUID();
        await catalog.steerWindowOpen(sid, t, owner, LEASE);
        await accept(sid, t, "delivered");
        await accept(sid, t, "in flight");
        await accept(sid, t, "pending");
        const d = await deliverOne(sid, owner);
        const [inflight] = await catalog.steerClaim(sid, owner, 1);
        const att = await catalog.steerMarkSubmitting(inflight.requestId, owner);
        await catalog.steerMarkSubmitted(att, owner, "sdk-late");

        await catalog.recordEvents(sid, [{ eventType: "session.turn_stopped", data: { reason: "x", turnIndex: 3 } }]);
        expect((await catalog.steerState(sid)).steerable).toBe(true);   // a stale Stop for another turn changes nothing

        await catalog.recordEvents(sid, [{ eventType: "session.turn_stopped", data: { reason: "x", turnIndex: 4 } }]);
        const items = (await catalog.steerList(sid)).items;
        const by = Object.fromEntries(items.map((i) => [i.text, i]));
        expect(by.delivered).toMatchObject({ status: "closed", disposition: "delivered_before_stop", closureReason: "stopped" });
        expect(by["in flight"]).toMatchObject({ status: "closed", disposition: "delivery_unconfirmed" });
        expect(by.pending).toMatchObject({ status: "closed", disposition: "not_delivered_turn_stopped" });
        expect((await catalog.steerState(sid)).window).toBeNull();
        expect(d.delivered.changed).toBe(true);

        // A late positive receipt for the stopped turn: label corrected, row stays closed, never reopens.
        expect(await catalog.steerMarkDelivered(att, "sdk-late", "steering")).toMatchObject({ changed: true, current: false });
        expect(await catalog.steerGet(sid, inflight.requestId)).toMatchObject({ status: "closed", disposition: "delivered_before_stop" });
        expect(await catalog.steerClaim(sid, owner, 5)).toEqual([]);
        await catalog.steerCloseStopped(sid, 4);   // the fast path is idempotent
    });

    it("same-target recovery orphans rows, gates them on the recovery check, and fences the old owner", async () => {
        const sid = await newSession(); const t = target(2); const old = randomUUID();
        await catalog.steerWindowOpen(sid, t, old, LEASE);
        await accept(sid, t, "absent later");
        await accept(sid, t, "present later");
        await accept(sid, t, "never claimed");
        const a = await deliverOne(sid, old);
        const b = await deliverOne(sid, old);

        const fresh = randomUUID();
        const reopened = await catalog.steerWindowOpen(sid, t, fresh, LEASE);
        expect(reopened.ok).toBe(true);
        expect(reopened.recovery).toBe(true);
        expect(reopened.recovered.map((r) => [r.requestId, r.recoveryCheck, r.sdkMessageId]))
            .toEqual([[a.requestId, "pending", a.sdkId], [b.requestId, "pending", b.sdkId]]);
        expect(await catalog.steerWindowRenew(sid, old, LEASE)).toBe(false);
        expect(await catalog.steerTurnFinalize(sid, t, old, "published", [a.requestId], 1)).toMatchObject({ finalized: false, reason: "not_owner" });

        // Pending-check rows are not claimable; the never-claimed row is.
        const first = await catalog.steerClaim(sid, fresh, 5);
        expect(first.map((r) => r.text)).toEqual(["never claimed"]);

        expect(await catalog.steerRecordRecoveryCheck(a.requestId, old, "absent")).toBe(false);
        expect(await catalog.steerRecordRecoveryCheck(a.requestId, fresh, "absent")).toBe(true);
        expect(await catalog.steerRecordRecoveryCheck(b.requestId, fresh, "present", b.sdkId)).toBe(true);
        expect(await catalog.steerGet(sid, a.requestId)).toMatchObject({ status: "orphaned", recovering: true,
            recoveryFlags: ["redelivery_pending"], eligibility: { state: "recovery_eligible", reason: "redelivery_pending" } });
        expect(await catalog.steerGet(sid, b.requestId)).toMatchObject({ status: "delivered", inclusion: { state: "included" } });

        const again = await catalog.steerClaim(sid, fresh, 5);
        expect(again).toEqual([expect.objectContaining({ requestId: a.requestId, redelivery: true })]);
        const att = await catalog.steerMarkSubmitting(a.requestId, fresh);
        await catalog.steerMarkSubmitted(att, fresh, "sdk-redelivered");
        await catalog.steerMarkDelivered(att, "sdk-redelivered", "steering");
        expect((await catalog.steerGet(sid, a.requestId)).recoveryFlags).toEqual(["delivered_again"]);

        // The old owner's late evidence is history only.
        const oldAttempts = await attempts(a.requestId);
        expect(oldAttempts.map((x) => x.owner_token)).toEqual([old, fresh]);

        await catalog.steerTurnFinalize(sid, t, fresh, "published", [a.requestId], 9);
        expect(await catalog.steerGet(sid, a.requestId)).toMatchObject({ inclusion: { state: "included", snapshotVersion: 9 }, recoveryFlags: ["delivered_again"] });
        expect(await catalog.steerGet(sid, b.requestId)).toMatchObject({ inclusion: { state: "included" }, status: "closed" });
    });

    it("0083: present_local marks delivered without inclusion; inclusion then follows this attempt's commit", async () => {
        for (const [outcome, expected] of [["published", "included"], ["unpublished", "not_included"]]) {
            const sid = await newSession(); const t = target(); const old = randomUUID(); const fresh = randomUUID();
            await catalog.steerWindowOpen(sid, t, old, LEASE);
            await accept(sid, t, "x");
            const a = await deliverOne(sid, old);
            await catalog.steerWindowOpen(sid, t, fresh, LEASE);
            expect(await catalog.steerRecordRecoveryCheck(a.requestId, fresh, "present_local", a.sdkId)).toBe(true);
            expect(await catalog.steerGet(sid, a.requestId)).toMatchObject({ status: "delivered", recoveryCheck: "present", inclusion: { state: "unconfirmed" }, recoveryFlags: [] });
            expect(await catalog.steerClaim(sid, fresh, 5)).toEqual([]);         // never resent
            await catalog.steerTurnFinalize(sid, t, fresh, outcome, [a.requestId], outcome === "published" ? 3 : null);
            expect((await catalog.steerGet(sid, a.requestId)).inclusion.state).toBe(expected);
        }
    });

    it("0084: resend intent links a retained steer to a fresh ordinary id, idempotently, and never enqueues", async () => {
        const sid = await newSession(); const t = target(); const owner = randomUUID();
        await catalog.steerWindowOpen(sid, t, owner, LEASE);
        const kept = (await accept(sid, t, "retained")).receipt;
        const live = (await accept(sid, t, "still pending")).receipt;
        expect(await catalog.steerRecordResendIntent(sid, live.requestId, "cm-0", alice, alice)).toEqual({ outcome: "not_resendable" });
        await catalog.steerWindowQuiesce(sid, owner);
        await catalog.steerTurnFinalize(sid, t, owner, "published", [], 1);
        const first = await catalog.steerRecordResendIntent(sid, kept.requestId, "cm-1", alice, alice);
        expect(first).toMatchObject({ outcome: "recorded", duplicate: false,
            linkage: { sessionId: sid, requestId: kept.requestId, clientMessageId: "cm-1", actor: { provider: "test", subject: "alice" } } });
        expect(await catalog.steerRecordResendIntent(sid, kept.requestId, "cm-1", alice, alice)).toMatchObject({ outcome: "recorded", duplicate: true });
        expect(await catalog.steerRecordResendIntent(sid, kept.requestId, "cm-1", bob, bob)).toEqual({ outcome: "conflict" });
        expect(await catalog.steerRecordResendIntent(sid, live.requestId, "cm-1", alice, alice)).toEqual({ outcome: "conflict" });
        expect(await catalog.steerRecordResendIntent(sid, "steer_nope", "cm-2", alice, alice)).toEqual({ outcome: "not_found" });
        expect(await catalog.steerRecordResendIntent(sid, kept.requestId, "", alice, alice)).toEqual({ outcome: "invalid" });
        expect((await catalog.steerRecordResendIntent(sid, kept.requestId, "cm-3", alice, alice)).duplicate).toBe(false);
        const ev = await events(sid, ["session.steering_resend_requested"]);
        expect(ev.map((e) => e.data.clientMessageIds)).toEqual([["cm-1"], ["cm-3"]]);
        expect(ev[0].data).toMatchObject({ schemaVersion: 1, requestId: kept.requestId, actor: { subject: "alice" }, sender: { subject: "alice" } });
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${schema}".session_steering_requests WHERE session_id = $1`, [sid]);
        expect(rows[0].n).toBe(2);                                   // no new steer, no queue row
    });

    it("a failed recovery read keeps the row unclaimable and closes it as recovery unconfirmed", async () => {
        const sid = await newSession(); const t = target(); const old = randomUUID(); const fresh = randomUUID();
        await catalog.steerWindowOpen(sid, t, old, LEASE);
        await accept(sid, t, "x");
        const a = await deliverOne(sid, old);
        await catalog.steerWindowOpen(sid, t, fresh, LEASE);
        await catalog.steerRecordRecoveryCheck(a.requestId, fresh, "failed");
        expect(await catalog.steerClaim(sid, fresh, 5)).toEqual([]);
        await catalog.steerTurnFinalize(sid, t, fresh, "published", [], 3);
        expect(await catalog.steerGet(sid, a.requestId)).toMatchObject({ status: "closed", disposition: "delivered_current_turn",
            inclusion: { state: "unconfirmed" }, recoveryFlags: ["recovery_unconfirmed"] });
    });

    it("adopt takes authority only over its own live target; the adopted finalize repairs inclusion", async () => {
        const sid = await newSession(); const t = target(1); const old = randomUUID(); const retry = randomUUID();
        await catalog.steerWindowOpen(sid, t, old, LEASE);
        await accept(sid, t, "x");
        const a = await deliverOne(sid, old);
        await catalog.steerWindowQuiesce(sid, old);
        expect(await catalog.steerWindowAdopt(sid, { ...t, incarnation: "other" }, retry)).toBe(false);
        expect(await catalog.steerWindowAdopt(sid, t, retry)).toBe(true);
        expect(await catalog.steerWindowRenew(sid, old, LEASE)).toBe(false);
        expect(await catalog.steerClaim(sid, retry, 5)).toEqual([]);              // adopt never opens admission
        expect((await accept(sid, t, "late")).outcome).toBe("no_active_turn");
        expect(await catalog.steerTurnFinalize(sid, t, old, "published", [a.requestId], 4)).toMatchObject({ reason: "not_owner" });
        expect(await catalog.steerTurnFinalize(sid, t, retry, "adopted", [a.requestId], 4)).toEqual({ finalized: true });
        expect(await catalog.steerGet(sid, a.requestId)).toMatchObject({ inclusion: { state: "included", snapshotVersion: 4 }, status: "closed" });
        expect(await catalog.steerWindowAdopt(sid, t, randomUUID())).toBe(false);
    });

    it("a new target closes the previous one; a stale open of an older target is refused; abandon writes a tombstone", async () => {
        const sid = await newSession(); const t0 = target(0); const t1 = target(1);
        await catalog.steerWindowOpen(sid, t0, randomUUID(), LEASE);
        const r = (await accept(sid, t0, "old turn")).receipt;
        await catalog.steerWindowOpen(sid, t1, randomUUID(), LEASE);
        expect(await catalog.steerGet(sid, r.requestId)).toMatchObject({ status: "closed", disposition: "not_delivered_turn_ended" });
        expect(await catalog.steerWindowOpen(sid, target(0), randomUUID(), LEASE)).toMatchObject({ ok: false, reason: "stale" });

        const t2 = target(2); const owner = randomUUID();
        expect(await catalog.steerWindowAbandon(sid, t2, owner)).toBe(true);
        expect(await catalog.steerWindowOpen(sid, t2, owner, LEASE)).toMatchObject({ ok: false, reason: "closed" });
        expect((await catalog.steerState(sid)).expectedTarget).toBe(encodeSteeringTarget(sid, t1));
        expect(await catalog.steerWindowAbandon(sid, t1, "not-the-owner")).toBe(false);
    });

    it("a stale lease refuses acceptance and claims and reads as recovering", async () => {
        const sid = await newSession(); const t = target(); const owner = randomUUID();
        await catalog.steerWindowOpen(sid, t, owner, 1);
        await pool.query(`SELECT pg_sleep(0.05)`);
        expect(await accept(sid, t, "late")).toEqual({ outcome: "no_active_turn", reason: "recovering" });
        expect(await catalog.steerState(sid)).toMatchObject({ steerable: false, recovering: true, expectedTarget: null });
        expect(await catalog.steerClaim(sid, owner, 5)).toEqual([]);
        expect(await catalog.steerWindowRenew(sid, owner, LEASE)).toBe(true);
        expect((await accept(sid, t, "renewed")).outcome).toBe("accepted");
    });

    it("terminal session states and deletion close steering; idle and waiting do not", async () => {
        const sid = await newSession(); const t = target(); const owner = randomUUID();
        await catalog.steerWindowOpen(sid, t, owner, LEASE);
        const r = (await accept(sid, t, "x")).receipt;
        for (const state of ["idle", "waiting", "input_required", "error"]) {
            await catalog.updateSession(sid, { state });
            expect((await catalog.steerState(sid)).steerable).toBe(true);
        }
        await catalog.updateSession(sid, { state: "completed" });
        expect(await catalog.steerGet(sid, r.requestId)).toMatchObject({ status: "closed", disposition: "not_delivered_turn_ended" });
        expect((await catalog.steerState(sid)).window).toBeNull();

        const s2 = await newSession(); const t2 = target();
        await catalog.steerWindowOpen(s2, t2, randomUUID(), LEASE);
        const r2 = (await accept(s2, t2, "y")).receipt;
        await catalog.softDeleteSession(s2);
        expect(await catalog.steerGet(s2, r2.requestId)).toMatchObject({ status: "closed" });
    });

    it("pages receipts and attempts with bounded cursors; filters by disposition and target", async () => {
        const sid = await newSession(); const t = target(); const owner = randomUUID();
        await catalog.steerWindowOpen(sid, t, owner, LEASE);
        for (const n of [1, 2, 3, 4, 5]) await accept(sid, t, `m${n}`);
        const p1 = await catalog.steerList(sid, { limit: 2 });
        expect(p1.items.map((i) => i.text)).toEqual(["m1", "m2"]);
        expect(p1.nextAfterSeq).toBe(p1.items[1].sequence);
        const p3 = await catalog.steerList(sid, { afterSeq: (await catalog.steerList(sid, { limit: 4 })).nextAfterSeq, limit: 2 });
        expect(p3.items.map((i) => i.text)).toEqual(["m5"]);
        expect(p3.nextAfterSeq).toBeNull();
        expect((await catalog.steerList(sid, { dispositions: ["withdrawn"] })).items).toEqual([]);
        expect((await catalog.steerList(sid, { target: { ...t, incarnation: "x" } })).items).toEqual([]);
        expect((await catalog.steerList(sid, { target: t })).items).toHaveLength(5);

        const filter = { dispositions: ["accepted"] };
        const cursor = encodeSteeringListCursor(sid, filter, 42);
        expect(decodeSteeringListCursor(sid, filter, cursor)).toBe(42);
        expect(decodeSteeringListCursor(sid, {}, cursor)).toBeNull();
        expect(decodeSteeringListCursor("other", filter, cursor)).toBeNull();

        // Three attempts on one request (two released), paged one at a time.
        const [row] = await catalog.steerClaim(sid, owner, 1);
        for (let i = 0; i < 2; i++) {
            const att = await catalog.steerMarkSubmitting(row.requestId, owner);
            await catalog.steerMarkReleased(att, owner);
            await catalog.steerClaim(sid, owner, 1);
        }
        await catalog.steerMarkSubmitting(row.requestId, owner);
        const g1 = await catalog.steerGet(sid, row.requestId, { attemptLimit: 1 });
        expect(g1.attempts.total).toBe(3);
        expect(g1.attempts.items.map((a) => a.attemptNo)).toEqual([1]);
        const g2 = await catalog.steerGet(sid, row.requestId, { attemptAfter: Number(g1.attempts.nextCursor), attemptLimit: 5 });
        expect(g2.attempts.items.map((a) => a.attemptNo)).toEqual([2, 3]);
        expect(g2.attempts.nextCursor).toBeNull();
        expect(await catalog.steerGet("other-session", row.requestId)).toBeNull();
    });

    it("stats aggregate without content", async () => {
        const sid = await newSession(); const t = target(); const owner = randomUUID();
        await catalog.steerWindowOpen(sid, t, owner, LEASE);
        await accept(sid, t, "secret guidance text");
        await deliverOne(sid, owner);
        await catalog.steerWindowQuiesce(sid, owner);
        await catalog.steerTurnFinalize(sid, t, owner, "published", null, 1);
        const stats = await catalog.steerStats(sid);
        expect(JSON.stringify(stats)).not.toContain("secret");
        expect(stats).toMatchObject({ schemaVersion: 1, requests: { accepted: 1, unresolved: 0, byInclusion: { unconfirmed: 1 } },
            attempts: { deliveries: 1, deliveredByKind: { steering: 1 }, redeliveries: 0 }, windows: { opened: 1 } });
        expect(stats.latency.handoffMs.count).toBe(1);
        expect(stats.latency.safePointMs.count).toBe(1);
    });
});
