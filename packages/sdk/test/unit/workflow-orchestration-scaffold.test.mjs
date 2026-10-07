import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
    WORKFLOW_SESSION_LATEST_VERSION,
    WORKFLOW_SESSION_ORCHESTRATION_NAME,
    WORKFLOW_SESSION_ORCHESTRATION_REGISTRY,
} from "../../dist/workflow-orchestration-registry.js";
import {
    durableWorkflowSessionOrchestration_1_0_0,
} from "../../dist/workflow-orchestration/index.js";

const sourceHash = name => {
    const source = readFileSync(
        new URL(`../../src/workflow-orchestration_1_0_0/${name}`, import.meta.url),
        "utf8",
    ).replace(/\r\n/g, "\n");
    return createHash("sha256").update(source).digest("hex");
};

const frozenWorkflowSources = {
    "contracts.ts": "66d8080c16c1e1359554ab083bc208ed0b9d03b702b801e8fe97117aebb94758",
    "agent-dispatch.ts": "b1fe44570c85872887caa8ddf63c5329982823760abdccc7fcdd9dfff1d854f2",
    "index.ts": "a67874d2c890e4ff0188989335db5957bb8d9509a4010bb9a5f144758c6f695f",
};

for (const [name, hash] of Object.entries(frozenWorkflowSources)) {
    test(`frozen workflow 1.0.0 ${name} remains unchanged`, () => {
        assert.equal(sourceHash(name), hash);
    });
}

test("workflow orchestration has an independent durable name and version registry", () => {
    assert.equal(WORKFLOW_SESSION_ORCHESTRATION_NAME, "workflow-session-v1");
    assert.equal(WORKFLOW_SESSION_LATEST_VERSION, "1.0.0");
    assert.deepEqual(
        WORKFLOW_SESSION_ORCHESTRATION_REGISTRY.map(({ version }) => version),
        ["1.0.0"],
    );
});

test("workflow orchestration registry points to the initial controller", () => {
    const [{ handler }] = WORKFLOW_SESSION_ORCHESTRATION_REGISTRY;
    assert.equal(handler, durableWorkflowSessionOrchestration_1_0_0);
});
