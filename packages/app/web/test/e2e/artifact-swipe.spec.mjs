// Two fingers sideways over a phone's full-screen HTML artifact go Back and
// Forward, as on every other phone screen.
//
// WHY THIS EXISTS: an HTML artifact renders in a sandboxed frame, so its
// touches never reach the portal's document. The phone's preview reports two
// fingers to the portal; one finger, a pinch and a scroll stay the page's.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const browserName = process.env.PS_TEST_BROWSER || "chromium";
test.use({ browserName, hasTouch: true, isMobile: true });
const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const PAGE = `<!doctype html><html><body style="margin:0;background:#123">
<div style="height:2000px;background:linear-gradient(#123,#456)"><h1 style="color:#fff">Report</h1></div></body></html>`;
const ENTRY = { filename: "report.html", contentType: "text/html", sizeBytes: PAGE.length, uploadedAt: "2026-11-07T00:00:00.000Z", source: "agent", isBinary: false };

async function openReport(page) {
    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        // A signed-in person: the view history is kept per person.
        if (url.pathname.endsWith("/bootstrap")) return route.fulfill({ json: { ok: true, result: { auth: { principal: { provider: "none", subject: "test", email: "test@example.com" }, authorization: { allowed: true, role: "user" } } } } });
        if (/\/artifacts$/.test(url.pathname)) return route.fulfill({ json: { ok: true, result: [ENTRY] } });
        if (url.pathname.endsWith("/artifacts/report.html/meta")) return route.fulfill({ json: { ok: true, result: ENTRY } });
        if (url.pathname.endsWith("/artifacts/report.html/download")) return route.fulfill({ contentType: "text/html", body: PAGE });
        return route.fallback();
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    await page.waitForFunction(() => Object.keys(sessionStorage).some((key) => key.startsWith("pilotswarm.view-history.v1:")));
    // Diagnostics, its Files tab, then the file: the preview opens full screen
    // over the Files tab, which is the stop Back returns to.
    await page.locator('.ps-toolbar.is-mobile button[aria-label^="Diagnostics"]').first().click();
    await page.getByRole("button", { name: "Files" }).first().click();
    await page.getByText("report.html").first().click();
    const overlay = page.locator(".ps-artifact-overlay");
    await expect(overlay).toBeVisible({ timeout: 15_000 });
    await expect(page.frameLocator(FRAME).locator("h1")).toHaveText("Report", { timeout: 15_000 });
    return overlay;
}

const FRAME = ".ps-artifact-overlay iframe.ps-html-preview-frame:not(.is-staging)";

test("two fingers sideways over an HTML artifact go back, one finger and a pinch do not", async ({ page, context }) => {
    test.skip(browserName !== "chromium", "multi-touch input needs the Chromium protocol");
    const overlay = await openReport(page);
    const frameEl = page.locator(FRAME);
    const box = await frameEl.boundingBox();
    const cx = box.x + 60, cy = box.y + box.height / 2;
    const cdp = await context.newCDPSession(page);
    const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
    const frame = () => page.waitForTimeout(16);

    // One finger sideways: the page's, nothing moves.
    await touch("touchStart", [[cx, cy]]);
    for (let i = 1; i <= 12; i++) { await touch("touchMove", [[cx + i * 18, cy]]); await frame(); }
    await touch("touchEnd", []);
    await expect(overlay).toBeVisible();

    // Two fingers spreading: a pinch, left to the page.
    await touch("touchStart", [[cx + 60, cy], [cx + 120, cy]]);
    for (let i = 1; i <= 10; i++) { await touch("touchMove", [[cx + 60 - i * 4, cy], [cx + 120 + i * 4, cy]]); await frame(); }
    await touch("touchEnd", []);
    await page.waitForTimeout(400);
    await expect(overlay).toBeVisible();

    // Two fingers sideways together: the preview follows them, then Back.
    await touch("touchStart", [[cx, cy - 40], [cx, cy + 40]]);
    let followed = false;
    for (let i = 1; i <= 12; i++) {
        await touch("touchMove", [[cx + i * 18, cy - 40], [cx + i * 18, cy + 40]]);
        await frame();
        if (i === 9) {
            await expect(page.locator(".ps-swipe-hint")).toHaveAttribute("data-ready", "true");
            followed = /translate3d\((\d+(?:\.\d+)?)px/.test(await overlay.evaluate((el) => el.style.transform));
        }
    }
    await touch("touchEnd", []);
    expect(followed).toBe(true);
    await expect(overlay).toBeHidden();
    await expect(page.locator('.ps-toolbar.is-mobile button[aria-label^="Diagnostics"]').first()).toHaveAttribute("aria-label", "Diagnostics — back to the chat");
});

test("a desktop HTML artifact keeps its exact bytes: no touch bridge", async ({ page }) => {
    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        // A signed-in person: the view history is kept per person.
        if (url.pathname.endsWith("/bootstrap")) return route.fulfill({ json: { ok: true, result: { auth: { principal: { provider: "none", subject: "test", email: "test@example.com" }, authorization: { allowed: true, role: "user" } } } } });
        if (/\/artifacts$/.test(url.pathname)) return route.fulfill({ json: { ok: true, result: [ENTRY] } });
        if (url.pathname.endsWith("/artifacts/report.html/meta")) return route.fulfill({ json: { ok: true, result: ENTRY } });
        if (url.pathname.endsWith("/artifacts/report.html/download")) return route.fulfill({ contentType: "text/html", body: PAGE });
        return route.fallback();
    });
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}&artifact=report.html`);
    const frame = page.frameLocator("iframe.ps-html-preview-frame:not(.is-staging)").first();
    await expect(frame.locator("h1")).toHaveText("Report", { timeout: 15_000 });
    expect(await frame.locator("script").count()).toBe(0);
});
