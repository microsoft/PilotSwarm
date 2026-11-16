import { test, expect } from "@playwright/test";
import { fixture, message } from "./motd-fixture.mjs";
const splash = page => page.getByRole("dialog", { name: "Message of the day", exact: true });
async function openAdmin(page) {
    await page.getByRole("button", { name: "Admin console", exact: true }).click();
    await page.getByRole("button", { name: "Message of the day", exact: true }).click();
    await page.getByRole("region", { name: "Message of the day settings" }).waitFor();
}
test("desktop splash renders markdown, blocks background and records one click dismissal", async ({ page }) => {
    const f = await fixture(page);
    try {
        await expect(splash(page)).toBeVisible(); await expect(splash(page).getByRole("heading", { name: "Welcome" })).toBeVisible();
        await expect(splash(page).getByRole("button", { name: "Got it" })).toBeFocused();
        await page.keyboard.press("Escape"); await expect(splash(page)).toBeVisible();
        await splash(page).getByRole("button", { name: "Got it" }).click(); await expect(splash(page)).toHaveCount(0);
        expect(f.state.calls.filter(c => c.path.endsWith("/dismiss"))).toHaveLength(1);
    } finally { await f.stop(); }
});
test("dismissed fleet-current stays absent after a null refresh, not replaced from hidden history", async ({ page }) => {
    const newest = message({ motdId: "2", bodyMd: "Newest announcement", toAt: null });
    const older = message({ bodyMd: "Superseded announcement", status: "hidden" });
    const f = await fixture(page, { current: newest, history: [newest, older] });
    try {
        await expect(splash(page)).toContainText("Newest announcement");
        const reads = f.state.reads;
        await splash(page).getByRole("button", { name: "Got it", exact: true }).click();
        await expect(splash(page)).toHaveCount(0);
        expect(f.state.current).toBeNull();
        expect(f.state.reads).toBe(reads);
        await page.reload();
        await expect.poll(() => f.state.reads).toBeGreaterThan(reads);
        await expect(splash(page)).toHaveCount(0);
        await openAdmin(page);
        const panel = page.getByRole("region", { name: "Message of the day settings", exact: true });
        await expect(panel).toContainText("Superseded announcement");
        await expect(panel).toContainText("Hidden by later message");
        await expect(splash(page)).toHaveCount(0);
        expect(f.state.calls.filter(call => call.path.endsWith("/dismiss"))).toHaveLength(1);
    } finally { await f.stop(); }
});
test("raw HTML is escaped, body pictures stay placeholders and links do not dismiss", async ({ page }) => {
    const f = await fixture(page, { current: message({ bodyMd: '---\n**Maintenance tonight**\n---\n\n## Safe\n<strong data-raw="yes">literal</strong>\n\n![remote](https://example.invalid/pic.png)\n\n[Guide](https://example.invalid/guide)' }) });
    try {
        await expect(splash(page)).toBeVisible();
        await expect(splash(page)).toContainText("Maintenance tonight");
        await expect(splash(page)).toContainText('<strong data-raw="yes">literal</strong>');
        await expect(splash(page).locator("[data-raw]")).toHaveCount(0);
        await expect(splash(page).locator("img")).toHaveCount(0);
        const link = splash(page).getByRole("link", { name: "Guide" });
        await expect(link).toHaveAttribute("target", "_blank");
        await expect(link).toHaveAttribute("rel", "noopener noreferrer");
        await link.evaluate(node => node.addEventListener("click", event => event.preventDefault()));
        await link.click(); await expect(splash(page)).toBeVisible(); expect(f.state.calls).toHaveLength(0);
        await splash(page).getByRole("heading", { name: "Safe" }).click(); await expect(splash(page)).toHaveCount(0);
    } finally { await f.stop(); }
});
for (const placement of ["above", "beside", "background"]) test(`phone forces ${placement} to above and keeps Got it visible for long fallback text`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    const f = await fixture(page, { current: message({ imagePlacement: placement, hasImage: true, bodyMd: "## Long notice\n\n" + "Long desktop paragraph.\n\n".repeat(80) }) });
    try {
        await expect(splash(page)).toBeVisible();
        await expect(splash(page).getByAltText("Main picture")).toBeVisible();
        const geometry = await splash(page).evaluate(dialog => {
            const footer = dialog.querySelector(".ps-motd-footer"), scroll = dialog.querySelector(".ps-motd-scroll");
            return { footer: footer.getBoundingClientRect().bottom, height: innerHeight,
                overflow: getComputedStyle(scroll).overflowY, scrolls: scroll.scrollHeight > scroll.clientHeight,
                placement: dialog.querySelector(".ps-motd-content").className };
        });
        expect(geometry.placement).toContain("is-above"); expect(geometry.footer).toBeLessThanOrEqual(geometry.height);
        expect(geometry.overflow).toBe("auto"); expect(geometry.scrolls).toBe(true);
        await splash(page).getByRole("button", { name: "Got it" }).click();
    } finally { await f.stop(); }
});
test("phone uses the mobile body and optional mobile picture", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    const f = await fixture(page, { current: message({ hasImage: true, hasMobileImage: true, mobileBodyMd: "## Phone only\nShort version." }) });
    try {
        await expect(splash(page).getByRole("heading", { name: "Phone only" })).toBeVisible();
        await expect(splash(page).getByAltText("Phone picture")).toBeVisible();
        expect(f.state.imageRequests).toEqual([true]);
        await expect(splash(page)).not.toContainText("Use the portal.");
    } finally { await f.stop(); }
});
test("920 px is narrow; 921 px keeps desktop placement", async ({ page }) => {
    await page.setViewportSize({ width: 920, height: 900 });
    const f = await fixture(page, { current: message({ hasImage: true, imagePlacement: "beside" }) });
    try {
        await expect(splash(page).locator(".ps-motd-content")).toHaveClass(/is-above/);
        await page.setViewportSize({ width: 921, height: 900 });
        await expect(splash(page).locator(".ps-motd-content")).toHaveClass(/is-beside/);
    } finally { await f.stop(); }
});
test("admin can show today's dismissed splash again without a dismissal write, and delete an older message", async ({ page }) => {
    const live = message(), older = message({ motdId: "9", status: "ended", bodyMd: "Old notice" });
    const f = await fixture(page, { current: null, history: [live, older] });
    try {
        await openAdmin(page);
        await page.getByRole("button", { name: "Show splash again", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Message of the day preview" })).toBeVisible();
        await page.getByRole("button", { name: "Close preview", exact: true }).click();
        expect(f.state.calls).toHaveLength(0);
        page.once("dialog", dialog => dialog.accept());
        await page.getByRole("button", { name: "Delete message 9", exact: true }).click();
        await expect(page.getByText("Old notice", { exact: true })).toHaveCount(0);
        expect(f.state.calls.at(-1).method).toBe("DELETE");
    } finally { await f.stop(); }
});
test("admin editor creates UTC windows, retries publication and deletes the current message", async ({ page }) => {
    const f = await fixture(page, { current: null, history: [message()] });
    try {
        await openAdmin(page);
        await page.getByRole("group", { name: "Starts", exact: true }).getByRole("radio", { name: "At a time...", exact: true }).locator("..").click();
        await page.getByLabel("Start date", { exact: true }).fill("2030-01-01");
        await page.getByLabel("Start time", { exact: true }).selectOption("12:00");
        await page.getByRole("group", { name: "Ends", exact: true }).getByRole("radio", { name: "1 day", exact: true }).locator("..").click();
        await page.getByLabel("Body (markdown)", { exact: true }).fill("## New message\nBody.");
        f.state.failCreate = true;
        await page.getByRole("button", { name: "Publish", exact: true }).click();
        await expect(page.getByRole("alert")).toContainText("uncertain");
        f.state.failCreate = false;
        await page.getByRole("button", { name: "Publish", exact: true }).click();
        await expect(page.getByRole("status").filter({ hasText: "Message published." })).toBeVisible();
        const calls = f.state.calls.filter(c => c.method === "POST");
        expect(calls).toHaveLength(2); expect(calls[0].input.requestId).toBe(calls[1].input.requestId);
        expect(calls[1].input.startsAt).toMatch(/Z$/);
        page.once("dialog", dialog => dialog.accept());
        await page.getByRole("button", { name: "Delete current message", exact: true }).click();
        await expect(page.getByText("No message is active today.")).toBeVisible();
    } finally { await f.stop(); }
});
test("non-admin reads today's and previous pictures and previews without change controls", async ({ page }) => {
    const previous = message({ motdId: "9", status: "ended", hasImage: true, bodyMd: "## Previous notice\nEarlier body." });
    const live = message({ hasImage: true });
    const f = await fixture(page, { admin: false, current: live, history: [live, previous] });
    try {
        await expect(splash(page)).toBeVisible(); await splash(page).getByRole("button", { name: "Got it" }).click();
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.getByRole("button", { name: "Message of the day", exact: true }).click();
        const panel = page.getByRole("region", { name: "Message of the day settings" });
        await expect(panel.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
        await expect(panel.locator("form")).toHaveCount(0);
        await expect(panel.getByRole("button", { name: /Publish|Delete|^Preview$/ })).toHaveCount(0);
        await expect(panel).not.toContainText("people dismissed");
        await panel.getByRole("button", { name: "Show splash again", exact: true }).first().click();
        await expect(page.getByRole("dialog", { name: "Message of the day preview" })).toBeVisible();
        await page.getByRole("button", { name: "Close preview", exact: true }).click();
        const older = panel.locator(".ps-motd-history-entry").filter({ hasText: "Previous notice" });
        await older.locator("summary").click();
        await expect(older.getByAltText("Main picture")).toBeVisible();
        await older.getByRole("button", { name: "Show splash again", exact: true }).click();
        await expect(page.getByRole("dialog", { name: "Message of the day preview" })).toContainText("Earlier body.");
        await page.getByRole("button", { name: "Close preview", exact: true }).click();
        expect(f.state.calls).toHaveLength(1);
        expect(f.state.calls[0].path).toContain("/dismiss");
    } finally { await f.stop(); }
});

test("an empty current-message reply does not break the portal", async ({ page }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const f = await fixture(page, { admin: true, current: null, history: [] });
    try {
        // Registered after the fixture so it wins, then a fresh load reads it.
        await page.route("**/api/v1/management/motd/current**", route => route.fulfill({ json: { ok: true } }));
        await page.reload();
        await expect(page.getByRole("button", { name: "Master of Agents", exact: true })).toBeVisible();
        await expect(page.getByRole("dialog", { name: "Message of the day", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Master of Agents", exact: true })).toBeEnabled();
        expect(errors).toEqual([]);
    } finally { await f.stop(); }
});
