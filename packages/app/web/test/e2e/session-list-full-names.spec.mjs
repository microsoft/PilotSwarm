// Plan 4: the desktop session list shows every name in full and scrolls sideways, one axis at a time.
//
// WHY THIS EXISTS: the desktop list cut a long name with "…" and pinned the [+N] badge and the context % to the column's
// edge, so the part of the name a person was looking for was the part they could not read. Now a row shows its full
// title, then its suffixes in one line (F1): the Workflows mark, a Workflow's state chip, the [+N] badge, the pause and
// timer marks, the context %. Every row of the list is as wide as the widest one (F2), and the list pans sideways when
// that is wider than the column. As on the phone there are two native scrollers, one axis each (F3): the list scrolls up
// and down, and a track inside it pans every row sideways together. The browser gives each wheel event, and each swipe
// as a whole, to one of them, so a sideways gesture never moves the list up or down, and an up-and-down gesture that
// starts straight up or down never pans it. Chromium gives an up-and-down wheel event that ALSO moves a little sideways,
// or a swipe whose first event does, to the track: it pans, and does not scroll. That is an accepted Chromium limit (Plan 4,
// F3 as amended), kept visible as the expected failure below. Selecting, the keyboard, live updates and search keep the sideways position (F4), and the list
// stays fast at 1,500 sessions (F6).
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
const DONE = "bbbb0000-0000-4000-8000-000000000004";
const TERMINATED = `terminated:${LONG}`;
const LONG_TITLE = "Quarterly release readiness review for the storage, networking and identity teams, with every follow-up";
const OWNER = { provider: "none", subject: "test", email: "test@example.com", displayName: "Test User" };
const member = (sessionId, title, extra = {}) => ({
    viewerGroupId: null, sessionId, title, status: "idle", model: "github-copilot:claude-sonnet-5", agentId: null, isSystem: false,
    owner: OWNER, parentSessionId: null, createdAt: 1785000002000, updatedAt: 1785000002000,
    contextUsage: { currentTokens: 150_000, tokenLimit: 200_000 }, ...extra,
});
// Every suffix a row can carry. LONG: the Workflows mark (it has a Workflow child), the [+N] badge (its children are
// hidden while it is closed), a budget pause, a timer and the context %. FLOW: a Workflow's state chip, then a pause.
// DONE, a failed child, puts a Terminated row under LONG (Plan 3): its chevron, "Terminated", "· 1 failed" and [+1].
const FULL_NAMES = [
    member(LONG, LONG_TITLE, { status: "waiting", pauseState: { kind: "hold" }, cronActive: true, cronInterval: 3600 }),
    member(FLOW, "Workflow: nightly-build", { parentSessionId: LONG, sessionKind: "workflow", status: "waiting",
        pauseState: { kind: "hold" }, createdAt: 1785000002100, updatedAt: 1785000002100 }),
    member(KID, "Log reader", { parentSessionId: LONG, createdAt: 1785000002200, updatedAt: 1785000002200 }),
    member(DONE, "Summary writer", { parentSessionId: LONG, status: "failed", createdAt: 1785000002300, updatedAt: 1785000002300 }),
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

/** The session column's width, in px. */
const columnWidth = (page) => page.locator(".ps-workspace-main-grid > .ps-workspace-pane-slot").first()
    .evaluate((slot) => Math.round(slot.getBoundingClientRect().width));

/** Narrow the session column with its resize handle's keyboard until the grid is in its compact mode (190 px or less). */
async function narrowToCompact(page) {
    const grid = page.locator(".ps-workspace-main-grid").first();
    const handle = page.getByRole("button", { name: "Resize sessions and chat columns" });
    await handle.focus();
    for (let i = 0; i < 40 && !/\bis-session-compact\b/.test(await grid.getAttribute("class")); i += 1) {
        await page.keyboard.press("ArrowLeft");
    }
    await expect(grid).toHaveClass(/\bis-session-compact\b/);
    return columnWidth(page);
}

// `compact`: the session column narrowed to its compact mode (190 px or less), where the old list cut names first.
const LAYOUTS = [
    { name: "at 1440 px", width: 1440 },
    { name: "at 1024 px", width: 1024 },
    { name: "at 1440 px with the session column at 190 px or less", width: 1440, compact: true },
];

for (const { name, width, compact } of LAYOUTS) test(`F1, F2: ${name} a row shows its full name and then every suffix, and all rows share one width`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", collectPageErrors(errors));
    await routeProfile(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(base);
    const list = listOf(page);
    const long = rowOf(list, LONG);
    await expect(long).toContainText("[+3]");
    if (compact) {
        const column = await narrowToCompact(page);
        expect(column, `the session column is in its compact mode (${column} px)`).toBeLessThanOrEqual(190);
    }
    await scrollRowIntoList(list, LONG);

    // The parent, closed: its full title, then the mark, the badge, the pause, the timer and the context %.
    await expect(long.locator(".ps-session-row-title__text")).toHaveText(LONG_TITLE);
    expectInOrder(await partsOf(long, [
        ["title", "text", LONG_TITLE], ["Workflows mark", "selector", '[data-workflow-owner="true"]'], ["[+N]", "text", "[+3]"],
        ["pause", "text", "paused · hold"], ["timer", "text", "⏱"], ["context %", "text", "75%"],
    ]), `${name}: parent`);
    expect(await cutIn(long), `${name}: nothing in the parent row is cut`).toEqual([]);

    // Every row is as wide as the widest, never narrower than the column; only the track pans sideways.
    const widths = await widthsOf(list);
    expect(widths.trackClient, `${name}: the rows are in a sideways track`).not.toBeNull();
    expect(widths.max - widths.min, `${name}: one width (${JSON.stringify(widths)})`).toBeLessThanOrEqual(1);
    expect(widths.min, `${name}: no row is narrower than the column (${JSON.stringify(widths)})`).toBeGreaterThanOrEqual(widths.trackClient - 1);
    expect(Math.abs(widths.max - widths.trackScroll), `${name}: the rows are as wide as the track's content (${JSON.stringify(widths)})`)
        .toBeLessThanOrEqual(1);
    expect(widths.trackScroll, `${name}: the long name makes the list pan sideways (${JSON.stringify(widths)})`).toBeGreaterThan(widths.trackClient + 20);
    expect(widths.listScrollX, `${name}: the list itself never pans sideways`).toBeLessThanOrEqual(1);

    // A row that fits keeps its context % at the column's right edge, where it is read without panning.
    const fits = await rowOf(list, "11111111-2222-3333-4444-555555555551").evaluate((row) => {
        const ctx = row.querySelector(".ps-session-row-ctx");
        const track = row.closest(".ps-session-list-track") ?? row.closest(".ps-session-list");
        return { ctxRight: Math.round(ctx.getBoundingClientRect().right), trackRight: Math.round(track.getBoundingClientRect().right) };
    });
    expect(fits.ctxRight, `${name}: a short row's % is on screen (${JSON.stringify(fits)})`).toBeLessThanOrEqual(fits.trackRight);
    expect(fits.ctxRight, `${name}: a short row's % sits at the column's right edge (${JSON.stringify(fits)})`).toBeGreaterThan(fits.trackRight - 24);

    if (width === 1440 && !compact) {
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
    ]), `${name}: Workflow`);
    expect(await cutIn(flow), `${name}: nothing in the Workflow row is cut`).toEqual([]);

    // The Terminated row (Plan 3): its chevron, its words in full, then its [+N] badge; nothing cut.
    const terminated = rowOf(list, TERMINATED);
    await expect(terminated).toBeVisible();
    await expect(terminated).toHaveText("Terminated · 1 failed [+1]");
    expectInOrder(await partsOf(terminated, [
        ["chevron", "selector", ".ps-terminated-chevron"], ["Terminated", "text", "Terminated"], ["failed", "text", "1 failed"],
        ["[+N]", "selector", ".ps-session-row-badge"],
    ]), `${name}: Terminated`);
    expect(await cutIn(terminated), `${name}: nothing in the Terminated row is cut`).toEqual([]);

    // Open, with the Workflow and the Terminated rows: still one width, never narrower than the column.
    const opened = await widthsOf(list);
    expect(opened.max - opened.min, `${name}, open: one width (${JSON.stringify(opened)})`).toBeLessThanOrEqual(1);
    expect(opened.min, `${name}, open: no row is narrower than the column (${JSON.stringify(opened)})`).toBeGreaterThanOrEqual(opened.trackClient - 1);
    for (const id of [FLOW, TERMINATED]) {
        const rowWidth = await rowOf(list, id).evaluate((row) => row.getBoundingClientRect().width);
        expect(Math.abs(rowWidth - opened.max), `${name}: ${id} is as wide as the widest row`).toBeLessThanOrEqual(1);
    }
    expect(errors).toEqual([]);
});

/**
 * The F3 harness: the list at 1,440 px with the pointer over it, and how to start each gesture from the same place.
 * `wheel`: Playwright's wheel events, one per call, with no gesture phase (as a mouse wheel sends them). `swipe`: Chromium's
 * own synthetic trackpad swipe (`Input.synthesizeScrollGesture`, a "mouse" source): one gesture of many small wheel events,
 * with its phases, which the browser keeps on the scroller its first event chose.
 */
async function gestureHarness(page) {
    await routeProfile(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base);
    const list = listOf(page);
    await expect(rowOf(list, LONG)).toContainText("[+3]");
    await expect(list.locator(".ps-session-list-track"), "the rows are in a sideways track").toHaveCount(1);
    const box = await list.boundingBox();
    const x = Math.round(box.x + box.width / 2);
    const y = Math.round(box.y + box.height / 2);
    await page.mouse.move(x, y);
    const cdp = await page.context().newCDPSession(page);
    const where = () => list.evaluate((el) => ({ top: el.scrollTop, left: el.querySelector(".ps-session-list-track").scrollLeft }));
    const maxLeft = await list.evaluate((el) => { const t = el.querySelector(".ps-session-list-track"); return t.scrollWidth - t.clientWidth; });
    expect(maxLeft, "the long name gives the track room to pan").toBeGreaterThan(400);
    const START_TOP = 200;
    const reset = async (left = 0) => {
        await list.evaluate((el, value) => { el.scrollTop = 200; el.querySelector(".ps-session-list-track").scrollLeft = value; }, left);
        // A new gesture: the browser keeps wheel events on one scroller until they have been quiet for a moment.
        await page.waitForTimeout(600);
        expect(await where()).toEqual({ top: START_TOP, left });
    };
    const settle = async () => { await page.waitForTimeout(400); return where(); };
    // Scroll by (dx, dy) in one swipe: the protocol's distances point the other way.
    const swipe = (dx, dy) => cdp.send("Input.synthesizeScrollGesture", { x, y, xDistance: -dx, yDistance: -dy, gestureSourceType: "mouse", speed: 600 });
    return { list, where, maxLeft, START_TOP, reset, settle, swipe };
}

test("F3: a sideways gesture pans only sideways, an up-and-down one only scrolls up and down", async ({ page }) => {
    const { where, maxLeft, START_TOP, reset, settle, swipe } = await gestureHarness(page);
    const measured = {};

    // One mostly sideways wheel event with a little vertical noise.
    await reset();
    await page.mouse.wheel(120, 8);
    await expect.poll(async () => (await where()).left).toBeGreaterThan(0);
    measured.sideways = await settle();
    expect(measured.sideways.top, "a sideways gesture does not move the list up or down").toBe(START_TOP);

    // One vertical wheel event, from the start and from a panned track.
    for (const left of [0, 120]) {
        await reset(left);
        await page.mouse.wheel(0, 120);
        await expect.poll(async () => (await where()).top).toBeGreaterThan(START_TOP);
        measured[`vertical@${left}`] = await settle();
        expect(measured[`vertical@${left}`].left, `a vertical gesture does not pan sideways (from ${left})`).toBe(left);
    }

    // A trackpad-like sideways run of wheel events: many small events, each with a little vertical noise.
    await reset();
    for (const dy of [2, -1, 3, 0, 2, -2, 1, 3, -1, 2, 0, 1]) await page.mouse.wheel(14, dy);
    measured.swipeSideways = await settle();
    expect(measured.swipeSideways.left, "the run pans sideways").toBeGreaterThan(0);
    expect(measured.swipeSideways.top, "the run does not move the list up or down").toBe(START_TOP);

    // A trackpad-like vertical run of wheel events.
    await reset(120);
    for (let i = 0; i < 12; i += 1) await page.mouse.wheel(0, 14);
    measured.swipeVertical = await settle();
    expect(measured.swipeVertical.top, "the run scrolls the list").toBeGreaterThan(START_TOP);
    expect(measured.swipeVertical.left, "the run does not pan sideways").toBe(120);

    // Swipes with their phases. Sideways, with 12 px of up-and-down in 200 px: only sideways, from either place.
    // Up and down, with 6 px of sideways in 200 px, and straight up and down: only up and down, from either place.
    // (A swipe whose first event already moves sideways pans instead: the expected failure below.)
    for (const left of [0, 120]) {
        await reset(left);
        await swipe(200, 12);
        measured[`phasedSideways@${left}`] = await settle();
        expect(measured[`phasedSideways@${left}`].left, `a sideways swipe pans (from ${left})`).toBeGreaterThan(left + 100);
        expect(measured[`phasedSideways@${left}`].top, `a sideways swipe does not move the list up or down (from ${left})`).toBe(START_TOP);
        for (const dx of [6, 0]) {
            await reset(left);
            await swipe(dx, 200);
            const end = await settle();
            measured[`phasedVertical${dx}@${left}`] = end;
            expect(end.top, `an up-and-down swipe (${dx} px sideways) scrolls (from ${left})`).toBeGreaterThan(START_TOP + 100);
            expect(end.left, `an up-and-down swipe (${dx} px sideways) does not pan (from ${left})`).toBe(left);
        }
    }

    // At the track's right end, a sideways gesture has nowhere to go: the list still does not move up or down.
    await reset(maxLeft);
    await page.mouse.wheel(120, 8);
    measured.sidewaysAtEnd = await settle();
    expect(measured.sidewaysAtEnd.top, "at the right end a sideways gesture does not move the list up or down").toBe(START_TOP);
    await reset(maxLeft);
    await swipe(200, 12);
    measured.phasedSidewaysAtEnd = await settle();
    expect(measured.phasedSidewaysAtEnd.top, "at the right end a sideways swipe does not move the list up or down").toBe(START_TOP);
    console.log(`F3 measured (start top ${START_TOP}; track max left ${maxLeft}): ${JSON.stringify(measured)}`);
});

// EXPECTED TO FAIL: an accepted Chromium limit (Plan 4, F3 as amended). An up-and-down gesture that also moves a little
// sideways pans instead of scrolling. Chromium gives a wheel event to the innermost scroller that can use ANY part of it, and a swipe to
// the scroller its first event chose, so such an event, or such a swipe, goes to the sideways track: it pans by its
// sideways part and loses its up-and-down part. No native arrangement of the scrollers (measured: this one, the reverse
// nesting, one two-axis scroller) and no passive listener (it runs after the browser has chosen; three latches measured)
// changes that; only a non-passive JS scroller would, which needs the owner's approval. This test asserts the ideal, so it
// fails today; Playwright reports it as an expected failure, and as an error the day it passes. Remove `test.fail` only
// when browser behaviour or an approved implementation makes it pass.
test("F3 (accepted Chromium limit): an up-and-down gesture with a little sideways movement only scrolls up and down", async ({ page }) => {
    test.fail(true, "Accepted Chromium limit (Plan 4, F3 as amended): Chromium routes a vertical wheel event or swipe start with sideways movement to the track");
    const { where, START_TOP, reset, settle, swipe } = await gestureHarness(page);
    const measured = {};
    for (const left of [0, 120]) {
        await reset(left);
        await page.mouse.wheel(8, 120);
        measured[`wheel(8,120)@${left}`] = await settle();
        await reset(left);
        for (const dx of [1, 2, 0, 1, 2, 1, 0, 2, 1, 1, 0, 2]) await page.mouse.wheel(dx, 14);
        measured[`12 wheel(0-2,14)@${left}`] = await settle();
        await reset(left);
        await swipe(60, 200);
        measured[`swipe(60,200)@${left}`] = await settle();
    }
    console.log(`F3 open (start top ${START_TOP}): ${JSON.stringify(measured)}`);
    for (const [gesture, end] of Object.entries(measured)) {
        const left = Number(gesture.split("@")[1]);
        expect.soft(end.top, `${gesture}: scrolls up and down`).toBeGreaterThan(START_TOP);
        expect.soft(end.left, `${gesture}: does not pan sideways`).toBe(left);
    }
});

test("F4: selecting, the keyboard, live updates and search keep the sideways position", async ({ page }) => {
    // Live updates: once `live.on` is set, the session list the portal polls (every 4 s) renames a session and adds one,
    // and the session reads that follow a poll agree with it.
    const RENAMED = "11111115-2222-3333-4444-555555555555";
    const ARRIVED = "bbbb0000-0000-4000-8000-000000000005";
    const arrived = member(ARRIVED, "Arrived while you look", { createdAt: 1785000003000, updatedAt: 1785000003000 });
    const live = { on: false, served: 0 };
    const updated = (session) => (session.sessionId === RENAMED
        ? { ...session, title: "Session 5, renamed while you look", updatedAt: session.updatedAt + 1000,
            contextUsage: { currentTokens: 90_000, tokenLimit: 200_000 } }
        : session);
    await page.route((url) => url.pathname.endsWith("/api/v1/management/sessions"), async (route) => {
        if (!live.on || route.request().method() !== "GET") return route.fallback();
        const response = await route.fetch();
        const body = await response.json();
        live.served += 1;
        await route.fulfill({ response, json: { ...body, result: { ...body.result, sessions: [...body.result.sessions.map(updated), arrived] } } });
    });
    await page.route((url) => url.pathname.endsWith(`/api/v1/sessions/${RENAMED}`) || url.pathname.endsWith(`/api/v1/sessions/${ARRIVED}`),
        async (route) => {
            if (!live.on || route.request().method() !== "GET") return route.fallback();
            const response = await route.fetch();
            const body = await response.json();
            const result = route.request().url().includes(ARRIVED) ? { ...arrived, messages: [], events: [], pendingMessages: [] } : updated(body.result);
            await route.fulfill({ response, json: { ...body, result } });
        });
    await routeProfile(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base);
    const list = listOf(page);
    await expect(rowOf(list, LONG)).toContainText("[+3]");
    const range = () => list.evaluate((el) => { const t = el.querySelector(".ps-session-list-track"); return t.scrollWidth - t.clientWidth; });
    expect(await range(), "the track has room to pan well past 120 px").toBeGreaterThan(400);
    await setSideways(list, 120);
    await expect.poll(() => sideways(list), { message: "the list pans sideways" }).toBe(120);
    const ids = () => list.locator(".ps-session-list-button[data-session-id]").evaluateAll((nodes) => nodes.map((node) => node.dataset.sessionId));
    const selected = () => list.locator(".ps-session-list-button.is-selected").getAttribute("data-session-id");

    // A click where the row is on screen.
    const target = rowOf(list, "11111113-2222-3333-4444-555555555553");
    const box = await target.boundingBox();
    const listBox = await list.boundingBox();
    await page.mouse.click(listBox.x + listBox.width / 2, box.y + box.height / 2);
    await expect(target).toHaveClass(/is-selected/);
    await page.waitForTimeout(300);
    expect(await sideways(list), "selecting a row keeps the sideways position").toBe(120);

    // The keyboard moves the selection one row at a time, and never pans.
    for (let i = 0; i < 4; i += 1) {
        const order = await ids();
        const next = order[order.indexOf(await selected()) + 1];
        expect(next, "there is a row below the selected one").toBeTruthy();
        await page.keyboard.press("ArrowDown");
        await expect(rowOf(list, next), `keyboard move ${i + 1} selects the next row`).toHaveClass(/is-selected/);
        await page.waitForTimeout(120);
        expect(await sideways(list), `keyboard move ${i + 1} keeps the sideways position`).toBe(120);
    }

    // A move to a row outside the list's view scrolls the list to show it, and still does not pan: the selected row at the
    // view's top edge, the row above it out of view, then ArrowUp.
    const order = await ids();
    const current = await selected();
    const above = order[order.indexOf(current) - 1];
    expect(above, "there is a row above the selected one").toBeTruthy();
    const atTop = await list.evaluate((el, [currentId, aboveId]) => {
        const row = (id) => el.querySelector(`.ps-session-list-button[data-session-id="${id}"]`);
        el.scrollTop += row(currentId).getBoundingClientRect().top - el.getBoundingClientRect().top;
        return { top: el.scrollTop, aboveHidden: row(aboveId).getBoundingClientRect().bottom <= el.getBoundingClientRect().top + 1 };
    }, [current, above]);
    expect(atTop.aboveHidden, `the row above ends above the list's view (${JSON.stringify(atTop)})`).toBe(true);
    await page.waitForTimeout(200);
    await page.keyboard.press("ArrowUp");
    await expect(rowOf(list, above), "the move selects the row above the view").toHaveClass(/is-selected/);
    await page.waitForTimeout(200);
    const revealed = await list.evaluate((el) => {
        const row = el.querySelector(".ps-session-list-button.is-selected").getBoundingClientRect();
        const view = el.getBoundingClientRect();
        return { top: el.scrollTop, rowTop: row.top, rowBottom: row.bottom, viewTop: view.top, viewBottom: view.bottom };
    });
    expect(revealed.top, `the list scrolled up to show the row (${JSON.stringify(revealed)})`).toBeLessThan(atTop.top);
    expect(revealed.rowTop, `the row is in the list's view (${JSON.stringify(revealed)})`).toBeGreaterThanOrEqual(revealed.viewTop - 1);
    expect(revealed.rowBottom, `the row is in the list's view (${JSON.stringify(revealed)})`).toBeLessThanOrEqual(revealed.viewBottom + 1);
    expect(await sideways(list), "the move that scrolls the list keeps the sideways position").toBe(120);

    // A live update renames a session and adds one; the track keeps its place, with room to spare.
    live.on = true;
    await expect.poll(() => live.served, { timeout: 15_000, message: "the portal polled the session list" }).toBeGreaterThan(0);
    await expect(rowOf(list, RENAMED), "the live update reached the list").toContainText("renamed while you look", { timeout: 15_000 });
    await expect(rowOf(list, ARRIVED)).toHaveCount(1);
    await page.waitForTimeout(300);
    expect(await range(), "the track still has room to pan past 120 px").toBeGreaterThan(400);
    expect(await sideways(list), "a live update keeps the sideways position").toBe(120);
    live.on = false;

    const search = page.locator(".ps-workspace-main-grid .ps-session-pane").first().getByRole("textbox", { name: "Find a session" });
    await search.fill("Session 3");
    await expect(list.locator(".ps-session-list-button[data-session-id]").first()).toBeVisible();
    await page.locator(".ps-workspace-main-grid .ps-session-pane").first().getByRole("button", { name: "Clear session search" }).click();
    await expect(rowOf(list, LONG)).toBeVisible();
    await expect.poll(() => sideways(list), { message: "clearing the search puts the sideways position back" }).toBe(120);
});

test("F6: with 1,500 sessions a search keystroke paints within its budget and selecting a row stays quick", async ({ page }) => {
    test.setTimeout(300_000);
    const large = await startStubServer(0, { sessionCount: 1500 });
    // Every API request the page makes, with when it started and when it ended.
    const requests = [];
    page.on("request", (request) => {
        if (request.url().includes("/api/")) requests.push({ request, path: new URL(request.url()).pathname, method: request.method(), start: Date.now(), end: null });
    });
    const ended = (request) => { const entry = requests.find((e) => e.request === request && e.end === null); if (entry) entry.end = Date.now(); };
    page.on("requestfinished", ended);
    page.on("requestfailed", ended);
    /** Wait until no request is in flight and none has started or ended for `ms`. */
    const quiet = async (ms, timeout = 15_000) => {
        const deadline = Date.now() + timeout;
        for (;;) {
            const pending = requests.some((e) => e.end === null);
            const last = requests.reduce((at, e) => Math.max(at, e.start, e.end ?? 0), 0);
            if (!pending && Date.now() - last >= ms) return;
            if (Date.now() > deadline) throw new Error(`no ${ms} ms without requests in ${timeout} ms`);
            await page.waitForTimeout(20);
        }
    };
    try {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(`http://127.0.0.1:${large.port}`);
        const pane = page.locator(".ps-workspace-main-grid .ps-session-pane").first();
        const list = pane.locator(".ps-session-list");
        await expect(list.locator(".ps-session-list-button")).toHaveCount(1500, { timeout: 30_000 });
        await page.waitForTimeout(1500);

        // Selecting a row costs script in two parts: the click's own frame, and the session load that the selection starts
        // after the list's 140 ms settle (the session, its events, its access and its Workflow Definitions), with the
        // renders that follow and the profile save 400 ms after the last change. SELECTION SCRIPT is all of it: the CDP
        // ScriptDuration from just before the click until every request the selection made has answered, no request has
        // started or ended for 450 ms, and two frames have run. Isolation from the portal's own background work: each
        // sample starts just after the 4 s session poll and its reads have finished, and a sample is not counted if any
        // request that is not the selection's own (a poll) started during it; the next row is then tried.
        // CLICK TO FRAME is the responsiveness measure: the click to the next animation frame.
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Performance.enable");
        const scriptMs = async () => 1000 * (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "ScriptDuration").value;
        const frames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.evaluate(() => {
            window.__clickFrames = [];
            document.addEventListener("click", () => {
                const start = performance.now();
                requestAnimationFrame(() => window.__clickFrames.push(performance.now() - start));
            }, true);
        });
        const polls = () => requests.filter((e) => e.path.endsWith("/management/sessions")).length;
        const listBox = await list.boundingBox();
        const SAMPLES = 5;
        const selectScript = [];
        const windows = [];
        const notCounted = [];
        for (const index of [3, 8, 5, 12, 2, 20, 7, 15, 4, 9, 11, 6, 14, 10, 13, 16, 18, 17, 19, 1]) {
            if (selectScript.length === SAMPLES) break;
            const seen = polls();
            await expect.poll(polls, { timeout: 10_000, message: "the session poll runs" }).toBeGreaterThan(seen);
            await quiet(450);
            const row = list.locator(".ps-session-list-button").nth(index);
            const id = await row.getAttribute("data-session-id");
            const box = await row.boundingBox();
            const mark = requests.length;
            const before = await scriptMs();
            const t0 = Date.now();
            await page.mouse.click(listBox.x + 60, box.y + box.height / 2);
            await expect(row).toHaveClass(/is-selected/);
            await page.waitForTimeout(200);
            await quiet(450);
            await frames();
            const ms = await scriptMs() - before;
            const during = requests.slice(mark);
            const own = (e) => e.path.includes(id) || (e.method === "PATCH" && e.path.endsWith("/me/profile/settings"));
            expect(during.some((e) => own(e) && e.path.endsWith(`/${id}/events`)), `selecting row ${index} loads its session`).toBe(true);
            const other = during.filter((e) => !own(e)).map((e) => `${e.method} ${e.path}`);
            if (other.length) { notCounted.push({ index, other }); continue; }
            selectScript.push(Math.round(ms));
            windows.push(Date.now() - t0);
        }
        const clickFrames = (await page.evaluate(() => window.__clickFrames)).map((ms) => Math.round(ms));

        // For scale, not asserted: the script the page runs in a window as long, with no click and no request.
        const background = [];
        const span = windows.length ? [...windows].sort((a, b) => a - b)[Math.floor(windows.length / 2)] : 700;
        for (let i = 0; i < 6 && background.length < 3; i += 1) {
            const seen = polls();
            await expect.poll(polls, { timeout: 10_000, message: "the session poll runs" }).toBeGreaterThan(seen);
            await quiet(450);
            const mark = requests.length;
            const before = await scriptMs();
            await page.waitForTimeout(span);
            await frames();
            const ms = await scriptMs() - before;
            if (requests.length === mark) background.push(Math.round(ms));
        }

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
            selectionScriptMs: selectScript, selectionWindowMs: windows, notCounted, backgroundScriptMsInSameWindow: background,
            selectClickToFrameMs: clickFrames,
        })}`);
        expect(delays.length).toBeGreaterThan(0);
        expect(Math.max(...delays), `keystroke paint delays ${JSON.stringify(delays)}`).toBeLessThan(350);
        expect(selectScript, `${SAMPLES} counted selections (not counted: ${JSON.stringify(notCounted)})`).toHaveLength(SAMPLES);
        for (const ms of selectScript) expect(Number.isFinite(ms) && ms >= 0, `selection script ${ms} ms is a measurement`).toBe(true);
        expect(Math.max(...selectScript), `selection script, click to loaded and painted: ${JSON.stringify(selectScript)} ms`).toBeLessThan(100);
        expect(clickFrames.length, "every click reached its next frame").toBeGreaterThanOrEqual(SAMPLES);
        for (const ms of clickFrames) expect(Number.isFinite(ms), `click to frame ${ms} ms is a measurement`).toBe(true);
        expect(Math.max(...clickFrames), `selection click to frame ${JSON.stringify(clickFrames)}`).toBeLessThan(100);
    } finally {
        await page.goto("about:blank");
        await new Promise((resolve) => large.server.close(resolve));
    }
});
