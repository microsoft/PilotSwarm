/**
 * Workflows are always on (owner decision 2026-11-08T08:03Z): there is no switch.
 * - agents: a session manager made with no Workflow setting declares the four workflow tools, scripts on or off, and the
 *   base instructions carry the Workflow guidance; no handler, bridge or spawn path reads a switch;
 * - the management client: the capabilities always say `enabled: true` (kept for an older client); reads, commands, the
 *   access check and lifecycle commands reach the Workflow store;
 * - the client: a person's prompt and event read the Workflow lineage.
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
import { SessionManager } from "../../dist/session-manager.js";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { PilotSwarmClient } from "../../dist/client.js";
import { workflowCapabilities } from "../../dist/workflow/v2/human-commands.js";

const SRC = new URL("../../src/", import.meta.url);
const read = name => fs.readFileSync(new URL(name, SRC), "utf8");
const WORKFLOW_TOOLS = ["workflow_definition", "update_workflow", "read_workflow", "send_workflow_input"];

test("there is no Workflow switch: none of its names is exported", () => {
    for (const name of ["WORKFLOWS_DISABLED", "WORKFLOWS_VARIABLE", "workflowsEnabledFromEnv", "resolveWorkflowsEnabled", "workflowsNotice", "workflowsDisabledError"]) {
        assert.equal(Object.hasOwn(sdk, name), false, `${name} is gone`);
    }
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

test("agents: a session manager made with no Workflow setting declares the four workflow tools, scripts on or off", async (t) => {
    const names = tools => tools.map(tool => tool.name);
    for (const scripts of [false, true]) {
        const { manager, calls } = managerFixture(t, { scripts });
        assert.equal(Object.hasOwn(manager, "workflowsEnabled"), false, "no switch on the session manager");
        await manager.getOrCreate(`s-${scripts}`, { toolNames: [] }, { turnIndex: 0 });
        const got = names(calls.at(-1).tools);
        for (const name of WORKFLOW_TOOLS) assert.ok(got.includes(name), `${name} with scripts=${scripts}`);
        assert.ok(got.includes("spawn_agent"));
    }
});

test("agents (owner 2026-11-08T16:55Z): with scripts on, cron and cron_at keep main's words plus one sentence for a Workflow loop; otherwise main's words", async (t) => {
    const { ManagedSession } = await import("../../dist/managed-session.js");
    const { WORKFLOW_SCHEDULING_HINT } = await import("../../dist/workflow/guidance.js");
    const main = Object.fromEntries(ManagedSession.systemToolDefs().map(tool => [tool.name, tool.description]));
    const described = (tools, name) => tools.find(tool => tool.name === name)?.description;
    for (const [scripts, clockWaits] of [[false, true], [true, false], [true, true]]) {
        const { manager, calls } = managerFixture(t, { scripts });
        await manager.getOrCreate(`s-${scripts}-${clockWaits}`, { toolNames: [], ...(clockWaits ? { workflowMilestoneTurn: true } : {}) }, { turnIndex: 0 });
        const tools = calls.at(-1).tools;
        const label = `scripts=${scripts}, clockWaits=${clockWaits}`;
        for (const name of ["cron", "cron_at"]) {
            assert.equal(described(tools, name), scripts ? `${main[name]}${WORKFLOW_SCHEDULING_HINT}` : main[name], `${name}, ${label}`);
        }
    }
    assert.match(WORKFLOW_SCHEDULING_HINT, /^ For a fixed check a script can do, start one Workflow that loops through a wait state instead: it costs no model turns\.$/);
    assert.ok(!/spawn_workflow/.test(WORKFLOW_SCHEDULING_HINT), "the tool of this stage, not the compat one");
});

// G-4: every turn's host runs a Workflow test, a frozen 1.0.82 turn's included, so every turn declares workflow_definition's test and the guidance teaches it.
test("agents (G-4): every turn declares workflow_definition's test and the guidance teaches it, a frozen 1.0.82 turn's included", async (t) => {
    const guidance = await import("../../dist/workflow/guidance.js");
    assert.equal(Object.hasOwn(guidance, "WORKFLOW_TESTS_UNAVAILABLE_GUIDANCE"), false, "no line says Workflow tests do not run here");
    for (const requestTurn of [false, true]) {
        const { manager, calls } = managerFixture(t, { scripts: true });
        await manager.getOrCreate(`s-tests-${requestTurn}`, { toolNames: [], ...(requestTurn ? { workflowMilestoneTurn: true } : {}) }, { turnIndex: 0 });
        const definition = calls.at(-1).tools.find(tool => tool.name === "workflow_definition");
        const label = `request turn=${requestTurn}`;
        assert.ok(definition, label);
        const declared = JSON.stringify(definition.parameters);
        assert.ok(definition.parameters.properties.operation.enum.includes("test"), label);
        assert.ok(/"fixtures"/.test(declared) && /"test_id"/.test(declared), label);
        // OF-S2-4 A: a package's author (Agent Smith) tests a definition before it publishes it.
        assert.ok(definition.description.includes("test: only when the user asks, or before you publish it in a package."), label);
        for (const operation of ["list", "read", "save", "start", "card"]) assert.ok(definition.parameters.properties.operation.enum.includes(operation), operation);
        const prompt = JSON.stringify(manager._buildSystemMessage(`s-tests-${requestTurn}`, {
            baseAgentPolicy: { version: "v2", fingerprint: "test", revision: null }, ...(requestTurn ? { workflowMilestoneTurn: true } : {}) }));
        assert.ok(prompt.includes("Test a revision only when the user asks, or before you publish it in a package"), label);
        assert.ok(!/tests do not run here/i.test(prompt), label);
    }
});

test("agents: the base instructions always carry the Workflow guidance; with scripts explicitly off (they are on by default) they say so", () => {
    const prompt = scripts => {
        const manager = new SessionManager(undefined, null, { frameworkBasePrompt: "Legacy base." });
        manager.workflowScriptsEnabled = scripts;
        return JSON.stringify(manager._buildSystemMessage("session", { baseAgentPolicy: { version: "v2", fingerprint: "test", revision: null } }));
    };
    assert.ok(prompt(true).includes("## Workflows"));
    assert.ok(!prompt(true).includes("Script nodes are off"));
    assert.ok(prompt(false).includes("## Workflows"));
    assert.ok(prompt(false).includes("Script nodes are off on this server (PILOTSWARM_WORKFLOW_SCRIPTS=0)"));
    // A session manager made with no setting runs scripts (owner 2026-11-08T15:45Z): its base has no scripts-off line.
    const fresh = new SessionManager(undefined, null, { frameworkBasePrompt: "Legacy base." });
    assert.equal(fresh.workflowScriptsEnabled, true);
    assert.ok(!JSON.stringify(fresh._buildSystemMessage("session", { baseAgentPolicy: { version: "v2", fingerprint: "test", revision: null } }))
        .includes("Script nodes are off"));
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

test("the management client: the capabilities always say enabled; reads and commands reach the catalog", async () => {
    const store = { workflowStore: () => ({}) };
    const capabilities = await managementClient({}, store).getWorkflowCapabilities();
    assert.deepEqual(capabilities, workflowCapabilities({ read: true, commands: null }));
    assert.equal(capabilities.enabled, true);
    // A read goes to the catalog: never refused for a switch.
    let touched = 0;
    const catalog = new Proxy({}, { get: () => { touched += 1; throw Object.assign(new Error("the catalog was read"), { code: "CATALOG_READ" }); } });
    const client = managementClient({ workflowCommands: {} }, catalog);
    await assert.rejects(client.readWorkflow("wf"), error => error.code !== "WORKFLOWS_DISABLED");
    assert.ok(touched > 0, "the read reached the catalog");
});

test("the management client: the access check reads the Workflow lineage", async () => {
    let reads = 0;
    const store = { readWorkflowLineage: async () => { reads += 1; return null; } };
    const client = managementClient({}, { workflowStore: () => store });
    await client.getWorkflowInputPolicy("c");
    assert.equal(reads, 1);
});

test("the client: a person's prompt and event read the Workflow lineage", async () => {
    const client = Object.assign(Object.create(PilotSwarmClient.prototype), { _catalog: { workflowStore: () => ({ marker: true }) } });
    assert.deepEqual(client._workflowStoreOrNull(), { marker: true });
});
