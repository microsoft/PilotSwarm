/**
 * Migration 0081 publishes `debug.enable_model_event_logging` exactly as the
 * code defines it, with an Off cluster setting that users may override, and
 * a user's own setting reaches the worker cache.
 *
 * Needs PostgreSQL: PS_TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgSessionCatalog } from "../../src/cms.ts";
import { FEATURE_FLAGS } from "../../src/feature-flags.ts";
import { FeatureFlagCache } from "../../src/feature-flag-cache.ts";
import { MODEL_EVENT_LOGGING_FEATURE, modelEventLoggingEnabled } from "../../src/model-event-logging.ts";

const key = MODEL_EVENT_LOGGING_FEATURE;
const schema = `ps_test_model_events_${randomUUID().replaceAll("-", "")}`;
const url = process.env.PS_TEST_DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/pilotswarm";
const pool = new pg.Pool({ connectionString: url, max: 2 });
const alice = { principal: { provider: "test", subject: "alice" }, isAdmin: false };
const bob = { principal: { provider: "test", subject: "bob" }, isAdmin: false };
let catalog;

beforeAll(async () => {
    catalog = await PgSessionCatalog.create(url, schema);
    await catalog.initialize();
    for (const viewer of [alice, bob]) await catalog.setUserProfileSettings(viewer.principal, {});
});

afterAll(async () => {
    await catalog?.close();
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
});

describe("model event logging catalog", () => {
    it("publishes the code definition with an Off cluster setting users may override", async () => {
        const snapshot = await catalog.features.snapshot([key]);
        expect(snapshot.definitions).toEqual([{ featureKey: key, ...FEATURE_FLAGS[key], revision: "1" }]);
        const settings = (await pool.query(`
            SELECT scope, user_id, enabled, allow_user_override, revision, updated_by
            FROM "${schema}".feature_flag_settings WHERE feature_key = $1`, [key])).rows;
        expect(settings).toEqual([{
            scope: "cluster", user_id: null, enabled: false, allow_user_override: true,
            revision: "1", updated_by: "migration:0081",
        }]);
    });

    it("is idempotent when initialization is repeated", async () => {
        await catalog.initialize();
        const { rows } = await pool.query(
            `SELECT count(*)::int AS n FROM "${schema}".feature_flag_settings WHERE feature_key = $1`, [key]);
        expect(rows[0].n).toBe(1);
    });

    it("turns on for one person through their own setting", async () => {
        const cache = new FeatureFlagCache(catalog.features);
        await cache.pollRevisionsAndRefresh();
        expect(modelEventLoggingEnabled(cache, alice.principal)).toBe(false);

        await catalog.features.mutate(alice, "user", { featureKey: key, expectedRevision: "1", requestId: randomUUID(), enabled: true });
        await cache.pollRevisionsAndRefresh();
        expect(modelEventLoggingEnabled(cache, alice.principal)).toBe(true);
        expect(modelEventLoggingEnabled(cache, bob.principal)).toBe(false);
        expect(modelEventLoggingEnabled(cache, null)).toBe(false);
        await cache.stop();
    });
});
