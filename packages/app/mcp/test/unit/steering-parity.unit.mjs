import test from "node:test";
import assert from "node:assert/strict";
import { registerTurnControlTools } from "../../dist/src/tools/turn-control.js";
import { registerSessionTools } from "../../dist/src/tools/sessions.js";

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

test("direct MCP receipt-linked resend refuses before any session or queue lookup", async () => {
    const handlers = new Map();
    const neverRead = new Proxy({}, { get() { throw new Error("Direct receipt resend must not inspect or enqueue as an inferred actor"); } });
    registerSessionTools({ registerTool: (name, _config, handler) => handlers.set(name, handler) },
        { api: null, mgmt: neverRead, client: neverRead });
    const result = await handlers.get("send_message")({
        session_id: "s", message: "retained guidance", steering_request_id: "r",
        client_message_ids: ["fresh-resend"], enqueue_only: true,
    });
    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), {
        error: "Steering receipt resend is unsupported in direct-store MCP mode. Use authenticated Web API mode.",
        code: "unsupported", reason: "direct_mcp_unavailable",
    });
});
