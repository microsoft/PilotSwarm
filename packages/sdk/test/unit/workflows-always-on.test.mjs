/**
 * Workflows are always on (owner decision 2026-11-08T08:03Z): the PILOTSWARM_WORKFLOWS switch (stage 2.0) is gone.
 * - the retired setting: a deployment that still sets it, to any value, is ignored with one warning per process;
 * - agents: a session manager made with no Workflow setting declares the five workflow tools, scripts on or off, and the
 *   base instructions carry the Workflow guidance; no handler, bridge or spawn path reads a switch;
 * - the management client: the capabilities always say `enabled: true` (kept for an older client); reads, commands, the
 *   access check and lifecycle commands reach the Workflow store, whatever PILOTSWARM_WORKFLOWS says;
 * - the client: a person's prompt and event read the Workflow lineage, whatever PILOTSWARM_WORKFLOWS says.
 * Script nodes (PILOTSWARM_WORKFLOW_SCRIPTS) and test mode (PILOTSWARM_WORKFLOW_TEST_MODE) keep their own settings.
 *
 * Run: node --test test/unit/workflows-always-on.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sdk from "../../dist/index.js";
import { RETIRED_WORKFLOWS_WARNING, resetRetiredWorkflowsSettingWarning, warnRetiredWorkflowsSetting } from "../../dist/workflow/retired-workflows-setting.js";
import { SessionManager } from "../../dist/session-manager.js";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { PilotSwarmClient } from "../../dist/client.js";
import { workflowCapabilities } from "../../dist/workflow/v2/human-commands.js";

const SRC = new URL("../../src/", import.meta.url);
const read = name => fs.readFileSync(new URL(name, SRC), "utf8");
const WORKFLOW_TOOLS = ["workflow_definition", "spawn_workflow", "update_workflow", "read_workflow", "send_workflow_input"];

/** Runs `fn` with PILOTSWARM_WORKFLOWS as given (undefined: unset), then puts it back. */
async function withRetired(value, fn) {
    const before = process.env.PILOTSWARM_WORKFLOWS;
    if (value === undefined) delete process.env.PILOTSWARM_WORKFLOWS;
    else process.env.PILOTSWARM_WORKFLOWS = value;
    try {
        return await fn();
    } finally {
        if (before === undefined) delete process.env.PILOTSWARM_WORKFLOWS;
        else process.env.PILOTSWARM_WORKFLOWS = before;
    }
}

test("the retired setting: any value is ignored with one warning per process; unset or empty, no warning", () => {
    assert.equal(sdk.RETIRED_WORKFLOWS_VARIABLE, "PILOTSWARM_WORKFLOWS");
    assert.equal(RETIRED_WORKFLOWS_WARNING, "PILOTSWARM_WORKFLOWS is ignored: Workflows are always on. Remove it from the deployment's settings.");
    for (const name of ["WORKFLOWS_DISABLED", "WORKFLOWS_VARIABLE", "workflowsEnabledFromEnv", "resolveWorkflowsEnabled", "workflowsNotice", "workflowsDisabledError"]) {
        assert.equal(Object.hasOwn(sdk, name), false, `${name} is gone`);
    }
    for (const value of [undefined, "", "  "]) {
        resetRetiredWorkflowsSettingWarning();
        const said = [];
        assert.equal(warnRetiredWorkflowsSetting(value === undefined ? {} : { PILOTSWARM_WORKFLOWS: value }, line => said.push(line)), false);
        assert.deepEqual(said, [], JSON.stringify(value));
    }
    for (const value of ["off", "on", "yes"]) {
        resetRetiredWorkflowsSettingWarning();
        const said = [];
        assert.equal(warnRetiredWorkflowsSetting({ PILOTSWARM_WORKFLOWS: value }, line => said.push(line)), true, value);
        assert.equal(warnRetiredWorkflowsSetting({ PILOTSWARM_WORKFLOWS: value }, line => said.push(line)), false, "once per process");
        assert.deepEqual(said, [RETIRED_WORKFLOWS_WARNING], value);
    }
    resetRetiredWorkflowsSettingWarning();
    // The worker, the portal and the MCP server warn at start; none reads the setting otherwise.
    assert.match(read("worker.ts"), /\n\s+warnRetiredWorkflowsSetting\(\);\n/);
    assert.match(fs.readFileSync(new URL("../../../app/web/server.js", import.meta.url), "utf8"), /warnRetiredWorkflowsSetting\(process\.env,/);
    assert.match(fs.readFileSync(new URL("../../../app/mcp/bin/pilotswarm-mcp.ts", import.meta.url), "utf8"), /warnRetiredWorkflowsSetting\(process\.env,/);
});

/** A SessionManager whose Copilot transport is stubbed (the workflow-milestone-tools pattern): each handle's declarations. */
function managerFixture(t, { scripts = true } = {}) {
    const home = fs.mkdtempSync(join(tmpdir(), "ps-workflows-always-on-"));
    const calls = [];
    const manager = new SessionManager(undefined, null, {}, home);
    manager.workflowScriptsEnabled = scripts;
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

test("agents: a session manager made with no Workflow setting declares the five workflow tools, scripts on or off, PILOTSWARM_WORKFLOWS=off ignored", async (t) => {
    const names = tools => tools.map(tool => tool.name);
    for (const [scripts, retired] of [[false, undefined], [true, undefined], [true, "off"]]) {
        await withRetired(retired, async () => {
            const { manager, calls } = managerFixture(t, { scripts });
            assert.equal(Object.hasOwn(manager, "workflowsEnabled"), false, "no switch on the session manager");
            await manager.getOrCreate(`s-${scripts}-${retired}`, { toolNames: [] }, { turnIndex: 0 });
            const got = names(calls.at(-1).tools);
            for (const name of WORKFLOW_TOOLS) assert.ok(got.includes(name), `${name} with scripts=${scripts}, PILOTSWARM_WORKFLOWS=${retired}`);
            assert.ok(got.includes("spawn_agent"));
        });
    }
});

test("agents (stage 2.5, PR 235 4b0ac3ca): with scripts on, cron sends a check a script can do to one Workflow; cron_at too where clock waits run; otherwise main's words", async (t) => {
    const { ManagedSession } = await import("../../dist/managed-session.js");
    const { WORKFLOW_AWARE_CRON_DESCRIPTION, WORKFLOW_AWARE_CRON_AT_DESCRIPTION } = await import("../../dist/workflow/guidance.js");
    const main = Object.fromEntries(ManagedSession.systemToolDefs().map(tool => [tool.name, tool.description]));
    const described = (tools, name) => tools.find(tool => tool.name === name)?.description;
    for (const [scripts, clockWaits, cron, cronAt] of [
        [false, true, main.cron, main.cron_at],
        [true, false, WORKFLOW_AWARE_CRON_DESCRIPTION, main.cron_at],
        [true, true, WORKFLOW_AWARE_CRON_DESCRIPTION, WORKFLOW_AWARE_CRON_AT_DESCRIPTION],
    ]) {
        const { manager, calls } = managerFixture(t, { scripts });
        await manager.getOrCreate(`s-${scripts}-${clockWaits}`, { toolNames: [], ...(clockWaits ? { workflowMilestoneTurn: true } : {}) }, { turnIndex: 0 });
        const tools = calls.at(-1).tools;
        const label = `scripts=${scripts}, clockWaits=${clockWaits}`;
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
        const { manager, calls } = managerFixture(t, { scripts: true });
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

test("agents: the base instructions always carry the Workflow guidance; with scripts off they say so", () => {
    const prompt = scripts => {
        const manager = new SessionManager(undefined, null, { frameworkBasePrompt: "Legacy base." });
        manager.workflowScriptsEnabled = scripts;
        return JSON.stringify(manager._buildSystemMessage("session", { baseAgentPolicy: { version: "v2", fingerprint: "test", revision: null } }));
    };
    assert.ok(prompt(true).includes("## Workflow Sessions"));
    assert.ok(!prompt(true).includes("Script nodes are turned off"));
    assert.ok(prompt(false).includes("## Workflow Sessions"));
    assert.ok(prompt(false).includes("Script nodes are turned off on this server (PILOTSWARM_WORKFLOW_SCRIPTS)"));
});

test("agents: no handler, bridge, lifecycle helper or spawn path reads a Workflows switch", () => {
    for (const name of ["managed-session.ts", "session-proxy.ts", "session-manager.ts", "management-client.ts", "client.ts", "worker.ts", "types.ts",
        "child-budget.ts", "workflow/v2/human-commands.ts"]) {
        const text = read(name);
        assert.ok(!/workflowsEnabled|workflowsDisabled|workflowsOn\b|WORKFLOWS_DISABLED|workflows-switch/.test(text), name);
    }
    assert.equal(fs.existsSync(new URL("workflow/workflows-switch.ts", SRC)), false);
});

// Review AOS-F2 and AOU-F2 (always-on review, low): the operator text counts five tools, and exempts system children from
// the budget, never a calling system agent (child-budget.ts: the count leaves out system children; admission still refuses).
test("docs: the five Workflow tools, and the budget exempts system children only", () => {
    const doc = fs.readFileSync(new URL("../../../../docs/developer/building/workflow-sessions.md", import.meta.url), "utf8");
    assert.ok(!/The four tools/.test(doc));
    assert.match(doc, /The five tools, the guidance and the screens are there whether or not the\s+workers run scripts\./);
    assert.ok(!/a system agent's `spawn_agent` is not budgeted/.test(doc));
    assert.match(doc, /System children are not counted[\s\S]{0,120}a calling system agent is not exempt/);
});

/** A management client made without start(); `catalog` is what it reads. */
function managementClient(config, catalog) {
    return Object.assign(Object.create(PilotSwarmManagementClient.prototype), { config, _catalog: catalog, _started: true });
}

test("the management client: the capabilities always say enabled; reads and commands reach the catalog, PILOTSWARM_WORKFLOWS=off ignored", async () => {
    const store = { workflowStore: () => ({}) };
    for (const retired of [undefined, "off"]) {
        await withRetired(retired, async () => {
            const capabilities = await managementClient({}, store).getWorkflowCapabilities();
            assert.deepEqual(capabilities, workflowCapabilities({ read: true, commands: null }));
            assert.equal(capabilities.enabled, true);
            // A read goes to the catalog: never refused for a switch.
            let touched = 0;
            const catalog = new Proxy({}, { get: () => { touched += 1; throw Object.assign(new Error("the catalog was read"), { code: "CATALOG_READ" }); } });
            const client = managementClient({ workflowCommands: { requests: true } }, catalog);
            await assert.rejects(client.readWorkflow("wf"), error => error.code !== "WORKFLOWS_DISABLED");
            assert.ok(touched > 0, "the read reached the catalog");
        });
    }
});

test("the management client: the access check reads the Workflow lineage, PILOTSWARM_WORKFLOWS=off ignored", async () => {
    await withRetired("off", async () => {
        let reads = 0;
        const store = { readWorkflowLineage: async () => { reads += 1; return null; } };
        const client = managementClient({}, { workflowStore: () => store });
        await client.getWorkflowInputPolicy("c");
        assert.equal(reads, 1);
    });
});

test("the client: a person's prompt and event read the Workflow lineage, whatever PILOTSWARM_WORKFLOWS says", async () => {
    const client = Object.assign(Object.create(PilotSwarmClient.prototype), { _catalog: { workflowStore: () => ({ marker: true }) } });
    for (const retired of [undefined, "off", "on"]) {
        await withRetired(retired, () => assert.deepEqual(client._workflowStoreOrNull(), { marker: true }, String(retired)));
    }
});
