// The phone toolbar keeps every button in view at every phone width, in the
// themes with the widest button chrome. It used to scroll its actions group
// sideways, so the last action (Budget) sat half-hidden under the view-mode
// group and only a swipe nobody would guess reached it.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 2 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

for (const themeId of ["workspace-dark", "ms-dos", "win95"]) {
    for (const width of [340, 360, 375, 390, 420]) {
        test(`${themeId} ${width}px: every toolbar button can be pressed`, async ({ browser }) => {
            const context = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });
            const page = await context.newPage();
            try {
                await page.route("**/api/v1/me/profile", (route) => route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: { themeId } } } }));
                await page.goto(`http://127.0.0.1:${stub.port}/?session=11111110-2222-3333-4444-555555555550`);
                await expect(page.locator("html")).toHaveAttribute("data-ps-theme", themeId);
                const covered = () => page.evaluate(() => [...document.querySelectorAll(".ps-toolbar button")]
                    .filter((button) => button.getBoundingClientRect().width > 0)
                    .filter((button) => {
                        const box = button.getBoundingClientRect();
                        return !button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
                            || box.right > window.innerWidth;
                    })
                    .map((button) => button.getAttribute("aria-label") || button.title));
                await expect(page.getByRole("button", { name: /^Budget/ })).toBeVisible();
                expect(await covered()).toEqual([]);
                await page.getByRole("button", { name: "Show canvas" }).click();
                expect(await covered(), "with the side pane open too").toEqual([]);
            } finally {
                await context.close();
            }
        });
    }
}
