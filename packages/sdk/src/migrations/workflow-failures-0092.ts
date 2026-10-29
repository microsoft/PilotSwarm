/**
 * Durable workflow orchestration failures and projection reconciliation.
 *
 * Duroxide remains authoritative for orchestration lifecycle. When a
 * management read observes a failed orchestration, this migration records an
 * authoritative failure fact and atomically advances the workflow projection.
 */
export function workflowFailuresMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
CREATE TABLE IF NOT EXISTS ${s}.workflow_failures (
    workflow_session_id TEXT PRIMARY KEY REFERENCES ${s}.sessions(session_id) ON DELETE CASCADE,
    graph_id            TEXT NOT NULL,
    orchestration_status TEXT NOT NULL CHECK (orchestration_status = 'Failed'),
    error_message       TEXT,
    failed_at           TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION ${s}.cms_fail_workflow(
    p_workflow_session_id TEXT,
    p_error_message       TEXT,
    p_failed_at           TIMESTAMPTZ
) RETURNS BOOLEAN AS $$
DECLARE
    v_projection ${s}.workflow_projections%ROWTYPE;
BEGIN
    SELECT * INTO v_projection
      FROM ${s}.workflow_projections
     WHERE workflow_session_id = p_workflow_session_id
     FOR UPDATE;

    IF NOT FOUND OR v_projection.status <> 'running' THEN
        RETURN FALSE;
    END IF;

    INSERT INTO ${s}.workflow_failures (
        workflow_session_id, graph_id, orchestration_status,
        error_message, failed_at
    ) VALUES (
        p_workflow_session_id, v_projection.graph_id, 'Failed',
        p_error_message, p_failed_at
    )
    ON CONFLICT (workflow_session_id) DO NOTHING;

    UPDATE ${s}.workflow_projections
       SET status = 'failed',
           waiting_on = NULL,
           waiting_details_json = NULL,
           terminal_outcome = 'failed',
           result_json = jsonb_build_object(
               'orchestrationStatus', 'Failed',
               'error', p_error_message
           ),
           completed_at = p_failed_at,
           updated_at = now()
     WHERE workflow_session_id = p_workflow_session_id
       AND status = 'running';

    UPDATE ${s}.sessions
       SET state = 'failed',
           last_error = p_error_message,
           wait_reason = NULL,
           updated_at = now()
     WHERE session_id = p_workflow_session_id;

    INSERT INTO ${s}.session_events (session_id, event_type, data)
    VALUES (
        p_workflow_session_id,
        'workflow.failed',
        jsonb_build_object(
            'graphId', v_projection.graph_id,
            'orchestrationStatus', 'Failed',
            'error', p_error_message
        )
    );

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_rebuild_workflow_projection(
    p_workflow_session_id TEXT
) RETURNS VOID AS $$
BEGIN
    DELETE FROM ${s}.workflow_projections
     WHERE workflow_session_id = p_workflow_session_id;

    INSERT INTO ${s}.workflow_projections (
        workflow_session_id, graph_id, status, current_state_id,
        current_execution_sequence, waiting_on, waiting_details_json, terminal_outcome,
        result_json, completed_at
    )
    SELECT c.workflow_session_id, c.graph_id, c.outcome, c.terminal_state_id,
           (
               SELECT MAX(e.execution_sequence)
                 FROM ${s}.workflow_state_executions e
                WHERE e.workflow_session_id = c.workflow_session_id
           ),
           NULL, NULL, c.outcome, c.result_json, c.completed_at
      FROM ${s}.workflow_completions c
     WHERE c.workflow_session_id = p_workflow_session_id;

    IF FOUND THEN
        RETURN;
    END IF;

    INSERT INTO ${s}.workflow_projections (
        workflow_session_id, graph_id, status, current_state_id,
        current_execution_sequence, waiting_on, waiting_details_json, terminal_outcome,
        result_json, completed_at
    )
    SELECT f.workflow_session_id, f.graph_id, 'failed', e.state_id,
           e.execution_sequence, NULL, NULL, 'failed',
           jsonb_build_object(
               'orchestrationStatus', f.orchestration_status,
               'error', f.error_message
           ),
           f.failed_at
      FROM ${s}.workflow_failures f
      LEFT JOIN LATERAL (
          SELECT execution_sequence, state_id
            FROM ${s}.workflow_state_executions
           WHERE workflow_session_id = f.workflow_session_id
           ORDER BY execution_sequence DESC
           LIMIT 1
      ) e ON TRUE
     WHERE f.workflow_session_id = p_workflow_session_id;

    IF FOUND THEN
        RETURN;
    END IF;

    INSERT INTO ${s}.workflow_projections (
        workflow_session_id, graph_id, status, current_state_id,
        current_execution_sequence, waiting_on, waiting_details_json
    )
    SELECT e.workflow_session_id, e.graph_id, 'running', e.state_id,
           e.execution_sequence,
           CASE WHEN e.status = 'accepted' THEN NULL ELSE e.waiting_on END,
           CASE WHEN e.status = 'accepted' THEN NULL ELSE e.waiting_details_json END
      FROM ${s}.workflow_state_executions e
     WHERE e.workflow_session_id = p_workflow_session_id
     ORDER BY e.execution_sequence DESC
     LIMIT 1;
END;
$$ LANGUAGE plpgsql;
`;
}
