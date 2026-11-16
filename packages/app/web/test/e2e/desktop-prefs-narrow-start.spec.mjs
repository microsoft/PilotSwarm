import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

// Per-device preferences (the desktop reading column, and the desktop and
// phone theme-sound slots) must survive a portal that opens at phone width and
// is then widened: the saved values are hydrated at every width, and only
// their use is gated by width.
test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 3, admin: true }); base = `http://127.0.0.1:${stub.port}`; });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

test("opening at phone width then widening keeps the saved desktop reading column and sound", async ({ page }) => {
    let settings = {
        themeId: "hearth",
        chatReading: { on: true, width: 720, align: "left", pad: 40 },
        themeSound: { on: false, volume: 35 },
        themeSoundMobile: { on: true, volume: 20 },
    };
    const saves = [];
    await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const reply = (result) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, result }) });
        if (path.endsWith("/me/profile/settings")) {
            settings = request.postDataJSON().settings;
            saves.push(settings);
            return reply({ profileSettings: settings });
        }
        if (path.endsWith("/me/profile")) return reply({ isAdmin: false, profileSettings: settings });
        return route.fallback();
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    await expect(page.locator("html")).toHaveAttribute("data-ps-theme", "hearth");
    await expect(page.locator(".ps-mobile-workspace")).toBeVisible();
    // The phone plays by its own setting.
    await expect(page.locator("html")).toHaveAttribute("data-ps-theme-sound", /playing|resting/);

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator(".ps-session-list-button").nth(1).click();
    await expect.poll(() => saves.length).toBeGreaterThan(0);
    await page.waitForTimeout(600);

    const last = saves.at(-1);
    expect(last.themeSound).toMatchObject({ on: false, volume: 35 });
    expect(last.themeSoundMobile).toMatchObject({ on: true, volume: 20 });
    expect(last.chatReading).toMatchObject({ on: true, width: 720, align: "left", pad: 40 });
    await expect(page.locator("html")).not.toHaveAttribute("data-ps-theme-sound", /./);
    await expect(page.locator(".ps-chat-panel.is-reading")).toHaveCount(1);
});

test("Appearance at phone width edits the phone's own sound setting", async ({ page }) => {
    let settings = { themeId: "hearth", themeSound: { on: true, volume: 35 }, themeSoundMobile: { on: false, volume: 40 } };
    await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const reply = (result) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, result }) });
        if (path.endsWith("/me/profile/settings")) {
            settings = request.postDataJSON().settings;
            return reply({ profileSettings: settings });
        }
        if (path.endsWith("/me/profile")) return reply({ isAdmin: true, profileSettings: settings });
        return route.fallback();
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base);
    await page.locator('button[aria-label="Admin console"]').click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    const pane = page.getByRole("region", { name: "Appearance" });
    await expect(pane.getByRole("switch", { name: "Theme sounds" })).toBeChecked();

    // At phone width the console becomes the phone console, and its sound
    // switch is the phone's own setting (stored off here), editable.
    await page.setViewportSize({ width: 390, height: 844 });
    const phone = page.locator(".ps-admin-console.is-mobile");
    await expect(phone).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-ps-theme-sound", /./);
    await phone.getByRole("button", { name: "Appearance", exact: true }).click();
    const phoneSound = page.getByRole("region", { name: "Appearance" }).getByRole("switch", { name: /Theme sounds/ });
    await expect(phoneSound).toBeEnabled();
    await expect(phoneSound).not.toBeChecked();
    await phoneSound.setChecked(true);
    await expect(page.locator("html")).toHaveAttribute("data-ps-theme-sound", /playing|resting/);
    await expect.poll(() => settings.themeSoundMobile?.on).toBe(true);
    expect(settings.themeSound).toMatchObject({ on: true, volume: 35 });
});

test("a phone with no saved sound setting plays by default; the desktop slot is untouched", async ({ page }) => {
    let settings = { themeId: "hearth", themeSound: { on: false, volume: 35 } };
    await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const reply = (result) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, result }) });
        if (path.endsWith("/me/profile/settings")) {
            settings = request.postDataJSON().settings;
            return reply({ profileSettings: settings });
        }
        if (path.endsWith("/me/profile")) return reply({ isAdmin: false, profileSettings: settings });
        return route.fallback();
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    await expect(page.locator(".ps-mobile-workspace")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-ps-theme-sound", /playing|resting/);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator("html")).not.toHaveAttribute("data-ps-theme-sound", /./);
});
