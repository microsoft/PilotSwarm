/**
 * Per-user notifications over the portal runtime: any authenticated user
 * reads and marks only their own rows, chosen by the server principal and
 * never by a request parameter.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PortalRuntime } from "../runtime.js";

function runtimeFor(calls) {
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.authz = { ...runtime.authz, enforce: true, adminScope: "unrestricted" };
    runtime.start = async () => {};
    runtime.transport = {
        listMyNotifications: async (options, owner) => {
            calls.push({ op: "list", options, owner });
            return [];
        },
        markNotificationsRead: async (ids, owner) => {
            calls.push({ op: "read", ids, owner });
            return { updated: 1 };
        },
    };
    return runtime;
}
const as = (subject, role = "user") => ({ principal: { provider: "entra", subject }, authorization: { role } });

test("notification ops are authenticated-only and take no principal parameters", async () => {
    const { OPERATIONS } = await import("../../../sdk/api/src/protocol.js");
    for (const name of ["listMyNotifications", "markNotificationsRead"]) {
        const op = OPERATIONS.find((candidate) => candidate.name === name);
        assert.equal(op.access, "authed", name);
        for (const forbidden of ["owner", "principal", "provider", "subject", "recipient"]) {
            assert.equal(Object.hasOwn(op.params ?? {}, forbidden), false, `${name} must not accept ${forbidden}`);
        }
    }
});

test("list and mark-read always act on the server principal", async () => {
    const calls = [];
    const runtime = runtimeFor(calls);
    await runtime.call("listMyNotifications", { unreadOnly: "true", limit: "25", subject: "victim", owner: { subject: "victim" } }, as("bob"));
    await runtime.call("listMyNotifications", {}, as("bob"));
    await runtime.call("markNotificationsRead", { ids: ["7"], subject: "victim" }, as("bob"));
    await runtime.call("markNotificationsRead", {}, as("ada", "admin"));
    assert.deepEqual(calls.map(({ op, options, ids, owner }) => [op, options ?? ids, owner.subject]), [
        ["list", { unreadOnly: true, limit: 25 }, "bob"],
        ["list", { unreadOnly: false }, "bob"],
        ["read", ["7"], "bob"],
        ["read", null, "ada"],
    ]);
});

test("an unauthenticated caller cannot read or mark notifications", async () => {
    const calls = [];
    const runtime = runtimeFor(calls);
    for (const op of ["listMyNotifications", "markNotificationsRead"]) {
        await assert.rejects(runtime.call(op, {}, { principal: null, authorization: { role: "user" } }),
            (error) => error.status === 401 || error.status === 403);
    }
    assert.equal(calls.length, 0);
});
