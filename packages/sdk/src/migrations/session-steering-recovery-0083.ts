/**
 * Migration 0083: same-activity recovery from LOCAL session state is not an
 * inclusion oracle (docs/proposals/session-steering.md FR-13, D-28).
 *
 * 0082 is frozen (deployed). This replaces `cms_steer_record_recovery_check`
 * with one added result, `present_local`: the steer's SDK id is in the
 * conversation this activity resumed from its own local files (not restored
 * from the stored base). The row becomes delivered and is not resent, but its
 * inclusion is left to finalize: the pump lists it in this attempt's manifest,
 * so a published commit marks it included and an unpublished one does not.
 * `present` keeps its 0082 meaning (restored from the stored base ⇒ included).
 *
 * It also replaces `cms_steer_projection` with one added receipt field,
 * `recoveryCheck`, so a reader can observe the recovery outcome.
 */
export function sessionSteeringRecoveryMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
-- Receipt projection: identical to 0082 plus 'recoveryCheck' (pending | present | absent | failed | null),
-- so readers can observe a same-target recovery outcome without inferring it.
CREATE OR REPLACE FUNCTION ${s}.cms_steer_projection(
    p_request_id TEXT, p_with_text BOOLEAN DEFAULT true,
    p_attempt_after INT DEFAULT 0, p_attempt_limit INT DEFAULT 20)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE
    r RECORD; w RECORD; has_window BOOLEAN;
    v_total INT; v_delivered INT; v_possible INT; v_acked INT;
    v_prior_delivered BOOLEAN; v_current_delivered BOOLEAN;
    v_items JSONB; v_last_no INT; v_more BOOLEAN; v_limit INT;
    v_flags JSONB := '[]'::JSONB; v_incl TEXT; v_elig TEXT; v_elig_reason TEXT;
    v_terminal BOOLEAN; v_submission TEXT; v_recovering BOOLEAN := false; v_out JSONB;
BEGIN
    SELECT * INTO r FROM ${s}.session_steering_requests WHERE request_id = p_request_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_limit := LEAST(GREATEST(COALESCE(p_attempt_limit, 20), 1), 100);

    SELECT count(*),
           count(*) FILTER (WHERE delivered_at IS NOT NULL),
           count(*) FILTER (WHERE outcome IS DISTINCT FROM 'released'),
           count(*) FILTER (WHERE sdk_message_id IS NOT NULL),
           COALESCE(bool_or(delivered_at IS NOT NULL AND owner_token IS DISTINCT FROM r.owner_token), false),
           COALESCE(bool_or(delivered_at IS NOT NULL AND r.owner_token IS NOT NULL AND owner_token = r.owner_token), false)
      INTO v_total, v_delivered, v_possible, v_acked, v_prior_delivered, v_current_delivered
      FROM ${s}.session_steering_attempts WHERE request_id = p_request_id;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'attemptId', a.attempt_id,
               'attemptNo', a.attempt_no,
               'submittingAt', ${s}.cms_steer_iso(a.submitting_at),
               'acknowledgedAt', ${s}.cms_steer_iso(a.acknowledged_at),
               'deliveredAt', ${s}.cms_steer_iso(a.delivered_at),
               'deliveryKind', a.delivery_kind,
               'outcome', a.outcome) ORDER BY a.attempt_no), '[]'::JSONB),
           max(a.attempt_no)
      INTO v_items, v_last_no
      FROM (SELECT * FROM ${s}.session_steering_attempts
             WHERE request_id = p_request_id AND attempt_no > COALESCE(p_attempt_after, 0)
             ORDER BY attempt_no LIMIT v_limit) a;
    v_more := v_last_no IS NOT NULL AND EXISTS (
        SELECT 1 FROM ${s}.session_steering_attempts WHERE request_id = p_request_id AND attempt_no > v_last_no);

    v_terminal := r.status IN ('closed', 'withdrawn');

    -- Recovery flags are derived, never stored (§6a.2).
    IF v_prior_delivered AND NOT v_current_delivered AND r.included IS DISTINCT FROM 'included'
       AND r.recovery_check = 'absent' AND NOT v_terminal THEN
        v_flags := v_flags || '["redelivery_pending"]'::JSONB;
    END IF;
    IF v_delivered >= 2 THEN v_flags := v_flags || '["delivered_again"]'::JSONB; END IF;
    IF r.recovery_check = 'failed'
       OR (r.status = 'closed' AND r.closure_reason = 'turn_ended' AND v_delivered > 0 AND r.included IS NULL) THEN
        v_flags := v_flags || '["recovery_unconfirmed"]'::JSONB;
    END IF;

    v_incl := CASE WHEN r.included IS NOT NULL THEN r.included
                   WHEN v_possible = 0 THEN 'not_included'
                   ELSE 'unconfirmed' END;

    IF v_terminal THEN
        v_elig := 'terminal'; v_elig_reason := r.closure_reason;
    ELSIF r.status = 'orphaned' THEN
        IF r.recovery_check = 'failed' THEN v_elig := 'pending'; v_elig_reason := 'recovery_unconfirmed';
        ELSE v_elig := 'recovery_eligible';
             v_elig_reason := CASE r.recovery_check WHEN 'pending' THEN 'recovery_check_pending'
                                                    WHEN 'absent' THEN 'redelivery_pending'
                                                    ELSE 'owner_lost' END;
        END IF;
    ELSE
        v_elig := 'pending';
        v_elig_reason := CASE r.status WHEN 'pending' THEN 'awaiting_handoff'
                                       WHEN 'delivered' THEN 'awaiting_turn_outcome'
                                       ELSE 'handoff_in_progress' END;
    END IF;

    v_submission := CASE WHEN v_possible = 0 THEN 'never_invoked'
                         WHEN v_acked > 0 THEN 'acknowledged'
                         ELSE 'may_have_submitted' END;

    IF NOT v_terminal THEN
        SELECT * INTO w FROM ${s}.session_steering_windows
         WHERE session_id = r.session_id AND transcript_epoch = r.transcript_epoch
           AND turn_index = r.turn_index AND incarnation = r.incarnation;
        has_window := FOUND;
        v_recovering := r.status = 'orphaned'
            OR (has_window AND w.state = 'open' AND w.lease_expires_at <= now());
    END IF;

    v_out := jsonb_build_object(
        'schemaVersion', 1,
        'sessionId', r.session_id,
        'requestId', r.request_id,
        'clientRequestId', r.idempotency_key,
        'expectedTarget', ${s}.cms_steer_target_token(r.session_id, r.transcript_epoch, r.turn_index, r.incarnation),
        'target', jsonb_build_object('transcriptEpoch', r.transcript_epoch, 'turnIndex', r.turn_index),
        'sequence', r.seq,
        'acceptedAt', ${s}.cms_steer_iso(r.accepted_at),
        'settledAt', ${s}.cms_steer_iso(r.settled_at),
        'actor', jsonb_strip_nulls(jsonb_build_object(
            'provider', r.actor->>'provider', 'subject', r.actor->>'subject',
            'displayName', r.actor->>'display')),
        'revision', r.revision,
        'status', r.status,
        'disposition', r.disposition,
        'closureReason', r.closure_reason,
        'submission', v_submission,
        'recovering', v_recovering,
        'recoveryCheck', r.recovery_check,
        'eligibility', jsonb_build_object('state', v_elig, 'reason', v_elig_reason),
        'inclusion', jsonb_build_object('state', v_incl, 'snapshotVersion', r.included_snapshot_version),
        'recoveryFlags', v_flags,
        'attempts', jsonb_build_object(
            'total', v_total,
            'items', v_items,
            'nextCursor', CASE WHEN v_more THEN v_last_no::TEXT ELSE NULL END));
    IF p_with_text THEN v_out := v_out || jsonb_build_object('text', r.content); END IF;
    RETURN v_out;
END $$;


CREATE OR REPLACE FUNCTION ${s}.cms_steer_record_recovery_check(
    p_request_id TEXT, p_owner TEXT, p_result TEXT, p_sdk_message_id TEXT DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE r RECORD; w RECORD; v_attempt TEXT;
BEGIN
    IF p_result NOT IN ('present', 'present_local', 'absent', 'failed') THEN
        RAISE EXCEPTION 'invalid recovery result %', p_result;
    END IF;
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
            UPDATE ${s}.session_steering_attempts
               SET delivered_at = COALESCE(delivered_at, now()), outcome = 'delivered'
             WHERE attempt_id = v_attempt;
        END IF;
        UPDATE ${s}.session_steering_requests SET
            status = 'delivered', recovery_check = 'present',
            -- Only the stored base is an inclusion oracle; local state waits for finalize.
            included = CASE WHEN p_result = 'present' THEN 'included' ELSE included END,
            disposition = CASE WHEN disposition IN ('accepted', 'delivery_unconfirmed') THEN 'delivered_current_turn' ELSE disposition END,
            revision = revision + 1
         WHERE request_id = p_request_id;
    ELSE
        UPDATE ${s}.session_steering_requests SET recovery_check = p_result, revision = revision + 1
         WHERE request_id = p_request_id;
    END IF;
    PERFORM ${s}.cms_steer_record_event(r.session_id, 'session.steering_updated', p_request_id);
    RETURN true;
END $$;
`;
}
