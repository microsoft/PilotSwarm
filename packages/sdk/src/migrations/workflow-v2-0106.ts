/**
 * Migration 0106 — workflow v2 agent chats that continue (owner decision
 * agent-node-continue-20261106: an agent state with `chat: continue` keeps
 * one agent chat per run and state, and each later visit of the state is a
 * new cycle prompt in that same chat).
 *
 * - workflow_agent_invocations.child_session_id is no longer UNIQUE: the
 *   visits of a continued chat are one invocation each (node_execution_id
 *   stays the primary key) that all name the same child session. A plain
 *   index keeps the lookups by child (a completion, a reminder) fast. A
 *   state without `chat: continue` still names one child per visit, as
 *   before.
 *
 * Additive in effect: the uniqueness dropped, one index added; no row
 * changes. The only ON CONFLICT on a child_session_id is on another table
 * (session_child_outcomes).
 *
 * The uniqueness is found by what it is, not by its name (review RT-6): every
 * UNIQUE constraint on exactly (child_session_id), whatever it is called, and
 * every unique index on exactly that column that no constraint owns, is
 * dropped. If one still remains, the migration fails, so 0106 is never
 * recorded while a second visit of a chat would fail (SQLSTATE 23505).
 */
export function workflowV2AgentChatContinuesMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0106_workflow_v2_agent_chat_continues

DO $$
DECLARE
    v_rel REGCLASS := '${s}.workflow_agent_invocations'::regclass;
    v_col SMALLINT;
    v_name TEXT;
BEGIN
    SELECT a.attnum INTO v_col FROM pg_attribute a
     WHERE a.attrelid = v_rel AND a.attname = 'child_session_id' AND NOT a.attisdropped;
    -- Every UNIQUE constraint on exactly (child_session_id), whatever its name (its index goes with it).
    FOR v_name IN SELECT c.conname FROM pg_constraint c
                   WHERE c.conrelid = v_rel AND c.contype = 'u'
                     AND array_length(c.conkey, 1) = 1 AND c.conkey[1] = v_col LOOP
        EXECUTE format('ALTER TABLE ${s}.workflow_agent_invocations DROP CONSTRAINT %I', v_name);
    END LOOP;
    -- Every unique index on exactly (child_session_id) that no constraint owns, partial or not.
    FOR v_name IN SELECT x.relname FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid
                   WHERE i.indrelid = v_rel AND i.indisunique AND NOT i.indisprimary
                     AND i.indnkeyatts = 1 AND i.indkey[0] = v_col
                     AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid) LOOP
        EXECUTE format('DROP INDEX ${s}.%I', v_name);
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_index i
                WHERE i.indrelid = v_rel AND i.indisunique AND NOT i.indisprimary
                  AND i.indnkeyatts = 1 AND i.indkey[0] = v_col) THEN
        RAISE EXCEPTION '0106: workflow_agent_invocations.child_session_id is still unique; a chat that continues needs one row per visit';
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS workflow_agent_invocations_by_child ON ${s}.workflow_agent_invocations (child_session_id, created_at);
`;
}
