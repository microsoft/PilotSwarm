// The session list on a phone.
//
// WHY THIS EXISTS: drag-to-folder is armed on pointerdown and needs
// `touch-action: none` to receive a move stream. On a touch screen that same
// declaration means the list can no longer be SCROLLED with a finger — every
// touch on a row is claimed as a potential drag — which made the list
// unusable on a phone. Nothing on a desktop viewport can catch that, so these
// run under a real mobile emulation.
import { test, expect, devices, chromium } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

test.use({ ...devices["iPhone 14 Pro"] });

let stub;
let base;

test.beforeAll(async () => {
    stub = await startStubServer(0, { sessionCount: 90, transcriptTurns: 8 });
    base = `http://127.0.0.1:${stub.port}`;
});

test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

// The list is a slide-over on a phone: open it from the leftmost button.
async function openList(page) {
    await page.goto(base);
    await page.getByRole("button", { name: "Sessions", exact: true }).click();
    await expect(page.locator(".ps-mobile-session-slideover.is-open")).toBeVisible();
    // Let the slide finish: a touch aimed mid-slide lands on the dimmed chat.
    await expect.poll(async () => (await page.locator(".ps-mobile-session-slideover").boundingBox()).x).toBeGreaterThanOrEqual(0);
}

test("rows never claim the finger that scrolls the list", async ({ page }) => {
    await openList(page);
    const row = page.locator(".ps-session-list-button").first();
    await row.waitFor();
    // touch-action:none on a row is exactly the regression: it disables
    // native panning over that element.
    const touchAction = await row.evaluate((node) => getComputedStyle(node).touchAction);
    expect(touchAction, "a row must not swallow touch panning").not.toBe("none");
});

test("a tap still selects", async ({ page }) => {
    await openList(page);
    const rows = page.locator(".ps-session-list-button");
    await rows.first().waitFor();
    await rows.nth(2).tap();
    await expect(page.locator(".ps-session-list-button.is-selected")).toHaveCount(1);
});

// The list scrolls natively on a phone: nothing of ours sits between the
// finger and the browser, so the system's own momentum and refresh rate apply.
// Up/down is the list; sideways is a track nested inside it, one axis each.
test("the list scrolls natively on both axes: no script holds the finger", async ({ page }) => {
    await openList(page);
    const list = page.locator(".ps-mobile-session-slideover .ps-session-list").first();
    await expect.poll(() => list.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(600);
    const shape = await list.evaluate((el) => {
        const track = el.querySelector(".ps-session-list-track");
        const fire = (target, type, y) => {
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(event, "targetTouches", { value: y == null ? [] : [{ clientX: 100, clientY: y }] });
            target.dispatchEvent(event);
            return event.defaultPrevented;
        };
        const row = track.querySelector(".ps-session-list-button");
        fire(row, "touchstart", 500);
        const prevented = [fire(row, "touchmove", 490), fire(row, "touchmove", 420), fire(row, "touchmove", 300)].some(Boolean);
        fire(row, "touchend", null);
        const ls = getComputedStyle(el), ts = getComputedStyle(track);
        return { prevented, listX: ls.overflowX, listY: ls.overflowY, trackX: ts.overflowX, trackY: ts.overflowY,
            listWide: el.scrollWidth - el.clientWidth, trackWide: track.scrollWidth - track.clientWidth,
            rowWidths: [...track.querySelectorAll(".ps-session-list-button")].map(b => Math.round(b.getBoundingClientRect().width)) };
    });
    expect(shape.prevented, "a touchmove was cancelled: the list is script-scrolled").toBe(false);
    expect([shape.listX, shape.listY]).toEqual(["hidden", "auto"]);
    expect([shape.trackX, shape.trackY]).toEqual(["auto", "hidden"]);
    expect(shape.listWide, "only the track may be wider than the list").toBeLessThanOrEqual(1);
    expect(shape.trackWide, "long rows have somewhere to pan to").toBeGreaterThan(20);
    expect(new Set(shape.rowWidths).size, "rows share the widest row's width").toBe(1);
    // Long titles are whole, not ellipsized: panning is how they are read.
    const clipped = await list.locator(".ps-session-list-button[data-session-id] .ps-line").evaluateAll((lines) => lines.filter((line) => line.scrollWidth > line.clientWidth + 1).length);
    expect(clipped).toBe(0);
});

test("Chromium: a sideways finger drag pans the rows and leaves the list where it was", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ ...devices["Pixel 7"] });
        await openList(page);
        const list = page.locator(".ps-mobile-session-slideover .ps-session-list").first();
        const track = list.locator(".ps-session-list-track");
        await expect.poll(() => track.evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(20);
        const selected = await page.locator(".ps-session-list-button.is-selected").textContent();
        const box = await list.boundingBox();
        const x = Math.round(box.x + box.width - 30), y = Math.round(box.y + box.height / 2);
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        for (const d of [8, 30, 60, 100, 140, 180]) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - d, y: y - Math.round(d / 12) }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect.poll(() => track.evaluate(el => el.scrollLeft)).toBeGreaterThan(20);
        expect(await list.evaluate(el => el.scrollTop), "a sideways swipe must not scroll the list").toBeLessThanOrEqual(2);
        await page.waitForTimeout(800);
        expect(await page.locator(".ps-session-list-button.is-selected").textContent()).toBe(selected);
        await cdp.detach();
    } finally {
        await browser.close();
    }
});

test("Chromium: a real finger drag scrolls the list and selects nothing", async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ ...devices["Pixel 7"] });
        await openList(page);
        const list = page.locator(".ps-mobile-session-slideover .ps-session-list").first();
        await expect.poll(() => list.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(600);
        const selected = await page.locator(".ps-session-list-button.is-selected").textContent();
        const box = await list.boundingBox();
        const x = Math.round(box.x + box.width / 2), y = Math.round(box.y + box.height - 20);
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        for (const d of [8, 30, 70, 120, 170, 220]) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - d }] });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect.poll(() => list.evaluate(el => el.scrollTop)).toBeGreaterThan(100);
        await page.waitForTimeout(800);
        expect(await page.locator(".ps-session-list-button.is-selected").textContent()).toBe(selected);
        await cdp.detach();
    } finally {
        await browser.close();
    }
});

test("the page never scrolls sideways, in or out of focus mode", async ({ page }) => {
    await openList(page);
    await page.locator(".ps-session-list-button").first().waitFor();
    const overflow = () => page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth - doc.clientWidth;
    });
    expect(await overflow(), "before focus").toBeLessThanOrEqual(0);

    const focus = page.locator('button[aria-label="Focus the chat pane"]');
    if (await focus.count() > 0) {
        await focus.tap();
        await page.waitForTimeout(300);
        expect(await overflow(), "in focus mode").toBeLessThanOrEqual(0);
        // The pane the focus rail opens is the other half of the report.
        const sessions = page.locator(".ps-chat-focus-rail button", { hasText: "Sessions" });
        if (await sessions.count() > 0) {
            await sessions.tap();
            await page.waitForTimeout(300);
            expect(await overflow(), "focus + sessions overlay").toBeLessThanOrEqual(0);
        }
    }
});

// Mobile Safari zooms the WHOLE page when a focused control's font-size is
// under 16px, and the dense terminal scale is 11.5px. The prompt had opted out
// with its own 1.25rem, so the composer looked fine while the session-filter
// search and the copy-link field silently zoomed the layout and scrolled it
// sideways. Only a real mobile viewport can catch this.
//
// Probing the CLASSES rather than tapping each surface open: most of these
// fields live behind a modal the stub cannot always reach, and the contract
// under test is the stylesheet's, not any one dialog's.
test("no field is small enough to make iOS zoom the page", async ({ page }) => {
    await openList(page);
    await page.locator(".ps-session-list-button").first().waitFor();

    const small = await page.evaluate(() => {
        const PROBES = [
            ["input", "ps-modal-input"],
            ["input", "ps-modal-input ps-modal-search"],
            ["input", "ps-link-input"],
            ["input", "ps-share-add-input"],
            ["select", "ps-share-add-select"],
            ["textarea", "ps-prompt-input"],
            ["input", ""],
        ];
        const out = [];
        for (const [tag, className] of PROBES) {
            const el = document.createElement(tag);
            el.className = className;
            document.body.appendChild(el);
            const px = parseFloat(getComputedStyle(el).fontSize);
            el.remove();
            if (px < 16) out.push(`${className || tag}=${px}px`);
        }
        // Plus every field actually on screen right now.
        for (const node of document.querySelectorAll("input, textarea, select")) {
            if (node.type === "file" || node.offsetParent === null) continue;
            const px = parseFloat(getComputedStyle(node).fontSize);
            if (px < 16) out.push(`${node.className || node.tagName}=${px}px`);
        }
        return out;
    });

    expect(small, `these fields would zoom the page on focus: ${small.join(", ")}`).toEqual([]);
});
