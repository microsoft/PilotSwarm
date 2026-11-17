// When the session list is shown again, the selected row is in view.
//
// WHY THIS EXISTS: the owner (2026-11-17, on a phone) picked a Workflow far down the slide-over list, deep inside a
// parent's Terminated group. The Workflow pane opened in place of the chat, and when he opened the list again it was
// scrolled to the top: the row was still selected, but off screen. A Workflow pane (like the canvas, diagnostics and
// Budget) replaces the phone's chat and its slide-over, so the list is built again from the top when it comes back; the
// desktop list is built again the same way when Budget closes. Now a list that is shown again, the slide-over opening or
// a list pane mounting, scrolls the highlighted row into view when it is not fully in view, and leaves the list where it
// is when it is. A selection made while the list is on screen still never moves it.
//
// Run (from packages/app, after `npm run build:web`):
//   npx playwright test --config=web/playwright.config.mjs web/test/e2e/session-list-reveal-on-show.spec.mjs
import { test, expect } from "@playwright/test";
import { startStubServer, TERMINATED_FAMILY, TERMINATED_FAMILY_IDS as F } from "./stub-server.mjs";
import { collectPageErrors } from "./page-errors.mjs";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });

let stub, base;
test.beforeAll(async () => {
    // Forty sessions above the family, so its rows sit far down a phone's list.
    stub = await startStubServer(0, { sessionCount: 40, extraSessions: TERMINATED_FAMILY });
    base = `http://127.0.0.1:${stub.port}`;
});
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const TOP = "11111110-2222-3333-4444-555555555550";

/** Every parent open, and the family's Terminated row open, as in the owner's screenshot. */
async function routeProfile(page) {
    const settings = { collapsedSessionIds: [], openTerminatedSessionIds: [F.parent] };
    await page.route("**/api/v1/me/profile/settings", (route) => route.fulfill({ json: { ok: true, result: { profileSettings: settings } } }));
    await page.route("**/api/v1/me/profile", (route) => route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: settings } } }));
}

const rowOf = (scope, id) => scope.locator(`.ps-session-list-button[data-session-id="${id}"]`);

/** Where a row sits in the list that scrolls it: the list's scroll offsets, and whether the row is fully in view up and down. */
const placement = (scope, id) => rowOf(scope, id).evaluate((row) => {
    const list = row.closest(".ps-session-list");
    const r = row.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    const top = box.top + list.clientTop;
    const bottom = top + list.clientHeight;
    const track = row.closest(".ps-session-list-track");
    const middle = (r.top + r.bottom) / 2 - top + list.scrollTop;
    return {
        scrollTop: Math.round(list.scrollTop),
        scrollLeft: Math.round((track || list).scrollLeft),
        // Where the row sits on screen, from the top of the list's visible box.
        rowTop: Math.round(r.top - top),
        inView: r.top >= top - 1 && r.bottom <= bottom + 1,
        // How far the list is, in rows, from holding the row in its middle as nearly as its ends allow.
        offMiddle: Math.abs(list.scrollTop - Math.max(0, Math.min(list.scrollHeight - list.clientHeight, middle - list.clientHeight / 2))) / r.height,
    };
});
const setScrollTop = (scope, value) => scope.locator(".ps-session-list").evaluate((list, top) => {
    list.scrollTop = top;
    return Math.round(list.scrollTop);
}, value);
/** Scroll the list as a person would, until the row sits in the middle of it. */
const scrollToRow = (scope, id) => rowOf(scope, id).evaluate((row) => {
    const list = row.closest(".ps-session-list");
    const r = row.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    list.scrollTop += (r.top + r.bottom) / 2 - (box.top + list.clientTop + list.clientHeight / 2);
    return Math.round(list.scrollTop);
});

test.describe("phone 390x844", () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    const slideOf = (page) => page.locator(".ps-mobile-session-slideover");
    const listButton = (page) => page.getByRole("button", { name: "Sessions", exact: true });

    async function openList(page) {
        await listButton(page).tap();
        await expect(slideOf(page)).toHaveClass(/is-open/);
        return slideOf(page);
    }

    async function openPhone(page) {
        await routeProfile(page);
        await page.goto(`${base}/?session=${TOP}`);
        await expect(page.locator(".ps-mobile-chat-pane textarea")).toBeVisible();
        const slide = await openList(page);
        await expect(rowOf(slide, F.workflowDone)).toHaveCount(1);
        return slide;
    }

    /** The agent session owns one saved Workflow definition, so picking it brings its Workflow pane up by itself (OF-S2-4d). */
    async function routeDefinition(page, sessionId) {
        const at = new Date(Date.now() - 60_000).toISOString();
        const actor = { kind: "session", sessionId };
        const revision = { definitionId: "def-reveal", revision: 1, valid: true, semver: "1.0.0", yamlSha256: "y1", irSha256: "ir1", basedOn: null,
            actor, imported: false, createdAt: at, errorCount: 0 };
        const item = { definitionId: "def-reveal", ownerSessionId: sessionId, name: "log-watch", source: "session", createdAt: at, updatedAt: at,
            deletedAt: null, currentRevision: 1, newestValidRevision: 1, revisions: [revision], workflows: [], current: revision };
        await page.route((url) => url.pathname.endsWith(`/sessions/${sessionId}/workflow-definitions`),
            (route) => route.fulfill({ json: { ok: true, result: [item] } }));
        await page.route((url) => url.pathname.endsWith(`/sessions/${sessionId}/workflow-definition`), (route) => route.fulfill({ status: 404,
            json: { ok: false, error: { code: "REVISION_NOT_FOUND", message: "log-watch has no such revision." } } }));
    }

    // How each pick leaves Main (the chat and its slide-over), and how the person comes back to the list.
    const cases = [
        { name: "a finished Workflow in the Terminated group (the owner's report)", id: F.workflowDone, replaced: "the Workflow pane" },
        { name: "a live Workflow", id: F.workflowLive, replaced: "the Workflow pane" },
        { name: "an agent session that has a Workflow", id: F.agentLive, replaced: "its Workflow pane, by itself", definition: true },
        { name: "an agent session, then diagnostics", id: F.agentCancelled, replaced: "diagnostics", diagnostics: true },
    ];
    for (const item of cases) {
        test(`${item.name}: picked far down, it is in view when the list opens again`, async ({ page }) => {
            const errors = [];
            page.on("pageerror", collectPageErrors(errors));
            if (item.definition) await routeDefinition(page, item.id);
            const slide = await openPhone(page);
            // The row is far down: the list has to scroll a long way to show it.
            expect(await scrollToRow(slide, item.id)).toBeGreaterThan(600);
            expect((await placement(slide, item.id)).inView).toBe(true);

            await rowOf(slide, item.id).tap();
            if (item.diagnostics) {
                await expect(slideOf(page)).not.toHaveClass(/is-open/);
                await page.getByRole("button", { name: /^Diagnostics/ }).first().tap();
            }
            // The pick or the button puts another view in the chat's place: the chat and the list's slide-over are gone
            // until the list button brings them back.
            await expect(page.locator(".ps-mobile-workspace"), item.replaced).toHaveCount(0);

            const again = await openList(page);
            await expect(rowOf(again, item.id)).toHaveClass(/is-selected/);
            await expect.poll(async () => (await placement(again, item.id)).inView, "the selected row is in view").toBe(true);
            const shown = await placement(again, item.id);
            expect(shown.offMiddle, "about in the middle of the list").toBeLessThanOrEqual(1);
            expect(shown.scrollLeft, "no sideways scroll is needed").toBe(0);
            expect(errors).toEqual([]);
        });
    }

    test("a plain agent session: the slide-over keeps its list, and the row stays in view", async ({ page }) => {
        const slide = await openPhone(page);
        expect(await scrollToRow(slide, F.agentCancelled)).toBeGreaterThan(600);
        await rowOf(slide, F.agentCancelled).tap();
        await expect(slideOf(page)).not.toHaveClass(/is-open/);
        await expect(page.locator(".ps-mobile-chat-pane .ps-panel-title").first()).toContainText("Flaky test hunter");
        await openList(page);
        await expect.poll(async () => (await placement(slide, F.agentCancelled)).inView).toBe(true);
    });

    test("scrolled away from the selected row and closed: opening it again shows the row, and takes no focus", async ({ page }) => {
        const slide = await openPhone(page);
        await scrollToRow(slide, F.agentLive);
        await rowOf(slide, F.agentLive).tap();
        await expect(slideOf(page)).not.toHaveClass(/is-open/);
        await openList(page);
        await expect.poll(async () => (await placement(slide, F.agentLive)).inView).toBe(true);
        // The person reads the top of the list, then closes it without picking anything.
        expect(await setScrollTop(slide, 0)).toBe(0);
        expect((await placement(slide, F.agentLive)).inView).toBe(false);
        await page.locator(".ps-mobile-session-backdrop").click({ position: { x: 370, y: 400 } });
        await expect(slideOf(page)).not.toHaveClass(/is-open/);
        await openList(page);
        await expect.poll(async () => (await placement(slide, F.agentLive)).inView, "the selected row is in view").toBe(true);
        expect((await placement(slide, F.agentLive)).offMiddle).toBeLessThanOrEqual(1);
        // Only the list moved: the focus is not in it.
        expect(await page.evaluate(() => Boolean(document.activeElement?.closest(".ps-session-list")))).toBe(false);
    });

    test("panned sideways past the selected row's text: opening again pans back to it, and keeps the list's height", async ({ page }) => {
        const slide = await openPhone(page);
        await scrollToRow(slide, F.agentLive);
        await rowOf(slide, F.agentLive).tap();
        await expect(slideOf(page)).not.toHaveClass(/is-open/);
        await openList(page);
        await expect.poll(async () => (await placement(slide, F.agentLive)).inView).toBe(true);
        const top = (await placement(slide, F.agentLive)).scrollTop;
        // The long first row makes the rows' track wider than the list: pan it to its far end.
        const panned = await slide.locator(".ps-session-list-track").evaluate((track) => { track.scrollLeft = track.scrollWidth; return Math.round(track.scrollLeft); });
        expect(panned).toBeGreaterThan(100);
        const textStart = () => rowOf(slide, F.agentLive).evaluate((row) => {
            const content = row.querySelector(".ps-session-row-content");
            const track = row.closest(".ps-session-list-track");
            const start = content.getBoundingClientRect().left + parseFloat(getComputedStyle(content).paddingInlineStart);
            const box = track.getBoundingClientRect();
            return { visible: start >= box.left && start <= box.right - 48, scrollLeft: Math.round(track.scrollLeft) };
        });
        expect((await textStart()).visible).toBe(false);
        await page.getByRole("button", { name: "Hide the session list", exact: true }).tap();
        await expect(slideOf(page)).not.toHaveClass(/is-open/);
        await openList(page);
        await expect.poll(async () => (await textStart()).visible, "the row's text is in view").toBe(true);
        expect((await textStart()).scrollLeft).toBeLessThan(panned);
        // In view up and down already: the list kept its height.
        expect((await placement(slide, F.agentLive)).scrollTop).toBe(top);
    });

    test("a list closed and opened again over a row still in view does not move", async ({ page }) => {
        const slide = await openPhone(page);
        await scrollToRow(slide, F.agentLive);
        await rowOf(slide, F.agentLive).tap();
        await expect(slideOf(page)).not.toHaveClass(/is-open/);
        await openList(page);
        await expect.poll(async () => (await placement(slide, F.agentLive)).inView).toBe(true);
        // Moved a little by hand: the row is still in full view, near the top of the list.
        const before = await placement(slide, F.agentLive);
        const nudged = await setScrollTop(slide, before.scrollTop + 200);
        expect((await placement(slide, F.agentLive)).inView).toBe(true);
        await page.getByRole("button", { name: "Hide the session list", exact: true }).tap();
        await expect(slideOf(page)).not.toHaveClass(/is-open/);
        await openList(page);
        await page.waitForTimeout(300);
        const after = await placement(slide, F.agentLive);
        expect(after.inView).toBe(true);
        expect(after.scrollTop, "the list stays where the person left it").toBe(nudged);
    });

    test("a row in view when the list is built again: the list stays at the top", async ({ page }) => {
        const slide = await openPhone(page);
        const near = "11111112-2222-3333-4444-555555555552";
        expect(await setScrollTop(slide, 0)).toBe(0);
        await rowOf(slide, near).tap();
        await expect(slideOf(page)).not.toHaveClass(/is-open/);
        await page.getByRole("button", { name: /^Diagnostics/ }).first().tap();
        await expect(page.locator(".ps-mobile-workspace")).toHaveCount(0);
        const again = await openList(page);
        await expect(rowOf(again, near)).toHaveClass(/is-selected/);
        await page.waitForTimeout(300);
        const after = await placement(again, near);
        expect(after.inView).toBe(true);
        expect(after.scrollTop).toBe(0);
    });
});

test.describe("desktop 1440x900", () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    const listOf = (page) => page.locator(".ps-workspace-main-grid .ps-session-pane .ps-session-list").first();

    async function openDesktop(page) {
        await routeProfile(page);
        await page.goto(`${base}/?session=${TOP}`);
        const list = listOf(page);
        await expect(rowOf(list, TOP)).toHaveClass(/is-selected/);
        await expect(rowOf(list, F.workflowDone)).toHaveCount(1);
        return list;
    }

    /**
     * Click a row where a person would: on the start of its text, which the list shows. Every desktop row is as wide as
     * the widest name (the sideways track), so a row's middle can sit past the list's right edge, under the chat. A plain
     * Playwright click aims there, finds the chat in the way ("intercepts pointer events"), and on its retry scrolls the
     * list and the track itself to reach the middle: that moved the list 46 px and the track 419 px (to its end) with no
     * page code involved, so the check measured Playwright, not the portal.
     */
    async function pick(scope, id) {
        const row = rowOf(scope, id);
        const x = await row.evaluate((el) => {
            const pan = el.closest(".ps-session-list-track") || el.closest(".ps-session-list");
            return Math.max(0, pan.getBoundingClientRect().left + pan.clientLeft - el.getBoundingClientRect().left) + 24;
        });
        const box = await row.boundingBox();
        await row.click({ position: { x, y: box.height / 2 } });
    }

    /** Count every scrollIntoView on a list row from now on. */
    const watchReveals = (page) => page.evaluate(() => {
        window.__revealCalls = [];
        const original = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function (options) {
            if (this.closest?.(".ps-session-list")) window.__revealCalls.push(this.getAttribute("data-session-id"));
            return original.call(this, options);
        };
    });

    test("a click in the list does not move it, and no row is scrolled into view", async ({ page }) => {
        const list = await openDesktop(page);
        await watchReveals(page);
        const positioned = await scrollToRow(list, F.agentCancelled);
        expect(positioned).toBeGreaterThan(0);
        const before = await placement(list, F.agentCancelled);
        await pick(list, F.agentCancelled);
        await expect(rowOf(list, F.agentCancelled)).toHaveClass(/is-selected/);
        await page.waitForTimeout(300);
        const after = await placement(list, F.agentCancelled);
        expect(after.scrollTop, "the list does not move up or down").toBe(positioned);
        expect(after.scrollLeft, "nor sideways").toBe(before.scrollLeft);
        expect(after.rowTop, "the row stays where the person clicked it").toBe(before.rowTop);
        expect(await page.evaluate(() => window.__revealCalls)).toEqual([]);
    });

    // A selection made outside the list while the list is on screen (here Back, which latches a navigation intent as a
    // deep link does) never moves the list, even onto a row that is out of view; the next time the list is shown, the
    // row is in view.
    for (const how of ["the Back button", "Alt+− in the chat box"]) {
        test(`a selection made elsewhere (${how}) does not move the list; shown again, the list shows the row`, async ({ page }) => {
            const errors = [];
            page.on("pageerror", collectPageErrors(errors));
            // Back and Forward keep a history per signed-in person: the stub's bootstrap names one here.
            await page.route("**/api/v1/bootstrap", async (route) => {
                const body = await (await route.fetch()).json();
                return route.fulfill({ json: { ...body, auth: { principal: { provider: "none", subject: "test", displayName: "Test User" },
                    authorization: { allowed: true, role: "user" } } } });
            });
            const back = page.getByRole("button", { name: /^Back.*\((Alt|Option)\+/ });
            const list = await openDesktop(page);
            const near = "11111112-2222-3333-4444-555555555552";
            // The person picks a row far down, then goes back to the top of the list and picks a row there.
            expect(await scrollToRow(list, F.agentCancelled)).toBeGreaterThan(0);
            await pick(list, F.agentCancelled);
            await expect(page.locator(".ps-chat-panel:visible .ps-panel-title").first()).toContainText("Flaky test hunter");
            expect(await list.evaluate((element) => { element.scrollTop = 0; return element.scrollTop; })).toBe(0);
            await pick(list, near);
            await expect(rowOf(list, near)).toHaveClass(/is-selected/);
            await expect(page.locator(".ps-chat-panel:visible .ps-panel-title").first()).not.toContainText("Flaky test hunter");
            await expect(back).toBeEnabled();
            const before = await placement(list, F.agentCancelled);
            expect(before.inView, "the far row is out of view").toBe(false);
            await watchReveals(page);

            if (how === "the Back button") {
                await back.click();
            } else {
                await page.locator(".ps-chat-panel:visible textarea.ps-prompt-input").focus();
                await page.keyboard.press("Alt+-");
            }
            await expect(rowOf(list, F.agentCancelled)).toHaveClass(/is-selected/);
            await expect(page.locator(".ps-chat-panel:visible .ps-panel-title").first()).toContainText("Flaky test hunter");
            await page.waitForTimeout(300);
            const after = await placement(list, F.agentCancelled);
            expect(after.scrollTop, "the list does not move").toBe(before.scrollTop);
            expect(after.scrollLeft, "nor sideways").toBe(before.scrollLeft);
            expect(after.inView).toBe(false);
            expect(await page.evaluate(() => window.__revealCalls)).toEqual([]);

            // Shown again: Budget takes the workspace's place, and closing it builds the list again.
            await page.getByRole("button", { name: /^Budget — providers/ }).click();
            await expect(listOf(page)).toHaveCount(0);
            await page.getByRole("button", { name: "Close budget" }).click();
            await expect(rowOf(listOf(page), F.agentCancelled)).toHaveClass(/is-selected/);
            await expect.poll(async () => (await placement(listOf(page), F.agentCancelled)).inView, "the selected row is in view").toBe(true);
            expect((await placement(listOf(page), F.agentCancelled)).offMiddle).toBeLessThanOrEqual(1);
            expect(errors).toEqual([]);
        });
    }

    test("the list built again after Budget closes shows the selected row", async ({ page }) => {
        const list = await openDesktop(page);
        expect(await scrollToRow(list, F.workflowDone)).toBeGreaterThan(0);
        await pick(list, F.workflowDone);
        await expect(rowOf(list, F.workflowDone)).toHaveClass(/is-selected/);
        const budget = page.getByRole("button", { name: /^Budget — providers/ });
        await budget.click();
        await expect(page.locator(".ps-budget-surface")).toBeVisible();
        await expect(listOf(page)).toHaveCount(0);
        await page.getByRole("button", { name: "Close budget" }).click();
        await expect(rowOf(listOf(page), F.workflowDone)).toHaveClass(/is-selected/);
        await expect.poll(async () => (await placement(listOf(page), F.workflowDone)).inView).toBe(true);
        expect((await placement(listOf(page), F.workflowDone)).offMiddle).toBeLessThanOrEqual(1);
    });

    test("a row in view when Budget closes: the list stays where it was built", async ({ page }) => {
        const list = await openDesktop(page);
        const near = "11111112-2222-3333-4444-555555555552";
        await pick(list, near);
        await expect(rowOf(list, near)).toHaveClass(/is-selected/);
        await page.getByRole("button", { name: /^Budget — providers/ }).click();
        await expect(listOf(page)).toHaveCount(0);
        await page.getByRole("button", { name: "Close budget" }).click();
        await expect(rowOf(listOf(page), near)).toHaveClass(/is-selected/);
        await page.waitForTimeout(300);
        const after = await placement(listOf(page), near);
        expect(after.inView).toBe(true);
        expect(after.scrollTop).toBe(0);
    });
});
