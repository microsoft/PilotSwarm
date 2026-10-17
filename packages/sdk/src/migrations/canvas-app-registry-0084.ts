/**
 * Migration 0084 — the canvas app registry (issue 181).
 * See docs/proposals/canvas-app-registry.md and migrations/0084_diff.md.
 *
 * Additive: six new tables and new procedures. Nothing existing is altered.
 *
 * Vocabulary:
 * - an app is (scope, owner, name); `shared` names are deployment-unique,
 *   `user` names are unique per owner, and a user's own copy hides the shared
 *   one of the same name for that user only;
 * - a version is one byte sequence of one app, identified by sha256, with a
 *   SemVer string; `precedence_key` orders versions by SemVer precedence under
 *   the "C" collation, and build metadata does not take part in it;
 * - a version is `pending` from reserve until its bytes are uploaded and it is
 *   committed; pending rows are invisible to every read;
 * - "resource admin" is the unrestricted admin; a cluster-scoped admin is an
 *   ordinary user here. A row the caller may not see is always NOT_FOUND.
 *
 * Every error is raised as CANVAS_APP_<CODE>: <message>; the management client
 * maps <CODE> to the public error code.
 */
export function canvasAppRegistryMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
-- 0084_canvas_app_registry

-- ── Tables ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ${s}.canvas_apps (
    app_id              TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    scope               TEXT NOT NULL CHECK (scope IN ('shared', 'user')),
    owner_provider      TEXT,
    owner_subject       TEXT,
    description         TEXT NOT NULL DEFAULT '',
    tags                TEXT[] NOT NULL DEFAULT '{}',
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    active_version_id   TEXT,
    artifact_session_id TEXT NOT NULL UNIQUE,
    -- TRUE from an import that created the app until that import finishes,
    -- so an interrupted first import still activates its highest version.
    import_open         BOOLEAN NOT NULL DEFAULT FALSE,
    created_by          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (scope = 'shared' OR (owner_provider IS NOT NULL AND owner_subject IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS canvas_apps_shared_name_uniq
    ON ${s}.canvas_apps (name) WHERE scope = 'shared';
CREATE UNIQUE INDEX IF NOT EXISTS canvas_apps_user_name_uniq
    ON ${s}.canvas_apps (owner_provider, owner_subject, name) WHERE scope = 'user';

CREATE TABLE IF NOT EXISTS ${s}.canvas_app_versions (
    version_id         TEXT PRIMARY KEY,
    app_id             TEXT NOT NULL REFERENCES ${s}.canvas_apps(app_id) ON DELETE CASCADE,
    version            TEXT NOT NULL,
    precedence_key     TEXT COLLATE "C" NOT NULL,
    -- pending: reserved, bytes being uploaded; ready: committed; cleanup:
    -- claimed by the pruner (never committable again), deleted with its bytes.
    state              TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'cleanup')),
    sha256             TEXT NOT NULL,
    size_bytes         BIGINT NOT NULL,
    artifact_filename  TEXT NOT NULL,
    card               JSONB NOT NULL DEFAULT '{}'::jsonb,
    workspace_key      TEXT,
    source_session_id  TEXT,
    source_slot        INT,
    created_by         TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    committed_at       TIMESTAMPTZ,
    UNIQUE (app_id, version),
    UNIQUE (app_id, sha256)
);
CREATE INDEX IF NOT EXISTS canvas_app_versions_precedence_idx
    ON ${s}.canvas_app_versions (app_id, precedence_key, created_at);
CREATE INDEX IF NOT EXISTS canvas_app_versions_sha_idx ON ${s}.canvas_app_versions (sha256);
CREATE INDEX IF NOT EXISTS canvas_app_versions_workspace_idx
    ON ${s}.canvas_app_versions (workspace_key) WHERE workspace_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS canvas_app_versions_pending_idx
    ON ${s}.canvas_app_versions (created_at) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS ${s}.canvas_app_editors (
    app_id     TEXT        NOT NULL REFERENCES ${s}.canvas_apps(app_id) ON DELETE CASCADE,
    user_id    BIGINT      NOT NULL REFERENCES ${s}.users(user_id),
    granted_by BIGINT      REFERENCES ${s}.users(user_id),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (app_id, user_id)
);
CREATE INDEX IF NOT EXISTS canvas_app_editors_user_idx ON ${s}.canvas_app_editors (user_id);

-- An app's bytes are deleted after its rows; the tombstone lets the prune op
-- finish a delete that was interrupted between the two.
CREATE TABLE IF NOT EXISTS ${s}.canvas_app_tombstones (
    app_id              TEXT PRIMARY KEY,
    artifact_session_id TEXT NOT NULL,
    name                TEXT NOT NULL,
    deleted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    purged_at           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ${s}.canvas_app_loads (
    load_id       BIGSERIAL PRIMARY KEY,
    app_id        TEXT NOT NULL REFERENCES ${s}.canvas_apps(app_id) ON DELETE CASCADE,
    app_name      TEXT NOT NULL,
    version       TEXT NOT NULL,
    version_id    TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    user_provider TEXT,
    user_subject  TEXT,
    loaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS canvas_app_loads_app_idx
    ON ${s}.canvas_app_loads (app_id, loaded_at DESC, load_id DESC);
CREATE INDEX IF NOT EXISTS canvas_app_loads_age_idx ON ${s}.canvas_app_loads (loaded_at);

-- Positive workspace approval (R20 as amended): the session owner's
-- decision on one exact program in one slot of one session. A program is the
-- page bytes, its checked workspace declaration and the folders those names
-- resolve to. Every new program asks once, whoever wrote it; the identical
-- program redrawn in the same slot keeps its decision. Owner-bound: a new
-- session owner decides again.
CREATE TABLE IF NOT EXISTS ${s}.canvas_workspace_grants (
    session_id          TEXT NOT NULL,
    slot                INT  NOT NULL,
    page_sha256         TEXT NOT NULL,
    declaration_sha256  TEXT NOT NULL,
    bindings_sha256     TEXT NOT NULL,
    owner_provider      TEXT NOT NULL,
    owner_subject       TEXT NOT NULL,
    rev                 INT  NOT NULL,
    trust               TEXT NOT NULL,
    version_id          TEXT,
    decision            TEXT NOT NULL CHECK (decision IN ('granted', 'denied')),
    decided_by_provider TEXT NOT NULL,
    decided_by_subject  TEXT NOT NULL,
    decided_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, slot, page_sha256, declaration_sha256, bindings_sha256, owner_provider, owner_subject)
);


-- ── SemVer ───────────────────────────────────────────────────────

-- The SemVer 2.0 grammar, build metadata included. NULL when invalid.
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_semver_parts(p_version TEXT)
RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
    SELECT regexp_match(
        BTRIM(p_version),
        '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)'
        || '(?:-((?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*))?'
        || '(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$'
    );
$$;

-- A text whose "C" byte order equals SemVer precedence. Every number is its
-- 4-digit length then its digits (no truncation, any accepted size); a
-- release ('|') sorts after any of its prereleases ('!');
-- prerelease identifiers are joined by ' ' (below every identifier byte), a
-- numeric identifier is '0' + its 4-digit length + digits, an alphanumeric one
-- is '1' + itself. Build metadata is ignored.
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_precedence_key(p_version TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_parts TEXT[] := ${s}.cms_canvas_app_semver_parts(p_version);
    v_key   TEXT;
    v_id    TEXT;
    v_ids   TEXT[] := '{}';
BEGIN
    IF v_parts IS NULL THEN
        RETURN NULL;
    END IF;
    IF length(v_parts[1]) > 9999 OR length(v_parts[2]) > 9999 OR length(v_parts[3]) > 9999 THEN
        RETURN NULL;
    END IF;
    v_key := lpad(length(v_parts[1])::TEXT, 4, '0') || v_parts[1] || '.'
          || lpad(length(v_parts[2])::TEXT, 4, '0') || v_parts[2] || '.'
          || lpad(length(v_parts[3])::TEXT, 4, '0') || v_parts[3];
    IF v_parts[4] IS NULL THEN
        RETURN v_key || '|';
    END IF;
    FOREACH v_id IN ARRAY string_to_array(v_parts[4], '.') LOOP
        IF v_id ~ '^[0-9]+$' AND length(v_id) > 9999 THEN
            RETURN NULL;
        END IF;
        IF v_id ~ '^[0-9]+$' THEN
            v_ids := v_ids || ('0' || lpad(length(v_id)::TEXT, 4, '0') || v_id);
        ELSE
            v_ids := v_ids || ('1' || v_id);
        END IF;
    END LOOP;
    RETURN v_key || '!' || array_to_string(v_ids, ' ');
END;
$$;

-- semver.inc(v, 'patch'): a prerelease becomes its release, a release gets
-- patch + 1, build metadata is dropped.
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_semver_next_patch(p_version TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    v_parts TEXT[] := ${s}.cms_canvas_app_semver_parts(p_version);
BEGIN
    IF v_parts IS NULL THEN
        RETURN '1.0.0';
    END IF;
    IF v_parts[4] IS NOT NULL THEN
        RETURN v_parts[1] || '.' || v_parts[2] || '.' || v_parts[3];
    END IF;
    RETURN v_parts[1] || '.' || v_parts[2] || '.' || (v_parts[3]::NUMERIC + 1)::TEXT;
END;
$$;

-- ── Identity and visibility ──────────────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_is_owner(
    p_app ${s}.canvas_apps, p_provider TEXT, p_subject TEXT
) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT p_app.owner_provider IS NOT NULL
       AND p_app.owner_provider = NULLIF(BTRIM(p_provider), '')
       AND p_app.owner_subject  = NULLIF(BTRIM(p_subject), '');
$$;

CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_is_editor(
    p_app_id TEXT, p_provider TEXT, p_subject TEXT
) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
          FROM ${s}.canvas_app_editors e
          JOIN ${s}.users u ON u.user_id = e.user_id
         WHERE e.app_id = p_app_id
           AND u.provider = NULLIF(BTRIM(p_provider), '')
           AND u.subject  = NULLIF(BTRIM(p_subject), '')
    );
$$;

-- Which app a name means for this viewer. Only apps the viewer may see are
-- ever returned: shared, the viewer's own, or (resource admin) any.
-- Unpinned: the viewer's own copy shadows the shared one.
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_resolve_id(
    p_name TEXT, p_viewer_provider TEXT, p_viewer_subject TEXT, p_resource_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT
) RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_viewer_p TEXT := NULLIF(BTRIM(p_viewer_provider), '');
    v_viewer_s TEXT := NULLIF(BTRIM(p_viewer_subject), '');
    v_sel_p    TEXT := NULLIF(BTRIM(p_sel_owner_provider), '');
    v_sel_s    TEXT := NULLIF(BTRIM(p_sel_owner_subject), '');
    v_id       TEXT;
BEGIN
    IF p_sel_scope = 'shared' THEN
        SELECT a.app_id INTO v_id FROM ${s}.canvas_apps a WHERE a.name = p_name AND a.scope = 'shared';
        RETURN v_id;
    END IF;
    IF p_sel_scope = 'user' THEN
        IF v_sel_p IS NULL OR v_sel_s IS NULL THEN
            v_sel_p := v_viewer_p;
            v_sel_s := v_viewer_s;
        END IF;
        IF v_sel_p IS NULL OR v_sel_s IS NULL THEN
            RETURN NULL;
        END IF;
        IF NOT COALESCE(p_resource_admin, FALSE)
           AND (v_sel_p IS DISTINCT FROM v_viewer_p OR v_sel_s IS DISTINCT FROM v_viewer_s) THEN
            RETURN NULL;
        END IF;
        SELECT a.app_id INTO v_id FROM ${s}.canvas_apps a
         WHERE a.name = p_name AND a.scope = 'user'
           AND a.owner_provider = v_sel_p AND a.owner_subject = v_sel_s;
        RETURN v_id;
    END IF;
    IF v_viewer_p IS NOT NULL AND v_viewer_s IS NOT NULL THEN
        SELECT a.app_id INTO v_id FROM ${s}.canvas_apps a
         WHERE a.name = p_name AND a.scope = 'user'
           AND a.owner_provider = v_viewer_p AND a.owner_subject = v_viewer_s;
        IF v_id IS NOT NULL THEN
            RETURN v_id;
        END IF;
    END IF;
    SELECT a.app_id INTO v_id FROM ${s}.canvas_apps a WHERE a.name = p_name AND a.scope = 'shared';
    RETURN v_id;
END;
$$;

-- Resolve and authorize. p_level: 'read' | 'editor' | 'owner'.
-- Invisible ⇒ NOT_FOUND. Visible but not allowed ⇒ FORBIDDEN.
-- 'editor' and 'owner' lock the row.
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_authz(
    p_name TEXT, p_viewer_provider TEXT, p_viewer_subject TEXT, p_resource_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT, p_level TEXT
) RETURNS ${s}.canvas_apps LANGUAGE plpgsql AS $$
DECLARE
    v_id  TEXT;
    v_app ${s}.canvas_apps;
BEGIN
    v_id := ${s}.cms_canvas_app_resolve_id(p_name, p_viewer_provider, p_viewer_subject, p_resource_admin,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject);
    IF v_id IS NULL THEN
        RAISE EXCEPTION 'CANVAS_APP_NOT_FOUND: canvas app "%" does not exist', p_name;
    END IF;
    IF p_level = 'read' THEN
        SELECT * INTO v_app FROM ${s}.canvas_apps WHERE app_id = v_id;
    ELSE
        SELECT * INTO v_app FROM ${s}.canvas_apps WHERE app_id = v_id FOR UPDATE;
    END IF;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'CANVAS_APP_NOT_FOUND: canvas app "%" does not exist', p_name;
    END IF;
    IF p_level = 'read' OR COALESCE(p_resource_admin, FALSE)
       OR ${s}.cms_canvas_app_is_owner(v_app, p_viewer_provider, p_viewer_subject) THEN
        RETURN v_app;
    END IF;
    IF p_level = 'editor' AND v_app.scope = 'shared'
       AND ${s}.cms_canvas_app_is_editor(v_app.app_id, p_viewer_provider, p_viewer_subject) THEN
        RETURN v_app;
    END IF;
    IF p_level = 'editor' THEN
        RAISE EXCEPTION 'CANVAS_APP_FORBIDDEN: only the owner, a contributor or an admin can change "%"', p_name;
    END IF;
    RAISE EXCEPTION 'CANVAS_APP_FORBIDDEN: only the owner or an admin can do this to "%"', p_name;
END;
$$;

-- ── Publish: reserve, commit, abort ─────────────────────────────
--
-- Reserve creates the app when absent (owner = the caller; p_allow_ownerless
-- is the admin-only legacy-migration path), checks write rights, and either
-- returns the existing version for the same bytes or inserts a PENDING row
-- holding the chosen version number. The caller uploads the bytes, then
-- commits. p_mode 'publish' re-activates a same-bytes version; 'import' never
-- moves the active pointer of an app that already existed.
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_reserve(
    p_new_app_id TEXT, p_new_version_id TEXT, p_artifact_session_id TEXT,
    p_name TEXT, p_scope TEXT,
    p_viewer_provider TEXT, p_viewer_subject TEXT, p_resource_admin BOOLEAN, p_allow_ownerless BOOLEAN,
    p_sha256 TEXT, p_size_bytes BIGINT, p_version TEXT, p_card JSONB, p_workspace_key TEXT,
    p_description TEXT, p_tags TEXT[], p_source_session_id TEXT, p_source_slot INT,
    p_created_by TEXT, p_mode TEXT, p_require_new_or_same BOOLEAN DEFAULT FALSE
) RETURNS TABLE(
    status TEXT, app_id TEXT, version_id TEXT, version TEXT,
    artifact_session_id TEXT, artifact_filename TEXT, app_created BOOLEAN
) LANGUAGE plpgsql AS $$
DECLARE
    v_owner_p TEXT := NULLIF(BTRIM(p_viewer_provider), '');
    v_owner_s TEXT := NULLIF(BTRIM(p_viewer_subject), '');
    v_app     ${s}.canvas_apps;
    v_ver     ${s}.canvas_app_versions;
    v_created BOOLEAN := FALSE;
    v_version TEXT;
    v_key     TEXT;
    v_latest  TEXT;
    v_file    TEXT;
BEGIN
    IF p_scope NOT IN ('shared', 'user') THEN
        RAISE EXCEPTION 'CANVAS_APP_BAD_SCOPE: scope must be shared or user, got "%"', p_scope;
    END IF;
    IF p_mode NOT IN ('publish', 'import') THEN
        RAISE EXCEPTION 'CANVAS_APP_BAD_REQUEST: mode must be publish or import';
    END IF;
    IF v_owner_p IS NULL OR v_owner_s IS NULL THEN
        IF NOT (COALESCE(p_allow_ownerless, FALSE) AND COALESCE(p_resource_admin, FALSE) AND p_scope = 'shared') THEN
            RAISE EXCEPTION 'CANVAS_APP_NO_OWNER: a canvas app needs a signed-in user as its owner';
        END IF;
    END IF;
    IF p_version IS NOT NULL AND BTRIM(p_version) <> '' AND ${s}.cms_canvas_app_semver_parts(p_version) IS NULL THEN
        RAISE EXCEPTION 'CANVAS_APP_BAD_VERSION: "%" is not a SemVer 2.0 version', p_version;
    END IF;

    <<retry>>
    LOOP
        SELECT * INTO v_app FROM ${s}.canvas_apps a
         WHERE a.name = p_name AND a.scope = p_scope
           AND (p_scope = 'shared' OR (a.owner_provider = v_owner_p AND a.owner_subject = v_owner_s))
         FOR UPDATE;
        IF FOUND THEN
            EXIT retry;
        END IF;
        -- FOR UPDATE on an absent row locks nothing; a concurrent first
        -- publish can win the INSERT. Catch it and lock the winner's row.
        BEGIN
            INSERT INTO ${s}.canvas_apps
                (app_id, name, scope, owner_provider, owner_subject, description, tags,
                 artifact_session_id, import_open, created_by)
            VALUES (p_new_app_id, p_name, p_scope, v_owner_p, v_owner_s,
                    COALESCE(p_description, ''), COALESCE(p_tags, '{}'),
                    p_artifact_session_id, p_mode = 'import', p_created_by);
            v_created := TRUE;
        EXCEPTION WHEN unique_violation THEN
            CONTINUE retry;
        END;
    END LOOP;

    IF NOT v_created THEN
        -- The ownerless (legacy migration) path may extend only an ownerless
        -- app, never one a user created meanwhile.
        IF COALESCE(p_allow_ownerless, FALSE) AND v_owner_p IS NULL AND v_app.owner_provider IS NOT NULL THEN
            RAISE EXCEPTION 'CANVAS_APP_NAME_TAKEN: a shared canvas app named "%" already exists and belongs to someone else', p_name;
        END IF;
        IF NOT (COALESCE(p_resource_admin, FALSE)
                OR ${s}.cms_canvas_app_is_owner(v_app, v_owner_p, v_owner_s)
                OR (v_app.scope = 'shared' AND ${s}.cms_canvas_app_is_editor(v_app.app_id, v_owner_p, v_owner_s))) THEN
            RAISE EXCEPTION 'CANVAS_APP_NAME_TAKEN: a shared canvas app named "%" already exists and belongs to someone else', p_name;
        END IF;
    END IF;

    -- Same bytes: no new version.
    SELECT * INTO v_ver FROM ${s}.canvas_app_versions v
     WHERE v.app_id = v_app.app_id AND v.sha256 = p_sha256;
    IF FOUND THEN
        IF v_ver.state = 'cleanup' THEN
            RAISE EXCEPTION 'CANVAS_APP_BUSY: an abandoned upload of these bytes is being cleaned up; try again in a minute';
        END IF;
        IF v_ver.state = 'ready' AND p_mode = 'publish' THEN
            -- A publish (not an import) of known bytes re-activates them and
            -- takes the publisher's description and tags.
            UPDATE ${s}.canvas_apps a
               SET active_version_id = v_ver.version_id,
                   description = CASE WHEN p_description IS NOT NULL AND BTRIM(p_description) <> '' THEN p_description ELSE a.description END,
                   tags = COALESCE(p_tags, a.tags),
                   updated_at = now()
             WHERE a.app_id = v_app.app_id;
        END IF;
        RETURN QUERY SELECT CASE WHEN v_ver.state = 'ready' THEN 'noop' ELSE 'in-progress' END,
            v_app.app_id, v_ver.version_id, v_ver.version, v_app.artifact_session_id,
            v_ver.artifact_filename, v_created;
        RETURN;
    END IF;

    -- Legacy migration: an app that already existed may be extended only by
    -- the same bytes, decided here under the app lock, not by a precheck.
    IF COALESCE(p_require_new_or_same, FALSE) AND NOT v_created THEN
        RAISE EXCEPTION 'CANVAS_APP_NAME_TAKEN: a shared canvas app named "%" already exists with other content', p_name;
    END IF;

    IF p_version IS NULL OR BTRIM(p_version) = '' THEN
        SELECT v.version INTO v_latest FROM ${s}.canvas_app_versions v
         WHERE v.app_id = v_app.app_id ORDER BY v.precedence_key DESC, v.created_at DESC LIMIT 1;
        v_version := CASE WHEN v_latest IS NULL THEN '1.0.0' ELSE ${s}.cms_canvas_app_semver_next_patch(v_latest) END;
    ELSE
        v_version := BTRIM(p_version);
    END IF;
    v_key := ${s}.cms_canvas_app_precedence_key(v_version);
    IF v_key IS NULL THEN
        RAISE EXCEPTION 'CANVAS_APP_BAD_VERSION: "%" is not a SemVer 2.0 version this registry can order', v_version;
    END IF;

    -- Version identity is the full text: 1.2.0+a and 1.2.0+b are two versions
    -- of equal precedence.
    PERFORM 1 FROM ${s}.canvas_app_versions v WHERE v.app_id = v_app.app_id AND v.version = v_version;
    IF FOUND THEN
        RAISE EXCEPTION 'CANVAS_APP_VERSION_EXISTS: %@% already exists with different content; versions are immutable', p_name, v_version;
    END IF;

    -- An existing app takes the publisher's description and tags only with a
    -- NEW version, and never from an import: a repeated or partial import
    -- leaves the app's metadata as it is.
    IF NOT v_created AND p_mode = 'publish' THEN
        UPDATE ${s}.canvas_apps a
           SET description = CASE WHEN p_description IS NOT NULL AND BTRIM(p_description) <> '' THEN p_description ELSE a.description END,
               tags = COALESCE(p_tags, a.tags),
               updated_at = now()
         WHERE a.app_id = v_app.app_id;
    END IF;

    -- The stored object is named after THIS reservation (its version id), so
    -- a path is never reused: a stale publisher or pruner holding an old
    -- reservation can only ever delete its own bytes, never a later
    -- reservation's for the same version and page.
    v_file := p_name || '@' || v_version || '.' || left(p_sha256, 12) || '.' || p_new_version_id || '.html';
    INSERT INTO ${s}.canvas_app_versions
        (version_id, app_id, version, precedence_key, state, sha256, size_bytes, artifact_filename,
         card, workspace_key, source_session_id, source_slot, created_by)
    VALUES (p_new_version_id, v_app.app_id, v_version, v_key, 'pending', p_sha256, p_size_bytes, v_file,
            COALESCE(p_card, '{}'::jsonb), NULLIF(p_workspace_key, ''), p_source_session_id, p_source_slot, p_created_by);

    RETURN QUERY SELECT 'reserved'::TEXT, v_app.app_id, p_new_version_id, v_version,
        v_app.artifact_session_id, v_file, v_created;
END;
$$;

-- Mark the bytes present. p_may_activate: the new version becomes active when
-- it has the highest precedence (publish, or an import that created the app).
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_commit(p_version_id TEXT, p_may_activate BOOLEAN)
RETURNS TABLE(app_id TEXT, version_id TEXT, version TEXT, active BOOLEAN) LANGUAGE plpgsql AS $$
DECLARE
    v_ver ${s}.canvas_app_versions;
    v_app ${s}.canvas_apps;
    v_active_key TEXT;
    v_active BOOLEAN := FALSE;
    v_rows INT;
BEGIN
    -- Lock the app first, then read the version under that lock. Abort and
    -- the pruner's claim take the same app lock, so a concurrent commit,
    -- abort, claim or delete is seen in its final state.
    SELECT a.* INTO v_app FROM ${s}.canvas_apps a
     WHERE a.app_id = (SELECT cv.app_id FROM ${s}.canvas_app_versions cv WHERE cv.version_id = p_version_id)
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'CANVAS_APP_NOT_FOUND: version % was aborted or its app was deleted', p_version_id;
    END IF;
    SELECT * INTO v_ver FROM ${s}.canvas_app_versions WHERE canvas_app_versions.version_id = p_version_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'CANVAS_APP_NOT_FOUND: version % was aborted or its app was deleted', p_version_id;
    END IF;
    -- Commit is a one-time transition of a PENDING version. Committing a
    -- version that is already ready changes nothing (no state change, no
    -- move of the active pointer): idempotent, and never a way to re-pin.
    IF v_ver.state = 'cleanup' THEN
        -- The pruner claimed this version (its publish outlived the pending
        -- TTL); its bytes are being deleted, so it never becomes ready.
        RAISE EXCEPTION 'CANVAS_APP_ABORTED: version % was abandoned and is being cleaned up; publish again', p_version_id;
    END IF;
    IF v_ver.state <> 'pending' THEN
        RETURN QUERY SELECT v_app.app_id, p_version_id, v_ver.version, v_app.active_version_id IS NOT DISTINCT FROM p_version_id;
        RETURN;
    END IF;
    UPDATE ${s}.canvas_app_versions SET state = 'ready', committed_at = now()
     WHERE canvas_app_versions.version_id = p_version_id AND state = 'pending';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'CANVAS_APP_NOT_FOUND: version % was aborted or its app was deleted', p_version_id;
    END IF;
    IF COALESCE(p_may_activate, FALSE) OR v_app.import_open OR v_app.active_version_id IS NULL THEN
        -- Activate only a new HIGHEST version: compared with every other ready
        -- version, not only the active one, so a pinned lower version is not
        -- replaced by a publish that is still below the latest.
        SELECT max(v.precedence_key COLLATE "C") INTO v_active_key FROM ${s}.canvas_app_versions v
         WHERE v.app_id = v_app.app_id AND v.state = 'ready' AND v.version_id <> p_version_id;
        IF v_active_key IS NULL OR (v_ver.precedence_key COLLATE "C") > (v_active_key COLLATE "C") THEN
            UPDATE ${s}.canvas_apps SET active_version_id = p_version_id, updated_at = now()
             WHERE canvas_apps.app_id = v_app.app_id;
            v_active := TRUE;
        END IF;
    END IF;
    RETURN QUERY SELECT v_app.app_id, p_version_id, v_ver.version,
        v_active OR v_app.active_version_id = p_version_id;
END;
$$;

-- An import that created its app is finished: from now on import mode
-- preserves the active pointer like any established app.
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_finish_import(p_app_id TEXT)
RETURNS VOID LANGUAGE sql AS $$
    UPDATE ${s}.canvas_apps SET import_open = FALSE WHERE app_id = p_app_id AND import_open;
$$;

-- Version lookup by text: the exact string, else the one version with that
-- precedence when exactly one exists.
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_find_version(p_app_id TEXT, p_version TEXT)
RETURNS TEXT LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_id TEXT;
    v_n  INT;
BEGIN
    SELECT v.version_id INTO v_id FROM ${s}.canvas_app_versions v
     WHERE v.app_id = p_app_id AND v.state = 'ready' AND v.version = BTRIM(p_version);
    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;
    SELECT count(*), min(v.version_id) INTO v_n, v_id FROM ${s}.canvas_app_versions v
     WHERE v.app_id = p_app_id AND v.state = 'ready'
       AND v.precedence_key = ${s}.cms_canvas_app_precedence_key(p_version);
    RETURN CASE WHEN v_n = 1 THEN v_id ELSE NULL END;
END;
$$;

-- Remove a version that never became ready (a failed publish, or one the
-- pruner claimed and whose bytes are gone). Takes the app lock, like commit
-- and claim. TRUE when a row was removed.
DROP FUNCTION IF EXISTS ${s}.cms_canvas_app_abort(TEXT);
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_abort(p_version_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
DECLARE
    v_rows INT;
BEGIN
    PERFORM 1 FROM ${s}.canvas_apps a
     WHERE a.app_id = (SELECT cv.app_id FROM ${s}.canvas_app_versions cv WHERE cv.version_id = p_version_id)
       FOR UPDATE;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;
    DELETE FROM ${s}.canvas_app_versions
     WHERE version_id = p_version_id AND state IN ('pending', 'cleanup');
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows > 0;
END;
$$;

-- ── Reads ───────────────────────────────────────────────────────

-- Apps the viewer may see. Disabled apps are listed only for their owner,
-- their contributors and resource admins.
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_list(
    p_viewer_provider TEXT, p_viewer_subject TEXT, p_resource_admin BOOLEAN
) RETURNS TABLE(
    app_id TEXT, name TEXT, scope TEXT, owner_provider TEXT, owner_subject TEXT,
    owner_email TEXT, owner_display_name TEXT, description TEXT, tags TEXT[], enabled BOOLEAN,
    created_by TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ,
    active_version_id TEXT, version TEXT, sha256 TEXT, size_bytes BIGINT, card JSONB,
    version_created_at TIMESTAMPTZ, can_edit BOOLEAN, can_manage BOOLEAN, shadowed BOOLEAN
) LANGUAGE sql STABLE AS $$
    WITH viewer AS (
        SELECT NULLIF(BTRIM(p_viewer_provider), '') AS p, NULLIF(BTRIM(p_viewer_subject), '') AS s
    ), app_rows AS (
        SELECT a.*,
               (a.owner_provider IS NOT NULL AND a.owner_provider = viewer.p AND a.owner_subject = viewer.s) AS is_owner,
               (a.scope = 'shared' AND ${s}.cms_canvas_app_is_editor(a.app_id, viewer.p, viewer.s)) AS is_editor
          FROM ${s}.canvas_apps a, viewer
         WHERE a.scope = 'shared'
            OR COALESCE(p_resource_admin, FALSE)
            OR (a.owner_provider = viewer.p AND a.owner_subject = viewer.s)
    )
    SELECT r.app_id, r.name, r.scope, r.owner_provider, r.owner_subject, u.email, u.display_name,
           r.description, r.tags, r.enabled, r.created_by, r.created_at, r.updated_at,
           v.version_id, v.version, v.sha256, v.size_bytes, v.card, v.created_at,
           (r.is_owner OR r.is_editor OR COALESCE(p_resource_admin, FALSE)),
           (r.is_owner OR COALESCE(p_resource_admin, FALSE)),
           (r.scope = 'shared' AND EXISTS (
               SELECT 1 FROM ${s}.canvas_apps o, viewer
                WHERE o.name = r.name AND o.scope = 'user'
                  AND o.owner_provider = viewer.p AND o.owner_subject = viewer.s))
      FROM app_rows r
      LEFT JOIN ${s}.canvas_app_versions v ON v.version_id = r.active_version_id
      LEFT JOIN ${s}.users u ON u.provider = r.owner_provider AND u.subject = r.owner_subject
     WHERE r.enabled OR r.is_owner OR r.is_editor OR COALESCE(p_resource_admin, FALSE)
     ORDER BY r.name, r.scope, r.owner_provider, r.owner_subject;
$$;

-- Ranked search over name, description and tags. Shadowed shared copies are
-- dropped (the viewer's own copy answers for that name); disabled apps follow
-- the list rule. An empty query lists by name.
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_search(
    p_viewer_provider TEXT, p_viewer_subject TEXT, p_resource_admin BOOLEAN, p_query TEXT, p_limit INT
) RETURNS TABLE(
    app_id TEXT, name TEXT, scope TEXT, owner_provider TEXT, owner_subject TEXT,
    description TEXT, tags TEXT[], enabled BOOLEAN, version TEXT, card JSONB, score REAL
) LANGUAGE sql STABLE AS $$
    WITH q AS (
        SELECT BTRIM(COALESCE(p_query, '')) AS text,
               plainto_tsquery('simple', BTRIM(COALESCE(p_query, ''))) AS ts
    ), visible AS (
        SELECT l.* FROM ${s}.cms_canvas_app_list(p_viewer_provider, p_viewer_subject, p_resource_admin) l
         WHERE NOT l.shadowed AND l.active_version_id IS NOT NULL
    ), ranked AS (
        SELECT v.*,
               (CASE WHEN q.text = '' THEN 1
                     ELSE ts_rank(
                        setweight(to_tsvector('simple', replace(v.name, '-', ' ')), 'A')
                        || setweight(to_tsvector('simple', array_to_string(v.tags, ' ')), 'B')
                        || setweight(to_tsvector('simple', v.description), 'C'), q.ts)
                          + CASE WHEN v.name = lower(q.text) THEN 1 ELSE 0 END
                          + CASE WHEN v.name ILIKE '%' || q.text || '%' THEN 0.5 ELSE 0 END
                END)::REAL AS score
          FROM visible v, q
    )
    SELECT r.app_id, r.name, r.scope, r.owner_provider, r.owner_subject, r.description, r.tags,
           r.enabled, r.version, r.card, r.score
      FROM ranked r
     WHERE r.score > 0
     ORDER BY r.score DESC, r.name
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 8), 50));
$$;

-- One app, every ready version (newest precedence first) and its contributors.
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_get(
    p_name TEXT, p_viewer_provider TEXT, p_viewer_subject TEXT, p_resource_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT
) RETURNS TABLE(
    app_id TEXT, name TEXT, scope TEXT, owner_provider TEXT, owner_subject TEXT,
    owner_email TEXT, owner_display_name TEXT, description TEXT, tags TEXT[], enabled BOOLEAN,
    created_by TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, active_version_id TEXT,
    can_edit BOOLEAN, can_manage BOOLEAN,
    version_id TEXT, version TEXT, sha256 TEXT, size_bytes BIGINT, artifact_filename TEXT, card JSONB,
    source_session_id TEXT, source_slot INT, version_created_by TEXT, version_created_at TIMESTAMPTZ
) LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_app ${s}.canvas_apps;
    v_owner BOOLEAN;
    v_editor BOOLEAN;
BEGIN
    v_app := ${s}.cms_canvas_app_authz(p_name, p_viewer_provider, p_viewer_subject, p_resource_admin,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject, 'read');
    v_owner := ${s}.cms_canvas_app_is_owner(v_app, p_viewer_provider, p_viewer_subject);
    v_editor := v_app.scope = 'shared' AND ${s}.cms_canvas_app_is_editor(v_app.app_id, p_viewer_provider, p_viewer_subject);
    IF NOT v_app.enabled AND NOT (v_owner OR v_editor OR COALESCE(p_resource_admin, FALSE)) THEN
        RAISE EXCEPTION 'CANVAS_APP_DISABLED: canvas app "%" is disabled', p_name;
    END IF;
    RETURN QUERY
    SELECT v_app.app_id, v_app.name, v_app.scope, v_app.owner_provider, v_app.owner_subject,
           u.email, u.display_name, v_app.description, v_app.tags, v_app.enabled,
           v_app.created_by, v_app.created_at, v_app.updated_at, v_app.active_version_id,
           (v_owner OR v_editor OR COALESCE(p_resource_admin, FALSE)),
           (v_owner OR COALESCE(p_resource_admin, FALSE)),
           v.version_id, v.version, v.sha256, v.size_bytes, v.artifact_filename, v.card,
           v.source_session_id, v.source_slot, v.created_by, v.created_at
      FROM (SELECT 1) one
      LEFT JOIN ${s}.users u ON u.provider = v_app.owner_provider AND u.subject = v_app.owner_subject
      LEFT JOIN ${s}.canvas_app_versions v ON v.app_id = v_app.app_id AND v.state = 'ready'
     ORDER BY v.precedence_key DESC NULLS LAST, v.created_at DESC;
END;
$$;

-- One version to draw or download: p_version NULL means the active one.
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_get_version(
    p_name TEXT, p_viewer_provider TEXT, p_viewer_subject TEXT, p_resource_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT, p_version TEXT
) RETURNS TABLE(
    app_id TEXT, name TEXT, scope TEXT, owner_provider TEXT, owner_subject TEXT, enabled BOOLEAN,
    artifact_session_id TEXT, version_id TEXT, version TEXT, sha256 TEXT, size_bytes BIGINT,
    artifact_filename TEXT, card JSONB, workspace_key TEXT
) LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_app ${s}.canvas_apps;
    v_ver ${s}.canvas_app_versions;
BEGIN
    v_app := ${s}.cms_canvas_app_authz(p_name, p_viewer_provider, p_viewer_subject, p_resource_admin,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject, 'read');
    IF NOT v_app.enabled
       AND NOT (${s}.cms_canvas_app_is_owner(v_app, p_viewer_provider, p_viewer_subject)
                OR (v_app.scope = 'shared' AND ${s}.cms_canvas_app_is_editor(v_app.app_id, p_viewer_provider, p_viewer_subject))
                OR COALESCE(p_resource_admin, FALSE)) THEN
        RAISE EXCEPTION 'CANVAS_APP_DISABLED: canvas app "%" is disabled', p_name;
    END IF;
    IF p_version IS NULL OR BTRIM(p_version) = '' THEN
        SELECT * INTO v_ver FROM ${s}.canvas_app_versions v
         WHERE v.version_id = v_app.active_version_id AND v.state = 'ready';
    ELSE
        SELECT * INTO v_ver FROM ${s}.canvas_app_versions v
         WHERE v.version_id = ${s}.cms_canvas_app_find_version(v_app.app_id, p_version);
    END IF;
    IF NOT FOUND OR v_ver.version_id IS NULL THEN
        RAISE EXCEPTION 'CANVAS_APP_VERSION_NOT_FOUND: %@% is not a published version', p_name, COALESCE(p_version, 'active');
    END IF;
    RETURN QUERY SELECT v_app.app_id, v_app.name, v_app.scope, v_app.owner_provider, v_app.owner_subject,
        v_app.enabled, v_app.artifact_session_id, v_ver.version_id, v_ver.version, v_ver.sha256,
        v_ver.size_bytes, v_ver.artifact_filename, v_ver.card, v_ver.workspace_key;
END;
$$;

-- Ready versions with these bytes that the viewer may see (trust and load
-- attribution decide among them in the service).
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_match_by_sha(
    p_sha256 TEXT, p_viewer_provider TEXT, p_viewer_subject TEXT, p_resource_admin BOOLEAN
) RETURNS TABLE(
    app_id TEXT, name TEXT, scope TEXT, owner_provider TEXT, owner_subject TEXT, enabled BOOLEAN,
    app_created_at TIMESTAMPTZ, version_id TEXT, version TEXT
) LANGUAGE sql STABLE AS $$
    SELECT a.app_id, a.name, a.scope, a.owner_provider, a.owner_subject, a.enabled, a.created_at,
           v.version_id, v.version
      FROM ${s}.canvas_app_versions v
      JOIN ${s}.canvas_apps a ON a.app_id = v.app_id
     WHERE v.sha256 = p_sha256 AND v.state = 'ready'
       AND (a.scope = 'shared' OR COALESCE(p_resource_admin, FALSE)
            OR (a.owner_provider = NULLIF(BTRIM(p_viewer_provider), '')
                AND a.owner_subject = NULLIF(BTRIM(p_viewer_subject), '')))
     ORDER BY (a.scope = 'shared') DESC, a.created_at, a.app_id;
$$;

-- Do these bytes belong to a ready version of an app the viewer may NOT see?
-- Cross-session artifact reads refuse such bytes, whatever the file is called.
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_sha_hidden(
    p_sha256 TEXT, p_viewer_provider TEXT, p_viewer_subject TEXT, p_resource_admin BOOLEAN
) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT NOT COALESCE(p_resource_admin, FALSE) AND EXISTS (
        SELECT 1
          FROM ${s}.canvas_app_versions v
          JOIN ${s}.canvas_apps a ON a.app_id = v.app_id
         WHERE v.sha256 = p_sha256 AND v.state = 'ready' AND a.scope = 'user'
           AND (a.owner_provider IS DISTINCT FROM NULLIF(BTRIM(p_viewer_provider), '')
                OR a.owner_subject IS DISTINCT FROM NULLIF(BTRIM(p_viewer_subject), ''))
    );
$$;

-- Are these bytes (or their workspace block) another owner's app that this
-- viewer may not edit? Agents never receive such bytes: they draw the app with
-- fromApp instead. Returns the app name when it is visible to the viewer,
-- '(private)' when it is not, NULL when the bytes are the viewer's to read.
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_foreign_bytes(
    p_sha256 TEXT, p_workspace_key TEXT, p_viewer_provider TEXT, p_viewer_subject TEXT, p_resource_admin BOOLEAN
) RETURNS TEXT LANGUAGE sql STABLE AS $$
    WITH viewer AS (
        SELECT NULLIF(BTRIM(p_viewer_provider), '') AS p, NULLIF(BTRIM(p_viewer_subject), '') AS s
    ), hits AS (
        SELECT a.app_id, a.name, a.scope, a.created_at
          FROM ${s}.canvas_app_versions v
          JOIN ${s}.canvas_apps a ON a.app_id = v.app_id, viewer
         WHERE v.state = 'ready'
           AND (v.sha256 = p_sha256 OR (p_workspace_key IS NOT NULL AND v.workspace_key = p_workspace_key AND a.scope = 'shared'))
           -- NULL-safe: an ownerless viewer owns and edits nothing, so every
           -- matching app is foreign to it (a bare NOT over NULL would drop it).
           AND NOT COALESCE(a.owner_provider IS NOT NULL AND viewer.p IS NOT NULL
                            AND a.owner_provider = viewer.p AND a.owner_subject = viewer.s, FALSE)
           AND NOT COALESCE(a.scope = 'shared' AND viewer.p IS NOT NULL
                            AND ${s}.cms_canvas_app_is_editor(a.app_id, viewer.p, viewer.s), FALSE)
    )
    SELECT CASE WHEN COALESCE(p_resource_admin, FALSE) THEN NULL
                WHEN h.scope = 'shared' THEN h.name
                ELSE '(private)' END
      FROM hits h
     ORDER BY (h.scope = 'shared') DESC, h.created_at
     LIMIT 1;
$$;

-- Is this id an app byte space (live or deleted)? The prefix test in TS is
-- only a filter; this is the answer.
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_is_space(p_session_id TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM ${s}.canvas_apps a WHERE a.artifact_session_id = p_session_id)
        OR EXISTS (SELECT 1 FROM ${s}.canvas_app_tombstones t WHERE t.artifact_session_id = p_session_id);
$$;

-- Does a version owned by someone else, visible to the viewer, declare this
-- workspace block? (Trust only; never attribution.)
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_foreign_workspace_match(
    p_workspace_key TEXT, p_viewer_provider TEXT, p_viewer_subject TEXT
) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT EXISTS (
        SELECT 1
          FROM ${s}.canvas_app_versions v
          JOIN ${s}.canvas_apps a ON a.app_id = v.app_id
         WHERE v.workspace_key = p_workspace_key AND v.state = 'ready' AND a.scope = 'shared'
           AND (a.owner_provider IS NULL
                OR a.owner_provider IS DISTINCT FROM NULLIF(BTRIM(p_viewer_provider), '')
                OR a.owner_subject IS DISTINCT FROM NULLIF(BTRIM(p_viewer_subject), ''))
    );
$$;

-- ── Mutations ───────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_set_enabled(
    p_name TEXT, p_enabled BOOLEAN, p_viewer_provider TEXT, p_viewer_subject TEXT, p_resource_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_app ${s}.canvas_apps;
BEGIN
    v_app := ${s}.cms_canvas_app_authz(p_name, p_viewer_provider, p_viewer_subject, p_resource_admin,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject, 'editor');
    UPDATE ${s}.canvas_apps SET enabled = COALESCE(p_enabled, TRUE), updated_at = now() WHERE app_id = v_app.app_id;
END;
$$;

CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_set_metadata(
    p_name TEXT, p_description TEXT, p_tags TEXT[], p_viewer_provider TEXT, p_viewer_subject TEXT,
    p_resource_admin BOOLEAN, p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_app ${s}.canvas_apps;
BEGIN
    v_app := ${s}.cms_canvas_app_authz(p_name, p_viewer_provider, p_viewer_subject, p_resource_admin,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject, 'editor');
    UPDATE ${s}.canvas_apps
       SET description = COALESCE(p_description, description),
           tags = COALESCE(p_tags, tags),
           updated_at = now()
     WHERE app_id = v_app.app_id;
END;
$$;

CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_pin(
    p_name TEXT, p_version TEXT, p_viewer_provider TEXT, p_viewer_subject TEXT, p_resource_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
    v_app ${s}.canvas_apps;
    v_id  TEXT;
BEGIN
    v_app := ${s}.cms_canvas_app_authz(p_name, p_viewer_provider, p_viewer_subject, p_resource_admin,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject, 'editor');
    v_id := ${s}.cms_canvas_app_find_version(v_app.app_id, p_version);
    IF v_id IS NULL THEN
        RAISE EXCEPTION 'CANVAS_APP_VERSION_NOT_FOUND: %@% is not a published version', p_name, p_version;
    END IF;
    UPDATE ${s}.canvas_apps SET active_version_id = v_id, updated_at = now() WHERE app_id = v_app.app_id;
    RETURN v_id;
END;
$$;

-- Owner or admin. Making an app private needs an owner and a free private
-- name; making it shared needs a free shared name. Making it private revokes
-- every contributor in the same statement.
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_set_scope(
    p_name TEXT, p_scope TEXT, p_viewer_provider TEXT, p_viewer_subject TEXT, p_resource_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_app ${s}.canvas_apps;
BEGIN
    IF p_scope NOT IN ('shared', 'user') THEN
        RAISE EXCEPTION 'CANVAS_APP_BAD_SCOPE: scope must be shared or user, got "%"', p_scope;
    END IF;
    v_app := ${s}.cms_canvas_app_authz(p_name, p_viewer_provider, p_viewer_subject, p_resource_admin,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject, 'owner');
    IF v_app.scope = p_scope THEN
        RETURN;
    END IF;
    IF p_scope = 'shared' THEN
        PERFORM 1 FROM ${s}.canvas_apps a WHERE a.name = v_app.name AND a.scope = 'shared';
        IF FOUND THEN
            RAISE EXCEPTION 'CANVAS_APP_NAME_TAKEN: a shared canvas app named "%" already exists', v_app.name;
        END IF;
    ELSE
        IF v_app.owner_provider IS NULL OR v_app.owner_subject IS NULL THEN
            RAISE EXCEPTION 'CANVAS_APP_NO_OWNER: "%" has no owner to make it private for', v_app.name;
        END IF;
        PERFORM 1 FROM ${s}.canvas_apps a
         WHERE a.name = v_app.name AND a.scope = 'user'
           AND a.owner_provider = v_app.owner_provider AND a.owner_subject = v_app.owner_subject;
        IF FOUND THEN
            RAISE EXCEPTION 'CANVAS_APP_NAME_TAKEN: the owner already has a private canvas app named "%"', v_app.name;
        END IF;
        DELETE FROM ${s}.canvas_app_editors WHERE app_id = v_app.app_id;
    END IF;
    UPDATE ${s}.canvas_apps SET scope = p_scope, updated_at = now() WHERE app_id = v_app.app_id;
END;
$$;

-- Owner or admin. Deletes the rows (versions, contributors and loads
-- cascade) and leaves a tombstone so the service, or the prune op after an
-- interruption, deletes the bytes.
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_delete(
    p_name TEXT, p_viewer_provider TEXT, p_viewer_subject TEXT, p_resource_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT
) RETURNS TABLE(app_id TEXT, artifact_session_id TEXT, artifact_filename TEXT) LANGUAGE plpgsql AS $$
DECLARE
    v_app ${s}.canvas_apps;
BEGIN
    v_app := ${s}.cms_canvas_app_authz(p_name, p_viewer_provider, p_viewer_subject, p_resource_admin,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject, 'owner');
    INSERT INTO ${s}.canvas_app_tombstones (app_id, artifact_session_id, name)
    VALUES (v_app.app_id, v_app.artifact_session_id, v_app.name)
    ON CONFLICT ON CONSTRAINT canvas_app_tombstones_pkey DO NOTHING;
    RETURN QUERY
    SELECT v_app.app_id, v_app.artifact_session_id, v.artifact_filename
      FROM ${s}.canvas_app_versions v WHERE v.app_id = v_app.app_id;
    DELETE FROM ${s}.canvas_apps WHERE canvas_apps.app_id = v_app.app_id;
END;
$$;

-- ── Contributors (shared apps only) ─────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_grant_editor(
    p_name TEXT, p_grantee_provider TEXT, p_grantee_subject TEXT,
    p_viewer_provider TEXT, p_viewer_subject TEXT, p_resource_admin BOOLEAN
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_app ${s}.canvas_apps;
    v_user BIGINT;
    v_by BIGINT;
BEGIN
    v_app := ${s}.cms_canvas_app_authz(p_name, p_viewer_provider, p_viewer_subject, p_resource_admin,
        'shared', NULL, NULL, 'owner');
    SELECT u.user_id INTO v_user FROM ${s}.users u
     WHERE u.provider = NULLIF(BTRIM(p_grantee_provider), '') AND u.subject = NULLIF(BTRIM(p_grantee_subject), '');
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'CANVAS_APP_USER_NOT_FOUND: that user has never signed in';
    END IF;
    SELECT u.user_id INTO v_by FROM ${s}.users u
     WHERE u.provider = NULLIF(BTRIM(p_viewer_provider), '') AND u.subject = NULLIF(BTRIM(p_viewer_subject), '');
    INSERT INTO ${s}.canvas_app_editors (app_id, user_id, granted_by)
    VALUES (v_app.app_id, v_user, v_by)
    ON CONFLICT (app_id, user_id) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_revoke_editor(
    p_name TEXT, p_grantee_provider TEXT, p_grantee_subject TEXT,
    p_viewer_provider TEXT, p_viewer_subject TEXT, p_resource_admin BOOLEAN
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_app ${s}.canvas_apps;
BEGIN
    v_app := ${s}.cms_canvas_app_authz(p_name, p_viewer_provider, p_viewer_subject, p_resource_admin,
        'shared', NULL, NULL, 'owner');
    DELETE FROM ${s}.canvas_app_editors e
     USING ${s}.users u
     WHERE e.app_id = v_app.app_id AND u.user_id = e.user_id
       AND u.provider = NULLIF(BTRIM(p_grantee_provider), '') AND u.subject = NULLIF(BTRIM(p_grantee_subject), '');
END;
$$;

CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_list_editors(
    p_name TEXT, p_viewer_provider TEXT, p_viewer_subject TEXT, p_resource_admin BOOLEAN
) RETURNS TABLE(provider TEXT, subject TEXT, email TEXT, display_name TEXT, granted_at TIMESTAMPTZ)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_app ${s}.canvas_apps;
BEGIN
    v_app := ${s}.cms_canvas_app_authz(p_name, p_viewer_provider, p_viewer_subject, p_resource_admin,
        'shared', NULL, NULL, 'read');
    RETURN QUERY
    SELECT u.provider, u.subject, u.email, u.display_name, e.granted_at
      FROM ${s}.canvas_app_editors e
      JOIN ${s}.users u ON u.user_id = e.user_id
     WHERE e.app_id = v_app.app_id
     ORDER BY e.granted_at, u.user_id;
END;
$$;

-- ── Loads ───────────────────────────────────────────────────────

-- One row per load. Also deletes at most 200 rows older than 400 days, from
-- any app, so a busy deployment keeps up without the sweeper.
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_record_load(
    p_app_id TEXT, p_version_id TEXT, p_session_id TEXT, p_user_provider TEXT, p_user_subject TEXT
) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
    v_id BIGINT;
BEGIN
    INSERT INTO ${s}.canvas_app_loads (app_id, app_name, version, version_id, session_id, user_provider, user_subject)
    SELECT a.app_id, a.name, v.version, v.version_id, p_session_id,
           NULLIF(BTRIM(p_user_provider), ''), NULLIF(BTRIM(p_user_subject), '')
      FROM ${s}.canvas_apps a
      JOIN ${s}.canvas_app_versions v ON v.app_id = a.app_id AND v.version_id = p_version_id
     WHERE a.app_id = p_app_id
    RETURNING load_id INTO v_id;
    DELETE FROM ${s}.canvas_app_loads
     WHERE load_id IN (SELECT l.load_id FROM ${s}.canvas_app_loads l
                        WHERE l.loaded_at < now() - INTERVAL '400 days'
                        ORDER BY l.loaded_at LIMIT 200);
    RETURN v_id;
END;
$$;

-- Loads of one app, newest first, owner or resource admin only.
-- Cursor: (loaded_at, load_id) of the last row of the previous page.
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_list_loads(
    p_name TEXT, p_viewer_provider TEXT, p_viewer_subject TEXT, p_resource_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT,
    p_since TIMESTAMPTZ, p_until TIMESTAMPTZ, p_limit INT, p_cursor_at TIMESTAMPTZ, p_cursor_id BIGINT
) RETURNS TABLE(
    load_id BIGINT, app_name TEXT, version TEXT, session_id TEXT, user_provider TEXT, user_subject TEXT,
    user_email TEXT, user_display_name TEXT, loaded_at TIMESTAMPTZ, total_30d BIGINT, cursor_at TEXT
) LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_app ${s}.canvas_apps;
    v_total BIGINT;
BEGIN
    v_app := ${s}.cms_canvas_app_authz(p_name, p_viewer_provider, p_viewer_subject, p_resource_admin,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject, 'read');
    IF NOT (COALESCE(p_resource_admin, FALSE) OR ${s}.cms_canvas_app_is_owner(v_app, p_viewer_provider, p_viewer_subject)) THEN
        RAISE EXCEPTION 'CANVAS_APP_FORBIDDEN: only the owner or an admin can read the loads of "%"', p_name;
    END IF;
    SELECT count(*) INTO v_total FROM ${s}.canvas_app_loads l
     WHERE l.app_id = v_app.app_id AND l.loaded_at >= now() - INTERVAL '30 days';
    RETURN QUERY
    SELECT l.load_id, l.app_name, l.version, l.session_id, l.user_provider, l.user_subject,
           u.email, u.display_name, l.loaded_at, v_total,
           -- Full microsecond precision: a JS Date would truncate to ms and
           -- the next page would skip rows sharing that millisecond.
           to_char(l.loaded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
      FROM ${s}.canvas_app_loads l
      LEFT JOIN ${s}.users u ON u.provider = l.user_provider AND u.subject = l.user_subject
     WHERE l.app_id = v_app.app_id
       AND l.loaded_at >= now() - INTERVAL '400 days'
       AND (p_since IS NULL OR l.loaded_at >= p_since)
       AND (p_until IS NULL OR l.loaded_at < p_until)
       AND (p_cursor_at IS NULL OR (l.loaded_at, l.load_id) < (p_cursor_at, p_cursor_id))
     ORDER BY l.loaded_at DESC, l.load_id DESC
     LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 500));
END;
$$;

CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_prune_loads(p_older_than TIMESTAMPTZ, p_batch INT)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
    v_count INT;
BEGIN
    DELETE FROM ${s}.canvas_app_loads
     WHERE load_id IN (SELECT l.load_id FROM ${s}.canvas_app_loads l
                        WHERE l.loaded_at < LEAST(p_older_than, now() - INTERVAL '400 days')
                        ORDER BY l.loaded_at LIMIT GREATEST(1, COALESCE(p_batch, 1000)));
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- ── Maintenance ─────────────────────────────────────────────────

-- Abandoned publishes. Each stale PENDING version is CLAIMED under its app
-- lock (pending -> cleanup), so it can never be committed afterwards; rows
-- already in cleanup (an earlier byte deletion failed) are returned again.
-- The pruner deletes the bytes, then aborts the row; a failed byte deletion
-- leaves the claimed row as the record to retry.
DROP FUNCTION IF EXISTS ${s}.cms_canvas_app_prune_pending(TIMESTAMPTZ);
CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_prune_pending(p_older_than TIMESTAMPTZ)
RETURNS TABLE(version_id TEXT, artifact_session_id TEXT, artifact_filename TEXT) LANGUAGE plpgsql AS $$
DECLARE
    v_ids TEXT[];
BEGIN
    -- The apps with stale pending versions, locked in app-id order: every
    -- pruner takes app locks in the same global order, and every other
    -- operation locks exactly one app, so no lock cycle can form.
    SELECT array_agg(DISTINCT v.app_id COLLATE "C" ORDER BY v.app_id COLLATE "C") INTO v_ids
      FROM (SELECT cv.app_id FROM ${s}.canvas_app_versions cv
             WHERE cv.state = 'pending' AND cv.created_at < p_older_than
             ORDER BY cv.created_at
             LIMIT 1000) v;
    IF v_ids IS NOT NULL THEN
        PERFORM 1 FROM ${s}.canvas_apps a WHERE a.app_id = ANY(v_ids) ORDER BY a.app_id COLLATE "C" FOR UPDATE;
        -- Re-checked under the locks: a version committed meanwhile is ready
        -- and is never claimed.
        UPDATE ${s}.canvas_app_versions cv SET state = 'cleanup'
         WHERE cv.app_id = ANY(v_ids) AND cv.state = 'pending' AND cv.created_at < p_older_than;
    END IF;
    RETURN QUERY
        SELECT v.version_id, a.artifact_session_id, v.artifact_filename
          FROM ${s}.canvas_app_versions v JOIN ${s}.canvas_apps a ON a.app_id = v.app_id
         WHERE v.state = 'cleanup'
         ORDER BY v.created_at
         LIMIT 1000;
END;
$$;

CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_list_tombstones(p_limit INT)
RETURNS TABLE(app_id TEXT, artifact_session_id TEXT, name TEXT, deleted_at TIMESTAMPTZ)
LANGUAGE sql STABLE AS $$
    SELECT t.app_id, t.artifact_session_id, t.name, t.deleted_at
      FROM ${s}.canvas_app_tombstones t
     WHERE t.purged_at IS NULL
     ORDER BY t.deleted_at
     LIMIT GREATEST(1, COALESCE(p_limit, 100));
$$;

CREATE OR REPLACE FUNCTION ${s}.cms_canvas_app_mark_purged(p_app_id TEXT)
RETURNS VOID LANGUAGE sql AS $$
    UPDATE ${s}.canvas_app_tombstones SET purged_at = now() WHERE app_id = p_app_id AND purged_at IS NULL;
$$;

-- ── Workspace approval ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION ${s}.cms_canvas_workspace_set_grant(
    p_session_id TEXT, p_slot INT, p_page_sha256 TEXT, p_declaration_sha256 TEXT, p_bindings_sha256 TEXT,
    p_owner_provider TEXT, p_owner_subject TEXT, p_rev INT, p_trust TEXT, p_version_id TEXT, p_decision TEXT,
    p_by_provider TEXT, p_by_subject TEXT
) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
    IF p_decision NOT IN ('granted', 'denied') THEN
        RAISE EXCEPTION 'CANVAS_APP_BAD_REQUEST: decision must be granted or denied';
    END IF;
    IF coalesce(p_page_sha256, '') !~ '^[0-9a-f]{64}$'
       OR coalesce(p_declaration_sha256, '') !~ '^[0-9a-f]{64}$'
       OR coalesce(p_bindings_sha256, '') !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'CANVAS_APP_BAD_REQUEST: an approval names the page, declaration and bindings by sha256';
    END IF;
    INSERT INTO ${s}.canvas_workspace_grants
        (session_id, slot, page_sha256, declaration_sha256, bindings_sha256, owner_provider, owner_subject,
         rev, trust, version_id, decision, decided_by_provider, decided_by_subject)
    VALUES (p_session_id, p_slot, p_page_sha256, p_declaration_sha256, p_bindings_sha256, p_owner_provider, p_owner_subject,
            p_rev, p_trust, p_version_id, p_decision, p_by_provider, p_by_subject)
    ON CONFLICT (session_id, slot, page_sha256, declaration_sha256, bindings_sha256, owner_provider, owner_subject)
    DO UPDATE SET decision = EXCLUDED.decision, rev = EXCLUDED.rev, trust = EXCLUDED.trust,
                  version_id = EXCLUDED.version_id,
                  decided_by_provider = EXCLUDED.decided_by_provider,
                  decided_by_subject = EXCLUDED.decided_by_subject, decided_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION ${s}.cms_canvas_workspace_get_grant(
    p_session_id TEXT, p_slot INT, p_page_sha256 TEXT, p_declaration_sha256 TEXT, p_bindings_sha256 TEXT,
    p_owner_provider TEXT, p_owner_subject TEXT
) RETURNS TEXT LANGUAGE sql STABLE AS $$
    SELECT g.decision FROM ${s}.canvas_workspace_grants g
     WHERE g.session_id = p_session_id AND g.slot = p_slot AND g.page_sha256 = p_page_sha256
       AND g.declaration_sha256 = p_declaration_sha256 AND g.bindings_sha256 = p_bindings_sha256
       AND g.owner_provider = p_owner_provider AND g.owner_subject = p_owner_subject;
$$;

`;
}
