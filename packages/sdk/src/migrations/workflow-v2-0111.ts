/**
 * Migration 0111 — an index on sessions.parent_session_id (release safety; the owner decided yes).
 *
 * A chat's end and a session's deletion run the Workflow triggers of migrations 0107 and 0109, which look up the chat's
 * Workflow sessions with `parent_session_id = <the chat>` four or five times; spawn_agent and a Workflow's Start count a
 * chat's running children the same way (child-budget.ts childBudgetCountSql). Without an index on parent_session_id each
 * of those reads scans every session row, on every chat end and delete.
 *
 * Built CONCURRENTLY, as autocommit steps (the migrator's `steps` mode, as migration 0029 builds
 * idx_<schema>_sessions_root), so writes to sessions go on during the build; a plain CREATE INDEX would hold a lock that
 * blocks every insert, update and delete of sessions until the build ends. A concurrent build that failed leaves an
 * invalid index that IF NOT EXISTS would keep: the first step drops it, so a retry builds it again. That drop needs an
 * exclusive lock on sessions, so it runs in its own transaction under a 5 s lock_timeout (review DS2-004; 0029's shape for
 * its quick lock steps): a drop that a long transaction blocks fails fast, leaves 0111 unrecorded, and the next CMS start
 * tries again, instead of queueing every later reader and writer of sessions behind its lock request. Idempotent; nothing
 * else changes.
 */
export function sessionsParentSessionIndexMigration(schema: string): string[] {
    const s = `"${schema}"`;
    const index = `idx_${schema}_sessions_parent`;
    return [`
-- 0111_sessions_parent_session_index: drop an invalid index a failed concurrent build left, under a lock timeout
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $parent_index$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = '${schema}'
          AND c.relname = '${index}'
          AND NOT i.indisvalid
    ) THEN
        EXECUTE 'DROP INDEX ${s}.${index}';
    END IF;
END
$parent_index$;
COMMIT;
`, `
-- 0111_sessions_parent_session_index
CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index}
    ON ${s}.sessions(parent_session_id);
`];
}
