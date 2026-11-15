// Use the caller's src/dist class so partial handles keep the real admission fence.
export function managedSessionFence(SessionClass) {
    return {
        workflowToolsClosed: false,
        workflowToolsGeneration: 0,
        closeWorkflowTools: SessionClass.prototype.closeWorkflowTools,
        resetWorkflowToolsOpen: SessionClass.prototype.resetWorkflowToolsOpen,
        assertWorkflowToolsOpen: SessionClass.prototype.assertWorkflowToolsOpen,
        captureWorkflowToolAdmission: SessionClass.prototype.captureWorkflowToolAdmission,
    };
}
