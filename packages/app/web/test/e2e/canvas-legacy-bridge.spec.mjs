// The canvas app transition (issue 181, L3): the portal client's side of the
// legacy bridge. While this portal's switch is on (bootstrap
// canvasLegacyMode), a canvas page drawn before the registry (no trust on its
// draw event), or flagged as an old app's page, is framed as on main
// (directly) only when the server's label says legacy for that revision, and
// only with the exact bytes the label names. Otherwise:
//   - "not legacy" (for example, the app's card changed after the draw): the
//     wrapper, as another user's page, with no notice;
//   - a failed or unconfirmed label: sealed, with the notice and Retry; only
//     Retry reads the label again;
//   - owner and agent pages never read the label, even when flagged.
// With the switch off, nothing reads the label and every page is framed as
// in r5. Each case counts downloads, starts and label reads. The phone cases
// are in canvas-legacy-bridge-phone.spec.mjs (a device is a top-level use).
import { test, expect } from "@playwright/test";
import { makeCanvasApp, startStubServer } from "./stub-server.mjs";
import { normalizeMoa } from "../../../ui/core/src/moa.js";
import { appPage, expectShown, LIST_CANVASES, openCanvasCold, routeCanvas, sha256, sid } from "./canvas-cold-open-fixtures.mjs";

const S = sid(0);
const sealedNotice = (page) => page.locator('[data-canvas-sealed="unconfirmed"]');
const legacyLabel = (html) => () => ({ rev: 1, trust: "cross-owner", legacy: true, pageSha256: sha256(html) });
const notLegacy = (html) => () => ({ rev: 1, trust: "cross-owner", legacy: false, pageSha256: sha256(html) });
const OTHER = { html: appPage("unused-2"), trust: "owner" };

async function settle(page) { await page.waitForTimeout(800); }

/** The Files view lists, describes and reads canvas.html as the server would; the bytes stay at the download path (routeCanvas). */
async function routeFiles(page, sessionId, html) {
    const entry = { filename: "canvas.html", contentType: "text/html", sizeBytes: Buffer.byteLength(html), uploadedAt: "2026-10-17T00:00:00.000Z", source: "agent", isBinary: false };
    await page.route("**/api/v1/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname.endsWith(`/sessions/${sessionId}/artifacts`)) return route.fulfill({ json: { ok: true, result: [entry] } });
        if (url.pathname.endsWith("/artifacts/canvas.html/meta")) return route.fulfill({ json: { ok: true, result: entry } });
        if (url.pathname.endsWith("/artifacts/canvas.html/text")) return route.fulfill({ json: { ok: true, result: html } });
        return route.fallback();
    });
}

test.describe("switch on", () => {
    let stub, base;
    test.beforeAll(async () => {
        stub = await startStubServer(0, { sessionCount: 1, canvases: LIST_CANVASES, canvasLegacyMode: true });
        base = `http://127.0.0.1:${stub.port}`;
    });
    test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

    test("a page drawn before the registry, labelled legacy: framed directly, one download, one start, one label read", async ({ page }) => {
        const html = appPage("pre-registry");
        const c = await routeCanvas(page, S, { slots: { 1: { html, pageSha256: null }, 2: OTHER }, labels: { 1: legacyLabel(html) } });
        await openCanvasCold(page, base, S);
        await expectShown(page, "pre-registry", { wrapped: false });
        await expect.poll(() => c.boots("pre-registry")).toBe(1);
        await settle(page);
        expect(c.downloads("canvas.html"), "one download").toBe(1);
        expect(c.srcdocs(), "never wrapped").toBe(0);
        expect(c.labelReads(1), "one label read").toBe(1);
        expect(await c.boots("pre-registry"), "started once").toBe(1);
        await expect(sealedNotice(page)).toHaveCount(0);
    });

    test("an old app's flagged page, labelled legacy: framed directly", async ({ page }) => {
        const html = appPage("old-app");
        const c = await routeCanvas(page, S, { slots: { 1: { html, trust: "cross-owner", legacy: true }, 2: OTHER }, labels: { 1: legacyLabel(html) } });
        await openCanvasCold(page, base, S);
        await expectShown(page, "old-app", { wrapped: false });
        await settle(page);
        expect(c.downloads("canvas.html")).toBe(1);
        expect(c.srcdocs()).toBe(0);
        expect(c.labelReads(1)).toBe(1);
    });

    test("the card changed after the draw (label: not legacy): wrapped on cold open, no notice", async ({ page }) => {
        const html = appPage("card-changed");
        const c = await routeCanvas(page, S, { slots: { 1: { html, trust: "cross-owner", legacy: true }, 2: OTHER }, labels: { 1: notLegacy(html) } });
        await openCanvasCold(page, base, S);
        await expectShown(page, "card-changed", { wrapped: true });
        await settle(page);
        expect(c.downloads("canvas.html")).toBe(1);
        expect(c.srcdocs(), "one wrapper").toBe(1);
        expect(c.labelReads(1)).toBe(1);
        await expect(sealedNotice(page)).toHaveCount(0);
    });

    test("a failing label seals the page; Retry reads it once more and then frames directly", async ({ page }) => {
        const html = appPage("label-fails");
        const c = await routeCanvas(page, S, {
            slots: { 1: { html, pageSha256: null }, 2: OTHER },
            labels: { 1: (n) => (n === 1 ? { status: 503 } : legacyLabel(html)()) },
        });
        await openCanvasCold(page, base, S);
        await expectShown(page, "label-fails", { wrapped: true });
        await expect(sealedNotice(page)).toBeVisible();
        await page.waitForTimeout(1500);
        expect(c.labelReads(1), "no retry loop").toBe(1);
        await sealedNotice(page).getByRole("button", { name: "Retry" }).click();
        await expectShown(page, "label-fails", { wrapped: false });
        await expect(sealedNotice(page)).toHaveCount(0);
        expect(c.labelReads(1), "Retry read it once more").toBe(2);
    });

    test("a legacy label for other bytes than the draw recorded seals the page", async ({ page }) => {
        const html = appPage("other-bytes");
        const c = await routeCanvas(page, S, {
            slots: { 1: { html, trust: "cross-owner", legacy: true }, 2: OTHER },
            labels: { 1: () => ({ rev: 1, trust: "cross-owner", legacy: true, pageSha256: "f".repeat(64) }) },
        });
        await openCanvasCold(page, base, S);
        await expectShown(page, "other-bytes", { wrapped: true });
        await expect(sealedNotice(page)).toBeVisible();
        expect(c.labelReads(1)).toBe(1);
    });

    test("a legacy label whose bytes are not the file's: refused (load error); Retry reads the label again and frames the file", async ({ page }) => {
        const html = appPage("swapped-file");
        const c = await routeCanvas(page, S, {
            slots: { 1: { html, pageSha256: null }, 2: OTHER },
            // First answer: other bytes than the file holds. Second (after the
            // user's Retry): the file's bytes.
            labels: { 1: (n) => ({ rev: 1, trust: "cross-owner", legacy: true, pageSha256: n === 1 ? sha256(appPage("judged-bytes")) : sha256(html) }) },
        });
        await openCanvasCold(page, base, S);
        // The byte check refuses the file (one automatic retry), then says so.
        const loadError = page.locator(".ps-canvas-load-error", { hasText: "Couldn't load rev 1" });
        await expect(loadError).toBeVisible({ timeout: 30_000 });
        expect(c.downloads("canvas.html"), "the file was downloaded and refused, twice").toBe(2);
        expect(await c.boots("swapped-file"), "refused bytes never ran").toBe(0);
        expect(c.srcdocs(), "never wrapped either").toBe(0);
        expect(c.labelReads(1), "no label re-read without the user").toBe(1);
        await loadError.getByRole("button", { name: "Retry" }).click();
        await expectShown(page, "swapped-file", { wrapped: false });
        await expect.poll(() => c.boots("swapped-file")).toBe(1);
        expect(c.labelReads(1), "Retry read the label once more").toBe(2);
        await expect(loadError).toHaveCount(0);
    });

    test("an owner page, even flagged, never reads the label and frames directly", async ({ page }) => {
        const html = appPage("owner-flagged");
        const c = await routeCanvas(page, S, { slots: { 1: { html, trust: "owner", legacy: true }, 2: OTHER }, labels: { 1: legacyLabel(html) } });
        await openCanvasCold(page, base, S);
        await expectShown(page, "owner-flagged", { wrapped: false });
        await settle(page);
        expect(c.labelReads(1), "no label read").toBe(0);
        expect(c.labelReads(2), "no label read for the owner page on slot 2 either").toBe(0);
    });

    test("another user's registry page (trust recorded, not flagged) never reads the label", async ({ page }) => {
        const html = appPage("registry-cross");
        const c = await routeCanvas(page, S, { slots: { 1: { html, trust: "cross-owner" }, 2: OTHER }, labels: { 1: legacyLabel(html) } });
        await openCanvasCold(page, base, S);
        await expectShown(page, "registry-cross", { wrapped: true });
        await settle(page);
        expect(c.labelReads(1)).toBe(0);
    });

    test("Files preview, full screen, cold: held until the draw and label are read, then one direct start", async ({ page }) => {
        const html = appPage("files-legacy");
        const c = await routeCanvas(page, S, { slots: { 1: { html, pageSha256: null }, 2: OTHER }, snapshot: { hold: true }, labels: { 1: legacyLabel(html) } });
        await routeFiles(page, S, html);
        await page.goto(`${base}/?session=${S}&artifact=canvas.html&view=full`);
        const region = page.getByRole("region", { name: "Artifact: canvas.html" });
        await expect(region).toBeVisible({ timeout: 30_000 });
        await expect(region.getByText("Rendering canvas.html…")).toBeVisible();
        await page.waitForTimeout(500);
        expect(await c.boots("files-legacy"), "nothing ran before the draw was read").toBe(0);
        expect(c.srcdocs(), "no wrapper before the draw was read").toBe(0);
        c.release();
        const outer = region.locator("iframe.ps-html-preview-frame:not(.is-staging)");
        await expect(outer).toHaveCount(1, { timeout: 30_000 });
        await expect(outer).toHaveAttribute("sandbox", /allow-popups/);
        await expect(region.frameLocator("iframe.ps-html-preview-frame:not(.is-staging)").locator("#marker")).toHaveText("files-legacy", { timeout: 30_000 });
        await expect.poll(() => c.boots("files-legacy")).toBe(1);
        await settle(page);
        expect(await c.boots("files-legacy"), "started once").toBe(1);
        expect(c.srcdocs(), "never wrapped").toBe(0);
        expect(c.labelReads(1)).toBe(1);
        await expect(region.locator('[data-preview-sealed="unconfirmed"]')).toHaveCount(0);
    });

    test("Files preview: a failing label is wrapped and says so; Retry reads it once more and frames directly", async ({ page }) => {
        const html = appPage("files-retry");
        const c = await routeCanvas(page, S, {
            slots: { 1: { html, pageSha256: null }, 2: OTHER },
            labels: { 1: (n) => (n === 1 ? { status: 503 } : legacyLabel(html)()) },
        });
        await routeFiles(page, S, html);
        await page.goto(`${base}/?session=${S}&artifact=canvas.html&view=full`);
        const region = page.getByRole("region", { name: "Artifact: canvas.html" });
        const notice = region.locator('[data-preview-sealed="unconfirmed"]');
        await expect(notice).toBeVisible({ timeout: 30_000 });
        const outer = region.locator("iframe.ps-html-preview-frame:not(.is-staging)");
        await expect(outer).toHaveAttribute("sandbox", "allow-scripts");
        await page.waitForTimeout(1500);
        expect(c.labelReads(1), "no retry loop").toBe(1);
        await notice.getByRole("button", { name: "Retry" }).click();
        await expect(outer).toHaveAttribute("sandbox", /allow-popups/, { timeout: 30_000 });
        await expect(region.frameLocator("iframe.ps-html-preview-frame:not(.is-staging)").locator("#marker")).toHaveText("files-retry", { timeout: 30_000 });
        await expect(notice).toHaveCount(0);
        expect(c.labelReads(1), "Retry read it once more").toBe(2);
    });

    test("Files preview: a label that never answers is wrapped after the hold and says so", async ({ page }) => {
        const html = appPage("files-silent");
        const c = await routeCanvas(page, S, { slots: { 1: { html, pageSha256: null }, 2: OTHER }, labels: { 1: () => ({ hang: true }) } });
        await routeFiles(page, S, html);
        await page.goto(`${base}/?session=${S}&artifact=canvas.html&view=full`);
        const region = page.getByRole("region", { name: "Artifact: canvas.html" });
        await expect(region.locator('[data-preview-sealed="unconfirmed"]')).toBeVisible({ timeout: 30_000 });
        await expect(region.locator("iframe.ps-html-preview-frame:not(.is-staging)")).toHaveAttribute("sandbox", "allow-scripts");
        expect(c.labelReads(1)).toBe(1);
    });

    test("share viewer: a page the server serves as text/html (legacy) is framed directly, as on main", async ({ page }) => {
        await page.route("**/api/canvas-share/**", async (route) => {
            const url = new URL(route.request().url());
            if (url.pathname.endsWith("/doc")) return route.fulfill({ contentType: "text/html; charset=utf-8", body: appPage("share-legacy") });
            if (url.pathname.endsWith("/live")) return route.fulfill({ json: { live: null } });
            return route.fulfill({ json: { entries: [] } });
        });
        await page.goto(`${base}/?canvasShare=tok-legacy`);
        const frame = page.locator("iframe").first();
        await expect(frame).toHaveCount(1, { timeout: 30_000 });
        await expect(page.frameLocator("iframe").first().locator("#marker")).toHaveText("share-legacy", { timeout: 30_000 });
        await expect(page.frameLocator("iframe").first().locator("iframe")).toHaveCount(0);
    });
});

test.describe("switch on, with the canvas app registry (PR 2 fixtures)", () => {
    let stub, base;
    test.beforeAll(async () => {
        stub = await startStubServer(0, { sessionCount: 1, canvases: LIST_CANVASES, canvasLegacyMode: true, canvasApps: [makeCanvasApp("board")] });
        base = `http://127.0.0.1:${stub.port}`;
    });
    test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

    test("the registry's signed-in bootstrap keeps the switch; a pre-registry page is still framed directly after its label", async ({ page }) => {
        const boot = await (await page.request.get(`${base}/api/v1/bootstrap`)).json();
        expect(boot.canvasLegacyMode, "the switch survives the registry's bootstrap").toBe(true);
        expect(boot.auth?.principal?.subject, "and it is still the signed-in registry bootstrap").toBeTruthy();
        const apps = await (await page.request.get(`${base}/api/v1/canvas-apps`)).json();
        expect(apps.result?.map((app) => app.name)).toEqual(["board"]);
        const html = appPage("registry-and-legacy");
        const c = await routeCanvas(page, S, { slots: { 1: { html, pageSha256: null }, 2: OTHER }, labels: { 1: legacyLabel(html) } });
        await openCanvasCold(page, base, S);
        await expectShown(page, "registry-and-legacy", { wrapped: false });
        await settle(page);
        expect(c.labelReads(1)).toBe(1);
        expect(c.srcdocs()).toBe(0);
    });
});

test.describe("switch on, MoA", () => {
    let stub, base;
    test.beforeAll(async () => {
        stub = await startStubServer(0, { sessionCount: 2, canvases: { 1: [{ slot: 1, name: "board", latestRev: 1, sizeBytes: 200 }] }, canvasLegacyMode: true });
        base = `http://127.0.0.1:${stub.port}`;
    });
    test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

    test("MoA: a pinned page drawn before the registry, labelled legacy: framed directly once", async ({ page }) => {
        const canvasNode = { id: "pinned", type: "canvas", sessionId: sid(1), slot: 1 };
        const tree = { id: "split", type: "split", direction: "row", ratio: 50, first: { id: "chat-0", type: "chat", sessionId: sid(0) }, second: canvasNode };
        const settings = { themeId: "terminal-green", moa: { ...normalizeMoa({ slots: [{ name: "Control room", tree }] }), composerMode: "shared" } };
        await page.route("**/api/v1/**", async (route) => {
            const url = new URL(route.request().url());
            if (url.pathname.endsWith("/me/profile")) return route.fulfill({ json: { ok: true, result: { isAdmin: false, profileSettings: settings } } });
            if (url.pathname.endsWith("/me/profile/settings")) return route.fulfill({ json: { ok: true, result: { profileSettings: settings } } });
            return route.fallback();
        });
        const html = appPage("moa-legacy");
        const c = await routeCanvas(page, sid(1), { slots: { 1: { html, pageSha256: null } }, labels: { 1: legacyLabel(html) } });
        await page.setViewportSize({ width: 1600, height: 1000 });
        await page.goto(`${base}/?session=${sid(0)}`);
        await expect(page.getByRole("button", { name: "Master of Agents", exact: true })).toBeEnabled();
        await page.getByRole("button", { name: "Master of Agents", exact: true }).click();
        const panel = page.locator('[data-moa-panel="pinned"]');
        const outer = panel.locator("iframe.ps-html-preview-frame:not(.is-staging)");
        await expect(outer).toHaveCount(1, { timeout: 30_000 });
        await expect(outer).toHaveAttribute("sandbox", /allow-popups/);
        await expect(panel.frameLocator("iframe.ps-html-preview-frame:not(.is-staging)").locator("#marker")).toHaveText("moa-legacy", { timeout: 30_000 });
        await expect.poll(() => c.boots("moa-legacy")).toBe(1);
        await settle(page);
        expect(c.downloads("canvas.html")).toBe(1);
        expect(c.srcdocs()).toBe(0);
        expect(c.labelReads(1)).toBe(1);
    });
});

test.describe("switch off: as in r5", () => {
    let stub, base;
    test.beforeAll(async () => {
        stub = await startStubServer(0, { sessionCount: 1, canvases: LIST_CANVASES });
        base = `http://127.0.0.1:${stub.port}`;
    });
    test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

    for (const [name, slot] of [["drawn before the registry", { pageSha256: null }], ["an old app's flagged page", { trust: "cross-owner", legacy: true }]]) {
        test(`${name}: wrapped as another user's page, no label read`, async ({ page }) => {
            const html = appPage("off");
            const c = await routeCanvas(page, S, { slots: { 1: { html, ...slot }, 2: OTHER }, labels: { 1: legacyLabel(html) } });
            await openCanvasCold(page, base, S);
            await expectShown(page, "off", { wrapped: true });
            await settle(page);
            expect(c.downloads("canvas.html")).toBe(1);
            expect(c.srcdocs()).toBe(1);
            expect(c.labelReads(1), "the switch is off: no label read").toBe(0);
            expect(c.labelReads(2)).toBe(0);
            await expect(sealedNotice(page)).toHaveCount(0);
        });
    }
});
