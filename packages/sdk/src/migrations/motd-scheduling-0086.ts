/** Optional end and latest-activation precedence, preserving deployed rows. */
export function motdSchedulingMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
ALTER TABLE ${s}.motds ALTER COLUMN to_at DROP NOT NULL;
DO $$
DECLARE c RECORD;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
        WHERE conrelid = '${s}.motds'::regclass AND contype = 'c'
        AND conkey @> ARRAY[
            (SELECT attnum FROM pg_attribute WHERE attrelid = '${s}.motds'::regclass AND attname = 'from_at'),
            (SELECT attnum FROM pg_attribute WHERE attrelid = '${s}.motds'::regclass AND attname = 'to_at')]::smallint[]
    LOOP EXECUTE format('ALTER TABLE ${s}.motds DROP CONSTRAINT %I', c.conname); END LOOP;
END;
$$;
ALTER TABLE ${s}.motds ADD CONSTRAINT motds_valid_window CHECK
    (isfinite(from_at) AND (to_at IS NULL OR (isfinite(to_at) AND to_at > from_at)));
CREATE INDEX IF NOT EXISTS motds_activation ON ${s}.motds
    (GREATEST(from_at, created_at) DESC, motd_id DESC);

CREATE OR REPLACE FUNCTION ${s}.cms_motd_json(m ${s}.motds) RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT jsonb_build_object('motdId', m.motd_id::TEXT, 'startsAt', m.from_at, 'endsAt', m.to_at,
        'fromAt', m.from_at, 'toAt', m.to_at,
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
        WHERE m.from_at <= now() AND (m.to_at IS NULL OR now() < m.to_at)
        AND NOT EXISTS (SELECT 1 FROM ${s}.motd_dismissals d WHERE d.user_id = v_user AND d.motd_id = m.motd_id)
        ORDER BY GREATEST(m.from_at, m.created_at) DESC, m.motd_id DESC LIMIT 1;
    RETURN v_result;
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_motd_list(p_provider TEXT, p_subject TEXT, p_admin BOOLEAN, p_limit INT, p_before BIGINT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE v_live BIGINT;
BEGIN
    PERFORM ${s}.cms_motd_actor(p_provider, p_subject, p_admin, false);
    SELECT motd_id INTO v_live FROM ${s}.motds WHERE from_at <= now() AND (to_at IS NULL OR now() < to_at)
        ORDER BY GREATEST(from_at, created_at) DESC, motd_id DESC LIMIT 1;
    RETURN COALESCE((SELECT jsonb_agg(
        (CASE WHEN COALESCE(p_admin, false) THEN ${s}.cms_motd_json(m) || jsonb_build_object(
            'dismissalCount', (SELECT count(*) FROM ${s}.motd_dismissals d WHERE d.motd_id = m.motd_id))
        ELSE ${s}.cms_motd_json(m) - 'createdBy' END)
        || jsonb_build_object('status', CASE WHEN m.from_at > now() THEN 'scheduled' WHEN m.to_at <= now() THEN 'ended'
            WHEN m.motd_id = v_live THEN 'live' ELSE 'hidden' END) ORDER BY m.motd_id DESC)
        FROM (SELECT * FROM ${s}.motds WHERE (p_before IS NULL OR motd_id < p_before)
            AND (COALESCE(p_admin, false) OR from_at <= now())
            ORDER BY motd_id DESC LIMIT LEAST(200, GREATEST(1, COALESCE(p_limit, 50)))) m), '[]'::JSONB);
END;
$$;
CREATE OR REPLACE FUNCTION ${s}.cms_motd_create(p_provider TEXT, p_subject TEXT, p_admin BOOLEAN, p_input JSONB, p_image BYTEA, p_mobile_image BYTEA)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE v_hash TEXT; v_existing ${s}.motds; v_result JSONB; v_start TIMESTAMPTZ; v_end TIMESTAMPTZ;
    v_now TIMESTAMPTZ := statement_timestamp(); v_metadata JSONB;
BEGIN
    PERFORM ${s}.cms_motd_actor(p_provider, p_subject, p_admin, true);
    IF COALESCE(length(btrim(p_input->>'requestId')), 0) NOT BETWEEN 1 AND 128
        OR COALESCE(octet_length(p_input->>'bodyMd'), 0) NOT BETWEEN 1 AND 16384
        OR (p_input->>'mobileBodyMd' IS NOT NULL AND octet_length(p_input->>'mobileBodyMd') NOT BETWEEN 1 AND 16384)
        OR COALESCE(p_input->>'imagePlacement', 'above') NOT IN ('above', 'beside', 'background') THEN
        RAISE EXCEPTION 'MOTD_INVALID: Invalid message body, placement or request ID';
    END IF;
    IF (p_input->>'startsAt' IS NOT NULL AND p_input->>'fromAt' IS NOT NULL
            AND p_input->>'startsAt' IS DISTINCT FROM p_input->>'fromAt')
        OR (p_input->>'endsAt' IS NOT NULL AND p_input->>'toAt' IS NOT NULL
            AND p_input->>'endsAt' IS DISTINCT FROM p_input->>'toAt') THEN
        RAISE EXCEPTION 'MOTD_INVALID: Conflicting message time fields';
    END IF;
    BEGIN
        v_start := COALESCE(p_input->>'startsAt', p_input->>'fromAt')::TIMESTAMPTZ;
        v_end := COALESCE(p_input->>'endsAt', p_input->>'toAt')::TIMESTAMPTZ;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'MOTD_INVALID: Invalid message time';
    END;
    IF (v_start IS NOT NULL AND NOT isfinite(v_start)) OR (v_end IS NOT NULL AND NOT isfinite(v_end))
        OR (v_start IS NOT NULL AND v_end IS NOT NULL AND v_end <= v_start) THEN
        RAISE EXCEPTION 'MOTD_INVALID: End must be after start when both are supplied';
    END IF;
    IF (p_image IS NOT NULL AND (octet_length(p_image) NOT BETWEEN 1 AND 2097152
            OR COALESCE(p_input->>'imageType', '') NOT IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
            OR COALESCE(length(btrim(p_input->>'imageAlt')), 0) NOT BETWEEN 1 AND 1024))
        OR (p_mobile_image IS NOT NULL AND (octet_length(p_mobile_image) NOT BETWEEN 1 AND 2097152
            OR COALESCE(p_input->>'mobileImageType', '') NOT IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')
            OR COALESCE(length(btrim(p_input->>'mobileImageAlt')), 0) NOT BETWEEN 1 AND 1024)) THEN
        RAISE EXCEPTION 'MOTD_INVALID: Invalid picture type, size or alt text';
    END IF;
    -- Hash the requested optional times, not the server-resolved creation time.
    v_metadata := p_input - 'startsAt' - 'endsAt' - 'fromAt' - 'toAt'
        || jsonb_build_object('fromAt', extract(epoch FROM v_start), 'toAt', extract(epoch FROM v_end));
    v_hash := md5(jsonb_build_array(v_metadata, encode(p_image, 'base64'), encode(p_mobile_image, 'base64'))::TEXT);
    PERFORM pg_advisory_xact_lock(hashtextextended(p_input->>'requestId', 8401));
    SELECT * INTO v_existing FROM ${s}.motds WHERE request_id = p_input->>'requestId';
    IF FOUND THEN
        IF v_existing.created_by_provider IS DISTINCT FROM p_provider OR v_existing.created_by_subject IS DISTINCT FROM p_subject THEN
            RAISE EXCEPTION 'MOTD_CONFLICT: Request ID was used by a different actor';
        END IF;
        -- 0084/0085 receipts hashed the legacy JSON fields. Preserve retries.
        IF v_existing.request_hash IS DISTINCT FROM v_hash AND v_existing.request_hash IS DISTINCT FROM
            md5(jsonb_build_array(p_input, encode(p_image, 'base64'), encode(p_mobile_image, 'base64'))::TEXT) THEN
            RAISE EXCEPTION 'MOTD_CONFLICT: Request ID was used for different input';
        END IF;
        RETURN ${s}.cms_motd_json(v_existing);
    END IF;
    IF v_end IS NOT NULL AND v_end <= v_now THEN RAISE EXCEPTION 'MOTD_INVALID: End must be in the future'; END IF;
    v_start := COALESCE(v_start, v_now);
    INSERT INTO ${s}.motds(from_at, to_at, body_md, mobile_body_md, image, image_type, image_alt,
        mobile_image, mobile_image_type, mobile_image_alt, image_placement, created_by_provider, created_by_subject,
        created_at, request_id, request_hash)
    VALUES (v_start, v_end, p_input->>'bodyMd', p_input->>'mobileBodyMd', p_image,
        CASE WHEN p_image IS NOT NULL THEN p_input->>'imageType' END, CASE WHEN p_image IS NOT NULL THEN p_input->>'imageAlt' END,
        p_mobile_image, CASE WHEN p_mobile_image IS NOT NULL THEN p_input->>'mobileImageType' END,
        CASE WHEN p_mobile_image IS NOT NULL THEN p_input->>'mobileImageAlt' END,
        COALESCE(p_input->>'imagePlacement', 'above'), p_provider, p_subject, v_now, p_input->>'requestId', v_hash)
    RETURNING ${s}.cms_motd_json(motds) INTO v_result;
    RETURN v_result;
END;
$$;
`;
}
