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
 * Classes, as for model providers:
 *   shared    registered by an administrator; usable by every signed-in user
 *   personal  registered by a user for themselves; usable only by that user,
 *             invisible to everyone else, administrators included
 *
 * A target also has an id that is never reused. A session records the
 * target's name and id in its creation config (`computeTarget`,
 * `computeTargetId`); the worker binds by id, so a deleted target leaves its
 * sessions blocked, and a new target with the same name never takes them.
 * The worker re-checks before every turn that the session's owner may still
 * use the target.
 *
 * A target also advertises what it offers (`advertised`): the models its
 * host can serve with its own model access, its operating system and other
 * facts. Workers refresh it as they reach the host. It shapes the options
 * users see and is never used to decide who may do what. Only personal
 * targets may advertise models.
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
/**
 * The most a stored advertisement may take. A migration's SQL must keep
 * meaning for ever, so the number is written here rather than imported;
 * `MAX_COMPUTE_ADVERTISEMENT_BYTES` in compute.ts is the worker's own cap
 * and a unit test keeps the two the same.
 */
export const COMPUTE_ADVERTISEMENT_MAX_BYTES = 16384;

export function computeTargetsMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0084_compute_targets

CREATE TABLE IF NOT EXISTS ${s}.compute_targets (
    name           TEXT PRIMARY KEY,
    target_id      UUID NOT NULL UNIQUE
                   DEFAULT md5(random()::text || clock_timestamp()::text)::uuid,
    kind           TEXT NOT NULL,
    class          TEXT NOT NULL CHECK (class IN ('shared','personal')),
    owner_user_id  BIGINT REFERENCES ${s}.users(user_id) ON DELETE CASCADE,
    display_name   TEXT,
    config         JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    advertised     JSONB,
    advertised_at  TIMESTAMPTZ,
    created_by     BIGINT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT compute_targets_owner_matches_class CHECK (
        (class = 'shared'   AND owner_user_id IS NULL) OR
        (class = 'personal' AND owner_user_id IS NOT NULL)),
    -- '<owner>/<label>': the owner's sign-in address, or 'shared' for a
    -- target an administrator registers for everyone, then the label the
    -- registrant chose. The worker builds the owner part from whoever is
    -- signed in; it is never taken from a request.
    CONSTRAINT compute_targets_name_shape CHECK (
        name ~ '^[a-zA-Z0-9][a-zA-Z0-9._%+@-]{0,126}/[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$'),
    -- A target an administrator registers for everyone is the only one in
    -- the shared space, and the only one outside it that belongs to nobody.
    CONSTRAINT compute_targets_name_space CHECK (
        (class = 'shared') = (split_part(name, '/', 1) = 'shared')),
    CONSTRAINT compute_targets_kind_shape CHECK (
        kind ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    CONSTRAINT compute_targets_config_object CHECK (
        jsonb_typeof(config) = 'object'),
    CONSTRAINT compute_targets_advertised_object CHECK (
        advertised IS NULL OR jsonb_typeof(advertised) = 'object')
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
DECLARE
    v_name TEXT := NULLIF(BTRIM(p_name), '');
    v_owner_name TEXT;
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
    -- A target of someone's own is named after them. Checked here as well
    -- as in the worker, so no caller can name a target after anyone else.
    IF p_class = 'personal' THEN
        SELECT lower(BTRIM(u.email)) INTO v_owner_name FROM ${s}.users u WHERE u.user_id = p_actor;
        IF COALESCE(v_owner_name, '') = '' THEN
            RAISE EXCEPTION 'COMPUTE_TARGET_INVALID: a compute target of your own is named after your sign-in address, and this account has none on record';
        END IF;
        IF split_part(v_name, '/', 1) <> v_owner_name THEN
            RAISE EXCEPTION 'COMPUTE_TARGET_FORBIDDEN: a compute target of your own is named "%/<label>"', v_owner_name;
        END IF;
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

-- The viewer's namespace: every shared target plus their own. Provider
-- config is shown only to those who may manage the target.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_target_list(
    p_viewer BIGINT, p_is_admin BOOLEAN
) RETURNS TABLE(
    name TEXT, kind TEXT, class TEXT, owner_user_id BIGINT,
    display_name TEXT, config JSONB, enabled BOOLEAN,
    created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, manageable BOOLEAN,
    target_id UUID, advertised JSONB, advertised_at TIMESTAMPTZ
) AS $$
    SELECT ct.name, ct.kind, ct.class, ct.owner_user_id,
           ct.display_name,
           CASE WHEN ct.class = 'personal' OR COALESCE(p_is_admin, FALSE)
                THEN ct.config ELSE '{}'::jsonb END,
           ct.enabled,
           ct.created_at, ct.updated_at,
           (ct.class = 'personal' OR COALESCE(p_is_admin, FALSE)) AS manageable,
           ct.target_id, ct.advertised, ct.advertised_at
      FROM ${s}.compute_targets ct
     WHERE ct.class = 'shared'
        OR (p_viewer IS NOT NULL AND ct.owner_user_id = p_viewer)
     ORDER BY ct.class, ct.name;
$$ LANGUAGE sql STABLE;

-- Session creation: may this owner run a session on the target? System
-- sessions use shared targets only. Raises rather than returning false;
-- returns the target's id for the session to record.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_target_assert_session(
    p_name TEXT, p_owner_provider TEXT, p_owner_subject TEXT, p_is_system BOOLEAN
) RETURNS UUID AS $$
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
    RETURN v_row.target_id;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- Worker side, before every turn: the target with this id, if the session's
-- owner may still use it (shared, or the owner's own; system sessions:
-- shared only). No row when it is gone or no longer theirs. Disabled rows
-- are returned so the worker can say so.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_target_resolve_for_session(
    p_target_id UUID, p_owner_provider TEXT, p_owner_subject TEXT, p_is_system BOOLEAN
) RETURNS SETOF ${s}.compute_targets AS $$
DECLARE v_owner BIGINT;
BEGIN
    IF NOT COALESCE(p_is_system, FALSE) THEN
        SELECT u.user_id INTO v_owner FROM ${s}.users u
         WHERE u.provider = NULLIF(BTRIM(p_owner_provider), '')
           AND u.subject = NULLIF(BTRIM(p_owner_subject), '');
    END IF;
    RETURN QUERY
        SELECT ct.* FROM ${s}.compute_targets ct
         WHERE ct.target_id = p_target_id
           AND (ct.class = 'shared' OR (v_owner IS NOT NULL AND ct.owner_user_id = v_owner));
END;
$$ LANGUAGE plpgsql STABLE;

-- Worker side, with no session behind it: the target with this id,
-- whoever owns it. Used where the worker is acting for PilotSwarm itself
-- rather than for a user — telling a provider a session tree it no longer
-- knows about is finished with a host. Trusted caller; nothing that
-- answers a user goes through it.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_target_by_id(p_target_id UUID)
RETURNS SETOF ${s}.compute_targets AS $$
    SELECT ct.* FROM ${s}.compute_targets ct WHERE ct.target_id = p_target_id;
$$ LANGUAGE sql STABLE;

-- Worker side: store what a target advertises. The worker has already kept
-- only the well-formed parts, but the advertisement comes from a host, so
-- the two rules that matter are repeated here, where nothing can skip them:
--   * it is a JSON object and no larger than the cap;
--   * only a personal target may offer models of its own, so a shared
--     target's models are dropped rather than refused (the rest of its
--     advertisement is still worth showing).
-- No row when the target is gone.
CREATE OR REPLACE FUNCTION ${s}.cms_compute_target_record_advertisement(
    p_target_id UUID, p_advertised JSONB
) RETURNS SETOF ${s}.compute_targets AS $$
BEGIN
    IF p_advertised IS NULL OR jsonb_typeof(p_advertised) <> 'object' THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_INVALID: an advertisement must be a JSON object';
    END IF;
    IF octet_length(p_advertised::text) > ${COMPUTE_ADVERTISEMENT_MAX_BYTES} THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_INVALID: an advertisement is larger than % bytes', ${COMPUTE_ADVERTISEMENT_MAX_BYTES};
    END IF;
    IF p_advertised ? 'models' AND jsonb_typeof(p_advertised->'models') <> 'array' THEN
        RAISE EXCEPTION 'COMPUTE_TARGET_INVALID: the models of an advertisement must be an array';
    END IF;
    RETURN QUERY
        UPDATE ${s}.compute_targets ct
           SET advertised = CASE WHEN ct.class = 'shared' THEN p_advertised - 'models'
                                 ELSE p_advertised END,
               advertised_at = now()
         WHERE ct.target_id = p_target_id
        RETURNING ct.*;
END;
$$ LANGUAGE plpgsql VOLATILE;

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
