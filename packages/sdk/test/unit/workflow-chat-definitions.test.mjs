/**
 * Workflow Simplified stage 2.1, without a database: the workflow_definition tool's declaration and its refusals of an
 * invalid call before anything is read; a person's codes map to HTTP statuses; migration 0107's shape (the live name key,
 * the chat-ended trigger, the lock that keeps Workflows from being created during the import); the declarations (with
 * Workflows on, inside a Workflow, off). The store's rules run on PostgreSQL in test/local/workflow-chat-definitions.test.js,
 * the import in test/local/workflow-v2-migration-0107.test.js and the save note in test/local/workflow-chat-notes-turn.test.js.
 *
 * Run: node --test test/unit/workflow-chat-definitions.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ManagedSession } from "../../dist/managed-session.js";
import { WORKFLOW_DEFINITION_TOOL, WORKFLOW_DEFINITION_TOOL_SPEC, workflowDefinitionFromTool, workflowDefinitionToolSpec } from "../../dist/workflow/v2/definition-tool.js";
import { chatActorWords, chatSaveRequestSha256, CHAT_ENDED_STATES } from "../../dist/workflow/v2/chat-definition-store.js";
import { workflowCommandStatus } from "../../dist/workflow/v2/human-commands.js";
import { workflowChatDefinitionsMigration } from "../../dist/migrations/workflow-v2-0107.js";
import { CMS_MIGRATIONS } from "../../dist/cms-migrations.js";
import { WORKFLOW_DEFINITION_TOOLS } from "../../dist/workflow/v2/input-policy.js";

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
    const text = WORKFLOW_DEFINITION_TOOL_SPEC.description;
    for (const phrase of ["belongs to this chat", "each save is a new revision", "a Workflow runs the revision it started with",
        "a save based on an older revision is refused, so read again and redo your change", "Change a Workflow = save a new revision, then start it.",
        "never a timer that starts a Workflow each time", "test (only when the user asks you to test it, or before you publish it in a package; never on your own, and Start never needs a test",
        "a call with no prepared answer fails the test, which names it",
        // Stage 2.3 (P3, P4, D7, E2-7).
        "A package's definition is named <package>/<name>", "you start it, you never save it", "list shows under canStart",
        "read a card before you start one", "ask the person for any input you lack"]) {
        assert.ok(text.includes(phrase), phrase);
    }
    assert.ok(!/delete/i.test(WORKFLOW_DEFINITION_TOOL_SPEC.parameters.properties.operation.enum.join(" ")), "a person deletes (Q8)");
});

// Stage 2.5: where its host cannot run a test, the tool is declared without test, so the model is not offered an operation
// that always refuses; a call of it is still refused, with its code, before anything is read.
test("without tests the tool declares no test operation, fixtures or test_id, and says a test cannot run here", async () => {
    assert.deepEqual(workflowDefinitionToolSpec(), WORKFLOW_DEFINITION_TOOL_SPEC);
    assert.deepEqual(workflowDefinitionToolSpec({ tests: true }), WORKFLOW_DEFINITION_TOOL_SPEC);
    const spec = workflowDefinitionToolSpec({ tests: false });
    assert.deepEqual(spec.parameters.properties.operation.enum, ["list", "read", "save", "start", "card"]);
    assert.equal(Object.hasOwn(spec.parameters.properties, "fixtures"), false);
    assert.equal(Object.hasOwn(spec.parameters.properties, "test_id"), false);
    assert.ok(!spec.description.includes("test (only when"));
    assert.ok(spec.description.includes("Workflow tests do not run here, so there is no test operation: if the user asks for a test, say a test cannot run here."));
    for (const key of ["name", "definition_id", "expected_revision", "yaml", "revision", "inputs", "vars", "notify_on_completion", "update"]) {
        assert.deepEqual(spec.parameters.properties[key], WORKFLOW_DEFINITION_TOOL_SPEC.parameters.properties[key], key);
    }
    const refused = await call({ operation: "test", name: "x" }, { host: { ...untouched(), requests: false } });
    assert.equal(refused.ok, false);
    assert.equal(refused.error.code, "WORKFLOW_TEST_UNAVAILABLE");
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

test("migration 0107: registered before 0108; one live definition per name; the chat-ended trigger; the import holds Workflow creation", () => {
    const list = CMS_MIGRATIONS("s");
    const at = list.findIndex(item => item.version === "0107");
    assert.equal(list[at].name, "workflow_chat_definitions");
    // Stage 2.3: 0108 (package definitions) follows it; stage 2 review: 0109 (the chat-ended trigger's lock order).
    assert.deepEqual(list.slice(at + 1, at + 3).map(item => item.version), ["0108", "0109"]);
    const sql = workflowChatDefinitionsMigration("s");
    assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS workflow_chat_definitions_live_name\s+ON "s"\.workflow_chat_definitions \(owner_session_id, name\) WHERE deleted_at IS NULL;/);
    assert.match(sql, /CONSTRAINT workflow_chat_revisions_valid_ir CHECK \(valid = \(ir IS NOT NULL AND ir_sha256 IS NOT NULL\)\)/);
    assert.match(sql, /CREATE TRIGGER workflow_v2_chat_ended\s+AFTER UPDATE OF state, deleted_at ON "s"\.sessions/);
    assert.match(sql, /WHEN \(NEW\.session_kind IS DISTINCT FROM 'workflow'/);
    assert.match(sql, /ELSIF NEW\.state IN \('completed', 'cancelled', 'failed'\)/);
    assert.match(sql, /LOCK TABLE "s"\.workflow_definitions IN SHARE ROW EXCLUSIVE MODE;/);
    // D3: deduplicated by YAML hash, never by metadata.version.
    assert.match(sql, /PARTITION BY c\.owner_session_id, c\.name, r\.yaml_sha256/);
    assert.ok(!/PARTITION BY[^)]*semver/.test(sql));
});

test("declarations: workflow_definition is a definition tool, declared beside spawn_workflow, and not inside a Workflow (A1)", () => {
    assert.ok(WORKFLOW_DEFINITION_TOOLS.includes("workflow_definition"));
    const names = defs => defs.map(def => def.name);
    const outside = names(ManagedSession.subAgentToolDefs());
    assert.ok(outside.includes("workflow_definition"));
    assert.ok(outside.indexOf("workflow_definition") < outside.indexOf("spawn_workflow"));
    const inside = names(ManagedSession.subAgentToolDefs({ workflowInsideWorkflow: true }));
    for (const tool of ["workflow_definition", "spawn_workflow", "update_workflow"]) assert.ok(!inside.includes(tool), tool);
    assert.ok(inside.includes("read_workflow"));
});
