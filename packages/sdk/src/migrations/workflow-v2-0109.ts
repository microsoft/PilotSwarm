/**
 * Migration 0109 — Workflow Simplified stage 2 review (S2RT-F2, S2RT-F6): the chat-ended trigger takes its locks in the
 * runtime's order, and ends a chat's hidden tests too.
 *
 * 0107's trigger (a chat completed, canceled, failed, or deleted ends its Workflows; R5, F2) changed its Workflows' node
 * rows, then their runs, then their session rows. Every runtime transaction locks a Workflow's session row first, then its
 * definition, run and node rows. A runtime transaction holding a Workflow's session row and waiting for its run, while the
 * chat's update held that run and waited for the session row, was a deadlock (S2RT-F2).
 *
 * The function is replaced in place (the trigger 0107 created calls it by name and is unchanged). It now:
 * - holds the chat's own row (the UPDATE that fired it) first, as before;
 * - deleted chat: marks its definitions deleted, then locks its Workflow session rows in session_id order, then soft-deletes
 *   them (0090's trigger ends each one's runs from its own session row, as before);
 * - completed, canceled or failed chat: locks its Workflow session rows in session_id order, then their active runs in
 *   run_id order, then ends their pending nodes, their runs and their sessions. The runs ended are the live ones and, since
 *   this migration, the test ones (S2RT-F6: a hidden test bench is a Workflow session of the chat; its report stays).
 *
 * A paused run that it cancels has its paused_from cleared, as the deletion trigger of 0091 does: 0107's function left it
 * set, so ending a chat whose Workflow was paused broke the 0091 check workflow_runs_paused_from and failed the chat's
 * own update.
 *
 * Idempotent (CREATE OR REPLACE), one transaction, no data rewritten.
 */
export function workflowChatEndedLockOrderMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0109_workflow_chat_ended_lock_order
CREATE OR REPLACE FUNCTION ${s}.workflow_v2_on_chat_ended() RETURNS TRIGGER AS $$
DECLARE
    v_envelope CONSTANT TEXT := '{"code":"cancelled","message":"The chat that owns this Workflow ended, so the Workflow was canceled."}';
BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        UPDATE ${s}.workflow_chat_definitions
           SET deleted_at = now(), deleted_by = '{"kind":"system","name":"chat-deleted"}', updated_at = now()
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
            RETURNING run.workflow_session_id
        )
        UPDATE ${s}.sessions
           SET state = 'cancelled', updated_at = now()
         WHERE session_id IN (SELECT workflow_session_id FROM ended) AND deleted_at IS NULL;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
`;
}
