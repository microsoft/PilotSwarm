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
    await page.route("**/management/sessions", async (route) => {
        const response = await route.fetch();
        const json = await response.json();
        const sessions = json.result.sessions.map((session, index) => (index === 1
            ? { ...session, agentId: "deepwiki", title: `DeepWiki Code Explorer: ${TITLE}` }
            : session));
        return route.fulfill({ response, json: { ...json, result: { ...json.result, sessions } } });
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(base);
    const row = page.locator(".ps-session-list-button", { hasText: "Investigate the nightly" }).first();
    await expect(row).toContainText(`${TITLE} · DeepWiki Code Explorer`);
    await row.click();
    await expect(page.locator(".ps-chat-panel .ps-panel-title, .ps-chat-pane .ps-panel-title").first()).toContainText(`${TITLE} · DeepWiki Code Explorer`);
});
