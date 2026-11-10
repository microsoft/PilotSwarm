/**
 * Workflow Simplified stage 2.1, without a database: the workflow_definition tool's declaration and its refusals of an
 * invalid call before anything is read; a person's codes map to HTTP statuses; the chat definition tables' shape (the
 * live name key, the chat-ended trigger); the declarations (with Workflows on, inside a Workflow, off). The store's rules
 * run on PostgreSQL in test/local/workflow-chat-definitions.test.js and the save note in
 * test/local/workflow-chat-notes-turn.test.js.
 *
 * Run: node --test test/unit/workflow-chat-definitions.test.mjs
 */
import test from "node:test";
import fs from "node:fs";
import assert from "node:assert/strict";
import { ManagedSession } from "../../dist/managed-session.js";
import { WORKFLOW_DEFINITION_TOOL, WORKFLOW_DEFINITION_TOOL_SPEC, workflowDefinitionFromTool, workflowDefinitionToolSpec } from "../../dist/workflow/definition-tool.js";
import { chatActorWords, chatSaveRequestSha256, CHAT_ENDED_STATES } from "../../dist/workflow/chat-definition-store.js";
import { workflowCommandStatus } from "../../dist/workflow/human-commands.js";
import { workflowMigration } from "../../dist/migrations/workflow-0088.js";
import { WORKFLOW_DEFINITION_TOOLS } from "../../dist/workflow/input-policy.js";

/** A host whose store must not be read: every refusal here comes before it. */
const untouched = () => ({ store: new Proxy({}, { get: (_target, name) => { throw new Error(`the store was used (${String(name)})`); } }) });
const call = (args, extra = {}) => workflowDefinitionFromTool(args, { callerSessionId: "chat", host: untouched(), toolCallId: "call-1", owner: null,
    binding: async () => null, ...extra }).then(text => JSON.parse(text));

test("the tool: one name, list, read, save, start and (stage 2.2) test, the guard's arguments; its words say a change is a revision", () => {
    assert.equal(WORKFLOW_DEFINITION_TOOL, "workflow_definition");
    // Stage 2.3: card (a package definition's interface card) and update (start a package's newer version).
    assert.deepEqual(WORKFLOW_DEFINITION_TOOL_SPEC.parameters.properties.operation.enum, ["list", "read", "save", "start", "test", "card"]);
    for (const key of ["name", "definition_id", "expected_revision", "yaml", "revision", "inputs", "vars", "notify_on_completion", "fixtures", "test_id", "update"]) {
        assert.ok(WORKFLOW_DEFINITION_TOOL_SPEC.parameters.properties[key], key);
    }
    // Owner 2026-11-08T16:55Z: the declaration carries its contract; the workflow-tools skill has the details.
    const text = WORKFLOW_DEFINITION_TOOL_SPEC.description;
    assert.ok(text.length <= 900, `${text.length}`);
    for (const phrase of ["This chat's Workflow Definitions, each named, with revisions 1, 2, 3.", "a stale save is refused",
        "a revision with errors is saved but cannot start", "start again to run it again",
        "test: only when the user asks, or before you publish it in a package.",
        // Stage 2.3 (P3, P4, D7, E2-7).
        "under canStart the package definitions (<package>/<name>, locked) you may start", "read it before you start one",
        "Call load_skill with name workflow-tools for every argument."]) {
        assert.ok(text.includes(phrase), phrase);
    }
    const tools = fs.readFileSync(new URL("../../plugins/workflow/skills/workflow-tools/SKILL.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    for (const phrase of ["every save is a new revision, and a Workflow runs the revision it started with", "A save based on an older revision is refused",
        "Read again and redo your change on the newest revision.", "A call with no prepared answer fails the test, which names it.",
        "Test only when the user asks (for example \"test it before you start it\") or before you publish it in a package; never on your own, and `start` never needs a test.",
        "A package's definition is named `<package>/<name>`", "you start it, you never save it", "`list` shows the ones you may start under `canStart`.",
        "Read its `card` first", "ask the person for any input you lack"]) {
        assert.ok(tools.includes(phrase), `workflow-tools: ${phrase}`);
    }
    assert.ok(!/delete/i.test(WORKFLOW_DEFINITION_TOOL_SPEC.parameters.properties.operation.enum.join(" ")), "a person deletes (Q8)");
});

test("an invalid call is refused before anything is read, with its code", async () => {
    for (const [args, extra, code] of [
        [{ operation: "explode" }, {}, "WORKFLOW_COMMAND_INVALID"],
        [{ operation: "read" }, {}, "WORKFLOW_COMMAND_INVALID"],
        [{ operation: "save", yaml: "x" }, {}, "WORKFLOW_COMMAND_INVALID"],
        [{ operation: "save", name: "n", yaml: "x" }, { toolCallId: null }, "WORKFLOW_COMMAND_INVALID"],
        [{ operation: "save", name: "n", yaml: "x", definition_id: "d" }, {}, "WORKFLOW_COMMAND_INVALID"],
        [{ operation: "save", name: "n", yaml: "x", expected_revision: 2 }, {}, "WORKFLOW_COMMAND_INVALID"],
        [{ operation: "save", name: "n", yaml: "x", definition_id: "d", expected_revision: 0 }, {}, "WORKFLOW_COMMAND_INVALID"],
        [{ operation: "start" }, {}, "WORKFLOW_COMMAND_INVALID"],
        [{ operation: "start", name: "n", inputs: [1] }, {}, "WORKFLOW_COMMAND_INVALID"],
        [{ operation: "read", name: "n", revision: "2" }, {}, "WORKFLOW_COMMAND_INVALID"],
    ]) {
        const answer = await call(args, extra);
        assert.equal(answer.ok, false, JSON.stringify(args));
        assert.equal(answer.error.code, code, `${JSON.stringify(args)}: ${answer.error.message}`);
    }
});

test("a person's refusals map to HTTP statuses: not found, invalid, unprocessable, a limit, and conflicts", () => {
    for (const code of ["DEFINITION_NOT_FOUND", "REVISION_NOT_FOUND", "CHAT_NOT_FOUND"]) assert.equal(workflowCommandStatus(code), 404, code);
    assert.equal(workflowCommandStatus("WORKFLOW_NAME_MISMATCH"), 400);
    for (const code of ["DEFINITION_INVALID", "WORKFLOW_SCRIPTS_DISABLED"]) assert.equal(workflowCommandStatus(code), 422, code);
    assert.equal(workflowCommandStatus("REVISION_LIMIT"), 429);
    for (const code of ["REVISION_STALE", "DEFINITION_DELETED", "DEFINITION_EXISTS", "DEFINITION_IN_USE", "CHAT_NOT_LIVE", "WORKFLOW_ACTIVE",
        "REVISION_REQUIRED", "OPERATION_CONFLICT"]) {
        assert.equal(workflowCommandStatus(code), 409, code);
    }
});

test("words and digests: who saved a revision, the chat's ended states, a save's request digest", () => {
    assert.equal(chatActorWords({ kind: "chat", sessionId: "c" }), "the chat");
    assert.equal(chatActorWords({ kind: "user", provider: "p", subject: "s", display: "Ada Lovelace" }), "Ada Lovelace");
    assert.equal(chatActorWords({ kind: "user", provider: "p", subject: "s" }), "s");
    assert.equal(chatActorWords({ kind: "system", name: "imported" }), "the import of stage 1 Workflows");
    assert.deepEqual([...CHAT_ENDED_STATES], ["completed", "cancelled", "failed"]);
    const digest = chatSaveRequestSha256({ name: "n", yamlSha256: "h", expected: { definitionId: "d", revision: 2 } });
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.notEqual(digest, chatSaveRequestSha256({ name: "n", yamlSha256: "h", expected: { definitionId: "d", revision: 3 } }), "the guard is part of it");
    assert.notEqual(digest, chatSaveRequestSha256({ name: "n", yamlSha256: "h", expected: null }));
});

test("the chat definition tables (migration 0088): one live definition per name; the chat-ended trigger", () => {
    const sql = workflowMigration("s")[0];
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS workflow_chat_definitions_live_name\s+ON "s"\.workflow_chat_definitions \(owner_session_id, name\) WHERE deleted_at IS NULL;/);
    assert.match(sql, /CONSTRAINT workflow_chat_revisions_valid_ir CHECK \(valid = \(ir IS NOT NULL AND ir_sha256 IS NOT NULL\)\)/);
    assert.match(sql, /CREATE TRIGGER workflow_chat_ended\s+AFTER UPDATE OF state, deleted_at ON "s"\.sessions/);
    assert.match(sql, /WHEN \(NEW\.session_kind IS DISTINCT FROM 'workflow'/);
    assert.match(sql, /ELSIF NEW\.state IN \('completed', 'cancelled', 'failed'\)/);
});

test("declarations: workflow_definition is a definition tool, declared (spawn_workflow is not), and not inside a Workflow (A1)", () => {
    assert.ok(WORKFLOW_DEFINITION_TOOLS.includes("workflow_definition"));
    const names = defs => defs.map(def => def.name);
    const outside = names(ManagedSession.subAgentToolDefs());
    assert.ok(outside.includes("workflow_definition"));
    assert.ok(!outside.includes("spawn_workflow"));
    const inside = names(ManagedSession.subAgentToolDefs({ workflowInsideWorkflow: true }));
    for (const tool of ["workflow_definition", "spawn_workflow", "update_workflow"]) assert.ok(!inside.includes(tool), tool);
    assert.ok(inside.includes("read_workflow"));
});

