import test from "node:test";
import assert from "node:assert/strict";
import { capabilityRef } from "../../dist/capability-catalog.js";
import { workflowAgentToolOffer } from "../../dist/workflow/agent-tools.js";
import { workflowToolDiagnostics } from "../../dist/workflow/tool-requirements.js";
import { SessionManager } from "../../dist/session-manager.js";

const owner = { provider: "test", subject: "starter" };
const source = {
    id: "tools", name: "shared-fixture", revision: "one", source: "published",
    scope: "shared", owner: { provider: "test", subject: "other-owner" },
    artifacts: [{ kind: "tool", name: "lookup" }],
    tools: new Map([["lookup", { name: "lookup" }]]), mcpServers: {},
};
const binding = {
    owner, agentStepTools: "selections", sourceRevisions: { tools: "one" },
    capabilities: { revision: 1, selections: [{
        sourceId: "tools", sourceRef: capabilityRef("tools", "one", "source"),
        tools: ["lookup"], mcpServers: [],
    }] },
    tools: [{ name: "lookup", schemaHash: "fixture" }], excludedTools: [],
};
const node = { id: "step", type: "agent", invoke: { prompt: "Harmless fixture." } };

test("FB-020 admission offers only exact visible source revisions", () => {
    assert.deepEqual(workflowAgentToolOffer(node, binding, [source], [], {}, null).offered, ["lookup"]);
    for (const candidate of [
        { ...source, revision: "two" },
        { ...source, scope: "user" },
    ]) assert.deepEqual(workflowAgentToolOffer(node, binding, [candidate], [], {}, null).offered, []);
    const staleRef = structuredClone(binding);
    staleRef.capabilities.selections[0].sourceRef = capabilityRef("tools", "old", "source");
    assert.deepEqual(workflowAgentToolOffer(node, staleRef, [source], [], {}, null).offered, []);
});

test("FB-020 audit names a second owner's shared package and the step's own owner", () => {
    const agent = { name: "reader", packageName: "other-agents", packageOwner: source.owner };
    const offer = workflowAgentToolOffer(node, binding, [source], [], {}, agent);
    assert.deepEqual(offer.delegated.agent, {
        name: "reader", package: "other-agents", owner: source.owner,
    });
    assert.equal(offer.delegated.sources[0].ownership, "other_shared");
});

test("FB-020 old bindings delegate nothing while defaults and explicit own MCP methods remain offered", () => {
    const old = { ...binding };
    delete old.agentStepTools;
    assert.deepEqual(workflowAgentToolOffer(node, old, [source], [{ name: "read_facts" }],
        { notes: { tools: ["read_note"] } }, null, ["bash"]).offered,
    ["read_facts", "bash", "notes-read_note"]);
    assert.deepEqual(workflowAgentToolOffer({ ...node, tools: [] }, binding, [source],
        [{ name: "read_facts" }], { notes: { tools: ["read_note"] } }, null, ["bash"]).offered, []);
});

test("FB-020 MCP admission uses the model-facing name, not the config alias", () => {
    const mcpSource = { ...source, mcpServers: { notes: { tools: ["read_note"] } } };
    const mcpBinding = structuredClone(binding);
    mcpBinding.capabilities.selections[0].mcpServers = ["notes"];
    mcpBinding.tools.push({ name: "notes-read_note", namespacedName: "notes/read_note",
        mcpServerName: "notes", mcpToolName: "read_note", schemaHash: "fixture" });
    assert.deepEqual(workflowAgentToolOffer({ ...node, tools: ["notes-read_note"] },
        mcpBinding, [mcpSource], [], {}, null).offered, ["notes-read_note"]);
});

test("FB-020 unknown worker defaults and wildcard own MCP methods warn; positive ceiling misses still refuse", () => {
    const required = { ...node, requiredTools: ["notes-read_note"] };
    const offer = workflowAgentToolOffer(required, null, [], [], { notes: { tools: ["*"] } }, null);
    assert.equal(workflowToolDiagnostics({ nodes: { step: required } }, null, true, { step: offer })[0].code,
        "WORKFLOW_TOOLS_UNCHECKED");
    assert.equal(workflowToolDiagnostics({ nodes: { step: required } }, null, true,
        { step: { ...offer, unchecked: true } })[0].code, "WORKFLOW_TOOLS_UNCHECKED");
    assert.equal(workflowToolDiagnostics({ nodes: { step: { ...required, tools: [] } } }, null, true,
        { step: { ...offer, unchecked: true } })[0].code, "WORKFLOW_TOOL_NOT_GRANTED");
});

test("FB-020 the real manager description includes framework and application defaults", async () => {
    const manager = new SessionManager(undefined, null, {
        frameworkBaseToolNames: ["framework_lookup"], appDefaultToolNames: ["app_lookup"],
    });
    manager.setToolRegistry(new Map(["framework_lookup", "app_lookup"].map(name => [name, { name }])));
    manager.setFactStore({ readFacts: async () => ({ count: 0, facts: [] }) });
    const described = await manager.describeWorkflowAgentTools(node, null, "starter", null);
    assert.ok(described.offered.includes("framework_lookup"));
    assert.ok(described.offered.includes("app_lookup"));
});
