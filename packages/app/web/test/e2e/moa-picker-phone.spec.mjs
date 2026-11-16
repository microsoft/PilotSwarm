// The session picker on a phone: Master of Agents panels and the maximized
// chat's session selector.
//
// WHY THIS EXISTS: the picker kept the desktop list (owner avatars, dense
// rows, no sub-agent chevrons) while the phone's own session list became a
// slide-over with larger rows, chevrons and native scrolling. Its + and ×
// were 30px: the MoA rule that makes phone dialog buttons 44px is scoped to
// the workspace, and the dialog is portalled to <body>.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 30, parents: { 1: 0, 2: 0, 3: 1 } }); base = `http://127.0.0.1:${stub.port}`; });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

async function openPhone(page) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base);
    await expect(page.locator(".ps-mobile-chat-pane textarea")).toBeVisible();
}

const pickers = {
    "maximized chat": async (page) => {
        await page.locator(".ps-chat-panel").getByRole("button", { name: "Enter mobile zen" }).click();
        await page.getByRole("button", { name: "Select session" }).click();
    },
    "Master of Agents": async (page) => {
        await page.getByRole("button", { name: "Master of Agents", exact: true }).click();
        await page.getByRole("button", { name: "Add first MoA panel" }).click();
    },
};

async function slideoverLook(page) {
    await page.getByRole("button", { name: "Sessions", exact: true }).click();
    const row = page.locator(".ps-mobile-session-slideover .ps-session-list-button[data-session-id]").first();
    await expect(row).toBeVisible();
    const look = await row.evaluate(node => ({ font: getComputedStyle(node).fontSize, avatars: node.closest(".ps-session-list").querySelectorAll(".ps-owner-avatar").length }));
    await page.getByRole("button", { name: "Hide the session list", exact: true }).click();
    return look;
}

for (const [where, open] of Object.entries(pickers)) test(`${where}: the phone picker matches the session slide-over`, async ({ page }) => {
    await openPhone(page);
    const slideover = await slideoverLook(page);
    await open(page);
    const picker = page.locator(".ps-moa-session-picker");
    await expect(picker).toBeVisible();
    const list = picker.locator(".ps-session-list");

    // The same rows: the slide-over's font and no owner avatars.
    const row = list.locator(".ps-session-list-button[data-session-id]").first();
    expect(await row.evaluate(node => getComputedStyle(node).fontSize)).toBe(slideover.font);
    expect(await list.locator(".ps-owner-avatar").count()).toBe(slideover.avatars);

    // Sub-agents fold behind a chevron in the status mark's place; a tap on it
    // folds without picking the row.
    const chevron = list.locator(".ps-session-row-disclosure").first();
    await expect(chevron).toBeVisible();
    const parent = chevron.locator("xpath=ancestor::*[contains(@class,'ps-session-list-button')][1]");
    const parentId = await parent.getAttribute("data-session-id");
    const before = await list.locator(".ps-session-list-button[data-session-id]").count();
    await chevron.click();
    await expect.poll(() => list.locator(".ps-session-list-button[data-session-id]").count()).not.toBe(before);
    await expect(page.locator(".ps-moa-picker-detail > div").first()).not.toHaveText(new RegExp(parentId.slice(0, 8)));

    // Native vertical scrolling. No sideways track in a picker: long titles
    // end in an ellipsis, which keeps search fast on a large list.
    const shape = await list.evaluate(el => ({ x: getComputedStyle(el).overflowX, y: getComputedStyle(el).overflowY, track: Boolean(el.querySelector(".ps-session-list-track")), wide: el.scrollWidth - el.clientWidth }));
    expect(shape).toEqual({ x: "hidden", y: "auto", track: false, wide: 0 });

    // + and × are phone-sized.
    for (const name of ["Create New Session", "Close dialog"]) {
        const box = await picker.locator(".ps-panel-header").getByRole("button", { name, exact: true }).boundingBox();
        expect(box.width, name).toBeGreaterThanOrEqual(44);
        expect(box.height, name).toBeGreaterThanOrEqual(44);
    }
});

test("desktop: the MoA picker uses the same list", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base);
    await page.getByRole("button", { name: "Master of Agents", exact: true }).click();
    await page.getByRole("button", { name: "Add first MoA panel" }).click();
    const picker = page.locator(".ps-moa-session-picker");
    await expect(picker).toBeVisible();
    await expect(picker).toHaveClass(/is-phone-picker/);
    await expect(picker.locator(".ps-session-row-disclosure").first()).toBeVisible();
    await expect(picker.locator(".ps-session-list-track")).toHaveCount(0);
    for (const name of ["Create New Session", "Close dialog"]) {
        const box = await picker.locator(".ps-panel-header").getByRole("button", { name, exact: true }).boundingBox();
        expect(box.width, name).toBeGreaterThanOrEqual(44);
    }
    // The desktop session list itself is unchanged.
    await page.keyboard.press("Escape");
});
