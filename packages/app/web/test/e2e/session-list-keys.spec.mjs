// Arrow keys keep the selected session on screen.
//
// WHY THIS EXISTS: the active-row reveal focuses the row with preventScroll,
// because selection from elsewhere (a refresh, a deep link) must never move
// the list. A keyboard move through the list went through the same path, so
// the selection walked off the top or bottom of the list and out of sight.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 60 }); base = `http://127.0.0.1:${stub.port}`; });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

// Where the selected row sits against the visible part of the list.
const placement = page => page.evaluate(() => {
    const row = document.querySelector(".ps-session-list .ps-session-list-button.is-selected");
    if (!row) return null;
    let scroller = row.parentElement;
    while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight + 1)) scroller = scroller.parentElement;
    const r = row.getBoundingClientRect(), s = scroller.getBoundingClientRect();
    return { visible: r.top >= s.top - 1 && r.bottom <= s.top + scroller.clientHeight + 1, scrollTop: scroller.scrollTop };
});

// Desktop widths: on a phone the list is a slide-over that a pick closes.
for (const width of [1440, 1024]) test(`${width}px: arrow and page keys keep the selection visible both ways`, async ({ page }) => {
    await page.setViewportSize(width > 600 ? { width, height: 700 } : { width, height: 844 });
    await page.goto(base);
    const rows = page.locator(".ps-session-list .ps-session-list-button[data-session-id]");
    await rows.first().waitFor();
    await rows.first().click();
    const start = await placement(page);
    expect(start.visible).toBe(true);

    for (let i = 0; i < 40; i++) {
        await page.keyboard.press("ArrowDown");
        await expect.poll(async () => (await placement(page)).visible, `after ArrowDown ${i + 1}`).toBe(true);
    }
    expect((await placement(page)).scrollTop).toBeGreaterThan(start.scrollTop);

    await page.keyboard.press("PageDown");
    await expect.poll(async () => (await placement(page)).visible, "after PageDown").toBe(true);

    for (let i = 0; i < 50; i++) {
        await page.keyboard.press("ArrowUp");
        await expect.poll(async () => (await placement(page)).visible, `after ArrowUp ${i + 1}`).toBe(true);
    }
});

test("a selected row that is already visible does not move the list", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.goto(base);
    const rows = page.locator(".ps-session-list .ps-session-list-button[data-session-id]");
    await rows.first().waitFor();
    await rows.nth(2).click();
    const before = await placement(page);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(200);
    const after = await placement(page);
    expect(after.visible).toBe(true);
    expect(after.scrollTop).toBe(before.scrollTop);
});
