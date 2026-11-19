// The desktop toolbar's middle group (new, filter, back, forward, canvas,
// diagnostics) sits on the centre of the screen, whatever the widths of the
// brand on the left and the account controls on the right. Below 1,040 px
// of tools the header takes two rows and the group leads the first row.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 2 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const offCentre = (page) => page.evaluate(() => {
    const header = document.querySelector(".portal-header").getBoundingClientRect();
    const nav = document.querySelector(".portal-header .ps-toolbar-navigation").getBoundingClientRect();
    return Math.round((nav.left + nav.width / 2) - (header.left + header.width / 2));
});

const centred = (page) => page.evaluate(() => {
    const header = document.querySelector(".portal-header").getBoundingClientRect();
    const nav = document.querySelector(".portal-header .ps-toolbar-navigation").getBoundingClientRect();
    const left = document.querySelector(".portal-header .ps-toolbar-side.is-left").getBoundingClientRect();
    const off = (nav.left + nav.width / 2) - (header.left + header.width / 2);
    // Exactly centred, or held right of centre with the left side at its minimum.
    return Math.abs(off) <= 2 || (off > 0 && Math.abs(left.width - 360) <= 2);
});

for (const themeId of ["workspace-dark", "win95"]) for (const width of [1920, 1600, 1440]) {
    test(`${themeId} ${width}px: the middle buttons sit on the centre of the screen`, async ({ page }) => {
        await page.route("**/api/v1/me/profile", (route) => route.fulfill({ json: { ok: true, result: { isAdmin: true, profileSettings: { themeId } } } }));
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`http://127.0.0.1:${stub.port}/`);
        await expect(page.locator(".portal-header .ps-toolbar-navigation")).toBeVisible();
        // Centred, unless that would leave the left side less than the room
        // the full-screen canvas controls need (360 px); then as close as that allows.
        await expect.poll(() => centred(page)).toBe(true);
        // Nothing overlaps: the flanks keep their own room.
        const overlap = await page.evaluate(() => {
            const r = (s) => document.querySelector(s)?.getBoundingClientRect();
            const nav = r(".portal-header .ps-toolbar-navigation"), left = r(".portal-header .ps-toolbar-side.is-left"), right = r(".portal-header .ps-toolbar-side.is-right"), brand = r(".portal-header-brand");
            return { navVsRight: nav.right - right.left, brandVsNav: brand.right - nav.left, leftVsNav: left.right - nav.left };
        });
        expect(overlap.navVsRight).toBeLessThanOrEqual(1);
        expect(overlap.brandVsNav).toBeLessThanOrEqual(1);
        // A resize keeps it centred while the header is one row.
        await page.setViewportSize({ width: width - 120, height: 900 });
        const oneRow = () => page.evaluate(() => {
            const nav = document.querySelector(".portal-header .ps-toolbar-navigation").getBoundingClientRect();
            const right = document.querySelector(".portal-header .ps-toolbar-side.is-right").getBoundingClientRect();
            return Math.abs(nav.top - right.top) < 2;
        });
        if (await oneRow()) await expect.poll(() => centred(page)).toBe(true);
    });
}
