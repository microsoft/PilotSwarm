import { test, expect } from "@playwright/test";
import { fixture, message } from "./motd-fixture.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const source = extra => message({ motdId: "7", bodyMd: "## Original body\nEdit before publishing.", mobileBodyMd: "Short original",
    fromAt: "2020-01-01T12:00:00Z", toAt: "2020-01-03T14:30:00Z", status: "ended",
    hasImage: true, hasMobileImage: true, imageAlt: "Source main alt", mobileImageAlt: "Source mobile alt", imagePlacement: "beside", ...extra });
async function openEditor(page, options = {}) {
    const f = await fixture(page, { current: null, history: [source()], ...options });
    await page.getByRole("button", { name: options.admin === false ? "Settings" : "Admin console", exact: true }).click();
    await page.getByRole("button", { name: "Message of the day", exact: true }).click();
    await page.getByRole("region", { name: "Message of the day settings" }).waitFor();
    return f;
}
async function transferImage(page, target, { mobile = false, kind = "paste", name = "pasted.png", size = null, type = "image/png" } = {}) {
    if (mobile) {
        const details = page.locator(".ps-motd-mobile-editor");
        if (!await details.evaluate(node => node.open)) await details.locator("summary").click();
        await page.getByLabel("Mobile body (markdown)", { exact: true }).focus();
    } else await page.getByLabel("Body (markdown)", { exact: true }).focus();
    return target.evaluate((node, input) => {
        const bytes = input.size === null ? Uint8Array.from(atob(input.base64), character => character.charCodeAt(0)) : new Uint8Array(input.size);
        const data = new DataTransfer();
        data.items.add(new File([bytes], input.name, { type: input.type }));
        const event = input.kind === "paste"
            ? new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
            : new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true });
        node.dispatchEvent(event);
        return event.defaultPrevented;
    }, { kind, name, size, type, base64: PNG });
}
test("duplicate an older message, edit it and publish only the new message", async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 600 });
    const f = await openEditor(page);
    try {
        const start = Date.now();
        await page.getByRole("button", { name: "Duplicate message 7", exact: true }).click();
        const editor = page.locator(".ps-motd-editor");
        await expect(page.getByLabel("Body (markdown)", { exact: true })).toHaveValue(source().bodyMd);
        await expect(page.getByLabel("Body (markdown)", { exact: true })).toBeFocused();
        await expect(page.getByLabel("Body (markdown)", { exact: true })).toBeInViewport({ ratio: 1 });
        await expect(editor).toContainText("Copied from message 7");
        await expect(editor.getByRole("status").filter({ hasText: "Copied from message 7" })).toBeInViewport();
        await expect(page.getByLabel("Mobile body (markdown)", { exact: true })).toHaveValue("Short original");
        await expect(page.getByLabel("Picture alt text", { exact: true })).toHaveValue("Source main alt");
        await expect(page.getByLabel("Mobile picture alt text", { exact: true })).toHaveValue("Source mobile alt");
        await expect(page.getByLabel("Picture placement", { exact: true })).toHaveValue("beside");
        await expect(editor.getByRole("group", { name: "Starts", exact: true }).getByRole("radio", { name: "Now", exact: true })).toBeChecked();
        await expect(editor.getByRole("group", { name: "Ends", exact: true }).getByRole("radio", { name: "At a time...", exact: true })).toBeChecked();
        expect(f.state.calls).toHaveLength(0);
        await page.getByLabel("Body (markdown)", { exact: true }).fill("## Edited copy\nPublish this one.");
        await page.getByRole("button", { name: "Publish", exact: true }).click();
        await expect(page.getByRole("status").filter({ hasText: "Message published." })).toBeVisible();
        expect(f.state.calls).toHaveLength(1);
        expect(f.state.calls[0].input.bodyMd).toBe("## Edited copy\nPublish this one.");
        expect(f.state.calls[0].input.image.alt).toBe("Source main alt");
        expect(f.state.calls[0].input.mobileImage.alt).toBe("Source mobile alt");
        expect(f.state.calls[0].input.startsAt).toBeUndefined();
        expect(Date.parse(f.state.calls[0].input.endsAt) - start).toBeGreaterThanOrEqual(Date.parse(source().toAt) - Date.parse(source().fromAt));
        expect(Date.parse(f.state.calls[0].input.endsAt) - start).toBeLessThan(Date.parse(source().toAt) - Date.parse(source().fromAt) + 10_000);
        expect(f.state.history.find(row => row.motdId === "7").bodyMd).toBe(source().bodyMd);
    } finally { await f.stop(); }
});
test("Duplicate on Today reuses its loaded main picture and keeps the source unchanged", async ({ page }) => {
    const live = source({ status: "live", toAt: "2090-01-01T00:00:00Z", hasMobileImage: false });
    const f = await openEditor(page, { history: [live] });
    try {
        await expect(page.locator(".ps-motd-mini").first().getByAltText("Main picture")).toBeVisible();
        expect(f.state.imageRequests).toHaveLength(1);
        await page.getByRole("button", { name: "Duplicate current message", exact: true }).click();
        await expect(page.getByLabel("Body (markdown)", { exact: true })).toHaveValue(live.bodyMd);
        expect(f.state.imageRequests).toHaveLength(1);
        expect(f.state.calls).toHaveLength(0);
        expect(f.state.history[0]).toEqual(live);
    } finally { await f.stop(); }
});
for (const kind of ["paste", "drop"]) {
    test(`${kind} selects main or mobile picture by editor focus and requires alt text`, async ({ page }) => {
        const f = await openEditor(page);
        try {
            const editor = page.locator(".ps-motd-editor");
            expect(await transferImage(page, editor, { kind, name: "main-paste.png" })).toBe(true);
            await expect(page.getByLabel("Picture alt text", { exact: true })).toHaveValue("main-paste.png");
            await expect(editor.getByAltText("main-paste.png")).toBeVisible();
            expect(await transferImage(page, editor, { kind, mobile: true, name: "mobile-paste.png" })).toBe(true);
            await expect(page.getByLabel("Mobile picture alt text", { exact: true })).toHaveValue("mobile-paste.png");
            await page.getByRole("group", { name: "Ends", exact: true }).getByRole("radio", { name: "1 day", exact: true }).locator("..").click();
            await page.getByLabel("Body (markdown)", { exact: true }).fill("Image notice");
            await page.getByLabel("Mobile picture alt text", { exact: true }).fill("");
            await page.getByRole("button", { name: "Publish", exact: true }).click();
            expect(f.state.calls).toHaveLength(0);
            expect(await page.getByLabel("Mobile picture alt text", { exact: true }).evaluate(node => node.checkValidity())).toBe(false);
            await page.getByLabel("Mobile picture alt text", { exact: true }).fill("Mobile alt");
            await page.getByRole("button", { name: "Publish", exact: true }).click();
            await expect(page.getByRole("status").filter({ hasText: "Message published." })).toBeVisible();
            expect(f.state.calls[0].input.image.alt).toBe("main-paste.png");
            expect(f.state.calls[0].input.mobileImage.alt).toBe("Mobile alt");
        } finally { await f.stop(); }
    });
}
test("oversized and unsupported pasted images use the same rejection as upload", async ({ page }) => {
    const f = await openEditor(page);
    try {
        const editor = page.locator(".ps-motd-editor");
        await transferImage(page, editor, { size: 2 * 1024 * 1024 + 1 });
        await expect(page.getByRole("alert")).toHaveText("Choose PNG, JPEG, WebP or GIF, at most 2 MB per picture.");
        await expect(editor.locator(".ps-motd-editor-thumb")).toHaveCount(0);
        await transferImage(page, editor, { name: "vector.svg", type: "image/svg+xml" });
        await expect(page.getByRole("alert")).toHaveText("Choose PNG, JPEG, WebP or GIF, at most 2 MB per picture.");
        await editor.locator('input[type="file"]').first().setInputFiles({ name: "vector.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg></svg>") });
        await expect(page.getByRole("alert")).toHaveText("Choose PNG, JPEG, WebP or GIF, at most 2 MB per picture.");
        await transferImage(page, editor, { kind: "drop", name: "document.pdf", type: "application/pdf" });
        await expect(page.getByRole("alert")).toHaveText("Choose PNG, JPEG, WebP or GIF, at most 2 MB per picture.");
        expect(f.state.calls).toHaveLength(0);
    } finally { await f.stop(); }
});
test("copied drafts do not steal focus on remount or after a failed second Duplicate", async ({ page }) => {
    const next = source({ motdId: "8", hasMobileImage: false });
    const f = await openEditor(page, { history: [source(), next] });
    try {
        await page.getByRole("button", { name: "Duplicate message 7", exact: true }).click();
        await expect(page.getByLabel("Body (markdown)", { exact: true })).toHaveValue(source().bodyMd);
        await page.locator(".ps-motd-mobile-editor summary").click();
        await page.getByRole("button", { name: "Model Providers", exact: true }).click();
        await page.getByRole("button", { name: "Message of the day", exact: true }).click();
        await expect(page.getByLabel("Body (markdown)", { exact: true })).not.toBeFocused();
        await expect(page.locator(".ps-motd-mobile-editor")).not.toHaveAttribute("open", "");
        await page.route("**/api/v1/management/motd/8/image**", route => route.fulfill({ status: 503,
            json: { ok: false, error: { code: "UNAVAILABLE", message: "Picture unavailable" } } }));
        const duplicate = page.getByRole("button", { name: "Duplicate message 8", exact: true });
        await duplicate.click();
        await expect(page.getByRole("alert")).toContainText("source picture could not be loaded");
        await expect(duplicate).toBeEnabled();
        await expect(page.getByLabel("Body (markdown)", { exact: true })).not.toBeFocused();
        await expect(page.getByLabel("Body (markdown)", { exact: true })).toHaveValue(source().bodyMd);
        expect(f.state.calls).toHaveLength(0);
    } finally { await f.stop(); }
});
test("a mixed image and text clipboard leaves text paste to the browser", async ({ page }) => {
    const f = await openEditor(page);
    try {
        const body = page.getByLabel("Body (markdown)", { exact: true });
        await body.fill("Existing body");
        const prevented = await body.evaluate((node, png) => {
            const data = new DataTransfer();
            data.setData("text/plain", "Office text");
            data.items.add(new File([Uint8Array.from(atob(png), character => character.charCodeAt(0))], "rendered.png", { type: "image/png" }));
            const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
            node.dispatchEvent(event);
            return event.defaultPrevented;
        }, PNG);
        expect(prevented).toBe(false);
        await expect(page.locator(".ps-motd-editor-thumb")).toHaveCount(0);
        await expect(body).toHaveValue("Existing body");
    } finally { await f.stop(); }
});
test("a nameless pasted image leaves alt empty; plain text paste remains untouched", async ({ page }) => {
    const f = await openEditor(page);
    try {
        const body = page.getByLabel("Body (markdown)", { exact: true });
        await body.fill("Existing text");
        await transferImage(page, page.locator(".ps-motd-editor"), { name: "" });
        await expect(page.getByLabel("Picture alt text", { exact: true })).toHaveValue("");
        const prevented = await body.evaluate(node => {
            const data = new DataTransfer(); data.setData("text/plain", " pasted text");
            const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
            node.dispatchEvent(event); return event.defaultPrevented;
        });
        expect(prevented).toBe(false);
        await expect(body).toHaveValue("Existing text");
        expect(f.state.calls).toHaveLength(0);
    } finally { await f.stop(); }
});
test("readers have no Duplicate buttons and no image editor", async ({ page }) => {
    const f = await openEditor(page, { admin: false });
    try {
        await expect(page.getByRole("button", { name: /Duplicate/ })).toHaveCount(0);
        await expect(page.locator(".ps-motd-editor")).toHaveCount(0);
    } finally { await f.stop(); }
});
