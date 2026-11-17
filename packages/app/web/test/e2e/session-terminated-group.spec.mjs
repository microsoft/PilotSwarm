// Plan 3: in a session's list of children, the Workflows come first, then the
// other sub-agents, and the finished children (completed, cancelled, failed)
// sit under one closed "Terminated" row at the end.
//
// WHY THIS EXISTS: ui/core builds the rows (unit tests cover the order, the
// words and the open state). Only a browser shows that the portal draws the row
// as a disclosure and not as a session: a click or a tap opens and closes it on
// the desktop, in the phone slide-over and in the Master of Agents picker, the
// chat stays where it was, nothing can drag, pin or multi-select it, the open
// state survives a reload, a deep link opens the group that holds its session,
// a group closed over the chat's session stays closed while the portal keeps
// reading the catalog, the row shows its count in the same [+N] badge a parent
// row draws (closed: all it holds; open: what is still hidden), and the row
// reads well in a modern and a retro theme.
//
// Run (from packages/app, after `npm run build:web`):
//   npx playwright test --config=web/playwright.config.mjs web/test/e2e/session-terminated-group.spec.mjs
// PS_E2E_SHOTS=<dir> saves a screenshot of the row in each theme.
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { startStubServer, TERMINATED_FAMILY, TERMINATED_FAMILY_IDS as F } from "./stub-server.mjs";
import { collectPageErrors } from "./page-errors.mjs";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
const SHOTS = process.env.PS_E2E_SHOTS || null;

let stub, base;
test.beforeAll(async () => {
    stub = await startStubServer(0, { sessionCount: 1, extraSessions: TERMINATED_FAMILY });
    base = `http://127.0.0.1:${stub.port}`;
});
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const TERMINATED = `terminated:${F.parent}`;
const NESTED_TERMINATED = `terminated:${F.agentFailed}`;
const CLOSED_ORDER = [F.parent, F.workflowLive, F.agentLive, TERMINATED];
const OPEN_ORDER = [F.parent, F.workflowLive, F.agentLive, TERMINATED,
    F.workflowDone, F.agentDone, F.agentFailed, NESTED_TERMINATED, F.agentCancelled];

/**
 * The profile, kept across reloads as the server keeps it. By default every parent is expanded
 * (`collapsedSessionIds: []`), so the Terminated rows are in view without opening their parents first.
 */
async function routeProfile(page, initial = { collapsedSessionIds: [] }) {
    const profile = { settings: structuredClone(initial) };
    await page.route("**/api/v1/me/profile/settings", async (route) => {
        profile.settings = structuredClone(route.request().postDataJSON().settings);
        await route.fulfill({ json: { ok: true, result: { profileSettings: profile.settings } } });
    });
    await page.route("**/api/v1/me/profile", (route) => route.fulfill({
        json: { ok: true, result: { isAdmin: false, profileSettings: profile.settings } },
    }));
    return profile;
}

/** Every request that named a Terminated row: none may reach the server (R4). */
function recordVirtualRequests(page) {
    const urls = [];
    page.on("request", (request) => {
        const url = decodeURIComponent(request.url());
        const body = request.postData() || "";
        if (url.includes("terminated:") || /"sessionIds?"\s*:\s*[^}]*terminated:/.test(body)) urls.push(`${request.method()} ${url}`);
    });
    return urls;
}

const rowOf = (scope, id) => scope.locator(`.ps-session-list-button[data-session-id="${id}"]`);
const rowIds = (scope) => scope.locator(".ps-session-list-button[data-session-id]")
    .evaluateAll((nodes) => nodes.map((node) => node.dataset.sessionId));
const familyIds = async (scope) => (await rowIds(scope)).filter((id) => id === F.parent || id.startsWith("terminated:") || id.startsWith("aaaa0000"));
const chatTitle = (page) => page.locator(".ps-chat-panel .ps-panel-title").first();
/** A row's [+N] badge text, or null when it has none: the element every parent row draws it in. */
const badgeOf = async (scope, id) => {
    const badge = rowOf(scope, id).locator(".ps-session-row-badge");
    return (await badge.count()) ? (await badge.innerText()).trim() : null;
};
/** The words and the badge of the family's rows, in list order. */
const familyBadges = async (scope) => Promise.all((await familyIds(scope)).map(async (id) => `${id} ${await badgeOf(scope, id)}`));

async function openDesktop(page, sessionId = F.parent) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/?session=${sessionId}`);
    const list = page.locator(".ps-session-pane .ps-session-list").first();
    await expect(rowOf(list, sessionId)).toHaveClass(/is-selected/);
    return list;
}

test.describe("desktop 1440x900", () => {
    test("order, closed by default; a click opens and closes it, and Enter on the focused row too; the chat stays", async ({ page }) => {
        const errors = [];
        page.on("pageerror", collectPageErrors(errors));
        await routeProfile(page);
        const virtual = recordVirtualRequests(page);
        const list = await openDesktop(page);
        await expect.poll(() => familyIds(list)).toEqual(CLOSED_ORDER);
        const terminated = rowOf(list, TERMINATED);
        // The words name no count; the count is the [+N] badge a parent row draws: closed, every session it holds
        // (four members and the failed one's child), the same five its parent hides.
        await expect(terminated.locator(".ps-session-row-title")).toHaveText("Terminated · 1 failed");
        await expect(terminated.locator(".ps-session-row-badge")).toHaveText("[+5]");
        await expect(terminated).toHaveText("Terminated · 1 failed [+5]");
        await expect(rowOf(list, F.parent).locator(".ps-session-row-badge")).toHaveText("[+5]");
        // The same distance from the row's right edge as the parent's badge: one column of [+N].
        const anchor = (id) => rowOf(list, id).evaluate((row) => Math.round(row.getBoundingClientRect().right
            - row.querySelector(".ps-session-row-badge").getBoundingClientRect().right));
        expect(await anchor(TERMINATED)).toBe(await anchor(F.parent));
        await expect(terminated).toHaveAttribute("aria-expanded", "false");
        await expect(terminated).toHaveAttribute("aria-selected", "false");
        // A disclosure chevron, not the TUI's ▸/▾ glyph; a muted row with nothing else a session row has.
        await expect(terminated.locator(".ps-terminated-chevron")).toBeVisible();
        await expect(terminated.locator(".ps-terminated-chevron")).not.toHaveClass(/is-open/);
        for (const selector of [".ps-owner-avatar", ".ps-session-status-dot", ".ps-wf-state", ".ps-session-row-ctx:not(.is-space)",
            ".ps-session-row-disclosure"]) {
            await expect(terminated.locator(selector), selector).toHaveCount(0);
        }
        // It keeps the ctx column's place, so its [+N] sits where its parent's does, and shows, reads and holds no ctx.
        const space = terminated.locator(".ps-session-row-ctx.is-space");
        await expect(space).toHaveCount(1);
        await expect(space).toBeHidden();
        await expect(space).toHaveAttribute("aria-hidden", "true");
        expect(await space.evaluate((node) => node.textContent)).toBe("");
        // Its indent is its depth: one rail and the same start as its live siblings.
        const indent = (id) => rowOf(list, id).evaluate((node) => ({
            rails: getComputedStyle(node).backgroundImage.split("linear-gradient").length - 1,
            start: getComputedStyle(node.querySelector(".ps-session-row-content")).paddingInlineStart,
        }));
        expect(await indent(TERMINATED)).toEqual(await indent(F.agentLive));
        // The chat's title names the session; its [+N] counts the children the list hides, so it follows the row.
        const chatName = async () => (await chatTitle(page).innerText()).replace(/\s*\[\+\d+\]/, "");
        const title = await chatName();
        expect(title).toContain("Release coordinator");

        await terminated.click();
        await expect(terminated).toHaveAttribute("aria-expanded", "true");
        await expect(terminated.locator(".ps-terminated-chevron")).toHaveClass(/is-open/);
        await expect.poll(() => familyIds(list)).toEqual(OPEN_ORDER);
        // Open: the failed member's child is still hidden in its own closed row, so the outer row, the member and the
        // nested row each count one.
        await expect(rowOf(list, NESTED_TERMINATED)).toHaveText("Terminated [+1]");
        await expect.poll(() => familyBadges(list)).toEqual([`${F.parent} [+1]`, `${F.workflowLive} null`, `${F.agentLive} null`,
            `${TERMINATED} [+1]`, `${F.workflowDone} null`, `${F.agentDone} null`, `${F.agentFailed} [+1]`, `${NESTED_TERMINATED} [+1]`,
            `${F.agentCancelled} null`]);
        // The same badge as a parent row's: the same element, style and place (right after the title, and the same
        // distance from the row's right edge, before the ctx column).
        const badgeLook = (id) => rowOf(list, id).evaluate((row) => {
            const badge = row.querySelector(".ps-session-row-badge");
            const title = row.querySelector(".ps-session-row-title");
            const style = getComputedStyle(badge);
            const run = getComputedStyle(badge.querySelector("span") || badge);
            return {
                parent: badge.parentElement.className.replace(/\s*has-workflow-state/, ""),
                after: badge.previousElementSibling === title,
                gap: Math.round(badge.getBoundingClientRect().left - title.getBoundingClientRect().right),
                fromRight: Math.round(row.getBoundingClientRect().right - badge.getBoundingClientRect().right),
                top: Math.round(badge.getBoundingClientRect().top - row.getBoundingClientRect().top),
                font: `${run.fontFamily} ${run.fontSize} ${run.fontWeight}`,
                color: run.color,
                padding: style.paddingInlineStart,
            };
        });
        // agentFailed is a real parent one level below T:P and one above T:agentFailed.
        expect(await badgeLook(TERMINATED)).toEqual(await badgeLook(F.agentFailed));
        expect(await badgeLook(NESTED_TERMINATED)).toEqual(await badgeLook(F.agentFailed));
        expect((await badgeLook(TERMINATED)).fromRight).toBe((await badgeLook(F.parent)).fromRight);
        // The chat did not change: the same session is selected and on screen.
        await expect(rowOf(list, F.parent)).toHaveClass(/is-selected/);
        await expect(terminated).toHaveAttribute("aria-selected", "false");
        await expect.poll(chatName).toBe(title);

        await terminated.click();
        await expect(terminated).toHaveAttribute("aria-expanded", "false");
        await expect.poll(() => familyIds(list)).toEqual(CLOSED_ORDER);
        await expect(terminated.locator(".ps-session-row-badge")).toHaveText("[+5]");

        await terminated.focus();
        await page.keyboard.press("Enter");
        await expect(terminated).toHaveAttribute("aria-expanded", "true");
        await expect.poll(() => familyIds(list)).toEqual(OPEN_ORDER);
        await page.keyboard.press("Enter");
        await expect(terminated).toHaveAttribute("aria-expanded", "false");
        await expect(rowOf(list, F.parent)).toHaveClass(/is-selected/);
        await expect.poll(chatName).toBe(title);
        expect(virtual).toEqual([]);
        expect(errors).toEqual([]);
    });

    test("the keyboard highlight moves onto the row; Enter then opens it and the chat stays", async ({ page }) => {
        await routeProfile(page);
        const list = await openDesktop(page, F.agentLive);
        const title = await chatTitle(page).innerText();
        await rowOf(list, F.agentLive).click();
        await page.keyboard.press("ArrowDown");
        const terminated = rowOf(list, TERMINATED);
        await expect(terminated).toHaveClass(/is-selected/);
        await expect(terminated).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(terminated).toHaveAttribute("aria-expanded", "true");
        await expect(chatTitle(page)).toHaveText(title);
    });

    test("the open state survives a reload", async ({ page }) => {
        const profile = await routeProfile(page);
        const list = await openDesktop(page);
        await rowOf(list, TERMINATED).click();
        await expect.poll(() => profile.settings.openTerminatedSessionIds).toEqual([F.parent]);
        await page.reload();
        await expect(rowOf(list, TERMINATED)).toHaveAttribute("aria-expanded", "true");
        await expect.poll(() => familyIds(list)).toEqual(OPEN_ORDER);

        await rowOf(list, TERMINATED).click();
        await expect.poll(() => profile.settings.openTerminatedSessionIds).toEqual([]);
        await page.reload();
        await expect(rowOf(list, TERMINATED)).toHaveAttribute("aria-expanded", "false");
        await expect.poll(() => familyIds(list)).toEqual(CLOSED_ORDER);
    });

    test("an open row's [+N] counts what a collapsed member hides, as a parent's does; nothing hidden, no badge", async ({ page }) => {
        const errors = [];
        page.on("pageerror", collectPageErrors(errors));
        const profile = await routeProfile(page, {
            collapsedSessionIds: [F.agentFailed], openTerminatedSessionIds: [F.parent, F.agentFailed],
        });
        const list = await openDesktop(page);
        const collapsedOrder = [F.parent, F.workflowLive, F.agentLive, TERMINATED, F.workflowDone, F.agentDone, F.agentFailed,
            F.agentCancelled];
        await expect.poll(() => familyIds(list)).toEqual(collapsedOrder);
        // The failed member is collapsed: it hides its child, and so do the open row and the parent above it.
        await expect.poll(() => familyBadges(list)).toEqual([`${F.parent} [+1]`, `${F.workflowLive} null`, `${F.agentLive} null`,
            `${TERMINATED} [+1]`, `${F.workflowDone} null`, `${F.agentDone} null`, `${F.agentFailed} [+1]`, `${F.agentCancelled} null`]);
        await expect(rowOf(list, TERMINATED)).toHaveText("Terminated · 1 failed [+1]");

        // The member open too, and its own row: every session shows, so no row has a badge.
        profile.settings = { ...profile.settings, collapsedSessionIds: [] };
        await page.reload();
        await expect.poll(() => familyIds(list)).toEqual([F.parent, F.workflowLive, F.agentLive, TERMINATED, F.workflowDone,
            F.agentDone, F.agentFailed, NESTED_TERMINATED, F.agentFailedChild, F.agentCancelled]);
        await expect.poll(() => familyBadges(list)).toEqual([F.parent, F.workflowLive, F.agentLive, TERMINATED, F.workflowDone,
            F.agentDone, F.agentFailed, NESTED_TERMINATED, F.agentFailedChild, F.agentCancelled].map((id) => `${id} null`));
        await expect(rowOf(list, TERMINATED)).toHaveText("Terminated · 1 failed");
        await expect(rowOf(list, NESTED_TERMINATED)).toHaveText("Terminated");
        expect(errors).toEqual([]);
    });

    test("under a search the row shows open for its matches; a click or Enter still saves the opposite choice", async ({ page }) => {
        const errors = [];
        page.on("pageerror", collectPageErrors(errors));
        const profile = await routeProfile(page, { collapsedSessionIds: [], openTerminatedSessionIds: [F.parent] });
        const virtual = recordVirtualRequests(page);
        const list = await openDesktop(page);
        const terminated = rowOf(list, TERMINATED);
        await expect(terminated).toHaveAttribute("aria-expanded", "true");
        await expect.poll(() => familyIds(list)).toEqual(OPEN_ORDER);
        // The chat's [+N] counts the children the list hides, so it follows the row; the name must not change.
        const chatName = async () => (await chatTitle(page).innerText()).replace(/\s*\[\+\d+\]/, "");
        const title = await chatName();
        expect(title).toContain("Release coordinator");
        const pane = page.locator(".ps-session-pane").first();
        const search = pane.getByRole("textbox", { name: "Find a session" });
        // The match, its real parent and the Terminated row that holds it: nothing else of the family.
        const SEARCH_ORDER = [F.parent, TERMINATED, F.agentDone];
        const clearSearch = () => pane.getByRole("button", { name: "Clear session search" }).click();

        // A match inside the group shows under the open row (R9); the click saves "closed" for when the search ends.
        await search.fill("Summary writer");
        await expect.poll(() => familyIds(list)).toEqual(SEARCH_ORDER);
        await expect(terminated).toHaveAttribute("aria-expanded", "true");
        // Under a search the badge counts what the results leave out, as the parent's does.
        await expect.poll(() => familyBadges(list)).toEqual([`${F.parent} [+6]`, `${TERMINATED} [+4]`, `${F.agentDone} null`]);
        await terminated.click();
        await expect.poll(() => profile.settings.openTerminatedSessionIds).toEqual([]);
        await expect(terminated).toHaveAttribute("aria-expanded", "true");
        await expect.poll(() => familyIds(list)).toEqual(SEARCH_ORDER);
        await clearSearch();
        await expect(terminated).toHaveAttribute("aria-expanded", "false");
        await expect.poll(() => familyIds(list)).toEqual(CLOSED_ORDER);
        await expect(rowOf(list, F.parent)).toHaveClass(/is-selected/);
        await expect.poll(chatName).toBe(title);

        // The other way, from the keyboard: the saved choice is "closed", the search still shows the row open, and
        // Enter on the focused row saves "open".
        await search.fill("Summary writer");
        await expect.poll(() => familyIds(list)).toEqual(SEARCH_ORDER);
        await expect(terminated).toHaveAttribute("aria-expanded", "true");
        await terminated.focus();
        await page.keyboard.press("Enter");
        await expect.poll(() => profile.settings.openTerminatedSessionIds).toEqual([F.parent]);
        await clearSearch();
        await expect(terminated).toHaveAttribute("aria-expanded", "true");
        await expect.poll(() => familyIds(list)).toEqual(OPEN_ORDER);
        await expect(rowOf(list, F.parent)).toHaveClass(/is-selected/);
        await expect.poll(chatName).toBe(title);
        expect(virtual).toEqual([]);
        expect(errors).toEqual([]);
    });

    test("a deep link to a finished child opens every group that holds it", async ({ page }) => {
        const errors = [];
        page.on("pageerror", collectPageErrors(errors));
        // No stored collapse state: parents start collapsed, as for a new person.
        await routeProfile(page, {});
        const virtual = recordVirtualRequests(page);
        const list = await openDesktop(page, F.agentFailedChild);
        await expect(rowOf(list, TERMINATED)).toHaveAttribute("aria-expanded", "true");
        await expect(rowOf(list, NESTED_TERMINATED)).toHaveAttribute("aria-expanded", "true");
        await expect(rowOf(list, F.agentFailedChild)).toBeVisible();
        await expect(chatTitle(page)).toContainText("Retry helper");
        expect(virtual).toEqual([]);
        expect(errors).toEqual([]);
    });

    // The owner's try-out (2026-11-17): "when one of the terminated workflows or sessions is selected, and I collapse the
    // Terminated node then it reopens in a few secs" (R7 as amended).
    test("a row closed over the chat's finished session stays closed through catalog refreshes", async ({ page }) => {
        const errors = [];
        page.on("pageerror", collectPageErrors(errors));
        const profile = await routeProfile(page);
        const virtual = recordVirtualRequests(page);
        // Each catalog refresh reads the folder list once.
        let refreshes = 0;
        page.on("requestfinished", (request) => {
            if (/\/management\/session-groups$/.test(new URL(request.url()).pathname)) refreshes += 1;
        });
        const list = await openDesktop(page);
        const terminated = rowOf(list, TERMINATED);
        await terminated.click();
        await expect.poll(() => familyIds(list)).toEqual(OPEN_ORDER);
        await rowOf(list, F.agentDone).click();
        await expect(rowOf(list, F.agentDone)).toHaveClass(/is-selected/);
        await expect(chatTitle(page)).toContainText("Summary writer");

        await terminated.click();
        await expect(terminated).toHaveAttribute("aria-expanded", "false");
        await expect.poll(() => familyIds(list)).toEqual(CLOSED_ORDER);
        await expect.poll(() => profile.settings.openTerminatedSessionIds).toEqual([]);
        // The portal reads the catalog every 4 s and starts a periodic read only when the last one is done, so after three
        // reads at least two refreshes have been applied.
        const closedAt = refreshes;
        await expect.poll(() => refreshes - closedAt, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
        await expect(terminated).toHaveAttribute("aria-expanded", "false");
        expect(await familyIds(list)).toEqual(CLOSED_ORDER);
        await expect(chatTitle(page)).toContainText("Summary writer");
        expect(profile.settings.openTerminatedSessionIds).toEqual([]);
        expect(virtual).toEqual([]);
        expect(errors).toEqual([]);
    });

    test("the row cannot be dragged, pinned, dropped on or multi-selected", async ({ page }) => {
        await routeProfile(page);
        const virtual = recordVirtualRequests(page);
        const list = await openDesktop(page);
        const terminated = rowOf(list, TERMINATED);
        await expect(terminated).toBeVisible();
        for (const attribute of ["data-orderable", "data-order-container", "data-drop-group", "data-group-row"]) {
            expect(await terminated.getAttribute(attribute), attribute).toBeNull();
        }
        await expect(terminated).not.toHaveClass(/is-pinned/);
        await expect(terminated.locator(".ps-pin-icon")).toHaveCount(0);

        // A drag from the row starts nothing. Released back on the row, the gesture is a click: it opens the row.
        const placements = stub.placements.length;
        const box = await terminated.boundingBox();
        const x = box.x + 40, y = box.y + box.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        for (let step = 1; step <= 6; step += 1) await page.mouse.move(x, y - step * 12);
        await expect(page.locator(".ps-drag-ghost")).toHaveCount(0);
        await expect(page.locator("body")).not.toHaveClass(/ps-dragging-sessions/);
        for (let step = 5; step >= 0; step -= 1) await page.mouse.move(x, y - step * 12);
        await page.mouse.up();
        expect(stub.placements.length).toBe(placements);
        await expect(terminated).toHaveAttribute("aria-expanded", "true");

        // Cmd/Ctrl-click makes no multi-selection and leaves the row as it was; a Shift range across it holds only sessions.
        await terminated.click({ modifiers: ["ControlOrMeta"] });
        await expect(list.locator(".ps-session-list-button.is-multiselected")).toHaveCount(0);
        await expect(terminated).toHaveAttribute("aria-expanded", "true");
        await rowOf(list, F.agentCancelled).click({ modifiers: ["Shift"] });
        await expect(page.getByText("7 selected", { exact: true })).toBeVisible();
        await expect(terminated).not.toHaveClass(/is-multiselected/);
        await expect(rowOf(list, NESTED_TERMINATED)).not.toHaveClass(/is-multiselected/);
        expect(virtual).toEqual([]);
    });
});

// An owner filter over families of mixed owners, on "Only mine". My session MP has a live child of mine and two finished
// ones: Bob's failed agent (it has a live child of Bob's) and my summary. A child passes the filter with an ancestor that
// passes, so all of MP's family is admitted, Bob's sessions too. Bob's session BQ has a failed child of Bob's and a failed
// child of mine; BQ does not pass, so its family shows only as a search result's ancestors, and its row then admits my
// member alone (R10). The row's words count the members it admits; its [+N] counts as a parent's does (R8): closed, every
// session it holds; open, what a collapse or the search still leaves out.
const ME = { provider: "none", subject: "test", email: "test@example.com", displayName: "Test User" };
const BOB = { provider: "none", subject: "bob", email: "bob@example.com", displayName: "Bob" };
const M = Object.freeze({
    mine: "bbbb0000-0000-4000-8000-000000000001",
    mineLive: "bbbb0000-0000-4000-8000-000000000002",
    bobFailed: "bbbb0000-0000-4000-8000-000000000003",
    bobFailedChild: "bbbb0000-0000-4000-8000-000000000004",
    mineDone: "bbbb0000-0000-4000-8000-000000000005",
    bob: "bbbb0000-0000-4000-8000-000000000006",
    bobsBobFailed: "bbbb0000-0000-4000-8000-000000000007",
    bobsMineFailed: "bbbb0000-0000-4000-8000-000000000008",
});
const mixedMember = (sessionId, title, status, createdOffset, owner, parentSessionId) => ({
    viewerGroupId: null,
    sessionId,
    title,
    status,
    model: "github-copilot:claude-sonnet-5",
    agentId: null,
    isSystem: false,
    owner,
    parentSessionId,
    createdAt: 1785000002000 + createdOffset,
    updatedAt: 1785000002000 + createdOffset,
    contextUsage: { currentTokens: 12_000, tokenLimit: 200_000 },
});
const MIXED_OWNER_FAMILIES = [
    mixedMember(M.mine, "My release", "idle", 0, ME, null),
    mixedMember(M.mineLive, "My log reader", "idle", 100, ME, M.mine),
    mixedMember(M.bobFailed, "Bob's build fixer", "failed", 200, BOB, M.mine),
    mixedMember(M.bobFailedChild, "Bob's retry", "idle", 300, BOB, M.bobFailed),
    mixedMember(M.mineDone, "My summary", "completed", 400, ME, M.mine),
    mixedMember(M.bob, "Bob's nightly", "idle", 500, BOB, null),
    mixedMember(M.bobsBobFailed, "Bob's flaky hunter", "failed", 600, BOB, M.bob),
    mixedMember(M.bobsMineFailed, "My smoke test", "failed", 700, ME, M.bob),
];
// Only my sessions, picked by owner: the stub runs with sign-in off, so it has no signed-in "me" for includeMe.
const ONLY_ME = { all: false, includeMe: false, includeShared: false, includeSystem: false, includeUnowned: false,
    ownerKeys: [`${ME.provider}\u0001${ME.subject}`] };
const MINE_TERMINATED = `terminated:${M.mine}`;
const BOB_TERMINATED = `terminated:${M.bob}`;

test.describe("owner filter, desktop 1440x900", () => {
    let mixedStub, mixedBase;
    test.beforeAll(async () => {
        mixedStub = await startStubServer(0, { sessionCount: 1, extraSessions: MIXED_OWNER_FAMILIES });
        mixedBase = `http://127.0.0.1:${mixedStub.port}`;
    });
    test.afterAll(async () => { await new Promise((resolve) => mixedStub.server.close(resolve)); });

    const mixedIds = async (list) => (await rowIds(list)).filter((id) => id.includes("bbbb0000"));
    const mixedBadges = async (list) => Promise.all((await mixedIds(list)).map(async (id) => `${id} ${await badgeOf(list, id)}`));
    /** The list with these profile settings, on my session. */
    async function openMixed(page, profile, settings) {
        profile.settings = { collapsedSessionIds: [], ...settings };
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(`${mixedBase}/?session=${M.mine}`);
        const list = page.locator(".ps-session-pane .ps-session-list").first();
        await expect(rowOf(list, M.mine)).toHaveClass(/is-selected/);
        return list;
    }

    test("the words count the members it admits; the [+N] counts as the parent's does, closed, open, collapsed and searched", async ({ page }) => {
        const errors = [];
        page.on("pageerror", collectPageErrors(errors));
        const profile = await routeProfile(page);
        const virtual = recordVirtualRequests(page);
        const title = (list, id) => rowOf(list, id).locator(".ps-session-row-title");

        // Closed: Bob's family is not listed. My row admits Bob's failed agent (under my session) and my summary, so it
        // names one failure; its [+N] counts the three sessions it holds (Bob's agent, its child and my summary), the
        // same three my session hides, and not the two members.
        let list = await openMixed(page, profile, { sessionOwnerFilter: ONLY_ME });
        await expect.poll(() => mixedIds(list)).toEqual([M.mine, M.mineLive, MINE_TERMINATED]);
        await expect(title(list, MINE_TERMINATED)).toHaveText("Terminated · 1 failed");
        await expect.poll(() => mixedBadges(list)).toEqual([`${M.mine} [+3]`, `${M.mineLive} null`, `${MINE_TERMINATED} [+3]`]);

        // Open: both members and Bob's agent's live child show. Nothing is hidden by a collapse: no badges.
        list = await openMixed(page, profile, { sessionOwnerFilter: ONLY_ME, openTerminatedSessionIds: [M.mine] });
        const openIds = [M.mine, M.mineLive, MINE_TERMINATED, M.bobFailed, M.bobFailedChild, M.mineDone];
        await expect.poll(() => mixedIds(list)).toEqual(openIds);
        await expect(rowOf(list, MINE_TERMINATED)).toHaveAttribute("aria-expanded", "true");
        await expect(title(list, MINE_TERMINATED)).toHaveText("Terminated · 1 failed");
        await expect.poll(() => mixedBadges(list)).toEqual(openIds.map((id) => `${id} null`));

        // Open with Bob's admitted agent collapsed: its child is hidden, so it, the row and my session each count one.
        list = await openMixed(page, profile, {
            sessionOwnerFilter: ONLY_ME, openTerminatedSessionIds: [M.mine], collapsedSessionIds: [M.bobFailed],
        });
        await expect.poll(() => mixedIds(list)).toEqual([M.mine, M.mineLive, MINE_TERMINATED, M.bobFailed, M.mineDone]);
        await expect.poll(() => mixedBadges(list)).toEqual([`${M.mine} [+1]`, `${M.mineLive} null`, `${MINE_TERMINATED} [+1]`,
            `${M.bobFailed} [+1]`, `${M.mineDone} null`]);

        // Searched: my smoke test under Bob's session. Its row admits only my member, so it names one failure, not Bob's
        // too; its [+N] and Bob's session's count the one session the search leaves out (Bob's failed agent).
        const pane = page.locator(".ps-session-pane").first();
        await pane.getByRole("textbox", { name: "Find a session" }).fill("My smoke test");
        await expect.poll(() => mixedIds(list)).toEqual([M.bob, BOB_TERMINATED, M.bobsMineFailed]);
        await expect(title(list, BOB_TERMINATED)).toHaveText("Terminated · 1 failed");
        await expect.poll(() => mixedBadges(list)).toEqual([`${M.bob} [+1]`, `${BOB_TERMINATED} [+1]`, `${M.bobsMineFailed} null`]);

        // The same search with no owner filter: both of Bob's session's members pass, so its row names two failures; the
        // [+N] is the same.
        list = await openMixed(page, profile, { sessionOwnerFilter: { ...ONLY_ME, all: true } });
        await pane.getByRole("textbox", { name: "Find a session" }).fill("My smoke test");
        await expect.poll(() => mixedIds(list)).toEqual([M.bob, BOB_TERMINATED, M.bobsMineFailed]);
        await expect(title(list, BOB_TERMINATED)).toHaveText("Terminated · 2 failed");
        await expect.poll(() => mixedBadges(list)).toEqual([`${M.bob} [+1]`, `${BOB_TERMINATED} [+1]`, `${M.bobsMineFailed} null`]);
        expect(virtual).toEqual([]);
        expect(errors).toEqual([]);
    });
});

test.describe("phone 390x844", () => {
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

    test("a tap in the slide-over opens and closes the row; the list stays open and the chat stays", async ({ page }) => {
        await routeProfile(page);
        const virtual = recordVirtualRequests(page);
        await page.goto(`${base}/?session=${F.parent}`);
        await expect(page.locator(".ps-mobile-chat-pane textarea")).toBeVisible();
        await page.getByRole("button", { name: "Sessions", exact: true }).tap();
        const slide = page.locator(".ps-mobile-session-slideover");
        await expect(slide).toHaveClass(/is-open/);
        const terminated = rowOf(slide, TERMINATED);
        await expect(terminated).toHaveText("Terminated · 1 failed [+5]");
        // The phone list draws every row's runs inline: the row's [+N] is drawn as its parent's is (same run, colour and
        // font, in the same kind of box), and both hide the same five sessions.
        const badgeRun = (id) => rowOf(slide, id).evaluate((row) => {
            const span = [...row.querySelectorAll("span")].find((node) => node.children.length === 0 && /^\[\+\d+\]$/.test(node.textContent.trim()));
            if (!span) return null;
            const style = getComputedStyle(span);
            return { text: span.textContent.trim(), color: style.color, font: `${style.fontFamily} ${style.fontSize} ${style.fontWeight}`,
                box: span.closest(".ps-session-row-badge") ? "badge" : "title" };
        });
        expect(await badgeRun(TERMINATED)).toEqual(await badgeRun(F.parent));
        expect((await badgeRun(TERMINATED))?.text).toBe("[+5]");
        await expect(rowOf(slide, F.parent)).toHaveClass(/is-selected/);
        await expect.poll(() => familyIds(slide)).toEqual(CLOSED_ORDER);

        await terminated.tap();
        await expect(terminated).toHaveAttribute("aria-expanded", "true");
        await expect.poll(() => familyIds(slide)).toEqual(OPEN_ORDER);
        await expect(terminated).toHaveText("Terminated · 1 failed [+1]");
        await expect(slide).toHaveClass(/is-open/);
        await expect(rowOf(slide, F.parent)).toHaveClass(/is-selected/);

        await terminated.tap();
        await expect(terminated).toHaveAttribute("aria-expanded", "false");
        await expect.poll(() => familyIds(slide)).toEqual(CLOSED_ORDER);
        await expect(slide).toHaveClass(/is-open/);
        expect(virtual).toEqual([]);
    });

    test("Master of Agents picker: a tap opens and closes the row and picks nothing", async ({ page }) => {
        await routeProfile(page);
        const virtual = recordVirtualRequests(page);
        await page.goto(`${base}/?session=${F.parent}`);
        await expect(page.locator(".ps-mobile-chat-pane textarea")).toBeVisible();
        await page.getByRole("button", { name: "Master of Agents", exact: true }).tap();
        await page.getByRole("button", { name: "Add first MoA panel" }).tap();
        const picker = page.locator(".ps-moa-session-picker");
        await expect(picker).toBeVisible();
        const footer = page.locator(".ps-moa-picker-detail > div").first();
        const picked = await footer.innerText();
        const terminated = rowOf(picker, TERMINATED);
        await expect(terminated).toHaveText("Terminated · 1 failed [+5]");

        await terminated.tap();
        await expect(terminated).toHaveAttribute("aria-expanded", "true");
        await expect(rowOf(picker, F.agentDone)).toBeVisible();
        await expect(footer).toHaveText(picked);

        await terminated.tap();
        await expect(terminated).toHaveAttribute("aria-expanded", "false");
        await expect(rowOf(picker, F.agentDone)).toHaveCount(0);
        await expect(footer).toHaveText(picked);
        expect(virtual).toEqual([]);
    });
});

// One modern and one retro theme: the words are drawn, in a colour that reads on the list's own background.
for (const themeId of ["github-light", "win95"]) {
    test(`theme ${themeId}: the row reads well`, async ({ page }) => {
        await routeProfile(page, { collapsedSessionIds: [], themeId });
        const list = await openDesktop(page);
        await expect(page.locator("html")).toHaveAttribute("data-ps-theme", themeId);
        const terminated = rowOf(list, TERMINATED);
        await expect(terminated).toHaveText("Terminated · 1 failed [+5]");
        const measured = await terminated.evaluate((row) => {
            // Colours through a 1x1 canvas, so any CSS colour (rgb(), color(srgb ...) from color-mix(), alpha) reads
            // the same, and translucent backgrounds composite over what is under them, as the browser paints them.
            const canvas = document.createElement("canvas");
            canvas.width = 1;
            canvas.height = 1;
            const context = canvas.getContext("2d", { willReadFrequently: true });
            const paint = (layers) => {
                context.globalCompositeOperation = "source-over";
                context.fillStyle = "#ffffff";
                context.fillRect(0, 0, 1, 1);
                for (const layer of layers) {
                    context.fillStyle = layer;
                    context.fillRect(0, 0, 1, 1);
                }
                return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
            };
            const luminance = ([r, g, b]) => {
                const channel = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
                return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
            };
            const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
            const groundLayers = (node) => {
                const layers = [];
                for (let at = node; at; at = at.parentElement) layers.unshift(getComputedStyle(at).backgroundColor);
                return layers;
            };
            const spans = [...row.querySelectorAll("span")].filter((span) => span.children.length === 0);
            const read = (text) => {
                const span = spans.find((candidate) => candidate.textContent.trim() === text);
                if (!span) return null;
                const layers = groundLayers(span);
                const back = paint(layers);
                const color = paint([...layers, getComputedStyle(span).color]);
                return { text, color, back, ratio: ratio(color, back), visible: span.getBoundingClientRect().width > 0 };
            };
            return { label: read("Terminated"), failed: read("1 failed"), badge: read("[+5]") };
        });
        console.log(`${themeId}: ${JSON.stringify(measured)}`);
        expect(measured.label, "the words are drawn").not.toBeNull();
        expect(measured.failed, "the failed count is drawn").not.toBeNull();
        expect(measured.badge, "the badge is drawn").not.toBeNull();
        for (const part of [measured.label, measured.failed, measured.badge]) {
            expect(part.visible, `${themeId}: ${part.text} is visible`).toBe(true);
            expect(part.color, `${themeId}: ${part.text} is not drawn in the background colour`).not.toEqual(part.back);
        }
        expect(measured.label.ratio, `${themeId}: label contrast ${JSON.stringify(measured.label)}`).toBeGreaterThanOrEqual(4.5);
        expect(measured.failed.ratio, `${themeId}: failed contrast ${JSON.stringify(measured.failed)}`).toBeGreaterThanOrEqual(3);
        if (SHOTS) {
            fs.mkdirSync(SHOTS, { recursive: true });
            await list.screenshot({ path: path.join(SHOTS, `terminated-row-${themeId}.png`) });
        }
    });
}
