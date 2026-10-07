/**
 * Migration 0087: Stop label on the cancellation path (owner Stop UX, test env 79d544be).
 * 0082-0086 are frozen (0086 is applied in the test environment).
 *
 * A runTurn cancelled because Stop won the orchestration race finalizes BEFORE Stop's own
 * target close, and closed rows are never reopened, so the receipt said 'turn_ended'.
 * `cms_steer_turn_finalize` gains p_close (default true). With p_close = false it records
 * inclusion exactly as before but leaves the closure, and its 'stopped' reason, to the
 * canceller: Stop's session.turn_stopped close, a terminal-state or delete backstop, or the
 * next window open. 8-argument callers resolve to the new function.
 */
export function sessionSteeringCancelledFinalizeMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
-- ─── Stop label on the cancellation path ─────────────────────────
-- A runTurn cancelled by Stop finalizes before Stop's own close; with p_close = false it
-- records inclusion but leaves the closure (and its 'stopped' reason) to the canceller.
DROP FUNCTION IF EXISTS ${s}.cms_steer_turn_finalize(TEXT, INT, INT, TEXT, TEXT, TEXT, TEXT[], INT);
CREATE OR REPLACE FUNCTION ${s}.cms_steer_turn_finalize(
    p_session_id TEXT, p_epoch INT, p_turn INT, p_incarnation TEXT, p_owner TEXT,
    p_outcome TEXT, p_manifest TEXT[], p_snapshot_version INT, p_close BOOLEAN DEFAULT true)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE w RECORD; r RECORD; v_possible BOOLEAN; v_own BOOLEAN; v_incl TEXT; v_n INT := 0;
BEGIN
    IF p_outcome NOT IN ('published', 'adopted', 'unpublished', 'stopped', 'unknown') THEN
        RAISE EXCEPTION 'invalid finalize outcome %', p_outcome;
    END IF;
    PERFORM ${s}.cms_steer_lock_session(p_session_id);
    SELECT * INTO w FROM ${s}.session_steering_windows
     WHERE session_id = p_session_id AND transcript_epoch = p_epoch AND turn_index = p_turn
       AND incarnation = p_incarnation FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('finalized', false, 'reason', 'no_window'); END IF;
    IF w.owner_token IS DISTINCT FROM p_owner THEN
        RETURN jsonb_build_object('finalized', false, 'reason', 'not_owner');   -- stale owner: history only
    END IF;
    FOR r IN SELECT * FROM ${s}.session_steering_requests
              WHERE session_id = p_session_id AND transcript_epoch = p_epoch AND turn_index = p_turn
                AND incarnation = p_incarnation
                AND (status NOT IN ('closed', 'withdrawn') OR (status = 'closed' AND included IS NULL))
              ORDER BY seq FOR UPDATE LOOP
        IF r.included = 'included' THEN CONTINUE; END IF;   -- a winner's inclusion is never overwritten
        SELECT COALESCE(bool_or(outcome IS DISTINCT FROM 'released'), false),
               COALESCE(bool_or(owner_token = p_owner AND outcome IS DISTINCT FROM 'released'), false)
          INTO v_possible, v_own
          FROM ${s}.session_steering_attempts WHERE request_id = r.request_id;
        IF NOT v_possible THEN
            v_incl := 'not_included';                       -- known never invoked
        ELSIF p_outcome IN ('published', 'adopted') THEN
            IF p_manifest IS NULL THEN v_incl := 'unconfirmed';
            ELSIF r.request_id = ANY(p_manifest) THEN v_incl := 'included';
            ELSIF r.recovery_check = 'absent' AND NOT v_own THEN v_incl := 'not_included';
            ELSE v_incl := 'unconfirmed';
            END IF;
        ELSIF p_outcome IN ('unpublished', 'stopped') THEN
            v_incl := CASE WHEN v_own OR r.request_id = ANY(COALESCE(p_manifest, '{}'::TEXT[]))
                           THEN 'not_included' ELSE r.included END;
        ELSE
            v_incl := COALESCE(r.included, 'unconfirmed');
        END IF;
        IF v_incl IS DISTINCT FROM r.included THEN
            UPDATE ${s}.session_steering_requests SET
                included = v_incl,
                included_snapshot_version = CASE WHEN v_incl = 'included' THEN p_snapshot_version
                                                 ELSE included_snapshot_version END,
                revision = CASE WHEN r.status = 'closed' THEN revision + 1 ELSE revision END
             WHERE request_id = r.request_id;
            v_n := v_n + 1;
            IF r.status = 'closed' THEN
                PERFORM ${s}.cms_steer_record_event(p_session_id, 'session.steering_updated', r.request_id);
            END IF;
        END IF;
    END LOOP;
    IF w.state = 'closed' THEN
        RETURN jsonb_build_object('finalized', false, 'reason', 'closed', 'inclusionUpdated', v_n);
    END IF;
    -- A cancelled result: inclusion follows its commit, but the closure belongs to whatever
    -- cancelled it (Stop's turn_stopped close, a terminal state, or the next window open).
    IF NOT COALESCE(p_close, true) THEN
        RETURN jsonb_build_object('finalized', false, 'reason', 'left_open', 'inclusionUpdated', v_n);
    END IF;
    PERFORM ${s}.cms_steer_close_target(p_session_id, p_epoch, p_turn, p_incarnation,
        CASE WHEN p_outcome = 'stopped' THEN 'stopped' ELSE 'turn_ended' END, 'finalized');
    RETURN jsonb_build_object('finalized', true);
END $$;

`;
}
