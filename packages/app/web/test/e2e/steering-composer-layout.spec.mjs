import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { listThemes } from "../../../ui/core/src/themes/index.js";

const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

for (const width of [320, 390, 800, 1440]) for (const { id: themeId } of listThemes()) {
    test(`steering composer ${width}px ${themeId}: touch targets and input remain usable`, async ({ browser }) => {
        const context = await browser.newContext({
            viewport: { width, height: 844 }, isMobile: width < 921, hasTouch: width < 921,
        });
        try {
            const page = await context.newPage();
            await page.route("**/api/v1/me/profile", route => route.fulfill({ json: {
                ok: true, result: { isAdmin: false, profileSettings: { themeId } },
            } }));
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
            await expect(page.locator("html")).toHaveAttribute("data-ps-theme", themeId);
            const input = page.getByTestId("session-prompt");
            await input.fill("Keep the public API unchanged.");
            const steer = page.getByRole("button", { name: "Steer current turn", exact: true });
            await expect(steer).toBeEnabled();
            const stop = page.getByRole("button", { name: "Stop the current turn", exact: true });
            const send = page.getByTestId("send-prompt");
            const attach = page.getByRole("button", { name: "Attach images", exact: true });
            const narrow = await input.evaluate(node => {
                const composer = node.closest(".ps-chat-composer");
                const style = getComputedStyle(composer);
                return composer.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
                    - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth) < 360;
            });
            if (narrow) await expect(attach).toBeHidden();
            for (const button of narrow ? [stop, steer, send] : [attach, stop, steer, send]) {
                await expect(button).toBeVisible();
                const box = await button.boundingBox();
                expect(box.width).toBeGreaterThanOrEqual(44);
                expect(box.height).toBeGreaterThanOrEqual(44);
            }
            const chrome = await steer.evaluate(node => {
                const style = getComputedStyle(node);
                const peer = getComputedStyle(node.parentElement.querySelector(".ps-attach-button"));
                return { border: style.borderTopWidth, radius: style.borderRadius, peerRadius: peer.borderRadius,
                    font: style.fontSize, peerFont: peer.fontSize, labelFont: getComputedStyle(node.querySelector(".ps-steer-label")).fontSize,
                    color: style.color, shadow: style.boxShadow };
            });
            expect(parseFloat(chrome.border)).toBeGreaterThan(0);
            expect(chrome.radius).toBe(chrome.peerRadius);
            expect(chrome.font).toBe(chrome.peerFont);
            expect(chrome.labelFont).toBe(chrome.font);
            expect(chrome.shadow).not.toBe("none");
            if (width === 1440) {
                await expect(steer.locator(".ps-steer-label")).toBeVisible();
                await expect(steer.locator(".ps-steer-glyph")).toBeVisible();
                await input.fill("");
                await expect(steer).toBeDisabled();
                expect(await steer.evaluate(node => Number(getComputedStyle(node).opacity))).toBeLessThan(1);
                await input.fill("Keep the public API unchanged.");
            }
            const geometry = await input.evaluate(node => {
                const shell = node.closest(".ps-prompt-shell");
                const bounds = element => {
                    const r = element.getBoundingClientRect();
                    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
                };
                return {
                    input: bounds(node), shell: bounds(shell),
                    label: bounds(shell.querySelector(".ps-prompt-label")),
                    actions: bounds(shell.querySelector(".ps-prompt-actions")),
                    buttons: [...shell.querySelectorAll(".ps-prompt-actions > button")].filter(button => button.getBoundingClientRect().width > 0).map(bounds),
                };
            });
            for (let index = 1; index < geometry.buttons.length; index++) {
                expect(geometry.buttons[index].x).toBeGreaterThanOrEqual(geometry.buttons[index - 1].right);
            }
            for (const box of geometry.buttons) expect(box.right).toBeLessThanOrEqual(width);
            expect(geometry.actions.x).toBeGreaterThanOrEqual(geometry.input.right);
            if (width <= 390) {
                expect(geometry.input.width).toBeGreaterThanOrEqual(width === 320 ? 112 : 130);
                expect(Math.abs(geometry.label.y + geometry.label.height / 2 - geometry.input.y - geometry.input.height / 2)).toBeLessThan(2);
                expect(await steer.locator(".ps-steer-glyph").isVisible()).toBe(true);
                await steer.dispatchEvent("pointerdown", { pointerType: "touch", clientX: 200, clientY: 700 });
                await expect(page.getByRole("tooltip")).toContainText("Steer current turn");
                await steer.dispatchEvent("pointerup", { pointerType: "touch" });
            }
            if (width === 390) {
                expect(geometry.input.height).toBeLessThan(80);
            }
        } finally {
            await context.close();
        }
    });
}
