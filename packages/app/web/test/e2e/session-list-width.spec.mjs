// The session list keeps one width while you flip between sessions.
//
// WHY THIS EXISTS: the list was 24% of the sessions + chat grid. A session
// with its canvas open shrank that grid, so the list jumped narrower on every
// canvas session and back on every plain one. The list's width now comes from
// the whole workspace; an open column takes its width from chat.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 3 }); base = `http://127.0.0.1:${stub.port}`; });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const geometry = page => page.evaluate(() => {
    const rect = sel => document.querySelector(sel)?.getBoundingClientRect() ?? null;
    const list = rect(".ps-workspace-main-grid > .ps-workspace-pane-slot:first-child");
    const chat = rect(".ps-workspace-main-grid > .ps-workspace-pane-slot:last-child");
    return {
        listLeft: list?.left, listRight: list?.right, chat: chat?.width ?? 0,
        canvas: document.querySelector(".ps-canvas-layer:not(.is-hidden)")?.getBoundingClientRect().width ?? 0,
    };
});

for (const width of [1600, 1280]) test(`${width}px: opening a canvas, or flipping to a session without one, never moves the list`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(base);
    const rows = page.locator(".ps-session-list-button");
    await rows.first().waitFor();
    await rows.nth(0).click();
    await page.waitForTimeout(300);
    const plain = await geometry(page);
    expect(plain.canvas).toBe(0);

    const showCanvas = page.getByRole("button", { name: /^Show canvas$/i });
    await showCanvas.first().click();
    await expect.poll(async () => (await geometry(page)).canvas).toBeGreaterThan(0);
    const withCanvas = await geometry(page);
    // The canvas takes its width from chat, not from the list.
    expect(Math.abs(withCanvas.listRight - plain.listRight)).toBeLessThanOrEqual(1);
    expect(withCanvas.chat).toBeLessThan(plain.chat);

    // Flip between sessions: the canvas follows its session or not; the list stays.
    for (const index of [1, 0, 2, 0]) {
        await rows.nth(index).click();
        await page.waitForTimeout(300);
        const now = await geometry(page);
        expect(Math.abs(now.listLeft - plain.listLeft)).toBeLessThanOrEqual(1);
        expect(Math.abs(now.listRight - plain.listRight)).toBeLessThanOrEqual(1);
    }
});

test("the list still gives way so chat keeps its floor on a narrow window", async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto(base);
    await page.locator(".ps-session-list-button").first().click();
    await page.getByRole("button", { name: /^Show canvas$/i }).first().click();
    await expect.poll(async () => (await geometry(page)).canvas).toBeGreaterThan(0);
    const g = await geometry(page);
    expect(g.chat).toBeGreaterThanOrEqual(224 - 1);
    expect(g.listRight - g.listLeft).toBeLessThan(1000 * 0.24);
});

test("a session that remembers a wider canvas than fits still leaves the list alone", async ({ page }) => {
    // Canvas widths are remembered per session. Session 1's is 640 + 884 px.
    const settings = { sessionViews: {
        [`11111110-2222-3333-4444-555555555550`]: { desktop: { at: 1, canvasOpen: false, layout: {} } },
        [`11111111-2222-3333-4444-555555555551`]: { desktop: { at: 1, canvasOpen: true, layout: { canvasPaneAdjust: 884 } } },
        [`11111112-2222-3333-4444-555555555552`]: { desktop: { at: 1, canvasOpen: true, layout: { canvasPaneAdjust: 0 } } },
    } };
    await page.route("**/api/v1/me/profile", (route) => route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: settings } } }));
    await page.route("**/api/v1/me/profile/settings", (route) => route.fulfill({ json: { ok: true, result: { profileSettings: settings } } }));
    for (const width of [1440, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(base);
        const rows = page.locator(".ps-session-list-button");
        await rows.first().waitFor();
        await rows.nth(0).click();
        await page.waitForTimeout(300);
        const plain = await geometry(page);
        for (const index of [1, 2, 1, 0]) {
            await rows.nth(index).click();
            await page.waitForTimeout(400);
            const now = await geometry(page);
            expect(Math.abs(now.listRight - plain.listRight), `${width}px, session ${index}`).toBeLessThanOrEqual(1);
            expect(now.chat, `${width}px, session ${index}: chat keeps its floor`).toBeGreaterThanOrEqual(223);
            if (index === 1) {
                expect(now.canvas, "the wide canvas shows narrower than remembered").toBeGreaterThan(0);
                expect(now.canvas).toBeLessThan(640 + 884);
            }
        }
    }
});

// Opening Settings swaps the workspace out and back in. The width measurements
// used to stay bound to the old, removed grid; the list then fell back to an
// estimate that counted each session's canvas, and changed width on every
// switch until a reload. Settings is where the reading column is turned on or
// off, so that is how it showed up.
for (const reading of [false, true]) test(`after Settings opens and closes, the list still holds its width (reading column ${reading ? "on" : "off"})`, async ({ page }) => {
    const settings = { chatReading: { on: reading, width: 1100, align: "left", pad: 20 }, sessionViews: {
        [`11111110-2222-3333-4444-555555555550`]: { desktop: { at: 1, canvasOpen: false, layout: {} } },
        [`11111111-2222-3333-4444-555555555551`]: { desktop: { at: 1, canvasOpen: true, layout: { canvasPaneAdjust: 137 } } },
        [`11111112-2222-3333-4444-555555555552`]: { desktop: { at: 1, canvasOpen: true, layout: { canvasPaneAdjust: -114 } } },
    } };
    await page.route("**/api/v1/me/profile", (route) => route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: settings } } }));
    await page.route("**/api/v1/me/profile/settings", (route) => route.fulfill({ json: { ok: true, result: { profileSettings: settings } } }));
    await page.setViewportSize({ width: 1512, height: 900 });
    await page.goto(base);
    const rows = page.locator(".ps-session-list-button");
    await rows.first().waitFor();
    await rows.nth(0).click();
    await page.waitForTimeout(300);
    const plain = await geometry(page);

    await page.locator('button[aria-label="Settings"]').click();
    await expect(page.locator(".ps-workspace-grid")).toHaveCount(0);
    await page.locator('button[aria-label="Close settings"]').click();
    await expect(page.locator(".ps-workspace-grid")).toHaveCount(1);

    for (const index of [1, 0, 2, 1, 0]) {
        await rows.nth(index).click();
        await page.waitForTimeout(400);
        const now = await geometry(page);
        expect(Math.abs(now.listRight - plain.listRight), `session ${index}`).toBeLessThanOrEqual(1);
        if (index > 0) expect(now.canvas, `session ${index} shows its canvas`).toBeGreaterThan(0);
    }
});
