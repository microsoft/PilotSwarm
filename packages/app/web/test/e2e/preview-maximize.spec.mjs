// An artifact preview can take the whole screen, as the canvas can.
//
// Desktop: the reader column covers the workspace (sessions and chat), its
// own bar stays with Restore; Escape steps down to the column, then closes.
// Phone: the full-screen preview drops its bar and the page's own header; one
// small button in the corner brings them back.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const browserName = process.env.PS_TEST_BROWSER || "chromium";
test.use({ browserName });
const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 2 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const PAGE = `<!doctype html><html><body style="margin:0;background:#123"><h1 style="color:#fff">Report</h1></body></html>`;
const ENTRY = { filename: "report.html", contentType: "text/html", sizeBytes: PAGE.length, uploadedAt: "2026-11-07T00:00:00.000Z", source: "agent", isBinary: false };

async function withReport(page) {
    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        if (/\/artifacts$/.test(url.pathname)) return route.fulfill({ json: { ok: true, result: [ENTRY] } });
        if (url.pathname.endsWith("/artifacts/report.html/meta")) return route.fulfill({ json: { ok: true, result: ENTRY } });
        if (url.pathname.endsWith("/artifacts/report.html/download")) return route.fulfill({ contentType: "text/html", body: PAGE });
        return route.fallback();
    });
}

const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });

test("desktop: the reader takes the whole workspace, Escape steps down, then closes", async ({ page }) => {
    await withReport(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}&artifact=report.html`);
    const reader = page.locator(".ps-artifact-layer");
    const frame = page.frameLocator(".ps-artifact-layer iframe.ps-html-preview-frame:not(.is-staging)");
    await expect(frame.locator("h1")).toHaveText("Report", { timeout: 15_000 });
    const grid = page.locator(".ps-workspace-grid").first();
    const column = await box(reader);
    const workspace = await box(grid);
    expect(column.w).toBeLessThan(workspace.w * 0.8);

    await reader.getByRole("button", { name: "Full screen preview" }).click();
    await expect(reader).toHaveClass(/is-maximized/);
    await expect.poll(async () => { const r = await box(reader); return Math.abs(r.x - workspace.x) < 4 && Math.abs(r.w - workspace.w) < 4 && Math.abs(r.h - workspace.h) < 4; }).toBe(true);
    // Nothing behind shows through the bar.
    expect(await reader.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(/rgba\(.*, 0\)$|transparent/);
    // The page is still the same document, not reloaded.
    await expect(frame.locator("h1")).toHaveText("Report");
    await expect(reader.getByRole("button", { name: "Restore preview" })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(reader).not.toHaveClass(/is-maximized/);
    await expect(reader).toBeVisible();
    await expect(reader.getByRole("button", { name: "Full screen preview" })).toBeVisible();

    // Full screen, then the close button: the next preview opens in its column.
    await reader.getByRole("button", { name: "Full screen preview" }).click();
    await reader.getByRole("button", { name: "Close artifact" }).click();
    await expect(reader).toHaveCount(0);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}&artifact=report.html`);
    await expect(frame.locator("h1")).toHaveText("Report", { timeout: 15_000 });
    await expect(page.locator(".ps-artifact-layer")).not.toHaveClass(/is-maximized/);
});

test("phone: the preview drops its bar and header, and one corner button brings them back", async ({ page }) => {
    await withReport(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}&artifact=report.html&view=full`);
    const overlay = page.locator(".ps-artifact-overlay");
    const frameEl = page.locator(".ps-artifact-overlay iframe.ps-html-preview-frame:not(.is-staging)");
    await expect(page.frameLocator(".ps-artifact-overlay iframe.ps-html-preview-frame:not(.is-staging)").locator("h1")).toHaveText("Report", { timeout: 15_000 });
    const before = await box(frameEl);
    await expect(overlay.locator(".ps-artifact-overlay-bar")).toBeVisible();

    await overlay.getByRole("button", { name: "Full screen preview" }).click();
    await expect(overlay).toHaveClass(/is-maximized/);
    await expect(overlay.locator(".ps-artifact-overlay-bar")).toHaveCount(0);
    await expect(overlay.locator(".ps-panel-header")).toHaveCount(0);
    await expect.poll(async () => (await box(frameEl)).h).toBeGreaterThan(before.h + 40);
    const after = await box(frameEl);
    expect(after.y).toBeLessThan(before.y);
    const restore = overlay.getByRole("button", { name: "Restore preview" });
    const r = await box(restore);
    expect(r.x + r.w).toBeGreaterThan(390 - 60);
    expect(r.y).toBeLessThan(60);
    // The target reaches 44 px even though the button looks smaller.
    expect(await restore.evaluate((el) => { const s = getComputedStyle(el, "::after"); return parseFloat(s.top) <= -4 && parseFloat(s.left) <= -4; })).toBe(true);

    await restore.click();
    await expect(overlay).not.toHaveClass(/is-maximized/);
    await expect(overlay.locator(".ps-artifact-overlay-bar")).toBeVisible();
    await expect.poll(async () => (await box(frameEl)).h).toBeLessThan(after.h);
});
