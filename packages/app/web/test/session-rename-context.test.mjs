import test from "node:test";
import assert from "node:assert/strict";
import { PortalRuntime } from "../runtime.js";

for (const role of ["user", "admin"]) {
    test(`rename forwards the authenticated viewer and resource role (${role})`, async () => {
        const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
        runtime.start = async () => {};
        const calls = [];
        runtime.transport = {
            getSessionAccess: async () => ({ canManage: true, canWrite: true, canRead: true }),
            renameSession: async (...args) => calls.push(args),
        };
        const principal = { provider: "dev", subject: "rename-owner", email: "owner@example.com", displayName: "Owner" };
        await runtime.call("renameSession", {
            sessionId: "session",
            title: "nightly",
            viewer: { provider: "dev", subject: "forged" },
            isAdmin: true,
        }, { principal, authorization: { role } });
        assert.deepEqual(calls, [["session", "nightly", { viewer: principal, isAdmin: role === "admin" }]]);
    });
}
