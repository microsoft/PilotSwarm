import test from "node:test";
import assert from "node:assert/strict";
import { registerTurnControlTools } from "../../dist/src/tools/turn-control.js";

function tools(api, mgmt) {
    const handlers = new Map();
    registerTurnControlTools({ registerTool: (name, _config, handler) => handlers.set(name, handler) }, { api, mgmt });
    return handlers;
}
test("direct MCP steering reports explicit unsupported without probing session identity", async () => {
    const handlers = tools(null, new Proxy({}, { get() { throw new Error("No direct actor may reach management"); } }));
    for (const name of ["get_steering_state", "steer_turn", "get_steering_request", "list_steering_requests", "withdraw_steering_request"]) {
        const result = await handlers.get(name)({ session_id: "s", request_id: "r", text: "text", client_request_id: "c", expected_target: "t" });
        assert.equal(result.isError, true);
        const body = JSON.parse(result.content[0].text);
        assert.equal(body.code, "unsupported");
        assert.equal(body.reason, "direct_mcp_unavailable");
    }
});
test("web MCP keeps typed receipt state and adds safe-point human wording", async () => {
    const receipt = { requestId: "r", status: "submitted", disposition: "accepted" };
    const handlers = tools({}, { steerSessionTurn: async () => ({ ok: true, receipt }) });
    const result = await handlers.get("steer_turn")({ session_id: "s", text: "text", client_request_id: "c", expected_target: "t" });
    const body = JSON.parse(result.content[0].text);
    assert.deepEqual(body.receipt, receipt);
    assert.equal(body.display.label, "Waiting for a safe point");
});
