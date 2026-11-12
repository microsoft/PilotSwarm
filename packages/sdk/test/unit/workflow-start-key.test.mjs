import test from "node:test";
import assert from "node:assert/strict";
import { workflowStartOperationId, workflowStartSessionId } from "../../dist/workflow/session-definitions.js";
import { WORKFLOW_DEFINITION_TOOL_SPEC } from "../../dist/workflow/definition-tool.js";

test("FB-001: a key survives different tool calls, but stays exact and session-scoped", () => {
    assert.equal(workflowStartOperationId("call-a"), "call-a");
    assert.equal(workflowStartOperationId("call-a", "attempt-1"), workflowStartOperationId("call-b", "attempt-1"));
    assert.notEqual(workflowStartOperationId("call-a", "attempt-1"), workflowStartOperationId("call-a", " attempt-1"));
    assert.notEqual(workflowStartSessionId("owner-a", "call-a", "attempt-1"), workflowStartSessionId("owner-b", "call-a", "attempt-1"));
    assert.equal(workflowStartSessionId("owner-a", "call-a", "attempt-1"), workflowStartSessionId("owner-a", "call-b", "attempt-1"));
    assert.notEqual(workflowStartSessionId("owner-a", "call-a"), workflowStartSessionId("owner-a", "call-b"));
});

test("FB-001: invalid keys are refused, and the tool declares an optional bounded key", () => {
    for (const key of [null, 42, "", " \n ", "x".repeat(129), "\0", "\ud800"]) {
        assert.throws(() => workflowStartOperationId("call-a", key), { code: "WORKFLOW_COMMAND_INVALID" });
    }
    assert.doesNotThrow(() => workflowStartOperationId("call-a", "x".repeat(128)));
    assert.doesNotThrow(() => workflowStartOperationId("call-a", "attempt-\u00e9"));
    assert.doesNotThrow(() => workflowStartOperationId("call-a", "\u{1f680}".repeat(128)));
    assert.throws(() => workflowStartOperationId("call-a", "\u{1f680}".repeat(129)), { code: "WORKFLOW_COMMAND_INVALID" });
    assert.deepEqual(WORKFLOW_DEFINITION_TOOL_SPEC.parameters.properties.key, {
        type: "string", minLength: 1, maxLength: 128,
        description: "start: exact idempotency key in this session. Reuse it for a retry; use a new key for another attempt.",
    });
    assert.equal(WORKFLOW_DEFINITION_TOOL_SPEC.parameters.required.includes("key"), false);
});
