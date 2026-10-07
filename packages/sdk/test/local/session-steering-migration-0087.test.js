/**
 * Session steering migrations: a fresh install (…→0087) and an upgrade from the state where
 * 0086 was already applied (the deployed test environment) end with the same steering
 * functions; 8-argument finalize callers (older workers) still resolve after the upgrade.
 *
 * Needs PostgreSQL: PS_TEST_DATABASE_URL (or TEST_DATABASE_URL / DATABASE_URL).
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { CMS_MIGRATIONS } from "../../src/cms-migrations.ts";
import { runMigrations } from "../../src/pg-migrator.ts";
import { PgSessionCatalog } from "../../src/cms.ts";
import { steeringContentHash } from "../../src/steering.ts";

const url = process.env.PS_TEST_DATABASE_URL || process.env.TEST_DATABASE_URL || process.env.DATABASE_URL
    || "postgres://postgres:postgres@localhost:5432/pilotswarm";
const CMS_LOCK_SEED = 0x63_6D_73;
const pool = new pg.Pool({ connectionString: url, max: 3 });
const schemas = [];
const newSchema = (tag) => { const s = `ps87_${tag}_${randomUUID().replaceAll("-", "")}`; schemas.push(s); return s; };

afterAll(async () => {
    for (const s of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
    await pool.end();
});

/** Every steering function with its identity arguments and body, schema name normalized. */
async function steeringFunctions(schema) {
    const { rows } = await pool.query(`
        SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, pg_get_functiondef(p.oid) AS def
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND (p.proname LIKE 'cms_steer%' OR p.proname IN ('cms_record_events', 'cms_update_session',
               'cms_soft_delete_session', 'cms_feature_mutate_gated'))
         ORDER BY 1, 2`, [schema]);
    const norm = (text) => text.split(`"${schema}"`).join("SCHEMA").split(schema).join("SCHEMA");
    return rows.map((r) => ({ name: r.proname, args: norm(r.args), def: norm(r.def) }));
}

describe.concurrent("steering migrations 0086 → 0087", () => {
    it("fresh install and upgrade-from-0086 produce identical steering functions", { timeout: 120_000 }, async () => {
        const fresh = newSchema("fresh");
        await runMigrations(pool, fresh, CMS_MIGRATIONS(fresh), CMS_LOCK_SEED);

        const upgraded = newSchema("upg");
        const upTo0086 = CMS_MIGRATIONS(upgraded).filter((m) => m.version <= "0086");
        expect(upTo0086.at(-1).version).toBe("0086");
        await runMigrations(pool, upgraded, upTo0086, CMS_LOCK_SEED);
        const applied0086 = (await pool.query(`SELECT applied_at FROM "${upgraded}".schema_migrations WHERE version='0086'`)).rows[0].applied_at;
        const before = await steeringFunctions(upgraded);
        expect(before.filter((f) => f.name === "cms_steer_turn_finalize").map((f) => f.args))
            .toEqual(["p_session_id text, p_epoch integer, p_turn integer, p_incarnation text, p_owner text, p_outcome text, p_manifest text[], p_snapshot_version integer"]);
        await runMigrations(pool, upgraded, CMS_MIGRATIONS(upgraded), CMS_LOCK_SEED);   // applies 0087 only

        const a = await steeringFunctions(fresh);
        const b = await steeringFunctions(upgraded);
        expect(b.map((f) => `${f.name}(${f.args})`)).toEqual(a.map((f) => `${f.name}(${f.args})`));
        const differing = a.filter((f, i) => f.def !== b[i].def).map((f) => `${f.name}(${f.args})`);
        if (differing.length) {
            const i = a.findIndex((f, j) => f.def !== b[j].def);
            const la = a[i].def.split("\n"), lb = b[i].def.split("\n");
            const k = la.findIndex((l, j) => l !== lb[j]);
            console.log("DIFF", differing, "\nfresh:", la[k], "\nupgraded:", lb[k]);
        }
        expect(differing).toEqual([]);
        expect(a.filter((f) => f.name === "cms_steer_turn_finalize").map((f) => f.args))
            .toEqual(["p_session_id text, p_epoch integer, p_turn integer, p_incarnation text, p_owner text, p_outcome text, p_manifest text[], p_snapshot_version integer, p_close boolean"]);
        const { rows } = await pool.query(`SELECT version FROM "${upgraded}".schema_migrations ORDER BY version DESC LIMIT 1`);
        expect(rows).toHaveLength(1);
        expect(rows[0].version).toBe("0087");
        expect((await pool.query(`SELECT applied_at FROM "${upgraded}".schema_migrations WHERE version='0086'`)).rows[0].applied_at).toEqual(applied0086);
        await runMigrations(pool, upgraded, CMS_MIGRATIONS(upgraded), CMS_LOCK_SEED);
        expect(await steeringFunctions(upgraded)).toEqual(b);
        expect((await pool.query(`SELECT count(*)::int AS n FROM "${upgraded}".schema_migrations WHERE version='0087'`)).rows[0].n).toBe(1);
    });

    it("after the upgrade an 8-argument finalize (older worker) still resolves and closes", { timeout: 120_000 }, async () => {
        const schema = newSchema("call");
        const catalog = await PgSessionCatalog.create(url, schema);
        try {
            await runMigrations(pool, schema, CMS_MIGRATIONS(schema).filter(m => m.version <= "0086"), CMS_LOCK_SEED);
            const beforeUpgrade = (await steeringFunctions(schema)).find(f => f.name === "cms_steer_turn_finalize");
            expect(beforeUpgrade.args).not.toContain("p_close");
            await catalog.initialize();
            const sid = randomUUID();
            await catalog.createSession(sid, { model: "m" });
            const target = { epoch: 0, turnIndex: 0, incarnation: randomUUID() };
            const owner = randomUUID();
            await catalog.steerWindowOpen(sid, target, owner, 10_000);
            const { rows } = await pool.query(
                `SELECT "${schema}".cms_steer_turn_finalize($1,$2,$3,$4,$5,$6,$7::text[],$8) AS v`,
                [sid, 0, 0, target.incarnation, owner, "published", [], 1]);
            expect(rows[0].v).toEqual({ finalized: true });
            expect((await catalog.steerState(sid)).window).toBeNull();
        } finally {
            await catalog.close();
        }
    });

    for (const upgraded of [false, true]) it(`${upgraded ? "existing0086 ledger upgrade" : "fresh0087 install"} preserves receipts and separates inclusion-only cancellation from Stop closure`, { timeout: 120_000 }, async () => {
        const schema = newSchema(upgraded ? "data_upg" : "data_fresh");
        const catalog = await PgSessionCatalog.create(url, schema);
        try {
            if (upgraded) await runMigrations(pool, schema, CMS_MIGRATIONS(schema).filter(m => m.version <= "0086"), CMS_LOCK_SEED);
            else await catalog.initialize();
            const sessionId = randomUUID();
            const target = { epoch: 0, turnIndex: 1, incarnation: randomUUID() };
            const owner = randomUUID();
            await catalog.createSession(sessionId);
            await catalog.steerWindowOpen(sessionId, target, owner, 10_000);
            const actor = { provider: "test", subject: randomUUID() };
            const requests = [];
            for (const text of ["delivered guidance", "pending guidance"]) {
                const accepted = await catalog.steerAccept({ sessionId, ...target, actor, content: text,
                    contentHash: steeringContentHash(text), requestId: randomUUID(), idempotencyKey: randomUUID() });
                expect(accepted.outcome).toBe("accepted");
                requests.push(accepted.receipt.requestId);
            }
            const [claimed] = await catalog.steerClaim(sessionId, owner, 1);
            expect(claimed.requestId).toBe(requests[0]);
            const attemptId = await catalog.steerMarkSubmitting(requests[0], owner);
            await catalog.steerMarkSubmitted(attemptId, owner, "sdk-before-upgrade");
            await catalog.steerMarkDelivered(attemptId, "sdk-before-upgrade", "queued");
            const before = await Promise.all(requests.map(id => catalog.steerGet(sessionId, id)));
            if (upgraded) await catalog.initialize();
            expect(await Promise.all(requests.map(id => catalog.steerGet(sessionId, id)))).toEqual(before);
            const result = await catalog.steerTurnFinalize(sessionId, target, owner, "published", [requests[0]], 7, { close: false });
            expect(result).toMatchObject({ finalized: false, reason: "left_open", inclusionUpdated: 2 });
            expect((await catalog.steerState(sessionId)).window.state).toBe("open");
            const delivered = await catalog.steerGet(sessionId, requests[0]);
            expect(delivered).toMatchObject({ status: "delivered", disposition: "delivered_after_response",
                inclusion: { state: "included", snapshotVersion: 7 }, attempts: { total: 1 } });
            expect((await catalog.steerGet(sessionId, requests[1])).status).toBe("pending");
            await catalog.steerCloseStopped(sessionId, 1);
            expect(await catalog.steerGet(sessionId, requests[0])).toMatchObject({ status: "closed", disposition: "delivered_before_stop",
                closureReason: "stopped", inclusion: { state: "included", snapshotVersion: 7 } });
            expect(await catalog.steerGet(sessionId, requests[1])).toMatchObject({ status: "closed", disposition: "not_delivered_turn_stopped" });
        } finally { await catalog.close(); }
    });
});
