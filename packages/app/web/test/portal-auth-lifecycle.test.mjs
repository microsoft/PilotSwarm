import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createNoBrowserAuthProvider } from "../src/auth/providers/none.js";
import { createDevBrowserAuthProvider } from "../src/auth/providers/dev.js";

const users = [
    { id: "alice", displayName: "Alice Example", email: "alice@example.invalid", role: "user" },
    { id: "bob", displayName: "Bob Example", email: "bob@example.invalid", role: "user" },
];
const devConfig = { provider: "dev", enabled: true, client: { users } };

function withSessionStorage(t) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    const entries = new Map();
    Object.defineProperty(globalThis, "sessionStorage", {
        configurable: true,
        value: {
            getItem: (key) => entries.get(key) ?? null,
            setItem: (key, value) => entries.set(key, String(value)),
            removeItem: (key) => entries.delete(key),
        },
    });
    t.after(() => {
        if (previous) Object.defineProperty(globalThis, "sessionStorage", previous);
        else delete globalThis.sessionStorage;
    });
    return entries;
}

test("none browser lifecycle remains tokenless with no account", async () => {
    const provider = createNoBrowserAuthProvider();
    const anonymous = { account: null, accessToken: null };
    assert.deepEqual(await provider.initialize({ provider: "none", enabled: false }), anonymous);
    assert.deepEqual(await provider.signIn(), anonymous);
    assert.equal(provider.getAccount(), null);
    assert.equal(await provider.getAccessToken(), null);
    assert.deepEqual(await provider.signOut(), anonymous);
});

test("dev restores the tab persona and clears only that persona on logout", async (t) => {
    const entries = withSessionStorage(t);
    entries.set("unrelated", "keep");
    const provider = createDevBrowserAuthProvider();
    assert.deepEqual(await provider.initialize(devConfig), { account: null, accessToken: null });
    const signedIn = await provider.signIn("alice");
    assert.deepEqual(signedIn.account, { name: "Alice Example", username: "alice@example.invalid" });
    assert.equal(signedIn.accessToken, "dev:alice");
    assert.equal(await provider.getAccessToken(), "dev:alice");

    const restored = createDevBrowserAuthProvider();
    assert.deepEqual(await restored.initialize(devConfig), signedIn);
    assert.deepEqual(restored.getAccount(), signedIn.account);
    assert.deepEqual(await restored.signOut(), { account: null, accessToken: null });
    assert.equal(provider.getAccount(), null);
    assert.equal(await provider.getAccessToken(), null);
    assert.deepEqual([...entries], [["unrelated", "keep"]]);
});

test("dev token getter follows the current tab persona rather than a cached token", async (t) => {
    withSessionStorage(t);
    const provider = createDevBrowserAuthProvider();
    await provider.initialize(devConfig);
    await provider.signIn("alice");
    assert.equal(await provider.getAccessToken(), "dev:alice");
    await provider.signIn("bob");
    assert.equal(await provider.getAccessToken(), "dev:bob");
    assert.equal(provider.getAccount().username, "bob@example.invalid");
});

test("dev keeps its existing empty-roster and malformed-storage behavior", async (t) => {
    const entries = withSessionStorage(t);
    entries.set("pilotswarm.devAuth.persona", "{not json");
    const provider = createDevBrowserAuthProvider();
    assert.deepEqual(await provider.initialize({ ...devConfig, client: { users: [] } }), {
        account: null, accessToken: null,
    });
    await assert.rejects(provider.signIn("alice"), /No dev personas configured/);
});

for (const provider of ["none", "entra", "proxy"]) {
    for (const anonymousAllowed of [true, false]) {
        test(`disabled ${provider} server keeps its explicit anonymous-policy outcome (${anonymousAllowed})`, async (t) => {
            const names = Object.keys(process.env).filter((key) => key.startsWith("PORTAL_AUTH") || key === "PLUGIN_DIRS");
            const saved = new Map(names.map((key) => [key, process.env[key]]));
            t.after(() => {
                for (const key of Object.keys(process.env)) {
                    if (key.startsWith("PORTAL_AUTH") || key === "PLUGIN_DIRS") delete process.env[key];
                }
                for (const [key, value] of saved) process.env[key] = value;
            });
            for (const key of names) delete process.env[key];
            Object.assign(process.env, {
                PORTAL_AUTH_PROVIDER: provider,
                PORTAL_AUTH_PROXY_MODE: "jwt",
                PORTAL_AUTH_ALLOW_UNAUTHENTICATED: String(anonymousAllowed),
                PORTAL_AUTHZ_DEFAULT_ROLE: "user",
                PLUGIN_DIRS: fileURLToPath(new URL("./fixtures/no-auth-plugin", import.meta.url)),
            });
            // Each import has its own cached provider bundle; configuration is
            // intentionally absent, independently of browser admission rules.
            const auth = await import(`../auth/index.js?disabled=${provider}-${anonymousAllowed}`);
            const config = await auth.getAuthConfig({ headers: { host: "portal.example.invalid" }, protocol: "http" });
            assert.equal(config.enabled, false);
            assert.equal(config.client, null);
            const result = await auth.authenticateRequest({ headers: {} });
            assert.equal(result.ok, anonymousAllowed);
            assert.equal(result.status, anonymousAllowed ? 200 : 401);
            assert.equal(result.authorization.allowed, anonymousAllowed);
            if (anonymousAllowed) {
                assert.equal(result.principal.provider, "none");
                assert.equal(result.principal.subject, "unknown");
            } else {
                assert.equal(result.principal, null);
            }
        });
    }
}
