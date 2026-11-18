/**
 * Migration 0096: retain a finished live Workflow's complete outcome with its owner, then sweep the child session.
 *
 * One SQL helper covers normal controller ends, command/deadline/stop ends, trigger-driven cancellation and legacy
 * Sweeper backfill. An outcome survives deletion of its child, but deleting its owner removes that owner's rows.
 */
export function workflowOutcomeRetentionMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `CREATE OR REPLACE FUNCTION ${s}.workflow_record_terminal_outcome(p_run_id TEXT) RETURNS VOID AS $$
DECLARE
    v_run RECORD;
    v_current JSONB;
    v_finished_at TIMESTAMPTZ;
BEGIN
    SELECT run.*, definition.parent_session_id, definition.session_definition_id, definition.session_revision,
           revision.name, revision.semver
      INTO v_run
      FROM ${s}.workflow_runs AS run
      JOIN ${s}.workflow_definitions AS definition USING (workflow_session_id)
      JOIN ${s}.workflow_revisions AS revision
        ON revision.workflow_session_id = run.workflow_session_id AND revision.revision = run.revision
     WHERE run.run_id = p_run_id
       AND run.mode = 'live'
       AND run.status NOT IN ('admitted', 'running', 'paused');
    IF NOT FOUND OR v_run.parent_session_id IS NULL THEN
        RETURN;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM ${s}.sessions
         WHERE session_id = v_run.parent_session_id AND deleted_at IS NULL
    ) THEN
        RETURN;
    END IF;

    v_finished_at := COALESCE(v_run.finished_at, v_run.updated_at);
    v_current := jsonb_build_object(
        'kind', 'workflow',
        'sessionId', v_run.workflow_session_id,
        'parentSessionId', v_run.parent_session_id,
        'runId', v_run.run_id,
        'revision', v_run.revision,
        'name', v_run.name,
        'version', v_run.semver,
        'sourceDefinitionId', v_run.session_definition_id,
        'sourceRevision', v_run.session_revision,
        'status', v_run.status,
        'outcome', v_run.terminal_outcome,
        'stateId', v_run.terminal_node_id,
        'outputText', CASE WHEN v_run.terminal_output IS NULL THEN 'null'::jsonb ELSE to_jsonb(v_run.terminal_output) END,
        'errorText', CASE WHEN v_run.terminal_error IS NULL THEN 'null'::jsonb ELSE to_jsonb(v_run.terminal_error) END,
        'completedAt', to_char(v_finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );

    INSERT INTO ${s}.session_child_outcomes (
        child_session_id, parent_session_id, result_json, verdict, summary, completed_at
    ) VALUES (
        v_run.workflow_session_id,
        v_run.parent_session_id,
        jsonb_build_object('current', v_current, 'revisions', jsonb_build_array(jsonb_build_object(
            'revision', 1,
            'submittedAt', to_char(v_finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'submittedBySessionId', v_run.workflow_session_id,
            'result', v_current
        ))),
        COALESCE(v_run.terminal_outcome, v_run.status),
        COALESCE('Workflow ' || v_run.name, 'Workflow') || ' ' || v_run.status ||
            CASE WHEN v_run.terminal_outcome IS NULL THEN '.' ELSE ' with outcome ' || v_run.terminal_outcome || '.' END,
        v_finished_at
    ) ON CONFLICT (child_session_id) DO UPDATE
    SET parent_session_id = EXCLUDED.parent_session_id,
        result_json = EXCLUDED.result_json,
        verdict = EXCLUDED.verdict,
        summary = EXCLUDED.summary,
        completed_at = EXCLUDED.completed_at,
        updated_at = now();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.workflow_on_session_deleted() RETURNS TRIGGER AS $$
DECLARE
    v_envelope CONSTANT TEXT := '{"code":"cancelled","message":"The workflow session was deleted."}';
BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        UPDATE ${s}.workflow_definitions
           SET state = 'deleted', updated_at = now()
         WHERE workflow_session_id = NEW.session_id
           AND state <> 'deleted';
        UPDATE ${s}.workflow_node_executions AS node
           SET state = 'completed', outcome = 'cancelled', result_kind = 'runtime_error',
               error = v_envelope, output = NULL, winner = 'delete', completed_at = now()
          FROM ${s}.workflow_runs AS run
         WHERE run.run_id = node.run_id
           AND run.workflow_session_id = NEW.session_id
           AND run.status IN ('admitted', 'running', 'paused')
           AND node.state = 'pending';
        UPDATE ${s}.workflow_runs
           SET status = 'cancelled', paused_from = NULL, terminal_error = v_envelope, updated_at = now(), finished_at = now()
         WHERE workflow_session_id = NEW.session_id
           AND status IN ('admitted', 'running', 'paused');
        PERFORM ${s}.workflow_record_terminal_outcome(run.run_id)
          FROM ${s}.workflow_runs AS run
         WHERE run.workflow_session_id = NEW.session_id AND run.mode = 'live';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.workflow_on_owner_session_ended() RETURNS TRIGGER AS $$
DECLARE
    v_envelope CONSTANT TEXT := '{"code":"cancelled","message":"The session that owns this Workflow ended, so the Workflow was canceled."}';
    v_ended INTEGER;
BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        UPDATE ${s}.session_workflow_definitions
           SET deleted_at = now(), deleted_by = '{"kind":"system","name":"owner-session-deleted"}', updated_at = now()
         WHERE owner_session_id = NEW.session_id AND deleted_at IS NULL;
        PERFORM 1 FROM ${s}.sessions
          WHERE parent_session_id = NEW.session_id AND session_kind = 'workflow' AND deleted_at IS NULL
          ORDER BY session_id
          FOR NO KEY UPDATE;
        UPDATE ${s}.sessions
           SET deleted_at = now(), updated_at = now()
         WHERE parent_session_id = NEW.session_id AND session_kind = 'workflow' AND deleted_at IS NULL;
    ELSIF NEW.state IN ('completed', 'cancelled', 'failed') AND OLD.state IS DISTINCT FROM NEW.state THEN
        PERFORM 1 FROM ${s}.sessions
          WHERE parent_session_id = NEW.session_id AND session_kind = 'workflow' AND deleted_at IS NULL
          ORDER BY session_id
          FOR NO KEY UPDATE;
        PERFORM 1 FROM ${s}.workflow_runs AS run
          JOIN ${s}.sessions AS child ON child.session_id = run.workflow_session_id
         WHERE child.parent_session_id = NEW.session_id AND child.session_kind = 'workflow'
           AND run.mode IN ('live', 'test') AND run.status IN ('admitted', 'running', 'paused')
         ORDER BY run.run_id
           FOR UPDATE OF run;
        UPDATE ${s}.workflow_node_executions AS node
           SET state = 'completed', outcome = 'cancelled', result_kind = 'runtime_error',
               error = v_envelope, output = NULL, winner = 'delete', completed_at = now()
          FROM ${s}.workflow_runs AS run, ${s}.sessions AS child
         WHERE run.run_id = node.run_id
           AND run.workflow_session_id = child.session_id
           AND child.parent_session_id = NEW.session_id AND child.session_kind = 'workflow'
           AND run.mode IN ('live', 'test') AND run.status IN ('admitted', 'running', 'paused')
           AND node.state = 'pending';
        WITH ended AS (
            UPDATE ${s}.workflow_runs AS run
               SET status = 'cancelled', paused_from = NULL, terminal_error = v_envelope, updated_at = now(), finished_at = now()
              FROM ${s}.sessions AS child
             WHERE run.workflow_session_id = child.session_id
               AND child.parent_session_id = NEW.session_id AND child.session_kind = 'workflow'
               AND run.mode IN ('live', 'test') AND run.status IN ('admitted', 'running', 'paused')
            RETURNING run.run_id, run.workflow_session_id, run.mode
        ), recorded AS (
            SELECT ${s}.workflow_record_terminal_outcome(run_id) AS ignored
              FROM ended
             WHERE mode = 'live'
        ), updated AS (
            UPDATE ${s}.sessions
               SET state = 'cancelled', updated_at = now()
             WHERE session_id IN (SELECT workflow_session_id FROM ended) AND deleted_at IS NULL
            RETURNING session_id
        )
        SELECT count(*) INTO v_ended
          FROM updated
          CROSS JOIN (SELECT count(*) FROM recorded) AS retained;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_soft_delete_session(
    p_session_id TEXT
) RETURNS VOID AS $$
DECLARE
    v_is_system BOOLEAN;
BEGIN
    SELECT is_system INTO v_is_system
    FROM ${s}.sessions
    WHERE session_id = p_session_id;

    IF v_is_system THEN
        RAISE EXCEPTION 'Cannot delete system session';
    END IF;

    UPDATE ${s}.sessions
    SET deleted_at = now(), updated_at = now()
    WHERE session_id = p_session_id;

    DELETE FROM ${s}.session_child_outcomes
    WHERE parent_session_id = p_session_id;

    UPDATE ${s}.session_metric_summaries
    SET deleted_at = now(), updated_at = now()
    WHERE session_id = p_session_id;
END;
$$ LANGUAGE plpgsql;
`;
}
