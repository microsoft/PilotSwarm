import test from "node:test";
import assert from "node:assert/strict";
import { ManagedSession } from "../../dist/managed-session.js";
import { WORKFLOW_VISIT_DECIDED_DENIAL, withWorkflowVisitDeny } from "../../dist/session-manager.js";
import { completeWorkflowNodeFromTool } from "../../dist/workflow/agent-node-service.js";
import { WorkflowStoreError } from "../../dist/workflow/store.js";
import { managedSessionFence } from "../helpers/managed-session-fence.mjs";

// Issue I1: once a Workflow agent step's result is recorded, its turn is not stopped; it only finishes its reply. Every
// tool call of that turn is refused, the CLI's own tools too (a pre-tool hook), until the session's next turn.

test("after the step's result the pre-tool hook refuses every call until the session's next turn", async () => {
    const inner = { onPreToolUse: async () => ({ permissionDecision: "allow" }), onPostToolUse: async () => undefined };
    assert.equal(withWorkflowVisitDeny(inner, null), inner, "no hook outside a Workflow agent step");
    const session = managedSessionFence(ManagedSession);
    const hooks = withWorkflowVisitDeny(inner, () => session.workflowVisitIsDecided());
    assert.equal(hooks.onPostToolUse, inner.onPostToolUse);
    assert.deepEqual(await hooks.onPreToolUse({ toolName: "bash" }), { permissionDecision: "allow" });
    session.decideWorkflowVisit();
    for (const toolName of ["bash", "edit", "task", "complete_workflow_node", "memory_probe"]) {
        assert.deepEqual(await hooks.onPreToolUse({ toolName }), { permissionDecision: "deny", permissionDecisionReason: WORKFLOW_VISIT_DECIDED_DENIAL });
    }
    assert.throws(() => session.assertWorkflowToolsOpen(), { message: "Workflow agent visit is no longer available." });
    // The session's next turn opens its tools again.
    session.resetWorkflowToolsOpen();
    assert.deepEqual(await hooks.onPreToolUse({ toolName: "bash" }), { permissionDecision: "allow" });
});

test("a turn whose binding is refused keeps complete_workflow_node: only a decided visit refuses every tool", async () => {
    const session = managedSessionFence(ManagedSession);
    const hooks = withWorkflowVisitDeny({}, () => session.workflowVisitIsDecided());
    session.decideWorkflowVisit();
    // The next turn starts with its tools open, then its binding is refused (session-manager's warm path): its Workflow tools
    // refuse, but the hook lets complete_workflow_node through, so the step can complete with execution_failed.
    session.resetWorkflowToolsOpen();
    session.closeWorkflowTools();
    assert.throws(() => session.assertWorkflowToolsOpen(), { message: "Workflow agent visit is no longer available." });
    assert.equal(await hooks.onPreToolUse({ toolName: "complete_workflow_node" }), undefined);
});

test("a completion write whose outcome is unknown closes the turn's tools when the visit is decided or cannot be read (review R2-3)", async () => {
    const lostAck = { completeAgentNode: async () => { throw new Error("Connection terminated unexpectedly"); } };
    const call = async (store, visitDecided) => {
        let decided = 0;
        const answer = JSON.parse(await completeWorkflowNodeFromTool({ outcome: "again", operation_id: "op-1" },
            { callerSessionId: "s", store, onDecided: () => { decided += 1; }, visitDecided }));
        assert.equal(answer.ok, false);
        return decided;
    };
    // The write committed, its acknowledgement was lost: the visit reads decided, so the turn's tools close.
    assert.equal(await call(lostAck, async () => true), 1);
    // The write did not commit: the call can be retried with its operation_id.
    assert.equal(await call(lostAck, async () => false), 0);
    // Neither can be verified: no more tools run in the turn.
    assert.equal(await call(lostAck, async () => { throw new Error("read failed"); }), 1);
    // A store refusal wrote nothing: no read.
    let reads = 0;
    const refused = { completeAgentNode: async () => { throw new WorkflowStoreError("COMPLETION_INVALID", "bad call"); } };
    assert.equal(await call(refused, async () => { reads += 1; return true; }), 0);
    assert.equal(reads, 0);
});
