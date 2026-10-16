// A sent message must not stay shown as queued. The server records the
// message (user.message with its client message ids); the portal clears the
// queued item when it sees that receipt, also when the receipt arrives by a
// path other than the live stream: the reload after a reconnect gap, or the
// history a MoA panel loads. The periodic session-list refresh (which also
// re-reads the selected session's new events) is held after start-up, so
// only the path under test can deliver the receipt, and each case asserts
// within 4 s, before the controller's 10 s re-check could clear the item.
import * as fs from "node:fs";
import * as path from "node:path";
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const SID_A = "11111110-2222-3333-4444-555555555550";
const SID_B = "11111111-2222-3333-4444-555555555551";
const FAST = { timeout: 4_000 };
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 2 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

/**
 * Route event reads, message sends and the live socket. A receipt added with
 * `recordReceipt()` is served by the events route only; nothing is pushed
 * over the socket. `holdRefresh()` leaves later session-list requests
 * unanswered, which stops the periodic refresh.
 */
async function fakePortal(page, { profile = null } = {}) {
    const events = { [SID_A]: [], [SID_B]: [] };
    const sends = [];
    const sockets = [];
    const subscriptions = [];
    let hold = false;
    await page.routeWebSocket("**/api/v1/ws", (ws) => {
        sockets.push(ws);
        ws.onMessage((raw) => {
            const message = JSON.parse(raw);
            if (message.type === "subscribeSession") subscriptions.push(message.sessionId);
        });
    });
    await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const answer = (result) => route.fulfill({ json: { ok: true, result } });
        if (hold && url.pathname.endsWith("/management/sessions") && request.method() === "GET") return;
        if (profile && url.pathname.endsWith("/me/profile/settings")) return answer({ profileSettings: request.postDataJSON().settings });
        if (profile && url.pathname.endsWith("/me/profile")) return answer({ isAdmin: false, profileSettings: profile });
        const send = /\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
        if (send) {
            sends.push({ sessionId: send[1], ...request.postDataJSON() });
            return answer({ queued: true });
        }
        const read = /\/management\/sessions\/([^/]+)\/events$/.exec(url.pathname);
        if (read && events[read[1]]) {
            const after = Number(url.searchParams.get("afterSeq") || 0);
            return answer(events[read[1]].filter((event) => event.seq > after));
        }
        return route.fallback();
    });
    return {
        sends,
        subscriptions: (sessionId) => subscriptions.filter((id) => id === sessionId).length,
        holdRefresh() { hold = true; },
        /** The server records the last sent message: its receipt, readable from the events route only. */
        recordReceipt() {
            const { sessionId, prompt, options } = sends.at(-1);
            events[sessionId].push({ sessionId, seq: 100 + events[sessionId].length, eventType: "user.message",
                createdAt: new Date().toISOString(), data: { content: prompt, clientMessageIds: options.clientMessageIds } });
        },
        dropSockets() { for (const ws of sockets.splice(0)) ws.close(); },
    };
}

const queuedLine = (page) => page.locator(".ps-panel-bottom-sticky", { hasText: "queued prompts" });

async function sendFromMainChat(page, portal, sessionId, text) {
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    await expect.poll(() => portal.subscriptions(sessionId)).toBeGreaterThan(0);
    await page.getByTestId("composer-input").fill(text);
    await page.getByTestId("composer-input").press("Enter");
    await expect(queuedLine(page)).toHaveCount(1);
    expect(portal.sends.map((send) => send.sessionId)).toEqual([sessionId]);
}

test("a receipt recorded during a reconnect gap clears the queued item when the socket comes back", async ({ page }) => {
    const portal = await fakePortal(page);
    await sendFromMainChat(page, portal, SID_A, "sent during a gap");
    portal.holdRefresh();
    const before = portal.subscriptions(SID_A);
    portal.dropSockets();
    portal.recordReceipt();
    await expect.poll(() => portal.subscriptions(SID_A), FAST).toBeGreaterThan(before);
    await expect(queuedLine(page)).toHaveCount(0, FAST);
});

test("a MoA panel whose history holds the receipt clears the queued item", async ({ page }) => {
    const profile = { themeId: "terminal-green", moa: { version: 2, aspectRatio: 2, composerMode: "shared",
        tree: { id: "split", type: "split", direction: "row", ratio: 50,
            first: { id: "pa", type: "chat", sessionId: SID_A }, second: { id: "pb", type: "chat", sessionId: SID_B } } } };
    const portal = await fakePortal(page, { profile });
    await sendFromMainChat(page, portal, SID_B, "queued before the panel opened");
    portal.holdRefresh();
    // The main chat moves on to another session; nothing reads session B now.
    await page.locator(`.ps-session-list-button[data-session-id="${SID_A}"]`).click();
    await expect(queuedLine(page)).toHaveCount(0);
    portal.recordReceipt();
    await page.getByRole("button", { name: "Master of Agents", exact: true }).click();
    const status = page.locator('[data-moa-panel="pb"] [aria-label="Session status"]');
    await expect(status).toBeVisible();
    await expect(status).not.toContainText("queued", FAST);
});

// While the images of a send upload, the Send button is busy (disabled,
// aria-busy, "Uploading…" or a spinner on a phone) and the draft stays.
for (const viewport of [{ name: "desktop", width: 1600, height: 950 }, { name: "phone", width: 390, height: 844 }]) {
    test(`${viewport.name}: Send is busy while the images upload; one message goes when they finish`, async ({ page }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const portal = await fakePortal(page);
        let releaseUpload;
        const uploadDone = new Promise((resolve) => { releaseUpload = resolve; });
        const uploads = [];
        await page.route("**/api/v1/sessions/*/artifacts/*", async (route) => {
            uploads.push(route.request().url());
            await uploadDone;
            return route.fulfill({ json: { ok: true, result: { filename: decodeURIComponent(route.request().url().split("/").pop()), sizeBytes: 3 } } });
        });
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${SID_A}`);
        await expect.poll(() => portal.subscriptions(SID_A)).toBeGreaterThan(0);
        const input = page.getByTestId("composer-input");
        await input.fill("look at these two pictures");
        const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
        await page.locator('.ps-prompt-shell input[type="file"]').setInputFiles([
            { name: "one.png", mimeType: "image/png", buffer: png },
            { name: "two.png", mimeType: "image/png", buffer: png },
        ]);
        const send = page.getByTestId("composer-send");
        await send.click();
        await expect.poll(() => uploads.length).toBeGreaterThan(0);
        await expect(send).toBeDisabled();
        await expect(send).toHaveAttribute("aria-busy", "true");
        await expect(send).toHaveAttribute("data-state", "uploading");
        if (viewport.name === "desktop") await expect(send).toContainText("Uploading…");
        else await expect(send.locator(".ps-send-spinner")).toBeVisible();
        await expect(input).toHaveValue("look at these two pictures");
        await input.press("Enter");
        const file = test.info().outputPath(`upload-busy-${viewport.name}.png`);
        await page.screenshot({ path: file });
        if (process.env.PS_UX_SHOTS_DIR) {
            fs.mkdirSync(process.env.PS_UX_SHOTS_DIR, { recursive: true });
            fs.copyFileSync(file, path.join(process.env.PS_UX_SHOTS_DIR, `upload-busy-${viewport.name}.png`));
        }
        releaseUpload();
        await expect.poll(() => portal.sends.length).toBe(1);
        await expect(send).toBeEnabled();
        await expect(send).not.toHaveAttribute("aria-busy", "true");
        expect(portal.sends[0].prompt).toContain("look at these two pictures");
    });
}
