/**
 * Workflow test mode, hidden (Workflow Simplified, spec 16; owner decisions E1, O2): off unless the deployment flag
 * PILOTSWARM_WORKFLOW_TEST_MODE is exactly `on`. Off, on every surface:
 * - the agent tool: update_workflow and read_workflow of a 1.9.0 turn declare no test operation, argument or field, and
 *   the handler refuses a test operation in words, before anything is read;
 * - a person's commands (the Web API and MCP run them): a test operation answers as one that does not exist; the
 *   bootstrap capabilities and a read model's personCommands do not list them, so the portal and the terminal UI offer
 *   no test control and no test run;
 * - the base guidance does not mention testing.
 * With the flag on, each is as it was (the test-mode tests keep running with it: vitest sets it for the SDK's local
 * tests, and the unit tests that cover test mode set it themselves).
 *
 * Run: node --test test/unit/workflow-test-mode-switch.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
    resolveWorkflowTestMode, WORKFLOW_TEST_MODE_ENABLED, WORKFLOW_TEST_MODE_OFF_TEXT, WORKFLOW_TEST_MODE_OPERATIONS, WORKFLOW_TEST_MODE_VARIABLE,
    workflowTestModeFromEnv, workflowTestModeNotice,
} from "../../dist/workflow/v2/test-mode-switch.js";
import {
    READ_WORKFLOW_MILESTONE_NO_TEST_TOOL_SPEC, READ_WORKFLOW_MILESTONE_TOOL_SPEC, READ_WORKFLOW_TOOL_SPEC, readWorkflowToolSpec,
    UPDATE_WORKFLOW_MILESTONE_NO_TEST_TOOL_SPEC, UPDATE_WORKFLOW_MILESTONE_TOOL_SPEC, UPDATE_WORKFLOW_TOOL_SPEC, updateWorkflowFromTool, updateWorkflowToolSpec,
} from "../../dist/workflow/v2/tools.js";
import {
    updateWorkflowForPerson, workflowCapabilities, workflowCommandsForPerson, workflowHumanMilestoneOperations, WORKFLOW_HUMAN_OPERATIONS,
} from "../../dist/workflow/v2/human-commands.js";
import { WORKFLOW_AUTHORING_POINTER, WORKFLOW_SESSION_GUIDANCE, workflowAuthoringPointer, workflowSessionGuidance } from "../../dist/workflow/guidance.js";
import { ManagedSession } from "../../dist/managed-session.js";
import { SessionManager } from "../../dist/session-manager.js";
import { RESPOND_SESSION_REQUEST_TOOL } from "../../dist/workflow/v2/request-service.js";
import * as sdk from "../../dist/index.js";

// Off by default: this file runs without the flag, whatever the shell exported.
delete process.env.PILOTSWARM_WORKFLOW_TEST_MODE;

/** Run `fn` with the flag set to `value` (undefined: unset), then restore it. */
async function withFlag(value, fn) {
    const before = process.env.PILOTSWARM_WORKFLOW_TEST_MODE;
    if (value === undefined) delete process.env.PILOTSWARM_WORKFLOW_TEST_MODE;
    else process.env.PILOTSWARM_WORKFLOW_TEST_MODE = value;
    try {
        return await fn();
    } finally {
        if (before === undefined) delete process.env.PILOTSWARM_WORKFLOW_TEST_MODE;
        else process.env.PILOTSWARM_WORKFLOW_TEST_MODE = before;
    }
}

const PRODUCTION = ["replace_definition", "publish", "publish_and_start", "start", "set_vars", "pause", "resume", "cancel", "recover"];
const TEST_ARGUMENTS = ["agent_mode", "fixtures", "scenario", "interception_id", "response", "seconds"];
const names = defs => defs.map(def => def.name);
const named = (defs, name) => defs.find(def => def.name === name);

test("the flag is on only when it is exactly `on`, separate from the test environment switch", () => {
    assert.equal(WORKFLOW_TEST_MODE_VARIABLE, "PILOTSWARM_WORKFLOW_TEST_MODE");
    assert.equal(WORKFLOW_TEST_MODE_ENABLED, "on");
    assert.deepEqual([...WORKFLOW_TEST_MODE_OPERATIONS], ["test", "test_respond", "test_advance"]);
    assert.equal(workflowTestModeFromEnv({}), false);
    for (const value of ["", "ON", "On", " on", "on ", "1", "true", "yes", "isolated-test-only"]) {
        assert.equal(workflowTestModeFromEnv({ PILOTSWARM_WORKFLOW_TEST_MODE: value }), false, JSON.stringify(value));
    }
    assert.equal(workflowTestModeFromEnv({ PILOTSWARM_WORKFLOW_TEST_MODE: "on" }), true);
    // The Workflow V2 test environment switch does not turn it on.
    assert.equal(workflowTestModeFromEnv({ PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT: "isolated-test-only" }), false);
    assert.equal(workflowTestModeFromEnv(), false, "this process: off by default");
    // A host's own boolean wins; without one, the flag decides.
    assert.equal(resolveWorkflowTestMode(true, {}), true);
    assert.equal(resolveWorkflowTestMode(false, { PILOTSWARM_WORKFLOW_TEST_MODE: "on" }), false);
    assert.equal(resolveWorkflowTestMode(undefined, { PILOTSWARM_WORKFLOW_TEST_MODE: "on" }), true);
    assert.equal(resolveWorkflowTestMode(null, {}), false);
    assert.equal(workflowTestModeNotice({}), null);
    assert.match(workflowTestModeNotice({ PILOTSWARM_WORKFLOW_TEST_MODE: "on" }), /^Workflow test mode ON/);
    assert.match(workflowTestModeNotice({ PILOTSWARM_WORKFLOW_TEST_MODE: "yes" }), /ignored, workflow test mode OFF\.$/);
    // The package exports it.
    assert.equal(sdk.workflowTestModeFromEnv, workflowTestModeFromEnv);
    assert.equal(sdk.WORKFLOW_TEST_MODE_VARIABLE, WORKFLOW_TEST_MODE_VARIABLE);
});

test("agent tool: with test mode off, a 1.9.0 turn is declared stop and no test operation, argument or field", () => {
    const update = UPDATE_WORKFLOW_MILESTONE_NO_TEST_TOOL_SPEC;
    assert.deepEqual([...update.parameters.properties.operation.enum], [...PRODUCTION, "stop"]);
    assert.ok(update.description.startsWith(UPDATE_WORKFLOW_TOOL_SPEC.description));
    assert.ok(update.description.includes("stop (run_id optional, reason, grace_seconds 0 to 3600"));
    assert.ok(!/\btest/i.test(update.description), update.description);
    for (const name of TEST_ARGUMENTS) assert.equal(Object.hasOwn(update.parameters.properties, name), false, name);
    assert.ok(Object.hasOwn(update.parameters.properties, "grace_seconds"));
    for (const name of Object.keys(UPDATE_WORKFLOW_TOOL_SPEC.parameters.properties)) assert.ok(Object.hasOwn(update.parameters.properties, name), name);
    assert.deepEqual(update.parameters.required, UPDATE_WORKFLOW_TOOL_SPEC.parameters.required);

    const read = READ_WORKFLOW_MILESTONE_NO_TEST_TOOL_SPEC;
    assert.ok(read.description.startsWith(READ_WORKFLOW_TOOL_SPEC.description));
    assert.ok(!/\btest|held call/i.test(read.description), read.description);
    assert.ok(!/held call/.test(read.parameters.properties.limit.description));
    for (const field of ["agent.childSessionId", "publishedAgentPins", "graceSeconds", "openExecutions", "run.pages", "nextCursor"]) {
        assert.ok(read.description.includes(field), field);
    }
    assert.deepEqual(Object.keys(read.parameters.properties), Object.keys(READ_WORKFLOW_MILESTONE_TOOL_SPEC.parameters.properties));

    // The choice per turn.
    assert.equal(updateWorkflowToolSpec({ milestone: false, testMode: true }), UPDATE_WORKFLOW_TOOL_SPEC);
    assert.equal(updateWorkflowToolSpec({ milestone: true, testMode: false }), UPDATE_WORKFLOW_MILESTONE_NO_TEST_TOOL_SPEC);
    assert.equal(updateWorkflowToolSpec({ milestone: true, testMode: true }), UPDATE_WORKFLOW_MILESTONE_TOOL_SPEC);
    assert.equal(readWorkflowToolSpec({ milestone: false, testMode: true }), READ_WORKFLOW_TOOL_SPEC);
    assert.equal(readWorkflowToolSpec({ milestone: true, testMode: false }), READ_WORKFLOW_MILESTONE_NO_TEST_TOOL_SPEC);
    assert.equal(readWorkflowToolSpec({ milestone: true, testMode: true }), READ_WORKFLOW_MILESTONE_TOOL_SPEC);

    // What the model is declared: off by default, the test declarations with the flag on.
    const off = ManagedSession.subAgentToolDefs({ workflowMilestone: true });
    assert.equal(named(off, "update_workflow").description, UPDATE_WORKFLOW_MILESTONE_NO_TEST_TOOL_SPEC.description);
    assert.equal(named(off, "update_workflow").parameters, UPDATE_WORKFLOW_MILESTONE_NO_TEST_TOOL_SPEC.parameters);
    assert.equal(named(off, "read_workflow").description, READ_WORKFLOW_MILESTONE_NO_TEST_TOOL_SPEC.description);
    const production = ManagedSession.subAgentToolDefs();
    assert.equal(named(production, "update_workflow").description, UPDATE_WORKFLOW_TOOL_SPEC.description);
    assert.deepEqual(names(off).filter(name => name !== RESPOND_SESSION_REQUEST_TOOL), names(production));
});

test("agent tool: with the flag on, a 1.9.0 turn is declared the test operations as before", async () => {
    await withFlag("on", () => {
        const on = ManagedSession.subAgentToolDefs({ workflowMilestone: true });
        assert.equal(named(on, "update_workflow").description, UPDATE_WORKFLOW_MILESTONE_TOOL_SPEC.description);
        assert.equal(named(on, "update_workflow").parameters, UPDATE_WORKFLOW_MILESTONE_TOOL_SPEC.parameters);
        assert.equal(named(on, "read_workflow").description, READ_WORKFLOW_MILESTONE_TOOL_SPEC.description);
    });
});

/** A 1.9.0 host whose workflow child "wf" belongs to "parent"; it records every read. */
function hostOf(fields = {}) {
    const reads = [];
    return {
        reads,
        host: {
            catalog: { getSession: async id => { reads.push(["session", id]); return id === "wf" ? { sessionKind: "workflow", parentSessionId: "parent", deletedAt: null } : null; } },
            store: {
                readDefinition: async id => { reads.push(["definition", id]); return id === "wf" ? { parentSessionId: "parent" } : null; },
                readWorkflowLineage: async id => { reads.push(["lineage", id]); return { sessionId: id, level: 1, agentRoot: null }; },
            },
            duroxideClient: {},
            requests: true,
            ...fields,
        },
    };
}

const OFF_REFUSAL = /^Testing workflows is turned off on this server\. operation must be replace_definition, .* or stop\.$/;

test("agent tool: with test mode off, the handler refuses each test operation in words before anything is read", async () => {
    for (const fields of [{}, { testMode: false }]) {
        for (const operation of ["test", "test_respond", "test_advance"]) {
            const { host, reads } = hostOf(fields);
            const answer = JSON.parse(await updateWorkflowFromTool({ workflow_id: "wf", operation_id: "op-1", operation, run_id: "run-1" },
                { callerSessionId: "parent", host }));
            assert.equal(answer.ok, false, operation);
            assert.equal(answer.error.code, "WORKFLOW_COMMAND_INVALID", operation);
            assert.match(answer.error.message, OFF_REFUSAL, operation);
            assert.ok(answer.error.message.startsWith(WORKFLOW_TEST_MODE_OFF_TEXT));
            for (const word of ["test,", "test_respond", "test_advance"]) assert.ok(!answer.error.message.slice(WORKFLOW_TEST_MODE_OFF_TEXT.length).includes(word), word);
            assert.deepEqual(reads, [], `${operation}: nothing read`);
        }
    }
    // An unknown operation names stop, and no test operation.
    const { host } = hostOf();
    const unknown = JSON.parse(await updateWorkflowFromTool({ workflow_id: "wf", operation_id: "op-1", operation: "teleport" }, { callerSessionId: "parent", host }));
    assert.match(unknown.error.message, /^operation must be replace_definition, .* or stop\.$/);
    assert.ok(!unknown.error.message.includes("test_respond"));
    // stop is still taken: its own arguments are read and checked.
    const stop = JSON.parse(await updateWorkflowFromTool({ workflow_id: "wf", operation_id: "op-1", operation: "stop", grace_seconds: -1 },
        { callerSessionId: "parent", host }));
    assert.match(stop.error.message, /^grace_seconds must be an integer from 0 to 3600\.$/);
    // A host that says test mode is on takes them, whatever the flag: its own arguments are read and checked.
    const on = hostOf({ testMode: true }).host;
    const advance = JSON.parse(await updateWorkflowFromTool({ workflow_id: "wf", operation_id: "op-1", operation: "test_advance", run_id: "run-1", seconds: 0 },
        { callerSessionId: "parent", host: on }));
    assert.match(advance.error.message, /^seconds must be an integer from 1 to 2592000\.$/);
    // And the flag turns them on for a host that does not say.
    await withFlag("on", async () => {
        const flagged = JSON.parse(await updateWorkflowFromTool({ workflow_id: "wf", operation_id: "op-1", operation: "test", agent_mode: "live" },
            { callerSessionId: "parent", host: hostOf().host }));
        assert.match(flagged.error.message, /^agent_mode must be mocked or real\.$/);
    });
});

const PERSON = { kind: "user", provider: "test", subject: "alice" };

test("a person's commands (Web API, MCP): with test mode off a test operation answers as an operation that does not exist, and is not advertised", async () => {
    const refusal = async (operation, workflowSessionId = "wf") => {
        const { host, reads } = hostOf({ testMode: false });
        let caught = null;
        await assert.rejects(updateWorkflowForPerson({ operation, operation_id: "t-1", run_id: "run-1" }, { host, workflowSessionId, actor: PERSON }), error => {
            caught = error;
            return true;
        });
        return { code: caught.code, message: caught.message, reads };
    };
    const unknown = await refusal("teleport");
    assert.equal(unknown.code, "WORKFLOW_COMMAND_INVALID");
    assert.match(unknown.message, /^operation must be replace_definition, .* or stop\.$/);
    const missing = await refusal("teleport", "missing");
    assert.equal(missing.code, "WORKFLOW_NOT_FOUND");
    for (const operation of ["test", "test_respond", "test_advance"]) {
        // The same refusal, the same reads, no word of testing: as absent as an unknown operation.
        const answer = await refusal(operation);
        assert.deepEqual(answer, unknown, operation);
        assert.ok(!/test/i.test(answer.message), operation);
        assert.deepEqual(await refusal(operation, "missing"), missing, `${operation} on a session that is not a workflow`);
    }
    // The bootstrap's capabilities: stop, and the test operations only with test mode on.
    assert.deepEqual(workflowHumanMilestoneOperations(false), ["stop"]);
    assert.deepEqual(workflowHumanMilestoneOperations(true), ["stop", "test", "test_respond", "test_advance"]);
    assert.deepEqual(workflowCapabilities({ read: true, commands: { requests: true } }).v2.commands.operations, [...WORKFLOW_HUMAN_OPERATIONS, "stop"],
        "off by default");
    assert.deepEqual(workflowCapabilities({ read: true, commands: { requests: true, testMode: true } }).v2.commands.operations,
        [...WORKFLOW_HUMAN_OPERATIONS, "stop", "test", "test_respond", "test_advance"]);
    await withFlag("on", () => {
        assert.ok(workflowCapabilities({ read: true, commands: { requests: true } }).v2.commands.operations.includes("test"));
    });
    // A read model's personCommands: what a screen offers, so no test control and no test run while it is off.
    const store = {
        readWorkflowLineage: async () => null, readRun: async () => null, readRevision: async () => null,
    };
    const off = await workflowCommandsForPerson(store, "wf", { requests: true, runId: null });
    assert.deepEqual(off.operations, [...WORKFLOW_HUMAN_OPERATIONS, "stop"]);
    const on = await workflowCommandsForPerson(store, "wf", { requests: true, runId: null, testMode: true });
    assert.deepEqual(on.operations, [...WORKFLOW_HUMAN_OPERATIONS, "stop", "test", "test_respond", "test_advance"]);
    // A workflow in an agent step's subtree: the reason does not mention testing while it is off.
    const nested = { ...store, readWorkflowLineage: async () => ({ agentRoot: { workflowSessionId: "W1", controllingSessionId: "P" } }) };
    const restricted = await workflowCommandsForPerson(nested, "wf", { requests: true, runId: null });
    assert.match(restricted.restriction.reason, /only its controlling agent changes or resumes it\.$/);
    const restrictedOn = await workflowCommandsForPerson(nested, "wf", { requests: true, runId: null, testMode: true });
    assert.match(restrictedOn.restriction.reason, /only its controlling agent changes, resumes or tests it\.$/);
});

test("base guidance: with test mode off, neither the guidance nor the authoring pointer mentions testing", async () => {
    assert.equal(workflowSessionGuidance(true), WORKFLOW_SESSION_GUIDANCE);
    assert.equal(workflowAuthoringPointer(true), WORKFLOW_AUTHORING_POINTER);
    const guidance = workflowSessionGuidance(false);
    assert.ok(!guidance.includes("test_waiting") && !guidance.includes("test_respond"));
    assert.ok(guidance.includes("- `request`: answer it once with `respond_session_request`"));
    assert.ok(guidance.includes("\n\nA person's \"Ask the parent agent\" note"));
    assert.equal(guidance.length, WORKFLOW_SESSION_GUIDANCE.length - "\n- `test_waiting`: a test run's held call. Answer it with `update_workflow` operation `test_respond`.".length);
    assert.ok(!/\btest/i.test(workflowAuthoringPointer(false)));
    assert.ok(workflowAuthoringPointer(false).includes("load the `workflow-authoring` skill"));

    const prompt = () => {
        const manager = new SessionManager(undefined, null, { frameworkBasePrompt: "Legacy base." });
        manager.workflowScriptsEnabled = true;
        return JSON.stringify(manager._buildSystemMessage("session", { baseAgentPolicy: { version: "v2", fingerprint: "test", revision: null } }));
    };
    assert.ok(prompt().includes("## Workflow Sessions"));
    assert.ok(!prompt().includes("test_waiting"), "off by default");
    await withFlag("on", () => { assert.ok(prompt().includes("test_waiting")); });
});
