import { test, expect, chromium, webkit } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const sid = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

for (const browserName of ["chromium", "webkit"]) {
    for (const [width, height] of [[320, 568], [390, 500], [844, 390], [915, 412], [568, 320]]) {
        test(`${browserName}: short composer ${width}x${height}`, async () => {
            const browser = await ({ chromium, webkit })[browserName].launch();
            try {
                const page = await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true });
                await page.route("**/api/v1/me/profile", route => route.fulfill({ json: { ok: true, result: {
                    isAdmin: false, profileSettings: { themeId: "workspace-dark", sessionDetailCollapsed: false },
                } } }));
                await page.route("**/steering-state", route => route.fulfill({ json: { ok: true, result: {
                    supported: true, canWrite: true, steerable: true, expectedTarget: "target",
                    windowSeq: 1, limits: { maxBytes: 8192 },
                } } }));
                await page.route("**/steering?*", route => route.fulfill({ json: { ok: true, result: { items: [], nextCursor: null } } }));
                await page.goto(`http://127.0.0.1:${stub.port}/?session=${sid}`);
                const input = page.locator(".ps-prompt-input");
                await expect(input).toBeVisible();
                await expect(page.getByRole("button", { name: "Stop the current turn", exact: true })).toBeVisible();
                const measurements = [];
                for (const draft of ["", "Keep the public API unchanged.", "Keep the public API unchanged.\nPreserve the caller identity.\nReport the outcome."]) {
                    await input.fill(draft);
                    await input.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                    await expect.poll(async () => input.evaluate(node =>
                        node.closest(".ps-prompt-shell").querySelector(".ps-prompt-actions").getBoundingClientRect().bottom
                    )).toBeLessThanOrEqual(height);
                    measurements.push(await input.evaluate(node => {
                        const box = element => {
                            const rect = element.getBoundingClientRect();
                            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom };
                        };
                        const shell = node.closest(".ps-prompt-shell");
                        const ancestors = [];
                        for (let element = node.parentElement; element && ancestors.length < 8; element = element.parentElement) {
                            const style = getComputedStyle(element);
                            ancestors.push({ class: element.className, ...box(element), minHeight: style.minHeight,
                                rows: style.gridTemplateRows, overflow: style.overflow });
                        }
                        return { text: node.value, input: box(node), shell: box(shell),
                            actions: box(shell.querySelector(".ps-prompt-actions")),
                            steer: shell.querySelector(".ps-steer-button") ? box(shell.querySelector(".ps-steer-button")) : null,
                            scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
                            documentWidth: document.documentElement.scrollWidth,
                            ancestors };
                    }));
                }
                console.log(`COMPOSER_MEASURE ${JSON.stringify({ browserName, width, height, measurements })}`);
                for (const measurement of measurements) {
                    expect(measurement.documentWidth).toBeLessThanOrEqual(width);
                    expect(measurement.actions.height).toBeGreaterThanOrEqual(44);
                    if (width === 320) expect(measurement.input.width).toBeGreaterThanOrEqual(112);
                }
                await test.info().attach("composer-measurements", { body: JSON.stringify({ browserName, width, height, measurements }), contentType: "application/json" });
            } finally { await browser.close(); }
        });
    }

    test(`${browserName}: Attach hides only below 360px while running, without dropping staged images`, async () => {
        const browser = await ({ chromium, webkit })[browserName].launch();
        try {
            const page = await browser.newPage({ viewport: { width: 800, height: 844 }, isMobile: true, hasTouch: true });
            let status = "running";
            const row = () => ({ sessionId: sid, title: "Composer boundary", status, statusVersion: status === "running" ? 1 : 2,
                createdAt: 1, updatedAt: status === "running" ? 2 : 3,
                owner: { provider: "none", subject: "test" } });
            await page.route("**/api/v1/**", route => {
                const path = new URL(route.request().url()).pathname;
                const answer = result => route.fulfill({ json: { ok: true, result } });
                if (path.endsWith("/management/sessions")) return answer({ sessions: [row()], hasMore: false });
                if (path.endsWith(`/sessions/${sid}`)) return answer(row());
                if (path.endsWith("/steering-state")) return answer({
                    supported: true, canWrite: true, steerable: status === "running", expectedTarget: "target", windowSeq: 1,
                });
                if (path.endsWith("/steering")) return answer({ items: [], nextCursor: null });
                if (path.endsWith("/stop-turn")) { status = "idle"; return answer({ outcome: "stopped" }); }
                return route.fallback();
            });
            await page.goto(`http://127.0.0.1:${stub.port}/?session=${sid}`);
            const attach = page.getByRole("button", { name: "Attach images", exact: true });
            const composer = page.locator(".ps-chat-composer");
            const input = page.locator(".ps-prompt-input");
            await expect(attach).toBeVisible();
            await composer.evaluate(node => { node.style.boxSizing = "content-box"; node.style.width = "360px"; });
            await expect(attach).toBeVisible();
            await composer.evaluate(node => { node.style.width = "359px"; });
            await expect(attach).toBeHidden();
            await composer.evaluate(node => { node.style.removeProperty("width"); node.style.removeProperty("box-sizing"); });
            await page.setViewportSize({ width: 320, height: 568 });
            await input.fill("Keep my draft");
            await page.locator(".ps-hidden-file-input").setInputFiles({
                name: "retained.png", mimeType: "image/png",
                buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHH8AAAAASUVORK5CYII=", "base64"),
            });
            const remove = page.getByRole("button", { name: "Remove attachment retained.png", exact: true });
            await expect(attach).toBeHidden();
            await expect(remove).toBeVisible();
            await expect(page.getByRole("button", { name: "Steer current turn", exact: true })).toBeDisabled();
            await page.getByRole("button", { name: "Stop the current turn", exact: true }).click();
            await expect(attach).toBeVisible();
            await expect(remove).toBeVisible();
            await remove.click();
            await expect(remove).toHaveCount(0);
            await expect(input).toHaveValue("Keep my draft");
        } finally { await browser.close(); }
    });
}
