/**
 * Migration 0088 — Workflow: its session kind, tables, functions and triggers, created in their final shape.
 *
 * On `sessions` (an existing table): `session_kind` ('agent' or 'workflow'; existing rows are agents), `workflow_ref`,
 * the two Workflow triggers and an index on `parent_session_id`.
 *
 * - cms_create_workflow_session: claims a session row for a Workflow; an existing row of any kind is never changed.
 * - A Workflow (workflow_definitions: its own pinned copy of a chat's definition) has revisions, operations, runs, the
 *   runs' KV revisions and node executions; its messages (workflow_inbox, workflow_outbox), requests and their responses,
 *   operations and wakes; the durable intake of what it sends to a chat (workflow_intake, its invocations and exposures);
 *   the agents it runs (workflow_agent_invocations and their completions) and the interceptions of a test run.
 * - A chat owns its named Workflow Definitions (workflow_chat_definitions) and their immutable revisions, its operations,
 *   the newest revision it has seen of each and the notes a person's save leaves for it.
 * - Deleting a Workflow session ends its Workflow in the same transaction (workflow_on_session_deleted): the definition
 *   becomes a permanent tombstone, active runs are cancelled and their pending node executions lose to the deletion.
 * - A chat that ends ends its Workflows (workflow_on_chat_ended): a deleted chat has its definitions deleted and its
 *   Workflow sessions deleted (each one's own trigger then ends its runs); a completed, cancelled or failed chat has its
 *   Workflows' active runs (live and test) cancelled. It locks in the runtime's order: the chat's row (the UPDATE that
 *   fired it), then its Workflow session rows in session_id order, then their active runs in run_id order.
 * - Guards keep requests, responses, wakes, intake rows, invocations and exposures written once (or forward only).
 *
 * Values that a Workflow author or caller supplies (inputs, outputs, error envelopes, receipts, IR) are canonical JSON
 * TEXT, not JSONB, because JSONB rejects some valid JSON strings (`\u0000`, lone surrogates). Every mutation of a
 * definition locks its row first; every mutation of run state locks the run row first; a node execution's terminal
 * result is a single compare-and-swap from 'pending'.
 *
 * Steps (the migrator's `steps` mode, as migration 0029 builds idx_<schema>_sessions_root), each idempotent, so a start
 * that stops part way runs them all again:
 * 1. Everything but the index, in one transaction. What it adds to sessions (the two columns, the check and the two
 *    triggers) it adds only when the catalog does not have it yet, so a run again takes no lock on sessions.
 * 2. Drop an invalid parent_session_id index that a failed concurrent build left (IF NOT EXISTS would keep it), in its
 *    own transaction under a 5 s lock_timeout: the drop needs an exclusive lock on sessions, and a drop that a long
 *    transaction blocks fails fast instead of queueing every later reader and writer of sessions behind it.
 * 3. Build the index CONCURRENTLY, so writes to sessions go on during the build. The chat-end trigger, session deletion
 *    and the child budget (child-budget.ts childBudgetCountSql) look sessions up by parent_session_id.
 */
export function workflowMigration(schema: string): string[] {
    const s = `"${schema}"`;
    const parentIndex = `idx_${schema}_sessions_parent`;
    return [`
-- 0088_workflow: tables, functions and triggers
BEGIN;

DO $sessions$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = '${s}.sessions'::regclass AND attname = 'session_kind' AND NOT attisdropped) THEN
        ALTER TABLE ${s}.sessions ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'agent';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = '${s}.sessions'::regclass AND conname = 'sessions_session_kind_check') THEN
        ALTER TABLE ${s}.sessions
            ADD CONSTRAINT sessions_session_kind_check
            CHECK (session_kind IN ('agent', 'workflow'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_attribute
                    WHERE attrelid = '${s}.sessions'::regclass AND attname = 'workflow_ref' AND NOT attisdropped) THEN
        ALTER TABLE ${s}.sessions ADD COLUMN workflow_ref TEXT;
    END IF;
END
$sessions$;

-- Exclusive creation of a Workflow session row. The INSERT is the claim: when any row with this id exists (live or
-- deleted, of any kind, committed or being inserted concurrently), nothing is changed and FALSE is returned. Root, group
-- and visibility resolve as in cms_create_session.
CREATE OR REPLACE FUNCTION ${s}.cms_create_workflow_session(
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

-- A Workflow's own copy of the chat revision it started from (chat_definition_id, chat_revision).
CREATE TABLE IF NOT EXISTS ${s}.workflow_definitions (
    workflow_session_id   TEXT PRIMARY KEY,
    parent_session_id     TEXT,
    api_version           TEXT NOT NULL,
    semver                TEXT,
    state                 TEXT NOT NULL CHECK (state IN ('draft', 'published', 'deleted')),
    current_revision      INTEGER NOT NULL CHECK (current_revision >= 1),
    published_revision    INTEGER,
    published_yaml_sha256 TEXT,
    published_ir_sha256   TEXT,
    notify_parent         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at          TIMESTAMPTZ,
    published_agent_pins  TEXT,
    chat_definition_id    TEXT,
    chat_revision         INTEGER,
    CONSTRAINT workflow_definitions_published_pins CHECK (
        state <> 'published'
        OR (published_revision IS NOT NULL AND published_yaml_sha256 IS NOT NULL AND published_ir_sha256 IS NOT NULL)
    ),
    CONSTRAINT workflow_definitions_agent_pins CHECK (
        published_agent_pins IS NULL OR published_revision IS NOT NULL
    )
);
CREATE INDEX IF NOT EXISTS workflow_definitions_by_chat_definition
    ON ${s}.workflow_definitions (chat_definition_id, chat_revision) WHERE chat_definition_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_definitions_by_parent ON ${s}.workflow_definitions (parent_session_id) WHERE parent_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ${s}.workflow_revisions (
    workflow_session_id TEXT NOT NULL REFERENCES ${s}.workflow_definitions (workflow_session_id),
    revision            INTEGER NOT NULL CHECK (revision >= 1),
    yaml                TEXT NOT NULL,
    yaml_sha256         TEXT NOT NULL,
    valid               BOOLEAN NOT NULL,
    diagnostics         TEXT NOT NULL,
    name                TEXT,
    semver              TEXT,
    ir                  TEXT,
    ir_sha256           TEXT,
    actor               TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workflow_session_id, revision),
    CONSTRAINT workflow_revisions_valid_ir CHECK (valid = (ir IS NOT NULL AND ir_sha256 IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS ${s}.workflow_operations (
    workflow_session_id TEXT NOT NULL,
    operation_id        TEXT NOT NULL,
    kind                TEXT NOT NULL,
    request_sha256      TEXT NOT NULL,
    receipt             TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workflow_session_id, operation_id)
);

-- A run: its open KV and revision; pause (paused_from is the status a resume returns to); stop; a test run's virtual
-- clock, fixtures, scenario and agent pins; its deadline; the per-node models chosen at its start.
CREATE TABLE IF NOT EXISTS ${s}.workflow_runs (
    run_id                 TEXT PRIMARY KEY,
    workflow_session_id    TEXT NOT NULL REFERENCES ${s}.workflow_definitions (workflow_session_id),
    mode                   TEXT NOT NULL CHECK (mode IN ('live', 'test')),
    revision               INTEGER NOT NULL,
    yaml_sha256            TEXT NOT NULL,
    ir_sha256              TEXT NOT NULL,
    inputs                 TEXT NOT NULL,
    controller_instance_id TEXT NOT NULL UNIQUE,
    status                 TEXT NOT NULL CHECK (status IN ('admitted', 'running', 'paused', 'completed', 'failed', 'cancelled', 'stopped')),
    test_agent_mode        TEXT CHECK (test_agent_mode IN ('mocked', 'real')),
    terminal_node_id       TEXT,
    terminal_outcome       TEXT,
    terminal_output        TEXT,
    terminal_error         TEXT,
    start_operation_id     TEXT NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at            TIMESTAMPTZ,
    kv                     TEXT NOT NULL DEFAULT '{}',
    kv_revision            INTEGER NOT NULL DEFAULT 1,
    paused_from            TEXT,
    controller_version     TEXT,
    stop_requested_at      TIMESTAMPTZ,
    stop_deadline_at       TIMESTAMPTZ,
    stop_request           TEXT,
    virtual_now            TIMESTAMPTZ,
    test_fixtures          TEXT,
    test_scenario          TEXT,
    deadline_at            TIMESTAMPTZ,
    test_agent_pins        TEXT,
    agent_models           TEXT,
    FOREIGN KEY (workflow_session_id, revision) REFERENCES ${s}.workflow_revisions (workflow_session_id, revision),
    CONSTRAINT workflow_runs_test_mode CHECK ((mode = 'test') = (test_agent_mode IS NOT NULL)),
    CONSTRAINT workflow_runs_terminal CHECK (
        (status IN ('completed', 'failed', 'cancelled', 'stopped')) = (finished_at IS NOT NULL)
    ),
    CONSTRAINT workflow_runs_paused_from
        CHECK ((status = 'paused') = (paused_from IS NOT NULL) AND (paused_from IS NULL OR paused_from IN ('admitted', 'running'))),
    CONSTRAINT workflow_runs_stop CHECK (
        (stop_requested_at IS NULL) = (stop_deadline_at IS NULL)
        AND (stop_requested_at IS NULL) = (stop_request IS NULL)
        AND (stop_deadline_at IS NULL OR stop_deadline_at >= stop_requested_at)
        AND (status <> 'stopped' OR stop_requested_at IS NOT NULL)
    ),
    CONSTRAINT workflow_runs_test_clock CHECK (
        mode = 'test' OR (virtual_now IS NULL AND test_fixtures IS NULL)
    ),
    CONSTRAINT workflow_runs_test_scenario CHECK (mode = 'test' OR test_scenario IS NULL),
    CONSTRAINT workflow_runs_test_agent_pins CHECK (
        test_agent_pins IS NULL OR (mode = 'test' AND test_agent_mode = 'real')
    )
);

-- One live run per published Workflow (D04).
CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_one_live
    ON ${s}.workflow_runs (workflow_session_id) WHERE mode = 'live';
CREATE INDEX IF NOT EXISTS workflow_runs_by_workflow
    ON ${s}.workflow_runs (workflow_session_id, created_at);

-- Every revision of a run's KV, immutable: a node execution pins the revision it was admitted with (kv_revision); replay
-- reads that revision, never "the latest".
CREATE TABLE IF NOT EXISTS ${s}.workflow_kv_revisions (
    run_id       TEXT NOT NULL REFERENCES ${s}.workflow_runs (run_id),
    revision     INTEGER NOT NULL CHECK (revision >= 1),
    kv           TEXT NOT NULL,
    operation_id TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, revision)
);

CREATE TABLE IF NOT EXISTS ${s}.workflow_node_executions (
    node_execution_id   TEXT PRIMARY KEY,
    run_id              TEXT NOT NULL REFERENCES ${s}.workflow_runs (run_id),
    scope_id            TEXT NOT NULL,
    node_id             TEXT NOT NULL,
    ordinal             INTEGER NOT NULL CHECK (ordinal >= 1),
    node_type           TEXT NOT NULL,
    predecessor_id      TEXT REFERENCES ${s}.workflow_node_executions (node_execution_id),
    arrival_route       TEXT,
    input               TEXT NOT NULL,
    input_sha256        TEXT NOT NULL,
    state               TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
    outcome             TEXT,
    result_kind         TEXT CHECK (result_kind IN ('business', 'runtime_error')),
    output              TEXT,
    error               TEXT,
    winner              TEXT,
    effect_attempts     INTEGER NOT NULL DEFAULT 0,
    entered_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ,
    kv_revision         INTEGER,
    deadline_at         TIMESTAMPTZ,
    receive_contract    TEXT,
    receive_from        TEXT,
    receive_correlation TEXT,
    UNIQUE (run_id, scope_id, node_id, ordinal),
    CONSTRAINT workflow_node_executions_terminal CHECK (
        (state = 'completed') = (outcome IS NOT NULL AND result_kind IS NOT NULL AND winner IS NOT NULL AND completed_at IS NOT NULL)
    ),
    CONSTRAINT workflow_node_executions_result CHECK (
        result_kind IS NULL
        OR (result_kind = 'business' AND output IS NOT NULL AND error IS NULL)
        OR (result_kind = 'runtime_error' AND error IS NOT NULL AND output IS NULL)
    )
);
CREATE INDEX IF NOT EXISTS workflow_node_executions_by_run
    ON ${s}.workflow_node_executions (run_id, entered_at);

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
    receipt             TEXT,
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
    recipient_kind       TEXT,
    correlation          TEXT,
    intake_mode          TEXT,
    attempt_token        TEXT,
    intake_outcome       TEXT,
    intake_outcome_at    TIMESTAMPTZ,
    CONSTRAINT workflow_outbox_mode CHECK (mode IN ('send', 'request')),
    CONSTRAINT workflow_outbox_state CHECK (state IN ('pending', 'delivered', 'failed')),
    CONSTRAINT workflow_outbox_decided CHECK ((state = 'pending') = (decided_at IS NULL)),
    CONSTRAINT workflow_outbox_receipt CHECK ((state = 'delivered') = (receipt IS NOT NULL)),
    CONSTRAINT workflow_outbox_recipient_kind CHECK (recipient_kind IS NULL OR recipient_kind IN ('agent', 'workflow')),
    CONSTRAINT workflow_outbox_intake_mode CHECK (intake_mode IS NULL OR intake_mode IN ('durable', 'legacy_window')),
    CONSTRAINT workflow_outbox_intake_outcome CHECK ((
        (intake_outcome IS NULL AND intake_outcome_at IS NULL)
        OR (intake_outcome IS NOT NULL AND intake_outcome IN ('refused_full', 'refused_size') AND intake_outcome_at IS NOT NULL
            AND intake_mode IS NOT DISTINCT FROM 'durable')
    ) IS TRUE)
);
CREATE INDEX IF NOT EXISTS workflow_outbox_by_run ON ${s}.workflow_outbox (run_id, created_at);

-- The intake fence: only the first counted attempt decides the mode, and a durable row is counted only with a new token.
CREATE OR REPLACE FUNCTION ${s}.workflow_outbox_intake_fence() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.intake_mode IS DISTINCT FROM OLD.intake_mode
       AND NOT (OLD.intake_mode IS NULL AND OLD.attempts IS NOT DISTINCT FROM 0 AND NEW.attempts IS NOT DISTINCT FROM 1) THEN
        RAISE EXCEPTION 'workflow_outbox %: only the count of its first attempt decides its intake mode (% to %, attempts % to %)',
            OLD.exchange_id, coalesce(OLD.intake_mode, 'unset'), coalesce(NEW.intake_mode, 'unset'), OLD.attempts, NEW.attempts;
    END IF;
    IF NEW.intake_mode IS NOT DISTINCT FROM 'durable' AND OLD.intake_mode IS DISTINCT FROM 'durable'
       AND (NEW.attempt_token IS NULL OR NEW.attempt_token IS NOT DISTINCT FROM OLD.attempt_token) THEN
        RAISE EXCEPTION 'workflow_outbox %: the durable intake mode needs a new attempt token', OLD.exchange_id;
    END IF;
    IF OLD.intake_mode IS NOT DISTINCT FROM 'durable' AND NEW.attempts IS DISTINCT FROM OLD.attempts
       AND (NEW.attempt_token IS NULL OR NEW.attempt_token IS NOT DISTINCT FROM OLD.attempt_token) THEN
        RAISE EXCEPTION 'workflow_outbox %: an attempt of a durable exchange needs a new attempt token', OLD.exchange_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_outbox_intake_fence ON ${s}.workflow_outbox;
CREATE TRIGGER workflow_outbox_intake_fence BEFORE UPDATE ON ${s}.workflow_outbox
    FOR EACH ROW EXECUTE FUNCTION ${s}.workflow_outbox_intake_fence();

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
CREATE OR REPLACE FUNCTION ${s}.workflow_request_rows_guard() RETURNS TRIGGER AS $$
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
    FOR EACH ROW EXECUTE FUNCTION ${s}.workflow_request_rows_guard();
DROP TRIGGER IF EXISTS workflow_request_responses_guard ON ${s}.workflow_request_responses;
CREATE TRIGGER workflow_request_responses_guard BEFORE UPDATE OR DELETE ON ${s}.workflow_request_responses
    FOR EACH ROW EXECUTE FUNCTION ${s}.workflow_request_rows_guard();
DROP TRIGGER IF EXISTS workflow_request_operations_guard ON ${s}.workflow_request_operations;
CREATE TRIGGER workflow_request_operations_guard BEFORE UPDATE OR DELETE ON ${s}.workflow_request_operations
    FOR EACH ROW EXECUTE FUNCTION ${s}.workflow_request_rows_guard();
DROP TRIGGER IF EXISTS workflow_response_wakes_guard ON ${s}.workflow_response_wakes;
CREATE TRIGGER workflow_response_wakes_guard BEFORE UPDATE OR DELETE ON ${s}.workflow_response_wakes
    FOR EACH ROW EXECUTE FUNCTION ${s}.workflow_request_rows_guard();

-- An invocation's complete membership, written once by its first bind. Every bind, end and cancel of the invocation
-- first takes a transaction-scoped advisory lock on its identity (store.ts lockIntakeInvocation), the first bind
-- included, and checks this row.
CREATE TABLE IF NOT EXISTS ${s}.workflow_intake_invocations (
    invocation_id        TEXT PRIMARY KEY,
    recipient_session_id TEXT NOT NULL,
    members              TEXT NOT NULL,
    member_count         INTEGER NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL,
    CONSTRAINT workflow_intake_invocations_count CHECK ((member_count BETWEEN 1 AND 64) IS TRUE)
);

CREATE OR REPLACE FUNCTION ${s}.workflow_intake_invocation_guard() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'intake invocation %: an invocation is written once and is never changed or deleted', OLD.invocation_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_intake_invocations_guard ON ${s}.workflow_intake_invocations;
CREATE TRIGGER workflow_intake_invocations_guard BEFORE UPDATE OR DELETE ON ${s}.workflow_intake_invocations
    FOR EACH ROW EXECUTE FUNCTION ${s}.workflow_intake_invocation_guard();

CREATE TABLE IF NOT EXISTS ${s}.workflow_intake (
    exchange_id          TEXT PRIMARY KEY REFERENCES ${s}.workflow_outbox (exchange_id),
    recipient_session_id TEXT NOT NULL,
    workflow_session_id  TEXT NOT NULL,
    run_id               TEXT NOT NULL,
    envelope_sha256      TEXT NOT NULL,
    text                 TEXT,
    text_sha256          TEXT NOT NULL,
    claim_id             TEXT NOT NULL,
    state                TEXT NOT NULL,
    invocation_id        TEXT REFERENCES ${s}.workflow_intake_invocations (invocation_id),
    processing           TEXT,
    cancel_requested     BOOLEAN NOT NULL DEFAULT false,
    duplicates           INTEGER NOT NULL DEFAULT 0,
    conflicts            INTEGER NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL,
    updated_at           TIMESTAMPTZ NOT NULL,
    admitted_at          TIMESTAMPTZ,
    settled_at           TIMESTAMPTZ,
    reason               TEXT,
    CONSTRAINT workflow_intake_state CHECK ((state IN ('holding', 'admitted', 'cancelled', 'refused_full', 'refused_size')) IS TRUE),
    CONSTRAINT workflow_intake_processing
        CHECK ((processing IS NULL OR processing IN ('bound', 'completed', 'not_dispatched', 'interrupted', 'failed_indeterminate')) IS TRUE),
    CONSTRAINT workflow_intake_invocation CHECK (((state = 'admitted') = (invocation_id IS NOT NULL)) IS TRUE),
    CONSTRAINT workflow_intake_processed CHECK (((state = 'admitted') = (processing IS NOT NULL)) IS TRUE),
    CONSTRAINT workflow_intake_admitted CHECK (((state = 'admitted') = (admitted_at IS NOT NULL)) IS TRUE),
    CONSTRAINT workflow_intake_text CHECK ((text IS NOT NULL OR state IN ('refused_full', 'refused_size')) IS TRUE),
    CONSTRAINT workflow_intake_settled CHECK (((settled_at IS NOT NULL)
        = (state IN ('cancelled', 'refused_full', 'refused_size')
           OR (state = 'admitted' AND processing IS NOT NULL AND processing IS DISTINCT FROM 'bound'))) IS TRUE),
    CONSTRAINT workflow_intake_counters CHECK ((duplicates >= 0 AND conflicts >= 0) IS TRUE)
);
CREATE INDEX IF NOT EXISTS workflow_intake_by_recipient ON ${s}.workflow_intake (recipient_session_id, created_at);
CREATE INDEX IF NOT EXISTS workflow_intake_by_invocation ON ${s}.workflow_intake (invocation_id) WHERE invocation_id IS NOT NULL;

-- An intake row keeps its identity and text; its state and processing move forward once; nothing goes back; none is
-- deleted.
CREATE OR REPLACE FUNCTION ${s}.workflow_intake_guard() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'workflow_intake rows are kept: intake row % is never deleted', OLD.exchange_id;
    END IF;
    IF NEW.exchange_id IS DISTINCT FROM OLD.exchange_id OR NEW.recipient_session_id IS DISTINCT FROM OLD.recipient_session_id
       OR NEW.workflow_session_id IS DISTINCT FROM OLD.workflow_session_id OR NEW.run_id IS DISTINCT FROM OLD.run_id
       OR NEW.envelope_sha256 IS DISTINCT FROM OLD.envelope_sha256 OR NEW.text IS DISTINCT FROM OLD.text
       OR NEW.text_sha256 IS DISTINCT FROM OLD.text_sha256 OR NEW.claim_id IS DISTINCT FROM OLD.claim_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'intake row %: its identity and canonical text never change', OLD.exchange_id;
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND OLD.state IS DISTINCT FROM 'holding' THEN
        RAISE EXCEPTION 'intake row %: state % is final', OLD.exchange_id, OLD.state;
    END IF;
    IF NEW.invocation_id IS DISTINCT FROM OLD.invocation_id AND OLD.invocation_id IS NOT NULL THEN
        RAISE EXCEPTION 'intake row %: it stays bound to invocation %', OLD.exchange_id, OLD.invocation_id;
    END IF;
    -- Total: unset to bound, or bound to one final value; every other change, a null included, raises.
    IF NEW.processing IS DISTINCT FROM OLD.processing
       AND NOT ((OLD.processing IS NULL AND NEW.processing IS NOT DISTINCT FROM 'bound')
                OR (OLD.processing IS NOT DISTINCT FROM 'bound' AND NEW.processing IS NOT NULL AND NEW.processing IS DISTINCT FROM 'bound')) THEN
        RAISE EXCEPTION 'intake row %: processing % cannot become %', OLD.exchange_id, coalesce(OLD.processing, 'unset'), coalesce(NEW.processing, 'unset');
    END IF;
    IF (OLD.cancel_requested IS TRUE AND NEW.cancel_requested IS NOT TRUE)
       OR coalesce(NEW.duplicates < OLD.duplicates, true) OR coalesce(NEW.conflicts < OLD.conflicts, true) THEN
        RAISE EXCEPTION 'intake row %: its cancel flag and counters never go back', OLD.exchange_id;
    END IF;
    IF (OLD.admitted_at IS NOT NULL AND NEW.admitted_at IS DISTINCT FROM OLD.admitted_at)
       OR (OLD.settled_at IS NOT NULL AND NEW.settled_at IS DISTINCT FROM OLD.settled_at)
       OR (OLD.reason IS NOT NULL AND NEW.reason IS DISTINCT FROM OLD.reason) THEN
        RAISE EXCEPTION 'intake row %: its admission and settlement are written once', OLD.exchange_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_intake_guard ON ${s}.workflow_intake;
CREATE TRIGGER workflow_intake_guard BEFORE UPDATE OR DELETE ON ${s}.workflow_intake
    FOR EACH ROW EXECUTE FUNCTION ${s}.workflow_intake_guard();

CREATE TABLE IF NOT EXISTS ${s}.workflow_intake_exposures (
    invocation_id        TEXT PRIMARY KEY REFERENCES ${s}.workflow_intake_invocations (invocation_id),
    recipient_session_id TEXT NOT NULL,
    attempt_id           TEXT NOT NULL,
    exposed_at           TIMESTAMPTZ NOT NULL
);

-- An exposure is inserted once and is never changed or deleted.
CREATE OR REPLACE FUNCTION ${s}.workflow_intake_exposure_guard() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'intake exposure %: an exposure is written once and is never changed or deleted', OLD.invocation_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_intake_exposures_guard ON ${s}.workflow_intake_exposures;
CREATE TRIGGER workflow_intake_exposures_guard BEFORE UPDATE OR DELETE ON ${s}.workflow_intake_exposures
    FOR EACH ROW EXECUTE FUNCTION ${s}.workflow_intake_exposure_guard();

-- One row per visit of an agent node: a chat that continues across visits has one row per visit, so child_session_id
-- is not unique.
CREATE TABLE IF NOT EXISTS ${s}.workflow_agent_invocations (
    node_execution_id      TEXT PRIMARY KEY REFERENCES ${s}.workflow_node_executions (node_execution_id),
    run_id                 TEXT NOT NULL REFERENCES ${s}.workflow_runs (run_id),
    workflow_session_id    TEXT NOT NULL,
    child_session_id       TEXT NOT NULL,
    controlling_session_id TEXT,
    task                   TEXT NOT NULL,
    outcomes               TEXT NOT NULL,
    output_schema          TEXT,
    deadline_at            TIMESTAMPTZ NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL,
    spawn_attempts         INTEGER NOT NULL DEFAULT 0 CHECK (spawn_attempts >= 0),
    spawned_at             TIMESTAMPTZ,
    end_requested          TEXT CHECK (end_requested IN ('done', 'cancel')),
    end_requested_at       TIMESTAMPTZ,
    end_sent_at            TIMESTAMPTZ,
    end_child_status       TEXT,
    CONSTRAINT workflow_agent_invocations_end CHECK ((end_requested IS NULL) = (end_requested_at IS NULL)),
    CONSTRAINT workflow_agent_invocations_end_sent CHECK (
        (end_sent_at IS NULL) = (end_child_status IS NULL) AND (end_sent_at IS NULL OR end_requested IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS workflow_agent_invocations_by_run ON ${s}.workflow_agent_invocations (run_id);
CREATE INDEX IF NOT EXISTS workflow_agent_invocations_by_child ON ${s}.workflow_agent_invocations (child_session_id, created_at);

CREATE TABLE IF NOT EXISTS ${s}.workflow_agent_completions (
    node_execution_id TEXT NOT NULL REFERENCES ${s}.workflow_agent_invocations (node_execution_id),
    operation_id      TEXT NOT NULL,
    result_sha256     TEXT NOT NULL,
    outcome           TEXT NOT NULL CHECK (outcome IN ('decided', 'same', 'invalid', 'expired', 'closed', 'conflict')),
    problems          TEXT,
    receipt           TEXT,
    created_at        TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (node_execution_id, operation_id),
    CONSTRAINT workflow_agent_completions_receipt CHECK ((outcome = 'decided') = (receipt IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS ${s}.workflow_test_interceptions (
    interception_id       TEXT PRIMARY KEY,
    seq                   BIGINT GENERATED ALWAYS AS IDENTITY,
    run_id                TEXT NOT NULL REFERENCES ${s}.workflow_runs (run_id),
    node_execution_id     TEXT NOT NULL REFERENCES ${s}.workflow_node_executions (node_execution_id),
    operation             TEXT NOT NULL CHECK (operation IN ('tool.call', 'agent', 'send', 'request')),
    tool                  TEXT,
    arguments             TEXT NOT NULL,
    arguments_sha256      TEXT NOT NULL,
    response_schema       TEXT,
    state                 TEXT NOT NULL CHECK (state IN ('awaiting_parent', 'responded')),
    response_kind         TEXT CHECK (response_kind IN ('success', 'error', 'cancel')),
    response              TEXT,
    response_sha256       TEXT,
    disposition           TEXT CHECK (disposition IN ('parent', 'fixture')),
    response_operation_id TEXT,
    responded_by          TEXT,
    virtual_at            TIMESTAMPTZ NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL,
    responded_at          TIMESTAMPTZ,
    CONSTRAINT workflow_test_interceptions_tool CHECK ((operation = 'tool.call') = (tool IS NOT NULL)),
    CONSTRAINT workflow_test_interceptions_response CHECK (
        (state = 'responded') = (response_kind IS NOT NULL AND response IS NOT NULL AND response_sha256 IS NOT NULL
            AND disposition IS NOT NULL AND responded_at IS NOT NULL)
        AND (disposition IS DISTINCT FROM 'parent' OR responded_by IS NOT NULL)
    )
);
CREATE INDEX IF NOT EXISTS workflow_test_interceptions_by_run ON ${s}.workflow_test_interceptions (run_id, seq);

-- A chat's named Workflow Definitions: one live definition per name in a chat; a deleted one keeps its row and
-- revisions as a tombstone, so a finished Workflow keeps its pinned copy. current_revision is the newest (0 before the
-- first). A definition from an agent package is locked to its package.
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
    deleted_by        TEXT,
    locked            BOOLEAN NOT NULL DEFAULT FALSE,
    package_name      TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_chat_definitions_live_name
    ON ${s}.workflow_chat_definitions (owner_session_id, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS workflow_chat_definitions_by_owner ON ${s}.workflow_chat_definitions (owner_session_id, created_at);

-- One saved YAML of a definition, immutable, with its author (actor), the revision it was based on and its package.
CREATE TABLE IF NOT EXISTS ${s}.workflow_chat_revisions (
    definition_id  TEXT NOT NULL REFERENCES ${s}.workflow_chat_definitions (definition_id),
    revision       INTEGER NOT NULL CHECK (revision >= 1),
    yaml           TEXT NOT NULL,
    yaml_sha256    TEXT NOT NULL,
    valid          BOOLEAN NOT NULL,
    diagnostics    TEXT NOT NULL,
    semver         TEXT,
    ir             TEXT,
    ir_sha256      TEXT,
    based_on       INTEGER,
    actor          TEXT NOT NULL,
    imported       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    package_id     TEXT,
    package_semver TEXT,
    package_sha256 TEXT,
    card           TEXT,
    card_digest    TEXT,
    PRIMARY KEY (definition_id, revision),
    CONSTRAINT workflow_chat_revisions_valid_ir CHECK (valid = (ir IS NOT NULL AND ir_sha256 IS NOT NULL))
);

-- Each save, start and delete by its (chat, operation id), with its request digest and receipt: a repeated call is
-- answered from its receipt, and another request with that id is refused.
CREATE TABLE IF NOT EXISTS ${s}.workflow_chat_operations (
    owner_session_id TEXT NOT NULL,
    operation_id     TEXT NOT NULL,
    kind             TEXT NOT NULL,
    request_sha256   TEXT NOT NULL,
    receipt          TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_session_id, operation_id)
);

-- The newest revision of each definition the chat itself has seen (its own saves, its reads).
CREATE TABLE IF NOT EXISTS ${s}.workflow_chat_seen (
    owner_session_id TEXT NOT NULL,
    definition_id    TEXT NOT NULL,
    revision         INTEGER NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_session_id, definition_id)
);

-- A person's save leaves one note the chat reads on its next turn; it is consumed with the success of the turn that
-- read it, never by a turn that failed.
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

-- Deleting a Workflow session ends its Workflow in the same transaction, whatever deletes it. Every Workflow transition
-- locks the session row first and re-checks deleted_at, so nothing admits, starts or completes work after this commits.
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
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;


-- A chat that ends ends its Workflows, locking in the runtime's order (see the header).
CREATE OR REPLACE FUNCTION ${s}.workflow_on_chat_ended() RETURNS TRIGGER AS $$
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

DO $sessions_triggers$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgrelid = '${s}.sessions'::regclass AND tgname = 'workflow_session_deleted') THEN
        CREATE TRIGGER workflow_session_deleted
            AFTER UPDATE OF deleted_at ON ${s}.sessions
            FOR EACH ROW EXECUTE FUNCTION ${s}.workflow_on_session_deleted();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger
                    WHERE tgrelid = '${s}.sessions'::regclass AND tgname = 'workflow_chat_ended') THEN
        CREATE TRIGGER workflow_chat_ended
            AFTER UPDATE OF state, deleted_at ON ${s}.sessions
            FOR EACH ROW
            WHEN (NEW.session_kind IS DISTINCT FROM 'workflow'
                  AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at))
            EXECUTE FUNCTION ${s}.workflow_on_chat_ended();
    END IF;
END
$sessions_triggers$;

COMMIT;
`, `
-- 0088_workflow: drop an invalid parent_session_id index that a failed concurrent build left, under a lock timeout
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
          AND c.relname = '${parentIndex}'
          AND NOT i.indisvalid
    ) THEN
        EXECUTE 'DROP INDEX ${s}.${parentIndex}';
    END IF;
END
$parent_index$;
COMMIT;
`, `
-- 0088_workflow: the parent_session_id index, built concurrently
CREATE INDEX CONCURRENTLY IF NOT EXISTS ${parentIndex}
    ON ${s}.sessions(parent_session_id);
`];
}
