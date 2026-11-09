// A renamed named-agent session shows the person's title first in the
// portal's session list and chat header, whatever the agent's display name.
//
// WHY THIS EXISTS: the portal builds its list and header from a hand-copied
// slice of the controller state. The agent catalog titles were not in that
// slice, so "DeepWiki Code Explorer: <title>" kept the agent name first in the
// portal even though the shared selector ordered it correctly.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const browserName = process.env.PS_TEST_BROWSER || "chromium";
test.use({ browserName });
let stub, base;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 2 }); base = `http://127.0.0.1:${stub.port}`; });
test.afterEach(async ({ page }) => {
    // Let in-flight relabel reads finish before Playwright closes the page.
    await page.unrouteAll({ behavior: "wait" });
});
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const TITLE = "Investigate the nightly replication lag regression on the westus3 read replicas";

test("a renamed agent session leads with the person's title in the list and the header", async ({ page }) => {
    await page.route("**/api/v1/agents", (route) => route.fulfill({ json: { ok: true, result: [{ name: "deepwiki", title: "DeepWiki Code Explorer" }] } }));
    // Rewrite session 1 in whatever session list the page reads.
    const relabel = (sessions) => sessions.map((session, index) => (index === 1
        ? { ...session, agentId: "deepwiki", title: `DeepWiki Code Explorer: ${TITLE}` }
        : session));
    await page.route((url) => /\/api\//.test(url.pathname) && /sessions$/.test(url.pathname), async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const response = await route.fetch();
        const json = await response.json().catch(() => null);
        const result = json?.result;
        if (Array.isArray(result?.sessions)) return route.fulfill({ response, json: { ...json, result: { ...result, sessions: relabel(result.sessions) } } });
        if (Array.isArray(json?.sessions)) return route.fulfill({ response, json: { ...json, sessions: relabel(json.sessions) } });
        return route.fulfill({ response });
    });

    // The session's own detail read must agree, or it overwrites the row.
    await page.route((url) => /\/api\/.*\/sessions\/11111111-[^/]+$/.test(url.pathname), async (route) => {
        if (route.request().method() !== "GET") return route.fallback();
        const response = await route.fetch();
        const json = await response.json().catch(() => null);
        if (!json?.result || typeof json.result !== "object") return route.fulfill({ response });
        return route.fulfill({ response, json: { ...json, result: { ...json.result, agentId: "deepwiki", title: `DeepWiki Code Explorer: ${TITLE}` } } });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base);
    const row = page.locator(".ps-session-list-button", { hasText: "Investigate the nightly" }).first();
    await expect(row).toContainText(`${TITLE} · DeepWiki Code Explorer`);
    await row.click();
    await expect(page.locator(".ps-chat-panel .ps-panel-title, .ps-chat-pane .ps-panel-title").first()).toContainText(`${TITLE} · DeepWiki Code Explorer`);
});

for (const [theme, width, height] of [
    ["horizon-dawn", 390, 844],
    ["horizon-dawn", 844, 390],
    ["horizon-dawn", 1440, 900],
    ["win95", 390, 844],
]) test(`Manage ${theme} ${width}px: long prefix leaves the title editable without horizontal overflow`, async ({ page }, testInfo) => {
    const id = "11111111-2222-3333-4444-555555555551";
    const prefix = "Blackfinger - PilotSwarm Engineer: Session Title Layout";
    let title = `${prefix}: nightly`;
    let readsAfterSave = 0;
    const writes = [];
    await page.clock.install({ time: new Date("2030-01-01T00:00:00Z") });
    await page.route("**/api/v1/bootstrap", route => route.fulfill({ json: { ok: true, result: {
        auth: { principal: { provider: "none", subject: "test", email: "test@example.com" }, authorization: { role: "user", allowed: true } },
    } } }));
    await page.route("**/access", route => route.fulfill({ json: { ok: true, result: { canManage: true, canWrite: true, relation: "owner", owner: { provider: "none", subject: "test" } } } }));
    await page.route("**/api/v1/agents", route => route.fulfill({ json: { ok: true, result: [{ name: "ops", title: prefix }] } }));
    await page.route("**/me/profile", route => route.fulfill({ json: { ok: true, result: { profileSettings: { themeId: theme } } } }));
    await page.route(url => /\/api\/.*\/sessions(?:\/[^/]+)?$/.test(url.pathname), async route => {
        if (route.request().method() === "PATCH") {
            writes.push(route.request().postDataJSON());
            title = `${prefix}: ${writes.at(-1).title}`;
            return route.fulfill({ json: { ok: true, result: {} } });
        }
        if (route.request().method() !== "GET") return route.fallback();
        if (writes.length) readsAfterSave++;
        const response = await route.fetch();
        const json = await response.json();
        const relabel = s => s.sessionId === id ? { ...s, agentId: "ops", title } : s;
        if (json.result?.sessions) json.result.sessions = json.result.sessions.map(relabel);
        else if (json.sessions) json.sessions = json.sessions.map(relabel);
        else if (json.result?.sessionId) json.result = relabel(json.result);
        return route.fulfill({ response, json });
    });
    await page.setViewportSize({ width, height });
    await page.goto(base + `/?session=${id}`);
    const row = page.locator(`.ps-session-list-button[data-session-id="${id}"]`);
    await expect(row).toContainText("nightly");
    if (width <= 600) await page.getByRole("button", { name: "Sessions", exact: true }).click();
    await row.click();
    if (width <= 600) await page.getByRole("button", { name: "Sessions", exact: true }).click();
    await page.getByRole("button", { name: /^Manage session/ }).first().click();
    const modal = page.locator(".ps-share-modal");
    const input = modal.getByRole("textbox", { name: `Session title after ${prefix}`, exact: true });
    const fixedPrefix = modal.locator(".ps-manage-title-prefix");
    await expect(fixedPrefix).toHaveText(`${prefix}:`);
    await expect(input).toHaveValue("nightly");
    await expect(input).toHaveAttribute("maxlength", "100");
    await input.fill("morning sweep");
    const save = modal.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeEnabled();
    const prefixBox = await fixedPrefix.boundingBox();
    const inputBox = await input.boundingBox();
    const saveBox = await save.boundingBox();
    expect(inputBox.width).toBeGreaterThan(120);
    expect(prefixBox.y + prefixBox.height).toBeLessThanOrEqual(inputBox.y);
    expect(saveBox.x + saveBox.width).toBeLessThanOrEqual(width);
    expect(await modal.locator(".ps-share-modal-body").evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await modal.screenshot({ path: testInfo.outputPath(`manage-${theme}-${width}.png`) });
    // Freeze the catalog poll: only Save's own refresh can update the list.
    await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 1000)));
    await save.click();
    await expect.poll(() => writes).toEqual([{ title: "morning sweep" }]);
    await expect.poll(() => readsAfterSave).toBeGreaterThan(0);
    await expect(row).toContainText("morning sweep");
});
