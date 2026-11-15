/**
 * Stage 2.2: an agent's test of a revision of a session's definition runs on a test bench (definition-test.ts): a workflow child of
 * the session marked as a service session (service_kind workflow-test; its definition and revision are its creation config's
 * agentTest, not service_of, which holds a session's uuid). A test bench is never a
 * Workflow of the definition (it has no session pin), never shown in a session list, and never notifies the session.
 */
export const WORKFLOW_TEST_BENCH_KIND = "workflow-test";

/** Whether a session row is an agent's test bench. */
export function isWorkflowTestBench(row: { serviceKind?: string | null } | null | undefined): boolean {
    return row?.serviceKind === WORKFLOW_TEST_BENCH_KIND;
}
