/**
 * Workflow: a person's workflow command (workflow/human-commands.ts;
 * design 04 updateWorkflow, design 03 human-input denial; R13, R26), over a
 * fake host that records what it is asked.
 *
 * - The HTTP status of each refusal code.
 * - An agent actor, a command that is not an object, a workflow_id naming
 *   another session and recover are refused before anything is read; a
 *   session that is not a Workflow is WORKFLOW_NOT_FOUND.
 * - A workflow in an agent state's subtree refuses everything but a person's
 *   brakes (403 WORKFLOW_HUMAN_INPUT_DENIED with its details); a brake is not
 *   checked against the lineage and reaches the tool's own command parsing,
 *   as every command of a workflow outside such a subtree does.
 * - The workflow support a server advertises in its bootstrap (design 04,
 *   D11): what the host was configured with, a person's commands off by
 *   default with the refusal each then gets, the controller version and
 *   operations when they are on; the management client answers from its own configuration and catalog.
 *
 * Run: node --test test/unit/workflow-human-commands.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    parsePersonWorkflowInput, personSenderId, updateWorkflowForPerson, workflowCapabilities, workflowCommandStatus, WORKFLOW_CAPABILITIES_SCHEMA, WORKFLOW_HUMAN_BRAKE_OPERATIONS,
    WORKFLOW_HUMAN_MILESTONE_OPERATIONS, WORKFLOW_HUMAN_OPERATIONS,
} from "../../dist/workflow/human-commands.js";
import {
    WORKFLOW_DEFINITION_MCP_TOOLS, WORKFLOW_DEFINITION_TOOLS, WORKFLOW_HUMAN_INPUT_DENIED,
    workflowDefinitionMcpPermission, workflowDefinitionMcpToolFilters,
} from "../../dist/workflow/input-policy.js";
import { WORKFLOW_API_VERSION } from "../../dist/workflow/compiler.js";
import { WORKFLOW_CONTROLLER_VERSION } from "../../dist/workflow/runtime.js";
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
        ["FORBIDDEN", 403], [WORKFLOW_HUMAN_INPUT_DENIED, 403], ["WORKFLOW_COMMAND_INVALID", 400], ["WORKFLOW_YAML_INVALID", 400], ["INPUT_INVALID", 400],
        ["WORKFLOW_INPUT_INVALID", 422], ["TEST_RESPONSE_INVALID", 422], ["DEFINITION_INVALID", 422], ["OPERATION_LIMIT", 429],
        ["TEST_INTERCEPTION_LIMIT", 429], ["INBOX_FULL", 429], ["INBOX_RATE_LIMITED", 429], ["WORKFLOW_STORE_CORRUPT", 500],
        ["REVISION_CONFLICT", 409], ["OPERATION_CONFLICT", 409], ["UNSUPPORTED_CONTRACT", 409],
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
        enabled: true,
        decision: { available: false, defaultModel: null, models: [], reason: "no_cluster_decision_default" },
        apiVersion: WORKFLOW_API_VERSION, read: true, validate: true, skills: true, card: true, create: false, input: false,
        commands: { available: false, refusal: { code: "WORKFLOW_COMMANDS_UNAVAILABLE", status: 501 } },
    });
    assert.equal(off.apiVersion, "pilotswarm.dev/v1");
    assert.deepEqual(workflowCapabilities({ read: true, commands: undefined }), off);
    // Workflows are always on (owner 2026-11-08T08:03Z): `enabled` is always true, kept for an older client.
    assert.equal(workflowCapabilities({ read: false, commands: {} }).enabled, true);
    // Without a workflow store, reads (and card) are not advertised.
    assert.equal(workflowCapabilities({ read: false, commands: null }).read, false);
    assert.equal(workflowCapabilities({ read: false, commands: null }).card, false);
    assert.equal(workflowCapabilities({ read: false, commands: null }).validate, true);
    assert.equal(workflowCapabilities({ read: false, commands: null }).skills, true);
    // On: the controller and the operations every host takes: stop and, with workflow test mode on, the test operations
    // (Workflow Simplified, spec 16: test mode is hidden unless it is on).
    const milestone = workflowCapabilities({ read: true, commands: { testMode: true } }).commands;
    assert.deepEqual(milestone, { available: true, controllerVersion: WORKFLOW_CONTROLLER_VERSION,
        operations: [...WORKFLOW_HUMAN_OPERATIONS, ...WORKFLOW_HUMAN_MILESTONE_OPERATIONS] });
    assert.deepEqual(workflowCapabilities({ read: true, commands: { testMode: false } }).commands.operations,
        [...WORKFLOW_HUMAN_OPERATIONS, "stop"]);
    assert.equal(milestone.controllerVersion, "1.3.0");
    // recover stays the agent's: never advertised to a person.
    assert.ok(!milestone.operations.includes("recover"));
    // Each answer is a fresh value: a client that changes it changes nothing here.
    milestone.operations.push("recover");
    assert.ok(!workflowCapabilities({ read: true, commands: {} }).commands.operations.includes("recover"));
});

test("the management client answers from its own configuration and catalog, before and after it starts", async () => {
    const as = fields => Object.assign(Object.create(PilotSwarmManagementClient.prototype), fields);
    // Not started (no catalog): no reads; a person's commands as configured.
    assert.deepEqual(await as({ config: {}, _catalog: null }).getWorkflowCapabilities(), workflowCapabilities({ read: false, commands: null }));
    // A catalog with a workflow store, and a client whose configuration has no workflowCommands (as only a test makes one now):
    // reads on, commands off.
    const store = { workflowStore: () => ({}) };
    assert.deepEqual(await as({ config: {}, _catalog: store }).getWorkflowCapabilities(), workflowCapabilities({ read: true, commands: null }));
    // A catalog without one (no Workflows here): reads off.
    assert.equal((await as({ config: {}, _catalog: {} }).getWorkflowCapabilities()).read, false);
    // The full engine's commands, as every client is now created (its default).
    assert.deepEqual((await as({ config: { workflowCommands: {} }, _catalog: store }).getWorkflowCapabilities()).commands,
        workflowCapabilities({ read: true, commands: {} }).commands);
    // A real client, constructed as a deployment constructs it: commands on, on the full engine (owner decision
    // 2026-11-08T15:30Z); only an explicit null leaves them off.
    const client = new PilotSwarmManagementClient({ store: "postgres://capabilities.invalid/none" });
    assert.deepEqual(client.config.workflowCommands, {});
    assert.equal(new PilotSwarmManagementClient({ store: "postgres://capabilities.invalid/none", workflowCommands: null }).config.workflowCommands, null);
    // Review RLR-F1: an explicit object, partial or not, still takes commands on the full engine, and its test mode is kept
    // (absent, the deployment flag decides).
    for (const [given, want] of [[{}, {}], [{ testMode: true }, { testMode: true }], [{ testMode: false }, { testMode: false }]]) {
        const made = new PilotSwarmManagementClient({ store: "postgres://capabilities.invalid/none", workflowCommands: given });
        assert.deepEqual(made.config.workflowCommands, want, JSON.stringify(given));
        const capabilities = await as({ config: made.config, _catalog: store }).getWorkflowCapabilities();
        assert.equal(capabilities.commands.controllerVersion, WORKFLOW_CONTROLLER_VERSION, JSON.stringify(given));
        assert.ok(capabilities.commands.operations.includes("stop"), JSON.stringify(given));
    }
    const testing = new PilotSwarmManagementClient({ store: "postgres://capabilities.invalid/none", workflowCommands: { testMode: true } });
    assert.ok((await as({ config: testing.config, _catalog: store }).getWorkflowCapabilities()).commands.operations.includes("test"),
        "its test mode is not dropped");
});

// A real management client takes a person's commands on the full engine by default.
test("a real management client takes the full engine's commands", async () => {
    const client = new PilotSwarmManagementClient({ store: "postgres://capabilities.invalid/none" });
    const advertised = await Object.assign(Object.create(PilotSwarmManagementClient.prototype), {
        config: client.config, _catalog: { workflowStore: () => ({}) } }).getWorkflowCapabilities();
    assert.equal(advertised.commands.available, true);
    assert.equal(advertised.commands.controllerVersion, WORKFLOW_CONTROLLER_VERSION);
    assert.equal(advertised.input, true);
});

test("workflowCapabilities advertises input=true only when both read and commands are enabled", () => {
    assert.equal(workflowCapabilities({ read: true, commands: {} }).input, true);
    assert.equal(workflowCapabilities({ read: true, commands: null }).input, false);
    assert.equal(workflowCapabilities({ read: false, commands: {} }).input, false);
    assert.equal(workflowCapabilities({ read: false, commands: null }).input, false);
});

test("personSenderId encodes user and system actors collision-free and rejects invalid inputs", () => {
    assert.equal(personSenderId({ kind: "user", provider: "entra", subject: "sub-1" }), "person:user:entra:sub-1");
    const a = personSenderId({ kind: "user", provider: "a:b", subject: "c" });
    const b = personSenderId({ kind: "user", provider: "a", subject: "b:c" });
    assert.notEqual(a, b);
    assert.equal(a, "person:user:a%3Ab:c");
    assert.equal(b, "person:user:a:b%3Ac");
    assert.equal(personSenderId({ kind: "system", name: "management-client" }), "person:system:management-client");
    assert.throws(() => personSenderId({ kind: "agent", sessionId: "s-1" }), err => err.code === "FORBIDDEN");
    assert.throws(() => personSenderId({ kind: "user", provider: "entra", subject: "bad\uD800surrogate" }),
        err => err.code === "WORKFLOW_COMMAND_INVALID");
    assert.throws(() => personSenderId({ kind: "user", provider: "bad\uD800", subject: "sub-1" }),
        err => err.code === "WORKFLOW_COMMAND_INVALID");
    assert.throws(() => personSenderId({ kind: "system", name: "bad\uD800" }),
        err => err.code === "WORKFLOW_COMMAND_INVALID");
    assert.throws(() => personSenderId({ kind: "user", provider: "entra", subject: "x".repeat(520) }),
        err => err.code === "WORKFLOW_COMMAND_INVALID");
});

test("parsePersonWorkflowInput validates camelCase fields, preserves falsy payloads and untrimmed operationId", () => {
    for (const bad of [null, [], "str", 42]) {
        assert.throws(() => parsePersonWorkflowInput(bad), err => err.code === "WORKFLOW_COMMAND_INVALID");
    }
    assert.throws(() => parsePersonWorkflowInput({ contract: "Deploy@1", operationId: "op-1" }),
        err => err.code === "WORKFLOW_COMMAND_INVALID");
    assert.throws(() => parsePersonWorkflowInput({ contract: "Deploy@1", payload: undefined, operationId: "op-1" }),
        err => err.code === "WORKFLOW_COMMAND_INVALID");
    assert.throws(() => parsePersonWorkflowInput({ contract: "Deploy@1", payload: {}, operationId: "op-1", ttlSeconds: "60" }),
        err => err.code === "WORKFLOW_COMMAND_INVALID");
    assert.throws(() => parsePersonWorkflowInput({ contract: "Deploy@1", payload: {}, operationId: "op\u0000bad" }),
        err => err.code === "WORKFLOW_COMMAND_INVALID");
    for (const payload of [null, false, 0, ""]) {
        const parsed = parsePersonWorkflowInput({ contract: "Deploy@1", payload, operationId: " op-1 " });
        assert.equal(parsed.payload, payload);
        assert.equal(parsed.operationId, " op-1 ");
        assert.equal(parsed.contract, "Deploy@1");
        assert.equal(parsed.correlation, undefined);
        assert.equal(parsed.ttlSeconds, null);
        assert.equal(parsed.runId, null);
    }
    const full = parsePersonWorkflowInput({
        contract: "Deploy@1",
        payload: { ok: true },
        correlation: { ticket: "T-1" },
        operationId: "op-2",
        ttlSeconds: 120,
        runId: "run-9",
    });
    assert.deepEqual(full, {
        contract: "Deploy@1",
        payload: { ok: true },
        correlation: { ticket: "T-1" },
        operationId: "op-2",
        ttlSeconds: 120,
        runId: "run-9",
    });
});

test("send_workflow_input is in WORKFLOW_DEFINITION_MCP_TOOLS and rejected for sessions inside a Workflow without blocking the native tool", () => {
    assert.ok(WORKFLOW_DEFINITION_MCP_TOOLS.includes("send_workflow_input"));
    assert.equal(WORKFLOW_DEFINITION_TOOLS.includes("send_workflow_input"), false);
    const check = workflowDefinitionMcpPermission(() => ({ kind: "allow" }));
    const denied = check({ kind: "mcp", toolName: "send_workflow_input" });
    assert.equal(denied.kind, "reject");
    assert.equal(check({ kind: "custom-tool", toolName: "send_workflow_input" }).kind, "allow");
    assert.equal(check({ kind: "mcp", toolName: "read_workflow" }).kind, "allow");
    const filters = workflowDefinitionMcpToolFilters(["pilotswarm"]);
    assert.ok(filters.includes("mcp:pilotswarm-send_workflow_input"));
    assert.ok(filters.includes("pilotswarm-send_workflow_input"));
    assert.equal(filters.includes("send_workflow_input"), false);
});

test("PilotSwarmManagementClient.sendWorkflowInput refuses with 501 WORKFLOW_COMMANDS_UNAVAILABLE when workflowCommands is null", async () => {
    const client = Object.assign(Object.create(PilotSwarmManagementClient.prototype), {
        config: { workflowCommands: null },
        _started: true,
        _ensureStarted() {},
    });
    await assert.rejects(
        client.sendWorkflowInput("wf-1", { contract: "Deploy@1", payload: {}, operationId: "op-1" }),
        err => err.code === "WORKFLOW_COMMANDS_UNAVAILABLE" && err.status === 501 && err.expose === true,
    );
});
