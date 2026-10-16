/**
 * Migration 0083 — convert a queued message to a steer.
 * See docs/proposals/session-turn-control.md ("Convert a queued message")
 * and migrations/0083_diff.md.
 *
 * - Turn start records the turn's prompt in its own transaction, so a prompt
 *   is recorded before its turn can accept any control (replaces the 0082
 *   two-argument signature).
 * - A steer may name the queued message it replaces
 *   (`replacesClientMessageId`). It is refused `already_received` when that
 *   message is recorded, repeats its first answer for the same message while
 *   it is open or delivered, and is never carried.
 * - Turn end reports the replaced messages of delivered converted steers.
 */
export function turnControlConvertMigration(schema: string): string {
    const s = `"${schema}"`;
    const schemaLiteral = `'${schema.replace(/'/g, "''")}'`;
    return `
-- 0083_turn_control_convert

-- A turn that an 0082 worker started has no atomic prompt record. Clear its
-- running mark (turn_high stays): it accepts no control until its retry
-- passes the new turn start, which records the prompt. Legacy turns
-- (turn_high -1) keep theirs.
UPDATE ${s}.sessions
   SET active_turn_index = NULL
 WHERE active_turn_index IS NOT NULL
   AND turn_high = active_turn_index;

-- Whether a prompt record of the session (any lifetime) holds one of the ids.
CREATE OR REPLACE FUNCTION ${s}.cms_prompt_holds_any(p_session TEXT, p_ids JSONB)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM ${s}.session_events e
                    WHERE e.session_id = p_session
                      AND e.event_type IN ('user.message', 'system.message')
                      AND jsonb_typeof(e.data->'clientMessageIds') = 'array'
                      AND e.data->'clientMessageIds' ?| ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_ids, '[]'::jsonb))));
$$;

-- The replaced messages of the turn's delivered converted steers, in
-- position order. A NULL turn means the session's latest started turn.
CREATE OR REPLACE FUNCTION ${s}.cms_turn_replaced(p_session TEXT, p_turn INT DEFAULT NULL)
RETURNS TEXT[] LANGUAGE sql STABLE AS $$
    SELECT COALESCE(array_agg(e.data->>'replacesClientMessageId' ORDER BY e.seq), ARRAY[]::TEXT[])
      FROM ${s}.session_events e
     WHERE e.session_id = p_session
       AND e.event_type = 'user.steer'
       AND e.seq > ${s}.cms_turn_base_seq(p_session)
       AND e.data ? 'replacesClientMessageId'
       AND (e.data->>'turn')::int = COALESCE(p_turn, (SELECT x.turn_high FROM ${s}.sessions x WHERE x.session_id = p_session))
       AND EXISTS (SELECT 1 FROM ${s}.session_events o
                    WHERE o.session_id = p_session
                      AND o.event_type = 'session.control_outcome'
                      AND (o.data->>'seq')::bigint = e.seq
                      AND o.data->>'outcome' = 'delivered');
$$;

-- ── Turn start: records the turn's prompt ────────────────────────
-- 0082 and 0083 ship together; a worker that calls the two-argument form
-- must be stopped before this migration runs.

DROP FUNCTION IF EXISTS ${s}.cms_turn_start(TEXT, INT);

-- p_records: [{eventType, data}], in order. A record with clientMessageIds
-- is inserted whenever no prompt record holds one of its ids (this repairs a
-- started turn whose record is missing); a record without ids only on the
-- turn's first start.
CREATE OR REPLACE FUNCTION ${s}.cms_turn_start(p_session TEXT, p_turn INT, p_records JSONB, p_worker TEXT)
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
    INSERT INTO ${s}.session_events (session_id, event_type, data, worker_node_id)
    SELECT p_session, r.rec->>'eventType', r.rec->'data', p_worker
      FROM jsonb_array_elements(COALESCE(p_records, '[]'::jsonb)) WITH ORDINALITY AS r(rec, ord)
     WHERE CASE WHEN jsonb_typeof(r.rec->'data'->'clientMessageIds') = 'array'
                     AND jsonb_array_length(r.rec->'data'->'clientMessageIds') > 0
                THEN NOT ${s}.cms_prompt_holds_any(p_session, r.rec->'data'->'clientMessageIds')
                ELSE p_turn > v_high
           END
     ORDER BY r.ord;
    UPDATE ${s}.sessions x
       SET active_turn_index = p_turn, turn_high = p_turn, updated_at = now()
     WHERE x.session_id = p_session;
    RETURN jsonb_build_object(
        'stopped', ${s}.cms_turn_is_stopped(p_session, p_turn),
        'controls', ${s}.cms_turn_open_controls_json(p_session, p_turn, 0));
END $$;

-- ── Client: add a Steer or a Stop, optionally replacing a queued message ──

DROP FUNCTION IF EXISTS ${s}.cms_turn_control_add(TEXT, TEXT, TEXT, TEXT, JSONB, BOOLEAN);

CREATE OR REPLACE FUNCTION ${s}.cms_turn_control_add(
    p_session TEXT, p_kind TEXT, p_text TEXT, p_request_id TEXT, p_actor JSONB,
    p_steering_allowed BOOLEAN DEFAULT true, p_replaces TEXT DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    v_active INT;
    v_high INT;
    v_base BIGINT;
    v_prior RECORD;
    v_seq BIGINT;
    v_replaces TEXT := NULLIF(p_replaces, '');
BEGIN
    IF p_kind NOT IN ('steer', 'stop') OR COALESCE(p_request_id, '') = ''
       OR (v_replaces IS NOT NULL AND p_kind <> 'steer') THEN
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
        IF v_prior.event_type <> 'user.' || p_kind OR (v_prior.data->>'text') IS DISTINCT FROM p_text
           OR (v_prior.data->>'replacesClientMessageId') IS DISTINCT FROM v_replaces THEN
            RETURN '{"refused":"request_id_reused"}'::jsonb;
        END IF;
        RETURN jsonb_build_object('seq', v_prior.seq, 'turn', v_prior.data->'turn', 'repeat', true);
    END IF;

    -- The same queued message while its steer is open or delivered: the first answer.
    IF v_replaces IS NOT NULL THEN
        SELECT e.seq, e.data INTO v_prior
          FROM ${s}.session_events e
         WHERE e.session_id = p_session
           AND e.event_type = 'user.steer'
           AND e.seq > v_base
           AND e.data->>'replacesClientMessageId' = v_replaces
           AND NOT EXISTS (SELECT 1 FROM ${s}.session_events o
                            WHERE o.session_id = p_session
                              AND o.event_type = 'session.control_outcome'
                              AND (o.data->>'seq')::bigint = e.seq
                              AND o.data->>'outcome' <> 'delivered')
         ORDER BY e.seq
         LIMIT 1;
        IF FOUND THEN
            RETURN jsonb_build_object('seq', v_prior.seq, 'turn', v_prior.data->'turn', 'repeat', true);
        END IF;
    END IF;

    IF p_kind = 'steer' AND NOT COALESCE(p_steering_allowed, true) THEN
        RETURN '{"refused":"steering_disabled"}'::jsonb;
    END IF;

    -- The queued message already reached a turn (or the stash): nothing to replace.
    IF v_replaces IS NOT NULL AND ${s}.cms_prompt_holds_any(p_session, jsonb_build_array(v_replaces)) THEN
        RETURN '{"refused":"already_received"}'::jsonb;
    END IF;

    IF v_active IS NULL THEN
        RETURN '{"refused":"no_turn"}'::jsonb;
    END IF;
    IF v_high IS DISTINCT FROM v_active THEN
        RETURN '{"refused":"legacy_turn"}'::jsonb;
    END IF;
    IF p_kind = 'steer' AND (SELECT count(*) FROM ${s}.cms_turn_open_controls(p_session, v_active)) >= 20 THEN
        RETURN '{"refused":"too_many"}'::jsonb;
    END IF;

    INSERT INTO ${s}.session_events (session_id, event_type, data)
    VALUES (p_session, 'user.' || p_kind, jsonb_build_object(
        'turn', v_active, 'text', p_text, 'requestId', p_request_id, 'actor', COALESCE(p_actor, 'null'::jsonb))
        || CASE WHEN v_replaces IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('replacesClientMessageId', v_replaces) END)
    RETURNING seq INTO v_seq;
    PERFORM pg_notify('pilotswarm_turn_control',
        json_build_object('schema', ${schemaLiteral}, 'sessionId', p_session)::text);
    RETURN jsonb_build_object('seq', v_seq, 'turn', v_active);
END $$;

-- ── Worker T8: turn end ──────────────────────────────────────────
-- Same as 0082, plus: a converted steer is never carried (after the cursor
-- it is not_delivered, so its queued message runs in its place), and the
-- answer carries the replaced messages of the turn's delivered converted steers.

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
            WHEN EXISTS (SELECT 1 FROM ${s}.session_events e
                          WHERE e.session_id = p_session AND e.seq = c.seq
                            AND e.data ? 'replacesClientMessageId')  THEN 'not_delivered'
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
                              AND o.data->>'outcome' = 'carried')), '[]'::jsonb),
        'replaced', to_jsonb(${s}.cms_turn_replaced(p_session, p_turn)));
END $$;
`;
}
