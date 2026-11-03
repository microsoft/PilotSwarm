// The phone's session list slides over the chat.
//
// WHY THIS EXISTS: the list used to sit inline above the chat in a strip about
// 150px tall, roughly three rows, and the chat lost that height too. Now the
// chat keeps the whole height and the leftmost toolbar button slides the list
// over it, at full height, with its usual rows.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 40 }); base = `http://127.0.0.1:${stub.port}`; });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const listButton = page => page.getByRole("button", { name: "Sessions", exact: true });
const slide = page => page.locator(".ps-mobile-session-slideover");
const visibleRows = page => page.locator(".ps-mobile-session-slideover .ps-session-list-button[data-session-id]").evaluateAll(rows => {
    const list = rows[0]?.closest(".ps-session-list");
    if (!list) return 0;
    let scroller = list;
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
    const box = (scroller || list).getBoundingClientRect();
    return rows.filter(row => { const r = row.getBoundingClientRect(); return r.top >= box.top && r.bottom <= box.bottom; }).length;
});

async function openPhone(page) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    await expect(page.locator(".ps-mobile-chat-pane textarea")).toBeVisible();
}

test("the filter sits in the list's header, not the toolbar", async ({ page }) => {
    await openPhone(page);
    await expect(page.locator(".ps-toolbar.is-mobile").getByRole("button", { name: "Filter sessions" })).toHaveCount(0);
    await listButton(page).click();
    await page.locator(".ps-mobile-session-slideover").getByRole("button", { name: "Filter sessions" }).click();
    await expect(page.locator(".ps-modal")).toBeVisible();
});

test("the list button is leftmost, and the chat keeps the whole height while the list is closed", async ({ page }) => {
    await openPhone(page);
    const first = page.locator(".ps-toolbar.is-mobile button").first();
    await expect(first).toHaveAttribute("aria-label", "Sessions");
    await expect(slide(page)).not.toHaveClass(/is-open/);
    await expect(slide(page)).toBeHidden();
    const chat = await page.locator(".ps-mobile-chat-pane").boundingBox();
    const workspace = await page.locator(".ps-mobile-workspace").boundingBox();
    expect(chat.height).toBeGreaterThan(workspace.height - 2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("opening shows many rows over a dimmed chat; picking a session closes it", async ({ page }) => {
    await openPhone(page);
    await listButton(page).click();
    await expect(slide(page)).toHaveClass(/is-open/);
    await expect(page.locator(".ps-mobile-session-backdrop.is-open")).toBeVisible();
    await expect.poll(async () => (await slide(page).boundingBox()).x).toBeGreaterThanOrEqual(-1);
    const box = await slide(page).boundingBox();
    expect(box.width).toBeGreaterThan(390 * 0.8);
    expect(box.width).toBeLessThanOrEqual(390 * 0.87);
    await expect.poll(() => visibleRows(page)).toBeGreaterThanOrEqual(10);

    const target = page.locator(".ps-mobile-session-slideover .ps-session-list-button[data-session-id]:not([data-group-row])").nth(5);
    const targetId = await target.getAttribute("data-session-id");
    await target.click();
    await expect(slide(page)).not.toHaveClass(/is-open/);
    await expect(page.locator(".ps-mobile-session-slideover .ps-session-list-button.is-selected")).toHaveAttribute("data-session-id", targetId);
});

test("the dimmed chat, the list button and Escape all close it; it keeps its scroll position", async ({ page }) => {
    await openPhone(page);
    await listButton(page).click();
    await expect(slide(page)).toHaveClass(/is-open/);
    await page.mouse.click(380, 600);
    await expect(slide(page)).not.toHaveClass(/is-open/);

    await listButton(page).click();
    await expect(slide(page)).toHaveClass(/is-open/);
    const scrolled = await page.locator(".ps-mobile-session-slideover .ps-session-list").evaluate(list => {
        let s = list; while (s && !(s.scrollHeight > s.clientHeight + 1)) s = s.parentElement;
        s.scrollTop = 300; return s.scrollTop;
    });
    expect(scrolled).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Hide the session list", exact: true }).click();
    await expect(slide(page)).not.toHaveClass(/is-open/);

    await listButton(page).click();
    const restored = await page.locator(".ps-mobile-session-slideover .ps-session-list").evaluate(list => {
        let s = list; while (s && !(s.scrollHeight > s.clientHeight + 1)) s = s.parentElement;
        return s.scrollTop;
    });
    expect(restored).toBe(scrolled);
    await page.keyboard.press("Escape");
    await expect(slide(page)).not.toHaveClass(/is-open/);
});

test("from diagnostics, the list button returns to the chat and opens the list", async ({ page }) => {
    await openPhone(page);
    await page.getByRole("button", { name: /^Diagnostics — / }).first().click();
    await expect(page.locator(".ps-mobile-workspace")).toHaveCount(0);
    await listButton(page).click();
    await expect(slide(page)).toHaveClass(/is-open/);
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(slide(page)).not.toHaveClass(/is-open/);
});

test("desktop is unchanged: no list button, the list stays in its column", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base);
    await expect(page.locator(".ps-session-list-button").first()).toBeVisible();
    await expect(listButton(page)).toHaveCount(0);
    await expect(slide(page)).toHaveCount(0);
});

test("the open list is opaque: the chat never shows through it", async ({ page }) => {
    await openPhone(page);
    await listButton(page).click();
    await expect(slide(page)).toHaveClass(/is-open/);
    const bg = await slide(page).evaluate(node => getComputedStyle(node).backgroundColor);
    const alpha = bg.startsWith("rgba") ? Number(bg.slice(bg.lastIndexOf(",") + 1, -1)) : 1;
    expect(alpha).toBe(1);
});

test("a parent's chevron opens its sub-agents without picking it or closing the list", async ({ browser }) => {
    // Sessions 1 and 2 are sub-agents of session 0.
    const parents = { 1: 0, 2: 0 };
    const tree = await startStubServer(0, { sessionCount: 6, parents });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
        await page.goto(`http://127.0.0.1:${tree.port}`);
        await page.getByRole("button", { name: "Sessions", exact: true }).click();
        await expect(slide(page)).toHaveClass(/is-open/);
        const parent = slide(page).locator('.ps-session-list-button[data-session-id="11111110-2222-3333-4444-555555555550"]');
        const child = slide(page).locator('.ps-session-list-button[data-session-id="11111111-2222-3333-4444-555555555551"]');
        const chevron = parent.locator(".ps-session-row-disclosure");
        await expect(chevron).toBeVisible();
        const wasSelected = await parent.getAttribute("aria-selected");
        if (await chevron.getAttribute("aria-expanded") === "true") {
            await chevron.click();
            await expect(child).toHaveCount(0);
        }
        await chevron.click();
        await expect(chevron).toHaveAttribute("aria-expanded", "true");
        await expect(child).toBeVisible();
        await expect(slide(page)).toHaveClass(/is-open/);
        expect(await parent.getAttribute("aria-selected")).toBe(wasSelected);
        // The chevron stands in for the parent's status mark: the parent's
        // title starts where a sibling's does, not one chevron further in.
        const sibling = slide(page).locator('.ps-session-list-button[data-session-id="11111113-2222-3333-4444-555555555553"]');
        const textLeft = (row) => row.locator('.ps-session-row-title__text').evaluate(n => n.getBoundingClientRect().left);
        expect(Math.abs(await textLeft(parent) - await textLeft(sibling))).toBeLessThanOrEqual(1);
        // And a sub-agent's title starts further in than its parent's.
        expect(await textLeft(child)).toBeGreaterThan(await textLeft(parent) + 4);
        // The sub-agent itself is an ordinary pick: it opens and closes the list.
        await child.click();
        await expect(slide(page)).not.toHaveClass(/is-open/);
        await expect(slide(page).locator(".ps-session-list-button.is-selected")).toHaveAttribute("data-session-id", "11111111-2222-3333-4444-555555555551");
    } finally {
        await page.close();
        await new Promise((resolve) => tree.server.close(resolve));
    }
});

test("rows in the slide-over are two points larger than the dense list text", async ({ page }) => {
    await openPhone(page);
    await listButton(page).click();
    await expect(slide(page)).toHaveClass(/is-open/);
    const sizes = await slide(page).locator(".ps-session-list-button[data-session-id] .ps-session-row-title__text").first().evaluate(node => ({
        row: parseFloat(getComputedStyle(node).fontSize),
        dense: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ps-font-size-dense")),
        height: node.closest(".ps-session-list-button").getBoundingClientRect().height,
    }));
    expect(sizes.row).toBeCloseTo(sizes.dense + 2, 1);
    expect(sizes.height).toBeGreaterThanOrEqual(28);
});
