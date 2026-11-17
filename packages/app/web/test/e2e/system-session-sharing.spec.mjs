import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 2, admin: true }); base = `http://127.0.0.1:${stub.port}`; });
test.afterEach(async ({ page }) => { await page.unrouteAll({ behavior: "wait" }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

for (const width of [1440, 390]) for (const reading of [true, false]) {
    test(`system-tree sharing is read-only except revocation (${width}px, reading=${reading})`, async ({ page }) => {
        const id = "11111111-2222-3333-4444-555555555551";
        const grant = { provider: "dev", subject: "bob", displayName: "Bob", access: "read" };
        let isSystem = true;
        let grants = [grant];
        const writes = [];
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.route("**/api/v1/bootstrap", route => route.fulfill({ json: { ok: true, result: {
            auth: { principal: { provider: "none", subject: "test" }, authorization: { role: "admin", allowed: true } },
        } } }));
        await page.route("**/me/profile", route => route.fulfill({ json: { ok: true, result: { isAdmin: true, profileSettings: {
            themeId: reading ? "cobalt2" : "win95", chatReading: { on: reading },
        } } } }));
        await page.route("**/me/profile/settings", route => route.fulfill({ json: { ok: true, result: {} } }));
        await page.route("**/access", route => route.fulfill({ json: { ok: true, result: {
            sessionId: id, rootSessionId: "system-root", isSystem, canManage: true, canWrite: true,
            visibility: "private", relation: "admin",
        } } }));
        await page.route("**/shares", route => {
            if (route.request().method() === "GET") return route.fulfill({ json: { ok: true, result: grants } });
            writes.push(route.request().method());
            return route.fulfill({ json: { ok: true, result: {} } });
        });
        await page.route("**/shares/*", route => {
            writes.push(route.request().method());
            grants = [];
            return route.fulfill({ json: { ok: true, result: {} } });
        });
        await page.route("**/visibility", route => {
            writes.push(route.request().method());
            return route.fulfill({ json: { ok: true, result: {} } });
        });
        await page.goto(`${base}/?session=${id}`);
        const modal = page.locator(".ps-share-modal");
        const open = async () => {
            await page.locator(`.ps-session-list-button[data-session-id="${id}"]`).waitFor({ state: "attached" });
            const sessions = page.getByRole("button", { name: "Sessions", exact: true });
            const manage = page.getByRole("button", { name: /^Manage session/ }).first();
            if (await sessions.isVisible() && !await manage.isVisible()) await sessions.click();
            await manage.click();
            await modal.getByRole("tab", { name: "Access", exact: true }).click();
        };
        for (const state of ["initial", ...(width === 1440 ? ["settings"] : []), "reloaded"]) {
            if (state === "settings") {
                await page.getByRole("button", { name: "Admin console", exact: true }).click();
                await page.getByRole("button", { name: /^Close .*console$/i }).click();
            }
            if (state === "reloaded") await page.reload();
            await open();
            await expect(modal.getByText(/system session sharing.*deployment policy/i)).toBeVisible();
            for (const radio of await modal.getByRole("radio").all()) await expect(radio).toBeDisabled();
            await expect(modal.getByPlaceholder("Name, email, or id")).toBeDisabled();
            await expect(modal.getByRole("combobox")).toBeDisabled();
            await expect(modal.getByRole("button", { name: "Add", exact: true })).toBeDisabled();
            await expect(modal.getByRole("button", { name: "Apply", exact: true })).toBeDisabled();
            await expect(modal.getByRole("button", { name: "Remove", exact: true })).toBeEnabled();
            await modal.getByRole("button", { name: "Close", exact: true }).click();
        }
        await open();
        await modal.getByRole("button", { name: "Remove", exact: true }).click();
        await modal.getByRole("button", { name: "Apply", exact: true }).click();
        await expect.poll(() => writes).toEqual(["POST"]);
        await modal.getByRole("button", { name: "Close", exact: true }).click();
        isSystem = false;
        await open();
        const shared = modal.getByRole("radio").nth(2);
        await expect(shared).toBeEnabled();
        await shared.check();
        await expect(modal.getByPlaceholder("Name, email, or id")).toBeEnabled();
        await expect(modal.getByRole("combobox")).toBeEnabled();
        await expect(modal.getByRole("button", { name: "Apply", exact: true })).toBeEnabled();
    });
}
