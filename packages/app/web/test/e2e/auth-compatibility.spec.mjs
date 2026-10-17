import { test, expect } from "@playwright/test";
import { createAuthTestServer } from "./fixtures/auth-server.mjs";

const account = { homeAccountId: "fixture-alice", name: "Alice Example", username: "alice@example.invalid" };
const users = [
    { id: "alice", displayName: "Alice Example", email: "alice@example.invalid", role: "user" },
    { id: "bob", displayName: "Bob Example", email: "bob@example.invalid", role: "user" },
];
const configs = {
    none: { provider: "none", enabled: false, client: null },
    proxy: { provider: "proxy", enabled: false, client: null },
    dev: { provider: "dev", enabled: true, client: { users } },
    entra: { provider: "entra", enabled: true, client: {
        clientId: "fixture-client", authority: "https://login.example.invalid/fixture",
        redirectUri: "http://portal.example.invalid",
    } },
};
let vite;
let origin;

test.beforeAll(async () => {
    vite = await createAuthTestServer();
    origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
});

test.afterAll(async () => { await vite?.close(); });

async function openAuth(page, {
    provider = "entra", enabled, accounts = [], silentFailure = false,
    status = 200, view = "hook", storedPersona,
    principal = { provider, subject: storedPersona?.id ?? "alice", displayName: storedPersona?.displayName ?? "Alice Example" },
} = {}) {
    const config = { ...configs[provider], ...(enabled === undefined ? {} : { enabled }) };
    const requests = [];
    await page.addInitScript(({ config, accounts, silentFailure, account, storedPersona, view }) => {
        window.__authFixture = { config, accounts, silentFailure, loginAccount: account, calls: [], view };
        if (storedPersona) sessionStorage.setItem("pilotswarm.devAuth.persona", JSON.stringify(storedPersona));
    }, { config, accounts, silentFailure, account, storedPersona, view });
    await page.route("**/api/portal-config", route => route.fulfill({ json: { auth: config } }));
    await page.route("**/api/auth/me", route => {
        const authorization = route.request().headers().authorization ?? null;
        requests.push({ hasBearer: authorization?.startsWith("Bearer ") === true });
        return route.fulfill({ status, json: status === 200 ? {
            principal,
            authorization: { allowed: true, role: "user" },
        } : { error: status === 403 ? "Fixture policy denies access" : "Unauthorized" } });
    });
    await page.goto(`${origin}/test/e2e/fixtures/auth-browser.html`);
    if (view === "hook") {
        await expect.poll(() => page.evaluate(() => window.__authFixture.current?.loading)).toBe(false);
    } else {
        await expect(page.locator(".portal-gate-title")).toBeVisible();
    }
    return requests;
}

const state = page => page.evaluate(() => {
    const { loading, signedIn, forbidden, account, accessToken, principal } = window.__authFixture.current;
    return { loading, signedIn, forbidden, account, accessToken, principal };
});
const calls = page => page.evaluate(() => window.__authFixture.calls);

test("none authorizes without account, cached token or Authorization header", async ({ page }) => {
    const requests = await openAuth(page, { provider: "none", principal: null });
    expect(await state(page)).toMatchObject({ signedIn: true, account: null, accessToken: null, principal: null });
    expect(requests).toEqual([{ hasBearer: false }]);
    expect(await calls(page)).toEqual([]);
});

for (const status of [401, 403]) {
    test(`none preserves its ${status} gate without manufacturing an account`, async ({ page }) => {
        await openAuth(page, { provider: "none", status });
        expect(await state(page)).toMatchObject({ signedIn: false, forbidden: status === 403, account: null, accessToken: null });
    });
}

test("disabled proxy cannot enter the anonymous browser branch", async ({ page }) => {
    const requests = await openAuth(page, { provider: "proxy" });
    expect(await state(page)).toMatchObject({ signedIn: false, account: null, accessToken: null, principal: null });
    expect(await page.evaluate(() => window.__authFixture.current.error))
        .toBe('Portal auth provider "proxy" is selected but not fully configured.');
    expect(requests).toEqual([]);
    expect(await calls(page)).toEqual([]);
});

for (const provider of ["dev", "entra"]) for (const status of [401, 403]) {
    test(`${provider} preserves its initial signed-in ${status} state`, async ({ page }) => {
        const requests = await openAuth(page, {
            provider, status, accounts: [account],
            storedPersona: provider === "dev" ? users[0] : undefined,
        });
        expect(await state(page)).toMatchObject({
            signedIn: true, forbidden: status === 403, principal: null,
        });
        expect(requests).toEqual([{ hasBearer: true }]);
    });
}

for (const provider of ["dev", "entra"]) {
    test(`${provider} does not probe auth/me with no account`, async ({ page }) => {
        const requests = await openAuth(page, { provider });
        expect(await state(page)).toMatchObject({ signedIn: false, account: null, accessToken: null });
        expect(requests).toEqual([]);
    });
    test(`disabled ${provider} stays outside anonymous admission`, async ({ page }) => {
        const requests = await openAuth(page, { provider, enabled: false, accounts: [account] });
        expect(await state(page)).toMatchObject({ signedIn: false, account: null, accessToken: null });
        await expect(page.getByTestId("auth-state")).toContainText("not fully configured");
        expect(requests).toEqual([]);
        expect(await calls(page)).toEqual([]);
    });
}

test("Entra restores an account without probing when silent acquisition needs interaction", async ({ page }) => {
    const requests = await openAuth(page, { accounts: [account], silentFailure: true });
    expect(await state(page)).toMatchObject({ signedIn: true, account, accessToken: null, principal: null });
    expect(requests).toEqual([]);
    expect((await calls(page)).map(call => call.method)).toEqual([
        "constructor", "initialize", "handleRedirectPromise", "getAllAccounts", "acquireTokenSilent",
    ]);
    expect((await calls(page))[0].input).toMatchObject({
        auth: configs.entra.client,
        cache: { cacheLocation: "localStorage", storeAuthStateInCookie: true },
    });
});

test("Entra renewal delegates to silent acquisition rather than cached hook state", async ({ page }) => {
    const requests = await openAuth(page, { accounts: [account] });
    expect(await state(page)).toMatchObject({ signedIn: true, accessToken: "fixture-entra-initial" });
    expect(requests).toEqual([{ hasBearer: true }]);
    const renewed = await page.evaluate(async () => {
        window.__authFixture.token = "fixture-entra-renewed";
        return window.__authFixture.current.getAccessToken();
    });
    expect(renewed).toBe("fixture-entra-renewed");
    expect(await state(page)).toMatchObject({ accessToken: "fixture-entra-initial" });
    expect((await calls(page)).filter(call => call.method === "acquireTokenSilent")).toHaveLength(2);
    const missing = await page.evaluate(async () => {
        window.__authFixture.silentFailure = true;
        return window.__authFixture.current.getAccessToken();
    });
    expect(missing).toBeNull();
    expect((await calls(page)).some(call => call.method === "acquireTokenPopup")).toBe(false);
});

test("Entra desktop login fallback and logout preserve their interactive calls", async ({ page }) => {
    const requests = await openAuth(page, { silentFailure: true });
    await page.evaluate(() => window.__authFixture.current.signIn());
    await expect.poll(async () => (await state(page)).accessToken).toBe("fixture-entra-interactive");
    expect(requests).toEqual([{ hasBearer: true }]);
    expect((await calls(page)).map(call => call.method)).toContain("loginPopup");
    expect((await calls(page)).map(call => call.method)).toContain("acquireTokenPopup");
    await page.evaluate(() => window.__authFixture.current.signOut());
    await expect.poll(async () => (await state(page)).signedIn).toBe(false);
    expect((await calls(page)).at(-1)).toEqual({ method: "logoutPopup", input: { account } });
    expect(requests).toHaveLength(1);
});

test("Entra mobile keeps redirect login and redirect logout", async ({ browser }) => {
    const context = await browser.newContext({ userAgent: "Mozilla/5.0 (iPhone; Mobile)" });
    try {
        const page = await context.newPage();
        const requests = await openAuth(page);
        await page.evaluate(() => window.__authFixture.current.signIn());
        expect((await calls(page)).at(-1).method).toBe("loginRedirect");
        await page.evaluate(() => window.__authFixture.current.signOut());
        expect((await calls(page)).at(-1).method).toBe("logoutRedirect");
        expect(requests).toEqual([]);
    } finally {
        await context.close();
    }
});

test("actual App retains the Entra signed-out and signed-in denied gates", async ({ browser }) => {
    const context = await browser.newContext();
    try {
        const signedOut = await context.newPage();
        const noAccountRequests = await openAuth(signedOut, { view: "app" });
        await expect(signedOut.locator(".portal-gate-title")).toHaveText("Sign in to PilotSwarm");
        // App starts with its default none config while public config loads.
        // Only the hook's selected-provider path must avoid a tokenless probe.
        expect(noAccountRequests).toEqual([{ hasBearer: false }]);
        const denied = await context.newPage();
        const requests = await openAuth(denied, { view: "app", accounts: [account], status: 403 });
        await expect(denied.locator(".portal-gate-title")).toHaveText("Access denied for PilotSwarm");
        expect(requests).toEqual([{ hasBearer: false }, { hasBearer: true }]);
    } finally {
        await context.close();
    }
});

test("dev sign-in and transport callbacks retain the hook lifecycle", async ({ page }) => {
    const requests = await openAuth(page, {
        provider: "dev", principal: { provider: "dev", subject: "bob", displayName: "Bob Example" },
    });
    await page.evaluate(() => window.__authFixture.current.signIn("bob"));
    await expect.poll(async () => (await state(page)).accessToken).toBe("dev:bob");
    expect(requests).toEqual([{ hasBearer: true }]);
    await page.evaluate(() => window.__authFixture.current.handleForbidden("Fixture operation denied"));
    await expect.poll(async () => (await state(page)).forbidden).toBe(true);
    expect(await state(page)).toMatchObject({ signedIn: true, accessToken: "dev:bob", principal: null });
    await page.evaluate(() => window.__authFixture.current.handleUnauthorized());
    await expect.poll(async () => (await state(page)).signedIn).toBe(false);
    expect(await state(page)).toMatchObject({ account: null, accessToken: null, principal: null });
    expect(requests).toHaveLength(1);
});

test("dev remains isolated by tab and logout does not probe auth/me again", async ({ context }) => {
    const alice = await context.newPage();
    const bob = await context.newPage();
    const aliceRequests = await openAuth(alice, { provider: "dev", storedPersona: users[0] });
    const bobRequests = await openAuth(bob, { provider: "dev", storedPersona: users[1] });
    expect((await state(alice)).accessToken).toBe("dev:alice");
    expect((await state(bob)).accessToken).toBe("dev:bob");
    await alice.evaluate(() => window.__authFixture.current.signOut());
    await expect.poll(async () => (await state(alice)).signedIn).toBe(false);
    expect((await state(bob)).accessToken).toBe("dev:bob");
    expect(aliceRequests).toHaveLength(1);
    expect(bobRequests).toHaveLength(1);
});
