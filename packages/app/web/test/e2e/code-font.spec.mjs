import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

// The code font is a choice in Settings › Appearance: the theme's default,
// JetBrains Mono or the system monospace stack. Horizon Dawn's default is
// JetBrains Mono; every other theme keeps the system stack it always had.
test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 2, admin: true }); base = `http://127.0.0.1:${stub.port}`; });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

async function withProfile(page, initial) {
    let settings = { ...initial };
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
        if (path.endsWith("/me/profile")) return reply({ isAdmin: true, profileSettings: settings });
        return route.fallback();
    });
    return saves;
}

const monoOf = (page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--ps-mono").trim());

test("Horizon Dawn uses JetBrains Mono by default; another theme keeps the system stack", async ({ page }) => {
    await withProfile(page, { themeId: "horizon-dawn" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base);
    await expect(page.locator("html")).toHaveAttribute("data-ps-theme", "horizon-dawn");
    await expect(page.locator("html")).toHaveAttribute("data-ps-mono", "jetbrains");
    expect(await monoOf(page)).toMatch(/^"PS JetBrains Mono"/);
    // The face really comes from the bundle.
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('13px "PS JetBrains Mono"'))).toBe(true);
});

test("a theme without a font of its own looks exactly as before: the system monospace", async ({ page }) => {
    await withProfile(page, { themeId: "hearth" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base);
    await expect(page.locator("html")).toHaveAttribute("data-ps-theme", "hearth");
    await expect(page.locator("html")).toHaveAttribute("data-ps-mono", "system");
    expect(await monoOf(page)).toBe("ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace");
});

test("Appearance picks the code font, it is saved, and it beats the theme's default", async ({ page }) => {
    const saves = await withProfile(page, { themeId: "horizon-dawn" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base);
    await expect(page.locator("html")).toHaveAttribute("data-ps-mono", "jetbrains");
    await page.locator('button[aria-label="Admin console"]').click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    const group = page.getByRole("region", { name: "Appearance" }).getByRole("group", { name: "Code font" });
    await expect(group.getByRole("button", { name: "Theme default" })).toHaveAttribute("aria-pressed", "true");

    await group.getByRole("button", { name: "System" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-ps-mono", "system");
    await expect(group.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => saves.at(-1)?.codeFont).toBe("system");

    // A reload keeps it.
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-ps-theme", "horizon-dawn");
    await expect(page.locator("html")).toHaveAttribute("data-ps-mono", "system");
});

test("on a phone the choice is a native picker in Appearance", async ({ page }) => {
    const saves = await withProfile(page, { themeId: "hearth" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    await expect(page.locator("html")).toHaveAttribute("data-ps-mono", "system");
    await page.getByRole("button", { name: "Admin Console", exact: true }).click();
    await page.locator(".ps-admin-console.is-mobile").getByRole("button", { name: "Appearance", exact: true }).click();
    const picker = page.getByRole("region", { name: "Appearance" }).getByRole("combobox", { name: "Code font" });
    await expect(picker).toHaveValue("theme");
    await picker.selectOption("jetbrains");
    await expect(page.locator("html")).toHaveAttribute("data-ps-mono", "jetbrains");
    await expect.poll(() => saves.at(-1)?.codeFont).toBe("jetbrains");
    // iOS zooms into inputs under 16 px.
    expect(await picker.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
});
