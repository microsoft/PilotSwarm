/**
 * Authoritative workflow execution facts plus a rebuildable current projection.
 *
 * Duroxide remains authoritative for control flow. These rows make externally
 * significant admissions and accepted results queryable and idempotent without
 * interpreting orchestration history. Lifecycle events are written in the same
 * transaction for diagnostics, but are not the authoritative record.
 */
export function workflowExecutionsMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
CREATE TABLE IF NOT EXISTS ${s}.workflow_state_executions (
    workflow_session_id TEXT NOT NULL REFERENCES ${s}.sessions(session_id) ON DELETE CASCADE,
    execution_sequence  BIGINT NOT NULL CHECK (execution_sequence > 0),
    graph_id             TEXT NOT NULL,
    state_id             TEXT NOT NULL,
    child_session_id     TEXT,
    waiting_on           TEXT NOT NULL CHECK (waiting_on IN ('activity', 'agent-result')),
    status               TEXT NOT NULL DEFAULT 'admitted' CHECK (status IN ('admitted', 'accepted')),
    outcome              TEXT,
    output_json          JSONB,
    admitted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    accepted_at          TIMESTAMPTZ,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workflow_session_id, execution_sequence)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_${schema}_workflow_execution_child
    ON ${s}.workflow_state_executions(child_session_id)
    WHERE child_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ${s}.workflow_projections (
    workflow_session_id       TEXT PRIMARY KEY REFERENCES ${s}.sessions(session_id) ON DELETE CASCADE,
    graph_id                  TEXT NOT NULL,
    status                    TEXT NOT NULL,
    current_state_id          TEXT,
    current_execution_sequence BIGINT,
    waiting_on                TEXT,
    terminal_outcome          TEXT,
    result_json               JSONB,
    completed_at              TIMESTAMPTZ,
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ${s}.workflow_completions (
    workflow_session_id TEXT PRIMARY KEY REFERENCES ${s}.sessions(session_id) ON DELETE CASCADE,
    graph_id            TEXT NOT NULL,
    terminal_state_id   TEXT NOT NULL,
    outcome             TEXT NOT NULL,
    summary             TEXT NOT NULL,
    result_json         JSONB NOT NULL,
    completed_at        TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION ${s}.cms_record_workflow_execution(
    p_workflow_session_id TEXT,
    p_execution_sequence  BIGINT,
    p_graph_id            TEXT,
    p_state_id            TEXT,
    p_child_session_id    TEXT,
    p_waiting_on          TEXT
) RETURNS VOID AS $$
DECLARE
    v_existing ${s}.workflow_state_executions%ROWTYPE;
    v_inserted INTEGER;
BEGIN
    IF p_execution_sequence < 1 THEN
        RAISE EXCEPTION 'WORKFLOW_EXECUTION_INVALID: execution sequence must be positive';
    END IF;
    IF p_waiting_on NOT IN ('activity', 'agent-result') THEN
        RAISE EXCEPTION 'WORKFLOW_EXECUTION_INVALID: unsupported waiting target %', p_waiting_on;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM ${s}.sessions
         WHERE session_id = p_workflow_session_id
           AND session_kind = 'workflow'
           AND deleted_at IS NULL
    ) THEN
        RAISE EXCEPTION 'WORKFLOW_SESSION_REQUIRED: workflow session % is unavailable', p_workflow_session_id;
    END IF;

    INSERT INTO ${s}.workflow_state_executions (
        workflow_session_id, execution_sequence, graph_id, state_id,
        child_session_id, waiting_on
    ) VALUES (
        p_workflow_session_id, p_execution_sequence, p_graph_id, p_state_id,
        p_child_session_id, p_waiting_on
    )
    ON CONFLICT (workflow_session_id, execution_sequence) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    IF v_inserted = 0 THEN
        SELECT * INTO v_existing
          FROM ${s}.workflow_state_executions
         WHERE workflow_session_id = p_workflow_session_id
           AND execution_sequence = p_execution_sequence;
        IF v_existing.graph_id IS DISTINCT FROM p_graph_id
            OR v_existing.state_id IS DISTINCT FROM p_state_id
            OR v_existing.child_session_id IS DISTINCT FROM p_child_session_id
            OR v_existing.waiting_on IS DISTINCT FROM p_waiting_on
        THEN
            RAISE EXCEPTION 'WORKFLOW_EXECUTION_CONFLICT: execution %/% has different identity',
                p_workflow_session_id, p_execution_sequence;
        END IF;
    ELSE
        INSERT INTO ${s}.session_events (session_id, event_type, data)
        VALUES (
            p_workflow_session_id,
            'workflow.execution_admitted',
            jsonb_build_object(
                'graphId', p_graph_id,
                'stateId', p_state_id,
                'executionSequence', p_execution_sequence,
                'childSessionId', p_child_session_id,
                'waitingOn', p_waiting_on
            )
        );
    END IF;

    INSERT INTO ${s}.workflow_projections (
        workflow_session_id, graph_id, status, current_state_id,
        current_execution_sequence, waiting_on
    ) VALUES (
        p_workflow_session_id, p_graph_id, 'running', p_state_id,
        p_execution_sequence, p_waiting_on
    )
    ON CONFLICT (workflow_session_id) DO UPDATE
    SET graph_id = EXCLUDED.graph_id,
        status = 'running',
        current_state_id = EXCLUDED.current_state_id,
        current_execution_sequence = EXCLUDED.current_execution_sequence,
        waiting_on = EXCLUDED.waiting_on,
        terminal_outcome = NULL,
        result_json = NULL,
        completed_at = NULL,
        updated_at = now()
    WHERE ${s}.workflow_projections.status = 'running'
      AND COALESCE(${s}.workflow_projections.current_execution_sequence, 0)
          <= EXCLUDED.current_execution_sequence;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_accept_workflow_execution(
    p_workflow_session_id TEXT,
    p_execution_sequence  BIGINT,
    p_graph_id            TEXT,
    p_state_id            TEXT,
    p_child_session_id    TEXT,
    p_outcome             TEXT,
    p_output_json         JSONB
) RETURNS VOID AS $$
DECLARE
    v_existing ${s}.workflow_state_executions%ROWTYPE;
BEGIN
    SELECT * INTO v_existing
      FROM ${s}.workflow_state_executions
     WHERE workflow_session_id = p_workflow_session_id
       AND execution_sequence = p_execution_sequence
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'WORKFLOW_EXECUTION_REQUIRED: execution %/% is unavailable',
            p_workflow_session_id, p_execution_sequence;
    END IF;
    IF v_existing.graph_id IS DISTINCT FROM p_graph_id
        OR v_existing.state_id IS DISTINCT FROM p_state_id
        OR v_existing.child_session_id IS DISTINCT FROM p_child_session_id
    THEN
        RAISE EXCEPTION 'WORKFLOW_EXECUTION_CONFLICT: execution %/% has different identity',
            p_workflow_session_id, p_execution_sequence;
    END IF;

    IF v_existing.status = 'accepted' THEN
        IF v_existing.outcome IS DISTINCT FROM p_outcome
            OR v_existing.output_json IS DISTINCT FROM p_output_json
        THEN
            RAISE EXCEPTION 'WORKFLOW_RESULT_CONFLICT: execution %/% already accepted a different result',
                p_workflow_session_id, p_execution_sequence;
        END IF;
        RETURN;
    END IF;

    UPDATE ${s}.workflow_state_executions
       SET status = 'accepted',
           outcome = p_outcome,
           output_json = p_output_json,
           accepted_at = now(),
           updated_at = now()
     WHERE workflow_session_id = p_workflow_session_id
       AND execution_sequence = p_execution_sequence;

    UPDATE ${s}.workflow_projections
       SET waiting_on = NULL,
           updated_at = now()
     WHERE workflow_session_id = p_workflow_session_id
       AND current_execution_sequence = p_execution_sequence
       AND status = 'running';

    IF p_child_session_id IS NOT NULL THEN
        INSERT INTO ${s}.session_child_outcomes (
            child_session_id, parent_session_id, result_json,
            verdict, summary, completed_at
        ) VALUES (
            p_child_session_id,
            p_workflow_session_id,
            jsonb_build_object(
                'kind', 'workflow-state-result',
                'graphId', p_graph_id,
                'stateId', p_state_id,
                'executionSequence', p_execution_sequence,
                'outcome', p_outcome,
                'output', p_output_json
            ),
            p_outcome,
            format('Workflow state %L completed with outcome %L.', p_state_id, p_outcome),
            now()
        )
        ON CONFLICT (child_session_id) DO UPDATE
        SET parent_session_id = EXCLUDED.parent_session_id,
            result_json = EXCLUDED.result_json,
            verdict = EXCLUDED.verdict,
            summary = EXCLUDED.summary,
            completed_at = COALESCE(${s}.session_child_outcomes.completed_at, EXCLUDED.completed_at),
            updated_at = now();
    END IF;

    INSERT INTO ${s}.session_events (session_id, event_type, data)
    VALUES (
        p_workflow_session_id,
        'workflow.execution_accepted',
        jsonb_build_object(
            'graphId', p_graph_id,
            'stateId', p_state_id,
            'executionSequence', p_execution_sequence,
            'childSessionId', p_child_session_id,
            'outcome', p_outcome
        )
    );
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_complete_workflow(
    p_workflow_session_id TEXT,
    p_parent_session_id   TEXT,
    p_graph_id            TEXT,
    p_terminal_state_id   TEXT,
    p_outcome             TEXT,
    p_summary             TEXT,
    p_result_json         JSONB,
    p_completed_at        TIMESTAMPTZ
) RETURNS VOID AS $$
DECLARE
    v_existing ${s}.workflow_completions%ROWTYPE;
    v_inserted INTEGER;
BEGIN
    INSERT INTO ${s}.workflow_completions (
        workflow_session_id, graph_id, terminal_state_id, outcome,
        summary, result_json, completed_at
    ) VALUES (
        p_workflow_session_id, p_graph_id, p_terminal_state_id, p_outcome,
        p_summary, p_result_json, p_completed_at
    )
    ON CONFLICT (workflow_session_id) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;

    IF v_inserted = 0 THEN
        SELECT * INTO v_existing
          FROM ${s}.workflow_completions
         WHERE workflow_session_id = p_workflow_session_id
         FOR UPDATE;
        IF v_existing.graph_id IS DISTINCT FROM p_graph_id
            OR v_existing.terminal_state_id IS DISTINCT FROM p_terminal_state_id
            OR v_existing.outcome IS DISTINCT FROM p_outcome
            OR v_existing.summary IS DISTINCT FROM p_summary
            OR v_existing.result_json IS DISTINCT FROM p_result_json
            OR v_existing.completed_at IS DISTINCT FROM p_completed_at
        THEN
            RAISE EXCEPTION 'WORKFLOW_COMPLETION_CONFLICT: workflow % already completed differently',
                p_workflow_session_id;
        END IF;
    END IF;

    INSERT INTO ${s}.workflow_projections (
        workflow_session_id, graph_id, status, current_state_id,
        current_execution_sequence, waiting_on, terminal_outcome,
        result_json, completed_at
    ) VALUES (
        p_workflow_session_id, p_graph_id, p_outcome, p_terminal_state_id,
        (
            SELECT MAX(execution_sequence)
              FROM ${s}.workflow_state_executions
             WHERE workflow_session_id = p_workflow_session_id
        ),
        NULL, p_outcome,
        p_result_json, p_completed_at
    )
    ON CONFLICT (workflow_session_id) DO UPDATE
    SET graph_id = EXCLUDED.graph_id,
        status = EXCLUDED.status,
        current_state_id = EXCLUDED.current_state_id,
        waiting_on = NULL,
        terminal_outcome = EXCLUDED.terminal_outcome,
        result_json = EXCLUDED.result_json,
        completed_at = EXCLUDED.completed_at,
        updated_at = now();

    IF p_parent_session_id IS NOT NULL THEN
        INSERT INTO ${s}.session_child_outcomes (
            child_session_id, parent_session_id, result_json,
            verdict, summary, completed_at
        ) VALUES (
            p_workflow_session_id, p_parent_session_id, p_result_json,
            p_outcome, p_summary, p_completed_at
        )
        ON CONFLICT (child_session_id) DO UPDATE
        SET parent_session_id = EXCLUDED.parent_session_id,
            result_json = EXCLUDED.result_json,
            verdict = EXCLUDED.verdict,
            summary = EXCLUDED.summary,
            completed_at = EXCLUDED.completed_at,
            updated_at = now();
    END IF;

    IF v_inserted = 1 THEN
        INSERT INTO ${s}.session_events (session_id, event_type, data)
        VALUES (
            p_workflow_session_id,
            'workflow.completed',
            jsonb_build_object(
                'graphId', p_graph_id,
                'terminalStateId', p_terminal_state_id,
                'outcome', p_outcome
            )
        );
    END IF;
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
        current_execution_sequence, waiting_on, terminal_outcome,
        result_json, completed_at
    )
    SELECT c.workflow_session_id, c.graph_id, c.outcome, c.terminal_state_id,
           (
               SELECT MAX(e.execution_sequence)
                 FROM ${s}.workflow_state_executions e
                WHERE e.workflow_session_id = c.workflow_session_id
           ),
           NULL, c.outcome, c.result_json, c.completed_at
      FROM ${s}.workflow_completions c
     WHERE c.workflow_session_id = p_workflow_session_id;

    IF FOUND THEN
        RETURN;
    END IF;

    INSERT INTO ${s}.workflow_projections (
        workflow_session_id, graph_id, status, current_state_id,
        current_execution_sequence, waiting_on
    )
    SELECT e.workflow_session_id, e.graph_id, 'running', e.state_id,
           e.execution_sequence,
           CASE WHEN e.status = 'accepted' THEN NULL ELSE e.waiting_on END
      FROM ${s}.workflow_state_executions e
     WHERE e.workflow_session_id = p_workflow_session_id
     ORDER BY e.execution_sequence DESC
     LIMIT 1;
END;
$$ LANGUAGE plpgsql;
`;
}
