// Unit test: read_workflow, a person's workflow read over MCP (always registered: the view, a section's next page, one
// execution's whole value), update_workflow, a person's workflow command over MCP (Workflow v2, INACTIVE), and the
// workflow support get_capabilities and the pilotswarm://capabilities resource describe (design 04 "Advertise
// capability/version in bootstrap", D11; R01, R26).
//
// update_workflow is registered only when the server context enables workflow
// commands (test-only); it sends { session_id, command } to the management
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
import { PilotSwarmManagementClient, WebPilotSwarmManagementClient } from "pilotswarm-sdk";
import { registerWorkflowTools } from "../../dist/src/tools/workflows.js";
import { registerCapabilityTools } from "../../dist/src/tools/capabilities.js";
import { registerCapabilityResources } from "../../dist/src/resources/capabilities.js";
import { workflowContextOptionsFromEnv } from "../../dist/src/context.js";

// Workflows are always on (owner 2026-11-08T08:03Z): read_workflow is always registered, PILOTSWARM_WORKFLOWS (retired)
// changes nothing.
process.env.PILOTSWARM_WORKFLOWS = "off";

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
// Always the read, whatever the retired PILOTSWARM_WORKFLOWS says; the command only with the test-only option.
assert.deepEqual([...toolsWith({ mgmt: {} }).keys()], ["read_workflow"], "the read, always");
assert.deepEqual([...toolsWith({ mgmt: {}, workflowCommands: true }).keys()].sort(), ["read_workflow", "update_workflow"], "and the command with the option");

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
    await loose({ session_id: SID, command: { operation: "publish", operation_id: "o-1" }, originating_session_id: "node-chat" });
    const bound = toolsWith({ workflowCommands: true, originatingSessionId: "bound-chat", mgmt: { updateWorkflow } }).get("update_workflow");
    await bound({ session_id: SID, command: { operation: "publish", operation_id: "o-2" } });
    await bound({ session_id: SID, command: { operation: "publish", operation_id: "o-3" }, originating_session_id: "other" });
    assert.deepEqual(calls, [[{ originatingSessionId: "node-chat" }], [{ originatingSessionId: "bound-chat" }], [{ originatingSessionId: "bound-chat" }]]);
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

// 5a. Default off, as every deployment is configured today: version 2 reads, a person's commands refused (501), no tool.
{
    const mgmt = directClient();
    const advertised = await mgmt.getWorkflowCapabilities();
    assert.deepEqual(advertised.v2.commands, { available: false, refusal: { code: "WORKFLOW_COMMANDS_UNAVAILABLE", status: 501 } });
    assert.equal(advertised.v2.read, true);
    const { tool, resource } = await describedBy(capabilityCtx(mgmt));
    assert.deepEqual(tool.workflows, advertised, "the management client's own answer, which a bootstrap carries");
    assert.deepEqual(resource.workflows, advertised);
    assert.deepEqual(tool.workflow_tools, { read: true, commands: false });
    assert.deepEqual(resource.workflow_tools, { read: true, commands: false });
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
    assert.deepEqual(tool.workflow_tools, { read: true, commands: true });
    assert.equal(toolsWith({ mgmt, workflowCommands: true }).has("update_workflow"), true);
}

// 5c. Web mode: the server's bootstrap through the SDK's web client, said as it is. Where this server and the deployment
//     differ (update_workflow registered here while the deployment refuses commands), the descriptor shows both;
//     nothing is merged or inferred.
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
    assert.deepEqual(tool.workflow_tools, { read: true, commands: true });
    assert.equal(tool.workflows.v2.commands.available, false);
    assert.equal(tool.workflows.v2.read, true);
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
    assert.deepEqual(tool.workflow_tools, { read: true, commands: false });
}

// 5e. A host that cannot be asked now, or whose answer is not an advertisement, is not an older host: get_capabilities
//     answers the error (its standard error result) and the capabilities resource read rejects; nothing says null.
for (const [mgmt, message] of [
    [{ getWorkflowCapabilities: async () => { throw new Error("bootstrap unavailable"); } }, /bootstrap unavailable/],
    [{ getWorkflowCapabilities: async () => ["not", "an", "advertisement"] }, /The workflow advertisement is a list, not an object/],
    [{ getWorkflowCapabilities: async () => "v2" }, /The workflow advertisement is a string, not an object/],
    [webClient({ ok: true, workflows: ["v2"] }), /bootstrap advertises workflows as a list/],
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
    // M0: only an option exactly true registers the command tool (the read tool is always there).
    for (const workflowCommands of ["true", 1, undefined]) {
        const tools = toolsWith({ workflowCommands, mgmt: {} });
        assert.equal(tools.has("update_workflow"), false, String(workflowCommands));
        assert.deepEqual([...tools.keys()], ["read_workflow"], String(workflowCommands));
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

// 8. The Workflow V2 test environment switch (test-only): the MCP server's context gains a person's workflow commands
//    only for the exact enabling value; otherwise nothing, so the context is created exactly as before.
for (const value of [undefined, "", "1", "true", "on", "ISOLATED-TEST-ONLY", " isolated-test-only", "isolated-test-only "]) {
    assert.deepEqual(workflowContextOptionsFromEnv(value === undefined ? {} : { PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT: value }), {}, JSON.stringify(value));
}
assert.deepEqual(workflowContextOptionsFromEnv({ PILOTSWARM_WORKFLOW_V2_TEST_ENVIRONMENT: "isolated-test-only" }),
    { workflowCommands: { requests: true }, sessionStartVersion: "1.0.83" });
console.log("✅ the Workflow V2 test environment switch: off for every value but the exact enabling one");

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
            for (const word of ["test_respond", "test_advance", "agent_mode", "fixtures", "interception_id", " test,"]) assert.ok(!off.includes(word), word);
            assert.ok(off.includes("stop when the workers run controller 1.9.0"));
            assert.ok(off.includes("grace_seconds"));
        }
        const on = descriptions({ workflowCommands: true, workflowTestMode: true, mgmt: {} });
        for (const word of ["test_respond", "test_advance", "agent_mode", "interception_id"]) assert.ok(on.includes(word), word);
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
