/**
 * Workflow v2: a person's workflow command, inactive (workflow/v2/human-commands.ts;
 * design 04 updateWorkflow, design 03 human-input denial; R13, R26), over a
 * fake host that records what it is asked.
 *
 * - The HTTP status of each refusal code.
 * - An agent actor, a command that is not an object, a workflow_id naming
 *   another session and recover are refused before anything is read; a
 *   session that is not a version 2 workflow is WORKFLOW_NOT_FOUND.
 * - A workflow in an agent state's subtree refuses everything but a person's
 *   brakes (403 WORKFLOW_HUMAN_INPUT_DENIED with its details); a brake is not
 *   checked against the lineage and reaches the tool's own command parsing,
 *   as every command of a workflow outside such a subtree does.
 * - The workflow support a server advertises in its bootstrap (design 04,
 *   D11): what the host was configured with, a person's commands off by
 *   default with the refusal each then gets, the controller version and
 *   operations when they are on, and the legacy create's version 1 semantics;
 *   the management client answers from its own configuration and catalog.
 *
 * Run: node --test test/unit/workflow-v2-human-commands.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    updateWorkflowForPerson, workflowCapabilities, workflowCommandStatus, WORKFLOW_CAPABILITIES_SCHEMA, WORKFLOW_HUMAN_BRAKE_OPERATIONS,
    WORKFLOW_HUMAN_MILESTONE_OPERATIONS, WORKFLOW_HUMAN_OPERATIONS,
} from "../../dist/workflow/v2/human-commands.js";
import { WORKFLOW_HUMAN_INPUT_DENIED } from "../../dist/workflow/v2/input-policy.js";
import { WORKFLOW_V2_API_VERSION } from "../../dist/workflow/v2/compiler.js";
import { WORKFLOW_V2_CONTROLLER_VERSION, WORKFLOW_V2_REQUEST_CONTROLLER_VERSION } from "../../dist/workflow/v2/runtime.js";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";

const PERSON = { kind: "user", provider: "test", subject: "alice" };
const ROOT = { childSessionId: "C", nodeExecutionId: "nx-1", workflowSessionId: "W1", controllingSessionId: "P", distance: 1 };

/** A host whose sessions W (a workflow outside any agent state) and N (a workflow in one) exist; S is not a workflow. */
function hostOf() {
    const reads = [];
    const rows = { W: { sessionKind: "workflow", deletedAt: null }, N: { sessionKind: "workflow", deletedAt: null }, S: { sessionKind: "agent", deletedAt: null },
        D: { sessionKind: "workflow", deletedAt: new Date() } };
    return {
        reads,
        host: {
            catalog: { getSession: async id => { reads.push(["session", id]); return rows[id] ?? null; } },
            store: {
                readDefinition: async id => { reads.push(["definition", id]); return rows[id]?.sessionKind === "workflow" ? { parentSessionId: "P" } : null; },
                readWorkflowLineage: async id => { reads.push(["lineage", id]); return { sessionId: id, level: id === "N" ? 3 : 1, agentRoot: id === "N" ? ROOT : null }; },
            },
            duroxideClient: {},
        },
    };
}

async function rejectsWith(promise, code) {
    await assert.rejects(promise, error => { assert.equal(error.code, code, error.message); return true; });
}

test("maps each refusal code to its HTTP status", () => {
    for (const [code, status] of [["WORKFLOW_NOT_FOUND", 404], ["RUN_NOT_FOUND", 404], ["INTERCEPTION_NOT_FOUND", 404], ["WORKFLOW_DELETED", 404],
        ["FORBIDDEN", 403], [WORKFLOW_HUMAN_INPUT_DENIED, 403], ["WORKFLOW_COMMAND_INVALID", 400], ["WORKFLOW_YAML_INVALID", 400],
        ["WORKFLOW_INPUT_INVALID", 422], ["TEST_RESPONSE_INVALID", 422], ["DEFINITION_INVALID", 422], ["OPERATION_LIMIT", 429],
        ["TEST_INTERCEPTION_LIMIT", 429], ["WORKFLOW_STORE_CORRUPT", 500], ["REVISION_CONFLICT", 409], ["OPERATION_CONFLICT", 409],
        ["RUN_ENDED", 409], ["CONTROLLER_UNAVAILABLE", 409]]) {
        assert.equal(workflowCommandStatus(code), status, code);
    }
});

test("refuses an agent actor, a command that is not an object, another workflow_id and recover before reading anything", async () => {
    const { host, reads } = hostOf();
    const run = (command, actor = PERSON, workflowSessionId = "W") => updateWorkflowForPerson(command, { host, workflowSessionId, actor });
    await rejectsWith(run({ operation: "pause", operation_id: "o" }, { kind: "agent", sessionId: "P" }), "FORBIDDEN");
    for (const command of [null, [], "pause", 7]) await rejectsWith(run(command), "WORKFLOW_COMMAND_INVALID");
    await rejectsWith(run({ workflow_id: "X", operation: "pause", operation_id: "o" }), "WORKFLOW_COMMAND_INVALID");
    await rejectsWith(run({ operation: "recover", operation_id: "o" }), "WORKFLOW_COMMAND_INVALID");
    assert.deepEqual(reads, []);
    for (const id of ["S", "D", "missing"]) await rejectsWith(run({ operation: "pause", operation_id: "o" }, PERSON, id), "WORKFLOW_NOT_FOUND");
});

test("lets a person only brake a workflow in an agent state's subtree", async () => {
    assert.deepEqual([...WORKFLOW_HUMAN_BRAKE_OPERATIONS], ["pause", "stop", "cancel"]);
    const { host, reads } = hostOf();
    for (const operation of ["set_vars", "resume", "publish", "start", "replace_definition", "test", "test_respond", "test_advance", "bogus", undefined]) {
        await assert.rejects(updateWorkflowForPerson({ operation, operation_id: "o" }, { host, workflowSessionId: "N", actor: PERSON }), error => {
            assert.equal(error.code, WORKFLOW_HUMAN_INPUT_DENIED, String(operation));
            assert.equal(error.status, 403);
            assert.deepEqual(error.details, { sessionId: "N", action: "workflow", workflowSessionId: "W1", nodeExecutionId: "nx-1", controllingSessionId: "P" });
            assert.match(error.message, /change its definition, inputs, runs or tests/);
            return true;
        });
    }
    // A brake is not checked against the lineage: it reaches the tool's own parsing (here: no operation id, refused there).
    reads.length = 0;
    for (const operation of ["pause", "cancel"]) {
        await assert.rejects(updateWorkflowForPerson({ operation }, { host, workflowSessionId: "N", actor: PERSON }),
            error => error.code === "WORKFLOW_COMMAND_INVALID" && /operation_id is required/.test(error.message));
    }
    assert.equal(reads.some(([kind]) => kind === "lineage"), false);
    // Outside such a subtree every command reaches the tool's own parsing.
    await assert.rejects(updateWorkflowForPerson({ operation: "set_vars", operation_id: "o" }, { host, workflowSessionId: "W", actor: PERSON }),
        error => error.code === "WORKFLOW_COMMAND_INVALID" && /set_vars needs set or delete/.test(error.message));
});

test("advertises the workflow support the host was configured with: a person's commands off by default, with the refusal each gets", () => {
    const off = workflowCapabilities({ read: true, commands: null });
    assert.deepEqual(off, {
        schema: WORKFLOW_CAPABILITIES_SCHEMA,
        v2: {
            apiVersion: WORKFLOW_V2_API_VERSION, read: true, create: false, input: false,
            commands: { available: false, refusal: { code: "WORKFLOW_COMMANDS_UNAVAILABLE", status: 501 } },
        },
        legacyCreate: { workflowVersion: 1, draft: false },
    });
    assert.equal(off.v2.apiVersion, "pilotswarm.dev/v2-draft");
    assert.deepEqual(workflowCapabilities({ read: true, commands: undefined }), off);
    // Without a workflow store, reads are not advertised.
    assert.equal(workflowCapabilities({ read: false, commands: null }).v2.read, false);
    // On: the production controller and the operations every host takes; the 1.9.0 host's adds stop and the test operations.
    assert.deepEqual(workflowCapabilities({ read: true, commands: {} }).v2.commands,
        { available: true, controllerVersion: WORKFLOW_V2_CONTROLLER_VERSION, operations: [...WORKFLOW_HUMAN_OPERATIONS] });
    assert.deepEqual(workflowCapabilities({ read: true, commands: { requests: false } }).v2.commands.controllerVersion, "1.8.0");
    const milestone = workflowCapabilities({ read: true, commands: { requests: true } }).v2.commands;
    assert.deepEqual(milestone, { available: true, controllerVersion: WORKFLOW_V2_REQUEST_CONTROLLER_VERSION,
        operations: [...WORKFLOW_HUMAN_OPERATIONS, ...WORKFLOW_HUMAN_MILESTONE_OPERATIONS] });
    assert.equal(milestone.controllerVersion, "1.9.0");
    // recover stays the agent's: never advertised to a person.
    assert.ok(!milestone.operations.includes("recover"));
    // Each answer is a fresh value: a client that changes it changes nothing here.
    milestone.operations.push("recover");
    assert.ok(!workflowCapabilities({ read: true, commands: { requests: true } }).v2.commands.operations.includes("recover"));
});

test("the management client answers from its own configuration and catalog, before and after it starts", async () => {
    const as = fields => Object.assign(Object.create(PilotSwarmManagementClient.prototype), fields);
    // Not started (no catalog): no reads; a person's commands as configured.
    assert.deepEqual(await as({ config: {}, _catalog: null }).getWorkflowCapabilities(), workflowCapabilities({ read: false, commands: null }));
    // A catalog with a workflow store, and the production default (no workflowCommands): reads on, commands off.
    const store = { workflowStore: () => ({}) };
    assert.deepEqual(await as({ config: {}, _catalog: store }).getWorkflowCapabilities(), workflowCapabilities({ read: true, commands: null }));
    // A catalog without one (no version 2 workflows here): reads off.
    assert.equal((await as({ config: {}, _catalog: {} }).getWorkflowCapabilities()).v2.read, false);
    // The test-only option, as the portal or MCP host would be created with it.
    assert.deepEqual((await as({ config: { workflowCommands: { requests: true } }, _catalog: store }).getWorkflowCapabilities()).v2.commands,
        workflowCapabilities({ read: true, commands: { requests: true } }).v2.commands);
    assert.equal((await as({ config: { workflowCommands: {} }, _catalog: store }).getWorkflowCapabilities()).v2.commands.controllerVersion, "1.8.0");
    // A real client, constructed as a deployment constructs it: commands off.
    const client = new PilotSwarmManagementClient({ store: "postgres://capabilities.invalid/none" });
    assert.equal((await client.getWorkflowCapabilities()).v2.commands.available, false);
});
