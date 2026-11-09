/**
 * Migration 0099 — workflow v2 durable recipient intake: the possible-exposure
 * record.
 *
 * Design docs/proposals/workflow-durable-intake.md (exposure protocol
 * revision 2; decision intake-exposure-r2-implementation). Every worker
 * registers orchestration 1.0.83 and its intake activities, but the durable
 * intake ships switched off (no worker sets the workflowIntake capability), so
 * no send creates an exchange that writes here; only tests do.
 *
 * - workflow_intake_exposures: at most one row per invocation (key, and a
 *   foreign key to workflow_intake_invocations that does not cascade),
 *   inserted by the first admission that lets an attempt include the
 *   invocation's items in a model request: its recipient, that attempt's id
 *   as the orchestration recorded it, and the store's clock. It means the
 *   items were possibly seen; never that a request was sent, nor that it
 *   completed. The admission, every end and every unsent cancel read it under
 *   the invocation's advisory lock (store.ts lockIntakeInvocation), which
 *   serializes them; only an admission holding that lock inserts it, and only
 *   when none exists. A guard trigger raises on every UPDATE, a no-op one
 *   included, and on every DELETE.
 *
 * Purely additive: one table and its guard trigger. The tables, triggers and
 * guards of 0098 are unchanged, and no existing row is touched. It has no
 * down step.
 */
export function workflowV2IntakeExposuresMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0099_workflow_v2_intake_exposures

CREATE TABLE IF NOT EXISTS ${s}.workflow_intake_exposures (
    invocation_id        TEXT PRIMARY KEY REFERENCES ${s}.workflow_intake_invocations (invocation_id),
    recipient_session_id TEXT NOT NULL,
    attempt_id           TEXT NOT NULL,
    exposed_at           TIMESTAMPTZ NOT NULL
);

-- An exposure is inserted once and is never changed or deleted.
CREATE OR REPLACE FUNCTION ${s}.workflow_v2_intake_exposure_guard() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'intake exposure %: an exposure is written once and is never changed or deleted', OLD.invocation_id;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_intake_exposures_guard ON ${s}.workflow_intake_exposures;
CREATE TRIGGER workflow_intake_exposures_guard BEFORE UPDATE OR DELETE ON ${s}.workflow_intake_exposures
    FOR EACH ROW EXECUTE FUNCTION ${s}.workflow_v2_intake_exposure_guard();
`;
}
