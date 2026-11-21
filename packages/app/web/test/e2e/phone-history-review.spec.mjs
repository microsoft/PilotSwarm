// Phone Back and Forward across sessions and into an artifact preview.
//
// WHY THIS EXISTS: review found that Back from session B into session A's
// canvas landed on A's chat: the reset that runs on a session change undid
// the restored pane.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const browserName = process.env.PS_TEST_BROWSER || "chromium";
test.use({ browserName, hasTouch: true, isMobile: true });
let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 3 }); base = `http://127.0.0.1:${stub.port}`; });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const A = "11111110-2222-3333-4444-555555555550";
const PAGE = `<!doctype html><html><body style="margin:0;background:#123"><h1 style="color:#fff">Canvas A</h1></body></html>`;

async function setup(page, sessionId = A) {
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
    await page.goto(`${base}/?session=${sessionId}`);
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

// On a phone the session list closes the canvas first, so A's canvas and B
// are normally separated by A's chat. The jump straight from B to A's canvas
// happens with history recorded elsewhere (a desktop window narrowed to a
// phone, a deep link): seed exactly that history and go Back once.
const B = "11111111-2222-3333-4444-555555555551";
test("Back from another session lands on the first session's canvas", async ({ page, context }) => {
    test.skip(browserName !== "chromium", "real touch events need the Chromium protocol");
    const view = (sessionId, extra) => ({ mode: "workspace", sessionId, canvasOpen: false, canvasSlot: 1, canvasMaximized: false, canvasZen: false, diagnosticsOpen: false, artifactSessionId: null, artifactFilename: null, artifactFullscreen: false, mobilePane: "workspace", ...extra });
    await page.addInitScript(([a, b, entries]) => {
        if (sessionStorage.getItem("seeded")) return;
        sessionStorage.setItem("seeded", "1");
        sessionStorage.setItem('pilotswarm.view-history.v1:["none","test"]', JSON.stringify({ version: 1, index: 1, entries }));
    }, [A, B, [view(A, { canvasOpen: true, mobilePane: "canvas" }), view(B)]]);
    await setup(page, B);
    const layer = page.locator(".ps-mobile-canvas-layer");
    await expect(layer).toHaveCount(0);
    await twoFingerSwipe(page, context, 80, 320);
    await expect(page.frameLocator(".ps-mobile-canvas-layer iframe.ps-html-preview-frame:not(.is-staging)").locator("h1")).toHaveText("Canvas A");
    await expect(layer).not.toHaveClass(/is-hidden/);
});
