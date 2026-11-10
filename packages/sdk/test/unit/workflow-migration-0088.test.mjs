/**
 * Migration 0088 (workflow): the Workflow migration after main's 0087 creates the Workflow schema; 0089 then renames its
 *   owner-side objects (workflow-migration-0089.test.js).
 * - It is registered once, right after 0087 and before 0089, as three idempotent steps: everything but the index in one transaction, then the drop of
 *   an invalid parent_session_id index under a lock timeout, then the index built concurrently.
 * - What it adds to the existing sessions table (two columns, a check, two triggers) is added only when missing, so a run
 *   again takes no lock on sessions; nothing in it drops or rewrites a table, a column or a row.
 * - The chat-ended trigger (S2RT-F2, S2RT-F6) takes its locks in the runtime's order (the chat, then its Workflow
 *   sessions in session_id order, then their runs in run_id order, then their nodes), ends test runs as well as live
 *   ones, and clears a cancelled run's paused_from.
 * workflow-migration-0088.test.js runs it on PostgreSQL: a fresh create, a run again, and its index steps.
 *
 * Run: node --test test/unit/workflow-migration-0088.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";
import { workflowMigration } from "../../dist/migrations/workflow-0088.js";
import { sessionPairLockOrder } from "../../dist/workflow/store.js";

const flat = (sql) => sql.replace(/\s+/g, " ");
const [objects, dropLeftover, buildIndex] = workflowMigration("s");
const chatEnded = () => {
    const sql = flat(objects);
    return sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION "s".workflow_on_chat_ended()'), sql.indexOf("$$ LANGUAGE plpgsql; DO $sessions_triggers$"));
};

test("the Workflow migration, 0088, registered after main's 0087 and before 0089, as three steps", () => {
    const list = CMS_MIGRATIONS("s");
    const at = list.findIndex(item => item.version === "0088");
    assert.deepEqual(list[at], { version: "0088", name: "workflow", steps: workflowMigration("s") });
    assert.equal(list[at - 1].version, "0087");
    assert.deepEqual(list.slice(at + 1).map(item => [item.version, item.name]), [["0089", "workflow_session_names"]]);
    assert.deepEqual(list.filter(item => /workflow|0111|parent_session/.test(item.name)).map(item => item.version), ["0088", "0089"]);
    assert.equal(workflowMigration("s").length, 3);
    assert.match(objects, /^\s*-- 0088_workflow[^\n]*\nBEGIN;\n/);
    assert.match(objects, /\nCOMMIT;\n\s*$/);
    assert.match(flat(dropLeftover), /BEGIN; SET LOCAL lock_timeout = '5s';.*AND NOT i\.indisvalid.*DROP INDEX "s"\.idx_s_sessions_parent.*COMMIT;/);
    assert.match(flat(buildIndex), /^ ?-- [^\n]* CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_s_sessions_parent ON "s"\.sessions\(parent_session_id\); ?$/);
});

test("it creates, never drops or rewrites: no intermediate shape, no data step", () => {
    const sql = flat(workflowMigration("s").join("\n"));
    for (const absent of [/DROP TABLE/, /DROP COLUMN/, /DROP CONSTRAINT/, /DROP FUNCTION/, /RENAME/, /ALTER COLUMN/, /INSERT INTO "s"\.workflow/,
        /UPDATE "s"\.workflow_\w+ d\b/, /DELETE FROM/, /CREATE TEMP/, /LOCK TABLE/, /imported-/]) {
        assert.doesNotMatch(sql, absent);
    }
    // Every table is created once and only if missing; triggers on Workflow tables are replaced, functions are replaced.
    assert.equal((sql.match(/CREATE TABLE /g) ?? []).length, (sql.match(/CREATE TABLE IF NOT EXISTS /g) ?? []).length);
    assert.equal((sql.match(/CREATE TABLE IF NOT EXISTS /g) ?? []).length, 23);
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION /g) ?? []).length, 8);
});

test("what it adds to sessions it adds only when the catalog lacks it, so a run again takes no lock on sessions", () => {
    const sql = flat(objects);
    // No bare ALTER TABLE or trigger statement on sessions: each sits in a DO block behind a catalog check.
    const bare = sql.replace(/DO \$sessions\$.*?\$sessions\$;/, "").replace(/DO \$sessions_triggers\$.*?\$sessions_triggers\$;/, "");
    assert.doesNotMatch(bare, /ALTER TABLE "s"\.sessions/);
    assert.doesNotMatch(bare, /TRIGGER \w+ (BEFORE|AFTER) [^;]* ON "s"\.sessions/);
    assert.doesNotMatch(bare, /DROP TRIGGER IF EXISTS \w+ ON "s"\.sessions/);
    for (const column of ["session_kind", "workflow_ref"]) {
        assert.match(sql, new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM pg_attribute WHERE attrelid = '"s"\\.sessions'::regclass AND attname = '${column}' AND NOT attisdropped\\) THEN ALTER TABLE "s"\\.sessions ADD COLUMN ${column} `));
    }
    assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conrelid = '"s"\.sessions'::regclass AND conname = 'sessions_session_kind_check'\) THEN/);
    for (const trigger of ["workflow_session_deleted", "workflow_chat_ended"]) {
        assert.match(sql, new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM pg_trigger WHERE tgrelid = '"s"\\.sessions'::regclass AND tgname = '${trigger}'\\) THEN CREATE TRIGGER ${trigger} `));
    }
});

test("S2RT-F2: an ended chat locks its Workflow sessions, then their runs, before it changes a node, a run or a session", () => {
    const sql = chatEnded();
    const ended = sql.slice(sql.indexOf("ELSIF NEW.state IN"));
    const sessions = ended.indexOf("ORDER BY session_id FOR NO KEY UPDATE");
    const runs = ended.indexOf("ORDER BY run.run_id FOR UPDATE OF run");
    const nodes = ended.indexOf('UPDATE "s".workflow_node_executions');
    const endRuns = ended.indexOf('UPDATE "s".workflow_runs');
    const endSessions = ended.lastIndexOf('UPDATE "s".sessions');
    assert.ok(sessions > 0 && sessions < runs && runs < nodes && nodes < endRuns && endRuns < endSessions,
        JSON.stringify({ sessions, runs, nodes, endRuns, endSessions }));
    // A deleted chat: its definitions, then its Workflow sessions in order, then their soft delete.
    const deleted = sql.slice(sql.indexOf("IF NEW.deleted_at IS NOT NULL"), sql.indexOf("ELSIF"));
    const definitions = deleted.indexOf('UPDATE "s".workflow_chat_definitions');
    const lock = deleted.indexOf("ORDER BY session_id FOR NO KEY UPDATE");
    const soft = deleted.indexOf('UPDATE "s".sessions SET deleted_at');
    assert.ok(definitions >= 0 && definitions < lock && lock < soft, JSON.stringify({ definitions, lock, soft }));
});

test("S2RT-F6: an ended chat ends its test runs (its hidden test benches) as well as its live runs", () => {
    const ended = chatEnded().split("ELSIF")[1];
    assert.equal((ended.match(/run\.mode IN \('live', 'test'\)/g) ?? []).length, 3);
    assert.doesNotMatch(ended, /run\.mode = 'live'/);
});

test("S2RT-F2: a Workflow and its own parent chat are locked chat first; any other pair in ascending session id order", () => {
    assert.deepEqual(sessionPairLockOrder("w-1", "z-chat", "z-chat"), ["z-chat", "w-1"]);
    assert.deepEqual(sessionPairLockOrder("w-9", "a-chat", "a-chat"), ["a-chat", "w-9"]);
    assert.deepEqual(sessionPairLockOrder("w-1", "z-other", "a-chat"), ["w-1", "z-other"]);
    assert.deepEqual(sessionPairLockOrder("w-9", "a-other", null), ["a-other", "w-9"]);
    assert.deepEqual(sessionPairLockOrder("w-1", "w-1", "a-chat"), ["w-1"]);
});

// The executor's run at ea596f23: a chat that ended while its Workflow's run was paused broke the check
// workflow_runs_paused_from ((status = 'paused') = (paused_from IS NOT NULL)) when the run was cancelled with paused_from
// left set. The chat's own update failed with it.
test("a paused run that an ended chat cancels has its paused_from cleared, as the deletion trigger does", () => {
    const ended = chatEnded().split("ELSIF")[1];
    assert.match(ended, /UPDATE "s"\.workflow_runs AS run SET status = 'cancelled', paused_from = NULL,/);
    assert.match(flat(objects), /UPDATE "s"\.workflow_runs SET status = 'cancelled', paused_from = NULL, terminal_error = v_envelope/);
});

test("a run's agent models (OF-S2-7) are one nullable TEXT column", () => {
    assert.match(flat(objects), / agent_models TEXT, FOREIGN KEY \(workflow_session_id, revision\)/);
});
