import { test, expect, chromium, webkit } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { normalizeMoa } from "../../../ui/core/src/moa.js";

const sid = "11111110-2222-3333-4444-555555555550";
const other = "11111111-2222-3333-4444-555555555551";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 2 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });
for (const browserName of ["chromium", "webkit"]) {
    test(`${browserName}: old guidance update stays unplaced until backward acceptance history loads`, async () => {
        const browser = await ({ chromium, webkit })[browserName].launch();
        try {
            const page = await browser.newPage();
            const receipt = { sessionId: sid, requestId: "old", sequence: 1, revision: 2, text: "Old guidance",
                schemaVersion: 1, status: "delivered", disposition: "delivered_after_response" };
            const newer = { sessionId: sid, seq: 50, eventType: "user.message", data: { content: "New conversation" } };
            const update = { sessionId: sid, seq: 60, eventType: "session.steering_updated", data: { projection: receipt } };
            await page.route("**/steering-state", route => route.fulfill({ json: { ok: true, result: { supported: true, steerable: false } } }));
            await page.route("**/steering?*", route => route.fulfill({ json: { ok: true, result: { items: [receipt], nextCursor: null } } }));
            await page.route("**/steering/old", route => route.fulfill({ json: { ok: true, result: receipt } }));
            await page.route(`**/sessions/${sid}/events?*`, route => route.fulfill({ json: { ok: true, result: [newer, update] } }));
            await page.goto(`http://127.0.0.1:${stub.port}/?session=${sid}`);
            const chat = page.locator(".ps-chat-panel .ps-scroll-panel");
            await expect(chat).toContainText("New conversation");
            await expect(page.locator(".ps-steering-archive")).toBeVisible();
            await expect(chat).not.toContainText("Old guidance");
            await page.locator(".ps-steering-archive > summary").click();
            await expect(page.locator(".ps-steering-archive")).toContainText("Old guidance");
        } finally { await browser.close(); }
    });
    for (const phase of ["pending", "queued"]) {
        test(`${browserName}: MoA ${phase} recall loses edit binding when its original draft is restored`, async () => {
            const browser = await ({ chromium, webkit })[browserName].launch();
            const issued = Promise.withResolvers(), release = Promise.withResolvers();
            try {
                const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
                await page.route("**/api/v1/me/profile", route => route.fulfill({ json: { ok: true, result: {
                    isAdmin: false, profileSettings: { moa: normalizeMoa({ version: 3, activeDashboardId: "dash", dashboards: [{
                        id: "dash", name: "Drafts", focusedPanelId: "a",
                        tree: { id: "root", type: "split", direction: "row", ratio: 50,
                            first: { id: "a", type: "chat", sessionId: sid }, second: { id: "b", type: "chat", sessionId: other } },
                    }] }) },
                } } }));
                await page.route(`**/sessions/${sid}/messages`, async route => {
                    issued.resolve();
                    if (phase === "pending") await release.promise;
                    return route.fulfill({ json: { ok: true, result: { queued: true } } });
                });
                await page.goto(`http://127.0.0.1:${stub.port}/?session=${sid}`);
                await page.getByRole("button", { name: "Master of Agents", exact: true }).click();
                const a = page.locator('[data-moa-panel="a"]');
                const b = page.locator('[data-moa-panel="b"]');
                const input = a.locator("textarea");
                await expect(input).toBeVisible();
                await input.fill("Queue text");
                const sent = phase === "queued" ? page.waitForResponse(response => response.url().endsWith(`/sessions/${sid}/messages`)) : null;
                await input.press("Enter");
                await issued.promise;
                if (phase === "queued") await sent;
                await expect(input).toHaveValue("");
                await input.fill("Original draft");
                await input.evaluate(node => {
                    const clipboardData = new DataTransfer();
                    clipboardData.items.add(new File([new Uint8Array([137, 80, 78, 71])], "draft.png", { type: "image/png" }));
                    node.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
                });
                await expect(a.getByRole("button", { name: "Remove attachment draft.png", exact: true })).toBeVisible();
                await input.press("ArrowUp");
                await expect(input).toHaveValue("Queue text");
                await expect(input).toHaveJSProperty("readOnly", phase === "queued");
                await b.locator("header").first().click();
                await a.locator("header").first().click();
                await expect(input).toHaveValue("Original draft");
                await expect(input).toHaveJSProperty("readOnly", false);
                await expect(a.getByRole("button", { name: "Remove attachment draft.png", exact: true })).toBeVisible();
                await input.fill("Original draft typed");
                await input.press("ArrowUp");
                await expect(input).toHaveValue("Queue text");
                await input.press("ArrowDown");
                await expect(input).toHaveValue("Original draft typed");
            } finally { release.resolve(); await browser.close(); }
        });
    }
}
