import { test, expect } from "@playwright/test";
import { fixture, message } from "./motd-fixture.mjs";

const zones = [
    { id: "America/Los_Angeles",
        live: "Sun, Nov 1, 7:00 AM until Mon, Nov 2, 12:00 PM (Pacific Time)",
        previous: "Sat, Oct 31, 9:00 AM until replaced (Pacific Time)" },
    { id: "Asia/Kolkata",
        live: "Sun, Nov 1, 8:30 PM until Tue, Nov 3, 1:30 AM (India Standard Time)",
        previous: "Sat, Oct 31, 9:30 PM until replaced (India Standard Time)" },
];
for (const zone of zones) test.describe(`MoTD viewer timezone ${zone.id}`, () => {
    test.use({ timezoneId: zone.id, hasTouch: true });
    for (const admin of [true, false]) test(`${admin ? "admin" : "reader"} sees local timestamps in every MoTD surface`, async ({ page }) => {
        await page.clock.setFixedTime(new Date("2026-11-01T22:16:00Z"));
        const live = message({ fromAt: "2026-11-01T15:00:00Z", toAt: "2026-11-02T20:00:00Z", bodyMd: "Current local notice" });
        const previous = message({ motdId: "9", fromAt: "2026-10-31T16:00:00Z", toAt: null,
            status: "hidden", bodyMd: "Previous local notice" });
        const f = await fixture(page, { admin, current: live, history: [live, previous] });
        const preview = page.getByRole("dialog", { name: "Message of the day preview", exact: true });
        try {
            const current = page.getByRole("dialog", { name: "Message of the day", exact: true });
            await expect(current.locator(".ps-motd-window")).toHaveText(zone.live);
            await current.getByRole("button", { name: "Got it", exact: true }).click();
            await page.getByRole("button", { name: admin ? "Admin console" : "Settings", exact: true }).click();
            await page.getByRole("button", { name: "Message of the day", exact: true }).click();
            const panel = page.getByRole("region", { name: "Message of the day settings", exact: true });
            await expect(panel.locator(".ps-motd-admin-grid .ps-motd-admin-card").first()).toContainText(zone.live);
            await expect(panel.locator(".ps-motd-history-entry").first()).toContainText(zone.live);
            await expect(panel.locator(".ps-motd-history-entry").last()).toContainText(zone.previous);
            await expect(panel).not.toContainText(" UTC");
            await panel.getByRole("button", { name: "Show splash again", exact: true }).first().click();
            await expect(preview.locator(".ps-motd-window")).toHaveText(zone.live);
            await page.setViewportSize({ width: 390, height: 800 });
            await expect(preview.locator(".ps-motd-window")).toHaveText(zone.live);
            await preview.getByRole("button", { name: "Close preview", exact: true }).click();
            await expect(page.locator(".ps-admin-console.is-mobile [data-level='0']")).toBeVisible();
            await page.getByRole("button", { name: "Message of the day", exact: true }).click();
            await expect(panel).toBeVisible();
            await expect(panel.locator(".ps-motd-admin-card").first()).toContainText(zone.live);
            await expect(panel.locator(".ps-motd-editor")).toHaveCount(0);
            await expect(panel.getByRole("button", { name: /Duplicate|Phone view/ })).toHaveCount(0);
            await expect(panel.getByRole("button", { name: "Delete message 9", exact: true })).toHaveCount(admin ? 1 : 0);
            const row = panel.locator(".ps-motd-history-entry").last();
            const summary = row.locator("summary");
            await summary.scrollIntoViewIfNeeded();
            const hit = await summary.evaluate(node => {
                const rect = node.getBoundingClientRect();
                const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
                const text = [...node.querySelectorAll(".ps-motd-meta,.ps-motd-history-title")];
                const overlaps = [...node.querySelectorAll("button")].some(button => {
                    const control = button.getBoundingClientRect();
                    return text.some(element => {
                        const box = element.getBoundingClientRect();
                        return control.left < box.right && control.right > box.left
                            && control.top < box.bottom && control.bottom > box.top;
                    });
                });
                const actions = node.querySelector(".ps-motd-history-actions")?.getBoundingClientRect();
                return { inSummary: node.contains(target), button: target?.closest("button")?.getAttribute("aria-label") || null, overlaps,
                    actionsBelowText: !actions || text.every(element => element.getBoundingClientRect().bottom <= actions.top) };
            });
            expect(hit).toEqual({ inSummary: true, button: null, overlaps: false, actionsBelowText: true });
            await summary.tap();
            await expect(row).toHaveJSProperty("open", true);
            // Tap feedback can clear keyboard activation between Space down and up.
            await expect.poll(() => summary.evaluate(node => node.matches(":active"))).toBe(false);
            await summary.press("Space");
            await expect(row).toHaveJSProperty("open", false);
            await row.locator(".ps-motd-history-title").tap();
            await expect(row).toHaveJSProperty("open", true);
            await expect.poll(() => summary.evaluate(node => node.matches(":active"))).toBe(false);
            await summary.press("Space");
            await expect(row).toHaveJSProperty("open", false);
            await summary.press("Space");
            await expect(row).toHaveJSProperty("open", true);
            await row.getByRole("button", { name: "Show splash again", exact: true }).click();
            await expect(preview.locator(".ps-motd-window")).toHaveText(zone.previous);
            await preview.getByRole("button", { name: "Close preview", exact: true }).click();
            expect(f.state.calls.filter(call => call.path.endsWith("/dismiss"))).toHaveLength(1);
            expect(f.state.history[0].fromAt).toBe("2026-11-01T15:00:00Z");
            expect(f.state.history[0].toAt).toBe("2026-11-02T20:00:00Z");
        } finally { await f.stop(); }
    });
});
