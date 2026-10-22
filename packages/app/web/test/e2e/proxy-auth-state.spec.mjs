import { test, expect } from "@playwright/test";
import { createAuthTestServer } from "./fixtures/auth-server.mjs";

const config = (client = {}) => ({
    provider: "proxy", enabled: true, displayName: "Fixture Proxy",
    client: { authenticatesFromRequest: true, signInUrl: null, signOutUrl: null, ...client },
});
const admission = (subject = "alice") => ({
    principal: {
        provider: "proxy", subject, displayName: `${subject} Example`,
        email: `${subject}@example.invalid`, tenantId: null, groups: ["staff"], roles: [],
    },
    authorization: { allowed: true, role: "user", reason: null, matchedGroups: ["staff"] },
});
const readState = page => page.locator('[data-testid="auth-state"]').textContent().then(JSON.parse);
let vite;
let origin;

test.beforeAll(async () => {
    vite = await createAuthTestServer();
    origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
});
test.afterAll(async () => { await vite?.close(); });

async function releaseAdmission(page, gate, number = 1) {
    const settled = page.evaluate(number => window.__authFixture.flushAdmission(number), number);
    await expect.poll(() => page.evaluate(() => window.__authFixture.flushingAdmission)).toBe(number);
    gate.resolve();
    await settled;
}

async function open(page, { auth = config(), basePath = "/", view = "hook", wait = true, reply, publicConfig } = {}) {
    const requests = [];
    await page.addInitScript(({ auth, basePath, view }) => {
        window.__authFixture = { config: auth, basePath, view, calls: [], accounts: [] };
    }, { auth, basePath, view });
    await page.route("**/api/portal-config", route => publicConfig ? publicConfig(route) : route.fulfill({ json: { auth } }));
    await page.route("**/api/auth/me", async route => {
        requests.push({ path: new URL(route.request().url()).pathname, headers: route.request().headers() });
        if (reply) return reply(route, requests.length);
        return route.fulfill({ json: admission() });
    });
    await page.goto(`${origin}/test/e2e/fixtures/auth-browser.html`);
    if (view === "hook" && wait) await expect.poll(async () => (await readState(page)).loading).toBe(false);
    return requests;
}

for (const basePath of ["/", "/portal", "/tools/agents"]) {
    test(`request-auth admits without an account or token at ${basePath}`, async ({ page }) => {
        const requests = await open(page, { basePath });
        expect(await readState(page)).toMatchObject({ signedIn: true, forbidden: false, account: null, accessToken: null, ...admission() });
        expect(await page.evaluate(() => window.__authFixture.current.getAccessToken())).toBeNull();
        expect(await page.evaluate(() => window.__authFixture.current.getResourceToken("fixture-resource"))).toBeNull();
        expect(requests.map(request => request.path)).toEqual([`${basePath === "/" ? "" : basePath}/api/auth/me`]);
        expect(requests[0].headers.authorization).toBeUndefined();
        expect(Object.keys(requests[0].headers).filter(name => /^(x-user|x-forwarded-user|cf-access-jwt)/u.test(name))).toEqual([]);
        expect(await page.evaluate(() => window.__authFixture.calls)).toEqual([]);
    });
}

for (const [name, response, forbidden, error] of [
    ["missing identity", { status: 401, json: {} }, false, /upstream proxy/u],
    ["policy refusal", { status: 403, json: {} }, true, /not authorized/u],
    ["allowed false", { json: { authorization: { allowed: false } } }, true, /not authorized/u],
    ["missing principal", { json: { authorization: admission().authorization } }, false, /public identity/u],
    ["invalid decision", { json: { ...admission(), authorization: { allowed: "true" } } }, false, /authorization decision/u],
    ["sign-in HTML", { contentType: "text/html", body: "<html>Sign in upstream</html>" }, false, /non-JSON/u],
    ["malformed JSON", { contentType: "application/json", body: "{" }, false, /not valid JSON/u],
    ["server error", { status: 503, json: {} }, false, /HTTP 503/u],
]) {
    test(`request-auth rejects ${name}`, async ({ page }) => {
        await open(page, { reply: route => route.fulfill(response) });
        expect(await readState(page)).toMatchObject({ signedIn: false, forbidden, account: null, accessToken: null, principal: null });
        expect((await readState(page)).error).toMatch(error);
    });
}

test("network failure is shown and an absent login action retries admission", async ({ page }) => {
    const requests = await open(page, { reply: (route, count) => count === 1 ? route.abort("failed") : route.fulfill({ json: admission() }) });
    expect((await readState(page)).error).toMatch(/Could not contact/u);
    await page.evaluate(() => window.__authFixture.current.signIn());
    await expect.poll(async () => (await readState(page)).signedIn).toBe(true);
    expect(requests).toHaveLength(2);
    expect(await readState(page)).toMatchObject({ account: null, accessToken: null });
});

test("absent logout leaves an admitted identity intact without making a new admission request", async ({ page }) => {
    const requests = await open(page);
    await page.evaluate(() => window.__authFixture.current.signOut());
    await expect.poll(async () => (await readState(page)).actionNotice).toMatch(/has not signed you out/u);
    expect(await readState(page)).toMatchObject({ signedIn: true, account: null, accessToken: null, ...admission() });
    expect(requests).toHaveLength(1);
});

test("disabled and incomplete proxy metadata do not enter anonymous or token admission", async ({ browser }) => {
    const context = await browser.newContext();
    try {
        for (const auth of [{ ...config(), enabled: false }, { ...config(), client: null }, config({ authenticatesFromRequest: false })]) {
            const page = await context.newPage();
            const requests = await open(page, { auth });
            expect(await readState(page)).toMatchObject({ signedIn: false, principal: null, account: null, accessToken: null });
            expect((await readState(page)).error).toBeTruthy();
            expect(requests).toHaveLength(0);
            await page.close();
        }
    } finally {
        await context.close();
    }
});

test("later transport 401 and 403 clear proxy identity without inventing local sign-out", async ({ page }) => {
    const requests = await open(page);
    await page.evaluate(() => window.__authFixture.current.handleForbidden("Fixture access revoked"));
    await expect.poll(async () => (await readState(page)).forbidden).toBe(true);
    expect(await readState(page)).toMatchObject({ signedIn: false, principal: null, authorization: null, account: null, accessToken: null });
    await page.evaluate(() => window.__authFixture.current.signIn());
    await expect.poll(async () => (await readState(page)).signedIn).toBe(true);
    await page.evaluate(() => window.__authFixture.current.handleUnauthorized());
    await expect.poll(async () => (await readState(page)).signedIn).toBe(false);
    expect(await readState(page)).toMatchObject({ forbidden: false, principal: null, authorization: null });
    expect(requests).toHaveLength(2);
});

test("an older admission cannot replace a newer retry", async ({ page }) => {
    const first = Promise.withResolvers();
    const requests = await open(page, { wait: false, reply: async (route, count) => {
        if (count === 1) await first.promise;
        return route.fulfill({ json: admission(count === 1 ? "old-user" : "new-user") });
    } });
    await expect.poll(() => requests.length).toBe(1);
    await page.evaluate(() => { void window.__authFixture.current.signIn(); });
    await expect.poll(async () => (await readState(page)).principal?.subject).toBe("new-user");
    await releaseAdmission(page, first);
    expect(await page.evaluate(() => window.__authFixture.states.some(state => state.principal?.subject === "old-user"))).toBe(false);
    expect((await readState(page)).principal.subject).toBe("new-user");
});

test("provider replacement invalidates pending proxy admission", async ({ page }) => {
    const first = Promise.withResolvers();
    const requests = await open(page, { wait: false, reply: async (route, count) => {
        if (count === 1) {
            await first.promise;
            return route.fulfill({ json: admission("stale-proxy") });
        }
        return route.fulfill({ json: { principal: null, authorization: { allowed: true, role: "user" } } });
    } });
    await expect.poll(() => requests.length).toBe(1);
    await page.evaluate(() => window.__authFixture.setConfig({ provider: "none", enabled: false, client: null }));
    await expect.poll(async () => (await readState(page)).signedIn).toBe(true);
    await releaseAdmission(page, first);
    expect(await readState(page)).toMatchObject({ signedIn: true, principal: null, account: null, accessToken: null });
    expect(await page.evaluate(() => window.__authFixture.states.some(state => state.principal?.subject === "stale-proxy"))).toBe(false);
});

test("actual App displays proxy denial before its accountless signed-out gate", async ({ page }) => {
    await open(page, { view: "app", reply: route => route.fulfill({ status: 403, json: {} }) });
    await expect(page.locator(".portal-gate-title")).toHaveText("Access denied for PilotSwarm");
    await expect(page.getByRole("button", { name: "Sign-out help" })).toBeVisible();
});

test("a pending response cannot undo a later unauthorized event", async ({ page }) => {
    const pending = Promise.withResolvers();
    const requests = await open(page, { wait: false, reply: async route => {
        await pending.promise;
        return route.fulfill({ json: admission("stale-user") });
    } });
    await expect.poll(() => requests.length).toBe(1);
    await page.evaluate(() => window.__authFixture.current.handleUnauthorized());
    await expect.poll(async () => (await readState(page)).loading).toBe(false);
    await releaseAdmission(page, pending);
    expect(await readState(page)).toMatchObject({ signedIn: false, principal: null, authorization: null });
    expect(await page.evaluate(() => window.__authFixture.states.some(state => state.principal?.subject === "stale-user"))).toBe(false);
});

test("changed proxy public configuration invalidates its earlier admission", async ({ page }) => {
    const first = Promise.withResolvers();
    const requests = await open(page, { wait: false, reply: async (route, count) => {
        if (count === 1) await first.promise;
        return route.fulfill({ json: admission(count === 1 ? "old-config" : "current-config") });
    } });
    await expect.poll(() => requests.length).toBe(1);
    await page.evaluate(auth => window.__authFixture.setConfig(auth), config({ signInUrl: "/auth/login" }));
    await expect.poll(async () => (await readState(page)).principal?.subject).toBe("current-config");
    await releaseAdmission(page, first);
    expect((await readState(page)).principal.subject).toBe("current-config");
    expect(await page.evaluate(() => window.__authFixture.states.some(state => state.principal?.subject === "old-config"))).toBe(false);
});

test("default-none admission never opens App workspace while proxy admission is pending", async ({ page }) => {
    const discovery = Promise.withResolvers();
    const proxyDecision = Promise.withResolvers();
    const workspaceRequests = [];
    await page.route("**/api/v1/**", route => {
        workspaceRequests.push(route.request().url());
        return route.fulfill({ status: 403, json: { error: "Fixture workspace must not open" } });
    });
    const requests = await open(page, {
        view: "app",
        publicConfig: async route => {
            await discovery.promise;
            return route.fulfill({ json: { auth: config() } });
        },
        reply: async (route, count) => {
            if (count === 1) return route.fulfill({ json: { principal: null, authorization: { allowed: true, role: "user" } } });
            await proxyDecision.promise;
            return route.fulfill({ status: 403, json: {} });
        },
    });
    await expect.poll(() => requests.length).toBe(1);
    discovery.resolve();
    await expect.poll(() => requests.length).toBe(2);
    await expect(page.locator(".portal-gate-title")).toHaveText("Preparing your workspace");
    expect(workspaceRequests).toEqual([]);
    proxyDecision.resolve();
    await expect(page.locator(".portal-gate-title")).toHaveText("Access denied for PilotSwarm");
    expect(workspaceRequests).toEqual([]);
});
