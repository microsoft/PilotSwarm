/**
 * Migration 0082: session steering ledger, admission windows and stored
 * procedures (docs/proposals/session-steering.md §6a.2, §6a.3, §7.3).
 *
 * Additive only. Creates three tables, one sequence and the `cms_steer_*`
 * procedures; replaces `cms_record_events`, `cms_update_session` and
 * `cms_soft_delete_session` with bodies identical to their latest versions
 * plus the steering backstops; publishes the feature flag
 * `sessions.steering` (Off, no user override).
 *
 * Lock order inside every procedure: actor advisory lock (acceptance only)
 * → session steering advisory lock → window row → request rows → attempts.
 *
 * The receipt projection is computed once, in SQL (`cms_steer_projection`),
 * because the same transaction must write it into `session.steering_*`
 * events. `steering.ts` maps it to the public typed DTO and adds the
 * viewer-derived `actions`.
 */
export function sessionSteeringMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
-- ─── Tables ──────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS ${s}.session_steering_seq;

CREATE TABLE IF NOT EXISTS ${s}.session_steering_requests (
    request_id                TEXT PRIMARY KEY,
    session_id                TEXT NOT NULL REFERENCES ${s}.sessions(session_id) ON DELETE CASCADE,
    seq                       BIGINT NOT NULL,
    idempotency_key           TEXT NOT NULL,
    actor                     JSONB NOT NULL,
    content                   TEXT NOT NULL,
    content_hash              TEXT NOT NULL,
    transcript_epoch          INT NOT NULL,
    turn_index                INT NOT NULL,
    incarnation               TEXT NOT NULL,
    status                    TEXT NOT NULL CHECK (status IN
        ('pending','claimed','submitting','submitted','delivered','orphaned','withdrawn','closed')),
    owner_token               TEXT,
    recovery_check            TEXT CHECK (recovery_check IN ('pending','present','absent','failed')),
    included                  TEXT CHECK (included IN ('included','not_included','unconfirmed')),
    included_snapshot_version INT,
    closure_reason            TEXT CHECK (closure_reason IN ('turn_ended','stopped','withdrawn')),
    disposition               TEXT NOT NULL CHECK (disposition IN
        ('accepted','delivered_current_turn','delivered_after_response','delivered_before_stop',
         'not_delivered_turn_ended','not_delivered_turn_stopped','withdrawn','delivery_unconfirmed')),
    revision                  INT NOT NULL DEFAULT 1,
    accepted_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    claimed_at                TIMESTAMPTZ,
    settled_at                TIMESTAMPTZ,
    UNIQUE (session_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS session_steering_requests_by_seq
    ON ${s}.session_steering_requests (session_id, seq);
CREATE INDEX IF NOT EXISTS session_steering_requests_by_target
    ON ${s}.session_steering_requests (session_id, transcript_epoch, turn_index, incarnation, seq);
CREATE INDEX IF NOT EXISTS session_steering_requests_by_actor
    ON ${s}.session_steering_requests ((actor->>'provider'), (actor->>'subject'), accepted_at);

CREATE TABLE IF NOT EXISTS ${s}.session_steering_attempts (
    attempt_id      TEXT PRIMARY KEY,
    request_id      TEXT NOT NULL REFERENCES ${s}.session_steering_requests(request_id) ON DELETE CASCADE,
    session_id      TEXT NOT NULL,
    attempt_no      INT NOT NULL,
    owner_token     TEXT NOT NULL,
    turn_key        TEXT NOT NULL,
    submitting_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    sdk_message_id  TEXT,
    acknowledged_at TIMESTAMPTZ,
    delivered_at    TIMESTAMPTZ,
    delivery_kind   TEXT CHECK (delivery_kind IN ('steering','queued','idle')),
    outcome         TEXT CHECK (outcome IN ('released','acknowledged','delivered','unconfirmed')),
    UNIQUE (request_id, attempt_no),
    UNIQUE (request_id, sdk_message_id)
);
CREATE INDEX IF NOT EXISTS session_steering_attempts_by_session
    ON ${s}.session_steering_attempts (session_id, submitting_at);

CREATE TABLE IF NOT EXISTS ${s}.session_steering_windows (
    session_id        TEXT NOT NULL REFERENCES ${s}.sessions(session_id) ON DELETE CASCADE,
    transcript_epoch  INT NOT NULL,
    turn_index        INT NOT NULL,
    incarnation       TEXT NOT NULL,
    owner_token       TEXT,
    lease_expires_at  TIMESTAMPTZ,
    state             TEXT NOT NULL CHECK (state IN ('open','quiesced','closed')),
    opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    quiesced_at       TIMESTAMPTZ,
    closed_reason     TEXT,
    closed_at         TIMESTAMPTZ,
    PRIMARY KEY (session_id, transcript_epoch, turn_index, incarnation)
);
CREATE UNIQUE INDEX IF NOT EXISTS session_steering_windows_one_live
    ON ${s}.session_steering_windows (session_id) WHERE state <> 'closed';

-- Pre-acceptance counters (duplicates, typed refusals). No content.
CREATE TABLE IF NOT EXISTS ${s}.session_steering_counters (
    session_id  TEXT NOT NULL REFERENCES ${s}.sessions(session_id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    value       BIGINT NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, name)
);

-- ─── Helpers ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_steer_iso(p_ts TIMESTAMPTZ) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN p_ts IS NULL THEN NULL
                ELSE to_char(p_ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END;
$$;

-- Opaque target token: 'st1.' + base64url(session \\n epoch \\n turn \\n incarnation).
-- steering.ts decodes it; callers treat it as opaque.
CREATE OR REPLACE FUNCTION ${s}.cms_steer_target_token(p_session_id TEXT, p_epoch INT, p_turn INT, p_incarnation TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT 'st1.' || rtrim(translate(replace(encode(convert_to(
        p_session_id || chr(10) || p_epoch::TEXT || chr(10) || p_turn::TEXT || chr(10) || p_incarnation,
        'UTF8'), 'base64'), chr(10), ''), '+/', '-_'), '=');
$$;

CREATE OR REPLACE FUNCTION ${s}.cms_steer_lock_session(p_session_id TEXT) RETURNS VOID
LANGUAGE sql AS $$
    SELECT pg_advisory_xact_lock(hashtextextended('steer-window:' || p_session_id, 0));
$$;

CREATE OR REPLACE FUNCTION ${s}.cms_steer_count(p_session_id TEXT, p_name TEXT) RETURNS VOID
LANGUAGE sql AS $$
    INSERT INTO ${s}.session_steering_counters (session_id, name, value, updated_at)
    SELECT p_session_id, p_name, 1, now()
     WHERE EXISTS (SELECT 1 FROM ${s}.sessions WHERE session_id = p_session_id)
    ON CONFLICT (session_id, name) DO UPDATE
       SET value = ${s}.session_steering_counters.value + 1, updated_at = now();
$$;

-- Disposition of a CLOSED row, derived only from evidence (§6a.2 terminal table).
-- Also used to correct the historical label when late evidence arrives (FR-11).
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
        IF p_reason = 'stopped' THEN RETURN 'delivered_before_stop'; END IF;
        IF p_current IN ('delivered_current_turn', 'delivered_after_response') THEN RETURN p_current; END IF;
        RETURN CASE WHEN v_first_kind = 'steering' OR v_first_kind IS NULL
                    THEN 'delivered_current_turn' ELSE 'delivered_after_response' END;
    END IF;
    -- NULL outcome = still 'submitting' (crash after the write-ahead marker): may have been sent.
    IF COALESCE(v_possible, false) THEN RETURN 'delivery_unconfirmed'; END IF;
    IF p_reason = 'stopped' THEN RETURN 'not_delivered_turn_stopped'; END IF;
    RETURN 'not_delivered_turn_ended';
END $$;

-- The authoritative receipt projection (camelCase, schemaVersion 1).
-- p_with_text = false gives SteeringProjectionV1 (events), true the read receipt.
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

-- Inserts one steering event in the caller's transaction (§6a.3).
-- For request events p_ref is the request id and the payload is derived;
-- for window events the caller passes p_data.
CREATE OR REPLACE FUNCTION ${s}.cms_steer_record_event(
    p_session_id TEXT, p_event_type TEXT, p_ref TEXT, p_data JSONB DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_data JSONB := p_data; v_proj JSONB;
BEGIN
    IF v_data IS NULL AND p_event_type = 'session.steering_accepted' THEN
        v_data := jsonb_build_object('receipt', ${s}.cms_steer_projection(p_ref, true));
    ELSIF v_data IS NULL AND p_event_type = 'session.steering_updated' THEN
        v_proj := ${s}.cms_steer_projection(p_ref, false);
        v_data := jsonb_build_object('requestId', p_ref, 'revision', v_proj->'revision', 'projection', v_proj);
    END IF;
    INSERT INTO ${s}.session_events (session_id, event_type, data)
    VALUES (p_session_id, p_event_type, v_data);
END $$;

CREATE OR REPLACE FUNCTION ${s}.cms_steer_window_event(p_session_id TEXT, p_state TEXT, p_token TEXT, p_reason TEXT)
RETURNS VOID LANGUAGE sql AS $$
    SELECT ${s}.cms_steer_record_event(p_session_id, 'session.steering_window_changed', NULL,
        jsonb_build_object('schemaVersion', 1, 'state', p_state, 'expectedTarget', p_token, 'reason', p_reason));
$$;

CREATE OR REPLACE FUNCTION ${s}.cms_steer_match_or_conflict(
    r ${s}.session_steering_requests, p_actor JSONB, p_hash TEXT, p_epoch INT, p_turn INT, p_incarnation TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
BEGIN
    IF (r.actor->>'provider') IS NOT DISTINCT FROM (p_actor->>'provider')
       AND (r.actor->>'subject') IS NOT DISTINCT FROM (p_actor->>'subject')
       AND r.content_hash = p_hash
       AND r.transcript_epoch = p_epoch AND r.turn_index = p_turn AND r.incarnation = p_incarnation THEN
        PERFORM ${s}.cms_steer_count(r.session_id, 'duplicate');
        RETURN jsonb_build_object('outcome', 'accepted', 'duplicate', true,
                                  'receipt', ${s}.cms_steer_projection(r.request_id, true));
    END IF;
    PERFORM ${s}.cms_steer_count(r.session_id, 'rejected:idempotency_conflict');
    RETURN jsonb_build_object('outcome', 'idempotency_conflict');
END $$;

-- Retry probe for the management client (§6b.1, §8.6): an already-accepted matching retry
-- returns its receipt BEFORE any new-admission gate (flag, terminal state, window). NULL when the
-- key is new. Same comparison and counters as acceptance; a mismatch reveals nothing.
CREATE OR REPLACE FUNCTION ${s}.cms_steer_match_existing(
    p_session_id TEXT, p_idem TEXT, p_actor JSONB, p_hash TEXT, p_epoch INT, p_turn INT, p_incarnation TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE r ${s}.session_steering_requests;
BEGIN
    SELECT * INTO r FROM ${s}.session_steering_requests WHERE session_id = p_session_id AND idempotency_key = p_idem;
    IF NOT FOUND THEN RETURN NULL; END IF;
    RETURN ${s}.cms_steer_match_or_conflict(r, p_actor, p_hash, p_epoch, p_turn, p_incarnation);
END $$;

-- Shared terminal closure of one target (§7.3). Caller holds the session lock.
CREATE OR REPLACE FUNCTION ${s}.cms_steer_close_target(
    p_session_id TEXT, p_epoch INT, p_turn INT, p_incarnation TEXT, p_reason TEXT, p_window_reason TEXT DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE v_id TEXT; v_changed INT;
BEGIN
    FOR v_id IN
        UPDATE ${s}.session_steering_requests r SET
            status = 'closed', closure_reason = p_reason, settled_at = now(), revision = r.revision + 1,
            disposition = ${s}.cms_steer_closed_disposition(r.request_id, p_reason, r.disposition)
         WHERE r.session_id = p_session_id AND r.transcript_epoch = p_epoch AND r.turn_index = p_turn
           AND r.incarnation = p_incarnation AND r.status NOT IN ('closed', 'withdrawn')
        RETURNING r.request_id
    LOOP
        PERFORM ${s}.cms_steer_record_event(p_session_id, 'session.steering_updated', v_id);
    END LOOP;
    UPDATE ${s}.session_steering_windows
       SET state = 'closed', closed_reason = COALESCE(p_window_reason, p_reason), closed_at = now()
     WHERE session_id = p_session_id AND transcript_epoch = p_epoch AND turn_index = p_turn
       AND incarnation = p_incarnation AND state <> 'closed';
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    IF v_changed > 0 THEN
        PERFORM ${s}.cms_steer_window_event(p_session_id, 'closed', NULL, COALESCE(p_window_reason, p_reason));
    END IF;
END $$;

-- Closes every live window of a session (terminal session state / delete backstop).
CREATE OR REPLACE FUNCTION ${s}.cms_steer_close_session(p_session_id TEXT, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE w RECORD;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM ${s}.session_steering_windows WHERE session_id = p_session_id AND state <> 'closed')
       AND NOT EXISTS (SELECT 1 FROM ${s}.session_steering_requests
                        WHERE session_id = p_session_id AND status NOT IN ('closed', 'withdrawn')) THEN
        RETURN;
    END IF;
    PERFORM ${s}.cms_steer_lock_session(p_session_id);
    FOR w IN SELECT DISTINCT transcript_epoch, turn_index, incarnation FROM (
                SELECT transcript_epoch, turn_index, incarnation FROM ${s}.session_steering_windows
                 WHERE session_id = p_session_id AND state <> 'closed'
                UNION
                SELECT transcript_epoch, turn_index, incarnation FROM ${s}.session_steering_requests
                 WHERE session_id = p_session_id AND status NOT IN ('closed', 'withdrawn')) t
    LOOP
        PERFORM ${s}.cms_steer_close_target(p_session_id, w.transcript_epoch, w.turn_index, w.incarnation, 'turn_ended', p_reason);
    END LOOP;
END $$;

-- ─── Acceptance (FR-2, FR-3, FR-4, D-23) ─────────────────────────
-- p_limits: { maxBytes, maxUnresolved, ratePerMinute }; defaults 8192 / 16 / 30 (OD-G).
CREATE OR REPLACE FUNCTION ${s}.cms_steer_accept(
    p_session_id TEXT, p_request_id TEXT, p_idem TEXT, p_actor JSONB,
    p_content TEXT, p_hash TEXT, p_epoch INT, p_turn INT, p_incarnation TEXT, p_limits JSONB)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
    w RECORD; r ${s}.session_steering_requests; inserted BOOLEAN; key_exists BOOLEAN; has_window BOOLEAN;
    v_max_bytes INT := COALESCE(NULLIF(p_limits->>'maxBytes', '')::INT, 8192);
    v_max_unresolved INT := COALESCE(NULLIF(p_limits->>'maxUnresolved', '')::INT, 16);
    v_rate INT := COALESCE(NULLIF(p_limits->>'ratePerMinute', '')::INT, 30);
    v_n INT;
BEGIN
    IF COALESCE(p_actor->>'provider', '') = '' OR COALESCE(p_actor->>'subject', '') = '' THEN
        RETURN jsonb_build_object('outcome', 'forbidden', 'reason', 'actor_required');
    END IF;
    IF COALESCE(p_idem, '') = '' OR COALESCE(p_hash, '') = '' OR p_content IS NULL OR btrim(p_content) = '' THEN
        RETURN jsonb_build_object('outcome', 'invalid', 'reason', 'invalid_request');
    END IF;
    -- 1. Existing key: a matching retry gets its receipt even after the window closed.
    SELECT * INTO r FROM ${s}.session_steering_requests WHERE session_id = p_session_id AND idempotency_key = p_idem;
    key_exists := FOUND;
    IF key_exists THEN
        RETURN ${s}.cms_steer_match_or_conflict(r, p_actor, p_hash, p_epoch, p_turn, p_incarnation);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ${s}.sessions WHERE session_id = p_session_id AND deleted_at IS NULL) THEN
        RETURN jsonb_build_object('outcome', 'not_found');
    END IF;
    -- 2. New key. Lock order: actor (the per-actor rate spans sessions), then the session window.
    PERFORM pg_advisory_xact_lock(hashtextextended(
        'steer-actor:' || (p_actor->>'provider') || ':' || (p_actor->>'subject'), 0));
    PERFORM ${s}.cms_steer_lock_session(p_session_id);
    SELECT * INTO w FROM ${s}.session_steering_windows
     WHERE session_id = p_session_id AND state <> 'closed' FOR UPDATE;
    has_window := FOUND;
    SELECT * INTO r FROM ${s}.session_steering_requests WHERE session_id = p_session_id AND idempotency_key = p_idem;
    key_exists := FOUND;
    IF key_exists THEN   -- a same-key retry raced in while we waited for the locks: not charged
        RETURN ${s}.cms_steer_match_or_conflict(r, p_actor, p_hash, p_epoch, p_turn, p_incarnation);
    END IF;
    IF NOT has_window OR w.state <> 'open' OR w.lease_expires_at IS NULL OR w.lease_expires_at <= now() THEN
        PERFORM ${s}.cms_steer_count(p_session_id, 'rejected:no_active_turn');
        RETURN jsonb_build_object('outcome', 'no_active_turn',
            'reason', CASE WHEN has_window AND w.state = 'open' THEN 'recovering' ELSE NULL END);
    END IF;
    IF w.transcript_epoch <> p_epoch OR w.turn_index <> p_turn OR w.incarnation <> p_incarnation THEN
        PERFORM ${s}.cms_steer_count(p_session_id, 'rejected:stale_target');
        RETURN jsonb_build_object('outcome', 'stale_target');
    END IF;
    IF octet_length(convert_to(p_content, 'UTF8')) > v_max_bytes THEN
        PERFORM ${s}.cms_steer_count(p_session_id, 'rejected:too_large');
        RETURN jsonb_build_object('outcome', 'too_large', 'limit', v_max_bytes);
    END IF;
    SELECT count(*) INTO v_n FROM ${s}.session_steering_requests
     WHERE session_id = p_session_id AND status NOT IN ('closed', 'withdrawn');
    IF v_n >= v_max_unresolved THEN
        PERFORM ${s}.cms_steer_count(p_session_id, 'rejected:rate_limited');
        RETURN jsonb_build_object('outcome', 'rate_limited', 'reason', 'unresolved_cap', 'limit', v_max_unresolved);
    END IF;
    SELECT count(*) INTO v_n FROM ${s}.session_steering_requests
     WHERE actor->>'provider' = p_actor->>'provider' AND actor->>'subject' = p_actor->>'subject'
       AND accepted_at > now() - interval '1 minute';
    IF v_n >= v_rate THEN
        PERFORM ${s}.cms_steer_count(p_session_id, 'rejected:rate_limited');
        RETURN jsonb_build_object('outcome', 'rate_limited', 'reason', 'actor_rate', 'limit', v_rate,
                                  'retryAfterMs', 60000);
    END IF;
    INSERT INTO ${s}.session_steering_requests (request_id, session_id, seq, idempotency_key, actor, content,
        content_hash, transcript_epoch, turn_index, incarnation, status, disposition, revision, accepted_at)
    VALUES (p_request_id, p_session_id, nextval('${s}.session_steering_seq'), p_idem, p_actor, p_content,
        p_hash, p_epoch, p_turn, p_incarnation, 'pending', 'accepted', 1, now())
    ON CONFLICT (session_id, idempotency_key) DO NOTHING
    RETURNING true INTO inserted;
    SELECT * INTO r FROM ${s}.session_steering_requests WHERE session_id = p_session_id AND idempotency_key = p_idem;
    IF NOT COALESCE(inserted, false) THEN
        RETURN ${s}.cms_steer_match_or_conflict(r, p_actor, p_hash, p_epoch, p_turn, p_incarnation);
    END IF;
    PERFORM ${s}.cms_steer_record_event(p_session_id, 'session.steering_accepted', r.request_id);
    PERFORM pg_notify('pilotswarm_steering', p_session_id);   -- hint only, no content (D-14)
    RETURN jsonb_build_object('outcome', 'accepted', 'duplicate', false,
                              'receipt', ${s}.cms_steer_projection(r.request_id, true));
END $$;

-- ─── Windows ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_steer_window_open(
    p_session_id TEXT, p_epoch INT, p_turn INT, p_incarnation TEXT, p_owner TEXT, p_lease_ms INT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE w RECORD; has_window BOOLEAN; o RECORD; v_id TEXT; v_recovered JSONB := '[]'::JSONB;
BEGIN
    PERFORM ${s}.cms_steer_lock_session(p_session_id);
    SELECT * INTO w FROM ${s}.session_steering_windows
     WHERE session_id = p_session_id AND transcript_epoch = p_epoch AND turn_index = p_turn
       AND incarnation = p_incarnation FOR UPDATE;
    has_window := FOUND;
    IF has_window AND w.state = 'closed' THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'closed', 'recovered', '[]'::JSONB);
    END IF;
    IF EXISTS (SELECT 1 FROM ${s}.session_steering_windows
                WHERE session_id = p_session_id AND (transcript_epoch, turn_index) > (p_epoch, p_turn)) THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'stale', 'recovered', '[]'::JSONB);
    END IF;
    IF has_window THEN
        -- Same target re-opened by a redelivered activity: recovery.
        UPDATE ${s}.session_steering_windows
           SET owner_token = p_owner, state = 'open', quiesced_at = NULL,
               lease_expires_at = now() + make_interval(secs => p_lease_ms / 1000.0)
         WHERE session_id = p_session_id AND transcript_epoch = p_epoch AND turn_index = p_turn
           AND incarnation = p_incarnation;
        FOR v_id IN
            UPDATE ${s}.session_steering_requests r SET
                status = 'orphaned', owner_token = NULL, revision = r.revision + 1,
                recovery_check = CASE WHEN EXISTS (SELECT 1 FROM ${s}.session_steering_attempts a
                                                    WHERE a.request_id = r.request_id AND a.sdk_message_id IS NOT NULL)
                                      THEN 'pending' ELSE NULL END
             WHERE r.session_id = p_session_id AND r.transcript_epoch = p_epoch AND r.turn_index = p_turn
               AND r.incarnation = p_incarnation
               AND r.status IN ('claimed', 'submitting', 'submitted', 'delivered', 'orphaned')
               AND r.included IS DISTINCT FROM 'included'
            RETURNING r.request_id
        LOOP
            PERFORM ${s}.cms_steer_record_event(p_session_id, 'session.steering_updated', v_id);
        END LOOP;
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'requestId', r.request_id, 'sequence', r.seq, 'recoveryCheck', r.recovery_check,
                   'sdkMessageId', (SELECT a.sdk_message_id FROM ${s}.session_steering_attempts a
                                     WHERE a.request_id = r.request_id AND a.sdk_message_id IS NOT NULL
                                     ORDER BY a.attempt_no DESC LIMIT 1),
                   'sdkMessageIds', COALESCE((SELECT jsonb_agg(a.sdk_message_id ORDER BY a.attempt_no)
                                     FROM ${s}.session_steering_attempts a
                                     WHERE a.request_id = r.request_id AND a.sdk_message_id IS NOT NULL), '[]'::JSONB))
                   ORDER BY r.seq), '[]'::JSONB)
          INTO v_recovered
          FROM ${s}.session_steering_requests r
         WHERE r.session_id = p_session_id AND r.transcript_epoch = p_epoch AND r.turn_index = p_turn
           AND r.incarnation = p_incarnation AND r.status = 'orphaned';
        PERFORM ${s}.cms_steer_window_event(p_session_id, 'open',
            ${s}.cms_steer_target_token(p_session_id, p_epoch, p_turn, p_incarnation), 'recovered');
        RETURN jsonb_build_object('ok', true, 'recovery', true, 'recovered', v_recovered);
    END IF;
    -- A new target: finalize any other live target of this session first (D-29 backstop).
    FOR o IN SELECT transcript_epoch, turn_index, incarnation FROM ${s}.session_steering_windows
              WHERE session_id = p_session_id AND state <> 'closed' LOOP
        PERFORM ${s}.cms_steer_close_target(p_session_id, o.transcript_epoch, o.turn_index, o.incarnation, 'turn_ended', 'superseded');
    END LOOP;
    INSERT INTO ${s}.session_steering_windows (session_id, transcript_epoch, turn_index, incarnation,
        owner_token, lease_expires_at, state, opened_at)
    VALUES (p_session_id, p_epoch, p_turn, p_incarnation, p_owner,
        now() + make_interval(secs => p_lease_ms / 1000.0), 'open', now());
    PERFORM ${s}.cms_steer_window_event(p_session_id, 'open',
        ${s}.cms_steer_target_token(p_session_id, p_epoch, p_turn, p_incarnation), 'turn_started');
    RETURN jsonb_build_object('ok', true, 'recovery', false, 'recovered', '[]'::JSONB);
END $$;

CREATE OR REPLACE FUNCTION ${s}.cms_steer_window_abandon(
    p_session_id TEXT, p_epoch INT, p_turn INT, p_incarnation TEXT, p_owner TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE w RECORD; has_window BOOLEAN;
BEGIN
    PERFORM ${s}.cms_steer_lock_session(p_session_id);
    SELECT * INTO w FROM ${s}.session_steering_windows
     WHERE session_id = p_session_id AND transcript_epoch = p_epoch AND turn_index = p_turn
       AND incarnation = p_incarnation FOR UPDATE;
    has_window := FOUND;
    IF NOT has_window THEN
        INSERT INTO ${s}.session_steering_windows (session_id, transcript_epoch, turn_index, incarnation,
            owner_token, lease_expires_at, state, opened_at, closed_reason, closed_at)
        SELECT p_session_id, p_epoch, p_turn, p_incarnation, p_owner, now(), 'closed', now(), 'abandoned', now()
         WHERE EXISTS (SELECT 1 FROM ${s}.sessions WHERE session_id = p_session_id);
        RETURN true;
    END IF;
    IF w.state = 'closed' THEN RETURN true; END IF;
    IF w.owner_token IS DISTINCT FROM p_owner THEN RETURN false; END IF;
    PERFORM ${s}.cms_steer_close_target(p_session_id, p_epoch, p_turn, p_incarnation, 'turn_ended', 'abandoned');
    RETURN true;
END $$;

CREATE OR REPLACE FUNCTION ${s}.cms_steer_window_renew(p_session_id TEXT, p_owner TEXT, p_lease_ms INT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE v_n INT;
BEGIN
    UPDATE ${s}.session_steering_windows
       SET lease_expires_at = now() + make_interval(secs => p_lease_ms / 1000.0)
     WHERE session_id = p_session_id AND state IN ('open', 'quiesced') AND owner_token = p_owner;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n > 0;
END $$;

CREATE OR REPLACE FUNCTION ${s}.cms_steer_window_quiesce(p_session_id TEXT, p_owner TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE v_n INT;
BEGIN
    PERFORM ${s}.cms_steer_lock_session(p_session_id);
    UPDATE ${s}.session_steering_windows SET state = 'quiesced', quiesced_at = now()
     WHERE session_id = p_session_id AND state = 'open' AND owner_token = p_owner;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN PERFORM ${s}.cms_steer_window_event(p_session_id, 'quiesced', NULL, 'turn_settling'); END IF;
    RETURN v_n > 0;
END $$;

-- Already-committed recovery only (§6a.6, §7.3). Never opens admission or claims.
CREATE OR REPLACE FUNCTION ${s}.cms_steer_window_adopt(
    p_session_id TEXT, p_epoch INT, p_turn INT, p_incarnation TEXT, p_owner TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE w RECORD; has_window BOOLEAN; v_was TEXT;
BEGIN
    PERFORM ${s}.cms_steer_lock_session(p_session_id);
    SELECT * INTO w FROM ${s}.session_steering_windows
     WHERE session_id = p_session_id AND transcript_epoch = p_epoch AND turn_index = p_turn
       AND incarnation = p_incarnation FOR UPDATE;
    has_window := FOUND;
    IF NOT has_window OR w.state = 'closed' THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM ${s}.session_steering_windows
                WHERE session_id = p_session_id AND (transcript_epoch, turn_index) > (p_epoch, p_turn)) THEN
        RETURN false;
    END IF;
    v_was := w.state;
    UPDATE ${s}.session_steering_windows
       SET owner_token = p_owner, state = 'quiesced', lease_expires_at = now(), quiesced_at = COALESCE(quiesced_at, now())
     WHERE session_id = p_session_id AND transcript_epoch = p_epoch AND turn_index = p_turn
       AND incarnation = p_incarnation;
    IF v_was = 'open' THEN PERFORM ${s}.cms_steer_window_event(p_session_id, 'quiesced', NULL, 'adopted'); END IF;
    RETURN true;
END $$;

-- ─── Pump: claim and hand-off ────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_steer_claim(p_session_id TEXT, p_owner TEXT, p_limit INT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE w RECORD; v_ids TEXT[] := '{}'; v_id TEXT;
BEGIN
    SELECT * INTO w FROM ${s}.session_steering_windows
     WHERE session_id = p_session_id AND state = 'open' AND owner_token = p_owner
       AND lease_expires_at > now() FOR SHARE;
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

CREATE OR REPLACE FUNCTION ${s}.cms_steer_record_recovery_check(
    p_request_id TEXT, p_owner TEXT, p_result TEXT, p_sdk_message_id TEXT DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE r RECORD; w RECORD; v_attempt TEXT;
BEGIN
    IF p_result NOT IN ('present', 'absent', 'failed') THEN RAISE EXCEPTION 'invalid recovery result %', p_result; END IF;
    SELECT * INTO r FROM ${s}.session_steering_requests WHERE request_id = p_request_id;
    IF NOT FOUND THEN RETURN false; END IF;
    PERFORM ${s}.cms_steer_lock_session(r.session_id);
    SELECT * INTO w FROM ${s}.session_steering_windows
     WHERE session_id = r.session_id AND transcript_epoch = r.transcript_epoch AND turn_index = r.turn_index
       AND incarnation = r.incarnation AND state = 'open' AND owner_token = p_owner FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
    SELECT * INTO r FROM ${s}.session_steering_requests WHERE request_id = p_request_id FOR UPDATE;
    IF r.status <> 'orphaned' THEN RETURN false; END IF;
    IF p_result = 'present' THEN
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
            status = 'delivered', recovery_check = 'present', included = 'included',
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

-- Write-ahead marker (D-29): committed BEFORE send(). Returns the attempt id, or NULL when not allowed.
CREATE OR REPLACE FUNCTION ${s}.cms_steer_mark_submitting(p_request_id TEXT, p_owner TEXT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE r RECORD; v_attempt TEXT; v_no INT;
BEGIN
    SELECT * INTO r FROM ${s}.session_steering_requests WHERE request_id = p_request_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    PERFORM 1 FROM ${s}.session_steering_windows
     WHERE session_id = r.session_id AND transcript_epoch = r.transcript_epoch AND turn_index = r.turn_index
       AND incarnation = r.incarnation AND state = 'open' AND owner_token = p_owner FOR SHARE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT * INTO r FROM ${s}.session_steering_requests WHERE request_id = p_request_id FOR UPDATE;
    IF r.status <> 'claimed' OR r.owner_token IS DISTINCT FROM p_owner THEN RETURN NULL; END IF;
    SELECT COALESCE(max(attempt_no), 0) + 1 INTO v_no FROM ${s}.session_steering_attempts WHERE request_id = p_request_id;
    v_attempt := gen_random_uuid()::TEXT;
    INSERT INTO ${s}.session_steering_attempts (attempt_id, request_id, session_id, attempt_no, owner_token, turn_key, submitting_at)
    VALUES (v_attempt, p_request_id, r.session_id, v_no, p_owner, r.incarnation, now());
    UPDATE ${s}.session_steering_requests SET status = 'submitting', revision = revision + 1
     WHERE request_id = p_request_id;
    PERFORM ${s}.cms_steer_record_event(r.session_id, 'session.steering_updated', p_request_id);
    RETURN v_attempt;
END $$;

-- The live pump positively knows it never called send(): attempt released, row back to pending.
CREATE OR REPLACE FUNCTION ${s}.cms_steer_mark_released(p_attempt_id TEXT, p_owner TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE a RECORD; r RECORD;
BEGIN
    SELECT * INTO a FROM ${s}.session_steering_attempts WHERE attempt_id = p_attempt_id;
    IF NOT FOUND OR a.owner_token <> p_owner OR a.outcome IS NOT NULL OR a.sdk_message_id IS NOT NULL THEN
        RETURN false;
    END IF;
    PERFORM ${s}.cms_steer_lock_session(a.session_id);
    SELECT * INTO r FROM ${s}.session_steering_requests WHERE request_id = a.request_id FOR UPDATE;
    UPDATE ${s}.session_steering_attempts SET outcome = 'released'
     WHERE attempt_id = p_attempt_id AND outcome IS NULL AND sdk_message_id IS NULL;
    IF r.status = 'submitting' AND r.owner_token = p_owner THEN
        UPDATE ${s}.session_steering_requests SET status = 'pending', owner_token = NULL, revision = revision + 1
         WHERE request_id = a.request_id;
    ELSIF r.status = 'closed' THEN   -- late evidence corrects the historical label only
        UPDATE ${s}.session_steering_requests
           SET disposition = ${s}.cms_steer_closed_disposition(request_id, closure_reason, disposition),
               revision = revision + 1
         WHERE request_id = a.request_id;
    ELSE
        UPDATE ${s}.session_steering_requests SET revision = revision + 1 WHERE request_id = a.request_id;
    END IF;
    PERFORM ${s}.cms_steer_record_event(a.session_id, 'session.steering_updated', a.request_id);
    RETURN true;
END $$;

CREATE OR REPLACE FUNCTION ${s}.cms_steer_mark_submitted(p_attempt_id TEXT, p_owner TEXT, p_sdk_message_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE a RECORD; r RECORD;
BEGIN
    SELECT * INTO a FROM ${s}.session_steering_attempts WHERE attempt_id = p_attempt_id;
    IF NOT FOUND OR a.owner_token <> p_owner OR COALESCE(p_sdk_message_id, '') = '' THEN RETURN false; END IF;
    IF a.sdk_message_id IS NOT NULL AND a.sdk_message_id <> p_sdk_message_id THEN RETURN false; END IF;
    PERFORM ${s}.cms_steer_lock_session(a.session_id);
    SELECT * INTO r FROM ${s}.session_steering_requests WHERE request_id = a.request_id FOR UPDATE;
    UPDATE ${s}.session_steering_attempts
       SET sdk_message_id = p_sdk_message_id,
           acknowledged_at = COALESCE(acknowledged_at, now()),
           outcome = CASE WHEN outcome IS NULL OR outcome = 'unconfirmed' THEN 'acknowledged' ELSE outcome END
     WHERE attempt_id = p_attempt_id;
    -- Only the current owner's live row advances; a stale owner records attempt history only.
    IF r.status = 'submitting' AND r.owner_token = p_owner THEN
        UPDATE ${s}.session_steering_requests SET status = 'submitted', revision = revision + 1
         WHERE request_id = a.request_id;
    ELSE
        UPDATE ${s}.session_steering_requests SET revision = revision + 1 WHERE request_id = a.request_id;
    END IF;
    PERFORM ${s}.cms_steer_record_event(a.session_id, 'session.steering_updated', a.request_id);
    RETURN true;
END $$;

-- Correlated SDK user.message (D-03, D-16). Idempotent per (request, sdk id).
-- Writes the delivery evidence AND the single user.message projection.
CREATE OR REPLACE FUNCTION ${s}.cms_steer_mark_delivered(p_attempt_id TEXT, p_sdk_message_id TEXT, p_kind TEXT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE a RECORD; r RECORD; v_current BOOLEAN; v_disp TEXT; v_rev INT;
BEGIN
    IF p_kind NOT IN ('steering', 'queued', 'idle') THEN RAISE EXCEPTION 'invalid delivery kind %', p_kind; END IF;
    SELECT * INTO a FROM ${s}.session_steering_attempts WHERE attempt_id = p_attempt_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('changed', false, 'reason', 'not_found'); END IF;
    IF a.sdk_message_id IS NOT NULL AND a.sdk_message_id <> p_sdk_message_id THEN
        RETURN jsonb_build_object('changed', false, 'reason', 'message_id_mismatch');
    END IF;
    PERFORM ${s}.cms_steer_lock_session(a.session_id);
    SELECT * INTO a FROM ${s}.session_steering_attempts WHERE attempt_id = p_attempt_id FOR UPDATE;
    IF a.delivered_at IS NOT NULL THEN
        RETURN jsonb_build_object('changed', false, 'reason', 'already_recorded');
    END IF;
    SELECT * INTO r FROM ${s}.session_steering_requests WHERE request_id = a.request_id FOR UPDATE;
    UPDATE ${s}.session_steering_attempts
       SET sdk_message_id = p_sdk_message_id, acknowledged_at = COALESCE(acknowledged_at, now()),
           delivered_at = now(), delivery_kind = p_kind, outcome = 'delivered'
     WHERE attempt_id = p_attempt_id;
    v_current := r.owner_token = a.owner_token AND r.status IN ('claimed', 'submitting', 'submitted', 'delivered');
    IF r.status = 'closed' THEN
        v_disp := ${s}.cms_steer_closed_disposition(r.request_id, r.closure_reason, r.disposition);
    ELSIF r.disposition IN ('accepted', 'delivery_unconfirmed') THEN
        v_disp := CASE WHEN p_kind = 'steering' THEN 'delivered_current_turn' ELSE 'delivered_after_response' END;
    ELSE
        v_disp := r.disposition;
    END IF;
    UPDATE ${s}.session_steering_requests SET
        status = CASE WHEN v_current THEN 'delivered' ELSE status END,
        disposition = v_disp, revision = revision + 1
     WHERE request_id = a.request_id
    RETURNING revision INTO v_rev;
    PERFORM ${s}.cms_steer_record_event(a.session_id, 'session.steering_updated', a.request_id);
    INSERT INTO ${s}.session_events (session_id, event_type, data)
    VALUES (a.session_id, 'user.message', jsonb_build_object(
        'content', r.content,
        'sender', r.actor,
        'steering', jsonb_build_object('requestId', r.request_id, 'revision', v_rev,
                                       'attemptId', a.attempt_id, 'deliveryKind', p_kind)));
    RETURN jsonb_build_object('changed', true, 'current', v_current, 'revision', v_rev);
END $$;

CREATE OR REPLACE FUNCTION ${s}.cms_steer_mark_unconfirmed(p_attempt_id TEXT, p_owner TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE a RECORD; r RECORD;
BEGIN
    SELECT * INTO a FROM ${s}.session_steering_attempts WHERE attempt_id = p_attempt_id;
    IF NOT FOUND OR a.owner_token <> p_owner THEN RETURN false; END IF;
    IF a.outcome IS NOT NULL AND a.outcome <> 'acknowledged' THEN RETURN false; END IF;
    PERFORM ${s}.cms_steer_lock_session(a.session_id);
    SELECT * INTO r FROM ${s}.session_steering_requests WHERE request_id = a.request_id FOR UPDATE;
    UPDATE ${s}.session_steering_attempts SET outcome = 'unconfirmed'
     WHERE attempt_id = p_attempt_id AND (outcome IS NULL OR outcome = 'acknowledged') AND delivered_at IS NULL;
    -- Live uncertainty is shown at once ("Delivery uncertain"), not only at closure; a row with
    -- positive delivery keeps its delivered label. Eligibility and attempt history are unchanged.
    UPDATE ${s}.session_steering_requests SET
        disposition = CASE
            WHEN status = 'closed' THEN ${s}.cms_steer_closed_disposition(request_id, closure_reason, disposition)
            WHEN disposition = 'accepted' THEN 'delivery_unconfirmed'
            ELSE disposition END,
        revision = revision + 1
     WHERE request_id = a.request_id;
    PERFORM ${s}.cms_steer_record_event(a.session_id, 'session.steering_updated', a.request_id);
    RETURN true;
END $$;

-- ─── Finalize, Stop, withdraw (D-04, D-21, D-28, D-29) ───────────
-- p_outcome: published | adopted | unpublished | stopped | unknown. p_manifest: request ids of
-- the delivered entries of the saved result, or NULL when the result carried no manifest.
-- 'stopped' is an unpublished result whose target closes with reason 'stopped'.
-- On a target that Stop already closed, the current owner may still record inclusion;
-- closed rows are never reopened and their dispositions are not changed.
CREATE OR REPLACE FUNCTION ${s}.cms_steer_turn_finalize(
    p_session_id TEXT, p_epoch INT, p_turn INT, p_incarnation TEXT, p_owner TEXT,
    p_outcome TEXT, p_manifest TEXT[], p_snapshot_version INT)
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
    PERFORM ${s}.cms_steer_close_target(p_session_id, p_epoch, p_turn, p_incarnation,
        CASE WHEN p_outcome = 'stopped' THEN 'stopped' ELSE 'turn_ended' END, 'finalized');
    RETURN jsonb_build_object('finalized', true);
END $$;

-- Target-scoped by turn index: closes ALL non-terminal rows of that turn (orphaned included)
-- whatever the window state. Never touches another turn's window.
CREATE OR REPLACE FUNCTION ${s}.cms_steer_close_stopped(p_session_id TEXT, p_turn INT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE t RECORD;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM ${s}.session_steering_windows
                    WHERE session_id = p_session_id AND turn_index = p_turn AND state <> 'closed')
       AND NOT EXISTS (SELECT 1 FROM ${s}.session_steering_requests
                        WHERE session_id = p_session_id AND turn_index = p_turn
                          AND status NOT IN ('closed', 'withdrawn')) THEN
        RETURN;
    END IF;
    PERFORM ${s}.cms_steer_lock_session(p_session_id);
    FOR t IN SELECT DISTINCT transcript_epoch, turn_index, incarnation FROM (
                SELECT transcript_epoch, turn_index, incarnation FROM ${s}.session_steering_requests
                 WHERE session_id = p_session_id AND turn_index = p_turn AND status NOT IN ('closed', 'withdrawn')
                UNION
                SELECT transcript_epoch, turn_index, incarnation FROM ${s}.session_steering_windows
                 WHERE session_id = p_session_id AND turn_index = p_turn AND state <> 'closed') x
    LOOP
        PERFORM ${s}.cms_steer_close_target(p_session_id, t.transcript_epoch, t.turn_index, t.incarnation, 'stopped');
    END LOOP;
END $$;

-- Author (same canonical actor) or session manager only (D-32). Only before claim (D-07).
CREATE OR REPLACE FUNCTION ${s}.cms_steer_withdraw(
    p_session_id TEXT, p_request_id TEXT, p_actor JSONB, p_is_manager BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE r RECORD;
BEGIN
    SELECT * INTO r FROM ${s}.session_steering_requests
     WHERE request_id = p_request_id AND session_id = p_session_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
    IF NOT COALESCE(p_is_manager, false)
       AND ((r.actor->>'provider') IS DISTINCT FROM (p_actor->>'provider')
            OR (r.actor->>'subject') IS DISTINCT FROM (p_actor->>'subject')
            OR COALESCE(p_actor->>'subject', '') = '') THEN
        RETURN jsonb_build_object('outcome', 'forbidden');
    END IF;
    PERFORM ${s}.cms_steer_lock_session(p_session_id);
    SELECT * INTO r FROM ${s}.session_steering_requests WHERE request_id = p_request_id FOR UPDATE;
    IF r.status IN ('closed', 'withdrawn') THEN
        RETURN jsonb_build_object('outcome', 'already_settled', 'receipt', ${s}.cms_steer_projection(p_request_id, true));
    END IF;
    IF r.status <> 'pending' THEN
        RETURN jsonb_build_object('outcome', 'not_withdrawable', 'receipt', ${s}.cms_steer_projection(p_request_id, true));
    END IF;
    UPDATE ${s}.session_steering_requests SET
        status = 'withdrawn', closure_reason = 'withdrawn', disposition = 'withdrawn',
        settled_at = now(), revision = revision + 1
     WHERE request_id = p_request_id;
    PERFORM ${s}.cms_steer_record_event(p_session_id, 'session.steering_updated', p_request_id);
    PERFORM pg_notify('pilotswarm_steering', p_session_id);
    RETURN jsonb_build_object('outcome', 'withdrawn', 'receipt', ${s}.cms_steer_projection(p_request_id, true));
END $$;

-- ─── Reads ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ${s}.cms_steer_get(
    p_session_id TEXT, p_request_id TEXT, p_attempt_after INT DEFAULT 0, p_attempt_limit INT DEFAULT 20)
RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT ${s}.cms_steer_projection(r.request_id, true, p_attempt_after, p_attempt_limit)
      FROM ${s}.session_steering_requests r
     WHERE r.request_id = p_request_id AND r.session_id = p_session_id;
$$;

-- Server-sequence page. Optional disposition filter and target filter.
CREATE OR REPLACE FUNCTION ${s}.cms_steer_list(
    p_session_id TEXT, p_after_seq BIGINT, p_limit INT, p_dispositions TEXT[],
    p_epoch INT, p_turn INT, p_incarnation TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200); v_ids TEXT[]; v_seqs BIGINT[]; v_more BOOLEAN;
BEGIN
    SELECT array_agg(request_id ORDER BY seq), array_agg(seq ORDER BY seq) INTO v_ids, v_seqs
      FROM (SELECT request_id, seq FROM ${s}.session_steering_requests
             WHERE session_id = p_session_id AND seq > COALESCE(p_after_seq, 0)
               AND (p_dispositions IS NULL OR disposition = ANY(p_dispositions))
               AND (p_epoch IS NULL OR transcript_epoch = p_epoch)
               AND (p_turn IS NULL OR turn_index = p_turn)
               AND (p_incarnation IS NULL OR incarnation = p_incarnation)
             ORDER BY seq LIMIT v_limit + 1) x;
    v_more := COALESCE(array_length(v_ids, 1), 0) > v_limit;
    IF v_more THEN v_ids := v_ids[1:v_limit]; v_seqs := v_seqs[1:v_limit]; END IF;
    RETURN jsonb_build_object(
        'items', COALESCE((SELECT jsonb_agg(${s}.cms_steer_projection(id, true, 0, 20) ORDER BY ord)
                             FROM unnest(v_ids) WITH ORDINALITY AS u(id, ord)), '[]'::JSONB),
        'nextAfterSeq', CASE WHEN v_more THEN v_seqs[v_limit] ELSE NULL END);
END $$;

-- Current window and admission facts for getSessionSteeringState. Stale leases read as recovering.
-- windowSeq: session_events.seq of the latest session.steering_window_changed (0 when none), so a
-- client can order this read against live window events (a newer event wins; an older one is ignored).
CREATE OR REPLACE FUNCTION ${s}.cms_steer_state(p_session_id TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE w RECORD; has_window BOOLEAN; v_fresh BOOLEAN; v_unresolved INT; v_seq BIGINT;
BEGIN
    SELECT COALESCE(max(seq), 0) INTO v_seq FROM ${s}.session_events
     WHERE session_id = p_session_id AND event_type = 'session.steering_window_changed';
    SELECT count(*) INTO v_unresolved FROM ${s}.session_steering_requests
     WHERE session_id = p_session_id AND status NOT IN ('closed', 'withdrawn');
    SELECT * INTO w FROM ${s}.session_steering_windows WHERE session_id = p_session_id AND state <> 'closed';
    has_window := FOUND;
    IF NOT has_window THEN
        RETURN jsonb_build_object('steerable', false, 'reason', 'no_active_turn', 'recovering', false,
                                  'expectedTarget', NULL, 'window', NULL, 'unresolved', v_unresolved,
                                  'windowSeq', v_seq);
    END IF;
    v_fresh := w.lease_expires_at IS NOT NULL AND w.lease_expires_at > now();
    RETURN jsonb_build_object(
        'steerable', w.state = 'open' AND v_fresh,
        'reason', CASE WHEN w.state = 'open' AND v_fresh THEN NULL ELSE 'no_active_turn' END,
        'recovering', w.state = 'open' AND NOT v_fresh,
        'expectedTarget', CASE WHEN w.state = 'open' AND v_fresh
                               THEN ${s}.cms_steer_target_token(p_session_id, w.transcript_epoch, w.turn_index, w.incarnation)
                               ELSE NULL END,
        'window', jsonb_build_object(
            'state', w.state, 'transcriptEpoch', w.transcript_epoch, 'turnIndex', w.turn_index,
            'leaseFresh', v_fresh, 'openedAt', ${s}.cms_steer_iso(w.opened_at),
            'leaseExpiresAt', ${s}.cms_steer_iso(w.lease_expires_at)),
        'unresolved', v_unresolved,
        'windowSeq', v_seq);
END $$;

-- Aggregates for §11 (no content, no identities). p_since bounds request/attempt rows.
CREATE OR REPLACE FUNCTION ${s}.cms_steer_stats(p_session_id TEXT, p_since TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE v_req JSONB; v_att JSONB; v_lat JSONB; v_counters JSONB; v_windows JSONB; v_since TIMESTAMPTZ := COALESCE(p_since, '-infinity');
BEGIN
    SELECT jsonb_build_object(
        'accepted', count(*),
        'unresolved', count(*) FILTER (WHERE status NOT IN ('closed', 'withdrawn')),
        'claimable', count(*) FILTER (WHERE status = 'pending'
                                     OR (status = 'orphaned' AND (recovery_check IS NULL OR recovery_check = 'absent'))),
        'oldestUnresolvedAt', ${s}.cms_steer_iso(min(accepted_at) FILTER (WHERE status NOT IN ('closed', 'withdrawn'))),
        'byDisposition', COALESCE((SELECT jsonb_object_agg(d, n) FROM (
             SELECT disposition d, count(*) n FROM ${s}.session_steering_requests
              WHERE session_id = p_session_id AND accepted_at >= v_since GROUP BY disposition) t), '{}'::JSONB),
        'byInclusion', jsonb_build_object(
             'included', count(*) FILTER (WHERE included = 'included'),
             'notIncluded', count(*) FILTER (WHERE included = 'not_included'),
             'unconfirmed', count(*) FILTER (WHERE included = 'unconfirmed')),
        'recoveryChecks', jsonb_build_object(
             'pending', count(*) FILTER (WHERE recovery_check = 'pending'),
             'present', count(*) FILTER (WHERE recovery_check = 'present'),
             'absent', count(*) FILTER (WHERE recovery_check = 'absent'),
             'failed', count(*) FILTER (WHERE recovery_check = 'failed')))
      INTO v_req
      FROM ${s}.session_steering_requests WHERE session_id = p_session_id AND accepted_at >= v_since;

    SELECT jsonb_build_object(
        'attempts', count(*),
        'deliveries', count(*) FILTER (WHERE delivered_at IS NOT NULL),
        'deliveredByKind', jsonb_build_object(
             'steering', count(*) FILTER (WHERE delivery_kind = 'steering'),
             'queued', count(*) FILTER (WHERE delivery_kind = 'queued'),
             'idle', count(*) FILTER (WHERE delivery_kind = 'idle')),
        'redeliveries', count(*) FILTER (WHERE delivered_at IS NOT NULL AND EXISTS (
             SELECT 1 FROM ${s}.session_steering_attempts p
              WHERE p.request_id = a.request_id AND p.attempt_no < a.attempt_no AND p.delivered_at IS NOT NULL)),
        'released', count(*) FILTER (WHERE outcome = 'released'),
        'unconfirmed', count(*) FILTER (WHERE outcome = 'unconfirmed'),
        'inFlight', count(*) FILTER (WHERE outcome IS NULL OR outcome = 'acknowledged'))
      INTO v_att
      FROM ${s}.session_steering_attempts a WHERE a.session_id = p_session_id AND a.submitting_at >= v_since;

    SELECT jsonb_build_object(
        'handoffMs', (SELECT jsonb_build_object('count', count(*),
                'p50', percentile_cont(0.5) WITHIN GROUP (ORDER BY ms), 'p95', percentile_cont(0.95) WITHIN GROUP (ORDER BY ms))
              FROM (SELECT EXTRACT(EPOCH FROM (a.acknowledged_at - r.accepted_at)) * 1000 AS ms
                      FROM ${s}.session_steering_attempts a
                      JOIN ${s}.session_steering_requests r ON r.request_id = a.request_id
                     WHERE a.session_id = p_session_id AND a.attempt_no = 1 AND a.acknowledged_at IS NOT NULL
                       AND r.accepted_at >= v_since) h),
        'safePointMs', (SELECT jsonb_build_object('count', count(*),
                'p50', percentile_cont(0.5) WITHIN GROUP (ORDER BY ms), 'p95', percentile_cont(0.95) WITHIN GROUP (ORDER BY ms))
              FROM (SELECT EXTRACT(EPOCH FROM (delivered_at - submitting_at)) * 1000 AS ms
                      FROM ${s}.session_steering_attempts
                     WHERE session_id = p_session_id AND delivered_at IS NOT NULL AND delivery_kind IS NOT NULL
                       AND submitting_at >= v_since) d))
      INTO v_lat;

    SELECT COALESCE(jsonb_object_agg(name, value), '{}'::JSONB) INTO v_counters
      FROM ${s}.session_steering_counters WHERE session_id = p_session_id;

    SELECT jsonb_build_object(
        'opened', count(*) FILTER (WHERE closed_reason IS DISTINCT FROM 'abandoned' OR state <> 'closed'),
        'abandoned', count(*) FILTER (WHERE closed_reason = 'abandoned'),
        'openDurationMs', (SELECT jsonb_build_object('count', count(*),
                'p50', percentile_cont(0.5) WITHIN GROUP (ORDER BY ms), 'p95', percentile_cont(0.95) WITHIN GROUP (ORDER BY ms))
              FROM (SELECT EXTRACT(EPOCH FROM (COALESCE(quiesced_at, closed_at) - opened_at)) * 1000 AS ms
                      FROM ${s}.session_steering_windows
                     WHERE session_id = p_session_id AND COALESCE(quiesced_at, closed_at) IS NOT NULL
                       AND closed_reason IS DISTINCT FROM 'abandoned' AND opened_at >= v_since) o))
      INTO v_windows
      FROM ${s}.session_steering_windows WHERE session_id = p_session_id AND opened_at >= v_since;

    RETURN jsonb_build_object('schemaVersion', 1, 'requests', v_req, 'attempts', v_att,
        'latency', v_lat, 'counters', v_counters, 'windows', v_windows,
        'since', ${s}.cms_steer_iso(p_since));
END $$;

-- ─── Backstops on existing procedures (same bodies as their latest versions) ──
-- cms_record_events (0004) + the durable Stop authority: session.turn_stopped
-- closes that turn's steering in the same transaction (§6a.3).
CREATE OR REPLACE FUNCTION ${s}.cms_record_events(
    p_session_id     TEXT,
    p_events         JSONB,
    p_worker_node_id TEXT
) RETURNS VOID AS $$
DECLARE v_turn TEXT;
BEGIN
    INSERT INTO ${s}.session_events (session_id, event_type, data, worker_node_id)
    SELECT
        p_session_id,
        (elem->>'eventType'),
        (elem->'data'),
        p_worker_node_id
    FROM jsonb_array_elements(p_events) AS elem;

    IF jsonb_typeof(p_events) = 'array' AND p_events @> '[{"eventType":"session.turn_stopped"}]'::JSONB THEN
        FOR v_turn IN
            SELECT elem->'data'->>'turnIndex' FROM jsonb_array_elements(p_events) AS elem
             WHERE elem->>'eventType' = 'session.turn_stopped'
               AND (elem->'data'->>'turnIndex') ~ '^-?[0-9]{1,9}$'
        LOOP
            PERFORM ${s}.cms_steer_close_stopped(p_session_id, v_turn::INT);
        END LOOP;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- cms_update_session (0059) + terminal-state backstop. Never acts on idle,
-- waiting, input_required or error: those can arrive while a turn is commit-pending.
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

    IF (p_updates ? 'state') AND (p_updates->>'state') IN ('failed', 'cancelled', 'completed') THEN
        PERFORM ${s}.cms_steer_close_session(p_session_id, 'session_' || (p_updates->>'state'));
    END IF;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- cms_soft_delete_session (0004) + deleted-session backstop.
CREATE OR REPLACE FUNCTION ${s}.cms_soft_delete_session(
    p_session_id TEXT
) RETURNS VOID AS $$
DECLARE
    v_is_system BOOLEAN;
BEGIN
    SELECT is_system INTO v_is_system
    FROM ${s}.sessions
    WHERE session_id = p_session_id;

    IF v_is_system THEN
        RAISE EXCEPTION 'Cannot delete system session';
    END IF;

    UPDATE ${s}.sessions
    SET deleted_at = now(), updated_at = now()
    WHERE session_id = p_session_id;

    UPDATE ${s}.session_metric_summaries
    SET deleted_at = now(), updated_at = now()
    WHERE session_id = p_session_id;

    PERFORM ${s}.cms_steer_close_session(p_session_id, 'session_deleted');
END;
$$ LANGUAGE plpgsql;

-- ─── Feature flag: sessions.steering (Off; no user override, D-23) ───
INSERT INTO ${s}.feature_flags (feature_key, display_name, description, default_enabled, default_allow_user_override, required_capability)
VALUES ('sessions.steering', 'Session steering',
        'Let people with write access send guidance to a running turn without stopping it. Turn on only after every worker runs a build that supports steering.',
        false, false, 'sessions.steering')
ON CONFLICT (feature_key) DO NOTHING;
INSERT INTO ${s}.feature_flag_settings (feature_key, scope, user_id, enabled, allow_user_override, revision, updated_by)
SELECT feature_key, 'cluster', NULL, false, false, revision, 'migration:0082'
FROM ${s}.feature_flags WHERE feature_key = 'sessions.steering'
ON CONFLICT (feature_key) WHERE scope = 'cluster' DO NOTHING;
`;
}
