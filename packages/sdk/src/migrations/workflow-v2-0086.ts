/**
 * Migration 0086 — workflow v2 exclusive session creation and deletion.
 *
 * Kept separate from 0085, which an earlier build may already have recorded:
 * the migrator never re-runs a recorded version, so these objects must come
 * from a new version. Every statement is idempotent (CREATE OR REPLACE,
 * DROP TRIGGER IF EXISTS), so a schema that already has them is unchanged.
 *
 * - cms_create_workflow_session_v2: claims a session row for a v2 workflow;
 *   an existing row of any kind is never changed.
 * - workflow_v2_on_session_deleted: deleting the session ends its v2 workflow
 *   in the same transaction (tombstone, cancelled runs, pending nodes lose).
 */
export function workflowV2SessionLifecycleMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0086_workflow_v2_session_lifecycle
-- Exclusive creation of a v2 workflow session row. The INSERT is the claim:
-- when any row with this id exists (live or deleted, of any kind, committed
-- or being inserted concurrently), nothing is changed and FALSE is returned.
-- Root, group and visibility resolve as in cms_create_session.
CREATE OR REPLACE FUNCTION ${s}.cms_create_workflow_session_v2(
    p_session_id        TEXT,
    p_parent_session_id TEXT,
    p_creation_config   JSONB
) RETURNS BOOLEAN AS $$
DECLARE
    v_root    TEXT;
    v_group   TEXT;
    v_claimed TEXT;
BEGIN
    IF p_parent_session_id IS NOT NULL THEN
        SELECT COALESCE(parent.root_session_id, parent.session_id), parent.group_id
          INTO v_root, v_group
          FROM ${s}.sessions parent
         WHERE parent.session_id = p_parent_session_id;
    END IF;
    v_root := COALESCE(v_root, p_session_id);

    INSERT INTO ${s}.sessions
        (session_id, parent_session_id, is_system, group_id, root_session_id, visibility, session_kind, creation_config)
    VALUES
        (p_session_id, p_parent_session_id, FALSE, v_group, v_root, 'private', 'workflow', p_creation_config)
    ON CONFLICT (session_id) DO NOTHING
    RETURNING session_id INTO v_claimed;

    IF v_claimed IS NULL THEN
        RETURN FALSE;
    END IF;

    INSERT INTO ${s}.session_metric_summaries (session_id, parent_session_id)
    VALUES (p_session_id, p_parent_session_id)
    ON CONFLICT (session_id) DO UPDATE
    SET parent_session_id = COALESCE(${s}.session_metric_summaries.parent_session_id, EXCLUDED.parent_session_id),
        updated_at        = now();
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Deleting a workflow session ends its v2 workflow in the same transaction,
-- whatever deletes it: the definition becomes a permanent tombstone, active
-- runs are cancelled and their pending node executions lose to the deletion.
-- Every v2 transition locks the session row first and re-checks deleted_at,
-- so nothing admits, starts or completes work after this commits.
CREATE OR REPLACE FUNCTION ${s}.workflow_v2_on_session_deleted() RETURNS TRIGGER AS $$
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
           AND run.status IN ('admitted', 'running')
           AND node.state = 'pending';
        UPDATE ${s}.workflow_runs
           SET status = 'cancelled', terminal_error = v_envelope, updated_at = now(), finished_at = now()
         WHERE workflow_session_id = NEW.session_id
           AND status IN ('admitted', 'running');
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_v2_session_deleted ON ${s}.sessions;
CREATE TRIGGER workflow_v2_session_deleted
    AFTER UPDATE OF deleted_at ON ${s}.sessions
    FOR EACH ROW EXECUTE FUNCTION ${s}.workflow_v2_on_session_deleted();
`;
}
