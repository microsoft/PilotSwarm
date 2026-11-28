import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { collectPageErrors } from "./page-errors.mjs";

const SESSION = "11111110-2222-3333-4444-555555555550";
const OWNER = { kind: "user", provider: "dev", subject: "owner", display: "Affan Dar", relation: "owner" };

let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

test("portal renders merged canvas action + typed text as a canvas card and a user message", async ({ page }) => {
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));

    const sockets = [];
    const sends = [];
    let subscribed = false;

    await page.routeWebSocket("**/api/v1/ws", (socket) => {
        sockets.push(socket);
        socket.onMessage((raw) => {
            const msg = JSON.parse(raw);
            if (msg.type === "subscribeSession" && msg.sessionId === SESSION) subscribed = true;
        });
    });

    const bulkEvent = {
        sessionId: SESSION,
        seq: 1,
        eventType: "user.message",
        createdAt: new Date("2026-11-27T06:43:00Z").toISOString(),
        data: {
            content: '[canvas-action] {"action":"decide","data":{"id":"i7-answers","choice":"accept-all"}}\n\nok what was the thing I wanted to discuss?',
            sender: OWNER,
            clientMessageIds: ["msg-bulk-1"],
        },
    };

    await page.route("**/api/v1/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const answer = (result) => route.fulfill({ json: { ok: true, result } });
        if (url.pathname.endsWith(`/sessions/${SESSION}/messages`) && request.method() === "POST") {
            sends.push(request.postDataJSON());
            return answer({ queued: true });
        }
        if (url.pathname.endsWith(`/management/sessions/${SESSION}/events`)) {
            const after = Number(url.searchParams.get("afterSeq") || 0);
            return answer(after < 1 ? [bulkEvent] : []);
        }
        if (url.pathname.endsWith(`/management/sessions/${SESSION}/events-before`)) {
            return answer([]);
        }
        return route.fallback();
    });

    await page.goto(`http://127.0.0.1:${stub.port}/?session=${SESSION}`);
    await expect.poll(() => subscribed).toBe(true);

    const cards = page.locator("details.ps-canvas-action");
    const userBubbles = page.getByTestId("transcript-user-message");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("decide");
    await expect(userBubbles).toHaveCount(1);
    await expect(userBubbles.first()).toContainText("ok what was the thing I wanted to discuss?");
    await expect(userBubbles.first()).not.toContainText("[canvas-action]");

    // Now type a follow-up while busy, then deliver a live merged turn combining
    // a canvas press and that typed message.
    await page.getByTestId("composer-input").fill("follow-up typed note");
    await page.getByTestId("composer-input").press("Enter");
    await expect.poll(() => sends.length).toBe(1);
    const sentIds = sends[0].options?.clientMessageIds || [];
    expect(sentIds.length).toBe(1);

    const liveEvent = {
        sessionId: SESSION,
        seq: 2,
        eventType: "user.message",
        createdAt: new Date("2026-11-27T06:44:00Z").toISOString(),
        data: {
            content: '[canvas-action] {"action":"approve","data":{"step":2}}\n\nfollow-up typed note',
            sender: OWNER,
            clientMessageIds: sentIds,
        },
    };
    for (const socket of sockets) {
        socket.send(JSON.stringify({ type: "sessionEvent", sessionId: SESSION, event: liveEvent }));
    }

    await expect(cards).toHaveCount(2);
    await expect(cards.nth(1)).toContainText("approve");
    await expect(userBubbles).toHaveCount(2);
    await expect(userBubbles.nth(1)).toContainText("follow-up typed note");
    await expect(userBubbles.nth(1)).not.toContainText("[canvas-action]");
    await expect(page.locator(".ps-panel-bottom-sticky", { hasText: "queued prompts" })).toHaveCount(0);
    expect(errors).toEqual([]);
});
