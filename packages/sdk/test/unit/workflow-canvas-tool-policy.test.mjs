import test from "node:test";
import assert from "node:assert/strict";
import {
    WORKFLOW_CANVAS_TOOLS, WORKFLOW_SCRIPT_CANVAS_TOOLS, admittedWorkflowToolGrant, allowedWorkflowTool, captureWorkflowTools,
    isWorkflowCanvasTool, isWorkflowControlTool, isWorkflowScriptRefusedCanvasTool, resolveWorkflowTool, validateWorkflowToolArguments,
    workflowCanvasToolMissingMessage, workflowScriptCanvasToolMessage, workflowToolGrant,
} from "../../dist/workflow/tool-policy.js";
import * as policy from "../../dist/workflow/tool-policy.js";
import { WORKFLOW_SCRIPT_MUST_NAME_CANVAS } from "../../dist/canvas-support.js";

const allowed = ["draw_canvas", "update_canvas", "show_canvas", "read_canvas", "canvas_kv"];
const refused = ["publish_canvas_app", "find_canvas_app"];
const metadata = name => ({ name, description: name, input_schema: { type: "object" } });
const M3 = 'A Workflow script must name a canvas: pass session_id "parent" (the agent that started this Workflow) or the session id of an agent above it.';
const M4 = name => `Canvas tool '${name}' cannot run in a Workflow script.`;
const M5 = name => `Canvas tool '${name}' is not available to this Workflow: the agent that starts it cannot use it.`;

test("D2: seven canvas tools; scripts may call five of them", () => {
    assert.deepEqual([...WORKFLOW_CANVAS_TOOLS].sort(), [...allowed, ...refused].sort());
    assert.deepEqual([...WORKFLOW_SCRIPT_CANVAS_TOOLS].sort(), [...allowed].sort());
    for (const name of [...allowed, ...refused]) {
        assert.equal(isWorkflowCanvasTool(name), true, name);
        assert.equal(isWorkflowCanvasTool(`x/${name}`), true, `leaf of x/${name}`);
        assert.equal(isWorkflowControlTool(name), false, name);
    }
    for (const name of allowed) assert.equal(isWorkflowScriptRefusedCanvasTool(name), false, name);
    for (const name of refused) {
        assert.equal(isWorkflowScriptRefusedCanvasTool(name), true, name);
        assert.equal(isWorkflowScriptRefusedCanvasTool(`functions.${name}`), true, `leaf of functions.${name}`);
    }
    assert.equal(isWorkflowCanvasTool("read_facts"), false);
    assert.equal(isWorkflowScriptRefusedCanvasTool("read_facts"), false);
    assert.equal(workflowScriptCanvasToolMessage("publish_canvas_app"), M4("publish_canvas_app"));
    assert.equal(workflowCanvasToolMissingMessage("draw_canvas"), M5("draw_canvas"));
});

test("D4: the old live-session predicate and message are gone", () => {
    assert.deepEqual(Object.keys(policy).filter(name => /LiveSession/.test(name)), []);
});

test("D2: the five script canvas tools are captured as bare system tools; the two refused ones are not", () => {
    const tools = [...allowed, ...refused].map(metadata).concat([metadata("read_facts")]);
    assert.deepEqual(captureWorkflowTools(tools).map(tool => tool.name), [...allowed, "read_facts"]);
    for (const name of allowed) assert.equal(allowedWorkflowTool(metadata(name)), true, name);
    for (const name of refused) assert.equal(allowedWorkflowTool(metadata(name)), false, name);
});

test("D2: an MCP or package tool named like a canvas tool is never admitted", () => {
    for (const name of [...allowed, ...refused]) {
        for (const tool of [
            { ...metadata(name), mcpServerName: "x", mcpToolName: name },
            metadata(`x/${name}`),
            { ...metadata(`functions.${name}`), namespacedName: `functions.${name}` },
            { ...metadata(name), namespacedName: `x/${name}` },
            { ...metadata(`mcp_${name}`), mcpServerName: "canvas", mcpToolName: name },
            { ...metadata("alias"), namespacedName: `canvas/${name}` },
        ]) {
            assert.equal(allowedWorkflowTool(tool), false, JSON.stringify(tool));
            assert.deepEqual(captureWorkflowTools([tool]), [], JSON.stringify(tool));
        }
    }
});

test("Review focus 5: a starter holding both a bare and an MCP draw_canvas captures only the bare one, and a script's call resolves to it", () => {
    const bare = metadata("draw_canvas");
    const mcp = { ...metadata("draw_canvas"), namespacedName: "x/draw_canvas", mcpServerName: "x", mcpToolName: "draw_canvas",
        input_schema: { type: "object", properties: { other: { type: "string" } } } };
    const grants = captureWorkflowTools([bare, mcp]);
    assert.deepEqual(grants, [workflowToolGrant(bare)]);
    assert.equal(resolveWorkflowTool("draw_canvas", grants, [bare, mcp]), bare);
    assert.throws(() => resolveWorkflowTool("x/draw_canvas", grants, [bare, mcp]), /not uniquely admitted/);
    // An old stored grant that holds the MCP tool still never resolves to it.
    const stale = [workflowToolGrant(mcp)];
    assert.throws(() => resolveWorkflowTool("draw_canvas", stale, [bare, mcp]), /not uniquely admitted/);
    assert.throws(() => admittedWorkflowToolGrant("x/draw_canvas", stale), /not uniquely admitted/);
});

test("D4: a script call of publish_canvas_app or find_canvas_app is refused with M4, even with an old grant", () => {
    for (const name of refused) {
        const grant = workflowToolGrant(metadata(name));
        assert.throws(() => resolveWorkflowTool(name, [grant], [metadata(name)]), { message: M4(name) });
        assert.throws(() => admittedWorkflowToolGrant(name, [grant]), { message: M4(name) });
        assert.throws(() => admittedWorkflowToolGrant(name, []), { message: M4(name) });
    }
    for (const name of allowed) {
        const grant = workflowToolGrant(metadata(name));
        assert.equal(resolveWorkflowTool(name, [grant], [metadata(name)]).name, name);
        assert.deepEqual(admittedWorkflowToolGrant(name, [grant]), grant);
        assert.throws(() => admittedWorkflowToolGrant(name, []), /not uniquely admitted/);
    }
});

test("D8: script canvas arguments name a canvas and, when given, a slot 1-10", () => {
    assert.equal(WORKFLOW_SCRIPT_MUST_NAME_CANVAS, M3);
    for (const name of allowed) {
        for (const args of [{}, { data: {} }, { session_id: "" }, { session_id: "   " }, { session_id: 7 }, { session_id: null }]) {
            assert.throws(() => validateWorkflowToolArguments(name, args), { message: M3 }, `${name} ${JSON.stringify(args)}`);
        }
        for (const slot of [0, 11, 1.5, "eleven", -1]) {
            assert.throws(() => validateWorkflowToolArguments(name, { session_id: "parent", slot }),
                { message: "slot must be an integer 1-10" }, `${name} slot ${JSON.stringify(slot)}`);
        }
        for (const args of [{ session_id: "parent" }, { session_id: "parent", slot: 10 }, { session_id: "parent", slot: 1 }]) {
            assert.doesNotThrow(() => validateWorkflowToolArguments(name, args), `${name} ${JSON.stringify(args)}`);
        }
    }
    assert.throws(() => validateWorkflowToolArguments("update_canvas", { data: {} }), { message: M3 });
    assert.throws(() => validateWorkflowToolArguments("update_canvas", { session_id: "parent", slot: 11 }), /slot must be an integer 1-10/);
    assert.doesNotThrow(() => validateWorkflowToolArguments("update_canvas", { session_id: "parent", data: {} }));
    assert.doesNotThrow(() => validateWorkflowToolArguments("bash", { session_id: "" }));
    assert.doesNotThrow(() => validateWorkflowToolArguments("read_facts", { slot: 11 }));
});
