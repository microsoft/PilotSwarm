// The zen rail's composer stays one line at rest.
//
// WHY THIS EXISTS: in a 330px rail the "you" label and three buttons left the
// input about 140px. Its hint, sized into the box on purpose, wrapped to two
// lines, and after a send the longer queue hint to four. The narrow composer
// now takes the phone's layout (no label, the short hint), and a box sized to
// a wrapped hint shrinks as soon as text replaces it.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1, transcriptTurns: 2 }); });
test.afterAll(async () => { if (stub) await new Promise(resolve => stub.server.close(resolve)); });

async function openZen(page, railPx) {
    const settings = { themeId: "terminal-green", canvasPrefs: { [sessionId]: { zenRailPx: railPx } } };
    await page.route("**/api/v1/**", route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/me/profile/settings")) return route.fulfill({ json: { ok: true, result: { profileSettings: settings } } });
        if (url.pathname.endsWith("/me/profile")) return route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: settings } } });
        if (/\/messages$/.test(url.pathname)) return route.fulfill({ json: { ok: true, result: { queued: true } } });
        return route.fallback();
    });
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    await page.locator(".ps-session-list-button").first().waitFor();
    const box = page.getByTestId("composer-input").first();
    const wide = await box.evaluate(node => ({ placeholder: node.placeholder, label: getComputedStyle(node.closest(".ps-prompt-shell").querySelector(".ps-prompt-label")).display }));
    await page.getByRole("button", { name: /^Show canvas$/i }).first().click();
    await page.getByRole("button", { name: "Zen mode" }).first().click();
    await expect(page.getByRole("button", { name: "Leave zen mode" }).first()).toBeVisible();
    return { box, wide };
}

const height = box => box.evaluate(node => node.getBoundingClientRect().height);

for (const railPx of [260, 330]) test(`${railPx}px zen rail: one line at rest, and back to one line after a long prompt`, async ({ page }) => {
    const { box, wide } = await openZen(page, railPx);
    // The full-width chat composer keeps its label and full hint.
    expect(wide.placeholder).toBe("Type a message and press Enter");
    expect(wide.label).not.toBe("none");

    await expect(box).toHaveAttribute("placeholder", "Message…");
    await expect(page.locator(".ps-prompt-shell.is-narrow .ps-prompt-label.is-default")).toBeHidden();
    const rest = await height(box);
    expect(rest).toBeLessThanOrEqual(48);

    await box.click();
    await box.fill("Please review every one of the following points in detail. ".repeat(40));
    await expect.poll(() => height(box)).toBeGreaterThan(rest * 3);
    await box.press("Enter");
    await expect(box).toHaveValue("");
    await expect.poll(() => height(box)).toBeLessThanOrEqual(rest + 1);
    await box.fill("short");
    await expect.poll(() => height(box)).toBeLessThanOrEqual(rest + 1);
});

test("a narrow desktop chat beside a canvas keeps a usable one-line composer", async ({ page }) => {
    const settings = { themeId: "terminal-green", chatReading: { on: true, pad: 16, align: "left", width: 1100 } };
    await page.route("**/api/v1/**", route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/me/profile/settings")) return route.fulfill({ json: { ok: true, result: { profileSettings: settings } } });
        if (url.pathname.endsWith("/me/profile")) return route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: settings } } });
        return route.fallback();
    });
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    await page.locator(".ps-session-list-button").first().waitFor();
    await page.getByRole("button", { name: /^Show canvas$/i }).first().click();
    const box = page.getByTestId("composer-input").first();
    await expect(page.locator(".ps-chat-panel.is-reading .ps-prompt-shell.is-narrow")).toBeVisible();
    await expect(box).toHaveAttribute("placeholder", "Message…");
    const g = await box.evaluate(node => {
        const chat = document.querySelector(".ps-workspace-main-grid > .ps-workspace-pane-slot:last-child").getBoundingClientRect();
        const r = node.getBoundingClientRect();
        return { chat: chat.width, w: r.width, h: r.height };
    });
    expect(g.chat).toBeGreaterThanOrEqual(223);
    expect(g.w).toBeGreaterThanOrEqual(80);
    expect(g.h).toBeLessThanOrEqual(48);
});

test("zen ignores the reading column and its inset; leaving zen restores them", async ({ page }) => {
    const settings = { themeId: "terminal-green", chatReading: { on: true, pad: 40, align: "left", width: 900 },
        canvasPrefs: { [sessionId]: { zenRailPx: 420 } } };
    await page.route("**/api/v1/**", route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/me/profile/settings")) return route.fulfill({ json: { ok: true, result: { profileSettings: settings } } });
        if (url.pathname.endsWith("/me/profile")) return route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: settings } } });
        return route.fallback();
    });
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    await page.locator(".ps-session-list-button").first().waitFor();
    await page.getByRole("button", { name: /^Show canvas$/i }).first().click();
    await expect(page.locator(".ps-chat-panel.is-reading")).toHaveCount(1);
    await page.getByRole("button", { name: "Zen mode" }).first().click();
    await expect(page.getByRole("button", { name: "Leave zen mode" }).first()).toBeVisible();
    await expect(page.locator(".ps-chat-panel.is-reading")).toHaveCount(0);
    // The composer starts at the rail's own padding, not 40px further in.
    const inset = await page.locator(".ps-chat-panel .ps-chat-composer").first().evaluate(node => {
        const panel = node.closest(".ps-chat-panel").getBoundingClientRect();
        return node.getBoundingClientRect().left - panel.left;
    });
    expect(inset).toBeLessThan(30);
    await page.getByRole("button", { name: "Leave zen mode" }).first().click();
    await expect(page.locator(".ps-chat-panel.is-reading")).toHaveCount(1);
});
