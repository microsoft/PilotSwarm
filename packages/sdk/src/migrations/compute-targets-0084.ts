/**
 * Migration 0084 — compute targets and the host bindings PilotSwarm holds.
 * See docs/proposals/compute-providers.md and migrations/0084_diff.md.
 *
 * A compute target is a registered place where a session's agent runtime
 * can run: one instance of a compute type (the worker's own process, a
 * separate host, a sandbox, a user's machine, an existing build pool).
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
 * `compute_bindings` is what PilotSwarm is using right now: one row per
 * (session tree, target, host). A worker renews its lease while it holds
 * a binding, so renewals that stop mean nobody is using the host; and a
 * sweep finds bindings whose session tree has ended, including trees that
 * ended while no worker had them loaded, so the provider is told once.
 * Neither table ever holds a handshake secret.
 *
 * Additive: two tables and their procedures; no session column changes.
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

-- Worker side, with no session behind it: the target with this id. Used
-- where the worker is acting for PilotSwarm itself rather than for a user
-- — telling a provider a session tree it no longer knows about is
-- finished with a host.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_target_by_id(p_target_id UUID)
RETURNS SETOF ${s}.compute_targets AS $$
    SELECT ct.* FROM ${s}.compute_targets ct WHERE ct.target_id = p_target_id;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------
-- Host bindings: what PilotSwarm is using, and what it has finished with
--
-- One row per (session tree, target, host). A worker writes it when it
-- binds and renews the lease while it holds the binding, so a provider can
-- read "renewals stopped" as "nobody is using this host". released_at
-- says a worker let go of it; done_at says the session tree is finished
-- with it for good, which is the notice a provider gets exactly once.
--
-- Release never means destroy, and neither does done: what happens to a
-- host nobody needs is the provider's decision alone. No handshake secret
-- is ever written here; host_ref is the provider's own handle and
-- PilotSwarm does not read inside it.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ${s}.compute_bindings (
    binding_id      UUID PRIMARY KEY
                    DEFAULT md5(random()::text || clock_timestamp()::text)::uuid,
    root_session_id TEXT NOT NULL,
    target_id       UUID NOT NULL,
    kind            TEXT NOT NULL,
    -- The provider's own name for the host and which incarnation of it,
    -- so a replaced host is a different binding.
    host_key        TEXT NOT NULL,
    host_ref        JSONB NOT NULL,
    worker_node_id  TEXT NOT NULL,
    leased_until    TIMESTAMPTZ,
    released_at     TIMESTAMPTZ,
    done_at         TIMESTAMPTZ,
    done_attempt_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT compute_bindings_host_ref_object CHECK (
        jsonb_typeof(host_ref) = 'object'),
    CONSTRAINT compute_bindings_one_per_host UNIQUE (root_session_id, target_id, host_key)
);

CREATE INDEX IF NOT EXISTS compute_bindings_unfinished
    ON ${s}.compute_bindings (root_session_id) WHERE done_at IS NULL;

-- Worker side, at bind: write the binding and take a lease on it.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_binding_record(
    p_root_session_id TEXT, p_target_id UUID, p_kind TEXT, p_host_key TEXT,
    p_host_ref JSONB, p_worker_node_id TEXT, p_lease_ms BIGINT
) RETURNS SETOF ${s}.compute_bindings AS $$
BEGIN
    IF p_host_ref IS NULL OR jsonb_typeof(p_host_ref) <> 'object' THEN
        RAISE EXCEPTION 'COMPUTE_BINDING_INVALID: a binding needs the provider''s handle for the host';
    END IF;
    RETURN QUERY
    INSERT INTO ${s}.compute_bindings
        (root_session_id, target_id, kind, host_key, host_ref, worker_node_id, leased_until)
    VALUES (p_root_session_id, p_target_id, p_kind, p_host_key, p_host_ref, p_worker_node_id,
            now() + make_interval(secs => GREATEST(COALESCE(p_lease_ms, 0), 0) / 1000.0))
    ON CONFLICT (root_session_id, target_id, host_key) DO UPDATE
        SET host_ref = EXCLUDED.host_ref,
            worker_node_id = EXCLUDED.worker_node_id,
            leased_until = EXCLUDED.leased_until,
            released_at = NULL,
            updated_at = now()
    RETURNING ${s}.compute_bindings.*;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- Worker side, on the lease timer. A binding already finished with is not
-- revived: a renewal after the done notice does nothing.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_binding_renew(
    p_binding_id UUID, p_worker_node_id TEXT, p_lease_ms BIGINT
) RETURNS BOOLEAN AS $$
DECLARE v_hit BOOLEAN;
BEGIN
    UPDATE ${s}.compute_bindings cb
       SET leased_until = now() + make_interval(secs => GREATEST(COALESCE(p_lease_ms, 0), 0) / 1000.0),
           worker_node_id = COALESCE(NULLIF(BTRIM(p_worker_node_id), ''), cb.worker_node_id),
           released_at = NULL,
           updated_at = now()
     WHERE cb.binding_id = p_binding_id AND cb.done_at IS NULL
    RETURNING TRUE INTO v_hit;
    RETURN COALESCE(v_hit, FALSE);
END;
$$ LANGUAGE plpgsql VOLATILE;

-- Worker side, at release: this worker is no longer using the host. The
-- row stays, because the session tree may still come back to it; only the
-- done notice closes a binding.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_binding_release(p_binding_id UUID)
RETURNS BOOLEAN AS $$
DECLARE v_hit BOOLEAN;
BEGIN
    UPDATE ${s}.compute_bindings cb
       SET released_at = now(), leased_until = NULL, updated_at = now()
     WHERE cb.binding_id = p_binding_id AND cb.done_at IS NULL
    RETURNING TRUE INTO v_hit;
    RETURN COALESCE(v_hit, FALSE);
END;
$$ LANGUAGE plpgsql VOLATILE;

-- The sweep. Bindings whose session tree has ended — a terminal state, a
-- deleted row, or no row at all — and that nobody has finished telling the
-- provider about. Claimed with FOR UPDATE SKIP LOCKED and stamped with the
-- attempt, so two workers never take the same row and a worker that dies
-- mid-notice leaves it to be retried after p_retry_after_ms.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_binding_claim_done(
    p_worker_node_id TEXT, p_limit INTEGER, p_retry_after_ms BIGINT
) RETURNS TABLE(
    binding_id UUID, root_session_id TEXT, target_id UUID, kind TEXT,
    host_ref JSONB, reason TEXT
) AS $$
    WITH ready AS (
        SELECT cb.binding_id,
               CASE WHEN ss.session_id IS NULL OR ss.deleted_at IS NOT NULL
                    THEN 'deleted' ELSE 'ended' END AS reason
          FROM ${s}.compute_bindings cb
          LEFT JOIN ${s}.sessions ss ON ss.session_id = cb.root_session_id
         WHERE cb.done_at IS NULL
           AND (cb.done_attempt_at IS NULL
                OR cb.done_attempt_at < now() - make_interval(secs => GREATEST(COALESCE(p_retry_after_ms, 0), 0) / 1000.0))
           AND (ss.session_id IS NULL
                OR ss.deleted_at IS NOT NULL
                OR ss.state IN ('completed', 'failed', 'error', 'cancelled'))
         ORDER BY cb.updated_at
         LIMIT GREATEST(COALESCE(p_limit, 1), 1)
           FOR UPDATE OF cb SKIP LOCKED
    )
    UPDATE ${s}.compute_bindings cb
       SET done_attempt_at = now(),
           worker_node_id = COALESCE(NULLIF(BTRIM(p_worker_node_id), ''), cb.worker_node_id),
           updated_at = now()
      FROM ready
     WHERE cb.binding_id = ready.binding_id
    RETURNING cb.binding_id, cb.root_session_id, cb.target_id, cb.kind, cb.host_ref, ready.reason;
$$ LANGUAGE sql VOLATILE;

-- The bindings of one session tree, newest last.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_binding_list(p_root_session_id TEXT)
RETURNS SETOF ${s}.compute_bindings AS $$
    SELECT cb.* FROM ${s}.compute_bindings cb
     WHERE cb.root_session_id = p_root_session_id
     ORDER BY cb.created_at;
$$ LANGUAGE sql STABLE;

-- The provider has been told. Idempotent: the first notice sets the time
-- and every later one leaves it alone, so a binding is reported once.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_binding_mark_done(p_binding_id UUID)
RETURNS BOOLEAN AS $$
DECLARE v_hit BOOLEAN;
BEGIN
    UPDATE ${s}.compute_bindings cb
       SET done_at = now(), leased_until = NULL, updated_at = now()
     WHERE cb.binding_id = p_binding_id AND cb.done_at IS NULL
    RETURNING TRUE INTO v_hit;
    RETURN COALESCE(v_hit, FALSE);
END;
$$ LANGUAGE plpgsql VOLATILE;
`;
}
