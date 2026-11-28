import test from "node:test";
import assert from "node:assert/strict";
import { ManagedSession } from "../../dist/managed-session.js";
import { WorkflowToolAuthorityError } from "../../dist/workflow/tool-policy.js";
import { managedSessionFence } from "../helpers/managed-session-fence.mjs";

const refusal = {
    message: "Workflow agent visit is no longer available.",
};

test("a partial session fixture starts open and closes with the real refusal", () => {
    const handle = managedSessionFence(ManagedSession);
    assert.equal(handle.workflowToolsGeneration, 0);
    handle.assertWorkflowToolsOpen();
    const admitted = handle.captureWorkflowToolAdmission();
    admitted();
    handle.closeWorkflowTools();
    assert.equal(handle.workflowToolsGeneration, 1);
    assert.throws(() => handle.assertWorkflowToolsOpen(), refusal);
    assert.throws(admitted, WorkflowToolAuthorityError);
    assert.throws(() => handle.captureWorkflowToolAdmission(), refusal);
});

test("reopening a partial session fixture cannot revive an old admission", () => {
    const handle = managedSessionFence(ManagedSession);
    const oldAdmission = handle.captureWorkflowToolAdmission();
    handle.closeWorkflowTools();
    handle.resetWorkflowToolsOpen();
    assert.equal(handle.workflowToolsGeneration, 2);
    handle.assertWorkflowToolsOpen();
    assert.throws(oldAdmission, refusal);
    const newAdmission = handle.captureWorkflowToolAdmission();
    newAdmission();
    handle.resetWorkflowToolsOpen();
    assert.equal(handle.workflowToolsGeneration, 3);
    assert.throws(newAdmission, refusal);
});

// complete_workflow_node's onDecided (session-proxy) calls decideWorkflowVisit, then reads getActiveTurn for the report's task cancel.
test("a partial session fixture decides its visit with the real flag and has no active turn", () => {
    const handle = managedSessionFence(ManagedSession);
    assert.equal(handle.workflowVisitIsDecided(), false);
    assert.equal(handle.getActiveTurn(), null);
    handle.decideWorkflowVisit();
    assert.equal(handle.workflowVisitIsDecided(), true);
    assert.throws(() => handle.assertWorkflowToolsOpen(), refusal);
    handle.resetWorkflowToolsOpen();
    assert.equal(handle.workflowVisitIsDecided(), false);
    handle.assertWorkflowToolsOpen();
});

test("partial session fixtures do not share admission state", () => {
    const first = managedSessionFence(ManagedSession);
    const second = managedSessionFence(ManagedSession);
    const firstAdmission = first.captureWorkflowToolAdmission();
    const secondAdmission = second.captureWorkflowToolAdmission();
    first.closeWorkflowTools();
    assert.throws(firstAdmission, refusal);
    secondAdmission();
    assert.equal(second.workflowToolsGeneration, 0);
    first.resetWorkflowToolsOpen();
    assert.throws(firstAdmission, refusal);
    secondAdmission();
});
