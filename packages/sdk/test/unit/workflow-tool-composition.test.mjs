import test from "node:test";
import assert from "node:assert/strict";
import { capabilityRef } from "../../dist/capability-catalog.js";
import { compileWorkflow, parseWorkflowIr } from "../../dist/workflow/compiler.js";
import { workflowAgentToolOffer } from "../../dist/workflow/agent-tools.js";
import * as agentTools from "../../dist/workflow/agent-tools.js";
import { SessionManager, defineTool } from "../../dist/index.js";
import { WorkflowStore } from "../../dist/workflow/store.js";
import { readWorkflowToolBinding, workflowAgentStepBinding, workflowToolGrant } from "../../dist/workflow/tool-policy.js";

const owner = { provider: "test", subject: "parent" };
const source = {
    id: "fixture-package", name: "fixture-tools", revision: "one", source: "published",
    scope: "shared", owner,
    artifacts: [{ kind: "tool", name: "pkg_tool_a" }, { kind: "tool", name: "pkg_tool_b" }],
    tools: new Map(["pkg_tool_a", "pkg_tool_b"].map(name => [name, { name }])),
    mcpServers: { notes: { tools: ["read", "write"] } },
};
const binding = {
    owner, agentStepTools: "selections", sourceRevisions: { [source.id]: source.revision },
    capabilities: { revision: 1, selections: [{
        sourceId: source.id, sourceRef: capabilityRef(source.id, source.revision, "source"),
        tools: ["pkg_tool_a", "pkg_tool_b"], mcpServers: ["notes"],
    }] },
    tools: [
        ...["pkg_tool_a", "pkg_tool_b"].map(name => ({ name, schemaHash: "fixture" })),
        ...["read", "write"].map(method => ({
            name: `notes-${method}`, mcpServerName: "notes", mcpToolName: method, schemaHash: "fixture",
        })),
    ],
    excludedTools: [],
};
const inline = { id: "step", type: "agent", invoke: { prompt: "Harmless fixture." } };
const agent = { name: "reader", tools: ["declared_tool"] };
const named = { ...inline, invoke: { agent: { name: agent.name, package: null, version: null } } };
const offer = (node, definition = null) =>
    workflowAgentToolOffer(node, binding, [source], [{ name: "read_facts" }, ...(definition ? [{ name: "declared_tool" }] : [])],
        {}, definition);
const yaml = grant => `
apiVersion: pilotswarm.dev/v1
kind: Workflow
metadata: { name: composition, version: "1.0.0" }
initial: step
states:
  step:
    type: agent
    invoke: { prompt: "Harmless fixture." }
    timeoutSeconds: 120${grant === undefined ? "" : `\n    grant: ${grant}`}
    transition: { next: { done: finish } }
  finish: { type: terminal, outcome: succeeded }
`;

test("composition grants compile and survive a serialized IR round trip without changing omitted fields", () => {
    for (const [text, expected] of [
        ["all", "all"], ["none", "none"],
        ["[pkg_tool_a, 'package:fixture-tools', 'mcp:notes']", ["pkg_tool_a", "package:fixture-tools", "mcp:notes"]],
    ]) {
        const compiled = compileWorkflow(yaml(text));
        assert.equal(compiled.valid, true, JSON.stringify(compiled.diagnostics));
        assert.deepEqual(compiled.ir.nodes.step.grant, expected);
        assert.deepEqual(parseWorkflowIr(JSON.parse(JSON.stringify(compiled.ir))).nodes.step.grant, expected);
    }
    const omitted = compileWorkflow(yaml(undefined));
    assert.equal(omitted.valid, true);
    assert.equal(Object.hasOwn(omitted.ir.nodes.step, "grant"), false);
});

test("invalid grants and exclude are refused, not silently dropped from stored IR", () => {
    for (const invalid of ["false", "7", "[]", "[pkg_tool_a, pkg_tool_a]", "['package:']", "['mcp:']", "['two words']"]) {
        const compiled = compileWorkflow(yaml(invalid));
        assert.equal(compiled.valid, false, invalid);
        assert.ok(compiled.diagnostics.some(item => item.path === "states.step.grant" && item.severity === "error"), invalid);
    }
    const compiled = compileWorkflow(yaml(undefined).replace("timeoutSeconds: 120", "timeoutSeconds: 120\n    exclude: [pkg_tool_a]"));
    assert.equal(compiled.valid, false);
    for (const invalid of [false, [], ["pkg_tool_a", "pkg_tool_a"], ["package:"], "other"]) {
        const ir = JSON.parse(JSON.stringify(compileWorkflow(yaml(undefined)).ir));
        ir.nodes.step.grant = invalid;
        assert.throws(() => parseWorkflowIr(ir), /stored IR agent state step is invalid/);
    }
});

test("inline agents default to all; named agents default to no parent grant and keep their declared and role tools", () => {
    assert.deepEqual(offer(inline).offered, ["read_facts", "pkg_tool_a", "pkg_tool_b", "notes-read", "notes-write"]);
    const offered = offer(named, agent);
    assert.deepEqual(offered.offered, ["read_facts", "declared_tool"]);
    assert.deepEqual(offered.delegated.sources, []);
});

test("explicit grant all opts a named agent in; none narrows an inline grant without removing role tools", () => {
    assert.deepEqual(offer({ ...named, grant: "all" }, agent).offered,
        ["read_facts", "declared_tool", "pkg_tool_a", "pkg_tool_b", "notes-read", "notes-write"]);
    assert.deepEqual(offer({ ...inline, grant: "none" }).offered, ["read_facts"]);
});

test("tool, package and MCP selectors hand down only the parent's captured capability tools", () => {
    assert.deepEqual(offer({ ...inline, grant: ["pkg_tool_b"] }).offered, ["read_facts", "pkg_tool_b"]);
    assert.deepEqual(offer({ ...inline, grant: ["mcp:notes"] }).offered, ["read_facts", "notes-read", "notes-write"]);
    assert.deepEqual(offer({ ...inline, grant: ["notes-read"] }).offered, ["read_facts", "notes-read"]);
    assert.deepEqual(offer({ ...inline, grant: ["package:fixture-tools"] }).offered,
        ["read_facts", "pkg_tool_a", "pkg_tool_b", "notes-read", "notes-write"]);
    const narrowed = structuredClone(binding);
    narrowed.capabilities.selections[0].tools = ["pkg_tool_a"];
    narrowed.tools = narrowed.tools.filter(tool => tool.name !== "pkg_tool_b");
    assert.deepEqual(workflowAgentToolOffer({ ...inline, grant: ["package:fixture-tools"] },
        narrowed, [source], [], {}, null).offered, ["pkg_tool_a", "notes-read", "notes-write"]);
});

test("a grant never activates an unheld tool, package, MCP server or platform tool", () => {
    for (const selector of ["missing_tool", "package:unheld", "mcp:unheld", "read_facts"]) {
        assert.throws(() => offer({ ...inline, grant: [selector] }), /grant.*parent|parent.*hold/i, selector);
    }
});

test("the existing tools ceiling applies after grant selection, including MCP methods and declared tools", () => {
    assert.deepEqual(offer({ ...named, grant: "all", tools: ["notes-read"] }, agent).offered, ["notes-read"]);
    assert.deepEqual(offer({ ...named, grant: "all", tools: [] }, agent).offered, []);
    const compiled = compileWorkflow(yaml("[pkg_tool_a]").replace("timeoutSeconds: 120",
        "timeoutSeconds: 120\n    tools: [pkg_tool_a]\n    requiredTools: [pkg_tool_b]"));
    assert.equal(compiled.valid, false, "required tools outside the ceiling refuse the definition");
});

test("the grant includes a parent's held deployment capability without granting role tools", () => {
    const deployment = { ...source, id: "static:registered-tools", name: "deployment", source: "static", revision: "deploy-one",
        tools: new Map([["deploy_tool", { name: "deploy_tool" }]]), mcpServers: {} };
    const held = { ...binding, tools: [...binding.tools, { name: "deploy_tool", schemaHash: "fixture" }],
        sourceRevisions: { ...binding.sourceRevisions, [deployment.id]: deployment.revision },
        toolSources: { deploy_tool: deployment.id } };
    assert.deepEqual(workflowAgentToolOffer({ ...inline, grant: ["deploy_tool"] }, held, [source, deployment], [], {}, null)
        .offered, ["deploy_tool"]);
    assert.throws(() => workflowAgentToolOffer({ ...inline, grant: ["read_facts"] }, held,
        [source, deployment], [{ name: "read_facts" }], {}, null), /parent.*hold|grant.*parent/i);
});

test("a named step pins declared foreign-package tools independently of its default-none parent grant", () => {
    const foreign = { ...source, id: "foreign-package", name: "foreign-tools", revision: "foreign-one",
        tools: new Map([["declared_tool", { name: "declared_tool" }]]), mcpServers: {} };
    const snapshot = agentTools.captureWorkflowAgentStepBinding(named, binding, [source, foreign], [
        { sourceId: foreign.id, tool: { name: "declared_tool", schemaHash: "declared-schema" } },
    ]);
    assert.deepEqual(snapshot.tools.map(tool => tool.name), ["declared_tool"]);
    assert.deepEqual(snapshot.capabilities.selections.map(selection => [selection.sourceId, selection.tools]),
        [[foreign.id, ["declared_tool"]]]);
    assert.equal(snapshot.sourceRevisions[foreign.id], "foreign-one");
    assert.equal(snapshot.toolSources.declared_tool, foreign.id);
    assert.equal(binding.sourceRevisions[foreign.id], undefined, "script bindings are not widened");
});

test("the immutable state snapshot applies the ceiling to granted and declared capabilities", () => {
    const before = structuredClone(binding);
    const snapshot = agentTools.captureWorkflowAgentStepBinding({ ...named, grant: "all", tools: ["pkg_tool_a"] },
        binding, [source], [{ sourceId: source.id, tool: { name: "pkg_tool_b", schemaHash: "fixture" } }]);
    assert.deepEqual(snapshot.tools.map(tool => tool.name), ["pkg_tool_a"]);
    assert.deepEqual(snapshot.capabilities.selections[0].tools, ["pkg_tool_a"]);
    assert.deepEqual(binding, before);
    const persisted = JSON.parse(JSON.stringify(snapshot));
    binding.capabilities.selections[0].tools.push("added_later");
    try {
        assert.deepEqual(persisted.capabilities.selections[0].tools, ["pkg_tool_a"]);
    } finally {
        binding.capabilities.selections[0].tools.pop();
    }
});

test("a declared tool never satisfies a selector for an unheld parent capability", () => {
    const foreign = { ...source, id: "foreign-package", name: "foreign-tools",
        tools: new Map([["declared_tool", { name: "declared_tool" }]]), mcpServers: {} };
    assert.throws(() => agentTools.captureWorkflowAgentStepBinding({ ...named, grant: ["declared_tool"] },
        binding, [source, foreign], [{ sourceId: foreign.id, tool: { name: "declared_tool", schemaHash: "fixture" } }]),
        /grant.*parent|parent.*hold/i);
});

test("the real manager resolves declared foreign tools only for the composed agent step", async () => {
    const exported = defineTool("declared_tool", { description: "Harmless fixture.",
        parameters: { type: "object", properties: {} }, handler: async () => ({ ok: true }) });
    const foreign = { ...source, id: "foreign-package", name: "foreign-tools", revision: "foreign-one",
        tools: new Map([[exported.name, exported]]), mcpServers: {} };
    const definition = { ...agent, packageId: "reader-package", packageScope: "shared" };
    const manager = new SessionManager(undefined, null, {
        getCapabilitySources: () => [source, foreign],
        agentPromptLookup: { reader: { prompt: "Harmless fixture.", toolNames: ["declared_tool"],
            packageId: "reader-package", packageScope: "shared" } },
    });
    manager.setToolRegistry(new Map([[exported.name, exported]]), {
        byPackage: new Map([[foreign.id, foreign.tools]]), staticNames: new Set(),
    });
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
    assert.throws(() => manager._resolveTools(undefined, { toolNames: ["declared_tool"] }, "reader-package"),
        error => error.code === "PACKAGE_TOOL_REQUIRES_BOUND_AGENT");
    const described = await manager.describeWorkflowAgentTools(named, binding, "parent", definition);
    assert.ok(described.offered.includes("declared_tool"));
    assert.equal(described.binding.sourceRevisions[foreign.id], "foreign-one");
    assert.equal(described.binding.toolSources.declared_tool, foreign.id);
    assert.ok(!described.offered.includes("pkg_tool_a"), "the named default remains none");
    assert.throws(() => manager._resolveTools(undefined, { toolNames: ["declared_tool"] }, "reader-package"),
        error => error.code === "PACKAGE_TOOL_REQUIRES_BOUND_AGENT", "ordinary spawning is unchanged");
});

test("state snapshots survive persistence, refuse malformed or missing scopes, and never widen scripts", () => {
    const snapshot = agentTools.captureWorkflowAgentStepBinding({ ...inline, grant: ["pkg_tool_a"] }, binding, [source], []);
    const root = { ...binding, policy: "node-parent-tools-v1", parentSessionId: "parent",
        config: {}, boundAgentFingerprint: "fixture", agentStepBindings: { step: snapshot } };
    const restored = readWorkflowToolBinding(JSON.parse(JSON.stringify(root)));
    const scoped = workflowAgentStepBinding(restored, "step");
    assert.deepEqual(scoped.tools.map(tool => tool.name), ["pkg_tool_a"]);
    assert.equal(scoped.agentStepStateId, "step");
    assert.deepEqual(restored.tools, binding.tools);
    assert.throws(() => workflowAgentStepBinding(restored, "other"), /No captured tool binding/);
    assert.throws(() => readWorkflowToolBinding({ ...root, agentStepBindings: { step: {} } }), /Invalid persisted/);
    assert.throws(() => readWorkflowToolBinding({ ...root, agentStepBindings: { step: { ...snapshot, owner } } }),
        /Invalid persisted/);
});

test("a lost package does not re-resolve a captured grant or hide its typed loss, and visit authority stays fenced", async () => {
    const otherTool = defineTool("other_tool", { description: "Harmless fixture.",
        parameters: { type: "object", properties: {} }, handler: async () => ({ ok: true }) });
    const other = { ...source, id: "static:registered-tools", name: "deployment", source: "static", revision: "deploy-one",
        tools: new Map([[otherTool.name, otherTool]]), mcpServers: {} };
    const held = { ...binding, tools: [...binding.tools, workflowToolGrant({ name: otherTool.name, input_schema: otherTool.parameters })],
        sourceRevisions: { ...binding.sourceRevisions, [other.id]: other.revision },
        packagePins: { [source.id]: { package: source.name, version: "1.0.0", ownership: "owned" } },
        toolSources: { ...Object.fromEntries(binding.tools.map(tool => [tool.name, source.id])), other_tool: other.id } };
    const state = { ...inline, grant: [`package:${source.name}`, "other_tool"] };
    const snapshot = agentTools.captureWorkflowAgentStepBinding(state, held, [source, other], []);
    const root = { ...held, policy: "node-parent-tools-v1", parentSessionId: "parent",
        config: {}, boundAgentFingerprint: "fixture", agentStepBindings: { step: snapshot } };
    let visitState = "pending";
    const rows = {
        parent: { sessionId: "parent", owner, state: "idle" },
        wf: { sessionId: "wf", parentSessionId: "parent", sessionKind: "workflow", owner },
        child: { sessionId: "child", parentSessionId: "wf", owner },
    };
    const manager = new SessionManager(undefined, null, {
        getCapabilitySources: () => [other],
        getWorkflowCapabilitySnapshot: async captured => ({
            sources: [other], labels: { packagePins: held.packagePins, toolSources: captured.toolSources },
            pins: [{ packageId: source.id, package: source.name, version: "1.0.0", revision: "one",
                ownership: "owned", state: "unavailable", reason: "deleted" }],
        }),
    });
    manager.setSessionCatalog({
        getSession: async id => rows[id] ?? null,
        getSessionCreationConfig: async () => ({ workflowToolBinding: root }),
        workflowStore: () => ({
            readAgentInvocation: async () => ({ childSessionId: "child", workflowSessionId: "wf" }),
            readNodeExecution: async () => ({ nodeId: "step", state: visitState }),
        }),
    });
    const context = { workflowSessionId: "wf", nodeExecutionId: "visit" };
    const scoped = await manager.readWorkflowAgentBinding("child", context);
    assert.deepEqual(scoped.tools, snapshot.tools, "open reads captured tool names, not live package selectors");
    assert.ok(agentTools.workflowAgentToolOffer(state, scoped, [other], [], {}, null).offered.includes("other_tool"));
    assert.doesNotThrow(() => agentTools.workflowAgentGrantedToolNames(held, [other], [`package:${source.name}`]),
        "legacy selector checks use the captured package label when the source is lost");
    await manager.authorizeWorkflowTools("wf", scoped, "other_tool");
    await assert.rejects(manager.authorizeWorkflowTools("wf", scoped, "pkg_tool_a"),
        error => error.name === "WorkflowPackageToolError" && error.details.reason === "deleted");
    await assert.rejects(manager.authorizeWorkflowTools("wf", { ...scoped, tools: [] }, "other_tool"),
        /Workflow tool binding changed/);
    visitState = "completed";
    await assert.rejects(manager.readWorkflowAgentBinding("child", context), /visit is no longer available/);
    visitState = "pending";
    rows.parent.state = "completed";
    await assert.rejects(manager.readWorkflowAgentBinding("child", context), /parent authority is no longer available/);
});

test("pre-composition named-step bindings retain all while new Starts use a captured default-none snapshot", async () => {
    const store = Object.create(WorkflowStore.prototype);
    store.pool = { query: async () => ({ rows: [{ node_id: "step", workflow_session_id: "wf", revision: 1, ir_sha256: "fixture" }] }) };
    store.t = { nodes: "nodes", runs: "runs" };
    store.readRevisionIr = async () => ({ nodes: { step: named } });
    assert.equal(await store.readAgentToolGrant("visit"), "all");
    assert.deepEqual(agentTools.captureWorkflowAgentStepBinding(named, binding, [source], []).tools, []);
});

test("legacy all means activated selections only; newly captured steps may additionally grant held bound and deployment tools", () => {
    for (const provider of [source, { ...source, id: "static:registered-tools", source: "static" }]) {
        const legacy = { ...binding, capabilities: { revision: 1, selections: [] },
            tools: [{ name: "pkg_tool_a", schemaHash: "fixture" }],
            sourceRevisions: { [provider.id]: provider.revision }, toolSources: { pkg_tool_a: provider.id } };
        assert.deepEqual([...agentTools.workflowAgentGrantedToolNames(legacy, [provider], "all")], []);
        assert.deepEqual(agentTools.workflowAgentSelections(legacy, [provider], [], {}, null, null, new Set(["pkg_tool_a"])), []);
        assert.deepEqual(agentTools.captureWorkflowAgentStepBinding({ ...inline, grant: "all" }, legacy, [provider], [])
            .tools.map(tool => tool.name), ["pkg_tool_a"], "new capture still supports the signed-off all default");
    }
});
