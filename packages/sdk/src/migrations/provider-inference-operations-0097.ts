/**
 * Migration 0097: provider_inference_operations, the token ledger for inference outside a chat turn.
 *
 * A Workflow decision node calls a provider from a Workflow effect, not from a session turn, so it has no
 * (session_id, turn_index) to settle on. This table is the chat ledger's sibling, keyed by (operation_id, attempt):
 * the effect's operation identity and its entry count. A row is claimed before the provider call and settled once
 * after it. tokens_total is input + output, as on the chat ledger since 0070, and NULL while the usage is unknown.
 *
 * The first settlement also advances the provider and per-owner budget meters. cms_provider_usage_totals,
 * cms_provider_usage_daily and cms_provider_usage_breakdown add the settled tokens; their turn counts stay chat-only.
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
DECLARE
    v_provider TEXT;
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
    RETURNING provider_name, model_qualified, owner_user_id, charge_class, tokens_total, settled_at
         INTO v_provider, v_model, v_owner, v_class, v_total, v_settled_at;
    GET DIAGNOSTICS v_first = ROW_COUNT;
    IF v_first = 0 THEN RETURN FALSE; END IF;

    -- A meter is the live user-charge cache. Unknown usage, machinery,
    -- unattributed calls, calls with no live provider, and zero totals remain
    -- in the ledger without changing a budget.
    IF v_total IS NULL OR v_total <= 0 OR v_class <> 'user'
       OR NULLIF(BTRIM(v_provider), '') IS NULL THEN
        RETURN TRUE;
    END IF;

    PERFORM 1 FROM ${s}.provider_instances pi
     WHERE pi.name = v_provider FOR KEY SHARE;
    IF NOT FOUND THEN RETURN TRUE; END IF;

    v_scope := COALESCE(NULLIF(BTRIM(v_model), ''), '*');

    -- Fixed ordering prevents two multi-row upserts on one provider from
    -- taking the same meter keys in different orders (0070).
    INSERT INTO ${s}.provider_meters
        (provider_name, period, scope, window_key_utc, used_tokens,
         window_start_utc, resets_at_utc)
    SELECT v_provider, per.period, sc.scope, wb.window_key, v_total,
           wb.window_start, wb.resets_at
      FROM (VALUES ('day'),('week'),('month')) AS per(period)
      CROSS JOIN LATERAL ${s}.cms_provider_window_bounds(per.period, v_settled_at) wb
      CROSS JOIN (SELECT DISTINCT v.s FROM (VALUES ('*'), (v_scope)) AS v(s)) AS sc(scope)
     ORDER BY per.period, sc.scope
    ON CONFLICT (provider_name, period, scope, window_key_utc) DO UPDATE
        SET used_tokens = ${s}.provider_meters.used_tokens + EXCLUDED.used_tokens,
            updated_at = v_settled_at;

    IF v_owner IS NOT NULL THEN
        INSERT INTO ${s}.provider_meters_user
            (provider_name, period, scope, window_key_utc, user_id, used_tokens,
             window_start_utc, resets_at_utc)
        SELECT v_provider, per.period, sc.scope, wb.window_key, v_owner, v_total,
               wb.window_start, wb.resets_at
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

-- 0069's daily series plus the same settled inference union. Turns remain chat-only.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_daily(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_days INTEGER,
    p_owner BIGINT, p_provider TEXT, p_model TEXT, p_session TEXT, p_class TEXT
) RETURNS TABLE(
    day_utc DATE, tokens_total BIGINT, turns BIGINT,
    tokens_input BIGINT, tokens_output BIGINT, tokens_cache_read BIGINT, tokens_cache_write BIGINT
) AS $$
    WITH usage AS (
        SELECT l.session_id, l.provider_name, l.model_qualified, l.owner_user_id, l.charge_class,
               l.tokens_input, l.tokens_output, l.tokens_cache_read, l.tokens_cache_write,
               l.tokens_total, l.created_at, TRUE AS is_turn
          FROM ${s}.provider_usage_ledger l
        UNION ALL
        SELECT o.session_id, o.provider_name, o.model_qualified, o.owner_user_id, o.charge_class,
               o.tokens_input, o.tokens_output, o.tokens_cache_read, o.tokens_cache_write,
               o.tokens_total, o.settled_at, FALSE AS is_turn
          FROM ${s}.provider_inference_operations o
         WHERE o.tokens_total IS NOT NULL
    )
    SELECT (u.created_at AT TIME ZONE 'UTC')::date,
           COALESCE(sum(u.tokens_total), 0)::BIGINT,
           count(*) FILTER (WHERE u.is_turn),
           COALESCE(sum(u.tokens_input), 0)::BIGINT,
           COALESCE(sum(u.tokens_output), 0)::BIGINT,
           COALESCE(sum(u.tokens_cache_read), 0)::BIGINT,
           COALESCE(sum(u.tokens_cache_write), 0)::BIGINT
      FROM usage u
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
       AND (p_class IS NULL OR u.charge_class = p_class)
     GROUP BY 1 ORDER BY 1;
$$ LANGUAGE sql STABLE;

-- 0061's private, attributed breakdown plus settled inference tokens. Its turn count remains chat-only.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_breakdown(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_days INTEGER,
    p_owner BIGINT, p_provider TEXT, p_model TEXT, p_session TEXT, p_class TEXT,
    p_dim TEXT, p_limit INTEGER
) RETURNS TABLE(key TEXT, label TEXT, tokens_total BIGINT, turns BIGINT) AS $$
    WITH usage AS (
        SELECT l.session_id, l.provider_name, l.model_qualified, l.owner_user_id, l.charge_class,
               l.agent_id, l.tokens_total, l.created_at, TRUE AS is_turn
          FROM ${s}.provider_usage_ledger l
        UNION ALL
        SELECT o.session_id, o.provider_name, o.model_qualified, o.owner_user_id, o.charge_class,
               o.agent_id, o.tokens_total, o.settled_at, FALSE AS is_turn
          FROM ${s}.provider_inference_operations o
         WHERE o.tokens_total IS NOT NULL
    ), rows AS (
        SELECT u.*,
               CASE p_dim
                   WHEN 'session'  THEN u.session_id
                   WHEN 'provider' THEN COALESCE(u.provider_name, '(none)')
                   WHEN 'model'    THEN COALESCE(u.model_qualified, '(none)')
                   WHEN 'agent'    THEN COALESCE(u.agent_id, '(none)')
                   WHEN 'user'     THEN COALESCE(u.owner_user_id::TEXT,
                                          CASE WHEN u.charge_class = 'system'
                                               THEN '(system)' ELSE '(unowned)' END)
                   ELSE COALESCE(u.provider_name, '(none)')
               END AS dim_key
          FROM usage u
         WHERE u.created_at >= now() - (COALESCE(p_days, 7) || ' days')::interval
           AND (COALESCE(p_is_admin, FALSE) OR u.owner_user_id IS NOT DISTINCT FROM p_viewer)
           AND (p_owner IS NULL OR u.owner_user_id = p_owner)
           AND (p_provider IS NULL OR u.provider_name = p_provider)
           AND (p_provider IS NULL OR u.created_at >= COALESCE(
                   (SELECT pi.created_at FROM ${s}.provider_instances pi WHERE pi.name = p_provider),
                   '-infinity'::timestamptz))
           AND (p_model IS NULL OR u.model_qualified = p_model)
           AND (p_session IS NULL OR u.session_id = p_session)
           AND (p_class IS NULL OR u.charge_class = p_class)
    )
    SELECT g.dim_key,
           CASE p_dim
               WHEN 'session' THEN COALESCE((SELECT ss.title FROM ${s}.sessions ss
                                              WHERE ss.session_id = g.dim_key), g.dim_key)
               WHEN 'user'    THEN COALESCE((SELECT COALESCE(uu.display_name, uu.email, uu.subject)
                                               FROM ${s}.users uu
                                              WHERE uu.user_id::TEXT = g.dim_key), g.dim_key)
               ELSE g.dim_key
           END,
           sum(g.tokens_total)::BIGINT,
           count(*) FILTER (WHERE g.is_turn)
      FROM rows g
     GROUP BY g.dim_key
     ORDER BY 3 DESC
     LIMIT COALESCE(p_limit, 40);
$$ LANGUAGE sql STABLE;

-- The cluster-scoped breakdown keeps its 0075 privacy folds while using the same settled inference rows.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_breakdown_cluster(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_days INTEGER,
    p_owner BIGINT, p_provider TEXT, p_model TEXT, p_session TEXT, p_class TEXT,
    p_dim TEXT, p_limit INTEGER
) RETURNS TABLE(key TEXT, label TEXT, tokens_total BIGINT, turns BIGINT) AS $$
    WITH visible_sessions AS MATERIALIZED (
        SELECT ss.session_id FROM ${s}.sessions ss
         WHERE p_dim = 'session' AND ${s}.cms_session_content_visible(ss.session_id, p_viewer, TRUE)
    ), usage AS (
        SELECT l.session_id, l.provider_name, l.model_qualified, l.owner_user_id, l.charge_class,
               l.agent_id, l.tokens_total, l.created_at, TRUE AS is_turn
          FROM ${s}.provider_usage_ledger l
        UNION ALL
        SELECT o.session_id, o.provider_name, o.model_qualified, o.owner_user_id, o.charge_class,
               o.agent_id, o.tokens_total, o.settled_at, FALSE AS is_turn
          FROM ${s}.provider_inference_operations o
         WHERE o.tokens_total IS NOT NULL
    ), rows AS (
        SELECT u.*,
               CASE p_dim
                   WHEN 'session'  THEN CASE WHEN visible.session_id IS NOT NULL
                                            THEN u.session_id ELSE '(private sessions)' END
                   WHEN 'provider' THEN COALESCE(u.provider_name, '(none)')
                   WHEN 'model'    THEN COALESCE(u.model_qualified, '(none)')
                   WHEN 'agent'    THEN CASE WHEN u.owner_user_id = p_viewer OR u.charge_class = 'system'
                                            THEN COALESCE(u.agent_id, '(none)') ELSE '(other users agents)' END
                   WHEN 'user'     THEN COALESCE(u.owner_user_id::TEXT,
                                          CASE WHEN u.charge_class = 'system'
                                               THEN '(system)' ELSE '(unowned)' END)
                   ELSE COALESCE(u.provider_name, '(none)')
               END AS dim_key
          FROM usage u
          LEFT JOIN visible_sessions visible ON visible.session_id = u.session_id
         WHERE u.created_at >= now() - (COALESCE(p_days, 7) || ' days')::interval
           AND (COALESCE(p_is_admin, FALSE) OR u.owner_user_id IS NOT DISTINCT FROM p_viewer)
           AND (p_owner IS NULL OR u.owner_user_id = p_owner)
           AND (p_provider IS NULL OR u.provider_name = p_provider)
           AND (p_provider IS NULL OR u.created_at >= COALESCE(
                   (SELECT pi.created_at FROM ${s}.provider_instances pi WHERE pi.name = p_provider),
                   '-infinity'::timestamptz))
           AND (p_model IS NULL OR u.model_qualified = p_model)
           AND (p_session IS NULL OR u.session_id = p_session)
           AND (p_class IS NULL OR u.charge_class = p_class)
    )
    SELECT g.dim_key,
           CASE p_dim
               WHEN 'session' THEN COALESCE((SELECT ss.title FROM ${s}.sessions ss
                                              WHERE ss.session_id = g.dim_key), g.dim_key)
               WHEN 'user'    THEN COALESCE((SELECT COALESCE(uu.display_name, uu.email, uu.subject)
                                               FROM ${s}.users uu
                                              WHERE uu.user_id::TEXT = g.dim_key), g.dim_key)
               ELSE g.dim_key
           END,
           sum(g.tokens_total)::BIGINT,
           count(*) FILTER (WHERE g.is_turn)
      FROM rows g
     GROUP BY g.dim_key
     ORDER BY 3 DESC
     LIMIT COALESCE(p_limit, 40);
$$ LANGUAGE sql STABLE;
`;
}
