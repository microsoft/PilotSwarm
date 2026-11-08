/**
 * CMS Schema Migrator — thin wrapper over the shared pg-migrator.
 *
 * @module
 */

import { runMigrations, type MigrationLedgerMove } from "./pg-migrator.js";
import { CMS_MIGRATIONS } from "./cms-migrations.js";

export type { MigrationEntry } from "./pg-migrator.js";

const CMS_LOCK_SEED = 0x63_6D_73; // "cms"

/**
 * Run all pending CMS migrations against the given schema.
 *
 * @param pool   - node-postgres pool
 * @param schema - target schema name (e.g. "copilot_sessions")
 */
export async function runCmsMigrations(pool: any, schema: string): Promise<void> {
    const migrations = CMS_MIGRATIONS(schema);
    await runMigrations(pool, schema, migrations, CMS_LOCK_SEED, { ledgerMoves: cmsLedgerMoves(migrations) });
}

/**
 * The workflow migrations a database may have applied under their earlier numbers (adversarial review RT-1): before
 * main's MOTD migrations took 0084-0087, the workflow migrations now at 0088-0105 were 0084-0101. A ledger that records
 * them there is moved to the new numbers (by version and name) before anything runs, so the MOTD migrations run and
 * nothing is applied twice.
 */
export function cmsLedgerMoves(migrations: ReadonlyArray<{ version: string; name: string }>): MigrationLedgerMove[] {
    const moves: MigrationLedgerMove[] = [];
    for (const migration of migrations) {
        const number = Number(migration.version);
        if (number < 88 || number > 105) continue;
        moves.push({ name: migration.name, from: String(number - 4).padStart(4, "0"), to: migration.version });
    }
    return moves;
}
