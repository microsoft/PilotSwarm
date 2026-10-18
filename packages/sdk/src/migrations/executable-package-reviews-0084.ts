/** Additive review catalog. No executable activation until runtime fencing exists. */
export function executablePackageReviewsMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
ALTER TABLE ${s}.agent_packages ADD COLUMN IF NOT EXISTS activation_revision BIGINT NOT NULL DEFAULT 1;
-- Existing sessions stay NULL: never silently bind historical sessions to today's active version.
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS package_binding_policy_version INTEGER;
ALTER TABLE ${s}.sessions ALTER COLUMN package_binding_policy_version SET DEFAULT 1;
DO $bootstrap$ BEGIN
IF to_regprocedure('${s.replace(/'/g, "''")}.cms_package_runtime_barrier()') IS NULL THEN
    EXECUTE $stub$ CREATE FUNCTION ${s}.cms_package_runtime_barrier() RETURNS VOID AS $body$
        BEGIN RETURN; END; $body$ LANGUAGE plpgsql $stub$;
END IF;
IF to_regprocedure('${s.replace(/'/g, "''")}.cms_package_executable_eligible(text,text,text)') IS NULL THEN
    EXECUTE $stub$ CREATE FUNCTION ${s}.cms_package_executable_eligible(TEXT,TEXT,TEXT) RETURNS BOOLEAN AS $body$
        SELECT FALSE; $body$ LANGUAGE sql $stub$;
END IF;
END; $bootstrap$;
CREATE TABLE IF NOT EXISTS ${s}.agent_package_reviews (
    version_id TEXT PRIMARY KEY,
    package_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    decision TEXT NOT NULL DEFAULT 'pending'
        CHECK (decision IN ('pending', 'approved', 'rejected', 'revoked', 'not_required')),
    revision BIGINT NOT NULL DEFAULT 1,
    inspection JSONB,
    prior_active_version_id TEXT
);
ALTER TABLE ${s}.agent_package_reviews ADD COLUMN IF NOT EXISTS approval_scope TEXT NOT NULL
    DEFAULT 'artifact-content' CHECK (approval_scope = 'artifact-content');
CREATE TABLE IF NOT EXISTS ${s}.agent_package_review_audit (
    audit_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    package_id TEXT NOT NULL, version_id TEXT NOT NULL, sha256 TEXT NOT NULL,
    actor_provider TEXT NOT NULL, actor_subject TEXT NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    reason TEXT NOT NULL, before_decision TEXT NOT NULL, after_decision TEXT NOT NULL,
    revision BIGINT NOT NULL
);
CREATE OR REPLACE FUNCTION ${s}.cms_package_review_audit_append_only()
RETURNS TRIGGER AS $$ BEGIN
    RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_FORBIDDEN: audit is append-only';
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS agent_package_review_audit_append_only ON ${s}.agent_package_review_audit;
CREATE TRIGGER agent_package_review_audit_append_only
BEFORE UPDATE OR DELETE ON ${s}.agent_package_review_audit
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_package_review_audit_append_only();
-- Neither table cascades on package deletion: review history is evidence.
INSERT INTO ${s}.agent_package_reviews(version_id, package_id, sha256, prior_active_version_id)
SELECT v.version_id, v.package_id, v.sha256, p.active_version_id
FROM ${s}.agent_package_versions v JOIN ${s}.agent_packages p USING(package_id)
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION ${s}.cms_package_review_identity_immutable()
RETURNS TRIGGER AS $$ BEGIN
    IF OLD.inspection IS NULL AND NEW.inspection IS NOT NULL
       AND (to_jsonb(NEW) - 'inspection' - 'decision' - 'revision') =
           (to_jsonb(OLD) - 'inspection' - 'decision' - 'revision')
       AND OLD.decision='pending' AND NEW.decision IN ('pending','not_required')
       AND NEW.revision=OLD.revision+1 THEN
        RETURN NEW;
    END IF;
    IF (to_jsonb(NEW) - 'decision' - 'revision') IS DISTINCT FROM
       (to_jsonb(OLD) - 'decision' - 'revision') THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_CONFLICT: reviewed artifact identity and inspection are immutable';
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS agent_package_review_identity_immutable ON ${s}.agent_package_reviews;
CREATE TRIGGER agent_package_review_identity_immutable
BEFORE UPDATE ON ${s}.agent_package_reviews
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_package_review_identity_immutable();
CREATE OR REPLACE FUNCTION ${s}.cms_package_version_immutable()
RETURNS TRIGGER AS $$ BEGIN
    IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_CONFLICT: published artifact version is immutable';
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS agent_package_version_immutable ON ${s}.agent_package_versions;
CREATE TRIGGER agent_package_version_immutable
BEFORE UPDATE ON ${s}.agent_package_versions
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_package_version_immutable();

CREATE OR REPLACE FUNCTION ${s}.cms_record_agent_package_inspection(
    p_package_id TEXT,p_version_id TEXT,p_sha256 TEXT,p_revision BIGINT,p_inspection JSONB
) RETURNS VOID AS $$
DECLARE v_review ${s}.agent_package_reviews; v_name TEXT; v_semver TEXT; v_decision TEXT;
BEGIN
    SELECT name INTO v_name FROM ${s}.agent_packages WHERE package_id=p_package_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_NOT_FOUND: package deleted'; END IF;
    SELECT * INTO v_review FROM ${s}.agent_package_reviews
     WHERE package_id=p_package_id AND version_id=p_version_id FOR UPDATE;
    SELECT semver INTO v_semver FROM ${s}.agent_package_versions
     WHERE package_id=p_package_id AND version_id=p_version_id AND sha256=p_sha256;
    IF NOT FOUND THEN RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_NOT_FOUND: exact version required'; END IF;
    IF v_review.sha256 IS DISTINCT FROM p_sha256 OR v_review.revision IS DISTINCT FROM p_revision THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_CONFLICT: stale inspection identity/revision';
    END IF;
    IF p_inspection->>'sha256' IS DISTINCT FROM p_sha256 OR p_inspection->>'format' IS DISTINCT FROM '1'
       OR p_inspection->>'name' IS DISTINCT FROM v_name OR p_inspection->>'semver' IS DISTINCT FROM v_semver
       OR COALESCE(p_inspection->>'executable','') NOT IN ('true','false')
       OR jsonb_typeof(p_inspection->'files') IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_inspection->'files')=0 THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_INVALID: exact verified artifact inspection required';
    END IF;
    IF v_review.inspection IS NOT NULL THEN
        IF v_review.inspection IS DISTINCT FROM p_inspection THEN
            RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_CONFLICT: stored inspection is immutable';
        END IF;
        RETURN;
    END IF;
    IF v_review.decision <> 'pending' THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_CONFLICT: a denied candidate cannot be reclassified';
    END IF;
    v_decision := CASE WHEN p_inspection->>'executable'='false' THEN 'not_required' ELSE 'pending' END;
    UPDATE ${s}.agent_package_reviews SET inspection=p_inspection,decision=v_decision,revision=revision+1
     WHERE version_id=p_version_id;
    INSERT INTO ${s}.agent_package_review_audit
      (package_id,version_id,sha256,actor_provider,actor_subject,reason,before_decision,after_decision,revision)
    VALUES(p_package_id,p_version_id,p_sha256,'system','canonical-artifact-inspector',
       'first full canonical artifact inspection; no executable permission granted',v_review.decision,v_decision,v_review.revision+1);
    PERFORM ${s}.cms_agent_registry_bump();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_review_agent_package(
    p_package_id TEXT, p_version_id TEXT, p_sha256 TEXT, p_expected_revision BIGINT,
    p_decision TEXT, p_reason TEXT, p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN
) RETURNS JSONB AS $$
DECLARE v_review ${s}.agent_package_reviews; v_result JSONB;
BEGIN
    PERFORM ${s}.cms_package_runtime_barrier();
    IF p_is_admin IS DISTINCT FROM TRUE OR NULLIF(BTRIM(p_actor_provider), '') IS NULL
       OR NULLIF(BTRIM(p_actor_subject), '') IS NULL THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_FORBIDDEN: authenticated administrator required';
    END IF;
    IF p_decision IS NULL OR p_decision NOT IN ('approved', 'rejected', 'revoked')
       OR NULLIF(BTRIM(p_reason), '') IS NULL THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_INVALID: decision and reason required';
    END IF;
    -- Review/activation serialize on package first, then the exact candidate.
    PERFORM 1 FROM ${s}.agent_packages WHERE package_id = p_package_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_NOT_FOUND: package deleted'; END IF;
    SELECT * INTO v_review FROM ${s}.agent_package_reviews
      WHERE version_id = p_version_id AND package_id = p_package_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_NOT_FOUND: candidate not found'; END IF;
    IF p_sha256 IS DISTINCT FROM v_review.sha256
       OR p_expected_revision IS DISTINCT FROM v_review.revision THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_CONFLICT: exact candidate digest/revision required';
    END IF;
    IF p_decision = 'approved' AND (v_review.inspection IS NULL
       OR v_review.inspection->>'sha256' IS DISTINCT FROM v_review.sha256
       OR v_review.inspection->>'format' IS DISTINCT FROM '1'
       OR jsonb_typeof(v_review.inspection->'files') IS DISTINCT FROM 'array'
       OR jsonb_array_length(v_review.inspection->'files') = 0) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_BLOCKED: immutable artifact inspection is missing';
    END IF;
    IF p_decision = v_review.decision OR v_review.decision = 'revoked'
       OR (p_decision = 'approved' AND v_review.decision NOT IN ('pending', 'not_required'))
       OR (p_decision = 'rejected' AND v_review.decision <> 'pending') THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_CONFLICT: invalid review transition';
    END IF;
    INSERT INTO ${s}.agent_package_review_audit
        (package_id, version_id, sha256, actor_provider, actor_subject, reason, before_decision, after_decision, revision)
    VALUES (p_package_id, p_version_id, p_sha256, p_actor_provider, p_actor_subject,
            p_reason, v_review.decision, p_decision, v_review.revision + 1);
    UPDATE ${s}.agent_package_reviews SET decision = p_decision, revision = revision + 1
      WHERE version_id = p_version_id RETURNING to_jsonb(agent_package_reviews.*) INTO v_result;
    PERFORM ${s}.cms_agent_registry_bump();
    RETURN v_result;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS ${s}.agent_package_activation_audit (
    audit_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    package_id TEXT NOT NULL, version_id TEXT NOT NULL, sha256 TEXT NOT NULL,
    actor_provider TEXT NOT NULL, actor_subject TEXT NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    reason TEXT NOT NULL, before_version_id TEXT, after_version_id TEXT NOT NULL,
    review_revision BIGINT NOT NULL, activation_revision BIGINT NOT NULL
);
DROP TRIGGER IF EXISTS agent_package_activation_audit_append_only ON ${s}.agent_package_activation_audit;
CREATE TRIGGER agent_package_activation_audit_append_only
BEFORE UPDATE OR DELETE ON ${s}.agent_package_activation_audit
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_package_review_audit_append_only();

CREATE OR REPLACE FUNCTION ${s}.cms_activate_agent_package(
    p_package_id TEXT, p_version_id TEXT, p_sha256 TEXT, p_review_revision BIGINT,
    p_activation_revision BIGINT, p_active_version_id TEXT, p_reason TEXT,
    p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN
) RETURNS VOID AS $$
DECLARE v_pkg ${s}.agent_packages; v_review ${s}.agent_package_reviews;
BEGIN
    PERFORM ${s}.cms_package_runtime_barrier();
    IF p_is_admin IS DISTINCT FROM TRUE OR NULLIF(BTRIM(p_actor_provider), '') IS NULL
       OR NULLIF(BTRIM(p_actor_subject), '') IS NULL THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_FORBIDDEN: authenticated administrator required';
    END IF;
    IF NULLIF(BTRIM(p_reason), '') IS NULL THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_INVALID: activation reason required';
    END IF;
    SELECT * INTO v_pkg FROM ${s}.agent_packages WHERE package_id = p_package_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_NOT_FOUND: package not found'; END IF;
    SELECT * INTO v_review FROM ${s}.agent_package_reviews
     WHERE package_id = p_package_id AND version_id = p_version_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_NOT_FOUND: candidate not found'; END IF;
    IF v_review.sha256 IS DISTINCT FROM p_sha256 OR v_review.revision IS DISTINCT FROM p_review_revision
       OR v_pkg.activation_revision IS DISTINCT FROM p_activation_revision
       OR v_pkg.active_version_id IS DISTINCT FROM p_active_version_id
       OR v_pkg.active_version_id = p_version_id THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_CONFLICT: stale activation identity/revision/pointer';
    END IF;
    IF NOT v_pkg.enabled OR v_review.decision NOT IN ('approved', 'not_required')
       OR v_review.inspection IS NULL OR v_review.inspection->>'sha256' IS DISTINCT FROM p_sha256
       OR (v_review.inspection->>'executable' IS DISTINCT FROM 'false'
           AND NOT ${s}.cms_package_executable_eligible(p_package_id,p_version_id,p_sha256)) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_BLOCKED: executable dependency closure is not verified; content acceptance is not execution approval';
    END IF;
    UPDATE ${s}.agent_packages SET active_version_id = p_version_id WHERE package_id = p_package_id;
    INSERT INTO ${s}.agent_package_activation_audit
      (package_id,version_id,sha256,actor_provider,actor_subject,reason,before_version_id,after_version_id,
       review_revision,activation_revision)
    SELECT p_package_id,p_version_id,p_sha256,p_actor_provider,p_actor_subject,p_reason,
           v_pkg.active_version_id,p_version_id,p_review_revision,p.activation_revision
      FROM ${s}.agent_packages p WHERE p.package_id = p_package_id;
    PERFORM ${s}.cms_agent_registry_bump();
END;
$$ LANGUAGE plpgsql;

-- Identity/ownership/semver rules mirror 0063. Pending publication never
-- touches active_version_id, so v1 remains active while v2 is reviewed.
CREATE OR REPLACE FUNCTION ${s}.cms_publish_reviewed_agent_package(
    p_package_id TEXT, p_version_id TEXT, p_name TEXT, p_scope TEXT,
    p_owner_provider TEXT, p_owner_subject TEXT, p_source_id TEXT,
    p_semver TEXT, p_sha256 TEXT, p_size_bytes BIGINT, p_artifact_filename TEXT,
    p_commit_sha TEXT, p_manifest JSONB, p_created_by TEXT, p_is_admin BOOLEAN,
    p_inspection JSONB
) RETURNS TABLE(status TEXT, package_id TEXT, version_id TEXT) AS $$
DECLARE
    v_pkg ${s}.agent_packages;
    v_ver ${s}.agent_package_versions;
    v_declarative BOOLEAN;
    v_owner_provider TEXT := NULLIF(BTRIM(p_owner_provider), '');
    v_owner_subject TEXT := NULLIF(BTRIM(p_owner_subject), '');
BEGIN
    IF p_scope IS NULL OR p_scope NOT IN ('shared', 'user') THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_BAD_SCOPE: shared or user required';
    END IF;
    IF LEFT(LOWER(BTRIM(p_name)), 2) = '__' THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_RESERVED_NAME: reserved prefix';
    END IF;
    IF p_is_admin IS DISTINCT FROM TRUE AND (v_owner_provider IS NULL OR v_owner_subject IS NULL) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_FORBIDDEN: authenticated publisher required';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
        jsonb_build_array(p_name, p_scope,
          CASE WHEN p_scope = 'user' THEN v_owner_provider END,
          CASE WHEN p_scope = 'user' THEN v_owner_subject END)::TEXT, 0));
    SELECT p.* INTO v_pkg FROM ${s}.agent_packages p
     WHERE p.name = p_name AND p.scope = p_scope
       AND (p_scope = 'shared' OR (p.owner_provider IS NOT DISTINCT FROM v_owner_provider
          AND p.owner_subject IS NOT DISTINCT FROM v_owner_subject)) FOR UPDATE;
    IF NOT FOUND THEN
        INSERT INTO ${s}.agent_packages
          (package_id, source_id, name, scope, owner_provider, owner_subject, created_by)
        VALUES (p_package_id, p_source_id, p_name, p_scope, v_owner_provider, v_owner_subject, p_created_by)
        RETURNING * INTO v_pkg;
    ELSIF p_is_admin IS DISTINCT FROM TRUE
       AND NOT (v_pkg.owner_provider IS NOT NULL
           AND v_pkg.owner_provider IS NOT DISTINCT FROM v_owner_provider
           AND v_pkg.owner_subject IS NOT DISTINCT FROM v_owner_subject)
       AND NOT ${s}.cms_agent_package_is_editor(v_pkg.package_id, v_owner_provider, v_owner_subject) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_FORBIDDEN: creator, editor or admin required';
    END IF;
    IF p_inspection IS NOT NULL AND (p_inspection->>'sha256' IS DISTINCT FROM p_sha256
       OR p_inspection->>'format' IS DISTINCT FROM '1') THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_INVALID: inspection identity mismatch';
    END IF;
    v_declarative := p_inspection->>'executable' = 'false';
    SELECT * INTO v_ver FROM ${s}.agent_package_versions v
     WHERE v.package_id = v_pkg.package_id AND v.semver = p_semver;
    IF FOUND THEN
        IF v_ver.sha256 = p_sha256 THEN
            RETURN QUERY SELECT 'noop'::TEXT, v_pkg.package_id, v_ver.version_id;
            RETURN;
        END IF;
        RAISE EXCEPTION 'AGENT_PACKAGE_SEMVER_CONFLICT: published versions are immutable';
    END IF;
    INSERT INTO ${s}.agent_package_versions
      (version_id, package_id, semver, sha256, size_bytes, artifact_filename, commit_sha, manifest, created_by)
    VALUES (p_version_id, v_pkg.package_id, p_semver, p_sha256, p_size_bytes,
            p_artifact_filename, p_commit_sha, p_manifest, p_created_by);
    INSERT INTO ${s}.agent_package_reviews
        (version_id, package_id, sha256, decision, inspection, prior_active_version_id)
    VALUES (p_version_id, v_pkg.package_id, p_sha256,
            CASE WHEN v_declarative THEN 'not_required' ELSE 'pending' END, p_inspection, v_pkg.active_version_id);
    IF v_declarative THEN
        UPDATE ${s}.agent_packages SET active_version_id = p_version_id
         WHERE ${s}.agent_packages.package_id = v_pkg.package_id;
    END IF;
    UPDATE ${s}.agent_packages SET source_id = COALESCE(p_source_id, source_id)
     WHERE ${s}.agent_packages.package_id = v_pkg.package_id;
    PERFORM ${s}.cms_agent_registry_bump();
    RETURN QUERY SELECT 'published'::TEXT, v_pkg.package_id, p_version_id;
END;
$$ LANGUAGE plpgsql;

-- Covers legacy pin/publish and direct catalog activation, not just the UI.
CREATE OR REPLACE FUNCTION ${s}.cms_guard_agent_package_activation()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.active_version_id IS NULL OR NEW.active_version_id IS NOT DISTINCT FROM OLD.active_version_id THEN RETURN NEW; END IF;
    IF NOT EXISTS (
        SELECT 1 FROM ${s}.agent_package_reviews r
        JOIN ${s}.agent_package_versions v ON v.version_id = r.version_id
        WHERE r.version_id = NEW.active_version_id AND r.package_id = NEW.package_id AND r.sha256 = v.sha256
          AND r.decision IN ('not_required','approved')
          AND (r.inspection->>'executable' = 'false'
               OR ${s}.cms_package_executable_eligible(r.package_id,r.version_id,r.sha256))
    ) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_ACTIVATION_DENIED: candidate has no verified declarative inspection; executable runtime is not ready';
    END IF;
    NEW.activation_revision := OLD.activation_revision + 1;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS agent_package_activation_guard ON ${s}.agent_packages;
CREATE TRIGGER agent_package_activation_guard
BEFORE UPDATE OF active_version_id ON ${s}.agent_packages
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_guard_agent_package_activation();

DROP FUNCTION IF EXISTS ${s}.cms_get_agent_packages_install_manifest();
CREATE FUNCTION ${s}.cms_get_agent_packages_install_manifest()
RETURNS TABLE(
    package_id TEXT, name TEXT, scope TEXT, owner_provider TEXT, owner_subject TEXT,
    semver TEXT, sha256 TEXT, size_bytes BIGINT, artifact_filename TEXT, manifest JSONB,
    version_id TEXT, review_decision TEXT, review_revision BIGINT
) AS $$
    SELECT p.package_id, p.name, p.scope, p.owner_provider, p.owner_subject,
           v.semver, v.sha256, v.size_bytes, v.artifact_filename, v.manifest,
           v.version_id, r.decision, r.revision
      FROM ${s}.agent_packages p JOIN ${s}.agent_package_versions v ON v.version_id = p.active_version_id
      LEFT JOIN ${s}.agent_package_reviews r ON r.version_id = v.version_id
     WHERE p.enabled ORDER BY p.name, p.scope, p.owner_provider, p.owner_subject;
$$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_agent_packages_runtime_install_manifest()
RETURNS TABLE(
    package_id TEXT, name TEXT, scope TEXT, owner_provider TEXT, owner_subject TEXT,
    semver TEXT, sha256 TEXT, size_bytes BIGINT, artifact_filename TEXT, manifest JSONB,
    version_id TEXT, review_decision TEXT, review_revision BIGINT
) AS $$ SELECT * FROM ${s}.cms_get_agent_packages_install_manifest(); $$ LANGUAGE sql;

CREATE TABLE IF NOT EXISTS ${s}.session_agent_package_bindings (
    session_id TEXT PRIMARY KEY, package_id TEXT NOT NULL, version_id TEXT NOT NULL,
    sha256 TEXT NOT NULL, agent_name TEXT NOT NULL, revision BIGINT NOT NULL DEFAULT 1,
    owner_provider TEXT NOT NULL, owner_subject TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ${s}.session_agent_package_binding_audit (
    audit_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL, package_id TEXT NOT NULL, version_id TEXT NOT NULL, sha256 TEXT NOT NULL,
    before_version_id TEXT, before_sha256 TEXT, revision BIGINT NOT NULL,
    actor_provider TEXT NOT NULL, actor_subject TEXT NOT NULL, reason TEXT NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
DROP TRIGGER IF EXISTS session_agent_package_binding_audit_append_only ON ${s}.session_agent_package_binding_audit;
CREATE TRIGGER session_agent_package_binding_audit_append_only
BEFORE UPDATE OR DELETE ON ${s}.session_agent_package_binding_audit
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_package_review_audit_append_only();

CREATE OR REPLACE FUNCTION ${s}.cms_assert_session_package_target(
    p_session_id TEXT, p_package_id TEXT, p_version_id TEXT, p_sha256 TEXT, p_agent_name TEXT
) RETURNS JSONB AS $$
DECLARE v_pkg ${s}.agent_packages; v_owner RECORD; v_version RECORD; v_root TEXT;
BEGIN
    SELECT COALESCE(root_session_id, session_id) INTO v_root FROM ${s}.sessions
     WHERE session_id=p_session_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_NOT_FOUND: live session required'; END IF;
    SELECT * INTO v_pkg FROM ${s}.agent_packages WHERE package_id=p_package_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_NOT_FOUND: package deleted'; END IF;
    SELECT u.provider,u.subject INTO v_owner FROM ${s}.session_owners so JOIN ${s}.users u USING(user_id)
     WHERE so.session_id=v_root FOR SHARE OF so;
    IF NOT FOUND OR NOT v_pkg.enabled OR (v_pkg.scope='user' AND
       (v_pkg.owner_provider IS DISTINCT FROM v_owner.provider OR v_pkg.owner_subject IS DISTINCT FROM v_owner.subject)) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_FORBIDDEN: current session owner has no enabled package access';
    END IF;
    SELECT v.*,r.decision,r.inspection INTO v_version FROM ${s}.agent_package_versions v
     JOIN ${s}.agent_package_reviews r USING(version_id)
     WHERE v.version_id=p_version_id AND v.package_id=p_package_id AND v.sha256=p_sha256 AND r.sha256=p_sha256
     FOR SHARE OF v,r;
    IF NOT FOUND THEN RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_NOT_FOUND: exact content identity required'; END IF;
    IF v_version.decision NOT IN ('approved','not_required') OR
       (v_version.inspection->>'executable' IS DISTINCT FROM 'false'
         AND NOT ${s}.cms_package_executable_eligible(p_package_id,p_version_id,p_sha256)) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_BLOCKED: rejected/revoked/unverified executable binding is denied';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(v_version.manifest->'agents','[]'::JSONB)) a
       WHERE a->>'name'=regexp_replace(p_agent_name,'^.*:','')) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_FORBIDDEN: agent not declared by exact version';
    END IF;
    RETURN jsonb_build_object('provider',v_owner.provider,'subject',v_owner.subject);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_bind_new_session_agent_package(
    p_session_id TEXT,p_package_id TEXT,p_agent_name TEXT
) RETURNS VOID AS $$
DECLARE v_pkg ${s}.agent_packages; v_version ${s}.agent_package_versions;
    v_binding ${s}.session_agent_package_bindings; v_owner JSONB;
BEGIN
    PERFORM 1 FROM ${s}.sessions WHERE session_id=p_session_id FOR UPDATE;
    SELECT * INTO v_binding FROM ${s}.session_agent_package_bindings WHERE session_id=p_session_id FOR UPDATE;
    IF FOUND THEN
        IF v_binding.package_id IS DISTINCT FROM p_package_id OR v_binding.agent_name IS DISTINCT FROM p_agent_name THEN
            RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_CONFLICT: existing binding requires explicit rebind';
        END IF;
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM ${s}.sessions
       WHERE session_id=p_session_id AND package_binding_policy_version=1) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_CONFLICT: historical session requires explicit exact-content rebind';
    END IF;
    SELECT * INTO v_pkg FROM ${s}.agent_packages WHERE package_id=p_package_id FOR UPDATE;
    SELECT * INTO v_version FROM ${s}.agent_package_versions WHERE version_id=v_pkg.active_version_id;
    v_owner := ${s}.cms_assert_session_package_target(
        p_session_id,p_package_id,v_version.version_id,v_version.sha256,p_agent_name);
    INSERT INTO ${s}.session_agent_package_bindings
      (session_id,package_id,version_id,sha256,agent_name,owner_provider,owner_subject)
    VALUES(p_session_id,p_package_id,v_version.version_id,v_version.sha256,p_agent_name,v_owner->>'provider',v_owner->>'subject');
    INSERT INTO ${s}.session_agent_package_binding_audit
      (session_id,package_id,version_id,sha256,revision,actor_provider,actor_subject,reason)
    VALUES(p_session_id,p_package_id,v_version.version_id,v_version.sha256,1,v_owner->>'provider',v_owner->>'subject','initial binding');
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_rebind_session_agent_package(
    p_session_id TEXT,p_package_id TEXT,p_version_id TEXT,p_sha256 TEXT,p_agent_name TEXT,
    p_expected_revision BIGINT,p_reason TEXT,p_actor_provider TEXT,p_actor_subject TEXT,p_is_admin BOOLEAN
) RETURNS VOID AS $$
DECLARE v_binding ${s}.session_agent_package_bindings; v_owner JSONB;
BEGIN
    IF p_is_admin IS DISTINCT FROM TRUE OR NULLIF(BTRIM(p_actor_provider),'') IS NULL
       OR NULLIF(BTRIM(p_actor_subject),'') IS NULL THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_FORBIDDEN: authenticated administrator required';
    END IF;
    IF NULLIF(BTRIM(p_reason),'') IS NULL THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_INVALID: rebind reason required';
    END IF;
    v_owner := ${s}.cms_assert_session_package_target(p_session_id,p_package_id,p_version_id,p_sha256,p_agent_name);
    SELECT * INTO v_binding FROM ${s}.session_agent_package_bindings WHERE session_id=p_session_id FOR UPDATE;
    IF NOT FOUND THEN
        IF p_expected_revision IS DISTINCT FROM 0 THEN
            RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_CONFLICT: unbound session requires expected binding revision zero';
        END IF;
        INSERT INTO ${s}.session_agent_package_bindings
          (session_id,package_id,version_id,sha256,agent_name,owner_provider,owner_subject)
        VALUES(p_session_id,p_package_id,p_version_id,p_sha256,p_agent_name,v_owner->>'provider',v_owner->>'subject');
        INSERT INTO ${s}.session_agent_package_binding_audit
          (session_id,package_id,version_id,sha256,revision,actor_provider,actor_subject,reason)
        VALUES(p_session_id,p_package_id,p_version_id,p_sha256,1,p_actor_provider,p_actor_subject,p_reason);
        RETURN;
    END IF;
    IF v_binding.revision IS DISTINCT FROM p_expected_revision OR v_binding.package_id IS DISTINCT FROM p_package_id
       OR v_binding.agent_name IS DISTINCT FROM p_agent_name THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_CONFLICT: exact binding revision/package/agent required';
    END IF;
    UPDATE ${s}.session_agent_package_bindings SET version_id=p_version_id,sha256=p_sha256,revision=revision+1,
       owner_provider=v_owner->>'provider',owner_subject=v_owner->>'subject' WHERE session_id=p_session_id;
    INSERT INTO ${s}.session_agent_package_binding_audit
      (session_id,package_id,version_id,sha256,before_version_id,before_sha256,revision,actor_provider,actor_subject,reason)
    VALUES(p_session_id,p_package_id,p_version_id,p_sha256,v_binding.version_id,v_binding.sha256,
       v_binding.revision+1,p_actor_provider,p_actor_subject,p_reason);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_session_agent_package_binding(p_session_id TEXT)
RETURNS JSONB AS $$
DECLARE v_binding ${s}.session_agent_package_bindings; v_allowed BOOLEAN := TRUE;
BEGIN
    SELECT * INTO v_binding FROM ${s}.session_agent_package_bindings WHERE session_id=p_session_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    BEGIN
        IF ${s}.cms_assert_session_package_target(p_session_id,v_binding.package_id,v_binding.version_id,
             v_binding.sha256,v_binding.agent_name) IS DISTINCT FROM
             jsonb_build_object('provider',v_binding.owner_provider,'subject',v_binding.owner_subject) THEN
            v_allowed := FALSE;
        END IF;
    EXCEPTION WHEN raise_exception THEN v_allowed := FALSE;
    END;
    RETURN jsonb_build_object('sessionId',v_binding.session_id,'packageId',v_binding.package_id,
       'versionId',v_binding.version_id,'sha256',v_binding.sha256,'agentName',v_binding.agent_name,
       'revision',v_binding.revision,'owner',jsonb_build_object('provider',v_binding.owner_provider,'subject',v_binding.owner_subject),
       'allowed',v_allowed);
END;
$$ LANGUAGE plpgsql;
`;
}
