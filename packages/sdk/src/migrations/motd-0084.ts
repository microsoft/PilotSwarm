/** Deployment-wide announcements. Dismissals deliberately outlive deleted messages. */
export function motdMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
CREATE TABLE IF NOT EXISTS ${s}.motds (
    motd_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    from_at TIMESTAMPTZ NOT NULL, to_at TIMESTAMPTZ NOT NULL,
    body_md TEXT NOT NULL CHECK (octet_length(body_md) BETWEEN 1 AND 16384),
    mobile_body_md TEXT CHECK (octet_length(mobile_body_md) BETWEEN 1 AND 16384),
    image BYTEA CHECK (octet_length(image) BETWEEN 1 AND 2097152),
    image_type TEXT, image_alt TEXT,
    mobile_image BYTEA CHECK (octet_length(mobile_image) BETWEEN 1 AND 2097152),
    mobile_image_type TEXT, mobile_image_alt TEXT,
    image_placement TEXT NOT NULL DEFAULT 'above' CHECK (image_placement IN ('above', 'beside', 'background')),
    created_by_provider TEXT NOT NULL, created_by_subject TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_id TEXT UNIQUE NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
    request_hash TEXT NOT NULL,
    CHECK (isfinite(from_at) AND isfinite(to_at) AND to_at > from_at),
    CHECK ((image IS NULL AND image_type IS NULL AND image_alt IS NULL) OR
        (image IS NOT NULL AND image_type IS NOT NULL AND image_alt IS NOT NULL
            AND image_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif') AND length(btrim(image_alt)) BETWEEN 1 AND 1024)),
    CHECK ((mobile_image IS NULL AND mobile_image_type IS NULL AND mobile_image_alt IS NULL) OR
        (mobile_image IS NOT NULL AND mobile_image_type IS NOT NULL AND mobile_image_alt IS NOT NULL
            AND mobile_image_type IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif') AND length(btrim(mobile_image_alt)) BETWEEN 1 AND 1024))
);
CREATE INDEX IF NOT EXISTS motds_window ON ${s}.motds(from_at DESC, created_at DESC, motd_id DESC);
CREATE TABLE IF NOT EXISTS ${s}.motd_dismissals (
    user_id BIGINT NOT NULL, motd_id BIGINT NOT NULL, dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, motd_id)
);
CREATE INDEX IF NOT EXISTS motd_dismissals_by_message ON ${s}.motd_dismissals(motd_id);

CREATE OR REPLACE FUNCTION ${s}.cms_motd_actor(p_provider TEXT, p_subject TEXT, p_admin BOOLEAN, p_admin_required BOOLEAN)
RETURNS BIGINT LANGUAGE plpgsql STABLE AS $$
DECLARE v_user BIGINT;
BEGIN
    IF COALESCE(btrim(p_provider), '') = '' OR COALESCE(btrim(p_subject), '') = '' THEN
        RAISE EXCEPTION 'MOTD_FORBIDDEN: An authenticated actor is required';
    END IF;
    IF p_admin_required AND NOT COALESCE(p_admin, false) THEN
        RAISE EXCEPTION 'MOTD_FORBIDDEN: Message management requires admin';
    END IF;
    SELECT user_id INTO v_user FROM ${s}.users WHERE provider = p_provider AND subject = p_subject;
    RETURN v_user;
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_motd_json(m ${s}.motds) RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object('motdId', m.motd_id::TEXT, 'fromAt', m.from_at, 'toAt', m.to_at,
        'bodyMd', m.body_md, 'mobileBodyMd', m.mobile_body_md, 'hasImage', m.image IS NOT NULL,
        'imageType', m.image_type, 'imageAlt', m.image_alt, 'imagePlacement', m.image_placement,
        'hasMobileImage', m.mobile_image IS NOT NULL, 'mobileImageType', m.mobile_image_type,
        'mobileImageAlt', m.mobile_image_alt, 'createdAt', m.created_at,
        'createdBy', jsonb_build_object('provider', m.created_by_provider, 'subject', m.created_by_subject));
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_motd_current(p_provider TEXT, p_subject TEXT, p_admin BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE v_user BIGINT; v_result JSONB;
BEGIN
    v_user := ${s}.cms_motd_actor(p_provider, p_subject, p_admin, false);
    SELECT ${s}.cms_motd_json(m) - 'createdBy' INTO v_result FROM ${s}.motds m
        WHERE m.from_at <= now() AND now() < m.to_at
        AND NOT EXISTS (SELECT 1 FROM ${s}.motd_dismissals d WHERE d.user_id = v_user AND d.motd_id = m.motd_id)
        ORDER BY m.from_at DESC, m.created_at DESC, m.motd_id DESC LIMIT 1;
    RETURN v_result;
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_motd_list(p_provider TEXT, p_subject TEXT, p_admin BOOLEAN, p_limit INT, p_before BIGINT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE v_live BIGINT;
BEGIN
    PERFORM ${s}.cms_motd_actor(p_provider, p_subject, p_admin, true);
    SELECT motd_id INTO v_live FROM ${s}.motds WHERE from_at <= now() AND now() < to_at
        ORDER BY from_at DESC, created_at DESC, motd_id DESC LIMIT 1;
    RETURN COALESCE((SELECT jsonb_agg(${s}.cms_motd_json(m) || jsonb_build_object(
        'dismissalCount', (SELECT count(*) FROM ${s}.motd_dismissals d WHERE d.motd_id = m.motd_id),
        'status', CASE WHEN m.from_at > now() THEN 'scheduled' WHEN m.to_at <= now() THEN 'ended'
            WHEN m.motd_id = v_live THEN 'live' ELSE 'hidden' END) ORDER BY m.motd_id DESC)
        FROM (SELECT * FROM ${s}.motds WHERE p_before IS NULL OR motd_id < p_before
            ORDER BY motd_id DESC LIMIT LEAST(200, GREATEST(1, COALESCE(p_limit, 50)))) m), '[]'::JSONB);
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_motd_create(p_provider TEXT, p_subject TEXT, p_admin BOOLEAN, p_input JSONB, p_image BYTEA, p_mobile_image BYTEA)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_hash TEXT; v_existing ${s}.motds; v_result JSONB; v_from TIMESTAMPTZ; v_to TIMESTAMPTZ;
BEGIN
    PERFORM ${s}.cms_motd_actor(p_provider, p_subject, p_admin, true);
    IF COALESCE(length(btrim(p_input->>'requestId')), 0) NOT BETWEEN 1 AND 128
        OR COALESCE(octet_length(p_input->>'bodyMd'), 0) NOT BETWEEN 1 AND 16384
        OR (p_input->>'mobileBodyMd' IS NOT NULL AND octet_length(p_input->>'mobileBodyMd') NOT BETWEEN 1 AND 16384)
        OR COALESCE(p_input->>'imagePlacement', 'above') NOT IN ('above', 'beside', 'background') THEN
        RAISE EXCEPTION 'MOTD_INVALID: Invalid message body, placement or request ID';
    END IF;
    BEGIN
        v_from := (p_input->>'fromAt')::TIMESTAMPTZ; v_to := (p_input->>'toAt')::TIMESTAMPTZ;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'MOTD_INVALID: Invalid message window';
    END;
    IF v_from IS NULL OR v_to IS NULL OR NOT isfinite(v_from) OR NOT isfinite(v_to) OR v_to <= v_from THEN
        RAISE EXCEPTION 'MOTD_INVALID: Invalid message window';
    END IF;
    IF (p_image IS NOT NULL AND (octet_length(p_image) NOT BETWEEN 1 AND 2097152
            OR COALESCE(p_input->>'imageType', '') NOT IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
            OR COALESCE(length(btrim(p_input->>'imageAlt')), 0) NOT BETWEEN 1 AND 1024))
        OR (p_mobile_image IS NOT NULL AND (octet_length(p_mobile_image) NOT BETWEEN 1 AND 2097152
            OR COALESCE(p_input->>'mobileImageType', '') NOT IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
            OR COALESCE(length(btrim(p_input->>'mobileImageAlt')), 0) NOT BETWEEN 1 AND 1024)) THEN
        RAISE EXCEPTION 'MOTD_INVALID: Invalid picture type, size or alt text';
    END IF;
    v_hash := md5(jsonb_build_array(p_input, encode(p_image, 'base64'), encode(p_mobile_image, 'base64'))::TEXT);
    PERFORM pg_advisory_xact_lock(hashtextextended(p_input->>'requestId', 8401));
    SELECT * INTO v_existing FROM ${s}.motds WHERE request_id = p_input->>'requestId';
    IF FOUND THEN
        IF v_existing.created_by_provider IS DISTINCT FROM p_provider OR v_existing.created_by_subject IS DISTINCT FROM p_subject
            OR v_existing.request_hash IS DISTINCT FROM v_hash THEN
            RAISE EXCEPTION 'MOTD_CONFLICT: Request ID was used for different input';
        END IF;
        RETURN ${s}.cms_motd_json(v_existing);
    END IF;
    INSERT INTO ${s}.motds(from_at, to_at, body_md, mobile_body_md, image, image_type, image_alt,
        mobile_image, mobile_image_type, mobile_image_alt, image_placement, created_by_provider, created_by_subject, request_id, request_hash)
    VALUES (v_from, v_to, p_input->>'bodyMd', p_input->>'mobileBodyMd', p_image,
        CASE WHEN p_image IS NOT NULL THEN p_input->>'imageType' END, CASE WHEN p_image IS NOT NULL THEN p_input->>'imageAlt' END,
        p_mobile_image, CASE WHEN p_mobile_image IS NOT NULL THEN p_input->>'mobileImageType' END,
        CASE WHEN p_mobile_image IS NOT NULL THEN p_input->>'mobileImageAlt' END,
        COALESCE(p_input->>'imagePlacement', 'above'), p_provider, p_subject, p_input->>'requestId', v_hash)
    RETURNING ${s}.cms_motd_json(motds) INTO v_result;
    RETURN v_result;
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_motd_dismiss(p_provider TEXT, p_subject TEXT, p_admin BOOLEAN, p_id BIGINT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_user BIGINT;
BEGIN
    v_user := ${s}.cms_motd_actor(p_provider, p_subject, p_admin, false);
    IF p_id IS NULL OR p_id < 1 THEN RAISE EXCEPTION 'MOTD_INVALID: Invalid message ID'; END IF;
    IF NOT EXISTS (SELECT 1 FROM ${s}.motds WHERE motd_id = p_id) THEN
        RETURN jsonb_build_object('motdId', p_id::TEXT, 'dismissed', true);
    END IF;
    IF v_user IS NULL THEN v_user := ${s}.cms_register_user(p_provider, p_subject, NULL, NULL); END IF;
    -- A deletion racing this click must still acknowledge the dismissal.
    INSERT INTO ${s}.motd_dismissals(user_id, motd_id) VALUES (v_user, p_id) ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('motdId', p_id::TEXT, 'dismissed', true);
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_motd_delete(p_provider TEXT, p_subject TEXT, p_admin BOOLEAN, p_id BIGINT)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_deleted BOOLEAN;
BEGIN
    PERFORM ${s}.cms_motd_actor(p_provider, p_subject, p_admin, true);
    IF p_id IS NULL OR p_id < 1 THEN RAISE EXCEPTION 'MOTD_INVALID: Invalid message ID'; END IF;
    DELETE FROM ${s}.motds WHERE motd_id = p_id;
    v_deleted := FOUND;
    RETURN jsonb_build_object('motdId', p_id::TEXT, 'deleted', v_deleted);
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_motd_image(p_provider TEXT, p_subject TEXT, p_admin BOOLEAN, p_id BIGINT, p_mobile BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE m ${s}.motds;
BEGIN
    PERFORM ${s}.cms_motd_actor(p_provider, p_subject, p_admin, false);
    SELECT * INTO m FROM ${s}.motds WHERE motd_id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'MOTD_NOT_FOUND: Message not found'; END IF;
    IF NOT COALESCE(p_admin, false) AND NOT (m.from_at <= now() AND now() < m.to_at) THEN
        RAISE EXCEPTION 'MOTD_NOT_FOUND: Message not found';
    END IF;
    IF p_mobile AND m.mobile_image IS NOT NULL THEN
        RETURN jsonb_build_object('base64', replace(encode(m.mobile_image, 'base64'), E'\\n', ''), 'contentType', m.mobile_image_type, 'alt', m.mobile_image_alt);
    END IF;
    IF m.image IS NULL THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('base64', replace(encode(m.image, 'base64'), E'\\n', ''), 'contentType', m.image_type, 'alt', m.image_alt);
END;
$$;
`;
}
