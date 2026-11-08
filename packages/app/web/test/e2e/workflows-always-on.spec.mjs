// Workflows are always on (owner 2026-11-08T08:03Z): the portal shows the Workflow button, the Workflow rows and a
// coordinating chat's Workflow badge with no opt-in, at desktop and phone widths. The client reads no switch: even a
// bootstrap that says `workflows.enabled: false` (no server sends it any more) hides nothing.
//
// Selector: npx playwright test test/e2e/workflows-always-on.spec.mjs (from packages/app/web, after build).
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const AGENT_ID = "11111110-2222-3333-4444-555555555551";
const WORKFLOW_ID = "77777777-2222-3333-4444-555555555551";
const now = Date.now();
// A chat made for a package's Workflow (workflowRef): it wears the Workflow badge.
const COORD_ID = "88888888-2222-3333-4444-555555555551";
const SESSIONS = [
    { sessionId: AGENT_ID, title: "Release triage agent", status: "idle", model: "test:test-model", createdAt: now - 60_000, updatedAt: now - 60_000 },
    { sessionId: COORD_ID, title: "release-watch · release-tools", status: "idle", model: "test:test-model", workflowRef: "release-tools/release-watch",
        createdAt: now - 50_000, updatedAt: now - 50_000 },
    { sessionId: WORKFLOW_ID, title: "Workflow: nightly-report", status: "running", sessionKind: "workflow", parentSessionId: AGENT_ID,
        createdAt: now - 30_000, updatedAt: now - 20_000 },
];

let stub;
test.beforeAll(async () => {
    // No Workflows option: the stub's bootstrap says what every server says.
    stub = await startStubServer(0, { sessionCount: 1 });
});
test.afterAll(async () => {
    await new Promise((resolve) => stub.server.close(resolve));
});

/** The session list with one session and its running Workflow; reads of either answer quietly. */
async function routeSessions(page, { oldBootstrap = false } = {}) {
    await page.route("**/api/v1/**", async (route) => {
        const req = route.request();
        const pathname = new URL(req.url()).pathname;
        const answer = (result) => route.fulfill({ json: { ok: true, result } });
        if (oldBootstrap && pathname.endsWith("/bootstrap")) return route.fulfill({ json: { ok: true, workflows: { schema: 1, enabled: false } } });
        if (pathname.endsWith("/management/sessions")) return answer({ sessions: SESSIONS, hasMore: false, nextCursor: null });
        if (pathname.endsWith("/sessions") && req.method() === "GET") return answer({ sessions: SESSIONS, hasMore: false });
        if (pathname.endsWith(`/sessions/${WORKFLOW_ID}/workflow`)) return route.fulfill({ status: 404, json: { ok: false, error: { code: "NOT_FOUND", message: "Not found." } } });
        if (pathname.includes("/events")) return answer([]);
        if (pathname.endsWith(`/sessions/${AGENT_ID}`)) return answer({ ...SESSIONS[0], events: [], messages: [] });
        if (pathname.endsWith(`/sessions/${WORKFLOW_ID}`)) return answer({ ...SESSIONS[2], events: [], messages: [] });
        return route.fallback();
    });
}

const workflowButton = (page) => page.getByRole("button", { name: /^(Workflow( —.*)?|Hide the Workflow tab)$/ });
const workflowRow = (page) => page.locator(".ps-session-row-content", { hasText: "nightly-report" });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    for (const oldBootstrap of [false, true]) {
        const label = oldBootstrap ? "even when a bootstrap says enabled: false" : "with no opt-in";
        test(`always on: the Workflow button, badge and rows show ${label}, at ${viewport.width}px`, async ({ page }) => {
            await page.setViewportSize(viewport);
            const errors = [];
            page.on("pageerror", (error) => errors.push(error.message));
            await routeSessions(page, { oldBootstrap });
            await page.goto(`http://127.0.0.1:${stub.port}/?session=${AGENT_ID}`);
            await expect(workflowButton(page)).toHaveCount(1);
            if (viewport.width > 600) {
                // The coordinating chat wears the Workflow badge.
                await expect(page.locator(`.ps-session-list-button[data-session-id="${COORD_ID}"] [data-workflow-ref="release-tools/release-watch"]`).first()).toBeVisible();
                // Workflow rows sit under their session: the session's row opens them.
                const row = workflowRow(page).first();
                for (let tries = 0; tries < 3 && !(await row.isVisible().catch(() => false)); tries++) {
                    await page.locator(`.ps-session-list-button[data-session-id="${AGENT_ID}"] .ps-session-row-content`).first().click();
                    await page.waitForTimeout(250);
                }
                await expect(row).toBeVisible();
            }
            expect(errors).toEqual([]);
        });
    }
}
