/**
 * Formal deviation D1: complete_workflow_node passes the turn visit to the store as it is: a continued session's turn visit,
 * or null for such a turn that received no cycle prompt (the store then refuses, as the reminder does: no_visit); and
 * nothing for every other caller (session: new, or a call outside a turn), whose binding is unchanged.
 *
 * Run: node --test test/unit/workflow-simplified-completion-turn-visit.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { completeWorkflowNodeFromTool } from "../../dist/workflow/agent-node-service.js";

test("the turn visit reaches the store as given: a visit, null, or nothing", async () => {
    const calls = [];
    const store = { completeAgentNode: async input => { calls.push(input); return { kind: "refused", code: "AGENT_NODE_NOT_FOUND" }; } };
    const args = { outcome: "finish", output: { fact: "x" }, operation_id: "op-1", node_execution_id: "nx-2" };
    for (const turnVisit of ["nx-2", null, undefined]) {
        await completeWorkflowNodeFromTool(args, { callerSessionId: "chat", store, ...(turnVisit !== undefined ? { turnVisit } : {}) });
    }
    assert.deepEqual(calls.map(call => (Object.hasOwn(call, "turnVisit") ? call.turnVisit : "absent")), ["nx-2", null, "absent"]);
});
