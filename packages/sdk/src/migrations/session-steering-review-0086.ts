/**
 * Migration 0086: fixes from the independent review of the steering runtime.
 * 0082-0085 are frozen; every procedure below replaces an earlier one.
 *
 * F02 (lock order) and F03 (lease fence):
 *   `cms_steer_claim` and `cms_steer_mark_submitting` take the session's
 *   steering advisory lock first, like every closing procedure, so a Stop or
 *   finalize can never form a row-lock cycle with a hand-off (40P01). Both
 *   check the window lease against clock_timestamp() AFTER their locks are
 *   held: a row claimed before expiry can no longer get a write-ahead attempt
 *   once the lease has expired.
 *
 * F06 (honest recovery timing): a recovery check that finds the steer in the
 *   conversation carries the delivery kind the CLI recorded with it. Known kind:
 *   steering ⇒ delivered_current_turn, queued/idle ⇒ delivered_after_response,
 *   and the attempt keeps that kind. Unknown kind: the new disposition
 *   delivered_timing_unconfirmed. Inclusion stays a separate fact. Closure no
 *   longer turns a delivered attempt with no kind into delivered_current_turn,
 *   and Stop never overrides delivered_timing_unconfirmed (it is terminal).
 *
 * F12: `cms_steer_list_recent` reads the newest receipts first (tuner diagnostics).
 * F18: `cms_steer_capabilities` replaces the inline to_regprocedure probe.
 */
export function sessionSteeringReviewMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_steer_claim(p_session_id TEXT, p_owner TEXT, p_limit INT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE w RECORD; v_ids TEXT[] := '{}'; v_id TEXT;
BEGIN
    -- Same lock order as closure: session advisory lock, then rows.
    PERFORM ${s}.cms_steer_lock_session(p_session_id);
    SELECT * INTO w FROM ${s}.session_steering_windows
     WHERE session_id = p_session_id AND state = 'open' AND owner_token = p_owner
       AND lease_expires_at > clock_timestamp() FOR SHARE;
    IF NOT FOUND THEN RETURN '[]'::JSONB; END IF;
    FOR v_id IN
        WITH c AS (
            SELECT request_id FROM ${s}.session_steering_requests
             WHERE session_id = p_session_id AND transcript_epoch = w.transcript_epoch
               AND turn_index = w.turn_index AND incarnation = w.incarnation
               AND (status = 'pending'
                    OR (status = 'orphaned' AND (recovery_check IS NULL OR recovery_check = 'absent')))
             ORDER BY seq
             LIMIT GREATEST(COALESCE(p_limit, 1), 0)
             FOR UPDATE SKIP LOCKED)
        UPDATE ${s}.session_steering_requests r
           SET status = 'claimed', owner_token = p_owner, claimed_at = now(), revision = r.revision + 1
          FROM c WHERE r.request_id = c.request_id
        RETURNING r.request_id
    LOOP
        v_ids := v_ids || v_id;
        PERFORM ${s}.cms_steer_record_event(p_session_id, 'session.steering_updated', v_id);
    END LOOP;
    RETURN (SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'requestId', r.request_id, 'sequence', r.seq, 'text', r.content,
               'actor', r.actor,
               'redelivery', EXISTS (SELECT 1 FROM ${s}.session_steering_attempts a
                                      WHERE a.request_id = r.request_id AND a.delivered_at IS NOT NULL))
               ORDER BY r.seq), '[]'::JSONB)
      FROM ${s}.session_steering_requests r WHERE r.request_id = ANY(v_ids));
END $$;

-- Write-ahead marker (D-29): committed BEFORE send(). The final durable hand-off fence:
-- open window, same owner, lease fresh at clock_timestamp() after the locks, row claimed by owner.
CREATE OR REPLACE FUNCTION ${s}.cms_steer_mark_submitting(p_request_id TEXT, p_owner TEXT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE r RECORD; v_attempt TEXT; v_no INT;
BEGIN
    SELECT * INTO r FROM ${s}.session_steering_requests WHERE request_id = p_request_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    PERFORM ${s}.cms_steer_lock_session(r.session_id);
    PERFORM 1 FROM ${s}.session_steering_windows
     WHERE session_id = r.session_id AND transcript_epoch = r.transcript_epoch AND turn_index = r.turn_index
       AND incarnation = r.incarnation AND state = 'open' AND owner_token = p_owner FOR SHARE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT * INTO r FROM ${s}.session_steering_requests WHERE request_id = p_request_id FOR UPDATE;
    IF r.status <> 'claimed' OR r.owner_token IS DISTINCT FROM p_owner THEN RETURN NULL; END IF;
    -- Lease checked last, with the current time, after every lock is held.
    IF NOT EXISTS (SELECT 1 FROM ${s}.session_steering_windows
                    WHERE session_id = r.session_id AND transcript_epoch = r.transcript_epoch
                      AND turn_index = r.turn_index AND incarnation = r.incarnation
                      AND state = 'open' AND owner_token = p_owner
                      AND lease_expires_at > clock_timestamp()) THEN
        RETURN NULL;
    END IF;
    SELECT COALESCE(max(attempt_no), 0) + 1 INTO v_no FROM ${s}.session_steering_attempts WHERE request_id = p_request_id;
    v_attempt := gen_random_uuid()::TEXT;
    INSERT INTO ${s}.session_steering_attempts (attempt_id, request_id, session_id, attempt_no, owner_token, turn_key, submitting_at)
    VALUES (v_attempt, p_request_id, r.session_id, v_no, p_owner, r.incarnation, now());
    UPDATE ${s}.session_steering_requests SET status = 'submitting', revision = revision + 1
     WHERE request_id = p_request_id;
    PERFORM ${s}.cms_steer_record_event(r.session_id, 'session.steering_updated', p_request_id);
    RETURN v_attempt;
END $$;

-- ─── F06: honest recovery timing ────────────────────────────────
ALTER TABLE ${s}.session_steering_requests DROP CONSTRAINT IF EXISTS session_steering_requests_disposition_check;
ALTER TABLE ${s}.session_steering_requests ADD CONSTRAINT session_steering_requests_disposition_check CHECK (disposition IN
    ('accepted','delivered_current_turn','delivered_after_response','delivered_timing_unconfirmed',
     'delivered_before_stop','not_delivered_turn_ended','not_delivered_turn_stopped','withdrawn','delivery_unconfirmed'));

-- Delivered label from the first delivered attempt's recorded kind; no kind ⇒ timing unconfirmed.
CREATE OR REPLACE FUNCTION ${s}.cms_steer_delivered_disposition(p_kind TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE p_kind WHEN 'steering' THEN 'delivered_current_turn'
                       WHEN 'queued' THEN 'delivered_after_response'
                       WHEN 'idle' THEN 'delivered_after_response'
                       ELSE 'delivered_timing_unconfirmed' END;
$$;

CREATE OR REPLACE FUNCTION ${s}.cms_steer_closed_disposition(p_request_id TEXT, p_reason TEXT, p_current TEXT)
RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE v_first_kind TEXT; v_delivered BOOLEAN; v_possible BOOLEAN;
BEGIN
    IF p_reason = 'withdrawn' THEN RETURN 'withdrawn'; END IF;
    SELECT bool_or(delivered_at IS NOT NULL),
           bool_or(outcome IS DISTINCT FROM 'released'),
           (array_agg(delivery_kind ORDER BY delivered_at, attempt_no) FILTER (WHERE delivered_at IS NOT NULL))[1]
      INTO v_delivered, v_possible, v_first_kind
      FROM ${s}.session_steering_attempts WHERE request_id = p_request_id;
    IF COALESCE(v_delivered, false) THEN
        -- Timing unknown is terminal: Stop never overrides it (owner decision 2026-10-07).
        -- Delivered with no recorded kind, or already labelled so, stays delivered_timing_unconfirmed;
        -- a Stop-closed delivery_unconfirmed row that gains such evidence is corrected to it.
        IF p_current = 'delivered_timing_unconfirmed' OR v_first_kind IS NULL THEN
            RETURN 'delivered_timing_unconfirmed';
        END IF;
        IF p_reason = 'stopped' THEN RETURN 'delivered_before_stop'; END IF;
        IF p_current IN ('delivered_current_turn', 'delivered_after_response') THEN
            RETURN p_current;
        END IF;
        RETURN ${s}.cms_steer_delivered_disposition(v_first_kind);
    END IF;
    -- NULL outcome = still 'submitting' (crash after the write-ahead marker): may have been sent.
    IF COALESCE(v_possible, false) THEN RETURN 'delivery_unconfirmed'; END IF;
    IF p_reason = 'stopped' THEN RETURN 'not_delivered_turn_stopped'; END IF;
    RETURN 'not_delivered_turn_ended';
END $$;

-- One signature with the delivery kind (a 5-argument overload next to the 4-argument
-- one would make 4-argument calls ambiguous).
DROP FUNCTION IF EXISTS ${s}.cms_steer_record_recovery_check(TEXT, TEXT, TEXT, TEXT);
CREATE OR REPLACE FUNCTION ${s}.cms_steer_record_recovery_check(
    p_request_id TEXT, p_owner TEXT, p_result TEXT, p_sdk_message_id TEXT DEFAULT NULL, p_kind TEXT DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE r RECORD; w RECORD; v_attempt TEXT; v_kind TEXT; v_first_kind TEXT;
BEGIN
    IF p_result NOT IN ('present', 'present_local', 'absent', 'failed') THEN
        RAISE EXCEPTION 'invalid recovery result %', p_result;
    END IF;
    v_kind := CASE WHEN p_kind IN ('steering', 'queued', 'idle') THEN p_kind ELSE NULL END;
    SELECT * INTO r FROM ${s}.session_steering_requests WHERE request_id = p_request_id;
    IF NOT FOUND THEN RETURN false; END IF;
    PERFORM ${s}.cms_steer_lock_session(r.session_id);
    SELECT * INTO w FROM ${s}.session_steering_windows
     WHERE session_id = r.session_id AND transcript_epoch = r.transcript_epoch AND turn_index = r.turn_index
       AND incarnation = r.incarnation AND state = 'open' AND owner_token = p_owner FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT * INTO r FROM ${s}.session_steering_requests WHERE request_id = p_request_id FOR UPDATE;
    IF r.status <> 'orphaned' THEN RETURN false; END IF;
    IF p_result IN ('present', 'present_local') THEN
        SELECT attempt_id INTO v_attempt FROM ${s}.session_steering_attempts
         WHERE request_id = p_request_id AND sdk_message_id IS NOT NULL
           AND (p_sdk_message_id IS NULL OR sdk_message_id = p_sdk_message_id)
         ORDER BY attempt_no DESC LIMIT 1;
        IF v_attempt IS NOT NULL THEN
            -- Never overwrite a kind recorded from live evidence.
            UPDATE ${s}.session_steering_attempts
               SET delivered_at = COALESCE(delivered_at, now()), outcome = 'delivered',
                   delivery_kind = COALESCE(delivery_kind, v_kind)
             WHERE attempt_id = v_attempt;
        END IF;
        SELECT (array_agg(delivery_kind ORDER BY delivered_at, attempt_no) FILTER (WHERE delivered_at IS NOT NULL))[1]
          INTO v_first_kind
          FROM ${s}.session_steering_attempts WHERE request_id = p_request_id;
        UPDATE ${s}.session_steering_requests SET
            status = 'delivered', recovery_check = 'present',
            -- Only the stored base is an inclusion oracle; local state waits for finalize.
            included = CASE WHEN p_result = 'present' THEN 'included' ELSE included END,
            disposition = CASE WHEN disposition IN ('accepted', 'delivery_unconfirmed')
                               THEN ${s}.cms_steer_delivered_disposition(v_first_kind) ELSE disposition END,
            revision = revision + 1
         WHERE request_id = p_request_id;
    ELSE
        UPDATE ${s}.session_steering_requests SET recovery_check = p_result, revision = revision + 1
         WHERE request_id = p_request_id;
    END IF;
    PERFORM ${s}.cms_steer_record_event(r.session_id, 'session.steering_updated', p_request_id);
    RETURN true;
END $$;

-- ─── F12: newest-first diagnostics read ─────────────────────────
-- The latest p_limit receipts (max 100), newest first, plus the session total.
CREATE OR REPLACE FUNCTION ${s}.cms_steer_list_recent(p_session_id TEXT, p_limit INT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100); v_total BIGINT;
BEGIN
    SELECT count(*) INTO v_total FROM ${s}.session_steering_requests WHERE session_id = p_session_id;
    RETURN jsonb_build_object(
        'items', COALESCE((SELECT jsonb_agg(${s}.cms_steer_projection(x.request_id, true, 0, 20) ORDER BY x.seq DESC)
                             FROM (SELECT request_id, seq FROM ${s}.session_steering_requests
                                    WHERE session_id = p_session_id ORDER BY seq DESC LIMIT v_limit) x), '[]'::JSONB),
        'total', v_total);
END $$;

-- ─── F18: schema capability probe as a procedure ────────────────
-- Callers detect steering support by calling this; a missing function (42883) means no support.
CREATE OR REPLACE FUNCTION ${s}.cms_steer_capabilities()
RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
    SELECT jsonb_build_object('schemaVersion', 1, 'migration', '0086');
$$;
`;
}