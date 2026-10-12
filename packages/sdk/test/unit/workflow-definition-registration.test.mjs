import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { agentPackageTarSha256 } from "../../dist/agent-package-format.js";
import { PgSessionCatalog } from "../../dist/cms.js";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";

const PACKAGE_ROOT = fileURLToPath(
    new URL("../fixtures/workflow-package/", import.meta.url),
);

const TERMINAL_WORKFLOW = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata:
  name: registered-example
  version: 0.1.0
initial: done
states:
  done:
    type: terminal
    outcome: succeeded
    output:
      registered: true
`;

const PACKAGE_WORKFLOW = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata:
  name: registered-package
  version: 0.1.0
initial: inspect
states:
  inspect:
    type: agent
    agent: package-inspector
    input: {}
    result:
      schema: package/inspection/v1
    completion:
      mode: one-shot
      outcomes:
        - succeeded
        - blocked
    transition:
      handler:
        module: ./transitions.mjs
        export: inspect
  publish:
    type: terminal
    outcome: succeeded
  needs-attention:
    type: terminal
    outcome: blocked
`;

function definitionRow() {
    return {
        definition_id: "definition-1",
        graph_id: "registered-example@0.1.0",
        name: "registered-example",
        version: "0.1.0",
        api_version: "pilotswarm.dev/v1alpha1",
        compiler_version: "v1alpha1-4",
        source_yaml: TERMINAL_WORKFLOW,
        source_sha256: "source-hash",
        package_sha256: "a".repeat(64),
        package_artifact_filename: `workflow-package.${"a".repeat(64)}.tar.gz`,
        package_source_json: { kind: "local-package" },
        compiled_sha256: "compiled-hash",
        initial_state_id: "done",
        input_schema_json: {},
        configuration_json: {},
        compiled_manifest_json: {
            compilerVersion: "v1alpha1-4",
            apiVersion: "pilotswarm.dev/v1alpha1",
            kind: "Workflow",
            graphId: "registered-example@0.1.0",
            packageSha256: "a".repeat(64),
            metadata: { name: "registered-example", version: "0.1.0" },
            inputSchema: {},
            configuration: {},
            initialState: "done",
            states: [{
                id: "done",
                type: "terminal",
                outcome: "succeeded",
                summary: "Workflow 'registered-example' completed with outcome 'succeeded'.",
                hasOutput: true,
                output: { registered: true },
            }],
        },
        created_at: "2026-10-07T23:30:00.000Z",
    };
}

function createCatalogHarness() {
    const calls = [];
    const pool = {
        async query(sql, params) {
            calls.push({ sql, params });
            if (sql.includes("cms_register_workflow_definition")) {
                return { rows: [{ definition_id: "definition-1" }] };
            }
            if (sql.includes("cms_admit_workflow")) {
                return {
                    rows: [{
                        session_id: "workflow-1",
                        definition_id: "definition-1",
                        primary_key_json: ["change-42"],
                        primary_key_sha256: "c".repeat(64),
                        attempt: "1",
                        inputs_json: { changeId: "change-42" },
                        parent_session_id: null,
                        owner_provider: "entra",
                        owner_subject: "user-1",
                        owner_email: "user@example.test",
                        owner_display_name: "User One",
                        group_id: null,
                        visibility: "private",
                        rerun_reason: null,
                        orchestration_id: "session-workflow-1",
                        created: true,
                        deduplicated: false,
                        needs_start: true,
                    }],
                };
            }
            if (sql.includes("workflow_definitions WHERE")) {
                return { rows: [definitionRow()] };
            }
            return { rows: [] };
        },
    };
    return {
        catalog: new PgSessionCatalog(pool, "workflow_test"),
        calls,
    };
}

test("catalog persists authored YAML and the normalized compiled manifest", async () => {
    const { catalog, calls } = createCatalogHarness();
    const manifest = {
        compilerVersion: "v1alpha1-4",
        apiVersion: "pilotswarm.dev/v1alpha1",
        kind: "Workflow",
        graphId: "registered-example@0.1.0",
        packageSha256: "a".repeat(64),
        metadata: { name: "registered-example", version: "0.1.0" },
        inputSchema: {},
        configuration: {},
        initialState: "done",
        states: [{
            id: "done",
            type: "terminal",
            outcome: "succeeded",
            summary: "Workflow 'registered-example' completed with outcome 'succeeded'.",
            hasOutput: true,
            output: { registered: true },
        }],
    };

    const registered = await catalog.registerWorkflowDefinition({
        definitionId: "definition-new",
        sourceYaml: TERMINAL_WORKFLOW,
        sourceSha256: "source-hash",
        packageSha256: "a".repeat(64),
        packageArtifactFilename: `workflow-package.${"a".repeat(64)}.tar.gz`,
        packageSource: { kind: "local-package" },
        compiledSha256: "compiled-hash",
        manifest,
    });

    assert.match(calls[0].sql, /cms_register_workflow_definition/);
    assert.equal(calls[0].params[1], "registered-example@0.1.0");
    assert.equal(calls[0].params[6], TERMINAL_WORKFLOW);
    assert.equal(calls[0].params[8], "a".repeat(64));
    assert.equal(calls[0].params[9], `workflow-package.${"a".repeat(64)}.tar.gz`);
    assert.equal(calls[0].params[10], JSON.stringify({ kind: "local-package" }));
    assert.equal(calls[0].params[15], JSON.stringify(manifest));
    assert.equal(registered.definitionId, "definition-1");
    assert.equal(registered.graphId, "registered-example@0.1.0");
    assert.equal(registered.packageSha256, "a".repeat(64));
    assert.deepEqual(registered.compiledManifest, manifest);
});

test("catalog admits and marks a workflow start through migration procedures", async () => {
    const { catalog, calls } = createCatalogHarness();
    const admitted = await catalog.admitWorkflow({
        sessionId: "workflow-1",
        definitionId: "definition-1",
        inputs: { changeId: "change-42" },
        primaryKeyValues: ["change-42"],
        primaryKeySha256: "c".repeat(64),
        owner: {
            provider: "entra",
            subject: "user-1",
            email: "user@example.test",
            displayName: "User One",
        },
        visibility: "private",
        idempotencyKey: "request-1",
        requestSha256: "d".repeat(64),
        forceRerun: false,
        isAdmin: false,
    });
    await catalog.markWorkflowAdmissionStarted(
        admitted.sessionId,
        admitted.orchestrationId,
    );

    assert.deepEqual(admitted, {
        sessionId: "workflow-1",
        definitionId: "definition-1",
        primaryKeyValues: ["change-42"],
        primaryKeySha256: "c".repeat(64),
        attempt: 1,
        inputs: { changeId: "change-42" },
        parentSessionId: null,
        owner: {
            provider: "entra",
            subject: "user-1",
            email: "user@example.test",
            displayName: "User One",
        },
        groupId: null,
        visibility: "private",
        rerunReason: null,
        orchestrationId: "session-workflow-1",
        created: true,
        deduplicated: false,
        needsStart: true,
    });
    assert.ok(calls.some(call => call.sql.includes("cms_admit_workflow")));
    assert.ok(calls.some(call => call.sql.includes("cms_mark_workflow_admission_started")));
});

test("management registration invokes the compiler before persistence", async () => {
    let persisted;
    let uploadedPackageSha256;
    const client = Object.create(PilotSwarmManagementClient.prototype);
    client._started = true;
    client._artifactStore = {
        async uploadArtifact(sessionId, filename, content, contentType, options) {
            assert.match(sessionId, /^[0-9a-f-]{36}$/);
            assert.match(filename, /^workflow-package\.[a-f0-9]{64}\.tar\.gz$/);
            assert.ok(Buffer.isBuffer(content));
            assert.equal(contentType, "application/gzip");
            assert.equal(options.pinned, true);
            uploadedPackageSha256 = agentPackageTarSha256(content);
            return { filename };
        },
    };
    client._catalog = {
        async registerWorkflowDefinition(input) {
            persisted = input;
            return {
                definitionId: input.definitionId,
                graphId: input.manifest.graphId,
            };
        },
    };

    const result = await client.registerWorkflowDefinition(
        TERMINAL_WORKFLOW,
        { packageRoot: PACKAGE_ROOT },
    );

    assert.equal(result.graphId, "registered-example@0.1.0");
    assert.equal(persisted.sourceYaml, TERMINAL_WORKFLOW);
    assert.match(persisted.definitionId, /^[0-9a-f-]{36}$/);
    assert.match(persisted.sourceSha256, /^[0-9a-f]{64}$/);
    assert.equal(persisted.packageSha256, persisted.manifest.packageSha256);
    assert.equal(uploadedPackageSha256, persisted.packageSha256);
    assert.match(persisted.packageArtifactFilename, /^workflow-package\.[a-f0-9]{64}\.tar\.gz$/);
    assert.deepEqual(persisted.packageSource, { kind: "local-package" });
    assert.match(persisted.compiledSha256, /^[0-9a-f]{64}$/);
    assert.match(persisted.manifest.packageSha256, /^[0-9a-f]{64}$/);
    assert.equal(persisted.manifest.states[0].id, "done");
    assert.equal(persisted.manifest.states[0].type, "terminal");
});

test("management registration persists package and module transition identities", async () => {
    let persisted;
    let atomicRegistration;
    const uploadedArtifacts = [];
    const client = Object.create(PilotSwarmManagementClient.prototype);
    client._started = true;
    client._artifactStore = {
        async uploadArtifact(sessionId, filename) {
            uploadedArtifacts.push({ sessionId, filename });
            return { filename };
        },
    };
    client._catalog = {
        async getAgentPackage() {
            return null;
        },
        async registerWorkflowDefinitionWithAgentPackage(input) {
            atomicRegistration = input;
            persisted = input.definition;
            return {
                definitionId: input.definition.definitionId,
                graphId: input.definition.manifest.graphId,
            };
        },
    };

    await client.registerWorkflowDefinition(
        PACKAGE_WORKFLOW,
        { packageRoot: PACKAGE_ROOT },
    );

    const handler = persisted.manifest.states[0].transition.handler;
    assert.equal(atomicRegistration.package.scope, "shared");
    assert.equal(atomicRegistration.package.owner, null);
    assert.equal(atomicRegistration.package.createdBy, "workflow-definition-registration");
    assert.equal(atomicRegistration.packageId, persisted.manifest.states[0].agentPackageId);
    assert.equal(
        persisted.manifest.states[0].agentPackageId,
        atomicRegistration.packageId,
    );
    assert.equal(uploadedArtifacts.length, 2);
    assert.ok(uploadedArtifacts.some(({ filename }) => filename.startsWith("workflow-package.")));
    assert.ok(uploadedArtifacts.some(({ filename }) => filename.includes("workflow-package-fixture")));
    assert.match(persisted.manifest.packageSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(
        { module: handler.module, export: handler.export },
        { module: "./transitions.mjs", export: "inspect" },
    );
    assert.match(handler.moduleSha256, /^[0-9a-f]{64}$/);
    assert.equal(handler.packageSha256, persisted.manifest.packageSha256);
});

test("management registration retries a concurrent logical-package creation without partial publication", async () => {
    const packageIds = [];
    let lookup = 0;
    let atomicCalls = 0;
    const client = Object.create(PilotSwarmManagementClient.prototype);
    client._started = true;
    client._artifactStore = {
        async uploadArtifact(_sessionId, filename) {
            return { filename };
        },
        async deleteArtifact() {
            assert.fail("a converged retry must retain the uploaded artifact");
        },
    };
    client._catalog = {
        async getAgentPackage() {
            lookup++;
            return lookup === 1
                ? null
                : {
                    packageId: "package-winner",
                    versions: [],
                };
        },
        async registerWorkflowDefinitionWithAgentPackage(input) {
            atomicCalls++;
            packageIds.push(input.definition.manifest.states[0].agentPackageId);
            if (atomicCalls === 1) {
                throw new Error(
                    "WORKFLOW_AGENT_PACKAGE_RETRY: package was concurrently created",
                );
            }
            return {
                definitionId: input.definition.definitionId,
                graphId: input.definition.manifest.graphId,
            };
        },
    };

    const result = await client.registerWorkflowDefinition(
        PACKAGE_WORKFLOW,
        { packageRoot: PACKAGE_ROOT },
    );

    assert.equal(result.graphId, "registered-package@0.1.0");
    assert.equal(atomicCalls, 2);
    assert.notEqual(packageIds[0], "package-winner");
    assert.equal(packageIds[1], "package-winner");
});

test("management registration leaves only content-addressed bytes after atomic metadata failure", async () => {
    let publishedSeparately = false;
    const client = Object.create(PilotSwarmManagementClient.prototype);
    client._started = true;
    client._artifactStore = {
        async uploadArtifact(_sessionId, filename) {
            return { filename };
        },
        async deleteArtifact() {
            assert.fail("rollback must not race another publisher with compensating blob deletion");
        },
    };
    client._catalog = {
        async getAgentPackage() {
            return null;
        },
        async registerWorkflowDefinitionWithAgentPackage() {
            throw new Error(
                "WORKFLOW_DEFINITION_CONFLICT: graph is already registered with different content",
            );
        },
        async publishAgentPackage() {
            publishedSeparately = true;
        },
    };

    await assert.rejects(
        () => client.registerWorkflowDefinition(
            PACKAGE_WORKFLOW,
            { packageRoot: PACKAGE_ROOT },
        ),
        /WORKFLOW_DEFINITION_CONFLICT/,
    );
    assert.equal(publishedSeparately, false);
});

test("management registration rejects workflow agents absent from the package", async () => {
    const client = Object.create(PilotSwarmManagementClient.prototype);
    client._started = true;
    client._artifactStore = {
        async uploadArtifact() {
            assert.fail("registration should fail before workflow artifact upload");
        },
    };
    client._catalog = {};
    client.publishAgentPackageDirectory = async () => {
        assert.fail("registration should fail before agent package publication");
    };

    await assert.rejects(
        () => client.registerWorkflowDefinition(
            PACKAGE_WORKFLOW.replace("package-inspector", "missing-agent"),
            { packageRoot: PACKAGE_ROOT },
        ),
        error => error?.code === "WORKFLOW_AGENT_NOT_DECLARED",
    );
});

test("management registration uses a deployment workflow package resolver", async () => {
    const source = {
        kind: "git",
        repositoryUrl: "https://example.test/private/repository",
        gitRef: "refs/heads/main",
        workflowPath: "workflow.yaml",
    };
    let resolvedSource;
    let cleaned = false;
    let persisted;
    const client = Object.create(PilotSwarmManagementClient.prototype);
    client._started = true;
    client.config = {
        workflowPackageResolver: {
            async resolve(input) {
                resolvedSource = input;
                return {
                    checkoutRoot: PACKAGE_ROOT,
                    packageRoot: PACKAGE_ROOT,
                    workflowYaml: TERMINAL_WORKFLOW,
                    source: {
                        ...input,
                        commitSha: "a".repeat(40),
                    },
                    async cleanup() {
                        cleaned = true;
                    },
                };
            },
        },
    };
    client._artifactStore = {
        async uploadArtifact(_sessionId, filename) {
            return { filename };
        },
    };
    client._catalog = {
        async registerWorkflowDefinition(input) {
            persisted = input;
            return {
                definitionId: input.definitionId,
                graphId: input.manifest.graphId,
            };
        },
    };

    const result = await client.registerWorkflowDefinition({ source });

    assert.deepEqual(resolvedSource, source);
    assert.equal(result.graphId, "registered-example@0.1.0");
    assert.equal(persisted.packageSource.commitSha, "a".repeat(40));
    assert.equal(cleaned, true);
});

test("management registration cleans up a resolved package after registration fails", async () => {
    const source = {
        kind: "git",
        repositoryUrl: "https://example.test/private/repository",
        gitRef: "refs/heads/main",
        workflowPath: "workflow.yaml",
    };
    let cleaned = false;
    const client = Object.create(PilotSwarmManagementClient.prototype);
    client._started = true;
    client.config = {
        workflowPackageResolver: {
            async resolve(input) {
                return {
                    checkoutRoot: PACKAGE_ROOT,
                    packageRoot: PACKAGE_ROOT,
                    workflowYaml: TERMINAL_WORKFLOW,
                    source: {
                        ...input,
                        commitSha: "a".repeat(40),
                    },
                    async cleanup() {
                        cleaned = true;
                    },
                };
            },
        },
    };
    client._artifactStore = {
        async uploadArtifact() {
            throw Object.assign(new Error("upload failed"), {
                code: "TEST_UPLOAD_FAILED",
            });
        },
    };
    client._catalog = {
        async registerWorkflowDefinition() {
            assert.fail("registration should not follow a failed upload");
        },
    };

    await assert.rejects(
        () => client.registerWorkflowDefinition({ source }),
        error => error?.code === "TEST_UPLOAD_FAILED",
    );
    assert.equal(cleaned, true);
});
