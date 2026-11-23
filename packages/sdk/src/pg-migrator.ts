/**
 * Shared PostgreSQL Schema Migrator — versioned SQL migrations with advisory locks.
 *
 * Extracted from the CMS-specific migrator so that both the CMS and Facts
 * schemas can reuse the same ordered, transactional migration runner.
 *
 * @module
 */

// Poll interval while waiting for the advisory migration lock (ms).
const LOCK_POLL_INTERVAL_MS = 100;

// A migration's session settings end with it. One connection runs every pending
// migration and then goes back to the pool, and CMS migrations 0036 and 0070 run
// a session-level `SET lock_timeout = '5s'`. Kept, that limit cut short 0088's
// CREATE INDEX CONCURRENTLY, which waits for every older transaction in the
// database, and every later catalog query on the pooled connection. The runner
// reads the connection's settings before the first migration, including any its
// pool's connect hook set, and puts back each one a migration changed (RESET ALL
// would also drop the hook's). Per-transaction settings (transaction_isolation
// and the like) cannot be set outside their transaction and do not outlive it.
const READ_SESSION_SETTINGS =
    "SELECT name, setting FROM pg_settings WHERE context IN ('user', 'superuser') AND name NOT LIKE 'transaction\\_%'";
const RESTORE_SESSION_SETTINGS =
    "SELECT set_config(b.name, b.setting, false) FROM unnest($1::text[], $2::text[]) AS b(name, setting) "
    + "JOIN pg_settings AS s ON s.name = b.name WHERE s.setting IS DISTINCT FROM b.setting";

interface MigrationEntryBase {
    version: string;
    name: string;
}

export type MigrationEntry = MigrationEntryBase & (
    | {
        /** Transactional SQL run inside one BEGIN/COMMIT block. */
        sql: string;
        steps?: never;
    }
    | {
        /**
         * Non-transactional, individually autocommitted SQL statements.
         * Every step must be idempotent: partial success leaves the version
         * unrecorded and the next run starts again from step one.
         */
        steps: string[];
        sql?: never;
    }
);

/** Validate migration definitions before acquiring a connection or lock. */
export function validateMigrationEntries(migrations: MigrationEntry[]): void {
    const versions = new Set<string>();
    for (const migration of migrations as Array<MigrationEntry & { sql?: unknown; steps?: unknown }>) {
        const label = migration?.version ? `Migration ${migration.version}` : "Migration entry";
        if (!migration || typeof migration.version !== "string" || !migration.version.trim()) {
            throw new Error(`${label} requires a non-empty version`);
        }
        if (versions.has(migration.version)) {
            throw new Error(`Duplicate migration version: ${migration.version}`);
        }
        versions.add(migration.version);
        if (typeof migration.name !== "string" || !migration.name.trim()) {
            throw new Error(`${label} requires a non-empty name`);
        }

        const hasSql = typeof migration.sql === "string";
        const hasSteps = Array.isArray(migration.steps);
        if (hasSql === hasSteps) {
            throw new Error(`${label} must define exactly one execution mode: sql or steps`);
        }
        if (hasSql && !migration.sql!.trim()) {
            throw new Error(`${label} sql must be non-empty`);
        }
        if (hasSteps) {
            if (migration.steps!.length === 0) {
                throw new Error(`${label} steps must contain at least one statement`);
            }
            if (migration.steps!.some((step) => typeof step !== "string" || !step.trim())) {
                throw new Error(`${label} steps must contain only non-empty SQL strings`);
            }
        }
    }
}

/**
 * Run all pending migrations against the given schema.
 *
 * Uses a PostgreSQL advisory lock keyed on `lockSeed` + schema name to
 * serialize concurrent workers. Each migration runs in its own transaction
 * (or as autocommit steps — see MigrationEntry.steps).
 *
 * @param pool      - node-postgres pool
 * @param schema    - target schema name (e.g. "copilot_sessions", "pilotswarm_facts")
 * @param migrations - ordered list of migrations to apply
 * @param lockSeed  - unique seed per system so different schemas don't block each other
 */
export async function runMigrations(
    pool: any,
    schema: string,
    migrations: MigrationEntry[],
    lockSeed: number,
): Promise<void> {
    validateMigrationEntries(migrations);
    const lockKey = hashSchemaName(schema, lockSeed);
    const client = await pool.connect();
    // Review CI-114: a ROLLBACK or the unlock that fails (HorizonDB answered a ROLLBACK after a lock timeout with a server
    // error) leaves this connection in an aborted transaction, and maybe still holding the migration lock. It is then
    // discarded, never handed back to the pool, so no later query gets it and its session lock goes with it.
    let unusable: unknown = null;
    const rollback = () => client.query("ROLLBACK").catch((error: unknown) => { unusable ??= error; });
    let restoreSettings: (() => Promise<unknown>) | null = null;
    try {
        // Acquire the migration lock by POLLING pg_try_advisory_lock rather
        // than blocking on pg_advisory_lock. A worker blocked inside
        // pg_advisory_lock holds an open transaction for the entire wait, and
        // CREATE INDEX CONCURRENTLY (used by hardened migrations such as CMS
        // 0029) waits for every concurrent transaction to finish — so the lock
        // holder's CIC and the blocked waiter deadlock. Polling lets a waiter
        // sleep with NO open transaction between attempts, so the holder's CIC
        // can complete. Same session-level lock, released by pg_advisory_unlock.
        for (;;) {
            const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [lockKey]);
            if (rows[0]?.locked === true) break;
            await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
        }

        const { rows: settings } = await client.query(READ_SESSION_SETTINGS);
        const settingNames = (settings ?? []).map((row: any) => row.name);
        const settingValues = (settings ?? []).map((row: any) => row.setting);
        restoreSettings = () => client.query(RESTORE_SESSION_SETTINGS, [settingNames, settingValues]);

        await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

        const migrationsTable = `"${schema}".schema_migrations`;
        await client.query(`
            CREATE TABLE IF NOT EXISTS ${migrationsTable} (
                version     TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        const { rows: applied } = await client.query(
            `SELECT version FROM ${migrationsTable} ORDER BY version`,
        );
        const appliedSet = new Set(applied.map((r: any) => r.version));

        for (const migration of migrations) {
            if (appliedSet.has(migration.version)) continue;

            if (migration.steps) {
                // Autocommit path: no BEGIN wrapper. On a mid-way failure the
                // version stays unrecorded and the (idempotent) steps re-run
                // on the next attempt.
                for (const step of migration.steps) {
                    try {
                        await client.query(step);
                    } catch (err) {
                        // A failed step can leave the connection inside an
                        // aborted explicit transaction (a step's own BEGIN);
                        // roll it back so the pooled connection stays usable.
                        await rollback();
                        throw err;
                    }
                }
                await client.query(
                    `INSERT INTO ${migrationsTable} (version, name) VALUES ($1, $2)`,
                    [migration.version, migration.name],
                );
                await restoreSettings();
                continue;
            }

            try {
                await client.query("BEGIN");
                await client.query(migration.sql);
                await client.query(
                    `INSERT INTO ${migrationsTable} (version, name) VALUES ($1, $2)`,
                    [migration.version, migration.name],
                );
                await client.query("COMMIT");
            } catch (err) {
                await rollback();
                throw err;
            }
            await restoreSettings();
        }
    } finally {
        if (unusable === null && restoreSettings) {
            await restoreSettings().catch((error: unknown) => { unusable = error; });
        }
        if (unusable === null) {
            await client.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch((error: unknown) => { unusable = error; });
        }
        // node-postgres: release(error) closes the connection instead of returning it to the pool.
        client.release(unusable === null ? undefined : (unusable instanceof Error ? unusable : new Error(String(unusable))));
    }
}

/** Stable 32-bit hash of a schema name combined with a per-system seed. */
function hashSchemaName(schema: string, seed: number): number {
    let hash = seed;
    for (let i = 0; i < schema.length; i++) {
        hash = ((hash << 5) - hash + schema.charCodeAt(i)) | 0;
    }
    return hash;
}
