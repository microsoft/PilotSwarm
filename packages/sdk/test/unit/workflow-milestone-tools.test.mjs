import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedSession } from "../../dist/managed-session.js";
import { SessionManager } from "../../dist/session-manager.js";
import { SPAWN_WORKFLOW_MILESTONE_TOOL_SPEC, SPAWN_WORKFLOW_TOOL_SPEC } from "../../dist/workflow/tool-spec.js";
import {
    READ_WORKFLOW_MILESTONE_TOOL_SPEC, READ_WORKFLOW_TOOL_SPEC, UPDATE_WORKFLOW_MILESTONE_NO_TEST_TOOL_SPEC, UPDATE_WORKFLOW_MILESTONE_OPERATIONS,
    UPDATE_WORKFLOW_MILESTONE_TOOL_SPEC, UPDATE_WORKFLOW_TOOL_SPEC, updateWorkflowFromTool,
} from "../../dist/workflow/v2/tools.js";
import { RESPOND_SESSION_REQUEST_TOOL, RESPOND_SESSION_REQUEST_TOOL_SPEC } from "../../dist/workflow/v2/request-service.js";
import { COMPLETE_WORKFLOW_NODE_TOOL, COMPLETE_WORKFLOW_NODE_TOOL_SPEC } from "../../dist/workflow/v2/agent-node-service.js";

// Workflow test mode is hidden unless PILOTSWARM_WORKFLOW_TEST_MODE=on (Workflow Simplified, spec 16). These tests describe
// the 1.9.0 tools with it on; workflow-test-mode-switch.test.mjs covers it off. Read when a declaration or command is made.
process.env.PILOTSWARM_WORKFLOW_TEST_MODE = "on";

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
    for (const field of ["run.test", "agent.childSessionId", "publishedAgentPins", "graceSeconds", "openExecutions", "run.pages", "nextCursor"]) {
        assert.ok(READ_WORKFLOW_MILESTONE_TOOL_SPEC.description.includes(field), field);
    }
    // The paging and whole-value arguments are declared on this host only; every production argument is declared as it is.
    const read = READ_WORKFLOW_MILESTONE_TOOL_SPEC.parameters;
    for (const name of Object.keys(READ_WORKFLOW_TOOL_SPEC.parameters.properties)) {
        assert.deepEqual(read.properties[name], READ_WORKFLOW_TOOL_SPEC.parameters.properties[name], name);
    }
    for (const name of ["cursor", "limit", "execution_id", "kv_revision", "kv_key", "agent_versions", "definition_revision", "step_input"]) {
        assert.ok(Object.hasOwn(read.properties, name), name);
        assert.equal(Object.hasOwn(READ_WORKFLOW_TOOL_SPEC.parameters.properties, name), false, `production declares no ${name}`);
        assert.ok(READ_WORKFLOW_MILESTONE_TOOL_SPEC.description.includes(name), `the description names ${name}`);
    }
    assert.deepEqual(read.required, READ_WORKFLOW_TOOL_SPEC.parameters.required);
    const spawn = SPAWN_WORKFLOW_MILESTONE_TOOL_SPEC.description;
    assert.ok(!spawn.includes("not supported yet"));
    for (const phrase of ["mode: request", "respond_session_request", "invoke:", "complete_workflow_node", "forEach:", "all_required", "${branch.item}",
        "{first: k}", "timeoutSeconds, which needs a timed_out route"]) {
        assert.ok(spawn.includes(phrase), phrase);
    }
    assert.equal(SPAWN_WORKFLOW_MILESTONE_TOOL_SPEC.parameters, SPAWN_WORKFLOW_TOOL_SPEC.parameters);
});

const names = defs => defs.map(def => def.name);
const named = (defs, name) => defs.find(def => def.name === name);

test("the model is declared what a 1.9.0 turn's handlers take; every other session's declarations are unchanged", () => {
    // What the Copilot CLI shows the model comes only from these declarations (session-manager, at create or resume); a turn's
    // handlers alone are invisible to it.
    const production = ManagedSession.subAgentToolDefs();
    for (const name of [RESPOND_SESSION_REQUEST_TOOL, COMPLETE_WORKFLOW_NODE_TOOL]) assert.ok(!names(production).includes(name), name);
    assert.equal(named(production, "spawn_workflow").description, SPAWN_WORKFLOW_TOOL_SPEC.description);
    assert.equal(named(production, "update_workflow").description, UPDATE_WORKFLOW_TOOL_SPEC.description);
    assert.equal(named(production, "update_workflow").parameters, UPDATE_WORKFLOW_TOOL_SPEC.parameters);
    assert.equal(named(production, "read_workflow").description, READ_WORKFLOW_TOOL_SPEC.description);
    assert.deepEqual(names(ManagedSession.subAgentToolDefs({ workflowAgentChild: true })).filter(name => name !== COMPLETE_WORKFLOW_NODE_TOOL),
        names(production), "the child flag adds only the completion tool");

    const milestone = ManagedSession.subAgentToolDefs({ workflowMilestone: true });
    assert.equal(named(milestone, "spawn_workflow").description, SPAWN_WORKFLOW_MILESTONE_TOOL_SPEC.description);
    assert.equal(named(milestone, "update_workflow").description, UPDATE_WORKFLOW_MILESTONE_TOOL_SPEC.description);
    assert.equal(named(milestone, "update_workflow").parameters, UPDATE_WORKFLOW_MILESTONE_TOOL_SPEC.parameters);
    assert.equal(named(milestone, "read_workflow").description, READ_WORKFLOW_MILESTONE_TOOL_SPEC.description);
    assert.equal(named(milestone, RESPOND_SESSION_REQUEST_TOOL).description, RESPOND_SESSION_REQUEST_TOOL_SPEC.description);
    assert.equal(named(milestone, RESPOND_SESSION_REQUEST_TOOL).parameters, RESPOND_SESSION_REQUEST_TOOL_SPEC.parameters);
    assert.ok(!names(milestone).includes(COMPLETE_WORKFLOW_NODE_TOOL), "only an agent state's own child completes a state");
    assert.deepEqual(names(milestone).filter(name => name !== RESPOND_SESSION_REQUEST_TOOL), names(production));

    const child = ManagedSession.subAgentToolDefs({ workflowMilestone: true, workflowAgentChild: true });
    assert.equal(named(child, COMPLETE_WORKFLOW_NODE_TOOL).description, COMPLETE_WORKFLOW_NODE_TOOL_SPEC.description);
    assert.equal(named(child, COMPLETE_WORKFLOW_NODE_TOOL).parameters, COMPLETE_WORKFLOW_NODE_TOOL_SPEC.parameters);
    assert.deepEqual(names(child).filter(name => name !== COMPLETE_WORKFLOW_NODE_TOOL), names(milestone));
    // The workspace flag still adds what it did.
    assert.deepEqual(names(ManagedSession.subAgentToolDefs({ workspaceTools: true, workflowMilestone: true })),
        names(ManagedSession.subAgentToolDefs({ workflowMilestone: true })));
});

/** A SessionManager whose Copilot transport is stubbed (the session-workspace-binding pattern): each handle's declarations. */
function managerFixture(t) {
    const home = fs.mkdtempSync(join(tmpdir(), "ps-wf-milestone-tools-"));
    const calls = [];
    const manager = new SessionManager(undefined, null, {}, home);
    manager.workflowScriptsEnabled = true;
    manager.setFactStore({
        readFacts: async () => ({ count: 0, facts: [] }),
        storeFact: async () => ({ stored: true }),
        deleteFact: async () => ({ deleted: true }),
    });
    const open = (kind, config) => {
        calls.push({ kind, tools: config.tools });
        fs.mkdirSync(join(home, config.sessionId), { recursive: true });
        return {
            disconnect: async () => {},
            rpc: { tasks: { list: async () => ({ tasks: [] }), cancel: async () => ({ cancelled: true }) } },
        };
    };
    manager.ensureClient = async () => ({
        createSession: async config => open("create", config),
        resumeSession: async (_id, config) => open("resume", config),
        deleteSession: async () => {},
    });
    t.after(async () => {
        for (const id of [...manager.sessions.keys()]) await manager.dropWarmSession(id);
        fs.rmSync(home, { recursive: true, force: true });
    });
    return { manager, calls };
}

test("a session's CLI handle is declared the tools of its turn's flags: set by the runTurn activity, never kept from an earlier turn", async (t) => {
    const { manager, calls } = managerFixture(t);
    const declared = () => calls.at(-1).tools;

    await manager.getOrCreate("plain", { toolNames: [] }, { turnIndex: 0 });
    for (const name of [RESPOND_SESSION_REQUEST_TOOL, COMPLETE_WORKFLOW_NODE_TOOL]) assert.ok(!names(declared()).includes(name), name);
    assert.equal(named(declared(), "update_workflow").description, UPDATE_WORKFLOW_TOOL_SPEC.description);

    // An agent state's own child on a 1.9.0 turn: the milestone descriptions, both tools, pinned like every PilotSwarm tool.
    await manager.getOrCreate("child", { toolNames: [], workflowMilestoneTurn: true, workflowAgentChild: true }, { turnIndex: 0 });
    assert.equal(calls.at(-1).kind, "create");
    assert.equal(named(declared(), "update_workflow").description, UPDATE_WORKFLOW_MILESTONE_TOOL_SPEC.description);
    for (const name of [RESPOND_SESSION_REQUEST_TOOL, COMPLETE_WORKFLOW_NODE_TOOL]) assert.equal(named(declared(), name)?.defer, "never", name);
    const childHandles = calls.length;
    // The same flags keep the warm handle.
    await manager.getOrCreate("child", { toolNames: [], workflowMilestoneTurn: true, workflowAgentChild: true }, { turnIndex: 1 });
    assert.equal(calls.length, childHandles);

    // A turn without the flags: the stored config's flags do not survive, and the changed declarations need a new handle.
    await manager.getOrCreate("child", { toolNames: [] }, { turnIndex: 2 });
    assert.equal(calls.length, childHandles + 1);
    assert.equal(calls.at(-1).kind, "resume");
    for (const name of [RESPOND_SESSION_REQUEST_TOOL, COMPLETE_WORKFLOW_NODE_TOOL]) assert.ok(!names(declared()).includes(name), name);
    assert.equal(named(declared(), "update_workflow").description, UPDATE_WORKFLOW_TOOL_SPEC.description);

    // A 1.9.0 turn of a session outside every agent state: respond_session_request only.
    await manager.getOrCreate("parent", { toolNames: [], workflowMilestoneTurn: true }, { turnIndex: 0 });
    assert.ok(names(declared()).includes(RESPOND_SESSION_REQUEST_TOOL));
    assert.ok(!names(declared()).includes(COMPLETE_WORKFLOW_NODE_TOOL));
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

test("the reference skill's update_workflow table names exactly the operations a 1.9.0 host takes with test mode hidden (spec 16)", () => {
    const text = fs.readFileSync(new URL("../../plugins/workflow-v2/skills/workflow-reference/SKILL.md", import.meta.url), "utf8");
    const table = text.slice(text.indexOf("| Operation | Arguments | Effect |"), text.indexOf("`read_workflow`:"));
    const named = table.split("\n").slice(2).filter(line => line.startsWith("| `"))
        .flatMap(line => line.split("|")[1].split(",").map(cell => cell.trim().replace(/`/g, "")));
    assert.deepEqual(named.sort(), [...UPDATE_WORKFLOW_MILESTONE_NO_TEST_TOOL_SPEC.parameters.properties.operation.enum].sort());
});
