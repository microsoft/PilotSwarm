/** Pick fleet-current before applying a viewer's dismissal. */
export function motdSupersessionMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_motd_current(p_provider TEXT, p_subject TEXT, p_admin BOOLEAN)
RETURNS JSONB LANGUAGE plpgsql STABLE AS $$
DECLARE v_user BIGINT; v_current ${s}.motds;
BEGIN
    v_user := ${s}.cms_motd_actor(p_provider, p_subject, p_admin, false);
    SELECT * INTO v_current FROM ${s}.motds
        WHERE from_at <= now() AND (to_at IS NULL OR now() < to_at)
        ORDER BY GREATEST(from_at, created_at) DESC, motd_id DESC LIMIT 1;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF EXISTS (SELECT 1 FROM ${s}.motd_dismissals
        WHERE user_id = v_user AND motd_id = v_current.motd_id) THEN RETURN NULL; END IF;
    RETURN ${s}.cms_motd_json(v_current) - 'createdBy';
END;
$$;
`;
}
