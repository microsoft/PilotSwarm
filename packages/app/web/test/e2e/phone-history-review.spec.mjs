// Phone Back and Forward across sessions and into an artifact preview.
//
// WHY THIS EXISTS: review found that Back from session B into session A's
// canvas landed on A's chat (the reset that runs on a session change undid
// the restored pane), and that the phone's full-screen artifact preview was
// not a stop in the history at all.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const browserName = process.env.PS_TEST_BROWSER || "chromium";
test.use({ browserName, hasTouch: true, isMobile: true });
let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 3 }); base = `http://127.0.0.1:${stub.port}`; });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const A = "11111110-2222-3333-4444-555555555550";
const PAGE = `<!doctype html><html><body style="margin:0;background:#123"><h1 style="color:#fff">Canvas A</h1></body></html>`;

async function setup(page) {
    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/bootstrap")) return route.fulfill({ json: { ok: true, result: { auth: { principal: { provider: "none", subject: "test", email: "test@example.com" }, authorization: { allowed: true, role: "user" } } } } });
        if (url.pathname.includes(A) && url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_updated")) {
            return route.fulfill({ json: { ok: true, result: [{ seq: 1, eventType: "session.canvas_updated", data: { slot: 1, rev: 1, sizeBytes: PAGE.length, name: "a" } }] } });
        }
        if (url.pathname.includes(A) && url.pathname.includes("/artifacts/") && url.pathname.includes("canvas.html")) return route.fulfill({ contentType: "text/html", body: PAGE });
        return route.fallback();
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/?session=${A}`);
    await page.waitForFunction(() => Object.keys(sessionStorage).some((key) => key.startsWith("pilotswarm.view-history.v1:")));
}

async function twoFingerSwipe(page, context, from, to) {
    const cdp = await context.newCDPSession(page);
    const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
    await touch("touchStart", [[from, 520], [from, 600]]);
    for (let i = 1; i <= 10; i++) { const x = from + (to - from) * i / 10; await touch("touchMove", [[x, 520], [x, 600]]); }
    await touch("touchEnd", []);
    await page.waitForTimeout(600);
}

test("Back from another session lands on the first session's canvas", async ({ page, context }) => {
    test.skip(browserName !== "chromium", "real touch events need the Chromium protocol");
    await setup(page);
    await page.locator('.ps-toolbar.is-mobile button[aria-label*="anvas"]').first().click();
    const layer = page.locator(".ps-mobile-canvas-layer");
    await expect(page.frameLocator(".ps-mobile-canvas-layer iframe.ps-html-preview-frame:not(.is-staging)").locator("h1")).toHaveText("Canvas A");
    // Leave for session B from the session list.
    await page.getByRole("button", { name: "Sessions", exact: true }).click();
    await page.locator('.ps-mobile-session-slideover .ps-session-list-button[data-session-id="11111111-2222-3333-4444-555555555551"]').click();
    await page.waitForTimeout(800);
    await expect(layer).toHaveCount(0);
    // Two fingers right: back to A, on its canvas.
    await twoFingerSwipe(page, context, 80, 320);
    await expect(page.frameLocator(".ps-mobile-canvas-layer iframe.ps-html-preview-frame:not(.is-staging)").locator("h1")).toHaveText("Canvas A");
    await expect(page.locator(".ps-mobile-canvas-layer")).not.toHaveClass(/is-hidden/);
});
