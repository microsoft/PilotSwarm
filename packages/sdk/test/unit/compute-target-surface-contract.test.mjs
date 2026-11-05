import test from "node:test";
import assert from "node:assert/strict";

import { PilotSwarmManagementClient } from "../../dist/management-client.js";

const principal = { provider: "test", subject: "user-1", email: "owner@example.com" };
const sharedTarget = {
    id: "target-1",
    name: "shared/pool",
    kind: "pool",
    class: "shared",
    displayName: null,
    config: { selector: "any" },
    enabled: true,
    manageable: true,
    createdAt: null,
    updatedAt: null,
};

function managementClient({ target = sharedTarget } = {}) {
    const calls = [];
    const store = {
        lookupUserId: async () => 4,
        list: async () => target ? [target] : [],
        create: async (input, actor, isAdmin) => {
            calls.push({ method: "create", input, actor, isAdmin });
            return { ...input, id: "new-target", class: "shared", enabled: true };
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

test("an administrator creates targets in the shared namespace and nowhere else", async () => {
    const { client, calls } = managementClient({ target: null });
    const admin = { principal, isAdmin: true };
    const result = await client.createComputeTarget(admin, { label: "build-pool", kind: "pool" });
    assert.equal(result.target.name, "shared/build-pool");
    assert.equal(calls[0].isAdmin, true);
    await assert.rejects(
        client.createComputeTarget(admin, { name: "someone@example.com/build-pool", kind: "pool" }),
        (error) => error.code === "COMPUTE_TARGET_FORBIDDEN",
    );
});

test("only an administrator may create a compute target", async () => {
    const { client } = managementClient({ target: null });
    await assert.rejects(
        client.createComputeTarget({ principal, isAdmin: false }, { label: "build-pool", kind: "pool" }),
        (error) => error.code === "COMPUTE_TARGET_FORBIDDEN",
    );
});

test("a bare label is shorthand for the shared target of that label", async () => {
    const { client, calls } = managementClient();
    await client.updateComputeTarget({ principal, isAdmin: true }, { name: "pool", enabled: false });
    assert.equal(calls.find((call) => call.method === "update").name, "shared/pool");
});
