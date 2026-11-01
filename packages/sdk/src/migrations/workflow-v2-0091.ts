/**
 * Migration 0091 — workflow v2 messaging send states: the outbox.
 *
 * - workflow_outbox: one row per send state's node execution, written in the
 *   transaction that admits it, after the recipient was decided under the
 *   session locks: the message's intent (recipient, contract, payload),
 *   before any delivery. exchange_id is stable (the node execution's id), so
 *   every delivery attempt of it carries the same identity. A delivery
 *   counts its attempts and records its receipt (delivered) or its failure
 *   (failed) once, from pending; it is never deleted.
 *
 * Additive: no existing row changes.
 */
export function workflowV2OutboxMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0091_workflow_v2_outbox

CREATE TABLE IF NOT EXISTS ${s}.workflow_outbox (
    exchange_id          TEXT PRIMARY KEY,
    node_execution_id    TEXT NOT NULL UNIQUE REFERENCES ${s}.workflow_node_executions (node_execution_id),
    workflow_session_id  TEXT NOT NULL,
    run_id               TEXT NOT NULL REFERENCES ${s}.workflow_runs (run_id),
    mode                 TEXT NOT NULL,
    recipient_session_id TEXT NOT NULL,
    contract             TEXT NOT NULL,
    payload              TEXT NOT NULL,
    payload_sha256       TEXT NOT NULL,
    state                TEXT NOT NULL DEFAULT 'pending',
    attempts             INTEGER NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL,
    last_attempt_at      TIMESTAMPTZ,
    decided_at           TIMESTAMPTZ,
    receipt              TEXT,
    error                TEXT,
    CONSTRAINT workflow_outbox_mode CHECK (mode IN ('send')),
    CONSTRAINT workflow_outbox_state CHECK (state IN ('pending', 'delivered', 'failed')),
    CONSTRAINT workflow_outbox_decided CHECK ((state = 'pending') = (decided_at IS NULL)),
    CONSTRAINT workflow_outbox_receipt CHECK ((state = 'delivered') = (receipt IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS workflow_outbox_by_run ON ${s}.workflow_outbox (run_id, created_at);
`;
}
