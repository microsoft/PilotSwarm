/**
 * Migration 0084: idempotent "Send as new message" linkage (§3.5, OD-B, FR-8).
 *
 * A retained steer may be resent as an ordinary message with a fresh client
 * message id. This records the link (steer request → ordinary message id,
 * actual resender) once, before the ordinary send, with an idempotent replay:
 * the same (session, clientMessageId) for the same request and resender
 * returns the existing link; any other mapping is a conflict. It never
 * enqueues anything and changes no queue or orchestration shape.
 */
export function sessionSteeringResendMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
CREATE TABLE IF NOT EXISTS ${s}.session_steering_resend_intents (
    session_id         TEXT NOT NULL REFERENCES ${s}.sessions(session_id) ON DELETE CASCADE,
    client_message_id  TEXT NOT NULL,
    request_id         TEXT NOT NULL REFERENCES ${s}.session_steering_requests(request_id) ON DELETE CASCADE,
    actor              JSONB NOT NULL,
    sender             JSONB,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, client_message_id)
);
CREATE INDEX IF NOT EXISTS session_steering_resend_intents_by_request
    ON ${s}.session_steering_resend_intents (request_id, created_at);

-- p_actor: canonical resender { provider, subject } (server-stamped). p_sender: the stamped MessageSender.
CREATE OR REPLACE FUNCTION ${s}.cms_steer_record_resend_intent(
    p_session_id TEXT, p_request_id TEXT, p_client_message_id TEXT, p_actor JSONB, p_sender JSONB)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE r RECORD; i RECORD; inserted BOOLEAN;
BEGIN
    IF COALESCE(p_client_message_id, '') = '' OR COALESCE(p_actor->>'provider', '') = ''
       OR COALESCE(p_actor->>'subject', '') = '' THEN
        RETURN jsonb_build_object('outcome', 'invalid');
    END IF;
    SELECT * INTO r FROM ${s}.session_steering_requests WHERE request_id = p_request_id AND session_id = p_session_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'not_found'); END IF;
    -- Existing id first: a matching replay succeeds even if the row changed since.
    SELECT * INTO i FROM ${s}.session_steering_resend_intents
     WHERE session_id = p_session_id AND client_message_id = p_client_message_id;
    IF NOT FOUND THEN
        IF NOT (r.status IN ('closed', 'withdrawn')
                AND r.disposition IN ('not_delivered_turn_ended', 'not_delivered_turn_stopped', 'withdrawn')) THEN
            RETURN jsonb_build_object('outcome', 'not_resendable');
        END IF;
        INSERT INTO ${s}.session_steering_resend_intents (session_id, client_message_id, request_id, actor, sender)
        VALUES (p_session_id, p_client_message_id, p_request_id,
                jsonb_build_object('provider', p_actor->>'provider', 'subject', p_actor->>'subject'), p_sender)
        ON CONFLICT (session_id, client_message_id) DO NOTHING
        RETURNING true INTO inserted;
        SELECT * INTO i FROM ${s}.session_steering_resend_intents
         WHERE session_id = p_session_id AND client_message_id = p_client_message_id;
    END IF;
    IF i.request_id <> p_request_id
       OR (i.actor->>'provider') IS DISTINCT FROM (p_actor->>'provider')
       OR (i.actor->>'subject') IS DISTINCT FROM (p_actor->>'subject') THEN
        RETURN jsonb_build_object('outcome', 'conflict');       -- reveals nothing about the other mapping
    END IF;
    IF COALESCE(inserted, false) THEN
        INSERT INTO ${s}.session_events (session_id, event_type, data)
        VALUES (p_session_id, 'session.steering_resend_requested', jsonb_strip_nulls(jsonb_build_object(
            'schemaVersion', 1, 'requestId', p_request_id,
            'clientMessageIds', jsonb_build_array(p_client_message_id),
            'actor', i.actor, 'sender', p_sender)));
    END IF;
    RETURN jsonb_build_object('outcome', 'recorded', 'duplicate', NOT COALESCE(inserted, false),
        'linkage', jsonb_build_object('sessionId', i.session_id, 'requestId', i.request_id,
            'clientMessageId', i.client_message_id, 'actor', i.actor,
            'createdAt', ${s}.cms_steer_iso(i.created_at)));
END $$;
`;
}
