/**
 * Migration 0110 (OF-S2-7, per-node models): one nullable TEXT column on workflow_runs, agent_models, the canonical JSON of
 * the agent node models a start chose. Additive and idempotent: no other table, column, index, trigger or function; no row
 * rewritten; registered last, after 0109.
 *
 * Run: node --test test/unit/workflow-migration-0110.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";
import { workflowRunAgentModelsMigration } from "../../dist/migrations/workflow-v2-0110.js";

test("0110 adds only the nullable agent_models column, idempotently, and is registered after 0109", () => {
    const list = CMS_MIGRATIONS("s");
    assert.deepEqual(list.at(-1), { version: "0110", name: "workflow_run_agent_models", sql: workflowRunAgentModelsMigration("s") });
    assert.equal(list.at(-2).version, "0109");
    const statements = workflowRunAgentModelsMigration("s").split("\n").map(line => line.trim()).filter(line => line && !line.startsWith("--"));
    assert.deepEqual(statements, ['ALTER TABLE "s".workflow_runs ADD COLUMN IF NOT EXISTS agent_models TEXT;']);
    for (const absent of [/NOT NULL/, /DEFAULT/, /UPDATE /, /CREATE /, /DROP /]) assert.doesNotMatch(workflowRunAgentModelsMigration("s"), absent);
});
