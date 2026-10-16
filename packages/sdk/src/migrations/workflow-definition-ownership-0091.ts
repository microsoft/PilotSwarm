/**
 * Add user/shared ownership to immutable workflow definitions and extend the
 * atomic bundled-agent publication path to preserve that ownership.
 */
export function workflowDefinitionOwnershipMigration(schema: string): string {
    const s = `"${schema}"`;
    return `
ALTER TABLE ${s}.workflow_definitions
    ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'shared',
    ADD COLUMN IF NOT EXISTS owner_provider TEXT,
    ADD COLUMN IF NOT EXISTS owner_subject TEXT,
    ADD COLUMN IF NOT EXISTS created_by TEXT;

ALTER TABLE ${s}.workflow_definitions
    DROP CONSTRAINT IF EXISTS workflow_definitions_scope_check,
    ADD CONSTRAINT workflow_definitions_scope_check
        CHECK (scope IN ('shared', 'user'));

ALTER TABLE ${s}.workflow_definitions
    DROP CONSTRAINT IF EXISTS workflow_definitions_owner_check,
    ADD CONSTRAINT workflow_definitions_owner_check
        CHECK (
            scope = 'shared'
            OR (owner_provider IS NOT NULL AND owner_subject IS NOT NULL)
        );

ALTER TABLE ${s}.workflow_definitions
    DROP CONSTRAINT IF EXISTS workflow_definitions_graph_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS workflow_definitions_shared_graph_uq
    ON ${s}.workflow_definitions (graph_id)
    WHERE scope = 'shared';

CREATE UNIQUE INDEX IF NOT EXISTS workflow_definitions_user_graph_uq
    ON ${s}.workflow_definitions (owner_provider, owner_subject, graph_id)
    WHERE scope = 'user';

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
    p_compiled_manifest_json JSONB,
    p_scope               TEXT,
    p_owner_provider      TEXT,
    p_owner_subject       TEXT,
    p_created_by          TEXT,
    p_is_admin            BOOLEAN
) RETURNS TEXT AS $$
DECLARE
    v_existing ${s}.workflow_definitions%ROWTYPE;
    v_owner_provider TEXT := NULLIF(BTRIM(p_owner_provider), '');
    v_owner_subject TEXT := NULLIF(BTRIM(p_owner_subject), '');
    v_package_id TEXT;
    v_package ${s}.agent_packages%ROWTYPE;
BEGIN
    IF p_scope NOT IN ('shared', 'user') THEN
        RAISE EXCEPTION 'WORKFLOW_DEFINITION_BAD_SCOPE: scope must be shared or user, got "%"', p_scope;
    END IF;
    IF NOT p_is_admin AND (v_owner_provider IS NULL OR v_owner_subject IS NULL) THEN
        RAISE EXCEPTION 'WORKFLOW_DEFINITION_FORBIDDEN: registration requires an owner identity';
    END IF;
    IF p_scope = 'user' AND (v_owner_provider IS NULL OR v_owner_subject IS NULL) THEN
        RAISE EXCEPTION 'WORKFLOW_DEFINITION_FORBIDDEN: user workflows require an owner identity';
    END IF;
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

    FOR v_package_id IN
        SELECT DISTINCT state->>'agentPackageId'
          FROM jsonb_array_elements(p_compiled_manifest_json->'states') AS state
         WHERE state->>'type' = 'agent'
           AND COALESCE(state->>'agentPackageId', '') <> ''
         ORDER BY state->>'agentPackageId'
    LOOP
        PERFORM pg_advisory_xact_lock(
            hashtextextended('workflow-agent-package:' || v_package_id, 0)
        );

        SELECT * INTO v_package
          FROM ${s}.agent_packages package
         WHERE package.package_id = v_package_id
           AND package.enabled;
        IF NOT FOUND THEN
            RAISE EXCEPTION
                'WORKFLOW_AGENT_PACKAGE_UNAVAILABLE: package % is unavailable',
                v_package_id;
        END IF;

        IF p_scope = 'shared' AND v_package.scope <> 'shared' THEN
            RAISE EXCEPTION
                'WORKFLOW_AGENT_PACKAGE_SCOPE_INVALID: shared workflows may reference only shared packages';
        END IF;
        IF p_scope = 'user'
            AND v_package.scope = 'user'
            AND (
                v_package.owner_provider IS DISTINCT FROM v_owner_provider
                OR v_package.owner_subject IS DISTINCT FROM v_owner_subject
            )
        THEN
            RAISE EXCEPTION
                'WORKFLOW_AGENT_PACKAGE_SCOPE_INVALID: user workflows may reference only their owner''s user packages or shared packages';
        END IF;
    END LOOP;

    PERFORM pg_advisory_xact_lock(hashtextextended(
        p_scope || E'\\n'
        || COALESCE(v_owner_provider, '') || E'\\n'
        || COALESCE(v_owner_subject, '') || E'\\n'
        || p_graph_id,
        0
    ));

    SELECT * INTO v_existing
      FROM ${s}.workflow_definitions definition
     WHERE definition.graph_id = p_graph_id
       AND definition.scope = p_scope
       AND (
            p_scope = 'shared'
            OR (
                definition.owner_provider IS NOT DISTINCT FROM v_owner_provider
                AND definition.owner_subject IS NOT DISTINCT FROM v_owner_subject
            )
       )
     FOR UPDATE;

    IF FOUND THEN
        IF NOT p_is_admin AND (
            v_existing.owner_provider IS DISTINCT FROM v_owner_provider
            OR v_existing.owner_subject IS DISTINCT FROM v_owner_subject
        ) THEN
            RAISE EXCEPTION 'WORKFLOW_DEFINITION_FORBIDDEN: only the workflow creator or an admin may publish "%" ', p_graph_id;
        END IF;
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

    INSERT INTO ${s}.workflow_definitions (
        definition_id, graph_id, name, version, api_version, compiler_version,
        source_yaml, source_sha256, package_sha256, package_artifact_filename,
        package_source_json, compiled_sha256, initial_state_id,
        input_schema_json, configuration_json, compiled_manifest_json,
        scope, owner_provider, owner_subject, created_by
    ) VALUES (
        p_definition_id, p_graph_id, p_name, p_version, p_api_version,
        p_compiler_version, p_source_yaml, p_source_sha256, p_package_sha256,
        p_package_artifact_filename, p_package_source_json, p_compiled_sha256,
        p_initial_state_id, p_input_schema_json, p_configuration_json,
        p_compiled_manifest_json, p_scope, v_owner_provider, v_owner_subject,
        p_created_by
    );
    RETURN p_definition_id;
END;
$$ LANGUAGE plpgsql;

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
    SELECT ${s}.cms_register_workflow_definition(
        p_definition_id, p_graph_id, p_name, p_version, p_api_version,
        p_compiler_version, p_source_yaml, p_source_sha256, p_package_sha256,
        p_package_artifact_filename, p_package_source_json, p_compiled_sha256,
        p_initial_state_id, p_input_schema_json, p_configuration_json,
        p_compiled_manifest_json, 'shared', NULL, NULL, NULL, TRUE
    );
$$ LANGUAGE sql;

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
    v_definition_scope TEXT := COALESCE(
        NULLIF(BTRIM(p_definition->>'scope'), ''),
        'shared'
    );
    v_definition_owner_provider TEXT := NULLIF(
        BTRIM(p_definition#>>'{owner,provider}'),
        ''
    );
    v_definition_owner_subject TEXT := NULLIF(
        BTRIM(p_definition#>>'{owner,subject}'),
        ''
    );
    v_definition_is_admin BOOLEAN := COALESCE(
        (p_definition->>'isAdmin')::BOOLEAN,
        TRUE
    );
    v_lock_package_id TEXT;
BEGIN
    IF p_package->>'scope' IS DISTINCT FROM v_definition_scope
        OR NULLIF(BTRIM(p_package#>>'{owner,provider}'), '')
            IS DISTINCT FROM v_definition_owner_provider
        OR NULLIF(BTRIM(p_package#>>'{owner,subject}'), '')
            IS DISTINCT FROM v_definition_owner_subject
    THEN
        RAISE EXCEPTION 'WORKFLOW_AGENT_PACKAGE_OWNERSHIP_MISMATCH: bundled package ownership must match the workflow definition';
    END IF;

    FOR v_lock_package_id IN
        SELECT DISTINCT state->>'agentPackageId'
          FROM jsonb_array_elements(v_manifest->'states') AS state
         WHERE state->>'type' = 'agent'
           AND COALESCE(state->>'agentPackageId', '') <> ''
         ORDER BY state->>'agentPackageId'
    LOOP
        PERFORM pg_advisory_xact_lock(
            hashtextextended(
                'workflow-agent-package:' || v_lock_package_id,
                0
            )
        );
    END LOOP;

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
           AND COALESCE(state->>'agentPackageId', '') = ''
    ) OR NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(v_manifest->'states') AS state
         WHERE state->>'type' = 'agent'
           AND state->>'agentPackageId' = v_published.package_id
    ) THEN
        RAISE EXCEPTION
            'WORKFLOW_AGENT_PACKAGE_MISMATCH: compiled bundled states do not reference package %',
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
        v_manifest,
        v_definition_scope,
        v_definition_owner_provider,
        v_definition_owner_subject,
        p_definition->>'createdBy',
        v_definition_is_admin
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
