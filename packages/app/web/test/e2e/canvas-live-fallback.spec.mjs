import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { collectPageErrors } from "./page-errors.mjs";

const SESSION = "11111110-2222-3333-4444-555555555550";
const HTML = `<!doctype html><html><body><p id="value">waiting</p><p id="deliveries">0</p><script>
let deliveries = 0;
addEventListener("message", (e) => {
    if (e.data?.type !== "canvas-data") return;
    document.getElementById("value").textContent = String(e.data.data.x);
    document.getElementById("deliveries").textContent = String(++deliveries);
});
</script></body></html>`;

let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });

for (const ping of [true, false]) {
    test(`a durable canvas tick reaches the frame after a doc ping when the data ping ${ping ? "cannot fetch live state" : "is missed"}`, async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const errors = [];
        page.on("pageerror", collectPageErrors(errors));
        const sockets = [];
        let canvasSubscribed = false;
        let liveReads = 0;
        await page.routeWebSocket("**/api/v1/ws", socket => {
            sockets.push(socket);
            socket.onMessage(raw => {
                if (JSON.parse(raw).type === "subscribeCanvas") canvasSubscribed = true;
            });
        });
        await page.route("**/api/v1/**", async route => {
            const url = new URL(route.request().url());
            const answer = result => route.fulfill({ json: { ok: true, result } });
            if (url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_updated")) {
                return answer([{ seq: 1, eventType: "session.canvas_updated",
                    data: { slot: 1, rev: 1, sizeBytes: HTML.length, name: "Live fallback" } }]);
            }
            if (url.pathname.endsWith("/events-before") && url.search.includes("session.canvas_data")) return answer([]);
            if (url.pathname.endsWith("/events")) return answer([]);
            if (url.pathname.endsWith("/canvas-live")) {
                liveReads++;
                return route.fulfill({ status: 500, json: { ok: false, error: { code: "TEST_LIVE_UNAVAILABLE", message: "Live state unavailable" } } });
            }
            if (url.pathname.includes("/artifacts/") && url.pathname.includes("canvas.html")) {
                return route.fulfill({ contentType: "text/html", body: HTML });
            }
            return route.fallback();
        });
        await page.goto(`http://127.0.0.1:${stub.port}/?session=${SESSION}`);
        const show = page.getByRole("button", { name: "Show canvas", exact: true });
        await show.or(page.getByRole("button", { name: "Hide the canvas", exact: true })).first().waitFor();
        if (await show.isVisible()) await show.click();
        const frame = page.frameLocator(".ps-side-pane-layer:not(.is-parked) iframe.ps-html-preview-frame:not(.is-staging)");
        await expect(frame.locator("#value")).toHaveText("waiting");
        await expect.poll(() => canvasSubscribed).toBe(true);
        const send = message => {
            for (const socket of sockets) socket.send(JSON.stringify(message));
        };
        send({ type: "canvasLive", sessionId: SESSION, slot: 1, seq: 1, kind: "doc" });
        if (ping) {
            const before = liveReads;
            send({ type: "canvasLive", sessionId: SESSION, slot: 1, seq: 2, kind: "data" });
            await expect.poll(() => liveReads).toBeGreaterThan(before);
        }
        send({ type: "sessionEvent", sessionId: SESSION, event: {
            sessionId: SESSION, seq: 2, eventType: "session.canvas_data", createdAt: new Date().toISOString(),
            data: { slot: 1, dataRev: 1, ...(ping ? { planeSeq: 2 } : {}), payload: { x: 1 } },
        } });
        await expect(frame.locator("#value")).toHaveText("1");
        await expect(frame.locator("#deliveries")).toHaveText("1");
        expect(errors).toEqual([]);
    });
}
