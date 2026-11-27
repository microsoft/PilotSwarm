// Use the caller's src/dist class so partial handles keep the real admission fence.
export function managedSessionFence(SessionClass) {
    return {
        workflowToolsClosed: false,
        workflowToolsGeneration: 0,
        workflowVisitDecided: false,
        closeWorkflowTools: SessionClass.prototype.closeWorkflowTools,
        resetWorkflowToolsOpen: SessionClass.prototype.resetWorkflowToolsOpen,
        decideWorkflowVisit: SessionClass.prototype.decideWorkflowVisit,
        workflowVisitIsDecided: SessionClass.prototype.workflowVisitIsDecided,
        assertWorkflowToolsOpen: SessionClass.prototype.assertWorkflowToolsOpen,
        captureWorkflowToolAdmission: SessionClass.prototype.captureWorkflowToolAdmission,
    };
}
