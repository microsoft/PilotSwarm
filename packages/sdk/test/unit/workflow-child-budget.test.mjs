/**
 * Stage 2 review S2RT-F3: one budget of running children for spawn_agent and a Workflow's Start (child-budget.ts). Both
 * count with the same SQL, after an exclusive lock on the chat's row, in the creation's own transaction; a retry of an
 * existing child is not counted again. Without a database: a recording client.
 *
 * Run: node --test test/unit/workflow-child-budget.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CHILD_BUDGET_AGENT_STATES, CHILD_BUDGET_RUN_STATUSES, childBudgetCountSql, childBudgetWords, spawnAgentAdmission, spawnAgentCreationBudget,
    WORKFLOW_CHILD_BUDGET_MAX } from "../../dist/child-budget.js";
import { PgSessionCatalog } from "../../dist/cms.js";
import { ChatDefinitionStore } from "../../dist/workflow/v2/chat-definition-store.js";

/** A client that answers the lock, an existing-row read and the count, and records each statement. */
function clientWith({ exists = false, count, chat = { state: "running", deleted_at: null, session_kind: null } }) {
    const statements = [];
    return { statements, query: async (sql, params) => {
        statements.push(sql.replace(/\s+/g, " ").trim());
        if (/FOR NO KEY UPDATE/.test(sql)) return { rows: chat ? [chat] : [] };
        if (/count\(\*\)/.test(sql)) return { rows: [{ n: count }] };
        return { rows: exists ? [{}] : [] };
    } };
}

test("the count: sub-agents pending or running, Workflows with an active live run or a Start's claim not admitted yet", () => {
    assert.equal(WORKFLOW_CHILD_BUDGET_MAX, 50);
    assert.deepEqual([...CHILD_BUDGET_AGENT_STATES], ["pending", "running"]);
    assert.deepEqual([...CHILD_BUDGET_RUN_STATUSES], ["admitted", "running", "paused"]);
    const sql = childBudgetCountSql('"s"').replace(/\s+/g, " ");
    for (const part of ["c.parent_session_id = $1 AND c.session_id <> $2", "c.is_system IS NOT TRUE AND c.service_kind IS NULL",
        "c.state IN ('pending', 'running')", "r.mode = 'live' AND r.status IN ('admitted', 'running', 'paused')", "c.creation_config -> 'workflowV2' ? 'chatPin'"]) {
        assert.ok(sql.includes(part), part);
    }
    assert.equal(childBudgetWords(50), "This chat already has 50 running sub-agents and Workflows (max 50). Wait for some to end before starting another.");
});

test("spawn_agent's creation (the catalog): the chat locked, then counted; a full budget refuses; a retry is not counted", async () => {
    const catalog = Object.create(PgSessionCatalog.prototype);
    catalog.sql = { schema: "s" };
    const full = clientWith({ count: 50 });
    await assert.rejects(catalog.requireChildBudgetLocked(full, "chat", "child", 50),
        (error) => error.code === "CHILD_LIMIT" && /^This chat already has 50 running sub-agents and Workflows \(max 50\)/.test(error.message));
    assert.match(full.statements[0], /^SELECT 1 FROM "s"\.sessions WHERE session_id = \$1 FOR NO KEY UPDATE$/);
    assert.match(full.statements.at(-1), /count\(\*\)/);
    await catalog.requireChildBudgetLocked(clientWith({ count: 49 }), "chat", "child", 50);
    const retry = clientWith({ exists: true, count: 50 });
    await catalog.requireChildBudgetLocked(retry, "chat", "child", 50);
    assert.equal(retry.statements.some((sql) => /count\(\*\)/.test(sql)), false);
});

test("a Start's claim (the chat store): the chat locked, then counted without the claimed Workflow; a full budget refuses", async () => {
    const store = new ChatDefinitionStore({ query: async () => ({ rows: [] }) }, "s");
    const full = clientWith({ count: 50 });
    await assert.rejects(store.requireChildBudgetLocked(full, "chat", "wf", 50),
        (error) => error.code === "CHILD_LIMIT" && /Nothing was started\.$/.test(error.message));
    assert.match(full.statements[0], /FOR NO KEY UPDATE$/);
    assert.equal(full.statements[1], childBudgetCountSql('"s"').replace(/\s+/g, " ").trim());
    await store.requireChildBudgetLocked(clientWith({ count: 49 }), "chat", "wf", 50);
});

// Lock-order check O1: a Start's claim that waited behind the chat's deletion or end is refused under the lock it waited for,
// before anything is counted, so the claim is rolled back and leaves no Workflow session.
test("a Start's claim under a deleted or ended chat is refused under the chat's lock, before the count", async () => {
    const store = new ChatDefinitionStore({ query: async () => ({ rows: [] }) }, "s");
    for (const [chat, code] of [[{ state: "running", deleted_at: new Date(), session_kind: null }, "CHAT_NOT_FOUND"], [null, "CHAT_NOT_FOUND"],
        [{ state: "cancelled", deleted_at: null, session_kind: null }, "CHAT_NOT_LIVE"], [{ state: "completed", deleted_at: null, session_kind: null }, "CHAT_NOT_LIVE"],
        [{ state: "failed", deleted_at: null, session_kind: null }, "CHAT_NOT_LIVE"]]) {
        const client = clientWith({ count: 0, chat });
        await assert.rejects(store.requireChildBudgetLocked(client, "chat", "wf", 50), (error) => error.code === code, JSON.stringify(chat));
        assert.equal(client.statements.length, 1, "only the lock: nothing counted");
        assert.match(client.statements[0], /FOR NO KEY UPDATE$/);
    }
});

// Coordinator decision on S2RT-F3: the switch is the boundary. With Workflows off, spawn_agent's admission is exactly the
// one before stage 2: the running direct sub-agents counted, no budget count and no lock at the creation.
test("spawn_agent with Workflows off: the count before stage 2 (running sub-agents), its words, and no lock at the creation", async () => {
    const calls = [];
    const children = [{ status: "running" }, { status: "running", isSystem: true }, { status: "pending" }, { status: "completed" }];
    const off = await spawnAgentAdmission({ workflowsOn: false, parentSessionId: "chat", max: 2,
        countBudgetChildren: async id => { calls.push(id); return 99; }, directChildren: async () => children });
    assert.deepEqual(off, { count: 1, refusal: null, creation: {} });
    assert.deepEqual(calls, [], "the shared budget is not counted");
    const full = await spawnAgentAdmission({ workflowsOn: false, parentSessionId: "chat", max: 1,
        countBudgetChildren: async () => 0, directChildren: async () => children });
    assert.equal(full.refusal, "[SYSTEM: spawn_agent failed — you already have 1 running sub-agents (max 1). Wait for some to complete before spawning more.]");
    assert.deepEqual(full.creation, {});
    assert.deepEqual(spawnAgentCreationBudget(false, false, 50), {});
});

test("spawn_agent with Workflows on: the shared budget's count, and the creation counts it again under the chat's lock", async () => {
    const on = await spawnAgentAdmission({ workflowsOn: true, parentSessionId: "chat", max: WORKFLOW_CHILD_BUDGET_MAX,
        countBudgetChildren: async () => 50, directChildren: async () => { throw new Error("not read"); } });
    assert.equal(on.count, 50);
    assert.match(on.refusal, /50 running sub-agents and Workflows \(max 50\)/);
    assert.deepEqual(on.creation, { childBudget: { max: WORKFLOW_CHILD_BUDGET_MAX } });
    // A system agent is never counted at its creation; a catalog without the count falls back to the running sub-agents.
    assert.deepEqual(spawnAgentCreationBudget(true, true, 50), {});
    const plain = await spawnAgentAdmission({ workflowsOn: true, parentSessionId: "chat", max: 50, directChildren: async () => [{ status: "running" }] });
    assert.equal(plain.count, 1);
    // Both spawn paths take the switch.
    const proxy = readFileSync(fileURLToPath(new URL("../../src/session-proxy.ts", import.meta.url)), "utf8");
    assert.match(proxy, /const workflowsOn = sessionManager\.workflowsEnabled !== false;/);
    assert.match(proxy, /\.\.\.spawnAgentCreationBudget\(workflowsOn, agentIsSystem, MAX_SUB_AGENTS\)/);
    assert.match(proxy, /\.\.\.spawnAgentCreationBudget\(sessionManager\.workflowsEnabled !== false, input\.isSystem === true, WORKFLOW_CHILD_BUDGET_MAX\)/);
    assert.ok(!/childBudget: \{ max: (MAX_SUB_AGENTS|WORKFLOW_CHILD_BUDGET_MAX) \}/.test(proxy), "no spawn path passes the budget without the switch");
});
