import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { createTestEnv } from "./local-env.js";
import { createCatalog } from "./cms-helpers.js";

export const STEER_AUTHOR = Object.freeze({ provider: "test", subject: "steer-author", displayName: "Author" });
export const STEER_OTHER = Object.freeze({ provider: "test", subject: "steer-other", displayName: "Other writer" });
export const STEER_LIMITS = Object.freeze({
    maxBytes: 16_384, perSessionPerMinute: 30, perActorPerMinute: 60, maxUnresolved: 5,
});

/** Real procedures and isolated PostgreSQL state; no steering behavior is faked. */
export async function withSteeringLedger(fn) {
    const env = createTestEnv("steering-ledger");
    const catalog = await createCatalog(env);
    const pool = new pg.Pool({ connectionString: env.store, max: 4 });
    const schema = `"${env.cmsSchema}"`;
    const sessionId = randomUUID();
    const target = { epoch: 0, turn: 1, incarnation: "snapshot-turn-1", owner: randomUUID() };
    const query = (sql, args = []) => pool.query(sql, args);
    const proc = async (name, args) => {
        if (!/^cms_steer_[a-z_]+$/.test(name)) throw new Error(`Not a steering procedure: ${name}`);
        const placeholders = args.map((_, i) => `$${i + 1}`).join(",");
        const { rows } = await query(`SELECT ${schema}.${name}(${placeholders}) AS result`, args);
        return rows[0].result;
    };
    const open = (over = {}) => {
        const t = { ...target, ...over };
        return proc("cms_steer_window_open", [t.sessionId ?? sessionId, t.epoch, t.turn, t.incarnation, t.owner, t.leaseMs ?? 10_000]);
    };
    const accept = async (over = {}) => {
        const t = { ...target, ...over };
        const input = {
            requestId: randomUUID(), idempotencyKey: randomUUID(), actor: STEER_AUTHOR,
            content: "Use the new constraint", limits: STEER_LIMITS, ...over,
        };
        const hash = createHash("sha256").update(input.content).digest("hex");
        const result = await proc("cms_steer_accept", [
            input.sessionId ?? sessionId, input.requestId, input.idempotencyKey, input.actor,
            input.content, hash, t.epoch, t.turn, t.incarnation, input.limits,
        ]);
        return { ...input, result };
    };
    const request = async (id) => {
        const { rows } = await query(`SELECT * FROM ${schema}.session_steering_requests WHERE request_id=$1`, [id]);
        return rows[0] ?? null;
    };
    const requests = async (id = sessionId) => {
        const { rows } = await query(`SELECT * FROM ${schema}.session_steering_requests WHERE session_id=$1 ORDER BY seq`, [id]);
        return rows;
    };
    const attempts = async (id) => {
        const { rows } = await query(`SELECT * FROM ${schema}.session_steering_attempts WHERE request_id=$1 ORDER BY submitting_at,attempt_id`, [id]);
        return rows;
    };
    const submitting = async (id, owner = target.owner) => {
        await proc("cms_steer_mark_submitting", [id, owner]);
        const rows = await attempts(id);
        if (rows.length !== 1) throw new Error(`Expected one write-ahead attempt, found ${rows.length}`);
        return rows[0].attempt_id;
    };
    const finalize = (over = {}) => {
        const t = { ...target, ...over };
        return proc("cms_steer_turn_finalize", [
            sessionId, t.epoch, t.turn, t.incarnation, t.owner,
            t.outcome ?? "unpublished", t.manifest ?? null, t.snapshotVersion ?? null,
        ]);
    };
    try {
        await catalog.createSession(sessionId, { owner: STEER_AUTHOR });
        await catalog.updateSession(sessionId, { state: "running" });
        await fn({ env, catalog, pool, schema, query, proc, sessionId, target, open, accept, request, requests, attempts, submitting, finalize });
    } finally {
        await pool.end();
        await catalog.close();
        await env.cleanup();
    }
}

export function deliveredManifest(requestId, attemptId, sdkMessageId, kind = "steering") {
    return [{ requestId, attemptId, sdkMessageId, kind }];
}
