import test from "node:test";
import assert from "node:assert/strict";
import { PortalRuntime } from "../runtime.js";

function fixture() {
    const calls = [];
    const runtime = new PortalRuntime({ store: "sqlite::memory:", mode: "local" });
    runtime.start = async () => {};
    runtime.transport = {
        getAgentPackageReviewStatus: async (...args) => { calls.push(["status", ...args]); return { versions: [] }; },
        listAgentPackageReviews: async (...args) => { calls.push(["list", ...args]); return []; },
        decideAgentPackageReview: async (...args) => { calls.push(["decide", ...args]); },
        getAgentPackageReviewAudit: async (...args) => { calls.push(["audit", ...args]); return []; },
        getAgentPackageReviewDiff: async (...args) => { calls.push(["diff", ...args]); return { changes: [] }; },
        getAgentPackageReviewFileDiff: async (...args) => { calls.push(["fileDiff", ...args]); return { change: null }; },
        getAgentPackageRuntimeStatus: async (...args) => { calls.push(["runtime", ...args]); return { denied: true, complete: false, outstanding: 2 }; },
        activateAgentPackageVersion: async (...args) => { calls.push(["activate", ...args]); },
        getAgentPackageActivationAudit: async (...args) => { calls.push(["activationAudit", ...args]); return []; },
        getSessionAgentPackageBinding: async (...args) => { calls.push(["binding", ...args]); return null; },
        rebindSessionAgentPackage: async (...args) => { calls.push(["rebind", ...args]); },
    };
    return { runtime, calls };
}

test("publisher status uses the authenticated principal, not client owner/admin claims, including scoped administrators", async () => {
    for (const [role, scope, expectedAdmin] of [["user", "unrestricted", false], ["admin", "unrestricted", true], ["admin", "cluster", false]]) {
        const { runtime, calls } = fixture();
        runtime.authz.adminScope = scope;
        await runtime.call("getAgentPackageReviewStatus", { packageId: "pkg", owner: { provider: "fake", subject: "owner" }, isAdmin: true },
            { principal: { provider: "entra", subject: "publisher" }, authorization: { role } });
        assert.deepEqual(calls, [["status", "pkg", { provider: "entra", subject: "publisher", email: null, displayName: null }, expectedAdmin]]);
    }
    const { runtime, calls } = fixture();
    await assert.rejects(runtime.call("getAgentPackageReviewStatus", { packageId: "pkg", isAdmin: true }, { authorization: { role: "admin" } }), /authenticated/i);
    assert.deepEqual(calls, []);
});

for (const role of ["user", "anonymous", null]) {
    test(`review surface rejects ${role} despite forged body isAdmin and ownership dark launch`, async () => {
        const { runtime, calls } = fixture();
        for (const method of ["listAgentPackageReviews", "decideAgentPackageReview", "getAgentPackageReviewAudit", "getAgentPackageReviewDiff", "getAgentPackageReviewFileDiff", "getAgentPackageRuntimeStatus",
            "activateAgentPackageVersion", "getAgentPackageActivationAudit", "getSessionAgentPackageBinding", "rebindSessionAgentPackage"]) {
            await assert.rejects(runtime.call(method, {
                isAdmin: true, owner: { provider: "entra", subject: "admin" },
                input: { isAdmin: true, decision: "approved" },
            }, { principal: { provider: "entra", subject: "caller" }, authorization: { role } }), /admin/i);
        }
        assert.deepEqual(calls, []);
    });

    test("activation/rebind forward exact CAS inputs only and bind identity to the authenticated administrator", async () => {
        const { runtime, calls } = fixture();
        const context = { principal: { provider: "entra", subject: "real-admin" }, authorization: { role: "admin" } };
        const activation = {
            packageId: "pkg", versionId: "v2", sha256: "a".repeat(64), expectedReviewRevision: 2,
            expectedActivationRevision: 3, expectedActiveVersionId: "v1", reason: "switch new bindings",
        };
        const pin = { sessionId: "s1", packageId: "pkg", versionId: "v2", sha256: activation.sha256,
            agentName: "kit:helper", expectedBindingRevision: 0, reason: "explicit migration" };
        for (const [method, input] of [["activateAgentPackageVersion", activation], ["rebindSessionAgentPackage", pin]]) {
            const result = await runtime.call(method, { input: { ...input, actor: "forged", isAdmin: true } }, context);
            assert.equal(result.runtimeFencing, "not-reported");
            assert.equal(result.executionAllowed, false);
        }
        assert.deepEqual(calls.map((entry) => entry.slice(1)), [activation, pin].map((input) => [
            input, { provider: "entra", subject: "real-admin", email: null, displayName: null }, true,
        ]));
    });
}

test("admin role without authenticated principal cannot decide executable trust", async () => {
    const { runtime, calls } = fixture();
    await assert.rejects(runtime.call("decideAgentPackageReview", {}, { authorization: { role: "admin" } }), /authenticated/i);
    assert.deepEqual(calls, []);
});

test("cluster-scoped administrator cannot use global package review, activation or rebind authority", async () => {
    const { runtime, calls } = fixture();
    runtime.authz.adminScope = "cluster";
    for (const method of ["listAgentPackageReviews", "decideAgentPackageReview", "getAgentPackageReviewAudit", "getAgentPackageReviewDiff", "getAgentPackageReviewFileDiff", "getAgentPackageRuntimeStatus",
        "activateAgentPackageVersion", "getAgentPackageActivationAudit", "getSessionAgentPackageBinding", "rebindSessionAgentPackage"]) {
        await assert.rejects(runtime.call(method, { input: { isAdmin: true } }, {
            principal: { provider: "entra", subject: "cluster-admin" }, authorization: { role: "admin" },
        }), /administrator/i);
    }
    assert.deepEqual(calls, []);
});

test("runtime fencing status forwards only exact identity and authenticated fleet-admin authority", async () => {
    const { runtime, calls } = fixture();
    const input = { packageId: "deleted-package", versionId: "old-version", sha256: "a".repeat(64) };
    const result = await runtime.call("getAgentPackageRuntimeStatus", { input: { ...input, isAdmin: true, actor: "forged" } }, {
        principal: { provider: "entra", subject: "real-admin" }, authorization: { role: "admin" },
    });
    assert.deepEqual(result, { denied: true, complete: false, outstanding: 2 });
    assert.deepEqual(calls, [["runtime", input, { provider: "entra", subject: "real-admin", email: null, displayName: null }, true]]);
});

test("server admin identity is forwarded; client actor/admin flags are discarded and no fencing completion is claimed", async () => {
    const { runtime, calls } = fixture();
    const input = {
        packageId: "pkg", versionId: "v", sha256: "a".repeat(64), expectedRevision: 7,
        decision: "revoked", reason: "reviewed bytes denied",
    };
    const context = { principal: { provider: "entra", subject: "real-admin" }, authorization: { role: "admin" } };
    const result = await runtime.call("decideAgentPackageReview", {
        input: { ...input, isAdmin: true, actor: { provider: "forged", subject: "forged" } },
        isAdmin: false,
    }, context);
    assert.deepEqual(calls, [["decide", input,
        { provider: "entra", subject: "real-admin", email: null, displayName: null }, true]]);
    assert.equal(result.recorded, true);
    assert.equal(result.activationAllowed, false);
    assert.equal(result.runtimeFencing, "not-reported");
    await runtime.call("listAgentPackageReviews", {}, context);
    await runtime.call("getAgentPackageReviewAudit", { versionId: "v" }, context);
    assert.equal(calls[2][0], "audit");
    assert.equal(calls[2][1], "v");
});

test("review diff summary and per-file diff forward only exact identity, the summary flag and the path", async () => {
    const { runtime, calls } = fixture();
    const context = { principal: { provider: "entra", subject: "real-admin" }, authorization: { role: "admin" } };
    const exact = { packageId: "pkg", versionId: "v2", sha256: "a".repeat(64) };
    await runtime.call("getAgentPackageReviewDiff", { input: { ...exact, patches: false, isAdmin: true, actor: "forged" } }, context);
    await runtime.call("getAgentPackageReviewFileDiff", { input: { ...exact, path: "tools/q.mjs", isAdmin: true, owner: "forged" } }, context);
    const admin = { provider: "entra", subject: "real-admin", email: null, displayName: null };
    assert.deepEqual(calls, [
        ["diff", { ...exact, baselineVersionId: null, patches: false }, admin, true],
        ["fileDiff", { ...exact, baselineVersionId: null, path: "tools/q.mjs" }, admin, true],
    ]);
});