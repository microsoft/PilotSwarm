import test from "node:test";
import assert from "node:assert/strict";
import { HttpApiTransport } from "../../api/src/http-api-transport.js";
import { PilotSwarmManagementClient } from "../../dist/management-client.js";
import { WebPilotSwarmManagementClient } from "../../dist/web/web-management-client.js";

test("publisher status HTTP operation is GET with encoded exact identity and no client authority fields", async () => {
    const calls = [];
    const status = { packageId: "pkg", versions: [] };
    const transport = new HttpApiTransport({ apiUrl: "https://status.invalid", fetchImpl: async (...args) => {
        calls.push(args); return new Response(JSON.stringify(status), { headers: { "content-type": "application/json" } });
    } });
    assert.deepEqual(await transport.getAgentPackageReviewStatus("pkg / name", { isAdmin: true }), status);
    assert.equal(calls[0][0], "https://status.invalid/api/v1/agent-package-review-status/pkg%20%2F%20name");
    assert.equal(calls[0][1].method, "GET");
    assert.equal(calls[0][1].body, undefined);
});

test("provider-neutral management status preserves actor without requiring admin, and Web facade forwards only identity", async () => {
    const actor = { provider: "test", subject: "publisher" };
    const calls = [];
    const context = { _ensureStarted() {}, _catalog: { packageReviews: { publisherStatus: async (...args) => { calls.push(args); return {}; } } } };
    await PilotSwarmManagementClient.prototype.getAgentPackageReviewStatus.call(context, "pkg", actor, false);
    assert.deepEqual(calls, [[{ principal: actor, isAdmin: false }, "pkg"]]);
    await WebPilotSwarmManagementClient.prototype.getAgentPackageReviewStatus.call({ ops: { getAgentPackageReviewStatus: async params => calls.push(params) } }, "pkg");
    assert.deepEqual(calls.at(-1), { packageId: "pkg" });
});
