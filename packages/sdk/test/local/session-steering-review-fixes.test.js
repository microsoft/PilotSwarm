/**
 * Session steering: regressions for the independent review findings
 * (F02 lock order, F03 lease fence, F04 generation-safe cleanup,
 * F05 bounded I/O, F06 recovery timing). Real PostgreSQL, isolated schema.
 *
 * Needs PostgreSQL: PS_TEST_DATABASE_URL (or TEST_DATABASE_URL / DATABASE_URL).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgSessionCatalog } from "../../src/cms.ts";
import { steeringContentHash } from "../../src/steering.ts";
import { SteeringCallQueue, SteeringTurn, createCmsSteeringChannel } from "../../src/steering-channel.ts";
import { SteeringPump } from "../../src/steering-pump.ts";
import { within } from "../helpers/steering-cli.mjs";
import { SessionManager } from "../../src/session-manager.ts";
import { withSteeringLedger } from "../helpers/steering-ledger.js";

const url = process.env.PS_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
    || "postgres://postgres:postgres@localhost:5432/pilotswarm";
const schema = `ps_test_steer_review_${randomUUID().replaceAll("-", "")}`;
const pool = new pg.Pool({ connectionString: url, max: 6 });
const alice = { kind: "user", provider: "test", subject: "alice", display: "Alice" };
const LEASE = 10_000;
let catalog;

beforeAll(async () => {
    catalog = await PgSessionCatalog.create(url, schema);
    await catalog.initialize();
});

afterAll(async () => {
    await catalog?.close();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(pred, ms = 5_000, label = "condition") {
    const end = Date.now() + ms;
    while (!(await pred())) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
        await sleep(10);
    }
}

async function seededClaim(turnIndex = 0) {
    const sessionId = randomUUID();
    await catalog.createSession(sessionId, { model: "m" });
    const target = { epoch: 0, turnIndex, incarnation: randomUUID() };
    const owner = randomUUID();
    await catalog.steerWindowOpen(sessionId, target, owner, LEASE);
    const text = "guidance";
    const accepted = await catalog.steerAccept({ sessionId, requestId: `steer_${randomUUID()}`, idempotencyKey: randomUUID(),
        actor: alice, content: text, contentHash: steeringContentHash(text), ...target });
    const [row] = await catalog.steerClaim(sessionId, owner, 1);
    expect(row.requestId).toBe(accepted.receipt.requestId);
    return { sessionId, target, owner, requestId: row.requestId };
}

/** Wait for this exact blocked backend, not unrelated concurrent database activity. */
async function blockedBy(pid, blocker) {
    let stopped = false;
    try { await within((async () => {
        while (!stopped) {
            const { rows } = await pool.query("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS held", [blocker, pid]);
            if (rows[0].held) return;
            await new Promise(setImmediate);
        }
    })(), "actual handoff backend waits on the held closure transaction", 5_000);
    } finally { stopped = true; }
}

describe.concurrent("F02: Stop closure and hand-off take locks in one order", () => {
    it("a hand-off that starts while closure holds request rows waits instead of deadlocking (no 40P01)", async () => {
        const { sessionId, target, owner, requestId } = await seededClaim(4);
        const stop = new pg.Client({ connectionString: url });
        const handoffClient = new pg.Client({ connectionString: url });
        await stop.connect();
        await handoffClient.connect();
        try {
            const stopperPid = (await stop.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            const handoffPid = (await handoffClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            // Connection A: the prefix of terminal closure — session advisory lock, then the request row.
            await stop.query("BEGIN");
            await stop.query(`SELECT "${schema}".cms_steer_lock_session($1)`, [sessionId]);
            await stop.query(`SELECT 1 FROM "${schema}".session_steering_requests WHERE request_id = $1 FOR UPDATE`, [requestId]);
            // Connection B: the real hand-off procedure, started while A holds those locks.
            const handoff = handoffClient.query(`SELECT "${schema}".cms_steer_mark_submitting($1,$2) AS attempt`, [requestId, owner]).then(
                ({ rows }) => ({ ok: true, v: rows[0].attempt }), (err) => ({ ok: false, err }));
            await blockedBy(handoffPid, stopperPid);
            // A finishes the real closure (requests, then the window) and commits.
            await stop.query(`SELECT "${schema}".cms_steer_close_stopped($1, $2)`, [sessionId, target.turnIndex]);
            await stop.query("COMMIT");
            const result = await handoff;
            expect(result.ok, `hand-off failed: ${result.err?.code} ${result.err?.message}`).toBe(true);
            expect(result.v).toBeNull();                                       // window closed: no write-ahead
            const receipt = await catalog.steerGet(sessionId, requestId);
            expect(receipt).toMatchObject({ status: "closed", disposition: "not_delivered_turn_stopped", attempts: { total: 0 } });
        } finally {
            await stop.query("ROLLBACK");
            await stop.end();
            await handoffClient.end();
        }
    });

    it("claim also waits behind closure's advisory lock and then finds no open window", async () => {
        const { sessionId, target, owner } = await seededClaim(5);
        const text = "second";
        await catalog.steerAccept({ sessionId, requestId: `steer_${randomUUID()}`, idempotencyKey: randomUUID(),
            actor: alice, content: text, contentHash: steeringContentHash(text), ...target });
        const stop = new pg.Client({ connectionString: url });
        const claimClient = new pg.Client({ connectionString: url });
        await stop.connect();
        await claimClient.connect();
        try {
            const stopperPid = (await stop.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            const claimPid = (await claimClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
            await stop.query("BEGIN");
            await stop.query(`SELECT "${schema}".cms_steer_lock_session($1)`, [sessionId]);
            const claim = claimClient.query(`SELECT "${schema}".cms_steer_claim($1,$2,$3) AS requests`, [sessionId, owner, 5]);
            await blockedBy(claimPid, stopperPid);
            await stop.query(`SELECT "${schema}".cms_steer_close_stopped($1, $2)`, [sessionId, target.turnIndex]);
            await stop.query("COMMIT");
            expect((await claim).rows[0].requests).toEqual([]);
        } finally {
            await stop.query("ROLLBACK");
            await stop.end();
            await claimClient.end();
        }
    });
});

describe.concurrent("F03: the final hand-off fence checks the lease", () => {
    it("a row claimed before expiry gets no write-ahead attempt after expiry", async () => {
        const { sessionId, requestId, owner } = await seededClaim();
        await pool.query(`UPDATE "${schema}".session_steering_windows SET lease_expires_at = now() - interval '1 second'
                           WHERE session_id = $1`, [sessionId]);
        expect(await catalog.steerMarkSubmitting(requestId, owner)).toBeNull();
        const receipt = await catalog.steerGet(sessionId, requestId);
        expect(receipt).toMatchObject({ status: "claimed", attempts: { total: 0 }, submission: "never_invoked" });
        // A renewal by the owner restores admission; the claimed row can then be handed off.
        expect(await catalog.steerWindowRenew(sessionId, owner, LEASE)).toBe(true);
        expect(await catalog.steerMarkSubmitting(requestId, owner)).toMatch(/[0-9a-f-]{36}/);
    });

    it("a live pump whose renewal is held never hands off after the lease expires", async () => {
        const sessionId = randomUUID();
        await catalog.createSession(sessionId, { model: "m" });
        const target = { epoch: 0, turnIndex: 0, incarnation: randomUUID() };
        const owner = randomUUID();
        const leaseMs = 600;
        const real = createCmsSteeringChannel(catalog, sessionId, target, owner, { leaseMs, recoverySource: "restored" });
        let releaseClaim;
        const claimReturned = Promise.withResolvers();
        const claimEntered = Promise.withResolvers();
        const claimHeld = new Promise((r) => { releaseClaim = r; });
        const renewalResult = Promise.withResolvers();
        let markCalls = 0;
        const channel = {
            ...real,
            renew: () => renewalResult.promise,
            claim: async (limit) => {
                const rows = await real.claim(limit);
                if (rows.length) { claimEntered.resolve(); await claimHeld; claimReturned.resolve(); }
                return rows;
            },
            markSubmitting: async (id) => { markCalls++; return real.markSubmitting(id); },
        };
        const sends = [];
        const handlers = new Map();
        const session = {
            on: (type, fn) => { handlers.set(type, fn); return () => handlers.delete(type); },
            send: async (o) => { sends.push(o); return `sdk-${sends.length}`; },
            getEvents: async () => [],
        };
        const pump = new SteeringPump(session, channel, {
            stopping: () => false, turnBoundaryScheduled: () => false, quiesceWarmSession: async () => true,
            scanMs: 10, renewMs: 50, ioTimeoutMs: 500, sendTimeoutMs: 500, settleMs: 200,
        });
        try {
            handlers.get("user.message")?.({ type: "user.message", data: { messageId: "main", delivery: "idle" } });
            pump.noteMainPrompt("main");
            await until(() => pump.gate.isOpen, 5_000, "the gate");
            const text = "late guidance";
            const accepted = await catalog.steerAccept({ sessionId, requestId: `steer_${randomUUID()}`, idempotencyKey: randomUUID(),
                actor: alice, content: text, contentHash: steeringContentHash(text), ...target });
            expect(accepted.outcome).toBe("accepted");
            await until(async () => (await catalog.steerGet(sessionId, accepted.receipt.requestId))?.status === "claimed",
                5_000, "the claim");
            await within(claimEntered.promise, "actual claim barrier reached");
            await until(async () => {
                const { rows } = await pool.query(`SELECT lease_expires_at < clock_timestamp() AS expired
                    FROM "${schema}".session_steering_windows WHERE session_id = $1`, [sessionId]);
                return rows[0]?.expired === true;
            }, 5_000, "the database lease to expire");
            releaseClaim();
            await within(claimReturned.promise, "held real claim returns after lease expiry");
            await pump.settle({ stopping: false });
            expect(sends).toEqual([]);
            const receipt = await catalog.steerGet(sessionId, accepted.receipt.requestId);
            expect(receipt.attempts.total).toBe(0);
            expect(markCalls).toBe(0);                                        // the local lease deadline stopped it first
        } finally {
            releaseClaim();
            renewalResult.resolve(false);
            handlers.get("session.idle")?.({ type: "session.idle", data: {} });
            await pump.settle({ stopping: false });
            pump.dispose();
        }
    });
});

describe.concurrent("F04: steering quiescence cleanup is generation-safe", () => {
    /** The real SessionManager methods over an in-memory handle map (no CLI, no I/O). */
    function manager() {
        const m = Object.create(SessionManager.prototype);
        m.sessions = new Map();
        m.sessionAgentCopies = new Map();
        m.sessionBindingFingerprints = new Map();
        return m;
    }
    function handle(name, destroyImpl) {
        const h = {
            name,
            destroyed: false,
            aborted: false,
            getWorkspaceState: () => ({}),
            getActiveTurn: () => (name === "replacement" && !h.aborted ? { turnIndex: 7, startedAt: Date.now() } : null),
            requestStop: () => ({ turnIndex: 7 }),
            abort: () => { h.aborted = true; },
            destroy: destroyImpl ?? (async function () { this.destroyed = true; }),
        };
        return h;
    }

    it("a deferred old cleanup completing after recovery does not remove the replacement handle", async () => {
        const m = manager();
        const destroyEntered = Promise.withResolvers();
        let finishOld;
        const old = handle("old", function () {
            destroyEntered.resolve();
            return new Promise((r) => { finishOld = () => { this.destroyed = true; r(); }; });
        });
        m.sessions.set("s1", old);
        m.sessionAgentCopies.set("s1", { tag: "old-copy" });
        m.sessionBindingFingerprints.set("s1", "old-fp");

        // Hold the actual manager's destroy boundary while recovery replaces it.
        const late = m.quiesceForSteering("s1");
        await within(destroyEntered.promise, "old handle destroy is issued and held");

        // Recovery installs a replacement while the old cleanup is still outstanding.
        const replacement = handle("replacement");
        m.sessions.set("s1", replacement);
        m.sessionAgentCopies.set("s1", { tag: "new-copy" });
        m.sessionBindingFingerprints.set("s1", "new-fp");

        finishOld();
        expect(await late).toBe(true);
        expect(old.destroyed).toBe(true);
        expect(m.sessions.get("s1")).toBe(replacement);
        expect(m.sessionAgentCopies.get("s1")).toEqual({ tag: "new-copy" });
        expect(m.sessionBindingFingerprints.get("s1")).toBe("new-fp");

        // Stop still reaches the replacement's running turn.
        const stop = await m.abortWarmSessionTurn("s1", { reason: "test", unwindGraceMs: 1_000 });
        expect(stop).toEqual({ outcome: "stopped", turnIndex: 7 });
        expect(replacement.aborted).toBe(true);
    });

    it("without a replacement the cleanup still forgets its own handle", async () => {
        const m = manager();
        const old = handle("old");
        m.sessions.set("s2", old);
        m.sessionAgentCopies.set("s2", { tag: "copy" });
        expect(await m.quiesceForSteering("s2")).toBe(true);
        expect(m.sessions.has("s2")).toBe(false);
        expect(m.sessionAgentCopies.has("s2")).toBe(false);
    });
});

describe.concurrent("F05: steering database work is bounded", () => {
    async function holdSessionLock(sessionId) {
        const holder = new pg.Client({ connectionString: url });
        await holder.connect();
        await holder.query(`SELECT pg_advisory_lock(hashtextextended('steer-window:' || $1, 0))`, [sessionId]);
        return { release: async () => { await holder.query(`SELECT pg_advisory_unlock_all()`); await holder.end(); } };
    }

    it("a blocked real statement is cancelled server-side within the budget; the pool stays usable", async () => {
      await withSteeringLedger(async (h) => {
        const catalog = h.catalog;
        const sessionId = randomUUID();
        await catalog.createSession(sessionId, { model: "m" });
        const target = { epoch: 0, turnIndex: 0, incarnation: randomUUID() };
        const owner = randomUUID();
        await catalog.steerWindowOpen(sessionId, target, owner, LEASE);
        const previous = catalog.steeringQueryTimeoutMs;
        catalog.steeringQueryTimeoutMs = 400;
        const lock = await holdSessionLock(sessionId);
        try {
            const started = Date.now();
            const blocked = catalog.steerTurnFinalize(sessionId, target, owner, "published", [], 1).then(() => null, (e) => e);
            const waitingHere = async () => (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
                  AND position($1 in query) > 0 AND query LIKE '%cms_steer_turn_finalize%'`, [h.schema])).rows[0].n;
            await until(async () => (await waitingHere()) > 0, 3_000, "this exact schema's finalizer is blocked");
            const err = await blocked;
            const elapsed = Date.now() - started;
            // Server-side cancellation: lock_timeout (55P03) or statement_timeout (57014), never a hang.
            expect(["55P03", "57014"], String(err?.message)).toContain(err?.code);
            expect(elapsed).toBeLessThan(2_500);
            expect(await waitingHere()).toBe(0, "this exact schema's timed-out statement no longer waits on the held lock");
            // Nothing committed: the window is still open, and the pool still serves calls.
            expect((await catalog.steerState(sessionId)).steerable).toBe(true);
        } finally {
            await lock.release();
            catalog.steeringQueryTimeoutMs = previous;
        }
      });
    });

    it("post-commit finalize returns within its budget while storage is blocked, and completes once unblocked", async () => {
      await withSteeringLedger(async (h) => {
        const catalog = h.catalog;
        const sessionId = randomUUID();
        await catalog.createSession(sessionId, { model: "m" });
        const turn = await SteeringTurn.create({
            catalog, sessionId, turnKey: randomUUID(), transcriptEpoch: 0, turnIndex: 3,
            sessionRow: { owner: null }, featureCache: { resolve: () => ({ enabled: true }) },
        });
        const channel = turn.newChannel();
        expect((await channel.openWindow()).ok).toBe(true);
        const previous = catalog.steeringQueryTimeoutMs;
        catalog.steeringQueryTimeoutMs = 300;
        const lock = await holdSessionLock(sessionId);
        try {
            const started = Date.now();
            await turn.finalize("published", { delivered: [] }, 1);           // traced, never thrown
            expect(Date.now() - started).toBeLessThan(5_000);
            expect((await catalog.steerState(sessionId)).window?.state).toBe("open");
        } finally {
            await lock.release();
            catalog.steeringQueryTimeoutMs = previous;
        }
        await turn.finalize("published", { delivered: [] }, 1);
        expect((await catalog.steerState(sessionId)).window).toBeNull();
      });
    });

    it("lease renewals never overlap", async () => {
        let calls = 0;
        const entered = Promise.withResolvers();
        const held = Promise.withResolvers();
        const channel = {
            sessionId: "s", target: { epoch: 0, turnIndex: 0, incarnation: "i" }, ownerToken: "o", recoverySource: "restored",
            openWindow: async () => ({ ok: true, recovered: [] }),
            renew: () => { calls++; entered.resolve(); return held.promise; },
            claim: async () => [], quiesce: async () => {}, abandonWindow: async () => {},
            recordRecoveryCheck: async () => {}, markSubmitting: async () => null, markReleased: async () => {},
            markSubmitted: async () => {}, markDelivered: async () => {}, markUnconfirmed: async () => {},
        };
        const handlers = new Map();
        const session = { on: (type, fn) => { handlers.set(type, fn); return () => {}; }, send: async () => "x", getEvents: async () => [] };
        const pump = new SteeringPump(session, channel, {
            stopping: () => false, turnBoundaryScheduled: () => false, quiesceWarmSession: async () => true,
            scanMs: 10, renewMs: 5, ioTimeoutMs: 100, settleMs: 50,
        });
        try {
            handlers.get("user.message")({ type: "user.message", data: { messageId: "main" } });
            pump.noteMainPrompt("main");
            await until(() => pump.gate.isOpen, 2_000, "the gate");
            await within(entered.promise, "first real pump renewal has been issued and is held");
            await pump.renewLease();
            await pump.renewLease();
            await pump.renewLease();
            expect(calls).toBe(1);
        } finally {
            held.resolve(false);
            handlers.get("session.idle")({ type: "session.idle", data: {} });
            await pump.settle({ stopping: false });
            pump.dispose();
        }
    });
});

describe.concurrent("F06: recovery records the observed delivery timing, never an invented one", () => {
    /** Accept → claim → write-ahead → SDK id persisted (delivery write lost) → same-target recovery. */
    async function lostDeliveryRecovered() {
        const { sessionId, target, owner, requestId } = await seededClaim();
        const attemptId = await catalog.steerMarkSubmitting(requestId, owner);
        const sdkId = `sdk-${randomUUID()}`;
        await catalog.steerMarkSubmitted(attemptId, owner, sdkId);
        const fresh = randomUUID();
        const reopened = await catalog.steerWindowOpen(sessionId, target, fresh, LEASE);
        expect(reopened.recovered.map((r) => r.requestId)).toEqual([requestId]);
        return { sessionId, target, fresh, requestId, sdkId };
    }

    for (const [kind, disposition] of [["steering", "delivered_current_turn"], ["queued", "delivered_after_response"],
        ["idle", "delivered_after_response"], [null, "delivered_timing_unconfirmed"], ["bogus", "delivered_timing_unconfirmed"]]) {
        it(`restored history with delivery kind ${kind} ⇒ ${disposition}; inclusion stays separate`, async () => {
            const { sessionId, target, fresh, requestId, sdkId } = await lostDeliveryRecovered();
            expect(await catalog.steerRecordRecoveryCheck(requestId, fresh, "present", sdkId, kind)).toBe(true);
            const r = await catalog.steerGet(sessionId, requestId);
            const recorded = ["steering", "queued", "idle"].includes(kind) ? kind : null;
            expect(r).toMatchObject({ status: "delivered", disposition, inclusion: { state: "included" } });
            expect(r.attempts.items.at(-1)).toMatchObject({ outcome: "delivered", deliveryKind: recorded });
            await catalog.steerTurnFinalize(sessionId, target, fresh, "published", [], 2);
            const closed = await catalog.steerGet(sessionId, requestId);
            expect(closed).toMatchObject({ status: "closed", disposition, inclusion: { state: "included" } });
        });
    }

    it("present_local carries the kind too and leaves inclusion to finalize", async () => {
        const { sessionId, fresh, requestId, sdkId } = await lostDeliveryRecovered();
        await catalog.steerRecordRecoveryCheck(requestId, fresh, "present_local", sdkId, "queued");
        expect(await catalog.steerGet(sessionId, requestId)).toMatchObject({
            disposition: "delivered_after_response", inclusion: { state: "unconfirmed" } });
    });

    it("a kind recorded from live evidence is never overwritten by recovery", async () => {
        const { sessionId, target, owner, requestId } = await seededClaim();
        const attemptId = await catalog.steerMarkSubmitting(requestId, owner);
        await catalog.steerMarkSubmitted(attemptId, owner, "sdk-live");
        await catalog.steerMarkDelivered(attemptId, "sdk-live", "queued");
        const fresh = randomUUID();
        await catalog.steerWindowOpen(sessionId, target, fresh, LEASE);
        await catalog.steerRecordRecoveryCheck(requestId, fresh, "present", "sdk-live", "steering");
        const r = await catalog.steerGet(sessionId, requestId);
        expect(r.attempts.items[0].deliveryKind).toBe("queued");
        expect(r.disposition).toBe("delivered_after_response");
    });

    it("owner decision F06: Stop closes unknown-timing recovery without inventing a delivered-before-Stop timing", async () => {
        const { sessionId, target, fresh, requestId, sdkId } = await lostDeliveryRecovered();
        await catalog.steerRecordRecoveryCheck(requestId, fresh, "present", sdkId, null);
        await catalog.steerCloseStopped(sessionId, target.turnIndex);
        const closed = await catalog.steerGet(sessionId, requestId);
        expect(closed).toMatchObject({
            status: "closed", disposition: "delivered_timing_unconfirmed", closureReason: "stopped",
            eligibility: { state: "terminal" }, inclusion: { state: "included" },
        });
        expect(closed.attempts.items.at(-1).deliveryKind).toBeNull();
        const stats = await catalog.steerStats(sessionId);
        expect(stats.requests.byDisposition.delivered_timing_unconfirmed).toBe(1);
        expect(stats.requests.byDisposition.delivered_before_stop ?? 0).toBe(0);
        const b = await lostDeliveryRecovered();
        await catalog.steerRecordRecoveryCheck(b.requestId, b.fresh, "present", b.sdkId, "queued");
        await catalog.steerCloseStopped(b.sessionId, b.target.turnIndex);
        expect((await catalog.steerGet(b.sessionId, b.requestId)).disposition).toBe("delivered_before_stop");
    });

    it("a still-pending row closed by Stop keeps the normal Stop dispositions", async () => {
        const { sessionId, target, requestId } = await seededClaim(9);
        await catalog.steerCloseStopped(sessionId, target.turnIndex);
        expect((await catalog.steerGet(sessionId, requestId)).disposition).toBe("not_delivered_turn_stopped");
    });

    it("a Stop-closed delivery_unconfirmed row that gains timing-unknown evidence is corrected, never reopened", async () => {
        const { sessionId, target, owner, requestId } = await seededClaim(10);
        const attemptId = await catalog.steerMarkSubmitting(requestId, owner);
        await catalog.steerMarkSubmitted(attemptId, owner, "sdk-late-unknown");
        await catalog.steerCloseStopped(sessionId, target.turnIndex);
        expect((await catalog.steerGet(sessionId, requestId)).disposition).toBe("delivery_unconfirmed");
        // Late positive evidence without a recorded kind. No product path writes such evidence onto a
        // Stop-closed row today (a stopped target never reopens for recovery), so this checks the
        // closure rule every late-evidence correction uses.
        await pool.query(`UPDATE "${schema}".session_steering_attempts SET delivered_at = now(), outcome = 'delivered'
                           WHERE attempt_id = $1`, [attemptId]);
        const { rows } = await pool.query(`SELECT "${schema}".cms_steer_closed_disposition($1, 'stopped', 'delivery_unconfirmed') AS d`, [requestId]);
        expect(rows[0].d).toBe("delivered_timing_unconfirmed");
        expect((await catalog.steerGet(sessionId, requestId)).status).toBe("closed");
    });

    it("the pump passes the recorded kind of the found event", async () => {
        const calls = [];
        const channel = {
            sessionId: "s", target: { epoch: 0, turnIndex: 0, incarnation: "i" }, ownerToken: "o", recoverySource: "restored",
            openWindow: async () => ({ ok: true, recovery: true, recovered: [
                { requestId: "a", sequence: 1, recoveryCheck: "pending", sdkMessageId: "m1", sdkMessageIds: ["m1"] },
                { requestId: "b", sequence: 2, recoveryCheck: "pending", sdkMessageId: "m2", sdkMessageIds: ["m2"] },
                { requestId: "c", sequence: 3, recoveryCheck: "pending", sdkMessageId: "m3", sdkMessageIds: ["m3"] }] }),
            recordRecoveryCheck: async (...args) => { calls.push(args); },
            renew: async () => true, claim: async () => [], quiesce: async () => {}, abandonWindow: async () => {},
            markSubmitting: async () => null, markReleased: async () => {}, markSubmitted: async () => {},
            markDelivered: async () => {}, markUnconfirmed: async () => {},
        };
        const handlers = new Map();
        const session = {
            on: (type, fn) => { handlers.set(type, fn); return () => {}; }, send: async () => "x",
            getEvents: async () => [
                { type: "user.message", data: { messageId: "m1", delivery: "queued" } },
                { type: "user.message", data: { messageId: "m2", delivery: "idle" } },
                { type: "user.message", data: { messageId: "m3" } }],
        };
        const pump = new SteeringPump(session, channel, {
            stopping: () => false, turnBoundaryScheduled: () => false, quiesceWarmSession: async () => true, scanMs: 10, settleMs: 50,
        });
        handlers.get("user.message")({ type: "user.message", data: { messageId: "main" } });
        pump.noteMainPrompt("main");
        await until(() => pump.gate.isOpen, 2_000, "the gate");
        expect(calls).toEqual([["a", "present", "m1", "queued"], ["b", "present", "m2", "idle"], ["c", "present", "m3", null]]);
        handlers.get("session.idle")({ type: "session.idle", data: {} });
        await pump.settle({ stopping: false });
        pump.dispose();
    });
});

describe.concurrent("CMS pool pressure: one steering database call per turn", () => {
    it("the call queue runs one call at a time and lets a renewal go next", async () => {
        const q = new SteeringCallQueue();
        const order = [];
        const entered = Promise.withResolvers();
        let releaseFirst;
        const first = q.run(() => new Promise((r) => { releaseFirst = () => { order.push("claim"); r(); }; entered.resolve(); }));
        const second = q.run(async () => { order.push("mark"); });
        const renewal = q.run(async () => { order.push("renew"); }, { priority: true });
        await within(entered.promise, "first real queue function is running and held");
        try { expect(q.inFlight).toBe(1); } finally { releaseFirst(); }
        await Promise.all([first, second, renewal]);
        expect(order).toEqual(["claim", "renew", "mark"]);
        expect(q.peak).toBe(1);
    });

    it("a live pump plus finalize never holds more than one steering connection for the turn", async () => {
        const sessionId = randomUUID();
        await catalog.createSession(sessionId, { model: "m" });
        const submitted = Promise.withResolvers();
        let activeCalls = 0;
        let peakCalls = 0;
        let submittedCount = 0;
        const observedCalls = [];
        const observedCatalog = new Proxy(catalog, {
            get(target, key) {
                const value = Reflect.get(target, key, target);
                if (typeof value !== "function") return value;
                if (!String(key).startsWith("steer")) return value.bind(target);
                return async (...args) => {
                    activeCalls++;
                    peakCalls = Math.max(peakCalls, activeCalls);
                    observedCalls.push(key);
                    try {
                        const result = await value.apply(target, args);
                        if (key === "steerMarkSubmitted" && ++submittedCount === 3) submitted.resolve();
                        return result;
                    } finally { activeCalls--; }
                };
            },
        });
        const turn = await SteeringTurn.create({
            catalog: observedCatalog, sessionId, turnKey: randomUUID(), transcriptEpoch: 0, turnIndex: 0,
            sessionRow: { owner: null }, featureCache: { resolve: () => ({ enabled: true }) },
        });
        const channel = turn.newChannel();
        const handlers = new Map();
        const session = { on: (type, fn) => { handlers.set(type, fn); return () => handlers.delete(type); },
            send: async () => {
                const id = `sdk-${randomUUID()}`;
                handlers.get("user.message")({ type: "user.message", data: { messageId: id, delivery: "steering" } });
                return id;
            }, getEvents: async () => [] };
        const pump = new SteeringPump(session, channel, {
            stopping: () => false, turnBoundaryScheduled: () => false, quiesceWarmSession: async () => true,
            scanMs: 5, renewMs: 5, settleMs: 200,
        });
        try {
            handlers.get("user.message")({ type: "user.message", data: { messageId: "main" } });
            pump.noteMainPrompt("main");
            await until(() => pump.gate.isOpen, 5_000, "the gate");
            const target = channel.target;
            for (let i = 0; i < 3; i++) {
                const text = `g${i}`;
                await catalog.steerAccept({ sessionId, requestId: `steer_${randomUUID()}`, idempotencyKey: randomUUID(),
                    actor: alice, content: text, contentHash: steeringContentHash(text), ...target });
            }
            await within(submitted.promise, "all three actual write-ahead and submitted procedures complete");
            handlers.get("session.idle")({ type: "session.idle", data: {} });
            const manifest = await pump.settle({ stopping: false });
            expect(manifest.delivered).toHaveLength(3);
            await turn.finalize("published", manifest, 1);
            expect(observedCalls).toContain("steerTurnFinalize");
            expect(submittedCount).toBe(3);
            expect(peakCalls).toBe(1, "observe actual catalog procedure entries, not only a queue's self-reported peak");
            expect(activeCalls).toBe(0);
            expect(turn.callQueue.peak).toBe(1);
        } finally {
            handlers.get("session.idle")?.({ type: "session.idle", data: {} });
            await pump.settle({ stopping: false });
            pump.dispose();
        }
    });
});

describe("F18: steering support is detected through a procedure", () => {
    it("supportsSteering calls cms_steer_capabilities; without it the schema reports no support", async () => {
        expect(await catalog.supportsSteering()).toBe(true);
        const other = `ps_test_steer_caps_${randomUUID().replaceAll("-", "")}`;
        const probe = await PgSessionCatalog.create(url, other);
        try {
            await probe.initialize();
            expect(await probe.supportsSteering()).toBe(true);
            await pool.query(`DROP FUNCTION "${other}".cms_steer_capabilities()`);
            const fresh = await PgSessionCatalog.create(url, other);
            try {
                expect(await fresh.supportsSteering()).toBe(false);
            } finally {
                await fresh.close();
            }
        } finally {
            await probe.close();
            await pool.query(`DROP SCHEMA IF EXISTS "${other}" CASCADE`);
        }
    });
});

describe("Stop label survives the cancellation path", () => {
    it("a cancelled turn's finalize records inclusion but leaves the closure to Stop", async () => {
        const { sessionId, target, owner, requestId } = await seededClaim(12);
        const attemptId = await catalog.steerMarkSubmitting(requestId, owner);
        await catalog.steerMarkSubmitted(attemptId, owner, "sdk-c");
        await catalog.steerWindowQuiesce(sessionId, owner);
        expect(await catalog.steerTurnFinalize(sessionId, target, owner, "unpublished", [requestId], null, { close: false }))
            .toEqual({ finalized: false, reason: "left_open", inclusionUpdated: 1 });
        expect(await catalog.steerGet(sessionId, requestId)).toMatchObject({ status: "submitted", inclusion: { state: "not_included" } });
        await catalog.recordEvents(sessionId, [{ eventType: "session.turn_stopped", data: { turnIndex: target.turnIndex } }]);
        expect(await catalog.steerGet(sessionId, requestId)).toMatchObject({
            status: "closed", closureReason: "stopped", disposition: "delivery_unconfirmed", inclusion: { state: "not_included" } });
    });

    it("finalize without the flag still closes as before", async () => {
        const { sessionId, target, owner, requestId } = await seededClaim(13);
        expect(await catalog.steerTurnFinalize(sessionId, target, owner, "published", [], 1)).toEqual({ finalized: true });
        expect((await catalog.steerGet(sessionId, requestId)).closureReason).toBe("turn_ended");
    });
});
