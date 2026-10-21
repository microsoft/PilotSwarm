export function packageRuntimeCompletionMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
ALTER TABLE ${s}.package_runtime_registrations ADD COLUMN IF NOT EXISTS host_key TEXT;
ALTER TABLE ${s}.package_runtime_registrations ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();
CREATE TABLE IF NOT EXISTS ${s}.package_runtime_processes (
 registration_id TEXT NOT NULL,generation TEXT NOT NULL,host_key TEXT NOT NULL,
 pid INTEGER NOT NULL,start_token TEXT NOT NULL,role TEXT NOT NULL,
 PRIMARY KEY(registration_id,generation,pid,start_token)
);
CREATE TABLE IF NOT EXISTS ${s}.package_runtime_legacy_workers (
 worker_id TEXT PRIMARY KEY,state TEXT NOT NULL DEFAULT 'unverified' CHECK(state IN ('unverified','fenced')),
 revision BIGINT NOT NULL DEFAULT 1,evidence JSONB,at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO ${s}.package_runtime_legacy_workers(worker_id)
 SELECT worker_node_id FROM ${s}.workers WHERE info->>'packageRuntimeProtocol' IS DISTINCT FROM '1'
 UNION SELECT a.worker_node_id FROM ${s}.agent_worker_state a WHERE NOT EXISTS(
 SELECT 1 FROM ${s}.workers w WHERE w.worker_node_id=a.worker_node_id AND w.info->>'packageRuntimeProtocol'='1')
 ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION ${s}.cms_runtime_legacy_worker_guard() RETURNS TRIGGER AS $$
BEGIN
 IF NEW.info->>'packageRuntimeProtocol' IS DISTINCT FROM '1' THEN
  PERFORM ${s}.cms_package_runtime_barrier();
  INSERT INTO ${s}.package_runtime_legacy_workers(worker_id) VALUES(NEW.worker_node_id)
  ON CONFLICT(worker_id) DO UPDATE SET state='unverified',revision=${s}.package_runtime_legacy_workers.revision+1,at=clock_timestamp();
  UPDATE ${s}.package_runtime_registrations SET state='fence_requested',requested_at=clock_timestamp() WHERE state='active';
 END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS package_runtime_legacy_worker_guard ON ${s}.workers;
CREATE TRIGGER package_runtime_legacy_worker_guard BEFORE INSERT OR UPDATE OF info ON ${s}.workers
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_runtime_legacy_worker_guard();
CREATE OR REPLACE FUNCTION ${s}.cms_package_runtime_fleet_eligible() RETURNS BOOLEAN AS $$
SELECT NOT EXISTS(SELECT 1 FROM ${s}.package_runtime_legacy_workers WHERE state<>'fenced');
$$ LANGUAGE sql;
CREATE OR REPLACE FUNCTION ${s}.cms_package_executable_eligible(p_package TEXT,p_version TEXT,p_sha TEXT)
RETURNS BOOLEAN AS $$
SELECT ${s}.cms_package_runtime_fleet_eligible()
 AND EXISTS(SELECT 1 FROM ${s}.agent_package_reviews r
 WHERE r.package_id=p_package AND r.version_id=p_version AND r.sha256=p_sha AND r.decision='approved'
 AND r.inspection->'execution'->>'policy'='1' AND r.inspection->'execution'->>'artifactSha256'=p_sha);
$$ LANGUAGE sql;
CREATE TABLE IF NOT EXISTS ${s}.session_executable_package_grants (
 session_id TEXT NOT NULL,package_id TEXT NOT NULL,version_id TEXT NOT NULL,sha256 TEXT NOT NULL,
 owner_provider TEXT NOT NULL,owner_subject TEXT NOT NULL,
 source_ref TEXT NOT NULL,capability_revision BIGINT NOT NULL,
 tools JSONB NOT NULL,mcp_servers JSONB NOT NULL,callbacks JSONB NOT NULL DEFAULT '[]',
 active BOOLEAN NOT NULL DEFAULT TRUE,
 PRIMARY KEY(session_id,package_id,version_id,sha256)
);
CREATE TABLE IF NOT EXISTS ${s}.session_executable_package_grant_audit (
 sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,session_id TEXT NOT NULL,
 package_id TEXT NOT NULL,version_id TEXT NOT NULL,sha256 TEXT NOT NULL,
 capability_revision BIGINT NOT NULL,event TEXT NOT NULL,
 owner_provider TEXT NOT NULL,owner_subject TEXT NOT NULL,at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
DROP TRIGGER IF EXISTS executable_grant_audit_append_only ON ${s}.session_executable_package_grant_audit;
CREATE TRIGGER executable_grant_audit_append_only BEFORE UPDATE OR DELETE ON ${s}.session_executable_package_grant_audit
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_package_review_audit_append_only();
CREATE OR REPLACE FUNCTION ${s}.cms_runtime_grant_change() RETURNS TRIGGER AS $$
BEGIN
 PERFORM ${s}.cms_request_package_fences(OLD.package_id,OLD.version_id);
 PERFORM ${s}.cms_agent_registry_bump();
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS executable_grant_change ON ${s}.session_executable_package_grants;
CREATE TRIGGER executable_grant_change BEFORE UPDATE ON ${s}.session_executable_package_grants
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_runtime_grant_change();
CREATE OR REPLACE FUNCTION ${s}.cms_runtime_grant_session_change() RETURNS TRIGGER AS $$
DECLARE v_package TEXT; v_changed BOOLEAN:=FALSE;
BEGIN
 FOR v_package IN SELECT DISTINCT g.package_id FROM ${s}.session_executable_package_grants g
 JOIN ${s}.sessions ss USING(session_id)
 WHERE g.session_id=COALESCE(NEW.session_id,OLD.session_id) OR ss.root_session_id=COALESCE(NEW.session_id,OLD.session_id) LOOP
 PERFORM ${s}.cms_request_package_fences(v_package);
 v_changed:=TRUE;
 END LOOP;
 IF v_changed THEN PERFORM ${s}.cms_agent_registry_bump(); END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS executable_grants_owner_change ON ${s}.session_owners;
CREATE TRIGGER executable_grants_owner_change BEFORE UPDATE OR DELETE ON ${s}.session_owners
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_runtime_grant_session_change();
DROP TRIGGER IF EXISTS executable_grants_capability_change ON ${s}.session_capabilities;
CREATE TRIGGER executable_grants_capability_change BEFORE INSERT OR UPDATE OR DELETE ON ${s}.session_capabilities
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_runtime_grant_session_change();
DROP TRIGGER IF EXISTS executable_grants_session_lifecycle ON ${s}.sessions;
CREATE TRIGGER executable_grants_session_lifecycle BEFORE DELETE OR UPDATE OF deleted_at ON ${s}.sessions
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_runtime_grant_session_change();
CREATE OR REPLACE FUNCTION ${s}.cms_runtime_grant_user_change() RETURNS TRIGGER AS $$
DECLARE v_session TEXT;
BEGIN
 FOR v_session IN SELECT session_id FROM ${s}.session_owners WHERE user_id=OLD.user_id LOOP
  PERFORM ${s}.cms_runtime_session_change(v_session,TRUE);
  PERFORM ${s}.cms_request_package_fences(g.package_id) FROM ${s}.session_executable_package_grants g
   JOIN ${s}.sessions ss USING(session_id) WHERE g.session_id=v_session OR ss.root_session_id=v_session;
 END LOOP;
 PERFORM ${s}.cms_agent_registry_bump();
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS executable_grants_user_change ON ${s}.users;
CREATE TRIGGER executable_grants_user_change BEFORE DELETE OR UPDATE OF provider,subject ON ${s}.users
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_runtime_grant_user_change();
CREATE OR REPLACE FUNCTION ${s}.cms_runtime_agent_configuration_change() RETURNS TRIGGER AS $$
DECLARE v_package TEXT; v_changed BOOLEAN:=FALSE;
BEGIN
 IF (NEW.creation_config,NEW.root_session_id) IS NOT DISTINCT FROM (OLD.creation_config,OLD.root_session_id) THEN RETURN NEW; END IF;
 PERFORM ${s}.cms_package_runtime_barrier();
 NEW.package_capability_epoch:=OLD.package_capability_epoch+1;
 FOR v_package IN
  SELECT g.package_id FROM ${s}.session_executable_package_grants g JOIN ${s}.sessions ss USING(session_id)
   WHERE g.session_id=OLD.session_id OR ss.root_session_id=OLD.session_id
  UNION SELECT b.package_id FROM ${s}.session_agent_package_bindings b JOIN ${s}.sessions ss USING(session_id)
   WHERE b.session_id=OLD.session_id OR ss.root_session_id=OLD.session_id LOOP
  PERFORM ${s}.cms_request_package_fences(v_package); v_changed:=TRUE;
 END LOOP;
 IF v_changed THEN PERFORM ${s}.cms_agent_registry_bump(); END IF;
 RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS package_runtime_agent_configuration_change ON ${s}.sessions;
CREATE TRIGGER package_runtime_agent_configuration_change BEFORE UPDATE OF creation_config,root_session_id ON ${s}.sessions
FOR EACH ROW EXECUTE FUNCTION ${s}.cms_runtime_agent_configuration_change();
`;
}
