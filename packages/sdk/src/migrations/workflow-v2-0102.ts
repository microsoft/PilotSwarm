/**
 * Migration 0102 — workflow v2 test runs (design 05 tool-mocked testing;
 * R19, R20, R28; INACTIVE: only controller 1.9.0 runs them, and only a test
 * host starts them).
 *
 * - workflow_runs.virtual_now: a test run's virtual clock; null for a live
 *   run. It starts at the test epoch (9000-01-01T00:00:00Z), after any real
 *   time, so no decision by the store's clock ever finds a test run's
 *   deadline due: a test run's waits, receive waits, request and agent
 *   deadlines are counted from it, and only an explicit advance moves it
 *   (monotonically) and decides what became due in the same transaction.
 * - workflow_runs.test_fixtures: the fixtures a test run answers intercepted
 *   operations from, as canonical JSON; null for a live run. Never changed.
 * - workflow_test_interceptions: one row per intercepted effect of a test run
 *   (a script's tool call, an agent state's agent, a send's delivery, a
 *   request's exchange), written once when the effect is reached, with its
 *   operation, tool, arguments (canonical JSON) and their hash, the schema a
 *   response must match, and the virtual time; then answered once, by the
 *   parent or a fixture: the response's kind (success, error, cancel), value,
 *   hash, disposition, operation id and actor. An answered row never
 *   changes; a repeat of the same response is idempotent and another is a
 *   conflict.
 *
 * Additive: two nullable columns, allowed only on test runs, and one new
 * table; no existing row changes.
 */
export function workflowV2TestRunsMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0102_workflow_v2_test_runs

ALTER TABLE ${s}.workflow_runs ADD COLUMN IF NOT EXISTS virtual_now TIMESTAMPTZ;
ALTER TABLE ${s}.workflow_runs ADD COLUMN IF NOT EXISTS test_fixtures TEXT;
ALTER TABLE ${s}.workflow_runs DROP CONSTRAINT IF EXISTS workflow_runs_test_clock;
ALTER TABLE ${s}.workflow_runs ADD CONSTRAINT workflow_runs_test_clock CHECK (
    mode = 'test' OR (virtual_now IS NULL AND test_fixtures IS NULL)
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
`;
}
