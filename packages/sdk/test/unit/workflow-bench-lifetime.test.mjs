/**
 * Stage 2 review S2RT-F6: a chat's hidden tests follow the chat's and the definition's lifetime. A bench is made and its
 * test admitted only under the chat's lock (live) and the definition's (not deleted); deleting a definition ends its active
 * tests in the runtime's lock order (bench sessions, then runs, then nodes) and keeps their reports. Without a database:
 * recording clients. (The chat-ended trigger's part is migration 0109: workflow-migration-0109.test.mjs.)
 *
 * Run: node --test test/unit/workflow-bench-lifetime.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ChatDefinitionStore, requireBenchLiveLocked } from "../../dist/workflow/chat-definition-store.js";

const flat = (sql) => sql.replace(/\s+/g, " ").trim();

function clientWith(answers) {
    const statements = [];
    return { statements, release: () => {}, query: async (sql, params) => {
        statements.push(flat(sql));
        for (const [pattern, rows] of answers) if (pattern.test(sql)) return { rows: typeof rows === "function" ? rows(params) : rows };
        return { rows: [] };
    } };
}

test("a bench is made, and its test admitted, only while its chat is live and its definition is not deleted, chat locked first", async () => {
    const live = { deleted_at: null, state: "idle" };
    const definition = { owner_session_id: "chat", name: "waiter", deleted_at: null };
    const ok = clientWith([[/FROM "s"\.sessions/, [live]], [/workflow_chat_definitions/, [definition]]]);
    await requireBenchLiveLocked(ok, "s", { ownerSessionId: "chat", definitionId: "def-1" });
    assert.match(ok.statements[0], /FROM "s"\.sessions WHERE session_id = \$1 FOR SHARE$/);
    assert.match(ok.statements[1], /FROM "s"\.workflow_chat_definitions WHERE definition_id = \$1 FOR SHARE$/);
    for (const [chat, def, code] of [
        [[], [definition], "CHAT_NOT_FOUND"], [[{ ...live, deleted_at: new Date() }], [definition], "CHAT_NOT_FOUND"],
        [[{ ...live, state: "completed" }], [definition], "CHAT_NOT_LIVE"], [[{ ...live, state: "cancelled" }], [definition], "CHAT_NOT_LIVE"],
        [[live], [{ ...definition, deleted_at: new Date() }], "DEFINITION_DELETED"], [[live], [{ ...definition, owner_session_id: "other" }], "DEFINITION_NOT_FOUND"],
    ]) {
        const client = clientWith([[/FROM "s"\.sessions/, chat], [/workflow_chat_definitions/, def]]);
        await assert.rejects(requireBenchLiveLocked(client, "s", { ownerSessionId: "chat", definitionId: "def-1" }),
            (error) => error.code === code && /Nothing was tested\.$|has no Workflow Definition/.test(error.message), code);
    }
});

test("deleting a definition ends its active tests: bench sessions, then runs, then nodes, runs and sessions; reports stay", async () => {
    const client = clientWith([
        [/FROM "s"\.workflow_chat_operations/, []],
        [/SELECT state, deleted_at, session_kind FROM "s"\.sessions/, [{ state: "idle", deleted_at: null, session_kind: null }]],
        [/SELECT \* FROM "s"\.workflow_chat_definitions WHERE definition_id = \$1 FOR UPDATE/, [{ definition_id: "def-1", owner_session_id: "chat",
            name: "waiter", current_revision: 1, created_at: new Date(), updated_at: new Date(), deleted_at: null }]],
        [/RETURNING deleted_at/, [{ deleted_at: new Date() }]],
        [/UPDATE "s"\.workflow_runs SET status = 'cancelled'/, [{ workflow_session_id: "bench-1" }]],
    ]);
    const store = new ChatDefinitionStore({ connect: async () => client }, "s");
    const deleted = await store.deleteDefinition({ ownerSessionId: "chat", definitionId: "def-1", actor: { kind: "user", provider: "dev", subject: "ada" },
        operationId: "delete-1", requestSha256: "x" });
    assert.equal(deleted.receipt.definitionId, "def-1");
    const at = (pattern) => client.statements.findIndex((sql) => pattern.test(sql));
    const marked = at(/RETURNING deleted_at/);
    const benches = at(/service_kind = 'workflow-test' .* ORDER BY session_id FOR NO KEY UPDATE$/);
    const runs = at(/mode = 'test' AND status IN \('admitted', 'running', 'paused'\) ORDER BY run_id FOR UPDATE$/);
    const nodes = at(/UPDATE "s"\.workflow_node_executions SET state = 'completed', outcome = 'cancelled'/);
    const endRuns = at(/UPDATE "s"\.workflow_runs SET status = 'cancelled'/);
    const endSessions = at(/UPDATE "s"\.sessions SET state = 'cancelled'/);
    assert.ok(marked > 0 && marked < benches && benches < runs && runs < nodes && nodes < endRuns && endRuns < endSessions,
        JSON.stringify({ marked, benches, runs, nodes, endRuns, endSessions }));
    // The tests' reports stay: nothing of theirs is deleted.
    assert.equal(client.statements.some((sql) => /DELETE FROM|cms_soft_delete_session/.test(sql)), false);
    // A paused test run is ended with its paused_from cleared (the 0091 check workflow_runs_paused_from).
    assert.match(client.statements[endRuns], /SET status = 'cancelled', paused_from = NULL,/);
});

// Stage 2 review S2RT-F8: retention keeps the newest five ENDED tests; a running test is never retired and never takes an
// ended test's place; it runs again when a test ends, for the bench's own chat and definition.
test("S2RT-F8: retention keeps the newest five ended tests, whatever is running; it runs again when a test ends", async () => {
    const tests = (verdicts) => verdicts.map((verdict, index) => ({ testId: `t${index}`, definitionId: "def-1", revision: 1, verdict }));
    const deleted = [];
    const store = new ChatDefinitionStore({ query: async (sql, params) => {
        if (/cms_soft_delete_session/.test(sql)) { deleted.push(params[0]); return { rows: [] }; }
        if (/service_kind = 'workflow-test'/.test(sql)) return { rows: params[0] === "bench" ? [{ parent_session_id: "chat", definition_id: "def-1" }] : [] };
        return { rows: [] };
    } }, "s");
    // Newest first: two running, then six ended.
    store.listTests = async () => tests(["running", "running", "passed", "failed", "passed", "passed", "passed", "passed"]);
    assert.deepEqual(await store.retireTests("chat", "def-1", 5), ["t7"]);
    assert.deepEqual(deleted, ["t7"]);
    deleted.length = 0;
    // Six overlapping tests that all ended: the oldest goes, with no new test started.
    store.listTests = async () => tests(["passed", "passed", "passed", "passed", "passed", "passed"]);
    assert.deepEqual(await store.retireTestsAfterEnd("bench"), ["t5"]);
    assert.deepEqual(await store.retireTestsAfterEnd("not-a-bench"), []);
});
