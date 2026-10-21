// A canvas pinned in a MoA panel (issue 181): another user's app on a session
// that is NOT the active one is framed once, sealed. A SMOKE test of the
// pinned-canvas path, not of the trust hold: the panel's own controller loads
// one session and learns the revision and its trust together from the draw
// events (it takes no sessions-list seed), so the frame mounts with its trust
// already known. The hold itself is proven on the main canvas
// (canvas-cold-open.spec.mjs) and on the phone; both mount the same
// CanvasFrame.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { normalizeMoa } from "../../../ui/core/src/moa.js";
import { appPage, routeCanvas, sid } from "./canvas-cold-open-fixtures.mjs";

let stub, base;
test.beforeAll(async () => {
    stub = await startStubServer(0, { sessionCount: 2, canvases: { 1: [{ slot: 1, name: "board", latestRev: 1, sizeBytes: 200 }] } });
    base = `http://127.0.0.1:${stub.port}`;
});
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

test("MoA smoke: a pinned canvas of another session, another user's app: one download, one wrapper, one start", async ({ page }) => {
    const canvasNode = { id: "pinned", type: "canvas", sessionId: sid(1), slot: 1 };
    const tree = { id: "split", type: "split", direction: "row", ratio: 50, first: { id: "chat-0", type: "chat", sessionId: sid(0) }, second: canvasNode };
    const settings = { themeId: "terminal-green", moa: { ...normalizeMoa({ slots: [{ name: "Control room", tree }] }), composerMode: "shared" } };
    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith("/me/profile")) return route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: settings } } });
        if (url.pathname.endsWith("/me/profile/settings")) return route.fulfill({ json: { ok: true, result: { profileSettings: settings } } });
        return route.fallback();
    });
    const c = await routeCanvas(page, sid(1), { slots: { 1: { html: appPage("moa-pinned"), trust: "cross-owner" } }, snapshot: {} });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(`${base}/?session=${sid(0)}`);
    await expect(page.getByRole("button", { name: "Master of Agents", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Master of Agents", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Master of Agents" })).toBeVisible();
    const panel = page.locator('[data-moa-panel="pinned"]');
    const outer = panel.locator("iframe.ps-html-preview-frame:not(.is-staging)");
    await expect(outer).toHaveCount(1, { timeout: 30_000 });
    await expect(outer).toHaveAttribute("sandbox", "allow-scripts");
    await expect(panel.frameLocator("iframe.ps-html-preview-frame:not(.is-staging)").frameLocator("iframe").locator("#marker")).toHaveText("moa-pinned", { timeout: 30_000 });
    await expect.poll(() => c.boots("moa-pinned")).toBe(1);
    await page.waitForTimeout(800);
    expect(c.downloads("canvas.html"), "one download").toBe(1);
    expect(c.srcdocs(), "one wrapper").toBe(1);
    expect(await c.boots("moa-pinned"), "the app started once").toBe(1);
});
