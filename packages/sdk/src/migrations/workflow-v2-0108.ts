/**
 * Migration 0108 — Workflow Simplified stage 2.3: package Workflow Definitions (spec "Packages and Agent Smith": P1–P7,
 * E2-7, D7, D8).
 *
 * A package ships Workflow Definitions as top-level entries (workflows/<name>/workflow.yaml with its interface card). A chat
 * that starts one has it attached: a chat definition named `<package>/<name>` (a chat's own names have no slash, D7) that is
 * locked (E2-7, P5): read-only for the person and the chat; a person makes an editable copy instead. Each attached package
 * version is a revision of it, recording the package (its id, version and content hash) and the card with its digest, so a
 * Workflow pins the package version and the card it started with (P5); a newer version is attached for the next Workflow
 * only (P6).
 *
 * - workflow_chat_definitions: `locked`, and `package_name` for a locked one.
 * - workflow_chat_revisions: `package_id`, `package_semver`, `package_sha256`, `card` (the card as the registry exported it)
 *   and `card_digest`; null on a chat's own revisions.
 * - sessions: `workflow_ref`, the `<package>/<name>` a coordinating chat was made for from the new-session picker (P2): the
 *   session list shows it with the Workflow badge. Null on every other session.
 */
export function workflowPackageDefinitionsMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0108_workflow_package_definitions

ALTER TABLE ${s}.workflow_chat_definitions ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE ${s}.workflow_chat_definitions ADD COLUMN IF NOT EXISTS package_name TEXT;

ALTER TABLE ${s}.workflow_chat_revisions ADD COLUMN IF NOT EXISTS package_id TEXT;
ALTER TABLE ${s}.workflow_chat_revisions ADD COLUMN IF NOT EXISTS package_semver TEXT;
ALTER TABLE ${s}.workflow_chat_revisions ADD COLUMN IF NOT EXISTS package_sha256 TEXT;
ALTER TABLE ${s}.workflow_chat_revisions ADD COLUMN IF NOT EXISTS card TEXT;
ALTER TABLE ${s}.workflow_chat_revisions ADD COLUMN IF NOT EXISTS card_digest TEXT;

ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS workflow_ref TEXT;
`;
}
