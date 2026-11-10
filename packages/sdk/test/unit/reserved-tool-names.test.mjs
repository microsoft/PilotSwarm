import test from "node:test";
import assert from "node:assert/strict";
import { findReservedPackageToolName, WORKFLOW_TURN_TOOL_NAMES } from "../../dist/reserved-tool-names.js";
import { createFactTools } from "../../dist/facts-tools.js";
import { createGraphTools } from "../../dist/graph-tools.js";
import { createInspectTools } from "../../dist/inspect-tools.js";
import { FEATURE_OPERATION_SPECS } from "../../dist/feature-tools.js";
import { PROVIDER_TOOL_NAMES } from "../../dist/provider-tools.js";
import { ManagedSession } from "../../dist/managed-session.js";
import { COMPLETE_WORKFLOW_NODE_TOOL } from "../../dist/workflow/v2/agent-node-service.js";
import { RESPOND_SESSION_REQUEST_TOOL } from "../../dist/workflow/v2/request-service.js";

test("Copilot-native and PilotSwarm control names are reserved", () => {
    assert.equal(findReservedPackageToolName(["domain_tool", "read_agent"], [], []), "read_agent");
    assert.equal(findReservedPackageToolName(["spawn_agent"], ["spawn_agent"], []), "spawn_agent");
});

test("deployment tool names are reserved", () => {
    assert.equal(findReservedPackageToolName(["domain_tool"], [], ["domain_tool"]), "domain_tool");
});

test("domain-specific package names remain available", () => {
    assert.equal(findReservedPackageToolName(["domain_catalog"], ["spawn_agent"], ["app_tool"]), null);
});

test("runtime-discovered Copilot names are reserved before the first turn", () => {
    for (const name of ["web_search", "catalog_search"]) {
        assert.equal(findReservedPackageToolName([name], [], []), name);
    }
});

test("the workflow turn tools are reserved whatever a session declares", () => {
    // The same names as the tools a 1.0.83 turn declares (their modules are not imported by the reserved list).
    assert.deepEqual([...WORKFLOW_TURN_TOOL_NAMES].sort(), [COMPLETE_WORKFLOW_NODE_TOOL, RESPOND_SESSION_REQUEST_TOOL].sort());
    // The worker checks package tools against an ordinary session's declarations, which never have them.
    const ordinary = [...ManagedSession.systemToolDefs(), ...ManagedSession.subAgentToolDefs()].map(tool => tool.name);
    const declared = ManagedSession.subAgentToolDefs({ workflowMilestone: true, workflowAgentChild: true }).map(tool => tool.name);
    for (const name of WORKFLOW_TURN_TOOL_NAMES) {
        assert.ok(!ordinary.includes(name), `an ordinary session does not declare ${name}`);
        assert.ok(declared.includes(name), `an agent state's child declares ${name}`);
        assert.equal(findReservedPackageToolName(["domain_tool", name], ordinary, []), name, `a package tool named ${name}`);
        // A capability export is checked against no platform list at all.
        assert.equal(findReservedPackageToolName([name], [], []), name, `a capability tool named ${name}`);
    }
    // Names that only resemble them stay available.
    assert.equal(findReservedPackageToolName(["complete_workflow", "complete_workflow_node_v2", "respond_request"], ordinary, []), null);
});

test("role- and store-gated platform bundles cannot be shadowed by packages", () => {
    // Only declarations are constructed: a dependency call here is a bug.
    const inert = new Proxy({}, { get: () => () => { throw new Error("tool factory performed I/O"); } });
    const emitted = new Set();
    for (const agentIdentity of [undefined, "agent-tuner", "agent-manager", "facts-manager", "resourcemgr"]) {
        const options = { agentIdentity, factStore: inert, graphStore: inert, catalog: inert, duroxideClient: inert,
            enhancedFactStore: { capabilities: { search: true, embedder: true } }, isCrawler: true };
        for (const factory of [createFactTools, createGraphTools, createInspectTools]) {
            for (const tool of factory(options)) emitted.add(tool.name);
        }
    }
    for (const name of [...PROVIDER_TOOL_NAMES, ...FEATURE_OPERATION_SPECS.map(spec => spec.name)]) emitted.add(name);
    assert.ok(emitted.has("graph_stats"));
    assert.ok(emitted.has("set_cluster_feature_flag"));
    assert.ok(emitted.has("facts_search"));
    for (const name of emitted) {
        assert.equal(findReservedPackageToolName([name], [], []), name,
            `package tool ${name} escaped quarantine when its privileged bundle was absent`);
    }
});
