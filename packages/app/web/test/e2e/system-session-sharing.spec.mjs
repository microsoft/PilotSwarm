import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 2, admin: true }); base = `http://127.0.0.1:${stub.port}`; });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

test("system sharing controls are disabled but revocation and ordinary sharing remain usable", async ({ page }) => {
    const id = "11111111-2222-3333-4444-555555555551";
    let isSystem = true;
    let grants = [{ provider: "dev", subject: "bob", displayName: "Bob", access: "read" }];
    const revocations = [];
    await page.route("**/api/v1/bootstrap", route => route.fulfill({ json: { ok: true, result: {
        auth: { principal: { provider: "none", subject: "test" }, authorization: { role: "admin", allowed: true } },
    } } }));
    await page.route("**/access", route => route.fulfill({ json: { ok: true, result: {
        isSystem, canManage: true, canWrite: true, visibility: "private", relation: "admin",
    } } }));
    await page.route("**/shares", route => route.fulfill({ json: { ok: true, result: grants } }));
    await page.route("**/shares/revoke", route => {
        revocations.push(route.request().postDataJSON());
        grants = [];
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
    await expect(modal.getByRole("radio")).toHaveCount(3);
    for (const radio of await modal.getByRole("radio").all()) await expect(radio).toBeDisabled();
    await expect(modal.getByPlaceholder("Name, email, or id")).toBeDisabled();
    await expect(modal.getByRole("combobox")).toBeDisabled();
    await expect(modal.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
    await expect(modal.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
    await modal.getByRole("button", { name: "Remove", exact: true }).click();
    await modal.getByRole("button", { name: "Apply", exact: true }).click();
    await expect.poll(() => revocations).toEqual([{ user: { provider: "dev", subject: "bob" } }]);
    await modal.getByRole("button", { name: "Close", exact: true }).click();
    isSystem = false;
    await open();
    await modal.getByRole("radio").nth(2).check();
    await expect(modal.getByPlaceholder("Name, email, or id")).toBeEnabled();
    await expect(modal.getByRole("combobox")).toBeEnabled();
    await expect(modal.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
});
