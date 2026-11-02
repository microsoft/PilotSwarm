/**
 * Migration 0102 — workflow v2 invocation credentials (design 04: "scoped
 * service-issued invocation credentials with caller identity, audience,
 * session/run/node binding, expiry and revocation"; INACTIVE: only the
 * service's issue and verify calls, which no route uses yet, write or read
 * it).
 *
 * - workflow_invocation_credentials: one row per credential the host issued
 *   for one holder session to act on one pending workflow effect: answer a
 *   request (audience workflow.respond: the request's responder) or complete
 *   an agent state (audience workflow.complete: the state's child). It keeps
 *   only the SHA-256 of the opaque token (never the token, and there is no
 *   signing key), the binding (workflow, run, node execution, holder), when
 *   it was issued, when it expires (no later than the effect's deadline),
 *   and when and why it was revoked. One credential per binding is active:
 *   issuing another revokes the earlier one.
 *
 * Additive: one new table; no existing row changes.
 */
export function workflowV2InvocationCredentialsMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0102_workflow_v2_invocation_credentials

CREATE TABLE IF NOT EXISTS ${s}.workflow_invocation_credentials (
    credential_id        TEXT PRIMARY KEY,
    token_sha256         TEXT NOT NULL UNIQUE,
    audience             TEXT NOT NULL CHECK (audience IN ('workflow.respond', 'workflow.complete')),
    workflow_session_id  TEXT NOT NULL,
    run_id               TEXT NOT NULL REFERENCES ${s}.workflow_runs (run_id),
    node_execution_id    TEXT NOT NULL REFERENCES ${s}.workflow_node_executions (node_execution_id),
    holder_session_id    TEXT NOT NULL,
    issued_at            TIMESTAMPTZ NOT NULL,
    expires_at           TIMESTAMPTZ NOT NULL,
    revoked_at           TIMESTAMPTZ,
    revoked_reason       TEXT,
    last_used_at         TIMESTAMPTZ,
    CONSTRAINT workflow_invocation_credentials_expiry CHECK (expires_at > issued_at),
    CONSTRAINT workflow_invocation_credentials_revoked CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS workflow_invocation_credentials_active
    ON ${s}.workflow_invocation_credentials (audience, node_execution_id, holder_session_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS workflow_invocation_credentials_by_run ON ${s}.workflow_invocation_credentials (run_id);
`;
}
