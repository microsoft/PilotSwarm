/**
 * Migration 0097 — workflow v2 messaging request states: storage only.
 *
 * Nothing runs a request state yet (design workflow-messaging-request.md,
 * section 8.4): these tables are written only by store methods that no
 * published definition reaches. The design's records:
 *
 * - workflow_outbox.mode admits 'request': a request state's message intent,
 *   as a send's. Existing 'send' rows are unchanged.
 * - workflow_requests: one row per request state's node execution, written
 *   once when it is admitted and never changed: its responder (frozen at
 *   entry), contract, request hash, the response schema of its pinned
 *   definition and its deadline. Its status is not stored: it is derived from
 *   the node execution (the node's compare-and-swap is the one decision).
 * - workflow_request_responses: at most one row per request, written only by
 *   the transaction that decides the node with a response or a declined
 *   refusal; never changed.
 * - workflow_request_operations: one binding per admitted operation of a
 *   request (the winner, an identical alias, an audited refusal) to its
 *   result identity and outcome; only last_at and count change.
 * - workflow_response_wakes: the durable wake intent written with a response;
 *   a settled intent never changes.
 *
 * Not purely additive: it replaces the outbox's mode CHECK constraint
 * (0095: mode IN ('send')) with a wider one (mode IN ('send', 'request')),
 * which every existing row satisfies. Otherwise it adds four tables, their
 * indexes and a guard trigger. It drops no table and removes or changes no
 * row; no row of the new tables is deleted.
 */
export function workflowV2RequestsMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0097_workflow_v2_requests

ALTER TABLE ${s}.workflow_outbox DROP CONSTRAINT IF EXISTS workflow_outbox_mode;
ALTER TABLE ${s}.workflow_outbox ADD CONSTRAINT workflow_outbox_mode CHECK (mode IN ('send', 'request'));

CREATE TABLE IF NOT EXISTS ${s}.workflow_requests (
    exchange_id            TEXT PRIMARY KEY REFERENCES ${s}.workflow_outbox (exchange_id),
    workflow_session_id    TEXT NOT NULL,
    run_id                 TEXT NOT NULL REFERENCES ${s}.workflow_runs (run_id),
    responder_session_id   TEXT NOT NULL,
    contract               TEXT NOT NULL,
    request_sha256         TEXT NOT NULL,
    response_schema        TEXT NOT NULL,
    deadline_at            TIMESTAMPTZ NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL,
    CONSTRAINT workflow_requests_node FOREIGN KEY (exchange_id) REFERENCES ${s}.workflow_node_executions (node_execution_id)
);
CREATE INDEX IF NOT EXISTS workflow_requests_by_run ON ${s}.workflow_requests (run_id, created_at);

CREATE TABLE IF NOT EXISTS ${s}.workflow_request_responses (
    exchange_id      TEXT PRIMARY KEY REFERENCES ${s}.workflow_requests (exchange_id),
    kind             TEXT NOT NULL,
    value            TEXT NOT NULL,
    result_sha256    TEXT NOT NULL,
    operation_id     TEXT NOT NULL,
    actor_session_id TEXT NOT NULL,
    decided_at       TIMESTAMPTZ NOT NULL,
    receipt          TEXT NOT NULL,
    CONSTRAINT workflow_request_responses_kind CHECK (kind IN ('response', 'decline'))
);

CREATE TABLE IF NOT EXISTS ${s}.workflow_request_operations (
    exchange_id      TEXT NOT NULL REFERENCES ${s}.workflow_requests (exchange_id),
    operation_id     TEXT NOT NULL,
    actor_session_id TEXT NOT NULL,
    result_sha256    TEXT NOT NULL,
    outcome          TEXT NOT NULL,
    status           TEXT NOT NULL,
    first_at         TIMESTAMPTZ NOT NULL,
    last_at          TIMESTAMPTZ NOT NULL,
    count            INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (exchange_id, operation_id),
    CONSTRAINT workflow_request_operations_outcome CHECK (outcome IN ('decided', 'same', 'expired', 'closed', 'conflict')),
    CONSTRAINT workflow_request_operations_status
        CHECK (status IN ('pending', 'responded', 'declined', 'timed_out', 'cancelled', 'failed')),
    CONSTRAINT workflow_request_operations_count CHECK (count >= 1)
);

CREATE TABLE IF NOT EXISTS ${s}.workflow_response_wakes (
    exchange_id            TEXT PRIMARY KEY REFERENCES ${s}.workflow_request_responses (exchange_id),
    run_id                 TEXT NOT NULL REFERENCES ${s}.workflow_runs (run_id),
    controller_instance_id TEXT NOT NULL,
    state                  TEXT NOT NULL DEFAULT 'pending',
    lease_token            TEXT,
    lease_until            TIMESTAMPTZ,
    attempts               INTEGER NOT NULL DEFAULT 0,
    next_attempt_at        TIMESTAMPTZ NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL,
    settled_at             TIMESTAMPTZ,
    last_error             TEXT,
    CONSTRAINT workflow_response_wakes_state CHECK (state IN ('pending', 'leased', 'dispatched', 'moot', 'abandoned')),
    CONSTRAINT workflow_response_wakes_settled CHECK ((state IN ('dispatched', 'moot', 'abandoned')) = (settled_at IS NOT NULL)),
    CONSTRAINT workflow_response_wakes_lease CHECK ((state = 'leased') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
    CONSTRAINT workflow_response_wakes_attempts CHECK (attempts >= 0)
);
CREATE INDEX IF NOT EXISTS workflow_response_wakes_due ON ${s}.workflow_response_wakes (state, next_attempt_at);

-- A request and its response are written once; an operation binding changes only its repeat counters; a settled wake
-- never changes. None of these rows is deleted.
CREATE OR REPLACE FUNCTION ${s}.workflow_v2_request_rows_guard() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '% rows are kept: a % is never deleted', TG_TABLE_NAME, TG_TABLE_NAME;
    END IF;
    IF TG_TABLE_NAME = 'workflow_request_operations' THEN
        IF NEW.exchange_id IS DISTINCT FROM OLD.exchange_id OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
           OR NEW.actor_session_id IS DISTINCT FROM OLD.actor_session_id OR NEW.result_sha256 IS DISTINCT FROM OLD.result_sha256
           OR NEW.outcome IS DISTINCT FROM OLD.outcome OR NEW.status IS DISTINCT FROM OLD.status
           OR NEW.first_at IS DISTINCT FROM OLD.first_at THEN
            RAISE EXCEPTION 'an operation binding never changes; only its last_at and count do';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_TABLE_NAME = 'workflow_response_wakes' THEN
        IF OLD.state IN ('dispatched', 'moot', 'abandoned') THEN
            RAISE EXCEPTION 'a settled wake intent never changes';
        END IF;
        IF NEW.exchange_id IS DISTINCT FROM OLD.exchange_id OR NEW.run_id IS DISTINCT FROM OLD.run_id
           OR NEW.controller_instance_id IS DISTINCT FROM OLD.controller_instance_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'a wake intent keeps its identity';
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION '% rows are written once and never changed', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_requests_guard ON ${s}.workflow_requests;
CREATE TRIGGER workflow_requests_guard BEFORE UPDATE OR DELETE ON ${s}.workflow_requests
    FOR EACH ROW EXECUTE FUNCTION ${s}.workflow_v2_request_rows_guard();
DROP TRIGGER IF EXISTS workflow_request_responses_guard ON ${s}.workflow_request_responses;
CREATE TRIGGER workflow_request_responses_guard BEFORE UPDATE OR DELETE ON ${s}.workflow_request_responses
    FOR EACH ROW EXECUTE FUNCTION ${s}.workflow_v2_request_rows_guard();
DROP TRIGGER IF EXISTS workflow_request_operations_guard ON ${s}.workflow_request_operations;
CREATE TRIGGER workflow_request_operations_guard BEFORE UPDATE OR DELETE ON ${s}.workflow_request_operations
    FOR EACH ROW EXECUTE FUNCTION ${s}.workflow_v2_request_rows_guard();
DROP TRIGGER IF EXISTS workflow_response_wakes_guard ON ${s}.workflow_response_wakes;
CREATE TRIGGER workflow_response_wakes_guard BEFORE UPDATE OR DELETE ON ${s}.workflow_response_wakes
    FOR EACH ROW EXECUTE FUNCTION ${s}.workflow_v2_request_rows_guard();
`;
}
