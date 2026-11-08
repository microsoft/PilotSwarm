/**
 * Workflows can be switched off (Workflow Simplified stage 2.0; spec "switch", decision D1): PILOTSWARM_WORKFLOWS, exactly
 * `on`; off by default; PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT=isolated-test-only implies on.
 * - the setting, its option precedence, its notice and its refusals;
 * - agents: the four tools are declared, and the base instructions carry Workflow guidance, only with Workflows on and a
 *   worker that runs scripts; a stale declaration's handler and the bridge answer WORKFLOWS_DISABLED first;
 * - the management client: the capabilities say `enabled: false` and nothing else; readWorkflow and updateWorkflow answer
 *   WORKFLOWS_DISABLED (404) before the catalog is read; the Workflow lookups on input, the access check and a cancel, done
 *   or delete are skipped;
 * - the client: a person's prompt and event cost no Workflow lookup.
 * The database side (a real lineage that would be refused when on) is test/local/workflows-switch.test.js.
 *
 * Run: node --test test/unit/workflows-switch.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "../../dist/index.js";
import {
    WORKFLOW_AGENT_TOOL_NAMES, WORKFLOWS_DISABLED, WORKFLOWS_DISABLED_TEXT, resolveWorkflowsEnabled, workflowsDisabledError, workflowsDisabledRefusal,
    workflowsEnabledFromEnv, workflowsNotice,
} from "../../dist/workflow/workflows-switch.js";
import { SessionManager } from "../../dist/session-manager.js";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { PilotSwarmClient } from "../../dist/client.js";
import { WORKFLOW_CAPABILITIES_SCHEMA, workflowCapabilities } from "../../dist/workflow/v2/human-commands.js";

const SRC = new URL("../../src/", import.meta.url);
const read = name => fs.readFileSync(new URL(name, SRC), "utf8");

/** Runs `fn` with `PILOTSWARM_WORKFLOWS` (and the test environment switch) as given, then puts them back. */
async function withEnv(values, fn) {
    const keys = ["PILOTSWARM_WORKFLOWS", "PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT"];
    const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) {
        if (values[key] === undefined) delete process.env[key];
        else process.env[key] = values[key];
    }
    try {
        return await fn();
    } finally {
        for (const key of keys) {
            if (before[key] === undefined) delete process.env[key];
            else process.env[key] = before[key];
        }
    }
}

test("the setting: exactly `on`, or the test environment switch; everything else is off", () => {
    assert.equal(sdk.WORKFLOWS_VARIABLE, "PILOTSWARM_WORKFLOWS");
    assert.equal(sdk.WORKFLOWS_ENABLED_VALUE, "on");
    for (const value of [undefined, "", "ON", "On", "1", "true", "yes", " on", "on ", "enabled", "off"]) {
        assert.equal(workflowsEnabledFromEnv(value === undefined ? {} : { PILOTSWARM_WORKFLOWS: value }), false, JSON.stringify(value));
    }
    assert.equal(workflowsEnabledFromEnv({ PILOTSWARM_WORKFLOWS: "on" }), true);
    assert.equal(workflowsEnabledFromEnv({ PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT: "isolated-test-only" }), true, "the test environment implies on");
    assert.equal(workflowsEnabledFromEnv({ PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT: "true" }), false);
    // An option says it first; absent, the setting.
    assert.equal(resolveWorkflowsEnabled(true, {}), true);
    assert.equal(resolveWorkflowsEnabled(false, { PILOTSWARM_WORKFLOWS: "on" }), false);
    assert.equal(resolveWorkflowsEnabled(undefined, { PILOTSWARM_WORKFLOWS: "on" }), true);
    assert.equal(resolveWorkflowsEnabled(null, {}), false);
    // One startup line, each case.
    assert.equal(workflowsNotice({}), "Workflows OFF (PILOTSWARM_WORKFLOWS is not set).");
    assert.equal(workflowsNotice({ PILOTSWARM_WORKFLOWS: "on" }), "Workflows ON (PILOTSWARM_WORKFLOWS=on).");
    assert.match(workflowsNotice({ PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT: "isolated-test-only" }), /^Workflows ON \(implied by PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT/);
    assert.equal(workflowsNotice({ PILOTSWARM_WORKFLOWS: "yes" }), "PILOTSWARM_WORKFLOWS is set but not to on: ignored, Workflows OFF.");
});

test("the refusal: a code and plain words, as JSON or as spawn_workflow's one line; a management call's is 404", () => {
    assert.equal(WORKFLOWS_DISABLED, "WORKFLOWS_DISABLED");
    assert.equal(WORKFLOWS_DISABLED_TEXT, "Workflows are turned off on this server. An operator turns them on with PILOTSWARM_WORKFLOWS=on.");
    assert.deepEqual(JSON.parse(workflowsDisabledRefusal("read_workflow")), { ok: false, error: { code: WORKFLOWS_DISABLED, message: WORKFLOWS_DISABLED_TEXT } });
    assert.equal(workflowsDisabledRefusal("spawn_workflow", { line: true }), `[SYSTEM: spawn_workflow refused — ${WORKFLOWS_DISABLED_TEXT} (WORKFLOWS_DISABLED)]`);
    const error = workflowsDisabledError();
    assert.equal(error.code, WORKFLOWS_DISABLED);
    assert.equal(error.status, 404);
    assert.equal(error.message, WORKFLOWS_DISABLED_TEXT);
    assert.deepEqual([...WORKFLOW_AGENT_TOOL_NAMES], ["workflow_definition", "spawn_workflow", "update_workflow", "read_workflow", "send_workflow_input"]);
});

/** A SessionManager whose Copilot transport is stubbed (the workflow-milestone-tools pattern): each handle's declarations. */
function managerFixture(t, { workflows, scripts = true }) {
    const home = fs.mkdtempSync(join(tmpdir(), "ps-workflows-switch-"));
    const calls = [];
    const manager = new SessionManager(undefined, null, {}, home);
    manager.workflowScriptsEnabled = scripts;
    if (workflows !== undefined) manager.workflowsEnabled = workflows;
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }), storeFact: async () => ({ stored: true }), deleteFact: async () => ({ deleted: true }) });
    const open = (kind, config) => {
        calls.push({ kind, tools: config.tools });
        fs.mkdirSync(join(home, config.sessionId), { recursive: true });
        return { disconnect: async () => {}, rpc: { tasks: { list: async () => ({ tasks: [] }), cancel: async () => ({ cancelled: true }) } } };
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

test("agents: the four tools are declared only with Workflows on, scripts on or off (one switch); off by default", async (t) => {
    const names = tools => tools.map(tool => tool.name);
    for (const [workflows, scripts, declared] of [[undefined, true, false], [false, true, false], [true, false, true], [true, true, true]]) {
        const { manager, calls } = managerFixture(t, { workflows, scripts });
        assert.equal(manager.workflowsEnabled, workflows ?? false, "a SessionManager starts with Workflows off");
        await manager.getOrCreate("s1", { toolNames: [] }, { turnIndex: 0 });
        const got = names(calls.at(-1).tools);
        for (const name of WORKFLOW_AGENT_TOOL_NAMES) {
            assert.equal(got.includes(name), declared, `${name} with workflows=${workflows}, scripts=${scripts}`);
        }
        // Every other tool is declared either way.
        assert.ok(got.includes("spawn_agent"));
    }
});

test("agents (stage 2.5, PR 235 4b0ac3ca): with Workflows and scripts on, cron sends a check a script can do to one Workflow; cron_at too where clock waits run; otherwise main's words", async (t) => {
    const { ManagedSession } = await import("../../dist/managed-session.js");
    const { WORKFLOW_AWARE_CRON_DESCRIPTION, WORKFLOW_AWARE_CRON_AT_DESCRIPTION } = await import("../../dist/workflow/guidance.js");
    const main = Object.fromEntries(ManagedSession.systemToolDefs().map(tool => [tool.name, tool.description]));
    const described = (tools, name) => tools.find(tool => tool.name === name)?.description;
    for (const [workflows, scripts, clockWaits, cron, cronAt] of [
        [undefined, true, false, main.cron, main.cron_at],
        [false, true, true, main.cron, main.cron_at],
        [true, false, true, main.cron, main.cron_at],
        [true, true, false, WORKFLOW_AWARE_CRON_DESCRIPTION, main.cron_at],
        [true, true, true, WORKFLOW_AWARE_CRON_DESCRIPTION, WORKFLOW_AWARE_CRON_AT_DESCRIPTION],
    ]) {
        const { manager, calls } = managerFixture(t, { workflows, scripts });
        await manager.getOrCreate(`s-${workflows}-${scripts}-${clockWaits}`, { toolNames: [], ...(clockWaits ? { workflowMilestoneTurn: true } : {}) }, { turnIndex: 0 });
        const tools = calls.at(-1).tools;
        const label = `workflows=${workflows}, scripts=${scripts}, clockWaits=${clockWaits}`;
        assert.equal(described(tools, "cron"), cron, `cron, ${label}`);
        assert.equal(described(tools, "cron_at"), cronAt, `cron_at, ${label}`);
    }
    // Each keeps every rule of main's wording; only what a Workflow does better is added.
    for (const rule of ["Do not use cron solely to poll sub-agent status", "clarify that intent before setting cron", "Minimum interval is 15 seconds."]) {
        assert.ok(main.cron.includes(rule) && WORKFLOW_AWARE_CRON_DESCRIPTION.includes(rule), rule);
    }
    for (const rule of ["Do NOT implement wall-clock schedules by polling every N minutes", "Recurrence is inferred from the fields you provide",
        "Pass max_fires=1 for a single one-shot scheduled-at-time action.", "Cancel with action='cancel'."]) {
        assert.ok(main.cron_at.includes(rule) && WORKFLOW_AWARE_CRON_AT_DESCRIPTION.includes(rule), rule);
    }
    assert.match(WORKFLOW_AWARE_CRON_DESCRIPTION, /workflow_definition and start it ONCE, with a loop through a wait state/);
    assert.match(WORKFLOW_AWARE_CRON_AT_DESCRIPTION, /wait state that has `at`/);
    assert.ok(!/spawn_workflow/.test(WORKFLOW_AWARE_CRON_DESCRIPTION + WORKFLOW_AWARE_CRON_AT_DESCRIPTION), "the tool of this stage, not the compat one");
});

test("agents (stage 2.5): workflow_definition declares test, and the guidance teaches it, only on a turn that can run a test", async (t) => {
    const { WORKFLOW_TESTS_UNAVAILABLE_GUIDANCE } = await import("../../dist/workflow/guidance.js");
    for (const requestTurn of [false, true]) {
        const { manager, calls } = managerFixture(t, { workflows: true, scripts: true });
        await manager.getOrCreate(`s-tests-${requestTurn}`, { toolNames: [], ...(requestTurn ? { workflowMilestoneTurn: true } : {}) }, { turnIndex: 0 });
        const definition = calls.at(-1).tools.find(tool => tool.name === "workflow_definition");
        const label = `request turn=${requestTurn}`;
        assert.ok(definition, label);
        const declared = JSON.stringify(definition.parameters);
        assert.equal(definition.parameters.properties.operation.enum.includes("test"), requestTurn, label);
        assert.equal(/"fixtures"|"test_id"/.test(declared), requestTurn, label);
        assert.equal(definition.description.includes("test (only when the user asks you to test it"), requestTurn, label);
        // OF-S2-4 A: a package's author (Agent Smith) tests a definition before it publishes it.
        assert.equal(definition.description.includes("or before you publish it in a package"), requestTurn, label);
        assert.equal(definition.description.includes("Workflow tests do not run here, so there is no test operation"), !requestTurn, label);
        for (const operation of ["list", "read", "save", "start", "card"]) assert.ok(definition.parameters.properties.operation.enum.includes(operation), operation);
        const prompt = JSON.stringify(manager._buildSystemMessage(`s-tests-${requestTurn}`, {
            baseAgentPolicy: { version: "v2", fingerprint: "test", revision: null }, ...(requestTurn ? { workflowMilestoneTurn: true } : {}) }));
        assert.equal(prompt.includes("Testing is optional. Test a revision only when the user asks"), requestTurn, label);
        assert.equal(prompt.includes("or before you publish it in a package; never test on your own"), requestTurn, label);
        assert.equal(prompt.includes(JSON.stringify(WORKFLOW_TESTS_UNAVAILABLE_GUIDANCE).slice(1, -1)), !requestTurn, label);
    }
});

test("agents: the base instructions carry Workflow guidance only with Workflows on; with scripts off they say so", () => {
    const prompt = (workflows, scripts) => {
        const manager = new SessionManager(undefined, null, { frameworkBasePrompt: "Legacy base." });
        manager.workflowScriptsEnabled = scripts;
        manager.workflowsEnabled = workflows;
        return JSON.stringify(manager._buildSystemMessage("session", { baseAgentPolicy: { version: "v2", fingerprint: "test", revision: null } }));
    };
    assert.ok(prompt(true, true).includes("## Workflow Sessions"));
    assert.ok(!prompt(true, true).includes("Script nodes are turned off"));
    assert.ok(prompt(true, false).includes("## Workflow Sessions"));
    assert.ok(prompt(true, false).includes("Script nodes are turned off on this server (PILOTSWARM_WORKFLOW_SCRIPTS)"));
    for (const [workflows, scripts] of [[false, true], [false, false]]) {
        const text = prompt(workflows, scripts);
        assert.ok(!text.includes("## Workflow Sessions"), `workflows=${workflows}, scripts=${scripts}`);
        assert.ok(!/spawn_workflow|update_workflow|read_workflow/.test(text), `no tool is named (workflows=${workflows}, scripts=${scripts})`);
    }
});

test("agents: a stale declaration's handler, and the bridge, answer WORKFLOWS_DISABLED before anything else", () => {
    const managed = read("managed-session.ts");
    // The handler checks the turn boundary, then Workflows off, then everything else (A1, arguments, the bridge).
    for (const [tool, form] of [["spawn_workflow", 'workflowsDisabledRefusal("spawn_workflow", { line: true })'], ["update_workflow", 'workflowsDisabledRefusal("update_workflow")'],
        ["read_workflow", 'workflowsDisabledRefusal("read_workflow")'], ["send_workflow_input", 'workflowsDisabledRefusal("send_workflow_input")']]) {
        const at = managed.indexOf(`defineTool("${tool}", {`, managed.indexOf("const workflowsOff = controlBridge?.workflowsDisabled === true;"));
        assert.ok(at > 0, tool);
        const body = managed.slice(at, managed.indexOf("defineTool(", at + 1));
        const boundary = body.indexOf(`blockedAfterTurnBoundary("${tool}")`);
        const off = body.indexOf(`if (workflowsOff) return ${form};`);
        assert.ok(boundary > 0 && off > boundary, `${tool}: the refusal after the turn boundary`);
        for (const later of ["insideWorkflow", "args?.yaml", "controlBridge?."]) {
            const index = body.indexOf(later, boundary + 1);
            if (index >= 0) assert.ok(index > off, `${tool}: ${later} after the refusal`);
        }
    }
    const proxy = read("session-proxy.ts");
    assert.match(proxy, /\.\.\.\(sessionManager\.workflowsEnabled === false \? \{ workflowsDisabled: true \} : \{\}\),/);
    assert.match(proxy, /spawnWorkflow: async \(args: SpawnWorkflowToolArgs, call\?: \{ toolCallId\?: string \}\) => sessionManager\.workflowsEnabled === false\n\s+\? workflowsDisabledRefusal\("spawn_workflow", \{ line: true \}\)/);
    for (const [method, tool] of [["updateWorkflow", "update_workflow"], ["readWorkflow", "read_workflow"], ["sendWorkflowInput", "send_workflow_input"]]) {
        const at = proxy.indexOf(`${method}: async (args: Record<string, unknown>) => {`);
        assert.ok(at > 0, method);
        assert.match(proxy.slice(at, at + 220), new RegExp(`=> \\{\\n\\s+if \\(sessionManager\\.workflowsEnabled === false\\) return workflowsDisabledRefusal\\("${tool}"\\);`), method);
    }
    // A cancel, done or delete from a session or an operator makes no Workflow lookup while Workflows are off.
    for (const helper of ["operatorCommandApplied", "workflowChildCommandApplied"]) {
        const at = proxy.indexOf(`const ${helper} = async (`);
        assert.ok(at > 0, helper);
        assert.match(proxy.slice(at, at + 400), /\n\s+if \(sessionManager\.workflowsEnabled === false \|\| !catalog\?\.workflowStore\) return false;/, helper);
    }
    // The worker sets it from its option, else the setting.
    assert.match(read("worker.ts"), /this\.sessionManager\.workflowsEnabled = resolveWorkflowsEnabled\(this\.config\.workflows\?\.enabled\);/);
});

/** A management client made without start(); `catalog` is what it reads. */
function managementClient(config, catalog) {
    return Object.assign(Object.create(PilotSwarmManagementClient.prototype), { config, _catalog: catalog, _started: true });
}

/** A catalog any read of which fails the test. */
const UNTOUCHABLE = new Proxy({}, { get: (_target, name) => { throw new Error(`the catalog was read (${String(name)})`); } });

test("the management client: Workflows off advertise only that; readWorkflow and updateWorkflow refuse before any read", async () => {
    const store = { workflowStore: () => ({}) };
    assert.deepEqual(await managementClient({ workflows: false, workflowCommands: { requests: true } }, store).getWorkflowCapabilities(),
        { schema: WORKFLOW_CAPABILITIES_SCHEMA, enabled: false });
    assert.deepEqual(await managementClient({ workflows: true }, store).getWorkflowCapabilities(), workflowCapabilities({ read: true, commands: null }));
    assert.equal((await managementClient({ workflows: true }, store).getWorkflowCapabilities()).enabled, true);
    // No option: the setting decides, off by default.
    await withEnv({}, async () => assert.equal((await managementClient({}, store).getWorkflowCapabilities()).enabled, false));
    await withEnv({ PILOTSWARM_WORKFLOWS: "on" }, async () => assert.equal((await managementClient({}, store).getWorkflowCapabilities()).enabled, true));
    await withEnv({ PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT: "isolated-test-only" }, async () =>
        assert.equal((await managementClient({}, store).getWorkflowCapabilities()).enabled, true));

    const off = managementClient({ workflows: false, workflowCommands: { requests: true } }, UNTOUCHABLE);
    for (const call of [() => off.readWorkflow("wf"), () => off.updateWorkflow("wf", { operation: "pause", operation_id: "op-1" })]) {
        await assert.rejects(call, error => error.code === WORKFLOWS_DISABLED && error.status === 404 && error.message === WORKFLOWS_DISABLED_TEXT);
    }
});

test("the management client: with Workflows off, input, the access check and lifecycle commands read no Workflow", async () => {
    let reads = 0;
    const store = { readWorkflowLineage: async () => { reads += 1; return { sessionId: "c", level: 2, agentRoot: { workflowSessionId: "w" } }; } };
    const catalog = { workflowStore: () => store };
    const off = managementClient({ workflows: false }, catalog);
    // The access check: as for any session, with nothing read.
    assert.deepEqual(await off.getWorkflowInputPolicy("c"), await off.getWorkflowInputPolicy("other"));
    assert.equal((await off.getWorkflowInputPolicy("c")).canSendPrompt, true);
    assert.equal(reads, 0);
    // On, the same lineage is read (the policy's own tests cover what it answers).
    const on = managementClient({ workflows: true }, catalog);
    await on.getWorkflowInputPolicy("c");
    assert.equal(reads, 1);
    // A cancel, done or delete goes to the session as for any other, with no Workflow store applied first.
    const sent = [];
    const lifecycle = Object.assign(managementClient({ workflows: false }, { workflowStore: () => { throw new Error("the workflow store was used"); } }), {
        sendCommand: async (sessionId, command) => { sent.push({ sessionId, cmd: command.cmd }); },
    });
    await lifecycle._sendLifecycleCommand("s1", { cmd: "cancel", id: "c-1", args: { reason: "test" } });
    assert.deepEqual(sent, [{ sessionId: "s1", cmd: "cancel" }]);
});

test("the client: with Workflows off a person's prompt and event cost no Workflow lookup", async () => {
    const client = Object.assign(Object.create(PilotSwarmClient.prototype), { _catalog: { workflowStore: () => ({ marker: true }) } });
    await withEnv({}, () => assert.equal(client._workflowStoreOrNull(), null));
    await withEnv({ PILOTSWARM_WORKFLOWS: "on" }, () => assert.deepEqual(client._workflowStoreOrNull(), { marker: true }));
    await withEnv({ PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT: "isolated-test-only" }, () => assert.deepEqual(client._workflowStoreOrNull(), { marker: true }));
});
