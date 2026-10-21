export function packagePublisherStatusMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_get_agent_package_version_review(p_version TEXT)
RETURNS JSONB AS $$
SELECT jsonb_build_object('packageId',v.package_id,'versionId',v.version_id,'sha256',v.sha256,
 'decision',COALESCE(r.decision,'pending'),'executable',r.inspection->'executable' IS DISTINCT FROM 'false'::jsonb,
 'active',COALESCE(p.active_version_id=v.version_id,FALSE))
FROM ${s}.agent_package_versions v JOIN ${s}.agent_packages p USING(package_id)
LEFT JOIN ${s}.agent_package_reviews r ON r.version_id=v.version_id AND r.package_id=v.package_id AND r.sha256=v.sha256
WHERE v.version_id=p_version;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION ${s}.cms_get_agent_package_review_status(
 p_package TEXT,p_provider TEXT,p_subject TEXT,p_admin BOOLEAN
) RETURNS JSONB AS $$
DECLARE v_pkg ${s}.agent_packages; v_versions JSONB;
BEGIN
 IF NULLIF(BTRIM(p_provider),'') IS NULL OR NULLIF(BTRIM(p_subject),'') IS NULL THEN
  RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_FORBIDDEN: authenticated package manager required';
 END IF;
 SELECT p.* INTO v_pkg FROM ${s}.agent_packages p
 WHERE (p.package_id=p_package OR p.name=p_package) AND
 (p_admin IS TRUE OR (p.owner_provider=p_provider AND p.owner_subject=p_subject)
 OR ${s}.cms_agent_package_is_editor(p.package_id,p_provider,p_subject))
 ORDER BY (p.package_id=p_package) DESC,
 (p.owner_provider=p_provider AND p.owner_subject=p_subject) DESC,p.package_id LIMIT 1;
 IF NOT FOUND THEN RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_FORBIDDEN: package manager access required'; END IF;
 SELECT COALESCE(jsonb_agg(${s}.cms_get_agent_package_version_review(v.version_id) ||
  jsonb_build_object('semver',v.semver,'reasons',COALESCE(r.inspection->'reasons','[]'::jsonb))
  ORDER BY v.created_at DESC,v.version_id),'[]'::jsonb) INTO v_versions
 FROM ${s}.agent_package_versions v LEFT JOIN ${s}.agent_package_reviews r
 ON r.version_id=v.version_id AND r.package_id=v.package_id AND r.sha256=v.sha256
 WHERE v.package_id=v_pkg.package_id;
 RETURN jsonb_build_object('packageId',v_pkg.package_id,'name',v_pkg.name,
 'activeVersionId',v_pkg.active_version_id,'versions',v_versions);
END; $$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION ${s}.cms_pkg_declarative_root(p_session_id TEXT)
RETURNS BOOLEAN AS $$
DECLARE v_config JSONB; v_package_id TEXT; v_version ${s}.agent_package_versions; v_name TEXT;
BEGIN
 SELECT creation_config INTO v_config FROM ${s}.sessions WHERE session_id=p_session_id;
 v_package_id := v_config->>'boundAgentPackageId'; v_name := v_config->>'boundAgentName';
 IF v_package_id IS NULL OR v_name IS NULL OR v_name='' THEN RETURN FALSE; END IF;
 IF EXISTS(SELECT 1 FROM ${s}.session_agent_package_bindings b WHERE b.session_id=p_session_id
  AND NOT EXISTS(SELECT 1 FROM ${s}.agent_package_reviews r WHERE r.package_id=b.package_id
   AND r.version_id=b.version_id AND r.sha256=b.sha256 AND r.inspection->'executable'='false'::jsonb)) THEN RETURN FALSE; END IF;
 SELECT v.* INTO v_version FROM ${s}.agent_packages p
 JOIN ${s}.agent_package_versions v ON v.version_id=p.active_version_id AND v.package_id=p.package_id
 JOIN ${s}.agent_package_reviews r ON r.version_id=v.version_id AND r.package_id=v.package_id AND r.sha256=v.sha256
 WHERE p.package_id=v_package_id AND r.inspection->'executable'='false'::jsonb;
 IF NOT FOUND THEN RETURN FALSE; END IF;
 BEGIN
  RETURN ${s}.cms_read_session_package_target(p_session_id,v_package_id,v_version.version_id,v_version.sha256,v_name) IS NOT NULL;
 EXCEPTION WHEN raise_exception THEN RETURN FALSE;
 END;
END; $$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION ${s}.cms_get_session_agent_package_binding(p_session_id TEXT)
RETURNS JSONB AS $$
DECLARE v_binding ${s}.session_agent_package_bindings; v_allowed BOOLEAN := TRUE; v_executable BOOLEAN; v_review JSONB;
BEGIN
 SELECT * INTO v_binding FROM ${s}.session_agent_package_bindings WHERE session_id=p_session_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 v_review := ${s}.cms_get_agent_package_version_review(v_binding.version_id);
 v_executable := v_review->>'packageId' IS DISTINCT FROM v_binding.package_id
  OR v_review->>'sha256' IS DISTINCT FROM v_binding.sha256
  OR v_review->'executable' IS DISTINCT FROM 'false'::jsonb;
 BEGIN
  IF ${s}.cms_read_session_package_target(p_session_id,v_binding.package_id,v_binding.version_id,
   v_binding.sha256,v_binding.agent_name) IS DISTINCT FROM
   jsonb_build_object('provider',v_binding.owner_provider,'subject',v_binding.owner_subject) THEN
   v_allowed := FALSE;
  END IF;
 EXCEPTION WHEN raise_exception THEN v_allowed := FALSE;
 END;
 IF v_executable AND EXISTS(
  SELECT 1 FROM ${s}.agent_packages p
  JOIN ${s}.agent_package_versions v ON v.version_id=p.active_version_id AND v.package_id=p.package_id
  JOIN ${s}.agent_package_reviews r ON r.version_id=v.version_id AND r.package_id=v.package_id AND r.sha256=v.sha256
  WHERE p.package_id=v_binding.package_id AND r.inspection->'executable'='false'::jsonb
 ) THEN v_allowed := FALSE; END IF;
 RETURN jsonb_build_object('sessionId',v_binding.session_id,'packageId',v_binding.package_id,
 'versionId',v_binding.version_id,'sha256',v_binding.sha256,'agentName',v_binding.agent_name,
 'revision',v_binding.revision,'owner',jsonb_build_object('provider',v_binding.owner_provider,'subject',v_binding.owner_subject),
 'allowed',v_allowed,'executable',v_executable);
END; $$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION ${s}.cms_bind_new_session_agent_package(
 p_session_id TEXT,p_package_id TEXT,p_agent_name TEXT
) RETURNS VOID AS $$
DECLARE v_pkg ${s}.agent_packages; v_version ${s}.agent_package_versions;
 v_binding ${s}.session_agent_package_bindings; v_owner JSONB;
BEGIN
 PERFORM 1 FROM ${s}.sessions WHERE session_id=p_session_id FOR UPDATE;
 SELECT * INTO v_binding FROM ${s}.session_agent_package_bindings WHERE session_id=p_session_id FOR UPDATE;
 SELECT * INTO v_pkg FROM ${s}.agent_packages WHERE package_id=p_package_id FOR UPDATE;
 SELECT * INTO v_version FROM ${s}.agent_package_versions WHERE version_id=v_pkg.active_version_id;
 IF EXISTS(SELECT 1 FROM ${s}.agent_package_reviews r WHERE r.package_id=p_package_id
  AND r.version_id=v_version.version_id AND r.sha256=v_version.sha256
  AND r.inspection->'executable'='false'::jsonb) THEN RETURN; END IF;
 IF v_binding.session_id IS NOT NULL THEN
  IF v_binding.package_id IS DISTINCT FROM p_package_id OR v_binding.agent_name IS DISTINCT FROM p_agent_name THEN
   RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_CONFLICT: existing binding requires explicit rebind';
  END IF;
  RETURN;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM ${s}.sessions WHERE session_id=p_session_id AND package_binding_policy_version=1) THEN
  RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_CONFLICT: historical session requires explicit exact-content rebind';
 END IF;
 v_owner := ${s}.cms_assert_session_package_target(p_session_id,p_package_id,v_version.version_id,v_version.sha256,p_agent_name);
 INSERT INTO ${s}.session_agent_package_bindings
 (session_id,package_id,version_id,sha256,agent_name,owner_provider,owner_subject)
 VALUES(p_session_id,p_package_id,v_version.version_id,v_version.sha256,p_agent_name,v_owner->>'provider',v_owner->>'subject');
 INSERT INTO ${s}.session_agent_package_binding_audit
 (session_id,package_id,version_id,sha256,revision,actor_provider,actor_subject,reason)
 VALUES(p_session_id,p_package_id,v_version.version_id,v_version.sha256,1,v_owner->>'provider',v_owner->>'subject','initial binding');
END; $$ LANGUAGE plpgsql;

-- This new worker-only surface leaves the legacy active-only manifest intact.
CREATE OR REPLACE FUNCTION ${s}.cms_get_agent_packages_pinned_runtime_install_manifest()
RETURNS TABLE(
 package_id TEXT,name TEXT,scope TEXT,owner_provider TEXT,owner_subject TEXT,
 semver TEXT,sha256 TEXT,size_bytes BIGINT,artifact_filename TEXT,manifest JSONB,
 version_id TEXT,review_decision TEXT,review_revision BIGINT,active BOOLEAN
) AS $$
SELECT p.package_id,p.name,p.scope,p.owner_provider,p.owner_subject,
 v.semver,v.sha256,v.size_bytes,v.artifact_filename,v.manifest,v.version_id,r.decision,r.revision,
 COALESCE(v.version_id=p.active_version_id,FALSE)
FROM ${s}.agent_packages p JOIN ${s}.agent_package_versions v USING(package_id)
LEFT JOIN ${s}.agent_package_reviews r ON r.package_id=v.package_id AND r.version_id=v.version_id AND r.sha256=v.sha256
WHERE p.enabled AND (v.version_id=p.active_version_id OR
 (r.decision='approved' AND r.inspection->'executable' IS DISTINCT FROM 'false'::jsonb
  AND (EXISTS(SELECT 1 FROM ${s}.session_agent_package_bindings b WHERE b.package_id=p.package_id
   AND b.version_id=v.version_id AND b.sha256=v.sha256)
   OR EXISTS(SELECT 1 FROM ${s}.session_executable_package_grants g WHERE g.package_id=p.package_id
    AND g.version_id=v.version_id AND g.sha256=v.sha256 AND g.active))))
ORDER BY p.name,p.scope,p.owner_provider,p.owner_subject,(v.version_id=p.active_version_id) DESC,v.version_id;
$$ LANGUAGE sql STABLE;
`;
}
