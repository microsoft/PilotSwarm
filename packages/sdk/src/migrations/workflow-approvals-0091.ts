/** Owner-only Workflow approvals; accepted consent and its proposal are immutable. */
export function workflowApprovalsMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
SET LOCAL lock_timeout = '5s';
CREATE TABLE IF NOT EXISTS ${s}.workflow_approvals (
    node_execution_id TEXT PRIMARY KEY REFERENCES ${s}.workflow_node_executions(node_execution_id),
    workflow_session_id TEXT NOT NULL REFERENCES ${s}.workflow_definitions(workflow_session_id),
    run_id TEXT NOT NULL REFERENCES ${s}.workflow_runs(run_id),
    owner_provider TEXT NOT NULL CHECK (length(owner_provider) > 0),
    owner_subject TEXT NOT NULL CHECK (length(owner_subject) > 0),
    snapshot TEXT NOT NULL,
    context_sha256 TEXT NOT NULL CHECK (context_sha256 ~ '^[0-9a-f]{64}$'),
    decision TEXT CHECK (decision IN ('approved', 'rejected')),
    reason TEXT CHECK (reason IS NULL OR length(reason) <= 2000),
    decided_by TEXT,
    decided_at TIMESTAMPTZ,
    operation_id TEXT,
    CONSTRAINT workflow_approvals_decision CHECK (
        (decision IS NULL AND reason IS NULL AND decided_by IS NULL AND decided_at IS NULL AND operation_id IS NULL)
        OR (decision IS NOT NULL AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND operation_id IS NOT NULL
            AND length(operation_id) > 0 AND (decision <> 'rejected' OR (reason IS NOT NULL AND length(btrim(reason)) > 0)))
    )
);
CREATE INDEX IF NOT EXISTS workflow_approvals_by_run ON ${s}.workflow_approvals(run_id, node_execution_id);
CREATE OR REPLACE FUNCTION ${s}.workflow_approval_immutable() RETURNS TRIGGER AS $$
BEGIN
    IF ROW(NEW.node_execution_id, NEW.workflow_session_id, NEW.run_id, NEW.owner_provider, NEW.owner_subject, NEW.snapshot, NEW.context_sha256)
        IS DISTINCT FROM ROW(OLD.node_execution_id, OLD.workflow_session_id, OLD.run_id, OLD.owner_provider, OLD.owner_subject, OLD.snapshot, OLD.context_sha256)
        OR (OLD.decision IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
        RAISE EXCEPTION 'a Workflow approval proposal or accepted decision is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS workflow_approval_immutable ON ${s}.workflow_approvals;
CREATE TRIGGER workflow_approval_immutable BEFORE UPDATE ON ${s}.workflow_approvals
    FOR EACH ROW EXECUTE FUNCTION ${s}.workflow_approval_immutable();
ALTER TABLE ${s}.workflow_test_interceptions DROP CONSTRAINT IF EXISTS workflow_test_interceptions_operation_check;
ALTER TABLE ${s}.workflow_test_interceptions ADD CONSTRAINT workflow_test_interceptions_operation_check
    CHECK (operation IN ('tool.call', 'agent', 'send', 'request', 'approval'));
`;
}
