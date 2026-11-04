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
 * A migration recorded in a ledger under an earlier version number (adversarial review RT-1): the migration `name`
 * once applied as version `from` is now version `to`.
 */
export interface MigrationLedgerMove {
    name: string;
    from: string;
    to: string;
}

/**
 * Which of `moves` a ledger needs, from what it records (`recorded`, every version and name), or why it cannot be
 * reconciled. A move applies when its old version is recorded under its name and that version now holds another
 * migration. Within the versions the moves touch, every recorded row must be the migration now at that version or one
 * of the moved migrations at its old version; a migration recorded at both its old and its new version, or a target
 * held by another migration that is not moved away, is ambiguous. Elsewhere the ledger is not looked at. Pure.
 */
export function planMigrationLedgerMoves(recorded: ReadonlyArray<{ version: string; name: string }>, migrations: MigrationEntry[],
    moves: readonly MigrationLedgerMove[]): { moves: MigrationLedgerMove[]; error: string | null } {
    const byVersion = new Map(recorded.map(row => [row.version, row.name]));
    const current = new Map(migrations.map(migration => [migration.version, migration.name]));
    const legacyAt = new Map(moves.map(move => [move.from, move.name]));
    const touched = new Set(moves.flatMap(move => [move.from, move.to]));
    for (const version of touched) {
        const name = byVersion.get(version);
        if (name === undefined || name === current.get(version) || name === legacyAt.get(version)) continue;
        return { moves: [], error: `version ${version} is recorded as '${name}', which is neither '${current.get(version) ?? "(none)"}' nor an earlier number of a moved migration` };
    }
    const due = moves.filter(move => byVersion.get(move.from) === move.name && current.get(move.from) !== move.name);
    const freed = new Set(due.map(move => move.from));
    for (const move of due) {
        const target = byVersion.get(move.to);
        if (target === undefined || freed.has(move.to)) continue;
        return { moves: [], error: target === move.name
            ? `'${move.name}' is recorded at both ${move.from} and ${move.to}`
            : `'${move.name}' cannot move from ${move.from} to ${move.to}, which is recorded as '${target}'` };
    }
    return { moves: due, error: null };
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
    options: { ledgerMoves?: readonly MigrationLedgerMove[] } = {},
): Promise<void> {
    validateMigrationEntries(migrations);
    const lockKey = hashSchemaName(schema, lockSeed);
    const client = await pool.connect();
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

        await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

        const migrationsTable = `"${schema}".schema_migrations`;
        await client.query(`
            CREATE TABLE IF NOT EXISTS ${migrationsTable} (
                version     TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        `);

        // RT-1: migrations renumbered after a database applied them are moved to their new numbers first, under this
        // lock and in one transaction, by version and name; an ambiguous ledger stops the start.
        if (options.ledgerMoves?.length) {
            const { rows: recorded } = await client.query(`SELECT version, name FROM ${migrationsTable}`);
            const plan = planMigrationLedgerMoves(recorded, migrations, options.ledgerMoves);
            if (plan.error) throw new Error(`The migration ledger of schema ${schema} cannot be reconciled: ${plan.error}.`);
            if (plan.moves.length > 0) {
                try {
                    await client.query("BEGIN");
                    for (const move of plan.moves) {
                        await client.query(`UPDATE ${migrationsTable} SET version = $1 WHERE version = $2 AND name = $3`,
                            [`moving:${move.from}`, move.from, move.name]);
                    }
                    for (const move of plan.moves) {
                        await client.query(`UPDATE ${migrationsTable} SET version = $1 WHERE version = $2 AND name = $3`,
                            [move.to, `moving:${move.from}`, move.name]);
                    }
                    await client.query("COMMIT");
                } catch (err) {
                    await client.query("ROLLBACK").catch(() => {});
                    throw err;
                }
            }
        }

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
                        await client.query("ROLLBACK").catch(() => {});
                        throw err;
                    }
                }
                await client.query(
                    `INSERT INTO ${migrationsTable} (version, name) VALUES ($1, $2)`,
                    [migration.version, migration.name],
                );
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
                await client.query("ROLLBACK").catch(() => {});
                throw err;
            }
        }
    } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch(() => {});
        client.release();
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
