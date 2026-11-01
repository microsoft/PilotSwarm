/**
 * Migration 0084 — compute targets.
 * See docs/proposals/compute-providers.md and migrations/0084_diff.md.
 *
 * A compute target is a registered place where a session's GHCP runtime can
 * run: one instance of a compute type (the worker's own process, a pod on
 * another node pool, a sandbox, a user's machine, an existing build pool).
 * The type is named by `kind`; the worker plug-in that understands it is a
 * compute provider. PilotSwarm stores the target and checks who may use it.
 * It never interprets `config`: that belongs to the provider of `kind`.
 *
 * Classes, as for model providers:
 *   shared    registered by an administrator; usable by every signed-in user
 *   personal  registered by a user for themselves; usable only by that user,
 *             invisible to everyone else, administrators included
 *
 * Additive: one table and its procedures. A session records its target in
 * its creation config (`computeTarget`); no session column changes.
 */
export function computeTargetsMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0084_compute_targets

CREATE TABLE IF NOT EXISTS ${s}.compute_targets (
    name           TEXT PRIMARY KEY,
    kind           TEXT NOT NULL,
    class          TEXT NOT NULL CHECK (class IN ('shared','personal')),
    owner_user_id  BIGINT REFERENCES ${s}.users(user_id) ON DELETE CASCADE,
    display_name   TEXT,
    config         JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    created_by     BIGINT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT compute_targets_owner_matches_class CHECK (
        (class = 'shared'   AND owner_user_id IS NULL) OR
        (class = 'personal' AND owner_user_id IS NOT NULL)),
    CONSTRAINT compute_targets_name_shape CHECK (
        name ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'),
    CONSTRAINT compute_targets_kind_shape CHECK (
        kind ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    CONSTRAINT compute_targets_config_object CHECK (
        jsonb_typeof(config) = 'object')
);

CREATE INDEX IF NOT EXISTS compute_targets_owner
    ON ${s}.compute_targets (owner_user_id) WHERE owner_user_id IS NOT NULL;

-- Every shared target, plus the viewer's own. A name outside it returns no
-- row, the same answer as a name that does not exist.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_target_in_namespace(
    p_name TEXT, p_viewer BIGINT
) RETURNS SETOF ${s}.compute_targets AS $$
    SELECT ct.* FROM ${s}.compute_targets ct
     WHERE ct.name = p_name
       AND (ct.class = 'shared'
            OR (p_viewer IS NOT NULL AND ct.owner_user_id = p_viewer));
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION ${s}.cms_compute_target_create(
    p_name TEXT, p_kind TEXT, p_class TEXT, p_display_name TEXT, p_config JSONB,
    p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS SETOF ${s}.compute_targets AS $$
DECLARE v_name TEXT := NULLIF(BTRIM(p_name), '');
BEGIN
    IF v_name IS NULL THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_INVALID: a compute target needs a name';
    END IF;
    IF NULLIF(BTRIM(p_kind), '') IS NULL THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_INVALID: a compute target needs a kind';
    END IF;
    IF p_class NOT IN ('shared','personal') THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_INVALID: class must be shared or personal';
    END IF;
    IF p_config IS NOT NULL AND jsonb_typeof(p_config) <> 'object' THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_INVALID: config must be a JSON object';
    END IF;
    IF p_class = 'shared' AND NOT COALESCE(p_is_admin, FALSE) THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_FORBIDDEN: only an administrator can add a shared compute target';
    END IF;
    IF p_class = 'personal' AND p_actor IS NULL THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_FORBIDDEN: sign in to add a compute target of your own';
    END IF;
    IF EXISTS (SELECT 1 FROM ${s}.compute_targets ct WHERE ct.name = v_name) THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_CONFLICT: the name "%" is already taken', v_name;
    END IF;
    -- A personal target always belongs to the person creating it.
    INSERT INTO ${s}.compute_targets
        (name, kind, class, owner_user_id, display_name, config, created_by)
    VALUES (v_name, BTRIM(p_kind), p_class,
            CASE WHEN p_class = 'personal' THEN p_actor END,
            NULLIF(BTRIM(p_display_name), ''),
            COALESCE(p_config, '{}'::jsonb), p_actor);
    RETURN QUERY SELECT ct.* FROM ${s}.compute_targets ct WHERE ct.name = v_name;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- May the actor manage this target? A personal target answers only to its
-- owner and reads as absent to anyone else; a shared one needs an admin.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_target_assert_manage(
    p_name TEXT, p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS ${s}.compute_targets AS $$
DECLARE v_row ${s}.compute_targets;
BEGIN
    SELECT * INTO v_row FROM ${s}.compute_targets ct WHERE ct.name = p_name;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_NOT_FOUND: there is no compute target named "%"', p_name;
    END IF;
    IF v_row.class = 'personal' THEN
        IF p_actor IS NULL OR v_row.owner_user_id IS DISTINCT FROM p_actor THEN
            RAISE EXCEPTION 'COMPUTE_TARGET_NOT_FOUND: there is no compute target named "%"', p_name;
        END IF;
        RETURN v_row;
    END IF;
    IF NOT COALESCE(p_is_admin, FALSE) THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_FORBIDDEN: "%" is a shared compute target; only an administrator can change it', p_name;
    END IF;
    RETURN v_row;
END;
$$ LANGUAGE plpgsql STABLE;

-- NULL arguments keep the current value.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_target_update(
    p_name TEXT, p_display_name TEXT, p_config JSONB, p_enabled BOOLEAN,
    p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS SETOF ${s}.compute_targets AS $$
BEGIN
    PERFORM ${s}.cms_compute_target_assert_manage(p_name, p_actor, p_is_admin);
    IF p_config IS NOT NULL AND jsonb_typeof(p_config) <> 'object' THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_INVALID: config must be a JSON object';
    END IF;
    UPDATE ${s}.compute_targets ct
       SET display_name = CASE WHEN p_display_name IS NULL THEN ct.display_name
                               ELSE NULLIF(BTRIM(p_display_name), '') END,
           config       = COALESCE(p_config, ct.config),
           enabled      = COALESCE(p_enabled, ct.enabled),
           updated_at   = now()
     WHERE ct.name = p_name;
    RETURN QUERY SELECT ct.* FROM ${s}.compute_targets ct WHERE ct.name = p_name;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- Returns how many open sessions name the target. They are not touched: at
-- their next turn the target no longer resolves and the turn waits.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_target_delete(
    p_name TEXT, p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS BIGINT AS $$
DECLARE v_waiting BIGINT;
BEGIN
    PERFORM ${s}.cms_compute_target_assert_manage(p_name, p_actor, p_is_admin);
    SELECT count(*) INTO v_waiting
      FROM ${s}.sessions ss
     WHERE ss.deleted_at IS NULL
       AND ss.state NOT IN ('completed', 'failed', 'error', 'cancelled')
       AND ss.creation_config->>'computeTarget' = p_name;
    DELETE FROM ${s}.compute_targets ct WHERE ct.name = p_name;
    RETURN v_waiting;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- The viewer's namespace: every shared target plus their own.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_target_list(
    p_viewer BIGINT, p_is_admin BOOLEAN
) RETURNS TABLE(
    name TEXT, kind TEXT, class TEXT, owner_user_id BIGINT,
    display_name TEXT, config JSONB, enabled BOOLEAN,
    created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, manageable BOOLEAN
) AS $$
    SELECT ct.name, ct.kind, ct.class, ct.owner_user_id,
           ct.display_name, ct.config, ct.enabled,
           ct.created_at, ct.updated_at,
           (ct.class = 'personal' OR COALESCE(p_is_admin, FALSE)) AS manageable
      FROM ${s}.compute_targets ct
     WHERE ct.class = 'shared'
        OR (p_viewer IS NOT NULL AND ct.owner_user_id = p_viewer)
     ORDER BY ct.class, ct.name;
$$ LANGUAGE sql STABLE;

-- Session creation: may this owner run a session on the target? System
-- sessions use shared targets only. Raises rather than returning false.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_target_assert_session(
    p_name TEXT, p_owner_provider TEXT, p_owner_subject TEXT, p_is_system BOOLEAN
) RETURNS BOOLEAN AS $$
DECLARE
    v_owner BIGINT;
    v_row ${s}.compute_targets;
BEGIN
    IF NOT COALESCE(p_is_system, FALSE) THEN
        SELECT u.user_id INTO v_owner FROM ${s}.users u
         WHERE u.provider = NULLIF(BTRIM(p_owner_provider), '')
           AND u.subject = NULLIF(BTRIM(p_owner_subject), '');
    END IF;
    SELECT ct.* INTO v_row
      FROM ${s}.compute_targets ct
     WHERE ct.name = p_name
       AND (ct.class = 'shared' OR (v_owner IS NOT NULL AND ct.owner_user_id = v_owner))
     FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_NOT_FOUND: there is no compute target named "%"', p_name;
    END IF;
    IF NOT v_row.enabled THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_DISABLED: the compute target "%" is disabled', p_name;
    END IF;
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- Worker side: the target a session names, as the worker needs it before a
-- turn. Trusted caller; no viewer. NULL when the target is gone.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_target_resolve(
    p_name TEXT
) RETURNS SETOF ${s}.compute_targets AS $$
    SELECT ct.* FROM ${s}.compute_targets ct WHERE ct.name = p_name;
$$ LANGUAGE sql STABLE;
`;
}
