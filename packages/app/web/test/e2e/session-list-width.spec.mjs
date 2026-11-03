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
