// Workflows can be switched off (Workflow Simplified stage 2.0; spec "switch"): with the server's bootstrap saying
// `workflows.enabled: false` (a deployment's default; the stub's default too) the portal shows no Workflow button, tab, pane or rows, at desktop and
// phone widths, even when the session list holds a session's Workflow children and the profile remembers the Workflow
// tab; with it on (the test environment), the same fixture shows them.
//
// Selector: npx playwright test test/e2e/workflows-switch.spec.mjs (from packages/app/web, after build).
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const AGENT_ID = "11111110-2222-3333-4444-555555555551";
const WORKFLOW_ID = "77777777-2222-3333-4444-555555555551";
const now = Date.now();
// Review S2UI-F9: a chat made for a package's Workflow (workflowRef): off, an ordinary chat row with no Workflow badge.
const COORD_ID = "88888888-2222-3333-4444-555555555551";
const SESSIONS = [
    { sessionId: AGENT_ID, title: "Release triage agent", status: "idle", model: "test:test-model", createdAt: now - 60_000, updatedAt: now - 60_000 },
    { sessionId: COORD_ID, title: "release-watch · release-tools", status: "idle", model: "test:test-model", workflowRef: "release-tools/release-watch",
        createdAt: now - 50_000, updatedAt: now - 50_000 },
    { sessionId: WORKFLOW_ID, title: "Workflow: nightly-report", status: "running", sessionKind: "workflow", parentSessionId: AGENT_ID,
        createdAt: now - 30_000, updatedAt: now - 20_000 },
];

let off;
let on;
test.beforeAll(async () => {
    off = await startStubServer(0, { sessionCount: 1 });
    on = await startStubServer(0, { sessionCount: 1, workflows: true });
});
test.afterAll(async () => {
    for (const stub of [off, on]) await new Promise((resolve) => stub.server.close(resolve));
});

/** The session list with one session and its running Workflow; reads of either answer quietly. `reads` lists Workflow reads. */
async function routeSessions(page, { sideTab = null } = {}) {
    const reads = [];
    await page.route("**/api/v1/**", async (route) => {
        const req = route.request();
        const pathname = new URL(req.url()).pathname;
        const answer = (result) => route.fulfill({ json: { ok: true, result } });
        if (pathname.endsWith("/management/sessions")) return answer({ sessions: SESSIONS, hasMore: false, nextCursor: null });
        if (pathname.endsWith("/sessions") && req.method() === "GET") return answer({ sessions: SESSIONS, hasMore: false });
        if (pathname.endsWith(`/sessions/${WORKFLOW_ID}/workflow`)) { reads.push(pathname); return route.fulfill({ status: 404, json: { ok: false, error: { code: "WORKFLOWS_DISABLED", message: "Workflows are turned off on this server." } } }); }
        if (pathname.includes("/events")) return answer([]);
        if (pathname.endsWith(`/sessions/${AGENT_ID}`)) return answer({ ...SESSIONS[0], events: [], messages: [] });
        if (pathname.endsWith(`/sessions/${WORKFLOW_ID}`)) return answer({ ...SESSIONS[1], events: [], messages: [] });
        if (sideTab && /\/me\/profile$/.test(pathname)) {
            return answer({ isAdmin: false, profileSettings: { desktopPanes: { canvasOpen: true, diagnosticsOpen: false, zen: false, sideTab } } });
        }
        return route.fallback();
    });
    return { reads };
}

const workflowButton = (page) => page.getByRole("button", { name: /^(Workflow( —.*)?|Hide the Workflow tab)$/ });
const workflowRow = (page) => page.locator(".ps-session-row-content", { hasText: "nightly-report" });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`stage 2.0, Workflows off: no Workflow button, tab, pane or rows, and no Workflow read, at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const { reads } = await routeSessions(page, { sideTab: "workflow" });
        await page.goto(`http://127.0.0.1:${off.port}/?session=${AGENT_ID}`);
        let list = page;
        if (viewport.width <= 600) {
            // On a phone the list is a slide-over behind the leftmost toolbar button: open it, so the session's row (and
            // the absence of its Workflow row) is checked where a person would look.
            await page.locator(".ps-toolbar.is-mobile").getByRole("button", { name: "Sessions", exact: true }).click();
            await expect(page.locator(".ps-mobile-session-slideover.is-open")).toBeVisible();
            list = page.locator(".ps-mobile-session-slideover");
        }
        await expect(list.locator(".ps-session-row-content", { hasText: "Release triage agent" }).first()).toBeVisible();
        // Give the session list and its refreshes time to settle; nothing about Workflows may appear.
        await page.waitForTimeout(1_500);
        await expect(workflowButton(page)).toHaveCount(0);
        await expect(page.locator(".ps-wf-tab")).toHaveCount(0);
        await expect(workflowRow(page)).toHaveCount(0);
        // The coordinating chat is an ordinary row: no Workflow badge, no "Runs the Workflow" tooltip.
        await expect(list.locator(".ps-session-row-content", { hasText: "release-watch · release-tools" }).first()).toBeVisible();
        await expect(page.locator("[data-workflow-ref]")).toHaveCount(0);
        await expect(page.locator('[title^="Runs the Workflow"]')).toHaveCount(0);
        // A link to the Workflow itself shows no Workflow tab either.
        await page.goto(`http://127.0.0.1:${off.port}/?session=${WORKFLOW_ID}`);
        await page.waitForTimeout(1_000);
        await expect(page.locator(".ps-wf-tab")).toHaveCount(0);
        await expect(workflowButton(page)).toHaveCount(0);
        expect(reads).toEqual([]);
        expect(errors).toEqual([]);
    });

    test(`stage 2.0, Workflows on (the test environment): the same fixture has the Workflow button and row, at ${viewport.width}px`, async ({ page }) => {
        await page.setViewportSize(viewport);
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await routeSessions(page);
        await page.goto(`http://127.0.0.1:${on.port}/?session=${AGENT_ID}`);
        await expect(workflowButton(page)).toHaveCount(1);
        if (viewport.width > 600) {
            // On, the coordinating chat wears the Workflow badge.
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
