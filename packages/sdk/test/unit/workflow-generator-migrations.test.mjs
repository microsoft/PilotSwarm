import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";

const migrations = CMS_MIGRATIONS("workflow_generator_test");
const migration = migrations.find((entry) => entry.version === "0083");
const acknowledgementMigration = migrations.find((entry) => entry.version === "0084");
const cleanupMigration = migrations.find((entry) => entry.version === "0090");
const cutoverMigration = migrations.find((entry) => entry.version === "0095");
const sharedIdentityCutoverMigration = migrations.find((entry) => entry.version === "0096");
const neutralRunContractMigration = migrations.find((entry) => entry.version === "0097");
const computeAffinityMigration = migrations.find((entry) => entry.version === "0098");
const versionCollisionCompatibilityMigration = migrations.find((entry) => entry.version === "0099");
const executionAffinityMigration = migrations.find((entry) => entry.version === "0100");

test("WorkflowGenerator migration defines durable aggregate and history tables", () => {
    assert.ok(migration);
    assert.equal(migration.name, "workflow_generators");
    for (const table of [
        "workflow_generators",
        "workflow_definitions",
        "workflow_generator_cycles",
        "workflow_runs",
        "workflow_run_producers",
        "workflow_run_sessions",
    ]) {
        assert.match(migration.sql, new RegExp(`CREATE TABLE IF NOT EXISTS \"workflow_generator_test\"\\.${table}`));
    }
});

test("Workflow Run identity is shared across producers and Definition versions", () => {
    assert.match(migration.sql, /workflow_type\s+TEXT NOT NULL/);
    assert.match(migration.sql, /producer_type\s+TEXT NOT NULL/);
    assert.match(migration.sql, /workflow_run_producers/);
    assert.ok(cleanupMigration);
    assert.match(cleanupMigration.sql, /uq_workflow_runs_active_type_key/);
    assert.match(cleanupMigration.sql, /workflow_type, workflow_run_key/);
    assert.match(cleanupMigration.sql, /WHERE deleted_at IS NULL/);
    assert.doesNotMatch(migration.sql, /uq_workflow_runs_direct_idempotency/);
    assert.doesNotMatch(migration.sql, /uq_workflow_runs_generator_source/);
    assert.match(migration.sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_run_sessions_one_current/);
    assert.match(migration.sql, /WHERE is_current/);
    assert.match(migration.sql, /session_id\s+TEXT NOT NULL UNIQUE/);
    assert.match(migration.sql, /UNIQUE \(workflow_run_id, ordinal\)/);
    assert.match(migration.sql, /effective_config\s+JSONB NOT NULL/);
    assert.match(migration.sql, /induction_lease_owner\s+TEXT/);
    assert.match(migration.sql, /induction_lease_expires_at\s+TIMESTAMPTZ/);
});

test("Workflow Definitions are independently owned, versioned, and immutable", () => {
    const definitionTable = migration.sql.match(/CREATE TABLE IF NOT EXISTS "workflow_generator_test"\.workflow_definitions \(([\s\S]*?)\n\);/)?.[1] ?? "";
    assert.doesNotMatch(definitionTable, /workflow_generator_id/);
    assert.doesNotMatch(definitionTable, /source_type|source_config/);
    assert.match(migration.sql, /owner_provider\s+TEXT NOT NULL/);
    assert.match(migration.sql, /definition_hash\s+TEXT NOT NULL/);
    assert.match(migration.sql, /UNIQUE \(workflow_type, version\)/);
    assert.match(migration.sql, /UNIQUE \(workflow_type, definition_hash\)/);
    assert.match(migration.sql, /workflow_generators[\s\S]*source_type\s+TEXT/);
    assert.match(migration.sql, /workflow_generators[\s\S]*source_config\s+JSONB NOT NULL/);
    assert.match(migration.sql, /FOREIGN KEY \(active_workflow_definition_id\)[\s\S]*workflow_definitions/);
    assert.match(migration.sql, /WORKFLOW_GENERATOR_DEFINITION_IMMUTABLE/);
    assert.match(migration.sql, /BEFORE UPDATE ON "workflow_generator_test"\.workflow_definitions/);
});

test("WorkflowRun session acknowledgement distinguishes queued from worker-active sessions", () => {
    assert.ok(acknowledgementMigration);
    assert.equal(acknowledgementMigration.name, "workflow_run_session_acknowledgement");
    assert.match(acknowledgementMigration.sql, /'reserved', 'unacked', 'active', 'failed', 'replaced'/);
});

test("Workflow terminology cutover recreates only the workflow subsystem", () => {
    assert.ok(cutoverMigration);
    assert.equal(cutoverMigration.name, "workflow_terminology_cutover");
    for (const table of [
        "workflow_run_waits",
        "workflow_run_external_operations",
        "workflow_run_journal_entries",
        "workflow_run_state_runs",
        "workflow_run_sessions",
        "workflow_run_producers",
        "workflow_runs",
        "workflow_run_cleanup_tombstones",
        "workflow_generator_cycles",
        "workflow_definitions",
        "workflow_generators",
        "job_waits",
        "job_external_operations",
        "job_journal_entries",
        "job_state_runs",
        "job_sessions",
        "jobs",
        "job_cleanup_tombstones",
        "job_generator_cycles",
        "job_generator_definitions",
        "job_generators",
    ]) {
        assert.match(cutoverMigration.sql, new RegExp(`"workflow_generator_test"\\.${table}`));
    }
    assert.match(
        cutoverMigration.sql,
        /CREATE TABLE IF NOT EXISTS "workflow_generator_test"\.workflow_generators/,
    );
});

test("shared identity upgrades preserve existing workflow state", () => {
    assert.ok(sharedIdentityCutoverMigration);
    assert.equal(sharedIdentityCutoverMigration.name, "shared_workflow_run_identity");
    assert.notEqual(sharedIdentityCutoverMigration.sql, cutoverMigration.sql);
    assert.doesNotMatch(sharedIdentityCutoverMigration.sql, /DROP TABLE/i);
    assert.match(sharedIdentityCutoverMigration.sql, /ADD COLUMN IF NOT EXISTS workflow_type TEXT/i);
    assert.match(sharedIdentityCutoverMigration.sql, /legacy-generator:/i);
    assert.match(sharedIdentityCutoverMigration.sql, /CREATE TABLE IF NOT EXISTS .*workflow_run_producers/is);
    assert.match(sharedIdentityCutoverMigration.sql, /INSERT INTO .*workflow_run_producers/is);
    assert.match(sharedIdentityCutoverMigration.sql, /ALTER COLUMN workflow_generator_id DROP NOT NULL/i);
    assert.match(sharedIdentityCutoverMigration.sql, /uq_workflow_runs_active_type_key/i);
});

test("neutral Workflow Run contract remains additive", () => {
    assert.ok(neutralRunContractMigration);
    assert.equal(neutralRunContractMigration.name, "neutral_workflow_run_contract");
    assert.doesNotMatch(neutralRunContractMigration.sql, /DROP TABLE/i);
    assert.match(neutralRunContractMigration.sql, /RENAME COLUMN source_payload TO input/i);
    assert.match(neutralRunContractMigration.sql, /DROP COLUMN IF EXISTS producer_type/i);
    assert.match(cutoverMigration.sql, /CREATE TABLE IF NOT EXISTS "workflow_generator_test"\.workflow_runs/);
});

test("Workflow compute affinities are nullable and constrained", () => {
    assert.ok(computeAffinityMigration);
    assert.equal(computeAffinityMigration.name, "workflow_compute_affinity");
    assert.match(
        computeAffinityMigration.sql,
        /ADD COLUMN IF NOT EXISTS controller_compute_affinity TEXT/,
    );
    assert.match(
        computeAffinityMigration.sql,
        /ADD COLUMN IF NOT EXISTS session_compute_affinity TEXT/,
    );
    assert.match(
        computeAffinityMigration.sql,
        /controller_compute_affinity IS NULL[\s\S]*IN \('cluster', 'devbox'\)/,
    );
    assert.match(
        computeAffinityMigration.sql,
        /session_compute_affinity IS NULL[\s\S]*IN \('cluster', 'devbox'\)/,
    );
});

test("feature-parent 0096 collision is detected and repaired additively", () => {
    assert.ok(versionCollisionCompatibilityMigration);
    assert.equal(
        versionCollisionCompatibilityMigration.name,
        "workflow_0096_collision_compatibility",
    );
    assert.match(
        versionCollisionCompatibilityMigration.sql,
        /version = '0096'[\s\S]*name = 'workflow_generator_compute_affinity'/,
    );
    assert.match(
        versionCollisionCompatibilityMigration.sql,
        /column_name = 'workflow_generator_id'/,
    );
    assert.match(
        versionCollisionCompatibilityMigration.sql,
        /ADD COLUMN IF NOT EXISTS workflow_type TEXT/,
    );
    assert.match(
        versionCollisionCompatibilityMigration.sql,
        /RENAME COLUMN source_payload TO input/,
    );
    assert.match(
        versionCollisionCompatibilityMigration.sql,
        /ADD COLUMN IF NOT EXISTS controller_compute_affinity TEXT/,
    );
});

test("Workflow Runs persist a private execution-affinity principal", () => {
    assert.ok(executionAffinityMigration);
    assert.equal(executionAffinityMigration.name, "workflow_run_execution_affinity");
    assert.match(
        executionAffinityMigration.sql,
        /ADD COLUMN IF NOT EXISTS execution_affinity_provider TEXT/,
    );
    assert.match(
        executionAffinityMigration.sql,
        /producer_type = 'direct_request'/,
    );
    assert.match(
        executionAffinityMigration.sql,
        /generator\.owner_provider/,
    );
    assert.match(
        executionAffinityMigration.sql,
        /ALTER COLUMN execution_affinity_provider SET NOT NULL/,
    );
});

test("catalog querying adds stable indexes and filtered Session paging", () => {
    const migration = migrations.find((entry) => entry.name === "catalog_query_pages");
    assert.ok(migration);
    assert.match(migration.sql, /ix_workflow_generators_catalog_updated/);
    assert.match(migration.sql, /ix_workflow_runs_catalog_updated/);
    assert.match(migration.sql, /p_owner_query\s+TEXT/);
    assert.match(migration.sql, /p_status\s+TEXT/);
    assert.match(migration.sql, /p_updated_after\s+TIMESTAMPTZ/);
    assert.match(
        migration.sql,
        /DROP FUNCTION IF EXISTS [\s\S]*cms_list_sessions_page\([\s\S]*p_system_filter/s,
    );
    assert.match(migration.sql, /date_trunc\('milliseconds', sess\.updated_at\)/);
    assert.match(migration.sql, /sess\.session_id < p_cursor_session_id/);
});

test("controller placement is filtered inside the locked claim query", async () => {
    const cmsSource = await readFile(new URL("../../dist/cms.js", import.meta.url), "utf8");
    assert.match(
        cmsSource,
        /WITH due AS \([\s\S]*controller_compute_affinity = \$4[\s\S]*FOR UPDATE SKIP LOCKED[\s\S]*LIMIT \$2/,
    );
});
