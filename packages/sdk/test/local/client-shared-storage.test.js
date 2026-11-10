/**
 * Batch 7 (n-5): a worker's activities and turns make a PilotSwarmClient per call or per turn. Started on the worker's
 * own duroxide provider, session catalog and fact store (_startOnShared), such a client opens no pools of its own, its
 * queries share the worker's, and stop() leaves the worker's catalog and fact store open. A client started without
 * them (tests, SQLite) starts as before.
 * CI run 115 (HorizonDB): counting every connection to the shared database also counted other suites' (28 against 27).
 * This file's pools take a name of their own (PGAPPNAME: node-postgres uses it when a pool names none), and only those
 * are counted, once the worker's pools have idled back (10 s).
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { useSuiteEnv } from "../helpers/local-env.js";
import { PgSessionCatalog } from "../../src/cms.ts";
import { PilotSwarmClient } from "../../src/client.ts";

const { PostgresProvider } = createRequire(import.meta.url)("duroxide");
const getEnv = useSuiteEnv(import.meta.url);
const TIMEOUT = 60_000;

async function connections(pool, appName) {
    return Number((await pool.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1", [appName])).rows[0].n);
}

describe("a client started on a worker's own storage", () => {
    it("opens no pools of its own, and stopping it leaves the worker's catalog and fact store open", { timeout: TIMEOUT }, async () => {
        const env = getEnv();
        const appName = `client-shared-storage-${randomUUID().slice(0, 8)}`;
        const priorAppName = process.env.PGAPPNAME;
        process.env.PGAPPNAME = appName;
        const catalog = await PgSessionCatalog.create(env.store, env.cmsSchema);
        await catalog.initialize();
        const provider = await PostgresProvider.connectWithSchema(env.store, env.duroxideSchema);
        let factsClosed = 0;
        const factStore = { close: async () => { factsClosed += 1; } };
        const probe = new pg.Pool({ connectionString: env.store, max: 1, application_name: `${appName}-probe` });
        try {
            // Warm the worker's own pools, as a running worker's are.
            await catalog.listSessions();
            const before = await connections(probe, appName);

            // A status turn's clients: two reads and a listing, each its own client, as a worker makes them.
            for (let i = 0; i < 3; i += 1) {
                const client = new PilotSwarmClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema });
                await client._startOnShared({ provider, catalog, factStore });
                expect(client._catalog).toBe(catalog);
                expect(client._factStore).toBe(factStore);
                await client.listSessions();
                await client.stop();
            }
            let after = await connections(probe, appName);
            for (let waited = 0; after > before && waited < 15_000; waited += 250) {
                await new Promise(resolve => setTimeout(resolve, 250));
                after = await connections(probe, appName);
            }
            expect(after).toBeLessThanOrEqual(before);
            // The worker's catalog still answers, and its fact store was not closed.
            await catalog.listSessions();
            expect(factsClosed).toBe(0);

            // Started twice is started once.
            const twice = new PilotSwarmClient({ store: env.store, duroxideSchema: env.duroxideSchema, cmsSchema: env.cmsSchema, factsSchema: env.factsSchema });
            await twice._startOnShared({ provider, catalog, factStore });
            await twice._startOnShared({ provider, catalog: null, factStore: null });
            expect(twice._catalog).toBe(catalog);
            await twice.stop();
            expect(factsClosed).toBe(0);
        } finally {
            await probe.end();
            await catalog.close();
            if (priorAppName === undefined) delete process.env.PGAPPNAME;
            else process.env.PGAPPNAME = priorAppName;
        }
    });
});
