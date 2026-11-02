/**
 * Workflow v2 (INACTIVE): NodeSdkTransport.updateWorkflow, the portal's and
 * the TUI direct mode's way to a person's workflow command. The portal always
 * names the signed-in caller (null without one) and that caller is passed as
 * it is; the TUI names none, and its own user is the caller. The command is
 * passed as it is; the management client decides everything else.
 *
 * Run: node --test tui/test/workflow-command-transport.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { NodeSdkTransport } from "../src/node-sdk-transport.js";

function transportWith(currentUser) {
    const calls = [];
    const transport = {
        currentUser,
        mgmt: { updateWorkflow: async (...args) => { calls.push(args); return { operation: args[1]?.operation ?? null }; } },
        updateWorkflow: NodeSdkTransport.prototype.updateWorkflow,
    };
    return { transport, calls };
}

test("passes the portal's caller as it is, or the TUI's own user when no caller is named", async () => {
    const command = { operation: "pause", operation_id: "p-1" };
    const { transport, calls } = transportWith({ provider: "test", subject: "local-user", email: "x@example.com" });
    assert.deepEqual(await transport.updateWorkflow("wf-1", command, { principal: { provider: "dev", subject: "alice" } }), { operation: "pause" });
    await transport.updateWorkflow("wf-1", command, { principal: null });
    await transport.updateWorkflow("wf-1", command);
    assert.deepEqual(calls, [
        ["wf-1", command, { principal: { provider: "dev", subject: "alice" } }],
        ["wf-1", command, { principal: null }],
        ["wf-1", command, { principal: { provider: "test", subject: "local-user" } }],
    ]);
    const anonymous = transportWith(null);
    await anonymous.transport.updateWorkflow("wf-1", command);
    assert.deepEqual(anonymous.calls, [["wf-1", command, { principal: null }]]);
});
