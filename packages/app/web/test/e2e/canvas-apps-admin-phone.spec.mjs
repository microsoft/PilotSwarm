// Issue 181 R25 on a phone: the canvas strip offers "Publish as app" to the
// session owner, the manifest check sends checkOnly and nothing else, and the
// dialog fits the screen. The device emulation covers the whole file, as in
// toolbar-groups-mobile.spec.mjs; the desktop cases are in
// canvas-apps-admin.spec.mjs.
import { test, expect, devices } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { drawOwnCanvas, publishFlow } from "./canvas-apps-fixtures.mjs";

test.use({ ...devices["iPhone 14 Pro"] });

let stub;
test.beforeEach(async () => { stub = await startStubServer(0, { sessionCount: 1, canvasApps: [] }); });
test.afterEach(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

test("phone: the button is in the canvas strip and the dialog fits the screen", async ({ page }) => {
    await drawOwnCanvas(page, `http://127.0.0.1:${stub.port}`);
    const dialog = await publishFlow(page, stub);
    const fit = await dialog.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.left >= 0 && r.right <= window.innerWidth + 1;
    });
    expect(fit).toBe(true);
});
