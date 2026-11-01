/**
 * Migration 0089 — workflow v2 typed input (messaging receive states).
 *
 * - workflow_inbox: each typed input a sender gave a run, accepted once per
 *   (workflow, sender, operation id). A message is never drained: it stays
 *   unconsumed until one receive state claims it (consumed_by, set once) or
 *   it expires, and it is kept after that. seq is the durable order in
 *   which a receive state claims messages (inputs to one workflow serialize
 *   on its session row, so seq follows commit order).
 * - a receive state's node execution records what it accepts (contract,
 *   sender, correlation), resolved when it is admitted, so an input that
 *   arrives later can claim it in the input's own transaction.
 *
 * Additive: existing rows are untouched; other node executions have no
 * receive fields.
 */
export function workflowV2InboxMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0089_workflow_v2_inbox

ALTER TABLE ${s}.workflow_node_executions ADD COLUMN IF NOT EXISTS receive_contract TEXT;
ALTER TABLE ${s}.workflow_node_executions ADD COLUMN IF NOT EXISTS receive_from TEXT;
ALTER TABLE ${s}.workflow_node_executions ADD COLUMN IF NOT EXISTS receive_correlation TEXT;

CREATE TABLE IF NOT EXISTS ${s}.workflow_inbox (
    message_id          TEXT PRIMARY KEY,
    seq                 BIGSERIAL NOT NULL UNIQUE,
    workflow_session_id TEXT NOT NULL,
    run_id              TEXT NOT NULL REFERENCES ${s}.workflow_runs (run_id),
    sender_session_id   TEXT NOT NULL,
    operation_id        TEXT NOT NULL,
    request_sha256      TEXT NOT NULL,
    contract            TEXT NOT NULL,
    correlation         TEXT NOT NULL,
    payload             TEXT NOT NULL,
    accepted_at         TIMESTAMPTZ NOT NULL,
    expires_at          TIMESTAMPTZ NOT NULL,
    consumed_by         TEXT REFERENCES ${s}.workflow_node_executions (node_execution_id),
    consumed_at         TIMESTAMPTZ,
    UNIQUE (workflow_session_id, sender_session_id, operation_id),
    CONSTRAINT workflow_inbox_consumed CHECK ((consumed_by IS NULL) = (consumed_at IS NULL)),
    CONSTRAINT workflow_inbox_expiry CHECK (expires_at > accepted_at)
);
CREATE INDEX IF NOT EXISTS workflow_inbox_unconsumed
    ON ${s}.workflow_inbox (run_id, contract, seq) WHERE consumed_by IS NULL;
CREATE INDEX IF NOT EXISTS workflow_inbox_by_sender
    ON ${s}.workflow_inbox (workflow_session_id, sender_session_id, accepted_at);
-- A receive state takes at most one message.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_inbox_one_claim
    ON ${s}.workflow_inbox (consumed_by) WHERE consumed_by IS NOT NULL;
`;
}
