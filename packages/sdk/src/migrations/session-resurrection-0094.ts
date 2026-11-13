/** Claim before reading a resurrection, then refuse moves that leave live descendants behind. */
export function sessionResurrectionMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
SET LOCAL lock_timeout = '5s';
${([6, 8, 9, 10] as const).map(arity => createSessionOverload(s, arity)).join("\n")}
${createWorkflowSession(s)}
`;
}

function lockParent(s: string): string {
    return `
    IF p_parent_session_id IS NOT NULL THEN
        SELECT COALESCE(parent.root_session_id, parent.session_id), parent.group_id, parent.deleted_at
          INTO v_root, v_parent_group, v_parent_deleted
          FROM ${s}.sessions parent
         WHERE parent.session_id = p_parent_session_id
         FOR SHARE;
        IF v_parent_deleted IS NOT NULL THEN
            RAISE EXCEPTION 'PARENT_DELETED: cannot create a session under a deleted parent';
        END IF;
    END IF;
    -- Absent parents remain allowed for system-agent bootstrap.
    v_root := COALESCE(v_root, p_session_id);
`;
}

function createSessionOverload(s: string, arity: 6 | 8 | 9 | 10): string {
    const reasoning = arity >= 8;
    const group = arity === 8 || arity === 9;
    const mobile = arity >= 9;
    const visibility = arity === 10;
    const parameters = [
        "p_session_id TEXT", "p_model TEXT",
        ...(reasoning ? ["p_reasoning_effort TEXT"] : []),
        "p_parent_session_id TEXT", "p_is_system BOOLEAN", "p_agent_id TEXT", "p_splash TEXT",
        ...(reasoning ? ["p_group_id TEXT"] : []),
        ...(mobile ? ["p_splash_mobile TEXT"] : []),
        ...(visibility ? ["p_visibility TEXT"] : []),
    ];
    const fields = [
        ["session_id", "p_session_id"], ["model", "p_model"],
        ...(reasoning ? [["reasoning_effort", "v_reasoning_effort"]] : []),
        ["parent_session_id", "p_parent_session_id"], ["is_system", "p_is_system"],
        ["agent_id", "p_agent_id"], ["splash", "p_splash"],
        ...(mobile ? [["splash_mobile", "p_splash_mobile"]] : []),
        ...(group ? [["group_id", "v_group_id"]] : []),
        ...(visibility ? [["root_session_id", "v_root"], ["visibility", "v_visibility"]] : []),
    ];
    const metrics = arity === 8 ? "session_metrics" : "session_metric_summaries";
    return `
-- ${arity}-argument body; the existing seven-argument shim delegates to eight.
CREATE OR REPLACE FUNCTION ${s}.cms_create_session(
    ${parameters.join(",\n    ")}
) RETURNS VOID AS $$
DECLARE
    v_root TEXT;
    v_parent_group TEXT;
    v_parent_deleted TIMESTAMPTZ;
    v_claimed TEXT;
    v_old_parent TEXT;
    v_deleted TIMESTAMPTZ;
    ${reasoning ? "v_reasoning_effort TEXT := NULLIF(BTRIM(p_reasoning_effort), '');" : ""}
    ${group ? "v_group_id TEXT := NULLIF(BTRIM(p_group_id), '');" : ""}
    ${visibility ? `v_visibility TEXT := CASE
        WHEN p_visibility IN ('private', 'shared_read', 'shared_write') THEN p_visibility
        ELSE 'private' END;` : ""}
BEGIN
${lockParent(s)}
    ${group ? "v_group_id := COALESCE(v_group_id, v_parent_group);" : ""}
    -- INSERT closes the absent-id race that SELECT FOR UPDATE alone cannot lock.
    INSERT INTO ${s}.sessions (${fields.map(([column]) => column).join(", ")})
    VALUES (${fields.map(([, value]) => value).join(", ")})
    ON CONFLICT (session_id) DO NOTHING
    RETURNING session_id INTO v_claimed;

    IF v_claimed IS NULL THEN
        SELECT x.parent_session_id, x.deleted_at INTO v_old_parent, v_deleted
          FROM ${s}.sessions x WHERE x.session_id = p_session_id FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'SESSION_DISAPPEARED: session was purged during creation';
        END IF;
        IF v_deleted IS NOT NULL THEN
            IF v_old_parent IS DISTINCT FROM p_parent_session_id AND EXISTS (
                WITH RECURSIVE descendants(session_id) AS (
                    SELECT x.session_id FROM ${s}.sessions x WHERE x.parent_session_id = p_session_id
                    UNION
                    SELECT x.session_id FROM ${s}.sessions x
                    JOIN descendants d ON x.parent_session_id = d.session_id
                )
                SELECT 1 FROM descendants d JOIN ${s}.sessions x USING (session_id)
                WHERE x.deleted_at IS NULL
            ) THEN
                RAISE EXCEPTION 'SESSION_RESURRECTION_HAS_LIVE_DESCENDANTS: cannot change parent while descendants are live';
            END IF;
            -- The row is locked and the guard passed. Reset before clearing the tombstone.
            PERFORM ${s}.cms_turn_lifetime_reset(p_session_id);
            UPDATE ${s}.sessions
               SET ${fields.filter(([column]) => column !== "session_id").map(([column, value]) => `${column} = ${value}`).join(",\n                   ")},
                   ${visibility ? "" : `root_session_id = CASE WHEN v_old_parent IS DISTINCT FROM p_parent_session_id
                       THEN v_root ELSE root_session_id END,`}
                   deleted_at = NULL,
                   updated_at = now(),
                   state = 'pending',
                   orchestration_id = NULL,
                   last_error = NULL,
                   last_active_at = NULL,
                   current_iteration = 0,
                   wait_reason = NULL,
                   title_locked = FALSE
             WHERE session_id = p_session_id;
        END IF;
    END IF;

    INSERT INTO ${s}.${metrics}
        (session_id, agent_id, model, ${reasoning ? "reasoning_effort, " : ""}parent_session_id)
    VALUES
        (p_session_id, p_agent_id, p_model, ${reasoning ? "v_reasoning_effort, " : ""}p_parent_session_id)
    ON CONFLICT (session_id) DO ${reasoning ? `UPDATE
    SET agent_id = COALESCE(${s}.${metrics}.agent_id, EXCLUDED.agent_id),
        model = COALESCE(${s}.${metrics}.model, EXCLUDED.model),
        reasoning_effort = COALESCE(${s}.${metrics}.reasoning_effort, EXCLUDED.reasoning_effort),
        parent_session_id = COALESCE(${s}.${metrics}.parent_session_id, EXCLUDED.parent_session_id),
        updated_at = now()` : "NOTHING"};
END;
$$ LANGUAGE plpgsql;
`;
}

function createWorkflowSession(s: string): string {
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_create_workflow_session(
    p_session_id TEXT,
    p_parent_session_id TEXT,
    p_creation_config JSONB
) RETURNS BOOLEAN AS $$
DECLARE
    v_root TEXT;
    v_parent_group TEXT;
    v_parent_deleted TIMESTAMPTZ;
    v_claimed TEXT;
BEGIN
${lockParent(s)}
    INSERT INTO ${s}.sessions
        (session_id, parent_session_id, is_system, group_id, root_session_id, visibility, session_kind, creation_config)
    VALUES
        (p_session_id, p_parent_session_id, FALSE, v_parent_group, v_root, 'private', 'workflow', p_creation_config)
    ON CONFLICT (session_id) DO NOTHING
    RETURNING session_id INTO v_claimed;
    IF v_claimed IS NULL THEN
        RETURN FALSE;
    END IF;

    INSERT INTO ${s}.session_metric_summaries (session_id, parent_session_id)
    VALUES (p_session_id, p_parent_session_id)
    ON CONFLICT (session_id) DO UPDATE
    SET parent_session_id = COALESCE(${s}.session_metric_summaries.parent_session_id, EXCLUDED.parent_session_id),
        updated_at = now();
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;
`;
}
