import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { SPAWN_WORKFLOW_MILESTONE_TOOL_SPEC, SPAWN_WORKFLOW_TOOL_SPEC } from "../../dist/workflow/tool-spec.js";
import {
    READ_WORKFLOW_MILESTONE_TOOL_SPEC, READ_WORKFLOW_TOOL_SPEC, UPDATE_WORKFLOW_MILESTONE_OPERATIONS, UPDATE_WORKFLOW_MILESTONE_TOOL_SPEC,
    UPDATE_WORKFLOW_TOOL_SPEC, updateWorkflowFromTool,
} from "../../dist/workflow/v2/tools.js";

/**
 * The workflow tools on a turn of a worker that runs controller 1.9.0 (R26,
 * T125; INACTIVE: only tests register one): their descriptions and
 * parameters name what their host takes, the handler takes exactly those
 * operations behind the same gate, and every other turn's tools are as
 * before.
 */

const PRODUCTION_OPERATIONS = ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel", "recover"];
const MILESTONE_OPERATIONS = ["stop", "test", "test_respond", "test_advance"];

test("every other turn keeps the production tool descriptions and parameters", () => {
    assert.deepEqual([...UPDATE_WORKFLOW_TOOL_SPEC.parameters.properties.operation.enum], PRODUCTION_OPERATIONS);
    for (const name of ["grace_seconds", "agent_mode", "fixtures", "scenario", "interception_id", "response", "seconds"]) {
        assert.equal(Object.hasOwn(UPDATE_WORKFLOW_TOOL_SPEC.parameters.properties, name), false, name);
    }
    for (const operation of MILESTONE_OPERATIONS) assert.ok(!UPDATE_WORKFLOW_TOOL_SPEC.description.includes(`${operation} (`), operation);
    assert.ok(SPAWN_WORKFLOW_TOOL_SPEC.description.includes("mode request is not supported yet"));
    assert.ok(!READ_WORKFLOW_TOOL_SPEC.description.includes("run.test"));
});

test("on a 1.9.0 turn the descriptions and parameters add the milestone operations, states and fields", () => {
    assert.deepEqual([...UPDATE_WORKFLOW_MILESTONE_OPERATIONS], MILESTONE_OPERATIONS);
    const update = UPDATE_WORKFLOW_MILESTONE_TOOL_SPEC;
    assert.deepEqual([...update.parameters.properties.operation.enum], [...PRODUCTION_OPERATIONS, ...MILESTONE_OPERATIONS]);
    assert.ok(update.description.startsWith(UPDATE_WORKFLOW_TOOL_SPEC.description));
    for (const name of Object.keys(UPDATE_WORKFLOW_TOOL_SPEC.parameters.properties)) assert.ok(Object.hasOwn(update.parameters.properties, name), name);
    for (const name of ["grace_seconds", "agent_mode", "fixtures", "scenario", "interception_id", "response", "seconds"]) {
        assert.ok(Object.hasOwn(update.parameters.properties, name), name);
        assert.ok(update.description.includes(name), `the description names ${name}`);
    }
    assert.deepEqual(update.parameters.required, UPDATE_WORKFLOW_TOOL_SPEC.parameters.required);
    assert.ok(READ_WORKFLOW_MILESTONE_TOOL_SPEC.description.startsWith(READ_WORKFLOW_TOOL_SPEC.description));
    for (const field of ["run.test", "agent.childSessionId", "publishedAgentPins", "graceSeconds"]) {
        assert.ok(READ_WORKFLOW_MILESTONE_TOOL_SPEC.description.includes(field), field);
    }
    assert.equal(READ_WORKFLOW_MILESTONE_TOOL_SPEC.parameters, READ_WORKFLOW_TOOL_SPEC.parameters);
    const spawn = SPAWN_WORKFLOW_MILESTONE_TOOL_SPEC.description;
    assert.ok(!spawn.includes("not supported yet"));
    for (const phrase of ["mode: request", "respond_session_request", "invoke:", "complete_workflow_node", "forEach:", "all_required", "${branch.item}"]) {
        assert.ok(spawn.includes(phrase), phrase);
    }
    assert.equal(SPAWN_WORKFLOW_MILESTONE_TOOL_SPEC.parameters, SPAWN_WORKFLOW_TOOL_SPEC.parameters);
});

/** A host whose workflow child "wf" belongs to the caller "parent"; nothing past authorization is reached. */
function hostOf(requests) {
    return {
        catalog: { getSession: async id => (id === "wf" ? { sessionKind: "workflow", parentSessionId: "parent", deletedAt: null } : null) },
        store: { readDefinition: async id => (id === "wf" ? { parentSessionId: "parent" } : null) },
        duroxideClient: {},
        ...(requests ? { requests: true } : {}),
    };
}

const call = async (requests, args) => JSON.parse(await updateWorkflowFromTool({ workflow_id: "wf", operation_id: "op-1", ...args },
    { callerSessionId: "parent", host: hostOf(requests) }));

test("the handler takes the milestone operations behind the same gate as the description, and reads each added argument", async () => {
    // Elsewhere: refused as unknown operations, and the refusal names the production operations only.
    for (const operation of MILESTONE_OPERATIONS) {
        const refused = await call(false, { operation });
        assert.equal(refused.ok, false, operation);
        assert.equal(refused.error.code, "WORKFLOW_COMMAND_INVALID", operation);
        assert.match(refused.error.message, /^operation must be replace_definition, .* or recover\.$/, operation);
    }
    // On a 1.9.0 host each one is taken: its own arguments are read and checked.
    const cases = [
        [{ operation: "stop", grace_seconds: -1 }, /^grace_seconds must be an integer from 0 to 3600\.$/],
        [{ operation: "test", agent_mode: "live" }, /^agent_mode must be mocked or real\.$/],
        [{ operation: "test", scenario: "x".repeat(129) }, /^scenario must be a name of at most 128 characters\.$/],
        [{ operation: "test", expected_revision: 1, definition_hash: "h", inputs: {}, fixtures: 5 }, /^fixtures must be a list\.$/],
        [{ operation: "test_respond", run_id: "run-1" }, /^interception_id is required\.$/],
        [{ operation: "test_advance", run_id: "run-1", seconds: 0 }, /^seconds must be an integer from 1 to 2592000\.$/],
    ];
    for (const [args, message] of cases) {
        const refused = await call(true, args);
        assert.equal(refused.ok, false, JSON.stringify(args));
        assert.equal(refused.error.code, "WORKFLOW_COMMAND_INVALID", JSON.stringify(args));
        assert.match(refused.error.message, message, JSON.stringify(args));
    }
    const response = await call(true, { operation: "test_respond", run_id: "run-1", interception_id: "nx-1/agent", response: { kind: "maybe" } });
    assert.equal(response.error.code, "TEST_RESPONSE_INVALID");
    // An unknown operation's refusal names every operation this host takes.
    const unknown = await call(true, { operation: "teleport" });
    assert.equal(unknown.error.code, "WORKFLOW_COMMAND_INVALID");
    for (const operation of [...PRODUCTION_OPERATIONS, ...MILESTONE_OPERATIONS]) assert.ok(unknown.error.message.includes(operation), operation);
});

test("the milestone operations keep the production authorization: only the agent that created the workflow uses them", async () => {
    const as = async (callerSessionId, workflowId, args) => JSON.parse(await updateWorkflowFromTool({ workflow_id: workflowId, operation_id: "op-1", ...args },
        { callerSessionId, host: hostOf(true) }));
    // Each with arguments that parse, so only authorization can refuse it; pause is a production operation, for comparison.
    const valid = {
        pause: { operation: "pause" },
        stop: { operation: "stop", grace_seconds: 30 },
        test: { operation: "test", expected_revision: 1, definition_hash: "h", inputs: {} },
        test_respond: { operation: "test_respond", run_id: "run-1", interception_id: "nx-1/agent", response: { kind: "cancel" } },
        test_advance: { operation: "test_advance", run_id: "run-1", seconds: 60 },
    };
    for (const [operation, args] of Object.entries(valid)) {
        const other = await as("someone-else", "wf", args);
        assert.deepEqual([other.ok, other.error.code], [false, "FORBIDDEN"], operation);
        assert.equal(other.error.message, "Only the agent that created this workflow may change or read it with this tool.", operation);
        const missing = await as("parent", "nope", args);
        assert.deepEqual([missing.ok, missing.error.code], [false, "WORKFLOW_NOT_FOUND"], operation);
    }
});

test("the reference skill's update_workflow table names exactly the operations a 1.9.0 host takes", () => {
    const text = fs.readFileSync(new URL("../../plugins/workflow-v2/skills/workflow-reference/SKILL.md", import.meta.url), "utf8");
    const table = text.slice(text.indexOf("| Operation | Arguments | Effect |"), text.indexOf("`read_workflow`:"));
    const named = table.split("\n").slice(2).filter(line => line.startsWith("| `"))
        .flatMap(line => line.split("|")[1].split(",").map(cell => cell.trim().replace(/`/g, "")));
    assert.deepEqual(named.sort(), [...UPDATE_WORKFLOW_MILESTONE_TOOL_SPEC.parameters.properties.operation.enum].sort());
});
