/**
 * Migration 0089 — Workflow: session names. Migration 0088 (unchanged) named the session that owns Workflow Definitions
 * "chat"; this renames those objects, on any database at 0088, in one transaction:
 * - the owner side's tables workflow_chat_{definitions,revisions,operations,seen,notes} -> session_workflow_*, with
 *   their indexes, constraints (primary keys, the revisions' foreign key and checks) and the notes' sequence;
 * - workflow_definitions.chat_definition_id / chat_revision -> session_definition_id / session_revision, and the index
 *   workflow_definitions_by_chat_definition -> workflow_definitions_by_session_definition;
 * - the trigger workflow_chat_ended -> workflow_owner_session_ended and its function workflow_on_chat_ended ->
 *   workflow_on_owner_session_ended. The function is renamed (the trigger keeps it), then replaced with a body that
 *   names the renamed table; no other 0088 function names a renamed table or column.
 * - The stored values that named the owning session or the agent session "chat": an actor kind 'chat' (revisions'
 *   actor, definitions' created_by and deleted_by) -> 'session'; the system deleter 'chat-deleted' ->
 *   'owner-session-deleted'; a definition source 'chat' -> 'session'; an agent invocation's end status ChatEnded /
 *   ChatContinues -> AgentSessionEnded / AgentSessionContinues.
 * Each step checks the catalog or names the old value, so a run again (or after a partial run) changes nothing. It never
 * builds an index (no CONCURRENTLY) and takes its locks under a 5 s lock timeout, on PostgreSQL and HorizonDB alike.
 */
export function workflowSessionNamesMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    const name = schema.replace(/'/g, "''");
    return `
SET LOCAL lock_timeout = '5s';

DO $tables$
DECLARE
    v_old TEXT;
BEGIN
    FOREACH v_old IN ARRAY ARRAY['definitions', 'revisions', 'operations', 'seen', 'notes'] LOOP
        IF to_regclass(format('%I.%I', '${name}', 'workflow_chat_' || v_old)) IS NOT NULL
           AND to_regclass(format('%I.%I', '${name}', 'session_workflow_' || v_old)) IS NULL THEN
            EXECUTE format('ALTER TABLE %I.%I RENAME TO %I', '${name}', 'workflow_chat_' || v_old, 'session_workflow_' || v_old);
        END IF;
    END LOOP;
END
$tables$;

-- Constraints first (renaming a primary key renames its index), then the other indexes and the notes' sequence.
DO $constraints$
DECLARE
    v_row RECORD;
BEGIN
    FOR v_row IN
        SELECT c.conname, t.relname
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
         WHERE n.nspname = '${name}' AND t.relname LIKE 'session\\_workflow\\_%' AND c.conname LIKE 'workflow\\_chat\\_%'
         ORDER BY c.conname
    LOOP
        EXECUTE format('ALTER TABLE %I.%I RENAME CONSTRAINT %I TO %I', '${name}', v_row.relname, v_row.conname,
            'session_workflow_' || substr(v_row.conname, length('workflow_chat_') + 1));
    END LOOP;
    FOR v_row IN
        SELECT c.relname, c.relkind
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = '${name}' AND c.relkind IN ('i', 'S') AND c.relname LIKE 'workflow\\_chat\\_%'
         ORDER BY c.relname
    LOOP
        EXECUTE format(CASE WHEN v_row.relkind = 'S' THEN 'ALTER SEQUENCE %I.%I RENAME TO %I' ELSE 'ALTER INDEX %I.%I RENAME TO %I' END,
            '${name}', v_row.relname, 'session_workflow_' || substr(v_row.relname, length('workflow_chat_') + 1));
    END LOOP;
END
$constraints$;

DO $columns$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = '${name}' AND table_name = 'workflow_definitions' AND column_name = 'chat_definition_id') THEN
        ALTER TABLE ${s}.workflow_definitions RENAME COLUMN chat_definition_id TO session_definition_id;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = '${name}' AND table_name = 'workflow_definitions' AND column_name = 'chat_revision') THEN
        ALTER TABLE ${s}.workflow_definitions RENAME COLUMN chat_revision TO session_revision;
    END IF;
END
$columns$;
ALTER INDEX IF EXISTS ${s}.workflow_definitions_by_chat_definition RENAME TO workflow_definitions_by_session_definition;

-- The function keeps its trigger when renamed; its body then names the renamed table and the new deleter.
DO $function$
BEGIN
    IF to_regprocedure(format('%I.%I()', '${name}', 'workflow_on_chat_ended')) IS NOT NULL
       AND to_regprocedure(format('%I.%I()', '${name}', 'workflow_on_owner_session_ended')) IS NULL THEN
        ALTER FUNCTION ${s}.workflow_on_chat_ended() RENAME TO workflow_on_owner_session_ended;
    END IF;
END
$function$;

-- A session that owns Workflows ends them, locking in the runtime's order (migration 0088's header).
CREATE OR REPLACE FUNCTION ${s}.workflow_on_owner_session_ended() RETURNS TRIGGER AS $$
DECLARE
    v_envelope CONSTANT TEXT := '{"code":"cancelled","message":"The session that owns this Workflow ended, so the Workflow was canceled."}';
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
            RETURNING run.workflow_session_id
        )
        UPDATE ${s}.sessions
           SET state = 'cancelled', updated_at = now()
         WHERE session_id IN (SELECT workflow_session_id FROM ended) AND deleted_at IS NULL;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $trigger$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = '${s}.sessions'::regclass AND tgname = 'workflow_chat_ended')
       AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = '${s}.sessions'::regclass AND tgname = 'workflow_owner_session_ended') THEN
        ALTER TRIGGER workflow_chat_ended ON ${s}.sessions RENAME TO workflow_owner_session_ended;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = '${s}.sessions'::regclass AND tgname = 'workflow_owner_session_ended') THEN
        CREATE TRIGGER workflow_owner_session_ended
            AFTER UPDATE OF state, deleted_at ON ${s}.sessions
            FOR EACH ROW
            WHEN (NEW.session_kind IS DISTINCT FROM 'workflow'
                  AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at))
            EXECUTE FUNCTION ${s}.workflow_on_owner_session_ended();
    END IF;
END
$trigger$;
DROP FUNCTION IF EXISTS ${s}.workflow_on_chat_ended();

-- Stored values that said "chat" (canonical JSON text: no spaces, so the old value is matched exactly).
UPDATE ${s}.session_workflow_revisions
   SET actor = replace(actor, '"kind":"chat"', '"kind":"session"')
 WHERE actor LIKE '%"kind":"chat"%';
UPDATE ${s}.session_workflow_definitions
   SET created_by = replace(created_by, '"kind":"chat"', '"kind":"session"')
 WHERE created_by LIKE '%"kind":"chat"%';
UPDATE ${s}.session_workflow_definitions
   SET deleted_by = replace(replace(deleted_by, '"kind":"chat"', '"kind":"session"'), '"name":"chat-deleted"', '"name":"owner-session-deleted"')
 WHERE deleted_by LIKE '%"kind":"chat"%' OR deleted_by LIKE '%"name":"chat-deleted"%';
UPDATE ${s}.session_workflow_definitions SET source = 'session' WHERE source = 'chat';
UPDATE ${s}.workflow_agent_invocations SET end_child_status = 'AgentSessionEnded' WHERE end_child_status = 'ChatEnded';
UPDATE ${s}.workflow_agent_invocations SET end_child_status = 'AgentSessionContinues' WHERE end_child_status = 'ChatContinues';
`;
}
