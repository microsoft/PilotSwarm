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
        compiler_version: "v1alpha1-2",
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
            compilerVersion: "v1alpha1-2",
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
        compilerVersion: "v1alpha1-2",
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
    const client = Object.create(PilotSwarmManagementClient.prototype);
    client._started = true;
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

    await client.registerWorkflowDefinition(
        PACKAGE_WORKFLOW,
        { packageRoot: PACKAGE_ROOT },
    );

    const handler = persisted.manifest.states[0].transition.handler;
    assert.match(persisted.manifest.packageSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(
        { module: handler.module, export: handler.export },
        { module: "./transitions.mjs", export: "inspect" },
    );
    assert.match(handler.moduleSha256, /^[0-9a-f]{64}$/);
    assert.equal(handler.packageSha256, persisted.manifest.packageSha256);
});
