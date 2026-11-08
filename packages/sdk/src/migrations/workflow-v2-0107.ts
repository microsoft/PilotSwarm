/**
 * Migration 0107 — Workflow Simplified stage 2.1: a definition belongs to the chat (spec "definitions", "migration";
 * decisions D3, Q1–Q10, F2 of the coordinator's 2.1 spec readings, 2026-11-07).
 *
 * New tables:
 * - workflow_chat_definitions: a named Workflow Definition owned by one chat (owner_session_id). One live definition per
 *   name in a chat (a partial unique index); a deleted one keeps its row and revisions as a tombstone, so a finished
 *   Workflow keeps its pinned copy (R6). `current_revision` is its newest revision (0 before the first).
 * - workflow_chat_revisions: one saved YAML of a definition, immutable: 1, 2, 3, with its author (`actor`), the revision
 *   it was based on (`based_on`) and when; `imported` for a revision made from stage 1 data.
 * - workflow_chat_operations: each save, start and delete by its (chat, operation id), with its request digest and receipt,
 *   so a repeated call is answered from its receipt and another request with that id is refused.
 * - workflow_chat_seen: the newest revision of each definition the chat itself has seen (its own saves, its reads); the
 *   spawn_workflow compatibility save is guarded by it (Q2).
 * - workflow_chat_notes: a person's save leaves one note the chat reads on its next turn (E2-4); it is consumed with the
 *   success of the turn that read it (F3), never by a turn that failed.
 *
 * workflow_definitions (a Workflow's own, pinned copy) gains chat_definition_id and chat_revision: the chat revision it
 * started from (R1 holds by construction: the copy is that revision's YAML).
 *
 * A trigger on sessions ends a chat's Workflows when the chat ends (R5, F2): a chat that is completed, canceled or failed
 * has its Workflows' active runs canceled in the same transaction (their pending visits lose to the cancel, their rows say
 * Canceled); a chat that is deleted has its definitions deleted and its Workflow sessions deleted (each one's own trigger,
 * 0090, ends its runs). A Workflow's controller that is waiting finds its run ended at its next wake.
 *
 * D3 (Q4–Q6): in this one transaction, which holds workflow_definitions in SHARE ROW EXCLUSIVE mode so no Workflow is
 * created meanwhile, each live chat's stage 1 Workflow children are grouped by definition name (each child's current
 * revision's name, else its newest named revision's). Each group becomes one definition (source 'imported') whose
 * revisions are every distinct YAML any of its children stored, its replaced drafts included, deduplicated by YAML hash
 * (never by metadata.version), oldest first by save time. Each child then points at the revision of the YAML it ran (its
 * published YAML), or, never started, of its current YAML: a stage 1 draft stays a row (Q5). Nothing is deleted; a child
 * whose YAML has no name is left as it is.
 */
export function workflowChatDefinitionsMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0107_workflow_chat_definitions

CREATE TABLE IF NOT EXISTS ${s}.workflow_chat_definitions (
    definition_id     TEXT PRIMARY KEY,
    owner_session_id  TEXT NOT NULL,
    name              TEXT NOT NULL,
    current_revision  INTEGER NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
    source            TEXT,
    created_by        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at        TIMESTAMPTZ,
    deleted_by        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_chat_definitions_live_name
    ON ${s}.workflow_chat_definitions (owner_session_id, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS workflow_chat_definitions_by_owner ON ${s}.workflow_chat_definitions (owner_session_id, created_at);

CREATE TABLE IF NOT EXISTS ${s}.workflow_chat_revisions (
    definition_id TEXT NOT NULL REFERENCES ${s}.workflow_chat_definitions (definition_id),
    revision      INTEGER NOT NULL CHECK (revision >= 1),
    yaml          TEXT NOT NULL,
    yaml_sha256   TEXT NOT NULL,
    valid         BOOLEAN NOT NULL,
    diagnostics   TEXT NOT NULL,
    semver        TEXT,
    ir            TEXT,
    ir_sha256     TEXT,
    based_on      INTEGER,
    actor         TEXT NOT NULL,
    imported      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (definition_id, revision),
    CONSTRAINT workflow_chat_revisions_valid_ir CHECK (valid = (ir IS NOT NULL AND ir_sha256 IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS ${s}.workflow_chat_operations (
    owner_session_id TEXT NOT NULL,
    operation_id     TEXT NOT NULL,
    kind             TEXT NOT NULL,
    request_sha256   TEXT NOT NULL,
    receipt          TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_session_id, operation_id)
);

CREATE TABLE IF NOT EXISTS ${s}.workflow_chat_seen (
    owner_session_id TEXT NOT NULL,
    definition_id    TEXT NOT NULL,
    revision         INTEGER NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_session_id, definition_id)
);

CREATE TABLE IF NOT EXISTS ${s}.workflow_chat_notes (
    note_id          BIGSERIAL PRIMARY KEY,
    owner_session_id TEXT NOT NULL,
    definition_id    TEXT NOT NULL,
    revision         INTEGER NOT NULL,
    text             TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS workflow_chat_notes_pending ON ${s}.workflow_chat_notes (owner_session_id, note_id) WHERE consumed_at IS NULL;

ALTER TABLE ${s}.workflow_definitions ADD COLUMN IF NOT EXISTS chat_definition_id TEXT;
ALTER TABLE ${s}.workflow_definitions ADD COLUMN IF NOT EXISTS chat_revision INTEGER;
CREATE INDEX IF NOT EXISTS workflow_definitions_by_chat_definition
    ON ${s}.workflow_definitions (chat_definition_id, chat_revision) WHERE chat_definition_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_definitions_by_parent ON ${s}.workflow_definitions (parent_session_id) WHERE parent_session_id IS NOT NULL;

-- R5 and F2: a chat that ends ends its Workflows.
CREATE OR REPLACE FUNCTION ${s}.workflow_v2_on_chat_ended() RETURNS TRIGGER AS $$
DECLARE
    v_envelope CONSTANT TEXT := '{"code":"cancelled","message":"The chat that owns this Workflow ended, so the Workflow was canceled."}';
BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        UPDATE ${s}.workflow_chat_definitions
           SET deleted_at = now(), deleted_by = '{"kind":"system","name":"chat-deleted"}', updated_at = now()
         WHERE owner_session_id = NEW.session_id AND deleted_at IS NULL;
        UPDATE ${s}.sessions
           SET deleted_at = now(), updated_at = now()
         WHERE parent_session_id = NEW.session_id AND session_kind = 'workflow' AND deleted_at IS NULL;
    ELSIF NEW.state IN ('completed', 'cancelled', 'failed') AND OLD.state IS DISTINCT FROM NEW.state THEN
        UPDATE ${s}.workflow_node_executions AS node
           SET state = 'completed', outcome = 'cancelled', result_kind = 'runtime_error',
               error = v_envelope, output = NULL, winner = 'delete', completed_at = now()
          FROM ${s}.workflow_runs AS run, ${s}.sessions AS child
         WHERE run.run_id = node.run_id
           AND run.workflow_session_id = child.session_id
           AND child.parent_session_id = NEW.session_id AND child.session_kind = 'workflow'
           AND run.mode = 'live' AND run.status IN ('admitted', 'running', 'paused')
           AND node.state = 'pending';
        WITH ended AS (
            UPDATE ${s}.workflow_runs AS run
               SET status = 'cancelled', terminal_error = v_envelope, updated_at = now(), finished_at = now()
              FROM ${s}.sessions AS child
             WHERE run.workflow_session_id = child.session_id
               AND child.parent_session_id = NEW.session_id AND child.session_kind = 'workflow'
               AND run.mode = 'live' AND run.status IN ('admitted', 'running', 'paused')
            RETURNING run.workflow_session_id
        )
        UPDATE ${s}.sessions
           SET state = 'cancelled', updated_at = now()
         WHERE session_id IN (SELECT workflow_session_id FROM ended) AND deleted_at IS NULL;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_v2_chat_ended ON ${s}.sessions;
CREATE TRIGGER workflow_v2_chat_ended
    AFTER UPDATE OF state, deleted_at ON ${s}.sessions
    FOR EACH ROW
    WHEN (NEW.session_kind IS DISTINCT FROM 'workflow'
          AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at))
    EXECUTE FUNCTION ${s}.workflow_v2_on_chat_ended();

-- D3: stage 1 Workflows become definitions with imported revisions.
LOCK TABLE ${s}.workflow_definitions IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE workflow_0107_children ON COMMIT DROP AS
SELECT d.workflow_session_id AS child_id,
       d.parent_session_id AS owner_session_id,
       COALESCE(
           (SELECT r.name FROM ${s}.workflow_revisions r
             WHERE r.workflow_session_id = d.workflow_session_id AND r.revision = d.current_revision),
           (SELECT r.name FROM ${s}.workflow_revisions r
             WHERE r.workflow_session_id = d.workflow_session_id AND r.name IS NOT NULL
             ORDER BY r.revision DESC LIMIT 1)) AS name,
       COALESCE(d.published_yaml_sha256,
           (SELECT r.yaml_sha256 FROM ${s}.workflow_revisions r
             WHERE r.workflow_session_id = d.workflow_session_id AND r.revision = d.current_revision)) AS pinned_yaml_sha256
  FROM ${s}.workflow_definitions d
  JOIN ${s}.sessions p ON p.session_id = d.parent_session_id
 WHERE d.parent_session_id IS NOT NULL AND p.deleted_at IS NULL AND d.chat_definition_id IS NULL;

DELETE FROM workflow_0107_children WHERE name IS NULL;

INSERT INTO ${s}.workflow_chat_definitions (definition_id, owner_session_id, name, current_revision, source, created_by, created_at, updated_at)
SELECT 'imported-' || md5(c.owner_session_id || chr(31) || c.name), c.owner_session_id, c.name, 0, 'imported',
       '{"kind":"system","name":"imported"}',
       min(r.created_at), now()
  FROM workflow_0107_children c
  JOIN ${s}.workflow_revisions r ON r.workflow_session_id = c.child_id
 GROUP BY c.owner_session_id, c.name
ON CONFLICT (definition_id) DO NOTHING;

INSERT INTO ${s}.workflow_chat_revisions
    (definition_id, revision, yaml, yaml_sha256, valid, diagnostics, semver, ir, ir_sha256, based_on, actor, imported, created_at)
SELECT n.definition_id, n.revision, n.yaml, n.yaml_sha256, n.valid, n.diagnostics, n.semver, n.ir, n.ir_sha256,
       CASE WHEN n.revision > 1 THEN n.revision - 1 END, '{"kind":"system","name":"imported"}', TRUE, n.created_at
  FROM (
    SELECT f.*, row_number() OVER (PARTITION BY f.definition_id ORDER BY f.created_at, f.yaml_sha256)::INTEGER AS revision
      FROM (
        SELECT 'imported-' || md5(c.owner_session_id || chr(31) || c.name) AS definition_id,
               r.yaml, r.yaml_sha256, r.valid, r.diagnostics, r.semver, r.ir, r.ir_sha256, r.created_at,
               row_number() OVER (PARTITION BY c.owner_session_id, c.name, r.yaml_sha256
                                  ORDER BY r.created_at, r.workflow_session_id, r.revision) AS copy
          FROM workflow_0107_children c
          JOIN ${s}.workflow_revisions r ON r.workflow_session_id = c.child_id
      ) f
     WHERE f.copy = 1
  ) n
ON CONFLICT (definition_id, revision) DO NOTHING;

UPDATE ${s}.workflow_chat_definitions d
   SET current_revision = (SELECT max(r.revision) FROM ${s}.workflow_chat_revisions r WHERE r.definition_id = d.definition_id)
 WHERE d.source = 'imported' AND d.current_revision = 0;

UPDATE ${s}.workflow_definitions d
   SET chat_definition_id = r.definition_id, chat_revision = r.revision
  FROM workflow_0107_children c, ${s}.workflow_chat_revisions r
 WHERE d.workflow_session_id = c.child_id
   AND r.definition_id = 'imported-' || md5(c.owner_session_id || chr(31) || c.name)
   AND r.yaml_sha256 = c.pinned_yaml_sha256;
`;
}
