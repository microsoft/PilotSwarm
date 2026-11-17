// Plan 4: the desktop session list shows every name in full and scrolls sideways, one axis at a time.
//
// WHY THIS EXISTS: the desktop list cut a long name with "…" and pinned the [+N] badge and the context % to the column's
// edge, so the part of the name a person was looking for was the part they could not read. Now a row shows its full
// title, then its suffixes in one line (F1): the Workflows mark, a Workflow's state chip, the [+N] badge, the pause and
// timer marks, the context %. Every row of the list is as wide as the widest one (F2), and the list pans sideways when
// that is wider than the column. As on the phone there are two native scrollers, one axis each (F3): the list scrolls up
// and down, and a track inside it pans every row sideways together, so a sideways gesture never moves the list up or down
// and an up-and-down one never moves it sideways. Selecting, the keyboard and search keep the sideways position (F4), and
// the list stays fast at 1,500 sessions (F6).
//
// Run (from packages/app, after `npm run build:web`):
//   npx playwright test --config=web/playwright.config.mjs web/test/e2e/session-list-full-names.spec.mjs
// PS_E2E_SHOTS=<dir> saves the list with a long name scrolled to the start and to the end.
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { collectPageErrors } from "./page-errors.mjs";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
const SHOTS = process.env.PS_E2E_SHOTS || null;

const LONG = "bbbb0000-0000-4000-8000-000000000001";
const FLOW = "bbbb0000-0000-4000-8000-000000000002";
const KID = "bbbb0000-0000-4000-8000-000000000003";
const LONG_TITLE = "Quarterly release readiness review for the storage, networking and identity teams, with every follow-up";
const OWNER = { provider: "none", subject: "test", email: "test@example.com", displayName: "Test User" };
const member = (sessionId, title, extra = {}) => ({
    viewerGroupId: null, sessionId, title, status: "idle", model: "github-copilot:claude-sonnet-5", agentId: null, isSystem: false,
    owner: OWNER, parentSessionId: null, createdAt: 1785000002000, updatedAt: 1785000002000,
    contextUsage: { currentTokens: 150_000, tokenLimit: 200_000 }, ...extra,
});
// Every suffix a row can carry. LONG: the Workflows mark (it has a Workflow child), the [+N] badge (its children are
// hidden while it is closed), a budget pause, a timer and the context %. FLOW: a Workflow's state chip, then a pause.
const FULL_NAMES = [
    member(LONG, LONG_TITLE, { status: "waiting", pauseState: { kind: "hold" }, cronActive: true, cronInterval: 3600 }),
    member(FLOW, "Workflow: nightly-build", { parentSessionId: LONG, sessionKind: "workflow", status: "waiting",
        pauseState: { kind: "hold" }, createdAt: 1785000002100, updatedAt: 1785000002100 }),
    member(KID, "Log reader", { parentSessionId: LONG, createdAt: 1785000002200, updatedAt: 1785000002200 }),
];

let stub, base;
test.beforeAll(async () => {
    // 60 sessions, so the list scrolls up and down as well as sideways.
    stub = await startStubServer(0, { sessionCount: 60, extraSessions: FULL_NAMES });
    base = `http://127.0.0.1:${stub.port}`;
});
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

/** The profile; `collapsedSessionIds: []` opens every parent, so a Workflow row is in the list. */
async function routeProfile(page, settings = {}) {
    await page.route("**/api/v1/me/profile/settings", (route) => route.fulfill({ json: { ok: true, result: { profileSettings: settings } } }));
    await page.route("**/api/v1/me/profile", (route) => route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: settings } } }));
}

const listOf = (page) => page.locator(".ps-workspace-main-grid .ps-session-pane .ps-session-list").first();
const rowOf = (scope, id) => scope.locator(`.ps-session-list-button[data-session-id="${id}"]`).first();

/** The list's sideways position: its track's, or the list's own where there is no track. */
const sideways = (list) => list.evaluate((el) => (el.querySelector(".ps-session-list-track") ?? el).scrollLeft);
const setSideways = (list, left) => list.evaluate((el, value) => { (el.querySelector(".ps-session-list-track") ?? el).scrollLeft = value; }, left);

/** Bring a row into the list's view by scrolling the list up or down only. */
const scrollRowIntoList = (list, id) => list.evaluate((el, rowId) => {
    const row = el.querySelector(`.ps-session-list-button[data-session-id="${rowId}"]`);
    const top = row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    el.scrollTop = Math.max(0, top - 40);
}, id);

/** Where each named part of a row is, in screen pixels: a selector's element, or the range of a text. */
const partsOf = (row, needles) => row.evaluate((button, wanted) => {
    const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right }; };
    const textBox = (text) => {
        const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const at = node.data.indexOf(text);
            if (at < 0) continue;
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + text.length);
            return box(range);
        }
        return null;
    };
    return wanted.map(([name, kind, value]) => {
        const element = kind === "selector" ? button.querySelector(value) : null;
        const found = kind === "text" ? textBox(value) : element ? box(element) : null;
        return found ? { name, left: Math.round(found.left), right: Math.round(found.right) } : { name, missing: true };
    });
}, needles);

/** Every element of a row that hides part of its content: what F1 forbids. */
const cutIn = (row) => row.evaluate((button) => [button, ...button.querySelectorAll("*")].filter((el) => {
    const style = getComputedStyle(el);
    return style.display !== "none" && (style.overflowX !== "visible" || style.textOverflow === "ellipsis")
        && el.scrollWidth > el.clientWidth + 1;
}).map((el) => `${el.className || el.tagName}: ${el.scrollWidth} > ${el.clientWidth}`));

/** The rows' widths against the list and its track (F2). */
const widthsOf = (list) => list.evaluate((el) => {
    const track = el.querySelector(".ps-session-list-track");
    const rows = [...el.querySelectorAll(".ps-session-list-button")].map((row) => row.getBoundingClientRect().width);
    return {
        rows: rows.length, min: Math.min(...rows), max: Math.max(...rows),
        trackClient: track ? track.clientWidth : null, trackScroll: track ? track.scrollWidth : null,
        listScrollX: el.scrollWidth - el.clientWidth,
    };
});

function expectInOrder(parts, label) {
    for (const part of parts) expect(part.missing, `${label}: ${part.name} is in the row (${JSON.stringify(parts)})`).toBeUndefined();
    for (let i = 1; i < parts.length; i += 1) {
        expect(parts[i].left, `${label}: ${parts[i].name} comes after ${parts[i - 1].name} (${JSON.stringify(parts)})`)
            .toBeGreaterThanOrEqual(parts[i - 1].right - 1);
    }
}

async function shot(page, name) {
    if (!SHOTS) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    await page.locator(".ps-workspace-main-grid .ps-session-pane").first().screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

for (const width of [1440, 1024]) test(`F1, F2: at ${width} px a row shows its full name and then every suffix, and all rows share one width`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    await routeProfile(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(base);
    const list = listOf(page);
    const long = rowOf(list, LONG);
    await expect(long).toContainText("[+2]");
    await scrollRowIntoList(list, LONG);

    // The parent, closed: its full title, then the mark, the badge, the pause, the timer and the context %.
    await expect(long.locator(".ps-session-row-title__text")).toHaveText(LONG_TITLE);
    expectInOrder(await partsOf(long, [
        ["title", "text", LONG_TITLE], ["Workflows mark", "selector", '[data-workflow-owner="true"]'], ["[+N]", "text", "[+2]"],
        ["pause", "text", "paused · hold"], ["timer", "text", "⏱"], ["context %", "text", "75%"],
    ]), `${width} parent`);
    expect(await cutIn(long), `${width}: nothing in the parent row is cut`).toEqual([]);

    // Every row is as wide as the widest, never narrower than the column; only the track pans sideways.
    const widths = await widthsOf(list);
    expect(widths.trackClient, `${width}: the rows are in a sideways track`).not.toBeNull();
    expect(widths.max - widths.min, `${width}: one width (${JSON.stringify(widths)})`).toBeLessThanOrEqual(1);
    expect(widths.min, `${width}: no row is narrower than the column (${JSON.stringify(widths)})`).toBeGreaterThanOrEqual(widths.trackClient - 1);
    expect(Math.abs(widths.max - widths.trackScroll), `${width}: the rows are as wide as the track's content (${JSON.stringify(widths)})`)
        .toBeLessThanOrEqual(1);
    expect(widths.trackScroll, `${width}: the long name makes the list pan sideways (${JSON.stringify(widths)})`).toBeGreaterThan(widths.trackClient + 20);
    expect(widths.listScrollX, `${width}: the list itself never pans sideways`).toBeLessThanOrEqual(1);

    // A row that fits keeps its context % at the column's right edge, where it is read without panning.
    const fits = await rowOf(list, "11111111-2222-3333-4444-555555555551").evaluate((row) => {
        const ctx = row.querySelector(".ps-session-row-ctx");
        const track = row.closest(".ps-session-list-track") ?? row.closest(".ps-session-list");
        return { ctxRight: Math.round(ctx.getBoundingClientRect().right), trackRight: Math.round(track.getBoundingClientRect().right) };
    });
    expect(fits.ctxRight, `${width}: a short row's % is on screen (${JSON.stringify(fits)})`).toBeLessThanOrEqual(fits.trackRight);
    expect(fits.ctxRight, `${width}: a short row's % sits at the column's right edge (${JSON.stringify(fits)})`).toBeGreaterThan(fits.trackRight - 24);

    if (width === 1440) {
        await shot(page, "plan4-long-name-start-1440");
        await setSideways(list, 100_000);
        await expect.poll(() => sideways(list)).toBeGreaterThan(20);
        await shot(page, "plan4-long-name-end-1440");
        await setSideways(list, 0);
    }

    // Open: the Workflow row shows its name, its state chip in full, then its pause.
    // The first click selects the parent; a click on the selected parent opens it.
    const flow = rowOf(list, FLOW);
    await rowOf(list, LONG).click({ position: { x: 40, y: 8 } });
    await page.waitForTimeout(400);
    if (!(await flow.isVisible())) await rowOf(list, LONG).click({ position: { x: 40, y: 8 } });
    await expect(flow).toBeVisible();
    await expect(flow.locator(".ps-wf-state")).toHaveText("Paused");
    expectInOrder(await partsOf(flow, [
        ["title", "selector", ".ps-session-row-title__text"], ["state chip", "selector", ".ps-wf-state"], ["pause", "text", "paused · hold"],
        ["context %", "text", "75%"],
    ]), `${width} Workflow`);
    expect(await cutIn(flow), `${width}: nothing in the Workflow row is cut`).toEqual([]);
    const opened = await widthsOf(list);
    expect(opened.max - opened.min, `${width} open: one width (${JSON.stringify(opened)})`).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
});

test("F3: a sideways gesture pans only sideways, an up-and-down one only scrolls up and down", async ({ page }) => {
    await routeProfile(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base);
    const list = listOf(page);
    await expect(rowOf(list, LONG)).toContainText("[+2]");
    await expect(list.locator(".ps-session-list-track"), "the rows are in a sideways track").toHaveCount(1);
    const box = await list.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const where = () => list.evaluate((el) => ({ top: el.scrollTop, left: (el.querySelector(".ps-session-list-track") ?? el).scrollLeft }));
    const START_TOP = 200;
    const reset = async (left = 0) => {
        await list.evaluate((el, x) => { el.scrollTop = 200; (el.querySelector(".ps-session-list-track") ?? el).scrollLeft = x; }, left);
        // A new gesture: the browser keeps a wheel gesture on one scroller until it has been quiet for a moment.
        await page.waitForTimeout(600);
        expect((await where()).top).toBe(START_TOP);
    };
    const settle = async () => { await page.waitForTimeout(400); return where(); };
    const measured = {};

    // One mostly sideways wheel event with a little vertical noise.
    await reset();
    await page.mouse.wheel(120, 8);
    await expect.poll(async () => (await where()).left).toBeGreaterThan(0);
    measured.sideways = await settle();
    expect(measured.sideways.top, "a sideways gesture does not move the list up or down").toBe(START_TOP);

    // One vertical wheel event.
    await reset();
    await page.mouse.wheel(0, 120);
    await expect.poll(async () => (await where()).top).toBeGreaterThan(START_TOP);
    measured.vertical = await settle();
    expect(measured.vertical.left, "a vertical gesture does not pan sideways").toBe(0);

    // A trackpad-like sideways swipe: many small events, each with a little vertical noise.
    await reset();
    for (const dy of [2, -1, 3, 0, 2, -2, 1, 3, -1, 2, 0, 1]) await page.mouse.wheel(14, dy);
    measured.swipeSideways = await settle();
    expect(measured.swipeSideways.left, "the swipe pans sideways").toBeGreaterThan(0);
    expect(measured.swipeSideways.top, "the swipe does not move the list up or down").toBe(START_TOP);

    // A trackpad-like vertical swipe.
    await reset();
    for (let i = 0; i < 12; i += 1) await page.mouse.wheel(0, 14);
    measured.swipeVertical = await settle();
    expect(measured.swipeVertical.top, "the swipe scrolls the list").toBeGreaterThan(START_TOP);
    expect(measured.swipeVertical.left, "the swipe does not pan sideways").toBe(0);

    // At the track's right end, a sideways gesture has nowhere to go: the list still does not move up or down.
    const maxLeft = await list.evaluate((el) => { const t = el.querySelector(".ps-session-list-track"); return t.scrollWidth - t.clientWidth; });
    await reset(maxLeft);
    await page.mouse.wheel(120, 8);
    measured.sidewaysAtEnd = await settle();
    expect(measured.sidewaysAtEnd.top, "at the right end a sideways gesture does not move the list up or down").toBe(START_TOP);

    // Reported, not asserted (Plan 4, F3): a vertical gesture with a little sideways noise.
    await reset();
    await page.mouse.wheel(8, 120);
    measured.verticalNoisy = await settle();
    await reset();
    for (const dx of [1, 2, 0, 1, 2, 1, 0, 2, 1, 1, 0, 2]) await page.mouse.wheel(dx, 14);
    measured.swipeVerticalNoisy = await settle();
    console.log(`F3 measured (start top ${START_TOP}, left 0; at end left ${maxLeft}): ${JSON.stringify(measured)}`);
});

test("F4: selecting, the keyboard and search keep the sideways position", async ({ page }) => {
    await routeProfile(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base);
    const list = listOf(page);
    await expect(rowOf(list, LONG)).toContainText("[+2]");
    await setSideways(list, 120);
    await expect.poll(() => sideways(list), { message: "the list pans sideways" }).toBe(120);

    // A click where the row is on screen.
    const target = rowOf(list, "11111113-2222-3333-4444-555555555553");
    const box = await target.boundingBox();
    const listBox = await list.boundingBox();
    await page.mouse.click(listBox.x + listBox.width / 2, box.y + box.height / 2);
    await expect(target).toHaveClass(/is-selected/);
    await page.waitForTimeout(300);
    expect(await sideways(list), "selecting a row keeps the sideways position").toBe(120);

    for (let i = 0; i < 4; i += 1) {
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(120);
        expect(await sideways(list), `keyboard move ${i + 1} keeps the sideways position`).toBe(120);
    }

    const search = page.locator(".ps-workspace-main-grid .ps-session-pane").first().getByRole("textbox", { name: "Find a session" });
    await search.fill("Session 3");
    await expect(list.locator(".ps-session-list-button[data-session-id]").first()).toBeVisible();
    await page.locator(".ps-workspace-main-grid .ps-session-pane").first().getByRole("button", { name: "Clear session search" }).click();
    await expect(rowOf(list, LONG)).toBeVisible();
    await expect.poll(() => sideways(list), { message: "clearing the search puts the sideways position back" }).toBe(120);
});

test("F6: with 1,500 sessions a search keystroke paints within its budget and selecting a row stays quick", async ({ page }) => {
    test.setTimeout(180_000);
    const large = await startStubServer(0, { sessionCount: 1500 });
    try {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(`http://127.0.0.1:${large.port}`);
        const pane = page.locator(".ps-workspace-main-grid .ps-session-pane").first();
        const list = pane.locator(".ps-session-list");
        await expect(list.locator(".ps-session-list-button")).toHaveCount(1500, { timeout: 30_000 });
        await page.waitForTimeout(1500);

        // Selecting a row: the click's script up to the next frame, and the script time it costs in all.
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Performance.enable");
        const scriptSeconds = async () => (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "ScriptDuration").value;
        await page.evaluate(() => {
            window.__clickFrames = [];
            document.addEventListener("click", () => {
                const start = performance.now();
                requestAnimationFrame(() => window.__clickFrames.push(performance.now() - start));
            }, true);
        });
        const listBox = await list.boundingBox();
        const selectScript = [];
        for (const index of [3, 8, 5, 12, 2]) {
            const row = list.locator(".ps-session-list-button").nth(index);
            const box = await row.boundingBox();
            const before = await scriptSeconds();
            await page.mouse.click(listBox.x + 60, box.y + box.height / 2);
            await expect(row).toHaveClass(/is-selected/);
            await page.waitForTimeout(500);
            selectScript.push(Math.round((await scriptSeconds() - before) * 1000));
        }
        const clickFrames = (await page.evaluate(() => window.__clickFrames)).map((ms) => Math.round(ms));

        // A search keystroke at a 4x slower CPU.
        const input = pane.getByRole("textbox", { name: "Find a session" });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
        await input.evaluate((node) => {
            window.searchPaintDelays = [];
            window.longTasks = [];
            new PerformanceObserver((entries) => { for (const entry of entries.getEntries()) window.longTasks.push(entry.duration); })
                .observe({ type: "longtask" });
            node.addEventListener("input", () => {
                const start = performance.now();
                requestAnimationFrame(() => window.searchPaintDelays.push(performance.now() - start));
            }, true);
        });
        await input.pressSequentially("Session 1499", { delay: 20 });
        await expect(input).toHaveValue("Session 1499");
        await expect(list.locator('.ps-session-list-button[data-session-id^="11111111499-"]')).toBeVisible();
        await page.waitForTimeout(500);
        const delays = (await page.evaluate(() => window.searchPaintDelays)).map((ms) => Math.round(ms));
        const longTasks = (await page.evaluate(() => window.longTasks)).map((ms) => Math.round(ms));
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
        console.log(`F6 desktop 1440x900, 1,500 sessions: ${JSON.stringify({
            keystrokePaintMs: { max: Math.max(...delays), all: delays }, longestTaskWhileTypingMs: Math.max(0, ...longTasks),
            selectClickToFrameMs: clickFrames, selectScriptMsWithin500: selectScript,
        })}`);
        expect(delays.length).toBeGreaterThan(0);
        expect(Math.max(...delays), `keystroke paint delays ${JSON.stringify(delays)}`).toBeLessThan(350);
        expect(Math.max(...clickFrames), `selection click to frame ${JSON.stringify(clickFrames)}`).toBeLessThan(100);
    } finally {
        await page.goto("about:blank");
        await new Promise((resolve) => large.server.close(resolve));
    }
});
