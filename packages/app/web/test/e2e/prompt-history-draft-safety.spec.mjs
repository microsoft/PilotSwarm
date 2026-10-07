import { test, expect, chromium, webkit } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const sid = "11111110-2222-3333-4444-555555555550";
const other = "11111111-2222-3333-4444-555555555551";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 2 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });
const image = name => ({ name, mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHH8AAAAASUVORK5CYII=", "base64") });
async function open(page) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.route("**/api/v1/bootstrap", route => route.fulfill({ json: { ok: true, result: {
        auth: { principal: { provider: "none", subject: "test" }, authorization: { role: "user" } },
    } } }));
    await page.route(`**/sessions/${sid}/events?*`, route => route.fulfill({ json: { ok: true, result: [{
        sessionId: sid, seq: 1, eventType: "user.message", data: { content: "Historical input",
            sender: { kind: "user", provider: "none", subject: "test" } },
    }] } }));
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sid}`);
    await expect(page.locator(".ps-chat-panel")).toContainText("Historical input");
    return page.getByTestId("session-prompt");
}
for (const browserName of ["chromium", "webkit"]) {
    test(`${browserName}: away/back during recall restores unsent text and image`, async () => {
        const browser = await ({ chromium, webkit })[browserName].launch();
        try {
            const page = await browser.newPage();
            const input = await open(page);
            await input.fill("Original draft");
            await page.locator(".ps-hidden-file-input").setInputFiles(image("original.png"));
            await input.press("Home");
            await input.press("ArrowUp");
            await expect(input).toHaveValue("Historical input");
            await page.locator(`.ps-session-list-button[data-session-id="${other}"]`).click();
            await page.locator(`.ps-session-list-button[data-session-id="${sid}"]`).click();
            await expect(input).toHaveValue("Original draft");
            await expect(page.getByRole("button", { name: "Remove attachment original.png", exact: true })).toBeVisible();
        } finally { await browser.close(); }
    });
    test(`${browserName}: attaching an image ends recall and Down keeps it`, async () => {
        const browser = await ({ chromium, webkit })[browserName].launch();
        try {
            const page = await browser.newPage();
            const input = await open(page);
            await input.fill("Original draft");
            await input.press("ArrowUp");
            await expect(input).toHaveValue("Historical input");
            await page.locator(".ps-hidden-file-input").setInputFiles(image("new.png"));
            await input.press("ArrowDown");
            await expect(input).toHaveValue("Historical input");
            await expect(page.getByRole("button", { name: "Remove attachment new.png", exact: true })).toBeVisible();
        } finally { await browser.close(); }
    });
}
