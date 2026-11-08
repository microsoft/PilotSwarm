/**
 * Migration 0109 (stage 2 review S2RT-F2, S2RT-F6): the chat-ended trigger's function, replaced in place, takes its locks in
 * the runtime's order (the chat, then its Workflow sessions in session_id order, then their runs in run_id order, then
 * their nodes), and ends test runs as well as live ones. Only the function is replaced: no table, column, index or trigger
 * is made, no row of 0107's or 0108's is rewritten.
 *
 * Run: node --test test/unit/workflow-migration-0109.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";
import { workflowChatEndedLockOrderMigration } from "../../dist/migrations/workflow-v2-0109.js";
import { workflowChatDefinitionsMigration } from "../../dist/migrations/workflow-v2-0107.js";
import { sessionPairLockOrder } from "../../dist/workflow/v2/store.js";

const flat = (sql) => sql.replace(/\s+/g, " ");

test("0109 only replaces the chat-ended function (0110, the run's agent models, follows it)", () => {
    const list = CMS_MIGRATIONS("s");
    assert.deepEqual(list.find(item => item.version === "0109"), { version: "0109", name: "workflow_chat_ended_lock_order", sql: workflowChatEndedLockOrderMigration("s") });
    assert.equal(list[list.findIndex(item => item.version === "0109") + 1]?.version, "0110");
    const sql = flat(workflowChatEndedLockOrderMigration("s"));
    assert.equal((sql.match(/CREATE OR REPLACE FUNCTION/g) ?? []).length, 1);
    assert.match(sql, /CREATE OR REPLACE FUNCTION "s"\.workflow_v2_on_chat_ended\(\) RETURNS TRIGGER/);
    for (const forbidden of [/CREATE TABLE/, /ALTER TABLE/, /CREATE (UNIQUE )?INDEX/, /CREATE TRIGGER/, /DROP /, /INSERT INTO/, /DELETE FROM/]) {
        assert.doesNotMatch(sql, forbidden);
    }
    // 0107's own text is unchanged (it is applied on TEST).
    assert.match(flat(workflowChatDefinitionsMigration("s")), /AND run\.mode = 'live' AND run\.status IN \('admitted', 'running', 'paused'\) AND node\.state = 'pending';/);
});

test("S2RT-F2: an ended chat locks its Workflow sessions, then their runs, before it changes a node, a run or a session", () => {
    const sql = flat(workflowChatEndedLockOrderMigration("s"));
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
    const ended = flat(workflowChatEndedLockOrderMigration("s")).split("ELSIF")[1];
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

// The executor's run at ea596f23: a chat that ended while its Workflow's run was paused broke the 0091 check
// workflow_runs_paused_from ((status = 'paused') = (paused_from IS NOT NULL)): 0107's function, and 0109 as first written,
// set the run cancelled and left paused_from. The chat's own update failed with it.
test("a paused run that an ended chat cancels has its paused_from cleared, as 0091's deletion trigger does", () => {
    const ended = flat(workflowChatEndedLockOrderMigration("s")).split("ELSIF")[1];
    assert.match(ended, /UPDATE "s"\.workflow_runs AS run SET status = 'cancelled', paused_from = NULL,/);
});
