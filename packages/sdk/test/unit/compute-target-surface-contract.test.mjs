import test from "node:test";
import assert from "node:assert/strict";

import { PilotSwarmManagementClient } from "../../dist/management-client.js";

const principal = { provider: "test", subject: "user-1", email: "owner@example.com" };
const viewer = { principal, isAdmin: false };
const personalTarget = {
    id: "target-1",
    name: "owner@example.com/my-machine",
    kind: "pool",
    class: "personal",
    ownerUserId: 4,
    displayName: null,
    config: { selector: "mine" },
    enabled: true,
    manageable: true,
    createdAt: null,
    updatedAt: null,
};

function managementClient({ target = personalTarget } = {}) {
    const calls = [];
    const store = {
        lookupUserId: async () => 4,
        list: async () => target ? [target] : [],
        create: async (input, actor, isAdmin) => {
            calls.push({ method: "create", input, actor, isAdmin });
            return { ...input, id: "new-target", ownerUserId: actor, enabled: true };
        },
        update: async (name, input, actor, isAdmin) => {
            calls.push({ method: "update", name, input, actor, isAdmin });
            return { ...target, ...input, name };
        },
        delete: async (name, actor, isAdmin) => {
            calls.push({ method: "delete", name, actor, isAdmin });
            return 0;
        },
    };
    const client = Object.create(PilotSwarmManagementClient.prototype);
    client._started = true;
    client._catalog = { computeTargets: store, recordAuthzAudit: async (audit) => calls.push({ method: "audit", audit }) };
    return { client, calls };
}


test("personal target creation assigns the signed-in owner namespace", async () => {
    const { client, calls } = managementClient({ target: null });
    const result = await client.createMyComputeTarget(viewer, { label: "workstation", kind: "pool" });
    assert.equal(result.target.name, "owner@example.com/workstation");
    assert.equal(calls[0].input.class, "personal");
    assert.equal(calls[0].actor, 4);
    assert.equal(calls[0].isAdmin, false);
    await assert.rejects(
        client.createMyComputeTarget(viewer, { name: "someone-else@example.com/workstation", kind: "pool" }),
        (error) => error.code === "COMPUTE_TARGET_FORBIDDEN",
    );
});
