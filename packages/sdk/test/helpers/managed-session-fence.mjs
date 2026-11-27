// Use the caller's src/dist class so partial handles keep the real admission fence, the real decided-visit flag that
// complete_workflow_node sets, and the real active-turn read. A partial handle runs no real turn, so it has no active
// turn and the report's task cancel never runs on it.
export function managedSessionFence(SessionClass) {
    return {
        workflowToolsClosed: false,
        workflowToolsGeneration: 0,
        workflowVisitDecided: false,
        activeTurn: null,
        closeWorkflowTools: SessionClass.prototype.closeWorkflowTools,
        resetWorkflowToolsOpen: SessionClass.prototype.resetWorkflowToolsOpen,
        assertWorkflowToolsOpen: SessionClass.prototype.assertWorkflowToolsOpen,
        captureWorkflowToolAdmission: SessionClass.prototype.captureWorkflowToolAdmission,
        decideWorkflowVisit: SessionClass.prototype.decideWorkflowVisit,
        workflowVisitIsDecided: SessionClass.prototype.workflowVisitIsDecided,
        getActiveTurn: SessionClass.prototype.getActiveTurn,
    };
}
