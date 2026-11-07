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

test("Manage keeps the catalog prefix outside the 100-character input and saves only the editable title", async ({ page }) => {
        const id = "11111111-2222-3333-4444-555555555551";
        let title = "Ops: Fleet Watcher: nightly";
        let readsAfterSave = 0;
        const writes = [];
        await page.route("**/api/v1/bootstrap", route => route.fulfill({ json: { ok: true, result: {
            auth: { principal: { provider: "none", subject: "test", email: "test@example.com" }, authorization: { role: "user", allowed: true } },
        } } }));
        await page.route("**/access", route => route.fulfill({ json: { ok: true, result: { canManage: true, canWrite: true, relation: "owner", owner: { provider: "none", subject: "test" } } } }));
        await page.route("**/api/v1/agents", route => route.fulfill({ json: { ok: true, result: [{ name: "ops", title: "Ops: Fleet Watcher" }] } }));
        await page.route(url => /\/api\/.*\/sessions(?:\/[^/]+)?$/.test(url.pathname), async route => {
            if (route.request().method() === "PATCH") {
                writes.push(route.request().postDataJSON());
                title = `Ops: Fleet Watcher: ${writes.at(-1).title}`;
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
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(base + `/?session=${id}`);
        const row = page.locator(`.ps-session-list-button[data-session-id="${id}"]`);
        await expect(row).toContainText("nightly");
        await row.click();
        await page.getByRole("button", { name: /^Manage session/ }).first().click();
        const modal = page.locator(".ps-share-modal");
        const input = modal.getByRole("textbox", { name: "Session title after Ops: Fleet Watcher", exact: true });
        await expect(modal.locator(".ps-manage-title-prefix")).toHaveText("Ops: Fleet Watcher:");
        await expect(input).toHaveValue("nightly");
        await expect(input).toHaveAttribute("maxlength", "100");
        await input.fill("morning sweep");
        await modal.getByRole("button", { name: "Save", exact: true }).click();
        await expect.poll(() => writes).toEqual([{ title: "morning sweep" }]);
        await expect.poll(() => readsAfterSave).toBeGreaterThan(0);
        await expect(row).toContainText("morning sweep");
});
