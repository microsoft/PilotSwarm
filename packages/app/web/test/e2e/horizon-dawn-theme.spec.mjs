/**
 * Horizon Dawn: the Azure HorizonDB GA theme's header scenery.
 *
 * The GA line reads exactly; the header stays compact; every layer (sky,
 * Orion, mountains, the animated mark) and the bundled Sora font load from the
 * bundle, not the network; reduced motion swaps in the still art; the sky sits
 * behind the land; and the phone header keeps Orion and the line on screen.
 */
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
const sessionId = "11111110-2222-3333-4444-555555555551";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 2, transcriptTurns: 1 }); });
test.afterAll(async () => { if (stub) await new Promise(resolve => stub.server.close(resolve)); });

async function openTheme(page, viewport) {
    const failed = [];
    page.on("requestfailed", request => failed.push(request.url()));
    page.on("response", response => { if (response.status() >= 400 && /horizon-dawn|sora|\.svg|\.woff2/i.test(response.url())) failed.push(`${response.status()} ${response.url()}`); });
    await page.route("**/api/v1/**", route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/me/profile")) return route.fulfill({ json: { ok: true, result: { profileSettings: { themeId: "horizon-dawn" } } } });
        return route.fallback();
    });
    await page.setViewportSize(viewport);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    await expect(page.locator("html")).toHaveAttribute("data-ps-theme", "horizon-dawn");
    await page.evaluate(() => document.fonts.ready);
    return failed;
}

const layers = page => page.locator(".portal-header").evaluate(header => getComputedStyle(header, "::before").backgroundImage);
// Each art file carries a root id (hd-<name>); Vite inlines the small ones as data URIs and emits
// the large ones as hashed files, so a layer is found by either form.
const art = name => new RegExp(`hd-${name}(?![-a-z])|/${name}-[A-Za-z0-9_-]{8}\\.svg`);
const where = (images, name) => images.search(art(name));

test("desktop: the GA line, a compact header, and every layer from the bundle", async ({ page }) => {
    const failed = await openTheme(page, { width: 1440, height: 900 });
    const header = page.locator(".portal-header");
    expect(await header.evaluate(el => getComputedStyle(el, "::after").content)).toBe('"Azure HorizonDB  /  Generally Available Nov 17, 2026"');
    const box = await header.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(96);
    expect(box.height).toBeLessThanOrEqual(110);
    const images = await layers(page);
    const order = ["mountains-front", "mountains-back", "orion", "sky"].map(name => where(images, name));
    expect(order.every(index => index >= 0), images).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order); // land is drawn over the sky
    expect(images).not.toMatch(/googleapis|gstatic/);
    expect(await page.locator(".portal-logo-frame").evaluate(el => getComputedStyle(el).backgroundImage)).toMatch(art("logo"));
    expect(await page.evaluate(() => document.fonts.check('600 13px "PS Sora"'))).toBe(true);
    await page.waitForTimeout(500);
    expect(failed).toEqual([]);
});

test("state signals survive the theme: focused pane, focused composer, pressed toggle, current tab", async ({ page }) => {
    await openTheme(page, { width: 1440, height: 900 });
    const states = await page.evaluate(() => {
        const style = (el) => { const s = getComputedStyle(el); return `${s.borderTopColor}|${s.backgroundColor}|${s.boxShadow}`; };
        const focused = document.querySelector(".ps-panel.is-focused");
        const unfocused = document.querySelector(".ps-panel:not(.is-focused)");
        const button = document.querySelector(".portal-header .ps-toolbar-button:not(.is-active)");
        const rest = style(button);
        button.classList.add("is-active"); const pressed = style(button); button.classList.remove("is-active");
        const row = document.createElement("div"); row.className = "ps-tab-row-icons";
        const tab = document.createElement("button"); tab.className = "ps-toolbar-button is-active"; row.append(tab); document.body.append(row);
        const tabShadow = getComputedStyle(tab).boxShadow; row.remove();
        return { focused: focused && style(focused), unfocused: unfocused && style(unfocused), rest, pressed, tabShadow };
    });
    expect(states.focused, "a pane is focused at start").toBeTruthy();
    expect(states.focused).not.toBe(states.unfocused);
    expect(states.pressed).not.toBe(states.rest);
    expect(states.tabShadow).toMatch(/0px -2px 0px 0px inset/);
    const input = page.locator(".ps-prompt-input").first();
    await input.focus();
    expect(await input.evaluate(el => getComputedStyle(el).borderTopColor)).toBe("rgb(92, 200, 242)");
});

test("reduced motion: still art for the mark, Orion and the sky", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openTheme(page, { width: 1440, height: 900 });
    const images = await layers(page);
    expect(images).toMatch(art("orion-still"));
    expect(images).toMatch(art("sky-still"));
    expect(images).not.toMatch(art("orion"));
    expect(await page.locator(".portal-logo-frame").evaluate(el => getComputedStyle(el).backgroundImage)).toMatch(art("logo-still"));
});

test("phone: Orion and the GA line stay on screen, nothing scrolls sideways", async ({ page }) => {
    const failed = await openTheme(page, { width: 390, height: 844 });
    const images = await layers(page);
    expect(images).toMatch(art("orion-phone"));
    const header = await page.locator(".portal-header").boundingBox();
    expect(header.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.waitForTimeout(500);
    expect(failed).toEqual([]);
});
