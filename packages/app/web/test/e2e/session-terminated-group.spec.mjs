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
// and the row reads well in a modern and a retro theme.
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
        await expect(terminated).toHaveText("Terminated 4 · 1 failed");
        await expect(terminated).toHaveAttribute("aria-expanded", "false");
        await expect(terminated).toHaveAttribute("aria-selected", "false");
        // A disclosure chevron, not the TUI's ▸/▾ glyph; a muted row with nothing a session row has.
        await expect(terminated.locator(".ps-terminated-chevron")).toBeVisible();
        await expect(terminated.locator(".ps-terminated-chevron")).not.toHaveClass(/is-open/);
        for (const selector of [".ps-owner-avatar", ".ps-session-status-dot", ".ps-wf-state", ".ps-session-row-badge", ".ps-session-row-ctx",
            ".ps-session-row-disclosure"]) {
            await expect(terminated.locator(selector), selector).toHaveCount(0);
        }
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
        await expect(rowOf(list, NESTED_TERMINATED)).toHaveText("Terminated 1");
        // The chat did not change: the same session is selected and on screen.
        await expect(rowOf(list, F.parent)).toHaveClass(/is-selected/);
        await expect(terminated).toHaveAttribute("aria-selected", "false");
        await expect.poll(chatName).toBe(title);

        await terminated.click();
        await expect(terminated).toHaveAttribute("aria-expanded", "false");
        await expect.poll(() => familyIds(list)).toEqual(CLOSED_ORDER);

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
        await expect(terminated).toHaveText("Terminated 4 · 1 failed");
        await expect(rowOf(slide, F.parent)).toHaveClass(/is-selected/);
        await expect.poll(() => familyIds(slide)).toEqual(CLOSED_ORDER);

        await terminated.tap();
        await expect(terminated).toHaveAttribute("aria-expanded", "true");
        await expect.poll(() => familyIds(slide)).toEqual(OPEN_ORDER);
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
        await expect(terminated).toHaveText("Terminated 4 · 1 failed");

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
        await expect(terminated).toHaveText("Terminated 4 · 1 failed");
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
            return { label: read("Terminated 4"), failed: read("1 failed") };
        });
        console.log(`${themeId}: ${JSON.stringify(measured)}`);
        expect(measured.label, "the words are drawn").not.toBeNull();
        expect(measured.failed, "the failed count is drawn").not.toBeNull();
        for (const part of [measured.label, measured.failed]) {
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
