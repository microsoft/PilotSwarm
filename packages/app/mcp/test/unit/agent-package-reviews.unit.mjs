import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAgentPackageTools } from "../../dist/src/tools/agent-packages.js";

async function fixture(t, options = {}) {
    const calls = [];
    const mgmt = new Proxy({}, { get: (_, method) => async (...args) => { calls.push({ method, args }); return []; } });
    const server = new McpServer({ name: "package-review-test", version: "1" });
    registerAgentPackageTools(server, { mgmt, web: {}, admin: true, role: "admin", agentMgmt: "full", ...options });
    const client = new Client({ name: "review-client", version: "1" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    await client.connect(c);
    t.after(async () => { await client.close(); await server.close(); });
    return { client, calls };
}

test("MCP review tools preserve exact immutable candidate CAS, without supplying authority from arguments", async (t) => {
    const { client, calls } = await fixture(t);
    const sha256 = "a".repeat(64);
    await client.callTool({ name: "decide_agent_package_review", arguments: {
        package_id: "pkg", version_id: "v2", sha256, expected_revision: 4,
        decision: "revoked", reason: "review denied",
    } });
    assert.deepEqual(calls, [{ method: "decideAgentPackageReview", args: [{
        packageId: "pkg", versionId: "v2", sha256, expectedRevision: 4,
        decision: "revoked", reason: "review denied",
    }, null, true] }]);
    const invalid = await client.callTool({ name: "decide_agent_package_review", arguments: {
        package_id: "pkg", version_id: "v2", sha256: "substituted", expected_revision: 4,
        decision: "revoked", reason: "review denied",
    } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 1);
});

test("MCP runtime status preserves exact identity and never fabricates fencing completion", async t => {
    const { client, calls } = await fixture(t);
    await client.callTool({ name: "get_agent_package_runtime_status", arguments: {
        package_id: "deleted-package", version_id: "old-version", sha256: "b".repeat(64),
    } });
    assert.deepEqual(calls, [{ method: "getAgentPackageRuntimeStatus", args: [{
        packageId: "deleted-package", versionId: "old-version", sha256: "b".repeat(64),
    }, null, true] }]);
});

for (const options of [{ role: "user", admin: false }, { role: "anonymous" }, { agentMgmt: "read" }, { agentMgmt: "off" }]) {
    test(`MCP review mutation not registered for ${JSON.stringify(options)}`, async (t) => {
        const { client } = await fixture(t, options);
        if (options.agentMgmt === "off") {
            await assert.rejects(client.listTools(), /Method not found/);
            return;
        }
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        assert.equal(names.includes("decide_agent_package_review"), false);
        assert.equal(names.includes("activate_agent_package_version"), false);
        assert.equal(names.includes("rebind_session_agent_package"), false);
        if (options.role === "anonymous" || options.role === "user") {
            assert.equal(names.includes("list_agent_package_reviews"), false);
        }

        test("MCP activation and session rebind preserve exact CAS identities on the real protocol", async (t) => {
            const { client, calls } = await fixture(t);
            const sha256 = "a".repeat(64);
            await client.callTool({ name: "activate_agent_package_version", arguments: {
                package_id: "pkg", version_id: "v2", sha256, expected_review_revision: 2,
                expected_activation_revision: 3, expected_active_version_id: "v1", reason: "activate exact target",
            } });
            await client.callTool({ name: "rebind_session_agent_package", arguments: {
                session_id: "s1", package_id: "pkg", version_id: "v2", sha256,
                agent_name: "kit:helper", expected_binding_revision: 1, reason: "migrate session",
            } });
            assert.deepEqual(calls, [
                { method: "activateAgentPackageVersion", args: [{
                    packageId: "pkg", versionId: "v2", sha256, expectedReviewRevision: 2,
                    expectedActivationRevision: 3, expectedActiveVersionId: "v1", reason: "activate exact target",
                }, null, true] },
                { method: "rebindSessionAgentPackage", args: [{
                    sessionId: "s1", packageId: "pkg", versionId: "v2", sha256,
                    agentName: "kit:helper", expectedBindingRevision: 1, reason: "migrate session",
                }, null, true] },
            ]);
            await client.callTool({ name: "rebind_session_agent_package", arguments: {
                session_id: "historical", package_id: "pkg", version_id: "v2", sha256,
                agent_name: "kit:helper", expected_binding_revision: 0, reason: "explicit initial binding",
            } });
            assert.equal(calls.at(-1).args[0].expectedBindingRevision, 0);
        });
    });
}
