import { test, expect, chromium, webkit, devices } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const sid = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 2 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

for (const variant of ["chromium", "webkit", "ipad"]) {
    test(`${variant}: queued inputs retain priority and readonly state before executed history`, async () => {
        const browser = await (variant === "chromium" ? chromium : webkit).launch();
        const context = await browser.newContext(variant === "ipad"
            ? { ...devices["iPad (gen 7)"], viewport: { width: 810, height: 600 } }
            : { viewport: { width: 1440, height: 900 } });
        try {
            const page = await context.newPage();
            await page.route("**/api/v1/bootstrap", route => route.fulfill({ json: { ok: true, result: {
                auth: { principal: { provider: "none", subject: "test" }, authorization: { role: "user" } },
            } } }));
            await page.route(`**/sessions/${sid}/events?*`, route => route.fulfill({ json: { ok: true, result: [1, 2].map(seq => ({
                sessionId: sid, seq, eventType: "user.message",
                data: { content: `Executed ${seq}`, sender: { kind: "user", provider: "none", subject: "test" } },
            })) } }));
            await page.route(`**/sessions/${sid}/messages`, route => route.fulfill({ json: { ok: true, result: { queued: true } } }));
            await page.goto(`http://127.0.0.1:${stub.port}/?session=${sid}`);
            await expect(page.locator(".ps-chat-panel")).toContainText("Executed 2");
            const input = page.getByTestId("session-prompt");
            for (const text of ["Queued first", "Queued second"]) {
                await input.fill(text);
                const accepted = page.waitForResponse(response => response.url().endsWith(`/sessions/${sid}/messages`));
                await page.getByTestId("send-prompt").click();
                await accepted;
                await expect(input).toHaveValue("");
            }
            await input.fill("Unsent draft");
            for (const text of ["Queued second", "Queued first", "Executed 2", "Executed 1"]) {
                await input.press("ArrowUp");
                await expect(input).toHaveValue(text);
                await expect(input).toHaveJSProperty("readOnly", text.startsWith("Queued"));
            }
            for (const text of ["Executed 2", "Queued first", "Queued second", "Unsent draft"]) {
                await input.press("ArrowDown");
                await expect(input).toHaveValue(text);
                await expect(input).toHaveJSProperty("readOnly", text.startsWith("Queued"));
            }
            await input.press("ArrowUp");
            await input.dispatchEvent("keydown", { key: "ArrowUp", code: "ArrowUp", isComposing: true });
            await expect(input).toHaveValue("Queued second");
            await input.press("Escape");
            await expect(input).toHaveValue("Unsent draft");
        } finally {
            await context.close();
            await browser.close();
        }
    });
}
