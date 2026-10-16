import test from "node:test";
import assert from "node:assert/strict";
import {
    resolveWorkflowPrimaryKey,
    validateWorkflowInputs,
    workflowCanonicalJsonSha256,
} from "../../dist/workflow-orchestration/admission.js";

const manifest = {
    inputSchema: {
        repository: { type: "string", required: true },
        changeId: { type: "integer", required: true },
        dryRun: { type: "boolean", required: false },
    },
    identity: {
        primaryKey: ["inputs.repository", "inputs.changeId"],
    },
};

test("validates declared inputs and derives a stable composite primary key", () => {
    const inputs = {
        repository: "microsoft/PilotSwarm",
        changeId: 28,
        dryRun: false,
    };
    validateWorkflowInputs(manifest, inputs);
    const primaryKey = resolveWorkflowPrimaryKey(manifest, inputs);

    assert.deepEqual(primaryKey.values, ["microsoft/PilotSwarm", 28]);
    assert.equal(
        primaryKey.sha256,
        workflowCanonicalJsonSha256(["microsoft/PilotSwarm", 28]),
    );
});

test("rejects missing and incorrectly typed workflow inputs before admission", () => {
    assert.throws(
        () => validateWorkflowInputs(manifest, {
            repository: "microsoft/PilotSwarm",
        }),
        error => error?.code === "WORKFLOW_INPUT_REQUIRED",
    );
    assert.throws(
        () => validateWorkflowInputs(manifest, {
            repository: "microsoft/PilotSwarm",
            changeId: "28",
        }),
        error => error?.code === "WORKFLOW_INPUT_INVALID",
    );
});

test("canonical request identities do not depend on object key order", () => {
    assert.equal(
        workflowCanonicalJsonSha256({ definitionId: "d", inputs: { b: 2, a: 1 } }),
        workflowCanonicalJsonSha256({ inputs: { a: 1, b: 2 }, definitionId: "d" }),
    );
});

test("rejects workflow inputs that are not JSON-compatible plain data", () => {
    const objectManifest = {
        inputSchema: {
            metadata: { type: "object", required: true },
        },
    };
    assert.throws(
        () => validateWorkflowInputs(objectManifest, {
            metadata: new Date("2026-10-07T20:00:00.000Z"),
        }),
        error => error?.code === "WORKFLOW_INPUT_INVALID",
    );
    assert.throws(
        () => validateWorkflowInputs(objectManifest, {
            metadata: { omitted: undefined },
        }),
        error => error?.code === "WORKFLOW_INPUT_INVALID",
    );
    const circular = {};
    circular.self = circular;
    assert.throws(
        () => validateWorkflowInputs(objectManifest, {
            metadata: circular,
        }),
        error => error?.code === "WORKFLOW_INPUT_INVALID",
    );
});
