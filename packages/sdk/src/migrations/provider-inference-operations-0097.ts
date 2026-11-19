/**
 * Migration 0097: provider_inference_operations, the token ledger for inference outside a chat turn.
 *
 * A Workflow decision node calls a provider from a Workflow effect, not from a session turn, so it has no
 * (session_id, turn_index) to settle on. This table is the chat ledger's sibling, keyed by (operation_id, attempt):
 * the effect's operation identity and its entry count. A row is claimed before the provider call and settled once
 * after it. tokens_total is input + output, as on the chat ledger since 0070, and NULL while the usage is unknown.
 *
 * cms_provider_usage_totals adds the settled tokens; its turn and session counts stay the chat ledger's. The chat
 * ledger, its settle procedure and the budget meters are not changed.
 */
export function providerInferenceOperationsMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
CREATE TABLE IF NOT EXISTS ${s}.provider_inference_operations (
    operation_id       TEXT    NOT NULL,
    attempt            INTEGER NOT NULL CHECK (attempt >= 1),
    capability         TEXT    NOT NULL,
    purpose            TEXT    NOT NULL,
    session_id         TEXT,
    workflow_run_id    TEXT,
    node_execution_id  TEXT,
    provider_name      TEXT    NOT NULL,
    model_qualified    TEXT    NOT NULL,
    owner_user_id      BIGINT,
    charge_class       TEXT    NOT NULL CHECK (charge_class IN ('user','system','unattributed')),
    agent_id           TEXT,
    tokens_input       BIGINT,
    tokens_output      BIGINT,
    tokens_cache_read  BIGINT,
    tokens_cache_write BIGINT,
    tokens_total       BIGINT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at         TIMESTAMPTZ,
    PRIMARY KEY (operation_id, attempt),
    -- The cache counts are part of the input; adding them again double-counts (0070).
    CHECK (tokens_total IS NOT DISTINCT FROM tokens_input + tokens_output)
);

-- The claim, made before the provider call. Returns false when this attempt is already claimed.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_claim_inference_operation(
    p_operation_id TEXT, p_attempt INTEGER, p_capability TEXT, p_purpose TEXT,
    p_session_id TEXT, p_workflow_run_id TEXT, p_node_execution_id TEXT,
    p_provider TEXT, p_model TEXT, p_owner BIGINT, p_charge_class TEXT, p_agent_id TEXT
) RETURNS BOOLEAN AS $$
DECLARE v_first INTEGER;
BEGIN
    INSERT INTO ${s}.provider_inference_operations
        (operation_id, attempt, capability, purpose, session_id, workflow_run_id, node_execution_id,
         provider_name, model_qualified, owner_user_id, charge_class, agent_id)
    VALUES (p_operation_id, p_attempt, p_capability, p_purpose, p_session_id, p_workflow_run_id, p_node_execution_id,
            p_provider, p_model, p_owner, p_charge_class, p_agent_id)
    ON CONFLICT (operation_id, attempt) DO NOTHING;
    GET DIAGNOSTICS v_first = ROW_COUNT;
    RETURN v_first > 0;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- Settlement, once per claimed attempt. A NULL count is unknown, and an unknown input or output leaves the total NULL.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_settle_inference_operation(
    p_operation_id TEXT, p_attempt INTEGER,
    p_in BIGINT, p_out BIGINT, p_cache_read BIGINT, p_cache_write BIGINT
) RETURNS BOOLEAN AS $$
DECLARE v_first INTEGER;
BEGIN
    UPDATE ${s}.provider_inference_operations
       SET tokens_input = p_in, tokens_output = p_out,
           tokens_cache_read = p_cache_read, tokens_cache_write = p_cache_write,
           tokens_total = p_in + p_out, settled_at = now()
     WHERE operation_id = p_operation_id AND attempt = p_attempt AND settled_at IS NULL;
    GET DIAGNOSTICS v_first = ROW_COUNT;
    RETURN v_first > 0;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- 0061's totals plus settled inference tokens, each dated by its settlement as a chat ledger row is.
-- Turns and sessions count chat ledger rows only.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_totals(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_days INTEGER,
    p_owner BIGINT, p_provider TEXT, p_model TEXT, p_session TEXT, p_class TEXT
) RETURNS TABLE(tokens_total BIGINT, turns BIGINT, sessions BIGINT) AS $$
    SELECT COALESCE(sum(u.tokens_total), 0)::BIGINT,
           count(*) FILTER (WHERE u.is_turn),
           count(DISTINCT u.session_id) FILTER (WHERE u.is_turn)
      FROM (
        SELECT l.session_id, l.provider_name, l.model_qualified, l.owner_user_id, l.charge_class,
               l.tokens_total, l.created_at, TRUE AS is_turn
          FROM ${s}.provider_usage_ledger l
        UNION ALL
        SELECT o.session_id, o.provider_name, o.model_qualified, o.owner_user_id, o.charge_class,
               o.tokens_total, o.settled_at, FALSE
          FROM ${s}.provider_inference_operations o
         WHERE o.tokens_total IS NOT NULL
      ) u
     WHERE u.created_at >= now() - (COALESCE(p_days, 7) || ' days')::interval
       AND (COALESCE(p_is_admin, FALSE)
            OR u.owner_user_id IS NOT DISTINCT FROM p_viewer
            OR (p_provider IS NOT NULL AND p_owner IS NULL AND p_session IS NULL
                AND EXISTS (
                    SELECT 1 FROM ${s}.provider_instances pi
                     WHERE pi.name = p_provider AND pi.class = 'shared')))
       AND (p_owner IS NULL OR u.owner_user_id = p_owner)
       AND (p_provider IS NULL OR u.provider_name = p_provider)
       AND (p_provider IS NULL OR u.created_at >= COALESCE(
               (SELECT pi.created_at FROM ${s}.provider_instances pi WHERE pi.name = p_provider),
               '-infinity'::timestamptz))
       AND (p_model IS NULL OR u.model_qualified = p_model)
       AND (p_session IS NULL OR u.session_id = p_session)
       AND (p_class IS NULL OR u.charge_class = p_class);
$$ LANGUAGE sql STABLE;
`;
}
