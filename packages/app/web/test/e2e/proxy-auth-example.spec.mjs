import { test, expect } from "@playwright/test";
import { createProxyExampleFixture } from "./fixtures/proxy-example-server.mjs";

// Browser cookie/form proof with the real verifier, not full portal/CMS proof.
// The credentialed SDK suite separately starts the real portal and workers.
for (const basePath of ["/", "/portal", "/tools/agents"]) {
    test(`demo cookie, forms and two browser identities at ${basePath}`, async ({ browser }) => {
        const fixture = await createProxyExampleFixture({ basePath });
        const alice = await browser.newContext();
        const bob = await browser.newContext();
        try {
            for (const [context, persona] of [[alice, "alice"], [bob, "bob"]]) {
                const page = await context.newPage();
                await page.goto(`${fixture.origin}/example-auth/login`);
                await expect(page.getByText("This is not a production identity service.", { exact: false })).toBeVisible();
                await page.getByLabel("Demo user").selectOption(persona);
                await page.getByRole("button", { name: "Sign in", exact: true }).click();
                await expect(page).toHaveURL(`${fixture.origin}${fixture.proxy.paths.entryPath}`);
                const response = await context.request.get(`${fixture.origin}${fixture.proxy.paths.path("/api/auth/me")}`);
                expect(response.status()).toBe(200);
                expect((await response.json()).principal.subject).toBe(`demo-${persona}`);
                const cookies = await context.cookies();
                expect(cookies).toHaveLength(1);
                expect(cookies[0]).toMatchObject({
                    name: "pilotswarm_proxy_demo", path: "/", httpOnly: true, secure: false, sameSite: "Strict",
                });
                expect(await page.evaluate(() => document.cookie)).toBe("");
                expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
            }
            expect(fixture.calls.every(call => !call.hasAuthorization && !call.hasCookie && !call.spoofedUser)).toBe(true);
            const alicePage = alice.pages()[0];
            await alicePage.goto(`${fixture.origin}/example-auth/logout`);
            await alicePage.getByRole("button", { name: "Sign out", exact: true }).click();
            await expect(alicePage).toHaveURL(`${fixture.origin}/example-auth/signed-out`);
            expect(await alice.cookies()).toEqual([]);
            expect((await bob.request.get(`${fixture.origin}${fixture.proxy.paths.path("/api/auth/me")}`)).status()).toBe(200);
            expect((await alice.request.get(`${fixture.origin}${fixture.proxy.paths.path("/api/auth/me")}`)).status()).toBe(401);
        } finally {
            await alice.close();
            await bob.close();
            await fixture.close();
        }
    });
}

test("an auth-directory cookie does not authenticate the prefixed portal", async ({ browser }) => {
    const fixture = await createProxyExampleFixture();
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/example-auth/login`);
        await page.getByLabel("Demo user").selectOption("alice");
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await expect(page).toHaveURL(`${fixture.origin}${fixture.proxy.paths.entryPath}`);
        const [cookie] = await context.cookies();
        expect((await context.request.get(`${fixture.origin}${fixture.proxy.paths.path("/api/auth/me")}`)).status()).toBe(200);
        await context.clearCookies();
        await context.addCookies([{ ...cookie, path: "/example-auth" }]);
        const response = await context.request.get(`${fixture.origin}${fixture.proxy.paths.path("/api/auth/me")}`);
        expect(response.status()).toBe(401);
    } finally {
        await context.close();
        await fixture.close();
    }
});
