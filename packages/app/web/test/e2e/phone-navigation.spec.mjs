// The phone keeps its layout sideways, and moves back and forward by a
// two-finger swipe.
//
// WHY THIS EXISTS: a phone held in landscape is wider than the 920 px
// breakpoint, so it used to switch to the desktop layout. And the desktop's
// back and forward history had no way in on a phone; now two fingers to the
// right go back and two to the left go forward, with the screen following
// them. Two fingers everywhere, because one finger belongs to the screen:
// scrolling the chat, and using a canvas page.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const browserName = process.env.PS_TEST_BROWSER || "chromium";
test.use({ browserName, hasTouch: true, isMobile: true });
let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 6, transcriptTurns: 1 }); base = `http://127.0.0.1:${stub.port}`; });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const diagnostics = page => page.locator('.ps-toolbar.is-mobile button[aria-label^="Diagnostics"]').first();
// The view history keys on the signed-in user: give the stub one.
async function signedIn(page) {
    await page.route("**/api/v1/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/bootstrap")) return route.fulfill({ json: { ok: true, result: { auth: { principal: { provider: "none", subject: "test", email: "test@example.com" }, authorization: { allowed: true, role: "user" } } } } });
        return route.fallback();
    });
}
const historyReady = page => page.waitForFunction(() => Object.keys(sessionStorage).some((key) => key.startsWith("pilotswarm.view-history.v1:")));

for (const viewport of [{ width: 844, height: 390 }, { width: 932, height: 430 }]) {
    test(`landscape ${viewport.width}x${viewport.height} keeps the phone layout`, async ({ page }) => {
        await page.setViewportSize(viewport);
        await page.goto(base);
        await expect(page.locator(".ps-toolbar.is-mobile")).toBeVisible();
        await expect(page.locator(".ps-mobile-chat-pane textarea")).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    });
}

test("a tablet-sized landscape window stays desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 820 });
    await page.goto(base);
    await expect(page.locator(".ps-toolbar.is-mobile")).toHaveCount(0);
});

test("two fingers right go back, two left go forward, and the screen follows them", async ({ page, context }) => {
    test.skip(browserName !== "chromium", "real touch events need the Chromium protocol");
    await signedIn(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    await expect(page.locator(".ps-mobile-chat-pane textarea")).toBeVisible();
    await historyReady(page);
    await diagnostics(page).click();
    await expect(diagnostics(page)).toHaveAttribute("aria-label", "Diagnostics — back to the chat");
    await diagnostics(page).click();
    await expect(page.locator(".ps-mobile-workspace")).toHaveCount(1);
    const cdp = await context.newCDPSession(page);
    const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
    async function swipe(from, to, check = null) {
        await touch("touchStart", [[from, 520], [from, 600]]);
        for (let i = 1; i <= 10; i++) {
            const x = from + (to - from) * i / 10;
            await touch("touchMove", [[x, 520], [x, 600]]);
            if (i === 8 && check) await check();
        }
        await touch("touchEnd", []);
        await page.waitForTimeout(500);
    }
    await swipe(120, 330, async () => {
        const moved = await page.locator(".ps-workspace").evaluate(el => el.style.transform);
        expect(moved).toMatch(/translate3d\(\d/);
        await expect(page.locator(".ps-swipe-hint")).toHaveAttribute("data-ready", "true");
    });
    await expect(diagnostics(page)).toHaveAttribute("aria-label", "Diagnostics — back to the chat");
    await swipe(300, 80);
    await expect(page.locator(".ps-mobile-workspace")).toHaveCount(1);
    await expect(diagnostics(page)).toHaveAttribute("aria-label", "Diagnostics");
    // Nothing further forward: the screen gives a little and springs back.
    await swipe(300, 80, async () => {
        await expect(page.locator(".ps-swipe-hint")).toHaveAttribute("data-blocked", "true");
    });
    await expect(page.locator(".ps-mobile-workspace")).toHaveCount(1);
    expect(await page.locator(".ps-workspace").evaluate(el => el.style.transform)).toBe("");
});

test("one finger sideways and two fingers spreading do not navigate", async ({ page, context }) => {
    test.skip(browserName !== "chromium", "real touch events need the Chromium protocol");
    await signedIn(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    await expect(page.locator(".ps-mobile-chat-pane textarea")).toBeVisible();
    await historyReady(page);
    await diagnostics(page).click();
    await expect(diagnostics(page)).toHaveAttribute("aria-label", "Diagnostics — back to the chat");
    const cdp = await context.newCDPSession(page);
    const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
    // One finger, far enough that two fingers would have gone back.
    await touch("touchStart", [[80, 560]]);
    for (let i = 1; i <= 10; i++) await touch("touchMove", [[80 + i * 25, 560]]);
    await touch("touchEnd", []);
    await page.waitForTimeout(500);
    await expect(diagnostics(page)).toHaveAttribute("aria-label", "Diagnostics — back to the chat");
    // Two fingers spreading, drifting right as they do.
    await touch("touchStart", [[180, 560], [220, 560]]);
    for (let i = 1; i <= 10; i++) await touch("touchMove", [[180 - i * 8 + i * 4, 560], [220 + i * 8 + i * 4, 560]]);
    await touch("touchEnd", []);
    await page.waitForTimeout(500);
    await expect(diagnostics(page)).toHaveAttribute("aria-label", "Diagnostics — back to the chat");
    expect(await page.locator(".ps-workspace").evaluate(el => el.style.transform)).toBe("");
});

test("a vertical scroll is not a swipe", async ({ page, context }) => {
    test.skip(browserName !== "chromium", "real touch events need the Chromium protocol");
    await signedIn(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    await diagnostics(page).click();
    await diagnostics(page).click();
    const cdp = await context.newCDPSession(page);
    const touch = (type, points) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
    await historyReady(page);
    const before = await page.evaluate(() => Object.entries(sessionStorage).filter(([k]) => k.startsWith("pilotswarm.view-history.v1:")));
    await touch("touchStart", [[160, 700], [240, 700]]);
    for (let i = 1; i <= 10; i++) await touch("touchMove", [[160 + i * 12, 700 - i * 30], [240 + i * 12, 700 - i * 30]]);
    await touch("touchEnd", []);
    await page.waitForTimeout(400);
    await expect(page.locator(".ps-mobile-workspace")).toHaveCount(1);
    expect(await page.locator(".ps-workspace").evaluate(el => el.style.transform)).toBe("");
    expect(await page.evaluate(() => Object.entries(sessionStorage).filter(([k]) => k.startsWith("pilotswarm.view-history.v1:")))).toEqual(before);
});

const savedHistory = page => page.evaluate(() => {
    const key = Object.keys(sessionStorage).find(k => k.startsWith("pilotswarm.view-history.v1:"));
    return key ? JSON.parse(sessionStorage.getItem(key)) : null;
});
async function pageTouch(page, context) {
    const cdp = await context.newCDPSession(page);
    return (type, x) => cdp.send("Input.dispatchTouchEvent", {
        type, touchPoints: type === "touchEnd" ? [] : [520, 600].map((y, id) => ({ x, y, id })),
    });
}

test("two-finger touches on the page do not navigate under an open dialog", async ({ page, context }) => {
    test.skip(browserName !== "chromium", "real touch events need the Chromium protocol");
    await signedIn(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    await historyReady(page);
    await diagnostics(page).click();
    await expect.poll(async () => (await savedHistory(page)).index).toBeGreaterThan(0);
    const before = (await savedHistory(page)).index;
    await page.evaluate(() => {
        const dialog = document.createElement("div");
        dialog.className = "ps-modal-backdrop";
        dialog.id = "touch-dialog";
        dialog.setAttribute("role", "dialog");
        document.querySelector(".ps-workspace").appendChild(dialog);
    });
    const touch = await pageTouch(page, context);
    await touch("touchStart", 80);
    for (let x = 100; x <= 320; x += 20) await touch("touchMove", x);
    await touch("touchEnd");
    expect((await savedHistory(page)).index).toBe(before);
    expect(await page.locator(".ps-workspace").evaluate(el => el.style.transform)).toBe("");
    await page.evaluate(() => document.getElementById("touch-dialog").remove());
    await touch("touchStart", 80);
    for (let x = 100; x <= 320; x += 20) await touch("touchMove", x);
    await touch("touchEnd");
    await expect.poll(async () => (await savedHistory(page)).index).toBe(before - 1);
});

test("a second swipe within slide-out flushes the first exactly once", async ({ page, context }) => {
    test.skip(browserName !== "chromium", "real touch events need the Chromium protocol");
    await signedIn(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    await historyReady(page);
    await diagnostics(page).click();
    await diagnostics(page).click();
    await expect.poll(async () => (await savedHistory(page)).index).toBeGreaterThanOrEqual(2);
    const before = (await savedHistory(page)).index;
    await page.clock.install({ time: new Date("2030-01-01T00:00:00Z") });
    await page.clock.pauseAt(new Date("2030-01-01T00:00:01Z"));
    await page.evaluate(() => {
        window.touchTrace = [];
        for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
            window.addEventListener(type, event => window.touchTrace.push({ type, target: event.target.className, connected: event.target.isConnected }), true);
        }
    });
    const touch = await pageTouch(page, context);
    await touch("touchStart", 80);
    for (let x = 100; x <= 320; x += 20) await touch("touchMove", x);
    await touch("touchEnd");
    expect((await savedHistory(page)).index).toBe(before);
    // Freeze only the CSS slide, so the next physical touch still hits the
    // outgoing page while the real 150 ms navigation timer remains pending.
    await page.locator(".ps-workspace").evaluate(el => {
        for (const animation of el.getAnimations()) { animation.pause(); animation.currentTime = 0; }
    });
    await page.clock.runFor(60);
    await touch("touchStart", 270);
    expect((await savedHistory(page)).index).toBe(before - 1);
    for (let x = 290; x <= 385; x += 19) await touch("touchMove", x);
    await touch("touchEnd");
    await page.clock.runFor(160);
    expect((await savedHistory(page)).index, JSON.stringify(await page.evaluate(() => window.touchTrace))).toBe(before - 2);
    await page.clock.runFor(600);
    expect((await savedHistory(page)).index).toBe(before - 2);
});

test("two-finger back on a full-screen Markdown artifact moves only the preview", async ({ page, context }) => {
    test.skip(browserName !== "chromium", "real touch events need the Chromium protocol");
    await signedIn(page);
    await page.route(url => url.pathname.endsWith("/artifacts"), route => route.fulfill({ json: { ok: true, result: [{ filename: "notes.md", contentType: "text/markdown", sizeBytes: 80, isBinary: false }] } }));
    await page.route(url => url.pathname.endsWith("/artifacts/notes.md/text"), route => route.fulfill({ json: { ok: true, result: "# Notes\n\nA full-screen Markdown artifact." } }));
    await page.route(url => url.pathname.endsWith("/artifacts/notes.md/meta"), route => route.fulfill({ json: { ok: true, result: { filename: "notes.md", contentType: "text/markdown", sizeBytes: 80, isBinary: false } } }));
    const id = "11111110-2222-3333-4444-555555555550";
    const view = { mode: "workspace", sessionId: id, canvasOpen: false, canvasSlot: 1, canvasMaximized: false, canvasZen: false, diagnosticsOpen: false, artifactSessionId: null, artifactFilename: null, artifactFullscreen: false, mobilePane: "workspace" };
    await page.addInitScript(([view, id]) => {
        sessionStorage.setItem('pilotswarm.view-history.v1:["none","test"]', JSON.stringify({ version: 1, index: 1, entries: [
            view, { ...view, artifactSessionId: id, artifactFilename: "notes.md", artifactFullscreen: true },
        ] }));
    }, [view, id]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + `/?session=${id}&artifact=notes.md&view=full`);
    const overlay = page.locator(".ps-artifact-overlay");
    await expect(overlay).toContainText("A full-screen Markdown artifact.");
    const before = (await savedHistory(page)).index;
    const touch = await pageTouch(page, context);
    await touch("touchStart", 80);
    for (let x = 100; x <= 320; x += 20) await touch("touchMove", x);
    await expect.poll(() => overlay.evaluate(el => el.style.transform)).toContain("translate3d(");
    expect(await page.locator(".ps-workspace").evaluate(el => el.style.transform)).toBe("");
    await touch("touchEnd");
    await expect(overlay).toHaveCount(0);
    expect((await savedHistory(page)).index).toBe(before - 1);
});
