import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";

const personalSessionId = "11111110-2222-3333-4444-555555555550";
const fleetSessionId = "11111111-2222-3333-4444-555555555551";

let stub;
test.beforeAll(async () => {
    stub = await startStubServer(0, {
        sessionCount: 3,
        transcriptTurns: 4,
        admin: true,
    });
});
test.afterAll(async () => {
    await new Promise((resolve) => stub.server.close(resolve));
});

test("admin personal view keeps Session actions inside a narrow work-index header", async ({ page }) => {
    await page.setViewportSize({ width: 827, height: 700 });
    await page.goto(`http://127.0.0.1:${stub.port}`);
    await page.locator(".ps-session-list-button").first().waitFor();

    await expect(page.getByRole("button", { name: "My view" })).toBeVisible();
    const header = page.locator("#ps-work-index-panel .ps-panel-header").first();
    const actions = header.locator(".ps-panel-actions button");
    await expect(actions).toHaveCount(5);

    const geometry = await header.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
            header: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
            actions: [...element.querySelectorAll(".ps-panel-actions button")].map((button) => {
                const rect = button.getBoundingClientRect();
                return {
                    label: button.getAttribute("aria-label"),
                    left: rect.left,
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                };
            }),
        };
    });

    for (const action of geometry.actions) {
        expect(action.left, action.label).toBeGreaterThanOrEqual(geometry.header.left);
        expect(action.top, action.label).toBeGreaterThanOrEqual(geometry.header.top);
        expect(action.right, action.label).toBeLessThanOrEqual(geometry.header.right);
        expect(action.bottom, action.label).toBeLessThanOrEqual(geometry.header.bottom);
    }
});

test("admin Fleet view keeps Session transcripts stable and read-only", async ({ page }) => {
    const requests = [];
    page.on("request", (request) => {
        if (request.url().includes("/api/v1/sessions")) requests.push(request.url());
    });

    await page.goto(`http://127.0.0.1:${stub.port}`);
    await page.getByRole("button", { name: "My view" }).click();

    await expect(page.getByRole("button", { name: "Fleet view · read-only" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New session" })).toBeDisabled();
    await expect(page.getByRole("button", { name: /canvas/i })).toBeDisabled();
    await expect(page.getByRole("button", { name: /diagnostics/i })).toBeDisabled();

    const fleetRow = page.locator("#ps-work-index-panel tbody tr").filter({ hasText: "Session 1" });
    await fleetRow.click();
    await expect(fleetRow).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".ps-chat-panel")).toContainText("Assessment");
    await expect(page.getByText(
        "Fleet view is read-only. Switch to My view to participate in this session.",
    )).toBeVisible();

    await page.waitForTimeout(5_000);
    await expect(fleetRow).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".ps-chat-panel")).toContainText("Assessment");

    await page.keyboard.press("Shift+D");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.getByRole("button", { name: "Fleet view · read-only" }).click();
    await expect(page.getByRole("button", { name: "My view" })).toBeVisible();
    await expect(page.getByText(
        "Fleet view is read-only. Switch to My view to participate in this session.",
    )).toHaveCount(0);

    expect(requests.some((url) => url.includes("scope=fleet"))).toBe(true);
    const sessionDetailRequests = requests.filter((url) => (
        /\/api\/v1\/sessions\/[^/]+$/.test(new URL(url).pathname)
    ));
    expect(sessionDetailRequests.some((url) => (
        new URL(url).pathname.endsWith(`/${fleetSessionId}`)
        && new URL(url).searchParams.get("scope") === "fleet"
    ))).toBe(true);
    expect(sessionDetailRequests.at(-1)).toContain(personalSessionId);
});
