import test from "node:test";
import assert from "node:assert/strict";
import { NodeSdkTransport } from "../src/node-sdk-transport.js";

for (const isAdmin of [false, true]) {
    test(`rename uses the caller's catalog and normalized session agent (admin=${isAdmin})`, async () => {
        const transport = new NodeSdkTransport({ store: "sqlite::memory:", mode: "local" });
        const viewer = { provider: "dev", subject: "rename-owner" };
        const calls = [];
        transport.mgmt = {
            getSession: async (id) => {
                assert.equal(id, "session");
                return { agentId: "fleet-watcher" };
            },
            renameSession: async (...args) => calls.push(args),
        };
        transport.listCreatableAgents = async (...args) => {
            assert.deepEqual(args, [viewer, isAdmin]);
            return [
                { name: "Fleet Watcher", title: "Ops: Fleet Watcher" },
                { name: "fleet_watcher", title: "Ops" },
                { name: "another-agent", title: "Private catalog title" },
                { name: "fleet-watcher", title: "" },
            ];
        };
        await transport.renameSession("session", "nightly", { viewer, isAdmin });
        assert.deepEqual(calls, [["session", "nightly", { agentTitles: ["Ops: Fleet Watcher", "Ops"] }]]);
    });
}

test("a failed catalog lookup still renames with no catalog titles", async () => {
    const transport = new NodeSdkTransport({ store: "sqlite::memory:", mode: "local" });
    const calls = [];
    transport.mgmt = {
        getSession: async () => ({ agentId: "ops" }),
        renameSession: async (...args) => calls.push(args),
    };
    transport.listCreatableAgents = async () => { throw new Error("catalog unavailable"); };
    await transport.renameSession("session", "nightly");
    assert.deepEqual(calls, [["session", "nightly", { agentTitles: [] }]]);
});
