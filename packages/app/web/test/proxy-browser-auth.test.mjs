import test from "node:test";
import assert from "node:assert/strict";
import {
    createPortalPaths, resolvePortalActionUrl, safePortalReturnUrl, validatePortalActionUrl,
} from "../portal-paths.js";
import { fetchRequestAuthContext, parseRequestAuthContext } from "../src/auth/proxy-auth.js";
import { createProxyBrowserAuthProvider } from "../src/auth/providers/proxy.js";
import { createProxyAuthProvider } from "../auth/providers/proxy.js";

const principal = {
    provider: "proxy", subject: "alice", displayName: "Alice Example",
    email: "alice@example.invalid", tenantId: null, groups: ["staff"], roles: [],
};
const authorization = { allowed: true, role: "user", reason: null, matchedGroups: ["staff"] };
const admission = () => ({ principal: { ...principal }, authorization: { ...authorization } });
const config = (client = {}) => ({
    provider: "proxy", enabled: true,
    client: { authenticatesFromRequest: true, signInUrl: null, signOutUrl: null, ...client },
});

test("request admission requires the public schema and copies only public identity fields", () => {
    const payload = admission();
    payload.principal.rawClaims = { notPublic: true };
    payload.authorization.extra = { notPublic: true };
    const result = parseRequestAuthContext(payload);
    assert.deepEqual(result, { status: "authorized", principal, authorization });
    assert.notEqual(result.principal.groups, payload.principal.groups);
    assert.notEqual(result.authorization.matchedGroups, payload.authorization.matchedGroups);
});

test("malformed identities and non-boolean decisions never admit a workspace", () => {
    for (const payload of [null, [], {}, { principal }, { authorization }, { ...admission(), principal: null }]) {
        assert.equal(parseRequestAuthContext(payload).status, "error");
    }
    for (const allowed of [undefined, null, 1, "true", {}, []]) {
        assert.equal(parseRequestAuthContext({ ...admission(), authorization: { ...authorization, allowed } }).status, "error");
    }
    assert.equal(parseRequestAuthContext({ authorization: { allowed: false } }).status, "forbidden");
    for (const [field, values] of [
        ["provider", ["", " ", null, 1]], ["subject", ["", " ", null, {}]],
        ["displayName", [undefined, {}, 1]], ["email", [undefined, [], false]],
        ["tenantId", [undefined, 1]], ["roles", [undefined, "admin", [1]]], ["groups", [undefined, {}, [null]]],
    ]) for (const value of values) {
        assert.equal(parseRequestAuthContext({ ...admission(), principal: { ...principal, [field]: value } }).status, "error", field);
    }
});

test("request admission uses the configured prefix and sends no credential/header substitute", async () => {
    for (const base of ["/", "/portal", "/tools/agents"]) {
        const paths = createPortalPaths(base);
        const calls = [];
        const result = await fetchRequestAuthContext(paths, async (...args) => {
            calls.push(args);
            return Response.json(admission());
        });
        assert.equal(result.status, "authorized");
        assert.deepEqual(calls, [[paths.path("/api/auth/me"), { credentials: "same-origin", cache: "no-store", redirect: "error" }]]);
    }
});

test("missing identity, refusal, non-JSON, malformed JSON, server and network errors stay distinct", async () => {
    for (const [response, status, message] of [
        [new Response("", { status: 401 }), "unauthorized", /upstream proxy/u],
        [new Response("<html>denied</html>", { status: 403 }), "forbidden", /not authorized/u],
        [new Response("", { status: 500 }), "error", /HTTP 500/u],
        [new Response("<html>sign in</html>", { headers: { "content-type": "text/html" } }), "error", /non-JSON/u],
        [new Response("", { headers: { "content-type": "application/json" } }), "error", /not valid JSON/u],
        [Response.json(null), "error", /authorization decision/u],
    ]) {
        const result = await fetchRequestAuthContext(createPortalPaths("/portal"), async () => response);
        assert.equal(result.status, status);
        assert.match(result.error, message);
    }
    const failed = await fetchRequestAuthContext(createPortalPaths("/"), async () => { throw new TypeError("fixture offline"); });
    assert.equal(failed.status, "error");
    assert.match(failed.error, /Could not contact.*fixture offline/u);
});

test("action configuration rejects ambiguous paths and placeholders without interpreting opaque queries", () => {
    assert.equal(validatePortalActionUrl(null), null);
    assert.equal(validatePortalActionUrl(""), null);
    for (const valid of ["/login", "/login?fixed=%2F%2Felsewhere.invalid", "/auth/login?return={returnTo}", "/auth#return={returnTo}"]) {
        assert.equal(validatePortalActionUrl(valid), valid);
    }
    for (const invalid of [
        "https://elsewhere.invalid", "//elsewhere.invalid", "javascript:alert(1)", "/a\\b", "/a/../login",
        "/%2e%2e/login", "/a%252fb", "/login\n", "/%ff", "/login/{returnTo}",
        "/login?x={returnTo}&y={returnTo}", "/login?x={other}", "/login?x=%7BreturnTo%7D",
    ]) assert.throws(() => validatePortalActionUrl(invalid), /Portal sign-in\/out/u, invalid);
});

test("return targets keep benign query/hash bytes but exclude capabilities and paths outside the base", () => {
    const paths = createPortalPaths("/tools/agents");
    const valid = "/tools/agents/?session=fixture&literal=%252F%23#section=%2F";
    assert.equal(safePortalReturnUrl(valid, paths), valid);
    assert.equal(resolvePortalActionUrl("/auth/login?return={returnTo}", valid, paths),
        `/auth/login?return=${encodeURIComponent(valid)}`);
    for (const value of [
        "//elsewhere.invalid", "/tools/agents-ish/", "/tools/agents/../escape",
        "/tools/agents/?canvasShare=opaque", "/tools/agents/?%63anvasShare=opaque",
        "/tools/agents/#canvasShare=opaque", "/tools/agents/api/canvas-share/doc?t=opaque",
        "/tools/agents/api/v1/ws?canvasShare=opaque",
    ]) assert.equal(safePortalReturnUrl(value, paths), paths.entryPath, value);
});

test("proxy adapter never returns or caches an account or token and missing logout is explicitly upstream managed", async () => {
    const navigations = [];
    const provider = createProxyBrowserAuthProvider({ location: {
        pathname: "/portal/", search: "?session=fixture", hash: "#section", assign: (url) => navigations.push(url),
    } });
    assert.deepEqual(await provider.initialize(config(), "/portal"), { account: null, accessToken: null });
    assert.equal(provider.getAccount(), null);
    assert.equal(await provider.getAccessToken(), null);
    assert.deepEqual(await provider.signIn(), { redirected: false });
    assert.deepEqual(await provider.signOut(), { redirected: false, upstreamManaged: true });
    assert.deepEqual(navigations, []);
});

test("proxy actions navigate once to safe returns and propagate navigation failure", async () => {
    const navigations = [];
    const location = {
        pathname: "/portal/", search: "?session=fixture", hash: "#section", assign: (url) => navigations.push(url),
    };
    const provider = createProxyBrowserAuthProvider({ location });
    await provider.initialize(config({ signInUrl: "/auth/login?return={returnTo}", signOutUrl: "/auth/logout?return={returnTo}" }), "/portal");
    assert.deepEqual(await provider.signIn(), { redirected: true });
    assert.deepEqual(await provider.signOut(), { redirected: true });
    assert.deepEqual(navigations, [
        `/auth/login?return=${encodeURIComponent("/portal/?session=fixture#section")}`,
        `/auth/logout?return=${encodeURIComponent("/portal/")}`,
    ]);
    location.assign = () => { throw new Error("fixture navigation failure"); };
    await assert.rejects(provider.signOut(), /fixture navigation failure/u);
    assert.equal(provider.getAccount(), null);
    assert.equal(await provider.getAccessToken(), null);
});

test("missing capability and disabled proxy cannot initialize or advertise browser admission", async () => {
    for (const invalid of [{ ...config(), enabled: false }, { ...config(), client: null }, config({ authenticatesFromRequest: "true" })]) {
        await assert.rejects(createProxyBrowserAuthProvider().initialize(invalid), /enabled request-authentication/u);
    }
    const disabled = createProxyAuthProvider({ env: {} });
    assert.equal((await disabled.getPublicConfig()).client, null);
    assert.equal(await disabled.authenticateRequest(null, { headers: {} }), null);
    assert.throws(() => createProxyAuthProvider({ env: { PORTAL_AUTH_PROXY_SIGN_IN_URL: "//elsewhere.invalid" } }), /Portal sign-in\/out/u);
});
