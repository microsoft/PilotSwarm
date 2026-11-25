/** Add Workflow spawn operations to the existing test interception table. */
export function workflowChildWorkflowsMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, "\"\"")}"`;
    return `
SET LOCAL lock_timeout = '5s';
ALTER TABLE ${s}.workflow_test_interceptions DROP CONSTRAINT IF EXISTS workflow_test_interceptions_operation_check;
ALTER TABLE ${s}.workflow_test_interceptions ADD CONSTRAINT workflow_test_interceptions_operation_check
    CHECK (operation IN ('tool.call', 'decision', 'agent', 'send', 'request', 'approval', 'spawn'));
`;
}
