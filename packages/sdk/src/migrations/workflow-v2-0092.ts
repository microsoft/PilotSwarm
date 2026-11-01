/**
 * Migration 0092 — workflow v2 send states to workflow recipients.
 *
 * - workflow_outbox.recipient_kind: what the admission decided the
 *   recipient is, under the session locks: 'agent' (its message goes to the
 *   session's message queue) or 'workflow' (typed input for one of the
 *   recipient workflow's receive states). Null on rows written before this
 *   migration, which were all for agent sessions.
 * - workflow_outbox.correlation: the canonical JSON correlation the send
 *   state resolved when it was entered (a workflow recipient's receive
 *   states match it). Null on rows written before this migration ({}).
 *
 * Additive: no existing row changes.
 */
export function workflowV2OutboxRecipientMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0092_workflow_v2_outbox_recipient

ALTER TABLE ${s}.workflow_outbox ADD COLUMN IF NOT EXISTS recipient_kind TEXT;
ALTER TABLE ${s}.workflow_outbox ADD COLUMN IF NOT EXISTS correlation TEXT;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workflow_outbox_recipient_kind'
                     AND conrelid = '${s}.workflow_outbox'::regclass) THEN
        ALTER TABLE ${s}.workflow_outbox
            ADD CONSTRAINT workflow_outbox_recipient_kind CHECK (recipient_kind IS NULL OR recipient_kind IN ('agent', 'workflow'));
    END IF;
END $$;
`;
}
