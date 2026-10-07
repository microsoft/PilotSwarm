import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { normalizeMoa } from "../../../ui/core/src/moa.js";

const sid = "11111110-2222-3333-4444-555555555550";
const receipt = { schemaVersion: 1, sessionId: sid, requestId: "retained", clientRequestId: "original",
    expectedTarget: "old", sequence: 1, acceptedAt: new Date(1).toISOString(), revision: 1,
    text: "Retained guidance", actor: { provider: "none", subject: "test" }, status: "closed",
    disposition: "not_delivered_turn_ended", eligibility: { state: "terminal" },
    actions: { canWithdraw: false, canSendAsNewMessage: true } };
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });
const url = () => `http://127.0.0.1:${stub.port}/?session=${sid}`;
const state = (over = {}) => ({ supported: true, canWrite: true, steerable: true, recovering: false,
    expectedTarget: "new", windowSeq: 2, limits: { maxBytes: 8192 }, ...over });

test("new open-window event clears recovery only through one authoritative read", async ({ page }) => {
    let reads = 0, socket;
    await page.routeWebSocket("**/api/v1/ws", ws => { socket = ws; });
    await page.route("**/steering-state", route => route.fulfill({ json: { ok: true, result: state(
        ++reads === 1 ? { recovering: true, steerable: false, windowSeq: 1 } : {}) } }));
    await page.route("**/steering?*", route => route.fulfill({ json: { ok: true, result: { items: [], nextCursor: null } } }));
    await page.goto(url());
    await page.getByTestId("session-prompt").fill("New guidance");
    const button = page.getByRole("button", { name: "Steer current turn", exact: true });
    await expect(button).toBeDisabled();
    await expect.poll(() => Boolean(socket)).toBe(true);
    socket.send(JSON.stringify({ type: "sessionEvent", sessionId: sid, event: {
        sessionId: sid, seq: 2, eventType: "session.steering_window_changed",
        data: { schemaVersion: 1, state: "open", expectedTarget: "new" },
    } }));
    await expect(button).toBeEnabled();
    expect(reads).toBe(2);
});

test("receipt reads outside recent history stay separate and expose a partial page", async ({ page }) => {
    await page.route("**/steering-state", route => route.fulfill({ json: { ok: true, result: state() } }));
    await page.route("**/steering?*", route => route.fulfill({ json: { ok: true, result:
        new URL(route.request().url()).searchParams.has("cursor")
            ? { items: [{ ...receipt, requestId: "second", sequence: 2, text: "Second old guidance" }], nextCursor: null }
            : { items: [receipt], nextCursor: "next-page" } } }));
    await page.route(`**/sessions/${sid}/events?*`, route => route.fulfill({ json: { ok: true, result: [{
        sessionId: sid, seq: 50, eventType: "user.message", createdAt: Date.now(), data: { content: "Recent ordinary input" },
    }] } }));
    await page.goto(url());
    const chat = page.locator(".ps-chat-panel .ps-scroll-panel");
    await expect(chat).toContainText("Recent ordinary input");
    await expect(chat).not.toContainText("Retained guidance");
    const archive = page.locator(".ps-steering-archive");
    await archive.locator("summary").first().click();
    await expect(archive).toContainText("Partial receipt list");
    await archive.getByRole("button", { name: "Load more guidance", exact: true }).click();
    await expect(archive).toContainText("Second old guidance");
    await expect(archive.getByRole("button", { name: "Load more guidance" })).toHaveCount(0);
    await expect(chat).not.toContainText("Second old guidance");
});

test("two MoA panels retry one uncertain ordinary message identity", async ({ page }) => {
    const messages = [];
    await page.route("**/api/v1/me/profile", route => route.fulfill({ json: { ok: true, result: {
        isAdmin: false, profileSettings: { moa: normalizeMoa({ version: 3, activeDashboardId: "dash", dashboards: [{
            id: "dash", name: "Review", focusedPanelId: "a", tree: { id: "root", type: "split", direction: "row", ratio: 50,
                first: { id: "a", type: "chat", sessionId: sid }, second: { id: "b", type: "chat", sessionId: sid } },
        }] }) },
    } } }));
    await page.route("**/steering-state", route => route.fulfill({ json: { ok: true, result: state() } }));
    await page.route("**/steering?*", route => route.fulfill({ json: { ok: true, result: { items: [receipt], nextCursor: null } } }));
    await page.route("**/steering/retained", route => route.fulfill({ json: { ok: true, result: receipt } }));
    await page.route(`**/sessions/${sid}/events?*`, route => route.fulfill({ json: { ok: true, result: [
        { sessionId: sid, seq: 1, eventType: "session.steering_accepted", data: { receipt } },
    ] } }));
    await page.route(`**/sessions/${sid}/messages`, route => {
        messages.push(route.request().postDataJSON());
        return messages.length === 1 ? route.abort("failed") : route.fulfill({ json: { ok: true, result: {} } });
    });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(url());
    await page.getByRole("button", { name: "Master of Agents", exact: true }).click();
    const a = page.locator('[data-moa-panel="a"]'), b = page.locator('[data-moa-panel="b"]');
    await a.getByRole("button", { name: "Send as new message", exact: true }).click();
    await b.getByText("Delivery details", { exact: true }).click();
    await expect(b).toContainText("New-message enqueue unconfirmed");
    await b.getByRole("button", { name: "Send as new message", exact: true }).click();
    await expect.poll(() => messages.length).toBe(2);
    expect(messages[1].options.clientMessageIds).toEqual(messages[0].options.clientMessageIds);
});
