// The canvas app transition (issue 181, L3) on a phone: the same rules as
// canvas-legacy-bridge.spec.mjs, on the phone layout. A page drawn before the
// registry is framed directly only when the label says legacy; "not legacy"
// wraps it. One download, one label read.
import { test, expect, devices } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { appPage, expectShown, LIST_CANVASES, openCanvasCold, routeCanvas, sha256, sid } from "./canvas-cold-open-fixtures.mjs";

test.use({ ...devices["iPhone 14 Pro"] });

const S = sid(0);
const legacyLabel = (html) => () => ({ rev: 1, trust: "cross-owner", legacy: true, pageSha256: sha256(html) });
const notLegacy = (html) => () => ({ rev: 1, trust: "cross-owner", legacy: false, pageSha256: sha256(html) });
const OTHER = { html: appPage("unused-2"), trust: "owner" };

async function settle(page) { await page.waitForTimeout(800); }

let stub, base;
test.beforeAll(async () => {
    stub = await startStubServer(0, { sessionCount: 1, canvases: LIST_CANVASES, canvasLegacyMode: true });
    base = `http://127.0.0.1:${stub.port}`;
});
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

for (const [name, label, wrapped] of [["legacy", legacyLabel, false], ["not legacy", notLegacy, true]]) {
    test(`phone: a page drawn before the registry, label ${name}`, async ({ page }) => {
        const html = appPage(`phone-${wrapped ? "wrapped" : "direct"}`);
        const c = await routeCanvas(page, S, { slots: { 1: { html, pageSha256: null }, 2: OTHER }, labels: { 1: label(html) } });
        await openCanvasCold(page, base, S);
        await expectShown(page, `phone-${wrapped ? "wrapped" : "direct"}`, { wrapped });
        await settle(page);
        expect(c.downloads("canvas.html")).toBe(1);
        expect(c.srcdocs()).toBe(wrapped ? 1 : 0);
        expect(c.labelReads(1)).toBe(1);
    });
}
