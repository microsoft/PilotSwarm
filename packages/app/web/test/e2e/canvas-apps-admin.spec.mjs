// Issue 181 PR 2 in a real browser: Admin Console → Canvas Apps (R23, R29),
// the collapsible and scrolling Packages / Canvas Apps tree (R24), and the
// canvas toolbar's "Publish as app" (R25), on desktop and on a phone.
//
// The fake server records every registry call (stub-server.mjs,
// canvasAppRegistry), so each write a click makes is proven at the API, and
// the manifest check is proven to send checkOnly and nothing else.
//
// The phone case is canvas-apps-admin-phone.spec.mjs: a device emulation
// must be set for the whole file (Playwright forbids it in a describe).
//
// Not covered here: the TUI (tui/test/admin-canvas-apps.test.mjs), the real
// registry's authorization (SDK canvas-app-portal-ops.test.js), and the
// Admin Console on a phone, which is desktop-only by design
// (toolbar-groups-mobile.spec.mjs).
import { test, expect } from "@playwright/test";
import { startStubServer, makeCanvasApp } from "./stub-server.mjs";
import { drawOwnCanvas, publishFlow } from "./canvas-apps-fixtures.mjs";

const OTHER = { provider: "none", subject: "bob" };

function seed() {
    return [
        makeCanvasApp("team-board", "shared"),
        makeCanvasApp("poll", "shared", OTHER, { canManage: false, canEdit: false }),
        makeCanvasApp("notes", "user"),
        makeCanvasApp("bobs-draft", "user", OTHER),
    ];
}

async function openCanvasApps(page, base) {
    await page.goto(base);
    await page.locator(".ps-session-list-button").first().waitFor();
    await page.locator('button[aria-label="Admin console"]').click();
    await page.locator('[data-tree-id="canvasApps"]').click();
    await expect(page.locator(".ps-canvas-app-detail, .ps-admin-detail.is-empty h3").first()).toBeVisible();
}

const row = (page, id) => page.locator(`[data-tree-id="${id}"]`);

test.describe("desktop: Admin → Canvas Apps", () => {
    let stub;
    let base;
    test.beforeEach(async () => {
        stub = await startStubServer(0, { sessionCount: 2, admin: true, canvasApps: seed() });
        base = `http://127.0.0.1:${stub.port}`;
    });
    test.afterEach(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

    test("the section sits next to Packages with Shared, Private and Other users", async ({ page }) => {
        await openCanvasApps(page, base);
        const sections = await page.locator(".ps-admin-tree__row.depth-0 .ps-admin-tree__name").allTextContents();
        expect(sections.indexOf("Canvas Apps")).toBe(sections.indexOf("Packages") + 1);
        await expect(row(page, "capps:shared")).toContainText("Shared");
        await expect(row(page, "capps:shared")).toContainText("2");
        await expect(row(page, "capps:mine")).toContainText("Private");
        await expect(row(page, "capps:others")).toContainText("Other users");
        await expect(row(page, "capp:user:bob:bobs-draft")).toContainText("bob");
    });

    test("the detail page shows the header, description, interface card, versions, contributors and loads", async ({ page }) => {
        await openCanvasApps(page, base);
        await row(page, "capp:shared::team-board").click();
        const detail = page.locator(".ps-canvas-app-detail");
        await expect(detail.locator("h3")).toHaveText("team-board");
        await expect(detail.locator(".ps-admin-detail__head")).toContainText("1.0.0");
        await expect(detail.locator(".ps-admin-detail__head")).toContainText("Shared");
        await expect(detail).toContainText("Test User");
        await expect(detail.locator(".ps-agent-chip")).toHaveText(["team"]);
        // The description keeps its paragraphs.
        await expect(detail.locator(".ps-canvas-app-detail__desc p")).toHaveCount(2);
        const card = detail.locator(".ps-canvas-app-card");
        await expect(card).toContainText("vote item: string, weight?: number");
        await expect(card).toContainText("app/item/<id>");
        await expect(card).toContainText("summarize");
        await expect(card).toContainText("expects back");
        await expect(card).toContainText("evt/<n>");
        await expect(card.locator(".ps-canvas-app-card__warning")).toContainText("workspace folders");
        await expect(detail.locator(".ps-admin-version")).toHaveCount(2);
        await expect(detail.locator(".ps-admin-version").nth(1).getByRole("button", { name: "Pin" })).toBeVisible();
        await expect(detail.locator(".ps-canvas-app-detail__people")).toContainText("Dev Person");
        await expect(detail).toContainText("1,234 in the last 30 days");
    });

    test("Preview runs the page in a sandboxed, isolated frame", async ({ page }) => {
        await openCanvasApps(page, base);
        await row(page, "capp:user:test:notes").click();
        await page.locator(".ps-canvas-app-detail").getByRole("button", { name: "Preview", exact: true }).first().click();
        const frame = page.locator("iframe.ps-canvas-app-preview__frame");
        await expect(frame).toHaveAttribute("sandbox", "allow-scripts");
        expect(await frame.getAttribute("src")).toMatch(/^blob:/);
        const inner = page.frameLocator("iframe.ps-canvas-app-preview__frame").frameLocator("iframe");
        await expect(inner.locator("#hello")).toHaveText("Hello from notes");
        await expect(inner.locator("#hello")).toHaveAttribute("data-ran", "1");
        // The wrapper holds none of the page's bytes, proven as in
        // canvas-isolation.spec.mjs: its live markup up to the inner frame
        // (whose srcdoc property reflects into the DOM) and its ORIGINAL
        // source, as the portal created it.
        const wrapper = await (await frame.elementHandle()).contentFrame();
        expect(wrapper.childFrames()).toHaveLength(1);
        const wrapperHtml = await wrapper.evaluate(() => document.documentElement.outerHTML.replace(/<iframe[\s\S]*$/i, ""));
        expect(wrapperHtml).not.toContain("Hello from notes");
        expect(wrapperHtml).toContain("frame-src 'none'");
        const source = await page.evaluate(async (url) => (await fetch(url)).text(), wrapper.url());
        expect(source).not.toContain("Hello from notes");
        expect(source).toContain("frame-src 'none'");
        expect(source).toMatch(/setAttribute\('sandbox','allow-scripts'\)/);
    });

    test("actions reach the API for exactly this copy: disable, pin, share, delete", async ({ page }) => {
        await openCanvasApps(page, base);
        await row(page, "capp:user:test:notes").click();
        const detail = page.locator(".ps-canvas-app-detail");
        await detail.getByRole("button", { name: "Disable" }).click();
        await expect.poll(() => stub.canvasAppCalls.find((c) => c.op === "setCanvasAppEnabled")).toMatchObject({ name: "notes", enabled: false, scope: "user", ownerProvider: "none", ownerSubject: "test" });
        await detail.locator(".ps-admin-version").nth(1).getByRole("button", { name: "Pin" }).click();
        await expect.poll(() => stub.canvasAppCalls.find((c) => c.op === "pinCanvasAppVersion")).toMatchObject({ name: "notes", version: "0.9.0" });
        await detail.getByRole("button", { name: "Share" }).click();
        await expect.poll(() => stub.canvasAppCalls.find((c) => c.op === "setCanvasAppScope")).toMatchObject({ name: "notes", targetScope: "shared" });
        page.once("dialog", (dialog) => dialog.accept());
        await page.locator(".ps-canvas-app-detail").getByRole("button", { name: "Delete" }).click();
        await expect.poll(() => stub.canvasAppCalls.find((c) => c.op === "deleteCanvasApp")).toMatchObject({ name: "notes" });
    });

    test("a read-only app offers no changes", async ({ page }) => {
        await openCanvasApps(page, base);
        await row(page, "capp:shared::poll").click();
        const detail = page.locator(".ps-canvas-app-detail");
        await expect(detail).toContainText("Read-only");
        await expect(detail.getByRole("button", { name: "Delete" })).toHaveCount(0);
        await expect(detail.getByRole("button", { name: "Disable" })).toHaveCount(0);
        await expect(detail.getByRole("button", { name: "Export" })).toBeVisible();
    });

    test("Add canvas app uploads an .html page", async ({ page }) => {
        await openCanvasApps(page, base);
        await page.getByRole("button", { name: "+ Add canvas app" }).click();
        const dialog = page.locator(".ps-canvas-app-add");
        await dialog.locator('input[type="file"]').setInputFiles({ name: "Release-Board.html", mimeType: "text/html", buffer: Buffer.from("<!doctype html><p>board</p>") });
        await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("release-board");
        await dialog.getByRole("radio", { name: /Shared/ }).check();
        await dialog.getByRole("button", { name: "Publish" }).click();
        await expect(dialog).toHaveCount(0);
        expect(stub.canvasAppCalls.find((c) => c.op === "uploadCanvasApp")).toMatchObject({ name: "release-board", scope: "shared", html: "<!doctype html><p>board</p>" });
    });

    test("collapse, keys and per-viewer state that survives a reload", async ({ page }) => {
        await openCanvasApps(page, base);
        const tree = page.locator("nav.ps-admin-tree");
        await row(page, "capps:shared").click();
        await expect(row(page, "capps:shared")).toHaveAttribute("aria-expanded", "false");
        await expect(row(page, "capps:shared")).toContainText("2");
        await expect(row(page, "capp:shared::team-board")).toHaveCount(0);
        // Keyboard: Right expands, Left collapses, Down moves, Enter toggles.
        await tree.focus();
        await page.keyboard.press("ArrowRight");
        await expect(row(page, "capps:shared")).toHaveAttribute("aria-expanded", "true");
        await page.keyboard.press("ArrowLeft");
        await expect(row(page, "capps:shared")).toHaveAttribute("aria-expanded", "false");
        await page.keyboard.press("ArrowDown");
        await expect(row(page, "capps:mine")).toHaveClass(/is-cursor/);
        await page.keyboard.press("Enter");
        await expect(row(page, "capps:mine")).toHaveAttribute("aria-expanded", "false");
        await page.keyboard.press(" ");
        await expect(row(page, "capps:mine")).toHaveAttribute("aria-expanded", "true");
        // j lands on an item and opens it.
        await page.keyboard.press("j");
        await expect(page.locator(".ps-canvas-app-detail h3")).toHaveText("notes");
        // The Packages section collapses with the same rules.
        await row(page, "agents").locator(".ps-admin-tree__caret").click();
        await expect(row(page, "agents")).toHaveAttribute("aria-expanded", "false");
        await expect(row(page, "group:shared")).toHaveCount(0);
        // Saved in this viewer's profile, and applied again after a reload.
        await expect.poll(() => stub.savedProfileSettings().adminCollapsed, { timeout: 5000 }).toEqual(["capps:shared", "agents"]);
        await openCanvasApps(page, base);
        await expect(row(page, "capps:shared")).toHaveAttribute("aria-expanded", "false");
        await expect(row(page, "agents")).toHaveAttribute("aria-expanded", "false");
    });

    test("an app added into a closed group opens that group and is selected", async ({ page }) => {
        await openCanvasApps(page, base);
        await row(page, "capps:mine").click();
        await expect(row(page, "capps:mine")).toHaveAttribute("aria-expanded", "false");
        await page.getByRole("button", { name: "+ Add canvas app" }).click();
        const dialog = page.locator(".ps-canvas-app-add");
        await dialog.locator('input[type="file"]').setInputFiles({ name: "fresh.html", mimeType: "text/html", buffer: Buffer.from("<!doctype html><p>fresh</p>") });
        await dialog.getByRole("button", { name: "Publish" }).click();
        await expect(page.locator(".ps-canvas-app-detail h3")).toHaveText("fresh");
        await expect(row(page, "capps:mine")).toHaveAttribute("aria-expanded", "true");
        await expect(row(page, "capp:user:test:fresh")).toHaveClass(/is-selected/);
    });
});

test.describe("desktop: a long list scrolls in its section and keeps the selection in view", () => {
    let stub;
    test.beforeAll(async () => {
        const many = Array.from({ length: 60 }, (_, i) => makeCanvasApp(`app-${String(i).padStart(2, "0")}`, "user"));
        stub = await startStubServer(0, { sessionCount: 1, admin: true, canvasApps: many });
    });
    test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

    test("the Canvas Apps rows scroll on their own and the cursor row stays visible", async ({ page }) => {
        await openCanvasApps(page, `http://127.0.0.1:${stub.port}`);
        const box = page.locator('.ps-admin-tree__scroll[data-tree-section="canvasApps"]');
        const sizes = await box.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight, overflow: getComputedStyle(el).overflowY }));
        expect(sizes.scroll).toBeGreaterThan(sizes.client);
        expect(sizes.overflow).toBe("auto");
        // Workers (the next section) stays on screen below the long list.
        await expect(row(page, "workers")).toBeInViewport();
        await page.locator("nav.ps-admin-tree").focus();
        for (let i = 0; i < 64; i += 1) await page.keyboard.press("j");
        await expect(page.locator(".ps-canvas-app-detail h3")).toHaveText("app-59");
        const inView = await box.evaluate((el) => {
            const target = el.querySelector('[data-tree-id="capp:user:test:app-59"]');
            const a = el.getBoundingClientRect();
            const b = target.getBoundingClientRect();
            return b.top >= a.top - 1 && b.bottom <= a.bottom + 1;
        });
        expect(inView).toBe(true);
    });
});

test.describe("desktop: Publish as app", () => {
    let stub;
    test.beforeEach(async () => { stub = await startStubServer(0, { sessionCount: 1, canvasApps: [] }); });
    test.afterEach(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

    test("the owner checks then publishes from the canvas toolbar", async ({ page }) => {
        await drawOwnCanvas(page, `http://127.0.0.1:${stub.port}`);
        await publishFlow(page, stub);
    });
});
