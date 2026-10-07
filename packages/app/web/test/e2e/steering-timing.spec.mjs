import { test, expect, chromium, webkit } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const sid = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

for (const browserName of ["chromium", "webkit"]) {
    test(`${browserName}: recovered delivery preserves approved wording and offers no reuse or resend`, async () => {
        const browser = await ({ chromium, webkit })[browserName].launch();
        try {
            const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
            const receipt = { schemaVersion: 1, sessionId: sid, requestId: "recovered", revision: 2, sequence: 1,
                status: "delivered", disposition: "delivered_timing_unconfirmed", text: "Recovered guidance",
                actor: { provider: "none", subject: "test" }, inclusion: { state: "included" },
                actions: { canWithdraw: false, canSendAsNewMessage: false } };
            await page.route("**/steering-state", route => route.fulfill({ json: { ok: true, result: {
                supported: true, canWrite: true, steerable: false,
            } } }));
            await page.route("**/steering?*", route => route.fulfill({ json: { ok: true, result: { items: [receipt], nextCursor: null } } }));
            await page.route(`**/sessions/${sid}/events?*`, route => route.fulfill({ json: { ok: true, result: [{
                sessionId: sid, seq: 1, eventType: "session.steering_accepted", data: { receipt },
            }] } }));
            await page.goto(`http://127.0.0.1:${stub.port}/?session=${sid}`);
            const row = page.getByTestId("steering-request").filter({ hasText: "Recovered guidance" }).first();
            await expect(row.getByTestId("steering-status")).toHaveText(" — Delivered (timing unconfirmed)");
            await row.getByText("Delivery details", { exact: true }).click();
            await expect(row).toContainText("Delivered before recovery; whether it reached the turn or followed the response is not known.");
            await expect(row).toContainText("Included in the saved conversation.");
            await expect(row.getByRole("button", { name: "Reuse in draft", exact: true })).toHaveCount(0);
            await expect(row.getByRole("button", { name: "Send as new message", exact: true })).toHaveCount(0);
        } finally { await browser.close(); }
    });
}
