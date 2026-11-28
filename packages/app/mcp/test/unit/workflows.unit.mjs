// Unit test: read_workflow, a person's workflow read over MCP (always registered: the view, a section's next page, one
// execution's whole value), update_workflow, a person's workflow command over MCP (Workflow, INACTIVE), and the
// workflow support get_capabilities and the pilotswarm://capabilities resource describe (design 04 "Advertise
// capability/version in bootstrap", D11; R01, R26).
//
// update_workflow is registered when the server context enables workflow commands (every server's context does, unless a
// test creates it with workflowCommands: null); it sends { session_id, command } to the management
// client's updateWorkflow and answers its receipt; every refusal with a code
// (an invalid command, the subtree denial, a 501 while the deployment has it
// off) answers in one JSON shape with its code, status and details. read_workflow refuses in the same shape.
//
// The descriptor carries the deployment's workflow support exactly as its bootstrap advertises it: the management
// client's own getWorkflowCapabilities (direct mode: this process's configuration, the answer its server advertises;
// web mode: the server's bootstrap), null only from a host that advertises none (no getter, or a null answer); a host
// that cannot be asked, or whose answer is not an advertisement, answers an error; and, beside it, the workflow tools
// this server registers, so a client sees where they differ.
//
// No DB, no SDK client connection: `mgmt` is a fake, or the SDK's own getter over a stand-in. Run after `npm run build:mcp`.
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PilotSwarmManagementClient, WebPilotSwarmManagementClient } from "pilotswarm-sdk";
import { registerWorkflowTools } from "../../dist/src/tools/workflows.js";
import { registerCapabilityTools } from "../../dist/src/tools/capabilities.js";
import { registerCapabilityResources } from "../../dist/src/resources/capabilities.js";
import * as context from "../../dist/src/context.js";
import { readFileSync } from "node:fs";

// Workflows are always on (owner 2026-11-08T08:03Z): read_workflow is always registered.

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
assert.equal(toolsWith({ mgmt: {} }).has("workflow_definition"), false, "workflow_definition absent by default");
assert.equal(toolsWith({ mgmt: {} }).has("send_workflow_input"), false, "send_workflow_input absent by default");
// Always discovery/read/skills/session-for-workflow; command, definition, and input tools only with workflowCommands: true.
assert.deepEqual(
    [...toolsWith({ mgmt: {} }).keys()].sort(),
    ["create_session_for_workflow", "list_creatable_workflows", "read_workflow", "read_workflow_skill"],
    "always-registered workflow tools",
);
assert.deepEqual(
    [...toolsWith({ mgmt: {}, workflowCommands: true }).keys()].sort(),
    ["create_session_for_workflow", "list_creatable_workflows", "read_workflow", "read_workflow_skill", "send_workflow_input", "update_workflow", "workflow_definition"],
    "all workflow tools with workflowCommands",
);

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
    [Object.assign(new Error("Session x runs a step of workflow w: people cannot change its definition, inputs, runs or tests."),
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

// 5. Review SF-2: the session a command comes from is passed on, so the client refuses a definition operation from a
//    session inside a Workflow. A server started for one session (PILOTSWARM_ORIGINATING_SESSION_ID, the context's
//    originatingSessionId) passes that session, whatever the argument says.
{
    const calls = [];
    const updateWorkflow = async (sessionId, command, ...rest) => { calls.push(rest); return { ok: true }; };
    const loose = toolsWith({ workflowCommands: true, mgmt: { updateWorkflow } }).get("update_workflow");
    await loose({ session_id: SID, command: { operation: "publish", operation_id: "o-1" }, originating_session_id: "node-owner" });
    const bound = toolsWith({ workflowCommands: true, originatingSessionId: "bound-owner", mgmt: { updateWorkflow } }).get("update_workflow");
    await bound({ session_id: SID, command: { operation: "publish", operation_id: "o-2" } });
    await bound({ session_id: SID, command: { operation: "publish", operation_id: "o-3" }, originating_session_id: "other" });
    assert.deepEqual(calls, [[{ originatingSessionId: "node-owner" }], [{ originatingSessionId: "bound-owner" }], [{ originatingSessionId: "bound-owner" }]]);
    const { originatingSessionIdFromEnv } = await import("../../dist/src/context.js");
    assert.equal(originatingSessionIdFromEnv({}), null);
    assert.equal(originatingSessionIdFromEnv({ PILOTSWARM_ORIGINATING_SESSION_ID: "  " }), null);
    assert.equal(originatingSessionIdFromEnv({ PILOTSWARM_ORIGINATING_SESSION_ID: " s-1 " }), "s-1");
}

console.log("✅ update_workflow: registration gate, receipt and refusal shapes, and the session a command comes from");

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

// 5a. Default off, as every deployment is configured today: reads, a person's commands refused (501), no tool.
{
    const mgmt = directClient();
    const advertised = await mgmt.getWorkflowCapabilities();
    assert.deepEqual(advertised.commands, { available: false, refusal: { code: "WORKFLOW_COMMANDS_UNAVAILABLE", status: 501 } });
    assert.equal(advertised.read, true);
    const { tool, resource } = await describedBy(capabilityCtx(mgmt));
    assert.deepEqual(tool.workflows, advertised, "the management client's own answer, which a bootstrap carries");
    assert.deepEqual(resource.workflows, advertised);
    assert.deepEqual(tool.workflow_tools, { read: true, catalog: true, session_for_workflow: true, skills: true, commands: false, definitions: false, input: false });
    assert.deepEqual(resource.workflow_tools, { read: true, catalog: true, session_for_workflow: true, skills: true, commands: false, definitions: false, input: false });
    assert.equal(toolsWith({ mgmt }).has("update_workflow"), false);
}

// 5b. A person's commands: the controller version the runs start at and the operations a person may send, and the tool.
for (const [workflowCommands, controllerVersion, stop] of [[{}, "1.3.0", true]]) {
    const mgmt = directClient({ workflowCommands });
    const advertised = await mgmt.getWorkflowCapabilities();
    const { tool, resource } = await describedBy(capabilityCtx(mgmt, { workflowCommands: true }));
    assert.deepEqual(tool.workflows, advertised);
    assert.deepEqual(resource.workflows, advertised);
    assert.equal(tool.workflows.commands.available, true);
    assert.equal(tool.workflows.commands.controllerVersion, controllerVersion);
    assert.equal(tool.workflows.commands.operations.includes("stop"), stop);
    assert.deepEqual(tool.workflow_tools, { read: true, catalog: true, session_for_workflow: true, skills: true, commands: true, definitions: true, input: true });
    assert.equal(toolsWith({ mgmt, workflowCommands: true }).has("update_workflow"), true);
}

// 5c. Web mode: the server's bootstrap through the SDK's web client, said as it is. Where this server and the deployment
//     differ (update_workflow registered here while the deployment refuses commands), the descriptor shows both;
//     nothing is merged or inferred; workflow_tools.input fails closed unless advert.input === true.
{
    const advertised = {
        schema: 1,
        apiVersion: "pilotswarm.dev/v1", read: true, create: false, input: false,
        commands: { available: false, refusal: { code: "WORKFLOW_COMMANDS_UNAVAILABLE", status: 501 } },
    };
    const { tool, resource } = await describedBy(capabilityCtx(webClient({ ok: true, workflows: advertised }), { workflowCommands: true, webMode: true }));
    assert.equal(tool.mode, "web");
    assert.deepEqual(tool.workflows, advertised);
    assert.deepEqual(resource.workflows, advertised);
    assert.deepEqual(tool.workflow_tools, { read: true, catalog: true, session_for_workflow: true, skills: true, commands: true, definitions: true, input: false });
    assert.equal(tool.workflows.commands.available, false);
    assert.equal(tool.workflows.read, true);
}

// 5d. An older host advertises none: null, and the rest still answers. A host whose getter answers null is an older one too.
for (const mgmt of [
    webClient({ ok: true }),
    webClient({ ok: true, workflows: null }),
    webClient(null),
    {},
    { getWorkflowCapabilities: async () => null },
    // Undefined is no advertisement either (tester r2 M3 open point, decided: absent, as null).
    { getWorkflowCapabilities: async () => undefined },
]) {
    const { tool, resource } = await describedBy(capabilityCtx(mgmt, { webMode: true }));
    assert.equal(tool.workflows, null);
    assert.equal(resource.workflows, null);
    assert.equal(tool.mode, "web");
    assert.deepEqual(tool.workflow_tools, { read: true, catalog: true, session_for_workflow: true, skills: true, commands: false, definitions: false, input: false });
}

// 5e. A host that cannot be asked now, or whose answer is not an advertisement, is not an older host: get_capabilities
//     answers the error (its standard error result) and the capabilities resource read rejects; nothing says null.
for (const [mgmt, message] of [
    [{ getWorkflowCapabilities: async () => { throw new Error("bootstrap unavailable"); } }, /bootstrap unavailable/],
    [{ getWorkflowCapabilities: async () => ["not", "an", "advertisement"] }, /The workflow advertisement is a list, not an object/],
    [{ getWorkflowCapabilities: async () => "read" }, /The workflow advertisement is a string, not an object/],
    [webClient({ ok: true, workflows: ["read"] }), /bootstrap advertises workflows as a list/],
    [new WebPilotSwarmManagementClient({ api: { getBootstrap: async () => { throw Object.assign(new Error("HTTP 503"), { status: 503 }); } } }), /HTTP 503/],
]) {
    const ctx = capabilityCtx(mgmt, { webMode: true });
    const tools = new Map();
    registerCapabilityTools({ registerTool: (name, _spec, handler) => { tools.set(name, handler); } }, ctx);
    const answer = await tools.get("get_capabilities")({});
    assert.equal(answer.isError, true, answer.content?.[0]?.text);
    assert.match(answer.content[0].text, message);
    let readResource = null;
    registerCapabilityResources({ registerResource: (_name, _uri, _meta, handler) => { readResource = handler; } }, ctx);
    await assert.rejects(readResource(new URL("pilotswarm://capabilities")), message);
    // A malformed answer keeps its exact code on the rejection (tester r2 M3 C4): never a null in its place.
    if (/not an object/.test(String(message))) {
        await assert.rejects(readResource(new URL("pilotswarm://capabilities")), error => error?.code === "WORKFLOW_CAPABILITIES_MALFORMED");
    }
}

console.log("✅ get_capabilities and the capabilities resource: the bootstrap's workflow advertisement, default off, test-only, web, older host, failures");

{
    const run = { runId: "run", createdAt: "2026-01-01T00:00:00Z", finishedAt: null };
    const view = { workflowId: SID, run, runs: [run] };
    const tools = toolsWith({ mgmt: { readWorkflow: async () => view } });
    assert.deepEqual(JSON.parse((await tools.get("read_workflow")({ session_id: SID })).content[0].text), view);
}

// 6. read_workflow: always registered; the read goes to the management client as given (only the arguments given), its
//    answer is the read's; a refusal with a code answers in update_workflow's JSON shape.
{
    const calls = [];
    const page = { workflowId: SID, runId: "r1", section: "inbox", order: "newest_first", limit: 5, items: [], nextCursor: null };
    const tools = toolsWith({ mgmt: { readWorkflow: async (...args) => { calls.push(args); return page; } } });
    assert.equal(tools.has("read_workflow"), true, "registered without the test-only option");
    assert.equal(tools.has("update_workflow"), false);
    const read = tools.get("read_workflow");
    const cursor = { v: 1, workflowId: SID, runId: "r1", section: "inbox", order: "newest_first", after: { seq: "9" } };
    assert.deepEqual(JSON.parse((await read({ session_id: SID })).content[0].text), page);
    await read({ session_id: SID, run_id: "r1", cursor, limit: 5 });
    await read({ session_id: SID, execution_id: "nx-1" });
    await read({ session_id: SID, run_id: "r1", kv_revision: 3, kv_key: "a" });
    await read({ session_id: SID, agent_versions: true });
    await read({ session_id: SID, definition_revision: 2 });
    await read({ session_id: SID, step_input: { state: "review", input: { pr: { source: "run_input", name: "pr" } } } });
    assert.deepEqual(calls, [[SID, {}], [SID, { runId: "r1", cursor, limit: 5 }], [SID, { executionId: "nx-1" }], [SID, { runId: "r1", kvRevision: 3, kvKey: "a" }],
        [SID, { agentVersions: true }], [SID, { definitionRevision: 2 }],
        [SID, { stepInput: { state: "review", input: { pr: { source: "run_input", name: "pr" } } } }]]);
    for (const [error, expected] of [
        [Object.assign(new Error("This cursor is for another workflow."), { code: "WORKFLOW_CURSOR_INVALID", status: 400 }),
            { code: "WORKFLOW_CURSOR_INVALID", status: 400 }],
        [Object.assign(new Error("Execution nx-9 is not a node execution of run r1."), { code: "EXECUTION_NOT_FOUND", status: 404 }),
            { code: "EXECUTION_NOT_FOUND", status: 404 }],
        [Object.assign(new Error("limit must be an integer from 1 to 200."), { code: "WORKFLOW_READ_INVALID", status: 400 }),
            { code: "WORKFLOW_READ_INVALID", status: 400 }],
    ]) {
        const refused = await toolsWith({ mgmt: { readWorkflow: async () => { throw error; } } }).get("read_workflow")({ session_id: SID, cursor });
        assert.equal(refused.isError, true);
        assert.deepEqual(JSON.parse(refused.content[0].text), { error: error.message, session_id: SID, ...expected });
    }
    // The portal's not-found privacy answers its code and status as any refusal does; a bare 403 keeps the standard answer,
    // and an error without a code too.
    const hidden = await toolsWith({ mgmt: { readWorkflow: async () => { throw Object.assign(new Error("Session not found."), { code: "NOT_FOUND", status: 404 }); } } })
        .get("read_workflow")({ session_id: SID });
    assert.deepEqual(JSON.parse(hidden.content[0].text), { error: "Session not found.", session_id: SID, code: "NOT_FOUND", status: 404 });
    const forbidden = await toolsWith({ mgmt: { readWorkflow: async () => { throw Object.assign(new Error("Forbidden"), { code: "FORBIDDEN", status: 403 }); } } })
        .get("read_workflow")({ session_id: SID });
    assert.deepEqual(JSON.parse(forbidden.content[0].text), { error: "The server refused this call (HTTP 403) and gave no reason.", status: 403, code: "FORBIDDEN" });
    const plain = await toolsWith({ mgmt: { readWorkflow: async () => { throw new Error("boom"); } } }).get("read_workflow")({ session_id: SID });
    assert.equal(plain.content[0].text, "Error: boom");
}

console.log("✅ read_workflow: always registered, arguments as given, the read's answer and refusal shapes");

// 7. (Adapted from the independent test design 090ad919-r2, M0-M2.) update_workflow forwards a repeated delivery unchanged
//    and keeps the server's replay marker (the SDK decides idempotency; MCP neither de-duplicates nor rewrites), and maps
//    refusals generically: the codes below are arbitrary on purpose, no product code is claimed.
{
    const updateWith = updateWorkflow => toolsWith({ workflowCommands: true, mgmt: { updateWorkflow } }).get("update_workflow");
    // M0: only an option exactly true registers the command/definition tools (discovery/read/skills are always there).
    for (const workflowCommands of ["true", 1, undefined]) {
        const tools = toolsWith({ workflowCommands, mgmt: {} });
        assert.equal(tools.has("update_workflow"), false, String(workflowCommands));
        assert.equal(tools.has("workflow_definition"), false, String(workflowCommands));
        assert.deepEqual(
            [...tools.keys()].sort(),
            ["create_session_for_workflow", "list_creatable_workflows", "read_workflow", "read_workflow_skill"],
            String(workflowCommands),
        );
    }
    // M1: a duplicate delivery is forwarded unchanged; the receipt text is the server's, byte for byte.
    const seen = new Map();
    const calls = [];
    const tool = updateWith(async (sessionId, command) => {
        calls.push([sessionId, structuredClone(command)]);
        const first = !seen.has(command.operation_id);
        if (first) seen.set(command.operation_id, { operation: command.operation, operationId: command.operation_id, runId: "r1" });
        return { ...seen.get(command.operation_id), replayed: !first };
    });
    const command = { operation: "pause", operation_id: "dup-1" };
    const a = await tool({ session_id: SID, command });
    const b = await tool({ session_id: SID, command });
    assert.equal(a.isError, undefined);
    assert.equal(b.isError, undefined);
    assert.equal(calls.length, 2, "no client-side de-duplication");
    assert.deepEqual(calls[0], [SID, command]);
    assert.deepEqual(calls[1], calls[0], "the second delivery is the same command, unchanged");
    assert.equal(a.content[0].text, JSON.stringify({ operation: "pause", operationId: "dup-1", runId: "r1", replayed: false }, null, 2));
    assert.equal(JSON.parse(b.content[0].text).replayed, true, "the server's replay marker is not dropped");
    assert.equal(JSON.parse((await tool({ session_id: SID, command: { operation: "pause", operation_id: "dup-2" } })).content[0].text).replayed, false);
    // M2: the generic refusal mapping.
    const refusedWith = async error => updateWith(async () => { throw error; })({ session_id: SID, command: { operation: "set_vars", operation_id: "k-9" } });
    const coded = await refusedWith(Object.assign(new Error("refused: x"), { code: "ANY_CODED_REFUSAL", status: 409, details: { expected: 3, current: 4 } }));
    assert.equal(coded.isError, true);
    assert.deepEqual(JSON.parse(coded.content[0].text), { error: "refused: x", code: "ANY_CODED_REFUSAL", session_id: SID, status: 409, details: { expected: 3, current: 4 } });
    // A status that is not an integer and null details are omitted, never sent as null.
    assert.deepEqual(JSON.parse((await refusedWith(Object.assign(new Error("refused: y"), { code: "OTHER_CODE", status: "409", details: null }))).content[0].text),
        { error: "refused: y", code: "OTHER_CODE", session_id: SID });
    // A coded 403 that is not FORBIDDEN keeps the coded shape (as a human-input denial does).
    assert.deepEqual(JSON.parse((await refusedWith(Object.assign(new Error("people cannot send it commands"), { code: "SOME_DENIAL", status: 403 }))).content[0].text),
        { error: "people cannot send it commands", code: "SOME_DENIAL", session_id: SID, status: 403 });
    // FORBIDDEN 403 goes to the standard answer: its reason kept, no session_id added; a bare one says it gave no reason.
    assert.deepEqual(JSON.parse((await refusedWith(Object.assign(new Error("Only the owner may command this workflow."), { code: "FORBIDDEN", status: 403 }))).content[0].text),
        { error: "Only the owner may command this workflow.", status: 403, code: "FORBIDDEN" });
    assert.deepEqual(JSON.parse((await refusedWith(Object.assign(new Error("Forbidden"), { code: "FORBIDDEN", status: 403 }))).content[0].text),
        { error: "The server refused this call (HTTP 403) and gave no reason.", status: 403, code: "FORBIDDEN" });
    // An uncoded failure, or a code that is not a string, is plain text: never a guessed code.
    const uncoded = await refusedWith(Object.assign(new Error("socket hang up"), { status: 502 }));
    assert.equal(uncoded.isError, true);
    assert.equal(uncoded.content[0].text, "Error: socket hang up");
    assert.equal((await refusedWith(Object.assign(new Error("numeric code"), { code: 7 }))).content[0].text, "Error: numeric code");
}

console.log("✅ update_workflow: exact registration gate, duplicate delivery forwarded unchanged, generic refusal mapping (tester r2 M0-M2)");

// 8. Every MCP server registers update_workflow and, in direct mode, takes a person's commands on the full engine; only
//    `workflowCommands: null` (a test) leaves them off. No environment variable decides it.
assert.equal("workflowContextOptionsFromEnv" in context, false, "no export reads an environment switch");
const contextSource = readFileSync(new URL("../../src/context.ts", import.meta.url), "utf8");
assert.match(contextSource, /workflowCommands: opts\.workflowCommands !== null,/);
assert.doesNotMatch(contextSource, /sessionStartVersion|_startSessionsAt/);
console.log("✅ every server registers update_workflow unless a test passes null");

// 9. Workflow test mode is hidden (Workflow Simplified, spec 16): update_workflow names stop and no test operation or
//    argument unless test mode is on (the context's own value, or this process's PILOTSWARM_WORKFLOW_TEST_MODE=on).
{
    const descriptions = ctx => {
        const specs = new Map();
        registerWorkflowTools({ registerTool: (name, spec) => { specs.set(name, spec); } }, ctx);
        return specs.get("update_workflow").description;
    };
    const flag = process.env.PILOTSWARM_WORKFLOW_TEST_MODE;
    delete process.env.PILOTSWARM_WORKFLOW_TEST_MODE;
    try {
        for (const off of [descriptions({ workflowCommands: true, mgmt: {} }), descriptions({ workflowCommands: true, workflowTestMode: false, mgmt: {} })]) {
            for (const word of ["test_respond", "test_advance", "agent_mode", "fixtures", "interception_id", " test,", "replace_definition", "publish_and_start", "publish", "approval_respond"]) assert.ok(!off.includes(word), word);
            // Stop is named without a condition; legacy definition operations are removed; recover refusal is stated.
            assert.ok(off.includes("operation (set_vars, pause, resume, cancel and stop),"), off);
            assert.ok(/persons are refused recover/i.test(off), off);
            assert.ok(!/controller 1\.9\.0|when the workers run/.test(off), off);
            assert.ok(off.includes("grace_seconds"));
        }
        const on = descriptions({ workflowCommands: true, workflowTestMode: true, mgmt: {} });
        for (const word of ["test_respond", "test_advance", "agent_mode", "interception_id", "expected_revision", "inputs", "vars"]) assert.ok(on.includes(word), word);
        assert.ok(!on.includes("approval_respond"), on);
        assert.ok(!on.includes("no test"), on);
        assert.ok(on.includes("cancel, stop, test, test_respond and test_advance),"), on);
        assert.ok(!/controller 1\.9\.0|when the workers run/.test(on), on);
        // read_workflow (review SF-5): off, its description names no test run's part either.
        const readDescription = ctx => {
            const specs = new Map();
            registerWorkflowTools({ registerTool: (name, spec) => { specs.set(name, spec); } }, ctx);
            return specs.get("read_workflow").description;
        };
        for (const off of [readDescription({ mgmt: {} }), readDescription({ workflowTestMode: false, mgmt: {} })]) {
            assert.ok(!/\btest|interception/i.test(off), off);
            assert.ok(off.includes("(openExecutions, openInbox, openOutbox). run.pages gives"));
        }
        assert.ok(readDescription({ workflowTestMode: true, mgmt: {} }).includes("openOutbox, run.test.openInterceptions). run.pages gives"));
        process.env.PILOTSWARM_WORKFLOW_TEST_MODE = "on";
        assert.ok(descriptions({ workflowCommands: true, mgmt: {} }).includes("test_respond"), "the flag turns it on");
        assert.ok(readDescription({ mgmt: {} }).includes("run.test.openInterceptions"));
    } finally {
        if (flag === undefined) delete process.env.PILOTSWARM_WORKFLOW_TEST_MODE;
        else process.env.PILOTSWARM_WORKFLOW_TEST_MODE = flag;
    }
}
console.log("✅ update_workflow names the test operations, and read_workflow a test run's part, only with workflow test mode on");

// 10. Phase 4 (Task 4): approval_respond 403 refusal pinned; list_creatable_workflows; create_session_for_workflow;
//     read_workflow_skill; and workflow_definition (all 8 ops, operation_id, script warning, update:true, SF-2).
{
    const upd = toolsWith({
        workflowCommands: true,
        mgmt: { updateWorkflow: async () => { throw new Error("must not call mgmt for approval_respond"); } },
    }).get("update_workflow");
    const appRes = await upd({ session_id: SID, command: { operation: "approval_respond", approval_id: "a1", decision: "approve" } });
    assert.equal(appRes.isError, true);
    assert.deepEqual(JSON.parse(appRes.content[0].text), {
        error: "A person must read and answer this approval directly in the portal. MCP cannot give consent.",
        code: "FORBIDDEN",
        status: 403,
        session_id: SID,
    });
}

{
    const calls = [];
    const handlers = toolsWith({
        webMode: true,
        workflowCommands: true,
        mgmt: {
            listCreatableWorkflows: async (viewer) => {
                calls.push(["listCreatable", viewer]);
                return [{ ref: "demo/echo", name: "echo", package: "demo", semver: "1.0.0" }];
            },
            createSessionForWorkflow: async (ref, opts) => {
                calls.push(["createForWf", ref, opts]);
                if (ref === "demo/skew") {
                    throw Object.assign(new Error("changed"), { code: "PACKAGE_VERSION_CHANGED", status: 409 });
                }
                return { sessionId: "coord-1", workflowRef: ref, title: "echo · demo", model: "azure:gpt-5", reasoningEffort: "high" };
            },
            readWorkflowSkills: async (opts) => {
                calls.push(["skills", opts]);
                if (!opts?.name) return { skills: [{ name: "workflow-authoring", description: "d" }] };
                if (opts.name === "workflow-authoring") return { name: "workflow-authoring", description: "d", content: "# Authoring" };
                throw Object.assign(new Error("No Workflow skill"), { code: "WORKFLOW_SKILL_NOT_FOUND", status: 404 });
            },
        },
    });

    const listRes = JSON.parse((await handlers.get("list_creatable_workflows")({})).content[0].text);
    assert.equal(listRes.count, 1);
    assert.equal(listRes.workflows[0].ref, "demo/echo");
    assert.deepEqual(calls[0], ["listCreatable", null]);

    const createRes = JSON.parse((await handlers.get("create_session_for_workflow")({
        ref: "demo/echo", model: "azure:gpt-5", reasoning_effort: "high", context_tier: "default", group_id: "g1",
    })).content[0].text);
    assert.deepEqual(createRes, {
        session_id: "coord-1",
        workflow_ref: "demo/echo",
        title: "echo · demo",
        model: "azure:gpt-5",
        reasoning_effort: "high",
        status: "created",
        kickoff_sent: true,
    });

    const skewRes = await handlers.get("create_session_for_workflow")({ ref: "demo/skew" });
    assert.equal(skewRes.isError, true);
    const skewBody = JSON.parse(skewRes.content[0].text);
    assert.equal(skewBody.code, "PACKAGE_VERSION_CHANGED");
    assert.equal(skewBody.status, 409);
    assert.equal("session_id" in skewBody, false);

    const skillList = JSON.parse((await handlers.get("read_workflow_skill")({})).content[0].text);
    assert.equal(skillList.count, 1);
    assert.equal(skillList.skills[0].name, "workflow-authoring");

    const skillRaw = (await handlers.get("read_workflow_skill")({ name: "workflow-authoring" })).content[0].text;
    assert.ok(skillRaw.indexOf('"note"') >= 0 && skillRaw.indexOf('"note"') < skillRaw.indexOf('"content"'), "read_workflow_skill note must appear before content");
    const skillBody = JSON.parse(skillRaw);
    assert.equal(skillBody.name, "workflow-authoring");
    assert.equal(skillBody.content, "# Authoring");
    assert.match(skillBody.note, /load_skill\(name\) is read_workflow_skill \{ name \}/);
    assert.match(skillBody.note, /poll read_workflow/);
    assert.match(skillBody.note, /send_and_wait/);
    assert.match(skillBody.note, /send_workflow_input/);
    assert.doesNotMatch(skillBody.note, /no send_workflow_input/i);
    assert.doesNotMatch(skillBody.note, /send_workflow_input[^;.]*not available/i);

    // B1, B3, B4: tool descriptions & schema text for workflow_definition, update_workflow, create_session_for_workflow, send_workflow_input
    {
        const specs = new Map();
        registerWorkflowTools({ registerTool: (name, spec) => { specs.set(name, spec); } }, { workflowCommands: true, workflowTestMode: false, mgmt: {} });
        const wdSpec = specs.get("workflow_definition");
        const uwSpec = specs.get("update_workflow");
        const csfwSpec = specs.get("create_session_for_workflow");
        const swiSpec = specs.get("send_workflow_input");
        assert.ok(swiSpec, "send_workflow_input spec registered");
        for (const [label, desc] of [["workflow_definition", wdSpec.description], ["update_workflow", uwSpec.description]]) {
            assert.match(desc, /no test/i, `${label} must state missing test`);
            assert.doesNotMatch(desc, /no send_workflow_input/i, `${label} must not say send_workflow_input is missing`);
            assert.match(desc, /send_and_wait/, `${label} must mention send_and_wait workaround`);
            assert.match(desc, /send_workflow_input/, `${label} must point callers to send_workflow_input`);
        }
        assert.match(csfwSpec.description, /chat/i, "create_session_for_workflow must explain it starts a chat, not a run");
        assert.match(csfwSpec.description, /workflow_definition.*start/i, "create_session_for_workflow must explain direct workflow_definition start");
        assert.match(wdSpec.inputSchema.name.description, /Required for save/i, "workflow_definition.name must mark required for save");
        assert.match(wdSpec.inputSchema.yaml.description, /metadata\.version.*quoted semver.*"1\.0\.0"/i, "workflow_definition.yaml must document quoted semver metadata.version");
    }

    const skill404 = await handlers.get("read_workflow_skill")({ name: "nope" });
    assert.equal(skill404.isError, true);
    assert.equal(JSON.parse(skill404.content[0].text).code, "WORKFLOW_SKILL_NOT_FOUND");
}

{
    const calls = [];
    const OWNER_SID = "b7f23cda-5cfd-4f0e-aff1-d6b0400b8da5";
    const mgmt = {
        validateWorkflowDefinition: async (yaml) => { calls.push(["validate", yaml]); return { valid: true, name: "sum", errors: [], warnings: [], graph: { initial: "a", states: [] }, inputsSchema: null }; },
        listSessionWorkflowDefinitions: async (sid, opts) => { calls.push(["list", sid, opts]); return [{ definitionId: "d1", name: "sum" }]; },
        readSessionWorkflowDefinition: async (sid, ref) => {
            calls.push(["read", sid, ref]);
            if (ref.name === "unattached/pkg") throw Object.assign(new Error("missing"), { code: "DEFINITION_NOT_FOUND", status: 404 });
            if (ref.name === "own-wf") return { definitionId: "d-own", name: "own-wf", locked: false, graph: { states: [{ id: "w", type: "wait" }] } };
            if (ref.definitionId === "d-script" || ref.name === "script-wf") {
                return {
                    definitionId: "d-script", name: "script-wf", locked: false,
                    revision: { yaml: 'apiVersion: pilotswarm.dev/v1\nkind: Workflow\nmetadata: { name: script-wf, version: "1.0.0" }\ninitial: compute\nstates:\n  compute:\n    type: script\n    outcomes: [ok]\n    source: |\n      await callTool(context.inputs.tool, {});\n      await setResult("ok", {});\n    transition: { next: { ok: done, failure: done } }\n  done: { type: terminal, outcome: succeeded }\n' },
                    graph: { states: [{ id: "compute", type: "script" }] },
                };
            }
            if (ref.definitionId === "d-pure-script" || ref.name === "pure-script-wf") {
                return {
                    definitionId: "d-pure-script", name: "pure-script-wf", locked: false,
                    revision: { yaml: 'apiVersion: pilotswarm.dev/v1\nkind: Workflow\nmetadata: { name: pure-script-wf, version: "1.0.0" }\ninitial: compute\nstates:\n  compute:\n    type: script\n    outcomes: [ok]\n    source: |\n      await setResult("ok", { n: 1 });\n    transition: { next: { ok: done, failure: done } }\n  done: { type: terminal, outcome: succeeded }\n' },
                    graph: { states: [{ id: "compute", type: "script" }] },
                };
            }
            if (ref.definitionId === "d-child-wf-script" || ref.name === "child-wf-script") {
                return {
                    definitionId: "d-child-wf-script", name: "child-wf-script", locked: false,
                    revision: { yaml: 'apiVersion: pilotswarm.dev/v1\nkind: Workflow\nmetadata: { name: child-wf-script, version: "1.0.0" }\ninitial: compute\nstates:\n  compute:\n    type: script\n    outcomes: [ok]\n    source: |\n      await callTool("child_workflows", { operation: "list" });\n      await setResult("ok", {});\n    transition: { next: { ok: done, failure: done } }\n  done: { type: terminal, outcome: succeeded }\n' },
                    graph: { states: [{ id: "compute", type: "script" }] },
                };
            }
            if (ref.definitionId === "d-wait" || ref.name === "wait-wf") {
                return { definitionId: "d-wait", name: "wait-wf", locked: false, graph: { states: [{ id: "hold", type: "wait" }] } };
            }
            return { definitionId: "d-pkg", name: "demo/pkg", locked: true, graph: { states: [{ id: "hold", type: "wait" }] } };
        },
        readSessionWorkflowCard: async (sid, ref) => { calls.push(["card", sid, ref]); return { name: ref.name, version: "1.0.0", card: "card text" }; },
        saveSessionWorkflowDefinition: async (sid, req, opts) => { calls.push(["save", sid, req, opts]); return { definitionId: "d1", name: req.name, revision: 1, valid: true, replayed: false }; },
        startSessionWorkflowDefinition: async (sid, req, opts) => {
            calls.push(["start", sid, req, opts]);
            const defId = req.definitionId ?? (
                req.name === "script-wf" ? "d-script"
                : req.name === "pure-script-wf" ? "d-pure-script"
                : req.name === "child-wf-script" ? "d-child-wf-script"
                : req.name === "wait-wf" ? "d-wait"
                : "d-pkg"
            );
            return { operation: "start", definitionId: defId, name: req.name ?? "script-wf", revision: req.revision ?? 1, workflowId: "wf-1", runId: "r-1", replayed: false };
        },
        updateSessionWorkflowPackage: async (sid, req, opts) => { calls.push(["updatePkg", sid, req, opts]); return { operation: "attach", definitionId: "d-pkg", name: "demo/pkg", revision: 3, replayed: false }; },
        deleteSessionWorkflowDefinition: async (sid, req, opts) => { calls.push(["delete", sid, req, opts]); return { operation: "delete", definitionId: "d1", name: req.name ?? "sum", deletedAt: "2026-11-27T00:00:00Z", replayed: false }; },
        copySessionWorkflowDefinition: async (sid, req, opts) => { calls.push(["copy", sid, req, opts]); return { operation: "save", definitionId: "d-copy", name: "pkg", revision: 1, replayed: false }; },
    };
    const wfDef = toolsWith({ workflowCommands: true, originatingSessionId: "bound-orig", mgmt }).get("workflow_definition");

    // validate without owner_session_id
    const vRes = JSON.parse((await wfDef({ operation: "validate", yaml: "apiVersion: pilotswarm.dev/v1" })).content[0].text);
    assert.equal(vRes.operation, "validate");
    assert.equal(vRes.valid, true);

    // missing owner_session_id on list
    const missingOwner = await wfDef({ operation: "list" });
    assert.equal(missingOwner.isError, true);
    assert.equal(JSON.parse(missingOwner.content[0].text).code, "WORKFLOW_COMMAND_INVALID");

    // missing operation_id on save/delete/copy/unkeyed start
    for (const [op, extra] of [
        ["save", { name: "x", yaml: "y" }],
        ["delete", { name: "x" }],
        ["copy", { name: "demo/pkg" }],
        ["start", { name: "wait-wf" }],
    ]) {
        const res = await wfDef({ operation: op, owner_session_id: OWNER_SID, ...extra });
        assert.equal(res.isError, true, `${op} without operation_id must fail`);
        const body = JSON.parse(res.content[0].text);
        assert.equal(body.code, "WORKFLOW_COMMAND_INVALID");
        assert.equal(body.status, 400);
        assert.equal(body.error, `operation_id is required for ${op}: choose a new id for this change and reuse it unchanged only to retry this same call.`);
    }

    // list, read, card, save, delete, copy + ctx.originatingSessionId wins over arg
    const listOut = JSON.parse((await wfDef({ operation: "list", owner_session_id: OWNER_SID, include_deleted: true })).content[0].text);
    assert.equal(listOut.operation, "list");
    assert.equal(listOut.owner_session_id, OWNER_SID);

    const cardOut = JSON.parse((await wfDef({ operation: "card", owner_session_id: OWNER_SID, name: "demo/pkg" })).content[0].text);
    assert.equal(cardOut.operation, "card");
    assert.equal(cardOut.name, "demo/pkg");

    await wfDef({ operation: "save", owner_session_id: OWNER_SID, name: "sum", yaml: "y", operation_id: "op-s1", originating_session_id: "spoofed" });
    assert.equal(calls.at(-1)[3].originatingSessionId, "bound-orig");

    // start with script state calling callTool -> appends WORKFLOW_PERSON_START_NO_TOOL_BINDING; keyed start without operation_id derives key:<k>
    const scriptStart = JSON.parse((await wfDef({
        operation: "start", owner_session_id: OWNER_SID, name: "script-wf", key: "k1", workspace: "none",
    })).content[0].text);
    assert.equal(scriptStart.operation, "start");
    assert.ok(scriptStart.warnings?.some(w => w.code === "WORKFLOW_PERSON_START_NO_TOOL_BINDING"));
    const startCall = calls.find(c => c[0] === "start");
    assert.equal(startCall[2].operationId, "key:k1");
    assert.equal(startCall[2].key, "k1");

    // start with pure script state (no callTool) or child_workflows-only script -> no WORKFLOW_PERSON_START_NO_TOOL_BINDING warning
    const pureScriptStart = JSON.parse((await wfDef({
        operation: "start", owner_session_id: OWNER_SID, name: "pure-script-wf", operation_id: "op-ps1", workspace: "none",
    })).content[0].text);
    assert.equal(Boolean(pureScriptStart.warnings?.some(w => w.code === "WORKFLOW_PERSON_START_NO_TOOL_BINDING")), false);

    const childWfScriptStart = JSON.parse((await wfDef({
        operation: "start", owner_session_id: OWNER_SID, name: "child-wf-script", operation_id: "op-cw1", workspace: "none",
    })).content[0].text);
    assert.equal(Boolean(childWfScriptStart.warnings?.some(w => w.code === "WORKFLOW_PERSON_START_NO_TOOL_BINDING")), false);

    // start without script state -> no WORKFLOW_PERSON_START_NO_TOOL_BINDING warning
    const waitStart = JSON.parse((await wfDef({
        operation: "start", owner_session_id: OWNER_SID, name: "wait-wf", operation_id: "op-w1", workspace: "none",
    })).content[0].text);
    assert.equal(Boolean(waitStart.warnings?.some(w => w.code === "WORKFLOW_PERSON_START_NO_TOOL_BINDING")), false);

    // start { update: true } on attached locked pkg -> calls updateSessionWorkflowPackage with ${opId}:update and pins revision: 3
    calls.length = 0;
    const updStart = JSON.parse((await wfDef({
        operation: "start", owner_session_id: OWNER_SID, name: "demo/pkg", update: true, operation_id: "op-u1", workspace: "none",
    })).content[0].text);
    assert.equal(updStart.revision, 3);
    const updCall = calls.find(c => c[0] === "updatePkg");
    assert.equal(updCall[2].operationId, "op-u1:update");
    assert.equal(updCall[3].originatingSessionId, "bound-orig");
    const stCall = calls.find(c => c[0] === "start");
    assert.equal(stCall[2].revision, 3);

    // start { update: true } on unattached or non-locked definition -> 400 WORKFLOW_COMMAND_INVALID
    for (const badName of ["unattached/pkg", "own-wf"]) {
        const badUpd = await wfDef({ operation: "start", owner_session_id: OWNER_SID, name: badName, update: true, operation_id: "op-bad" });
        assert.equal(badUpd.isError, true);
        const body = JSON.parse(badUpd.content[0].text);
        assert.equal(body.code, "WORKFLOW_COMMAND_INVALID");
        assert.equal(body.status, 400);
        assert.match(body.error, /create_session_for_workflow/);
    }

    // SF-1: keyed start { update: true } retried with a different operation_id derives key:<k>:update so update replays
    calls.length = 0;
    const updSeen = new Map();
    const keyedMgmt = {
        readSessionWorkflowDefinition: async () => ({ definitionId: "d-pkg", name: "demo/pkg", locked: true, graph: { states: [{ id: "hold", type: "wait" }] } }),
        updateSessionWorkflowPackage: async (_sid, req) => {
            calls.push(["updatePkg", req.operationId]);
            if (updSeen.has(req.operationId)) return { ...updSeen.get(req.operationId), replayed: true };
            const receipt = { operation: "attach", definitionId: "d-pkg", name: "demo/pkg", revision: updSeen.size + 2 };
            updSeen.set(req.operationId, receipt);
            return { ...receipt, replayed: false };
        },
        startSessionWorkflowDefinition: async (_sid, req) => {
            calls.push(["start", req.revision, req.operationId, req.key]);
            return { operation: "start", definitionId: "d-pkg", name: "demo/pkg", revision: req.revision, workflowId: "wf-k", runId: "r-k", replayed: false };
        },
    };
    const keyedWfDef = toolsWith({ workflowCommands: true, mgmt: keyedMgmt }).get("workflow_definition");
    const kRun1 = JSON.parse((await keyedWfDef({
        operation: "start", owner_session_id: OWNER_SID, name: "demo/pkg", update: true, key: "k-upd", operation_id: "op-a", workspace: "none",
    })).content[0].text);
    const kRun2 = JSON.parse((await keyedWfDef({
        operation: "start", owner_session_id: OWNER_SID, name: "demo/pkg", update: true, key: "k-upd", operation_id: "op-b", workspace: "none",
    })).content[0].text);
    assert.equal(kRun1.revision, 2);
    assert.equal(kRun2.revision, 2, "keyed retry with different operation_id must reuse key-derived update op id and pin original revision");
    assert.deepEqual(calls.filter(c => c[0] === "updatePkg"), [["updatePkg", "key:k-upd:update"], ["updatePkg", "key:k-upd:update"]]);

    // N-2: 256-char operation_id with update:true produces <=256-char hashed update operationId
    calls.length = 0;
    const longOpId = "x".repeat(256);
    await keyedWfDef({ operation: "start", owner_session_id: OWNER_SID, name: "demo/pkg", update: true, operation_id: longOpId, workspace: "none" });
    const longUpdCall = calls.find(c => c[0] === "updatePkg");
    assert.ok(longUpdCall && longUpdCall[1].length <= 256, `update operationId exceeded 256 chars: ${longUpdCall?.[1]?.length}`);

    // N-3: PERSON_START_TOOL_BINDING_WARNING carries severity: "warning"
    assert.equal(scriptStart.warnings.find(w => w.code === "WORKFLOW_PERSON_START_NO_TOOL_BINDING")?.severity, "warning");

    // N-10: update: true combined with run_again_of is refused 400 WORKFLOW_COMMAND_INVALID
    const badCombo = await wfDef({
        operation: "start", owner_session_id: OWNER_SID, name: "demo/pkg", update: true, run_again_of: "wf-old", operation_id: "op-combo",
    });
    assert.equal(badCombo.isError, true);
    assert.equal(JSON.parse(badCombo.content[0].text).code, "WORKFLOW_COMMAND_INVALID");

    // delete & copy
    const delOut = JSON.parse((await wfDef({ operation: "delete", owner_session_id: OWNER_SID, name: "sum", operation_id: "op-d1" })).content[0].text);
    assert.equal(delOut.operation, "delete");
    const copyOut = JSON.parse((await wfDef({ operation: "copy", owner_session_id: OWNER_SID, name: "demo/pkg", operation_id: "op-c1" })).content[0].text);
    assert.equal(copyOut.operation, "copy");

    // Proposed Q1: ctx.originatingSessionId overrides caller arg on create_session_for_workflow
    let seenCsfwOpts = null;
    const csfw = toolsWith({
        webMode: true,
        workflowsAdvert: { validate: true, card: true, skills: true },
        originatingSessionId: "bound-wf-child",
        mgmt: {
            createSessionForWorkflow: async (_ref, opts) => {
                seenCsfwOpts = opts;
                throw Object.assign(new Error("Sessions inside a Workflow cannot create or change workflow definitions."), {
                    code: "WORKFLOW_DEFINITION_TOOLS_REFUSED",
                    status: 403,
                });
            },
        },
    }).get("create_session_for_workflow");
    const csfwDenied = await csfw({ ref: "demo/echo", originating_session_id: "spoofed" });
    assert.equal(seenCsfwOpts.originatingSessionId, "bound-wf-child");
    assert.equal(csfwDenied.isError, true);
    assert.equal(JSON.parse(csfwDenied.content[0].text).code, "WORKFLOW_DEFINITION_TOOLS_REFUSED");

    // Proposed Q3: older-portal advert reflection in buildCapabilities & 501 WORKFLOW_API_UNAVAILABLE on missing route
    const olderAdvert = { schema: 1, enabled: true, apiVersion: "pilotswarm.dev/v1", read: true };
    const { tool: olderTool } = await describedBy({
        ...capabilityCtx(webClient({ ok: true, workflows: olderAdvert }), { workflowCommands: true, webMode: true }),
        workflowsAdvert: olderAdvert,
    });
    assert.deepEqual(olderTool.workflow_tools, {
        read: true, catalog: true, session_for_workflow: true, skills: false, commands: true, definitions: false, input: false,
    });
    const newerAdvert = { schema: 1, enabled: true, apiVersion: "pilotswarm.dev/v1", read: true, validate: true, skills: true, card: true, input: true };
    const { tool: newerTool } = await describedBy({
        ...capabilityCtx(webClient({ ok: true, workflows: newerAdvert }), { workflowCommands: true, webMode: true }),
        workflowsAdvert: newerAdvert,
    });
    assert.deepEqual(newerTool.workflow_tools, {
        read: true, catalog: true, session_for_workflow: true, skills: true, commands: true, definitions: true, input: true,
    });

    const missingRouteErr = () => Object.assign(new Error("Unknown API route: POST /api/v1/workflow-definitions/validate"), {
        code: "NOT_FOUND",
        status: 404,
    });
    const olderTools = toolsWith({
        webMode: true,
        workflowCommands: true,
        mgmt: {
            readWorkflowSkills: async () => { throw missingRouteErr(); },
            validateWorkflowDefinition: async () => { throw missingRouteErr(); },
            readSessionWorkflowCard: async () => { throw missingRouteErr(); },
        },
    });
    const sk501 = JSON.parse((await olderTools.get("read_workflow_skill")({})).content[0].text);
    assert.equal(sk501.code, "WORKFLOW_API_UNAVAILABLE");
    assert.equal(sk501.status, 501);
    const val501 = JSON.parse((await olderTools.get("workflow_definition")({ operation: "validate", yaml: "x" })).content[0].text);
    assert.equal(val501.code, "WORKFLOW_API_UNAVAILABLE");
    assert.equal(val501.status, 501);
    const card501 = JSON.parse((await olderTools.get("workflow_definition")({ operation: "card", owner_session_id: OWNER_SID, name: "demo/echo" })).content[0].text);
    assert.equal(card501.code, "WORKFLOW_API_UNAVAILABLE");
    assert.equal(card501.status, 501);
    assert.equal(card501.session_id, OWNER_SID);

    // SF-3: older-portal advert fails closed (501 WORKFLOW_API_UNAVAILABLE) for originatingSessionId and name-only start/delete/copy
    let skewReachedMgmt = false;
    const skewTools = toolsWith({
        webMode: true,
        workflowCommands: true,
        workflowsAdvert: olderAdvert,
        originatingSessionId: "inside-wf-1",
        mgmt: {
            createSessionForWorkflow: async () => { skewReachedMgmt = true; return {}; },
            saveSessionWorkflowDefinition: async () => { skewReachedMgmt = true; return {}; },
            startSessionWorkflowDefinition: async () => { skewReachedMgmt = true; return {}; },
            deleteSessionWorkflowDefinition: async () => { skewReachedMgmt = true; return {}; },
            copySessionWorkflowDefinition: async () => { skewReachedMgmt = true; return {}; },
        },
    });
    const skewCsfw = await skewTools.get("create_session_for_workflow")({ ref: "demo/echo" });
    assert.equal(skewCsfw.isError, true);
    assert.equal(JSON.parse(skewCsfw.content[0].text).code, "WORKFLOW_API_UNAVAILABLE");
    assert.equal(JSON.parse(skewCsfw.content[0].text).status, 501);

    const skewSave = await skewTools.get("workflow_definition")({
        operation: "save", owner_session_id: OWNER_SID, name: "w", yaml: "y", operation_id: "op-1",
    });
    assert.equal(skewSave.isError, true);
    assert.equal(JSON.parse(skewSave.content[0].text).code, "WORKFLOW_API_UNAVAILABLE");

    const skewNoOrigTools = toolsWith({
        webMode: true,
        workflowCommands: true,
        workflowsAdvert: olderAdvert,
        mgmt: {
            startSessionWorkflowDefinition: async () => { skewReachedMgmt = true; return {}; },
            deleteSessionWorkflowDefinition: async () => { skewReachedMgmt = true; return {}; },
            copySessionWorkflowDefinition: async () => { skewReachedMgmt = true; return {}; },
        },
    });
    for (const op of ["start", "delete", "copy"]) {
        const res = await skewNoOrigTools.get("workflow_definition")({
            operation: op, owner_session_id: OWNER_SID, name: "by-name-only", operation_id: `op-${op}`,
        });
        assert.equal(res.isError, true, `older portal must fail closed for name-only ${op}`);
        assert.equal(JSON.parse(res.content[0].text).code, "WORKFLOW_API_UNAVAILABLE");
        assert.equal(JSON.parse(res.content[0].text).status, 501);
    }
    assert.equal(skewReachedMgmt, false, "older-portal fail-closed guard must stop before hitting mgmt");

    // Missing (null) advert in web mode fails closed (501 WORKFLOW_API_UNAVAILABLE) on mutations
    let nullAdvertReachedMgmt = false;
    const nullAdvertTools = toolsWith({
        webMode: true,
        workflowCommands: true,
        workflowsAdvert: null,
        mgmt: {
            deleteSessionWorkflowDefinition: async () => { nullAdvertReachedMgmt = true; return {}; },
        },
    });
    const nullAdvertDel = await nullAdvertTools.get("workflow_definition")({
        operation: "delete", owner_session_id: OWNER_SID, name: "by-name-only", operation_id: "op-null-advert",
    });
    assert.equal(nullAdvertDel.isError, true, "null advert in web mode must fail closed on mutation");
    assert.equal(JSON.parse(nullAdvertDel.content[0].text).code, "WORKFLOW_API_UNAVAILABLE");
    assert.equal(JSON.parse(nullAdvertDel.content[0].text).status, 501);
    assert.equal(nullAdvertReachedMgmt, false);
}

// 11. send_workflow_input (Gap G8): workflow_id / session_id resolution, agent refusal, field mapping, falsy payloads, fail-closed 501.
{
    const OTHER_SID = "c7f23cda-5cfd-4f0e-aff1-d6b0400b8da5";
    const calls = [];
    const mgmt = {
        sendWorkflowInput: async (wfId, input) => {
            calls.push([wfId, input]);
            return {
                replayed: false,
                workflowId: wfId,
                runId: input.runId ?? "run-1",
                messageId: "msg-1",
                senderSessionId: "person:system:management-client",
                operationId: input.operationId,
                contract: input.contract,
                requestSha256: "req",
                payloadSha256: "pay",
                acceptedAt: "2026-11-27T00:00:00.000Z",
                expiresAt: "2026-11-28T00:00:00.000Z",
                claimedBy: { nodeExecutionId: "nx-1", stateId: "await_signal" },
            };
        },
    };
    const sendTool = toolsWith({ workflowCommands: true, mgmt }).get("send_workflow_input");
    assert.ok(sendTool, "send_workflow_input handler exists");

    // Accepts workflow_id, session_id, or both identical.
    const r1 = JSON.parse((await sendTool({
        workflow_id: SID, contract: "Deploy@1", payload: { ok: true }, correlation: { ticket: "T-1" },
        operation_id: "op-1", ttl_seconds: 300, run_id: "run-9",
    })).content[0].text);
    assert.equal(r1.workflowId, SID);
    assert.deepEqual(calls[0], [SID, {
        contract: "Deploy@1", payload: { ok: true }, correlation: { ticket: "T-1" },
        operationId: "op-1", ttlSeconds: 300, runId: "run-9",
    }]);

    await sendTool({ session_id: SID, contract: "Deploy@1", payload: null, operation_id: "op-2" });
    assert.deepEqual(calls[1], [SID, { contract: "Deploy@1", payload: null, operationId: "op-2" }]);

    await sendTool({ workflow_id: SID, session_id: SID, contract: "Deploy@1", payload: false, operation_id: "op-3" });
    assert.deepEqual(calls[2], [SID, { contract: "Deploy@1", payload: false, operationId: "op-3" }]);

    // Missing both workflow_id and session_id -> 400 WORKFLOW_COMMAND_INVALID.
    const noId = await sendTool({ contract: "Deploy@1", payload: {}, operation_id: "op-4" });
    assert.equal(noId.isError, true);
    assert.equal(JSON.parse(noId.content[0].text).code, "WORKFLOW_COMMAND_INVALID");
    assert.equal(JSON.parse(noId.content[0].text).status, 400);

    // Conflicting workflow_id and session_id -> 400 WORKFLOW_COMMAND_INVALID.
    const conflict = await sendTool({ workflow_id: SID, session_id: OTHER_SID, contract: "Deploy@1", payload: {}, operation_id: "op-5" });
    assert.equal(conflict.isError, true);
    assert.equal(JSON.parse(conflict.content[0].text).code, "WORKFLOW_COMMAND_INVALID");
    assert.equal(JSON.parse(conflict.content[0].text).status, 400);

    // Missing payload (undefined) -> 400 WORKFLOW_COMMAND_INVALID.
    const noPayload = await sendTool({ workflow_id: SID, contract: "Deploy@1", operation_id: "op-6" });
    assert.equal(noPayload.isError, true);
    assert.equal(JSON.parse(noPayload.content[0].text).code, "WORKFLOW_COMMAND_INVALID");
    assert.equal(JSON.parse(noPayload.content[0].text).status, 400);

    // originating_session_id or ctx.originatingSessionId -> 403 FORBIDDEN without calling mgmt.
    const prevCalls = calls.length;
    const origArg = await sendTool({ workflow_id: SID, contract: "Deploy@1", payload: {}, operation_id: "op-7", originating_session_id: OTHER_SID });
    assert.equal(origArg.isError, true);
    assert.equal(JSON.parse(origArg.content[0].text).code, "FORBIDDEN");
    assert.equal(JSON.parse(origArg.content[0].text).status, 403);

    const boundSend = toolsWith({ workflowCommands: true, originatingSessionId: OTHER_SID, mgmt }).get("send_workflow_input");
    const origCtx = await boundSend({ workflow_id: SID, contract: "Deploy@1", payload: {}, operation_id: "op-8" });
    assert.equal(origCtx.isError, true);
    assert.equal(JSON.parse(origCtx.content[0].text).code, "FORBIDDEN");
    assert.equal(JSON.parse(origCtx.content[0].text).status, 403);
    assert.equal(calls.length, prevCalls, "agent-originated MCP calls must be refused before reaching mgmt");

    // Web mode fail-closed when workflowsAdvert is null or workflowsAdvert.input !== true -> 501 WORKFLOW_API_UNAVAILABLE.
    for (const workflowsAdvert of [null, { read: true, validate: true, card: true, skills: true }, { read: true, input: false }]) {
        let called = false;
        const oldSend = toolsWith({
            webMode: true, workflowCommands: true, workflowsAdvert,
            mgmt: { sendWorkflowInput: async () => { called = true; return {}; } },
        }).get("send_workflow_input");
        const res = await oldSend({ workflow_id: SID, contract: "Deploy@1", payload: {}, operation_id: "op-old" });
        assert.equal(res.isError, true);
        assert.equal(JSON.parse(res.content[0].text).code, "WORKFLOW_API_UNAVAILABLE");
        assert.equal(JSON.parse(res.content[0].text).status, 501);
        assert.equal(called, false);
    }

    // Route 404 fallback in webMode when advert had input: true -> 501 WORKFLOW_API_UNAVAILABLE via refusal().
    const route404Send = toolsWith({
        webMode: true, workflowCommands: true, workflowsAdvert: { read: true, input: true },
        mgmt: {
            sendWorkflowInput: async () => {
                throw Object.assign(new Error("Unknown API route: POST /api/v1/sessions/x/workflow/inputs"), { code: "NOT_FOUND", status: 404 });
            },
        },
    }).get("send_workflow_input");
    const r404 = await route404Send({ workflow_id: SID, contract: "Deploy@1", payload: {}, operation_id: "op-404" });
    assert.equal(r404.isError, true);
    assert.equal(JSON.parse(r404.content[0].text).code, "WORKFLOW_API_UNAVAILABLE");
    assert.equal(JSON.parse(r404.content[0].text).status, 501);
}

console.log("✅ Phase 4 MCP workflow tools unit suite passed");

// 11. Phase 3 I7 (Task 8b): re-run from a step over MCP. workflow_definition start takes rerun_from (the definition is read
//     from the Workflow when name and definition_id are omitted, before update attaches a newer version); every call says
//     viaMcp (OQ5: MCP never reuses an answered approval); read_workflow takes rerun_plan alone (outcome only, viaMcp); and a
//     web-mode server whose portal does not advertise workflows.rerun fails closed before anything is changed (M1).
{
    const OWNER_SID = "c7f23cda-5cfd-4f0e-aff1-d6b0400b8da5";
    const SOURCE = "wf-src-2";
    const TOOL_YAML = 'apiVersion: pilotswarm.dev/v1\nkind: Workflow\nmetadata: { name: pkg, version: "1.0.0" }\ninitial: compute\nstates:\n'
        + '  compute:\n    type: script\n    outcomes: [ok]\n    source: |\n      await callTool("read_facts", {});\n      await setResult("ok", {});\n'
        + '    transition: { next: { ok: done, failure: done } }\n  done: { type: terminal, outcome: succeeded }\n';
    const RERUN_ADVERT = { validate: true, card: true, skills: true, rerun: true };
    const rerunMgmt = ({ grant = "inherited", startError = null } = {}) => {
        const calls = [];
        const mgmt = {
            readWorkflow: async (sid, opts, ...rest) => {
                calls.push(["read", sid, opts, rest.length]);
                if (sid === "wf-gone") return { workflowId: sid, deleted: true, definition: { state: "deleted" }, run: { outcome: "failed" } };
                if (sid === "wf-plain") return { workflowId: sid, definition: { state: "published", source: null } };
                if (sid === "wf-foreign") return { workflowId: sid, definition: { source: { ownerSessionId: "another-session", definitionId: "d-x", revision: 1 } } };
                if (opts?.rerunPlan) return { workflowId: sid, rerunPlan: { allowed: false, blockedReason: "Only the owner in the portal can reuse an approval." } };
                return { workflowId: sid, definition: { state: "published", source: { ownerSessionId: OWNER_SID, definitionId: "d-pkg", revision: 2 } } };
            },
            readSessionWorkflowDefinition: async (sid, ref) => {
                calls.push(["readDef", sid, ref]);
                return { definitionId: "d-pkg", name: "demo/pkg", locked: true, revision: { yaml: TOOL_YAML } };
            },
            updateSessionWorkflowPackage: async (sid, req, opts) => {
                calls.push(["updatePkg", sid, req, opts]);
                return { operation: "attach", definitionId: "d-pkg", name: "demo/pkg", revision: 4, replayed: false };
            },
            startSessionWorkflowDefinition: async (sid, req, opts) => {
                calls.push(["start", sid, req, opts]);
                if (startError) throw startError;
                return { operation: "start", definitionId: "d-pkg", name: "demo/pkg", revision: req.revision ?? 2, workflowId: "wf-3", runId: "r-3",
                    replayed: false, rerun: { ofWorkflowId: SOURCE, mode: req.rerunFrom?.mode ?? "run_again", reused: 1, ...(grant ? { grant } : {}) } };
            },
        };
        return { mgmt, calls };
    };
    const body = (res) => JSON.parse(res.content[0].text);

    // (a) name and definition_id omitted: the definition is the Workflow's; update attaches the newer version first and the
    //     re-run pins it; rerun_from goes on as rerunFrom with viaMcp; an inherited grant warns of no missing tool grant.
    {
        const { mgmt, calls } = rerunMgmt();
        const wfDef = toolsWith({ workflowCommands: true, mgmt }).get("workflow_definition");
        const rerun_from = { workflow_id: SOURCE, execution_id: "nx-2", mode: "supply", result: { outcome: "ok", output: { fqdn: "a.db" } }, note: "Checked in the portal." };
        const started = body(await wfDef({ operation: "start", owner_session_id: OWNER_SID, rerun_from, update: true, key: "k-1" }));
        assert.equal(started.operation, "start");
        assert.equal(started.revision, 4);
        assert.equal(started.rerun.grant, "inherited");
        assert.equal(started.warnings, undefined, "an inherited grant is not a person's Start without one");
        assert.deepEqual(calls.map(c => c[0]), ["read", "readDef", "updatePkg", "start"]);
        assert.equal(calls[0][1], SOURCE);
        assert.deepEqual(calls[1][2], { definitionId: "d-pkg" });
        assert.deepEqual(calls[2][2], { definitionId: "d-pkg", operationId: "key:k-1:update" });
        assert.deepEqual(calls[3][2], {
            definitionId: "d-pkg", revision: 4, key: "k-1", operationId: "key:k-1",
            rerunFrom: { workflowId: SOURCE, executionId: "nx-2", mode: "supply", result: { outcome: "ok", output: { fqdn: "a.db" } }, note: "Checked in the portal." },
            viaMcp: true,
        });

        // Without update and revision, the source revision is the server's default: none is sent.
        calls.length = 0;
        await wfDef({ operation: "start", owner_session_id: OWNER_SID, rerun_from: { workflow_id: SOURCE }, operation_id: "op-r1" });
        assert.deepEqual(calls.at(-1)[2], { definitionId: "d-pkg", operationId: "op-r1", rerunFrom: { workflowId: SOURCE }, viaMcp: true });
        // An explicit revision and a name go as given; the Workflow is not read for its definition.
        calls.length = 0;
        await wfDef({ operation: "start", owner_session_id: OWNER_SID, name: "demo/pkg", revision: 3, rerun_from: { workflow_id: SOURCE, mode: "run_again" }, operation_id: "op-r2" });
        assert.deepEqual(calls.map(c => c[0]), ["start"]);
        assert.deepEqual(calls[0][2], { name: "demo/pkg", revision: 3, operationId: "op-r2", rerunFrom: { workflowId: SOURCE, mode: "run_again" }, viaMcp: true });
        // A Start without rerun_from sends no viaMcp (an older portal takes no such field).
        calls.length = 0;
        await wfDef({ operation: "start", owner_session_id: OWNER_SID, name: "demo/pkg", operation_id: "op-plain", workspace: "none" });
        assert.equal("viaMcp" in calls[0][2], false);
    }

    // A re-run that inherited no grant still warns when its scripts call tools.
    {
        const { mgmt } = rerunMgmt({ grant: null });
        const wfDef = toolsWith({ workflowCommands: true, mgmt }).get("workflow_definition");
        const started = body(await wfDef({ operation: "start", owner_session_id: OWNER_SID, rerun_from: { workflow_id: SOURCE }, operation_id: "op-ng" }));
        assert.ok(started.warnings?.some(w => w.code === "WORKFLOW_PERSON_START_NO_TOOL_BINDING"));
    }

    // The Workflow named must be this session's, started from a saved definition and not cleaned up; nothing starts otherwise.
    for (const [workflowId, code, status] of [["wf-gone", "RERUN_SOURCE_GONE", 409], ["wf-plain", "RERUN_NOT_A_WORKFLOW", 422], ["wf-foreign", "WORKFLOW_NOT_FOUND", 404]]) {
        const { mgmt, calls } = rerunMgmt();
        const res = await toolsWith({ workflowCommands: true, mgmt }).get("workflow_definition")({
            operation: "start", owner_session_id: OWNER_SID, rerun_from: { workflow_id: workflowId }, update: true, operation_id: `op-${workflowId}`,
        });
        assert.equal(res.isError, true, workflowId);
        assert.equal(body(res).code, code);
        assert.equal(body(res).status, status);
        assert.deepEqual(calls.map(c => c[0]), ["read"], `${workflowId}: nothing but the read`);
    }

    // (b) Every re-run refusal from Start answers its code, status and details.
    for (const [code, status, details] of [
        ["RERUN_ARGUMENT_REFUSED", 400, undefined],
        ["RERUN_VISIT_REQUIRED", 400, { candidates: [{ executionId: "nx-1" }, { executionId: "nx-2" }] }],
        ["RERUN_APPROVAL_REUSED", 403, undefined],
        ["RERUN_VISIT_NOT_FOUND", 404, { executionId: "nx-9" }],
        ["WORKFLOW_DELETED", 404, undefined],
        ["RERUN_SOURCE_ACTIVE", 409, { status: "running" }],
        ["RERUN_SOURCE_GONE", 409, { workflowId: SOURCE, outcome: "failed" }],
        ["WORKFLOW_TOOLS_UNAVAILABLE", 409, undefined],
        ["OPERATION_CONFLICT", 409, undefined],
        ["RERUN_NOT_A_WORKFLOW", 422, undefined],
        ["RERUN_VISIT_NOT_ALLOWED", 422, { reason: "inside_lane" }],
        ["RERUN_SUPPLY_NOT_ALLOWED", 422, { nodeType: "approval" }],
        ["RERUN_SUPPLIED_RESULT_INVALID", 422, { problems: [{ path: "$.fqdn", message: "required" }] }],
        ["RERUN_INCOMPATIBLE", 422, { revision: 4, problems: [{ code: "step_missing", stateId: "provision" }] }],
        ["RERUN_TOO_LARGE", 422, undefined],
    ]) {
        const error = Object.assign(new Error(`refused: ${code}`), { code, status, ...(details ? { details } : {}) });
        const { mgmt } = rerunMgmt({ startError: error });
        const res = await toolsWith({ workflowCommands: true, mgmt }).get("workflow_definition")({
            operation: "start", owner_session_id: OWNER_SID, rerun_from: { workflow_id: SOURCE }, operation_id: `op-${code}`,
        });
        assert.equal(res.isError, true, code);
        assert.deepEqual(body(res), { error: `refused: ${code}`, code, session_id: OWNER_SID, status, ...(details ? { details } : {}) });
    }

    // (g) A re-run takes its source's inputs and workspace and repeats no other Workflow: refused before anything is read or
    //     attached (400 RERUN_ARGUMENT_REFUSED).
    for (const extra of [{ inputs: { a: 1 } }, { workspace: "none" }, { workspace: null }, { run_again_of: "wf-old" },
        { rerun_from: { workflow_id: SOURCE, child: { execution_id: "nx-c" } } }, { rerun_from: { execution_id: "nx-2" } }]) {
        const { mgmt, calls } = rerunMgmt();
        const res = await toolsWith({ workflowCommands: true, mgmt }).get("workflow_definition")({
            operation: "start", owner_session_id: OWNER_SID, rerun_from: { workflow_id: SOURCE }, update: true, operation_id: "op-arg", ...extra,
        });
        assert.equal(res.isError, true, JSON.stringify(extra));
        assert.equal(body(res).code, "RERUN_ARGUMENT_REFUSED", JSON.stringify(extra));
        assert.equal(body(res).status, 400);
        assert.deepEqual(calls, [], `${JSON.stringify(extra)}: refused before any call`);
    }
    {
        const { mgmt, calls } = rerunMgmt();
        const res = await toolsWith({ workflowCommands: true, mgmt }).get("workflow_definition")({
            operation: "start", owner_session_id: OWNER_SID, rerun_from: { workflow_id: SOURCE }, inputs: {}, operation_id: "op-empty-inputs",
        });
        assert.equal(res.isError, undefined, "empty inputs are no inputs");
        assert.equal("inputs" in calls.at(-1)[2], false);
    }

    // (i) Review H3: over the MCP wire (the McpServer's own schema parsing), a malformed supplied result or note reaches the
    //     handler, which refuses it as Start does (400 RERUN_ARGUMENT_REFUSED) before anything is read, updated or started; the
    //     note's limit counts characters, not UTF-16 code units.
    {
        const { mgmt, calls } = rerunMgmt();
        const server = new McpServer({ name: "rerun-wire-test", version: "1.0.0" });
        registerWorkflowTools(server, { workflowCommands: true, workflowTestMode: false, mgmt });
        const client = new Client({ name: "rerun-wire-client", version: "1.0.0" });
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
        const answer = (res) => { try { return JSON.parse(res.content[0].text); } catch { return res.content?.[0]?.text; } };
        const supply = (rerun) => client.callTool({ name: "workflow_definition", arguments: {
            operation: "start", owner_session_id: OWNER_SID, update: true, key: "k-h3",
            rerun_from: { workflow_id: SOURCE, execution_id: "nx-2", mode: "supply", result: { outcome: "ok", output: { fqdn: "a.db" } },
                note: "Checked in the portal.", ...rerun },
        } });
        try {
            for (const [label, rerun] of [
                ["an extra key in result", { result: { outcome: "ok", output: { fqdn: "a.db" }, verified: true } }],
                ["a result without outcome", { result: { output: { fqdn: "a.db" } } }],
                ["a blank outcome", { result: { outcome: " " } }],
                ["an outcome that is not text", { result: { outcome: 7 } }],
                ["a result that is not an object", { result: "ok" }],
                ["a note of 2,001 characters", { note: "😀".repeat(2001) }],
                ["a note that is not text", { note: { checked: true } }],
                ["a result outside supply", { mode: "run_again" }],
            ]) {
                const res = await supply(rerun);
                assert.equal(res.isError, true, label);
                assert.deepEqual(answer(res), { error: answer(res)?.error, code: "RERUN_ARGUMENT_REFUSED", status: 400, session_id: OWNER_SID }, label);
                assert.equal(typeof answer(res).error, "string", label);
                assert.deepEqual(calls, [], `${label}: no read, package update or Start`);
            }
            // A well-formed supply, with a note of 2,000 characters (4,000 UTF-16 code units), goes through the wire whole.
            const note = "😀".repeat(2000);
            const started = answer(await supply({ note }));
            assert.equal(started.operation, "start");
            assert.deepEqual(calls.map(c => c[0]), ["read", "readDef", "updatePkg", "start"]);
            assert.deepEqual(calls.at(-1)[2].rerunFrom, { workflowId: SOURCE, executionId: "nx-2", mode: "supply",
                result: { outcome: "ok", output: { fqdn: "a.db" } }, note });
        } finally {
            await client.close();
            await server.close();
        }
    }

    // (d) rerun_plan: alone, outcome only, viaMcp; the plan is the read's answer (allowed: false over MCP for an approval).
    {
        const { mgmt, calls } = rerunMgmt();
        const read = toolsWith({ mgmt }).get("read_workflow");
        const plan = body(await read({ session_id: SOURCE, rerun_plan: { execution_id: "nx-2", mode: "supply", revision: 3, outcome: "ok" } }));
        assert.equal(plan.rerunPlan.allowed, false);
        assert.deepEqual(calls, [["read", SOURCE, { rerunPlan: { executionId: "nx-2", mode: "supply", revision: 3, outcome: "ok", viaMcp: true } }, 0]]);
        await read({ session_id: SOURCE, rerun_plan: {} });
        assert.deepEqual(calls.at(-1)[2], { rerunPlan: { viaMcp: true } });
        for (const [extra, label] of [[{ run_id: "r1" }, "run_id"], [{ cursor: { v: 1 } }, "cursor"], [{ execution_id: "nx-1" }, "execution_id"],
            [{ kv_revision: 2 }, "kv_revision"], [{ agent_versions: true }, "agent_versions"], [{ definition_revision: 1 }, "definition_revision"],
            [{ step_input: { state: "s" } }, "step_input"]]) {
            calls.length = 0;
            const res = await read({ session_id: SOURCE, rerun_plan: { mode: "run_again" }, ...extra });
            assert.equal(res.isError, true, label);
            assert.equal(body(res).code, "WORKFLOW_READ_INVALID", label);
            assert.equal(body(res).status, 400);
            assert.match(body(res).error, new RegExp(label));
            assert.deepEqual(calls, [], `${label}: refused before the read`);
        }
        calls.length = 0;
        const withOutput = await read({ session_id: SOURCE, rerun_plan: { mode: "supply", outcome: "ok", output: { fqdn: "a.db" } } });
        assert.equal(body(withOutput).code, "WORKFLOW_READ_INVALID", "a plan never takes a supplied output (M6)");
        assert.deepEqual(calls, []);
        // A plan read's refusal keeps its details.
        const gone = Object.assign(new Error("Workflow wf-src-2 was cleaned up. Only its result is kept. Use Run again."),
            { code: "RERUN_SOURCE_GONE", status: 409, details: { workflowId: SOURCE, outcome: "failed" } });
        const refused = await toolsWith({ mgmt: { readWorkflow: async () => { throw gone; } } }).get("read_workflow")({ session_id: SOURCE, rerun_plan: {} });
        assert.deepEqual(body(refused), { error: gone.message, session_id: SOURCE, code: "RERUN_SOURCE_GONE", status: 409, details: { workflowId: SOURCE, outcome: "failed" } });
    }

    // (h) M1: a web-mode portal that does not advertise workflows.rerun (no advert, one without rerun, or a bootstrap that could not
    //     be read) fails closed with 501 WORKFLOW_API_UNAVAILABLE: no update-package, no start, no plan read.
    for (const [advert, label] of [[null, "no workflows advert (or a failed /bootstrap)"], [{ enabled: true }, "{ enabled: true }"],
        [{ enabled: true, validate: true, card: true, skills: true }, "rerun absent"], [{ ...RERUN_ADVERT, rerun: false }, "rerun: false"]]) {
        const { mgmt, calls } = rerunMgmt();
        const tools = toolsWith({ webMode: true, workflowCommands: true, ...(advert ? { workflowsAdvert: advert } : {}), mgmt });
        const start = await tools.get("workflow_definition")({
            operation: "start", owner_session_id: OWNER_SID, rerun_from: { workflow_id: SOURCE }, update: true, key: "k-skew",
        });
        assert.equal(start.isError, true, label);
        assert.equal(body(start).code, "WORKFLOW_API_UNAVAILABLE", label);
        assert.equal(body(start).status, 501);
        const plan = await tools.get("read_workflow")({ session_id: SOURCE, rerun_plan: {} });
        assert.equal(body(plan).code, "WORKFLOW_API_UNAVAILABLE", label);
        assert.equal(body(plan).status, 501);
        assert.deepEqual(calls, [], `${label}: 0 calls to update-package, start or the read`);
    }
    {
        const { mgmt, calls } = rerunMgmt();
        const tools = toolsWith({ webMode: true, workflowCommands: true, workflowsAdvert: RERUN_ADVERT, mgmt });
        const started = body(await tools.get("workflow_definition")({ operation: "start", owner_session_id: OWNER_SID, rerun_from: { workflow_id: SOURCE }, key: "k-web" }));
        assert.equal(started.workflowId, "wf-3");
        assert.equal(calls.at(-1)[2].viaMcp, true);
        assert.equal(body(await tools.get("read_workflow")({ session_id: SOURCE, rerun_plan: {} })).rerunPlan.allowed, false);
    }

    // (f) The skill and the descriptions name the re-run surface.
    {
        const specs = new Map();
        registerWorkflowTools({ registerTool: (name, spec) => { specs.set(name, spec); } }, { workflowCommands: true, workflowTestMode: false, mgmt: {} });
        assert.match(specs.get("read_workflow_skill").inputSchema.name.description, /'workflow-rerun'/);
        assert.match(specs.get("read_workflow").description, /rerun_plan/);
        for (const code of ["RERUN_SOURCE_ACTIVE", "RERUN_SOURCE_GONE", "RERUN_VISIT_NOT_FOUND", "RERUN_APPROVAL_REUSED", "RERUN_INCOMPATIBLE"]) {
            assert.match(specs.get("read_workflow").description, new RegExp(code));
        }
        assert.ok(specs.get("read_workflow").inputSchema.rerun_plan, "read_workflow takes rerun_plan");
        const wd = specs.get("workflow_definition");
        assert.ok(wd.inputSchema.rerun_from, "workflow_definition takes rerun_from");
        assert.match(wd.description, /rerun_from/);
        assert.match(wd.description, /workflow-rerun/);
        assert.match(wd.inputSchema.rerun_from.description, /omit inputs and workspace/i);
        assert.match(wd.inputSchema.revision.description, /rerun_from.*source Workflow's revision/i);
        assert.match(wd.inputSchema.workspace.description, /omit with rerun_from/i);
        const skill = body(await toolsWith({ mgmt: { readWorkflowSkills: async (opts) => ({ name: opts.name, description: "d", content: "# Re-run" }) } })
            .get("read_workflow_skill")({ name: "workflow-rerun" }));
        assert.equal(skill.name, "workflow-rerun");
        assert.match(skill.note, /rerun_from/);
        assert.match(skill.note, /rerun_plan/);
        assert.match(skill.note, /workflow-rerun/);
    }
}

console.log("✅ Phase 3 I7 MCP re-run (rerun_from, rerun_plan, viaMcp, M1 skew) unit suite passed");
