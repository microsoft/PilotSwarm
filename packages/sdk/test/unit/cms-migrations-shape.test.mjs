/**
 * Migration-shape invariants for the CMS registry — pure, no database.
 *
 * Guards the class of bug fixed by 0028: a session read path whose column
 * set silently diverges from the canonical cms_list_sessions shape. The
 * paged list (cms_list_sessions_page) originally returned SETOF sessions —
 * no owner columns — so every paged row reached clients with owner: null
 * and the UI rendered "?" initials.
 *
 * Run: node --test test/unit/cms-migrations-shape.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("released 0091 bytes stay approval-only; 0099 admits Decision interceptions before provider identity", () => {
    const m91 = migrations.find(migration => migration.version === "0091");
    const m99 = migrations.find(migration => migration.version === "0099");
    assert.ok(m91 && m99);
    assert.equal(createHash("sha256").update(m91.sql).digest("hex"),
        "09d88207d0a4b8c97dc82c05898cade5e91efd3889ea242596f154eb318d3698");
    assert.match(m91.sql, /CHECK \(operation IN \([^)]*approval[^)]*\)\)/);
    assert.doesNotMatch(m91.sql, /CHECK \(operation IN [^)]*decision/);
    assert.match(m99.sql, /CHECK \(operation IN \([^)]*decision[^)]*approval[^)]*\)\)/);
    assert.ok(migrations.filter(migration => migration.version < "0099").every(migration =>
        !/CHECK \(operation IN [^)]*decision/.test(migration.sql)));
});

test("the Decision-era and Workflow rerun migrations 0096-0104 quote-escape the schema name; 0098's SQL is unchanged for a plain name", () => {
    const quoted = CMS_MIGRATIONS('pilot"swarm').filter(migration => migration.version >= "0096" && migration.version <= "0104");
    assert.deepEqual(quoted.map(migration => migration.version), ["0096", "0097", "0098", "0099", "0100", "0101", "0102", "0103", "0104"]);
    for (const migration of quoted) {
        const text = migration.sql ?? migration.steps.join("\n");
        assert.ok(text.includes('"pilot""swarm".'), `${migration.version} must write the schema as "pilot""swarm"`);
        assert.ok(!text.includes('"pilot"swarm"'), `${migration.version} must not write the schema name unescaped`);
    }
    const m98 = migrations.find(migration => migration.version === "0098");
    assert.equal(createHash("sha256").update(m98.sql).digest("hex"),
        "8652d2f979958aea2f2e18b8f00f3ef660ec71516a55e45960d3f76e3cf48441");
    const m104 = migrations.find(migration => migration.version === "0104");
    assert.ok(m104, "migration 0104 must be registered");
    assert.equal(m104.name, "workflow_rerun");
    assert.ok(Array.isArray(m104.steps) && m104.steps.length === 5, "0104 must use separate steps for NOT VALID, VALIDATE, and CONCURRENTLY indexes");
    assert.match(m104.steps[0], /ADD CONSTRAINT workflow_runs_rerun_check CHECK \([\s\S]*?\) NOT VALID;/);
    assert.match(m104.steps[0], /ADD CONSTRAINT workflow_node_executions_reused_check CHECK \([\s\S]*?\) NOT VALID;/);
    assert.doesNotMatch(m104.steps[0], /VALIDATE CONSTRAINT/, "step 0 must release ACCESS EXCLUSIVE before VALIDATE");
    assert.match(m104.steps[1], /ALTER TABLE "shape_check"\.workflow_runs VALIDATE CONSTRAINT workflow_runs_rerun_check;/);
    assert.match(m104.steps[2], /ALTER TABLE "shape_check"\.workflow_node_executions VALIDATE CONSTRAINT workflow_node_executions_reused_check;/);
    assert.match(m104.steps[3], /CREATE INDEX CONCURRENTLY IF NOT EXISTS workflow_runs_by_rerun_of_run/);
    assert.match(m104.steps[4], /CREATE INDEX CONCURRENTLY IF NOT EXISTS workflow_runs_by_rerun_of_workflow/);
});

// Extract the RETURNS TABLE column list of a named function from a SQL blob.
// Matches the LAST definition in the blob (later migrations win).
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
    // Strip `--` comment lines before asserting: the migration's own header
    // comment legitimately mentions the old "RETURNS SETOF sessions" shape.
    const code = sql.split("\n").filter((ln) => !ln.trimStart().startsWith("--")).join("\n");
    assert.doesNotMatch(code, /RETURNS SETOF/, "paged list must not regress to SETOF sessions");
});
