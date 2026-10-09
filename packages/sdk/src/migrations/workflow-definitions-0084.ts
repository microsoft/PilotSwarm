/**
 * Immutable authored workflow definitions plus their normalized compiled form.
 *
 * The authored YAML is retained for audit, diagnostics, and future recompilation.
 * The normalized data-only manifest preserves the exact validated compiler
 * interpretation. Handler functions are never serialized; the manifest stores
 * only their registered identities.
 */
export function workflowDefinitionsMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
CREATE TABLE IF NOT EXISTS ${s}.registered_workflow_definitions (
    definition_id       TEXT PRIMARY KEY,
    graph_id             TEXT NOT NULL UNIQUE,
    name                 TEXT NOT NULL,
    version              TEXT NOT NULL,
    api_version          TEXT NOT NULL,
    compiler_version     TEXT NOT NULL,
    source_yaml          TEXT NOT NULL,
    source_sha256        TEXT NOT NULL,
    package_sha256       TEXT NOT NULL,
    package_artifact_filename TEXT NOT NULL,
    package_source_json  JSONB NOT NULL,
    compiled_sha256      TEXT NOT NULL,
    initial_state_id     TEXT NOT NULL,
    input_schema_json    JSONB NOT NULL,
    configuration_json   JSONB NOT NULL,
    compiled_manifest_json JSONB NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION ${s}.cms_register_workflow_definition(
    p_definition_id       TEXT,
    p_graph_id            TEXT,
    p_name                TEXT,
    p_version             TEXT,
    p_api_version         TEXT,
    p_compiler_version    TEXT,
    p_source_yaml         TEXT,
    p_source_sha256       TEXT,
    p_package_sha256      TEXT,
    p_package_artifact_filename TEXT,
    p_package_source_json JSONB,
    p_compiled_sha256     TEXT,
    p_initial_state_id    TEXT,
    p_input_schema_json   JSONB,
    p_configuration_json  JSONB,
    p_compiled_manifest_json JSONB
) RETURNS TEXT AS $$
DECLARE
    v_existing ${s}.registered_workflow_definitions%ROWTYPE;
BEGIN
    IF jsonb_typeof(p_compiled_manifest_json) IS DISTINCT FROM 'object'
        OR jsonb_typeof(p_compiled_manifest_json->'states') IS DISTINCT FROM 'array'
        OR jsonb_array_length(p_compiled_manifest_json->'states') = 0
    THEN
        RAISE EXCEPTION 'WORKFLOW_DEFINITION_INVALID: compiled manifest must contain non-empty states';
    END IF;
    IF p_package_sha256 !~ '^[0-9a-f]{64}$'
        OR p_compiled_manifest_json->>'packageSha256' IS DISTINCT FROM p_package_sha256
    THEN
        RAISE EXCEPTION 'WORKFLOW_DEFINITION_INVALID: compiled manifest must identify its package';
    END IF;
    IF COALESCE(p_package_artifact_filename, '') = ''
        OR p_package_artifact_filename IS DISTINCT FROM
            'workflow-package.' || p_package_sha256 || '.tar.gz'
        OR jsonb_typeof(p_package_source_json) IS DISTINCT FROM 'object'
        OR COALESCE(p_package_source_json->>'kind', '') = ''
        OR p_package_source_json->>'kind' NOT IN ('local-package', 'git')
    THEN
        RAISE EXCEPTION 'WORKFLOW_DEFINITION_INVALID: package artifact and source are required';
    END IF;
    IF p_package_source_json->>'kind' = 'git'
        AND (
            COALESCE(p_package_source_json->>'repositoryUrl', '') = ''
            OR COALESCE(p_package_source_json->>'gitRef', '') = ''
            OR COALESCE(p_package_source_json->>'workflowPath', '') = ''
            OR COALESCE(p_package_source_json->>'commitSha', '')
                !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
        )
    THEN
        RAISE EXCEPTION 'WORKFLOW_DEFINITION_INVALID: Git source provenance is incomplete';
    END IF;
    IF NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(p_compiled_manifest_json->'states') AS state
         WHERE state->>'id' = p_initial_state_id
    ) THEN
        RAISE EXCEPTION 'WORKFLOW_DEFINITION_INVALID: initial state % is missing', p_initial_state_id;
    END IF;
    IF EXISTS (
        SELECT 1
          FROM jsonb_array_elements(p_compiled_manifest_json->'states') AS state
         WHERE state->>'type' = 'agent'
           AND (
                COALESCE(state#>>'{transition,handler,module}', '') = ''
                OR COALESCE(state#>>'{transition,handler,export}', '') = ''
                OR COALESCE(state#>>'{transition,handler,moduleSha256}', '') !~ '^[0-9a-f]{64}$'
                OR state#>>'{transition,handler,packageSha256}'
                    IS DISTINCT FROM p_compiled_manifest_json->>'packageSha256'
           )
    ) THEN
        RAISE EXCEPTION 'WORKFLOW_DEFINITION_INVALID: agent transitions must identify package module exports';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_graph_id, 0));

    SELECT * INTO v_existing
      FROM ${s}.registered_workflow_definitions
     WHERE graph_id = p_graph_id
     FOR UPDATE;

    IF FOUND THEN
        IF v_existing.source_sha256 IS DISTINCT FROM p_source_sha256
            OR v_existing.package_sha256 IS DISTINCT FROM p_package_sha256
            OR v_existing.package_artifact_filename IS DISTINCT FROM p_package_artifact_filename
            OR v_existing.package_source_json IS DISTINCT FROM p_package_source_json
            OR v_existing.compiled_sha256 IS DISTINCT FROM p_compiled_sha256
            OR v_existing.compiler_version IS DISTINCT FROM p_compiler_version
        THEN
            RAISE EXCEPTION 'WORKFLOW_DEFINITION_CONFLICT: graph % is already registered with different content',
                p_graph_id;
        END IF;
        RETURN v_existing.definition_id;
    END IF;

    INSERT INTO ${s}.registered_workflow_definitions (
        definition_id, graph_id, name, version, api_version, compiler_version,
        source_yaml, source_sha256, package_sha256, package_artifact_filename,
        package_source_json, compiled_sha256, initial_state_id,
        input_schema_json, configuration_json, compiled_manifest_json
    ) VALUES (
        p_definition_id, p_graph_id, p_name, p_version, p_api_version,
        p_compiler_version, p_source_yaml, p_source_sha256, p_package_sha256,
        p_package_artifact_filename, p_package_source_json, p_compiled_sha256,
        p_initial_state_id, p_input_schema_json, p_configuration_json, p_compiled_manifest_json
    );
    RETURN p_definition_id;
END;
$$ LANGUAGE plpgsql;
`;
}
