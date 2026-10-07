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
import { createCmsSteeringChannel } from "../../src/steering-channel.ts";
import { SteeringPump } from "../../src/steering-pump.ts";
import { SessionManager } from "../../src/session-manager.ts";

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

/** Backends of this test database waiting on a lock that is not granted. */
async function waitingBackends() {
    const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
          WHERE NOT l.granted AND a.datname = current_database()`);
    return rows[0].n;
}

describe("F02: Stop closure and hand-off take locks in one order", () => {
    it("a hand-off that starts while closure holds request rows waits instead of deadlocking (no 40P01)", async () => {
        const { sessionId, target, owner, requestId } = await seededClaim(4);
        const stop = new pg.Client({ connectionString: url });
        await stop.connect();
        try {
            // Connection A: the prefix of terminal closure — session advisory lock, then the request row.
            await stop.query("BEGIN");
            await stop.query(`SELECT "${schema}".cms_steer_lock_session($1)`, [sessionId]);
            await stop.query(`SELECT 1 FROM "${schema}".session_steering_requests WHERE request_id = $1 FOR UPDATE`, [requestId]);
            // Connection B: the real hand-off procedure, started while A holds those locks.
            const before = await waitingBackends();
            const handoff = catalog.steerMarkSubmitting(requestId, owner).then(
                (v) => ({ ok: true, v }), (err) => ({ ok: false, err }));
            await until(async () => (await waitingBackends()) > before, 5_000, "the hand-off to block on a lock");
            // A finishes the real closure (requests, then the window) and commits.
            await stop.query(`SELECT "${schema}".cms_steer_close_stopped($1, $2)`, [sessionId, target.turnIndex]);
            await stop.query("COMMIT");
            const result = await handoff;
            expect(result.ok, `hand-off failed: ${result.err?.code} ${result.err?.message}`).toBe(true);
            expect(result.v).toBeNull();                                       // window closed: no write-ahead
            const receipt = await catalog.steerGet(sessionId, requestId);
            expect(receipt).toMatchObject({ status: "closed", disposition: "not_delivered_turn_stopped", attempts: { total: 0 } });
        } finally {
            await stop.query("ROLLBACK").catch(() => {});
            await stop.end();
        }
    });

    it("claim also waits behind closure's advisory lock and then finds no open window", async () => {
        const { sessionId, target, owner } = await seededClaim(5);
        const text = "second";
        await catalog.steerAccept({ sessionId, requestId: `steer_${randomUUID()}`, idempotencyKey: randomUUID(),
            actor: alice, content: text, contentHash: steeringContentHash(text), ...target });
        const stop = new pg.Client({ connectionString: url });
        await stop.connect();
        try {
            await stop.query("BEGIN");
            await stop.query(`SELECT "${schema}".cms_steer_lock_session($1)`, [sessionId]);
            const before = await waitingBackends();
            const claim = catalog.steerClaim(sessionId, owner, 5);
            await until(async () => (await waitingBackends()) > before, 5_000, "the claim to block");
            await stop.query(`SELECT "${schema}".cms_steer_close_stopped($1, $2)`, [sessionId, target.turnIndex]);
            await stop.query("COMMIT");
            expect(await claim).toEqual([]);
        } finally {
            await stop.query("ROLLBACK").catch(() => {});
            await stop.end();
        }
    });
});

describe("F03: the final hand-off fence checks the lease", () => {
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
        const claimHeld = new Promise((r) => { releaseClaim = r; });
        let markCalls = 0;
        const channel = {
            ...real,
            renew: () => new Promise(() => {}),                                   // held renewal: never answers
            claim: async (limit) => { const rows = await real.claim(limit); if (rows.length) await claimHeld; return rows; },
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
            await until(async () => {
                const { rows } = await pool.query(`SELECT lease_expires_at < clock_timestamp() AS expired
                    FROM "${schema}".session_steering_windows WHERE session_id = $1`, [sessionId]);
                return rows[0]?.expired === true;
            }, 5_000, "the database lease to expire");
            releaseClaim();
            await sleep(100);
            expect(sends).toEqual([]);
            const receipt = await catalog.steerGet(sessionId, accepted.receipt.requestId);
            expect(receipt.attempts.total).toBe(0);
            expect(markCalls).toBe(0);                                        // the local lease deadline stopped it first
        } finally {
            releaseClaim();
            handlers.get("session.idle")?.({ type: "session.idle", data: {} });
            await pump.settle({ stopping: false });
            pump.dispose();
        }
    });
});

describe("F04: steering quiescence cleanup is generation-safe", () => {
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

    it("a late completion of a timed-out cleanup does not remove the replacement handle", async () => {
        const m = manager();
        let finishOld;
        const old = handle("old", function () { return new Promise((r) => { finishOld = () => { this.destroyed = true; r(); }; }); });
        m.sessions.set("s1", old);
        m.sessionAgentCopies.set("s1", { tag: "old-copy" });
        m.sessionBindingFingerprints.set("s1", "old-fp");

        // The pump's bounded quiescence gives up (deadline); the manager call keeps running.
        const late = m.quiesceForSteering("s1");
        const outcome = await Promise.race([late, sleep(30).then(() => "deadline")]);
        expect(outcome).toBe("deadline");

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
