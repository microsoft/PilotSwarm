import test from "node:test";
import assert from "node:assert/strict";
import { scriptToolRequirements, workflowToolDiagnostics, requireWorkflowToolRequirements } from "../../dist/workflow/tool-requirements.js";
import { isWorkflowCanvasTool, workflowToolGrant } from "../../dist/workflow/tool-policy.js";

const grant = (...tools) => ({
    tools: tools.map(name => workflowToolGrant({ name, input_schema: { type: "object" } })), excludedTools: [],
});
const ir = source => ({ nodes: { poll: { id: "poll", type: "script", source } } });

test("FB-009: direct literal calls are extracted as JavaScript, not text matches", () => {
    const source = [
        '// callTool("comment", {})',
        'const text = \'callTool("quoted", {})\';',
        'const regex = /callTool\\("regex"/;',
        'await callTool("facts/read", {});',
        "await callTool('store_\\u0066act', {});",
        'await callTool(`update_status`, {});',
        'await callTool("facts/read", {});',
        'await callTool?.("optional", {});',
        'await callTool(context.inputs.tool, {});',
        'await callTool(`prefix_${context.input.tool}`, {});',
    ].join("\n");
    assert.deepEqual(scriptToolRequirements(source), {
        tools: ["facts/read", "store_fact", "update_status", "optional"], dynamic: true, unchecked: false,
    });
});

test("FB-009: local callTool declarations are not the runtime helper", () => {
    for (const source of [
        'function f(callTool) { callTool("local", {}); } await callTool("actual", {});',
        'function f({ callTool }) { callTool("local", {}); } await callTool("actual", {});',
        'function f() { callTool("local", {}); if (true) { var callTool = () => {}; } } await callTool("actual", {});',
        '{ callTool("local", {}); const callTool = () => {}; } await callTool("actual", {});',
        '{ function callTool() {} callTool("local", {}); } await callTool("actual", {});',
        'try {} catch (callTool) { callTool("local", {}); } await callTool("actual", {});',
        'for (const callTool of []) { callTool("local", {}); } await callTool("actual", {});',
        'const f = function callTool() { callTool("local", {}); }; await callTool("actual", {});',
    ]) assert.deepEqual(scriptToolRequirements(source), { tools: ["actual"], dynamic: false, unchecked: false }, source);
});

test("FB-009: unparseable and dynamic names are explicitly unchecked, never evaluated", () => {
    assert.equal(scriptToolRequirements("const = bad").unchecked, true);
    assert.match(scriptToolRequirements("const = bad").syntaxError, /Unexpected token/);
    assert.deepEqual(scriptToolRequirements('await callTool("read_" + "facts", {})'), { tools: [], dynamic: true, unchecked: false });
    assert.deepEqual(workflowToolDiagnostics(ir("const = bad"), null).map(item => item.code), ["WORKFLOW_TOOLS_UNCHECKED"]);
    const warnings = requireWorkflowToolRequirements(ir("await callTool(context.input.tool, {})"), null, "poller");
    assert.equal(warnings[0].code, "WORKFLOW_TOOLS_DYNAMIC");
    assert.match(warnings[0].message, /cannot check which tool/);
});

test("FB-009: static-block vars and function-body vars do not hide calls in outer or parameter environments", () => {
    for (const source of [
        'class C { static { var callTool = () => {}; callTool("local", {}); } } await callTool("actual", {});',
        'class C { static { if (true) { var callTool = () => {}; } callTool("local", {}); } } await callTool("actual", {});',
        'function f(value = callTool("actual", {})) { var callTool = () => {}; callTool("local", {}); }',
    ]) assert.deepEqual(scriptToolRequirements(source), { tools: ["actual"], dynamic: false, unchecked: false }, source);
});

test("FB-009: a switch discriminant uses the outer helper, not the case block's binding", () => {
    const source = 'switch (await callTool("actual", {})) { case 1: break; default: const callTool = () => {}; callTool("local", {}); }';
    assert.deepEqual(scriptToolRequirements(source), { tools: ["actual"], dynamic: false, unchecked: false });
});

test("FB-009: script grant diagnostics use the nested source path and give a person actionable guidance", () => {
    const compiled = { nodes: {
        parallel: { id: "parallel", type: "parallel", body: { states: ["poll"] } },
        poll: { id: "poll", type: "script", source: 'await callTool("read_facts", {});' },
    } };
    const diagnostic = workflowToolDiagnostics(compiled, null)[0];
    assert.equal(diagnostic.path, "states.parallel.body.states.poll.source");
    assert.match(diagnostic.message, /Ask the session's agent to start it with workflow_definition/);
});

test("FB-009: Start refuses literal tools absent, excluded or ambiguous in the captured grant", () => {
    const source = 'await callTool("read_facts", {});';
    for (const binding of [null, grant(), { ...grant("read_facts"), excludedTools: ["read_facts"] }, grant("read_facts", "read_facts")]) {
        assert.throws(() => requireWorkflowToolRequirements(ir(source), binding, "poller"), error => {
            assert.equal(error.code, "WORKFLOW_TOOLS_UNAVAILABLE");
            assert.match(error.message, /read_facts/);
            assert.match(error.message, /Nothing was started/);
            assert.equal(error.details.diagnostics[0].path, "states.poll.source");
            return true;
        });
    }
    assert.deepEqual(requireWorkflowToolRequirements(ir(source), grant("read_facts"), "poller"), []);
    assert.deepEqual(requireWorkflowToolRequirements(ir('await setResult("success", null);'), null, "poller"), []);
});

test("FB-009: every flattened script is checked, with exact MCP aliases", () => {
    const binding = grant("actual");
    binding.tools[0].namespacedName = "facts.read";
    binding.tools[0].mcpServerName = "facts";
    binding.tools[0].mcpToolName = "read";
    const nodes = {
        first: { id: "first", type: "script", source: 'callTool("facts.read", {})' },
        second: { id: "second", type: "script", source: 'callTool("facts/read", {})' },
        third: { id: "third", type: "script", source: 'callTool("missing", {})' },
    };
    assert.deepEqual(workflowToolDiagnostics({ nodes }, binding).map(item => item.path), ["states.third.source"]);
});

test("FB-009: Save warnings distinguish unavailable tools from an unknown grant", () => {
    const source = 'await callTool("read_facts", {});';
    assert.deepEqual(workflowToolDiagnostics(ir(source), null, false).map(item => item.code), ["WORKFLOW_TOOLS_UNCHECKED"]);
    assert.deepEqual(workflowToolDiagnostics(ir(source), grant()).map(item => item.code), ["WORKFLOW_TOOL_NOT_GRANTED"]);
    assert.deepEqual(workflowToolDiagnostics(ir(source), grant("read_facts")), []);
});

test("D4: Start admits a script's literal canvas call that the starter's grant holds", () => {
    const source = 'await callTool("update_canvas", { session_id: "parent", data: {} }); await callTool("draw_canvas", { session_id: "parent", html: "x" });';
    assert.deepEqual(workflowToolDiagnostics(ir(source), grant("update_canvas", "draw_canvas")), []);
    assert.deepEqual(requireWorkflowToolRequirements(ir(source), grant("update_canvas", "draw_canvas"), "board-sync"), []);
    // Agent-step bindings still drop every canvas grant: agent steps get the canvas tools as system tools.
    assert.equal(isWorkflowCanvasTool("update_canvas"), true);
});

test("D4: Start refuses publish_canvas_app and find_canvas_app in a script with M4, even for an old grant", () => {
    for (const name of ["publish_canvas_app", "find_canvas_app"]) {
        for (const binding of [null, grant(name)]) {
            const source = `await callTool("${name}", { session_id: "parent" });`;
            const message = `Canvas tool '${name}' cannot run in a Workflow script.`;
            assert.deepEqual(workflowToolDiagnostics(ir(source), binding).map(({ code, message }) => ({ code, message })),
                [{ code: "WORKFLOW_TOOL_LIVE_SESSION", message }]);
            assert.throws(() => requireWorkflowToolRequirements(ir(source), binding, "board-sync"), error => {
                assert.equal(error.code, "WORKFLOW_TOOLS_UNAVAILABLE");
                assert.equal(error.message, `board-sync was not started: states.poll.source: ${message} Nothing was started.`);
                assert.deepEqual(error.details.diagnostics.map(item => item.code), ["WORKFLOW_TOOL_LIVE_SESSION"]);
                return true;
            });
        }
    }
});

test("D4: a script's literal canvas call that the starter cannot use gets M5", () => {
    const source = 'await callTool("draw_canvas", { session_id: "parent", html: "x" });';
    const message = "Canvas tool 'draw_canvas' is not available to this Workflow: the agent that starts it cannot use it.";
    for (const binding of [grant(), grant("update_canvas"), { ...grant("draw_canvas"), excludedTools: ["draw_canvas"] }]) {
        assert.deepEqual(workflowToolDiagnostics(ir(source), binding).map(({ code, message }) => ({ code, message })),
            [{ code: "WORKFLOW_TOOL_NOT_GRANTED", message }]);
        assert.throws(() => requireWorkflowToolRequirements(ir(source), binding, "board-sync"), error => {
            assert.equal(error.code, "WORKFLOW_TOOLS_UNAVAILABLE");
            assert.equal(error.message, `board-sync was not started: states.poll.source: ${message} Nothing was started.`);
            return true;
        });
    }
    // With no captured grant at all, the message stays the one that asks for an agent's start.
    assert.match(workflowToolDiagnostics(ir(source), null)[0].message, /has no captured tool grant on this start/);
});
