import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

for (const width of [390, 800, 1440]) {
    test(`steering composer ${width}px: touch targets and input remain usable`, async ({ browser }) => {
        const context = await browser.newContext({
            viewport: { width, height: 844 }, isMobile: width < 921, hasTouch: width < 921,
        });
        try {
            const page = await context.newPage();
            await page.route(`**/sessions/${sessionId}/steering-state`, route => route.fulfill({ json: {
                ok: true, result: {
                    sessionId, supported: true, canWrite: true, steerable: true,
                    expectedTarget: "fixture-observed-target", reason: null, windowSeq: 0,
                    limits: { maxBytes: 8192, maxUnresolved: 16, ratePerMinute: 30 },
                },
            } }));
            await page.route(`**/sessions/${sessionId}/steering?*`, route => route.fulfill({
                json: { ok: true, result: { items: [], nextCursor: null } },
            }));
            await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
            const input = page.getByTestId("session-prompt");
            await input.fill("Keep the public API unchanged.");
            const steer = page.getByRole("button", { name: "Steer current turn", exact: true });
            await expect(steer).toBeEnabled();
            const stop = page.getByRole("button", { name: "Stop the current turn", exact: true });
            const send = page.getByTestId("send-prompt");
            const attach = page.getByRole("button", { name: "Attach images", exact: true });
            for (const button of [attach, stop, steer, send]) {
                await expect(button).toBeVisible();
                const box = await button.boundingBox();
                expect(box.width).toBeGreaterThanOrEqual(44);
                expect(box.height).toBeGreaterThanOrEqual(44);
            }
            const geometry = await input.evaluate(node => {
                const shell = node.closest(".ps-prompt-shell");
                const bounds = element => {
                    const r = element.getBoundingClientRect();
                    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
                };
                return {
                    input: bounds(node), shell: bounds(shell),
                    actions: bounds(shell.querySelector(".ps-prompt-actions")),
                    buttons: [...shell.querySelectorAll(".ps-prompt-actions > button")].map(bounds),
                };
            });
            for (let index = 1; index < geometry.buttons.length; index++) {
                expect(geometry.buttons[index].x).toBeGreaterThanOrEqual(geometry.buttons[index - 1].right);
            }
            for (const box of geometry.buttons) expect(box.right).toBeLessThanOrEqual(width);
            if (width === 390) {
                expect(geometry.actions.y).toBeGreaterThanOrEqual(geometry.input.bottom);
                expect(geometry.input.width).toBeGreaterThanOrEqual(geometry.shell.width - 1);
                expect(geometry.input.width).toBeGreaterThan(300);
                expect(geometry.input.height).toBeLessThan(80);
            } else {
                expect(geometry.actions.x).toBeGreaterThanOrEqual(geometry.input.right);
            }
        } finally {
            await context.close();
        }
    });
}
