import test from "node:test";
import assert from "node:assert/strict";
import { loadAuthorizationPolicy } from "../auth/config.js";
import { authorizePrincipal } from "../auth/authz/engine.js";

const env = {
    PORTAL_AUTHZ_MODE: "authenticated-admin",
    PORTAL_AUTH_ALLOW_UNAUTHENTICATED: "false",
    PORTAL_AUTHZ_DEFAULT_ROLE: "none",
    PORTAL_AUTHZ_ADMIN_GROUPS: "someone-else@example.invalid",
    PORTAL_AUTHZ_USER_GROUPS: "user@example.invalid",
};

for (const providerId of ["entra", "proxy"]) {
    test(`${providerId}: explicit authenticated-admin overrides role claims and email allowlists`, () => {
        const policy = loadAuthorizationPolicy({ env, providerId });
        for (const roles of [[], ["user"], ["admin"], ["unrecognized-role"]]) {
            for (const email of ["user@example.invalid", "unlisted@example.invalid", null]) {
                const decision = authorizePrincipal({ provider: providerId, subject: "verified-subject", email, roles }, policy);
                assert.equal(decision.allowed, true);
                assert.equal(decision.role, "admin");
            }
        }
    });
}

test("authenticated-admin never admits missing or synthetic anonymous/dev principals", () => {
    const policy = loadAuthorizationPolicy({ env, providerId: "entra" });
    for (const principal of [null, {}, { provider: "none", subject: "unknown" }, { provider: "dev", subject: "persona" }]) {
        const decision = authorizePrincipal(principal, { ...policy, allowUnauthenticated: true });
        assert.equal(decision.allowed, false);
        assert.equal(decision.role, null);
    }
});

test("unsafe or misspelled authorization mode configuration fails closed", () => {
    for (const providerId of ["none", "dev"]) {
        assert.throws(() => loadAuthorizationPolicy({ env, providerId }), /requires an authentication provider/);
    }
    assert.throws(() => loadAuthorizationPolicy({ env: { ...env, PORTAL_AUTH_ALLOW_UNAUTHENTICATED: "true" }, providerId: "entra" }), /disallows unauthenticated/);
    assert.throws(() => loadAuthorizationPolicy({ env: { ...env, PORTAL_AUTHZ_MODE: "authenticated-admn" }, providerId: "entra" }), /PORTAL_AUTHZ_MODE/);
});

test("default policy retains role precedence and denies unlisted principals", () => {
    const { PORTAL_AUTHZ_MODE, ...normalEnv } = env;
    const policy = loadAuthorizationPolicy({ env: normalEnv, providerId: "entra" });
    assert.equal(policy.mode, "policy");
    assert.equal(authorizePrincipal({ provider: "entra", subject: "user", roles: ["user"] }, policy).role, "user");
    assert.equal(authorizePrincipal({ provider: "entra", subject: "stranger", email: "stranger@example.invalid", roles: [] }, policy).allowed, false);
    assert.equal(authorizePrincipal(null, policy).allowed, false);
});
