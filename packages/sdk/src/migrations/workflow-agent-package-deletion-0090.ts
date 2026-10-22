/**
 * Preserve agent packages for the full lifetime of every admitted workflow
 * that references them. Admission and deletion share an advisory lock so a
 * concurrent delete cannot slip between package validation and reservation.
 */
export function workflowAgentPackageDeletionGuardMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_guard_workflow_admission_agent_packages()
RETURNS TRIGGER AS $$
DECLARE
    v_package_id TEXT;
BEGIN
    FOR v_package_id IN
        SELECT DISTINCT manifest_state.state_json->>'agentPackageId'
          FROM ${s}.workflow_definitions definition
          CROSS JOIN LATERAL jsonb_array_elements(
              definition.compiled_manifest_json->'states'
          ) AS manifest_state(state_json)
         WHERE definition.definition_id = NEW.definition_id
           AND manifest_state.state_json->>'type' = 'agent'
           AND COALESCE(
               manifest_state.state_json->>'agentPackageId',
               ''
           ) <> ''
         ORDER BY manifest_state.state_json->>'agentPackageId'
    LOOP
        PERFORM pg_advisory_xact_lock(
            hashtextextended('workflow-agent-package:' || v_package_id, 0)
        );
        IF NOT EXISTS (
            SELECT 1
              FROM ${s}.agent_packages package
             WHERE package.package_id = v_package_id
               AND package.enabled
        ) THEN
            RAISE EXCEPTION
                'WORKFLOW_AGENT_PACKAGE_UNAVAILABLE: package % is unavailable',
                v_package_id;
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workflow_admission_agent_package_guard
    ON ${s}.workflow_admissions;
CREATE TRIGGER workflow_admission_agent_package_guard
BEFORE INSERT OR UPDATE OF definition_id
ON ${s}.workflow_admissions
FOR EACH ROW
EXECUTE FUNCTION ${s}.cms_guard_workflow_admission_agent_packages();

CREATE OR REPLACE FUNCTION ${s}.cms_delete_agent_package(
    p_name TEXT, p_actor_provider TEXT, p_actor_subject TEXT, p_is_admin BOOLEAN,
    p_sel_scope TEXT, p_sel_owner_provider TEXT, p_sel_owner_subject TEXT
) RETURNS TABLE(artifact_filename TEXT) AS $$
DECLARE
    v_pkg ${s}.agent_packages;
    v_filenames TEXT[];
BEGIN
    v_pkg := ${s}.cms_agent_package_authz(
        p_name, p_actor_provider, p_actor_subject, p_is_admin,
        p_sel_scope, p_sel_owner_provider, p_sel_owner_subject);

    PERFORM pg_advisory_xact_lock(
        hashtextextended('workflow-agent-package:' || v_pkg.package_id, 0)
    );

    IF EXISTS (
        SELECT 1
          FROM ${s}.workflow_admissions admission
          JOIN ${s}.workflow_definitions definition
            ON definition.definition_id = admission.definition_id
          LEFT JOIN ${s}.sessions session
            ON session.session_id = admission.session_id
          CROSS JOIN LATERAL jsonb_array_elements(
              definition.compiled_manifest_json->'states'
          ) AS manifest_state(state_json)
         WHERE manifest_state.state_json->>'type' = 'agent'
           AND manifest_state.state_json->>'agentPackageId' = v_pkg.package_id
           AND (
                session.session_id IS NULL
                OR session.state NOT IN ('completed', 'failed', 'error', 'cancelled')
           )
    ) THEN
        RAISE EXCEPTION
            'AGENT_PACKAGE_WORKFLOW_IN_USE: package % is referenced by an active workflow',
            v_pkg.package_id;
    END IF;

    SELECT array_agg(DISTINCT version.artifact_filename) INTO v_filenames
      FROM ${s}.agent_package_versions version
     WHERE version.package_id = v_pkg.package_id;

    DELETE FROM ${s}.agent_packages
     WHERE package_id = v_pkg.package_id;
    PERFORM ${s}.cms_agent_registry_bump();

    RETURN QUERY
        SELECT filename
          FROM unnest(COALESCE(v_filenames, ARRAY[]::TEXT[])) AS filename
         WHERE NOT EXISTS (
             SELECT 1
               FROM ${s}.agent_package_versions surviving
              WHERE surviving.artifact_filename = filename
         );
END;
$$ LANGUAGE plpgsql;
`;
}
