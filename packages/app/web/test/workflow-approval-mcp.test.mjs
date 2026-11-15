import test from "node:test";
import assert from "node:assert/strict";
import { registerWorkflowTools } from "../../mcp/dist/src/tools/workflows.js";

test("generic MCP Workflow commands cannot forward a person's consent, in either provenance mode", async () => {
    for (const originatingSessionId of [undefined, "agent-session"]) {
        const registered = new Map();
        const calls = [];
        registerWorkflowTools({ registerTool(name, config, handler) { registered.set(name, { config, handler }); } }, {
            workflowCommands: true, workflowTestMode: false, originatingSessionId,
            mgmt: { updateWorkflow: async (...args) => { calls.push(args); return {}; } },
        });
        const tool = registered.get("update_workflow");
        assert.ok(!tool.config.description.includes("approval_respond"));
        const result = await tool.handler({ session_id: "wf", command: { operation: "approval_respond", operation_id: "op",
            run_id: "run", approval_id: "visit", context_sha256: "a".repeat(64), decision: "approved" } });
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /FORBIDDEN/);
        assert.equal(calls.length, 0);
    }
});
