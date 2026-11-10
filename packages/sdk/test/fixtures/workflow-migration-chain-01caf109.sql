-- The Workflow migrations 0088-0111 as PR 270 had them at 01caf109869c58c4d47e03f8c73826a0281c9862, before they were
-- collapsed into the one migration 0088 (workflow). Frozen: workflow-migration-0088.test.js applies them after main's
-- 0001-0087 and compares the schema they leave with the schema the collapsed migration creates. Never edit.
-- Each migration starts at a "-- @migration <version> <name> <sql|steps>" line; a steps migration's steps are separated by
-- "-- @step" lines. "pswf_chain_schema" stands for the schema.
-- @migration 0088 workflow_session_kind sql
ALTER TABLE "pswf_chain_schema".sessions
    ADD COLUMN IF NOT EXISTS session_kind TEXT NOT NULL DEFAULT 'agent';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'sessions_session_kind_check'
           AND conrelid = 'pswf_chain_schema.sessions'::regclass
    ) THEN
        ALTER TABLE "pswf_chain_schema".sessions
            ADD CONSTRAINT sessions_session_kind_check
            CHECK (session_kind IN ('agent', 'workflow'));
    END IF;
END $$;
-- @migration 0089 workflow_v2 sql
-- 0089_workflow_v2

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_definitions (
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
    CONSTRAINT workflow_definitions_published_pins CHECK (
        state <> 'published'
        OR (published_revision IS NOT NULL AND published_yaml_sha256 IS NOT NULL AND published_ir_sha256 IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_revisions (
    workflow_session_id TEXT NOT NULL REFERENCES "pswf_chain_schema".workflow_definitions (workflow_session_id),
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

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_operations (
    workflow_session_id TEXT NOT NULL,
    operation_id        TEXT NOT NULL,
    kind                TEXT NOT NULL,
    request_sha256      TEXT NOT NULL,
    receipt             TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workflow_session_id, operation_id)
);

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_runs (
    run_id                 TEXT PRIMARY KEY,
    workflow_session_id    TEXT NOT NULL REFERENCES "pswf_chain_schema".workflow_definitions (workflow_session_id),
    mode                   TEXT NOT NULL CHECK (mode IN ('live', 'test')),
    revision               INTEGER NOT NULL,
    yaml_sha256            TEXT NOT NULL,
    ir_sha256              TEXT NOT NULL,
    inputs                 TEXT NOT NULL,
    controller_instance_id TEXT NOT NULL UNIQUE,
    status                 TEXT NOT NULL CHECK (status IN ('admitted', 'running', 'completed', 'failed', 'cancelled')),
    test_agent_mode        TEXT CHECK (test_agent_mode IN ('mocked', 'real')),
    terminal_node_id       TEXT,
    terminal_outcome       TEXT,
    terminal_output        TEXT,
    terminal_error         TEXT,
    start_operation_id     TEXT NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at            TIMESTAMPTZ,
    FOREIGN KEY (workflow_session_id, revision) REFERENCES "pswf_chain_schema".workflow_revisions (workflow_session_id, revision),
    CONSTRAINT workflow_runs_test_mode CHECK ((mode = 'test') = (test_agent_mode IS NOT NULL)),
    CONSTRAINT workflow_runs_terminal CHECK (
        (status IN ('completed', 'failed', 'cancelled')) = (finished_at IS NOT NULL)
    )
);

-- One live run per published workflow child (D04).
CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_one_live
    ON "pswf_chain_schema".workflow_runs (workflow_session_id) WHERE mode = 'live';
CREATE INDEX IF NOT EXISTS workflow_runs_by_workflow
    ON "pswf_chain_schema".workflow_runs (workflow_session_id, created_at);

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_node_executions (
    node_execution_id TEXT PRIMARY KEY,
    run_id            TEXT NOT NULL REFERENCES "pswf_chain_schema".workflow_runs (run_id),
    scope_id          TEXT NOT NULL,
    node_id           TEXT NOT NULL,
    ordinal           INTEGER NOT NULL CHECK (ordinal >= 1),
    node_type         TEXT NOT NULL,
    predecessor_id    TEXT REFERENCES "pswf_chain_schema".workflow_node_executions (node_execution_id),
    arrival_route     TEXT,
    input             TEXT NOT NULL,
    input_sha256      TEXT NOT NULL,
    state             TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
    outcome           TEXT,
    result_kind       TEXT CHECK (result_kind IN ('business', 'runtime_error')),
    output            TEXT,
    error             TEXT,
    winner            TEXT,
    effect_attempts   INTEGER NOT NULL DEFAULT 0,
    entered_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at      TIMESTAMPTZ,
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
    ON "pswf_chain_schema".workflow_node_executions (run_id, entered_at);
-- @migration 0090 workflow_v2_session_lifecycle sql
-- 0090_workflow_v2_session_lifecycle
-- Exclusive creation of a v2 workflow session row. The INSERT is the claim:
-- when any row with this id exists (live or deleted, of any kind, committed
-- or being inserted concurrently), nothing is changed and FALSE is returned.
-- Root, group and visibility resolve as in cms_create_session.
CREATE OR REPLACE FUNCTION "pswf_chain_schema".cms_create_workflow_session_v2(
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
          FROM "pswf_chain_schema".sessions parent
         WHERE parent.session_id = p_parent_session_id;
    END IF;
    v_root := COALESCE(v_root, p_session_id);

    INSERT INTO "pswf_chain_schema".sessions
        (session_id, parent_session_id, is_system, group_id, root_session_id, visibility, session_kind, creation_config)
    VALUES
        (p_session_id, p_parent_session_id, FALSE, v_group, v_root, 'private', 'workflow', p_creation_config)
    ON CONFLICT (session_id) DO NOTHING
    RETURNING session_id INTO v_claimed;

    IF v_claimed IS NULL THEN
        RETURN FALSE;
    END IF;

    INSERT INTO "pswf_chain_schema".session_metric_summaries (session_id, parent_session_id)
    VALUES (p_session_id, p_parent_session_id)
    ON CONFLICT (session_id) DO UPDATE
    SET parent_session_id = COALESCE("pswf_chain_schema".session_metric_summaries.parent_session_id, EXCLUDED.parent_session_id),
        updated_at        = now();
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- Deleting a workflow session ends its v2 workflow in the same transaction,
-- whatever deletes it: the definition becomes a permanent tombstone, active
-- runs are cancelled and their pending node executions lose to the deletion.
-- Every v2 transition locks the session row first and re-checks deleted_at,
-- so nothing admits, starts or completes work after this commits.
CREATE OR REPLACE FUNCTION "pswf_chain_schema".workflow_v2_on_session_deleted() RETURNS TRIGGER AS $$
DECLARE
    v_envelope CONSTANT TEXT := '{"code":"cancelled","message":"The workflow session was deleted."}';
BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        UPDATE "pswf_chain_schema".workflow_definitions
           SET state = 'deleted', updated_at = now()
         WHERE workflow_session_id = NEW.session_id
           AND state <> 'deleted';
        UPDATE "pswf_chain_schema".workflow_node_executions AS node
           SET state = 'completed', outcome = 'cancelled', result_kind = 'runtime_error',
               error = v_envelope, output = NULL, winner = 'delete', completed_at = now()
          FROM "pswf_chain_schema".workflow_runs AS run
         WHERE run.run_id = node.run_id
           AND run.workflow_session_id = NEW.session_id
           AND run.status IN ('admitted', 'running')
           AND node.state = 'pending';
        UPDATE "pswf_chain_schema".workflow_runs
           SET status = 'cancelled', terminal_error = v_envelope, updated_at = now(), finished_at = now()
         WHERE workflow_session_id = NEW.session_id
           AND status IN ('admitted', 'running');
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_v2_session_deleted ON "pswf_chain_schema".sessions;
CREATE TRIGGER workflow_v2_session_deleted
    AFTER UPDATE OF deleted_at ON "pswf_chain_schema".sessions
    FOR EACH ROW EXECUTE FUNCTION "pswf_chain_schema".workflow_v2_on_session_deleted();
-- @migration 0091 workflow_v2_kv_pause sql
-- 0091_workflow_v2_kv_pause

ALTER TABLE "pswf_chain_schema".workflow_runs ADD COLUMN IF NOT EXISTS kv TEXT NOT NULL DEFAULT '{}';
ALTER TABLE "pswf_chain_schema".workflow_runs ADD COLUMN IF NOT EXISTS kv_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "pswf_chain_schema".workflow_runs ADD COLUMN IF NOT EXISTS paused_from TEXT;
ALTER TABLE "pswf_chain_schema".workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_status_check;
ALTER TABLE "pswf_chain_schema".workflow_runs ADD CONSTRAINT workflow_runs_status_check
    CHECK (status IN ('admitted', 'running', 'paused', 'completed', 'failed', 'cancelled'));
ALTER TABLE "pswf_chain_schema".workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_paused_from;
ALTER TABLE "pswf_chain_schema".workflow_runs ADD CONSTRAINT workflow_runs_paused_from
    CHECK ((status = 'paused') = (paused_from IS NOT NULL) AND (paused_from IS NULL OR paused_from IN ('admitted', 'running')));

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_kv_revisions (
    run_id       TEXT NOT NULL REFERENCES "pswf_chain_schema".workflow_runs (run_id),
    revision     INTEGER NOT NULL CHECK (revision >= 1),
    kv           TEXT NOT NULL,
    operation_id TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, revision)
);
INSERT INTO "pswf_chain_schema".workflow_kv_revisions (run_id, revision, kv)
SELECT run_id, 1, '{}' FROM "pswf_chain_schema".workflow_runs
ON CONFLICT (run_id, revision) DO NOTHING;

ALTER TABLE "pswf_chain_schema".workflow_node_executions ADD COLUMN IF NOT EXISTS kv_revision INTEGER;

CREATE OR REPLACE FUNCTION "pswf_chain_schema".workflow_v2_on_session_deleted() RETURNS TRIGGER AS $$
DECLARE
    v_envelope CONSTANT TEXT := '{"code":"cancelled","message":"The workflow session was deleted."}';
BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        UPDATE "pswf_chain_schema".workflow_definitions
           SET state = 'deleted', updated_at = now()
         WHERE workflow_session_id = NEW.session_id
           AND state <> 'deleted';
        UPDATE "pswf_chain_schema".workflow_node_executions AS node
           SET state = 'completed', outcome = 'cancelled', result_kind = 'runtime_error',
               error = v_envelope, output = NULL, winner = 'delete', completed_at = now()
          FROM "pswf_chain_schema".workflow_runs AS run
         WHERE run.run_id = node.run_id
           AND run.workflow_session_id = NEW.session_id
           AND run.status IN ('admitted', 'running', 'paused')
           AND node.state = 'pending';
        UPDATE "pswf_chain_schema".workflow_runs
           SET status = 'cancelled', paused_from = NULL, terminal_error = v_envelope, updated_at = now(), finished_at = now()
         WHERE workflow_session_id = NEW.session_id
           AND status IN ('admitted', 'running', 'paused');
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- @migration 0092 workflow_v2_wait sql
-- 0092_workflow_v2_wait

ALTER TABLE "pswf_chain_schema".workflow_node_executions ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;
-- @migration 0093 workflow_v2_inbox sql
-- 0093_workflow_v2_inbox

ALTER TABLE "pswf_chain_schema".workflow_node_executions ADD COLUMN IF NOT EXISTS receive_contract TEXT;
ALTER TABLE "pswf_chain_schema".workflow_node_executions ADD COLUMN IF NOT EXISTS receive_from TEXT;
ALTER TABLE "pswf_chain_schema".workflow_node_executions ADD COLUMN IF NOT EXISTS receive_correlation TEXT;

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_inbox (
    message_id          TEXT PRIMARY KEY,
    seq                 BIGSERIAL NOT NULL UNIQUE,
    workflow_session_id TEXT NOT NULL,
    run_id              TEXT NOT NULL REFERENCES "pswf_chain_schema".workflow_runs (run_id),
    sender_session_id   TEXT NOT NULL,
    operation_id        TEXT NOT NULL,
    request_sha256      TEXT NOT NULL,
    contract            TEXT NOT NULL,
    correlation         TEXT NOT NULL,
    payload             TEXT NOT NULL,
    accepted_at         TIMESTAMPTZ NOT NULL,
    expires_at          TIMESTAMPTZ NOT NULL,
    consumed_by         TEXT REFERENCES "pswf_chain_schema".workflow_node_executions (node_execution_id),
    consumed_at         TIMESTAMPTZ,
    UNIQUE (workflow_session_id, sender_session_id, operation_id),
    CONSTRAINT workflow_inbox_consumed CHECK ((consumed_by IS NULL) = (consumed_at IS NULL)),
    CONSTRAINT workflow_inbox_expiry CHECK (expires_at > accepted_at)
);
CREATE INDEX IF NOT EXISTS workflow_inbox_unconsumed
    ON "pswf_chain_schema".workflow_inbox (run_id, contract, seq) WHERE consumed_by IS NULL;
CREATE INDEX IF NOT EXISTS workflow_inbox_by_sender
    ON "pswf_chain_schema".workflow_inbox (workflow_session_id, sender_session_id, accepted_at);
-- A receive state takes at most one message.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_inbox_one_claim
    ON "pswf_chain_schema".workflow_inbox (consumed_by) WHERE consumed_by IS NOT NULL;
-- @migration 0094 workflow_v2_input_receipt sql
-- 0094_workflow_v2_input_receipt

ALTER TABLE "pswf_chain_schema".workflow_inbox ADD COLUMN IF NOT EXISTS receipt TEXT;
-- @migration 0095 workflow_v2_outbox sql
-- 0095_workflow_v2_outbox

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_outbox (
    exchange_id          TEXT PRIMARY KEY,
    node_execution_id    TEXT NOT NULL UNIQUE REFERENCES "pswf_chain_schema".workflow_node_executions (node_execution_id),
    workflow_session_id  TEXT NOT NULL,
    run_id               TEXT NOT NULL REFERENCES "pswf_chain_schema".workflow_runs (run_id),
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
CREATE INDEX IF NOT EXISTS workflow_outbox_by_run ON "pswf_chain_schema".workflow_outbox (run_id, created_at);
-- @migration 0096 workflow_v2_outbox_recipient sql
-- 0096_workflow_v2_outbox_recipient

ALTER TABLE "pswf_chain_schema".workflow_outbox ADD COLUMN IF NOT EXISTS recipient_kind TEXT;
ALTER TABLE "pswf_chain_schema".workflow_outbox ADD COLUMN IF NOT EXISTS correlation TEXT;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_outbox_recipient_kind'
                     AND conrelid = '"pswf_chain_schema".workflow_outbox'::regclass) THEN
        ALTER TABLE "pswf_chain_schema".workflow_outbox
            ADD CONSTRAINT workflow_outbox_recipient_kind CHECK (recipient_kind IS NULL OR recipient_kind IN ('agent', 'workflow'));
    END IF;
END $$;
-- @migration 0097 workflow_v2_requests sql
-- 0097_workflow_v2_requests

ALTER TABLE "pswf_chain_schema".workflow_outbox DROP CONSTRAINT IF EXISTS workflow_outbox_mode;
ALTER TABLE "pswf_chain_schema".workflow_outbox ADD CONSTRAINT workflow_outbox_mode CHECK (mode IN ('send', 'request'));

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_requests (
    exchange_id            TEXT PRIMARY KEY REFERENCES "pswf_chain_schema".workflow_outbox (exchange_id),
    workflow_session_id    TEXT NOT NULL,
    run_id                 TEXT NOT NULL REFERENCES "pswf_chain_schema".workflow_runs (run_id),
    responder_session_id   TEXT NOT NULL,
    contract               TEXT NOT NULL,
    request_sha256         TEXT NOT NULL,
    response_schema        TEXT NOT NULL,
    deadline_at            TIMESTAMPTZ NOT NULL,
    created_at             TIMESTAMPTZ NOT NULL,
    CONSTRAINT workflow_requests_node FOREIGN KEY (exchange_id) REFERENCES "pswf_chain_schema".workflow_node_executions (node_execution_id)
);
CREATE INDEX IF NOT EXISTS workflow_requests_by_run ON "pswf_chain_schema".workflow_requests (run_id, created_at);

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_request_responses (
    exchange_id      TEXT PRIMARY KEY REFERENCES "pswf_chain_schema".workflow_requests (exchange_id),
    kind             TEXT NOT NULL,
    value            TEXT NOT NULL,
    result_sha256    TEXT NOT NULL,
    operation_id     TEXT NOT NULL,
    actor_session_id TEXT NOT NULL,
    decided_at       TIMESTAMPTZ NOT NULL,
    receipt          TEXT NOT NULL,
    CONSTRAINT workflow_request_responses_kind CHECK (kind IN ('response', 'decline'))
);

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_request_operations (
    exchange_id      TEXT NOT NULL REFERENCES "pswf_chain_schema".workflow_requests (exchange_id),
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

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_response_wakes (
    exchange_id            TEXT PRIMARY KEY REFERENCES "pswf_chain_schema".workflow_request_responses (exchange_id),
    run_id                 TEXT NOT NULL REFERENCES "pswf_chain_schema".workflow_runs (run_id),
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
CREATE INDEX IF NOT EXISTS workflow_response_wakes_due ON "pswf_chain_schema".workflow_response_wakes (state, next_attempt_at);

-- A request and its response are written once; an operation binding changes only its repeat counters; a settled wake
-- never changes. None of these rows is deleted.
CREATE OR REPLACE FUNCTION "pswf_chain_schema".workflow_v2_request_rows_guard() RETURNS TRIGGER AS $$
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

DROP TRIGGER IF EXISTS workflow_requests_guard ON "pswf_chain_schema".workflow_requests;
CREATE TRIGGER workflow_requests_guard BEFORE UPDATE OR DELETE ON "pswf_chain_schema".workflow_requests
    FOR EACH ROW EXECUTE FUNCTION "pswf_chain_schema".workflow_v2_request_rows_guard();
DROP TRIGGER IF EXISTS workflow_request_responses_guard ON "pswf_chain_schema".workflow_request_responses;
CREATE TRIGGER workflow_request_responses_guard BEFORE UPDATE OR DELETE ON "pswf_chain_schema".workflow_request_responses
    FOR EACH ROW EXECUTE FUNCTION "pswf_chain_schema".workflow_v2_request_rows_guard();
DROP TRIGGER IF EXISTS workflow_request_operations_guard ON "pswf_chain_schema".workflow_request_operations;
CREATE TRIGGER workflow_request_operations_guard BEFORE UPDATE OR DELETE ON "pswf_chain_schema".workflow_request_operations
    FOR EACH ROW EXECUTE FUNCTION "pswf_chain_schema".workflow_v2_request_rows_guard();
DROP TRIGGER IF EXISTS workflow_response_wakes_guard ON "pswf_chain_schema".workflow_response_wakes;
CREATE TRIGGER workflow_response_wakes_guard BEFORE UPDATE OR DELETE ON "pswf_chain_schema".workflow_response_wakes
    FOR EACH ROW EXECUTE FUNCTION "pswf_chain_schema".workflow_v2_request_rows_guard();
-- @migration 0098 workflow_v2_intake sql
-- 0098_workflow_v2_intake

ALTER TABLE "pswf_chain_schema".workflow_outbox ADD COLUMN IF NOT EXISTS intake_mode TEXT;
ALTER TABLE "pswf_chain_schema".workflow_outbox ADD COLUMN IF NOT EXISTS attempt_token TEXT;
ALTER TABLE "pswf_chain_schema".workflow_outbox ADD COLUMN IF NOT EXISTS intake_outcome TEXT;
ALTER TABLE "pswf_chain_schema".workflow_outbox ADD COLUMN IF NOT EXISTS intake_outcome_at TIMESTAMPTZ;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_outbox_intake_mode'
                     AND conrelid = '"pswf_chain_schema".workflow_outbox'::regclass) THEN
        ALTER TABLE "pswf_chain_schema".workflow_outbox
            ADD CONSTRAINT workflow_outbox_intake_mode CHECK (intake_mode IS NULL OR intake_mode IN ('durable', 'legacy_window'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_outbox_intake_outcome'
                     AND conrelid = '"pswf_chain_schema".workflow_outbox'::regclass) THEN
        ALTER TABLE "pswf_chain_schema".workflow_outbox
            ADD CONSTRAINT workflow_outbox_intake_outcome CHECK ((
                (intake_outcome IS NULL AND intake_outcome_at IS NULL)
                OR (intake_outcome IS NOT NULL AND intake_outcome IN ('refused_full', 'refused_size') AND intake_outcome_at IS NOT NULL
                    AND intake_mode IS NOT DISTINCT FROM 'durable')
            ) IS TRUE);
    END IF;
END $$;

-- The intake fence: only the first counted attempt decides the mode, and a durable row is counted only with a new token.
CREATE OR REPLACE FUNCTION "pswf_chain_schema".workflow_v2_outbox_intake_fence() RETURNS TRIGGER AS $$
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

DROP TRIGGER IF EXISTS workflow_outbox_intake_fence ON "pswf_chain_schema".workflow_outbox;
CREATE TRIGGER workflow_outbox_intake_fence BEFORE UPDATE ON "pswf_chain_schema".workflow_outbox
    FOR EACH ROW EXECUTE FUNCTION "pswf_chain_schema".workflow_v2_outbox_intake_fence();

-- An invocation's complete membership, written once by its first bind. Every bind, end and cancel of the invocation first takes a
-- transaction-scoped advisory lock on its identity (store.ts lockIntakeInvocation), the first bind included, and checks this row.
CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_intake_invocations (
    invocation_id        TEXT PRIMARY KEY,
    recipient_session_id TEXT NOT NULL,
    members              TEXT NOT NULL,
    member_count         INTEGER NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL,
    CONSTRAINT workflow_intake_invocations_count CHECK ((member_count BETWEEN 1 AND 64) IS TRUE)
);

CREATE OR REPLACE FUNCTION "pswf_chain_schema".workflow_v2_intake_invocation_guard() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'intake invocation %: an invocation is written once and is never changed or deleted', OLD.invocation_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_intake_invocations_guard ON "pswf_chain_schema".workflow_intake_invocations;
CREATE TRIGGER workflow_intake_invocations_guard BEFORE UPDATE OR DELETE ON "pswf_chain_schema".workflow_intake_invocations
    FOR EACH ROW EXECUTE FUNCTION "pswf_chain_schema".workflow_v2_intake_invocation_guard();

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_intake (
    exchange_id          TEXT PRIMARY KEY REFERENCES "pswf_chain_schema".workflow_outbox (exchange_id),
    recipient_session_id TEXT NOT NULL,
    workflow_session_id  TEXT NOT NULL,
    run_id               TEXT NOT NULL,
    envelope_sha256      TEXT NOT NULL,
    text                 TEXT,
    text_sha256          TEXT NOT NULL,
    claim_id             TEXT NOT NULL,
    state                TEXT NOT NULL,
    invocation_id        TEXT REFERENCES "pswf_chain_schema".workflow_intake_invocations (invocation_id),
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
CREATE INDEX IF NOT EXISTS workflow_intake_by_recipient ON "pswf_chain_schema".workflow_intake (recipient_session_id, created_at);
CREATE INDEX IF NOT EXISTS workflow_intake_by_invocation ON "pswf_chain_schema".workflow_intake (invocation_id) WHERE invocation_id IS NOT NULL;

-- An intake row keeps its identity and text; its state and processing move forward once; nothing goes back; none is deleted.
CREATE OR REPLACE FUNCTION "pswf_chain_schema".workflow_v2_intake_guard() RETURNS TRIGGER AS $$
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

DROP TRIGGER IF EXISTS workflow_intake_guard ON "pswf_chain_schema".workflow_intake;
CREATE TRIGGER workflow_intake_guard BEFORE UPDATE OR DELETE ON "pswf_chain_schema".workflow_intake
    FOR EACH ROW EXECUTE FUNCTION "pswf_chain_schema".workflow_v2_intake_guard();
-- @migration 0099 workflow_v2_intake_exposures sql
-- 0099_workflow_v2_intake_exposures

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_intake_exposures (
    invocation_id        TEXT PRIMARY KEY REFERENCES "pswf_chain_schema".workflow_intake_invocations (invocation_id),
    recipient_session_id TEXT NOT NULL,
    attempt_id           TEXT NOT NULL,
    exposed_at           TIMESTAMPTZ NOT NULL
);

-- An exposure is inserted once and is never changed or deleted.
CREATE OR REPLACE FUNCTION "pswf_chain_schema".workflow_v2_intake_exposure_guard() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'intake exposure %: an exposure is written once and is never changed or deleted', OLD.invocation_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_intake_exposures_guard ON "pswf_chain_schema".workflow_intake_exposures;
CREATE TRIGGER workflow_intake_exposures_guard BEFORE UPDATE OR DELETE ON "pswf_chain_schema".workflow_intake_exposures
    FOR EACH ROW EXECUTE FUNCTION "pswf_chain_schema".workflow_v2_intake_exposure_guard();
-- @migration 0100 workflow_v2_stop sql
-- 0100_workflow_v2_stop

ALTER TABLE "pswf_chain_schema".workflow_runs ADD COLUMN IF NOT EXISTS controller_version TEXT;
ALTER TABLE "pswf_chain_schema".workflow_runs ADD COLUMN IF NOT EXISTS stop_requested_at TIMESTAMPTZ;
ALTER TABLE "pswf_chain_schema".workflow_runs ADD COLUMN IF NOT EXISTS stop_deadline_at TIMESTAMPTZ;
ALTER TABLE "pswf_chain_schema".workflow_runs ADD COLUMN IF NOT EXISTS stop_request TEXT;

ALTER TABLE "pswf_chain_schema".workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_status_check;
ALTER TABLE "pswf_chain_schema".workflow_runs ADD CONSTRAINT workflow_runs_status_check
    CHECK (status IN ('admitted', 'running', 'paused', 'completed', 'failed', 'cancelled', 'stopped'));
ALTER TABLE "pswf_chain_schema".workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_terminal;
ALTER TABLE "pswf_chain_schema".workflow_runs ADD CONSTRAINT workflow_runs_terminal CHECK (
    (status IN ('completed', 'failed', 'cancelled', 'stopped')) = (finished_at IS NOT NULL)
);
ALTER TABLE "pswf_chain_schema".workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_stop;
ALTER TABLE "pswf_chain_schema".workflow_runs ADD CONSTRAINT workflow_runs_stop CHECK (
    (stop_requested_at IS NULL) = (stop_deadline_at IS NULL)
    AND (stop_requested_at IS NULL) = (stop_request IS NULL)
    AND (stop_deadline_at IS NULL OR stop_deadline_at >= stop_requested_at)
    AND (status <> 'stopped' OR stop_requested_at IS NOT NULL)
);
-- @migration 0101 workflow_v2_agent_states sql
-- 0101_workflow_v2_agent_states

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_agent_invocations (
    node_execution_id      TEXT PRIMARY KEY REFERENCES "pswf_chain_schema".workflow_node_executions (node_execution_id),
    run_id                 TEXT NOT NULL REFERENCES "pswf_chain_schema".workflow_runs (run_id),
    workflow_session_id    TEXT NOT NULL,
    child_session_id       TEXT NOT NULL UNIQUE,
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
CREATE INDEX IF NOT EXISTS workflow_agent_invocations_by_run ON "pswf_chain_schema".workflow_agent_invocations (run_id);

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_agent_completions (
    node_execution_id TEXT NOT NULL REFERENCES "pswf_chain_schema".workflow_agent_invocations (node_execution_id),
    operation_id      TEXT NOT NULL,
    result_sha256     TEXT NOT NULL,
    outcome           TEXT NOT NULL CHECK (outcome IN ('decided', 'same', 'invalid', 'expired', 'closed', 'conflict')),
    problems          TEXT,
    receipt           TEXT,
    created_at        TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (node_execution_id, operation_id),
    CONSTRAINT workflow_agent_completions_receipt CHECK ((outcome = 'decided') = (receipt IS NOT NULL))
);
-- @migration 0102 workflow_v2_test_runs sql
-- 0102_workflow_v2_test_runs

ALTER TABLE "pswf_chain_schema".workflow_runs ADD COLUMN IF NOT EXISTS virtual_now TIMESTAMPTZ;
ALTER TABLE "pswf_chain_schema".workflow_runs ADD COLUMN IF NOT EXISTS test_fixtures TEXT;
ALTER TABLE "pswf_chain_schema".workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_test_clock;
ALTER TABLE "pswf_chain_schema".workflow_runs ADD CONSTRAINT workflow_runs_test_clock CHECK (
    mode = 'test' OR (virtual_now IS NULL AND test_fixtures IS NULL)
);

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_test_interceptions (
    interception_id       TEXT PRIMARY KEY,
    seq                   BIGINT GENERATED ALWAYS AS IDENTITY,
    run_id                TEXT NOT NULL REFERENCES "pswf_chain_schema".workflow_runs (run_id),
    node_execution_id     TEXT NOT NULL REFERENCES "pswf_chain_schema".workflow_node_executions (node_execution_id),
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
CREATE INDEX IF NOT EXISTS workflow_test_interceptions_by_run ON "pswf_chain_schema".workflow_test_interceptions (run_id, seq);
-- @migration 0103 workflow_v2_publication_pins sql
-- 0103_workflow_v2_publication_pins

ALTER TABLE "pswf_chain_schema".workflow_definitions ADD COLUMN IF NOT EXISTS published_agent_pins TEXT;
ALTER TABLE "pswf_chain_schema".workflow_definitions DROP CONSTRAINT IF EXISTS workflow_definitions_agent_pins;
ALTER TABLE "pswf_chain_schema".workflow_definitions ADD CONSTRAINT workflow_definitions_agent_pins CHECK (
    published_agent_pins IS NULL OR published_revision IS NOT NULL
);
ALTER TABLE "pswf_chain_schema".workflow_runs ADD COLUMN IF NOT EXISTS test_scenario TEXT;
ALTER TABLE "pswf_chain_schema".workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_test_scenario;
ALTER TABLE "pswf_chain_schema".workflow_runs ADD CONSTRAINT workflow_runs_test_scenario CHECK (mode = 'test' OR test_scenario IS NULL);
-- @migration 0104 workflow_v2_run_deadline sql
-- 0104_workflow_v2_run_deadline

ALTER TABLE "pswf_chain_schema".workflow_runs ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;
-- @migration 0105 workflow_v2_test_agent_pins sql
-- 0105_workflow_v2_test_agent_pins

ALTER TABLE "pswf_chain_schema".workflow_runs ADD COLUMN IF NOT EXISTS test_agent_pins TEXT;
ALTER TABLE "pswf_chain_schema".workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_test_agent_pins;
ALTER TABLE "pswf_chain_schema".workflow_runs ADD CONSTRAINT workflow_runs_test_agent_pins CHECK (
    test_agent_pins IS NULL OR (mode = 'test' AND test_agent_mode = 'real')
);
-- @migration 0106 workflow_v2_agent_chat_continues sql
-- 0106_workflow_v2_agent_chat_continues

DO $$
DECLARE
    v_rel REGCLASS := '"pswf_chain_schema".workflow_agent_invocations'::regclass;
    v_col SMALLINT;
    v_name TEXT;
BEGIN
    SELECT a.attnum INTO v_col FROM pg_attribute a
     WHERE a.attrelid = v_rel AND a.attname = 'child_session_id' AND NOT a.attisdropped;
    -- Every UNIQUE constraint on exactly (child_session_id), whatever its name (its index goes with it).
    FOR v_name IN SELECT c.conname FROM pg_constraint c
                   WHERE c.conrelid = v_rel AND c.contype = 'u'
                     AND array_length(c.conkey, 1) = 1 AND c.conkey[1] = v_col LOOP
        EXECUTE format('ALTER TABLE "pswf_chain_schema".workflow_agent_invocations DROP CONSTRAINT %I', v_name);
    END LOOP;
    -- Every unique index on exactly (child_session_id) that no constraint owns, partial or not.
    FOR v_name IN SELECT x.relname FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid
                   WHERE i.indrelid = v_rel AND i.indisunique AND NOT i.indisprimary
                     AND i.indnkeyatts = 1 AND i.indkey[0] = v_col
                     AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid) LOOP
        EXECUTE format('DROP INDEX "pswf_chain_schema".%I', v_name);
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_index i
                WHERE i.indrelid = v_rel AND i.indisunique AND NOT i.indisprimary
                  AND i.indnkeyatts = 1 AND i.indkey[0] = v_col) THEN
        RAISE EXCEPTION '0106: workflow_agent_invocations.child_session_id is still unique; a chat that continues needs one row per visit';
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS workflow_agent_invocations_by_child ON "pswf_chain_schema".workflow_agent_invocations (child_session_id, created_at);
-- @migration 0107 workflow_chat_definitions sql
-- 0107_workflow_chat_definitions

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_chat_definitions (
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
    ON "pswf_chain_schema".workflow_chat_definitions (owner_session_id, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS workflow_chat_definitions_by_owner ON "pswf_chain_schema".workflow_chat_definitions (owner_session_id, created_at);

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_chat_revisions (
    definition_id TEXT NOT NULL REFERENCES "pswf_chain_schema".workflow_chat_definitions (definition_id),
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

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_chat_operations (
    owner_session_id TEXT NOT NULL,
    operation_id     TEXT NOT NULL,
    kind             TEXT NOT NULL,
    request_sha256   TEXT NOT NULL,
    receipt          TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_session_id, operation_id)
);

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_chat_seen (
    owner_session_id TEXT NOT NULL,
    definition_id    TEXT NOT NULL,
    revision         INTEGER NOT NULL,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_session_id, definition_id)
);

CREATE TABLE IF NOT EXISTS "pswf_chain_schema".workflow_chat_notes (
    note_id          BIGSERIAL PRIMARY KEY,
    owner_session_id TEXT NOT NULL,
    definition_id    TEXT NOT NULL,
    revision         INTEGER NOT NULL,
    text             TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS workflow_chat_notes_pending ON "pswf_chain_schema".workflow_chat_notes (owner_session_id, note_id) WHERE consumed_at IS NULL;

ALTER TABLE "pswf_chain_schema".workflow_definitions ADD COLUMN IF NOT EXISTS chat_definition_id TEXT;
ALTER TABLE "pswf_chain_schema".workflow_definitions ADD COLUMN IF NOT EXISTS chat_revision INTEGER;
CREATE INDEX IF NOT EXISTS workflow_definitions_by_chat_definition
    ON "pswf_chain_schema".workflow_definitions (chat_definition_id, chat_revision) WHERE chat_definition_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_definitions_by_parent ON "pswf_chain_schema".workflow_definitions (parent_session_id) WHERE parent_session_id IS NOT NULL;

-- R5 and F2: a chat that ends ends its Workflows.
CREATE OR REPLACE FUNCTION "pswf_chain_schema".workflow_v2_on_chat_ended() RETURNS TRIGGER AS $$
DECLARE
    v_envelope CONSTANT TEXT := '{"code":"cancelled","message":"The chat that owns this Workflow ended, so the Workflow was canceled."}';
BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        UPDATE "pswf_chain_schema".workflow_chat_definitions
           SET deleted_at = now(), deleted_by = '{"kind":"system","name":"chat-deleted"}', updated_at = now()
         WHERE owner_session_id = NEW.session_id AND deleted_at IS NULL;
        UPDATE "pswf_chain_schema".sessions
           SET deleted_at = now(), updated_at = now()
         WHERE parent_session_id = NEW.session_id AND session_kind = 'workflow' AND deleted_at IS NULL;
    ELSIF NEW.state IN ('completed', 'cancelled', 'failed') AND OLD.state IS DISTINCT FROM NEW.state THEN
        UPDATE "pswf_chain_schema".workflow_node_executions AS node
           SET state = 'completed', outcome = 'cancelled', result_kind = 'runtime_error',
               error = v_envelope, output = NULL, winner = 'delete', completed_at = now()
          FROM "pswf_chain_schema".workflow_runs AS run, "pswf_chain_schema".sessions AS child
         WHERE run.run_id = node.run_id
           AND run.workflow_session_id = child.session_id
           AND child.parent_session_id = NEW.session_id AND child.session_kind = 'workflow'
           AND run.mode = 'live' AND run.status IN ('admitted', 'running', 'paused')
           AND node.state = 'pending';
        WITH ended AS (
            UPDATE "pswf_chain_schema".workflow_runs AS run
               SET status = 'cancelled', terminal_error = v_envelope, updated_at = now(), finished_at = now()
              FROM "pswf_chain_schema".sessions AS child
             WHERE run.workflow_session_id = child.session_id
               AND child.parent_session_id = NEW.session_id AND child.session_kind = 'workflow'
               AND run.mode = 'live' AND run.status IN ('admitted', 'running', 'paused')
            RETURNING run.workflow_session_id
        )
        UPDATE "pswf_chain_schema".sessions
           SET state = 'cancelled', updated_at = now()
         WHERE session_id IN (SELECT workflow_session_id FROM ended) AND deleted_at IS NULL;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_v2_chat_ended ON "pswf_chain_schema".sessions;
CREATE TRIGGER workflow_v2_chat_ended
    AFTER UPDATE OF state, deleted_at ON "pswf_chain_schema".sessions
    FOR EACH ROW
    WHEN (NEW.session_kind IS DISTINCT FROM 'workflow'
          AND (NEW.state IS DISTINCT FROM OLD.state OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at))
    EXECUTE FUNCTION "pswf_chain_schema".workflow_v2_on_chat_ended();

-- D3: stage 1 Workflows become definitions with imported revisions.
LOCK TABLE "pswf_chain_schema".workflow_definitions IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE workflow_0107_children ON COMMIT DROP AS
SELECT d.workflow_session_id AS child_id,
       d.parent_session_id AS owner_session_id,
       COALESCE(
           (SELECT r.name FROM "pswf_chain_schema".workflow_revisions r
             WHERE r.workflow_session_id = d.workflow_session_id AND r.revision = d.current_revision),
           (SELECT r.name FROM "pswf_chain_schema".workflow_revisions r
             WHERE r.workflow_session_id = d.workflow_session_id AND r.name IS NOT NULL
             ORDER BY r.revision DESC LIMIT 1)) AS name,
       COALESCE(d.published_yaml_sha256,
           (SELECT r.yaml_sha256 FROM "pswf_chain_schema".workflow_revisions r
             WHERE r.workflow_session_id = d.workflow_session_id AND r.revision = d.current_revision)) AS pinned_yaml_sha256
  FROM "pswf_chain_schema".workflow_definitions d
  JOIN "pswf_chain_schema".sessions p ON p.session_id = d.parent_session_id
 WHERE d.parent_session_id IS NOT NULL AND p.deleted_at IS NULL AND d.chat_definition_id IS NULL;

DELETE FROM workflow_0107_children WHERE name IS NULL;

INSERT INTO "pswf_chain_schema".workflow_chat_definitions (definition_id, owner_session_id, name, current_revision, source, created_by, created_at, updated_at)
SELECT 'imported-' || md5(c.owner_session_id || chr(31) || c.name), c.owner_session_id, c.name, 0, 'imported',
       '{"kind":"system","name":"imported"}',
       min(r.created_at), now()
  FROM workflow_0107_children c
  JOIN "pswf_chain_schema".workflow_revisions r ON r.workflow_session_id = c.child_id
 GROUP BY c.owner_session_id, c.name
ON CONFLICT (definition_id) DO NOTHING;

INSERT INTO "pswf_chain_schema".workflow_chat_revisions
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
          JOIN "pswf_chain_schema".workflow_revisions r ON r.workflow_session_id = c.child_id
      ) f
     WHERE f.copy = 1
  ) n
ON CONFLICT (definition_id, revision) DO NOTHING;

UPDATE "pswf_chain_schema".workflow_chat_definitions d
   SET current_revision = (SELECT max(r.revision) FROM "pswf_chain_schema".workflow_chat_revisions r WHERE r.definition_id = d.definition_id)
 WHERE d.source = 'imported' AND d.current_revision = 0;

UPDATE "pswf_chain_schema".workflow_definitions d
   SET chat_definition_id = r.definition_id, chat_revision = r.revision
  FROM workflow_0107_children c, "pswf_chain_schema".workflow_chat_revisions r
 WHERE d.workflow_session_id = c.child_id
   AND r.definition_id = 'imported-' || md5(c.owner_session_id || chr(31) || c.name)
   AND r.yaml_sha256 = c.pinned_yaml_sha256;
-- @migration 0108 workflow_package_definitions sql
-- 0108_workflow_package_definitions

ALTER TABLE "pswf_chain_schema".workflow_chat_definitions ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "pswf_chain_schema".workflow_chat_definitions ADD COLUMN IF NOT EXISTS package_name TEXT;

ALTER TABLE "pswf_chain_schema".workflow_chat_revisions ADD COLUMN IF NOT EXISTS package_id TEXT;
ALTER TABLE "pswf_chain_schema".workflow_chat_revisions ADD COLUMN IF NOT EXISTS package_semver TEXT;
ALTER TABLE "pswf_chain_schema".workflow_chat_revisions ADD COLUMN IF NOT EXISTS package_sha256 TEXT;
ALTER TABLE "pswf_chain_schema".workflow_chat_revisions ADD COLUMN IF NOT EXISTS card TEXT;
ALTER TABLE "pswf_chain_schema".workflow_chat_revisions ADD COLUMN IF NOT EXISTS card_digest TEXT;

ALTER TABLE "pswf_chain_schema".sessions ADD COLUMN IF NOT EXISTS workflow_ref TEXT;
-- @migration 0109 workflow_chat_ended_lock_order sql
-- 0109_workflow_chat_ended_lock_order
CREATE OR REPLACE FUNCTION "pswf_chain_schema".workflow_v2_on_chat_ended() RETURNS TRIGGER AS $$
DECLARE
    v_envelope CONSTANT TEXT := '{"code":"cancelled","message":"The chat that owns this Workflow ended, so the Workflow was canceled."}';
BEGIN
    IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
        UPDATE "pswf_chain_schema".workflow_chat_definitions
           SET deleted_at = now(), deleted_by = '{"kind":"system","name":"chat-deleted"}', updated_at = now()
         WHERE owner_session_id = NEW.session_id AND deleted_at IS NULL;
        PERFORM 1 FROM "pswf_chain_schema".sessions
          WHERE parent_session_id = NEW.session_id AND session_kind = 'workflow' AND deleted_at IS NULL
          ORDER BY session_id
          FOR NO KEY UPDATE;
        UPDATE "pswf_chain_schema".sessions
           SET deleted_at = now(), updated_at = now()
         WHERE parent_session_id = NEW.session_id AND session_kind = 'workflow' AND deleted_at IS NULL;
    ELSIF NEW.state IN ('completed', 'cancelled', 'failed') AND OLD.state IS DISTINCT FROM NEW.state THEN
        PERFORM 1 FROM "pswf_chain_schema".sessions
          WHERE parent_session_id = NEW.session_id AND session_kind = 'workflow' AND deleted_at IS NULL
          ORDER BY session_id
          FOR NO KEY UPDATE;
        PERFORM 1 FROM "pswf_chain_schema".workflow_runs AS run
          JOIN "pswf_chain_schema".sessions AS child ON child.session_id = run.workflow_session_id
         WHERE child.parent_session_id = NEW.session_id AND child.session_kind = 'workflow'
           AND run.mode IN ('live', 'test') AND run.status IN ('admitted', 'running', 'paused')
         ORDER BY run.run_id
           FOR UPDATE OF run;
        UPDATE "pswf_chain_schema".workflow_node_executions AS node
           SET state = 'completed', outcome = 'cancelled', result_kind = 'runtime_error',
               error = v_envelope, output = NULL, winner = 'delete', completed_at = now()
          FROM "pswf_chain_schema".workflow_runs AS run, "pswf_chain_schema".sessions AS child
         WHERE run.run_id = node.run_id
           AND run.workflow_session_id = child.session_id
           AND child.parent_session_id = NEW.session_id AND child.session_kind = 'workflow'
           AND run.mode IN ('live', 'test') AND run.status IN ('admitted', 'running', 'paused')
           AND node.state = 'pending';
        WITH ended AS (
            UPDATE "pswf_chain_schema".workflow_runs AS run
               SET status = 'cancelled', paused_from = NULL, terminal_error = v_envelope, updated_at = now(), finished_at = now()
              FROM "pswf_chain_schema".sessions AS child
             WHERE run.workflow_session_id = child.session_id
               AND child.parent_session_id = NEW.session_id AND child.session_kind = 'workflow'
               AND run.mode IN ('live', 'test') AND run.status IN ('admitted', 'running', 'paused')
            RETURNING run.workflow_session_id
        )
        UPDATE "pswf_chain_schema".sessions
           SET state = 'cancelled', updated_at = now()
         WHERE session_id IN (SELECT workflow_session_id FROM ended) AND deleted_at IS NULL;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
-- @migration 0110 workflow_run_agent_models sql
-- 0110_workflow_run_agent_models
ALTER TABLE "pswf_chain_schema".workflow_runs ADD COLUMN IF NOT EXISTS agent_models TEXT;
-- @migration 0111 sessions_parent_session_index steps
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
        WHERE n.nspname = 'pswf_chain_schema'
          AND c.relname = 'idx_pswf_chain_schema_sessions_parent'
          AND NOT i.indisvalid
    ) THEN
        EXECUTE 'DROP INDEX "pswf_chain_schema".idx_pswf_chain_schema_sessions_parent';
    END IF;
END
$parent_index$;
COMMIT;
-- @step
-- 0111_sessions_parent_session_index
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pswf_chain_schema_sessions_parent
    ON "pswf_chain_schema".sessions(parent_session_id);
