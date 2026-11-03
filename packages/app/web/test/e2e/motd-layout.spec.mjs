import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { fixture, message } from "./motd-fixture.mjs";

const baseline = process.env.PS_MOTD_LAYOUT_BASELINE === "true";
const captureDir = process.env.PS_MOTD_CAPTURE_DIR;
for (const viewport of [{ width: 1440, height: 900 }, { width: 1100, height: 800 }]) {
    for (const admin of [true, false]) {
        test(`MoTD panel fills its pane: ${admin ? "admin" : "reader"} ${viewport.width}x${viewport.height}`, async ({ page }) => {
            await page.setViewportSize(viewport);
            const live = message({ hasImage: true, dismissalCount: 41 });
            const older = message({ motdId: "9", status: "ended", hasImage: true, bodyMd: "## Previous announcement\nThe previous message and its picture remain readable." });
            const f = await fixture(page, { admin, current: null, history: [live, older] });
            try {
                await page.getByRole("button", { name: admin ? "Admin console" : "Settings", exact: true }).click();
                const row = page.getByRole("button", { name: "Message of the day", exact: true });
                let measurements = null;
                if (baseline && !admin) {
                    await expect(row).toHaveCount(0);
                } else {
                    await row.click();
                    const panel = page.getByRole("region", { name: "Message of the day settings" });
                    await expect(panel.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
                    await expect(panel.getByRole("button", { name: "Show splash again", exact: true }).first()).toBeVisible();
                    if (admin) {
                        await page.getByRole("group", { name: "Starts", exact: true }).getByRole("radio", { name: "At a time...", exact: true }).locator("..").click();
                        await page.getByLabel("Start date", { exact: true }).fill("2030-01-01");
                        await page.getByLabel("Start time", { exact: true }).selectOption("12:30");
                        await page.getByRole("group", { name: "Ends", exact: true }).getByRole("radio", { name: "At a time...", exact: true }).locator("..").click();
                        await page.getByLabel("End date", { exact: true }).fill("2030-01-02");
                        await page.getByLabel("End time", { exact: true }).selectOption("18:45");
                        await page.getByLabel("Body (markdown)", { exact: true }).fill("## A message for everyone\n\nThe editor uses the available pane width.\n\nBoth local date and time fields remain readable.");
                    } else {
                        await expect(panel.locator("form")).toHaveCount(0);
                        await expect(panel.getByRole("button", { name: /Publish|Delete|Preview/ })).toHaveCount(0);
                        await expect(panel).not.toContainText("people dismissed");
                        await expect(panel).not.toContainText("by admin");
                    }
                    measurements = await panel.evaluate(root => {
                        const rect = node => {
                            const r = node.getBoundingClientRect();
                            return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height };
                        };
                        const cards = root.querySelector(".ps-motd-admin-grid");
                        const from = root.querySelector('input[type="date"]');
                        const to = root.querySelectorAll('input[type="date"]')[1];
                        return { panel: rect(root), main: rect(root.closest(".ps-admin-main")), grid: rect(cards),
                            today: rect(cards.firstElementChild), editor: cards.querySelector("form") ? rect(cards.querySelector("form")) : null,
                            from: from ? { ...rect(from), clientWidth: from.clientWidth, scrollWidth: from.scrollWidth } : null,
                            to: to ? { ...rect(to), clientWidth: to.clientWidth, scrollWidth: to.scrollWidth } : null,
                            body: root.querySelector("textarea") ? rect(root.querySelector("textarea")) : null,
                            history: rect(root.querySelector(".ps-motd-history")) };
                    });
                    if (!baseline) {
                        expect(measurements.panel.width).toBeGreaterThanOrEqual(measurements.main.width - 2);
                        expect(measurements.history.width).toBeGreaterThanOrEqual(measurements.grid.width - 2);
                        if (admin) {
                            expect(Math.abs(measurements.today.top - measurements.editor.top)).toBeLessThanOrEqual(2);
                            expect(measurements.editor.width).toBeGreaterThan(measurements.today.width * 1.2);
                            expect(Math.abs(measurements.editor.right - measurements.grid.right)).toBeLessThanOrEqual(2);
                            for (const field of [measurements.from, measurements.to]) {
                                expect(field.width).toBeGreaterThanOrEqual(220);
                                expect(field.scrollWidth).toBeLessThanOrEqual(field.clientWidth + 1);
                            }
                            expect(measurements.body.height).toBeGreaterThanOrEqual(220);
                            expect(measurements.to.top).toBeGreaterThan(measurements.from.top + measurements.from.height);
                        } else {
                            expect(measurements.today.width).toBeGreaterThanOrEqual(measurements.grid.width - 2);
                        }
                    }
                }
                if (captureDir) {
                    mkdirSync(captureDir, { recursive: true });
                    const stem = `motd-${baseline ? "before" : "after"}-${admin ? "admin" : "reader"}-${viewport.width}x${viewport.height}`;
                    await page.screenshot({ path: `${captureDir}/${stem}.png` });
                    writeFileSync(`${captureDir}/${stem}.json`, JSON.stringify({ viewport, admin, baseline, measurements,
                        note: "Synthetic T3 browser fixture, not the deployed portal" }, null, 2));
                }
            } finally { await f.stop(); }
        });
    }
}
