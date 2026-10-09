import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
    compileWorkflowPackageSnapshotYaml,
    materializeWorkflowPackageSnapshot,
} from "../../dist/workflow-orchestration/package-loader.js";
import {
    CmsWorkflowDefinitionProvider,
} from "../../dist/workflow-orchestration/definition-provider.js";
import {
    workflowCompiledManifestSha256,
} from "../../dist/workflow-orchestration/compiler.js";

const PACKAGE_ROOT = fileURLToPath(
    new URL("../fixtures/workflow-package/", import.meta.url),
);

const WORKFLOW_YAML = `
apiVersion: pilotswarm.dev/v1alpha1
kind: Workflow
metadata:
  name: provider-example
  version: 0.1.0
initial: inspect
states:
  inspect:
    type: agent
    agent: sample-inspector
    input: {}
    result:
      schema: sample/inspection/v1
    completion:
      mode: one-shot
      outcomes:
        - succeeded
        - blocked
    transition:
      handler:
        module: ./transitions.mjs
        export: inspect
  approve:
    type: question
    prompt: Publish?
    completion:
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

async function providerHarness({ artifactBody, transformRecord } = {}) {
    const snapshot = await materializeWorkflowPackageSnapshot(PACKAGE_ROOT);
    const compiled = await compileWorkflowPackageSnapshotYaml(WORKFLOW_YAML, snapshot);
    const definitionId = "definition-provider";
    const record = {
        definitionId,
        graphId: compiled.manifest.graphId,
        name: compiled.manifest.metadata.name,
        version: compiled.manifest.metadata.version,
        apiVersion: compiled.manifest.apiVersion,
        compilerVersion: compiled.manifest.compilerVersion,
        sourceYaml: WORKFLOW_YAML,
        sourceSha256: "a".repeat(64),
        packageSha256: snapshot.packageSha256,
        packageArtifactFilename: `workflow-package.${snapshot.packageSha256}.tar.gz`,
        packageSource: { kind: "local-package" },
        compiledSha256: workflowCompiledManifestSha256(compiled.manifest),
        initialStateId: compiled.manifest.initialState,
        inputSchema: compiled.manifest.inputSchema,
        configuration: compiled.manifest.configuration,
        compiledManifest: compiled.manifest,
        createdAt: new Date(),
    };
    const downloads = [];
    const provider = new CmsWorkflowDefinitionProvider(
        {
            async getWorkflowDefinition(requestedId) {
                return requestedId === definitionId
                    ? transformRecord?.(record) ?? record
                    : null;
            },
        },
        {
            async downloadArtifact(sessionId, filename) {
                downloads.push({ sessionId, filename });
                return {
                    filename,
                    contentType: "application/gzip",
                    sizeBytes: (artifactBody ?? snapshot.artifactTarGz).length,
                    body: artifactBody ?? snapshot.artifactTarGz,
                };
            },
        },
    );
    return { provider, compiled, definitionId, downloads };
}

test("loads a persisted compiled plan and executes its pinned transition", async () => {
    const { provider, compiled, definitionId, downloads } = await providerHarness();
    const resolved = await provider.resolve({ kind: "registered", definitionId });

    assert.equal(resolved.definitionId, definitionId);
    assert.deepEqual(resolved.manifest, compiled.manifest);
    assert.equal(downloads.length, 1);

    const directive = await provider.executeTransition({
        definitionId,
        stateId: "inspect",
        context: {
            workflowInputs: {},
            currentStateId: "inspect",
            stateOutcome: "succeeded",
            stateOutput: { approved: true },
            latestStateOutputs: {
                inspect: { outcome: "succeeded", output: { approved: true } },
            },
            executionHistory: [{
                stateId: "inspect",
                executionSequence: 1,
                outcome: "succeeded",
                output: { approved: true },
            }],
        },
    });

    assert.deepEqual(directive, { kind: "advance", target: "publish" });

    const questionDirective = await provider.executeTransition({
        definitionId,
        stateId: "approve",
        context: {
            workflowInputs: {},
            currentStateId: "approve",
            stateOutcome: "succeeded",
            stateOutput: { approved: true },
            latestStateOutputs: {
                approve: { outcome: "succeeded", output: { approved: true } },
            },
            executionHistory: [{
                stateId: "approve",
                executionSequence: 2,
                outcome: "succeeded",
                output: { approved: true },
            }],
        },
    });

    assert.deepEqual(questionDirective, { kind: "advance", target: "publish" });
    assert.equal(downloads.length, 1, "the verified package snapshot is cached by hash");
});

test("rejects a workflow artifact that does not match the registered package", async () => {
    const { provider, definitionId } = await providerHarness({
        artifactBody: Buffer.from("not a package"),
    });
    await assert.rejects(
        () => provider.resolve({ kind: "registered", definitionId }),
        error => error?.code === "WORKFLOW_PACKAGE_ARTIFACT_INVALID",
    );
});

test("rejects a persisted manifest that does not match its registered digest", async () => {
    const { provider, definitionId } = await providerHarness({
        transformRecord: record => ({
            ...record,
            compiledManifest: {
                ...record.compiledManifest,
                configuration: { tampered: true },
            },
        }),
    });

    await assert.rejects(
        () => provider.resolve({ kind: "registered", definitionId }),
        error => error?.code === "WORKFLOW_COMPILED_MANIFEST_HASH_MISMATCH",
    );
});
