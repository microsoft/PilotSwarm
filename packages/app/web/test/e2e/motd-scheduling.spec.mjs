import { test, expect } from "@playwright/test";
import { fixture, message } from "./motd-fixture.mjs";
import { mkdirSync } from "node:fs";

async function open(page, options = {}) {
    const f = await fixture(page, { current: null, history: [], ...options });
    await page.getByRole("button", { name: options.admin === false ? "Settings" : "Admin console", exact: true }).click();
    await page.getByRole("button", { name: "Message of the day", exact: true }).click();
    return f;
}
const starts = page => page.getByRole("group", { name: "Starts", exact: true });
const ends = page => page.getByRole("group", { name: "Ends", exact: true });

test("Now and Never defaults publish without either time", async ({ page }) => {
    const f = await open(page);
    try {
        await expect(starts(page).getByRole("radio", { name: "Now", exact: true })).toBeChecked();
        await expect(ends(page).getByRole("radio", { name: "Never - until replaced or deleted", exact: true })).toBeChecked();
        await expect(page.locator(".ps-motd-schedule-summary")).toHaveText("Shows now until replaced or deleted.");
        await expect(page.locator('input[type="date"],input[type="datetime-local"]')).toHaveCount(0);
        await page.getByLabel("Body (markdown)", { exact: true }).fill("No end announcement");
        await page.getByRole("button", { name: "Preview", exact: true }).click();
        const preview = page.getByRole("dialog", { name: "Message of the day preview", exact: true });
        await expect(preview).toContainText("until replaced");
        await expect(preview).not.toContainText("Invalid Date");
        await preview.getByRole("button", { name: "Close preview", exact: true }).click();
        await page.getByRole("button", { name: "Publish", exact: true }).click();
        await expect(page.getByRole("status").filter({ hasText: "Message published." })).toBeVisible();
        expect(f.state.calls[0].input.startsAt).toBeUndefined();
        expect(f.state.calls[0].input.endsAt).toBeUndefined();
        await expect(page.locator(".ps-motd-admin")).toContainText("until replaced");
    } finally { await f.stop(); }
});
test("custom dates and 15-minute time selects work with the keyboard and show the zone", async ({ page }) => {
    const f = await open(page);
    try {
        const now = starts(page).getByRole("radio", { name: "Now", exact: true });
        await now.focus();
        expect(await now.evaluate(node => ({ clip: getComputedStyle(node).clipPath, width: node.offsetWidth })))
            .toEqual({ clip: "inset(50%)", width: 1 });
        expect(await now.locator("..").evaluate(node => getComputedStyle(node).outlineWidth)).toBe("2px");
        await page.keyboard.press("ArrowRight");
        await expect(starts(page).getByRole("radio", { name: "At a time...", exact: true })).toBeChecked();
        await page.getByLabel("Start date", { exact: true }).fill("2030-11-02");
        const startTime = page.getByLabel("Start time", { exact: true });
        await startTime.selectOption("09:00"); await startTime.focus(); await page.keyboard.press("ArrowDown");
        await expect(startTime).toHaveValue("09:15");
        await ends(page).getByRole("radio", { name: "At a time...", exact: true }).locator("..").click();
        await page.getByLabel("End date", { exact: true }).fill("2030-11-08");
        await page.getByLabel("End time", { exact: true }).selectOption("18:00");
        expect(await startTime.locator("option").count()).toBe(96);
        await expect(page.locator(".ps-motd-schedule-summary")).toContainText("9:15 AM");
        await expect(page.locator(".ps-motd-schedule")).toContainText("Your time zone:");
        await page.getByLabel("Body (markdown)", { exact: true }).fill("Scheduled");
        await page.getByRole("button", { name: "Publish", exact: true }).click();
        await expect(page.getByRole("status").filter({ hasText: "Message published." })).toBeVisible();
        expect(f.state.calls[0].input.startsAt).toMatch(/Z$/);
        expect(f.state.calls[0].input.endsAt).toMatch(/Z$/);
    } finally { await f.stop(); }
});
test("each relative preset sends the exact length and Duplicate preserves it", async ({ page }) => {
    const source = message({ fromAt: "2020-01-01T00:00:00Z", toAt: "2020-01-02T00:00:00Z" });
    const f = await open(page, { history: [source] });
    try {
        await page.getByRole("button", { name: "Duplicate message 1", exact: true }).click();
        await expect(ends(page).getByRole("radio", { name: "1 day", exact: true })).toBeChecked();
        for (const name of ["1 hour", "1 day", "1 week"]) {
            await ends(page).getByRole("radio", { name, exact: true }).locator("..").click();
            await expect(page.locator(".ps-motd-schedule-summary")).toContainText("Shows now until");
            await page.getByLabel("Body (markdown)", { exact: true }).fill(`Preset ${name}`);
            const before = Date.now();
            await page.getByRole("button", { name: "Publish", exact: true }).click();
            await expect(page.getByRole("status").filter({ hasText: "Message published." })).toBeVisible();
            const request = f.state.calls.at(-1).input;
            expect(request.startsAt).toBeUndefined();
            const length = { "1 hour": 3_600_000, "1 day": 86_400_000, "1 week": 604_800_000 }[name];
            expect(Date.parse(request.endsAt) - before).toBeGreaterThanOrEqual(length);
            expect(Date.parse(request.endsAt) - before).toBeLessThan(length + 10_000);
            const saved = f.state.history[0];
            await page.getByRole("button", { name: `Duplicate message ${saved.motdId}`, exact: true }).click();
            await expect(ends(page).getByRole("radio", { name, exact: true })).toBeChecked();
        }
        expect(f.state.calls).toHaveLength(3);
    } finally { await f.stop(); }
});
test("Duplicate open-ended messages stays Now and Never, including on a phone", async ({ page }) => {
    const f = await open(page, { history: [message({ toAt: null, endsAt: null })] });
    try {
        await page.getByRole("button", { name: "Duplicate message 1", exact: true }).click();
        await expect(starts(page).getByRole("radio", { name: "Now", exact: true })).toBeChecked();
        await expect(ends(page).getByRole("radio", { name: "Never - until replaced or deleted", exact: true })).toBeChecked();
        await page.setViewportSize({ width: 390, height: 800 });
        await expect(page.locator(".ps-motd-schedule-summary")).toHaveText("Shows now until replaced or deleted.");
        expect(await page.locator(".ps-motd-editor").evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    } finally { await f.stop(); }
});
for (const theme of ["gruvbox-dark", "github-light"]) {
    test(`new editor screenshot: ${theme}`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 1100 });
        const f = await open(page, { themeId: theme });
        try {
            await expect(page.locator("html")).toHaveAttribute("data-ps-theme", theme);
            await page.getByLabel("Body (markdown)", { exact: true }).fill("## A message for everyone\n\nThe newest announcement takes over immediately. Choose an optional end, or keep it until replaced.");
            const dir = process.env.PS_MOTD_CAPTURE_DIR;
            if (dir) { mkdirSync(dir, { recursive: true }); await page.screenshot({ path: `${dir}/motd-schedule-${theme}.png` }); }
        } finally { await f.stop(); }
    });
}
