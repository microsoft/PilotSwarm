import test from "node:test";
import assert from "node:assert/strict";
import {
    admittedWorkflowToolGrant, allowedWorkflowTool, captureWorkflowTools, isWorkflowControlTool, isWorkflowLiveSessionTool,
    resolveWorkflowTool, workflowToolGrant,
} from "../../dist/workflow/tool-policy.js";

const canvasTools = ["draw_canvas", "update_canvas", "show_canvas", "read_canvas", "canvas_kv", "publish_canvas_app", "find_canvas_app"];
const metadata = name => ({ name, description: name, input_schema: { type: "object" } });

test("FB-014: bridge-only canvas tools are not captured; ordinary tools remain available", () => {
    const tools = [...canvasTools.map(metadata), metadata("read_facts"), metadata("write_artifact")];
    assert.deepEqual(captureWorkflowTools(tools).map(tool => tool.name), ["read_facts", "write_artifact"]);
    for (const name of canvasTools) {
        assert.equal(isWorkflowLiveSessionTool(name), true);
        assert.equal(isWorkflowControlTool(name), false);
        assert.equal(allowedWorkflowTool(metadata(name)), false);
    }
});

test("FB-014: aliases and old stored canvas grants cannot bypass the live-session restriction", () => {
    for (const name of canvasTools) {
        for (const tool of [
            metadata(name),
            { ...metadata(`functions.${name}`), namespacedName: `functions.${name}` },
            { ...metadata(`mcp_${name}`), mcpServerName: "canvas", mcpToolName: name },
            { ...metadata("alias"), namespacedName: `canvas/${name}` },
        ]) {
            assert.equal(allowedWorkflowTool(tool), false, JSON.stringify(tool));
            assert.deepEqual(captureWorkflowTools([tool]), []);
            const grant = workflowToolGrant(tool);
            assert.throws(() => resolveWorkflowTool(tool.name, [grant], [tool]), /live agent session|not uniquely admitted/);
            assert.throws(() => admittedWorkflowToolGrant(tool.name, [grant]), /live agent session|not uniquely admitted/);
        }
        assert.throws(() => admittedWorkflowToolGrant(name, []), {
            message: `Canvas tool '${name}' needs a live agent session and cannot run in a Workflow script. `
                + "Use an agent step, or send the update to the parent session.",
        });
    }
});
