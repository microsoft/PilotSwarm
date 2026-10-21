export function packageRuntimeMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS package_owner_epoch BIGINT NOT NULL DEFAULT 1;
ALTER TABLE ${s}.sessions ADD COLUMN IF NOT EXISTS package_capability_epoch BIGINT NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS ${s}.package_runtime_registrations (
    registration_id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, generation TEXT NOT NULL,
    package_id TEXT NOT NULL,version_id TEXT NOT NULL,sha256 TEXT NOT NULL,
    review_revision BIGINT NOT NULL,registry_epoch BIGINT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('active','fence_requested','fenced')),
    lease_until TIMESTAMPTZ NOT NULL, requested_at TIMESTAMPTZ, fenced_at TIMESTAMPTZ,
    node_version TEXT NOT NULL, UNIQUE(registration_id,generation)
);
CREATE TABLE IF NOT EXISTS ${s}.package_runtime_audit (
    sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    registration_id TEXT NOT NULL, generation TEXT NOT NULL, session_id TEXT,
    operation TEXT NOT NULL, target TEXT NOT NULL, event TEXT NOT NULL,
    owner_provider TEXT,owner_subject TEXT,at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
DROP TRIGGER IF EXISTS package_runtime_audit_append_only ON ${s}.package_runtime_audit;
CREATE TRIGGER package_runtime_audit_append_only BEFORE UPDATE OR DELETE ON ${s}.package_runtime_audit
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_package_review_audit_append_only();
CREATE OR REPLACE FUNCTION ${s}.cms_package_runtime_barrier() RETURNS VOID AS $$
BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('${schema.replace(/'/g, "''")}:package-runtime-admission',0)); END;
$$ LANGUAGE plpgsql;
DO $bootstrap$ BEGIN
 IF to_regprocedure('${s.replace(/'/g, "''")}.cms_package_runtime_fleet_eligible()') IS NULL THEN
  EXECUTE $definition$CREATE FUNCTION ${s}.cms_package_runtime_fleet_eligible() RETURNS BOOLEAN AS 'SELECT TRUE' LANGUAGE sql$definition$;
 END IF;
END $bootstrap$;
CREATE OR REPLACE FUNCTION ${s}.cms_package_executable_eligible(p_package TEXT,p_version TEXT,p_sha TEXT)
RETURNS BOOLEAN AS $$
SELECT ${s}.cms_package_runtime_fleet_eligible() AND EXISTS(SELECT 1 FROM ${s}.agent_package_reviews r
 WHERE r.package_id=p_package AND r.version_id=p_version AND r.sha256=p_sha AND r.decision='approved'
 AND r.inspection->'execution'->>'policy'='1'
 AND r.inspection->'execution'->>'artifactSha256'=p_sha);
$$ LANGUAGE sql;
CREATE OR REPLACE FUNCTION ${s}.cms_get_agent_packages_runtime_install_manifest()
RETURNS TABLE(
    package_id TEXT, name TEXT, scope TEXT, owner_provider TEXT, owner_subject TEXT,
    semver TEXT, sha256 TEXT, size_bytes BIGINT, artifact_filename TEXT, manifest JSONB,
    version_id TEXT, review_decision TEXT, review_revision BIGINT
) AS $$
SELECT p.package_id,p.name,p.scope,p.owner_provider,p.owner_subject,
    v.semver,v.sha256,v.size_bytes,v.artifact_filename,v.manifest,v.version_id,r.decision,r.revision
FROM ${s}.agent_packages p JOIN ${s}.agent_package_versions v ON v.version_id=p.active_version_id
LEFT JOIN ${s}.agent_package_reviews r ON r.version_id=v.version_id
WHERE p.enabled ORDER BY p.name,p.scope,p.owner_provider,p.owner_subject;
$$ LANGUAGE sql;
-- Legacy cold loaders never receive executable or uninspected artifacts.
-- This does not fence already-running pre-protocol worker code.
CREATE OR REPLACE FUNCTION ${s}.cms_get_agent_packages_install_manifest()
RETURNS TABLE(
    package_id TEXT, name TEXT, scope TEXT, owner_provider TEXT, owner_subject TEXT,
    semver TEXT, sha256 TEXT, size_bytes BIGINT, artifact_filename TEXT, manifest JSONB,
    version_id TEXT, review_decision TEXT, review_revision BIGINT
) AS $$
SELECT a.* FROM ${s}.cms_get_agent_packages_runtime_install_manifest() a
JOIN ${s}.agent_package_reviews r ON r.version_id=a.version_id
WHERE r.inspection->>'executable'='false' AND r.decision IN ('approved','not_required');
$$ LANGUAGE sql;
CREATE OR REPLACE FUNCTION ${s}.cms_request_package_fences(p_package TEXT,p_version TEXT DEFAULT NULL)
RETURNS VOID AS $$ BEGIN
    PERFORM ${s}.cms_package_runtime_barrier();
    UPDATE ${s}.package_runtime_registrations SET state='fence_requested',requested_at=clock_timestamp()
     WHERE package_id=p_package AND (p_version IS NULL OR version_id=p_version) AND state='active';
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION ${s}.cms_runtime_package_change() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP='DELETE' OR (NEW.enabled,NEW.scope,NEW.owner_provider,NEW.owner_subject,NEW.active_version_id)
       IS DISTINCT FROM (OLD.enabled,OLD.scope,OLD.owner_provider,OLD.owner_subject,OLD.active_version_id) THEN
        PERFORM ${s}.cms_request_package_fences(OLD.package_id);
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS package_runtime_package_change ON ${s}.agent_packages;
CREATE TRIGGER package_runtime_package_change BEFORE UPDATE OR DELETE ON ${s}.agent_packages
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_runtime_package_change();
CREATE OR REPLACE FUNCTION ${s}.cms_runtime_review_change() RETURNS TRIGGER AS $$
BEGIN
    PERFORM ${s}.cms_request_package_fences(OLD.package_id,OLD.version_id);
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS package_runtime_review_change ON ${s}.agent_package_reviews;
CREATE TRIGGER package_runtime_review_change BEFORE UPDATE OR DELETE ON ${s}.agent_package_reviews
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_runtime_review_change();
CREATE OR REPLACE FUNCTION ${s}.cms_runtime_session_change(p_session TEXT,p_owner BOOLEAN)
RETURNS VOID AS $$ DECLARE v_package TEXT; v_changed BOOLEAN:=FALSE;
BEGIN
    PERFORM ${s}.cms_package_runtime_barrier();
    IF p_owner THEN
        UPDATE ${s}.sessions SET package_owner_epoch=package_owner_epoch+1 WHERE session_id=p_session;
    ELSE
        UPDATE ${s}.sessions SET package_capability_epoch=package_capability_epoch+1 WHERE session_id=p_session;
    END IF;
    FOR v_package IN SELECT DISTINCT b.package_id FROM ${s}.session_agent_package_bindings b
      JOIN ${s}.sessions ss USING(session_id)
      WHERE b.session_id=p_session OR ss.root_session_id=p_session LOOP
        PERFORM ${s}.cms_request_package_fences(v_package);
        v_changed:=TRUE;
    END LOOP;
    IF v_changed THEN PERFORM ${s}.cms_agent_registry_bump(); END IF;
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION ${s}.cms_runtime_owner_change() RETURNS TRIGGER AS $$
BEGIN
    PERFORM ${s}.cms_runtime_session_change(CASE WHEN TG_OP='DELETE' THEN OLD.session_id ELSE NEW.session_id END,TRUE);
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS package_runtime_owner_change ON ${s}.session_owners;
CREATE TRIGGER package_runtime_owner_change BEFORE INSERT OR UPDATE OR DELETE ON ${s}.session_owners
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_runtime_owner_change();
CREATE OR REPLACE FUNCTION ${s}.cms_runtime_capability_change() RETURNS TRIGGER AS $$
BEGIN
    PERFORM ${s}.cms_runtime_session_change(CASE WHEN TG_OP='DELETE' THEN OLD.session_id ELSE NEW.session_id END,FALSE);
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS package_runtime_capability_change ON ${s}.session_capabilities;
CREATE TRIGGER package_runtime_capability_change BEFORE INSERT OR UPDATE OR DELETE ON ${s}.session_capabilities
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_runtime_capability_change();
CREATE OR REPLACE FUNCTION ${s}.cms_runtime_binding_change() RETURNS TRIGGER AS $$
BEGIN
    PERFORM ${s}.cms_request_package_fences(OLD.package_id);
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS package_runtime_binding_change ON ${s}.session_agent_package_bindings;
CREATE TRIGGER package_runtime_binding_change BEFORE UPDATE OR DELETE ON ${s}.session_agent_package_bindings
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_runtime_binding_change();
CREATE OR REPLACE FUNCTION ${s}.cms_runtime_session_lifecycle() RETURNS TRIGGER AS $$
DECLARE v_package TEXT;
BEGIN
    FOR v_package IN SELECT DISTINCT b.package_id FROM ${s}.session_agent_package_bindings b
      JOIN ${s}.sessions ss USING(session_id)
      WHERE b.session_id=OLD.session_id OR ss.root_session_id=OLD.session_id LOOP
        PERFORM ${s}.cms_request_package_fences(v_package);
    END LOOP;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS package_runtime_session_lifecycle ON ${s}.sessions;
CREATE TRIGGER package_runtime_session_lifecycle BEFORE UPDATE OF root_session_id,deleted_at OR DELETE ON ${s}.sessions
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_runtime_session_lifecycle();
CREATE OR REPLACE FUNCTION ${s}.cms_runtime_user_lifecycle() RETURNS TRIGGER AS $$
DECLARE v_session TEXT;
BEGIN
    FOR v_session IN SELECT session_id FROM ${s}.session_owners WHERE user_id=OLD.user_id LOOP
        PERFORM ${s}.cms_runtime_session_change(v_session,TRUE);
    END LOOP;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS package_runtime_user_lifecycle ON ${s}.users;
CREATE TRIGGER package_runtime_user_lifecycle BEFORE UPDATE OF provider,subject OR DELETE ON ${s}.users
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_runtime_user_lifecycle();
`;
}
