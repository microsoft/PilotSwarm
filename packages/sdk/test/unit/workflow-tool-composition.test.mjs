import test from "node:test";
import assert from "node:assert/strict";
import { capabilityRef } from "../../dist/capability-catalog.js";
import { compileWorkflow, parseWorkflowIr } from "../../dist/workflow/compiler.js";
import { workflowAgentToolOffer } from "../../dist/workflow/agent-tools.js";

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
