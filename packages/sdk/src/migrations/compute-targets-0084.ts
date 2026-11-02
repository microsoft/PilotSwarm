/**
 * Migration 0084 — compute targets and the host bindings PilotSwarm holds.
 * See docs/proposals/compute-providers.md and migrations/0084_diff.md.
 *
 * A compute target is a registered place where a session's agent runtime
 * can run: one instance of a compute type (the worker's own process, a
 * separate host, a sandbox, an existing pool of hosts).
 * The type is named by `kind`; the worker plug-in that understands it is a
 * compute provider. PilotSwarm stores the target and checks who may use it.
 * It never interprets `config`: that belongs to the provider of `kind`.
 *
 * A target is registered by an administrator and usable by every signed-in
 * user. It is named `shared/<label>`; keeping the owner part in the name
 * means a later change can add targets with another owner without renaming
 * anything.
 *
 * A target also has an id that is never reused. A session records the
 * target's name and id in its creation config (`computeTarget`,
 * `computeTargetId`); the worker binds by id, so a deleted target leaves its
 * sessions blocked, and a new target with the same name never takes them.
 * The worker re-checks before every turn that the target is still there and
 * still enabled.
 *
 * The table never holds a handshake secret.
 *
 * PilotSwarm records no host bindings of its own: a host is held while a
 * session uses it, and a host component ends itself after a set time with
 * no connection, so nothing has to be written down to know a host is
 * free.
 *
 * Additive: one table and its procedures; no session column changes.
 */
export function computeTargetsMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0084_compute_targets

CREATE TABLE IF NOT EXISTS ${s}.compute_targets (
    name           TEXT PRIMARY KEY,
    target_id      UUID NOT NULL UNIQUE
                   DEFAULT md5(random()::text || clock_timestamp()::text)::uuid,
    kind           TEXT NOT NULL,
    class          TEXT NOT NULL DEFAULT 'shared' CHECK (class IN ('shared')),
    display_name   TEXT,
    config         JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    created_by     BIGINT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- '<owner>/<label>'. Today the owner part is always 'shared': a target
    -- an administrator registers for everyone. The worker builds that part
    -- itself; it is never taken from a request. Keeping it in the name now
    -- means a later change can add targets with another owner without
    -- renaming anything.
    CONSTRAINT compute_targets_name_shape CHECK (
        name ~ '^[a-zA-Z0-9][a-zA-Z0-9._%+@-]{0,126}/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'),
    CONSTRAINT compute_targets_name_space CHECK (
        split_part(name, '/', 1) = 'shared'),
    CONSTRAINT compute_targets_kind_shape CHECK (
        kind ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    CONSTRAINT compute_targets_config_object CHECK (
        jsonb_typeof(config) = 'object')
);

-- Only an administrator registers or changes a compute target.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_target_create(
    p_name TEXT, p_kind TEXT, p_display_name TEXT, p_config JSONB,
    p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS SETOF ${s}.compute_targets AS $$
DECLARE
    v_name TEXT := NULLIF(BTRIM(p_name), '');
BEGIN
    IF v_name IS NULL THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_INVALID: a compute target needs a name';
    END IF;
    IF NULLIF(BTRIM(p_kind), '') IS NULL THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_INVALID: a compute target needs a kind';
    END IF;
    IF p_config IS NOT NULL AND jsonb_typeof(p_config) <> 'object' THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_INVALID: config must be a JSON object';
    END IF;
    IF NOT COALESCE(p_is_admin, FALSE) THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_FORBIDDEN: only an administrator can add a compute target';
    END IF;
    IF EXISTS (SELECT 1 FROM ${s}.compute_targets ct WHERE ct.name = v_name) THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_CONFLICT: the name "%" is already taken', v_name;
    END IF;
    INSERT INTO ${s}.compute_targets
        (name, kind, class, display_name, config, created_by)
    VALUES (v_name, BTRIM(p_kind), 'shared',
            NULLIF(BTRIM(p_display_name), ''),
            COALESCE(p_config, '{}'::jsonb), p_actor);
    RETURN QUERY SELECT ct.* FROM ${s}.compute_targets ct WHERE ct.name = v_name;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- May the actor manage this target? Only an administrator can.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_target_assert_manage(
    p_name TEXT, p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS ${s}.compute_targets AS $$
DECLARE v_row ${s}.compute_targets;
BEGIN
    SELECT * INTO v_row FROM ${s}.compute_targets ct WHERE ct.name = p_name;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_NOT_FOUND: there is no compute target named "%"', p_name;
    END IF;
    IF NOT COALESCE(p_is_admin, FALSE) THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_FORBIDDEN: only an administrator can change the compute target "%"', p_name;
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

-- Returns how many open sessions use the target. They are not touched: at
-- their next turn the target no longer resolves and the turn fails. A new
-- target with the same name gets a new id and never serves them.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_target_delete(
    p_name TEXT, p_actor BIGINT, p_is_admin BOOLEAN
) RETURNS BIGINT AS $$
DECLARE
    v_waiting BIGINT;
    v_row ${s}.compute_targets;
BEGIN
    v_row := ${s}.cms_compute_target_assert_manage(p_name, p_actor, p_is_admin);
    SELECT count(*) INTO v_waiting
      FROM ${s}.sessions ss
     WHERE ss.deleted_at IS NULL
       AND ss.state NOT IN ('completed', 'failed', 'error', 'cancelled')
       AND ss.creation_config->>'computeTargetId' = v_row.target_id::text;
    DELETE FROM ${s}.compute_targets ct WHERE ct.name = p_name;
    RETURN v_waiting;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- Every target, for every signed-in viewer. Provider config is shown only
-- to those who may manage the target.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_target_list(
    p_viewer BIGINT, p_is_admin BOOLEAN
) RETURNS TABLE(
    name TEXT, kind TEXT, class TEXT,
    display_name TEXT, config JSONB, enabled BOOLEAN,
    created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, manageable BOOLEAN,
    target_id UUID
) AS $$
    SELECT ct.name, ct.kind, ct.class,
           ct.display_name,
           CASE WHEN COALESCE(p_is_admin, FALSE) THEN ct.config ELSE '{}'::jsonb END,
           ct.enabled,
           ct.created_at, ct.updated_at,
           COALESCE(p_is_admin, FALSE) AS manageable,
           ct.target_id
      FROM ${s}.compute_targets ct
     ORDER BY ct.name;
$$ LANGUAGE sql STABLE;

-- Session creation: does the target exist, and is it enabled? Raises
-- rather than returning false; returns the target's id for the session to
-- record, because the worker binds by id.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_target_assert_session(p_name TEXT)
RETURNS UUID AS $$
DECLARE v_row ${s}.compute_targets;
BEGIN
    SELECT ct.* INTO v_row FROM ${s}.compute_targets ct
     WHERE ct.name = p_name FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_NOT_FOUND: there is no compute target named "%"', p_name;
    END IF;
    IF NOT v_row.enabled THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_DISABLED: the compute target "%" is disabled', p_name;
    END IF;
    RETURN v_row.target_id;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- Worker side, before every turn: the target with this id. No row when it
-- is gone, so a deleted target leaves its sessions blocked and a new
-- target with the same name never takes them. Disabled rows are returned
-- so the worker can say so.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_target_resolve_for_session(p_target_id UUID)
RETURNS SETOF ${s}.compute_targets AS $$
    SELECT ct.* FROM ${s}.compute_targets ct WHERE ct.target_id = p_target_id;
$$ LANGUAGE sql STABLE;

`;
}
