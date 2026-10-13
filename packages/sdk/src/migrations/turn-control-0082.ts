/**
 * Migration 0082 — session turn control (Stop and Steer through the CMS).
 * See docs/proposals/session-turn-control.md and migrations/0082_diff.md.
 *
 * Additive: two session columns, new procedures, a BOOLEAN return for the
 * end-of-turn write, closing rules in cms_update_session, a lifetime reset
 * on archive and revive, and the `sessions.steering` flag row. No new table,
 * no new index: every read uses session_events (session_id, event_type, seq).
 *
 * Vocabulary:
 * - a control is a `user.steer` or `user.stop` event; it is open while it has
 *   no `session.control_outcome` event;
 * - a carried steer is a steer whose outcome is `carried`; it is closed by a
 *   `session.carried_steers_closed` event that lists its seq;
 * - an orchestration lifetime starts when a session row is created or revived;
 *   events with seq <= sessions.turn_base_seq belong to an earlier lifetime and
 *   every turn-control procedure ignores them.
 */
export function turnControlMigration(schema: string): string {
    const s = `"${schema}"`;
    const schemaLiteral = `'${schema.replace(/'/g, "''")}'`;
    return `
-- 0082_turn_control

ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS turn_high INTEGER NOT NULL DEFAULT -1;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS turn_base_seq BIGINT NOT NULL DEFAULT 0;

-- ── Helpers ──────────────────────────────────────────────────────

-- The last event position before the session's current orchestration lifetime.
CREATE OR REPLACE FUNCTION ${s}.cms_turn_base_seq(p_session TEXT)
RETURNS BIGINT LANGUAGE sql STABLE AS $$
    SELECT COALESCE((SELECT x.turn_base_seq FROM ${s}.sessions x WHERE x.session_id = p_session), 0);
$$;

-- Open controls of one turn, in position order.
CREATE OR REPLACE FUNCTION ${s}.cms_turn_open_controls(p_session TEXT, p_turn INT)
RETURNS TABLE (seq BIGINT, kind TEXT, text TEXT, created_at TIMESTAMPTZ) LANGUAGE sql STABLE AS $$
    SELECT e.seq, substr(e.event_type, 6), e.data->>'text', e.created_at
      FROM ${s}.session_events e
     WHERE e.session_id = p_session
       AND e.event_type IN ('user.steer', 'user.stop')
       AND e.seq > ${s}.cms_turn_base_seq(p_session)
       AND (e.data->>'turn')::int = p_turn
       AND NOT EXISTS (SELECT 1 FROM ${s}.session_events o
                        WHERE o.session_id = p_session
                          AND o.event_type = 'session.control_outcome'
                          AND (o.data->>'seq')::bigint = e.seq)
     ORDER BY e.seq;
$$;

-- The open controls of one turn as a JSON array of {seq, kind, text, createdAt}.
CREATE OR REPLACE FUNCTION ${s}.cms_turn_open_controls_json(p_session TEXT, p_turn INT, p_after BIGINT DEFAULT 0)
RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'seq', c.seq, 'kind', c.kind, 'text', c.text, 'createdAt', c.created_at) ORDER BY c.seq), '[]'::jsonb)
      FROM ${s}.cms_turn_open_controls(p_session, p_turn) c
     WHERE c.seq > COALESCE(p_after, 0);
$$;

-- Whether a "stopped" outcome is recorded for the turn in this lifetime.
CREATE OR REPLACE FUNCTION ${s}.cms_turn_is_stopped(p_session TEXT, p_turn INT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM ${s}.session_events o
                    WHERE o.session_id = p_session
                      AND o.event_type = 'session.control_outcome'
                      AND o.seq > ${s}.cms_turn_base_seq(p_session)
                      AND (o.data->>'turn')::int = p_turn
                      AND o.data->>'outcome' = 'stopped');
$$;

-- Carried steers of this lifetime without a closing record, in position order.
CREATE OR REPLACE FUNCTION ${s}.cms_turn_unclosed_carried(p_session TEXT)
RETURNS TABLE (seq BIGINT) LANGUAGE sql STABLE AS $$
    SELECT e.seq
      FROM ${s}.session_events e
     WHERE e.session_id = p_session
       AND e.event_type = 'user.steer'
       AND e.seq > ${s}.cms_turn_base_seq(p_session)
       AND EXISTS (SELECT 1 FROM ${s}.session_events o
                    WHERE o.session_id = p_session
                      AND o.event_type = 'session.control_outcome'
                      AND (o.data->>'seq')::bigint = e.seq
                      AND o.data->>'outcome' = 'carried')
       AND NOT EXISTS (SELECT 1 FROM ${s}.session_events c
                        WHERE c.session_id = p_session
                          AND c.event_type = 'session.carried_steers_closed'
                          AND c.seq > ${s}.cms_turn_base_seq(p_session)
                          AND c.data->'seqs' @> to_jsonb(e.seq))
     ORDER BY e.seq;
$$;

-- Close everything the session still has open in this lifetime: every open
-- control (Stop → stopped, Steer → not_delivered) and every unclosed carried
-- steer (one closing record with p_reason). The caller holds the session row
-- lock. Writes nothing when nothing is open.
CREATE OR REPLACE FUNCTION ${s}.cms_turn_close_all(p_session TEXT, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_base BIGINT := ${s}.cms_turn_base_seq(p_session);
    v_iteration INT;
    v_seqs BIGINT[];
BEGIN
    INSERT INTO ${s}.session_events (session_id, event_type, data)
    SELECT p_session, 'session.control_outcome', jsonb_build_object(
               'seq', e.seq,
               'turn', (e.data->>'turn')::int,
               'outcome', CASE WHEN e.event_type = 'user.stop' THEN 'stopped' ELSE 'not_delivered' END)
      FROM ${s}.session_events e
     WHERE e.session_id = p_session
       AND e.event_type IN ('user.steer', 'user.stop')
       AND e.seq > v_base
       AND NOT EXISTS (SELECT 1 FROM ${s}.session_events o
                        WHERE o.session_id = p_session
                          AND o.event_type = 'session.control_outcome'
                          AND (o.data->>'seq')::bigint = e.seq)
     ORDER BY e.seq;

    SELECT array_agg(u.seq ORDER BY u.seq) INTO v_seqs FROM ${s}.cms_turn_unclosed_carried(p_session) u;
    IF v_seqs IS NOT NULL THEN
        SELECT x.current_iteration INTO v_iteration FROM ${s}.sessions x WHERE x.session_id = p_session;
        INSERT INTO ${s}.session_events (session_id, event_type, data)
        VALUES (p_session, 'session.carried_steers_closed', jsonb_build_object(
            'seqs', to_jsonb(v_seqs), 'turnIndex', COALESCE(v_iteration, 0), 'reason', p_reason));
    END IF;
END $$;

-- A new orchestration lifetime is about to start on a soft-deleted row
-- (system-session restart, or a revived session): close what the old
-- lifetime left open, then reset the turn columns and move the lifetime base
-- past every existing event. No-op for a live or missing row.
CREATE OR REPLACE FUNCTION ${s}.cms_turn_lifetime_reset(p_session TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_deleted TIMESTAMPTZ;
BEGIN
    SELECT x.deleted_at INTO v_deleted FROM ${s}.sessions x WHERE x.session_id = p_session FOR UPDATE;
    IF NOT FOUND OR v_deleted IS NULL THEN
        RETURN;
    END IF;
    PERFORM ${s}.cms_turn_close_all(p_session, 'terminal');
    UPDATE ${s}.sessions x
       SET turn_high = -1,
           active_turn_index = NULL,
           turn_base_seq = COALESCE((SELECT MAX(e.seq) FROM ${s}.session_events e WHERE e.session_id = p_session), x.turn_base_seq)
     WHERE x.session_id = p_session;
END $$;

-- ── 1. Client: add a Steer or a Stop ─────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_turn_control_add(
    p_session TEXT, p_kind TEXT, p_text TEXT, p_request_id TEXT, p_actor JSONB
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_active INT;
    v_high INT;
    v_base BIGINT;
    v_prior RECORD;
    v_seq BIGINT;
BEGIN
    IF p_kind NOT IN ('steer', 'stop') OR COALESCE(p_request_id, '') = '' THEN
        RAISE EXCEPTION 'invalid turn control';
    END IF;
    SELECT x.active_turn_index, x.turn_high, x.turn_base_seq INTO v_active, v_high, v_base
      FROM ${s}.sessions x
     WHERE x.session_id = p_session AND x.deleted_at IS NULL
       FOR UPDATE;
    IF NOT FOUND THEN
        RETURN '{"refused":"not_found"}'::jsonb;
    END IF;

    -- A retry with the same request id gets the first answer.
    SELECT e.seq, e.event_type, e.data INTO v_prior
      FROM ${s}.session_events e
     WHERE e.session_id = p_session
       AND e.event_type IN ('user.steer', 'user.stop')
       AND e.seq > v_base
       AND e.data->>'requestId' = p_request_id
     ORDER BY e.seq
     LIMIT 1;
    IF FOUND THEN
        IF v_prior.event_type <> 'user.' || p_kind OR (v_prior.data->>'text') IS DISTINCT FROM p_text THEN
            RETURN '{"refused":"request_id_reused"}'::jsonb;
        END IF;
        RETURN jsonb_build_object('seq', v_prior.seq, 'turn', v_prior.data->'turn', 'repeat', true);
    END IF;

    IF v_active IS NULL THEN
        RETURN '{"refused":"no_turn"}'::jsonb;
    END IF;
    IF v_high IS DISTINCT FROM v_active THEN
        RETURN '{"refused":"legacy_turn"}'::jsonb;
    END IF;
    IF (SELECT count(*) FROM ${s}.cms_turn_open_controls(p_session, v_active)) >= 20 THEN
        RETURN '{"refused":"too_many"}'::jsonb;
    END IF;

    INSERT INTO ${s}.session_events (session_id, event_type, data)
    VALUES (p_session, 'user.' || p_kind, jsonb_build_object(
        'turn', v_active, 'text', p_text, 'requestId', p_request_id, 'actor', COALESCE(p_actor, 'null'::jsonb)))
    RETURNING seq INTO v_seq;
    PERFORM pg_notify('pilotswarm_turn_control',
        json_build_object('schema', ${schemaLiteral}, 'sessionId', p_session)::text);
    RETURN jsonb_build_object('seq', v_seq, 'turn', v_active);
END $$;

-- ── 2. Worker T3: turn start ─────────────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_turn_start(p_session TEXT, p_turn INT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_high INT;
BEGIN
    SELECT x.turn_high INTO v_high FROM ${s}.sessions x WHERE x.session_id = p_session FOR UPDATE;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('stopped', false, 'controls', '[]'::jsonb);
    END IF;
    IF p_turn < v_high THEN
        RETURN '{"stale":true}'::jsonb;    -- a newer turn already started
    END IF;
    UPDATE ${s}.sessions x
       SET active_turn_index = p_turn, turn_high = p_turn, updated_at = now()
     WHERE x.session_id = p_session;
    RETURN jsonb_build_object(
        'stopped', ${s}.cms_turn_is_stopped(p_session, p_turn),
        'controls', ${s}.cms_turn_open_controls_json(p_session, p_turn, 0));
END $$;

-- ── 3. Worker: one look for all its running turns ────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_turn_look(p_turns JSONB)     -- [{session, turn, after}]
RETURNS TABLE (session_id TEXT, turn INT, controls JSONB) LANGUAGE sql STABLE AS $$
    SELECT t."session", t.turn, ${s}.cms_turn_open_controls_json(t."session", t.turn, t."after")
      FROM jsonb_to_recordset(COALESCE(p_turns, '[]'::jsonb)) AS t("session" TEXT, turn INT, "after" BIGINT);
$$;

-- ── 4. Worker T8: turn end ───────────────────────────────────────
-- After the save. Idempotent: every outcome is recomputed from the events.
-- p_result: 'stopped' | 'error' | 'other'. p_carried: the carried steers
-- folded into this turn; closed as stopped or ran unless the turn erred.

CREATE OR REPLACE FUNCTION ${s}.cms_turn_end(
    p_session TEXT, p_turn INT, p_cursor BIGINT, p_result TEXT, p_carried BIGINT[] DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_base BIGINT;
    v_stop_open BOOLEAN;
    v_close BIGINT[];
BEGIN
    SELECT x.turn_base_seq INTO v_base FROM ${s}.sessions x WHERE x.session_id = p_session FOR UPDATE;
    v_base := COALESCE(v_base, 0);
    v_stop_open := EXISTS (SELECT 1 FROM ${s}.cms_turn_open_controls(p_session, p_turn) c WHERE c.kind = 'stop');

    INSERT INTO ${s}.session_events (session_id, event_type, data)
    SELECT p_session, 'session.control_outcome', jsonb_build_object('seq', c.seq, 'turn', p_turn, 'outcome',
        CASE
            WHEN c.kind = 'stop' AND p_result IN ('stopped', 'error') THEN 'stopped'
            WHEN c.kind = 'stop'                                     THEN 'too_late'
            WHEN p_result = 'stopped'                                THEN 'not_delivered'
            WHEN c.seq <= COALESCE(p_cursor, 0)                      THEN 'delivered'
            WHEN v_stop_open                                         THEN 'not_delivered'
            ELSE 'carried'
        END)
      FROM ${s}.cms_turn_open_controls(p_session, p_turn) c
     ORDER BY c.seq;

    IF COALESCE(array_length(p_carried, 1), 0) > 0 AND p_result <> 'error' THEN
        SELECT array_agg(u.seq ORDER BY u.seq) INTO v_close
          FROM unnest(p_carried) AS u(seq)
         WHERE u.seq > v_base
           AND NOT EXISTS (SELECT 1 FROM ${s}.session_events c
                            WHERE c.session_id = p_session
                              AND c.event_type = 'session.carried_steers_closed'
                              AND c.seq > v_base
                              AND c.data->'seqs' @> to_jsonb(u.seq));
        IF v_close IS NOT NULL THEN
            INSERT INTO ${s}.session_events (session_id, event_type, data)
            VALUES (p_session, 'session.carried_steers_closed', jsonb_build_object(
                'seqs', to_jsonb(v_close), 'turnIndex', p_turn,
                'reason', CASE WHEN p_result = 'stopped' THEN 'stopped' ELSE 'ran' END));
        END IF;
    END IF;

    UPDATE ${s}.sessions x SET active_turn_index = NULL
     WHERE x.session_id = p_session AND x.active_turn_index = p_turn;

    RETURN jsonb_build_object(
        'stopped', ${s}.cms_turn_is_stopped(p_session, p_turn),
        'late', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('seq', e.seq, 'text', e.data->>'text') ORDER BY e.seq)
              FROM ${s}.session_events e
             WHERE e.session_id = p_session
               AND e.event_type = 'user.steer'
               AND e.seq > v_base
               AND (e.data->>'turn')::int = p_turn
               AND EXISTS (SELECT 1 FROM ${s}.session_events o
                            WHERE o.session_id = p_session
                              AND o.event_type = 'session.control_outcome'
                              AND (o.data->>'seq')::bigint = e.seq
                              AND o.data->>'outcome' = 'carried')), '[]'::jsonb));
END $$;

-- ── End-of-turn write: same 23 arguments, now reports open controls ──
-- PostgreSQL cannot change a return type in place: drop and recreate.
-- Older workers call it with SELECT and ignore the value.

DROP FUNCTION IF EXISTS ${s}.cms_complete_turn_writeback(
    TEXT, TEXT, TEXT, TEXT, INTEGER, TIMESTAMPTZ, TIMESTAMPTZ, INTEGER,
    BIGINT, BIGINT, BIGINT, BIGINT, INTEGER, INTEGER, TEXT[], TEXT, TEXT, TEXT,
    TEXT, TIMESTAMPTZ, TEXT, TEXT, INTEGER);

CREATE FUNCTION ${s}.cms_complete_turn_writeback(
    p_session_id         TEXT,
    p_agent_id           TEXT,
    p_model              TEXT,
    p_reasoning_effort   TEXT,
    p_turn_index         INTEGER,
    p_started_at         TIMESTAMPTZ,
    p_ended_at           TIMESTAMPTZ,
    p_duration_ms        INTEGER,
    p_tokens_input       BIGINT,
    p_tokens_output      BIGINT,
    p_tokens_cache_read  BIGINT,
    p_tokens_cache_write BIGINT,
    p_tool_calls         INTEGER,
    p_tool_errors        INTEGER,
    p_tool_names         TEXT[],
    p_result_type        TEXT,
    p_error_message      TEXT,
    p_worker_node_id     TEXT,
    p_state              TEXT,
    p_last_active_at     TIMESTAMPTZ,
    p_last_error         TEXT,
    p_wait_reason        TEXT,
    p_current_iteration  INTEGER
) RETURNS BOOLEAN AS $$
DECLARE
    v_reasoning_effort TEXT := NULLIF(BTRIM(p_reasoning_effort), '');
    v_ended_at TIMESTAMPTZ := COALESCE(p_ended_at, now());
    v_started_at TIMESTAMPTZ := COALESCE(p_started_at, v_ended_at);
    v_duration_ms INTEGER := GREATEST(0, COALESCE(p_duration_ms, FLOOR(EXTRACT(EPOCH FROM (v_ended_at - v_started_at)) * 1000)::INT));
BEGIN
    UPDATE ${s}.sessions
    SET state = COALESCE(p_state, state),
        last_active_at = COALESCE(p_last_active_at, v_ended_at),
        current_iteration = COALESCE(p_current_iteration, current_iteration),
        last_error = p_last_error,
        wait_reason = p_wait_reason,
        active_turn_index = NULL,
        updated_at = now()
    WHERE session_id = p_session_id;

    INSERT INTO ${s}.session_metrics (
        session_id, agent_id, model, reasoning_effort,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write
    ) VALUES (
        p_session_id, p_agent_id, p_model, v_reasoning_effort,
        COALESCE(p_tokens_input, 0), COALESCE(p_tokens_output, 0),
        COALESCE(p_tokens_cache_read, 0), COALESCE(p_tokens_cache_write, 0)
    )
    ON CONFLICT (session_id) DO UPDATE SET
        agent_id = COALESCE(${s}.session_metrics.agent_id, EXCLUDED.agent_id),
        model = COALESCE(EXCLUDED.model, ${s}.session_metrics.model),
        reasoning_effort = COALESCE(EXCLUDED.reasoning_effort, ${s}.session_metrics.reasoning_effort),
        tokens_input = ${s}.session_metrics.tokens_input + EXCLUDED.tokens_input,
        tokens_output = ${s}.session_metrics.tokens_output + EXCLUDED.tokens_output,
        tokens_cache_read = ${s}.session_metrics.tokens_cache_read + EXCLUDED.tokens_cache_read,
        tokens_cache_write = ${s}.session_metrics.tokens_cache_write + EXCLUDED.tokens_cache_write,
        updated_at = now();

    INSERT INTO ${s}.session_turn_metrics (
        session_id, agent_id, model, reasoning_effort, turn_index,
        started_at, ended_at, duration_ms,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
        tool_calls, tool_errors, result_type, error_message, worker_node_id
    ) VALUES (
        p_session_id, p_agent_id, p_model, v_reasoning_effort, COALESCE(p_turn_index, 0),
        v_started_at, v_ended_at, v_duration_ms,
        COALESCE(p_tokens_input, 0), COALESCE(p_tokens_output, 0),
        COALESCE(p_tokens_cache_read, 0), COALESCE(p_tokens_cache_write, 0),
        COALESCE(p_tool_calls, 0), COALESCE(p_tool_errors, 0),
        p_result_type, p_error_message, p_worker_node_id
    );

    INSERT INTO ${s}.session_events (session_id, event_type, data, worker_node_id)
    VALUES (
        p_session_id,
        'session.turn_completed',
        jsonb_build_object(
            'iteration', COALESCE(p_turn_index, 0),
            'turnIndex', COALESCE(p_turn_index, 0),
            'model', p_model,
            'reasoningEffort', v_reasoning_effort,
            'startedAt', v_started_at,
            'endedAt', v_ended_at,
            'durationMs', v_duration_ms,
            'tokensInput', COALESCE(p_tokens_input, 0),
            'tokensOutput', COALESCE(p_tokens_output, 0),
            'tokensCacheRead', COALESCE(p_tokens_cache_read, 0),
            'tokensCacheWrite', COALESCE(p_tokens_cache_write, 0),
            'toolCalls', COALESCE(p_tool_calls, 0),
            'toolErrors', COALESCE(p_tool_errors, 0),
            'toolNames', to_jsonb(COALESCE(p_tool_names, ARRAY[]::TEXT[])),
            'resultType', p_result_type,
            'errorMessage', p_error_message,
            'workerNodeId', p_worker_node_id
        ),
        p_worker_node_id
    );

    -- Turn control: checked after the UPDATE above took the row lock, so a
    -- control added just before is seen and none can be added after.
    RETURN EXISTS (SELECT 1 FROM ${s}.cms_turn_open_controls(p_session_id, COALESCE(p_turn_index, 0)));
END;
$$ LANGUAGE plpgsql;

-- ── cms_update_session: closing rules ────────────────────────────
-- Same signature and body as 0059, plus: closeControls (give-up) closes
-- every open control and unclosed carried steer with reason gave_up; a
-- terminal state (completed, failed, cancelled) closes them with reason
-- terminal, whoever writes it.

CREATE OR REPLACE FUNCTION ${s}.cms_update_session(
    p_session_id TEXT,
    p_updates JSONB
) RETURNS VOID AS $$
BEGIN
    UPDATE ${s}.sessions SET
        orchestration_id  = CASE WHEN p_updates ? 'orchestrationId'  THEN (p_updates->>'orchestrationId') ELSE orchestration_id END,
        title             = CASE WHEN p_updates ? 'title'            THEN (p_updates->>'title') ELSE title END,
        title_locked      = CASE WHEN p_updates ? 'titleLocked'      THEN (p_updates->>'titleLocked')::BOOLEAN ELSE title_locked END,
        state             = CASE WHEN p_updates ? 'state'            THEN (p_updates->>'state') ELSE state END,
        model             = CASE WHEN p_updates ? 'model'            THEN (p_updates->>'model') ELSE model END,
        reasoning_effort  = CASE WHEN p_updates ? 'reasoningEffort'  THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '') ELSE reasoning_effort END,
        context_tier      = CASE WHEN p_updates ? 'contextTier'      THEN NULLIF(BTRIM(p_updates->>'contextTier'), '') ELSE context_tier END,
        model_resolution_source = CASE WHEN p_updates ? 'modelResolutionSource' THEN NULLIF(BTRIM(p_updates->>'modelResolutionSource'), '') ELSE model_resolution_source END,
        last_active_at    = CASE WHEN p_updates ? 'lastActiveAt'     THEN (p_updates->>'lastActiveAt')::TIMESTAMPTZ ELSE last_active_at END,
        current_iteration = CASE WHEN p_updates ? 'currentIteration' THEN (p_updates->>'currentIteration')::INT ELSE current_iteration END,
        last_error        = CASE WHEN p_updates ? 'lastError'        THEN (p_updates->>'lastError') ELSE last_error END,
        wait_reason       = CASE WHEN p_updates ? 'waitReason'       THEN (p_updates->>'waitReason') ELSE wait_reason END,
        is_system         = CASE WHEN p_updates ? 'isSystem'         THEN (p_updates->>'isSystem')::BOOLEAN ELSE is_system END,
        agent_id          = CASE WHEN p_updates ? 'agentId'          THEN (p_updates->>'agentId') ELSE agent_id END,
        splash            = CASE WHEN p_updates ? 'splash'           THEN (p_updates->>'splash') ELSE splash END,
        splash_mobile     = CASE WHEN p_updates ? 'splashMobile'     THEN (p_updates->>'splashMobile') ELSE splash_mobile END,
        active_turn_index = CASE WHEN (p_updates ? 'state') AND (p_updates->>'state') <> 'running' THEN NULL ELSE active_turn_index END,
        updated_at        = now()
    WHERE session_id = p_session_id;

    UPDATE ${s}.session_metrics
       SET model = CASE WHEN p_updates ? 'model' THEN (p_updates->>'model') ELSE model END,
           reasoning_effort = CASE WHEN p_updates ? 'reasoningEffort' THEN NULLIF(BTRIM(p_updates->>'reasoningEffort'), '') ELSE reasoning_effort END,
           updated_at = CASE WHEN p_updates ? 'model' OR p_updates ? 'reasoningEffort' THEN now() ELSE updated_at END
     WHERE session_id = p_session_id
       AND (p_updates ? 'model' OR p_updates ? 'reasoningEffort');

    IF p_updates ? 'closeControls' AND (p_updates->>'closeControls') = 'true' THEN
        PERFORM ${s}.cms_turn_close_all(p_session_id, 'gave_up');
    ELSIF (p_updates ? 'state') AND (p_updates->>'state') IN ('completed', 'failed', 'cancelled') THEN
        PERFORM ${s}.cms_turn_close_all(p_session_id, 'terminal');
    END IF;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- ── System-session restart archive: also resets the turn columns ──
-- Same signature and body as 0017, plus the three turn-control columns.

CREATE OR REPLACE FUNCTION ${s}.cms_archive_system_session_for_restart(
    p_session_id TEXT,
    p_state      TEXT,
    p_last_error TEXT DEFAULT NULL
) RETURNS VOID AS $$
DECLARE
    v_is_system BOOLEAN;
BEGIN
    SELECT is_system INTO v_is_system
    FROM ${s}.sessions
    WHERE session_id = p_session_id
      AND deleted_at IS NULL;

    IF NOT FOUND THEN
        RETURN;
    END IF;

    IF NOT v_is_system THEN
        RAISE EXCEPTION 'Cannot archive non-system session for system restart';
    END IF;

    IF p_state NOT IN ('completed', 'cancelled', 'failed') THEN
        RAISE EXCEPTION 'Invalid system restart archive state: %', p_state;
    END IF;

    DELETE FROM ${s}.session_events
    WHERE session_id = p_session_id;

    DELETE FROM ${s}.session_turn_metrics
    WHERE session_id = p_session_id;

    DELETE FROM ${s}.session_metric_summaries
    WHERE session_id = p_session_id;

    DELETE FROM ${s}.session_child_outcomes
    WHERE child_session_id = p_session_id
       OR parent_session_id = p_session_id;

    UPDATE ${s}.sessions
    SET state             = p_state,
        last_error        = p_last_error,
        wait_reason       = NULL,
        orchestration_id  = NULL,
        last_active_at    = NULL,
        current_iteration = 0,
        short_summary     = NULL,
        summary_state     = NULL,
        summary_updated_at = NULL,
        active_turn_index = NULL,
        turn_high         = -1,
        turn_base_seq     = 0,
        deleted_at        = now(),
        updated_at        = now()
    WHERE session_id = p_session_id;
END;
$$ LANGUAGE plpgsql;

${reviveOverloads(s)}

-- ── Feature flag: sessions.steering ──────────────────────────────

INSERT INTO ${s}.feature_flags (feature_key, display_name, description, default_enabled, default_allow_user_override, required_capability)
VALUES ('sessions.steering', 'Steer running turns',
        'Let people add guidance to a running turn that the model receives at its next model call. Stop does not depend on this flag. The operator enables it; users may override it only when the operator allows.',
        false, false, NULL)
ON CONFLICT (feature_key) DO NOTHING;
INSERT INTO ${s}.feature_flag_settings (feature_key, scope, user_id, enabled, allow_user_override, revision, updated_by)
SELECT feature_key, 'cluster', NULL, false, false, revision, 'migration:0082'
FROM ${s}.feature_flags WHERE feature_key = 'sessions.steering'
ON CONFLICT (feature_key) WHERE scope = 'cluster' DO NOTHING;
`;
}

/**
 * The revivable cms_create_session overloads that write the row themselves
 * (6, 8, 9 and 10 arguments; the 7-argument overload delegates to the
 * 8-argument one). Each keeps its latest body (0004, 0022, 0026 and 0034)
 * and first calls cms_turn_lifetime_reset, which acts only when the row is
 * about to be revived.
 */
function reviveOverloads(s: string): string {
    return `
-- ── cms_create_session overloads: lifetime reset before a revive ──

-- 6 arguments (body: 0004)
CREATE OR REPLACE FUNCTION ${s}.cms_create_session(
    p_session_id        TEXT,
    p_model             TEXT,
    p_parent_session_id TEXT,
    p_is_system         BOOLEAN,
    p_agent_id          TEXT,
    p_splash            TEXT
) RETURNS VOID AS $$
BEGIN
    PERFORM ${s}.cms_turn_lifetime_reset(p_session_id);

    INSERT INTO ${s}.sessions
        (session_id, model, parent_session_id, is_system, agent_id, splash)
    VALUES
        (p_session_id, p_model, p_parent_session_id, p_is_system, p_agent_id, p_splash)
    ON CONFLICT (session_id) DO UPDATE
    SET model             = EXCLUDED.model,
        parent_session_id = EXCLUDED.parent_session_id,
        is_system         = EXCLUDED.is_system,
        agent_id          = EXCLUDED.agent_id,
        splash            = EXCLUDED.splash,
        deleted_at        = NULL,
        updated_at        = now(),
        state             = 'pending',
        orchestration_id  = NULL,
        last_error        = NULL,
        last_active_at    = NULL,
        current_iteration = 0,
        wait_reason       = NULL,
        title_locked      = FALSE
    WHERE ${s}.sessions.deleted_at IS NOT NULL;

    -- Seed zeroed metric summary row
    INSERT INTO ${s}.session_metric_summaries
        (session_id, agent_id, model, parent_session_id)
    VALUES
        (p_session_id, p_agent_id, p_model, p_parent_session_id)
    ON CONFLICT (session_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql;

-- 8 arguments (body: 0022)
CREATE OR REPLACE FUNCTION ${s}.cms_create_session(
    p_session_id        TEXT,
    p_model             TEXT,
    p_reasoning_effort  TEXT,
    p_parent_session_id TEXT,
    p_is_system         BOOLEAN,
    p_agent_id          TEXT,
    p_splash            TEXT,
    p_group_id          TEXT
) RETURNS VOID AS $$
DECLARE
    v_reasoning_effort TEXT := NULLIF(BTRIM(p_reasoning_effort), '');
    v_group_id TEXT := NULLIF(BTRIM(p_group_id), '');
BEGIN
    PERFORM ${s}.cms_turn_lifetime_reset(p_session_id);

    IF v_group_id IS NULL AND p_parent_session_id IS NOT NULL THEN
        SELECT group_id INTO v_group_id
        FROM ${s}.sessions
        WHERE session_id = p_parent_session_id;
    END IF;

    INSERT INTO ${s}.sessions
        (session_id, model, reasoning_effort, parent_session_id, is_system, agent_id, splash, group_id)
    VALUES
        (p_session_id, p_model, v_reasoning_effort, p_parent_session_id, p_is_system, p_agent_id, p_splash, v_group_id)
    ON CONFLICT (session_id) DO UPDATE
    SET model             = EXCLUDED.model,
        reasoning_effort  = EXCLUDED.reasoning_effort,
        parent_session_id = EXCLUDED.parent_session_id,
        is_system         = EXCLUDED.is_system,
        agent_id          = EXCLUDED.agent_id,
        splash            = EXCLUDED.splash,
        group_id          = EXCLUDED.group_id,
        deleted_at        = NULL,
        updated_at        = now(),
        state             = 'pending',
        orchestration_id  = NULL,
        last_error        = NULL,
        last_active_at    = NULL,
        current_iteration = 0,
        wait_reason       = NULL,
        title_locked      = FALSE
    WHERE ${s}.sessions.deleted_at IS NOT NULL;

    INSERT INTO ${s}.session_metrics
        (session_id, agent_id, model, reasoning_effort, parent_session_id)
    VALUES
        (p_session_id, p_agent_id, p_model, v_reasoning_effort, p_parent_session_id)
    ON CONFLICT (session_id) DO UPDATE
    SET agent_id          = COALESCE(${s}.session_metrics.agent_id, EXCLUDED.agent_id),
        model             = COALESCE(${s}.session_metrics.model, EXCLUDED.model),
        reasoning_effort  = COALESCE(${s}.session_metrics.reasoning_effort, EXCLUDED.reasoning_effort),
        parent_session_id = COALESCE(${s}.session_metrics.parent_session_id, EXCLUDED.parent_session_id),
        updated_at        = now();
END;
$$ LANGUAGE plpgsql;

-- 9 arguments (body: 0026)
CREATE OR REPLACE FUNCTION ${s}.cms_create_session(
    p_session_id        TEXT,
    p_model             TEXT,
    p_reasoning_effort  TEXT,
    p_parent_session_id TEXT,
    p_is_system         BOOLEAN,
    p_agent_id          TEXT,
    p_splash            TEXT,
    p_group_id          TEXT,
    p_splash_mobile     TEXT
) RETURNS VOID AS $$
DECLARE
    v_reasoning_effort TEXT := NULLIF(BTRIM(p_reasoning_effort), '');
    v_group_id TEXT := NULLIF(BTRIM(p_group_id), '');
BEGIN
    PERFORM ${s}.cms_turn_lifetime_reset(p_session_id);

    IF v_group_id IS NULL AND p_parent_session_id IS NOT NULL THEN
        SELECT group_id INTO v_group_id
        FROM ${s}.sessions
        WHERE session_id = p_parent_session_id;
    END IF;

    INSERT INTO ${s}.sessions
        (session_id, model, reasoning_effort, parent_session_id, is_system, agent_id, splash, splash_mobile, group_id)
    VALUES
        (p_session_id, p_model, v_reasoning_effort, p_parent_session_id, p_is_system, p_agent_id, p_splash, p_splash_mobile, v_group_id)
    ON CONFLICT (session_id) DO UPDATE
    SET model             = EXCLUDED.model,
        reasoning_effort  = EXCLUDED.reasoning_effort,
        parent_session_id = EXCLUDED.parent_session_id,
        is_system         = EXCLUDED.is_system,
        agent_id          = EXCLUDED.agent_id,
        splash            = EXCLUDED.splash,
        splash_mobile     = EXCLUDED.splash_mobile,
        group_id          = EXCLUDED.group_id,
        deleted_at        = NULL,
        updated_at        = now(),
        state             = 'pending',
        orchestration_id  = NULL,
        last_error        = NULL,
        last_active_at    = NULL,
        current_iteration = 0,
        wait_reason       = NULL,
        title_locked      = FALSE
    WHERE ${s}.sessions.deleted_at IS NOT NULL;

    INSERT INTO ${s}.session_metric_summaries
        (session_id, agent_id, model, reasoning_effort, parent_session_id)
    VALUES
        (p_session_id, p_agent_id, p_model, v_reasoning_effort, p_parent_session_id)
    ON CONFLICT (session_id) DO UPDATE
    SET agent_id          = COALESCE(${s}.session_metric_summaries.agent_id, EXCLUDED.agent_id),
        model             = COALESCE(${s}.session_metric_summaries.model, EXCLUDED.model),
        reasoning_effort  = COALESCE(${s}.session_metric_summaries.reasoning_effort, EXCLUDED.reasoning_effort),
        parent_session_id = COALESCE(${s}.session_metric_summaries.parent_session_id, EXCLUDED.parent_session_id),
        updated_at        = now();
END;
$$ LANGUAGE plpgsql;

-- 10 arguments (body: 0034)
CREATE OR REPLACE FUNCTION ${s}.cms_create_session(
    p_session_id        TEXT,
    p_model             TEXT,
    p_reasoning_effort  TEXT,
    p_parent_session_id TEXT,
    p_is_system         BOOLEAN,
    p_agent_id          TEXT,
    p_splash            TEXT,
    p_group_id          TEXT,
    p_splash_mobile     TEXT,
    p_visibility        TEXT
) RETURNS VOID AS $$
DECLARE
    v_reasoning_effort TEXT := NULLIF(BTRIM(p_reasoning_effort), '');
    v_root TEXT;
    v_visibility TEXT := CASE
        WHEN p_visibility IN ('private', 'shared_read', 'shared_write') THEN p_visibility
        ELSE 'private'
    END;
BEGIN
    PERFORM ${s}.cms_turn_lifetime_reset(p_session_id);

    IF p_parent_session_id IS NOT NULL THEN
        SELECT COALESCE(parent.root_session_id, parent.session_id)
        INTO v_root
        FROM ${s}.sessions parent
        WHERE parent.session_id = p_parent_session_id;
    END IF;
    v_root := COALESCE(v_root, p_session_id);

    INSERT INTO ${s}.sessions
        (session_id, model, reasoning_effort, parent_session_id, is_system, agent_id, splash, splash_mobile, root_session_id, visibility)
    VALUES
        (p_session_id, p_model, v_reasoning_effort, p_parent_session_id, p_is_system, p_agent_id, p_splash, p_splash_mobile, v_root, v_visibility)
    ON CONFLICT (session_id) DO UPDATE
    SET model             = EXCLUDED.model,
        reasoning_effort  = EXCLUDED.reasoning_effort,
        parent_session_id = EXCLUDED.parent_session_id,
        is_system         = EXCLUDED.is_system,
        agent_id          = EXCLUDED.agent_id,
        splash            = EXCLUDED.splash,
        splash_mobile     = EXCLUDED.splash_mobile,
        root_session_id   = EXCLUDED.root_session_id,
        visibility        = EXCLUDED.visibility,
        deleted_at        = NULL,
        updated_at        = now(),
        state             = 'pending',
        orchestration_id  = NULL,
        last_error        = NULL,
        last_active_at    = NULL,
        current_iteration = 0,
        wait_reason       = NULL,
        title_locked      = FALSE
    WHERE ${s}.sessions.deleted_at IS NOT NULL;

    INSERT INTO ${s}.session_metric_summaries
        (session_id, agent_id, model, reasoning_effort, parent_session_id)
    VALUES
        (p_session_id, p_agent_id, p_model, v_reasoning_effort, p_parent_session_id)
    ON CONFLICT (session_id) DO UPDATE
    SET agent_id          = COALESCE(${s}.session_metric_summaries.agent_id, EXCLUDED.agent_id),
        model             = COALESCE(${s}.session_metric_summaries.model, EXCLUDED.model),
        reasoning_effort  = COALESCE(${s}.session_metric_summaries.reasoning_effort, EXCLUDED.reasoning_effort),
        parent_session_id = COALESCE(${s}.session_metric_summaries.parent_session_id, EXCLUDED.parent_session_id),
        updated_at        = now();
END;
$$ LANGUAGE plpgsql;
`;
}
