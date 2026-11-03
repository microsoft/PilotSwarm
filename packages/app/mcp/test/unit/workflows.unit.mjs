// Unit test: update_workflow, a person's workflow command over MCP (Workflow v2, INACTIVE), and the workflow support
// get_capabilities and the pilotswarm://capabilities resource describe (design 04 "Advertise capability/version in
// bootstrap", D11; R26).
//
// The tool is registered only when the server context enables workflow
// commands (test-only); it sends { session_id, command } to the management
// client's updateWorkflow and answers its receipt; every refusal with a code
// (an invalid command, the subtree denial, a 501 while the deployment has it
// off) answers in one JSON shape with its code, status and details.
//
// The descriptor carries the deployment's workflow support exactly as its bootstrap advertises it: the management
// client's own getWorkflowCapabilities (direct mode: this process's configuration, the answer its server advertises;
// web mode: the server's bootstrap), null from a host that advertises none or cannot be asked; and, beside it, the
// workflow tools this server registers, so a client sees where they differ.
//
// No DB, no SDK client connection: `mgmt` is a fake, or the SDK's own getter over a stand-in. Run after `npm run build:mcp`.
import assert from "node:assert/strict";
import { PilotSwarmManagementClient, WebPilotSwarmManagementClient } from "pilotswarm-sdk";
import { registerWorkflowTools } from "../../dist/src/tools/workflows.js";
import { registerCapabilityTools } from "../../dist/src/tools/capabilities.js";
import { registerCapabilityResources } from "../../dist/src/resources/capabilities.js";

const SID = "a7f23cda-5cfd-4f0e-aff1-d6b0400b8da5";

function toolsWith(ctx) {
    const handlers = new Map();
    const server = { registerTool: (name, _spec, handler) => { handlers.set(name, handler); } };
    registerWorkflowTools(server, ctx);
    return handlers;
}

// 1. Absent unless the context enables it.
assert.equal(toolsWith({ mgmt: {} }).has("update_workflow"), false, "absent by default");
assert.equal(toolsWith({ mgmt: {}, workflowCommands: false }).has("update_workflow"), false, "absent when off");

// 2. The command goes to the management client as it is; the receipt is the answer.
{
    const calls = [];
    const tool = toolsWith({ workflowCommands: true, mgmt: {
        updateWorkflow: async (sessionId, command, ...rest) => { calls.push([sessionId, command, rest.length]); return { operation: "pause", runId: "r1", status: "paused" }; },
    } }).get("update_workflow");
    const result = await tool({ session_id: SID, command: { operation: "pause", operation_id: "p-1" } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { operation: "pause", runId: "r1", status: "paused" });
    assert.deepEqual(calls, [[SID, { operation: "pause", operation_id: "p-1" }, 0]], "no actor is sent: the client stamps it");
}

// 3. Refusals with a code: one JSON shape, with status and details.
for (const [error, expected] of [
    [Object.assign(new Error("Session x runs a workflow state for workflow w: people cannot change its definition, inputs, runs or tests."),
        { code: "WORKFLOW_HUMAN_INPUT_DENIED", status: 403, details: { sessionId: SID, action: "workflow", controllingSessionId: "P" } }),
        { code: "WORKFLOW_HUMAN_INPUT_DENIED", status: 403, details: { sessionId: SID, action: "workflow", controllingSessionId: "P" } }],
    [Object.assign(new Error("This deployment does not take workflow commands from people yet."), { code: "WORKFLOW_COMMANDS_UNAVAILABLE", status: 501 }),
        { code: "WORKFLOW_COMMANDS_UNAVAILABLE", status: 501 }],
    [Object.assign(new Error("Workflow inputs do not match inputs.schema."), { code: "WORKFLOW_INPUT_INVALID", status: 422, details: [{ path: "$.since", message: "required" }] }),
        { code: "WORKFLOW_INPUT_INVALID", status: 422, details: [{ path: "$.since", message: "required" }] }],
]) {
    const tool = toolsWith({ workflowCommands: true, mgmt: { updateWorkflow: async () => { throw error; } } }).get("update_workflow");
    const result = await tool({ session_id: SID, command: { operation: "set_vars", operation_id: "k-1" } });
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), { error: error.message, session_id: SID, ...expected });
}

// 4. A bare 403 (the portal's session gate) and an error without a code keep the standard answers.
{
    const forbidden = toolsWith({ workflowCommands: true, mgmt: { updateWorkflow: async () => {
        throw Object.assign(new Error("Only the session owner or an admin can do this."), { code: "FORBIDDEN", status: 403 });
    } } }).get("update_workflow");
    const denied = await forbidden({ session_id: SID, command: { operation: "pause", operation_id: "p-2" } });
    assert.equal(denied.isError, true);
    assert.deepEqual(JSON.parse(denied.content[0].text), { error: "Only the session owner or an admin can do this.", status: 403, code: "FORBIDDEN" });
    const plain = toolsWith({ workflowCommands: true, mgmt: { updateWorkflow: async () => { throw new Error("boom"); } } }).get("update_workflow");
    const failed = await plain({ session_id: SID, command: { operation: "pause", operation_id: "p-3" } });
    assert.equal(failed.content[0].text, "Error: boom");
}

console.log("✅ update_workflow: registration gate, receipt and refusal shapes");

// 5. The descriptor: the deployment's workflow support exactly as its bootstrap advertises it, and this server's workflow tools.
function capabilityCtx(mgmt, { workflowCommands = false, webMode = false } = {}) {
    return { mgmt, workflowCommands, webMode, admin: false, api: null, web: null, enhancedFacts: null, graph: null, models: null,
        skills: [], registeredAgents: [] };
}

/** What get_capabilities and the pilotswarm://capabilities resource answer for `ctx`. */
async function describedBy(ctx) {
    const tools = new Map();
    registerCapabilityTools({ registerTool: (name, _spec, handler) => { tools.set(name, handler); } }, ctx);
    let readResource = null;
    registerCapabilityResources({ registerResource: (_name, _uri, _meta, handler) => { readResource = handler; } }, ctx);
    const answer = await tools.get("get_capabilities")({});
    assert.equal(answer.isError, undefined, answer.content?.[0]?.text);
    const resource = await readResource(new URL("pilotswarm://capabilities"));
    return { tool: JSON.parse(answer.content[0].text), resource: JSON.parse(resource.contents[0].text) };
}

/** A direct-mode management client as a deployment configures it (`config`): a workflow store, and the SDK's own getter. */
const directClient = (config = {}) => ({
    _catalog: { workflowStore: () => ({}) },
    config,
    getWorkflowCapabilities() { return PilotSwarmManagementClient.prototype.getWorkflowCapabilities.call(this); },
});
/** The SDK's web-mode management client over a server whose bootstrap is `bootstrap`. */
const webClient = (bootstrap) => new WebPilotSwarmManagementClient({ api: { getBootstrap: async () => bootstrap } });

// 5a. Default off, as every deployment is configured today: version 2 reads, a person's commands refused (501), no tool.
{
    const mgmt = directClient();
    const advertised = await mgmt.getWorkflowCapabilities();
    assert.deepEqual(advertised.v2.commands, { available: false, refusal: { code: "WORKFLOW_COMMANDS_UNAVAILABLE", status: 501 } });
    assert.equal(advertised.v2.read, true);
    const { tool, resource } = await describedBy(capabilityCtx(mgmt));
    assert.deepEqual(tool.workflows, advertised, "the management client's own answer, which a bootstrap carries");
    assert.deepEqual(resource.workflows, advertised);
    assert.deepEqual(tool.workflow_tools, { read: false, commands: false });
    assert.deepEqual(resource.workflow_tools, { read: false, commands: false });
    assert.equal(toolsWith({ mgmt }).has("update_workflow"), false);
}

// 5b. The test-only option: the controller version the runs start at and the operations a person may send, and the tool.
for (const [requests, controllerVersion, stop] of [[false, "1.8.0", false], [true, "1.9.0", true]]) {
    const mgmt = directClient({ workflowCommands: { requests } });
    const advertised = await mgmt.getWorkflowCapabilities();
    const { tool, resource } = await describedBy(capabilityCtx(mgmt, { workflowCommands: true }));
    assert.deepEqual(tool.workflows, advertised);
    assert.deepEqual(resource.workflows, advertised);
    assert.equal(tool.workflows.v2.commands.available, true);
    assert.equal(tool.workflows.v2.commands.controllerVersion, controllerVersion);
    assert.equal(tool.workflows.v2.commands.operations.includes("stop"), stop);
    assert.deepEqual(tool.workflow_tools, { read: false, commands: true });
    assert.equal(toolsWith({ mgmt, workflowCommands: true }).has("update_workflow"), true);
}

// 5c. Web mode: the server's bootstrap through the SDK's web client, said as it is. Where this server and the deployment
//     differ (update_workflow registered here while the deployment refuses commands; reads on there, no read tool here),
//     the descriptor shows both; nothing is merged or inferred.
{
    const advertised = {
        schema: 1,
        v2: { apiVersion: "pilotswarm.dev/v2-draft", read: true, create: false, input: false,
            commands: { available: false, refusal: { code: "WORKFLOW_COMMANDS_UNAVAILABLE", status: 501 } } },
        legacyCreate: { workflowVersion: 1, draft: false },
    };
    const { tool, resource } = await describedBy(capabilityCtx(webClient({ ok: true, workflows: advertised }), { workflowCommands: true, webMode: true }));
    assert.equal(tool.mode, "web");
    assert.deepEqual(tool.workflows, advertised);
    assert.deepEqual(resource.workflows, advertised);
    assert.deepEqual(tool.workflow_tools, { read: false, commands: true });
    assert.equal(tool.workflows.v2.commands.available, false);
    assert.equal(tool.workflows.v2.read, true);
}

// 5d. An older host advertises none, and a host that cannot be asked now gives none: null, and the rest still answers.
for (const mgmt of [
    webClient({ ok: true }),
    webClient(null),
    {},
    { getWorkflowCapabilities: async () => { throw new Error("bootstrap unavailable"); } },
    { getWorkflowCapabilities: async () => ["not", "an", "advertisement"] },
]) {
    const { tool, resource } = await describedBy(capabilityCtx(mgmt, { webMode: true }));
    assert.equal(tool.workflows, null);
    assert.equal(resource.workflows, null);
    assert.equal(tool.mode, "web");
    assert.deepEqual(tool.workflow_tools, { read: false, commands: false });
}

console.log("✅ get_capabilities and the capabilities resource: the bootstrap's workflow advertisement, default off, test-only, web, older host");
