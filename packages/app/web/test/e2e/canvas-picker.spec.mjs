import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

test.use({ browserName: process.env.PS_TEST_BROWSER || "chromium" });
const sessionId = "11111110-2222-3333-4444-555555555550";
const names = ["Design overview and decisions", "Implementation details and examples", "Release notes"];
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

async function openCanvas(page, { width = 1440, height = 900, theme = "horizon-dawn", slots = 3, maximized = false } = {}) {
    await page.route("**/api/v1/**", route => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/me/profile")) return route.fulfill({ json: { ok: true, result: { profileSettings: { themeId: theme } } } });
        if (url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_updated")) {
            return route.fulfill({ json: { ok: true, result: names.slice(0, slots).map((name, index) => ({
                seq: index + 1, eventType: "session.canvas_updated",
                data: { slot: index + 1, rev: 1, sizeBytes: 128, name },
            })) } });
        }
        if (url.pathname.includes("/artifacts/") && /canvas(?:[2-5])?\.html/.test(url.pathname)) {
            const slot = Number(/canvas([2-5])\.html/.exec(url.pathname)?.[1] || 1);
            return route.fulfill({ contentType: "text/html", body: `<!doctype html><h1>Canvas ${slot}</h1>` });
        }
        return route.fallback();
    });
    await page.setViewportSize({ width, height });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}&view=canvas${maximized ? "&max=1" : ""}`);
    const pane = page.locator(".ps-canvas-pane:visible").first();
    await expect(pane).toBeVisible();
    await expect(pane.locator("iframe.ps-html-preview-frame:not(.is-staging)").contentFrame().getByRole("heading", { name: "Canvas 1", exact: true })).toBeVisible();
    return pane;
}

async function pickerLook(picker) {
    return picker.evaluate(el => {
        const select = el.querySelector("select"), arrow = el.querySelector(".ps-canvas-slot-chevron");
        const r = el.getBoundingClientRect(), s = select.getBoundingClientRect();
        return {
            width: r.width, selectWidth: s.width,
            opacity: getComputedStyle(select).opacity,
            chevron: getComputedStyle(arrow).display,
            hitIsSelect: document.elementFromPoint(s.x + s.width / 2, s.y + s.height / 2) === select,
        };
    });
}

for (const theme of ["horizon-dawn", "win95"]) test(`${theme}: a narrow picker becomes a chevron without losing native selection`, async ({ page }) => {
    const pane = await openCanvas(page, { theme });
    const picker = pane.locator(".ps-canvas-slot-picker");
    const select = picker.getByRole("combobox", { name: "Choose canvas", exact: true });
    await expect(select.locator("option")).toHaveCount(3);
    for (const [index, name] of names.entries()) await expect(select.locator("option").nth(index)).toContainText(name);

    // Let the real flex layout allocate 64 px after the two arrow buttons.
    const controls = pane.locator(".ps-canvas-slot-controls");
    await controls.evaluate(el => { el.style.flex = "0 0 120px"; el.style.width = "120px"; });
    await expect.poll(async () => (await pickerLook(picker)).opacity).toBe("0");
    expect(await pickerLook(picker)).toEqual({ width: 64, selectWidth: 64, opacity: "0", chevron: "flex", hitIsSelect: true });
    await select.focus();
    await expect(picker).toHaveCSS("outline-style", "solid");
    await select.selectOption("2");
    await expect(select).toHaveValue("2");
    await expect(select).toHaveAttribute("title", `Choose canvas: ${names[1]}`);
    await expect(pane.locator("iframe.ps-html-preview-frame:not(.is-staging)").contentFrame().getByRole("heading", { name: "Canvas 2", exact: true })).toBeVisible();
    const heading = pane.locator(".ps-artifact-pane-heading");
    const next = pane.getByRole("button", { name: "Next canvas", exact: true });
    const nextBefore = await next.boundingBox();
    await pane.getByRole("button", { name: "Next canvas", exact: true }).click();
    await expect(select).toHaveValue("3");
    expect(await heading.evaluate(el => el.scrollLeft)).toBe(0);
    expect((await next.boundingBox()).x).toBe(nextBefore.x);
    await pane.getByRole("button", { name: "Previous canvas", exact: true }).click();
    await expect(select).toHaveValue("2");
    await page.screenshot({ path: test.info().outputPath("compact-picker.png") });

    await controls.evaluate(el => { el.style.flex = "0 0 176px"; el.style.width = "176px"; });
    await expect.poll(async () => (await pickerLook(picker)).opacity).toBe("1");
    expect((await pickerLook(picker)).chevron).toBe("none");
    await expect(select).toHaveValue("2");
    await page.screenshot({ path: test.info().outputPath("named-picker.png") });
});

for (const width of [1280, 1920]) test(`maximized ${width}px: picker and adjacent controls stay reachable`, async ({ page }) => {
    await openCanvas(page, { width, maximized: true });
    const header = page.locator(".portal-header");
    const picker = header.locator(".ps-canvas-slot-picker");
    await expect(picker).toBeVisible();
    const look = await pickerLook(picker);
    expect(look.width).toBeGreaterThanOrEqual(44);
    expect(look.hitIsSelect).toBe(true);
    expect(look.opacity).toBe(look.width <= 88 ? "0" : "1");
    const collisions = await header.evaluate(el => {
        const controls = [...el.querySelectorAll("button, select")].map(node => ({ node, box: node.getBoundingClientRect() })).filter(({ box }) => box.width && box.height);
        return controls.flatMap((a, index) => controls.slice(index + 1).filter(b =>
            Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left) > 1 &&
            Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top) > 1
        ).map(b => [a.node.getAttribute("aria-label"), b.node.getAttribute("aria-label")]));
    });
    expect(collisions).toEqual([]);
    await expect(header.getByRole("button", { name: "Restore canvas", exact: true })).toBeVisible();
    await expect(header.getByRole("button", { name: "Zoom out", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`maximized-${width}.png`) });
});

test.describe("touch phone", () => {
test.use({ hasTouch: true, isMobile: true });
test("collapsed picker remains selectable across rotation and full screen", async ({ page }) => {
    const pane = await openCanvas(page, { width: 390, height: 844 });
    const picker = pane.locator(".ps-canvas-slot-picker");
    const select = picker.getByRole("combobox", { name: "Choose canvas", exact: true });
    const look = await pickerLook(picker);
    expect(look.width).toBeGreaterThanOrEqual(44);
    expect(look.hitIsSelect).toBe(true);
    expect(look.opacity).toBe(look.width <= 88 ? "0" : "1");
    await select.selectOption("2");
    await pane.getByRole("button", { name: "Maximize canvas", exact: true }).click();
    await expect(select).toHaveValue("2");
    await page.setViewportSize({ width: 844, height: 390 });
    const handle = pane.getByRole("button", { name: "Canvas controls", exact: true });
    await expect(handle).toBeVisible();
    await handle.tap();
    await expect(select).toHaveValue("2");
    await select.selectOption("3");
    await expect(select).toHaveValue("3");
    await page.screenshot({ path: test.info().outputPath("phone-picker.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(844);
});
});

test("one drawn canvas has no slot picker", async ({ page }) => {
    const pane = await openCanvas(page, { slots: 1 });
    await expect(pane.locator(".ps-canvas-slot-controls")).toHaveCount(0);
});
