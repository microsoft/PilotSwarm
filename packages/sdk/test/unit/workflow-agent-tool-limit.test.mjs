/**
 * Workflow Simplified stage 2.1c, FU-17: an agent node's tool limit (`tools: none` or a list of tool names).
 * - The compiler takes `tools: none` (no tools but complete_workflow_node) or a list of 1 to 64 distinct tool names; it
 *   refuses anything else in words. The IR has `tools` only when it is set (`[]` for none), and a stored IR keeps it.
 * - The graph (describeWorkflowV2States) says the limit, so the portal and the TUI show it.
 * - A session in the subtree of a state that limits its tools is offered only those (the Copilot session's
 *   availableTools); the state's own chat also keeps complete_workflow_node; another session is offered every tool. A
 *   change of the limit is a new binding (the handle is made again). PilotSwarm's own tools (the SDK `tools`) are cut to the
 *   limit by the session manager: the CLI's availableTools does not cut them (Copilot CLI 1.0.83). The real CLI case is
 *   test/local/workflow-agent-native-always-on.test.js.
 * The runTurn activity reads the limit from the state's run revision (store.readAgentToolLimit, on PostgreSQL in
 * test/local/workflow-v2-agent-tool-limit.test.js).
 *
 * Run: node --test test/unit/workflow-agent-tool-limit.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileWorkflowV2, parseWorkflowIr, WORKFLOW_V2_MILESTONE_IR_VERSION, WORKFLOW_V2_AGENT_TOOLS_MAX } from "../../dist/workflow/v2/compiler.js";
import { describeWorkflowV2States } from "../../dist/workflow/v2/runtime.js";
import { SessionManager, buildBindingFingerprintInput, workflowAgentToolAllowlist, workflowLimitedSdkTools } from "../../dist/session-manager.js";

const OPTIONS = { enableRequests: true, enableAgents: true, enableParallel: true, enableRunLimits: true };
const READ = { maxIrVersion: WORKFLOW_V2_MILESTONE_IR_VERSION };
const yaml = (tools) => `
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: limited, version: "1.0.0" }
initial: analyze
states:
  analyze:
    type: agent
    invoke: { prompt: "Summarize input.stories in three lines." }
    timeoutSeconds: 120${tools === undefined ? "" : `\n    tools: ${tools}`}
    transition: { next: { done: finish } }
  finish: { type: terminal, outcome: succeeded }
`;
const compile = (tools) => compileWorkflowV2(yaml(tools), OPTIONS);
const errors = (compiled) => compiled.diagnostics.filter(item => item.severity === "error");

test("tools: none, a list, or absent; the IR keeps it only when set, and a stored IR keeps it", () => {
    const none = compile("none");
    assert.equal(none.valid, true, JSON.stringify(none.diagnostics));
    assert.deepEqual(none.ir.nodes.analyze.tools, []);
    const listed = compile("[web_fetch, read_facts, \"mcp:github-search_code\"]");
    assert.equal(listed.valid, true, JSON.stringify(listed.diagnostics));
    assert.deepEqual(listed.ir.nodes.analyze.tools, ["web_fetch", "read_facts", "mcp:github-search_code"]);
    // complete_workflow_node is always kept, so naming it adds nothing.
    assert.deepEqual(compile("[complete_workflow_node, read_facts]").ir.nodes.analyze.tools, ["read_facts"]);
    const plain = compile(undefined);
    assert.equal(plain.valid, true);
    assert.equal(Object.hasOwn(plain.ir.nodes.analyze, "tools"), false, "a definition that sets no limit has the IR it had");
    for (const compiled of [none, listed]) {
        assert.deepEqual(parseWorkflowIr(JSON.parse(JSON.stringify(compiled.ir)), READ).nodes.analyze.tools, compiled.ir.nodes.analyze.tools);
    }
    assert.equal(Object.hasOwn(parseWorkflowIr(JSON.parse(JSON.stringify(plain.ir)), READ).nodes.analyze, "tools"), false);
    // A stored IR whose limit is not a list of tool names is refused, never read as no limit.
    const broken = JSON.parse(JSON.stringify(none.ir));
    broken.nodes.analyze.tools = "none";
    assert.throws(() => parseWorkflowIr(broken, READ), /stored IR agent state analyze is invalid/);
});

test("anything else is refused in words", () => {
    const tooMany = `[${Array.from({ length: WORKFLOW_V2_AGENT_TOOLS_MAX + 1 }, (_, index) => `tool_${index}`).join(", ")}]`;
    for (const value of ["all", "[]", "[web_fetch, web_fetch]", "[\"two words\"]", "7", "{ web_fetch: true }", tooMany]) {
        const compiled = compile(value);
        assert.equal(compiled.valid, false, value);
        const [error] = errors(compiled);
        assert.equal(error.code, "WORKFLOW_FIELD_INVALID", value);
        assert.equal(error.path, "states.analyze.tools", value);
        assert.match(error.message, /^tools must be none \(no tools but complete_workflow_node\) or a list of 1 to 64 distinct tool names/, value);
    }
    // Only an agent state takes it.
    const script = compileWorkflowV2(`
apiVersion: pilotswarm.dev/v2-draft
kind: Workflow
metadata: { name: s, version: "1.0.0" }
initial: hold
states:
  hold: { type: wait, seconds: 5, tools: none, transition: { next: { elapsed: done } } }
  done: { type: terminal, outcome: succeeded }
`, OPTIONS);
    assert.equal(script.valid, false);
    assert.ok(errors(script).some(item => item.path.startsWith("states.hold")), JSON.stringify(script.diagnostics));
});

test("the graph says the limit, so the portal and the terminal show it", () => {
    const states = new Map(describeWorkflowV2States(compile("[read_facts]").ir).map(state => [state.id, state]));
    assert.deepEqual(states.get("analyze").tools, ["read_facts"]);
    assert.deepEqual(new Map(describeWorkflowV2States(compile("none").ir).map(state => [state.id, state])).get("analyze").tools, []);
    assert.equal(Object.hasOwn(new Map(describeWorkflowV2States(compile(undefined).ir).map(state => [state.id, state])).get("analyze"), "tools"), false);
});

test("the allowlist: the limit, with complete_workflow_node for the state's own chat; none without a limit; in the binding", () => {
    assert.equal(workflowAgentToolAllowlist({}), null);
    assert.equal(workflowAgentToolAllowlist({ workflowAgentChild: true }), null);
    assert.deepEqual(workflowAgentToolAllowlist({ workflowToolLimit: [] }), []);
    assert.deepEqual(workflowAgentToolAllowlist({ workflowToolLimit: [], workflowAgentChild: true }), ["complete_workflow_node"]);
    assert.deepEqual(workflowAgentToolAllowlist({ workflowToolLimit: ["web_fetch", "read_facts"], workflowAgentChild: true }),
        ["complete_workflow_node", "read_facts", "web_fetch"]);
    const parts = { capabilityFingerprint: 1, baseAgentPolicy: null, sdkSkillDirectories: [], boundAgentName: null, boundAgentSource: null, boundAgentCopy: null,
        mcpServers: {}, excludedTools: [], tools: [] };
    assert.equal(Object.hasOwn(buildBindingFingerprintInput(parts), "availableTools"), false);
    assert.deepEqual(buildBindingFingerprintInput({ ...parts, availableTools: ["read_facts"] }).availableTools, ["read_facts"]);
});

test("PilotSwarm's own tools under a limit: only the ones it names (as name or custom:name); all of them without a limit", () => {
    const tools = ["read_facts", "store_fact", "spawn_agent", "complete_workflow_node"].map(name => ({ name }));
    const kept = (allowlist) => workflowLimitedSdkTools(tools, allowlist).map(tool => tool.name);
    assert.deepEqual(kept(null), ["read_facts", "store_fact", "spawn_agent", "complete_workflow_node"]);
    assert.deepEqual(kept([]), []);
    assert.deepEqual(kept(["complete_workflow_node"]), ["complete_workflow_node"]);
    assert.deepEqual(kept(["complete_workflow_node", "read_facts", "view", "notes-read_note"]), ["read_facts", "complete_workflow_node"]);
    assert.deepEqual(kept(["custom:spawn_agent"]), ["spawn_agent"]);
});

/** A SessionManager whose Copilot transport is stubbed; each handle's config. */
function managerFixture(t) {
    const home = fs.mkdtempSync(join(tmpdir(), "ps-wf-tool-limit-"));
    const configs = [];
    const manager = new SessionManager(undefined, null, {}, home);
    manager.workflowScriptsEnabled = true;
    manager.setFactStore({
        readFacts: async () => ({ count: 0, facts: [] }),
        storeFact: async () => ({ stored: true }),
        deleteFact: async () => ({ deleted: true }),
    });
    const open = config => {
        configs.push(config);
        fs.mkdirSync(join(home, config.sessionId), { recursive: true });
        return { disconnect: async () => {}, rpc: { tasks: { list: async () => ({ tasks: [] }), cancel: async () => ({ cancelled: true }) } } };
    };
    manager.ensureClient = async () => ({
        createSession: async config => open(config),
        resumeSession: async (_id, config) => open(config),
        deleteSession: async () => {},
    });
    t.after(async () => {
        for (const id of [...manager.sessions.keys()]) await manager.dropWarmSession(id);
        fs.rmSync(home, { recursive: true, force: true });
    });
    return { manager, configs };
}

test("a session under a limit is offered only its tools; the state's chat keeps complete_workflow_node; another session every tool", async (t) => {
    const { manager, configs } = managerFixture(t);
    const declared = config => config.tools.map(tool => tool.name).sort();
    await manager.getOrCreate("node-chat", { toolNames: [], workflowInsideWorkflow: true, workflowAgentChild: true, workflowToolLimit: [] }, { turnIndex: 0 });
    assert.deepEqual(configs.at(-1).availableTools, ["complete_workflow_node"]);
    // The CLI's availableTools does not cut PilotSwarm's tools, so they are cut in the declaration too.
    assert.deepEqual(declared(configs.at(-1)), ["complete_workflow_node"]);
    await manager.getOrCreate("sub-agent", { toolNames: [], workflowInsideWorkflow: true, workflowToolLimit: ["read_facts", "spawn_agent"] }, { turnIndex: 0 });
    assert.deepEqual(configs.at(-1).availableTools, ["read_facts", "spawn_agent"]);
    assert.deepEqual(declared(configs.at(-1)), ["read_facts", "spawn_agent"]);
    await manager.getOrCreate("plain", { toolNames: [] }, { turnIndex: 0 });
    assert.equal(Object.hasOwn(configs.at(-1), "availableTools"), false);
    assert.ok(declared(configs.at(-1)).includes("store_fact") && declared(configs.at(-1)).includes("spawn_agent"), "a session without a limit keeps every tool");
    // A later turn without the limit (a state that no longer limits it is a new chat; this checks the flag is not kept).
    const before = configs.length;
    await manager.getOrCreate("node-chat", { toolNames: [], workflowInsideWorkflow: true, workflowAgentChild: true }, { turnIndex: 1 });
    assert.ok(configs.length > before, "a changed limit makes the handle again");
    assert.equal(Object.hasOwn(configs.at(-1), "availableTools"), false);
});
