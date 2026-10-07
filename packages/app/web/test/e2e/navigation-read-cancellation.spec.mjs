import { test, expect, webkit, devices } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const a = "11111110-2222-3333-4444-555555555550", b = "11111111-2222-3333-4444-555555555551";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 2 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

test("iPhone navigation cancels held history/receipt reads and handles a failing system poll without pageerror", async () => {
    const browser = await webkit.launch();
    const context = await browser.newContext({ ...devices["iPhone 13"], viewport: { width: 390, height: 844 } });
    try {
        const page = await context.newPage(), errors = [], held = [];
        page.on("pageerror", error => errors.push(error.message));
        let failPoll = false, pollFailed = false;
        await page.route("**/api/v1/**", async route => {
            const url = new URL(route.request().url()), path = url.pathname;
            if (path.endsWith("/bootstrap")) return route.fulfill({ json: { ok: true, result: {
                auth: { principal: { provider: "none", subject: "test" }, authorization: { role: "user" } },
            } } });
            if (path.endsWith(`/sessions/${a}/events`)) return route.fulfill({ json: { ok: true, result: [
                { sessionId: a, seq: 1, eventType: "session.steering_updated",
                    data: { requestId: "r", revision: 2, projection: { schemaVersion: 1, sessionId: a, requestId: "r",
                        clientRequestId: "c", revision: 2, disposition: "accepted", status: "submitted" } } },
            ] } });
            if (path.endsWith(`/sessions/${a}/steering/r`)
                || path.endsWith(`/sessions/${a}/events-before`) && url.searchParams.get("limit") === "100") {
                await new Promise(resolve => { held.push(() => route.abort("failed").catch(() => {}).finally(resolve)); });
                return;
            }
            if (failPoll && path.endsWith("/management/sessions") && url.searchParams.get("systemFilter") === "only") {
                pollFailed = true;
                return route.abort("failed");
            }
            return route.fallback();
        });
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${a}`);
        await expect(page.getByTestId("session-prompt")).toBeVisible();
        await expect.poll(() => held.length).toBeGreaterThanOrEqual(2);
        await page.locator(`.ps-session-list-button[data-session-id="${b}"]`).click();
        for (const release of held) release();
        await page.getByTestId("session-prompt").fill("The new session remains usable");
        failPoll = true;
        await page.clock.install();
        await page.clock.fastForward(4100);
        await expect.poll(() => pollFailed).toBe(true);
        await expect(page.getByTestId("session-prompt")).toHaveValue("The new session remains usable");
        expect(errors).toEqual([]);
        await page.goto("about:blank");
        expect(errors).toEqual([]);
    } finally {
        await context.close();
        await browser.close();
    }
});
