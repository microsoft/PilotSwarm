/**
 * Migration-shape invariants for the CMS registry — pure, no database.
 *
 * Guards the class of bug fixed by 0028: a session read path whose column
 * set silently diverges from the canonical cms_list_sessions shape.
 *
 * Run: node --test test/unit/cms-migrations-shape.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";

const SCHEMA = "shape_check";
const migrations = CMS_MIGRATIONS(SCHEMA);

test("registry is strictly ordered and includes 0028_list_sessions_page_owner", () => {
    const versions = migrations.map((m) => m.version);
    assert.deepEqual([...versions].sort(), versions, "versions must sort lexicographically");
    assert.equal(new Set(versions).size, versions.length, "versions must be unique");
    const m28 = migrations.find((m) => m.version === "0028");
    assert.ok(m28, "migration 0028 must be registered");
    assert.equal(m28.name, "list_sessions_page_owner");
});

function returnsTableColumns(sql, fnName) {
    const re = new RegExp(
        `CREATE (?:OR REPLACE )?FUNCTION "${SCHEMA}"\\.${fnName}\\s*\\([^;]*?\\)\\s*RETURNS TABLE\\s*\\(([^;]*?)\\)\\s*AS`,
        "gs",
    );
    let cols = null;
    for (const m of sql.matchAll(re)) {
        cols = m[1]
            .split(",")
            .map((line) => line.trim().split(/\s+/)[0])
            .filter(Boolean);
    }
    return cols;
}

test("0028: paged list column set matches the canonical cms_list_sessions shape", () => {
    const allSql = migrations.map((m) => m.sql).join("\n");
    const listCols = returnsTableColumns(allSql, "cms_list_sessions");
    const pageCols = returnsTableColumns(allSql, "cms_list_sessions_page");
    assert.ok(listCols?.length, "cms_list_sessions RETURNS TABLE columns must parse");
    assert.ok(pageCols?.length, "cms_list_sessions_page RETURNS TABLE columns must parse");
    assert.deepEqual(
        pageCols,
        listCols,
        "cms_list_sessions_page must return exactly the cms_list_sessions columns " +
        "(same names, same order) so rowToSessionRow treats both paths identically. " +
        "If you added a session column, recreate BOTH functions in your migration.",
    );
    for (const col of ["owner_provider", "owner_subject", "owner_email", "owner_display_name"]) {
        assert.ok(pageCols.includes(col), `paged list must carry ${col}`);
    }
});

test("0028: drops the old SETOF signature and joins owners", () => {
    const sql = migrations.find((m) => m.version === "0028").sql;
    assert.match(sql, /DROP FUNCTION IF EXISTS "shape_check"\.cms_list_sessions_page\(/,
        "return-shape change requires DROP before CREATE");
    assert.match(sql, /LEFT JOIN "shape_check"\.session_owners/, "must join session_owners");
    assert.match(sql, /LEFT JOIN "shape_check"\.users/, "must join users");
    const code = sql.split("\n").filter((ln) => !ln.trimStart().startsWith("--")).join("\n");
    assert.doesNotMatch(code, /RETURNS SETOF/, "paged list must not regress to SETOF sessions");
});

test("0089: stable worker identities refresh owner and routing registration", () => {
    const migration = migrations.find((m) => m.version === "0089");
    assert.ok(migration, "migration 0089 must be registered");
    assert.equal(migration.name, "worker_registration_refresh");
    assert.match(migration.sql, /owner_provider = EXCLUDED\.owner_provider/);
    assert.match(migration.sql, /owner_subject = EXCLUDED\.owner_subject/);
    assert.match(migration.sql, /info = EXCLUDED\.info/);
});

test("0090: sessions persist an immutable routing contract", () => {
    const migration = migrations.find((m) => m.version === "0090");
    assert.ok(migration, "migration 0090 must be registered");
    assert.equal(migration.name, "session_routing_contract");
    assert.match(migration.sql, /ADD COLUMN IF NOT EXISTS routing_config JSONB/);
    assert.match(migration.sql, /jsonb_typeof\(routing_config\) = 'object'/);
});

test("0091: WorkflowRuns use logical deletion with durable cleanup tombstones", () => {
    const migration = migrations.find((m) => m.version === "0091");
    assert.ok(migration, "migration 0091 must be registered");
    assert.equal(migration.name, "workflow_run_cleanup_tombstones");
    assert.match(migration.sql, /ALTER TABLE "shape_check"\.workflow_generators\s+ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ/i);
    assert.match(migration.sql, /ALTER TABLE "shape_check"\.workflow_runs\s+ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ/i);
    assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS "shape_check"\.workflow_run_cleanup_tombstones/i);
    assert.match(migration.sql, /PRIMARY KEY \(aggregate_type, aggregate_id\)/i);
});

test("0092: WorkflowRun waits use one durable taxonomy with response fencing", () => {
    const migration = migrations.find((m) => m.version === "0092");
    assert.ok(migration, "migration 0092 must be registered");
    assert.equal(migration.name, "workflow_run_waits");
    assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS "shape_check"\.workflow_run_waits/i);
    assert.match(migration.sql, /kind IN \('response', 'observed_condition', 'timer'\)/i);
    assert.match(migration.sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_workflow_run_waits_pending_response/i);
});

test("0093: observed-condition waits persist scheduling leases and delivery boundaries", () => {
    const migration = migrations.find((m) => m.version === "0093");
    assert.ok(migration, "migration 0093 must be registered");
    assert.equal(migration.name, "workflow_run_wait_scheduling");
    assert.match(migration.sql, /ADD COLUMN IF NOT EXISTS signal_key TEXT/i);
    assert.match(migration.sql, /ADD COLUMN IF NOT EXISTS check_lease_owner TEXT/i);
    assert.match(migration.sql, /CREATE INDEX IF NOT EXISTS ix_workflow_run_waits_check_lease/i);
});

test("0095: WorkflowGenerator source providers use opaque identifiers", () => {
    const migration = migrations.find((m) => m.version === "0095");
    assert.ok(migration, "migration 0095 must be registered");
    assert.equal(migration.name, "workflow_generator_source_provider_ids");
    assert.match(migration.sql, /DROP CONSTRAINT IF EXISTS workflow_generators_source_type_check/i);
    assert.match(
        migration.sql,
        /CHECK \(source_type IS NULL OR source_type ~ '\^\[a-z\]\[a-z0-9\._-\]\{0,127\}\$'\)/i,
    );
    assert.doesNotMatch(migration.sql, /CHECK\s*\(\s*source_type\s+IN\s*\(/i);
});

test("0104: workflow sessions are additive and existing rows remain agent sessions", () => {
    const migration = migrations.find((m) => m.version === "0104");
    assert.ok(migration, "migration 0104 must be registered");
    assert.equal(migration.name, "workflow_session_kind");
    assert.match(migration.sql, /ADD COLUMN IF NOT EXISTS session_kind TEXT NOT NULL DEFAULT 'agent'/);
    assert.match(migration.sql, /CHECK \(session_kind IN \('agent', 'workflow'\)\)/);
});

test("0105: workflow facts are authoritative and lifecycle events are transactional", () => {
    const migration = migrations.find((m) => m.version === "0105");
    assert.ok(migration, "migration 0105 must be registered");
    assert.equal(migration.name, "workflow_executions");
    assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS "shape_check"\.workflow_state_executions/);
    assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS "shape_check"\.workflow_projections/);
    assert.match(migration.sql, /CREATE OR REPLACE FUNCTION "shape_check"\.cms_complete_workflow/);
});

test("0106: workflow definitions retain source and normalized compiled manifests", () => {
    const migration = migrations.find((m) => m.version === "0106");
    assert.ok(migration, "migration 0106 must be registered");
    assert.equal(migration.name, "workflow_definitions");
    assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS "shape_check"\.workflow_definitions/);
    assert.match(migration.sql, /package_artifact_filename TEXT NOT NULL/);
    assert.match(migration.sql, /CREATE OR REPLACE FUNCTION "shape_check"\.cms_register_workflow_definition/);
});

test("0107: workflow admission atomically enforces logical and request idempotency", () => {
    const migration = migrations.find((m) => m.version === "0107");
    assert.ok(migration, "migration 0107 must be registered");
    assert.equal(migration.name, "workflow_admissions");
    assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS "shape_check"\.workflow_admissions/);
    assert.match(migration.sql, /CREATE TABLE IF NOT EXISTS "shape_check"\.workflow_admission_requests/);
    assert.match(migration.sql, /CREATE OR REPLACE FUNCTION "shape_check"\.cms_admit_workflow/);
    assert.match(migration.sql, /WORKFLOW_IDEMPOTENCY_CONFLICT/);
});
