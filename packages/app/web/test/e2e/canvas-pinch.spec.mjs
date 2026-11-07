// A pinch on the phone's canvas zooms the canvas within its box, never the
// page; two fingers move the magnified canvas around; 1:1 puts it back.
//
// WHY THIS EXISTS: the canvas is live HTML, so one finger belongs to the page
// (buttons, scrolling, games). The portal takes only two-finger gestures, the
// way maps do, and keeps the magnified page covering its box edge to edge.
// Two fingers sideways at 1x are the phone's back and forward, as on every
// other screen.
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
    await expect(page.frameLocator(".ps-mobile-canvas-layer iframe.ps-html-preview-frame:not(.is-staging)").locator("h1")).toHaveText("Canvas", { timeout: 15_000 });
    const box = await frameEl.boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const cdp = await context.newCDPSession(page);
    const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
    const frame = () => page.waitForTimeout(16);
    const transform = () => frameEl.evaluate((el) => el.style.transform);
    const translate = async () => (await transform()).match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/)?.slice(1).map(Number) || [0, 0];

    // Spread two fingers: the canvas grows, the page does not.
    await touch("touchStart", [[cx - 30, cy], [cx + 30, cy]]);
    for (let i = 1; i <= 10; i++) { await touch("touchMove", [[cx - 30 - i * 6, cy], [cx + 30 + i * 6, cy]]); await frame(); }
    await touch("touchEnd", []);
    await expect.poll(transform).toMatch(/scale\(3\)/);
    expect(await page.evaluate(() => window.visualViewport.scale)).toBe(1);
    await expect(page.locator(".ps-canvas-pinch-hint")).toHaveText("Two fingers to move");
    const [x0, y0] = await translate();

    // Two fingers together: the magnified page follows them.
    await touch("touchStart", [[cx - 40, cy], [cx + 40, cy]]);
    for (let i = 1; i <= 20; i++) { await touch("touchMove", [[cx - 40 + i * 4, cy + i * 3], [cx + 40 + i * 4, cy + i * 3]]); await frame(); }
    await touch("touchEnd", []);
    // Within a couple of pixels of where the fingers went (80 right, 60 down).
    await expect.poll(async () => Math.abs((await translate())[0] - (x0 + 80))).toBeLessThan(3);
    expect(Math.abs((await translate())[1] - (y0 + 60))).toBeLessThan(3);
    await expect.poll(transform).toMatch(/scale\(3\)/);

    // It never slides off its box: dragging far right stops at the left edge.
    await touch("touchStart", [[cx - 40, cy], [cx + 40, cy]]);
    for (let i = 1; i <= 10; i++) await touch("touchMove", [[cx - 40 + i * 100, cy], [cx + 40 + i * 100, cy]]);
    await touch("touchEnd", []);
    await expect.poll(async () => (await translate())[0]).toBe(0);

    await page.locator(".ps-canvas-pinch-reset").click();
    await expect.poll(transform).toBe("");
});

test("two fingers sideways on an unmagnified canvas go back, like everywhere else", async ({ page, context }) => {
    test.skip(browserName !== "chromium", "multi-touch input needs the Chromium protocol");
    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/bootstrap")) return route.fulfill({ json: { ok: true, result: { auth: { principal: { provider: "none", subject: "test", email: "test@example.com" }, authorization: { allowed: true, role: "user" } } } } });
        if (url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_updated")) {
            return route.fulfill({ json: { ok: true, result: [{ seq: 1, eventType: "session.canvas_updated", data: { slot: 1, rev: 1, sizeBytes: PAGE.length, name: "pinch-test" } }] } });
        }
        if (url.pathname.includes("/artifacts/") && url.pathname.includes("canvas.html")) return route.fulfill({ contentType: "text/html", body: PAGE });
        return route.fallback();
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    await page.waitForFunction(() => Object.keys(sessionStorage).some((key) => key.startsWith("pilotswarm.view-history.v1:")));
    const canvasButton = page.locator('.ps-toolbar.is-mobile button[aria-label*="anvas"]').first();
    await canvasButton.click();
    const layer = page.locator(".ps-mobile-canvas-layer");
    await expect(layer).not.toHaveClass(/is-hidden/);
    const frameEl = page.locator(".ps-mobile-canvas-layer iframe.ps-html-preview-frame:not(.is-staging)");
    await expect(page.frameLocator(".ps-mobile-canvas-layer iframe.ps-html-preview-frame:not(.is-staging)").locator("h1")).toHaveText("Canvas", { timeout: 15_000 });
    const box = await frameEl.boundingBox();
    const cy = box.y + box.height / 2;
    const cdp = await context.newCDPSession(page);
    const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
    await touch("touchStart", [[box.x + 80, cy - 40], [box.x + 80, cy + 40]]);
    for (let i = 1; i <= 12; i++) {
        await touch("touchMove", [[box.x + 80 + i * 18, cy - 40], [box.x + 80 + i * 18, cy + 40]]);
        await page.waitForTimeout(16);
        if (i === 9) await expect(page.locator(".ps-swipe-hint")).toHaveAttribute("data-ready", "true");
    }
    await touch("touchEnd", []);
    // Back to the chat, and the canvas was never magnified on the way.
    await expect(layer).toHaveClass(/is-hidden/);
    await expect(page.locator(".ps-mobile-chat-pane textarea")).toBeVisible();
    expect(await frameEl.evaluate((el) => el.style.transform)).toBe("");
});

// Review fixes: a canvas page can post any message it likes, so the portal
// only takes a two-finger swipe from the canvas the person is looking at, as
// one gesture, and never while a dialog is open.
async function openCanvasWithHistory(page) {
    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/bootstrap")) return route.fulfill({ json: { ok: true, result: { auth: { principal: { provider: "none", subject: "test", email: "test@example.com" }, authorization: { allowed: true, role: "user" } } } } });
        if (url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_updated")) {
            return route.fulfill({ json: { ok: true, result: [{ seq: 1, eventType: "session.canvas_updated", data: { slot: 1, rev: 1, sizeBytes: PAGE.length, name: "pinch-test" } }] } });
        }
        if (url.pathname.includes("/artifacts/") && url.pathname.includes("canvas.html")) return route.fulfill({ contentType: "text/html", body: PAGE });
        return route.fallback();
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    await page.waitForFunction(() => Object.keys(sessionStorage).some((key) => key.startsWith("pilotswarm.view-history.v1:")));
    const diagnostics = page.locator('.ps-toolbar.is-mobile button[aria-label^="Diagnostics"]').first();
    await diagnostics.click();
    await expect(diagnostics).toHaveAttribute("aria-label", "Diagnostics — back to the chat");
    await page.locator('.ps-toolbar.is-mobile button[aria-label*="anvas"]').first().click();
    await expect(page.frameLocator(".ps-mobile-canvas-layer iframe.ps-html-preview-frame:not(.is-staging)").locator("h1")).toHaveText("Canvas");
    const frame = page.frames().find((f) => f !== page.mainFrame() && f.url() !== "about:blank");
    return { diagnostics, frame };
}
// What a page inside the canvas can send without any fingers on the screen.
const forgedSwipe = (frame) => frame.evaluate(async () => {
    const post = (m) => parent.postMessage({ type: "canvas-pinch", t: performance.timeOrigin + performance.now(), ...m }, "*");
    post({ phase: "start", x: 60, y: 300, d: 80 });
    for (let i = 1; i <= 12; i++) { await new Promise((r) => setTimeout(r, 16)); post({ phase: "move", x: 60 + i * 20, y: 300, d: 80 }); }
    post({ phase: "end" });
});

test("a hidden canvas cannot move the portal back or forward", async ({ page }) => {
    const { frame } = await openCanvasWithHistory(page);
    const layer = page.locator(".ps-mobile-canvas-layer");
    await page.locator('.ps-toolbar.is-mobile button[aria-label*="anvas"]').first().click();
    await expect(layer).toHaveClass(/is-hidden/);
    const before = await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage).filter(([k]) => k.startsWith("pilotswarm.view-history.v1:"))));
    await forgedSwipe(frame);
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage).filter(([k]) => k.startsWith("pilotswarm.view-history.v1:"))))).toBe(before);
    await expect(layer).toHaveClass(/is-hidden/);
});

test("no two-finger navigation while a dialog is open", async ({ page }) => {
    const { frame } = await openCanvasWithHistory(page);
    const layer = page.locator(".ps-mobile-canvas-layer");
    await page.evaluate(() => { const d = document.createElement("div"); d.className = "ps-modal-backdrop"; d.id = "test-dialog"; document.body.appendChild(d); });
    await forgedSwipe(frame);
    await page.waitForTimeout(600);
    await expect(layer).not.toHaveClass(/is-hidden/);
    await page.evaluate(() => document.getElementById("test-dialog").remove());
    // With the dialog gone, the same swipe on the visible canvas does go back.
    await forgedSwipe(frame);
    await expect(layer).toHaveClass(/is-hidden/);
});
