import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 2, admin: true }); base = `http://127.0.0.1:${stub.port}`; });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

test("system sharing hides expansion controls but preserves undo, revocation, and ordinary sharing", async ({ page }) => {
    const id = "11111111-2222-3333-4444-555555555551";
    let isSystem = true;
    let visibility = "private";
    let grants = [{ provider: "dev", subject: "bob", displayName: "Bob", access: "read" }];
    const revocations = [];
    const expansionWrites = [];
    let failNextShareList = false;
    await page.route("**/api/v1/bootstrap", route => route.fulfill({ json: { ok: true, result: {
        auth: { principal: { provider: "none", subject: "test" }, authorization: { role: "admin", allowed: true } },
    } } }));
    await page.route("**/access", route => route.fulfill({ json: { ok: true, result: {
        isSystem, systemVisibility: "read", canManage: true, canWrite: true, visibility, relation: "admin",
    } } }));
    await page.route("**/visibility", route => {
        const body = route.request().postDataJSON();
        expansionWrites.push(["visibility", body]);
        visibility = body.visibility;
        return route.fulfill({ json: { ok: true, result: { sessionId: id, visibility } } });
    });
    await page.route("**/shares", route => {
        if (route.request().method() === "POST") {
            const body = route.request().postDataJSON();
            expansionWrites.push(["grant", body]);
            grants = [...grants, { ...body.user, access: body.access }];
            return route.fulfill({ json: { ok: true, result: { sessionId: id, granted: body } } });
        }
        if (failNextShareList) {
            failNextShareList = false;
            return route.fulfill({ status: 500, json: { ok: false, error: { code: "INTERNAL_ERROR", message: "injected refresh failure" } } });
        }
        return route.fulfill({ json: { ok: true, result: grants } });
    });
    await page.route("**/shares/revoke", route => {
        const body = route.request().postDataJSON();
        revocations.push(body);
        grants = grants.filter((grant) => grant.provider !== body.user.provider || grant.subject !== body.user.subject);
        return route.fulfill({ json: { ok: true, result: {} } });
    });

    await page.goto(`${base}/?session=${id}`);
    const modal = page.locator(".ps-share-modal");
    const open = async () => {
        await page.getByRole("button", { name: /^Manage session/ }).first().click();
        await modal.getByRole("tab", { name: "Access", exact: true }).click();
    };

    await open();
    await expect(modal.getByText(/system session sharing.*deployment policy/i)).toBeVisible();
    await expect(modal.getByText(/everyone signed in can read this system session/i)).toBeVisible();
    await expect(modal.getByText("inactive (read)", { exact: true })).toBeVisible();
    await expect(modal.getByRole("radio")).toHaveCount(0);
    await expect(modal.getByPlaceholder("Name, email, or id")).toHaveCount(0);
    await expect(modal.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
    expect(expansionWrites).toEqual([]);

    await modal.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(modal.getByText("removed on Apply", { exact: true })).toBeVisible();
    await modal.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(modal.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
    await modal.getByRole("button", { name: "Remove", exact: true }).click();
    failNextShareList = true;
    await modal.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.poll(() => revocations).toEqual([{ user: { provider: "dev", subject: "bob" } }]);
    await expect(modal.getByText("No stored individual grants.", { exact: true })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
    expect(expansionWrites).toEqual([]);

    await modal.getByRole("button", { name: "Close", exact: true }).click();
    isSystem = false;
    await open();
    await modal.getByRole("radio").nth(2).check();
    await modal.getByPlaceholder("Name, email, or id").fill("carol@example.test");
    await modal.getByRole("button", { name: "Add", exact: true }).click();
    await modal.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.poll(() => expansionWrites).toHaveLength(2);
    expect(expansionWrites.map(([kind]) => kind)).toEqual(["visibility", "grant"]);
});
