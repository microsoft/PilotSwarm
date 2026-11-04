import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

// Activity tiles (tool runs, artifact cards, Thought disclosures) share one
// left edge in the transcript, and none of them may push the chat wider than
// its pane. A long artifact name once made its card as wide as the name,
// so a phone's whole chat scrolled sideways.
test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
const sessionId = "11111110-2222-3333-4444-555555555550";
const longName = "wfv2-interface-worker-mcp-090ad919-r1-results-file-with-every-detail-in-the-name.tgz";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1, transcriptTurns: 0 }); });
test.afterAll(async () => { if (stub) await new Promise(resolve => stub.server.close(resolve)); });

async function mount(page, { reading = null, viewport }) {
    const entries = [
        ["user.message", { content: "Run the interface tests" }],
        ["tool.execution_start", { toolName: "bash", toolCallId: "b1", arguments: { command: "npm test" } }],
        ["tool.execution_complete", { toolName: "bash", toolCallId: "b1", success: true, result: "ok" }],
        ["tool.execution_start", { toolName: "view", toolCallId: "v1", arguments: { path: "README.md" } }],
        ["tool.execution_complete", { toolName: "view", toolCallId: "v1", success: true, result: "ok" }],
        ["assistant.message", { messageId: "m1", reasoningText: "The results are in one archive.",
            content: `The results are in [the archive](artifact://${sessionId}/${longName}).` }],
        ["session.turn_completed", { resultType: "completed" }],
    ];
    const events = entries.map(([eventType, data], i) => ({ sessionId, seq: i + 1, eventType, data, createdAt: Date.now() - 10000 + i * 100 }));
    await page.route("**/api/v1/**", route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/me/profile")) return route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: {
            themeId: "hearth", touchScale: false, touchScaleMobile: true, ...(reading ? { chatReading: reading } : {}),
            moa: { version: 2, tree: { id: "chat", type: "chat", sessionId } },
        } } } });
        if (url.pathname.endsWith("/me/profile/settings")) return route.fulfill({ json: { ok: true, result: {} } });
        if (url.pathname.endsWith("/events")) return route.fulfill({ json: { ok: true, result: events.filter(e => e.seq > Number(url.searchParams.get("afterSeq") || 0)) } });
        return route.fallback();
    });
    await page.setViewportSize(viewport);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    const panel = page.locator(".ps-chat-panel .ps-scroll-panel").first();
    await expect(panel.locator(".ps-artifact-card")).toBeVisible();
    await expect(panel.locator(".ps-activity-run")).toBeVisible();
    await expect(panel.locator(".is-live-reasoning")).toBeVisible();
    return panel;
}

const edges = panel => panel.evaluate(node => {
    const left = selector => node.querySelector(selector).getBoundingClientRect().left;
    const card = node.querySelector(".ps-artifact-card"), title = node.querySelector(".ps-artifact-card-title");
    return {
        run: left(".ps-activity-run"), card: left(".ps-artifact-card"), thought: left(".is-live-reasoning"),
        cardRight: card.getBoundingClientRect().right,
        paneRight: node.getBoundingClientRect().left + node.clientWidth,
        scrollWidth: node.scrollWidth, clientWidth: node.clientWidth,
        titleClipped: title.scrollWidth > title.clientWidth,
    };
});

for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) test(`phone ${viewport.width}px: a long artifact name never widens the chat`, async ({ page }) => {
    const panel = await mount(page, { viewport });
    const e = await edges(panel);
    expect(e.scrollWidth).toBeLessThanOrEqual(e.clientWidth);
    expect(e.cardRight).toBeLessThanOrEqual(e.paneRight);
    expect(e.titleClipped).toBe(true);
    expect(Math.abs(e.card - e.run)).toBeLessThanOrEqual(1);
    expect(Math.abs(e.thought - e.run)).toBeLessThanOrEqual(1);
});

test("desktop: tool runs, artifact cards and Thought share one left edge", async ({ page }) => {
    const panel = await mount(page, { viewport: { width: 1440, height: 900 } });
    const e = await edges(panel);
    expect(Math.abs(e.card - e.run)).toBeLessThanOrEqual(1);
    expect(Math.abs(e.thought - e.run)).toBeLessThanOrEqual(1);
    expect(e.scrollWidth).toBeLessThanOrEqual(e.clientWidth);
});

test("desktop reading column: nested tiles align with tool runs", async ({ page }) => {
    const panel = await mount(page, { viewport: { width: 1600, height: 900 }, reading: { on: true, pad: 16, align: "left", width: 1100 } });
    await expect(page.locator(".ps-chat-panel.is-reading")).toBeVisible();
    const e = await edges(panel);
    expect(Math.abs(e.card - e.run)).toBeLessThanOrEqual(1);
    expect(Math.abs(e.thought - e.run)).toBeLessThanOrEqual(1);
    expect(e.scrollWidth).toBeLessThanOrEqual(e.clientWidth);
});
