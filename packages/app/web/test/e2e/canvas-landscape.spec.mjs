// A phone held sideways shows the canvas full screen, and the canvas
// controls fold into one small button in the corner.
//
// WHY THIS EXISTS: in landscape the canvas fills the screen edge to edge, and
// the open control strip sat on top of the page's own top bar, hiding its
// buttons (a code browser's comment and theme buttons, for example).
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const browserName = process.env.PS_TEST_BROWSER || "chromium";
test.use({ browserName, hasTouch: true, isMobile: true });
const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const PAGE = `<!doctype html><html><body style="margin:0;background:#123"><h1 style="color:#fff">Canvas</h1></body></html>`;

test("landscape full screen: the controls fold into one button, open on a tap, and fold again", async ({ page }) => {
    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_updated")) {
            return route.fulfill({ json: { ok: true, result: [{ seq: 1, eventType: "session.canvas_updated", data: { slot: 1, rev: 1, sizeBytes: PAGE.length, name: "landscape" } }] } });
        }
        if (url.pathname.includes("/artifacts/") && url.pathname.includes("canvas.html")) return route.fulfill({ contentType: "text/html", body: PAGE });
        return route.fallback();
    });
    await page.setViewportSize({ width: 844, height: 390 });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    await page.locator('.ps-toolbar.is-mobile button[aria-label*="anvas"]').first().click();
    const layer = page.locator(".ps-mobile-canvas-layer");
    await expect(layer).toHaveClass(/is-maximized/);
    await expect(page.frameLocator(".ps-mobile-canvas-layer iframe.ps-html-preview-frame:not(.is-staging)").locator("h1")).toHaveText("Canvas", { timeout: 15_000 });

    const handle = layer.getByRole("button", { name: "Canvas controls" });
    const restore = layer.getByRole("button", { name: "Restore canvas" });
    // Folded: one small button in the top-right corner, nothing else.
    await expect(handle).toBeVisible();
    await expect(restore).toHaveCount(0);
    const box = await handle.boundingBox();
    expect(box.width).toBeLessThanOrEqual(44);
    expect(box.x + box.width).toBeGreaterThan(844 - 60);
    expect(box.y).toBeLessThan(20);

    // A tap opens the controls; they fold again after a few seconds.
    await handle.tap();
    await expect(restore).toBeVisible();
    await expect(handle).toHaveCount(0);
    await expect(restore).toHaveCount(0, { timeout: 7_000 });
    await expect(handle).toBeVisible();

    // Opened again, Restore still works: back to the inset canvas.
    await handle.tap();
    await restore.tap();
    await expect(layer).not.toHaveClass(/is-maximized/);
});

test("portrait full screen keeps the open strip", async ({ page }) => {
    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_updated")) {
            return route.fulfill({ json: { ok: true, result: [{ seq: 1, eventType: "session.canvas_updated", data: { slot: 1, rev: 1, sizeBytes: PAGE.length, name: "portrait" } }] } });
        }
        if (url.pathname.includes("/artifacts/") && url.pathname.includes("canvas.html")) return route.fulfill({ contentType: "text/html", body: PAGE });
        return route.fallback();
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    await page.locator('.ps-toolbar.is-mobile button[aria-label*="anvas"]').first().click();
    const layer = page.locator(".ps-mobile-canvas-layer");
    await layer.getByRole("button", { name: "Maximize canvas" }).tap();
    await expect(layer).toHaveClass(/is-maximized/);
    await expect(layer.getByRole("button", { name: "Restore canvas" })).toBeVisible();
    await expect(layer.getByRole("button", { name: "Canvas controls" })).toHaveCount(0);
});
