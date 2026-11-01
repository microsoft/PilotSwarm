/**
 * Migration 0090 — the acceptance receipt of a workflow v2 typed input.
 *
 * send_workflow_input returns a receipt when it accepts an input, and a
 * repeat of the same request returns that receipt again. The receipt is
 * stored with the input when it is accepted (canonical JSON), and never
 * rewritten: a receive state that takes the input later changes its
 * consumed_by and consumed_at, which read_workflow shows, not the receipt.
 *
 * Additive: inputs stored before this migration have no receipt.
 */
export function workflowV2InputReceiptMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0090_workflow_v2_input_receipt

ALTER TABLE ${s}.workflow_inbox ADD COLUMN IF NOT EXISTS receipt TEXT;
`;
}
