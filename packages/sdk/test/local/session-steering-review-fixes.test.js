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
import { within } from "../helpers/steering-cli.mjs";

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
