import { test, expect, chromium, webkit, devices } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const sessions = ["11111110-2222-3333-4444-555555555550", "11111111-2222-3333-4444-555555555551"];
const actor = { kind: "user", provider: "none", subject: "carol" };
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 2 }); });
test.afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); });
const image = name => ({ name, mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHH8AAAAASUVORK5CYII=", "base64") });

for (const engine of ["chromium", "webkit"]) test(`${engine}: concurrent iPad contexts of Carol isolate two-session recall and draft stashes`, async () => {
    const browser = await ({ chromium, webkit })[engine].launch();
    const contexts = [];
    const errors = [];
    const events = new Map(sessions.map((id, index) => [id, [{
        sessionId: id, seq: 1, eventType: "user.message", data: { content: `session-${index} initial`, sender: actor },
    }]]));
    const receipts = new Map(sessions.map(id => [id, []]));
    const sockets = [];
    const held = [Promise.withResolvers(), Promise.withResolvers()];
    const entered = [Promise.withResolvers(), Promise.withResolvers()];
    const append = (id, eventType, data) => {
        const rows = events.get(id);
        const row = { sessionId: id, seq: rows.length + 1, eventType, data };
        rows.push(row);
        for (const socket of sockets) socket.send(JSON.stringify({ type: "sessionEvent", sessionId: id, event: row }));
        return row;
    };
    try {
        const pages = [];
        for (let index = 0; index < 2; index++) {
            const context = await browser.newContext({ ...devices["iPad (gen 7)"], viewport: { width: 810, height: 600 } });
            contexts.push(context);
            const page = await context.newPage();
            pages.push(page);
            page.on("pageerror", error => errors.push(error.message));
            await page.routeWebSocket("**/api/v1/ws", socket => sockets.push(socket));
            await page.route("**/api/v1/bootstrap", async route => {
                const response = await route.fetch();
                const payload = await response.json();
                (payload.result || payload).auth = { principal: { provider: actor.provider, subject: actor.subject },
                    authorization: { allowed: true, role: "user" } };
                await route.fulfill({ json: payload });
            });
            for (const id of sessions) {
                await page.route(`**/sessions/${id}/events?*`, route => route.fulfill({ json: { ok: true, result: events.get(id) } }));
                await page.route(`**/sessions/${id}/steering-state`, route => route.fulfill({ json: { ok: true, result: {
                    supported: true, canWrite: true, steerable: true, expectedTarget: `target-${id}`, windowSeq: 1,
                } } }));
                await page.route(`**/sessions/${id}/steering?*`, route => route.fulfill({ json: { ok: true, result: {
                    items: receipts.get(id), nextCursor: null,
                } } }));
                await page.route(`**/sessions/${id}/steering`, async route => {
                    if (route.request().method() !== "POST") return route.fallback();
                    const body = route.request().postDataJSON();
                    const options = body.options || body;
                    const receipt = { schemaVersion: 1, sessionId: id, requestId: `accepted-${index}-${receipts.get(id).length}`,
                        clientRequestId: options.clientRequestId, expectedTarget: options.expectedTarget, text: options.text,
                        actor, revision: 1, sequence: receipts.get(id).length + 1, status: "pending", disposition: "accepted" };
                    receipts.get(id).push(receipt);
                    append(id, "session.steering_accepted", { receipt });
                    entered[index].resolve();
                    await held[index].promise;
                    await route.fulfill({ json: { ok: true, result: { ok: true, receipt } } });
                });
                await page.route(`**/sessions/${id}/messages`, async route => {
                    const body = route.request().postDataJSON();
                    await route.fulfill({ json: { ok: true, result: { queued: true } } });
                    append(id, "user.message", { content: body.prompt || body.message, sender: actor,
                        clientMessageIds: body.options?.clientMessageIds || body.clientMessageIds });
                });
            }
            await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessions[index]}`);
            await expect(page.getByTestId("session-prompt")).toBeVisible();
        }
        for (let index = 0; index < 2; index++) {
            const input = pages[index].getByTestId("session-prompt");
            await input.fill(`session-${index} ordinary`);
            await pages[index].getByTestId("send-prompt").click();
            await expect(input).toHaveValue("");
        }
        for (let index = 0; index < 2; index++) {
            const page = pages[index];
            await page.getByTestId("session-prompt").fill(`session-${index} steering`);
            await page.getByRole("button", { name: "Steer current turn", exact: true }).click();
            await entered[index].promise;
        }
        // Reverse view ownership before the two acceptance replies return.
        for (let index = 0; index < 2; index++) {
            await pages[index].locator(`.ps-session-list-button[data-session-id="${sessions[1 - index]}"]`).click();
            await pages[index].getByTestId("session-prompt").fill(`tab-${index} other-session stash`);
        }
        held[1].resolve();
        held[0].resolve();
        for (let index = 0; index < 2; index++) {
            const page = pages[index], id = sessions[1 - index], input = page.getByTestId("session-prompt");
            await expect(input).toHaveValue(`tab-${index} other-session stash`);
            await page.locator(".ps-hidden-file-input").setInputFiles(image(`tab-${index}-stash.png`));
            await input.press("Home");
            await input.press("ArrowUp");
            await expect(input).toHaveValue(`session-${1 - index} steering`);
            await input.press("ArrowUp");
            await expect(input).toHaveValue(`session-${1 - index} ordinary`);
            await input.press("ArrowUp");
            await expect(input).toHaveValue(`session-${1 - index} initial`);
            await input.press("ArrowDown");
            await expect(input).toHaveValue(`session-${1 - index} ordinary`);
            await input.press("ArrowDown");
            await expect(input).toHaveValue(`session-${1 - index} steering`);
            await input.press("ArrowDown");
            await expect(input).toHaveValue(`tab-${index} other-session stash`);
            await expect(page.getByRole("button", { name: `Remove attachment tab-${index}-stash.png`, exact: true })).toBeVisible();
            // Rapid away/back while recalling must preserve the original unsent stash.
            await input.press("ArrowUp");
            await expect(input).toHaveValue(`session-${1 - index} steering`);
            await page.locator(`.ps-session-list-button[data-session-id="${sessions[index]}"]`).click();
            await page.locator(`.ps-session-list-button[data-session-id="${id}"]`).click();
            await expect(input).toHaveValue(`tab-${index} other-session stash`);
            await expect(page.getByRole("button", { name: `Remove attachment tab-${index}-stash.png`, exact: true })).toBeVisible();
        }
        expect(errors).toEqual([]);
    } finally {
        held.forEach(barrier => barrier.resolve());
        for (const context of contexts) await context.close();
        await browser.close();
    }
});
