// Cold open of a session canvas (issue 181) on a phone: the same one-frame
// rule as the desktop spec (canvas-cold-open.spec.mjs), on the phone layout.
// The draw-event reads are held until the test has seen the canvas waiting
// with nothing downloaded; then the trust is released.
import { test, expect, devices } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { appPage, expectShown, LIST_CANVASES, openCanvasCold, routeCanvas, sid } from "./canvas-cold-open-fixtures.mjs";

test.use({ ...devices["iPhone 14 Pro"] });

let stub, base;
test.beforeAll(async () => {
    stub = await startStubServer(0, { sessionCount: 1, canvases: LIST_CANVASES });
    base = `http://127.0.0.1:${stub.port}`;
});
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const S = sid(0);

for (const trust of ["owner", "cross-owner"]) {
    test(`phone, ${trust === "owner" ? "owner page" : "another user's app"}, cold deep link: held, then one download, one start`, async ({ page }) => {
        const marker = `phone-${trust}`;
        const c = await routeCanvas(page, S, { slots: { 1: { html: appPage(marker), trust }, 2: { html: appPage("unused-2"), trust: "owner" } }, snapshot: { hold: true } });
        await openCanvasCold(page, base, S);
        await expect(page.locator('[data-canvas-hold="trust"]'), "the canvas waits for the trust").toBeVisible();
        expect(c.downloads("canvas.html")).toBe(0);
        c.release();
        await expectShown(page, marker, { wrapped: trust === "cross-owner" });
        await expect.poll(() => c.boots(marker)).toBe(1);
        await page.waitForTimeout(800);
        expect(c.downloads("canvas.html"), "one download").toBe(1);
        expect(await c.boots(marker), "the page started once").toBe(1);
        expect(c.srcdocs()).toBe(trust === "cross-owner" ? 1 : 0);
    });
}
