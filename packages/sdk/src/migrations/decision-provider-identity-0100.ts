/**
 * Migration 0100: pin the CMS provider incarnation used by a Workflow Decision.
 *
 * Public model references remain provider:model strings. The private UUID ties
 * Start, budget admission, credential resolution, the inference claim and meter
 * settlement to the same provider row without trusting a reusable name.
 */
export function decisionProviderIdentityMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
ALTER TABLE ${s}.provider_instances
    ADD COLUMN IF NOT EXISTS provider_instance_id UUID DEFAULT gen_random_uuid();
UPDATE ${s}.provider_instances
   SET provider_instance_id = gen_random_uuid()
 WHERE provider_instance_id IS NULL;
ALTER TABLE ${s}.provider_instances
    ALTER COLUMN provider_instance_id SET DEFAULT gen_random_uuid(),
    ALTER COLUMN provider_instance_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS provider_instances_instance_id
    ON ${s}.provider_instances (provider_instance_id);

ALTER TABLE ${s}.workflow_runs
    ADD COLUMN IF NOT EXISTS decision_provider_bindings TEXT;

ALTER TABLE ${s}.provider_inference_operations
    ADD COLUMN IF NOT EXISTS provider_instance_id UUID,
    ADD COLUMN IF NOT EXISTS provider_type_id TEXT,
    ADD COLUMN IF NOT EXISTS provider_class TEXT,
    ADD COLUMN IF NOT EXISTS provider_owner_user_id BIGINT;

-- Decision admission is non-mutating: a provider call must not stamp or clear
-- the Workflow session's chat model/pause projection. It applies the existing
-- shared-provider budget rules while returning one immutable provider identity.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_check_decision(
    p_session_id TEXT, p_model TEXT, p_provider_instance_id UUID
) RETURNS TABLE(
    verdict TEXT,
    provider_instance_id UUID,
    provider_name TEXT,
    provider_type_id TEXT,
    provider_class TEXT,
    provider_owner_user_id BIGINT,
    provider_updated_at TEXT,
    owner_user_id BIGINT,
    model_qualified TEXT,
    exempt BOOLEAN,
    pause JSONB,
    rules JSONB
) AS $$
DECLARE
    v_sess RECORD;
    v_owner BIGINT;
    v_ref TEXT;
    v_split RECORD;
    v_inst RECORD;
    v_rule RECORD;
    v_bounds RECORD;
    v_scope TEXT;
    v_used BIGINT;
    v_you BIGINT;
    v_ceiling BIGINT;
    v_rules JSONB := '[]'::jsonb;
    v_block JSONB := NULL;
    v_kind TEXT := NULL;
    v_reset TIMESTAMPTZ := NULL;
    v_pause JSONB := NULL;
BEGIN
    SELECT ss.is_system INTO v_sess
      FROM ${s}.sessions ss
     WHERE ss.session_id = p_session_id;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'no_provider'::TEXT, NULL::UUID, NULL::TEXT, NULL::TEXT,
            NULL::TEXT, NULL::BIGINT, NULL::TEXT, NULL::BIGINT, NULL::TEXT, FALSE,
            jsonb_build_object('kind', 'no_provider', 'modelRef', p_model), '[]'::jsonb;
        RETURN;
    END IF;

    SELECT so.user_id INTO v_owner
      FROM ${s}.session_owners so
     WHERE so.session_id = p_session_id;

    v_ref := NULLIF(BTRIM(COALESCE(p_model, '')), '');
    SELECT * INTO v_split FROM ${s}.cms_provider_split_ref(v_ref);
    IF p_provider_instance_id IS NULL THEN
        -- Compatibility for runs admitted before 0100: pin the first current
        -- shared incarnation here, never a personal same-name provider.
        SELECT * INTO v_inst FROM ${s}.provider_instances pi
         WHERE pi.name = v_split.provider_name AND pi.class = 'shared';
    ELSE
        SELECT * INTO v_inst FROM ${s}.provider_instances pi
         WHERE pi.provider_instance_id = p_provider_instance_id
           AND pi.name = v_split.provider_name
           AND pi.class = 'shared';
    END IF;

    IF v_inst.name IS NULL THEN
        v_pause := jsonb_build_object('kind', 'no_provider', 'provider', v_split.provider_name, 'modelRef', v_ref);
        RETURN QUERY SELECT 'no_provider'::TEXT, NULL::UUID, v_split.provider_name,
            NULL::TEXT, NULL::TEXT, NULL::BIGINT, NULL::TEXT, v_owner, v_ref, FALSE,
            v_pause, '[]'::jsonb;
        RETURN;
    END IF;

    IF COALESCE(v_sess.is_system, FALSE) THEN
        RETURN QUERY SELECT 'clear'::TEXT, v_inst.provider_instance_id, v_inst.name,
            v_inst.type_id, v_inst.class, v_inst.owner_user_id, to_jsonb(v_inst)->>'updated_at', v_owner, v_ref,
            TRUE, NULL::JSONB, '[]'::jsonb;
        RETURN;
    END IF;

    IF COALESCE(v_inst.hold_indefinite, FALSE)
       OR (v_inst.hold_until_utc IS NOT NULL AND v_inst.hold_until_utc > now()) THEN
        v_pause := jsonb_build_object(
            'kind', 'hold',
            'provider', v_inst.name,
            'resetsAtUtc', CASE WHEN COALESCE(v_inst.hold_indefinite, FALSE)
                               THEN NULL ELSE to_char(v_inst.hold_until_utc AT TIME ZONE 'UTC',
                                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END);
        RETURN QUERY SELECT 'paused'::TEXT, v_inst.provider_instance_id, v_inst.name,
            v_inst.type_id, v_inst.class, v_inst.owner_user_id, to_jsonb(v_inst)->>'updated_at', v_owner, v_ref,
            FALSE, v_pause, '[]'::jsonb;
        RETURN;
    END IF;

    FOR v_rule IN
        SELECT r.* FROM ${s}.provider_budget_rules r
         WHERE r.provider_name = v_inst.name
           AND (r.model_qualified IS NULL OR r.model_qualified = v_ref)
    LOOP
        SELECT * INTO v_bounds FROM ${s}.cms_provider_window_bounds(v_rule.period, now());
        v_scope := COALESCE(v_rule.model_qualified, '*');

        SELECT COALESCE(m.used_tokens, 0) INTO v_used
          FROM ${s}.provider_meters m
         WHERE m.provider_name = v_inst.name AND m.period = v_rule.period
           AND m.scope = v_scope AND m.window_key_utc = v_bounds.window_key;
        v_used := COALESCE(v_used, 0);

        v_ceiling := NULL;
        v_you := NULL;
        IF v_inst.allowance_pct < 100 AND v_owner IS NOT NULL THEN
            v_ceiling := ${s}.cms_provider_ceiling(v_rule.limit_tokens, v_inst.allowance_pct);
            SELECT COALESCE(mu.used_tokens, 0) INTO v_you
              FROM ${s}.provider_meters_user mu
             WHERE mu.provider_name = v_inst.name AND mu.period = v_rule.period
               AND mu.scope = v_scope AND mu.window_key_utc = v_bounds.window_key
               AND mu.user_id = v_owner;
            v_you := COALESCE(v_you, 0);
        END IF;

        v_rules := v_rules || jsonb_build_object(
            'ruleId', v_rule.rule_id,
            'providerName', v_inst.name,
            'period', v_rule.period,
            'modelQualified', v_rule.model_qualified,
            'limitTokens', v_rule.limit_tokens,
            'usedTokens', v_used,
            'ceilingTokens', v_ceiling,
            'yourUsedTokens', v_you,
            'windowStartUtc', to_char(v_bounds.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'resetsAtUtc', to_char(v_bounds.resets_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));

        IF v_used >= v_rule.limit_tokens THEN
            IF v_kind IS DISTINCT FROM 'limit' THEN
                v_kind := 'limit';
                v_block := jsonb_build_object('ruleId', v_rule.rule_id, 'period', v_rule.period,
                    'modelQualified', v_rule.model_qualified, 'limitTokens', v_rule.limit_tokens, 'usedTokens', v_used);
            END IF;
            IF v_reset IS NULL OR v_bounds.resets_at > v_reset THEN v_reset := v_bounds.resets_at; END IF;
        ELSIF v_ceiling IS NOT NULL AND v_you >= v_ceiling THEN
            IF v_kind IS NULL THEN
                v_kind := 'allowance';
                v_block := jsonb_build_object('ruleId', v_rule.rule_id, 'period', v_rule.period,
                    'modelQualified', v_rule.model_qualified, 'limitTokens', v_rule.limit_tokens,
                    'ceilingTokens', v_ceiling, 'yourUsedTokens', v_you);
            END IF;
            IF v_reset IS NULL OR v_bounds.resets_at > v_reset THEN v_reset := v_bounds.resets_at; END IF;
        END IF;
    END LOOP;

    IF v_kind IS NOT NULL THEN
        v_pause := v_block || jsonb_build_object(
            'kind', v_kind,
            'provider', v_inst.name,
            'resetsAtUtc', to_char(v_reset AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
        RETURN QUERY SELECT 'paused'::TEXT, v_inst.provider_instance_id, v_inst.name,
            v_inst.type_id, v_inst.class, v_inst.owner_user_id, to_jsonb(v_inst)->>'updated_at', v_owner, v_ref,
            FALSE, v_pause, v_rules;
        RETURN;
    END IF;

    RETURN QUERY SELECT 'clear'::TEXT, v_inst.provider_instance_id, v_inst.name,
        v_inst.type_id, v_inst.class, v_inst.owner_user_id, to_jsonb(v_inst)->>'updated_at', v_owner, v_ref,
        FALSE, NULL::JSONB, v_rules;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- A claim snapshots the live provider row. A Decision caller names the pinned
-- UUID; other inference callers may omit it and linearize to the current row.
DROP FUNCTION IF EXISTS ${s}.cms_provider_claim_inference_operation(
    TEXT, INTEGER, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, BIGINT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION ${s}.cms_provider_claim_inference_operation(
    p_operation_id TEXT, p_attempt INTEGER, p_capability TEXT, p_purpose TEXT,
    p_session_id TEXT, p_workflow_run_id TEXT, p_node_execution_id TEXT,
    p_provider TEXT, p_model TEXT, p_owner BIGINT, p_charge_class TEXT,
    p_agent_id TEXT, p_provider_instance_id UUID, p_provider_updated_at TEXT
) RETURNS BOOLEAN AS $$
DECLARE
    v_inst RECORD;
    v_first INTEGER;
BEGIN
    IF p_provider_instance_id IS NULL THEN
        SELECT pi.* INTO v_inst FROM ${s}.provider_instances pi
         WHERE pi.name = p_provider
         FOR KEY SHARE;
    ELSE
        SELECT pi.* INTO v_inst FROM ${s}.provider_instances pi
         WHERE pi.provider_instance_id = p_provider_instance_id
           AND pi.name = p_provider
           AND (p_provider_updated_at IS NULL OR to_jsonb(pi)->>'updated_at' = p_provider_updated_at)
         FOR KEY SHARE;
    END IF;
    IF NOT FOUND AND p_provider_instance_id IS NOT NULL THEN RETURN FALSE; END IF;

    INSERT INTO ${s}.provider_inference_operations
        (operation_id, attempt, capability, purpose, session_id, workflow_run_id, node_execution_id,
         provider_name, model_qualified, owner_user_id, charge_class, agent_id,
         provider_instance_id, provider_type_id, provider_class, provider_owner_user_id)
    VALUES (p_operation_id, p_attempt, p_capability, p_purpose, p_session_id, p_workflow_run_id, p_node_execution_id,
            p_provider, p_model, p_owner, p_charge_class, p_agent_id,
            v_inst.provider_instance_id, v_inst.type_id, v_inst.class, v_inst.owner_user_id)
    ON CONFLICT (operation_id, attempt) DO NOTHING;
    GET DIAGNOSTICS v_first = ROW_COUNT;
    RETURN v_first > 0;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- Settlement uses the identity copied at claim time. Historical usage remains
-- on that row, but a same-name replacement never receives old live meters.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_settle_inference_operation(
    p_operation_id TEXT, p_attempt INTEGER,
    p_in BIGINT, p_out BIGINT, p_cache_read BIGINT, p_cache_write BIGINT
) RETURNS BOOLEAN AS $$
DECLARE
    v_provider TEXT;
    v_provider_instance_id UUID;
    v_provider_type_id TEXT;
    v_provider_class TEXT;
    v_provider_owner_user_id BIGINT;
    v_model TEXT;
    v_owner BIGINT;
    v_class TEXT;
    v_total BIGINT;
    v_settled_at TIMESTAMPTZ;
    v_scope TEXT;
    v_first INTEGER;
BEGIN
    UPDATE ${s}.provider_inference_operations
       SET tokens_input = p_in, tokens_output = p_out,
           tokens_cache_read = p_cache_read, tokens_cache_write = p_cache_write,
           tokens_total = p_in + p_out, settled_at = now()
     WHERE operation_id = p_operation_id AND attempt = p_attempt AND settled_at IS NULL
    RETURNING provider_name, provider_instance_id, provider_type_id, provider_class,
              provider_owner_user_id, model_qualified, owner_user_id, charge_class,
              tokens_total, settled_at
         INTO v_provider, v_provider_instance_id, v_provider_type_id, v_provider_class,
              v_provider_owner_user_id, v_model, v_owner, v_class, v_total, v_settled_at;
    GET DIAGNOSTICS v_first = ROW_COUNT;
    IF v_first = 0 THEN RETURN FALSE; END IF;

    IF v_total IS NULL OR v_total <= 0 OR v_class <> 'user'
       OR NULLIF(BTRIM(v_provider), '') IS NULL OR v_provider_instance_id IS NULL THEN
        RETURN TRUE;
    END IF;

    PERFORM 1 FROM ${s}.provider_instances pi
     WHERE pi.provider_instance_id = v_provider_instance_id
       AND pi.name = v_provider
       AND pi.type_id = v_provider_type_id
       AND pi.class = v_provider_class
       AND pi.owner_user_id IS NOT DISTINCT FROM v_provider_owner_user_id
       FOR KEY SHARE;
    IF NOT FOUND THEN RETURN TRUE; END IF;

    v_scope := COALESCE(NULLIF(BTRIM(v_model), ''), '*');
    INSERT INTO ${s}.provider_meters
        (provider_name, period, scope, window_key_utc, used_tokens, window_start_utc, resets_at_utc)
    SELECT v_provider, per.period, sc.scope, wb.window_key, v_total, wb.window_start, wb.resets_at
      FROM (VALUES ('day'),('week'),('month')) AS per(period)
      CROSS JOIN LATERAL ${s}.cms_provider_window_bounds(per.period, v_settled_at) wb
      CROSS JOIN (SELECT DISTINCT v.s FROM (VALUES ('*'), (v_scope)) AS v(s)) AS sc(scope)
     ORDER BY per.period, sc.scope
    ON CONFLICT (provider_name, period, scope, window_key_utc) DO UPDATE
        SET used_tokens = ${s}.provider_meters.used_tokens + EXCLUDED.used_tokens,
            updated_at = v_settled_at;

    IF v_owner IS NOT NULL THEN
        INSERT INTO ${s}.provider_meters_user
            (provider_name, period, scope, window_key_utc, user_id, used_tokens, window_start_utc, resets_at_utc)
        SELECT v_provider, per.period, sc.scope, wb.window_key, v_owner, v_total, wb.window_start, wb.resets_at
          FROM (VALUES ('day'),('week'),('month')) AS per(period)
          CROSS JOIN LATERAL ${s}.cms_provider_window_bounds(per.period, v_settled_at) wb
          CROSS JOIN (SELECT DISTINCT v.s FROM (VALUES ('*'), (v_scope)) AS v(s)) AS sc(scope)
         ORDER BY per.period, sc.scope
        ON CONFLICT (provider_name, period, scope, window_key_utc, user_id) DO UPDATE
            SET used_tokens = ${s}.provider_meters_user.used_tokens + EXCLUDED.used_tokens,
                updated_at = v_settled_at;
    END IF;

    RETURN TRUE;
END;
$$ LANGUAGE plpgsql VOLATILE;
`;
}
