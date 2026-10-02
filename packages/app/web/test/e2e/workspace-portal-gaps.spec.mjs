// Small portal gaps from an end-to-end test of session workspaces (issue
// #103), against the stub portal. The workspace calls are routed here; no
// worker, no model.
//
//   a long status (a failed workspace change) is cut off in the header,
//   and its tooltip holds all of it
//   Manage session -> Workspace -> Files shows the side pane on its
//   Workspace tab, while the pane is hidden
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const sessionId = "11111110-2222-3333-4444-555555555550";
let stub;
test.beforeAll(async () => { stub = await startStubServer(0, { sessionCount: 1 }); });
test.afterAll(async () => { await new Promise((resolve) => stub.server.close(resolve)); });

const VIEW = {
    workspace: { schema: 1, root: "a", folder: "sessions/s1/app" },
    revision: 1,
    turnRevision: 1,
    path: "/ws/a/sessions/s1/app",
    status: "ready",
    lastError: null,
    heldPrompts: 0,
    adopted: null,
    defaults: null,
};
const FOLDERS = [
    { id: "working", name: "app", role: "working", home: false, root: "a", folder: "sessions/s1/app", opened: true, available: true, base: "/ws/a/sessions/s1/app" },
];

async function routeWorkspace(page, { setError = null } = {}) {
    const sets = [];
    // The signed-in person owns the session, so Manage session is on.
    await page.route("**/api/v1/bootstrap", (route) => route.fulfill({ json: { ok: true, result: {
        auth: { principal: { provider: "none", subject: "test" }, authorization: { role: "admin" } },
    } } }));
    await page.route("**/api/v1/sessions/*/access", (route) => route.fulfill({
        json: { ok: true, result: { canRead: true, canWrite: true, canManage: true, owner: { provider: "none", subject: "test" } } },
    }));
    await page.route("**/api/portal-config", (route) => route.fulfill({ json: { ok: true, portal: { branding: { title: "PilotSwarm", pageTitle: "PilotSwarm" }, workspaceFiles: true } } }));
    await page.route(`**/management/sessions/${sessionId}/workspace`, (route) => {
        if (route.request().method() === "GET") return route.fulfill({ json: { ok: true, result: VIEW } });
        sets.push(route.request().postDataJSON());
        if (setError) return route.fulfill({ status: 422, json: { ok: false, error: setError } });
        return route.fulfill({ json: { ok: true, result: { status: "changed", revision: 2, workspace: VIEW.workspace } } });
    });
    await page.route(`**/management/sessions/${sessionId}/workspace/folders`, (route) => route.fulfill({
        json: { ok: true, result: { enabled: true, maxBytes: 20 * 1024 * 1024, folders: FOLDERS, roots: ["a", "shared"] } },
    }));
    await page.route(`**/management/sessions/${sessionId}/workspace/files`, (route) => route.fulfill({
        json: { ok: true, result: { entries: [{ name: "README.md", kind: "file", size: 6, mtimeMs: 1 }], truncated: false, readOnly: false } },
    }));
    return sets;
}

const manage = (page) => page.getByRole("button", { name: "Manage session — rename, switch model, and sharing", exact: true });
const dialog = (page) => page.locator(".ps-share-overlay");

test("a failed workspace change: the header cuts the reason off, and the tooltip holds all of it", async ({ page }) => {
    const reason = "WORKSPACE_ROOT_UNKNOWN: workspace root \"zz\" is not configured on this worker; "
        + "the roots this deployment serves are listed in the Set dialog, and a folder must stay inside its root, "
        + "so check the root name and the folder and try again";
    const sets = await routeWorkspace(page, { setError: { code: "WORKSPACE_ROOT_UNKNOWN", message: reason } });
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    await manage(page).click();
    await dialog(page).getByRole("button", { name: "Set…", exact: true }).click();
    const input = page.locator(".ps-modal-input");
    await expect(input).toHaveValue("a/sessions/s1/app");
    // The dialog lists the roots this deployment serves.
    await expect(page.locator(".ps-modal-details")).toContainText("Roots: a, shared");
    await input.fill("zz/some/folder");
    await input.press("Enter");
    await expect.poll(() => sets.length).toBe(1);

    const full = `Set workspace failed: ${reason}`;
    const status = page.locator(".portal-header-status");
    await expect(status).toHaveText(full);
    await expect(status).toHaveAttribute("title", full);
    // The point of the tooltip: at this width the line is cut off.
    expect(await status.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});

test("Manage session -> Workspace -> Files shows the hidden side pane on its Workspace tab", async ({ page }) => {
    await routeWorkspace(page);
    await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
    // The side pane starts hidden: the toolbar offers to show it.
    await expect(page.getByRole("button", { name: "Show canvas", exact: true })).toBeVisible();

    await manage(page).click();
    await dialog(page).getByRole("button", { name: "Files", exact: true }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Hide the canvas", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Workspace" })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".ps-ws-row-name", { hasText: /^README\.md$/ })).toBeVisible();
});
