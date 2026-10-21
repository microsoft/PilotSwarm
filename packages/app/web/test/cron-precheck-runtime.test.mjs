/**
 * Session PRECHECK selector over the portal runtime: session:manage (the
 * owner, or an admin acting on any session), a server-stamped actor that the
 * client cannot override, and a bounded wait.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { PortalRuntime } from "../runtime.js";

function runtimeFor(calls) {
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.authz = { ...runtime.authz, enforce: true, adminScope: "unrestricted" };
    runtime.start = async () => {};
    const owner = { provider: "entra", subject: "alice" };
    runtime.transport = {
        getSessionAccess: async (sessionId, viewer) => ({
            rootSessionId: sessionId,
            isSystem: false,
            visibility: "shared_write",
            owner: { ...owner, displayName: "Alice" },
            viewerIsOwner: viewer.provider === owner.provider && viewer.subject === owner.subject,
            viewerShareAccess: viewer.subject === "alice" ? null : "write",
        }),
        setSessionCronPrecheck: async (sessionId, input, options) => {
            calls.push({ sessionId, input, options });
            return { ok: true, precheck: input.precheck, revision: input.expectedRevision + 1, appliesOn: "next_fire" };
        },
    };
    return runtime;
}
const as = (subject, role = "user", email) => ({
    principal: { provider: "entra", subject, ...(email ? { email } : {}) },
    authorization: { role },
});

test("setSessionCronPrecheck is declared session:manage", async () => {
    const { OPERATIONS } = await import("../../../sdk/api/src/protocol.js");
    const op = OPERATIONS.find((candidate) => candidate.name === "setSessionCronPrecheck");
    assert.equal(op.access, "session:manage");
    assert.equal(op.path, "/management/sessions/:sessionId/cron-precheck");
    assert.equal(Object.hasOwn(op.params, "actor"), false, "the actor is never a client parameter");
});

test("the owner and an admin can change it; the actor is stamped from the principal", async () => {
    const calls = [];
    const runtime = runtimeFor(calls);
    const body = { sessionId: "s1", precheck: "pkg-queue", expectedRevision: 2, reason: "use the package check", actor: "forged" };
    await runtime.call("setSessionCronPrecheck", body, as("alice", "user", "alice@example.com"));
    await runtime.call("setSessionCronPrecheck", { ...body, precheck: null, options: { timeoutMs: 1e12 } }, as("ada", "admin", "ada@example.com"));
    assert.deepEqual(calls.map((call) => call.input), [
        { precheck: "pkg-queue", expectedRevision: 2, reason: "use the package check", actor: "alice@example.com" },
        { precheck: null, expectedRevision: 2, reason: "use the package check", actor: "ada@example.com" },
    ]);
    assert.deepEqual(calls.map((call) => call.options.timeoutMs), [30_000, 120_000]);
});

test("a shared-write user who is not the owner cannot change it", async () => {
    const calls = [];
    await assert.rejects(
        runtimeFor(calls).call("setSessionCronPrecheck", { sessionId: "s1", precheck: "queue", expectedRevision: 0, reason: "x" }, as("bob")),
        (error) => error.status === 403,
    );
    assert.equal(calls.length, 0);
});
