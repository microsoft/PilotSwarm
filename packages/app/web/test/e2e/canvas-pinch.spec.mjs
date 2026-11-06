// A pinch on the phone's canvas zooms the canvas within its box, never the
// page; two fingers move the magnified canvas around; 1:1 puts it back.
//
// WHY THIS EXISTS: the canvas is live HTML, so one finger belongs to the page
// (buttons, scrolling, games). The portal takes only two-finger gestures, the
// way maps do, and keeps the magnified page covering its box edge to edge.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const browserName = process.env.PS_TEST_BROWSER || "chromium";
test.use({ browserName, hasTouch: true, isMobile: true });
const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const PAGE = `<!doctype html><html><body style="margin:0;background:#123">
<div style="height:2000px;background:linear-gradient(#123,#456)"><h1 style="color:#fff">Canvas</h1></div></body></html>`;

test("pinch zooms inside the box, two fingers move it, 1:1 resets", async ({ page, context }) => {
    test.skip(browserName !== "chromium", "multi-touch input needs the Chromium protocol");
    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_updated")) {
            return route.fulfill({ json: { ok: true, result: [{ seq: 1, eventType: "session.canvas_updated", data: { slot: 1, rev: 1, sizeBytes: PAGE.length, name: "pinch-test" } }] } });
        }
        if (url.pathname.includes("/artifacts/") && url.pathname.includes("canvas.html")) return route.fulfill({ contentType: "text/html", body: PAGE });
        return route.fallback();
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    await page.locator('.ps-toolbar.is-mobile button[aria-label*="anvas"]').first().click();
    const frameEl = page.locator(".ps-mobile-canvas-layer iframe.ps-html-preview-frame:not(.is-staging)");
    await expect(page.frameLocator(".ps-mobile-canvas-layer iframe.ps-html-preview-frame:not(.is-staging)").locator("h1")).toHaveText("Canvas");
    const box = await frameEl.boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const cdp = await context.newCDPSession(page);
    const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
    const transform = () => frameEl.evaluate((el) => el.style.transform);
    const translate = async () => (await transform()).match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/)?.slice(1).map(Number) || [0, 0];

    // Spread two fingers: the canvas grows, the page does not.
    await touch("touchStart", [[cx - 30, cy], [cx + 30, cy]]);
    for (let i = 1; i <= 10; i++) await touch("touchMove", [[cx - 30 - i * 6, cy], [cx + 30 + i * 6, cy]]);
    await touch("touchEnd", []);
    await expect.poll(transform).toMatch(/scale\(3\)/);
    expect(await page.evaluate(() => window.visualViewport.scale)).toBe(1);
    await expect(page.locator(".ps-canvas-pinch-hint")).toHaveText("Two fingers to move");
    const [x0, y0] = await translate();

    // Two fingers together: the magnified page follows them.
    await touch("touchStart", [[cx - 40, cy], [cx + 40, cy]]);
    for (let i = 1; i <= 10; i++) await touch("touchMove", [[cx - 40 + i * 8, cy + i * 6], [cx + 40 + i * 8, cy + i * 6]]);
    await touch("touchEnd", []);
    await expect.poll(async () => (await translate())[0]).toBeCloseTo(x0 + 80, 0);
    expect((await translate())[1]).toBeCloseTo(y0 + 60, 0);
    await expect.poll(transform).toMatch(/scale\(3\)/);

    // It never slides off its box: dragging far right stops at the left edge.
    await touch("touchStart", [[cx - 40, cy], [cx + 40, cy]]);
    for (let i = 1; i <= 10; i++) await touch("touchMove", [[cx - 40 + i * 100, cy], [cx + 40 + i * 100, cy]]);
    await touch("touchEnd", []);
    await expect.poll(async () => (await translate())[0]).toBe(0);

    await page.locator(".ps-canvas-pinch-reset").click();
    await expect.poll(transform).toBe("");
});
