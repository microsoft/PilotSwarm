import test from "node:test";
import assert from "node:assert/strict";
import { ManagedSession } from "../../dist/managed-session.js";
import { orchestrationSupportsWorkflowTools, parseSpawnWorkflowToolArgs } from "../../dist/workflow-tools.js";

test("spawn_workflow is declared for ordinary agent sessions", () => {
    const definitions = ManagedSession.subAgentToolDefs();
    const tool = definitions.find(candidate => candidate.name === "spawn_workflow");
    assert.ok(tool);
    assert.deepEqual(tool.parameters.required, ["definition"]);
    assert.deepEqual(tool.parameters.properties.definition.properties.kind.enum, ["registered"]);
    assert.deepEqual(tool.parameters.properties.definition.required, ["kind", "definition_id"]);
    assert.ok(definitions.some(candidate => candidate.name === "check_workflows"));
    assert.ok(definitions.some(candidate => candidate.name === "wait_for_workflows"));
});

test("spawn_workflow can be withheld from older orchestration versions", () => {
    const names = ManagedSession.subAgentToolDefs({ workflowTools: false }).map(tool => tool.name);
    assert.equal(names.includes("spawn_workflow"), false);
    assert.equal(names.includes("spawn_agent"), true);
});

test("spawn_workflow normalizes registered definitions and inputs", () => {
    assert.deepEqual(parseSpawnWorkflowToolArgs({
        definition: {
            kind: "registered",
            definition_id: " definition-1 ",
        },
        inputs: { target: "staging" },
    }), {
        ok: true,
        definition: {
            kind: "registered",
            definitionId: "definition-1",
        },
        inputs: { target: "staging" },
    });
});

test("spawn_workflow requires a registered definition ID", () => {
    assert.deepEqual(parseSpawnWorkflowToolArgs({
        definition: { kind: "registered", definition_id: " " },
    }), {
        ok: false,
        error: "definition_id is required when definition.kind is registered.",
    });
});

test("spawn_workflow is gated to orchestration 1.0.81 and later", () => {
    assert.equal(orchestrationSupportsWorkflowTools("1.0.80"), false);
    assert.equal(orchestrationSupportsWorkflowTools("1.0.81"), true);
    assert.equal(orchestrationSupportsWorkflowTools("1.1.0"), true);
    assert.equal(orchestrationSupportsWorkflowTools(undefined), true);
});
