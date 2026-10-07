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
`;
}
