import test from "node:test";
import assert from "node:assert/strict";
import { ManagedSession } from "../../dist/managed-session.js";
import { WORKFLOW_VISIT_DECIDED_DENIAL, withWorkflowVisitDeny } from "../../dist/session-manager.js";
import { managedSessionFence } from "../helpers/managed-session-fence.mjs";

// Issue I1: once a Workflow agent step's result is recorded, its turn is not stopped; it only finishes its reply. Every
// tool call of that turn is refused, the CLI's own tools too (a pre-tool hook), until the session's next turn.

test("after the step's result the pre-tool hook refuses every call until the session's next turn", async () => {
    const inner = { onPreToolUse: async () => ({ permissionDecision: "allow" }), onPostToolUse: async () => undefined };
    assert.equal(withWorkflowVisitDeny(inner, null), inner, "no hook outside a Workflow agent step");
    const session = { ...managedSessionFence(ManagedSession), workflowVisitDecided: false,
        decideWorkflowVisit: ManagedSession.prototype.decideWorkflowVisit, workflowVisitIsDecided: ManagedSession.prototype.workflowVisitIsDecided };
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
    const session = { ...managedSessionFence(ManagedSession), workflowVisitDecided: false,
        decideWorkflowVisit: ManagedSession.prototype.decideWorkflowVisit, workflowVisitIsDecided: ManagedSession.prototype.workflowVisitIsDecided };
    const hooks = withWorkflowVisitDeny({}, () => session.workflowVisitIsDecided());
    session.decideWorkflowVisit();
    // The next turn starts with its tools open, then its binding is refused (session-manager's warm path): its Workflow tools
    // refuse, but the hook lets complete_workflow_node through, so the step can complete with execution_failed.
    session.resetWorkflowToolsOpen();
    session.closeWorkflowTools();
    assert.throws(() => session.assertWorkflowToolsOpen(), { message: "Workflow agent visit is no longer available." });
    assert.equal(await hooks.onPreToolUse({ toolName: "complete_workflow_node" }), undefined);
});
