export function packageReviewRemediationMigration(schema: string): string {
    const s = `"${schema.replace(/"/g, '""')}"`;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_pin_agent_package_version(
    p_name TEXT, p_semver TEXT, p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT
) RETURNS VOID AS $$
DECLARE v_pkg ${s}.agent_packages; v_version_id TEXT; v_executable TEXT;
BEGIN
    PERFORM ${s}.cms_package_runtime_barrier();
    v_pkg := ${s}.cms_agent_package_authz(
        p_name,p_actor_provider,p_actor_subject,p_is_admin,
        p_sel_scope,p_sel_owner_provider,p_sel_owner_subject,TRUE);
    SELECT v.version_id,r.inspection->>'executable' INTO v_version_id,v_executable
      FROM ${s}.agent_package_versions v
      LEFT JOIN ${s}.agent_package_reviews r
        ON r.version_id=v.version_id AND r.package_id=v.package_id AND r.sha256=v.sha256
     WHERE v.package_id=v_pkg.package_id AND v.semver=p_semver;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_VERSION_NOT_FOUND: %@% is not a published version',p_name,p_semver;
    END IF;
    IF v_executable IS DISTINCT FROM 'false' THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_FORBIDDEN: executable or uninspected versions require administrator activation with exact content and revision';
    END IF;
    UPDATE ${s}.agent_packages SET active_version_id=v_version_id WHERE package_id=v_pkg.package_id;
    PERFORM ${s}.cms_agent_registry_bump();
END;
$$ LANGUAGE plpgsql;

-- Admission holds the runtime barrier. Its entire eligibility read chain must
-- remain nonlocking: writers can own tuples before entering mutation triggers.
CREATE OR REPLACE FUNCTION ${s}.cms_read_session_package_target(
    p_session_id TEXT,p_package_id TEXT,p_version_id TEXT,p_sha256 TEXT,p_agent_name TEXT
) RETURNS JSONB AS $$
DECLARE v_pkg ${s}.agent_packages; v_owner RECORD; v_version RECORD; v_root TEXT;
BEGIN
    SELECT COALESCE(root_session_id,session_id) INTO v_root FROM ${s}.sessions
     WHERE session_id=p_session_id AND deleted_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_NOT_FOUND: live session required'; END IF;
    SELECT * INTO v_pkg FROM ${s}.agent_packages WHERE package_id=p_package_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_NOT_FOUND: package deleted'; END IF;
    SELECT u.provider,u.subject INTO v_owner FROM ${s}.session_owners so JOIN ${s}.users u USING(user_id)
     WHERE so.session_id=v_root;
    IF NOT FOUND OR NOT v_pkg.enabled OR (v_pkg.scope='user' AND
       (v_pkg.owner_provider IS DISTINCT FROM v_owner.provider OR v_pkg.owner_subject IS DISTINCT FROM v_owner.subject)) THEN
        RAISE EXCEPTION 'AGENT_PACKAGE_REVIEW_FORBIDDEN: current session owner has no enabled package access';
    END IF;
    SELECT v.*,r.decision,r.inspection INTO v_version FROM ${s}.agent_package_versions v
     JOIN ${s}.agent_package_reviews r USING(version_id)
     WHERE v.version_id=p_version_id AND v.package_id=p_package_id AND v.sha256=p_sha256 AND r.sha256=p_sha256;
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
$$ LANGUAGE plpgsql STABLE;

-- Binding mutations retain their locks and share the same eligibility rules.
CREATE OR REPLACE FUNCTION ${s}.cms_assert_session_package_target(
    p_session_id TEXT,p_package_id TEXT,p_version_id TEXT,p_sha256 TEXT,p_agent_name TEXT
) RETURNS JSONB AS $$
DECLARE v_root TEXT;
BEGIN
    SELECT COALESCE(root_session_id,session_id) INTO v_root FROM ${s}.sessions
     WHERE session_id=p_session_id AND deleted_at IS NULL FOR UPDATE;
    PERFORM 1 FROM ${s}.agent_packages WHERE package_id=p_package_id FOR UPDATE;
    PERFORM 1 FROM ${s}.session_owners WHERE session_id=v_root FOR SHARE;
    PERFORM 1 FROM ${s}.agent_package_versions v JOIN ${s}.agent_package_reviews r USING(version_id)
     WHERE v.version_id=p_version_id AND v.package_id=p_package_id AND v.sha256=p_sha256 AND r.sha256=p_sha256
     FOR SHARE OF v,r;
    RETURN ${s}.cms_read_session_package_target(p_session_id,p_package_id,p_version_id,p_sha256,p_agent_name);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ${s}.cms_get_session_agent_package_binding(p_session_id TEXT)
RETURNS JSONB AS $$
DECLARE v_binding ${s}.session_agent_package_bindings; v_allowed BOOLEAN := TRUE;
BEGIN
    SELECT * INTO v_binding FROM ${s}.session_agent_package_bindings WHERE session_id=p_session_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    BEGIN
        IF ${s}.cms_read_session_package_target(p_session_id,v_binding.package_id,v_binding.version_id,
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
$$ LANGUAGE plpgsql STABLE;
`;
}
