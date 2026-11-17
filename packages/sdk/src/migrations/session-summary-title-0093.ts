/** Summary-only writes must serialize with explicit title locks. */
export function sessionSummaryTitleMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_update_session_title_if_unlocked(
    p_session_id TEXT,
    p_title TEXT
) RETURNS BOOLEAN AS $$
DECLARE
    v_changed INTEGER;
BEGIN
    IF p_title IS NULL OR BTRIM(p_title) = '' THEN
        RAISE EXCEPTION 'summary title must not be empty';
    END IF;

    UPDATE ${s}.sessions
       SET title = p_title,
           updated_at = now()
     WHERE session_id = p_session_id
       AND deleted_at IS NULL
       AND NOT is_system
       AND NOT title_locked
       AND title IS DISTINCT FROM p_title;

    GET DIAGNOSTICS v_changed = ROW_COUNT;
    RETURN v_changed > 0;
END;
$$ LANGUAGE plpgsql VOLATILE;
`;
}
