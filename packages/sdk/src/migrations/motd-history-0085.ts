/** Owner-approved read-only history for every authenticated viewer. */
export function motdHistoryMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_motd_list(p_provider TEXT, p_subject TEXT, p_admin BOOLEAN, p_limit INT, p_before BIGINT)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE v_live BIGINT;
BEGIN
    PERFORM ${s}.cms_motd_actor(p_provider, p_subject, p_admin, false);
    SELECT motd_id INTO v_live FROM ${s}.motds WHERE from_at <= now() AND now() < to_at
        ORDER BY from_at DESC, created_at DESC, motd_id DESC LIMIT 1;
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
CREATE OR REPLACE FUNCTION ${s}.cms_motd_image(p_provider TEXT, p_subject TEXT, p_admin BOOLEAN, p_id BIGINT, p_mobile BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE m ${s}.motds;
BEGIN
    PERFORM ${s}.cms_motd_actor(p_provider, p_subject, p_admin, false);
    SELECT * INTO m FROM ${s}.motds WHERE motd_id = p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'MOTD_NOT_FOUND: Message not found'; END IF;
    IF NOT COALESCE(p_admin, false) AND m.from_at > now() THEN
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
