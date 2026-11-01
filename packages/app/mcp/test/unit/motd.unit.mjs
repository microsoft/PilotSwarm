import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerMotdTools } from "../../dist/src/tools/motd.js";

async function fixture(run, { webMode = false, grant = true } = {}) {
    const keys = ["PILOTSWARM_MCP_ACTOR_PROVIDER", "PILOTSWARM_MCP_ACTOR_SUBJECT", "PILOTSWARM_MCP_MOTD_ADMIN"];
    const prior = keys.map(k => process.env[k]);
    process.env[keys[0]] = "test"; process.env[keys[1]] = "admin";
    if (grant) process.env[keys[2]] = "true"; else delete process.env[keys[2]];
    const calls = [];
    const mgmt = new Proxy({}, { get: (_, method) => async (...args) => { calls.push({ method, args }); return { motdId: "1" }; } });
    const server = new McpServer({ name: "motd-test", version: "1.0.0" });
    registerMotdTools(server, { mgmt, admin: true, webMode });
    const client = new Client({ name: "motd-client", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try { await server.connect(b); await client.connect(a); await run(client, calls); }
    finally {
        await client.close(); await server.close();
        keys.forEach((key, i) => { if (prior[i] === undefined) delete process.env[key]; else process.env[key] = prior[i]; });
    }
}
test("MCP registers and dispatches every message tool with lossless message IDs", async () => {
    await fixture(async (client, calls) => {
        assert.equal((await client.listTools()).tools.length, 6);
        const request = { fromAt: "2020-01-01T00:00:00Z", toAt: "2090-01-01T00:00:00Z", bodyMd: "Hello", requestId: "one" };
        for (const [name, args] of [["get_current_motd", {}], ["dismiss_motd", { motdId: "9007199254740993" }],
            ["get_motd_image", { motdId: "1", mobile: true }], ["list_motds", { limit: 2, before: "9" }],
            ["create_motd", request], ["delete_motd", { motdId: "1" }]]) {
            assert.ok(!(await client.callTool({ name, arguments: args })).isError, name);
        }
        assert.equal(calls[1].args[1], "9007199254740993");
        assert.deepEqual(calls[4].args, [{ principal: { provider: "test", subject: "admin" }, isAdmin: true }, request]);
        assert.equal((await client.callTool({ name: "create_motd", arguments: { bodyMd: "missing window" } })).isError, true);
        assert.equal(calls.length, 6);
    });
});
test("MCP direct message mutations require their explicit grant", async () => {
    await fixture(async (client, calls) => {
        assert.equal((await client.callTool({ name: "delete_motd", arguments: { motdId: "1" } })).isError, true);
        assert.equal(calls.length, 0);
        await client.callTool({ name: "get_current_motd", arguments: {} });
        assert.equal(calls[0].args[0].isAdmin, false);
    }, { grant: false });
});
test("MCP web mode does not invent viewer privilege", async () => {
    await fixture(async (client, calls) => {
        await client.callTool({ name: "list_motds", arguments: {} });
        assert.equal(calls[0].args[0].isAdmin, false);
    }, { webMode: true });
});
