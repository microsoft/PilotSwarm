/**
 * Migration 0094 — workflow v2 durable recipient intake: storage only.
 *
 * Nothing writes these yet (design docs/proposals/workflow-durable-intake.md,
 * revision 3 with amendment 2, sections 4 and 5.1; decision
 * intake-inactive-implementation): no sender decides a durable mode, no
 * registered orchestration claims an exchange, and only tests call the
 * store's intake methods. Every existing statement runs as before.
 *
 * - workflow_outbox gains four nullable columns with no default:
 *   intake_mode ('durable' or 'legacy_window'; unset reads as
 *   legacy_window), attempt_token, intake_outcome ('refused_full' or
 *   'refused_size', set at most once and only on a durable exchange) and
 *   intake_outcome_at. Existing rows keep null in all four, and the existing
 *   insert and attempt count name none of them.
 * - The intake fence (design section 4), a BEFORE UPDATE trigger on
 *   workflow_outbox, raises when the mode changes other than from unset on
 *   the update that takes attempts from 0 to 1; when the mode becomes
 *   durable without a new non-null attempt token in the same update; or
 *   when attempts grows on a durable row while the token stays the same. So
 *   a row first counted with no mode stays legacy, a later promotion fails,
 *   and a count that keeps the token (an older build's) fails on a durable
 *   row. An update that changes neither the mode nor the attempts passes.
 * - workflow_intake: one row per exchange claimed by its recipient (key: the
 *   exchange id; foreign key to the outbox). The claim that inserts it writes
 *   its identity and canonical text once; its state moves only from holding
 *   to one final state; an admitted row names its invocation, and its
 *   processing moves only from bound to one final value; the cancel flag only
 *   becomes true; the counters only grow. A guard trigger enforces these, and
 *   no row is deleted.
 *
 * Not purely additive: it adds the fence trigger to the existing
 * workflow_outbox (it changes no row, and no current statement changes the
 * mode or counts a durable row) and two CHECK constraints on the new columns,
 * which every existing row (all null) satisfies. Otherwise it adds nullable
 * columns, one table, its indexes and its guard trigger. It has no down step:
 * removing the fence needs a separately authorized change (design section 4,
 * Rollback).
 */
export function workflowV2IntakeMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0094_workflow_v2_intake

ALTER TABLE ${s}.workflow_outbox ADD COLUMN IF NOT EXISTS intake_mode TEXT;
ALTER TABLE ${s}.workflow_outbox ADD COLUMN IF NOT EXISTS attempt_token TEXT;
ALTER TABLE ${s}.workflow_outbox ADD COLUMN IF NOT EXISTS intake_outcome TEXT;
ALTER TABLE ${s}.workflow_outbox ADD COLUMN IF NOT EXISTS intake_outcome_at TIMESTAMPTZ;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_outbox_intake_mode'
                     AND conrelid = '${s}.workflow_outbox'::regclass) THEN
        ALTER TABLE ${s}.workflow_outbox
            ADD CONSTRAINT workflow_outbox_intake_mode CHECK (intake_mode IS NULL OR intake_mode IN ('durable', 'legacy_window'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_outbox_intake_outcome'
                     AND conrelid = '${s}.workflow_outbox'::regclass) THEN
        ALTER TABLE ${s}.workflow_outbox
            ADD CONSTRAINT workflow_outbox_intake_outcome CHECK (
                (intake_outcome IS NULL AND intake_outcome_at IS NULL)
                OR (intake_outcome IN ('refused_full', 'refused_size') AND intake_outcome_at IS NOT NULL AND intake_mode = 'durable'));
    END IF;
END $$;

-- The intake fence: only the first counted attempt decides the mode, and a durable row is counted only with a new token.
CREATE OR REPLACE FUNCTION ${s}.workflow_v2_outbox_intake_fence() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.intake_mode IS DISTINCT FROM OLD.intake_mode
       AND NOT (OLD.intake_mode IS NULL AND OLD.attempts = 0 AND NEW.attempts = 1) THEN
        RAISE EXCEPTION 'workflow_outbox %: only the count of its first attempt decides its intake mode (% to %, attempts % to %)',
            OLD.exchange_id, coalesce(OLD.intake_mode, 'unset'), coalesce(NEW.intake_mode, 'unset'), OLD.attempts, NEW.attempts;
    END IF;
    IF NEW.intake_mode = 'durable' AND OLD.intake_mode IS DISTINCT FROM 'durable'
       AND (NEW.attempt_token IS NULL OR NEW.attempt_token IS NOT DISTINCT FROM OLD.attempt_token) THEN
        RAISE EXCEPTION 'workflow_outbox %: the durable intake mode needs a new attempt token', OLD.exchange_id;
    END IF;
    IF OLD.intake_mode = 'durable' AND NEW.attempts > OLD.attempts
       AND (NEW.attempt_token IS NULL OR NEW.attempt_token IS NOT DISTINCT FROM OLD.attempt_token) THEN
        RAISE EXCEPTION 'workflow_outbox %: an attempt of a durable exchange needs a new attempt token', OLD.exchange_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_outbox_intake_fence ON ${s}.workflow_outbox;
CREATE TRIGGER workflow_outbox_intake_fence BEFORE UPDATE ON ${s}.workflow_outbox
    FOR EACH ROW EXECUTE FUNCTION ${s}.workflow_v2_outbox_intake_fence();

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
    invocation_id        TEXT,
    processing           TEXT,
    cancel_requested     BOOLEAN NOT NULL DEFAULT false,
    duplicates           INTEGER NOT NULL DEFAULT 0,
    conflicts            INTEGER NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL,
    updated_at           TIMESTAMPTZ NOT NULL,
    admitted_at          TIMESTAMPTZ,
    settled_at           TIMESTAMPTZ,
    reason               TEXT,
    CONSTRAINT workflow_intake_state CHECK (state IN ('holding', 'admitted', 'cancelled', 'refused_full', 'refused_size')),
    CONSTRAINT workflow_intake_processing
        CHECK (processing IS NULL OR processing IN ('bound', 'completed', 'not_dispatched', 'interrupted', 'failed_indeterminate')),
    CONSTRAINT workflow_intake_invocation CHECK ((state = 'admitted') = (invocation_id IS NOT NULL)),
    CONSTRAINT workflow_intake_processed CHECK ((state = 'admitted') = (processing IS NOT NULL)),
    CONSTRAINT workflow_intake_admitted CHECK ((state = 'admitted') = (admitted_at IS NOT NULL)),
    CONSTRAINT workflow_intake_text CHECK (text IS NOT NULL OR state IN ('refused_full', 'refused_size')),
    CONSTRAINT workflow_intake_settled CHECK ((settled_at IS NOT NULL)
        = (state IN ('cancelled', 'refused_full', 'refused_size') OR (state = 'admitted' AND processing IS NOT NULL AND processing <> 'bound'))),
    CONSTRAINT workflow_intake_counters CHECK (duplicates >= 0 AND conflicts >= 0)
);
CREATE INDEX IF NOT EXISTS workflow_intake_by_recipient ON ${s}.workflow_intake (recipient_session_id, created_at);
CREATE INDEX IF NOT EXISTS workflow_intake_by_invocation ON ${s}.workflow_intake (invocation_id) WHERE invocation_id IS NOT NULL;

-- An intake row keeps its identity and text; its state and processing move forward once; nothing goes back; none is deleted.
CREATE OR REPLACE FUNCTION ${s}.workflow_v2_intake_guard() RETURNS TRIGGER AS $$
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
    IF NEW.state IS DISTINCT FROM OLD.state AND OLD.state <> 'holding' THEN
        RAISE EXCEPTION 'intake row %: state % is final', OLD.exchange_id, OLD.state;
    END IF;
    IF NEW.invocation_id IS DISTINCT FROM OLD.invocation_id AND OLD.invocation_id IS NOT NULL THEN
        RAISE EXCEPTION 'intake row %: it stays bound to invocation %', OLD.exchange_id, OLD.invocation_id;
    END IF;
    IF NEW.processing IS DISTINCT FROM OLD.processing
       AND NOT ((OLD.processing IS NULL AND NEW.processing = 'bound')
                OR (OLD.processing = 'bound' AND NEW.processing IS NOT NULL AND NEW.processing <> 'bound')) THEN
        RAISE EXCEPTION 'intake row %: processing % cannot become %', OLD.exchange_id, coalesce(OLD.processing, 'unset'), coalesce(NEW.processing, 'unset');
    END IF;
    IF (OLD.cancel_requested AND NOT NEW.cancel_requested) OR NEW.duplicates < OLD.duplicates OR NEW.conflicts < OLD.conflicts THEN
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
    FOR EACH ROW EXECUTE FUNCTION ${s}.workflow_v2_intake_guard();
`;
}
