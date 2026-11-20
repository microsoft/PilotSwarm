import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";

import { PortalRuntime } from "../runtime.js";
import { createApiRouter } from "../api/router.js";
import { NodeSdkTransport } from "../../tui/src/node-sdk-transport.js";

function runtimeForTest() {
    const prior = process.env.AUTHZ_ADMIN_SCOPE;
    process.env.AUTHZ_ADMIN_SCOPE = "unrestricted";
    try { return new PortalRuntime({ store: "sqlite::memory:", mode: "local" }); }
    finally {
        if (prior === undefined) delete process.env.AUTHZ_ADMIN_SCOPE;
        else process.env.AUTHZ_ADMIN_SCOPE = prior;
    }
}

test("portal runtime routes personal provider credential updates with the authenticated viewer", async () => {
    const calls = [];
    const runtime = runtimeForTest();
    runtime.start = async () => {};
    runtime.transport = {
        mgmt: {
            updateMyProviderCredential: async (viewer, input) => {
                calls.push({ viewer, input });
                return { name: input.name, typeId: "github-copilot", class: "personal" };
            },
        },
    };

    const authContext = {
        principal: { provider: "entra", subject: "user-1" },
        authorization: { role: "user" },
    };
    const result = await runtime.call("updateMyProviderCredential", {
        name: "my-ghcp",
        credentials: { githubToken: "replacement-token" },
    }, authContext);

    assert.deepEqual(calls, [{
        viewer: {
            principal: { ...authContext.principal, email: null, displayName: null },
            isAdmin: false,
            adminScope: "unrestricted",
        },
        input: { name: "my-ghcp", credentials: { githubToken: "replacement-token" } },
    }]);
    assert.deepEqual(result, { name: "my-ghcp", typeId: "github-copilot", class: "personal" });
    // NOT a credential-leak guard, despite reading like one: `result` comes
    // wholly from the stub above, which is hardcoded to {name,typeId,class},
    // and runtime.call returns the mgmt result verbatim. Nothing in the store,
    // the management client or the SQL could turn it red — and the deepEqual
    // on the line above already pins the exact value. The real guard is that
    // the store never puts a secret in what it returns; see
    // provider-credential-update.test.mjs, which asserts against the shape the
    // store actually produces.
    //
    // Kept as a cheap tripwire on the STUB's own shape only.
    assert.equal(JSON.stringify(result).includes("replacement-token"), false);
});

test("the HTTP Decision catalog route reaches the real Node SDK transport with the authenticated viewer", async () => {
    const calls = [];
    const expected = [{
        providerId: "decision-shared", providerType: "foundry-wif", qualifiedName: "decision-shared:ps-decision-1-1",
        modelName: "ps-decision-1-1", catalogKind: "runtime_provider", credentialAvailable: true,
    }];
    const mgmt = {
        listRuntimeDecisionModels: async viewer => { calls.push(viewer); return expected; },
    };
    const runtime = runtimeForTest();
    runtime.start = async () => {};
    runtime.transport = Object.assign(Object.create(NodeSdkTransport.prototype), { mgmt });

    const principal = { provider: "entra", subject: "admin-1", email: "admin@example.test", displayName: "Admin" };
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createApiRouter({
        runtime,
        requireAuth: (req, _res, next) => {
            req.auth = {
                principal,
                authorization: { allowed: true, role: "admin", reason: "test", matchedGroups: ["admins"] },
            };
            next();
        },
    }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/models/decision`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { ok: true, result: expected });
        assert.deepEqual(calls, [{ principal: {
            provider: "entra", subject: "admin-1", email: "admin@example.test", displayName: "Admin",
        }, isAdmin: true }]);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
