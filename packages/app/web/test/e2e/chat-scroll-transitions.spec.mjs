// Chat transcript scroll position must survive view transitions — phone (390px)
// and desktop (1440px) — both when scrolled to the middle and when following
// new messages at the bottom.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const browserName = process.env.PS_TEST_BROWSER || "chromium";
test.use({ browserName });

const SESSION_ID = "11111110-2222-3333-4444-555555555550";
const PARA = "The distributed state transition persisted across multiple worker restarts without losing the reader's place in the conversation. "
    + "Checking line wrapping and scroll anchoring across narrow mobile viewports and wide desktop columns.";

const ARTIFACT_A = {
    filename: "report-a.md",
    contentType: "text/markdown",
    content: "# Report A\n\nSummary of findings for report A.\n",
};
const ARTIFACT_B = {
    filename: "report-b.md",
    contentType: "text/markdown",
    content: "# Report B\n\nDetailed follow-up notes for report B.\n",
};
const ARTIFACTS = [ARTIFACT_A, ARTIFACT_B].map((a, index) => ({
    filename: a.filename,
    contentType: a.contentType,
    sizeBytes: Buffer.byteLength(a.content),
    uploadedAt: `2026-11-27T08:0${index}:00.000Z`,
    source: "agent",
    isBinary: false,
}));

function buildTranscript(sessionId, count = 48) {
    const events = [];
    let seq = 1;
    for (let i = 0; i < count; i++) {
        const isUser = i % 2 === 0;
        let content;
        if (isUser) {
            content = `User turn ${i}: inspect section ${i} and verify scroll anchoring.`;
        } else if (i === 21) {
            content = `**Assessment ${i}**\n\nSee [report-a.md](artifact://${sessionId}/report-a.md) for the first report.\n\n${PARA}`;
        } else if (i === count - 1) {
            content = `**Assessment ${i}**\n\nFinal summary in [report-b.md](artifact://${sessionId}/report-b.md).\n\n${PARA}`;
        } else {
            content = `**Assessment ${i}**\n\n${PARA}\n\n- Detail ${i}.1\n- Detail ${i}.2`;
        }
        events.push({
            seq: seq++,
            eventType: isUser ? "user.message" : "assistant.message",
            timestamp: 1785000000000 + (seq * 1000),
            data: { content },
        });
        if (!isUser) {
            events.push({
                seq: seq++,
                eventType: "session.turn_completed",
                timestamp: 1785000000000 + (seq * 1000),
                data: { resultType: "completed" },
            });
        }
    }
    return events;
}

let stub;
test.beforeAll(async () => {
    stub = await startStubServer(0, { sessionCount: 3, admin: true });
});
test.afterAll(async () => {
    await new Promise((resolve) => stub.server.close(resolve));
});

async function setupSession(page, viewport, { eventsRef = null } = {}) {
    const events = buildTranscript(SESSION_ID, 48);
    if (eventsRef) eventsRef.events = events;

    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        const pathname = url.pathname;
        if (pathname.endsWith("/bootstrap")) {
            return route.fulfill({
                json: {
                    ok: true,
                    result: {
                        mode: "remote",
                        workerCount: 1,
                        defaultModel: "github-copilot:claude-sonnet-5",
                        modelsByProvider: [],
                        auth: {
                            principal: { provider: "none", subject: "test", email: "test@example.com", displayName: "Test User" },
                            authorization: { allowed: true, role: "admin" },
                        },
                    },
                },
            });
        }
        if (/\/sessions\/[^/]+\/events$/.test(pathname)) {
            const afterSeq = Number(url.searchParams.get("afterSeq") || 0);
            const list = eventsRef ? eventsRef.events : events;
            const filtered = afterSeq > 0 ? list.filter((e) => e.seq > afterSeq) : list;
            return route.fulfill({ json: { ok: true, result: filtered } });
        }
        if (/\/artifacts$/.test(pathname)) {
            return route.fulfill({ json: { ok: true, result: ARTIFACTS } });
        }
        for (const art of [ARTIFACT_A, ARTIFACT_B]) {
            if (pathname.endsWith(`/artifacts/${art.filename}/meta`)) {
                const entry = ARTIFACTS.find((a) => a.filename === art.filename);
                return route.fulfill({ json: { ok: true, result: entry } });
            }
            if (pathname.endsWith(`/artifacts/${art.filename}/text`)) {
                return route.fulfill({ json: { ok: true, result: art.content } });
            }
            if (pathname.endsWith(`/artifacts/${art.filename}/download`)) {
                return route.fulfill({ contentType: art.contentType, body: art.content });
            }
        }
        return route.fallback();
    });

    await page.setViewportSize(viewport);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${SESSION_ID}`);
    const scroller = page.locator(".ps-chat-panel .ps-scroll-panel").first();
    await expect(scroller).toBeVisible({ timeout: 15_000 });
    await expect(scroller).toContainText("Assessment 47", { timeout: 15_000 });
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(600);
    // Let initial bottom-follow settle.
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(12);
    return scroller;
}

async function scrollToMiddleArtifact(page, scroller) {
    // Scroll so the middle artifact card (in Assessment 21) is comfortably inside the viewport.
    await scroller.evaluate((el) => {
        const card = el.querySelector(".ps-artifact-card");
        if (card) {
            const top = card.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
            el.scrollTop = Math.max(200, Math.round(top - el.clientHeight * 0.35));
        } else {
            el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) * 0.45);
        }
        el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    // Wait a couple frames for scroll state + layout to settle.
    await page.waitForTimeout(150);
    const before = await scroller.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const card = el.querySelector(".ps-artifact-card");
        const cardTop = card ? Math.round(card.getBoundingClientRect().top - rect.top) : null;
        return {
            scrollTop: Math.round(el.scrollTop),
            maxScroll: Math.round(el.scrollHeight - el.clientHeight),
            cardTop,
        };
    });
    expect(before.scrollTop).toBeGreaterThan(200);
    expect(before.maxScroll - before.scrollTop).toBeGreaterThan(200);
    return before;
}

async function measureScroll(scroller) {
    return scroller.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const card = el.querySelector(".ps-artifact-card");
        const cardTop = card ? Math.round(card.getBoundingClientRect().top - rect.top) : null;
        return {
            scrollTop: Math.round(el.scrollTop),
            maxScroll: Math.round(el.scrollHeight - el.clientHeight),
            cardTop,
        };
    });
}

async function expectScrollRestored(page, scroller, before, label, tolerancePx = 24) {
    await expect(scroller).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(150);
    const after = await measureScroll(scroller);
    expect(
        Math.abs(after.scrollTop - before.scrollTop),
        `${label}: expected scrollTop ~${before.scrollTop} (±${tolerancePx}), got ${after.scrollTop} (before cardTop=${before.cardTop}, after cardTop=${after.cardTop})`,
    ).toBeLessThanOrEqual(tolerancePx);
    if (before.cardTop != null && after.cardTop != null) {
        expect(
            Math.abs(after.cardTop - before.cardTop),
            `${label}: expected cardTop ~${before.cardTop} (±${tolerancePx}), got ${after.cardTop}`,
        ).toBeLessThanOrEqual(tolerancePx);
    }
    return after;
}

async function expectAnchorRestored(page, scroller, before, label, tolerancePx = 28) {
    await expect(scroller).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(150);
    const after = await measureScroll(scroller);
    expect(after.scrollTop, `${label}: must not jump to top`).toBeGreaterThan(200);
    expect(
        Math.abs(after.cardTop - before.cardTop),
        `${label}: expected visible anchor cardTop ~${before.cardTop} (±${tolerancePx}), got ${after.cardTop} (scrollTop ${before.scrollTop} -> ${after.scrollTop})`,
    ).toBeLessThanOrEqual(tolerancePx);
    return after;
}

async function expectAtBottomAndFollows(page, scroller, eventsRef, label) {
    await expect(scroller).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop), {
        message: `${label}: expected chat to stay at bottom`,
    }).toBeLessThan(12);

    const nextSeq = eventsRef.events.length + 1;
    const marker = `LIVE_FOLLOW_MARKER_${nextSeq}`;
    eventsRef.events.push({
        seq: nextSeq,
        eventType: "assistant.message",
        timestamp: 1785000000000 + (nextSeq * 1000),
        data: { content: `**${marker}**\n\n${PARA}\n\n${PARA}` },
    });
    await expect(scroller).toContainText(marker, { timeout: 15_000 });
    await expect.poll(() => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop), {
        message: `${label}: expected chat to keep following new message to bottom`,
    }).toBeLessThan(12);
}

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const SCREENSHOT_DIR = process.env.PS_SCROLL_SCREENSHOT_DIR || "";

test.describe("phone (390px) chat scroll preservation across transitions", () => {
    test("artifact preview from chat -> close X keeps middle position", async ({ page }) => {
        const scroller = await setupSession(page, PHONE);
        const before = await scrollToMiddleArtifact(page, scroller);
        if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/phone-preview-before.png` });

        await scroller.locator(".ps-artifact-card").first().click();
        const overlay = page.locator(".ps-artifact-overlay");
        await expect(overlay).toBeVisible({ timeout: 15_000 });
        await expect(overlay).toContainText("Report A", { timeout: 15_000 });

        await overlay.getByRole("button", { name: /^Close/ }).click();
        await expect(overlay).toBeHidden();
        if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/phone-preview-after.png` });

        await expectScrollRestored(page, scroller, before, "phone artifact preview close");
    });

    test("artifact preview from chat -> step next/prev -> close X keeps middle position", async ({ page }) => {
        const scroller = await setupSession(page, PHONE);
        const before = await scrollToMiddleArtifact(page, scroller);

        await scroller.locator(".ps-artifact-card").first().click();
        const overlay = page.locator(".ps-artifact-overlay");
        await expect(overlay).toBeVisible({ timeout: 15_000 });
        await expect(overlay).toContainText("Report A", { timeout: 15_000 });

        await overlay.getByRole("button", { name: "Next artifact" }).click();
        await expect(overlay).toContainText("Report B", { timeout: 15_000 });
        await overlay.getByRole("button", { name: "Previous artifact" }).click();
        await expect(overlay).toContainText("Report A", { timeout: 15_000 });
        await overlay.getByRole("button", { name: "Next artifact" }).click();
        await expect(overlay).toContainText("Report B", { timeout: 15_000 });

        await overlay.getByRole("button", { name: /^Close/ }).click();
        await expect(overlay).toBeHidden();

        await expectScrollRestored(page, scroller, before, "phone artifact preview step+close");
    });

    test("artifact preview from chat -> close X stays at bottom and keeps following", async ({ page }) => {
        const eventsRef = { events: [] };
        const scroller = await setupSession(page, PHONE, { eventsRef });
        // Click the last artifact card (Assessment 47, at bottom of chat).
        await scroller.locator(".ps-artifact-card").last().click();
        const overlay = page.locator(".ps-artifact-overlay");
        await expect(overlay).toBeVisible({ timeout: 15_000 });
        await expect(overlay).toContainText("Report B", { timeout: 15_000 });

        await overlay.getByRole("button", { name: /^Close/ }).click();
        await expect(overlay).toBeHidden();

        await expectAtBottomAndFollows(page, scroller, eventsRef, "phone artifact preview close at bottom");
    });

    test("maximize (Enter mobile zen) -> exit maximize keeps middle position", async ({ page }) => {
        const scroller = await setupSession(page, PHONE);
        const before = await scrollToMiddleArtifact(page, scroller);
        if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/phone-zen-before.png` });

        await page.getByRole("button", { name: "Enter mobile zen" }).click();
        const zenScroller = page.locator(".ps-mobile-zen .ps-chat-panel .ps-scroll-panel").first();
        await expect(zenScroller).toBeVisible({ timeout: 15_000 });
        await expectAnchorRestored(page, zenScroller, before, "phone inside maximize (mobile zen)");

        await page.getByRole("button", { name: "Exit mobile zen" }).click();
        await expect(page.locator(".ps-mobile-zen")).toHaveCount(0);
        if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/phone-zen-after.png` });

        await expectScrollRestored(page, scroller, before, "phone exit maximize (mobile zen)");
    });

    test("maximize (Enter mobile zen) -> exit maximize stays at bottom and keeps following", async ({ page }) => {
        const eventsRef = { events: [] };
        const scroller = await setupSession(page, PHONE, { eventsRef });

        await page.getByRole("button", { name: "Enter mobile zen" }).click();
        const zenScroller = page.locator(".ps-mobile-zen .ps-chat-panel .ps-scroll-panel").first();
        await expect(zenScroller).toBeVisible({ timeout: 15_000 });
        await expect.poll(() => zenScroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(12);

        await page.getByRole("button", { name: "Exit mobile zen" }).click();
        await expect(page.locator(".ps-mobile-zen")).toHaveCount(0);

        await expectAtBottomAndFollows(page, scroller, eventsRef, "phone exit maximize at bottom");
    });

    test("maximize (Enter mobile zen) -> tap artifact link opens preview -> close X returns to maximized chat at same position", async ({ page }) => {
        const scroller = await setupSession(page, PHONE);
        const before = await scrollToMiddleArtifact(page, scroller);

        await page.getByRole("button", { name: "Enter mobile zen" }).click();
        const zenScroller = page.locator(".ps-mobile-zen .ps-chat-panel .ps-scroll-panel").first();
        await expect(zenScroller).toBeVisible({ timeout: 15_000 });
        const beforeInZen = await expectAnchorRestored(page, zenScroller, before, "phone inside maximize before artifact tap");
        if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/phone-zen-artifact-before.png` });

        // Tap the artifact card from inside maximized mobile chat.
        await zenScroller.locator(".ps-artifact-card").first().click();
        const overlay = page.locator(".ps-artifact-overlay");
        await expect(overlay).toBeVisible({ timeout: 5_000 });
        await expect(overlay).toContainText("Report A", { timeout: 5_000 });

        await overlay.getByRole("button", { name: /^Close/ }).click();
        await expect(overlay).toBeHidden();
        // Must STILL be in maximized mobile chat (MobileZen), NOT bounced back to normal layout.
        await expect(page.locator(".ps-mobile-zen")).toBeVisible();
        await expect(page.getByRole("button", { name: "Exit mobile zen" })).toBeVisible();
        if (SCREENSHOT_DIR) await page.screenshot({ path: `${SCREENSHOT_DIR}/phone-zen-artifact-after.png` });

        await expectScrollRestored(page, zenScroller, beforeInZen, "phone maximized chat artifact close", 12);
    });

    test("maximize (Enter mobile zen) -> tap artifact link at bottom -> close X stays maximized at bottom and follows", async ({ page }) => {
        const eventsRef = { events: [] };
        await setupSession(page, PHONE, { eventsRef });

        await page.getByRole("button", { name: "Enter mobile zen" }).click();
        const zenScroller = page.locator(".ps-mobile-zen .ps-chat-panel .ps-scroll-panel").first();
        await expect(zenScroller).toBeVisible({ timeout: 15_000 });
        await expect.poll(() => zenScroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(12);

        await zenScroller.locator(".ps-artifact-card").last().click();
        const overlay = page.locator(".ps-artifact-overlay");
        await expect(overlay).toBeVisible({ timeout: 5_000 });
        await expect(overlay).toContainText("Report B", { timeout: 5_000 });

        await overlay.getByRole("button", { name: /^Close/ }).click();
        await expect(overlay).toBeHidden();
        await expect(page.locator(".ps-mobile-zen")).toBeVisible();

        await expectAtBottomAndFollows(page, zenScroller, eventsRef, "phone maximized chat artifact close at bottom");
    });

    test("maximize (Enter mobile zen) -> agent show_artifact opens preview -> close X returns to maximized chat at same position", async ({ page }) => {
        const eventsRef = { events: [] };
        const scroller = await setupSession(page, PHONE, { eventsRef });
        const before = await scrollToMiddleArtifact(page, scroller);

        await page.getByRole("button", { name: "Enter mobile zen" }).click();
        const zenScroller = page.locator(".ps-mobile-zen .ps-chat-panel .ps-scroll-panel").first();
        await expect(zenScroller).toBeVisible({ timeout: 15_000 });
        const beforeInZen = await expectAnchorRestored(page, zenScroller, before, "phone inside maximize before show_artifact");

        const nextSeq = eventsRef.events.length + 1;
        eventsRef.events.push({
            seq: nextSeq,
            eventType: "session.artifact_presented",
            createdAt: new Date().toISOString(),
            timestamp: Date.now(),
            data: { filename: "report-a.md", fullscreen: false },
        });
        const overlay = page.locator(".ps-artifact-overlay");
        await expect(overlay).toBeVisible({ timeout: 10_000 });
        await expect(overlay).toContainText("Report A", { timeout: 10_000 });

        await overlay.getByRole("button", { name: /^Close/ }).click();
        await expect(overlay).toBeHidden();
        await expect(page.locator(".ps-mobile-zen")).toBeVisible();
        await expectScrollRestored(page, zenScroller, beforeInZen, "phone maximized chat show_artifact close", 12);
    });

    test("session slide-over open -> close keeps middle position", async ({ page }) => {
        const scroller = await setupSession(page, PHONE);
        const before = await scrollToMiddleArtifact(page, scroller);

        await page.getByRole("button", { name: "Sessions", exact: true }).click();
        await expect(page.locator(".ps-mobile-session-slideover.is-open")).toBeVisible();
        await page.getByRole("button", { name: "Hide the session list", exact: true }).click();
        await expect(page.locator(".ps-mobile-session-slideover.is-open")).toHaveCount(0);

        await expectScrollRestored(page, scroller, before, "phone session slide-over");
    });

    test("diagnostics (Inspector -> Files tab) -> back to chat keeps middle position", async ({ page }) => {
        const scroller = await setupSession(page, PHONE);
        const before = await scrollToMiddleArtifact(page, scroller);

        const diagBtn = page.locator('.ps-toolbar.is-mobile button[aria-label^="Diagnostics"]').first();
        await diagBtn.click();
        await expect(page.getByRole("button", { name: "Files" }).first()).toBeVisible();
        await page.getByRole("button", { name: "Files" }).first().click();
        await expect(page.getByText("report-a.md").first()).toBeVisible({ timeout: 15_000 });

        await diagBtn.click();
        await expectScrollRestored(page, scroller, before, "phone diagnostics Files -> chat");
    });

    test("canvas open -> close keeps middle position", async ({ page }) => {
        const scroller = await setupSession(page, PHONE);
        const before = await scrollToMiddleArtifact(page, scroller);

        await page.getByRole("button", { name: "Show canvas", exact: true }).click();
        await expect(page.getByRole("button", { name: "Hide the canvas", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Hide the canvas", exact: true }).click();

        await expectScrollRestored(page, scroller, before, "phone canvas toggle");
    });

    test("workflow tab open -> close keeps middle position", async ({ page }) => {
        const scroller = await setupSession(page, PHONE);
        const before = await scrollToMiddleArtifact(page, scroller);

        await page.getByRole("button", { name: "Workflow", exact: true }).click();
        await expect(page.getByRole("button", { name: "Hide the Workflow tab", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Hide the Workflow tab", exact: true }).click();

        await expectScrollRestored(page, scroller, before, "phone workflow toggle");
    });

    test("budget open -> close keeps middle position", async ({ page }) => {
        const scroller = await setupSession(page, PHONE);
        const before = await scrollToMiddleArtifact(page, scroller);

        await page.getByRole("button", { name: "Budget — providers, limits and usage", exact: true }).click();
        await expect(page.getByRole("button", { name: "Close budget", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Close budget", exact: true }).click();

        await expectScrollRestored(page, scroller, before, "phone budget toggle");
    });

    test("Master of Agents open -> back keeps middle position", async ({ page }) => {
        const scroller = await setupSession(page, PHONE);
        const before = await scrollToMiddleArtifact(page, scroller);

        await page.getByRole("button", { name: "Master of Agents", exact: true }).click();
        await expect(page.getByRole("button", { name: "Back to normal view", exact: true })).toBeVisible({ timeout: 15_000 });
        await page.getByRole("button", { name: "Back to normal view", exact: true }).click();

        await expectScrollRestored(page, scroller, before, "phone MoA toggle");
    });
});

test.describe("desktop (1440px) chat scroll preservation across transitions", () => {
    test("artifact preview from chat -> close X keeps middle position", async ({ page }) => {
        const scroller = await setupSession(page, DESKTOP);
        const before = await scrollToMiddleArtifact(page, scroller);

        await scroller.locator(".ps-artifact-card").first().click();
        const reader = page.locator(".ps-artifact-layer");
        await expect(reader).toBeVisible({ timeout: 15_000 });
        await expect(reader).toContainText("Report A", { timeout: 15_000 });

        await reader.getByRole("button", { name: "Close artifact" }).click();
        await expect(reader).toHaveCount(0);

        await expectScrollRestored(page, scroller, before, "desktop artifact preview close");
    });

    test("artifact preview from chat -> step next -> full screen -> close X keeps middle position", async ({ page }) => {
        const scroller = await setupSession(page, DESKTOP);
        const before = await scrollToMiddleArtifact(page, scroller);

        await scroller.locator(".ps-artifact-card").first().click();
        const reader = page.locator(".ps-artifact-layer");
        await expect(reader).toBeVisible({ timeout: 15_000 });
        await expect(reader).toContainText("Report A", { timeout: 15_000 });

        await reader.getByRole("button", { name: "Next artifact" }).click();
        await expect(reader).toContainText("Report B", { timeout: 15_000 });

        await reader.getByRole("button", { name: "Full screen preview" }).click();
        await expect(reader).toHaveClass(/is-maximized/);

        await reader.getByRole("button", { name: "Close artifact" }).click();
        await expect(reader).toHaveCount(0);

        await expectScrollRestored(page, scroller, before, "desktop artifact step+fullscreen+close");
    });

    test("artifact preview from chat -> close X stays at bottom and keeps following", async ({ page }) => {
        const eventsRef = { events: [] };
        const scroller = await setupSession(page, DESKTOP, { eventsRef });

        await scroller.locator(".ps-artifact-card").last().click();
        const reader = page.locator(".ps-artifact-layer");
        await expect(reader).toBeVisible({ timeout: 15_000 });
        await expect(reader).toContainText("Report B", { timeout: 15_000 });

        await reader.getByRole("button", { name: "Close artifact" }).click();
        await expect(reader).toHaveCount(0);

        await expectAtBottomAndFollows(page, scroller, eventsRef, "desktop artifact preview close at bottom");
    });

    test("canvas open -> close keeps middle position", async ({ page }) => {
        const scroller = await setupSession(page, DESKTOP);
        const before = await scrollToMiddleArtifact(page, scroller);

        await page.getByRole("button", { name: "Show canvas", exact: true }).click();
        await expect(page.getByRole("button", { name: "Hide the canvas", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Hide the canvas", exact: true }).click();

        await expectScrollRestored(page, scroller, before, "desktop canvas toggle");
    });

    test("budget open -> close keeps middle position", async ({ page }) => {
        const scroller = await setupSession(page, DESKTOP);
        const before = await scrollToMiddleArtifact(page, scroller);

        await page.getByRole("button", { name: "Budget — providers, limits and usage", exact: true }).click();
        await expect(page.getByRole("button", { name: "Close budget", exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Close budget", exact: true }).click();

        await expectScrollRestored(page, scroller, before, "desktop budget toggle");
    });

    test("Admin console open -> close keeps middle position", async ({ page }) => {
        const scroller = await setupSession(page, DESKTOP);
        const before = await scrollToMiddleArtifact(page, scroller);

        await page.getByRole("button", { name: "Admin console", exact: true }).click();
        await expect(page.getByRole("button", { name: /^Close admin console$/i })).toBeVisible({ timeout: 15_000 });
        await page.getByRole("button", { name: /^Close admin console$/i }).click();

        await expectScrollRestored(page, scroller, before, "desktop admin console toggle");
    });

    test("Master of Agents open -> back to workspace keeps middle position", async ({ page }) => {
        const scroller = await setupSession(page, DESKTOP);
        const before = await scrollToMiddleArtifact(page, scroller);

        await page.getByRole("button", { name: "Master of Agents", exact: true }).click();
        await expect(page.getByRole("button", { name: "Sessions — session list, chat and panels", exact: true })).toBeVisible({ timeout: 15_000 });
        await page.getByRole("button", { name: "Sessions — session list, chat and panels", exact: true }).click();

        await expectScrollRestored(page, scroller, before, "desktop MoA toggle");
    });

    test("list-opened preview on phone still returns to Files list, not chat", async ({ page }) => {
        await setupSession(page, PHONE);
        const diagBtn = page.locator('.ps-toolbar.is-mobile button[aria-label^="Diagnostics"]').first();
        await diagBtn.click();
        await page.getByRole("button", { name: "Files" }).first().click();
        await page.getByText("report-a.md").first().click();
        const overlay = page.locator(".ps-artifact-overlay");
        await expect(overlay).toBeVisible({ timeout: 15_000 });
        await expect(overlay).toContainText("Report A", { timeout: 15_000 });

        await overlay.getByRole("button", { name: "Close, back to artifacts" }).click();
        await expect(overlay).toBeHidden();
        // Should remain on Diagnostics / Files list, NOT jump to chat.
        await expect(diagBtn).toHaveAttribute("aria-label", "Diagnostics — back to the chat");
    });
});
