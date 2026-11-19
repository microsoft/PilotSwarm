/**
 * Migration 0096 — Claude keep-warm heartbeat usage. Each keep-warm ping is a real model request that reads (and bills)
 * the session's cached prompt, so each one is recorded as usage of its own, apart from the turns:
 * - provider_heartbeat_usage: one row per ping — the four token counts, the CAPI total_nano_aiu the ping's reply
 *   reported, its HTTP status and usage_kind 'heartbeat'. Its primary key is (session_id, ping_seq), where ping_seq is
 *   the session's own running sequence; gap_ping is the handler's count inside one idle gap (1 to the model's maxPings,
 *   at most 24).
 * - session_metrics (the real table; session_metric_summaries is only a view of it) gets heartbeat_count and
 *   heartbeat_nano_aiu, and the view is replaced so it shows them. No table, column or row is dropped or rewritten.
 *   cms_get_session_metric_summary (0022) returns SELECT * of session_metrics, so it returns both columns as they are;
 *   SessionMetricSummary carries them as heartbeatCount and heartbeatNanoAiu to the management client and the tuner.
 * - cms_record_heartbeat_usage writes a ping: it adds the ping's tokens to the session's totals, the way a turn's
 *   writeback does (the row lock it takes orders concurrent pings), numbers the ping, and returns its ping_seq.
 * - provider_usage_ledger (migration 0049's table) gets usage_kind ('turn' by default, or 'heartbeat'). Each ping is also
 *   one ledger row keyed (session_id, -ping_seq), charged to the provider it was sent to (the session's model when the
 *   replayed request was made, resolved as admission does) with the session's owner and charge class, or like the
 *   session's latest turn row when the worker gives no model; a user row adds to the provider meters as
 *   cms_provider_settle_turn (0070) does. cms_heartbeat_provider_clear answers whether a ping may be sent now: not for
 *   a session that is gone or whose model changed since the replayed request, else whether the provider of the
 *   session's current model would admit a turn; it puts back every session column the admission check writes. The
 *   report functions that count turns count only 'turn' rows.
 * - cms_get_session_tree_stats, cms_get_fleet_stats_by_agent and cms_get_fleet_stats_totals are dropped and created
 *   again from their latest definitions (0027 for the tree and the totals, 0022 for the by-agent function), each with two
 *   more result columns, total_heartbeat_count and total_heartbeat_nano_aiu: the sums of the two session_metrics
 *   counters over a session tree, over each agent and model, and over the fleet. Their other columns and their bodies
 *   are unchanged, so a reader that picks columns by name is not affected by the two added ones.
 * Each step is idempotent and never builds an index concurrently; locks are taken under a 5 s
 * lock timeout, on PostgreSQL and HorizonDB alike.
 */
export function heartbeatUsageMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
SET LOCAL lock_timeout = '5s';

ALTER TABLE ${s}.session_metrics ADD COLUMN IF NOT EXISTS heartbeat_count BIGINT NOT NULL DEFAULT 0;
ALTER TABLE ${s}.session_metrics ADD COLUMN IF NOT EXISTS heartbeat_nano_aiu BIGINT NOT NULL DEFAULT 0;
-- A view's SELECT * is frozen when it is created; replacing it appends the two new columns and keeps what depends on it.
CREATE OR REPLACE VIEW ${s}.session_metric_summaries AS SELECT * FROM ${s}.session_metrics;

CREATE TABLE IF NOT EXISTS ${s}.provider_heartbeat_usage (
    session_id         TEXT        NOT NULL,
    ping_seq           BIGINT      NOT NULL,
    gap_ping           INTEGER     NOT NULL DEFAULT 0,
    model              TEXT,
    tokens_input       BIGINT      NOT NULL DEFAULT 0,
    tokens_output      BIGINT      NOT NULL DEFAULT 0,
    tokens_cache_read  BIGINT      NOT NULL DEFAULT 0,
    tokens_cache_write BIGINT      NOT NULL DEFAULT 0,
    total_nano_aiu     BIGINT      NOT NULL DEFAULT 0,
    http_status        INTEGER,
    usage_kind         TEXT        NOT NULL DEFAULT 'heartbeat' CHECK (usage_kind = 'heartbeat'),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, ping_seq)
);
CREATE INDEX IF NOT EXISTS provider_heartbeat_usage_created
    ON ${s}.provider_heartbeat_usage (created_at DESC);

-- A constant default and no CHECK: adding the column rewrites and scans no row of the ledger.
ALTER TABLE ${s}.provider_usage_ledger ADD COLUMN IF NOT EXISTS usage_kind TEXT NOT NULL DEFAULT 'turn';

CREATE OR REPLACE FUNCTION ${s}.cms_record_heartbeat_usage(
    p_session_id         TEXT,
    p_model              TEXT,
    p_ping               INTEGER,
    p_status             INTEGER,
    p_tokens_input       BIGINT,
    p_tokens_output      BIGINT,
    p_tokens_cache_read  BIGINT,
    p_tokens_cache_write BIGINT,
    p_total_nano_aiu     BIGINT,
    p_model_qualified    TEXT
) RETURNS BIGINT AS $$
DECLARE
    v_input  BIGINT := GREATEST(0, COALESCE(p_tokens_input, 0));
    v_output BIGINT := GREATEST(0, COALESCE(p_tokens_output, 0));
    v_cread  BIGINT := GREATEST(0, COALESCE(p_tokens_cache_read, 0));
    v_cwrite BIGINT := GREATEST(0, COALESCE(p_tokens_cache_write, 0));
    v_nano   BIGINT := GREATEST(0, COALESCE(p_total_nano_aiu, 0));
    v_seq    BIGINT;
    v_last   RECORD;
    v_class  TEXT;
    v_total  BIGINT;
    v_scope  TEXT;
    v_first  INTEGER;
    v_sess   RECORD;
    v_ref    TEXT := NULLIF(BTRIM(COALESCE(p_model_qualified, '')), '');
    v_pname  TEXT;
    v_prov   TEXT;
    v_model  TEXT;
    v_owner  BIGINT;
    v_agent  TEXT;
BEGIN
    -- The upsert takes the session's metrics row lock first, so two pings of one session number themselves in turn.
    INSERT INTO ${s}.session_metrics (
        session_id, model,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
        heartbeat_count, heartbeat_nano_aiu
    ) VALUES (
        p_session_id, p_model,
        v_input, v_output, v_cread, v_cwrite,
        1, v_nano
    )
    ON CONFLICT (session_id) DO UPDATE SET
        model = COALESCE(${s}.session_metrics.model, EXCLUDED.model),
        tokens_input = ${s}.session_metrics.tokens_input + EXCLUDED.tokens_input,
        tokens_output = ${s}.session_metrics.tokens_output + EXCLUDED.tokens_output,
        tokens_cache_read = ${s}.session_metrics.tokens_cache_read + EXCLUDED.tokens_cache_read,
        tokens_cache_write = ${s}.session_metrics.tokens_cache_write + EXCLUDED.tokens_cache_write,
        heartbeat_count = ${s}.session_metrics.heartbeat_count + 1,
        heartbeat_nano_aiu = ${s}.session_metrics.heartbeat_nano_aiu + EXCLUDED.heartbeat_nano_aiu,
        updated_at = now();

    SELECT COALESCE(MAX(h.ping_seq), 0) + 1 INTO v_seq
      FROM ${s}.provider_heartbeat_usage h
     WHERE h.session_id = p_session_id;

    INSERT INTO ${s}.provider_heartbeat_usage (
        session_id, ping_seq, gap_ping, model,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
        total_nano_aiu, http_status, usage_kind
    ) VALUES (
        p_session_id, v_seq, COALESCE(p_ping, 0), p_model,
        v_input, v_output, v_cread, v_cwrite,
        v_nano, p_status, 'heartbeat'
    );
    -- The ping is charged to the provider it was sent to: the provider of p_model_qualified (the session's model when
    -- the replayed request was made), resolved as a turn's admission resolves it (a system session's provider must
    -- allow system use; another session's must be shared or the owner's own), with the session's owner and charge
    -- class, as a turn is settled. Without p_model_qualified it is charged like the session's latest turn row; when the
    -- given model's provider does not resolve, or there is neither, it is unattributed and keeps the owner.
    SELECT so.user_id AS owner_user_id, COALESCE(ss.is_system, FALSE) AS is_system, ss.agent_id
      INTO v_sess
      FROM ${s}.sessions ss
      LEFT JOIN ${s}.session_owners so ON so.session_id = ss.session_id
     WHERE ss.session_id = p_session_id;
    SELECT l.provider_name, l.model_qualified, l.owner_user_id, l.charge_class, l.agent_id
      INTO v_last
      FROM ${s}.provider_usage_ledger l
     WHERE l.session_id = p_session_id AND l.usage_kind = 'turn'
     ORDER BY l.turn_index DESC
     LIMIT 1;
    IF v_ref IS NOT NULL THEN
        SELECT r.provider_name INTO v_pname FROM ${s}.cms_provider_split_ref(v_ref) r;
        IF COALESCE(v_sess.is_system, FALSE) THEN
            SELECT i.name INTO v_prov FROM ${s}.cms_provider_for_system(COALESCE(v_pname, '')) i;
        ELSE
            SELECT i.name INTO v_prov FROM ${s}.cms_provider_in_namespace(COALESCE(v_pname, ''), v_sess.owner_user_id) i;
        END IF;
        v_model := v_ref;
        v_owner := v_sess.owner_user_id;
        v_class := CASE WHEN v_prov IS NULL THEN 'unattributed'
                        WHEN COALESCE(v_sess.is_system, FALSE) THEN 'system' ELSE 'user' END;
    ELSIF v_last.provider_name IS NOT NULL THEN
        v_prov := v_last.provider_name;
        v_model := v_last.model_qualified;
        v_owner := v_last.owner_user_id;
        v_class := COALESCE(NULLIF(BTRIM(COALESCE(v_last.charge_class, '')), ''), 'user');
    ELSE
        v_model := v_last.model_qualified;
        v_owner := COALESCE(v_last.owner_user_id, v_sess.owner_user_id);
        v_class := 'unattributed';
    END IF;
    v_agent := COALESCE(v_last.agent_id, v_sess.agent_id);
    v_total := v_input + v_output;
    -- A turn's key is never below 0, so a ping never takes one; cms_provider_next_turn_index reads MAX and is unchanged.
    INSERT INTO ${s}.provider_usage_ledger
        (session_id, turn_index, provider_name, model_qualified, owner_user_id,
         charge_class, tokens_input, tokens_output, tokens_cache_read,
         tokens_cache_write, tokens_total, agent_id, usage_kind)
    VALUES (p_session_id, -(v_seq::INTEGER), v_prov, v_model, v_owner,
            v_class, v_input, v_output, v_cread, v_cwrite, v_total, v_agent, 'heartbeat')
    ON CONFLICT (session_id, turn_index) DO NOTHING;
    GET DIAGNOSTICS v_first = ROW_COUNT;

    -- The meter upserts of cms_provider_settle_turn (migration 0070), for a user row only.
    IF v_first > 0 AND v_class = 'user' AND v_total > 0 THEN
        PERFORM 1 FROM ${s}.provider_instances pi
         WHERE pi.name = v_prov FOR KEY SHARE;
        IF FOUND THEN
            v_scope := COALESCE(NULLIF(BTRIM(COALESCE(v_model, '')), ''), '*');
            INSERT INTO ${s}.provider_meters
                (provider_name, period, scope, window_key_utc, used_tokens,
                 window_start_utc, resets_at_utc)
            SELECT v_prov, per.period, sc.scope, wb.window_key, v_total,
                   wb.window_start, wb.resets_at
              FROM (VALUES ('day'),('week'),('month')) AS per(period)
              CROSS JOIN LATERAL ${s}.cms_provider_window_bounds(per.period, now()) wb
              CROSS JOIN (SELECT DISTINCT v.s FROM (VALUES ('*'), (v_scope)) AS v(s)) AS sc(scope)
             ORDER BY per.period, sc.scope
            ON CONFLICT (provider_name, period, scope, window_key_utc) DO UPDATE
                SET used_tokens = ${s}.provider_meters.used_tokens + EXCLUDED.used_tokens,
                    updated_at = now();

            IF v_owner IS NOT NULL THEN
                INSERT INTO ${s}.provider_meters_user
                    (provider_name, period, scope, window_key_utc, user_id, used_tokens,
                     window_start_utc, resets_at_utc)
                SELECT v_prov, per.period, sc.scope, wb.window_key, v_owner, v_total,
                       wb.window_start, wb.resets_at
                  FROM (VALUES ('day'),('week'),('month')) AS per(period)
                  CROSS JOIN LATERAL ${s}.cms_provider_window_bounds(per.period, now()) wb
                  CROSS JOIN (SELECT DISTINCT v.s FROM (VALUES ('*'), (v_scope)) AS v(s)) AS sc(scope)
                 ORDER BY per.period, sc.scope
                ON CONFLICT (provider_name, period, scope, window_key_utc, user_id) DO UPDATE
                    SET used_tokens = ${s}.provider_meters_user.used_tokens + EXCLUDED.used_tokens,
                        updated_at = now();
            END IF;
        END IF;
    END IF;
    RETURN v_seq;
END;
$$ LANGUAGE plpgsql;

-- Whether a keep-warm ping may be sent now (the worker asks before each ping). False when the session does not exist,
-- or when p_model_qualified (the session's model when the replayed request was made) is given and the session's model
-- is now another one. Otherwise the verdict of cms_provider_check_turn, which asks, as a turn's admission does, whether
-- the provider of the session's current model would admit a turn now; a session with no turn yet is checked the same
-- way. cms_provider_check_turn writes sessions.pause_state, and fills model, reasoning_effort, context_tier and
-- model_resolution_source when model is NULL, as a turn's admission does; this function puts all of them and
-- updated_at back as they were, so a ping never marks a session paused (cms_provider_paused_for would list it and a
-- budget change would wake it with a turn) and never picks the session's model.
CREATE OR REPLACE FUNCTION ${s}.cms_heartbeat_provider_clear(p_session_id TEXT, p_model_qualified TEXT) RETURNS BOOLEAN AS $$
DECLARE
    v_sess    RECORD;
    v_ref     TEXT := NULLIF(BTRIM(COALESCE(p_model_qualified, '')), '');
    v_verdict TEXT;
BEGIN
    SELECT ss.pause_state, ss.model, ss.reasoning_effort, ss.context_tier, ss.model_resolution_source, ss.updated_at
      INTO v_sess FROM ${s}.sessions ss
     WHERE ss.session_id = p_session_id FOR NO KEY UPDATE;
    IF NOT FOUND THEN RETURN FALSE; END IF;
    IF v_ref IS NOT NULL AND NULLIF(BTRIM(COALESCE(v_sess.model, '')), '') <> v_ref THEN RETURN FALSE; END IF;
    SELECT c.verdict INTO v_verdict FROM ${s}.cms_provider_check_turn(p_session_id, v_ref) c;
    UPDATE ${s}.sessions ss
       SET pause_state = v_sess.pause_state, model = v_sess.model, reasoning_effort = v_sess.reasoning_effort,
           context_tier = v_sess.context_tier, model_resolution_source = v_sess.model_resolution_source,
           updated_at = v_sess.updated_at
     WHERE ss.session_id = p_session_id
       AND (ss.pause_state IS DISTINCT FROM v_sess.pause_state OR ss.model IS DISTINCT FROM v_sess.model
            OR ss.reasoning_effort IS DISTINCT FROM v_sess.reasoning_effort
            OR ss.context_tier IS DISTINCT FROM v_sess.context_tier
            OR ss.model_resolution_source IS DISTINCT FROM v_sess.model_resolution_source);
    RETURN v_verdict IS NOT DISTINCT FROM 'clear';
END;
$$ LANGUAGE plpgsql VOLATILE;

-- cms_provider_usage_totals: copied from migration_0061_provider_correctness_fixes in cms-migrations.ts; turns count only usage_kind = 'turn' rows.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_totals(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_days INTEGER,
    p_owner BIGINT, p_provider TEXT, p_model TEXT, p_session TEXT, p_class TEXT
) RETURNS TABLE(tokens_total BIGINT, turns BIGINT, sessions BIGINT) AS $$
    SELECT COALESCE(sum(l.tokens_total), 0), count(*) FILTER (WHERE l.usage_kind = 'turn')::BIGINT,
           count(DISTINCT l.session_id)::BIGINT
      FROM ${s}.provider_usage_ledger l
     WHERE l.created_at >= now() - (COALESCE(p_days, 7) || ' days')::interval
       AND (COALESCE(p_is_admin, FALSE)
            OR l.owner_user_id IS NOT DISTINCT FROM p_viewer
            -- A named SHARED provider's TOTAL is open to everyone who may
            -- spend from it; the moment an attribution filter is present
            -- the question becomes admin-only. (Unchanged from 0051.)
            OR (p_provider IS NOT NULL AND p_owner IS NULL AND p_session IS NULL
                AND EXISTS (
                    SELECT 1 FROM ${s}.provider_instances pi
                     WHERE pi.name = p_provider AND pi.class = 'shared')))
       AND (p_owner IS NULL OR l.owner_user_id = p_owner)
       AND (p_provider IS NULL OR l.provider_name = p_provider)
       -- Nothing from before THIS provider took the name.
       AND (p_provider IS NULL OR l.created_at >= COALESCE(
               (SELECT pi.created_at FROM ${s}.provider_instances pi WHERE pi.name = p_provider),
               '-infinity'::timestamptz))
       AND (p_model IS NULL OR l.model_qualified = p_model)
       AND (p_session IS NULL OR l.session_id = p_session)
       AND (p_class IS NULL OR l.charge_class = p_class);
$$ LANGUAGE sql STABLE;

-- cms_provider_usage_daily: copied from migration_0069_provider_grid_token_split in cms-migrations.ts; turns count only usage_kind = 'turn' rows.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_daily(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_days INTEGER,
    p_owner BIGINT, p_provider TEXT, p_model TEXT, p_session TEXT, p_class TEXT
) RETURNS TABLE(
    day_utc DATE, tokens_total BIGINT, turns BIGINT,
    tokens_input BIGINT, tokens_output BIGINT, tokens_cache_read BIGINT, tokens_cache_write BIGINT
) AS $$
    SELECT (l.created_at AT TIME ZONE 'UTC')::date, COALESCE(sum(l.tokens_total), 0), count(*) FILTER (WHERE l.usage_kind = 'turn')::BIGINT,
           COALESCE(sum(l.tokens_input), 0), COALESCE(sum(l.tokens_output), 0),
           COALESCE(sum(l.tokens_cache_read), 0), COALESCE(sum(l.tokens_cache_write), 0)
      FROM ${s}.provider_usage_ledger l
     WHERE l.created_at >= now() - (COALESCE(p_days, 7) || ' days')::interval
       AND (COALESCE(p_is_admin, FALSE)
            OR l.owner_user_id IS NOT DISTINCT FROM p_viewer
            OR (p_provider IS NOT NULL AND p_owner IS NULL AND p_session IS NULL
                AND EXISTS (
                    SELECT 1 FROM ${s}.provider_instances pi
                     WHERE pi.name = p_provider AND pi.class = 'shared')))
       AND (p_owner IS NULL OR l.owner_user_id = p_owner)
       AND (p_provider IS NULL OR l.provider_name = p_provider)
       AND (p_provider IS NULL OR l.created_at >= COALESCE(
               (SELECT pi.created_at FROM ${s}.provider_instances pi WHERE pi.name = p_provider),
               '-infinity'::timestamptz))
       AND (p_model IS NULL OR l.model_qualified = p_model)
       AND (p_session IS NULL OR l.session_id = p_session)
       AND (p_class IS NULL OR l.charge_class = p_class)
     GROUP BY 1 ORDER BY 1;
$$ LANGUAGE sql STABLE;

-- cms_provider_usage_breakdown: copied from migration_0061_provider_correctness_fixes in cms-migrations.ts; turns count only usage_kind = 'turn' rows.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_breakdown(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_days INTEGER,
    p_owner BIGINT, p_provider TEXT, p_model TEXT, p_session TEXT, p_class TEXT,
    p_dim TEXT, p_limit INTEGER
) RETURNS TABLE(key TEXT, label TEXT, tokens_total BIGINT, turns BIGINT) AS $$
    WITH rows AS (
        SELECT l.*,
               CASE p_dim
                   WHEN 'session'  THEN l.session_id
                   WHEN 'provider' THEN COALESCE(l.provider_name, '(none)')
                   WHEN 'model'    THEN COALESCE(l.model_qualified, '(none)')
                   WHEN 'agent'    THEN COALESCE(l.agent_id, '(none)')
                   WHEN 'user'     THEN COALESCE(l.owner_user_id::TEXT,
                                          CASE WHEN l.charge_class = 'system'
                                               THEN '(system)' ELSE '(unowned)' END)
                   ELSE COALESCE(l.provider_name, '(none)')
               END AS dim_key
          FROM ${s}.provider_usage_ledger l
         WHERE l.created_at >= now() - (COALESCE(p_days, 7) || ' days')::interval
           AND (COALESCE(p_is_admin, FALSE) OR l.owner_user_id IS NOT DISTINCT FROM p_viewer)
           AND (p_owner IS NULL OR l.owner_user_id = p_owner)
           AND (p_provider IS NULL OR l.provider_name = p_provider)
           -- Nothing from before THIS provider took the name.
           AND (p_provider IS NULL OR l.created_at >= COALESCE(
                   (SELECT pi.created_at FROM ${s}.provider_instances pi WHERE pi.name = p_provider),
                   '-infinity'::timestamptz))
           AND (p_model IS NULL OR l.model_qualified = p_model)
           AND (p_session IS NULL OR l.session_id = p_session)
           AND (p_class IS NULL OR l.charge_class = p_class)
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
           sum(g.tokens_total)::BIGINT, count(*) FILTER (WHERE g.usage_kind = 'turn')::BIGINT
      FROM rows g
     GROUP BY g.dim_key
     ORDER BY 3 DESC
     LIMIT COALESCE(p_limit, 40);
$$ LANGUAGE sql STABLE;

-- cms_provider_usage_breakdown_cluster: copied from migration_0075_cluster_admin_accounting in cms-migrations.ts; turns count only usage_kind = 'turn' rows.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_breakdown_cluster(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_days INTEGER,
    p_owner BIGINT, p_provider TEXT, p_model TEXT, p_session TEXT, p_class TEXT,
    p_dim TEXT, p_limit INTEGER
) RETURNS TABLE(key TEXT, label TEXT, tokens_total BIGINT, turns BIGINT) AS $$
    WITH visible_sessions AS MATERIALIZED (
        SELECT ss.session_id FROM ${s}.sessions ss
         WHERE p_dim = 'session' AND ${s}.cms_session_content_visible(ss.session_id, p_viewer, TRUE)
    ), rows AS (
        SELECT l.*,
               CASE p_dim
                   WHEN 'session'  THEN CASE WHEN visible.session_id IS NOT NULL
                                            THEN l.session_id ELSE '(private sessions)' END
                   WHEN 'provider' THEN COALESCE(l.provider_name, '(none)')
                   WHEN 'model'    THEN COALESCE(l.model_qualified, '(none)')
                   WHEN 'agent'    THEN CASE WHEN l.owner_user_id = p_viewer OR l.charge_class = 'system'
                                            THEN COALESCE(l.agent_id, '(none)') ELSE '(other users agents)' END
                   WHEN 'user'     THEN COALESCE(l.owner_user_id::TEXT,
                                          CASE WHEN l.charge_class = 'system'
                                               THEN '(system)' ELSE '(unowned)' END)
                   ELSE COALESCE(l.provider_name, '(none)')
               END AS dim_key
          FROM ${s}.provider_usage_ledger l
          LEFT JOIN visible_sessions visible ON visible.session_id = l.session_id
         WHERE l.created_at >= now() - (COALESCE(p_days, 7) || ' days')::interval
           AND (COALESCE(p_is_admin, FALSE) OR l.owner_user_id IS NOT DISTINCT FROM p_viewer)
           AND (p_owner IS NULL OR l.owner_user_id = p_owner)
           AND (p_provider IS NULL OR l.provider_name = p_provider)
           -- Nothing from before THIS provider took the name.
           AND (p_provider IS NULL OR l.created_at >= COALESCE(
                   (SELECT pi.created_at FROM ${s}.provider_instances pi WHERE pi.name = p_provider),
                   '-infinity'::timestamptz))
           AND (p_model IS NULL OR l.model_qualified = p_model)
           AND (p_session IS NULL OR l.session_id = p_session)
           AND (p_class IS NULL OR l.charge_class = p_class)
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
           sum(g.tokens_total)::BIGINT, count(*) FILTER (WHERE g.usage_kind = 'turn')::BIGINT
      FROM rows g
     GROUP BY g.dim_key
     ORDER BY 3 DESC
     LIMIT COALESCE(p_limit, 40);
$$ LANGUAGE sql STABLE;

-- cms_provider_usage_summary_window: copied from migration_0068_provider_usage_summary in cms-migrations.ts; turns count only usage_kind = 'turn' rows.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_summary_window(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_since TIMESTAMPTZ, p_providers TEXT[]
) RETURNS JSONB AS $$
    SELECT jsonb_build_object(
        'input', COALESCE(sum(r.tokens_input), 0),
        'output', COALESCE(sum(r.tokens_output), 0),
        'cacheRead', COALESCE(sum(r.tokens_cache_read), 0),
        'cacheWrite', COALESCE(sum(r.tokens_cache_write), 0),
        'total', COALESCE(sum(r.tokens_total), 0),
        'turns', count(*) FILTER (WHERE r.usage_kind = 'turn'),
        'sessions', count(DISTINCT r.session_id))
      FROM ${s}.cms_provider_usage_summary_rows(p_viewer, p_is_admin, p_since, p_providers) r;
$$ LANGUAGE sql STABLE;

-- cms_provider_usage_summary: copied from migration_0068_provider_usage_summary in cms-migrations.ts; turns count only usage_kind = 'turn' rows.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_summary(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_days INTEGER, p_providers TEXT[]
) RETURNS JSONB AS $$
DECLARE
    v_days    INTEGER := LEAST(GREATEST(COALESCE(p_days, 14), 1), 365);
    -- UTC days, today included: the ledger stores UTC and the meters' day /
    -- week / month windows are UTC, so "today" here is the same today.
    v_today   DATE := (now() AT TIME ZONE 'UTC')::date;
    v_from    TIMESTAMPTZ := ((v_today - (v_days - 1)) :: timestamp) AT TIME ZONE 'UTC';
    v_month   TIMESTAMPTZ := ((v_today - 29) :: timestamp) AT TIME ZONE 'UTC';
    v_since   TIMESTAMPTZ := LEAST(v_from, v_month);
    v_windows JSONB;
    v_daily   JSONB;
    v_models  JSONB;
    v_classes JSONB;
BEGIN
    -- Today / last 7 UTC days / last 30 UTC days, each with the four-way
    -- split. The month window is what the ledger is read for at minimum.
    SELECT jsonb_build_object(
        'day',   ${s}.cms_provider_usage_summary_window(p_viewer, p_is_admin, ((v_today)::timestamp) AT TIME ZONE 'UTC', p_providers),
        'week',  ${s}.cms_provider_usage_summary_window(p_viewer, p_is_admin, ((v_today - 6)::timestamp) AT TIME ZONE 'UTC', p_providers),
        'month', ${s}.cms_provider_usage_summary_window(p_viewer, p_is_admin, v_month, p_providers))
      INTO v_windows;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'day', to_char(d.day, 'YYYY-MM-DD'),
               'input', d.i, 'output', d.o, 'cacheRead', d.cr, 'cacheWrite', d.cw,
               'total', d.t, 'turns', d.n) ORDER BY d.day), '[]'::jsonb)
      INTO v_daily
      FROM (
        SELECT (r.created_at AT TIME ZONE 'UTC')::date AS day,
               sum(r.tokens_input) i, sum(r.tokens_output) o,
               sum(r.tokens_cache_read) cr, sum(r.tokens_cache_write) cw,
               sum(r.tokens_total) t, count(*) FILTER (WHERE r.usage_kind = 'turn') n
          FROM ${s}.cms_provider_usage_summary_rows(p_viewer, p_is_admin, v_from, p_providers) r
         GROUP BY 1) d;

    -- The pivot: the model NAME, whatever provider carried it. model_qualified
    -- is provider:model, and a model name never holds a colon, so the part
    -- after the first colon is the model. Each row carries its own per-day
    -- totals for a sparkline.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'model', m.model, 'providers', m.providers, 'turns', m.n,
               'input', m.i, 'output', m.o, 'cacheRead', m.cr, 'cacheWrite', m.cw, 'total', m.t,
               'daily', m.daily) ORDER BY m.t DESC, m.model), '[]'::jsonb)
      INTO v_models
      FROM (
        SELECT g.model, count(DISTINCT g.provider_name) providers, count(*) FILTER (WHERE g.usage_kind = 'turn') n,
               sum(g.tokens_input) i, sum(g.tokens_output) o,
               sum(g.tokens_cache_read) cr, sum(g.tokens_cache_write) cw, sum(g.tokens_total) t,
               (SELECT COALESCE(jsonb_agg(jsonb_build_object('day', to_char(dd.day, 'YYYY-MM-DD'), 'total', dd.t) ORDER BY dd.day), '[]'::jsonb)
                  FROM (SELECT (x.created_at AT TIME ZONE 'UTC')::date AS day, sum(x.tokens_total) t
                          FROM ${s}.cms_provider_usage_summary_rows(p_viewer, p_is_admin, v_from, p_providers) x
                         WHERE substr(x.model_qualified, position(':' IN x.model_qualified) + 1) = g.model
                         GROUP BY 1) dd) AS daily
          FROM (SELECT r.*, substr(r.model_qualified, position(':' IN r.model_qualified) + 1) AS model
                  FROM ${s}.cms_provider_usage_summary_rows(p_viewer, p_is_admin, v_from, p_providers) r) g
         GROUP BY g.model) m;

    -- How the window's total splits by who was charged: people, the
    -- machinery PilotSwarm runs for itself, or turns with no provider.
    SELECT COALESCE(jsonb_agg(jsonb_build_object('chargeClass', c.charge_class, 'total', c.t, 'turns', c.n) ORDER BY c.t DESC), '[]'::jsonb)
      INTO v_classes
      FROM (SELECT r.charge_class, sum(r.tokens_total) t, count(*) FILTER (WHERE r.usage_kind = 'turn') n
              FROM ${s}.cms_provider_usage_summary_rows(p_viewer, p_is_admin, v_from, p_providers) r
             GROUP BY 1) c;

    RETURN jsonb_build_object(
        'days', v_days,
        'today', to_char(v_today, 'YYYY-MM-DD'),
        'scope', CASE WHEN COALESCE(p_is_admin, FALSE) THEN 'cluster' ELSE 'mine' END,
        'windows', v_windows,
        'daily', v_daily,
        'models', v_models,
        'classes', v_classes);
END;
$$ LANGUAGE plpgsql STABLE;

-- cms_provider_usage_agents: copied from migration_0071_provider_usage_agents in cms-migrations.ts; turns count only usage_kind = 'turn' rows.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_agents(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_days INTEGER, p_providers TEXT[]
) RETURNS JSONB AS $$
DECLARE
    v_days   INTEGER := LEAST(GREATEST(COALESCE(p_days, 14), 1), 365);
    v_today  DATE := (now() AT TIME ZONE 'UTC')::date;
    v_from   TIMESTAMPTZ := ((v_today - (v_days - 1)) :: timestamp) AT TIME ZONE 'UTC';
    v_agents JSONB;
    v_daily  JSONB;
BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'agent', a.agent, 'turns', a.n, 'sessions', a.sessions,
               'input', a.i, 'output', a.o, 'cacheRead', a.cr, 'cacheWrite', a.cw, 'total', a.t,
               'models', a.models, 'daily', a.daily) ORDER BY a.t DESC, a.agent), '[]'::jsonb)
      INTO v_agents
      FROM (
        SELECT g.agent, count(*) FILTER (WHERE g.usage_kind = 'turn') n, count(DISTINCT g.session_id) sessions,
               sum(g.tokens_input) i, sum(g.tokens_output) o,
               sum(g.tokens_cache_read) cr, sum(g.tokens_cache_write) cw, sum(g.tokens_total) t,
               (SELECT COALESCE(jsonb_agg(DISTINCT substr(x.model_qualified, position(':' IN x.model_qualified) + 1)), '[]'::jsonb)
                  FROM ${s}.cms_provider_usage_summary_rows(p_viewer, p_is_admin, v_from, p_providers) x
                 WHERE COALESCE(x.agent_id, '(none)') = g.agent AND x.model_qualified IS NOT NULL) AS models,
               (SELECT COALESCE(jsonb_agg(jsonb_build_object('day', to_char(dd.day, 'YYYY-MM-DD'), 'total', dd.t) ORDER BY dd.day), '[]'::jsonb)
                  FROM (SELECT (y.created_at AT TIME ZONE 'UTC')::date AS day, sum(y.tokens_total) t
                          FROM ${s}.cms_provider_usage_summary_rows(p_viewer, p_is_admin, v_from, p_providers) y
                         WHERE COALESCE(y.agent_id, '(none)') = g.agent
                         GROUP BY 1) dd) AS daily
          FROM (SELECT r.*, COALESCE(r.agent_id, '(none)') AS agent
                  FROM ${s}.cms_provider_usage_summary_rows(p_viewer, p_is_admin, v_from, p_providers) r) g
         GROUP BY g.agent) a;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'day', to_char(d.day, 'YYYY-MM-DD'), 'agent', d.agent, 'total', d.t, 'turns', d.n) ORDER BY d.day, d.t DESC), '[]'::jsonb)
      INTO v_daily
      FROM (
        SELECT (r.created_at AT TIME ZONE 'UTC')::date AS day, COALESCE(r.agent_id, '(none)') AS agent,
               sum(r.tokens_total) t, count(*) FILTER (WHERE r.usage_kind = 'turn') n
          FROM ${s}.cms_provider_usage_summary_rows(p_viewer, p_is_admin, v_from, p_providers) r
         GROUP BY 1, 2) d;

    RETURN jsonb_build_object(
        'days', v_days,
        'today', to_char(v_today, 'YYYY-MM-DD'),
        'scope', CASE WHEN COALESCE(p_is_admin, FALSE) THEN 'cluster' ELSE 'mine' END,
        'agents', v_agents,
        'daily', v_daily);
END;
$$ LANGUAGE plpgsql STABLE;

-- cms_provider_usage_agents_cluster: copied from migration_0075_cluster_admin_accounting in cms-migrations.ts; turns count only usage_kind = 'turn' rows.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_agents_cluster(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_days INTEGER, p_providers TEXT[]
) RETURNS JSONB AS $$
DECLARE
    v_days   INTEGER := LEAST(GREATEST(COALESCE(p_days, 14), 1), 365);
    v_today  DATE := (now() AT TIME ZONE 'UTC')::date;
    v_from   TIMESTAMPTZ := ((v_today - (v_days - 1)) :: timestamp) AT TIME ZONE 'UTC';
    v_agents JSONB;
    v_daily  JSONB;
BEGIN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'agent', a.agent, 'turns', a.n, 'sessions', a.sessions,
               'input', a.i, 'output', a.o, 'cacheRead', a.cr, 'cacheWrite', a.cw, 'total', a.t,
               'models', a.models, 'daily', a.daily) ORDER BY a.t DESC, a.agent), '[]'::jsonb)
      INTO v_agents
      FROM (
        SELECT g.agent, count(*) FILTER (WHERE g.usage_kind = 'turn') n, count(DISTINCT g.session_id) sessions,
               sum(g.tokens_input) i, sum(g.tokens_output) o,
               sum(g.tokens_cache_read) cr, sum(g.tokens_cache_write) cw, sum(g.tokens_total) t,
               (SELECT COALESCE(jsonb_agg(DISTINCT substr(x.model_qualified, position(':' IN x.model_qualified) + 1)), '[]'::jsonb)
                  FROM ${s}.cms_provider_usage_summary_rows_cluster(p_viewer, p_is_admin, v_from, p_providers) x
                 WHERE COALESCE(x.agent_id, '(none)') = g.agent AND x.model_qualified IS NOT NULL) AS models,
               (SELECT COALESCE(jsonb_agg(jsonb_build_object('day', to_char(dd.day, 'YYYY-MM-DD'), 'total', dd.t) ORDER BY dd.day), '[]'::jsonb)
                  FROM (SELECT (y.created_at AT TIME ZONE 'UTC')::date AS day, sum(y.tokens_total) t
                          FROM ${s}.cms_provider_usage_summary_rows_cluster(p_viewer, p_is_admin, v_from, p_providers) y
                         WHERE COALESCE(y.agent_id, '(none)') = g.agent
                         GROUP BY 1) dd) AS daily
          FROM (SELECT r.*, COALESCE(r.agent_id, '(none)') AS agent
                  FROM ${s}.cms_provider_usage_summary_rows_cluster(p_viewer, p_is_admin, v_from, p_providers) r) g
         GROUP BY g.agent) a;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'day', to_char(d.day, 'YYYY-MM-DD'), 'agent', d.agent, 'total', d.t, 'turns', d.n) ORDER BY d.day, d.t DESC), '[]'::jsonb)
      INTO v_daily
      FROM (
        SELECT (r.created_at AT TIME ZONE 'UTC')::date AS day, COALESCE(r.agent_id, '(none)') AS agent,
               sum(r.tokens_total) t, count(*) FILTER (WHERE r.usage_kind = 'turn') n
          FROM ${s}.cms_provider_usage_summary_rows_cluster(p_viewer, p_is_admin, v_from, p_providers) r
         GROUP BY 1, 2) d;

    RETURN jsonb_build_object(
        'days', v_days,
        'today', to_char(v_today, 'YYYY-MM-DD'),
        'scope', CASE WHEN COALESCE(p_is_admin, FALSE) THEN 'cluster' ELSE 'mine' END,
        'agents', v_agents,
        'daily', v_daily);
END;
$$ LANGUAGE plpgsql STABLE;

-- cms_provider_usage_summary_rows_cluster: copied from migration_0075_cluster_admin_accounting in cms-migrations.ts; turns count only usage_kind = 'turn' rows.
CREATE OR REPLACE FUNCTION ${s}.cms_provider_usage_summary_rows_cluster(
    p_viewer BIGINT, p_is_admin BOOLEAN, p_since TIMESTAMPTZ, p_providers TEXT[]
) RETURNS SETOF ${s}.provider_usage_ledger AS $$
    SELECT l.session_id, l.turn_index, l.provider_name, l.model_qualified,
           l.owner_user_id, l.charge_class, l.tokens_input, l.tokens_output,
           l.tokens_cache_read, l.tokens_cache_write, l.tokens_total,
           CASE WHEN l.owner_user_id = p_viewer OR l.charge_class = 'system'
                THEN l.agent_id ELSE '(other users agents)' END, l.created_at, l.usage_kind
      FROM ${s}.cms_provider_usage_summary_rows(p_viewer, p_is_admin, p_since, p_providers) l;
$$ LANGUAGE sql STABLE;

-- cms_get_session_tree_stats: copied from migration_0027_session_raw_size_bytes in cms-migrations.ts; adds total_heartbeat_count and total_heartbeat_nano_aiu. The token totals come from session_metrics, which holds the ping tokens.
DROP FUNCTION IF EXISTS ${s}.cms_get_session_tree_stats(TEXT);
CREATE FUNCTION ${s}.cms_get_session_tree_stats(
    p_session_id TEXT
) RETURNS TABLE (
    session_count              INT,
    total_tokens_input         BIGINT,
    total_tokens_output        BIGINT,
    total_tokens_cache_read    BIGINT,
    total_tokens_cache_write   BIGINT,
    total_dehydration_count    INT,
    total_hydration_count      INT,
    total_lossy_handoff_count  INT,
    total_snapshot_size_bytes   BIGINT,
    total_raw_size_bytes        BIGINT,
    total_heartbeat_count       BIGINT,
    total_heartbeat_nano_aiu    BIGINT
) AS $$
BEGIN
    RETURN QUERY
    WITH RECURSIVE tree AS (
        SELECT m.session_id FROM ${s}.session_metrics m
        WHERE m.session_id = p_session_id
        UNION ALL
        SELECT m.session_id FROM ${s}.session_metrics m
        INNER JOIN tree t ON m.parent_session_id = t.session_id
    )
    SELECT
        COUNT(*)::int                                    AS session_count,
        COALESCE(SUM(m.tokens_input), 0)::bigint        AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint       AS total_tokens_output,
        COALESCE(SUM(m.tokens_cache_read), 0)::bigint   AS total_tokens_cache_read,
        COALESCE(SUM(m.tokens_cache_write), 0)::bigint  AS total_tokens_cache_write,
        COALESCE(SUM(m.dehydration_count), 0)::int      AS total_dehydration_count,
        COALESCE(SUM(m.hydration_count), 0)::int        AS total_hydration_count,
        COALESCE(SUM(m.lossy_handoff_count), 0)::int    AS total_lossy_handoff_count,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint AS total_snapshot_size_bytes,
        COALESCE(SUM(m.raw_size_bytes), 0)::bigint       AS total_raw_size_bytes,
        COALESCE(SUM(m.heartbeat_count), 0)::bigint      AS total_heartbeat_count,
        COALESCE(SUM(m.heartbeat_nano_aiu), 0)::bigint   AS total_heartbeat_nano_aiu
    FROM ${s}.session_metrics m
    WHERE m.session_id IN (SELECT tree.session_id FROM tree);
END;
$$ LANGUAGE plpgsql;

-- cms_get_fleet_stats_totals: copied from migration_0027_session_raw_size_bytes in cms-migrations.ts; adds total_heartbeat_count and total_heartbeat_nano_aiu. The token totals come from session_metrics, which holds the ping tokens.
DROP FUNCTION IF EXISTS ${s}.cms_get_fleet_stats_totals(BOOLEAN, TIMESTAMPTZ);
CREATE FUNCTION ${s}.cms_get_fleet_stats_totals(
    p_include_deleted BOOLEAN,
    p_since           TIMESTAMPTZ
) RETURNS TABLE (
    session_count                INT,
    total_snapshot_size_bytes     BIGINT,
    total_raw_size_bytes          BIGINT,
    total_tokens_input           BIGINT,
    total_tokens_output          BIGINT,
    total_tokens_cache_read      BIGINT,
    total_tokens_cache_write     BIGINT,
    earliest_session_created_at  TIMESTAMPTZ,
    total_heartbeat_count         BIGINT,
    total_heartbeat_nano_aiu      BIGINT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        COUNT(*)::int                                          AS session_count,
        COALESCE(SUM(m.snapshot_size_bytes), 0)::bigint        AS total_snapshot_size_bytes,
        COALESCE(SUM(m.raw_size_bytes), 0)::bigint             AS total_raw_size_bytes,
        COALESCE(SUM(m.tokens_input), 0)::bigint               AS total_tokens_input,
        COALESCE(SUM(m.tokens_output), 0)::bigint              AS total_tokens_output,
        COALESCE(SUM(m.tokens_cache_read), 0)::bigint          AS total_tokens_cache_read,
        COALESCE(SUM(m.tokens_cache_write), 0)::bigint         AS total_tokens_cache_write,
        MIN(m.created_at)                                      AS earliest_session_created_at,
        COALESCE(SUM(m.heartbeat_count), 0)::bigint            AS total_heartbeat_count,
        COALESCE(SUM(m.heartbeat_nano_aiu), 0)::bigint         AS total_heartbeat_nano_aiu
    FROM ${s}.session_metrics m
    WHERE (p_include_deleted OR m.deleted_at IS NULL)
      AND (p_since IS NULL OR m.created_at >= p_since);
END;
$$ LANGUAGE plpgsql;

-- cms_get_fleet_stats_by_agent: copied from migration_0022_turn_metrics_reasoning_effort in cms-migrations.ts; adds total_heartbeat_count and total_heartbeat_nano_aiu. Its token sums come from session_turn_metrics rows (a session with no turn row counts its session_metrics tokens), as before.
DROP FUNCTION IF EXISTS ${s}.cms_get_fleet_stats_by_agent(BOOLEAN, TIMESTAMPTZ);
CREATE FUNCTION ${s}.cms_get_fleet_stats_by_agent(
    p_include_deleted BOOLEAN,
    p_since           TIMESTAMPTZ
) RETURNS TABLE (
    agent_id                    TEXT,
    model                       TEXT,
    session_count               INT,
    turn_count                  BIGINT,
    total_snapshot_size_bytes    BIGINT,
    total_dehydration_count     INT,
    total_hydration_count       INT,
    total_lossy_handoff_count   INT,
    total_tokens_input          BIGINT,
    total_tokens_output         BIGINT,
    total_tokens_cache_read     BIGINT,
    total_tokens_cache_write    BIGINT,
    total_heartbeat_count        BIGINT,
    total_heartbeat_nano_aiu     BIGINT
) AS $$
BEGIN
    RETURN QUERY
    WITH token_rows AS (
        SELECT
            COALESCE(t.agent_id, m.agent_id, sess.agent_id) AS agent_id_value,
            CASE
                WHEN NULLIF(BTRIM(t.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(t.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(t.model), ''), '(unknown)') || ':' || BTRIM(t.reasoning_effort)
            END AS model_label,
            t.session_id,
            t.tokens_input,
            t.tokens_output,
            t.tokens_cache_read,
            t.tokens_cache_write
        FROM ${s}.session_turn_metrics t
        INNER JOIN ${s}.sessions sess ON sess.session_id = t.session_id
        LEFT JOIN ${s}.session_metrics m ON m.session_id = t.session_id
        WHERE (p_include_deleted OR sess.deleted_at IS NULL)
          AND (p_since IS NULL OR t.started_at >= p_since)
        UNION ALL
        SELECT
            COALESCE(m.agent_id, sess.agent_id) AS agent_id_value,
            CASE
                WHEN NULLIF(BTRIM(m.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)') || ':' || BTRIM(m.reasoning_effort)
            END AS model_label,
            m.session_id,
            m.tokens_input,
            m.tokens_output,
            m.tokens_cache_read,
            m.tokens_cache_write
        FROM ${s}.session_metrics m
        INNER JOIN ${s}.sessions sess ON sess.session_id = m.session_id
        WHERE (p_include_deleted OR m.deleted_at IS NULL)
          AND (p_since IS NULL OR m.created_at >= p_since)
          AND NOT EXISTS (
              SELECT 1 FROM ${s}.session_turn_metrics existing
              WHERE existing.session_id = m.session_id
          )
    ), token_rollup AS (
        SELECT
            agent_id_value,
            model_label,
            COUNT(DISTINCT session_id)::INT AS session_count,
            COUNT(*)::BIGINT AS turn_count,
            COALESCE(SUM(tokens_input), 0)::BIGINT AS total_tokens_input,
            COALESCE(SUM(tokens_output), 0)::BIGINT AS total_tokens_output,
            COALESCE(SUM(tokens_cache_read), 0)::BIGINT AS total_tokens_cache_read,
            COALESCE(SUM(tokens_cache_write), 0)::BIGINT AS total_tokens_cache_write
        FROM token_rows
        GROUP BY agent_id_value, model_label
    ), metric_rollup AS (
        SELECT
            m.agent_id AS agent_id_value,
            CASE
                WHEN NULLIF(BTRIM(m.reasoning_effort), '') IS NULL
                    THEN COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)')
                ELSE COALESCE(NULLIF(BTRIM(m.model), ''), '(unknown)') || ':' || BTRIM(m.reasoning_effort)
            END AS model_label,
            COUNT(*)::INT AS session_count,
            COALESCE(SUM(m.snapshot_size_bytes), 0)::BIGINT AS total_snapshot_size_bytes,
            COALESCE(SUM(m.dehydration_count), 0)::INT AS total_dehydration_count,
            COALESCE(SUM(m.hydration_count), 0)::INT AS total_hydration_count,
            COALESCE(SUM(m.lossy_handoff_count), 0)::INT AS total_lossy_handoff_count,
            COALESCE(SUM(m.heartbeat_count), 0)::BIGINT AS total_heartbeat_count,
            COALESCE(SUM(m.heartbeat_nano_aiu), 0)::BIGINT AS total_heartbeat_nano_aiu
        FROM ${s}.session_metrics m
        WHERE (p_include_deleted OR m.deleted_at IS NULL)
          AND (p_since IS NULL OR m.created_at >= p_since)
        GROUP BY m.agent_id, model_label
    )
    SELECT
        COALESCE(t.agent_id_value, m.agent_id_value) AS agent_id,
        COALESCE(t.model_label, m.model_label) AS model,
        COALESCE(t.session_count, m.session_count, 0)::INT AS session_count,
        COALESCE(t.turn_count, 0)::BIGINT AS turn_count,
        COALESCE(m.total_snapshot_size_bytes, 0)::BIGINT AS total_snapshot_size_bytes,
        COALESCE(m.total_dehydration_count, 0)::INT AS total_dehydration_count,
        COALESCE(m.total_hydration_count, 0)::INT AS total_hydration_count,
        COALESCE(m.total_lossy_handoff_count, 0)::INT AS total_lossy_handoff_count,
        COALESCE(t.total_tokens_input, 0)::BIGINT AS total_tokens_input,
        COALESCE(t.total_tokens_output, 0)::BIGINT AS total_tokens_output,
        COALESCE(t.total_tokens_cache_read, 0)::BIGINT AS total_tokens_cache_read,
        COALESCE(t.total_tokens_cache_write, 0)::BIGINT AS total_tokens_cache_write,
        COALESCE(m.total_heartbeat_count, 0)::BIGINT AS total_heartbeat_count,
        COALESCE(m.total_heartbeat_nano_aiu, 0)::BIGINT AS total_heartbeat_nano_aiu
    FROM token_rollup t
    FULL OUTER JOIN metric_rollup m
    ON m.agent_id_value IS NOT DISTINCT FROM t.agent_id_value
      AND m.model_label = t.model_label
     ORDER BY COALESCE(t.total_tokens_input, 0) DESC, COALESCE(t.model_label, m.model_label);
END;
$$ LANGUAGE plpgsql;
`;
}
