/**
 * Atomically publish a workflow's agent package metadata and persist the
 * immutable workflow definition. Artifact blobs are uploaded before this
 * function; PostgreSQL metadata becomes visible all-or-nothing.
 */
export function workflowAgentPackageRegistrationMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
CREATE OR REPLACE FUNCTION ${s}.cms_register_workflow_definition_with_agent_package(
    p_package_id TEXT,
    p_version_id TEXT,
    p_package JSONB,
    p_definition JSONB
) RETURNS TABLE(
    definition_id TEXT,
    package_status TEXT,
    package_id TEXT,
    version_id TEXT
) AS $$
DECLARE
    v_published RECORD;
    v_definition_id TEXT;
    v_manifest JSONB := p_definition->'manifest';
BEGIN
    SELECT * INTO v_published
      FROM ${s}.cms_publish_agent_package(
        p_package_id,
        p_version_id,
        p_package->>'name',
        p_package->>'scope',
        p_package#>>'{owner,provider}',
        p_package#>>'{owner,subject}',
        p_package->>'sourceId',
        p_package->>'semver',
        p_package->>'sha256',
        (p_package->>'sizeBytes')::BIGINT,
        p_package->>'artifactFilename',
        p_package->>'commitSha',
        COALESCE(p_package->'manifest', '{}'::JSONB),
        p_package->>'createdBy',
        COALESCE((p_package->>'isAdmin')::BOOLEAN, FALSE)
      );

    IF v_published.package_id IS DISTINCT FROM p_package_id THEN
        RAISE EXCEPTION
            'WORKFLOW_AGENT_PACKAGE_RETRY: package "%" was concurrently created as %',
            p_package->>'name',
            v_published.package_id;
    END IF;

    IF EXISTS (
        SELECT 1
          FROM jsonb_array_elements(v_manifest->'states') AS state
         WHERE state->>'type' = 'agent'
           AND state->>'agentPackageId' IS DISTINCT FROM v_published.package_id
    ) THEN
        RAISE EXCEPTION
            'WORKFLOW_AGENT_PACKAGE_MISMATCH: compiled states do not reference package %',
            v_published.package_id;
    END IF;

    v_definition_id := ${s}.cms_register_workflow_definition(
        p_definition->>'definitionId',
        v_manifest->>'graphId',
        v_manifest#>>'{metadata,name}',
        v_manifest#>>'{metadata,version}',
        v_manifest->>'apiVersion',
        v_manifest->>'compilerVersion',
        p_definition->>'sourceYaml',
        p_definition->>'sourceSha256',
        p_definition->>'packageSha256',
        p_definition->>'packageArtifactFilename',
        p_definition->'packageSource',
        p_definition->>'compiledSha256',
        v_manifest->>'initialState',
        v_manifest->'inputSchema',
        v_manifest->'configuration',
        v_manifest
    );

    RETURN QUERY SELECT
        v_definition_id,
        v_published.status::TEXT,
        v_published.package_id::TEXT,
        v_published.version_id::TEXT;
END;
$$ LANGUAGE plpgsql;
`;
}
