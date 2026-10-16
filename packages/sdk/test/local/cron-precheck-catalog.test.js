/**
 * Migration 0084 publishes `sessions.cron_precheck_skip` exactly as the code
 * defines it, Off and operator-controlled; the cluster setting reaches the
 * worker cache.
 *
 * Needs PostgreSQL: PS_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgSessionCatalog } from "../../src/cms.ts";
import { FEATURE_FLAGS } from "../../src/feature-flags.ts";
import { FeatureFlagCache } from "../../src/feature-flag-cache.ts";
import { CRON_PRECHECK_SKIP_FEATURE, cronPrecheckSkipEnforced } from "../../src/cron-precheck.ts";

const key = CRON_PRECHECK_SKIP_FEATURE;
const schema = `ps_test_cron_precheck_${randomUUID().replaceAll("-", "")}`;
const url = process.env.PS_TEST_DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/pilotswarm";
const pool = new pg.Pool({ connectionString: url, max: 2 });
const admin = { principal: { provider: "test", subject: "admin" }, isAdmin: true };
const alice = { principal: { provider: "test", subject: "alice" }, isAdmin: false };
let catalog;

beforeAll(async () => {
    catalog = await PgSessionCatalog.create(url, schema);
    await catalog.initialize();
    for (const viewer of [admin, alice]) await catalog.setUserProfileSettings(viewer.principal, {});
});

afterAll(async () => {
    await catalog?.close();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
});

describe("cron precheck skip flag catalog", () => {
    it("publishes the code definition with an Off cluster setting and no user override", async () => {
        const snapshot = await catalog.features.snapshot([key]);
        expect(snapshot.definitions).toEqual([{ featureKey: key, ...FEATURE_FLAGS[key], revision: "1" }]);
        const settings = (await pool.query(`
            SELECT scope, user_id, enabled, allow_user_override, revision, updated_by
            FROM "${schema}".feature_flag_settings WHERE feature_key = $1`, [key])).rows;
        expect(settings).toEqual([{
            scope: "cluster", user_id: null, enabled: false, allow_user_override: false,
            revision: "1", updated_by: "migration:0084",
        }]);
    });

    it("is idempotent when initialization is repeated", async () => {
        await catalog.initialize();
        const { rows } = await pool.query(
            `SELECT count(*)::int AS n FROM "${schema}".feature_flag_settings WHERE feature_key = $1`, [key]);
        expect(rows[0].n).toBe(1);
    });

    it("enforces only after the operator turns the cluster setting on", async () => {
        const cache = new FeatureFlagCache(catalog.features);
        await cache.pollRevisionsAndRefresh();
        expect(cronPrecheckSkipEnforced(cache, alice.principal)).toBe(false);

        const current = (await catalog.features.revisions()).find((row) => row.featureKey === key);
        await catalog.features.mutate(admin, "cluster", {
            featureKey: key, expectedRevision: current.revision, requestId: randomUUID(), enabled: true, allowUserOverride: false,
        });
        await cache.pollRevisionsAndRefresh();
        expect(cronPrecheckSkipEnforced(cache, alice.principal)).toBe(true);
        expect(cronPrecheckSkipEnforced(cache, null)).toBe(true);
        await cache.stop();
    });
});
