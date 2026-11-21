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

// Negative cases for the Cluster Decision Default over HTTP (owner 2026-11-20): PUT /model-defaults with scope cluster_decision
// reaches the real management-client checks; a non-admin is refused 403 and invalid tuples 4xx, and none of them writes.
test("PUT /model-defaults cluster_decision: non-admin 403, invalid tuples 4xx, admin set and clear write only valid tuples", async () => {
    const { PilotSwarmManagementClient, ModelProviderRegistry } = await import("pilotswarm-sdk");
    const registry = new ModelProviderRegistry({ providers: [
        { id: "foundry", type: "foundry-wif", baseUrl: "https://decision.example.test/openai/v1", models: [{ name: "gpt-chat" }],
            decisionModels: [{ name: "ps-decision-1-1" }] },
    ] }, { keepUncredentialed: true });
    const row = (name, cls) => ({ name, typeId: "foundry", class: cls, ownerUserId: cls === "personal" ? 7 : null,
        baseUrl: "https://decision.example.test/openai/v1", secretRef: {}, instanceId: `${name}-id`, usableByMe: true });
    const rows = [row("shared-decision", "shared"), row("mine", "personal")];
    const writes = [];
    const store = {
        lookupUserId: async () => 7,
        listProviders: async () => rows,
        getCredential: async name => rows.find(item => item.name === name) ?? null,
        setClusterDecisionDefault: async (tuple, isAdmin) => { writes.push({ tuple, isAdmin }); },
    };
    const mgmt = Object.assign(Object.create(PilotSwarmManagementClient.prototype), {
        _started: true, _modelProviders: registry, _catalog: { providers: store, recordAuthzAudit: async () => {} },
    });
    const runtime = runtimeForTest();
    runtime.start = async () => {};
    runtime.transport = Object.assign(Object.create(NodeSdkTransport.prototype), { mgmt });
    let role = "user";
    const app = express();
    app.use(express.json());
    app.use("/api/v1", createApiRouter({
        runtime,
        requireAuth: (req, _res, next) => {
            req.auth = { principal: { provider: "entra", subject: "u-1", email: "u@example.test", displayName: "U" },
                authorization: { allowed: true, role, reason: "test", matchedGroups: [] } };
            next();
        },
    }));
    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const put = async body => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/model-defaults`, {
            method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "cluster_decision", ...body }),
        });
        return { status: response.status, body: await response.json() };
    };
    const valid = { provider: "shared-decision", model: "shared-decision:ps-decision-1-1" };
    try {
        let answer = await put(valid);
        assert.equal(answer.status, 403, JSON.stringify(answer.body));
        assert.equal(answer.body.error.code, "PROVIDER_FORBIDDEN");
        assert.match(answer.body.error.message, /Only an administrator can set the Cluster Decision Default/);
        answer = await put({ provider: null, model: null });
        assert.equal(answer.status, 403, "a non-admin cannot clear it either");

        role = "admin";
        for (const [label, body, status, code] of [
            ["a provider without a model", { provider: "shared-decision", model: null }, 400, "PROVIDER_INVALID"],
            ["a model without a provider", { provider: null, model: "shared-decision:ps-decision-1-1" }, 400, "PROVIDER_INVALID"],
            ["a chat model", { provider: "shared-decision", model: "shared-decision:gpt-chat" }, 400, "PROVIDER_INVALID"],
            ["another provider's model", { provider: "shared-decision", model: "other:ps-decision-1-1" }, 400, "PROVIDER_INVALID"],
            ["a Decision model the catalog does not list", { provider: "shared-decision", model: "shared-decision:no-such-decision" }, 400, "PROVIDER_INVALID"],
            ["a personal provider", { provider: "mine", model: "mine:ps-decision-1-1" }, 400, "PROVIDER_INVALID"],
            ["an unknown provider", { provider: "nobody", model: "nobody:ps-decision-1-1" }, 404, "PROVIDER_NOT_FOUND"],
            ["a chat reasoning effort", { ...valid, reasoningEffort: "high" }, 400, "PROVIDER_INVALID"],
        ]) {
            answer = await put(body);
            assert.equal(answer.status, status, `${label}: ${JSON.stringify(answer.body)}`);
            assert.equal(answer.body.error.code, code, label);
        }
        assert.deepEqual(writes, [], "no refused request wrote a default");

        answer = await put(valid);
        assert.equal(answer.status, 200, JSON.stringify(answer.body));
        answer = await put({ provider: null, model: null });
        assert.equal(answer.status, 200, JSON.stringify(answer.body));
        assert.deepEqual(writes, [
            { tuple: { provider: "shared-decision", model: "shared-decision:ps-decision-1-1", reasoning: null, context: null }, isAdmin: true },
            { tuple: { provider: null, model: null, reasoning: null, context: null }, isAdmin: true },
        ]);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
